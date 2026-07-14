#!/usr/bin/env node
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', '.audit', '.test-tmp', 'node_modules', '__pycache__']);

async function discover(directory, output = []) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    if (entry.name.startsWith('._') || SKIP.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await discover(absolute, output);
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

async function main() {
  const files = await discover(ROOT);
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
    if (result.status !== 0) failures.push({ file: path.relative(ROOT, file), error: result.stderr.trim() });
  }
  if (failures.length) {
    for (const failure of failures) process.stderr.write(`${failure.file}\n${failure.error}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`syntax verified: ${files.length} JavaScript files\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
