'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  ensurePrivateDir,
  atomicWriteFile,
  copyTree,
  makeSiblingTemp,
  createPrivateStage,
  hardenTree,
  verifyDarwinNoAcl,
  assertPrivateRegularFilePermissions
} = require('../../cli/lib/fs-safe');
const { createMemoryExport } = require('../../cli/memory-data');
const { install, update } = require('../../cli/operations');
const { sandbox, incomingDistribution } = require('./helpers');

async function mode(filename) {
  return (await fsp.stat(filename)).mode & 0o777;
}

test('private directory helpers never chmod an existing caller-owned parent', { skip: process.platform === 'win32' }, async () => {
  const box = await sandbox('parent-mode-helpers');
  try {
    const parent = path.join(box.base, 'caller-parent');
    await fsp.mkdir(parent, { mode: 0o751 });
    await fsp.chmod(parent, 0o751);

    const nested = path.join(parent, 'private', 'nested');
    await ensurePrivateDir(nested);
    assert.equal(await mode(parent), 0o751);
    assert.equal(await mode(path.join(parent, 'private')), 0o700);
    assert.equal(await mode(nested), 0o700);

    await atomicWriteFile(path.join(parent, 'private', 'value.txt'), 'private\n');
    assert.equal(await mode(parent), 0o751);

    const stage = await makeSiblingTemp(path.join(parent, 'workspace'), 'mode-test');
    assert.equal(await mode(parent), 0o751);
    assert.equal(await mode(stage), 0o700);
    await fsp.rm(stage, { recursive: true, force: true });
  } finally {
    await box.cleanup();
  }
});

test('install and update preserve the existing workspace parent mode', { skip: process.platform === 'win32' }, async () => {
  const box = await sandbox('parent-mode-install-update');
  try {
    await fsp.chmod(box.base, 0o751);
    await install({ target: box.workspace, consent: 'granted' });
    assert.equal(await mode(box.base), 0o751);
    const incoming = await incomingDistribution(box.base, '1.0.1', async ({ source }) => {
      await fsp.appendFile(path.join(source, 'commands.md'), '\nparent mode update\n');
    });
    await update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1' });
    assert.equal(await mode(box.base), 0o751);
  } finally {
    await box.cleanup();
  }
});

test('copy and export preserve existing destination-root permissions', { skip: process.platform === 'win32' }, async () => {
  const box = await sandbox('parent-mode-copy-export');
  try {
    const source = path.join(box.base, 'source');
    const destination = path.join(box.base, 'destination');
    const exportRoot = path.join(box.base, 'exports');
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, 'profile.md'), 'private profile\n');
    await fsp.mkdir(destination, { mode: 0o755 });
    await fsp.mkdir(exportRoot, { mode: 0o751 });
    await fsp.chmod(destination, 0o755);
    await fsp.chmod(exportRoot, 0o751);

    await copyTree(source, destination);
    assert.equal(await mode(destination), 0o755);

    const result = await createMemoryExport(source, { scope: 'active', output: exportRoot });
    assert.equal(result.status, 'created');
    assert.equal(await mode(exportRoot), 0o751);
    assert.equal(await mode(result.exportPath), 0o700);
  } finally {
    await box.cleanup();
  }
});

test('memory export aborts instead of finalizing a mixed-time payload when its source changes after snapshot', async () => {
  const box = await sandbox('memory-export-source-race');
  try {
    const source = path.join(box.base, 'source');
    const output = path.join(box.base, 'exports');
    const profile = path.join(source, 'profile.md');
    await fsp.mkdir(source);
    await fsp.mkdir(output);
    await fsp.writeFile(profile, 'before\n');
    let injected = false;
    const options = { scope: 'active', output };
    Object.defineProperty(options, 'dryRun', {
      enumerable: true,
      get() {
        if (!injected) {
          injected = true;
          require('node:fs').appendFileSync(profile, 'concurrent export write\n');
        }
        return false;
      }
    });

    await assert.rejects(createMemoryExport(source, options), { code: 'STALE_WORKSPACE' });
    assert.match(await fsp.readFile(profile, 'utf8'), /concurrent export write/);
    assert.deepEqual(await fsp.readdir(output), []);
  } finally {
    await box.cleanup();
  }
});

test('memory export reports a retained sensitive artifact when post-rename finalization fails', async () => {
  const box = await sandbox('memory-export-post-rename-failure');
  try {
    const source = path.join(box.base, 'source');
    const output = path.join(box.base, 'exports');
    await fsp.mkdir(source);
    await fsp.mkdir(output);
    await fsp.writeFile(path.join(source, 'profile.md'), 'private profile\n');
    process.env.SCALVIN_TEST_MEMORY_EXPORT_FAILPOINT = 'after-rename';
    await assert.rejects(createMemoryExport(source, { scope: 'active', output }), (error) => {
      assert.equal(error.code, 'TEST_FAILPOINT');
      assert.equal(error.details.status, 'partial');
      assert.equal(error.details.exportCreated, true);
      assert.equal(error.details.nextAction, 'secure-or-remove-memory-export');
      return true;
    });
    const retained = await fsp.readdir(output);
    assert.equal(retained.length, 1);
    await fsp.access(path.join(output, retained[0], 'integrity.json'));
  } finally {
    delete process.env.SCALVIN_TEST_MEMORY_EXPORT_FAILPOINT;
    await box.cleanup();
  }
});

test('macOS inherited ACL grants are stripped before sensitive writes and rejected on private inputs', { skip: process.platform !== 'darwin' }, async () => {
  const box = await sandbox('darwin-private-acl');
  try {
    const parent = path.join(box.base, 'acl-parent');
    await fsp.mkdir(parent);
    execFileSync('/bin/chmod', ['+a', 'everyone allow list,search,file_inherit,directory_inherit', parent]);

    const stage = path.join(parent, 'private-stage');
    await createPrivateStage(stage);
    assert.deepEqual(await verifyDarwinNoAcl(stage), { ok: true });
    const privateFile = path.join(stage, 'private.txt');
    await fsp.writeFile(privateFile, 'private\n', { mode: 0o600 });
    execFileSync('/bin/chmod', ['+a', 'everyone allow read', privateFile]);
    assert.deepEqual(await verifyDarwinNoAcl(stage, { recursive: true }), { ok: false });
    await hardenTree(stage);
    assert.deepEqual(await verifyDarwinNoAcl(stage, { recursive: true }), { ok: true });

    const exposedSecret = path.join(parent, 'secret.txt');
    await fsp.writeFile(exposedSecret, 'synthetic-secret\n', { mode: 0o600 });
    execFileSync('/bin/chmod', ['+a', 'everyone allow read', exposedSecret]);
    await assert.rejects(assertPrivateRegularFilePermissions(exposedSecret, null, {
      code: 'TEST_PRIVATE_FILE_PERMISSIONS', message: 'Synthetic private file is exposed.'
    }), { code: 'TEST_PRIVATE_FILE_PERMISSIONS' });

    const source = path.join(box.base, 'source');
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, 'profile.md'), 'private profile\n');
    const exported = await createMemoryExport(source, { scope: 'active', output: parent });
    assert.deepEqual(await verifyDarwinNoAcl(exported.exportPath, { recursive: true }), { ok: true });
  } finally {
    await box.cleanup();
  }
});
