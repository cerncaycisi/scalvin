'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { invariant } = require('./lib/errors');
const {
  assertInside,
  rejectSymlinkPath,
  readBoundedRegularFile,
  pathExists
} = require('./lib/fs-safe');

const CHANGE_ID = /^chg-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_ID = /^rev-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^s-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSENT_ID = /^consent-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 512 * 1024;
const EVIDENCE = new Set(['user_requested', 'observed_once', 'observed_repeatedly']);

const TARGETS = Object.freeze({
  persona: Object.freeze({
    path: '.therapy/user-overrides/persona.json',
    settings: Object.freeze({ challenge_intensity: ['gentle', 'balanced', 'direct'], humor: ['off', 'ask_first', 'allowed'] })
  }),
  'live-moveset': Object.freeze({
    path: '.therapy/user-overrides/live-moveset.json',
    settings: Object.freeze({
      preferred_move: ['reflect', 'clarify', 'validate', 'summarize', 'gently_challenge', 'ground', 'pause_and_ask'],
      avoid_move: ['reflect', 'clarify', 'validate', 'summarize', 'gently_challenge', 'ground', 'pause_and_ask']
    })
  }),
  disambiguation: Object.freeze({
    path: '.therapy/user-overrides/disambiguation.json',
    settings: Object.freeze({ ask_before_interpreting: ['on', 'off'] })
  }),
  'rupture-and-repair': Object.freeze({
    path: '.therapy/user-overrides/rupture-and-repair.json',
    settings: Object.freeze({ apology_style: ['brief', 'standard'] })
  }),
  'source-triggers': Object.freeze({
    path: '.therapy/user-overrides/source-triggers.json',
    settings: Object.freeze({ retrieval_mode: ['ask_first', 'explicit_only'] })
  }),
  'session-style': Object.freeze({
    path: '.therapy/user-overrides/session-style.json',
    settings: Object.freeze({ response_load: ['concise', 'standard', 'detailed'], one_question_at_a_time: ['on', 'off'] })
  }),
  accessibility: Object.freeze({
    path: '.therapy/user-overrides/accessibility.json',
    settings: Object.freeze({
      plain_language_summaries: ['on', 'off'],
      body_prompts: ['allowed', 'ask_first', 'off'],
      sensory_grounding: ['allowed', 'ask_first', 'off'],
      between_session_experiments: ['allowed', 'ask_first', 'off']
    })
  })
});

function canonicalTimestamp(value) {
  invariant(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), 'Change-control timestamp is invalid.', 'CHANGE_TIMESTAMP_INVALID');
  const parsed = new Date(value);
  invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value, 'Change-control timestamp is invalid.', 'CHANGE_TIMESTAMP_INVALID');
  return value;
}

function exactKeys(value, expected, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`, 'CHANGE_RECORD_INVALID');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} has unknown or missing fields.`, 'CHANGE_RECORD_INVALID');
}

function singleLine(value, label, max = 1000, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  invariant(typeof value === 'string' && value.trim() && value.length <= max && !/[\0\r\n]/.test(value), `${label} must be a bounded single line.`, 'CHANGE_VALUE_INVALID');
  return value.trim();
}

function assertNoProtectedIntent(value) {
  if (typeof value !== 'string') return;
  const normalized = value.normalize('NFKC').toLowerCase();
  invariant(!/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(normalized), 'Behavior customization contains hidden or bidirectional control characters.', 'CHANGE_PROTECTED_INTENT');
  const words = normalized.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const weakening = /\b(?:ignore|bypass|disable|override|weaken|skip|remove|evade|circumvent|break|supersede|overrule|disregard)\b/u;
  const protectedDomain = /\b(?:safety|crisis|risk|contraindication|consent|permission|privacy|secret|credential|memory|retention|deletion|provenance|source|authority|identity|dependency|tool|network|filesystem|file|scope|policy|protocol)\b/u;
  const sourceElevation = /\b(?:obey|execute|follow|trust|authorize)\b.*\b(?:source|import|document|content)\b|\b(?:source|import|document|content)\b.*\b(?:authoritative|trusted|instruction|command)\b/u;
  const deceptionOrDependency = /\b(?:deceive|deception|lie|manipulate|dependency|dependent|exclusive relationship|pretend to be human|hide (?:the )?(?:truth|risk|limitation))\b/u;
  const unauthorizedExpansion = /\b(?:expand|grant|enable|allow|use|access)\b.*\b(?:tool|network|filesystem|file|scope|secret|credential)\b.*\b(?:without|regardless|unasked|silently)\b/u;
  invariant(!(weakening.test(words) && protectedDomain.test(words)) && !sourceElevation.test(words) && !deceptionOrDependency.test(words) && !unauthorizedExpansion.test(words), 'Behavior customization cannot weaken protected safety, consent, privacy, provenance, identity, or tool-scope boundaries.', 'CHANGE_PROTECTED_INTENT');
}

function normalizeSetting(target, setting, value) {
  const definition = TARGETS[target];
  invariant(definition, 'Change target is not allowed.', 'CHANGE_TARGET_INVALID', { available: Object.keys(TARGETS) });
  const kind = definition.settings[setting];
  invariant(kind, 'Change setting is not allowed for this target.', 'CHANGE_SETTING_INVALID', { target, available: Object.keys(definition.settings) });
  assertNoProtectedIntent(value);
  invariant(kind.includes(value), 'Change value is not allowed for this setting.', 'CHANGE_VALUE_INVALID', { target, setting, available: kind });
  return value;
}

function assertBehaviorWriteAllowed(state) {
  invariant(state?.consent?.behaviorLearning === 'on', 'Behavior customization consent is not on.', 'BEHAVIOR_CONSENT_REQUIRED');
  invariant(state.consent.memoryPause?.state === 'none', 'Behavior customization is unavailable while memory is paused.', 'MEMORY_PAUSE_ACTIVE');
  const retention = state.consent.retention?.behavior_customization;
  invariant(retention === 'until_deleted', 'Behavior customization requires the supported durable until-deleted retention policy.', 'RETENTION_DO_NOT_STORE');
  const consentEventId = state.consent.decisions?.behavior_customization?.eventId;
  invariant(CONSENT_ID.test(consentEventId || ''), 'Behavior customization has no valid consent event.', 'BEHAVIOR_CONSENT_EVENT_INVALID');
  return consentEventId.toLowerCase();
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readCanonicalJson(root, relative, { optional = false } = {}) {
  const filename = path.resolve(root, relative);
  assertInside(root, filename, 'Change-control path');
  await rejectSymlinkPath(filename, { allowMissing: optional });
  if (optional && !(await pathExists(filename))) return null;
  const raw = (await readBoundedRegularFile(filename, MAX_RECORD_BYTES, {
    typeCode: 'CHANGE_RECORD_NOT_REGULAR',
    sizeCode: 'CHANGE_RECORD_TOO_LARGE',
    changedCode: 'CHANGE_RECORD_CHANGED'
  })).toString('utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { invariant(false, 'Change-control record is invalid JSON.', 'CHANGE_RECORD_INVALID'); }
  invariant(raw === canonicalJson(parsed), 'Change-control JSON must use its canonical generated form.', 'CHANGE_RECORD_NONCANONICAL');
  return parsed;
}

function validateOverlay(overlay, target) {
  if (overlay === null) return null;
  exactKeys(overlay, ['schemaVersion', 'authority', 'target', 'revision', 'updatedAt', 'approvedChangeId', 'settings'], 'Behavior overlay');
  invariant(overlay.schemaVersion === 1 && overlay.target === target, 'Behavior overlay target or schema is invalid.', 'CHANGE_RECORD_INVALID');
  invariant(overlay.authority === 'user_preference_below_safety_consent_privacy_and_source_trust', 'Behavior overlay authority is invalid.', 'CHANGE_RECORD_INVALID');
  invariant(Number.isSafeInteger(overlay.revision) && overlay.revision >= 1, 'Behavior overlay revision is invalid.', 'CHANGE_RECORD_INVALID');
  canonicalTimestamp(overlay.updatedAt);
  invariant(CHANGE_ID.test(overlay.approvedChangeId || ''), 'Behavior overlay change ID is invalid.', 'CHANGE_RECORD_INVALID');
  invariant(overlay.settings && typeof overlay.settings === 'object' && !Array.isArray(overlay.settings), 'Behavior overlay settings are invalid.', 'CHANGE_RECORD_INVALID');
  const keys = Object.keys(overlay.settings);
  invariant(keys.length > 0 && keys.length <= Object.keys(TARGETS[target].settings).length, 'Behavior overlay settings are invalid.', 'CHANGE_RECORD_INVALID');
  for (const key of keys) normalizeSetting(target, key, overlay.settings[key]);
  return overlay;
}

async function readOverlay(root, target) {
  const overlay = await readCanonicalJson(root, TARGETS[target].path, { optional: true });
  return validateOverlay(overlay, target);
}

function validateProposal(proposal) {
  exactKeys(proposal, [
    'schemaVersion', 'changeId', 'createdAt', 'sessionId', 'target', 'setting',
    'evidenceStatus', 'consentEventId', 'why', 'before', 'proposedAfter',
    'expectedEffect', 'risksOrTradeoffs', 'status', 'decidedAt',
    'decisionWording', 'appliedRevision', 'rollbackRevisionId'
  ], 'Change proposal');
  invariant(proposal.schemaVersion === 1 && CHANGE_ID.test(proposal.changeId || ''), 'Change proposal identity is invalid.', 'CHANGE_RECORD_INVALID');
  canonicalTimestamp(proposal.createdAt);
  invariant(SESSION_ID.test(proposal.sessionId || ''), 'Change proposal session ID is invalid.', 'CHANGE_RECORD_INVALID');
  invariant(EVIDENCE.has(proposal.evidenceStatus), 'Change proposal evidence status is invalid.', 'CHANGE_RECORD_INVALID');
  invariant(CONSENT_ID.test(proposal.consentEventId || ''), 'Change proposal consent event is invalid.', 'CHANGE_RECORD_INVALID');
  singleLine(proposal.why, 'Change reason', 1000);
  singleLine(proposal.expectedEffect, 'Expected effect', 1000);
  singleLine(proposal.risksOrTradeoffs, 'Risks or tradeoffs', 1000);
  normalizeSetting(proposal.target, proposal.setting, proposal.proposedAfter);
  if (proposal.before !== null) normalizeSetting(proposal.target, proposal.setting, proposal.before);
  invariant(['pending', 'approved', 'rejected', 'superseded'].includes(proposal.status), 'Change proposal status is invalid.', 'CHANGE_RECORD_INVALID');
  if (proposal.status === 'pending') {
    invariant(proposal.decidedAt === null && proposal.decisionWording === null && proposal.appliedRevision === null && proposal.rollbackRevisionId === null, 'Pending proposal has decision data.', 'CHANGE_RECORD_INVALID');
  }
  return proposal;
}

function proposalRelative(changeId) {
  invariant(CHANGE_ID.test(changeId || ''), 'Change ID is invalid.', 'CHANGE_ID_INVALID');
  return `.therapy/change-control/pending/${changeId.toLowerCase()}.json`;
}

function historyRelative(identifier) {
  invariant(CHANGE_ID.test(identifier || '') || REVISION_ID.test(identifier || ''), 'Change history ID is invalid.', 'CHANGE_ID_INVALID');
  return `.therapy/change-control/history/${identifier.toLowerCase()}.json`;
}

function proposalToken(workspaceId, proposal) {
  invariant(typeof workspaceId === 'string' && /^[0-9a-f-]{36}$/i.test(workspaceId), 'Workspace ID is invalid.', 'WORKSPACE_STATE_INVALID');
  const digest = crypto.createHash('sha256').update(`${workspaceId}\0approve\0${canonicalJson(proposal)}`).digest('hex').slice(0, 20);
  return `approve:${proposal.changeId}:${digest}`;
}

function rollbackToken(workspaceId, revisionId, snapshot) {
  const digest = crypto.createHash('sha256').update(`${workspaceId}\0rollback\0${revisionId}\0${canonicalJson(snapshot)}`).digest('hex').slice(0, 20);
  return `rollback:${revisionId}:${digest}`;
}

function usageLedgerEnabled(state) {
  return state?.consent?.usageLedgers === 'on' && state.consent.retention?.usage_ledgers !== 'do_not_store';
}

async function changeLogWrite(root, state, row) {
  if (!usageLedgerEnabled(state)) return null;
  const relative = '.therapy/state/CHANGE-LOG.md';
  const filename = path.resolve(root, relative);
  await rejectSymlinkPath(filename, { allowMissing: false });
  const markdown = (await readBoundedRegularFile(filename, MAX_RECORD_BYTES, {
    typeCode: 'CHANGE_LOG_NOT_REGULAR', sizeCode: 'CHANGE_LOG_TOO_LARGE', changedCode: 'CHANGE_LOG_CHANGED'
  })).toString('utf8');
  invariant(!Object.values(row).some((value) => /[|\r\n]/.test(String(value))), 'Change-log row is invalid.', 'CHANGE_LOG_INVALID');
  return { relative, content: `${markdown.replace(/\s*$/, '')}\n| ${row.changeId} | ${row.at} | ${row.sessionId} | ${row.target} | ${row.fromRevision} | ${row.toRevision} | ${row.action} | ${row.consentEventId} |\n` };
}

async function planProposal(root, state, options = {}) {
  const consentEventId = assertBehaviorWriteAllowed(state);
  const target = options.target;
  const setting = options.setting;
  const proposedAfter = normalizeSetting(target, setting, options.value);
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const sessionId = String(options.sessionId || state.consent.currentSessionId || '').toLowerCase();
  invariant(SESSION_ID.test(sessionId), 'A current session ID is required for a change proposal.', 'SESSION_ID_REQUIRED');
  invariant(EVIDENCE.has(options.evidenceStatus), 'Change proposal needs an explicit evidence status.', 'CHANGE_EVIDENCE_INVALID', { available: [...EVIDENCE] });
  const overlay = await readOverlay(root, target);
  const before = overlay?.settings?.[setting] ?? null;
  invariant(before !== proposedAfter, 'The proposed behavior value is already active.', 'CHANGE_NOOP');
  const changeId = `chg-${(options.idFactory || crypto.randomUUID)()}`.toLowerCase();
  invariant(CHANGE_ID.test(changeId), 'Generated change ID is invalid.', 'CHANGE_ID_INVALID');
  const relative = proposalRelative(changeId);
  invariant(!(await pathExists(path.resolve(root, relative))), 'Change proposal already exists.', 'CHANGE_ALREADY_EXISTS');
  const proposal = validateProposal({
    schemaVersion: 1,
    changeId,
    createdAt: now,
    sessionId,
    target,
    setting,
    evidenceStatus: options.evidenceStatus,
    consentEventId,
    why: singleLine(options.why, 'Change reason', 1000),
    before,
    proposedAfter,
    expectedEffect: singleLine(options.expectedEffect, 'Expected effect', 1000),
    risksOrTradeoffs: singleLine(options.risksOrTradeoffs, 'Risks or tradeoffs', 1000),
    status: 'pending',
    decidedAt: null,
    decisionWording: null,
    appliedRevision: null,
    rollbackRevisionId: null
  });
  return {
    changeId,
    target,
    setting,
    before,
    proposedAfter,
    confirmation: proposalToken(state.workspaceId, proposal),
    writes: new Map([[relative, canonicalJson(proposal)]]),
    deletes: []
  };
}

async function loadProposal(root, changeId) {
  const proposal = await readCanonicalJson(root, proposalRelative(changeId));
  validateProposal(proposal);
  invariant(proposal.changeId === changeId.toLowerCase(), 'Change proposal identity does not match its path.', 'CHANGE_RECORD_INVALID');
  return proposal;
}

async function planApprove(root, state, options = {}) {
  const consentEventId = assertBehaviorWriteAllowed(state);
  const proposal = await loadProposal(root, options.changeId);
  invariant(proposal.status === 'pending', 'Only a pending change can be approved.', 'CHANGE_NOT_PENDING');
  invariant(proposal.consentEventId === consentEventId, 'Behavior consent changed after this proposal; create a new proposal.', 'CHANGE_CONSENT_CHANGED');
  const expected = proposalToken(state.workspaceId, proposal);
  if (!options.confirm) return { preview: true, changeId: proposal.changeId, target: proposal.target, setting: proposal.setting, before: proposal.before, proposedAfter: proposal.proposedAfter, confirmation: expected, writes: new Map(), deletes: [] };
  invariant(options.confirm === expected, 'Change approval confirmation token does not match.', 'CONFIRMATION_REQUIRED');
  const current = await readOverlay(root, proposal.target);
  invariant((current?.settings?.[proposal.setting] ?? null) === proposal.before, 'The active overlay changed after this proposal; create a new proposal.', 'CHANGE_CONFLICT');
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const revisionId = `rev-${(options.idFactory || crypto.randomUUID)()}`.toLowerCase();
  invariant(REVISION_ID.test(revisionId), 'Generated revision ID is invalid.', 'CHANGE_ID_INVALID');
  invariant(!(await pathExists(path.resolve(root, historyRelative(proposal.changeId)))) && !(await pathExists(path.resolve(root, historyRelative(revisionId)))), 'Change history identity already exists.', 'CHANGE_ALREADY_EXISTS');
  const settings = { ...(current?.settings || {}), [proposal.setting]: proposal.proposedAfter };
  const next = validateOverlay({ schemaVersion: 1, authority: 'user_preference_below_safety_consent_privacy_and_source_trust', target: proposal.target, revision: (current?.revision || 0) + 1, updatedAt: now, approvedChangeId: proposal.changeId, settings }, proposal.target);
  const decided = validateProposal({ ...proposal, status: 'approved', decidedAt: now, decisionWording: 'explicit_confirmation_token', appliedRevision: next.revision, rollbackRevisionId: revisionId });
  const snapshot = {
    schemaVersion: 1,
    revisionId,
    changeId: proposal.changeId,
    target: proposal.target,
    appliedAt: now,
    consentEventId,
    fromRevision: current?.revision || 0,
    toRevision: next.revision,
    beforeOverlay: current,
    afterOverlay: next,
    action: 'approve'
  };
  const writes = new Map([
    [TARGETS[proposal.target].path, canonicalJson(next)],
    [historyRelative(proposal.changeId), canonicalJson(decided)],
    [historyRelative(revisionId), canonicalJson(snapshot)]
  ]);
  const log = await changeLogWrite(root, state, { changeId: proposal.changeId, at: now, sessionId: proposal.sessionId, target: proposal.target, fromRevision: snapshot.fromRevision, toRevision: snapshot.toRevision, action: 'approved', consentEventId });
  if (log) writes.set(log.relative, log.content);
  return { preview: false, changeId: proposal.changeId, revisionId, target: proposal.target, revision: next.revision, writes, deletes: [proposalRelative(proposal.changeId)] };
}

async function planReject(root, state, options = {}) {
  invariant(CHANGE_ID.test(options.changeId || ''), 'Change ID is invalid.', 'CHANGE_ID_INVALID');
  const relative = proposalRelative(options.changeId);
  const exists = await pathExists(path.resolve(root, relative));
  invariant(exists, 'Pending change proposal was not found.', 'CHANGE_NOT_FOUND');
  if (state.consent.memoryPause?.state === 'sealed_pause') {
    return { changeId: options.changeId.toLowerCase(), target: null, writes: new Map(), deletes: [relative], sealedDeletion: true };
  }
  const proposal = await loadProposal(root, options.changeId);
  invariant(proposal.status === 'pending', 'Only a pending change can be rejected.', 'CHANGE_NOT_PENDING');
  invariant(!(await pathExists(path.resolve(root, historyRelative(proposal.changeId)))), 'Change decision history already exists.', 'CHANGE_ALREADY_EXISTS');
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const decided = validateProposal({ ...proposal, status: 'rejected', decidedAt: now, decisionWording: singleLine(options.wording || 'user_rejected', 'Decision wording', 500), appliedRevision: null, rollbackRevisionId: null });
  const writes = new Map([[historyRelative(proposal.changeId), canonicalJson(decided)]]);
  const log = await changeLogWrite(root, state, { changeId: proposal.changeId, at: now, sessionId: proposal.sessionId, target: proposal.target, fromRevision: '-', toRevision: '-', action: 'rejected', consentEventId: proposal.consentEventId });
  if (log) writes.set(log.relative, log.content);
  return { changeId: proposal.changeId, target: proposal.target, writes, deletes: [relative], sealedDeletion: false };
}

function validateSnapshot(snapshot) {
  exactKeys(snapshot, ['schemaVersion', 'revisionId', 'changeId', 'target', 'appliedAt', 'consentEventId', 'fromRevision', 'toRevision', 'beforeOverlay', 'afterOverlay', 'action'], 'Change revision');
  invariant(snapshot.schemaVersion === 1 && REVISION_ID.test(snapshot.revisionId || '') && CHANGE_ID.test(snapshot.changeId || ''), 'Change revision identity is invalid.', 'CHANGE_RECORD_INVALID');
  invariant(TARGETS[snapshot.target] && ['approve', 'rollback'].includes(snapshot.action), 'Change revision target or action is invalid.', 'CHANGE_RECORD_INVALID');
  canonicalTimestamp(snapshot.appliedAt);
  invariant(CONSENT_ID.test(snapshot.consentEventId || ''), 'Change revision consent event is invalid.', 'CHANGE_RECORD_INVALID');
  invariant(Number.isSafeInteger(snapshot.fromRevision) && snapshot.fromRevision >= 0 && Number.isSafeInteger(snapshot.toRevision) && snapshot.toRevision >= 1, 'Change revision numbers are invalid.', 'CHANGE_RECORD_INVALID');
  validateOverlay(snapshot.beforeOverlay, snapshot.target);
  validateOverlay(snapshot.afterOverlay, snapshot.target);
  return snapshot;
}

async function planRollback(root, state, options = {}) {
  const consentEventId = assertBehaviorWriteAllowed(state);
  invariant(REVISION_ID.test(options.revisionId || ''), 'Revision ID is invalid.', 'CHANGE_ID_INVALID');
  const snapshot = validateSnapshot(await readCanonicalJson(root, historyRelative(options.revisionId)));
  invariant(snapshot.revisionId === options.revisionId.toLowerCase(), 'Revision ID does not match its path.', 'CHANGE_RECORD_INVALID');
  const current = await readOverlay(root, snapshot.target);
  invariant(canonicalJson(current) === canonicalJson(snapshot.afterOverlay), 'The active overlay no longer matches this revision; rollback would clobber newer changes.', 'CHANGE_CONFLICT');
  const expected = rollbackToken(state.workspaceId, snapshot.revisionId, snapshot);
  if (!options.confirm) return { preview: true, revisionId: snapshot.revisionId, target: snapshot.target, fromRevision: snapshot.toRevision, toRevision: snapshot.fromRevision, confirmation: expected, writes: new Map(), deletes: [] };
  invariant(options.confirm === expected, 'Rollback confirmation token does not match.', 'CONFIRMATION_REQUIRED');
  const now = canonicalTimestamp(options.now || new Date().toISOString());
  const rollbackRevisionId = `rev-${(options.idFactory || crypto.randomUUID)()}`.toLowerCase();
  const changeId = `chg-${(options.changeIdFactory || crypto.randomUUID)()}`.toLowerCase();
  invariant(REVISION_ID.test(rollbackRevisionId) && CHANGE_ID.test(changeId), 'Generated rollback identity is invalid.', 'CHANGE_ID_INVALID');
  const currentRevision = current?.revision || snapshot.toRevision;
  const restored = snapshot.beforeOverlay === null ? null : validateOverlay({ ...snapshot.beforeOverlay, revision: currentRevision + 1, updatedAt: now, approvedChangeId: changeId }, snapshot.target);
  const rollbackSnapshot = validateSnapshot({
    schemaVersion: 1,
    revisionId: rollbackRevisionId,
    changeId,
    target: snapshot.target,
    appliedAt: now,
    consentEventId,
    fromRevision: currentRevision,
    toRevision: restored?.revision || currentRevision + 1,
    beforeOverlay: current,
    afterOverlay: restored,
    action: 'rollback'
  });
  invariant(!(await pathExists(path.resolve(root, historyRelative(rollbackRevisionId)))) && !(await pathExists(path.resolve(root, historyRelative(changeId)))), 'Rollback history identity already exists.', 'CHANGE_ALREADY_EXISTS');
  const writes = new Map([[historyRelative(rollbackRevisionId), canonicalJson(rollbackSnapshot)]]);
  const deletes = [];
  if (restored === null) deletes.push(TARGETS[snapshot.target].path);
  else writes.set(TARGETS[snapshot.target].path, canonicalJson(restored));
  const sessionId = String(options.sessionId || state.consent.currentSessionId || '').toLowerCase();
  invariant(SESSION_ID.test(sessionId), 'A current session ID is required for rollback.', 'SESSION_ID_REQUIRED');
  const log = await changeLogWrite(root, state, { changeId, at: now, sessionId, target: snapshot.target, fromRevision: currentRevision, toRevision: rollbackSnapshot.toRevision, action: 'rollback', consentEventId });
  if (log) writes.set(log.relative, log.content);
  return { preview: false, changeId, revisionId: rollbackRevisionId, target: snapshot.target, writes, deletes };
}

async function listHistory(root, state) {
  invariant(state?.consent?.memoryPause?.state !== 'sealed_pause', 'Change history cannot be read while sealed pause is active.', 'MEMORY_SEALED');
  const directory = path.resolve(root, '.therapy/change-control/history');
  await rejectSymlinkPath(directory, { allowMissing: true });
  if (!(await pathExists(directory))) return [];
  const entries = await require('node:fs/promises').readdir(directory, { withFileTypes: true });
  invariant(entries.length <= 10_000, 'Change history contains too many entries.', 'CHANGE_HISTORY_TOO_LARGE');
  const output = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    invariant(entry.isFile() && !entry.isSymbolicLink(), 'Change history contains an unsupported entry.', 'CHANGE_RECORD_NOT_REGULAR');
    if (!/^(?:chg|rev)-[0-9a-f-]{36}\.json$/i.test(entry.name)) invariant(false, 'Change history filename is invalid.', 'CHANGE_RECORD_INVALID');
    const relative = `.therapy/change-control/history/${entry.name}`;
    const record = await readCanonicalJson(root, relative);
    if (entry.name.startsWith('chg-')) {
      validateProposal(record);
      output.push({ recordType: 'decision', changeId: record.changeId, target: record.target, setting: record.setting, status: record.status, at: record.decidedAt });
    } else {
      validateSnapshot(record);
      output.push({ recordType: 'revision', revisionId: record.revisionId, changeId: record.changeId, target: record.target, action: record.action, fromRevision: record.fromRevision, toRevision: record.toRevision, at: record.appliedAt });
    }
  }
  return output;
}

module.exports = {
  TARGETS,
  CHANGE_ID,
  REVISION_ID,
  normalizeSetting,
  proposalToken,
  rollbackToken,
  planProposal,
  planApprove,
  planReject,
  planRollback,
  listHistory,
  validateOverlay,
  validateProposal,
  validateSnapshot
};
