'use strict';

const path = require('node:path');
const { ScalvinError, invariant } = require('./errors');
const { atomicWriteFile, readBoundedRegularFile, rejectSymlinkPath } = require('./fs-safe');

const LEDGER_RELATIVE = '.therapy/state/BACKUP-LEDGER.md';
const SESSION_THRESHOLD = 10;
const REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

function strictInstant(value, allowNull = true) {
  if (allowNull && value === 'null') return null;
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);
  const epoch = match ? Date.parse(value) : NaN;
  invariant(match && Number(match[6]) <= 59 && !Number.isNaN(epoch), 'Backup reminder timestamp is invalid.', 'BACKUP_LEDGER_INVALID');
  return new Date(epoch).toISOString();
}

function parseReminder(markdown) {
  const read = (label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...markdown.matchAll(new RegExp(`^- ${escaped}: ([^|\\r\\n]{1,128})$`, 'gm'))];
    invariant(matches.length === 1, 'Backup reminder state is missing or duplicated.', 'BACKUP_LEDGER_INVALID', { field: label });
    return matches[0][1];
  };
  const sessions = read('Sessions since successful backup');
  invariant(/^\d+$/.test(sessions) && Number.isSafeInteger(Number(sessions)), 'Backup reminder session count is invalid.', 'BACKUP_LEDGER_INVALID');
  return {
    sessionsSinceSuccessfulBackup: Number(sessions),
    lastReminderAt: strictInstant(read('Last reminder at')),
    reminderDeclinedUntil: strictInstant(read('Reminder declined until'))
  };
}

function replaceField(markdown, label, value) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`^- ${escaped}:.*$`, 'm');
  invariant(expression.test(markdown), 'Backup reminder field is missing.', 'BACKUP_LEDGER_INVALID', { field: label });
  return markdown.replace(expression, `- ${label}: ${value}`);
}

async function reminderContext(workspace) {
  const statePath = path.join(workspace, '.scalvin', 'state.json');
  await rejectSymlinkPath(statePath);
  let state;
  try {
    state = JSON.parse((await readBoundedRegularFile(statePath, 2 * 1024 * 1024, {
      typeCode: 'WORKSPACE_STATE_INVALID', sizeCode: 'WORKSPACE_STATE_INVALID', changedCode: 'WORKSPACE_STATE_CHANGED'
    })).toString('utf8'));
  } catch (error) {
    if (error instanceof ScalvinError) throw error;
    throw new ScalvinError('Workspace state is invalid.', 'WORKSPACE_STATE_INVALID');
  }
  if (state.consent?.usageLedgers !== 'on' || state.consent?.retention?.usage_ledgers === 'do_not_store') return { enabled: false };
  const ledgerPath = path.join(workspace, LEDGER_RELATIVE);
  await rejectSymlinkPath(ledgerPath);
  const markdown = (await readBoundedRegularFile(ledgerPath, 1024 * 1024, {
    typeCode: 'BACKUP_LEDGER_INVALID', sizeCode: 'BACKUP_LEDGER_INVALID', changedCode: 'BACKUP_LEDGER_CHANGED'
  })).toString('utf8');
  return { enabled: true, ledgerPath, markdown, reminder: parseReminder(markdown) };
}

async function writeAndVerify(context, markdown) {
  await atomicWriteFile(context.ledgerPath, markdown);
  const verified = (await readBoundedRegularFile(context.ledgerPath, 1024 * 1024, {
    typeCode: 'BACKUP_LEDGER_VERIFY_FAILED', sizeCode: 'BACKUP_LEDGER_VERIFY_FAILED', changedCode: 'BACKUP_LEDGER_VERIFY_FAILED'
  })).toString('utf8');
  return parseReminder(verified);
}

async function recordPersistedSessionClose(workspace, options = {}) {
  const at = strictInstant(options.at || new Date().toISOString(), false);
  const context = await reminderContext(workspace);
  if (!context.enabled) return { recorded: false, reason: 'usage-ledgers-off', due: false };
  const sessions = context.reminder.sessionsSinceSuccessfulBackup + 1;
  invariant(Number.isSafeInteger(sessions), 'Backup reminder session count overflowed.', 'BACKUP_LEDGER_INVALID');
  const nowMs = Date.parse(at);
  const suppressed = context.reminder.reminderDeclinedUntil !== null && Date.parse(context.reminder.reminderDeclinedUntil) > nowMs;
  const intervalElapsed = context.reminder.lastReminderAt === null || nowMs - Date.parse(context.reminder.lastReminderAt) >= REMINDER_INTERVAL_MS;
  const due = sessions >= SESSION_THRESHOLD && !suppressed && intervalElapsed;
  let markdown = replaceField(context.markdown, 'Sessions since successful backup', String(sessions));
  if (due) markdown = replaceField(markdown, 'Last reminder at', at);
  const verified = await writeAndVerify(context, markdown);
  invariant(verified.sessionsSinceSuccessfulBackup === sessions && (!due || verified.lastReminderAt === at), 'Backup reminder update verification failed.', 'BACKUP_LEDGER_VERIFY_FAILED');
  const nextReminderAt = suppressed
    ? context.reminder.reminderDeclinedUntil
    : due
      ? new Date(nowMs + REMINDER_INTERVAL_MS).toISOString()
      : context.reminder.lastReminderAt
        ? new Date(Date.parse(context.reminder.lastReminderAt) + REMINDER_INTERVAL_MS).toISOString()
        : null;
  return { recorded: true, sessionsSinceSuccessfulBackup: sessions, due, nextReminderAt };
}

async function declineBackupReminder(workspace, options = {}) {
  const at = strictInstant(options.at || new Date().toISOString(), false);
  const context = await reminderContext(workspace);
  if (!context.enabled) return { recorded: false, reason: 'usage-ledgers-off' };
  const declinedUntil = new Date(Date.parse(at) + REMINDER_INTERVAL_MS).toISOString();
  let markdown = replaceField(context.markdown, 'Last reminder at', at);
  markdown = replaceField(markdown, 'Reminder declined until', declinedUntil);
  const verified = await writeAndVerify(context, markdown);
  invariant(verified.lastReminderAt === at && verified.reminderDeclinedUntil === declinedUntil, 'Backup reminder decline verification failed.', 'BACKUP_LEDGER_VERIFY_FAILED');
  return { recorded: true, declinedUntil };
}

module.exports = {
  LEDGER_RELATIVE,
  SESSION_THRESHOLD,
  REMINDER_INTERVAL_MS,
  parseReminder,
  recordPersistedSessionClose,
  declineBackupReminder
};
