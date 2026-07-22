'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { install, backup } = require('../../cli/operations');
const { appendBackupLedger, markBackupDeleted, readBackupLedgerStatus } = require('../../cli/lib/backup');
const { SESSION_THRESHOLD, recordPersistedSessionClose } = require('../../cli/lib/backup-reminder');
const { sandbox } = require('./helpers');

test('backup status selects the newest active timestamp and deletion falls back to the prior record', async () => {
  const box = await sandbox('backup-ledger-latest');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const older = {
      backupId: 'backup-11111111-1111-4111-8111-111111111111',
      createdAt: '2026-07-14T10:00:00.000Z', destinationClass: 'local_sibling_default',
      encryption: 'none', checksum: 'a'.repeat(64)
    };
    const newer = {
      backupId: 'backup-22222222-2222-4222-8222-222222222222',
      createdAt: '2026-07-15T10:00:00.000Z', destinationClass: 'local_user_selected',
      encryption: 'aes-256-gcm', checksum: 'b'.repeat(64)
    };
    const appendedLaterButOlder = {
      backupId: 'backup-33333333-3333-4333-8333-333333333333',
      createdAt: '2026-07-13T10:00:00.000Z', destinationClass: 'restore_input_exact_path',
      encryption: 'none', checksum: 'c'.repeat(64)
    };
    await appendBackupLedger(box.workspace, older);
    await appendBackupLedger(box.workspace, newer);
    assert.equal((await appendBackupLedger(box.workspace, appendedLaterButOlder)).written, true);
    const before = await readBackupLedgerStatus(box.workspace);
    assert.equal(before.recordCount, 3);
    assert.equal(before.latest.backupId, newer.backupId);
    assert.equal(before.reminder.lastSuccessfulBackup, newer.createdAt);

    await markBackupDeleted(box.workspace, { backupId: newer.backupId, deletedAt: '2026-07-15T11:00:00.000Z' });
    const after = await readBackupLedgerStatus(box.workspace);
    assert.equal(after.latest.backupId, older.backupId);
    assert.equal(after.reminder.lastSuccessfulBackup, older.createdAt);
    assert.equal(after.reminder.lastSuccessfulBackupSha256, older.checksum);
    assert.equal(after.reminder.lastDestinationClass, older.destinationClass);
  } finally {
    await box.cleanup();
  }
});

test('backup status exposes bounded reminder eligibility and records explicit suppression', async () => {
  const box = await sandbox('backup-reminder-status');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    for (let index = 0; index < SESSION_THRESHOLD; index += 1) {
      await recordPersistedSessionClose(box.workspace, {
        at: new Date(Date.UTC(2026, 0, index + 1)).toISOString()
      });
    }
    const status = await backup({ target: box.workspace, action: 'status' });
    assert.deepEqual(Object.keys(status.reminder).sort(), [
      'dueNow', 'lastReminderAt', 'nextEligibleAt', 'reminderDeclinedUntil',
      'sessionThreshold', 'sessionsSinceSuccessfulBackup', 'thresholdReached'
    ]);
    assert.equal(status.reminder.sessionsSinceSuccessfulBackup, SESSION_THRESHOLD);
    assert.equal(status.reminder.thresholdReached, true);
    assert.equal(status.reminder.dueNow, true);

    const declined = await backup({ target: box.workspace, action: 'status', 'decline-reminder': true });
    assert.equal(declined.reminderDecline.recorded, true);
    assert.match(declined.reminderDecline.declinedUntil, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(declined.reminder.dueNow, false);
    assert.equal(declined.reminder.reminderDeclinedUntil, declined.reminderDecline.declinedUntil);
  } finally {
    await box.cleanup();
  }
});

test('backup action surface uses authenticated stable IDs and exact deletion confirmation', async () => {
  const box = await sandbox('backup-actions');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const created = await backup({ target: box.workspace, action: 'create' });
    assert.match(created.backupId, /^backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const status = await backup({ target: box.workspace, action: 'status', id: created.backupId });
    assert.equal(status.status, 'found');
    assert.equal(status.backupStatus, 'complete');
    assert.equal(status.contentIncluded, false);
    assert.equal(status.artifactPathIncluded, false);
    assert.equal(JSON.stringify(status).includes(created.backupPath), false);

    const verified = await backup({ target: box.workspace, action: 'verify', id: created.backupId });
    assert.equal(verified.status, 'verified');
    assert.equal(verified.backupId, created.backupId);
    assert.equal(verified.verified, true);
    assert.equal(verified.artifactPathIncluded, false);

    const preview = await backup({ target: box.workspace, action: 'delete', id: created.backupId });
    assert.equal(preview.status, 'preview');
    await assert.rejects(backup({
      target: box.workspace, action: 'delete', id: created.backupId, confirm: 'wrong'
    }), { code: 'STALE_CONFIRMATION' });
    const deleted = await backup({
      target: box.workspace, action: 'delete', id: created.backupId, confirm: preview.confirmationRequired
    });
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.ledgerWritten, true);
    await assert.rejects(fsp.access(created.backupPath), { code: 'ENOENT' });
    const after = await backup({ target: box.workspace, action: 'status', id: created.backupId });
    assert.equal(after.backupStatus, 'deleted');
    assert.equal(after.deletedAt, deleted.deletedAt);
    assert.equal(after.operationReceiptCount, 4);
  } finally {
    await box.cleanup();
  }
});

test('backup delete preview becomes stale when a valid same-ID artifact changes', async () => {
  const box = await sandbox('backup-delete-stale-artifact');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const created = await backup({ target: box.workspace, action: 'create', 'allow-plaintext-backup': true });
    const preview = await backup({ target: box.workspace, action: 'delete', id: created.backupId });
    const integrityPath = path.join(created.backupPath, 'integrity.json');
    const integrity = JSON.parse(await fsp.readFile(integrityPath, 'utf8'));
    const entry = integrity.entries.find((item) => item.type === 'file');
    const payloadPath = path.join(created.backupPath, 'payload', entry.path);
    await fsp.appendFile(payloadPath, '\nvalid post-preview mutation\n');
    const payload = await fsp.readFile(payloadPath);
    entry.size = payload.length;
    entry.sha256 = crypto.createHash('sha256').update(payload).digest('hex');
    const raw = `${JSON.stringify(integrity, null, 2)}\n`;
    await fsp.writeFile(integrityPath, raw);
    await fsp.writeFile(
      path.join(created.backupPath, 'CHECKSUM.sha256'),
      `${crypto.createHash('sha256').update(raw).digest('hex')}  integrity.json\n`
    );
    await assert.rejects(backup({
      target: box.workspace, action: 'delete', id: created.backupId,
      confirm: preview.confirmationRequired
    }), { code: 'STALE_CONFIRMATION' });
    await fsp.access(created.backupPath);
    const fresh = await backup({ target: box.workspace, action: 'delete', id: created.backupId });
    const deleted = await backup({
      target: box.workspace, action: 'delete', id: created.backupId,
      confirm: fresh.confirmationRequired
    });
    assert.equal(deleted.status, 'deleted');
  } finally {
    await box.cleanup();
  }
});

test('backup delete returns post-commit partial truth when ledger reconciliation has no usable row', async () => {
  const box = await sandbox('backup-delete-ledger-failure');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const created = await backup({ target: box.workspace, action: 'create' });
    const preview = await backup({ target: box.workspace, action: 'delete', id: created.backupId });
    const ledgerPath = path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md');
    await fsp.writeFile(ledgerPath, 'invalid ledger\n', { mode: 0o600 });

    const result = await backup({
      target: box.workspace, action: 'delete', id: created.backupId,
      confirm: preview.confirmationRequired
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.artifactDeleted, true);
    assert.equal(result.backupId, created.backupId);
    assert.match(result.deletedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.ledgerWritten, false);
    assert.equal(result.ledgerReason, 'backup-id-not-found');
    assert.equal(result.nextAction, 'reconcile-backup-deletion-ledger');
    assert.deepEqual(result.warnings, [{
      code: 'BACKUP_DELETION_LEDGER_RECONCILIATION_REQUIRED', reason: 'backup-id-not-found'
    }]);
    await assert.rejects(fsp.access(created.backupPath), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('backup delete returns partial when the authenticated artifact has no ledger row', async () => {
  const box = await sandbox('backup-delete-missing-ledger-row');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const created = await backup({ target: box.workspace, action: 'create' });
    const preview = await backup({ target: box.workspace, action: 'delete', id: created.backupId });
    const ledgerPath = path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md');
    const ledger = await fsp.readFile(ledgerPath, 'utf8');
    await fsp.writeFile(
      ledgerPath,
      `${ledger.split('\n').filter((line) => !line.includes(`| ${created.backupId} |`)).join('\n')}`,
      { mode: 0o600 }
    );

    const result = await backup({
      target: box.workspace, action: 'delete', id: created.backupId,
      confirm: preview.confirmationRequired
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.artifactDeleted, true);
    assert.equal(result.ledgerWritten, false);
    assert.equal(result.ledgerReason, 'backup-id-not-found');
    assert.equal(result.nextAction, 'reconcile-backup-deletion-ledger');
    assert.deepEqual(result.warnings, [{
      code: 'BACKUP_DELETION_LEDGER_RECONCILIATION_REQUIRED', reason: 'backup-id-not-found'
    }]);
    await assert.rejects(fsp.access(created.backupPath), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('user-selected backup artifacts require an explicit path for verify/delete and preserve output-root mode', { skip: process.platform === 'win32' }, async () => {
  const box = await sandbox('backup-explicit-path');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const output = path.join(box.base, 'selected-backups');
    await fsp.mkdir(output, { mode: 0o751 });
    await fsp.chmod(output, 0o751);
    const created = await backup({ target: box.workspace, action: 'create', output });
    assert.equal((await fsp.stat(output)).mode & 0o777, 0o751);
    await assert.rejects(
      backup({ target: box.workspace, action: 'verify', id: created.backupId }),
      { code: 'BACKUP_PATH_REQUIRED' }
    );
    const verified = await backup({
      target: box.workspace, action: 'verify', id: created.backupId, backup: created.backupPath
    });
    assert.equal(verified.backupId, created.backupId);
  } finally {
    await box.cleanup();
  }
});
