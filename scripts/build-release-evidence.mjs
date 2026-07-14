#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyEvidence } = require('../cli/verify-release-evidence');
const { sha256 } = require('../cli/evaluate-captured-responses');
const {
  createPrivateExclusiveFile,
  ensurePrivateDir,
  preparePrivateDirectory
} = require('../cli/lib/fs-safe');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { capture: [] };
  const singleton = new Set([
    'review',
    'signature',
    'public-key',
    'output',
    'expected-commit',
    'expected-version',
    'reviewer-key-sha256'
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') return { help: true };
    if (!token.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail('Invalid arguments.');
    const name = token.slice(2);
    if (name === 'capture') options.capture.push(argv[index + 1]);
    else if (singleton.has(name) && options[name] === undefined) options[name] = argv[index + 1];
    else fail('Unknown or duplicate arguments are not allowed.');
    index += 1;
  }
  if ([...singleton].some((name) => options[name] === undefined) || options.capture.length === 0 || options.capture.length > 64) {
    fail('Review, signature, public key, output, expected commit, expected version, reviewer key SHA-256, and one or more captures are required.');
  }
  return options;
}

async function readRegular(filePath, maxBytes) {
  const before = await fsp.lstat(filePath).catch(() => fail('An input file cannot be read.'));
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) fail('An input must be a bounded regular non-symlink file.');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const handle = await fsp.open(filePath, flags).catch(() => fail('An input file cannot be opened safely.'));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || opened.size > maxBytes) {
      fail('An input changed while it was being opened.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > maxBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('An input changed while it was being read.');
    }
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function prepareEvidenceOutput(filePath) {
  const directory = path.dirname(path.resolve(filePath));
  try {
    const prepared = await ensurePrivateDir(directory);
    if (prepared.created) await preparePrivateDirectory(directory);
  } catch {
    fail('A private evidence output directory could not be prepared.');
  }
}

async function removeIfSameFile(filePath, identity) {
  try {
    const named = await fsp.lstat(filePath);
    if (!named.isSymbolicLink() && named.dev === identity.dev && named.ino === identity.ino) {
      await fsp.rm(filePath, { force: true });
    }
  } catch {}
}

async function writePrivateEvidence(filePath, bytes) {
  let handle;
  let identity;
  try {
    handle = await createPrivateExclusiveFile(filePath);
    identity = await handle.stat();
    await handle.writeFile(bytes);
    await handle.sync();
    const after = await handle.stat();
    if (after.dev !== identity.dev || after.ino !== identity.ino || after.nlink !== 1) {
      fail('The private release-evidence output changed while it was being written.');
    }
    await handle.close();
    handle = undefined;
    return identity;
  } catch {
    await handle?.close().catch(() => {});
    if (identity) await removeIfSameFile(filePath, identity);
    fail('The private release-evidence output could not be created.');
  }
}

function parseCapture(bytes) {
  const text = bytes.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    let records;
    try {
      records = text.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line));
    } catch {
      fail('A capture is neither valid JSON nor JSONL.');
    }
    if (records.length < 2) fail('A capture is neither valid JSON nor JSONL.');
    const metadata = records[0];
    return {
      schemaVersion: metadata.schemaVersion,
      corpus: metadata.corpus,
      candidate: metadata.candidate,
      responses: records.slice(1).map((record) => ({
        caseId: record.caseId,
        locale: record.locale,
        promptSha256: record.promptSha256,
        response: record.response
      }))
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/build-release-evidence.mjs --review review.json --signature review.sig --public-key reviewer-public.pem --capture capture.json [--capture capture.jsonl ...] --output release-evidence.json.gz --expected-commit <full-hash> --expected-version <semver> --reviewer-key-sha256 <sha256>\n');
    return;
  }
  let review;
  try {
    review = JSON.parse((await readRegular(options.review, 1024 * 1024)).toString('utf8'));
  } catch {
    fail('The review must be valid bounded JSON.');
  }
  const signatureText = (await readRegular(options.signature, 4096)).toString('utf8').trim();
  const publicKeyText = (await readRegular(options['public-key'], 64 * 1024)).toString('utf8');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText)) fail('The signature must be base64 text.');
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyText);
  } catch {
    fail('The reviewer public key is invalid.');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('The reviewer public key must be Ed25519.');
  const fingerprint = sha256(publicKey.export({ type: 'spki', format: 'der' }));
  const captures = [];
  for (const capturePath of options.capture) {
    captures.push(parseCapture(await readRegular(capturePath, 8 * 1024 * 1024)));
  }
  const envelope = {
    schemaVersion: 1,
    artifactType: 'scalvin-stable-release-evidence',
    review,
    reviewSignature: signatureText,
    reviewerPublicKey: publicKeyText,
    captures
  };
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'), { level: 9 });
  await prepareEvidenceOutput(options.output);
  const outputIdentity = await writePrivateEvidence(options.output, compressed);
  try {
    const result = await verifyEvidence(options.output, {
      commit: options['expected-commit'],
      version: options['expected-version'],
      reviewerKeySha256: options['reviewer-key-sha256']
    });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: 'built-and-verified',
      evidenceSha256: sha256(compressed),
      reviewerKeySha256: result.review.reviewerKeySha256,
      candidate: result.candidate,
      captureTupleCount: result.review.captureTupleCount
    })}\n`);
  } catch (error) {
    await removeIfSameFile(options.output, outputIdentity);
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
