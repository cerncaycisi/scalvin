'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { sandbox, ROOT } = require('./helpers');
const {
  SESSION_THRESHOLD,
  REMINDER_INTERVAL_MS,
  recordPersistedSessionClose,
  declineBackupReminder
} = require('../../cli/lib/backup-reminder');
const { appendBackupOperationReceipt } = require('../../cli/lib/backup');
const { checkBackupLedger } = require('../../cli/doctor');

async function reminderWorkspace(t, label, usageLedgers = 'on') {
  const box = await sandbox(`backup-reminder-${label}`);
  t.after(box.cleanup);
  await fsp.mkdir(path.join(box.workspace, '.scalvin'), { recursive: true });
  await fsp.mkdir(path.join(box.workspace, '.therapy', 'state'), { recursive: true });
  const state = {
    schemaVersion: 2,
    consent: { usageLedgers, retention: { usage_ledgers: usageLedgers === 'on' ? 'until_deleted' : 'do_not_store' } }
  };
  await fsp.writeFile(path.join(box.workspace, '.scalvin', 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  await fsp.copyFile(
    path.join(ROOT, 'templates', 'state', 'BACKUP-LEDGER.template.md'),
    path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md')
  );
  return { ...box, state };
}

test('backup reminder is due on the tenth persisted close and never repeats within thirty days', async (t) => {
  const box = await reminderWorkspace(t, 'threshold');
  for (let index = 0; index < SESSION_THRESHOLD - 1; index += 1) {
    const result = await recordPersistedSessionClose(box.workspace, {
      at: new Date(Date.UTC(2026, 0, index + 1)).toISOString()
    });
    assert.equal(result.recorded, true);
    assert.equal(result.due, false);
    assert.equal(result.sessionsSinceSuccessfulBackup, index + 1);
  }
  const firstDueAt = new Date(Date.UTC(2026, 0, SESSION_THRESHOLD)).toISOString();
  const due = await recordPersistedSessionClose(box.workspace, { at: firstDueAt });
  assert.equal(due.sessionsSinceSuccessfulBackup, SESSION_THRESHOLD);
  assert.equal(due.due, true);

  const tooSoon = await recordPersistedSessionClose(box.workspace, {
    at: new Date(Date.parse(firstDueAt) + REMINDER_INTERVAL_MS - 1).toISOString()
  });
  assert.equal(tooSoon.due, false);
  const next = await recordPersistedSessionClose(box.workspace, {
    at: new Date(Date.parse(firstDueAt) + REMINDER_INTERVAL_MS).toISOString()
  });
  assert.equal(next.due, true);
});

test('session close timestamps without milliseconds or with an offset normalize before reminder persistence', async (t) => {
  const box = await reminderWorkspace(t, 'timestamp-normalization');
  const first = await recordPersistedSessionClose(box.workspace, { at: '2026-07-14T11:10:00Z' });
  assert.equal(first.recorded, true);
  const second = await recordPersistedSessionClose(box.workspace, { at: '2026-07-14T14:10:01+03:00' });
  assert.equal(second.sessionsSinceSuccessfulBackup, 2);
  const markdown = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md'), 'utf8');
  assert.match(markdown, /- Sessions since successful backup: 2/);
});

test('declining a reminder suppresses offers for thirty days and disabled ledgers write nothing', async (t) => {
  const box = await reminderWorkspace(t, 'decline');
  for (let index = 0; index < SESSION_THRESHOLD; index += 1) {
    await recordPersistedSessionClose(box.workspace, {
      at: new Date(Date.UTC(2026, 1, index + 1)).toISOString()
    });
  }
  const declinedAt = '2026-02-11T00:00:00.000Z';
  const declined = await declineBackupReminder(box.workspace, { at: declinedAt });
  assert.equal(declined.recorded, true);
  assert.equal(declined.declinedUntil, new Date(Date.parse(declinedAt) + REMINDER_INTERVAL_MS).toISOString());
  const suppressed = await recordPersistedSessionClose(box.workspace, {
    at: new Date(Date.parse(declined.declinedUntil) - 1).toISOString()
  });
  assert.equal(suppressed.due, false);
  const dueAgain = await recordPersistedSessionClose(box.workspace, { at: declined.declinedUntil });
  assert.equal(dueAgain.due, true);

  const disabled = await reminderWorkspace(t, 'disabled', 'off');
  const before = await fsp.readFile(path.join(disabled.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md'), 'utf8');
  assert.deepEqual(await recordPersistedSessionClose(disabled.workspace), { recorded: false, reason: 'usage-ledgers-off', due: false });
  assert.equal(await fsp.readFile(path.join(disabled.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md'), 'utf8'), before);
});

test('doctor validates shared backup and operation-receipt schemas without exposing content', async (t) => {
  const box = await reminderWorkspace(t, 'doctor');
  await appendBackupOperationReceipt(box.workspace, {
    operation: 'restore', backupId: null, phase: 'preflight', status: 'failed', errorCode: 'TARGET_NOT_EMPTY',
    at: '2026-07-14T10:00:00.000Z', eventId: 'backup-op-10000000-0000-4000-8000-000000000001'
  });
  const valid = await checkBackupLedger(box.workspace, box.state);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].code, 'BACKUP_LEDGER_OK');
  assert.equal(valid[0].details.operationReceiptCount, 1);

  const ledgerPath = path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md');
  await fsp.appendFile(ledgerPath, '| backup-op-invalid | 2026-07-14T10:00:00.000Z | restore | null | verify | failed | BAD |\n');
  const invalid = await checkBackupLedger(box.workspace, box.state);
  assert.equal(invalid[0].code, 'BACKUP_LEDGER_INVALID');
});
