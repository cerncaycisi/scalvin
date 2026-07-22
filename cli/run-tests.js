#!/usr/bin/env node
// <!-- version: 1.5.0 -->
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'all';

async function discover(directory) {
  const root = path.join(ROOT, directory);
  const output = [];
  async function visit(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (/\.test\.(?:js|cjs|mjs)$/.test(entry.name)) output.push(absolute);
    }
  }
  await visit(root);
  return output;
}

async function main() {
  let files;
  if (mode === 'cli') files = await discover('tests/cli');
  else if (mode === 'safety') files = await discover('tests/safety');
  else if (mode === 'evals') files = await discover('tests/evals');
  else if (mode === 'all') files = await discover('tests');
  else throw new Error(`unknown test group: ${mode}`);
  if (!files.length) throw new Error(`no tests found for group: ${mode}`);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SCALVIN_TEST_ROOT: path.join(ROOT, '.test-tmp') }
  });
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
