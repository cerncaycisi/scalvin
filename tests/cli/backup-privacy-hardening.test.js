'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, backup } = require('../../cli/operations');
const { sandbox } = require('./helpers');

test('recovery-key creation writes a private file without returning secret material', async () => {
  const box = await sandbox('backup-recovery-key-create');
  try {
    const output = path.join(box.base, 'keys', 'portable-recovery.key');
    const dry = await backup({ action: 'key-create', output, 'dry-run': true });
    assert.equal(dry.status, 'dry-run');
    await assert.rejects(fsp.access(output), { code: 'ENOENT' });

    const result = await backup({ action: 'key-create', output });
    assert.deepEqual(Object.keys(result).sort(), ['nextAction', 'recoveryKeyPath', 'secretIncluded', 'status']);
    assert.equal(result.secretIncluded, false);
    assert.equal(JSON.stringify(result).includes('scalvin-recovery-key-v1:'), false);
    const stat = await fsp.lstat(output);
    assert.equal(stat.isFile(), true);
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    assert.match(await fsp.readFile(output, 'utf8'), /^scalvin-recovery-key-v1:[A-Za-z0-9_-]{43}\n$/);
    await assert.rejects(backup({ action: 'key-create', output }), { code: 'RECOVERY_KEY_EXISTS' });
  } finally {
    await box.cleanup();
  }
});

test('user backup defaults to encrypted v3, auto-locates its separate key, and requires explicit plaintext override', async () => {
  const box = await sandbox('backup-encrypted-default');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await fsp.writeFile(path.join(box.workspace, 'private-note.txt'), 'synthetic private content\n');

    const created = await backup({ target: box.workspace });
    assert.equal(created.encrypted, true);
    assert.equal(created.recoveryKeyCreated, true);
    assert.equal(created.secretIncluded, false);
    assert.equal(path.dirname(created.backupPath) === path.dirname(created.recoveryKeyPath), false);
    const outer = JSON.parse(await fsp.readFile(path.join(created.backupPath, 'integrity.json'), 'utf8'));
    assert.equal(outer.formatVersion, 3);
    assert.deepEqual((await fsp.readdir(created.backupPath)).sort(), ['CHECKSUM.sha256', 'integrity.json', 'payload.enc']);

    const verified = await backup({ target: box.workspace, action: 'verify', id: created.backupId });
    assert.equal(verified.status, 'verified');
    const preview = await backup({ target: box.workspace, action: 'delete', id: created.backupId });
    const deleted = await backup({ target: box.workspace, action: 'delete', id: created.backupId, confirm: preview.confirmationRequired });
    assert.equal(deleted.artifactDeleted, true);
    assert.equal(deleted.recoveryKeyDeleted, true);
    await assert.rejects(fsp.access(created.backupPath), { code: 'ENOENT' });
    await assert.rejects(fsp.access(created.recoveryKeyPath), { code: 'ENOENT' });

    const plain = await backup({ target: box.workspace, output: path.join(box.base, 'plain'), 'allow-plaintext-backup': true });
    assert.equal(plain.encrypted, false);
    await fsp.access(path.join(plain.backupPath, 'payload', 'private-note.txt'));
    await assert.rejects(
      backup({ target: box.workspace, 'allow-plaintext-backup': true, encrypt: true }),
      { code: 'INVALID_ARGUMENT' }
    );
  } finally {
    await box.cleanup();
    await fsp.rm(path.join(path.dirname(box.workspace), '.scalvin-backups'), { recursive: true, force: true });
    await fsp.rm(path.join(path.dirname(box.workspace), '.scalvin-recovery-keys'), { recursive: true, force: true });
  }
});
