'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT } = require('./helpers');
const { npmInvocation, npmPackReport, PACK_ARGUMENTS } = require('../../scripts/lib/npm-pack.cjs');
const inventory = require('../../package-inventory.json');
const manifest = require('../../manifest.json');

const runtimeCliFiles = [
  'cli/change-control.js',
  'cli/context-graph.js',
  'cli/doctor.js',
  'cli/index.js',
  'cli/lib/args.js',
  'cli/lib/backup-crypto.js',
  'cli/lib/backup-reminder.js',
  'cli/lib/backup.js',
  'cli/lib/errors.js',
  'cli/lib/fs-safe.js',
  'cli/lib/manifest.js',
  'cli/lib/operation-journal.js',
  'cli/lib/source-provenance.js',
  'cli/lib/workspace.js',
  'cli/memory-data.js',
  'cli/memory-review.js',
  'cli/operations.js',
  'cli/review-due.js',
  'cli/session-lifecycle.js',
  'cli/source-inspect.js',
  'cli/source-lifecycle.js'
];

test('npm package allowlist contains the complete bootstrap and runtime surface only', () => {
  const report = npmPackReport({ cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
  const actualPaths = report.files.map((item) => item.path).sort();
  const files = new Set(actualPaths);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.purpose, 'canonical-npm-package-file-inventory');
  assert.deepEqual(actualPaths, [...inventory.files].sort());
  for (const required of [
    'AGENTS.md', 'CLAUDE.md', 'SETUP.md',
    'bin/scalvin.js', 'cli/index.js', 'manifest.json', 'package-inventory.json',
    'hooks/safety-net.cjs', 'hooks/safety-locales/en.json', 'hooks/safety-locales/tr.json',
    'schemas/manifest-v2.schema.json',
    ...runtimeCliFiles,
    ...manifest.files.map((entry) => entry.path)
  ]) assert.equal(files.has(required), true, required);
  for (const forbiddenPrefix of [
    '.scalvin/', '.therapy/', 'sessions/', 'sources/', 'archive/', '.test-tmp/',
    'evals/', 'scripts/'
  ]) {
    assert.equal([...files].some((filename) => filename.startsWith(forbiddenPrefix)), false, forbiddenPrefix);
  }
  for (const forbidden of [
    'SETUP-NOTES.md',
    'runtime/test_review_due_check.py',
    'cli/check-syntax.js',
    'cli/evaluate-captured-responses.js',
    'cli/refresh-manifest.js',
    'cli/refresh-package-inventory.js',
    'cli/run-tests.js',
    'cli/verify-release-evidence.js'
  ]) assert.equal(files.has(forbidden), false, forbidden);
  assert.equal(
    [...files].some((filename) => filename.split('/').includes('__pycache__') || /\.py[co]$/.test(filename)),
    false,
    'Python bytecode/cache artifacts'
  );
});

test('npm pack uses an executable entrypoint on Windows', () => {
  assert.deepEqual(
    npmInvocation({
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        npm_execpath: 'C:\\pnpm\\pnpm.cjs'
      }
    }),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json --ignore-scripts']
    }
  );

  assert.deepEqual(
    npmInvocation({ platform: 'linux', env: { npm_execpath: '/usr/local/bin/yarn.js' } }),
    { command: 'npm', args: [...PACK_ARGUMENTS] }
  );
});
