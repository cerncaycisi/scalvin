'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { assertSafeWorkspaceTarget, assertSafeBackupOutput, install, update, restore, backup } = require('../../cli/operations');
const { ROOT, sandbox } = require('./helpers');

test('workspace target guard rejects roots, home, source, and source ancestors', () => {
  const original = process.env.SCALVIN_ALLOW_REPO_TARGET;
  delete process.env.SCALVIN_ALLOW_REPO_TARGET;
  try {
    assert.throws(() => assertSafeWorkspaceTarget(path.parse(process.cwd()).root), { code: 'UNSAFE_WORKSPACE_TARGET' });
    assert.throws(() => assertSafeWorkspaceTarget(os.homedir()), { code: 'UNSAFE_WORKSPACE_TARGET' });
    assert.throws(() => assertSafeWorkspaceTarget(process.cwd()), { code: 'WORKSPACE_SOURCE_OVERLAP' });
    assert.throws(() => assertSafeWorkspaceTarget(path.dirname(process.cwd())), { code: 'WORKSPACE_SOURCE_OVERLAP' });
    assert.throws(() => assertSafeBackupOutput(path.join(process.cwd(), 'private-backup')), { code: 'BACKUP_INSIDE_SOURCE_REPO' });
  } finally {
    if (original === undefined) delete process.env.SCALVIN_ALLOW_REPO_TARGET;
    else process.env.SCALVIN_ALLOW_REPO_TARGET = original;
  }
});

test('update rejects an arbitrary nonempty directory without state', async () => {
  const box = await sandbox('update-arbitrary');
  try {
    await fsp.mkdir(box.workspace);
    await fsp.writeFile(path.join(box.workspace, 'file'), 'not scalvin');
    const manifest = await fsp.readFile(path.join(ROOT, 'manifest.json'));
    const manifestSha256 = crypto.createHash('sha256').update(manifest).digest('hex');
    await assert.rejects(update({ workspace: box.workspace, release: '1.0.0', 'manifest-sha256': manifestSha256 }), { code: 'WORKSPACE_STATE_MISSING' });
  } finally {
    await box.cleanup();
  }
});

test('forced restore refuses to replace an arbitrary nonempty directory', async () => {
  const box = await sandbox('restore-arbitrary');
  try {
    const source = path.join(box.base, 'source');
    await install({ workspace: source, consent: 'granted' });
    const made = await backup({ workspace: source, output: path.join(box.base, 'backups') });
    await fsp.mkdir(box.workspace);
    await fsp.writeFile(path.join(box.workspace, 'file'), 'arbitrary');
    await assert.rejects(restore({ workspace: box.workspace, backup: made.backupPath, force: true }), { code: 'RESTORE_TARGET_NOT_SCALVIN' });
    assert.equal(await fsp.readFile(path.join(box.workspace, 'file'), 'utf8'), 'arbitrary');
  } finally {
    await box.cleanup();
  }
});
