'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScalvinError, invariant } = require('./lib/errors');
const {
  PRIVATE_FILE_MODE,
  assertInside,
  validateRelativePath,
  rejectSymlinkPath,
  ensurePrivateDir,
  atomicWriteFile,
  fsyncDirectory,
  pathExists,
  sha256Buffer
} = require('./lib/fs-safe');
const { renderPrimerSingleton, validatePrimerSingletonMarkdown } = require('./memory-data');

const SESSION_ID_PATTERN = /^s-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function compareCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const CAPTURE_GRADES = new Set(['client_captured', 'turn_captured', 'best_effort_context', 'partial']);
const SPEAKERS = new Set(['user', 'companion']);
const TRANSCRIPT_STATES = new Set(['off', 'recording', 'paused', 'stopped', 'finalized']);
const GAP_REASONS = new Set(['paused_no_backfill', 'consent_revoked_no_backfill', 'capture_started_late', 'not_captured', 'capture_ended_early', 'client_gap', 'interrupted']);
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_ID_ATTEMPTS = 32;
const MAX_TRANSCRIPT_TURNS = 10_000;
const MAX_TRANSCRIPT_GAPS = 1_000;
const MAX_PAUSED_INTERVALS = 1_000;

const LEGACY_SESSION_CHECKPOINT_FRONTMATTER_KEYS = Object.freeze([
  'record_kind', 'session_id', 'started_at', 'updated_at', 'timezone', 'lifecycle_state',
  'consent_state', 'transcript_state', 'capture_grade', 'covered_turns', 'known_gaps',
  'last_persisted_turn', 'resumed_at'
]);

const ARTIFACT_FRONTMATTER_KEYS = Object.freeze({
  session_checkpoint: Object.freeze([
    'record_kind', 'session_id', 'started_at', 'updated_at', 'timezone', 'lifecycle_state',
    'consent_state', 'transcript_state', 'capture_grade', 'capture_method',
    'capability_proof_verified', 'covered_turns', 'known_gaps', 'paused_intervals',
    'finalized_at', 'full_coverage_proven', 'verbatim_claim', 'last_persisted_turn',
    'resumed_at'
  ]),
  ai_authored_session_note: Object.freeze([
    'record_kind', 'author_role', 'author_name', 'session_id', 'started_at', 'closed_at',
    'timezone', 'completion', 'source_transcript', 'consent_event_id'
  ]),
  transcript: Object.freeze([
    'record_kind', 'session_id', 'started_at', 'finalized_at', 'timezone', 'consent_event_id',
    'capture_grade', 'capture_method', 'capability_proof_verified', 'covered_turns',
    'known_gaps', 'paused_intervals', 'full_coverage_proven', 'verbatim_claim', 'body_sha256'
  ]),
  ai_authored_deep_dive: Object.freeze([
    'record_kind', 'artifact_id', 'author_role', 'author_name', 'session_id', 'created_at',
    'timezone', 'consent_event_id', 'source_memory_ids', 'source_ids'
  ])
});

function lifecycleError(message, code, details) {
  return new ScalvinError(message, code, details);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertTimestamp(value, label = 'Timestamp') {
  const match = typeof value === 'string' ? value.match(RFC3339_PATTERN) : null;
  invariant(match, `${label} must be canonical RFC 3339.`, 'INVALID_TIMESTAMP');
  const [, year, month, day, hour, minute, second, , zone, sign, offsetHour = '00', offsetMinute = '00'] = match;
  invariant(Number(second) <= 59 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59, `${label} must be canonical RFC 3339.`, 'INVALID_TIMESTAMP');
  const epoch = Date.parse(value);
  invariant(!Number.isNaN(epoch), `${label} must be canonical RFC 3339.`, 'INVALID_TIMESTAMP');
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute));
  const local = new Date(epoch + offset * 60_000);
  invariant(
    local.getUTCFullYear() === Number(year)
      && local.getUTCMonth() + 1 === Number(month)
      && local.getUTCDate() === Number(day)
      && local.getUTCHours() === Number(hour)
      && local.getUTCMinutes() === Number(minute)
      && local.getUTCSeconds() === Number(second),
    `${label} must be a real canonical RFC 3339 instant.`,
    'INVALID_TIMESTAMP'
  );
  return value;
}

function assertTimezone(value, timestamp) {
  invariant(value === 'unconfirmed' || (typeof value === 'string' && value.length <= 100 && !/[\0\r\n]/.test(value)), 'Timezone must be an IANA name or unconfirmed.', 'INVALID_TIMEZONE');
  if (value === 'unconfirmed') {
    invariant(timestamp.endsWith('Z'), 'Unconfirmed timezone timestamps must use UTC.', 'INVALID_TIMESTAMP');
    return value;
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format(new Date(timestamp));
  } catch {
    throw lifecycleError('Timezone must be a real IANA name.', 'INVALID_TIMEZONE');
  }
  invariant(/[+-]\d{2}:\d{2}$/.test(timestamp), 'Confirmed timezone timestamps require a numeric UTC offset.', 'INVALID_TIMESTAMP');
  return value;
}

function assertSessionId(value) {
  invariant(SESSION_ID_PATTERN.test(value || ''), 'Session ID must be s-<UUID-v4>.', 'INVALID_SESSION_ID');
  return value;
}

function assertText(value, label, options = {}) {
  invariant(typeof value === 'string', `${label} must be text.`, 'INVALID_ARTIFACT_CONTENT');
  invariant(!value.includes('\0'), `${label} cannot contain NUL.`, 'INVALID_ARTIFACT_CONTENT');
  invariant(Buffer.byteLength(value) <= (options.maxBytes || MAX_ARTIFACT_BYTES), `${label} is too large.`, 'ARTIFACT_TOO_LARGE');
  return value;
}

function normalizeSessionId(value) {
  const candidate = String(value || '');
  return candidate.startsWith('s-') ? candidate : `s-${candidate}`;
}

function timestampStamp(timestamp) {
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  invariant(match, 'Timestamp cannot be used for an artifact name.', 'INVALID_TIMESTAMP');
  return `${match[1]}-${match[2]}-${match[3]}-${match[4]}${match[5]}${match[6]}`;
}

function artifactPaths(startedAt, sessionId) {
  assertTimestamp(startedAt, 'Session start');
  const stamp = timestampStamp(startedAt);
  const uuid = assertSessionId(sessionId).slice(2);
  return {
    checkpoint: `archive/checkpoints/${stamp}--${uuid}--checkpoint.md`,
    sessionNote: `sessions/${stamp}--${uuid}--session.md`,
    transcript: `archive/transcripts/${stamp}--${uuid}--transcript.md`,
    deepDive: `archive/${stamp}--${uuid}--deep-dive.md`
  };
}

function assertSessionDescriptor(session) {
  invariant(session && typeof session === 'object' && !Array.isArray(session), 'Session descriptor is required.', 'SESSION_STATE_INVALID');
  assertSessionId(session.id);
  assertTimestamp(session.startedAt, 'Session start');
  assertTimezone(session.timezone, session.startedAt);
  if (session.startedAtUtc !== undefined) {
    assertTimestamp(session.startedAtUtc, 'Session UTC start');
    invariant(session.startedAtUtc.endsWith('Z') && new Date(session.startedAt).toISOString() === session.startedAtUtc, 'Session UTC start does not match the local start.', 'SESSION_STATE_INVALID');
  }
  const expected = artifactPaths(session.startedAt, session.id);
  invariant(session.paths && Object.keys(session.paths).length === Object.keys(expected).length, 'Session artifact paths are invalid.', 'SESSION_PATH_MISMATCH');
  for (const [key, relative] of Object.entries(expected)) invariant(session.paths[key] === relative, 'Session artifact paths do not match session identity.', 'SESSION_PATH_MISMATCH');
  return session;
}

function resolveArtifact(workspace, relative) {
  invariant(typeof workspace === 'string' && workspace.trim(), 'Workspace is required.', 'INVALID_ARGUMENT');
  const normalized = validateRelativePath(relative);
  const root = path.resolve(workspace);
  const absolute = path.resolve(root, normalized);
  assertInside(root, absolute, 'Lifecycle artifact');
  return absolute;
}

function persistenceDecision(canonicalState, dataClass) {
  const consent = canonicalState?.consent;
  if (!consent || consent.continuityMemory !== 'on') return { allowed: false, reason: 'continuity_consent_off' };
  const pause = consent.memoryPause?.state || 'none';
  if (pause !== 'none') return { allowed: false, reason: pause };
  const retention = consent.retention?.[dataClass];
  if (!retention || retention === 'do_not_store') return { allowed: false, reason: 'retention_do_not_store' };
  return { allowed: true, reason: null, retention };
}

function transcriptDecision(canonicalState) {
  const consent = canonicalState?.consent;
  if (!consent || consent.transcripts !== 'on') return { allowed: false, reason: 'transcript_consent_off' };
  const pause = consent.memoryPause?.state || 'none';
  if (pause !== 'none') return { allowed: false, reason: pause };
  const retention = consent.retention?.raw_transcripts;
  if (!retention || retention === 'do_not_store') return { allowed: false, reason: 'retention_do_not_store' };
  return { allowed: true, reason: null, retention };
}

function normalizePausedInterval(interval) {
  invariant(interval && typeof interval === 'object' && !Array.isArray(interval), 'Transcript pause interval is invalid.', 'INVALID_TRANSCRIPT_COVERAGE');
  const startedAt = assertTimestamp(interval.startedAt, 'Transcript pause start');
  const endedAt = interval.endedAt === null ? null : assertTimestamp(interval.endedAt, 'Transcript pause end');
  if (endedAt !== null) invariant(Date.parse(endedAt) >= Date.parse(startedAt), 'Transcript pause interval ends before it starts.', 'INVALID_TRANSCRIPT_COVERAGE');
  return { startedAt, endedAt };
}

function normalizeCoveredTurns(value) {
  if (value === null || value === undefined) return null;
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'Covered-turn metadata is invalid.', 'INVALID_TRANSCRIPT_COVERAGE');
  const { first, last, count } = value;
  invariant(Number.isSafeInteger(first) && first > 0 && Number.isSafeInteger(last) && last >= first && Number.isSafeInteger(count) && count > 0 && count <= last - first + 1, 'Covered-turn metadata is invalid.', 'INVALID_TRANSCRIPT_COVERAGE');
  return { first, last, count };
}

function transcriptSnapshot(input = {}) {
  const claimedGrade = input.captureGrade || null;
  if (claimedGrade !== null) invariant(CAPTURE_GRADES.has(claimedGrade), 'Transcript capture grade is invalid.', 'INVALID_CAPTURE_GRADE');
  const state = input.state || (claimedGrade ? 'recording' : 'off');
  invariant(TRANSCRIPT_STATES.has(state), 'Transcript state is invalid.', 'INVALID_TRANSCRIPT_COVERAGE');
  const knownGapsInput = input.knownGaps || [];
  const pausesInput = input.pausedIntervals || [];
  invariant(Array.isArray(knownGapsInput) && knownGapsInput.length <= MAX_TRANSCRIPT_GAPS, 'Transcript gap metadata is invalid or too large.', 'INVALID_TRANSCRIPT_COVERAGE');
  invariant(Array.isArray(pausesInput) && pausesInput.length <= MAX_PAUSED_INTERVALS, 'Transcript pause metadata is invalid or too large.', 'INVALID_TRANSCRIPT_COVERAGE');
  if (input.sessionId !== null && input.sessionId !== undefined) assertSessionId(input.sessionId);
  if (input.finalizedAt !== null && input.finalizedAt !== undefined) assertTimestamp(input.finalizedAt, 'Transcript finalization');
  const knownGaps = knownGapsInput.map(normalizeGap);
  const capabilityProofVerified = input.capabilityProofVerified === true;
  const highGradeUnverified = ['client_captured', 'turn_captured'].includes(claimedGrade) && !capabilityProofVerified;
  const grade = knownGaps.length && claimedGrade !== null ? 'partial' : highGradeUnverified ? 'best_effort_context' : claimedGrade;
  return {
    state,
    sessionId: input.sessionId || null,
    captureGrade: grade,
    captureMethod: input.captureMethod || claimedGrade,
    coveredTurns: normalizeCoveredTurns(input.coveredTurns),
    knownGaps,
    pausedIntervals: pausesInput.map(normalizePausedInterval),
    finalizedAt: input.finalizedAt || null,
    fullCoverageProven: input.fullCoverageProven === true && capabilityProofVerified,
    capabilityProofVerified,
    verbatimClaim: false
  };
}

function canonicalPatch(session, options = {}) {
  assertSessionDescriptor(session);
  const checkpoint = options.checkpoint === undefined ? clone(session.checkpoint || null) : clone(options.checkpoint);
  const transcript = transcriptSnapshot(options.transcript || session.transcript || {});
  const patch = {
    consent: {
      currentSessionId: options.currentSessionId === undefined ? session.id : options.currentSessionId
    },
    sessionLifecycle: {
      state: options.state || session.state,
      sessionId: session.id,
      startedAt: session.startedAt,
      startedAtUtc: session.startedAtUtc,
      timezone: session.timezone,
      resumedAt: clone(session.resumedAt || []),
      closedAt: options.closedAt || session.closedAt || null,
      completion: options.completion || session.completion || null,
      checkpoint,
      transcript
    }
  };
  return validateSessionLifecyclePatch(patch);
}

function validateSessionLifecyclePatch(patch) {
  invariant(patch && typeof patch === 'object' && !Array.isArray(patch), 'Session lifecycle patch must be an object.', 'SESSION_PATCH_INVALID');
  invariant(patch.consent && Object.prototype.hasOwnProperty.call(patch.consent, 'currentSessionId'), 'Session lifecycle patch must carry currentSessionId.', 'SESSION_PATCH_INVALID');
  const lifecycle = patch.sessionLifecycle;
  invariant(lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle), 'Session lifecycle state is missing.', 'SESSION_PATCH_INVALID');
  invariant(['none', 'active', 'interrupted', 'abandoned', 'closed'].includes(lifecycle.state), 'Session lifecycle state is invalid.', 'SESSION_PATCH_INVALID');
  if (lifecycle.state === 'none') {
    invariant(patch.consent.currentSessionId === null && lifecycle.sessionId === null && lifecycle.checkpoint === null, 'Empty lifecycle state cannot reference a session or checkpoint.', 'SESSION_PATCH_INVALID');
    invariant(lifecycle.startedAt === null && lifecycle.startedAtUtc === null && lifecycle.timezone === null && Array.isArray(lifecycle.resumedAt) && lifecycle.resumedAt.length === 0 && lifecycle.closedAt === null && lifecycle.completion === null, 'Empty lifecycle timestamps must be null.', 'SESSION_PATCH_INVALID');
    const emptyTranscript = transcriptSnapshot(lifecycle.transcript);
    invariant(emptyTranscript.state === 'off' && emptyTranscript.sessionId === null && emptyTranscript.captureGrade === null && emptyTranscript.coveredTurns === null && emptyTranscript.knownGaps.length === 0 && emptyTranscript.pausedIntervals.length === 0 && emptyTranscript.verbatimClaim === false, 'Empty lifecycle transcript state must be off.', 'SESSION_PATCH_INVALID');
    return patch;
  }

  assertSessionId(lifecycle.sessionId);
  assertTimestamp(lifecycle.startedAt, 'Lifecycle start');
  assertTimestamp(lifecycle.startedAtUtc, 'Lifecycle UTC start');
  assertTimezone(lifecycle.timezone, lifecycle.startedAt);
  invariant(lifecycle.startedAtUtc.endsWith('Z') && lifecycle.startedAtUtc === new Date(lifecycle.startedAt).toISOString(), 'Lifecycle UTC start does not match start time.', 'SESSION_PATCH_INVALID');
  invariant(Array.isArray(lifecycle.resumedAt) && lifecycle.resumedAt.length <= MAX_PAUSED_INTERVALS, 'Lifecycle resume metadata is invalid.', 'SESSION_PATCH_INVALID');
  for (const resumedAt of lifecycle.resumedAt) {
    assertTimestamp(resumedAt, 'Lifecycle resume');
    invariant(Date.parse(resumedAt) >= Date.parse(lifecycle.startedAt), 'Lifecycle resume precedes session start.', 'SESSION_PATCH_INVALID');
  }
  if (lifecycle.state === 'closed') {
    assertTimestamp(lifecycle.closedAt, 'Lifecycle close');
    invariant(Date.parse(lifecycle.closedAt) >= Date.parse(lifecycle.startedAt), 'Lifecycle close precedes session start.', 'SESSION_PATCH_INVALID');
    invariant(['complete', 'interrupted_partial'].includes(lifecycle.completion), 'Closed lifecycle completion is invalid.', 'SESSION_PATCH_INVALID');
    invariant(patch.consent.currentSessionId === null, 'Closed lifecycle cannot remain the current session.', 'SESSION_PATCH_INVALID');
  } else {
    invariant(lifecycle.closedAt === null && lifecycle.completion === null, 'Open lifecycle cannot carry close metadata.', 'SESSION_PATCH_INVALID');
    if (['active', 'interrupted'].includes(lifecycle.state)) invariant(patch.consent.currentSessionId === lifecycle.sessionId, 'Open lifecycle must be the canonical current session.', 'SESSION_PATCH_INVALID');
    else invariant(patch.consent.currentSessionId === null, 'Abandoned lifecycle cannot remain the current session.', 'SESSION_PATCH_INVALID');
  }

  if (lifecycle.checkpoint !== null) {
    invariant(lifecycle.checkpoint && typeof lifecycle.checkpoint === 'object' && !Array.isArray(lifecycle.checkpoint), 'Lifecycle checkpoint metadata is invalid.', 'SESSION_PATCH_INVALID');
    const expected = artifactPaths(lifecycle.startedAt, lifecycle.sessionId).checkpoint;
    invariant(lifecycle.checkpoint.path === expected, 'Lifecycle checkpoint path does not match session identity.', 'SESSION_PATCH_INVALID');
    assertTimestamp(lifecycle.checkpoint.updatedAt, 'Lifecycle checkpoint update');
    invariant(Date.parse(lifecycle.checkpoint.updatedAt) >= Date.parse(lifecycle.startedAt), 'Lifecycle checkpoint precedes session start.', 'SESSION_PATCH_INVALID');
    invariant(Number.isSafeInteger(lifecycle.checkpoint.lastPersistedTurn) && lifecycle.checkpoint.lastPersistedTurn > 0, 'Lifecycle checkpoint turn is invalid.', 'SESSION_PATCH_INVALID');
  }

  const transcript = lifecycle.transcript;
  invariant(transcript && typeof transcript === 'object' && !Array.isArray(transcript), 'Lifecycle transcript metadata is missing.', 'SESSION_PATCH_INVALID');
  invariant(transcript.verbatimClaim === false, 'Lifecycle transcript cannot claim verbatim capture.', 'SESSION_PATCH_INVALID');
  const normalizedTranscript = transcriptSnapshot(transcript);
  for (const key of ['state', 'sessionId', 'captureGrade', 'captureMethod', 'coveredTurns', 'knownGaps', 'pausedIntervals', 'finalizedAt', 'fullCoverageProven', 'capabilityProofVerified', 'verbatimClaim']) {
    invariant(JSON.stringify(transcript[key]) === JSON.stringify(normalizedTranscript[key]), 'Lifecycle transcript metadata is not normalized.', 'SESSION_PATCH_INVALID', { field: key });
  }
  invariant(transcript.capabilityProofVerified === false && transcript.fullCoverageProven === false,
    'This preview has no independently attested transcript capability channel.', 'SESSION_PATCH_INVALID');
  if (transcript.state === 'off') {
    invariant(transcript.sessionId === null && transcript.captureGrade === null && transcript.captureMethod === null
      && transcript.coveredTurns === null && transcript.knownGaps.length === 0 && transcript.pausedIntervals.length === 0
      && transcript.finalizedAt === null && transcript.fullCoverageProven === false && transcript.capabilityProofVerified === false,
    'Off lifecycle transcript state must not retain capture evidence.', 'SESSION_PATCH_INVALID');
  } else {
    invariant(transcript.sessionId === lifecycle.sessionId, 'Lifecycle transcript belongs to another session.', 'SESSION_PATCH_INVALID');
    invariant(transcript.captureGrade !== null && transcript.captureMethod !== null, 'Active or terminal lifecycle transcript evidence requires a capture grade.', 'SESSION_PATCH_INVALID');
  }
  const lifecycleStartedAt = Date.parse(lifecycle.startedAt);
  const lifecycleEndedAt = lifecycle.closedAt === null ? null : Date.parse(lifecycle.closedAt);
  if (transcript.finalizedAt !== null) {
    const finalizedAt = Date.parse(transcript.finalizedAt);
    invariant(finalizedAt >= lifecycleStartedAt && (lifecycleEndedAt === null || finalizedAt <= lifecycleEndedAt),
      'Lifecycle transcript finalization falls outside the session.', 'SESSION_PATCH_INVALID');
  }
  const openPauses = transcript.pausedIntervals.filter((interval) => interval.endedAt === null);
  invariant(transcript.state === 'paused' ? openPauses.length === 1 && transcript.pausedIntervals.at(-1)?.endedAt === null : openPauses.length === 0,
    'Lifecycle transcript pause state is inconsistent.', 'SESSION_PATCH_INVALID');
  invariant(['stopped', 'finalized'].includes(transcript.state) ? transcript.finalizedAt !== null : transcript.finalizedAt === null,
    'Lifecycle transcript terminal timestamp is inconsistent.', 'SESSION_PATCH_INVALID');
  for (const interval of transcript.pausedIntervals) {
    const startedAt = Date.parse(interval.startedAt);
    const endedAt = interval.endedAt === null ? null : Date.parse(interval.endedAt);
    invariant(startedAt >= lifecycleStartedAt && (lifecycleEndedAt === null || startedAt <= lifecycleEndedAt)
      && (endedAt === null || lifecycleEndedAt === null || endedAt <= lifecycleEndedAt),
    'Lifecycle transcript pause interval falls outside the session.', 'SESSION_PATCH_INVALID');
  }
  for (const gap of transcript.knownGaps) {
    if (gap.from === undefined) continue;
    const startedAt = Date.parse(gap.from);
    const endedAt = gap.to === null ? null : Date.parse(gap.to);
    invariant(startedAt >= lifecycleStartedAt && (lifecycleEndedAt === null || startedAt <= lifecycleEndedAt)
      && (endedAt === null || lifecycleEndedAt === null || endedAt <= lifecycleEndedAt),
    'Lifecycle transcript gap falls outside the session.', 'SESSION_PATCH_INVALID');
  }
  if (transcript.fullCoverageProven) {
    invariant(transcript.capabilityProofVerified && ['client_captured', 'turn_captured'].includes(transcript.captureGrade), 'Full transcript coverage lacks verified capture capability.', 'SESSION_PATCH_INVALID');
    invariant(transcript.knownGaps.length === 0 && transcript.coveredTurns && transcript.coveredTurns.first === 1 && transcript.coveredTurns.count === transcript.coveredTurns.last, 'Full transcript coverage metadata is inconsistent.', 'SESSION_PATCH_INVALID');
  }
  if (['closed', 'abandoned'].includes(lifecycle.state)) invariant(!['recording', 'paused'].includes(transcript.state), 'Terminal lifecycle cannot keep active transcript capture.', 'SESSION_PATCH_INVALID');
  return patch;
}

function createEmptySessionLifecyclePatch() {
  return validateSessionLifecyclePatch({
    consent: { currentSessionId: null },
    sessionLifecycle: {
      state: 'none',
      sessionId: null,
      startedAt: null,
      startedAtUtc: null,
      timezone: null,
      resumedAt: [],
      closedAt: null,
      completion: null,
      checkpoint: null,
      transcript: transcriptSnapshot()
    }
  });
}

async function collisionExists(workspace, paths) {
  for (const relative of Object.values(paths)) {
    const filename = resolveArtifact(workspace, relative);
    await rejectSymlinkPath(filename, { allowMissing: true });
    if (await pathExists(filename)) return true;
  }
  return false;
}

async function beginSession(options = {}) {
  const now = assertTimestamp(options.now || new Date().toISOString(), 'Session start');
  const timezone = options.timezone || 'unconfirmed';
  assertTimezone(timezone, now);
  invariant(options.canonicalState?.consent, 'Canonical consent state is required.', 'CONSENT_STATE_INVALID');
  invariant(!options.canonicalState.consent.currentSessionId, 'A canonical session is already active.', 'SESSION_ALREADY_ACTIVE');
  invariant(
    !['recording', 'paused'].includes(options.canonicalState.consent.transcriptState?.state),
    'A new session cannot begin while transcript capture is still active.',
    'TRANSCRIPT_STATE_INVALID'
  );
  const noteGate = persistenceDecision(options.canonicalState, 'session_notes');
  const checkpointGate = persistenceDecision(options.canonicalState, 'primers_and_checkpoints');
  const transcriptGate = transcriptDecision(options.canonicalState);
  const mayPersist = noteGate.allowed || checkpointGate.allowed || transcriptGate.allowed;
  const idFactory = options.idFactory || crypto.randomUUID;
  let sessionId;
  let paths;
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    sessionId = assertSessionId(normalizeSessionId(idFactory()));
    paths = artifactPaths(now, sessionId);
    if (!mayPersist || !await collisionExists(options.workspace, paths)) break;
    sessionId = null;
  }
  invariant(sessionId, 'Could not allocate a collision-free session UUID.', 'SESSION_ID_EXHAUSTED');
  const session = {
    id: sessionId,
    state: 'active',
    startedAt: now,
    startedAtUtc: new Date(now).toISOString(),
    timezone,
    resumedAt: [],
    closedAt: null,
    completion: null,
    consentEventId: options.canonicalState.consent.eventId || null,
    authorName: options.authorName || 'Susan',
    lastPersistedTurn: null,
    paths,
    checkpoint: null,
    transcript: transcriptSnapshot()
  };
  return {
    status: mayPersist ? 'active' : 'active_ephemeral',
    writeDisposition: mayPersist ? 'canonical_patch_required' : 'no_write',
    reason: mayPersist ? null : checkpointGate.reason || noteGate.reason || transcriptGate.reason,
    session,
    canonicalPatch: mayPersist ? canonicalPatch(session) : null,
    written: []
  };
}

function frontmatter(raw, options = {}) {
  const code = options.code || 'ARTIFACT_INVALID';
  invariant(raw.startsWith('---\n'), 'Lifecycle artifact frontmatter is missing.', code);
  const end = raw.indexOf('\n---\n', 4);
  invariant(end !== -1, 'Lifecycle artifact frontmatter is incomplete.', code);
  const header = raw.slice(4, end);
  const fields = {};
  for (const line of header.split('\n')) {
    if (line === '') continue;
    const match = /^([a-z][a-z0-9_]*):[ \t]*(.*)$/.exec(line);
    invariant(match, 'Lifecycle artifact frontmatter contains an invalid field.', code);
    const [, key, value] = match;
    invariant(!Object.hasOwn(fields, key), 'Lifecycle artifact frontmatter contains a duplicate field.', code, { field: key });
    fields[key] = value.trim();
  }
  const recordKind = fields.record_kind;
  const expectedRecordKind = options.expectedRecordKind || recordKind;
  invariant(recordKind === expectedRecordKind && Object.hasOwn(ARTIFACT_FRONTMATTER_KEYS, expectedRecordKind), 'Lifecycle artifact record kind is invalid.', code);
  const expectedKeys = ARTIFACT_FRONTMATTER_KEYS[expectedRecordKind];
  const actualKeys = Object.keys(fields).sort(compareCodePoint);
  const allowedSets = expectedRecordKind === 'ai_authored_session_note'
    ? [expectedKeys, [...expectedKeys, 'deep_dive']]
    : expectedRecordKind === 'session_checkpoint'
      ? [expectedKeys, LEGACY_SESSION_CHECKPOINT_FRONTMATTER_KEYS]
      : [expectedKeys];
  invariant(allowedSets.some((keys) => {
    const sorted = [...keys].sort(compareCodePoint);
    return sorted.length === actualKeys.length && sorted.every((key, index) => key === actualKeys[index]);
  }), 'Lifecycle artifact frontmatter fields are missing or unexpected.', code);
  return { fields, header, body: raw.slice(end + 5) };
}

async function readRegularFile(filename) {
  if (await pathExists(`${filename}.incomplete`)) throw lifecycleError('Lifecycle artifact has an incomplete-write marker.', 'ARTIFACT_INCOMPLETE');
  await rejectSymlinkPath(filename);
  const stat = await fsp.lstat(filename);
  invariant(stat.isFile(), 'Lifecycle artifact must be a regular file.', 'UNSUPPORTED_FILE_TYPE');
  invariant(stat.size <= MAX_ARTIFACT_BYTES, 'Lifecycle artifact is too large.', 'ARTIFACT_TOO_LARGE');
  return fsp.readFile(filename, 'utf8');
}

async function atomicExclusiveWrite(filename, data) {
  const directory = path.dirname(filename);
  await rejectSymlinkPath(directory, { allowMissing: true });
  await ensurePrivateDir(directory);
  await rejectSymlinkPath(filename, { allowMissing: true });
  const temp = path.join(directory, `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const incomplete = `${filename}.incomplete`;
  let handle;
  let markerHandle;
  let markerCreated = false;
  let targetCreated = false;
  let preserveIncomplete = false;
  try {
    handle = await fsp.open(temp, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== 'win32') await fsp.chmod(temp, PRIVATE_FILE_MODE);
    let linkError = null;
    if (process.env.SCALVIN_TEST_FORCE_NO_HARDLINK !== '1') {
      try {
        await fsp.link(temp, filename);
        targetCreated = true;
      } catch (error) {
        linkError = error;
      }
    } else {
      linkError = Object.assign(new Error('forced hard-link unavailability'), { code: 'ENOTSUP' });
    }
    if (linkError) {
      if (linkError.code === 'EEXIST') throw lifecycleError('Lifecycle artifact already exists; it was not overwritten.', 'ARTIFACT_COLLISION');
      invariant(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(linkError.code), 'Exclusive artifact activation failed.', 'ARTIFACT_ACTIVATION_FAILED', { causeCode: linkError.code || 'UNKNOWN' });
      if (await pathExists(incomplete)) throw lifecycleError('Lifecycle artifact has an incomplete-write marker.', 'ARTIFACT_INCOMPLETE');
      markerHandle = await fsp.open(incomplete, 'wx', PRIVATE_FILE_MODE);
      markerCreated = true;
      await markerHandle.writeFile('incomplete exclusive artifact activation\n');
      await markerHandle.sync();
      await markerHandle.close();
      markerHandle = undefined;
      await fsp.copyFile(temp, filename, fs.constants.COPYFILE_EXCL);
      targetCreated = true;
      const targetHandle = await fsp.open(filename, 'r+');
      try { await targetHandle.sync(); } finally { await targetHandle.close(); }
      await fsyncDirectory(directory);
      if (process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT === 'exclusive-fallback-crash') {
        preserveIncomplete = true;
        throw lifecycleError('Injected crash-safe incomplete artifact.', 'TEST_FAILPOINT');
      }
      await fsp.rm(incomplete, { force: true });
      markerCreated = false;
    }
    await fsyncDirectory(directory);
  } catch (error) {
    if (!preserveIncomplete) {
      if (targetCreated) await fsp.rm(filename, { force: true }).catch(() => {});
      if (markerCreated) await fsp.rm(incomplete, { force: true }).catch(() => {});
    }
    if (error.code === 'EEXIST') throw lifecycleError('Lifecycle artifact already exists; it was not overwritten.', 'ARTIFACT_COLLISION');
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await markerHandle?.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

async function verifyExactFile(filename, data) {
  const stored = await readRegularFile(filename);
  invariant(sha256Buffer(Buffer.from(stored)) === sha256Buffer(Buffer.from(data)), 'Lifecycle artifact verification failed.', 'ARTIFACT_VERIFY_FAILED');
}

async function writeExclusiveArtifact(filename, data, recordKind, sessionId) {
  try {
    await atomicExclusiveWrite(filename, data);
    await verifyExactFile(filename, data);
    return 'created';
  } catch (error) {
    if (error.code !== 'ARTIFACT_COLLISION') throw error;
    const existing = await readRegularFile(filename);
    const parsed = frontmatter(existing, { expectedRecordKind: recordKind });
    invariant(parsed.fields.record_kind === recordKind && parsed.fields.session_id === sessionId, 'Existing artifact belongs to a different session.', 'ARTIFACT_COLLISION');
    invariant(sha256Buffer(Buffer.from(existing)) === sha256Buffer(Buffer.from(data)), 'Existing session artifact differs and was not overwritten.', 'ARTIFACT_COLLISION');
    return 'already_present';
  }
}

async function planExclusiveArtifact(filename, data, recordKind, sessionId) {
  await rejectSymlinkPath(filename, { allowMissing: true });
  if (!await pathExists(filename)) return 'would_create_exclusively';
  const existing = await readRegularFile(filename);
  const parsed = frontmatter(existing, { expectedRecordKind: recordKind });
  invariant(parsed.fields.record_kind === recordKind && parsed.fields.session_id === sessionId, 'Existing artifact belongs to a different session.', 'ARTIFACT_COLLISION');
  invariant(sha256Buffer(Buffer.from(existing)) === sha256Buffer(Buffer.from(data)), 'Existing session artifact differs and was not overwritten.', 'ARTIFACT_COLLISION');
  return 'already_present';
}

function checkpointHeader(session, transcriptInput, updatedAtInput, turnInput) {
  const transcript = transcriptSnapshot(transcriptInput || {});
  const updatedAt = assertTimestamp(updatedAtInput, 'Checkpoint update');
  const turn = Number(turnInput);
  invariant(Number.isSafeInteger(turn) && turn > 0, 'Checkpoint turn number must be a positive integer.', 'INVALID_TURN_NUMBER');
  return `record_kind: session_checkpoint\nsession_id: ${session.id}\nstarted_at: ${session.startedAt}\nupdated_at: ${updatedAt}\ntimezone: ${session.timezone}\nlifecycle_state: ${session.state}\nconsent_state: on\ntranscript_state: ${transcript.state}\ncapture_grade: ${transcript.captureGrade || 'none'}\ncapture_method: ${transcript.captureMethod || 'none'}\ncapability_proof_verified: ${transcript.capabilityProofVerified === true}\ncovered_turns: ${JSON.stringify(transcript.coveredTurns)}\nknown_gaps: ${JSON.stringify(transcript.knownGaps)}\npaused_intervals: ${JSON.stringify(transcript.pausedIntervals)}\nfinalized_at: ${transcript.finalizedAt || 'null'}\nfull_coverage_proven: ${transcript.fullCoverageProven === true}\nverbatim_claim: false\nlast_persisted_turn: ${turn}\nresumed_at: ${JSON.stringify(session.resumedAt || [])}`;
}

function checkpointMarkdown(session, options) {
  const transcript = transcriptSnapshot(options.transcript || session.transcript || {});
  const turn = options.turnNumber;
  const updatedAt = assertTimestamp(options.now || new Date().toISOString(), 'Checkpoint update');
  const liveThread = assertText(options.liveThread || '', 'Checkpoint live thread');
  const unresolved = assertText(options.unresolved || '', 'Checkpoint unresolved item');
  const carryForward = assertText(options.carryForward || '', 'Checkpoint carry-forward');
  return {
    updatedAt,
    transcript,
    data: `---\n${checkpointHeader(session, transcript, updatedAt, turn)}\n---\n\n# Session Checkpoint\n\n- Live thread: ${liveThread}\n- Unresolved: ${unresolved}\n- Carry-forward if interrupted: ${carryForward}\n\nThis is a partial continuity marker, not a complete session note or transcript.\n`
  };
}

async function checkpointTurn(options = {}) {
  const { session, canonicalState } = options;
  assertSessionDescriptor(session);
  invariant(session && session.state === 'active', 'Only an active session can checkpoint.', 'SESSION_STATE_INVALID');
  const decision = persistenceDecision(canonicalState, 'primers_and_checkpoints');
  if (!decision.allowed) {
    return { status: 'skipped', writeDisposition: 'no_write', reason: decision.reason, session: clone(session), canonicalPatch: null, written: [] };
  }
  const turnNumber = Number(options.turnNumber);
  invariant(Number.isSafeInteger(turnNumber) && turnNumber > 0, 'Checkpoint turn number must be a positive integer.', 'INVALID_TURN_NUMBER');
  invariant(session.lastPersistedTurn === null || turnNumber > session.lastPersistedTurn, 'Checkpoint turns must increase monotonically.', 'NON_MONOTONIC_TURN');
  const canonicalTranscript = transcriptSnapshot(session.transcript || {});
  if (options.transcript !== undefined) {
    const suppliedTranscript = transcriptSnapshot(options.transcript);
    invariant(JSON.stringify(suppliedTranscript) === JSON.stringify(canonicalTranscript),
      'Checkpoint transcript metadata must exactly match canonical session evidence.', 'TRANSCRIPT_EVIDENCE_MISMATCH');
  }
  const rendered = checkpointMarkdown(session, { ...options, turnNumber, transcript: canonicalTranscript });
  const filename = resolveArtifact(options.workspace, session.paths.checkpoint);
  await rejectSymlinkPath(filename, { allowMissing: true });
  if (process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT === 'checkpoint-before-write') throw lifecycleError('Injected lifecycle failure before checkpoint write.', 'TEST_FAILPOINT');
  let disposition;
  if (await pathExists(filename)) {
    const existing = await readRegularFile(filename);
    const parsed = frontmatter(existing, { expectedRecordKind: 'session_checkpoint' });
    invariant(parsed.fields.record_kind === 'session_checkpoint' && parsed.fields.session_id === session.id, 'Checkpoint path belongs to another session.', 'ARTIFACT_COLLISION');
    if (!options.planOnly) await atomicWriteFile(filename, rendered.data, { mode: PRIVATE_FILE_MODE });
    disposition = options.planOnly ? 'would_replace_atomically' : 'replaced_atomically';
  } else {
    if (!options.planOnly) await atomicExclusiveWrite(filename, rendered.data);
    disposition = options.planOnly ? 'would_create_exclusively' : 'created_exclusively';
  }
  if (!options.planOnly) await verifyExactFile(filename, rendered.data);
  const updated = clone(session);
  updated.lastPersistedTurn = turnNumber;
  updated.transcript = rendered.transcript;
  updated.checkpoint = { path: session.paths.checkpoint, updatedAt: rendered.updatedAt, lastPersistedTurn: turnNumber };
  return {
    status: 'checkpointed',
    writeDisposition: disposition,
    session: updated,
    canonicalPatch: canonicalPatch(updated),
    written: [session.paths.checkpoint]
  };
}

function normalizeGap(gap) {
  invariant(gap && typeof gap === 'object' && !Array.isArray(gap) && GAP_REASONS.has(gap.reason), 'Transcript gap metadata is invalid.', 'INVALID_TRANSCRIPT_COVERAGE');
  const output = { reason: gap.reason };
  if (gap.fromTurn !== undefined || gap.toTurn !== undefined) {
    invariant(Number.isSafeInteger(gap.fromTurn) && gap.fromTurn > 0 && Number.isSafeInteger(gap.toTurn) && gap.toTurn >= gap.fromTurn, 'Transcript turn gap is invalid.', 'INVALID_TRANSCRIPT_COVERAGE');
    output.fromTurn = gap.fromTurn;
    output.toTurn = gap.toTurn;
  }
  if (gap.from !== undefined || gap.to !== undefined) {
    output.from = assertTimestamp(gap.from, 'Transcript gap start');
    output.to = gap.to === null ? null : assertTimestamp(gap.to, 'Transcript gap end');
    if (output.to !== null) invariant(Date.parse(output.to) >= Date.parse(output.from), 'Transcript gap ends before it starts.', 'INVALID_TRANSCRIPT_COVERAGE');
  }
  invariant(output.fromTurn !== undefined || output.from !== undefined, 'Transcript gap range is missing.', 'INVALID_TRANSCRIPT_COVERAGE');
  return output;
}

function normalizeTranscript(input, session, finalizedAt) {
  assertSessionDescriptor(session);
  invariant(input && CAPTURE_GRADES.has(input.captureGrade), 'A valid transcript capture grade is required.', 'INVALID_CAPTURE_GRADE');
  const sessionStartedAt = Date.parse(session.startedAt);
  const transcriptFinalizedAt = Date.parse(assertTimestamp(finalizedAt, 'Transcript finalization'));
  invariant(transcriptFinalizedAt >= sessionStartedAt, 'Transcript finalization precedes the session start.', 'INVALID_TRANSCRIPT_COVERAGE');
  const turns = clone(input.turns || []);
  invariant(Array.isArray(turns) && turns.length <= MAX_TRANSCRIPT_TURNS, 'Transcript turns must be a bounded array.', 'INVALID_TRANSCRIPT_COVERAGE');
  let previous = 0;
  const computedGaps = [];
  for (const turn of turns) {
    invariant(Number.isSafeInteger(turn.number) && turn.number > previous, 'Transcript turns must be positive and strictly increasing.', 'INVALID_TRANSCRIPT_COVERAGE');
    invariant(SPEAKERS.has(turn.speaker), 'Transcript speaker must be user or companion.', 'INVALID_TRANSCRIPT_COVERAGE');
    const capturedAt = Date.parse(assertTimestamp(turn.capturedAt, 'Transcript turn timestamp'));
    invariant(capturedAt >= sessionStartedAt && capturedAt <= transcriptFinalizedAt, 'Transcript turn timestamp falls outside the session.', 'INVALID_TRANSCRIPT_COVERAGE');
    assertText(turn.content, 'Transcript turn');
    if (previous === 0 && turn.number > 1) computedGaps.push({ fromTurn: 1, toTurn: turn.number - 1, reason: 'capture_started_late' });
    else if (previous > 0 && turn.number > previous + 1) computedGaps.push({ fromTurn: previous + 1, toTurn: turn.number - 1, reason: 'not_captured' });
    previous = turn.number;
  }
  const expectedLastTurn = input.expectedLastTurn === undefined ? previous : Number(input.expectedLastTurn);
  invariant(Number.isSafeInteger(expectedLastTurn) && expectedLastTurn >= previous, 'Expected transcript coverage is invalid.', 'INVALID_TRANSCRIPT_COVERAGE');
  if (previous > 0 && expectedLastTurn > previous) computedGaps.push({ fromTurn: previous + 1, toTurn: expectedLastTurn, reason: 'capture_ended_early' });
  invariant(Array.isArray(input.knownGaps || []) && (input.knownGaps || []).length <= MAX_TRANSCRIPT_GAPS, 'Transcript gaps must be a bounded array.', 'INVALID_TRANSCRIPT_COVERAGE');
  invariant(Array.isArray(input.pausedIntervals || []) && (input.pausedIntervals || []).length <= MAX_PAUSED_INTERVALS, 'Transcript pauses must be a bounded array.', 'INVALID_TRANSCRIPT_COVERAGE');
  const knownGaps = [...(input.knownGaps || []).map(normalizeGap), ...computedGaps].map((gap) => {
    if (gap.from === undefined) return gap;
    const closedGap = gap.to === null ? { ...gap, to: finalizedAt } : gap;
    const startedAt = Date.parse(closedGap.from);
    const endedAt = Date.parse(closedGap.to);
    invariant(startedAt >= sessionStartedAt && startedAt <= transcriptFinalizedAt && endedAt <= transcriptFinalizedAt,
      'Transcript gap falls outside the session.', 'INVALID_TRANSCRIPT_COVERAGE');
    return closedGap;
  });
  const pausedIntervals = (input.pausedIntervals || []).map(normalizePausedInterval).map((interval) => (
    interval.endedAt === null ? { ...interval, endedAt: finalizedAt } : interval
  ));
  for (const interval of pausedIntervals) {
    const startedAt = Date.parse(interval.startedAt);
    const endedAt = interval.endedAt === null ? transcriptFinalizedAt : Date.parse(interval.endedAt);
    invariant(startedAt >= sessionStartedAt && startedAt <= transcriptFinalizedAt && endedAt <= transcriptFinalizedAt,
      'Transcript pause interval falls outside the session.', 'INVALID_TRANSCRIPT_COVERAGE');
    invariant(!turns.some((turn) => {
      const capturedAt = Date.parse(turn.capturedAt);
      return capturedAt >= startedAt && capturedAt < endedAt;
    }), 'Transcript contains a captured turn inside a no-backfill pause interval.', 'INVALID_TRANSCRIPT_COVERAGE');
  }
  for (const interval of pausedIntervals) {
    if (!knownGaps.some((gap) => gap.reason === 'paused_no_backfill'
      && gap.from === interval.startedAt && gap.to === interval.endedAt)) {
      knownGaps.push({ from: interval.startedAt, to: interval.endedAt, reason: 'paused_no_backfill' });
    }
  }
  invariant(knownGaps.length <= MAX_TRANSCRIPT_GAPS, 'Transcript gap metadata is too large.', 'INVALID_TRANSCRIPT_COVERAGE');
  const expectedCapability = input.captureGrade === 'client_captured'
    ? 'authoritative_client_event_stream'
    : input.captureGrade === 'turn_captured'
      ? 'transactional_per_turn_capture'
      : null;
  // Transcript JSON is caller-controlled. No public field can attest a capture
  // capability; high-grade evidence stays downgraded until a non-forgeable
  // adapter channel is implemented.
  const capabilityProofVerified = false;
  const baseGrade = expectedCapability && !capabilityProofVerified ? 'best_effort_context' : input.captureGrade;
  const fullCoverageProven = capabilityProofVerified && input.captureComplete === true && turns.length > 0 && turns[0].number === 1 && previous === expectedLastTurn && knownGaps.length === 0;
  const captureGrade = knownGaps.length ? 'partial' : baseGrade;
  const coveredTurns = turns.length ? { first: turns[0].number, last: previous, count: turns.length } : null;
  return {
    state: 'finalized',
    sessionId: session.id,
    captureGrade,
    captureMethod: input.captureGrade,
    coveredTurns,
    knownGaps,
    pausedIntervals,
    finalizedAt,
    fullCoverageProven,
    capabilityProofVerified,
    verbatimClaim: false,
    turns
  };
}

function transcriptMarkdown(session, transcript) {
  let body = '# Session Transcript\n\n';
  for (const turn of transcript.turns) {
    body += `<!-- turn:${turn.number} captured_at:${turn.capturedAt} -->\n${turn.speaker}: ${turn.content}\n\n`;
  }
  const bytesAfterFrontmatter = `\n${body}`;
  const bodyHash = sha256Buffer(Buffer.from(bytesAfterFrontmatter));
  const data = `---\nrecord_kind: transcript\nsession_id: ${session.id}\nstarted_at: ${session.startedAt}\nfinalized_at: ${transcript.finalizedAt}\ntimezone: ${session.timezone}\nconsent_event_id: ${session.consentEventId || 'unknown'}\ncapture_grade: ${transcript.captureGrade}\ncapture_method: ${transcript.captureMethod}\ncapability_proof_verified: ${transcript.capabilityProofVerified === true}\ncovered_turns: ${JSON.stringify(transcript.coveredTurns)}\nknown_gaps: ${JSON.stringify(transcript.knownGaps)}\npaused_intervals: ${JSON.stringify(transcript.pausedIntervals)}\nfull_coverage_proven: ${transcript.fullCoverageProven}\nverbatim_claim: false\nbody_sha256: ${bodyHash}\n---\n${bytesAfterFrontmatter}`;
  invariant(Buffer.byteLength(data) <= MAX_ARTIFACT_BYTES, 'Transcript artifact is too large.', 'ARTIFACT_TOO_LARGE');
  return data;
}

function sessionNoteMarkdown(session, options, transcriptRelative, deepDiveRelative) {
  const body = assertText(options.noteBody, 'Session note');
  invariant(!body.startsWith('---\n'), 'Session note body must not supply frontmatter.', 'INVALID_ARTIFACT_CONTENT');
  const completion = options.completion || 'complete';
  invariant(['complete', 'interrupted_partial'].includes(completion), 'Session completion is invalid.', 'SESSION_STATE_INVALID');
  const authorName = assertText(session.authorName || 'Susan', 'Companion author name');
  invariant(!/[\r\n]/.test(authorName), 'Companion author name cannot contain newlines.', 'INVALID_ARTIFACT_CONTENT');
  const deepDiveField = deepDiveRelative ? `\ndeep_dive: ${deepDiveRelative}` : '';
  return `---\nrecord_kind: ai_authored_session_note\nauthor_role: ai_companion\nauthor_name: ${JSON.stringify(authorName)}\nsession_id: ${session.id}\nstarted_at: ${session.startedAt}\nclosed_at: ${options.closedAt}\ntimezone: ${session.timezone}\ncompletion: ${completion}\nsource_transcript: ${transcriptRelative || 'none'}\nconsent_event_id: ${session.consentEventId || 'unknown'}${deepDiveField}\n---\n\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

function deepDiveMarkdown(session, options) {
  const body = assertText(options.deepDiveBody, 'Deep dive');
  invariant(!body.startsWith('---\n'), 'Deep-dive body must not supply frontmatter.', 'INVALID_ARTIFACT_CONTENT');
  const authorName = assertText(session.authorName || 'Susan', 'Companion author name');
  invariant(!/[\r\n]/.test(authorName), 'Companion author name cannot contain newlines.', 'INVALID_ARTIFACT_CONTENT');
  const artifactId = `artifact-${session.id.slice(2).toLowerCase()}`;
  const data = `---\nrecord_kind: ai_authored_deep_dive\nartifact_id: ${artifactId}\nauthor_role: ai_companion\nauthor_name: ${JSON.stringify(authorName)}\nsession_id: ${session.id}\ncreated_at: ${options.closedAt}\ntimezone: ${session.timezone}\nconsent_event_id: ${session.consentEventId || 'unknown'}\nsource_memory_ids: []\nsource_ids: []\n---\n\n${body.endsWith('\n') ? body : `${body}\n`}`;
  invariant(Buffer.byteLength(data) <= MAX_ARTIFACT_BYTES, 'Deep-dive artifact is too large.', 'ARTIFACT_TOO_LARGE');
  return data;
}

async function removeOwnedCheckpoint(workspace, session, options = {}) {
  assertSessionDescriptor(session);
  const filename = resolveArtifact(workspace, session.paths.checkpoint);
  if (!await pathExists(filename)) return false;
  if (options.withoutContentRead) {
    await rejectSymlinkPath(filename);
    const stat = await fsp.lstat(filename);
    invariant(stat.isFile(), 'Checkpoint must be a regular file.', 'UNSUPPORTED_FILE_TYPE');
    invariant(path.basename(filename).includes(`--${session.id.slice(2)}--checkpoint.md`), 'Checkpoint filename belongs to another session.', 'ARTIFACT_COLLISION');
  } else {
    const existing = await readRegularFile(filename);
    const parsed = frontmatter(existing, { expectedRecordKind: 'session_checkpoint' });
    invariant(parsed.fields.record_kind === 'session_checkpoint' && parsed.fields.session_id === session.id, 'Checkpoint path belongs to another session.', 'ARTIFACT_COLLISION');
  }
  if (!options.planOnly) {
    await fsp.unlink(filename);
    await fsyncDirectory(path.dirname(filename));
  }
  return true;
}

function failpoint(name) {
  if (process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT === name) throw lifecycleError(`Injected lifecycle failure at ${name}.`, 'TEST_FAILPOINT');
}

async function closeSession(options = {}) {
  invariant(options.explicit === true, 'Session close requires an explicit user/client close event.', 'EXPLICIT_CLOSE_REQUIRED');
  const session = clone(options.session);
  assertSessionDescriptor(session);
  invariant(session && ['active', 'interrupted'].includes(session.state), 'Only an active or interrupted session can close.', 'SESSION_STATE_INVALID');
  const closedAt = assertTimestamp(options.now || new Date().toISOString(), 'Session close');
  const completion = options.completion || (session.state === 'interrupted' ? 'interrupted_partial' : 'complete');
  invariant(completion === 'complete' || completion === 'interrupted_partial', 'Session completion is invalid.', 'SESSION_STATE_INVALID');
  invariant(!(options.primerBody !== undefined && options.primerFields !== undefined), 'Next primer accepts either canonical fields or a complete file body, not both.', 'INVALID_ARGUMENT');
  const noteGate = persistenceDecision(options.canonicalState, 'session_notes');
  const primerGate = persistenceDecision(options.canonicalState, 'primers_and_checkpoints');
  const transcriptGate = transcriptDecision(options.canonicalState);
  const primer = primerGate.allowed && (options.primerBody !== undefined || options.primerFields !== undefined)
    ? options.primerFields === undefined
      ? validatePrimerSingletonMarkdown(assertText(options.primerBody, 'Next primer'))
      : renderPrimerSingleton({
        ...options.primerFields,
        closedSession: session.id,
        closedAt
      })
    : null;
  const shouldWriteTranscript = Boolean(options.transcript) && transcriptGate.allowed;
  let normalizedTranscript = transcriptSnapshot(session.transcript || {});
  invariant(normalizedTranscript.finalizedAt === null || Date.parse(normalizedTranscript.finalizedAt) <= Date.parse(closedAt),
    'Session close cannot precede transcript finalization.', 'INVALID_TRANSCRIPT_COVERAGE');
  const terminalPausedIntervals = clone(normalizedTranscript.pausedIntervals);
  const terminalKnownGaps = clone(normalizedTranscript.knownGaps);
  if (normalizedTranscript.state === 'stopped' && normalizedTranscript.finalizedAt
    && Date.parse(normalizedTranscript.finalizedAt) < Date.parse(closedAt)
    && !terminalKnownGaps.some((gap) => gap.reason === 'capture_ended_early'
      && gap.from === normalizedTranscript.finalizedAt && gap.to === closedAt)) {
    terminalKnownGaps.push({ from: normalizedTranscript.finalizedAt, to: closedAt, reason: 'capture_ended_early' });
  }
  if (normalizedTranscript.state === 'paused') {
    const interval = terminalPausedIntervals.at(-1);
    if (interval?.endedAt === null) interval.endedAt = closedAt;
  }
  for (const interval of terminalPausedIntervals) {
    if (interval.endedAt !== null && !terminalKnownGaps.some((gap) => gap.reason === 'paused_no_backfill' && gap.from === interval.startedAt)) {
      terminalKnownGaps.push({ from: interval.startedAt, to: interval.endedAt, reason: 'paused_no_backfill' });
    }
  }
  if (normalizedTranscript.state === 'stopped') {
    normalizedTranscript = transcriptSnapshot({
      ...normalizedTranscript,
      pausedIntervals: terminalPausedIntervals,
      knownGaps: terminalKnownGaps,
      fullCoverageProven: false
    });
  }
  if (shouldWriteTranscript) {
    const suppliedGaps = Array.isArray(options.transcript.knownGaps) ? options.transcript.knownGaps : [];
    const suppliedPauses = Array.isArray(options.transcript.pausedIntervals) ? options.transcript.pausedIntervals : [];
    const suppliedTurns = Array.isArray(options.transcript.turns) ? options.transcript.turns : [];
    for (const gap of terminalKnownGaps) {
      if (gap.from === undefined) continue;
      const from = Date.parse(gap.from);
      const to = gap.to === null ? Date.parse(closedAt) : Date.parse(gap.to);
      invariant(!suppliedTurns.some((turn) => {
        const capturedAt = Date.parse(turn?.capturedAt);
        return Number.isFinite(capturedAt) && capturedAt >= from && capturedAt < to;
      }), 'Transcript contains a captured turn inside canonical no-capture evidence.', 'INVALID_TRANSCRIPT_COVERAGE');
    }
    const mergeUnique = (left, right) => {
      const seen = new Set();
      return [...left, ...right].filter((item) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    normalizedTranscript = normalizeTranscript({
      ...options.transcript,
      knownGaps: mergeUnique(terminalKnownGaps, suppliedGaps),
      pausedIntervals: mergeUnique(terminalPausedIntervals, suppliedPauses)
    }, session, closedAt);
  } else if (['recording', 'paused'].includes(normalizedTranscript.state)) {
    normalizedTranscript = transcriptSnapshot({
      ...normalizedTranscript,
      state: 'stopped',
      finalizedAt: closedAt,
      pausedIntervals: terminalPausedIntervals,
      knownGaps: terminalKnownGaps,
      fullCoverageProven: false
    });
  }
  const pause = options.canonicalState?.consent?.memoryPause?.state || 'none';
  const anyWriteAllowed = noteGate.allowed || primerGate.allowed || transcriptGate.allowed;
  if (pause !== 'none' || !anyWriteAllowed) {
    const currentSessionId = options.canonicalState?.consent?.currentSessionId;
    const canonicalLifecycle = options.canonicalState?.sessionLifecycle;
    const closesCanonicalSession = typeof currentSessionId === 'string'
      && currentSessionId.toLowerCase() === session.id.toLowerCase()
      && typeof canonicalLifecycle?.sessionId === 'string'
      && canonicalLifecycle.sessionId.toLowerCase() === session.id.toLowerCase()
      && ['active', 'interrupted'].includes(canonicalLifecycle.state)
      && canonicalLifecycle.startedAt === session.startedAt;
    session.state = 'closed';
    session.closedAt = closedAt;
    session.completion = completion;
    session.transcript = normalizedTranscript;
    return {
      status: 'closed_ephemeral', writeDisposition: 'no_write',
      reason: pause !== 'none' ? pause : 'persistence_consent_off',
      session,
      canonicalPatch: closesCanonicalSession
        ? canonicalPatch(session, {
          state: 'closed', currentSessionId: null, checkpoint: session.checkpoint || null,
          transcript: normalizedTranscript, closedAt, completion
        })
        : null,
      written: [], checkpointRetained: Boolean(session.checkpoint)
    };
  }

  const written = [];
  const transcriptRelative = shouldWriteTranscript ? session.paths.transcript : null;
  const shouldWriteDeepDive = options.deepDiveBody !== undefined && noteGate.allowed;
  const deepDiveRelative = shouldWriteDeepDive ? session.paths.deepDive : null;
  failpoint('close-before-artifacts');

  if (shouldWriteDeepDive) {
    const deepDive = deepDiveMarkdown(session, { ...options, closedAt });
    const deepDivePath = resolveArtifact(options.workspace, session.paths.deepDive);
    if (options.planOnly) await planExclusiveArtifact(deepDivePath, deepDive, 'ai_authored_deep_dive', session.id);
    else await writeExclusiveArtifact(deepDivePath, deepDive, 'ai_authored_deep_dive', session.id);
    written.push(session.paths.deepDive);
  }
  failpoint('close-after-deep-dive');

  if (noteGate.allowed) {
    invariant(typeof options.noteBody === 'string', 'A consented close requires a session note body.', 'SESSION_NOTE_REQUIRED');
    const note = sessionNoteMarkdown(session, { ...options, closedAt, completion }, transcriptRelative, deepDiveRelative);
    const notePath = resolveArtifact(options.workspace, session.paths.sessionNote);
    if (options.planOnly) await planExclusiveArtifact(notePath, note, 'ai_authored_session_note', session.id);
    else await writeExclusiveArtifact(notePath, note, 'ai_authored_session_note', session.id);
    written.push(session.paths.sessionNote);
  }
  failpoint('close-after-note');

  if (shouldWriteTranscript) {
    const transcript = transcriptMarkdown(session, normalizedTranscript);
    const transcriptPath = resolveArtifact(options.workspace, session.paths.transcript);
    if (options.planOnly) await planExclusiveArtifact(transcriptPath, transcript, 'transcript', session.id);
    else await writeExclusiveArtifact(transcriptPath, transcript, 'transcript', session.id);
    written.push(session.paths.transcript);
  }
  failpoint('close-after-transcript');

  if (primer !== null) {
    const primerPath = resolveArtifact(options.workspace, 'NEXT-PRIMER.md');
    await rejectSymlinkPath(primerPath, { allowMissing: true });
    if (!options.planOnly) await atomicWriteFile(primerPath, primer.endsWith('\n') ? primer : `${primer}\n`, { mode: PRIVATE_FILE_MODE });
    written.push('NEXT-PRIMER.md');
  }
  failpoint('close-before-checkpoint-remove');
  const checkpointRemoved = primerGate.allowed ? await removeOwnedCheckpoint(options.workspace, session, { planOnly: options.planOnly === true }) : false;

  session.state = 'closed';
  session.closedAt = closedAt;
  session.completion = completion;
  if (checkpointRemoved || !session.checkpoint) session.checkpoint = null;
  session.transcript = normalizedTranscript;
  const retainedCheckpoint = session.checkpoint || null;
  return {
    status: 'closed',
    writeDisposition: 'artifacts_verified_patch_required',
    session,
    canonicalPatch: canonicalPatch(session, { state: 'closed', currentSessionId: null, checkpoint: retainedCheckpoint, transcript: normalizedTranscript, closedAt, completion }),
    written,
    skipped: {
      sessionNote: noteGate.allowed ? null : noteGate.reason,
      deepDive: options.deepDiveBody !== undefined && !noteGate.allowed ? noteGate.reason : null,
      primer: primerGate.allowed ? null : primerGate.reason,
      transcript: options.transcript && !transcriptGate.allowed ? transcriptGate.reason : null
    },
    checkpointRetained: !checkpointRemoved && Boolean(options.session.checkpoint)
  };
}

function parseCheckpointArray(fields, name, maxItems) {
  let value;
  try {
    value = JSON.parse(fields[name]);
  } catch {
    throw lifecycleError('Checkpoint metadata contains invalid JSON.', 'CHECKPOINT_METADATA_INVALID', { field: name });
  }
  invariant(Array.isArray(value) && value.length <= maxItems, 'Checkpoint metadata array is invalid or too large.', 'CHECKPOINT_METADATA_INVALID', { field: name });
  return value;
}

function checkpointBoolean(fields, name) {
  invariant(['true', 'false'].includes(fields[name]), 'Checkpoint boolean metadata is invalid.', 'CHECKPOINT_METADATA_INVALID', { field: name });
  return fields[name] === 'true';
}

function parseCheckpointTranscript(fields, sessionId) {
  const knownGaps = parseCheckpointArray(fields, 'known_gaps', MAX_TRANSCRIPT_GAPS).map(normalizeGap);
  let coveredTurns;
  try {
    coveredTurns = normalizeCoveredTurns(JSON.parse(fields.covered_turns));
  } catch (error) {
    throw lifecycleError('Checkpoint coverage metadata is invalid.', 'CHECKPOINT_METADATA_INVALID', { causeCode: error.code || 'INVALID_JSON' });
  }
  const currentFormat = Object.hasOwn(fields, 'paused_intervals');
  if (!currentFormat) {
    invariant(
      fields.transcript_state === 'off' && fields.capture_grade === 'none'
        && coveredTurns === null && knownGaps.length === 0,
      'Legacy checkpoint transcript evidence is incomplete and cannot be recovered safely.',
      'CHECKPOINT_METADATA_INVALID'
    );
    return transcriptSnapshot();
  }
  const pausedIntervals = parseCheckpointArray(fields, 'paused_intervals', MAX_PAUSED_INTERVALS).map(normalizePausedInterval);
  const finalizedAt = fields.finalized_at === 'null'
    ? null
    : assertTimestamp(fields.finalized_at, 'Checkpoint transcript finalization');
  const captureGrade = fields.capture_grade === 'none' ? null : fields.capture_grade;
  const captureMethod = fields.capture_method === 'none' ? null : fields.capture_method;
  const capabilityProofVerified = checkpointBoolean(fields, 'capability_proof_verified');
  const fullCoverageProven = checkpointBoolean(fields, 'full_coverage_proven');
  invariant(fields.verbatim_claim === 'false', 'Checkpoint transcript cannot claim verbatim capture.', 'CHECKPOINT_METADATA_INVALID');
  // Checkpoints are not signed adapter attestations. Until an attested channel
  // exists, persisted recovery evidence must never elevate these claims.
  invariant(capabilityProofVerified === false && fullCoverageProven === false,
    'Checkpoint capability claims are not independently attested.', 'CHECKPOINT_METADATA_INVALID');
  const input = {
    state: fields.transcript_state,
    sessionId: fields.transcript_state === 'off' ? null : sessionId,
    captureGrade,
    captureMethod,
    coveredTurns,
    knownGaps,
    pausedIntervals,
    finalizedAt,
    capabilityProofVerified: false,
    fullCoverageProven: false,
    verbatimClaim: false
  };
  const transcript = transcriptSnapshot(input);
  for (const key of ['state', 'sessionId', 'captureGrade', 'captureMethod', 'coveredTurns', 'knownGaps', 'pausedIntervals', 'finalizedAt', 'capabilityProofVerified', 'fullCoverageProven', 'verbatimClaim']) {
    invariant(JSON.stringify(transcript[key]) === JSON.stringify(input[key]),
      'Checkpoint transcript metadata is not canonical.', 'CHECKPOINT_METADATA_INVALID', { field: key });
  }
  return transcript;
}

async function findInterruptedSessions(options = {}) {
  const consent = options.canonicalState?.consent;
  invariant(consent, 'Canonical consent state is required.', 'CONSENT_STATE_INVALID');
  if (consent.memoryPause?.state === 'sealed_pause') return { status: 'sealed', candidates: [], checkpointFilesRead: false, checkpointBodyExposed: false };
  if (consent.continuityMemory !== 'on') return { status: 'disabled', candidates: [], checkpointFilesRead: false, checkpointBodyExposed: false };
  if (consent.retention?.primers_and_checkpoints === 'do_not_store') return { status: 'retention_disabled', candidates: [], checkpointFilesRead: false, checkpointBodyExposed: false };
  const directory = resolveArtifact(options.workspace, 'archive/checkpoints');
  await rejectSymlinkPath(directory, { allowMissing: true });
  if (!await pathExists(directory)) return { status: 'none', candidates: [], checkpointFilesRead: false, checkpointBodyExposed: false };
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries.sort((a, b) => compareCodePoint(a.name, b.name))) {
    if (!entry.name.endsWith('--checkpoint.md')) continue;
    const relative = `archive/checkpoints/${entry.name}`;
    const filename = resolveArtifact(options.workspace, relative);
    const raw = await readRegularFile(filename);
    const parsed = frontmatter(raw, { expectedRecordKind: 'session_checkpoint', code: 'CHECKPOINT_METADATA_INVALID' });
    if (parsed.fields.record_kind !== 'session_checkpoint' || !SESSION_ID_PATTERN.test(parsed.fields.session_id || '')) continue;
    if (!['active', 'interrupted'].includes(parsed.fields.lifecycle_state)) continue;
    const canonicalLifecycle = options.canonicalState?.sessionLifecycle;
    if (['closed', 'abandoned'].includes(canonicalLifecycle?.state)
      && canonicalLifecycle.sessionId?.toLowerCase() === parsed.fields.session_id.toLowerCase()) {
      continue;
    }
    try {
      assertTimestamp(parsed.fields.started_at, 'Checkpoint session start');
      assertTimestamp(parsed.fields.updated_at, 'Checkpoint update');
      assertTimezone(parsed.fields.timezone, parsed.fields.started_at);
    } catch (error) {
      throw lifecycleError('Checkpoint timestamp or timezone metadata is invalid.', 'CHECKPOINT_METADATA_INVALID', { causeCode: error.code || 'INVALID_TIMESTAMP' });
    }
    const lastPersistedTurn = parsed.fields.last_persisted_turn === 'null' ? null : Number(parsed.fields.last_persisted_turn);
    invariant(lastPersistedTurn === null || (Number.isSafeInteger(lastPersistedTurn) && lastPersistedTurn > 0), 'Checkpoint turn metadata is invalid.', 'CHECKPOINT_METADATA_INVALID');
    let resumedAt;
    let recoveredTranscript;
    try {
      resumedAt = parseCheckpointArray(parsed.fields, 'resumed_at', MAX_PAUSED_INTERVALS).map((value) => assertTimestamp(value, 'Checkpoint resume'));
      recoveredTranscript = parseCheckpointTranscript(parsed.fields, parsed.fields.session_id);
    } catch (error) {
      if (error.code === 'CHECKPOINT_METADATA_INVALID') throw error;
      throw lifecycleError('Checkpoint coverage metadata is invalid.', 'CHECKPOINT_METADATA_INVALID', { causeCode: error.code || 'INVALID_JSON' });
    }
    const uuid = parsed.fields.session_id.slice(2);
    const sessionsDirectory = resolveArtifact(options.workspace, 'sessions');
    const sessionEntries = await fsp.readdir(sessionsDirectory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const closeArtifactPresent = sessionEntries.some((name) => name.includes(`--${uuid}--session.md`));
    const checkpoint = {
      path: relative,
      updatedAt: parsed.fields.updated_at,
      lastPersistedTurn
    };
    let recoveredSession = {
      id: parsed.fields.session_id,
      state: 'interrupted',
      startedAt: parsed.fields.started_at,
      startedAtUtc: new Date(parsed.fields.started_at).toISOString(),
      timezone: parsed.fields.timezone,
      resumedAt,
      closedAt: null,
      completion: null,
      lastPersistedTurn: checkpoint.lastPersistedTurn,
      paths: artifactPaths(parsed.fields.started_at, parsed.fields.session_id),
      checkpoint,
      transcript: recoveredTranscript
    };
    const canonicalMatches = ['active', 'interrupted'].includes(canonicalLifecycle?.state)
      && canonicalLifecycle.sessionId?.toLowerCase() === parsed.fields.session_id.toLowerCase()
      && canonicalLifecycle.checkpoint?.path === relative;
    if (canonicalMatches) {
      invariant(canonicalLifecycle.startedAt === parsed.fields.started_at
        && canonicalLifecycle.timezone === parsed.fields.timezone,
      'Checkpoint identity conflicts with canonical lifecycle state.', 'CHECKPOINT_METADATA_INVALID');
      recoveredSession = {
        ...recoveredSession,
        startedAt: canonicalLifecycle.startedAt,
        startedAtUtc: canonicalLifecycle.startedAtUtc,
        timezone: canonicalLifecycle.timezone,
        resumedAt: clone(canonicalLifecycle.resumedAt),
        lastPersistedTurn: canonicalLifecycle.checkpoint.lastPersistedTurn,
        checkpoint: clone(canonicalLifecycle.checkpoint),
        transcript: transcriptSnapshot(canonicalLifecycle.transcript)
      };
    }
    validateSessionLifecyclePatch({
      consent: { currentSessionId: recoveredSession.id },
      sessionLifecycle: {
        state: 'interrupted', sessionId: recoveredSession.id,
        startedAt: recoveredSession.startedAt, startedAtUtc: recoveredSession.startedAtUtc,
        timezone: recoveredSession.timezone, resumedAt: clone(recoveredSession.resumedAt),
        closedAt: null, completion: null, checkpoint: clone(recoveredSession.checkpoint),
        transcript: clone(recoveredSession.transcript)
      }
    });
    candidates.push({
      sessionId: parsed.fields.session_id,
      checkpointPath: relative,
      startedAt: parsed.fields.started_at,
      updatedAt: parsed.fields.updated_at,
      timezone: parsed.fields.timezone,
      lifecycleState: parsed.fields.lifecycle_state,
      lastPersistedTurn: checkpoint.lastPersistedTurn,
      captureGrade: recoveredSession.transcript.captureGrade,
      knownGaps: recoveredSession.transcript.knownGaps,
      recoveryReason: closeArtifactPresent ? 'close_incomplete' : 'interrupted',
      session: recoveredSession
    });
  }
  return {
    status: candidates.length ? 'recovery_available' : 'none',
    candidates,
    checkpointFilesRead: entries.some((entry) => entry.name.endsWith('--checkpoint.md')),
    checkpointBodyExposed: false
  };
}

function finalizeInterruptedTranscript(session, now) {
  const current = transcriptSnapshot(session.transcript || {});
  if (!['recording', 'paused'].includes(current.state)) return current;
  const pausedIntervals = clone(current.pausedIntervals || []);
  const knownGaps = clone(current.knownGaps || []);
  if (current.state === 'paused') {
    const interval = pausedIntervals.at(-1);
    if (interval?.endedAt === null) interval.endedAt = now;
    if (interval && !knownGaps.some((gap) => gap.reason === 'paused_no_backfill'
      && gap.from === interval.startedAt && gap.to === interval.endedAt)) {
      knownGaps.push({ from: interval.startedAt, to: interval.endedAt, reason: 'paused_no_backfill' });
    }
  }
  const interruptedFrom = session.checkpoint?.updatedAt || session.startedAt;
  if (!knownGaps.some((gap) => gap.reason === 'interrupted' && gap.from === interruptedFrom && gap.to === now)) {
    knownGaps.push({ from: interruptedFrom, to: now, reason: 'interrupted' });
  }
  return transcriptSnapshot({
    ...current,
    state: 'stopped',
    pausedIntervals,
    knownGaps,
    finalizedAt: now,
    fullCoverageProven: false
  });
}

async function recoverSession(options = {}) {
  const action = options.action;
  invariant(['continue', 'close_interrupted', 'delete', 'abandon'].includes(action), 'Recovery action is invalid.', 'INVALID_ARGUMENT');
  const session = clone(options.session);
  assertSessionDescriptor(session);
  invariant(session && ['active', 'interrupted'].includes(session.state), 'Recovery requires an interrupted session descriptor.', 'SESSION_STATE_INVALID');
  const now = assertTimestamp(options.now || new Date().toISOString(), 'Recovery timestamp');
  invariant(Date.parse(now) >= Date.parse(session.startedAt)
    && (!session.checkpoint?.updatedAt || Date.parse(now) >= Date.parse(session.checkpoint.updatedAt)),
  'Recovery timestamp precedes the persisted session state.', 'INVALID_TIMESTAMP');
  session.transcript = finalizeInterruptedTranscript(session, now);
  if (action === 'close_interrupted') {
    session.state = 'interrupted';
    return closeSession({ ...options, session, now, explicit: true, completion: 'interrupted_partial' });
  }
  if (action === 'delete') {
    const deleted = await removeOwnedCheckpoint(options.workspace, session, { withoutContentRead: true, planOnly: options.planOnly === true });
    const terminalLifecycle = options.canonicalState?.sessionLifecycle;
    const preserveTerminalLifecycle = ['closed', 'abandoned'].includes(terminalLifecycle?.state)
      && terminalLifecycle.sessionId?.toLowerCase() === session.id.toLowerCase()
      && terminalLifecycle.checkpoint?.path === session.paths.checkpoint;
    session.state = preserveTerminalLifecycle ? terminalLifecycle.state : 'abandoned';
    session.checkpoint = null;
    return {
      status: 'deleted', session,
      canonicalPatch: preserveTerminalLifecycle
        ? validateSessionLifecyclePatch({
          consent: { currentSessionId: null },
          sessionLifecycle: { ...clone(terminalLifecycle), checkpoint: null }
        })
        : canonicalPatch(session, { state: 'abandoned', currentSessionId: null, checkpoint: null }),
      written: [], deleted: deleted ? [session.paths.checkpoint] : []
    };
  }
  const gate = persistenceDecision(options.canonicalState, 'primers_and_checkpoints');
  if (!gate.allowed) {
    if (action !== 'abandon') return { status: 'skipped', reason: gate.reason, session, canonicalPatch: null, written: [] };
    session.state = 'abandoned';
    return {
      status: 'abandoned', reason: gate.reason, session,
      canonicalPatch: canonicalPatch(session, {
        state: 'abandoned', currentSessionId: null,
        checkpoint: session.checkpoint || null, transcript: session.transcript
      }),
      written: []
    };
  }
  const filename = resolveArtifact(options.workspace, session.paths.checkpoint);
  const raw = await readRegularFile(filename);
  const parsed = frontmatter(raw, { expectedRecordKind: 'session_checkpoint' });
  invariant(parsed.fields.record_kind === 'session_checkpoint' && parsed.fields.session_id === session.id, 'Checkpoint path belongs to another session.', 'ARTIFACT_COLLISION');
  if (action === 'continue') {
    invariant(options.canResumeContext === true, 'Continue requires proof that the same client context can resume.', 'RESUME_CONTEXT_UNAVAILABLE');
    session.state = 'active';
    session.resumedAt = [...(session.resumedAt || []), now];
  } else {
    session.state = 'abandoned';
  }
  const turn = session.lastPersistedTurn || session.checkpoint?.lastPersistedTurn;
  const header = checkpointHeader(session, session.transcript, now, turn);
  const updatedRaw = `---\n${header}\n---\n${parsed.body}`;
  if (!options.planOnly) {
    await atomicWriteFile(filename, updatedRaw, { mode: PRIVATE_FILE_MODE });
    await verifyExactFile(filename, updatedRaw);
  }
  session.checkpoint = { ...(session.checkpoint || {}), path: session.paths.checkpoint, updatedAt: now };
  return {
    status: action === 'continue' ? 'continued' : 'abandoned',
    session,
    canonicalPatch: canonicalPatch(session, { state: session.state, currentSessionId: action === 'continue' ? session.id : null }),
    written: [session.paths.checkpoint]
  };
}

module.exports = {
  SESSION_ID_PATTERN,
  CAPTURE_GRADES,
  assertTimestamp,
  artifactPaths,
  persistenceDecision,
  transcriptDecision,
  transcriptSnapshot,
  canonicalPatch,
  validateSessionLifecyclePatch,
  createEmptySessionLifecyclePatch,
  beginSession,
  checkpointTurn,
  closeSession,
  findInterruptedSessions,
  recoverSession,
  normalizeTranscript
};
