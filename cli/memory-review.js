'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { invariant } = require('./lib/errors');
const {
  assertInside,
  rejectSymlinkPath,
  readBoundedRegularFile,
  pathExists,
  walkTree
} = require('./lib/fs-safe');
const { MEMORY_ID, memoryBlocks } = require('./memory-data');

const SESSION_ID = /^s-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_PATHS = Object.freeze([
  'profile.md',
  'ACTIVE-THEMES.md',
  'CURRENT-FOCUS.md',
  'sources/client-told-memories.md'
]);
const MAX_MEMORY_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function compareCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function calendarDateValid(year, month, day) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

function parseTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === 'null' || value === 'never' || value === 'unknown')) return null;
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/);
  invariant(match, `${label} is not a strict RFC3339 timestamp.`, 'MEMORY_REVIEW_METADATA_INVALID');
  const [, year, month, day, hour, minute, second, zone, offsetHour, offsetMinute] = match;
  invariant(calendarDateValid(Number(year), Number(month), Number(day)) && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59, `${label} is not a real timestamp.`, 'MEMORY_REVIEW_METADATA_INVALID');
  if (zone !== 'Z') invariant(Number(offsetHour) <= 14 && Number(offsetMinute) <= 59 && !(Number(offsetHour) === 14 && Number(offsetMinute) !== 0), `${label} has an invalid offset.`, 'MEMORY_REVIEW_METADATA_INVALID');
  const parsed = Date.parse(value);
  invariant(!Number.isNaN(parsed), `${label} is invalid.`, 'MEMORY_REVIEW_METADATA_INVALID');
  return parsed;
}

function parseDate(value, label) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  invariant(match && calendarDateValid(Number(match[1]), Number(match[2]), Number(match[3])), `${label} is invalid.`, 'MEMORY_REVIEW_METADATA_INVALID');
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function canonicalNow(value) {
  const parsed = parseTimestamp(value, 'Review time');
  const canonical = new Date(parsed).toISOString();
  invariant(value === canonical, 'Review time must be canonical UTC with milliseconds.', 'MEMORY_REVIEW_METADATA_INVALID');
  return { value, milliseconds: parsed };
}

async function readOptional(root, relative, maxBytes = MAX_MEMORY_BYTES) {
  const filename = path.resolve(root, relative);
  assertInside(root, filename, 'Memory-review path');
  await rejectSymlinkPath(filename, { allowMissing: true });
  if (!(await pathExists(filename))) return null;
  return (await readBoundedRegularFile(filename, maxBytes, {
    typeCode: 'MEMORY_REVIEW_FILE_NOT_REGULAR',
    sizeCode: 'MEMORY_REVIEW_FILE_TOO_LARGE',
    changedCode: 'MEMORY_REVIEW_FILE_CHANGED'
  })).toString('utf8');
}

function field(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.match(new RegExp(`^- ${escaped}:\\s*(.*)$`, 'mi'))?.[1].trim() || null;
}

function categoryForPath(relative) {
  if (relative === 'profile.md') return { category: 'profile', retention: 'profile_memory' };
  if (relative === 'ACTIVE-THEMES.md' || relative === 'CURRENT-FOCUS.md') return { category: relative === 'ACTIVE-THEMES.md' ? 'themes' : 'focus', retention: 'themes_and_focus' };
  return { category: 'client-scenes', retention: 'client_scene_memories' };
}

async function memoryRecords(root, state = null) {
  const records = [];
  const seen = new Set();
  for (const relative of REVIEW_PATHS) {
    const placement = categoryForPath(relative);
    if (state && state.consent.retention?.[placement.retention] === 'do_not_store') continue;
    const markdown = await readOptional(root, relative);
    if (markdown === null) continue;
    for (const block of memoryBlocks(markdown)) {
      invariant(!seen.has(block.id), 'A memory ID is duplicated across active layers.', 'MEMORY_ID_DUPLICATED', { id: block.id });
      seen.add(block.id);
      records.push({
        id: block.id,
        relative,
        markdown,
        block,
        category: placement.category,
        retentionClass: placement.retention,
        title: block.title,
        statement: block.statement,
        status: block.status,
        reviewState: block.reviewState || 'current',
        firstObserved: field(block.body, 'First observed'),
        firstSession: field(block.body, 'First session'),
        importedAt: field(block.body, 'Imported at'),
        lastLiveConfirmed: block.lastLiveConfirmed,
        lastConfirmedSession: field(block.body, 'Last confirmed session'),
        reviewDeclinedAt: field(block.body, 'Review declined at'),
        reviewDeclinedSession: field(block.body, 'Review declined session'),
        currentRevision: block.currentRevision
      });
    }
  }
  return records;
}

function parseFrontmatter(markdown) {
  invariant(markdown.startsWith('---\n'), 'Session history has invalid frontmatter.', 'SESSION_HISTORY_INVALID');
  const end = markdown.indexOf('\n---\n', 4);
  invariant(end !== -1, 'Session history has unterminated frontmatter.', 'SESSION_HISTORY_INVALID');
  const fields = {};
  for (const line of markdown.slice(4, end).split('\n')) {
    const match = line.match(/^([a-z][a-z0-9_]*):\s*(.*)$/);
    invariant(match, 'Session history frontmatter contains an invalid line.', 'SESSION_HISTORY_INVALID');
    invariant(!Object.hasOwn(fields, match[1]), 'Session history frontmatter contains a duplicate field.', 'SESSION_HISTORY_INVALID');
    fields[match[1]] = match[2].trim();
  }
  return fields;
}

async function completedSessions(root) {
  const sessionsRoot = path.resolve(root, 'sessions');
  await rejectSymlinkPath(sessionsRoot, { allowMissing: true });
  if (!(await pathExists(sessionsRoot))) return [];
  const entries = await walkTree(sessionsRoot);
  invariant(entries.length <= 20_000, 'Session history is too large to review safely.', 'SESSION_HISTORY_TOO_LARGE');
  const sessions = [];
  const ids = new Set();
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.path.endsWith('--session.md')) continue;
    const markdown = await readOptional(sessionsRoot, entry.path, MAX_SESSION_BYTES);
    const fields = parseFrontmatter(markdown);
    invariant(fields.record_kind === 'ai_authored_session_note' && SESSION_ID.test(fields.session_id || ''), 'Session history identity is invalid.', 'SESSION_HISTORY_INVALID');
    invariant(!ids.has(fields.session_id.toLowerCase()), 'Session history contains a duplicate session ID.', 'SESSION_HISTORY_INVALID');
    ids.add(fields.session_id.toLowerCase());
    if (fields.completion !== 'complete') continue;
    const closedAt = parseTimestamp(fields.closed_at, 'Session close time');
    sessions.push({ sessionId: fields.session_id.toLowerCase(), closedAt });
  }
  sessions.sort((a, b) => a.closedAt - b.closedAt || compareCodePoint(a.sessionId, b.sessionId));
  return sessions;
}

function assertReadAllowed(state) {
  invariant(state?.consent?.continuityMemory === 'on', 'Continuity memory consent is not on.', 'MEMORY_CONSENT_REQUIRED');
  invariant(state.consent.memoryPause?.state !== 'sealed_pause', 'Stale-memory review is unavailable while sealed pause is active.', 'MEMORY_SEALED');
}

function assertWriteAllowed(state) {
  assertReadAllowed(state);
  invariant(state.consent.memoryPause?.state === 'none', 'Memory review decisions cannot be persisted while memory writes are paused.', 'MEMORY_PAUSE_ACTIVE');
}

function assertRecordRetention(state, record) {
  invariant(state.consent.retention?.[record.retentionClass] && state.consent.retention[record.retentionClass] !== 'do_not_store', 'This memory class is disabled by retention policy.', 'RETENTION_DO_NOT_STORE');
}

function sessionBaseline(record, sessions) {
  const candidates = [];
  const lastConfirmed = parseTimestamp(record.lastLiveConfirmed, 'Last live confirmation', { nullable: true });
  if (lastConfirmed !== null) candidates.push(lastConfirmed);
  const imported = parseTimestamp(record.importedAt, 'Import time', { nullable: true });
  const firstObserved = parseTimestamp(record.firstObserved, 'First observed time', { nullable: true });
  if (lastConfirmed === null) {
    if (imported !== null) candidates.push(imported);
    if (firstObserved !== null) candidates.push(firstObserved);
  }
  for (const id of [record.lastConfirmedSession, record.firstSession]) {
    if (!id || id === 'null' || id === 'imported') continue;
    invariant(SESSION_ID.test(id), 'Memory record has an invalid session reference.', 'MEMORY_REVIEW_METADATA_INVALID');
    const match = sessions.find((session) => session.sessionId === id.toLowerCase());
    if (match) candidates.push(match.closedAt);
  }
  return { lastConfirmed, baseline: candidates.length ? Math.max(...candidates) : null };
}

function dueState(record, sessions, now) {
  invariant(/^(?:current|due|declined_until_\d{4}-\d{2}-\d{2})$/.test(record.reviewState || ''), 'Memory review state is invalid.', 'MEMORY_REVIEW_METADATA_INVALID');
  const { lastConfirmed, baseline } = sessionBaseline(record, sessions);
  if (baseline === null) return { due: false, reason: 'insufficient-provenance', sessionsSince: 0, ageDays: null, baseline: null };
  const sessionsSince = sessions.filter((session) => session.closedAt > baseline && session.closedAt <= now.milliseconds).length;
  const ageDays = Math.floor((now.milliseconds - baseline) / (24 * 60 * 60 * 1000));
  if (record.reviewState.startsWith('declined_until_')) {
    const eligibleDate = parseDate(record.reviewState.slice('declined_until_'.length), 'Declined-until date');
    const declinedAt = parseTimestamp(record.reviewDeclinedAt, 'Review decline time');
    invariant(record.reviewDeclinedSession && SESSION_ID.test(record.reviewDeclinedSession), 'Declined review has no valid session reference.', 'MEMORY_REVIEW_METADATA_INVALID');
    const sessionsAfterDecline = sessions.filter((session) => session.closedAt > declinedAt && session.closedAt <= now.milliseconds).length;
    const today = Date.UTC(new Date(now.milliseconds).getUTCFullYear(), new Date(now.milliseconds).getUTCMonth(), new Date(now.milliseconds).getUTCDate());
    return {
      due: today >= eligibleDate && sessionsAfterDecline >= 3,
      reason: today < eligibleDate ? 'declined-date-window' : sessionsAfterDecline < 3 ? 'declined-session-window' : 'decline-window-complete',
      sessionsSince,
      sessionsAfterDecline,
      ageDays,
      baseline
    };
  }
  if (sessionsSince < 3) return { due: false, reason: 'fewer-than-three-subsequent-sessions', sessionsSince, ageDays, baseline };
  if (lastConfirmed !== null && now.milliseconds - lastConfirmed < NINETY_DAYS_MS) return { due: false, reason: 'younger-than-ninety-days', sessionsSince, ageDays, baseline };
  return { due: true, reason: lastConfirmed === null ? 'legacy-or-imported-three-sessions' : 'ninety-days-and-three-sessions', sessionsSince, ageDays, baseline };
}

async function evaluateStaleMemory(root, state, options = {}) {
  assertReadAllowed(state);
  const now = canonicalNow(options.now || new Date().toISOString());
  const limit = options.limit === undefined ? 3 : Number(options.limit);
  invariant(Number.isInteger(limit) && limit >= 1 && limit <= 3, 'Stale-memory offer limit must be 1 to 3.', 'MEMORY_REVIEW_LIMIT_INVALID');
  if (state.consent.reviewPreferences?.staleMemoryOffers === 'off') return { status: 'disabled', due: [], totalDue: 0, nextAction: 'none' };
  const suppressed = new Set(state.consent.reviewPreferences?.suppressedMemoryIds || []);
  for (const id of suppressed) invariant(MEMORY_ID.test(id), 'Suppressed memory ID is invalid.', 'WORKSPACE_STATE_INVALID');
  const sessions = await completedSessions(root);
  const due = [];
  for (const record of await memoryRecords(root, state)) {
    if (suppressed.has(record.id)) continue;
    const eligibility = dueState(record, sessions, now);
    if (eligibility.due) due.push({
      id: record.id,
      category: record.category,
      title: record.title,
      statement: record.statement,
      status: record.status,
      lastLiveConfirmed: record.lastLiveConfirmed,
      reviewState: record.reviewState,
      reason: eligibility.reason,
      ageDays: eligibility.ageDays,
      completedSessionsSinceBaseline: eligibility.sessionsSince
    });
  }
  due.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) || compareCodePoint(a.id, b.id));
  return { status: due.length ? 'due' : 'not-due', due: due.slice(0, limit), totalDue: due.length, completedSessionCount: sessions.length, nextAction: due.length ? 'offer-neutral-review' : 'none' };
}

function replaceField(body, name, value, { remove = false } = {}) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`^- ${escaped}:.*(?:\\n|$)`, 'mi');
  if (remove) return body.replace(expression, '');
  if (expression.test(body)) return body.replace(expression, `- ${name}: ${value}\n`);
  const history = body.search(/^#### Revision history\s*$/mi);
  const line = `- ${name}: ${value}\n`;
  return history === -1 ? `${body.replace(/\s*$/, '')}\n${line}` : `${body.slice(0, history)}${line}\n${body.slice(history)}`;
}

function addRevision(body, revision, now, action, sessionId) {
  const line = `- r${revision} — ${now} — ${action} in ${sessionId}`;
  if (/^#### Revision history\s*$/mi.test(body)) return body.replace(/^(#### Revision history\s*)$/mi, `$1\n\n${line}`);
  return `${body.replace(/\s*$/, '')}\n\n#### Revision history\n\n${line}\n`;
}

async function findRecord(root, state, id) {
  invariant(MEMORY_ID.test(id || ''), 'Memory review requires a valid memory ID.', 'INVALID_MEMORY_ID');
  const matches = (await memoryRecords(root, state)).filter((record) => record.id === id.toLowerCase());
  invariant(matches.length === 1, matches.length ? 'Memory ID is duplicated.' : 'Memory item was not found.', matches.length ? 'MEMORY_ID_DUPLICATED' : 'MEMORY_NOT_FOUND');
  return matches[0];
}

function updateRecord(record, updater, now, action, sessionId) {
  const revision = Number(record.currentRevision || '1');
  invariant(Number.isSafeInteger(revision) && revision >= 1, 'Memory revision is invalid.', 'MEMORY_REVIEW_METADATA_INVALID');
  let body = updater(record.block.body);
  body = replaceField(body, 'Current revision', String(revision + 1));
  body = addRevision(body, revision + 1, now, action, sessionId);
  return `${record.markdown.slice(0, record.block.start)}${body}${record.markdown.slice(record.block.end)}`;
}

async function planReviewDecision(root, state, options = {}) {
  assertWriteAllowed(state);
  const id = String(options.id || '').toLowerCase();
  invariant(MEMORY_ID.test(id), 'Memory review requires a valid memory ID.', 'INVALID_MEMORY_ID');
  const action = options.action;
  invariant(['confirm', 'decline', 'suppress', 'unsuppress'].includes(action), 'Memory review action is invalid.', 'MEMORY_REVIEW_ACTION_INVALID');
  const preferences = structuredClone(state.consent.reviewPreferences || { staleMemoryOffers: 'on', suppressedMemoryIds: [] });
  const suppressed = new Set(preferences.suppressedMemoryIds || []);
  if (action === 'suppress' || action === 'unsuppress') {
    if (action === 'suppress') suppressed.add(id);
    else suppressed.delete(id);
    preferences.suppressedMemoryIds = [...suppressed].sort(compareCodePoint);
    const currentSuppressed = state.consent.reviewPreferences?.suppressedMemoryIds || [];
    return { action, id, writes: new Map(), deletes: [], reviewPreferences: preferences, changed: action === 'suppress' ? !currentSuppressed.includes(id) : currentSuppressed.includes(id) };
  }
  const record = await findRecord(root, state, id);
  assertRecordRetention(state, record);
  const now = canonicalNow(options.now || new Date().toISOString());
  const sessionId = String(options.sessionId || state.consent.currentSessionId || '').toLowerCase();
  invariant(SESSION_ID.test(sessionId), 'A current session ID is required for a memory review decision.', 'SESSION_ID_REQUIRED');
  let content;
  if (action === 'confirm') {
    content = updateRecord(record, (body) => {
      let next = replaceField(body, 'Status', 'user_confirmed');
      next = replaceField(next, 'Last live confirmed', now.value);
      next = replaceField(next, 'Last confirmed session', sessionId);
      next = replaceField(next, 'Review state', 'current');
      next = replaceField(next, 'Review declined at', '', { remove: true });
      return replaceField(next, 'Review declined session', '', { remove: true });
    }, now.value, 'user live confirmation; wording unchanged', sessionId);
  } else {
    const until = new Date(now.milliseconds + THIRTY_DAYS_MS).toISOString().slice(0, 10);
    content = updateRecord(record, (body) => {
      let next = replaceField(body, 'Review state', `declined_until_${until}`);
      next = replaceField(next, 'Review declined at', now.value);
      return replaceField(next, 'Review declined session', sessionId);
    }, now.value, 'stale review declined; content unchanged', sessionId);
  }
  return { action, id, writes: new Map([[record.relative, content]]), deletes: [], reviewPreferences: preferences, changed: true };
}

module.exports = {
  REVIEW_PATHS,
  completedSessions,
  evaluateStaleMemory,
  planReviewDecision,
  dueState,
  parseTimestamp
};
