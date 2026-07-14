#!/usr/bin/env node
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { npmPackReport } = require('../scripts/lib/npm-pack.cjs');

const ROOT = path.resolve(__dirname, '..');
const INVENTORY = path.join(ROOT, 'package-inventory.json');

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packagedFiles() {
  const report = npmPackReport({
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024
  });
  return report.files.map((entry) => entry.path).sort(compareCodePoint);
}

function canonicalInventory(files) {
  return `${JSON.stringify({
    schemaVersion: 1,
    purpose: 'canonical-npm-package-file-inventory',
    files
  }, null, 2)}\n`;
}

async function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check') || !write;
  if (process.argv.slice(2).some((argument) => !['--write', '--check'].includes(argument))) throw new Error('Usage: refresh-package-inventory.js [--write|--check]');
  const expected = canonicalInventory(packagedFiles());
  if (write) {
    const temporary = `${INVENTORY}.tmp-${process.pid}`;
    await fsp.writeFile(temporary, expected, { mode: 0o644, flag: 'wx' });
    await fsp.rename(temporary, INVENTORY);
    process.stdout.write('package inventory refreshed\n');
  }
  if (check) {
    const actual = await fsp.readFile(INVENTORY, 'utf8').catch(() => '');
    if (actual !== expected) {
      process.stderr.write('package-inventory.json is stale; run npm run inventory:refresh\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('package inventory verified\n');
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
