'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, backup, restore } = require('../../cli/operations');
const { createBackup, verifyBackup, readBackupLedgerStatus } = require('../../cli/lib/backup');
const { knownBackupCount } = require('../../cli/memory-data');
const { applyWindowsPrivateAcl } = require('../../cli/lib/fs-safe');
const { sandbox } = require('./helpers');

async function writePrivateFile(filename, data) {
  await fsp.writeFile(filename, data, { mode: 0o600 });
  if (process.platform !== 'win32') await fsp.chmod(filename, 0o600);
  else await applyWindowsPrivateAcl(filename);
  return filename;
}

test('backup is unique, complete, checksummed, and restorable', async () => {
  const box = await sandbox('backup');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await fsp.writeFile(path.join(box.workspace, 'private-note.txt'), 'synthetic private fixture');
    const first = await backup({ target: box.workspace, output: path.join(box.base, 'backups') });
    const second = await backup({ target: box.workspace, output: path.join(box.base, 'backups') });
    assert.equal(first.encrypted, true);
    assert.equal(first.recoveryKeyCreated, true);
    assert.notEqual(first.recoveryKeyPath, second.recoveryKeyPath);
    await fsp.access(first.recoveryKeyPath);
    assert.notEqual(first.backupPath, second.backupPath);
    assert.match(path.basename(first.backupPath), /^scalvin-backup-\d{4}-\d{2}-\d{2}-\d{6}--[0-9a-f-]{36}\.scalvin-backup$/);
    await verifyBackup(first.backupPath, { passphraseFile: first.recoveryKeyPath });
    const restored = path.join(box.base, 'restored');
    const dry = await restore({ backup: first.backupPath, target: restored, 'passphrase-file': first.recoveryKeyPath, 'dry-run': true });
    assert.equal(dry.status, 'dry-run');
    await assert.rejects(fsp.access(restored));
    const result = await restore({ backup: first.backupPath, target: restored, 'passphrase-file': first.recoveryKeyPath });
    assert.equal(result.status, 'restored');
    assert.equal(result.incomingBackupLedgerWritten, true);
    assert.equal(result.operationReceiptWritten, true);
    const restoredLedger = await readBackupLedgerStatus(restored);
    assert.equal(restoredLedger.recordCount, 1);
    assert.equal(restoredLedger.latest.backupId, first.backupId);
    assert.equal(restoredLedger.operationReceiptCount, 1);
    assert.equal(await knownBackupCount(restored), 1);
    assert.equal(await fsp.readFile(path.join(restored, 'private-note.txt'), 'utf8'), 'synthetic private fixture');
  } finally {
    await box.cleanup();
  }
});

test('restore binds an initially missing target and preserves content created during verification', async () => {
  const box = await sandbox('restore-missing-target-race');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const made = await backup({ target: box.workspace, output: path.join(box.base, 'backups'), 'allow-plaintext-backup': true });
    const target = path.join(box.base, 'concurrent-restore-target');
    const concurrent = path.join(target, '.therapy', 'persona.md');
    let injected = false;
    const options = { backup: made.backupPath, target };
    Object.defineProperty(options, 'passphrase-file', {
      enumerable: true,
      get() {
        if (!injected) {
          injected = true;
          require('node:fs').mkdirSync(path.dirname(concurrent), { recursive: true, mode: 0o700 });
          require('node:fs').writeFileSync(concurrent, 'concurrent restore content\n', { mode: 0o600 });
        }
        return undefined;
      }
    });

    await assert.rejects(restore(options), { code: 'STALE_WORKSPACE' });
    assert.equal(await fsp.readFile(concurrent, 'utf8'), 'concurrent restore content\n');
    await assert.rejects(fsp.access(path.join(target, 'profile.md')), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('restore returns post-activation partial truth when its success receipt cannot be finalized', async () => {
  const box = await sandbox('restore-post-activation-receipt');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const made = await backup({ target: box.workspace, output: path.join(box.base, 'backups'), 'allow-plaintext-backup': true });
    const target = path.join(box.base, 'restored-with-receipt-gap');
    process.env.SCALVIN_TEST_FAILPOINT = 'restore-after-activate';
    const result = await restore({ backup: made.backupPath, target });
    assert.equal(result.status, 'partial');
    assert.equal(result.restoreApplied, true);
    assert.equal(result.operationReceiptWritten, false);
    assert.equal(result.nextAction, 'reconcile-restore-operation-receipt');
    assert.deepEqual(result.warnings, [{ code: 'RESTORE_RECEIPT_RECONCILIATION_REQUIRED', errorCode: 'TEST_FAILPOINT' }]);
    await fsp.access(path.join(target, 'profile.md'));
  } finally {
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await box.cleanup();
  }
});

test('backup aborts instead of finalizing a mixed-time payload when its source changes after snapshot', async () => {
  const box = await sandbox('backup-source-race');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const concurrentPath = path.join(box.workspace, 'profile.md');
    const output = path.join(box.base, 'raced-backups');
    let injected = false;
    const options = { output };
    Object.defineProperty(options, 'encrypt', {
      enumerable: true,
      get() {
        if (!injected) {
          injected = true;
          require('node:fs').appendFileSync(concurrentPath, '\nconcurrent backup write\n');
        }
        return false;
      }
    });

    await assert.rejects(createBackup(box.workspace, options), { code: 'STALE_WORKSPACE' });
    assert.match(await fsp.readFile(concurrentPath, 'utf8'), /concurrent backup write/);
    assert.deepEqual(await fsp.readdir(output), []);
  } finally {
    await box.cleanup();
  }
});

test('tampering, undeclared extras, and symlinks fail restore verification', async () => {
  const box = await sandbox('backup-tamper');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const made = await backup({ target: box.workspace, output: path.join(box.base, 'backups'), 'allow-plaintext-backup': true });
    await fsp.appendFile(path.join(made.backupPath, 'payload', 'profile.md'), 'tamper');
    await assert.rejects(verifyBackup(made.backupPath), { code: 'BACKUP_CONTENT_MISMATCH' });

    const clean = await backup({ target: box.workspace, output: path.join(box.base, 'backups'), 'allow-plaintext-backup': true });
    await fsp.writeFile(path.join(clean.backupPath, 'payload', 'undeclared.txt'), 'extra');
    await assert.rejects(verifyBackup(clean.backupPath), { code: 'BACKUP_CONTENT_MISMATCH' });

    const symlinked = await backup({ target: box.workspace, output: path.join(box.base, 'backups'), 'allow-plaintext-backup': true });
    await fsp.symlink('/tmp', path.join(symlinked.backupPath, 'payload', 'escape'));
    await assert.rejects(verifyBackup(symlinked.backupPath), { code: 'SYMLINK_REJECTED' });
  } finally {
    await box.cleanup();
  }
});

test('forced restore backs up displaced target and rollback failpoint preserves it', async () => {
  const box = await sandbox('restore-force');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const made = await backup({ target: box.workspace, output: path.join(box.base, 'backups'), 'allow-plaintext-backup': true });
    await fsp.writeFile(path.join(box.workspace, 'sentinel.txt'), 'new target');
    let preview = await restore({ backup: made.backupPath, target: box.workspace, force: true });
    assert.equal(preview.status, 'preview');
    assert.match(preview.confirmationRequired, /^restore-replace:[a-f0-9]{64}$/);
    await fsp.writeFile(path.join(box.workspace, 'sentinel.txt'), 'changed after preview');
    await assert.rejects(restore({
      backup: made.backupPath, target: box.workspace, force: true, confirm: preview.confirmationRequired
    }), { code: 'STALE_CONFIRMATION' });
    assert.equal(await fsp.readFile(path.join(box.workspace, 'sentinel.txt'), 'utf8'), 'changed after preview');
    preview = await restore({ backup: made.backupPath, target: box.workspace, force: true });
    process.env.SCALVIN_TEST_FAILPOINT = 'restore-before-activate';
    await assert.rejects(restore({
      backup: made.backupPath, target: box.workspace, force: true, confirm: preview.confirmationRequired
    }), { code: 'TEST_FAILPOINT' });
    assert.equal(await fsp.readFile(path.join(box.workspace, 'sentinel.txt'), 'utf8'), 'changed after preview');
    assert.equal((await readBackupLedgerStatus(box.workspace)).operationReceiptCount, 2);
    delete process.env.SCALVIN_TEST_FAILPOINT;
    preview = await restore({ backup: made.backupPath, target: box.workspace, force: true });
    const result = await restore({
      backup: made.backupPath, target: box.workspace, force: true, confirm: preview.confirmationRequired
    });
    assert.ok(result.displacedWorkspaceBackup);
    assert.ok(result.displacedWorkspaceRecoveryKeyPath);
    await fsp.access(result.displacedWorkspaceRecoveryKeyPath);
    const displacedOuter = JSON.parse(await fsp.readFile(path.join(result.displacedWorkspaceBackup, 'integrity.json'), 'utf8'));
    assert.equal(displacedOuter.formatVersion, 3);
    assert.deepEqual((await fsp.readdir(result.displacedWorkspaceBackup)).sort(), ['CHECKSUM.sha256', 'integrity.json', 'payload.enc']);
    const displaced = await verifyBackup(result.displacedWorkspaceBackup, { passphraseFile: result.displacedWorkspaceRecoveryKeyPath });
    await displaced.cleanup();
    assert.equal(result.incomingBackupLedgerWritten, true);
    assert.equal(result.displacedWorkspaceBackupLedgerWritten, true);
    assert.equal((await readBackupLedgerStatus(box.workspace, { backupId: made.backupId })).status, 'found');
    assert.equal((await readBackupLedgerStatus(box.workspace, { backupId: displacedOuter.backupId })).status, 'found');
    assert.equal(await knownBackupCount(box.workspace), 2);
    assert.equal(result.operationReceiptWritten, true);
    await assert.rejects(fsp.access(path.join(box.workspace, 'sentinel.txt')));
  } finally {
    await box.cleanup();
  }
});

test('forced encrypted restore rejects a target-contained passphrase before making a displaced backup', async () => {
  const box = await sandbox('restore-passphrase-inside-target');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const outsidePassphrase = path.join(box.base, 'outside-passphrase.txt');
    await writePrivateFile(outsidePassphrase, 'correct horse battery staple\n');
    const made = await backup({
      target: box.workspace, output: path.join(box.base, 'encrypted-backups'),
      encrypt: true, 'passphrase-file': outsidePassphrase
    });
    const insidePassphrase = path.join(box.workspace, 'private-passphrase.txt');
    await writePrivateFile(insidePassphrase, 'correct horse battery staple\n');
    const displaced = path.join(box.base, 'displaced-backups');
    await assert.rejects(restore({
      backup: made.backupPath, target: box.workspace, force: true,
      'passphrase-file': insidePassphrase, 'backup-output': displaced
    }), { code: 'PASSPHRASE_INSIDE_WORKSPACE' });
    await fsp.access(insidePassphrase);
    await assert.rejects(fsp.access(displaced), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('restore rejects an input artifact that overlaps the target workspace', async () => {
  const box = await sandbox('restore-artifact-overlap');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const made = await backup({
      target: box.workspace, output: path.join(box.base, 'outside-backups'), 'allow-plaintext-backup': true
    });
    const inside = path.join(box.workspace, 'nested-input.scalvin-backup');
    await fsp.rename(made.backupPath, inside);
    const profileBefore = await fsp.readFile(path.join(box.workspace, 'profile.md'));

    await assert.rejects(
      restore({ backup: inside, target: box.workspace, force: true }),
      { code: 'RESTORE_PATH_OVERLAP' }
    );
    await fsp.access(path.join(inside, 'integrity.json'));
    assert.deepEqual(await fsp.readFile(path.join(box.workspace, 'profile.md')), profileBefore);
  } finally {
    await box.cleanup();
  }
});

test('backup refuses recursive destination and plaintext requires an explicit override', async () => {
  const box = await sandbox('backup-guards');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await assert.rejects(backup({ target: box.workspace, output: path.join(box.workspace, 'backups') }), { code: 'INVALID_BACKUP_LOCATION' });
    await assert.rejects(createBackup(box.workspace, { encrypt: true }), { code: 'PASSPHRASE_REQUIRED' });
    const plain = await backup({ target: box.workspace, output: path.join(box.base, 'plain-backups'), 'allow-plaintext-backup': true });
    assert.equal(plain.encrypted, false);
  } finally {
    await box.cleanup();
  }
});
