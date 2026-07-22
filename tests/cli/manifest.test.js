'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { loadManifest, verifyDistribution, validateManifest } = require('../../cli/lib/manifest');
const { ROOT } = require('./helpers');

test('manifest v2 is the hash-verified generated-workspace managed asset registry', async () => {
  const loaded = await loadManifest(path.join(ROOT, 'manifest.json'));
  assert.equal(loaded.manifest.schemaVersion, 2);
  assert.equal(loaded.manifest.defaults.companionName, 'Susan');
  assert.equal(loaded.manifest.defaults.persona, 'susan');
  assert.deepEqual(loaded.manifest.defaults.modalities, ['act', 'cft', 'motivational-interviewing']);
  assert.equal((await verifyDistribution(loaded.manifest, ROOT)).length, 0);
  for (const required of [
    'runtime/DATA-AND-CONSENT.md', 'runtime/MEMORY-PROVENANCE.md',
    'runtime/SESSION-LIFECYCLE.md', 'runtime/SELF-MODIFICATION.md',
    'runtime/CONTEXT-GRAPH.md', 'hooks/safety-net.cjs', 'hooks/current-time.cjs',
    'hooks/emergency-resources.cjs', 'hooks/emergency-resources.json',
    'templates/state/DATA-CONTROLS.template.md', 'templates/workspace/gitignore.template',
    'hooks/safety-locales/en.json', 'hooks/safety-locales/tr.json',
    'bin/scalvin-mcp.js', 'cli/mcp-server.js', 'cli/operations.js', 'cli/lib/fs-safe.js'
  ]) assert.ok(loaded.manifest.files.some((entry) => entry.path === required), required);
  for (const entry of loaded.manifest.files.filter((item) => item.path.startsWith('bin/') || item.path.startsWith('cli/'))) {
    assert.equal(entry.role, 'distribution-code');
    assert.equal(entry.protection, 'framework');
    assert.deepEqual(entry.targets, []);
  }
  const packageInventory = JSON.parse(await fsp.readFile(path.join(ROOT, 'package-inventory.json'), 'utf8'));
  const packagedRuntime = packageInventory.files.filter((entry) => entry.startsWith('bin/') || entry.startsWith('cli/'));
  assert.ok(packagedRuntime.length > 0);
  for (const relative of packagedRuntime) {
    assert.ok(loaded.manifest.files.some((entry) => entry.path === relative), `manifest missing packaged runtime: ${relative}`);
  }
  assert.ok(loaded.manifest.files.some((entry) => entry.path === 'personas/susan.md'));
  assert.equal(loaded.manifest.files.some((entry) => entry.path === 'personas/scalvin.md'), false);
  for (const locale of ['en', 'tr']) {
    const entry = loaded.manifest.files.find((item) => item.path === `hooks/safety-locales/${locale}.json`);
    assert.equal(entry.role, 'client-hook-data:safety-locale');
    assert.deepEqual(entry.targets.map((target) => target.path), [`.therapy/hooks/safety-locales/${locale}.json`]);
    assert.equal(loaded.manifest.clientIntegrations.claude.hooks.some((hook) => hook.target.endsWith(`${locale}.json`)), false);
  }
  for (const basename of ['emergency-resources.cjs', 'emergency-resources.json']) {
    const entry = loaded.manifest.files.find((item) => item.path === `hooks/${basename}`);
    assert.equal(entry.role, 'client-hook-data:emergency-resources');
    assert.deepEqual(entry.targets.map((target) => target.path), [`.therapy/hooks/${basename}`]);
    assert.equal(loaded.manifest.clientIntegrations.claude.hooks.some((hook) => hook.target.endsWith(basename)), false);
  }
  assert.equal(loaded.manifest.files.some((entry) => /\/test_[^/]+\.py$/.test(entry.path)), false);
});

test('every manifest-managed asset is pinned to LF checkout bytes', async () => {
  const loaded = await loadManifest(path.join(ROOT, 'manifest.json'));
  const managedPaths = loaded.manifest.files.map((entry) => entry.path);
  const result = spawnSync('git', ['check-attr', '-z', 'eol', '--', ...managedPaths], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);

  const fields = result.stdout.split('\0');
  const attributes = new Map();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [file, attribute, value] = fields.slice(index, index + 3);
    assert.equal(attribute, 'eol', `unexpected git attribute response for ${file}`);
    attributes.set(file.replaceAll('\\', '/'), value);
  }

  for (const managedPath of managedPaths) {
    assert.equal(
      attributes.get(managedPath),
      'lf',
      `${managedPath} must use text eol=lf so manifest hashes are checkout-platform invariant`
    );
  }
});

test('manifest validator rejects traversal, duplicate targets, and bad hashes', async () => {
  const loaded = await loadManifest(path.join(ROOT, 'manifest.json'));
  const traversal = structuredClone(loaded.manifest);
  traversal.files[0].path = '../escape';
  assert.throws(() => validateManifest(traversal), { code: 'PATH_TRAVERSAL' });
  const hash = structuredClone(loaded.manifest);
  hash.files[0].sha256 = 'bad';
  assert.throws(() => validateManifest(hash), { code: 'INVALID_MANIFEST' });
  const workspaceEntries = loaded.manifest.files.filter((entry) => entry.targets.length > 0);
  const duplicate = structuredClone(loaded.manifest);
  const duplicateEntry = duplicate.files.find((entry) => entry.path === workspaceEntries[0].path);
  duplicateEntry.targets.push(structuredClone(duplicateEntry.targets[0]));
  assert.throws(() => validateManifest(duplicate), { code: 'INVALID_MANIFEST' });
  const sourceCaseCollision = structuredClone(loaded.manifest);
  sourceCaseCollision.files[1].path = sourceCaseCollision.files[0].path.toUpperCase();
  assert.throws(() => validateManifest(sourceCaseCollision), { code: 'INVALID_MANIFEST' });
  const targetCaseCollision = structuredClone(loaded.manifest);
  const firstTargetEntry = targetCaseCollision.files.find((entry) => entry.path === workspaceEntries[0].path);
  const secondTargetEntry = targetCaseCollision.files.find((entry) => entry.path === workspaceEntries[1].path);
  const firstTarget = firstTargetEntry.targets[0].path;
  secondTargetEntry.targets[0].path = firstTarget.toUpperCase();
  assert.throws(() => validateManifest(targetCaseCollision), { code: 'INVALID_MANIFEST' });

  const distributionWithTarget = structuredClone(loaded.manifest);
  const distributionEntry = distributionWithTarget.files.find((entry) => entry.role === 'distribution-code');
  distributionEntry.targets.push({ path: '.therapy/should-not-exist.js', protection: 'framework' });
  assert.throws(() => validateManifest(distributionWithTarget), { code: 'INVALID_MANIFEST' });

  const workspaceWithoutTarget = structuredClone(loaded.manifest);
  workspaceWithoutTarget.files.find((entry) => entry.role !== 'distribution-code').targets = [];
  assert.throws(() => validateManifest(workspaceWithoutTarget), { code: 'INVALID_MANIFEST' });
});

test('release metadata is non-self-referential and trust comes from exact manifest bytes', async () => {
  const loaded = await loadManifest(path.join(ROOT, 'manifest.json'));
  const development = structuredClone(loaded.manifest);
  development.release = { channel: 'development', version: development.product.version };
  assert.doesNotThrow(() => validateManifest(development));
  const stable = structuredClone(loaded.manifest);
  stable.release = { channel: 'stable', version: stable.product.version };
  assert.doesNotThrow(() => validateManifest(stable));
  const recursiveClaim = structuredClone(stable);
  recursiveClaim.release.commit = 'a'.repeat(40);
  assert.throws(() => validateManifest(recursiveClaim), { code: 'INVALID_MANIFEST' });
});
