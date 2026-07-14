#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PRIVATE_FILE_MODE,
  createPrivateStage
} = require('../cli/lib/fs-safe');

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const CHUNK_CHARS = 40_000;
const MAX_CHUNKS = 8;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') return { help: true };
    if (!['--input', '--output-directory'].includes(token) || index + 1 >= argv.length ||
        argv[index + 1].startsWith('--') || options[token] !== undefined) fail('Invalid arguments.');
    options[token] = argv[index + 1];
    index += 1;
  }
  if (!options['--input'] || !options['--output-directory']) fail('Input and output directory are required.');
  return { input: options['--input'], outputDirectory: options['--output-directory'] };
}

async function readRegular(filePath) {
  const before = await fsp.lstat(filePath).catch(() => fail('The evidence file cannot be read.'));
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_INPUT_BYTES) {
    fail('The evidence input must be a bounded regular non-symlink file.');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const handle = await fsp.open(filePath, flags).catch(() => fail('The evidence file cannot be opened safely.'));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_INPUT_BYTES) {
      fail('The evidence file changed while it was being opened.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > MAX_INPUT_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('The evidence file changed while it was being read.');
    }
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/encode-release-evidence-secret-chunks.mjs --input release-evidence.json.gz --output-directory secret-chunks\n');
    return;
  }
  const bytes = await readRegular(options.input);
  const encoded = bytes.toString('base64');
  const chunks = [];
  for (let offset = 0; offset < encoded.length; offset += CHUNK_CHARS) {
    chunks.push(encoded.slice(offset, offset + CHUNK_CHARS));
  }
  if (chunks.length === 0 || chunks.length > MAX_CHUNKS) {
    fail('The compressed evidence exceeds the eight-chunk stable-release secret capacity.');
  }
  try {
    await createPrivateStage(options.outputDirectory);
  } catch {
    fail('A new private secret-chunk directory could not be prepared.');
  }
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const name = `SCALVIN_RELEASE_EVIDENCE_B64_${String(index + 1).padStart(2, '0')}.txt`;
      await fsp.writeFile(path.join(options.outputDirectory, name), chunks[index], { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    }
  } catch {
    fail('The release-evidence secret chunks could not be written safely; the private partial output directory was retained for manual inspection and cleanup.');
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'encoded',
    evidenceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    chunkCount: chunks.length,
    secretNames: chunks.map((_, index) => `SCALVIN_RELEASE_EVIDENCE_B64_${String(index + 1).padStart(2, '0')}`)
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
