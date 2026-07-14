'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadManifest, sanitizeRemoteLocator } = require('../../cli/lib/manifest');
const { sandbox, ROOT } = require('./helpers');

const SENTINEL = 'signed-query-token-MUST-NOT-LEAK';
const PRIVATE_USER = 'private-user';
const PRIVATE_PASSWORD = 'private-password';
const REMOTE = `https://${PRIVATE_USER}:${PRIVATE_PASSWORD}@example.invalid/releases/manifest.json?signature=${SENTINEL}#private-fragment`;

test('remote locator sanitizer exposes only origin and pathname', () => {
  assert.equal(sanitizeRemoteLocator(REMOTE), 'https://example.invalid/releases/manifest.json');
});

test('remote manifest fetch errors omit userinfo, query tokens, fragments, and transport messages', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error(`transport echoed ${REMOTE}`); };
  try {
    await assert.rejects(loadManifest(REMOTE), (error) => {
      const exposed = JSON.stringify({ message: error.message, details: error.details });
      assert.equal(error.code, 'MANIFEST_FETCH_FAILED');
      assert.equal(error.details.url, 'https://example.invalid/releases/manifest.json');
      for (const secret of [SENTINEL, PRIVATE_USER, PRIVATE_PASSWORD, 'private-fragment']) assert.equal(exposed.includes(secret), false);
      return true;
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('CLI JSON stderr never echoes a signed remote manifest URL token', async () => {
  const box = await sandbox('manifest-url-stderr');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    await fsp.writeFile(path.join(box.workspace, 'marker.txt'), 'non-empty\n');
    const script = [
      `global.fetch = async () => { throw new Error(${JSON.stringify(`transport echoed ${REMOTE}`)}); };`,
      `const { main } = require(${JSON.stringify(path.join(ROOT, 'cli', 'index.js'))});`,
      '(async () => { await main(process.argv.slice(1)); })();'
    ].join('\n');
    const result = spawnSync(process.execPath, [
      '-e', script,
      'update', '--workspace', box.workspace,
      '--manifest', REMOTE,
      '--manifest-sha256', 'a'.repeat(64),
      '--json'
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stderr.trim());
    assert.equal(output.code, 'MANIFEST_FETCH_FAILED');
    assert.equal(output.details.url, 'https://example.invalid/releases/manifest.json');
    const exposed = `${result.stdout}\n${result.stderr}`;
    for (const secret of [SENTINEL, PRIVATE_USER, PRIVATE_PASSWORD, 'private-fragment']) assert.equal(exposed.includes(secret), false);
  } finally {
    await box.cleanup();
  }
});
