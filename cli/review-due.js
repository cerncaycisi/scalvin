'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ScalvinError, invariant } = require('./lib/errors');
const { resolvePortablePath, rejectSymlinkPath, acquireMutationLock, inspectMutationLock } = require('./lib/fs-safe');
const { loadManifest } = require('./lib/manifest');
const { loadWorkspaceState } = require('./lib/workspace');

const MAX_REVIEW_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const BUNDLED_MANIFEST = path.resolve(__dirname, '..', 'manifest.json');

const REVIEW_PATTERNS = [
  { pattern: /^(\d{4}-\d{2}-\d{2})-\d{6}--[0-9a-f-]{36}--weekly-review\.md$/i, format: 'new' },
  { pattern: /^(\d{4}-\d{2}-\d{2})-\d{4}-weekly-review\.md$/, format: 'legacy' }
];
const SESSION_PATTERNS = [
  { pattern: /^(\d{4}-\d{2}-\d{2})-\d{6}--[0-9a-f-]{36}--session\.md$/i, format: 'new' },
  { pattern: /^(\d{4}-\d{2}-\d{2})-\d{4}\.md$/, format: 'legacy' }
];

function parseIsoDate(value) {
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(value || ''), '--date must use YYYY-MM-DD.', 'INVALID_DATE');
  const date = new Date(`${value}T00:00:00.000Z`);
  invariant(!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value, '--date is not a real calendar date.', 'INVALID_DATE');
  return date;
}

function localDateForTimezone(timezone) {
  try {
    const formatter = new Intl.DateTimeFormat('und-u-ca-iso8601-nu-latn', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
    return parseIsoDate(`${parts.year}-${parts.month}-${parts.day}`);
  } catch (error) {
    throw new ScalvinError(`Unknown IANA timezone: ${timezone}`, 'INVALID_TIMEZONE', { cause: error.message });
  }
}

function startOfWeek(date) {
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const monday = new Date(date);
  monday.setUTCDate(monday.getUTCDate() - mondayOffset);
  return monday;
}

async function readFrontmatterOnly(filename, options = {}) {
  await rejectSymlinkPath(filename);
  const before = await fsp.lstat(filename);
  invariant(before.isFile(), 'Review metadata source must be a regular file.', 'REVIEW_ARTIFACT_INVALID');
  invariant(before.size <= MAX_REVIEW_ARTIFACT_BYTES, 'Review metadata source exceeds the safe artifact limit.', 'REVIEW_ARTIFACT_TOO_LARGE');
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    invariant(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino, 'Review metadata source changed while opening.', 'REVIEW_ARTIFACT_CHANGED');
    if (options.afterOpen) await options.afterOpen();
    const bytes = [];
    const byte = Buffer.allocUnsafe(1);
    let position = 0;
    let suffix = '';
    while (position < Math.min(opened.size, MAX_FRONTMATTER_BYTES)) {
      const { bytesRead } = await handle.read(byte, 0, 1, position);
      if (bytesRead === 0) break;
      bytes.push(byte[0]);
      position += 1;
      suffix = `${suffix}${String.fromCharCode(byte[0])}`.slice(-5);
      if (position >= 9 && suffix === '\n---\n') break;
    }
    const after = await handle.stat();
    invariant(after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs, 'Review metadata source changed while reading.', 'REVIEW_ARTIFACT_CHANGED');
    const raw = Buffer.from(bytes).toString('utf8');
    invariant(raw.startsWith('---\n') && raw.endsWith('\n---\n'), 'Review artifact frontmatter is missing or exceeds the safe metadata limit.', 'REVIEW_ARTIFACT_INVALID');
    return raw.slice(4, -5);
  } finally {
    await handle.close();
  }
}

async function datedMatches(directory, patterns, label, options = {}) {
  await rejectSymlinkPath(directory);
  const stat = await fsp.lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') throw new ScalvinError(`${label} directory not found.`, 'DIRECTORY_NOT_FOUND', { path: directory });
    throw error;
  });
  invariant(stat.isDirectory(), `${label} path is not a directory.`, 'NOT_A_DIRECTORY', { path: directory });
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const matches = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.name.startsWith('.')) continue;
    const absolute = path.join(directory, entry.name);
    const entryStat = await fsp.lstat(absolute);
    invariant(!entryStat.isSymbolicLink(), `Symlink entries are not allowed in ${label}.`, 'SYMLINK_REJECTED', { path: absolute });
    if (!entryStat.isFile()) continue;
    for (const descriptor of patterns) {
      const match = descriptor.pattern.exec(entry.name);
      if (match) {
        const completed = descriptor.format === 'legacy'
          ? entryStat.size > 0
          : isCompletedFrontmatter(await readFrontmatterOnly(absolute, options.readOptions));
        if (completed) matches.push({ name: entry.name, date: parseIsoDate(match[1]) });
        break;
      }
    }
  }
  return matches;
}

function completionMarkers(content) {
  return [...content.matchAll(/^completion:\s*([^\r\n#]+?)\s*$/gim)].map((match) => match[1].trim().toLowerCase());
}

function isCompletedArtifact(content, format) {
  if (!content.trim()) return false;
  const markers = completionMarkers(content);
  if (markers.length > 1) return false;
  if (format === 'legacy') return markers.length === 0 || markers[0] === 'complete';
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return false;
  const frontmatterMarkers = completionMarkers(frontmatter[1]);
  return frontmatterMarkers.length === 1 && markers.length === 1 && frontmatterMarkers[0] === 'complete';
}

function isCompletedFrontmatter(frontmatter) {
  const markers = completionMarkers(frontmatter);
  return markers.length === 1 && markers[0] === 'complete';
}

async function canonicalReviewState(workspace, options) {
  if (options.canonicalState) return options.canonicalState;
  const loaded = await loadManifest(BUNDLED_MANIFEST);
  const result = await loadWorkspaceState(workspace, loaded.manifest);
  invariant(result.kind === 'current', 'review-due requires a valid canonical workspace state.', 'WORKSPACE_STATE_MIGRATION_REQUIRED', { kind: result.kind });
  return result.state;
}

function disabledResult(workspace, state, reason) {
  return {
    status: 'NOT_DUE', availability: 'disabled', workspacePath: workspace,
    workspaceId: state.workspaceId || null, reason,
    matches: [], priorSessionMatches: [], sessionFilesRead: false, reviewFilesRead: false,
    nextAction: 'continue-session'
  };
}

async function reviewDueUnlocked(options = {}) {
  invariant(options.target || options.workspace, 'review-due requires --workspace (or --target).', 'INVALID_ARGUMENT');
  const workspace = resolvePortablePath(options.target || options.workspace);
  await rejectSymlinkPath(workspace);
  const state = await canonicalReviewState(workspace, options);
  const consent = state?.consent;
  invariant(consent && consent.retention, 'review-due requires canonical consent and retention state.', 'CONSENT_STATE_INVALID');
  for (const dataClass of ['session_notes', 'reviews_and_summaries']) {
    invariant(['until_deleted', 'do_not_store'].includes(consent.retention[dataClass]), 'This retention policy is unsupported by the current deterministic review engine.', 'UNSUPPORTED_RETENTION_POLICY', { dataClass, policy: consent.retention[dataClass] });
  }
  if (consent.continuityMemory !== 'on') return disabledResult(workspace, state, 'continuity memory is off');
  if (consent.memoryPause?.state === 'sealed_pause') return disabledResult(workspace, state, 'memory is sealed');
  if (consent.retention.session_notes === 'do_not_store' || consent.retention.reviews_and_summaries === 'do_not_store') {
    return disabledResult(workspace, state, 'required review data retention is disabled');
  }
  let today;
  let timezone;
  let timezoneStatus;
  if (options.date) {
    today = parseIsoDate(options.date);
    timezone = options.timezone || 'date-override';
    timezoneStatus = 'date_override';
    if (options.timezone) localDateForTimezone(options.timezone); // validate it even with an override
  } else if (options.timezone) {
    today = localDateForTimezone(options.timezone);
    timezone = options.timezone;
    timezoneStatus = 'confirmed';
  } else if (consent.timezone?.status === 'confirmed') {
    timezone = consent.timezone.value;
    today = localDateForTimezone(timezone);
    timezoneStatus = 'confirmed';
  } else {
    timezone = 'unconfirmed';
    today = parseIsoDate(new Date().toISOString().slice(0, 10));
    timezoneStatus = 'unconfirmed';
  }

  const weekStart = startOfWeek(today);
  const reviews = await datedMatches(path.join(workspace, 'archive', 'reviews'), REVIEW_PATTERNS, 'reviews', options);
  const sessions = await datedMatches(path.join(workspace, 'sessions'), SESSION_PATTERNS, 'sessions', options);
  const currentReviews = reviews.filter((entry) => entry.date >= weekStart && entry.date <= today).map((entry) => entry.name);
  const priorSessions = sessions.filter((entry) => entry.date < weekStart).map((entry) => entry.name);
  let status;
  let reason;
  if (currentReviews.length) {
    status = 'NOT_DUE';
    reason = 'weekly review already exists for the current calendar week';
  } else if (!priorSessions.length) {
    status = 'NOT_DUE';
    reason = 'no completed session exists before the current calendar week';
  } else {
    status = 'DUE';
    reason = 'first returning session this week; prior-week session exists and no current-week review exists';
  }
  if (status === 'DUE' && timezoneStatus === 'unconfirmed') {
    status = 'NOT_DUE';
    reason = 'timezone is unconfirmed; confirm an IANA timezone before creating a calendar-week review';
  }
  return {
    status,
    workspacePath: workspace,
    today: today.toISOString().slice(0, 10),
    reviewWeekStart: weekStart.toISOString().slice(0, 10),
    timezone,
    timezoneStatus,
    reason,
    matches: currentReviews,
    priorSessionMatches: priorSessions,
    sessionFilesRead: true,
    reviewFilesRead: true,
    nextAction: status === 'DUE' ? 'create-weekly-review' : reason.startsWith('timezone is unconfirmed') ? 'confirm-timezone' : 'continue-session'
  };
}

async function reviewDue(options = {}) {
  invariant(options.target || options.workspace, 'review-due requires --workspace (or --target).', 'INVALID_ARGUMENT');
  const workspace = resolvePortablePath(options.target || options.workspace);
  let release;
  try {
    release = await acquireMutationLock(workspace);
  } catch (error) {
    if (error?.code !== 'MUTATION_LOCKED') throw error;
    const lock = await inspectMutationLock(workspace).catch(() => ({ status: 'unverifiable', lockPath: error.details?.lockPath || null }));
    return {
      status: 'BUSY',
      availability: 'busy',
      workspacePath: workspace,
      errors: 1,
      reason: 'workspace mutation lock is present; no multi-file due claim was made',
      matches: [],
      priorSessionMatches: [],
      sessionFilesRead: false,
      reviewFilesRead: false,
      mutationLock: lock,
      warnings: [{ code: 'WORKSPACE_MUTATION_BUSY' }],
      nextAction: 'confirm-no-writer-then-remove-exact-lock-manually'
    };
  }
  let result;
  let operationError = null;
  try {
    result = await reviewDueUnlocked(options);
  } catch (error) {
    operationError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    if (operationError) {
      operationError.details = {
        ...(operationError.details || {}),
        mutationLockReleased: false,
        warnings: [
          ...(operationError.details?.warnings || []),
          { code: 'MUTATION_LOCK_RELEASE_FAILED', errorCode: releaseError.code || 'MUTATION_LOCK_RELEASE_FAILED' }
        ],
        nextAction: operationError.details?.nextAction || 'inspect-workspace-and-reconcile-mutation-lock',
        mutationLockRelease: {
          released: false,
          errorCode: releaseError.code || 'MUTATION_LOCK_RELEASE_FAILED',
          nextAction: 'inspect-and-reconcile-mutation-lock'
        }
      };
      throw operationError;
    }
    return {
      ...result,
      status: 'partial',
      mutationLockReleased: false,
      warnings: [
        ...(Array.isArray(result?.warnings) ? result.warnings : []),
        { code: 'MUTATION_LOCK_RELEASE_FAILED', errorCode: releaseError.code || 'MUTATION_LOCK_RELEASE_FAILED' }
      ],
      nextAction: 'inspect-workspace-and-reconcile-mutation-lock'
    };
  }
  if (operationError) throw operationError;
  return result;
}

module.exports = { reviewDue, parseIsoDate, startOfWeek, datedMatches, completionMarkers, isCompletedArtifact, isCompletedFrontmatter, readFrontmatterOnly };
