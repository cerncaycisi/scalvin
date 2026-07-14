'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { invariant } = require('./lib/errors');
const {
  assertInside,
  validateRelativePath,
  rejectSymlinkPath,
  pathExists,
  readBoundedRegularFile
} = require('./lib/fs-safe');

const SCHEMA_VERSION = 1;
const MAX_ENTITY_BYTES = 64 * 1024;
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_ENTITIES = 10_000;
const MAX_ALIASES = 12;
const MAX_ENTITY_REFERENCES = 64;
const MAX_MEMORY_REFERENCES = 64;
const MAX_SOURCE_REFERENCES = 32;
const MAX_SESSION_REFERENCES = 64;
const MAX_REVISION_HISTORY = 1_000;
const MAX_BACKFILL_CANDIDATES = 5;

const STATUSES = Object.freeze(['Core', 'Active', 'Provisional', 'Dormant']);
const TYPES = Object.freeze(['person', 'place', 'event']);
const STATUS_LIMITS = Object.freeze({ Core: 12, Active: 24, Provisional: 10 });
const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_V4_PATTERN = new RegExp(`^${UUID_V4}$`);
const ENTITY_ID_PATTERN = new RegExp(`^(person|place|event)-${UUID_V4}$`);
const PERSON_ID_PATTERN = new RegExp(`^person-${UUID_V4}$`);
const PLACE_ID_PATTERN = new RegExp(`^place-${UUID_V4}$`);
const EVENT_ID_PATTERN = new RegExp(`^event-${UUID_V4}$`);
const SESSION_ID_PATTERN = new RegExp(`^s-${UUID_V4}$`);
const SOURCE_ID_PATTERN = new RegExp(`^src-${UUID_V4}$`);
const CONSENT_ID_PATTERN = new RegExp(`^consent-${UUID_V4}$`);
const DELETE_ID_PATTERN = new RegExp(`^delete-${UUID_V4}$`);
const MEMORY_ID_PATTERN = new RegExp(`^(?:mem|theme|focus)-${UUID_V4}$`);
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(Z|([+-])(\d{2}):(\d{2}))$/;

const CANDIDATE_KEYS = Object.freeze([
  'schemaVersion', 'type', 'id', 'label', 'aliases', 'summary', 'eventTime',
  'participantIds', 'placeIds', 'relatedEntityIds', 'memoryIds', 'sourceRefs',
  'sessionRefs'
]);
const ENTITY_KEYS = Object.freeze([
  'schemaVersion', 'type', 'id', 'status', 'label', 'aliases', 'summary',
  'eventTime', 'participantIds', 'placeIds', 'relatedEntityIds', 'memoryIds',
  'consentEventId', 'provenance', 'sourceRefs', 'sessionRefs', 'revision',
  'revisionHistory'
]);
const PATCH_KEYS = Object.freeze([
  'label', 'aliases', 'summary', 'eventTime', 'participantIds', 'placeIds',
  'relatedEntityIds', 'memoryIds', 'sourceRefs', 'sessionRefs'
]);
const REVISION_ACTIONS = new Set(['add', 'backfill', 'correct', 'status_change', 'merge', 'reference_rewrite']);
const EVENT_TIME_PRECISIONS = new Set(['exact', 'approximate', 'range', 'unknown']);

function compareCodePoint(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] < rightPoints[index]) return -1;
    if (leftPoints[index] > rightPoints[index]) return 1;
  }
  return leftPoints.length < rightPoints.length ? -1 : leftPoints.length > rightPoints.length ? 1 : 0;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value, expected, label, code = 'CONTEXT_RECORD_INVALID') {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`, code);
  const actual = Object.keys(value).sort(compareCodePoint);
  const wanted = [...expected].sort(compareCodePoint);
  invariant(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} has unknown or missing fields.`, code, { expected: wanted, actual });
}

function codePointLength(value) {
  return [...value].length;
}

function boundedText(value, label, options = {}) {
  const { minimum = 0, maximum = 2_000, singleLine = false, nullable = false } = options;
  if (nullable && value === null) return null;
  invariant(typeof value === 'string', `${label} must be text.`, 'CONTEXT_VALUE_INVALID');
  const unsupportedControls = singleLine ? /[\u0000-\u001f\u007f]/u : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  invariant(!unsupportedControls.test(value) && !value.includes('\r'), `${label} contains unsupported control characters.`, 'CONTEXT_VALUE_INVALID');
  if (singleLine) invariant(!value.includes('\n'), `${label} must be one line.`, 'CONTEXT_VALUE_INVALID');
  invariant(value === value.trim() && value === value.normalize('NFC'), `${label} must be trimmed NFC text.`, 'CONTEXT_VALUE_INVALID');
  const length = codePointLength(value);
  invariant(length >= minimum && length <= maximum, `${label} is outside its size bounds.`, 'CONTEXT_VALUE_INVALID', { minimum, maximum });
  invariant(Buffer.byteLength(value, 'utf8') <= maximum * 4, `${label} is outside its byte bound.`, 'CONTEXT_VALUE_INVALID');
  return value;
}

function canonicalTimestamp(value, label = 'Context timestamp') {
  const match = typeof value === 'string' ? value.match(TIMESTAMP_PATTERN) : null;
  invariant(match, `${label} must be canonical RFC 3339 with milliseconds.`, 'CONTEXT_TIMESTAMP_INVALID');
  const [, year, month, day, hour, minute, second, , zone, sign, offsetHour = '00', offsetMinute = '00'] = match;
  invariant(Number(second) <= 59 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59, `${label} must be a real canonical instant.`, 'CONTEXT_TIMESTAMP_INVALID');
  const epoch = Date.parse(value);
  invariant(!Number.isNaN(epoch), `${label} must be a real canonical instant.`, 'CONTEXT_TIMESTAMP_INVALID');
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute));
  const local = new Date(epoch + offset * 60_000);
  invariant(
    local.getUTCFullYear() === Number(year)
      && local.getUTCMonth() + 1 === Number(month)
      && local.getUTCDate() === Number(day)
      && local.getUTCHours() === Number(hour)
      && local.getUTCMinutes() === Number(minute)
      && local.getUTCSeconds() === Number(second),
    `${label} must be a real canonical instant.`,
    'CONTEXT_TIMESTAMP_INVALID'
  );
  return value;
}

function nullableTimestamp(value, label) {
  return value === null ? null : canonicalTimestamp(value, label);
}

function assertEntityId(value, expectedType = null) {
  invariant(typeof value === 'string' && ENTITY_ID_PATTERN.test(value), 'Context entity ID must be person-, place-, or event- plus a lowercase UUID-v4.', 'INVALID_CONTEXT_ID');
  const type = value.slice(0, value.indexOf('-'));
  invariant(expectedType === null || type === expectedType, 'Context entity ID prefix does not match its type.', 'INVALID_CONTEXT_ID');
  return value;
}

function entityType(value) {
  assertEntityId(value);
  return value.slice(0, value.indexOf('-'));
}

function entityRelative(value) {
  const type = entityType(value);
  const directory = type === 'person' ? 'people' : type === 'place' ? 'places' : 'events';
  return `context/${directory}/${value}.json`;
}

function canonicalArray(values, label, options = {}) {
  const { maximum = MAX_ENTITY_REFERENCES, validator = (item) => item, exclude = null } = options;
  invariant(Array.isArray(values) && values.length <= maximum, `${label} must be an array within its item limit.`, 'CONTEXT_VALUE_INVALID', { maximum });
  const normalized = values.map((item) => validator(item));
  invariant(!normalized.some((item) => item === exclude), `${label} cannot contain a self-reference.`, 'CONTEXT_REFERENCE_INVALID');
  const sorted = [...normalized].sort(compareCodePoint);
  invariant(sorted.every((item, index) => item === normalized[index]), `${label} must be sorted by Unicode code-point order.`, 'CONTEXT_RECORD_NONCANONICAL');
  invariant(new Set(normalized).size === normalized.length, `${label} contains duplicates.`, 'CONTEXT_DUPLICATE');
  return normalized;
}

function normalizeStringArray(values, label, options = {}) {
  return canonicalArray(values, label, {
    maximum: options.maximum,
    exclude: options.exclude,
    validator: (item) => boundedText(item, label, { minimum: 1, maximum: options.itemMaximum || 120, singleLine: true })
  });
}

function sourceRefKey(reference) {
  return `${reference.sourceId}\0${String(reference.revision).padStart(9, '0')}`;
}

function normalizeSourceRefs(values) {
  invariant(Array.isArray(values) && values.length <= MAX_SOURCE_REFERENCES, 'Source references must be a bounded array.', 'CONTEXT_VALUE_INVALID');
  const normalized = values.map((reference) => {
    exactKeys(reference, ['sourceId', 'revision'], 'Source reference');
    invariant(SOURCE_ID_PATTERN.test(reference.sourceId || ''), 'Source reference ID must be src-<UUID-v4>.', 'CONTEXT_REFERENCE_INVALID');
    invariant(Number.isSafeInteger(reference.revision) && reference.revision >= 1 && reference.revision <= 999_999, 'Source reference revision is invalid.', 'CONTEXT_REFERENCE_INVALID');
    return { sourceId: reference.sourceId, revision: reference.revision };
  });
  const keys = normalized.map(sourceRefKey);
  const sorted = [...keys].sort(compareCodePoint);
  invariant(sorted.every((item, index) => item === keys[index]), 'Source references must be sorted by source ID and revision.', 'CONTEXT_RECORD_NONCANONICAL');
  invariant(new Set(keys).size === keys.length, 'Source references contain duplicates.', 'CONTEXT_DUPLICATE');
  return normalized;
}

function normalizeEventTime(value, type) {
  if (type !== 'event') {
    invariant(value === null, 'Only event entities may have event time.', 'CONTEXT_VALUE_INVALID');
    return null;
  }
  exactKeys(value, ['value', 'precision'], 'Event time');
  invariant(EVENT_TIME_PRECISIONS.has(value.precision), 'Event time precision is invalid.', 'CONTEXT_VALUE_INVALID');
  if (value.precision === 'unknown') invariant(value.value === null, 'Unknown event time must have a null value.', 'CONTEXT_VALUE_INVALID');
  else boundedText(value.value, 'Event time value', { minimum: 1, maximum: 200, singleLine: true });
  return { value: value.value, precision: value.precision };
}

function validateCandidate(candidate) {
  exactKeys(candidate, CANDIDATE_KEYS, 'Context candidate', 'CONTEXT_CANDIDATE_INVALID');
  invariant(candidate.schemaVersion === SCHEMA_VERSION && TYPES.includes(candidate.type), 'Context candidate schema or type is invalid.', 'CONTEXT_CANDIDATE_INVALID');
  const id = assertEntityId(candidate.id, candidate.type);
  const label = boundedText(candidate.label, 'Context label', { minimum: 1, maximum: 120, singleLine: true });
  const aliases = normalizeStringArray(candidate.aliases, 'Context aliases', { maximum: MAX_ALIASES, itemMaximum: 120 });
  invariant(!aliases.includes(label), 'Context aliases cannot duplicate the current label.', 'CONTEXT_DUPLICATE');
  const summary = boundedText(candidate.summary, 'Context summary', { maximum: 2_000 });
  const eventTime = normalizeEventTime(candidate.eventTime, candidate.type);
  const participantIds = canonicalArray(candidate.participantIds, 'Participant IDs', {
    maximum: MAX_ENTITY_REFERENCES,
    validator: (item) => {
      invariant(PERSON_ID_PATTERN.test(item || ''), 'Participants must reference person UUID-v4 IDs.', 'CONTEXT_REFERENCE_INVALID');
      return item;
    },
    exclude: id
  });
  const placeIds = canonicalArray(candidate.placeIds, 'Place IDs', {
    maximum: MAX_ENTITY_REFERENCES,
    validator: (item) => {
      invariant(PLACE_ID_PATTERN.test(item || ''), 'Event places must reference place UUID-v4 IDs.', 'CONTEXT_REFERENCE_INVALID');
      return item;
    },
    exclude: id
  });
  if (candidate.type !== 'event') invariant(participantIds.length === 0 && placeIds.length === 0, 'Only events may have participants or place links.', 'CONTEXT_REFERENCE_INVALID');
  const relatedEntityIds = canonicalArray(candidate.relatedEntityIds, 'Related entity IDs', {
    maximum: MAX_ENTITY_REFERENCES,
    validator: (item) => assertEntityId(item),
    exclude: id
  });
  const memoryIds = canonicalArray(candidate.memoryIds, 'Memory IDs', {
    maximum: MAX_MEMORY_REFERENCES,
    validator: (item) => {
      invariant(MEMORY_ID_PATTERN.test(item || ''), 'Memory references must use mem-, theme-, or focus- UUID-v4 IDs.', 'CONTEXT_REFERENCE_INVALID');
      return item;
    }
  });
  const sourceRefs = normalizeSourceRefs(candidate.sourceRefs);
  const sessionRefs = canonicalArray(candidate.sessionRefs, 'Session references', {
    maximum: MAX_SESSION_REFERENCES,
    validator: (item) => {
      invariant(SESSION_ID_PATTERN.test(item || ''), 'Session references must use s-<UUID-v4>.', 'CONTEXT_REFERENCE_INVALID');
      return item;
    }
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    type: candidate.type,
    id,
    label,
    aliases,
    summary,
    eventTime,
    participantIds,
    placeIds,
    relatedEntityIds,
    memoryIds,
    sourceRefs,
    sessionRefs
  };
}

function candidateFromEntity(entity) {
  return validateCandidate({
    schemaVersion: SCHEMA_VERSION,
    type: entity.type,
    id: entity.id,
    label: entity.label,
    aliases: entity.aliases,
    summary: entity.summary,
    eventTime: entity.eventTime,
    participantIds: entity.participantIds,
    placeIds: entity.placeIds,
    relatedEntityIds: entity.relatedEntityIds,
    memoryIds: entity.memoryIds,
    sourceRefs: entity.sourceRefs,
    sessionRefs: entity.sessionRefs
  });
}

function normalizeRevisionHistory(values, revision) {
  invariant(Array.isArray(values) && values.length >= 1 && values.length <= MAX_REVISION_HISTORY, 'Revision history is outside its item limit.', 'CONTEXT_RECORD_INVALID');
  const normalized = values.map((entry, index) => {
    exactKeys(entry, ['revision', 'at', 'action', 'sessionId'], 'Revision history entry');
    invariant(entry.revision === index + 1, 'Revision history must be contiguous.', 'CONTEXT_RECORD_INVALID');
    canonicalTimestamp(entry.at, 'Revision timestamp');
    invariant(REVISION_ACTIONS.has(entry.action), 'Revision action is invalid.', 'CONTEXT_RECORD_INVALID');
    invariant(entry.sessionId === null || SESSION_ID_PATTERN.test(entry.sessionId), 'Revision session ID is invalid.', 'CONTEXT_RECORD_INVALID');
    if (index > 0) invariant(Date.parse(entry.at) >= Date.parse(values[index - 1].at), 'Revision timestamps must not move backward.', 'CONTEXT_RECORD_INVALID');
    return { revision: entry.revision, at: entry.at, action: entry.action, sessionId: entry.sessionId };
  });
  invariant(revision === normalized.length, 'Current revision does not match revision history.', 'CONTEXT_RECORD_INVALID');
  return normalized;
}

function validateEntity(entity) {
  exactKeys(entity, ENTITY_KEYS, 'Context entity');
  const candidate = validateCandidate(candidateFromUncheckedEntity(entity));
  invariant(STATUSES.includes(entity.status), 'Context status is invalid.', 'CONTEXT_STATUS_INVALID');
  invariant(CONSENT_ID_PATTERN.test(entity.consentEventId || ''), 'Context entity consent event is invalid.', 'CONTEXT_CONSENT_EVENT_INVALID');
  exactKeys(entity.provenance, ['origin', 'firstObservedAt', 'importedAt', 'lastLiveConfirmedAt', 'lastRelevantAt'], 'Context provenance');
  invariant(['live', 'imported'].includes(entity.provenance.origin), 'Context provenance origin is invalid.', 'CONTEXT_RECORD_INVALID');
  const firstObservedAt = nullableTimestamp(entity.provenance.firstObservedAt, 'First-observed timestamp');
  const importedAt = nullableTimestamp(entity.provenance.importedAt, 'Imported timestamp');
  const lastLiveConfirmedAt = nullableTimestamp(entity.provenance.lastLiveConfirmedAt, 'Last live-confirmed timestamp');
  const lastRelevantAt = nullableTimestamp(entity.provenance.lastRelevantAt, 'Last-relevant timestamp');
  if (entity.provenance.origin === 'live') invariant(firstObservedAt !== null && importedAt === null, 'Live provenance needs first-observed time and no import time.', 'CONTEXT_RECORD_INVALID');
  else invariant(firstObservedAt === null && importedAt !== null, 'Imported provenance needs import time and unknown first-observed time.', 'CONTEXT_RECORD_INVALID');
  invariant(Number.isSafeInteger(entity.revision) && entity.revision >= 1 && entity.revision <= MAX_REVISION_HISTORY, 'Context revision is invalid.', 'CONTEXT_RECORD_INVALID');
  const revisionHistory = normalizeRevisionHistory(entity.revisionHistory, entity.revision);
  invariant(revisionHistory[0].action === (entity.provenance.origin === 'live' ? 'add' : 'backfill'), 'Creation revision does not match provenance origin.', 'CONTEXT_RECORD_INVALID');
  invariant((entity.provenance.origin === 'live' ? firstObservedAt : importedAt) === revisionHistory[0].at, 'Creation provenance timestamp does not match the first revision.', 'CONTEXT_RECORD_INVALID');
  if (entity.provenance.origin === 'imported' && lastLiveConfirmedAt !== null) {
    const corrections = revisionHistory.filter((entry) => entry.action === 'correct');
    invariant(corrections.length > 0 && corrections.at(-1).at === lastLiveConfirmedAt, 'An import timestamp cannot be treated as live confirmation.', 'CONTEXT_RECORD_INVALID');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    type: candidate.type,
    id: candidate.id,
    status: entity.status,
    label: candidate.label,
    aliases: candidate.aliases,
    summary: candidate.summary,
    eventTime: candidate.eventTime,
    participantIds: candidate.participantIds,
    placeIds: candidate.placeIds,
    relatedEntityIds: candidate.relatedEntityIds,
    memoryIds: candidate.memoryIds,
    consentEventId: entity.consentEventId,
    provenance: {
      origin: entity.provenance.origin,
      firstObservedAt,
      importedAt,
      lastLiveConfirmedAt,
      lastRelevantAt
    },
    sourceRefs: candidate.sourceRefs,
    sessionRefs: candidate.sessionRefs,
    revision: entity.revision,
    revisionHistory
  };
}

function candidateFromUncheckedEntity(entity) {
  return {
    schemaVersion: entity.schemaVersion,
    type: entity.type,
    id: entity.id,
    label: entity.label,
    aliases: entity.aliases,
    summary: entity.summary,
    eventTime: entity.eventTime,
    participantIds: entity.participantIds,
    placeIds: entity.placeIds,
    relatedEntityIds: entity.relatedEntityIds,
    memoryIds: entity.memoryIds,
    sourceRefs: entity.sourceRefs,
    sessionRefs: entity.sessionRefs
  };
}

function canonicalCandidateJson(candidate) {
  return canonicalJson(validateCandidate(candidate));
}

function canonicalEntityJson(entity) {
  return canonicalJson(validateEntity(entity));
}

function parseJson(raw, code, message) {
  invariant(typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_ENTITY_BYTES, message, code);
  try {
    return JSON.parse(raw);
  } catch {
    invariant(false, message, code);
  }
}

function parseCandidateJson(raw) {
  const parsed = parseJson(raw, 'CONTEXT_CANDIDATE_INVALID', 'Context candidate is invalid JSON.');
  const candidate = validateCandidate(parsed);
  invariant(raw === canonicalJson(candidate), 'Context candidate JSON must use canonical generated form.', 'CONTEXT_RECORD_NONCANONICAL');
  return candidate;
}

function normalizePatch(patch, currentCandidate = null) {
  invariant(patch && typeof patch === 'object' && !Array.isArray(patch), 'Correction patch must be an object.', 'CONTEXT_PATCH_INVALID');
  const keys = Object.keys(patch);
  invariant(keys.length >= 1 && keys.every((key) => PATCH_KEYS.includes(key)), 'Correction patch has unknown or no fields.', 'CONTEXT_PATCH_INVALID', { available: PATCH_KEYS });
  const ordered = {};
  for (const key of PATCH_KEYS) if (Object.hasOwn(patch, key)) ordered[key] = patch[key];
  if (currentCandidate !== null) {
    const replacement = { ...currentCandidate, ...ordered };
    return { patch: ordered, replacement: validateCandidate(replacement) };
  }
  return { patch: ordered, replacement: null };
}

function parseCorrectionPatchJson(raw) {
  const parsed = parseJson(raw, 'CONTEXT_PATCH_INVALID', 'Context correction patch is invalid JSON.');
  const { patch } = normalizePatch(parsed);
  invariant(raw === canonicalJson(patch), 'Context correction patch JSON must use canonical generated form.', 'CONTEXT_RECORD_NONCANONICAL');
  return patch;
}

function parseCandidateBatchJson(raw) {
  const parsed = parseJson(raw, 'CONTEXT_CANDIDATE_INVALID', 'Context candidate batch is invalid JSON.');
  exactKeys(parsed, ['schemaVersion', 'candidates'], 'Context candidate batch', 'CONTEXT_CANDIDATE_INVALID');
  invariant(parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.candidates), 'Context candidate batch schema is invalid.', 'CONTEXT_CANDIDATE_INVALID');
  const candidates = normalizeCandidateSet(parsed.candidates);
  const normalized = { schemaVersion: SCHEMA_VERSION, candidates };
  invariant(raw === canonicalJson(normalized), 'Context candidate batch JSON must use canonical generated form.', 'CONTEXT_RECORD_NONCANONICAL');
  return candidates;
}

function durableRetention(value) {
  return value === 'until_deleted' || /^rolling_days:\s*[1-9]\d*$/.test(value || '') || /^until:\s*\d{4}-\d{2}-\d{2}$/.test(value || '');
}

function graphAccess(state) {
  const consent = state?.consent;
  invariant(consent?.continuityMemory === 'on', 'Continuity memory consent must be on for context-graph access.', 'CONTEXT_CONTINUITY_CONSENT_REQUIRED');
  invariant(consent.contextGraph === 'on', 'Context graph consent must be on.', 'CONTEXT_GRAPH_CONSENT_REQUIRED');
  const pause = consent.memoryPause?.state || 'none';
  invariant(pause === 'none', pause === 'sealed_pause' ? 'Context graph cannot be read while sealed pause is active.' : 'Context graph cannot be read or written while memory is paused.', pause === 'sealed_pause' ? 'MEMORY_SEALED' : 'MEMORY_PAUSE_ACTIVE');
  invariant(durableRetention(consent.retention?.context_graph), 'Context graph requires durable retention; session-only and do-not-store are not permitted.', 'CONTEXT_RETENTION_NOT_DURABLE');
  const consentEventId = consent.decisions?.context_graph?.eventId;
  invariant(CONSENT_ID_PATTERN.test(consentEventId || ''), 'Context graph has no valid consent event.', 'CONTEXT_CONSENT_EVENT_INVALID');
  return { consentEventId, retention: consent.retention.context_graph };
}

function currentSessionId(state, explicit = undefined) {
  const value = explicit === undefined ? state?.consent?.currentSessionId || null : explicit;
  invariant(value === null || SESSION_ID_PATTERN.test(value), 'Context operation session ID is invalid.', 'INVALID_SESSION_ID');
  return value;
}

function resolveManaged(root, relative, label = 'Context graph path') {
  const normalized = validateRelativePath(relative);
  const absolute = path.resolve(root, normalized);
  assertInside(path.resolve(root), absolute, label);
  return absolute;
}

async function readCanonicalEntity(root, relative) {
  const filename = resolveManaged(root, relative);
  await rejectSymlinkPath(filename);
  const raw = (await readBoundedRegularFile(filename, MAX_ENTITY_BYTES, {
    typeCode: 'CONTEXT_RECORD_NOT_REGULAR',
    sizeCode: 'CONTEXT_RECORD_TOO_LARGE',
    changedCode: 'CONTEXT_RECORD_CHANGED'
  })).toString('utf8');
  const parsed = parseJson(raw, 'CONTEXT_RECORD_INVALID', 'Context entity is invalid JSON.');
  const entity = validateEntity(parsed);
  invariant(raw === canonicalJson(entity), 'Context entity JSON must use canonical generated form.', 'CONTEXT_RECORD_NONCANONICAL');
  invariant(entityRelative(entity.id) === relative, 'Context entity identity does not match its path.', 'CONTEXT_PATH_INVALID');
  return entity;
}

async function inspectContextRoot(root) {
  const contextRoot = resolveManaged(root, 'context');
  await rejectSymlinkPath(contextRoot, { allowMissing: true });
  if (!(await pathExists(contextRoot))) return false;
  const rootStat = await fsp.lstat(contextRoot);
  invariant(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Context root must be a real directory.', 'CONTEXT_PATH_INVALID');
  const allowedDirectories = new Set(['people', 'places', 'events']);
  const allowedFiles = new Set(['README.md', 'index.md']);
  const entries = await fsp.readdir(contextRoot, { withFileTypes: true });
  invariant(entries.length <= MAX_ENTITIES + 5, 'Context root has too many entries.', 'CONTEXT_GRAPH_TOO_LARGE');
  for (const entry of entries) {
    invariant(!entry.isSymbolicLink(), 'Symbolic links are not allowed in context graph paths.', 'SYMLINK_REJECTED');
    if (entry.isDirectory()) invariant(allowedDirectories.has(entry.name), 'Unknown context directories, including concept nodes, are not allowed.', 'CONTEXT_PATH_INVALID');
    else invariant(entry.isFile() && allowedFiles.has(entry.name), 'Unknown context root artifacts are not allowed.', 'CONTEXT_PATH_INVALID');
  }
  return true;
}

async function loadAllEntities(root, options = {}) {
  const exists = await inspectContextRoot(root);
  if (!exists) return [];
  const entities = [];
  const seen = new Set();
  for (const [directory, type] of [['people', 'person'], ['places', 'place'], ['events', 'event']]) {
    const relativeDirectory = `context/${directory}`;
    const absoluteDirectory = resolveManaged(root, relativeDirectory);
    await rejectSymlinkPath(absoluteDirectory, { allowMissing: true });
    if (!(await pathExists(absoluteDirectory))) continue;
    const stat = await fsp.lstat(absoluteDirectory);
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'Context entity container must be a real directory.', 'CONTEXT_PATH_INVALID');
    const entries = await fsp.readdir(absoluteDirectory, { withFileTypes: true });
    invariant(entities.length + entries.length <= MAX_ENTITIES, 'Context graph has too many entities.', 'CONTEXT_GRAPH_TOO_LARGE');
    entries.sort((left, right) => compareCodePoint(left.name, right.name));
    const namePattern = new RegExp(`^${type}-${UUID_V4}\\.json$`);
    for (const entry of entries) {
      invariant(entry.isFile() && !entry.isSymbolicLink() && namePattern.test(entry.name), 'Context entity filename or type is invalid.', entry.isSymbolicLink() ? 'SYMLINK_REJECTED' : 'CONTEXT_PATH_INVALID');
      const relative = `${relativeDirectory}/${entry.name}`;
      if (relative === options.skipRelative) continue;
      const entity = await readCanonicalEntity(root, relative);
      invariant(!seen.has(entity.id), 'Context entity ID is duplicated.', 'CONTEXT_ID_DUPLICATED');
      seen.add(entity.id);
      entities.push(entity);
    }
  }
  return entities.sort((left, right) => compareCodePoint(left.id, right.id));
}

function mapEntities(entities) {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

function assertReferencesResolved(entities) {
  const byId = mapEntities(entities);
  for (const entity of entities) {
    for (const id of entity.relatedEntityIds) invariant(byId.has(id), 'Related context reference does not exist.', 'CONTEXT_REFERENCE_NOT_FOUND', { entityId: entity.id, referenceId: id });
    for (const id of entity.participantIds) invariant(byId.get(id)?.type === 'person', 'Event participant reference does not resolve to a person.', 'CONTEXT_REFERENCE_NOT_FOUND', { entityId: entity.id, referenceId: id });
    for (const id of entity.placeIds) invariant(byId.get(id)?.type === 'place', 'Event place reference does not resolve to a place.', 'CONTEXT_REFERENCE_NOT_FOUND', { entityId: entity.id, referenceId: id });
  }
}

function markdownCell(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\|`*_{}\[\]()#!])/gu, '\\$1');
}

function indexCounts(entities) {
  const counts = { Core: 0, Active: 0, Provisional: 0, Dormant: 0 };
  for (const entity of entities) counts[entity.status] += 1;
  return counts;
}

function renderIndex(entities, options = {}) {
  const updatedAt = options.updatedAt === null ? null : canonicalTimestamp(options.updatedAt || new Date().toISOString(), 'Index timestamp');
  const consentEventId = options.consentEventId === null || options.consentEventId === undefined ? null : options.consentEventId;
  invariant(consentEventId === null || CONSENT_ID_PATTERN.test(consentEventId), 'Index consent event is invalid.', 'CONTEXT_CONSENT_EVENT_INVALID');
  const sorted = [...entities].map(validateEntity).sort((left, right) => compareCodePoint(left.id, right.id));
  const counts = indexCounts(sorted);
  const lines = [
    '# Context Index',
    '',
    `- Schema version: ${SCHEMA_VERSION}`,
    `- Updated at: ${updatedAt || 'null'}`,
    `- Consent event: ${consentEventId || 'null'}`,
    `- Core count: ${counts.Core}`,
    `- Active count: ${counts.Active}`,
    `- Provisional count: ${counts.Provisional}`,
    `- Dormant count: ${counts.Dormant}`,
    ''
  ];
  for (const status of ['Core', 'Active', 'Provisional']) {
    lines.push(`## ${status}`, '', '| Entity ID | Type | Minimal label | Revision |', '|---|---|---|---|');
    for (const entity of sorted.filter((item) => item.status === status).slice(0, STATUS_LIMITS[status])) {
      lines.push(`| ${entity.id} | ${entity.type} | ${markdownCell(entity.label)} | ${entity.revision} |`);
    }
    lines.push('');
  }
  lines.push('## Dormant', '', `Count only: ${counts.Dormant}`, '');
  return lines.join('\n');
}

async function ensureIndexWritable(root) {
  const filename = resolveManaged(root, 'context/index.md');
  await rejectSymlinkPath(filename, { allowMissing: true });
  if (await pathExists(filename)) {
    const stat = await fsp.lstat(filename);
    invariant(stat.isFile() && !stat.isSymbolicLink(), 'Context index must be a regular file.', 'CONTEXT_PATH_INVALID');
  }
}

function withIndexWrite(writes, entities, access, now) {
  writes.set('context/index.md', renderIndex(entities, { updatedAt: now, consentEventId: access?.consentEventId || null }));
  return writes;
}

function appendRevision(entity, action, now, sessionId) {
  invariant(entity.revision < MAX_REVISION_HISTORY, 'Context revision history reached its supported bound.', 'CONTEXT_REVISION_LIMIT');
  const revision = entity.revision + 1;
  return {
    ...entity,
    revision,
    revisionHistory: [...entity.revisionHistory, { revision, at: now, action, sessionId }]
  };
}

function unionSorted(left, right) {
  return [...new Set([...left, ...right])].sort(compareCodePoint);
}

function unionSourceRefs(left, right) {
  const byKey = new Map();
  for (const reference of [...left, ...right]) byKey.set(sourceRefKey(reference), reference);
  return [...byKey.entries()].sort(([leftKey], [rightKey]) => compareCodePoint(leftKey, rightKey)).map(([, value]) => value);
}

function addSessionReference(candidate, sessionId) {
  if (sessionId === null || candidate.sessionRefs.includes(sessionId)) return candidate;
  return validateCandidate({ ...candidate, sessionRefs: [...candidate.sessionRefs, sessionId].sort(compareCodePoint) });
}

function buildEntity(candidateInput, options) {
  const candidate = addSessionReference(validateCandidate(candidateInput), options.sessionId || null);
  const now = canonicalTimestamp(options.now);
  const origin = options.origin;
  invariant(['live', 'imported'].includes(origin), 'Context entity origin is invalid.', 'CONTEXT_RECORD_INVALID');
  const status = options.status;
  invariant(STATUSES.includes(status), 'Context status is invalid.', 'CONTEXT_STATUS_INVALID');
  if (origin === 'imported') invariant(status === 'Provisional', 'Imported backfill entities must start Provisional.', 'CONTEXT_STATUS_INVALID');
  return validateEntity({
    schemaVersion: SCHEMA_VERSION,
    type: candidate.type,
    id: candidate.id,
    status,
    label: candidate.label,
    aliases: candidate.aliases,
    summary: candidate.summary,
    eventTime: candidate.eventTime,
    participantIds: candidate.participantIds,
    placeIds: candidate.placeIds,
    relatedEntityIds: candidate.relatedEntityIds,
    memoryIds: candidate.memoryIds,
    consentEventId: options.consentEventId,
    provenance: origin === 'live'
      ? { origin, firstObservedAt: now, importedAt: null, lastLiveConfirmedAt: status === 'Provisional' ? null : now, lastRelevantAt: now }
      : { origin, firstObservedAt: null, importedAt: now, lastLiveConfirmedAt: null, lastRelevantAt: null },
    sourceRefs: candidate.sourceRefs,
    sessionRefs: candidate.sessionRefs,
    revision: 1,
    revisionHistory: [{ revision: 1, at: now, action: origin === 'live' ? 'add' : 'backfill', sessionId: origin === 'live' ? options.sessionId || null : null }]
  });
}

async function planStatus(root, state, options = {}) {
  const access = graphAccess(state);
  const entities = await loadAllEntities(root);
  assertReferencesResolved(entities);
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const expectedIndex = renderIndex(entities, { updatedAt: now, consentEventId: access.consentEventId });
  const indexPath = resolveManaged(root, 'context/index.md');
  await rejectSymlinkPath(indexPath, { allowMissing: true });
  let indexPresent = false;
  if (await pathExists(indexPath)) {
    const stat = await fsp.lstat(indexPath);
    invariant(stat.isFile(), 'Context index must be a regular file.', 'CONTEXT_PATH_INVALID');
    indexPresent = true;
  }
  const counts = indexCounts(entities);
  return {
    operation: 'status',
    counts,
    total: entities.length,
    visible: {
      Core: entities.filter((entity) => entity.status === 'Core').slice(0, STATUS_LIMITS.Core).map((entity) => entity.id),
      Active: entities.filter((entity) => entity.status === 'Active').slice(0, STATUS_LIMITS.Active).map((entity) => entity.id),
      Provisional: entities.filter((entity) => entity.status === 'Provisional').slice(0, STATUS_LIMITS.Provisional).map((entity) => entity.id)
    },
    dormantCountOnly: counts.Dormant,
    indexPresent,
    expectedIndex,
    writes: new Map(),
    deletes: []
  };
}

async function planShow(root, state, options = {}) {
  graphAccess(state);
  const id = assertEntityId(options.id || '');
  const entities = await loadAllEntities(root);
  assertReferencesResolved(entities);
  const entity = entities.find((item) => item.id === id);
  invariant(entity, 'Context entity was not found.', 'CONTEXT_NOT_FOUND');
  return { operation: 'show', entity, writes: new Map(), deletes: [] };
}

async function planAdd(root, state, options = {}) {
  const access = graphAccess(state);
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const sessionId = currentSessionId(state, options.sessionId);
  const candidate = validateCandidate(options.candidate);
  const status = options.status || 'Active';
  const entities = await loadAllEntities(root);
  invariant(!entities.some((entity) => entity.id === candidate.id), 'Context entity already exists; add is no-clobber.', 'CONTEXT_ALREADY_EXISTS');
  const target = resolveManaged(root, entityRelative(candidate.id));
  await rejectSymlinkPath(target, { allowMissing: true });
  invariant(!(await pathExists(target)), 'Context entity path already exists; add is no-clobber.', 'CONTEXT_ALREADY_EXISTS');
  const entity = buildEntity(candidate, { origin: 'live', status, now, sessionId, consentEventId: access.consentEventId });
  const nextEntities = [...entities, entity].sort((left, right) => compareCodePoint(left.id, right.id));
  assertReferencesResolved(nextEntities);
  await ensureIndexWritable(root);
  const writes = new Map([[entityRelative(entity.id), canonicalJson(entity)]]);
  withIndexWrite(writes, nextEntities, access, now);
  return { operation: 'add', entityId: entity.id, type: entity.type, status: entity.status, revision: entity.revision, writes, deletes: [] };
}

async function planCorrect(root, state, options = {}) {
  const access = graphAccess(state);
  const id = assertEntityId(options.id || '');
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const sessionId = currentSessionId(state, options.sessionId);
  const entities = await loadAllEntities(root);
  const entity = entities.find((item) => item.id === id);
  invariant(entity, 'Context entity was not found.', 'CONTEXT_NOT_FOUND');
  const currentCandidate = candidateFromEntity(entity);
  const { replacement } = normalizePatch(options.patch, currentCandidate);
  const withSession = addSessionReference(replacement, sessionId);
  invariant(canonicalJson(currentCandidate) !== canonicalJson(withSession), 'Context correction does not change the entity.', 'CONTEXT_NOOP');
  let revised = {
    ...entity,
    ...withSession,
    consentEventId: entity.consentEventId,
    provenance: { ...entity.provenance, lastLiveConfirmedAt: now, lastRelevantAt: now }
  };
  revised = validateEntity(appendRevision(revised, 'correct', now, sessionId));
  const nextEntities = entities.map((item) => item.id === id ? revised : item);
  assertReferencesResolved(nextEntities);
  await ensureIndexWritable(root);
  const writes = new Map([[entityRelative(id), canonicalJson(revised)]]);
  withIndexWrite(writes, nextEntities, access, now);
  return { operation: 'correct', entityId: id, revision: revised.revision, writes, deletes: [] };
}

async function planStatusChange(root, state, options = {}) {
  const access = graphAccess(state);
  const id = assertEntityId(options.id || '');
  invariant(STATUSES.includes(options.status), 'Context status is invalid.', 'CONTEXT_STATUS_INVALID');
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const sessionId = currentSessionId(state, options.sessionId);
  const entities = await loadAllEntities(root);
  const entity = entities.find((item) => item.id === id);
  invariant(entity, 'Context entity was not found.', 'CONTEXT_NOT_FOUND');
  invariant(entity.status !== options.status, 'Context status is already set to the requested value.', 'CONTEXT_NOOP');
  const sessionRefs = sessionId === null ? entity.sessionRefs : unionSorted(entity.sessionRefs, [sessionId]);
  let revised = {
    ...entity,
    status: options.status,
    sessionRefs,
    provenance: { ...entity.provenance, lastRelevantAt: ['Core', 'Active'].includes(options.status) ? now : entity.provenance.lastRelevantAt }
  };
  revised = validateEntity(appendRevision(revised, 'status_change', now, sessionId));
  const nextEntities = entities.map((item) => item.id === id ? revised : item);
  await ensureIndexWritable(root);
  const writes = new Map([[entityRelative(id), canonicalJson(revised)]]);
  withIndexWrite(writes, nextEntities, access, now);
  return { operation: 'status-change', entityId: id, previousStatus: entity.status, status: revised.status, revision: revised.revision, writes, deletes: [] };
}

async function readOptionalOperational(root, relative, maximum = MAX_LEDGER_BYTES) {
  const filename = resolveManaged(root, relative, 'Operational ledger path');
  await rejectSymlinkPath(filename, { allowMissing: true });
  if (!(await pathExists(filename))) return null;
  return (await readBoundedRegularFile(filename, maximum, {
    typeCode: 'OPERATIONAL_LEDGER_NOT_REGULAR',
    sizeCode: 'OPERATIONAL_LEDGER_TOO_LARGE',
    changedCode: 'OPERATIONAL_LEDGER_CHANGED'
  })).toString('utf8');
}

async function knownBackupRecords(root) {
  try {
    const markdown = await readOptionalOperational(root, '.therapy/state/BACKUP-LEDGER.md');
    if (markdown === null) return { count: 0, ledgerAvailable: false };
    return {
      count: markdown.split(/\r?\n/).filter((line) => /^\|\s*backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\s*\|/.test(line)).length,
      ledgerAvailable: true
    };
  } catch {
    return { count: null, ledgerAvailable: false };
  }
}

function usageLedgerPermitted(state) {
  return state?.consent?.usageLedgers === 'on' && durableRetention(state.consent.retention?.usage_ledgers);
}

function suppressionTokens(entity) {
  return [
    entity.id,
    ...entity.sourceRefs.map((reference) => `${reference.sourceId}:r${reference.revision}`),
    ...entity.sessionRefs
  ].sort(compareCodePoint);
}

async function planSuppressionReceipt(root, state, options) {
  if (!usageLedgerPermitted(state)) return { write: null, eventId: null, reason: 'usage_ledgers_disabled' };
  let markdown;
  try {
    markdown = await readOptionalOperational(root, '.therapy/state/DELETION-LEDGER.md');
  } catch {
    return { write: null, eventId: null, reason: 'deletion_ledger_unavailable' };
  }
  if (markdown === null) return { write: null, eventId: null, reason: 'deletion_ledger_unavailable' };
  const header = '|---|---|---|---|---|---|---|---|---|';
  if (!markdown.includes(header)) return { write: null, eventId: null, reason: 'deletion_ledger_invalid' };
  const eventId = `delete-${(options.idFactory || crypto.randomUUID)()}`;
  invariant(DELETE_ID_PATTERN.test(eventId), 'Generated context deletion event ID is invalid.', 'CONTEXT_RECEIPT_INVALID');
  const fields = [eventId, options.now, options.sessionId || 'none', 'context_graph', options.tokens.join(','), options.scope, String(options.derivedCount), options.knownBackupCount > 0 ? 'true' : 'false', 'active_workspace_completed'];
  invariant(fields.every((field) => !/[|\r\n]/.test(String(field))), 'Context deletion receipt contains an invalid operational field.', 'CONTEXT_RECEIPT_INVALID');
  const row = `| ${fields.join(' | ')} |`;
  return {
    write: { relative: '.therapy/state/DELETION-LEDGER.md', content: markdown.replace(header, `${header}\n${row}`) },
    eventId,
    reason: null
  };
}

async function suppressedEntityIds(root) {
  const records = await suppressionRecords(root);
  const ids = new Set();
  for (const record of records) for (const id of record.entityIds) ids.add(id);
  return ids;
}

async function suppressionRecords(root) {
  const records = [];
  let markdown;
  try { markdown = await readOptionalOperational(root, '.therapy/state/DELETION-LEDGER.md'); } catch { return records; }
  if (!markdown) return records;
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\|\s*delete-/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 9 || cells[3] !== 'context_graph') continue;
    const tokens = cells[4].split(',').filter(Boolean).sort(compareCodePoint);
    records.push({
      entityIds: tokens.filter((token) => ENTITY_ID_PATTERN.test(token)),
      provenanceTokens: tokens.filter((token) => SOURCE_ID_PATTERN.test(token.replace(/:r[1-9]\d*$/, '')) || SESSION_ID_PATTERN.test(token))
    });
  }
  return records;
}

function candidateSuppressed(candidate, records) {
  const provenanceTokens = [
    ...candidate.sourceRefs.map((reference) => `${reference.sourceId}:r${reference.revision}`),
    ...candidate.sessionRefs
  ].sort(compareCodePoint);
  return records.some((record) => record.entityIds.includes(candidate.id)
    || (provenanceTokens.length > 0
      && record.provenanceTokens.length === provenanceTokens.length
      && record.provenanceTokens.every((token, index) => token === provenanceTokens[index])));
}

function removeReference(entity, id, now, sessionId) {
  const participantIds = entity.participantIds.filter((value) => value !== id);
  const placeIds = entity.placeIds.filter((value) => value !== id);
  const relatedEntityIds = entity.relatedEntityIds.filter((value) => value !== id);
  if (participantIds.length === entity.participantIds.length && placeIds.length === entity.placeIds.length && relatedEntityIds.length === entity.relatedEntityIds.length) return entity;
  return validateEntity(appendRevision({ ...entity, participantIds, placeIds, relatedEntityIds }, 'reference_rewrite', now, sessionId));
}

function removeMemoryReferences(entity, ids, now, sessionId) {
  const removed = new Set(ids);
  const memoryIds = entity.memoryIds.filter((value) => !removed.has(value));
  if (memoryIds.length === entity.memoryIds.length) return entity;
  return validateEntity(appendRevision({ ...entity, memoryIds }, 'reference_rewrite', now, sessionId));
}

async function planRemoveMemoryReferences(root, state, options = {}) {
  invariant(Array.isArray(options.ids) && options.ids.length >= 1 && options.ids.length <= MAX_MEMORY_REFERENCES, 'Memory-reference cleanup requires a bounded ID array.', 'CONTEXT_REFERENCE_INVALID');
  const ids = options.ids.map((id) => {
    invariant(MEMORY_ID_PATTERN.test(id || ''), 'Memory-reference cleanup IDs must use mem-, theme-, or focus- UUID-v4 IDs.', 'CONTEXT_REFERENCE_INVALID');
    return id;
  }).sort(compareCodePoint);
  invariant(new Set(ids).size === ids.length, 'Memory-reference cleanup IDs contain duplicates.', 'CONTEXT_DUPLICATE');
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const sessionId = currentSessionId(state, options.sessionId);
  const entities = await loadAllEntities(root);
  const writes = new Map();
  const nextEntities = [];
  let referenceRewrites = 0;
  for (const entity of entities) {
    const cleaned = removeMemoryReferences(entity, ids, now, sessionId);
    if (cleaned !== entity) {
      referenceRewrites += 1;
      writes.set(entityRelative(cleaned.id), canonicalJson(cleaned));
    }
    nextEntities.push(cleaned);
  }
  if (referenceRewrites > 0) {
    await ensureIndexWritable(root);
    const consentEventId = state?.consent?.decisions?.context_graph?.eventId;
    withIndexWrite(writes, nextEntities, CONSENT_ID_PATTERN.test(consentEventId || '') ? { consentEventId } : null, now);
  }
  return {
    operation: 'remove-memory-references',
    memoryIds: ids,
    referenceRewrites,
    writes,
    deletes: []
  };
}

function replaceReference(entity, fromId, toId, now, sessionId) {
  const replace = (values) => unionSorted(values.map((value) => value === fromId ? toId : value), []).filter((value) => value !== entity.id);
  const participantIds = replace(entity.participantIds);
  const placeIds = replace(entity.placeIds);
  const relatedEntityIds = replace(entity.relatedEntityIds);
  if (canonicalJson(participantIds) === canonicalJson(entity.participantIds)
      && canonicalJson(placeIds) === canonicalJson(entity.placeIds)
      && canonicalJson(relatedEntityIds) === canonicalJson(entity.relatedEntityIds)) return entity;
  return validateEntity(appendRevision({ ...entity, participantIds, placeIds, relatedEntityIds }, 'reference_rewrite', now, sessionId));
}

async function planForget(root, state, options = {}) {
  const id = assertEntityId(options.id || '');
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const sessionId = currentSessionId(state, options.sessionId);
  const backup = await knownBackupRecords(root);
  const relative = entityRelative(id);
  const target = resolveManaged(root, relative);
  await rejectSymlinkPath(target, { allowMissing: true });
  const targetExists = await pathExists(target);
  if (!targetExists) {
    const suppressed = await suppressedEntityIds(root);
    invariant(suppressed.has(id), 'Context entity was not found.', 'CONTEXT_NOT_FOUND');
    return {
      operation: 'forget', entityId: id, alreadyAbsent: true, referenceRewrites: 0,
      knownBackupRecords: backup.count, backupLedgerAvailable: backup.ledgerAvailable,
      receiptPlanned: false, receiptEventId: null, receiptReason: 'already_suppressed',
      writes: new Map(), deletes: []
    };
  }
  const targetStat = await fsp.lstat(target);
  invariant(targetStat.isFile() && !targetStat.isSymbolicLink(), 'Forget target must be a regular context entity file.', 'CONTEXT_PATH_INVALID');
  const entities = await loadAllEntities(root, { skipRelative: relative });
  let entity = null;
  try { entity = await readCanonicalEntity(root, relative); } catch { entity = null; }
  const remaining = [];
  let referenceRewrites = 0;
  const writes = new Map();
  for (const item of entities) {
    if (item.id === id) continue;
    const cleaned = removeReference(item, id, now, sessionId);
    if (cleaned !== item) {
      referenceRewrites += 1;
      writes.set(entityRelative(cleaned.id), canonicalJson(cleaned));
    }
    remaining.push(cleaned);
  }
  assertReferencesResolved(remaining);
  await ensureIndexWritable(root);
  const retainedConsentEventId = state?.consent?.decisions?.context_graph?.eventId;
  withIndexWrite(writes, remaining, CONSENT_ID_PATTERN.test(retainedConsentEventId || '') ? { consentEventId: retainedConsentEventId } : null, now);
  const receipt = await planSuppressionReceipt(root, state, {
    now,
    sessionId,
    scope: 'forget',
    tokens: entity ? suppressionTokens(entity) : [id],
    derivedCount: referenceRewrites + 1,
    knownBackupCount: backup.count || 0,
    idFactory: options.idFactory
  });
  if (receipt.write) writes.set(receipt.write.relative, receipt.write.content);
  return {
    operation: 'forget', entityId: id, alreadyAbsent: false, targetRecordValid: entity !== null, referenceRewrites,
    knownBackupRecords: backup.count, backupLedgerAvailable: backup.ledgerAvailable,
    receiptPlanned: receipt.write !== null, receiptEventId: receipt.eventId, receiptReason: receipt.reason,
    writes, deletes: [entityRelative(id)]
  };
}

function earliest(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function latest(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function mergeEntities(canonical, merged, now, sessionId) {
  invariant(canonical.type === merged.type, 'Only entities of the same type can be merged.', 'CONTEXT_MERGE_TYPE_MISMATCH');
  const candidate = candidateFromEntity(canonical);
  const aliases = unionSorted(candidate.aliases, [...merged.aliases, merged.label]).filter((value) => value !== canonical.label);
  const combined = validateCandidate({
    ...candidate,
    aliases,
    participantIds: unionSorted(canonical.participantIds, merged.participantIds).map((id) => id === merged.id ? canonical.id : id).filter((id) => id !== canonical.id).sort(compareCodePoint),
    placeIds: unionSorted(canonical.placeIds, merged.placeIds).map((id) => id === merged.id ? canonical.id : id).filter((id) => id !== canonical.id).sort(compareCodePoint),
    relatedEntityIds: unionSorted(canonical.relatedEntityIds, merged.relatedEntityIds).map((id) => id === merged.id ? canonical.id : id).filter((id) => id !== canonical.id).sort(compareCodePoint),
    memoryIds: unionSorted(canonical.memoryIds, merged.memoryIds),
    sourceRefs: unionSourceRefs(canonical.sourceRefs, merged.sourceRefs),
    sessionRefs: unionSorted(unionSorted(canonical.sessionRefs, merged.sessionRefs), sessionId ? [sessionId] : [])
  });
  let entity = {
    ...canonical,
    ...combined,
    consentEventId: canonical.consentEventId,
    provenance: {
      ...canonical.provenance,
      firstObservedAt: canonical.provenance.origin === 'live' ? earliest(canonical.provenance.firstObservedAt, merged.provenance.firstObservedAt) : null,
      importedAt: canonical.provenance.origin === 'imported' ? earliest(canonical.provenance.importedAt, merged.provenance.importedAt) : null,
      lastLiveConfirmedAt: canonical.provenance.lastLiveConfirmedAt,
      lastRelevantAt: latest(canonical.provenance.lastRelevantAt, merged.provenance.lastRelevantAt)
    }
  };
  entity = validateEntity(appendRevision(entity, 'merge', now, sessionId));
  return entity;
}

function mergeConflicts(canonical, merged) {
  const fields = [];
  for (const key of ['label', 'summary', 'eventTime', 'status']) if (canonicalJson(canonical[key]) !== canonicalJson(merged[key])) fields.push(key);
  return fields;
}

function mergeToken(workspaceId, canonical, merged, proposed, knownBackupCount = null) {
  invariant(UUID_V4_PATTERN.test(workspaceId || ''), 'Workspace ID is invalid.', 'WORKSPACE_STATE_INVALID');
  const material = canonicalJson({
    schemaVersion: SCHEMA_VERSION,
    operation: 'context_merge',
    workspaceId,
    canonical,
    merged,
    knownBackupCount,
    proposed: {
      candidate: candidateFromEntity(proposed),
      status: proposed.status,
      consentEventId: proposed.consentEventId,
      provenance: proposed.provenance
    }
  });
  const digest = crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
  return `context-merge:${canonical.id}:${merged.id}:${digest}`;
}

async function planMerge(root, state, options = {}) {
  const access = graphAccess(state);
  const canonicalId = assertEntityId(options.canonicalId || '');
  const mergedId = assertEntityId(options.mergedId || '');
  invariant(canonicalId !== mergedId, 'Merge requires two distinct context IDs.', 'CONTEXT_MERGE_INVALID');
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const sessionId = currentSessionId(state, options.sessionId);
  const entities = await loadAllEntities(root);
  const byId = mapEntities(entities);
  const canonical = byId.get(canonicalId);
  const merged = byId.get(mergedId);
  invariant(canonical && merged, 'Both merge entities must exist.', 'CONTEXT_NOT_FOUND');
  const proposed = mergeEntities(canonical, merged, now, sessionId);
  const backup = await knownBackupRecords(root);
  const confirmation = mergeToken(state.workspaceId, canonical, merged, proposed, backup.count);
  if (!options.confirm) {
    return {
      operation: 'merge', preview: true, canonicalId, mergedId,
      canonicalEntity: canonical, mergedEntity: merged, proposedEntity: proposed,
      conflicts: mergeConflicts(canonical, merged), confirmation,
      knownBackupRecords: backup.count, backupLedgerAvailable: backup.ledgerAvailable,
      writes: new Map(), deletes: []
    };
  }
  invariant(options.confirm === confirmation, 'Merge confirmation token does not match the exact current entities and canonical result.', 'CONTEXT_CONFIRMATION_MISMATCH', { confirmationRequired: confirmation });
  const writes = new Map();
  const nextEntities = [];
  let referenceRewrites = 0;
  for (const entity of entities) {
    if (entity.id === mergedId) continue;
    if (entity.id === canonicalId) {
      nextEntities.push(proposed);
      writes.set(entityRelative(canonicalId), canonicalJson(proposed));
      continue;
    }
    const rewritten = replaceReference(entity, mergedId, canonicalId, now, sessionId);
    if (rewritten !== entity) {
      referenceRewrites += 1;
      writes.set(entityRelative(rewritten.id), canonicalJson(rewritten));
    }
    nextEntities.push(rewritten);
  }
  assertReferencesResolved(nextEntities);
  await ensureIndexWritable(root);
  withIndexWrite(writes, nextEntities, access, now);
  const receipt = await planSuppressionReceipt(root, state, {
    now,
    sessionId,
    scope: 'merge',
    tokens: suppressionTokens(merged),
    derivedCount: referenceRewrites + 2,
    knownBackupCount: backup.count || 0,
    idFactory: options.idFactory
  });
  if (receipt.write) writes.set(receipt.write.relative, receipt.write.content);
  return {
    operation: 'merge', preview: false, canonicalId, mergedId, revision: proposed.revision,
    referenceRewrites, knownBackupRecords: backup.count, backupLedgerAvailable: backup.ledgerAvailable,
    receiptPlanned: receipt.write !== null, receiptEventId: receipt.eventId, receiptReason: receipt.reason,
    writes, deletes: [entityRelative(mergedId)]
  };
}

function normalizeCandidateSet(values) {
  invariant(Array.isArray(values) && values.length >= 1 && values.length <= MAX_BACKFILL_CANDIDATES, 'Supervised backfill accepts one to five resupplied candidates.', 'CONTEXT_BACKFILL_LIMIT', { maximum: MAX_BACKFILL_CANDIDATES });
  const candidates = values.map(validateCandidate).sort((left, right) => compareCodePoint(left.id, right.id));
  invariant(new Set(candidates.map((candidate) => candidate.id)).size === candidates.length, 'Backfill candidate IDs are duplicated.', 'CONTEXT_DUPLICATE');
  return candidates;
}

function normalizeApprovedIds(values, candidates) {
  invariant(Array.isArray(values), 'Backfill approved IDs must be an explicit array.', 'CONTEXT_BACKFILL_APPROVAL_INVALID');
  const ids = values.map((value) => assertEntityId(value)).sort(compareCodePoint);
  invariant(new Set(ids).size === ids.length, 'Backfill approved IDs contain duplicates.', 'CONTEXT_DUPLICATE');
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  invariant(ids.every((id) => candidateIds.has(id)), 'Every approved ID must belong to the exact resupplied candidate set.', 'CONTEXT_BACKFILL_APPROVAL_INVALID');
  return ids;
}

function backfillToken(workspaceId, candidates, approvedIds) {
  invariant(UUID_V4_PATTERN.test(workspaceId || ''), 'Workspace ID is invalid.', 'WORKSPACE_STATE_INVALID');
  const material = canonicalJson({
    schemaVersion: SCHEMA_VERSION,
    operation: 'context_backfill',
    workspaceId,
    candidates,
    approvedIds
  });
  return `context-backfill:${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

function possibleDuplicateIds(candidates, existing) {
  const output = [];
  for (const candidate of candidates) {
    const matches = existing
      .filter((entity) => entity.type === candidate.type && (entity.label === candidate.label || entity.aliases.includes(candidate.label) || candidate.aliases.includes(entity.label)))
      .map((entity) => entity.id)
      .sort(compareCodePoint);
    if (matches.length) output.push({ candidateId: candidate.id, existingIds: matches });
  }
  return output;
}

async function planBackfill(root, state, options = {}) {
  const access = graphAccess(state);
  const candidates = normalizeCandidateSet(options.candidates);
  const approvedIds = normalizeApprovedIds(options.approvedIds, candidates);
  const confirmation = backfillToken(state.workspaceId, candidates, approvedIds);
  const entities = await loadAllEntities(root);
  const duplicateHints = possibleDuplicateIds(candidates, entities);
  if (!options.confirm) {
    return {
      operation: 'backfill', preview: true, candidates, approvedIds,
      possibleDuplicates: duplicateHints, confirmation,
      writes: new Map(), deletes: []
    };
  }
  invariant(options.confirm === confirmation, 'Backfill confirmation token does not match the exact resupplied candidate set and approved IDs.', 'CONTEXT_CONFIRMATION_MISMATCH', { confirmationRequired: confirmation });
  const suppressionReceipts = await suppressionRecords(root);
  invariant(!candidates.some((candidate) => approvedIds.includes(candidate.id) && candidateSuppressed(candidate, suppressionReceipts)), 'An approved candidate or its exact content-free provenance was previously forgotten or merged and remains suppressed.', 'CONTEXT_BACKFILL_SUPPRESSED');
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const existing = mapEntities(entities);
  const approved = candidates.filter((candidate) => approvedIds.includes(candidate.id));
  const added = [];
  const alreadyPresentIds = [];
  for (const candidate of approved) {
    if (existing.has(candidate.id)) {
      alreadyPresentIds.push(candidate.id);
      continue;
    }
    const target = resolveManaged(root, entityRelative(candidate.id));
    await rejectSymlinkPath(target, { allowMissing: true });
    invariant(!(await pathExists(target)), 'Backfill entity path exists and cannot be clobbered.', 'CONTEXT_ALREADY_EXISTS');
    const entity = buildEntity(candidate, { origin: 'imported', status: 'Provisional', now, sessionId: null, consentEventId: access.consentEventId });
    added.push(entity);
    existing.set(entity.id, entity);
  }
  const nextEntities = [...entities, ...added].sort((left, right) => compareCodePoint(left.id, right.id));
  assertReferencesResolved(nextEntities);
  const writes = new Map();
  for (const entity of added) writes.set(entityRelative(entity.id), canonicalJson(entity));
  if (added.length) {
    await ensureIndexWritable(root);
    withIndexWrite(writes, nextEntities, access, now);
  }
  return {
    operation: 'backfill', preview: false,
    addedIds: added.map((entity) => entity.id), alreadyPresentIds,
    addedCount: added.length, alreadyPresentCount: alreadyPresentIds.length,
    writes, deletes: []
  };
}

module.exports = {
  SCHEMA_VERSION,
  STATUSES,
  TYPES,
  STATUS_LIMITS,
  ENTITY_ID_PATTERN,
  MAX_BACKFILL_CANDIDATES,
  compareCodePoint,
  canonicalJson,
  canonicalCandidateJson,
  canonicalEntityJson,
  validateCandidate,
  validateEntity,
  parseCandidateJson,
  parseCandidateBatchJson,
  parseCorrectionPatchJson,
  entityRelative,
  graphAccess,
  renderIndex,
  loadAllEntities,
  backfillToken,
  mergeToken,
  planStatus,
  planShow,
  planAdd,
  planCorrect,
  planStatusChange,
  planRemoveMemoryReferences,
  planForget,
  planMerge,
  planBackfill
};
