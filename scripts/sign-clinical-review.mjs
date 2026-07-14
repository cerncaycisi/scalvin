#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stableJson, sha256 } = require('../cli/evaluate-captured-responses');
const {
  assertPrivateRegularFilePermissions,
  createPrivateExclusiveFile,
  ensurePrivateDir,
  preparePrivateDirectory
} = require('../cli/lib/fs-safe');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  const names = new Set(['review', 'private-key', 'signature-output', 'public-key-output']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') return { help: true };
    if (!token.startsWith('--') || !names.has(token.slice(2)) ||
        index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail('Invalid arguments.');
    const name = token.slice(2);
    if (options[name] !== undefined) fail('Duplicate arguments are not allowed.');
    options[name] = argv[index + 1];
    index += 1;
  }
  if ([...names].some((name) => options[name] === undefined)) fail('All input and output arguments are required.');
  return options;
}

async function readRegular(filePath, maxBytes, privateMaterial = false) {
  const before = await fsp.lstat(filePath).catch(() => fail('An input file cannot be read.'));
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) fail('An input must be a bounded regular non-symlink file.');
  if (privateMaterial) await assertPrivateKey(filePath, before);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const handle = await fsp.open(filePath, flags).catch(() => fail('An input file cannot be opened safely.'));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || opened.size > maxBytes) {
      fail('An input changed while it was being opened.');
    }
    if (privateMaterial) await assertPrivateKey(filePath, opened);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > maxBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('An input changed while it was being read.');
    }
    if (privateMaterial) await assertPrivateKey(filePath, after);
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function assertPrivateKey(filePath, stat) {
  try {
    await assertPrivateRegularFilePermissions(filePath, stat, {
      code: 'REVIEWER_PRIVATE_KEY_PERMISSIONS',
      message: 'The reviewer private key permissions or access-control list are not private.'
    });
  } catch {
    fail('The reviewer private key permissions or access-control list are not private.');
  }
}

async function prepareOutputDirectories(filePaths) {
  const directories = [...new Set(filePaths.map((filePath) => path.dirname(path.resolve(filePath))))];
  try {
    for (const directory of directories) {
      const prepared = await ensurePrivateDir(directory);
      if (prepared.created) await preparePrivateDirectory(directory);
    }
  } catch {
    fail('A private signing output directory could not be prepared.');
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

async function writeSigningOutputs(outputs) {
  const opened = [];
  try {
    for (const output of outputs) {
      const handle = await createPrivateExclusiveFile(output.path);
      opened.push({ ...output, handle, identity: await handle.stat() });
    }
    for (const output of opened) {
      await output.handle.writeFile(output.value);
      await output.handle.sync();
      const after = await output.handle.stat();
      if (after.dev !== output.identity.dev || after.ino !== output.identity.ino || after.nlink !== 1) {
        fail('A signing output changed while it was being written.');
      }
    }
    for (const output of opened) {
      await output.handle.close();
      output.handle = null;
    }
  } catch {
    for (const output of opened) await output.handle?.close().catch(() => {});
    for (const output of opened) await removeIfSameFile(output.path, output.identity);
    fail('The signing outputs could not be created safely.');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/sign-clinical-review.mjs --review review.json --private-key reviewer-private.pem --signature-output review.sig --public-key-output reviewer-public.pem\n');
    return;
  }
  let review;
  try {
    review = JSON.parse((await readRegular(options.review, 1024 * 1024)).toString('utf8'));
  } catch {
    fail('The review must be valid bounded JSON.');
  }
  const privateBytes = await readRegular(options['private-key'], 64 * 1024, true);
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateBytes);
  } catch {
    fail('The reviewer private key is invalid.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('The reviewer private key must be Ed25519.');
  const publicKey = crypto.createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const canonical = Buffer.from(stableJson(review), 'utf8');
  const signature = crypto.sign(null, canonical, privateKey).toString('base64');
  await prepareOutputDirectories([options['signature-output'], options['public-key-output']]);
  await writeSigningOutputs([
    { path: options['signature-output'], value: `${signature}\n` },
    { path: options['public-key-output'], value: publicPem }
  ]);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'signed',
    reviewSha256: sha256(canonical),
    reviewerKeySha256: sha256(publicDer)
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
