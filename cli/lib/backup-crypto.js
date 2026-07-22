'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { TextDecoder } = require('node:util');
const { ScalvinError, invariant } = require('./errors');
const {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  resolvePortablePath,
  assertInside,
  validateRelativePath,
  rejectSymlinkPath,
  assertPrivateRegularFilePermissions
} = require('./fs-safe');

const ARCHIVE_MAGIC = Buffer.from('SCALVIN-ARCHIVE-V2\n', 'ascii');
const ENVELOPE_VERSION = 3;
const PAYLOAD_FORMAT = 'scalvin-archive-v2';
const SCRYPT_PROFILES = Object.freeze({
  2: Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 }),
  3: Object.freeze({ N: 131072, r: 8, p: 1, keyLength: 32, maxmem: 256 * 1024 * 1024 })
});
const SCRYPT = SCRYPT_PROFILES[ENVELOPE_VERSION];
const LIMITS = Object.freeze({
  passphraseMinBytes: 12,
  passphraseMaxBytes: 4096,
  manifestMaxBytes: 16 * 1024 * 1024,
  headerMaxBytes: 64 * 1024,
  maxEntries: 100000,
  maxFileBytes: 8 * 1024 * 1024 * 1024,
  maxArchiveBytes: 16 * 1024 * 1024 * 1024
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKUP_ID_PATTERN = /^backup-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected, code = 'BACKUP_MANIFEST_INVALID') {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'Backup metadata must be an object.', code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), 'Backup metadata fields are missing or unknown.', code);
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function decodeUtf8(buffer, code, message) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ScalvinError(message, code);
  }
}

function decodeCanonicalBase64(value, length) {
  invariant(typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'Encrypted backup envelope encoding is invalid.', 'BACKUP_MANIFEST_INVALID');
  const decoded = Buffer.from(value, 'base64');
  invariant(decoded.length === length && decoded.toString('base64') === value, 'Encrypted backup envelope encoding is invalid.', 'BACKUP_MANIFEST_INVALID');
  return decoded;
}

async function openBoundedRegularFile(filename, options = {}) {
  const maxBytes = options.maxBytes;
  const minBytes = options.minBytes ?? 0;
  const code = options.code || 'BACKUP_FILE_INVALID';
  const message = options.message || 'Backup component must be a bounded regular non-symlink file.';
  invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 0, 'Internal backup byte limit is invalid.', 'BACKUP_LIMIT_INVALID');
  await rejectSymlinkPath(filename).catch((error) => {
    if (error instanceof ScalvinError && error.code === 'SYMLINK_REJECTED') throw new ScalvinError(message, code);
    throw error;
  });
  let before;
  try {
    before = await fsp.lstat(filename);
  } catch {
    throw new ScalvinError(message, code);
  }
  invariant(before.isFile() && before.size >= minBytes && before.size <= maxBytes, message, code);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let handle;
  try {
    handle = await fsp.open(filename, flags);
    const opened = await handle.stat();
    invariant(opened.isFile() && opened.size >= minBytes && opened.size <= maxBytes, message, code);
    invariant(before.dev === opened.dev && before.ino === opened.ino, 'Backup component changed while it was opened.', 'BACKUP_FILE_CHANGED');
    return { handle, stat: opened };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof ScalvinError) throw error;
    throw new ScalvinError(message, code);
  }
}

async function assertFileUnchanged(handle, initialStat) {
  const finalStat = await handle.stat();
  invariant(finalStat.size === initialStat.size && finalStat.mtimeMs === initialStat.mtimeMs &&
    finalStat.dev === initialStat.dev && finalStat.ino === initialStat.ino,
  'Backup component changed while it was read.', 'BACKUP_FILE_CHANGED');
}

async function readBoundedRegularFile(filename, options = {}) {
  const opened = await openBoundedRegularFile(filename, options);
  try {
    const output = Buffer.alloc(opened.stat.size);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await opened.handle.read(output, offset, output.length - offset, offset);
      invariant(bytesRead > 0, 'Backup component ended unexpectedly.', options.code || 'BACKUP_FILE_INVALID');
      offset += bytesRead;
    }
    await assertFileUnchanged(opened.handle, opened.stat);
    return output;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function sha256BoundedRegularFile(filename, options = {}) {
  const opened = await openBoundedRegularFile(filename, options);
  const hash = crypto.createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < opened.stat.size) {
      const requested = Math.min(buffer.length, opened.stat.size - position);
      const { bytesRead } = await opened.handle.read(buffer, 0, requested, position);
      invariant(bytesRead > 0, 'Backup component ended unexpectedly.', options.code || 'BACKUP_FILE_INVALID');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    await assertFileUnchanged(opened.handle, opened.stat);
    return hash.digest('hex');
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function readPassphrase(options = {}) {
  if (!options.passphraseFile) {
    throw new ScalvinError('Encrypted backup or restore requires --passphrase-file.', 'PASSPHRASE_REQUIRED', undefined, 2);
  }
  const filename = resolvePortablePath(options.passphraseFile);
  const opened = await openBoundedRegularFile(filename, {
    minBytes: 1,
    maxBytes: LIMITS.passphraseMaxBytes + 2,
    code: 'PASSPHRASE_FILE_INVALID',
    message: 'Passphrase input must be a bounded regular non-symlink file.'
  });
  let raw;
  try {
    await assertPrivateRegularFilePermissions(filename, opened.stat, {
      code: 'PASSPHRASE_FILE_PERMISSIONS',
      message: 'Passphrase file permissions could not be verified as private.'
    });
    raw = Buffer.alloc(opened.stat.size);
    let offset = 0;
    while (offset < raw.length) {
      const { bytesRead } = await opened.handle.read(raw, offset, raw.length - offset, offset);
      invariant(bytesRead > 0, 'Passphrase file ended unexpectedly.', 'PASSPHRASE_FILE_INVALID');
      offset += bytesRead;
    }
    await assertFileUnchanged(opened.handle, opened.stat);
    let length = raw.length;
    if (length >= 2 && raw[length - 2] === 0x0d && raw[length - 1] === 0x0a) length -= 2;
    else if (length >= 1 && raw[length - 1] === 0x0a) length -= 1;
    const passphrase = Buffer.from(raw.subarray(0, length));
    raw.fill(0);
    if (passphrase.length < LIMITS.passphraseMinBytes || passphrase.length > LIMITS.passphraseMaxBytes) {
      passphrase.fill(0);
      throw new ScalvinError(
        `Passphrase must contain ${LIMITS.passphraseMinBytes} to ${LIMITS.passphraseMaxBytes} bytes.`,
        'PASSPHRASE_LENGTH_INVALID'
      );
    }
    return passphrase;
  } finally {
    raw?.fill(0);
    await opened.handle.close().catch(() => {});
  }
}

function deriveKey(passphrase, salt, profile) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, profile.keyLength, {
      N: profile.N,
      r: profile.r,
      p: profile.p,
      maxmem: profile.maxmem
    }, (error, key) => {
      if (error) reject(new ScalvinError('Backup key derivation failed.', 'BACKUP_KEY_DERIVATION_FAILED'));
      else resolve(key);
    });
  });
}

function archiveEntryHeader(entry) {
  return entry.type === 'file'
    ? { path: entry.path, type: 'file', mode: entry.mode, size: entry.size }
    : { path: entry.path, type: 'directory', mode: entry.mode };
}

function validatePayloadManifest(manifest) {
  exactKeys(manifest, ['format', 'formatVersion', 'backupId', 'createdAt', 'workspaceId', 'entries']);
  invariant(manifest.format === 'scalvin-backup-payload' && manifest.formatVersion === 1, 'Encrypted backup payload manifest version is unsupported.', 'BACKUP_FORMAT_UNSUPPORTED');
  invariant(BACKUP_ID_PATTERN.test(manifest.backupId || ''), 'Backup ID is invalid.', 'BACKUP_MANIFEST_INVALID');
  invariant(validTimestamp(manifest.createdAt), 'Backup timestamp is invalid.', 'BACKUP_MANIFEST_INVALID');
  invariant(manifest.workspaceId === null || UUID_PATTERN.test(manifest.workspaceId || ''), 'Backup workspace ID is invalid.', 'BACKUP_MANIFEST_INVALID');
  invariant(Array.isArray(manifest.entries) && manifest.entries.length <= LIMITS.maxEntries, 'Backup entry count exceeds the supported limit.', 'BACKUP_LIMIT_EXCEEDED');
  const paths = new Set();
  let totalFileBytes = 0;
  for (const entry of manifest.entries) {
    exactKeys(entry, entry?.type === 'file' ? ['path', 'type', 'mode', 'size', 'sha256'] : ['path', 'type', 'mode']);
    const relative = validateRelativePath(entry.path);
    invariant(relative === entry.path.replaceAll('\\', '/') && !paths.has(relative), 'Backup entry path is invalid or duplicated.', 'BACKUP_MANIFEST_INVALID');
    paths.add(relative);
    invariant(entry.type === 'file' || entry.type === 'directory', 'Backup entry type is invalid.', 'BACKUP_MANIFEST_INVALID');
    if (entry.type === 'directory') {
      invariant(entry.mode === PRIVATE_DIR_MODE, 'Backup directory mode is invalid.', 'BACKUP_MANIFEST_INVALID');
    } else {
      invariant(entry.mode === PRIVATE_FILE_MODE && Number.isSafeInteger(entry.size) && entry.size >= 0 &&
        entry.size <= LIMITS.maxFileBytes && /^[a-f0-9]{64}$/.test(entry.sha256),
      'Backup file metadata is invalid.', 'BACKUP_MANIFEST_INVALID');
      totalFileBytes += entry.size;
      invariant(Number.isSafeInteger(totalFileBytes) && totalFileBytes <= LIMITS.maxArchiveBytes, 'Backup payload exceeds the supported byte limit.', 'BACKUP_LIMIT_EXCEEDED');
    }
    const parent = path.posix.dirname(relative);
    if (parent !== '.') invariant(paths.has(parent), 'Backup entries must declare parent directories before children.', 'BACKUP_MANIFEST_INVALID');
  }
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
  invariant(manifestBytes <= LIMITS.manifestMaxBytes, 'Backup payload manifest exceeds the supported byte limit.', 'BACKUP_LIMIT_EXCEEDED');
  let archiveBytes = ARCHIVE_MAGIC.length + 4 + manifestBytes + 4;
  for (const entry of manifest.entries) {
    archiveBytes += 4 + Buffer.byteLength(JSON.stringify(archiveEntryHeader(entry))) + (entry.type === 'file' ? entry.size : 0);
    invariant(Number.isSafeInteger(archiveBytes) && archiveBytes <= LIMITS.maxArchiveBytes, 'Backup archive exceeds the supported byte limit.', 'BACKUP_LIMIT_EXCEEDED');
  }
  return { manifest, archiveBytes, totalFileBytes };
}

function validateEncryptedIntegrity(integrity, options = {}) {
  exactKeys(integrity, ['format', 'formatVersion', 'backupId', 'createdAt', 'encryption']);
  invariant(integrity.format === 'scalvin-backup' && [2, 3].includes(integrity.formatVersion), 'Encrypted backup format is unsupported.', 'BACKUP_FORMAT_UNSUPPORTED');
  invariant(BACKUP_ID_PATTERN.test(integrity.backupId || ''), 'Backup ID is invalid.', 'BACKUP_MANIFEST_INVALID');
  invariant(validTimestamp(integrity.createdAt), 'Backup timestamp is invalid.', 'BACKUP_MANIFEST_INVALID');
  const envelope = integrity.encryption;
  exactKeys(envelope, ['envelopeVersion', 'payloadFormat', 'algorithm', 'kdf', 'N', 'r', 'p', 'salt', 'nonce', 'tag']);
  const profile = SCRYPT_PROFILES[integrity.formatVersion];
  invariant(envelope.envelopeVersion === integrity.formatVersion && envelope.payloadFormat === PAYLOAD_FORMAT &&
    envelope.algorithm === 'aes-256-gcm' && envelope.kdf === 'scrypt',
  'Encrypted backup envelope is unsupported.', 'BACKUP_FORMAT_UNSUPPORTED');
  invariant(envelope.N === profile.N && envelope.r === profile.r && envelope.p === profile.p,
    'Encrypted backup KDF parameters are unsupported.', 'BACKUP_FORMAT_UNSUPPORTED');
  const salt = decodeCanonicalBase64(envelope.salt, 16);
  const nonce = decodeCanonicalBase64(envelope.nonce, 12);
  let tag = null;
  if (options.allowNullTag && envelope.tag === null) tag = null;
  else tag = decodeCanonicalBase64(envelope.tag, 16);
  return { envelope, profile, salt, nonce, tag };
}

function aadForIntegrity(integrity) {
  validateEncryptedIntegrity(integrity, { allowNullTag: true });
  const encryption = { ...integrity.encryption };
  delete encryption.tag;
  return Buffer.from(canonicalJson({ ...integrity, encryption }));
}

function privateManifestFromIntegrity(integrity) {
  exactKeys(integrity, ['format', 'formatVersion', 'backupId', 'createdAt', 'workspaceId', 'encryption', 'entries']);
  invariant(integrity.format === 'scalvin-backup' && integrity.formatVersion === 1 && integrity.encryption === 'none', 'Plain backup manifest cannot be encrypted.', 'BACKUP_MANIFEST_INVALID');
  const manifest = {
    format: 'scalvin-backup-payload',
    formatVersion: 1,
    backupId: integrity.backupId,
    createdAt: integrity.createdAt,
    workspaceId: integrity.workspaceId,
    entries: structuredClone(integrity.entries)
  };
  validatePayloadManifest(manifest);
  return manifest;
}

async function* fileChunks(filename, expected) {
  const opened = await openBoundedRegularFile(filename, {
    minBytes: expected.size,
    maxBytes: expected.size,
    code: 'BACKUP_CONTENT_CHANGED',
    message: 'Backup source file changed while the encrypted archive was created.'
  });
  const hash = crypto.createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < expected.size) {
      const requested = Math.min(buffer.length, expected.size - position);
      const { bytesRead } = await opened.handle.read(buffer, 0, requested, position);
      invariant(bytesRead > 0, 'Backup source file ended unexpectedly.', 'BACKUP_CONTENT_CHANGED');
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(chunk);
      position += bytesRead;
      yield chunk;
    }
    await assertFileUnchanged(opened.handle, opened.stat);
    invariant(hash.digest('hex') === expected.sha256, 'Backup source file changed after its integrity pass.', 'BACKUP_CONTENT_CHANGED');
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function* archiveChunks(payloadRoot, manifest) {
  const validated = validatePayloadManifest(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestLength = Buffer.allocUnsafe(4);
  manifestLength.writeUInt32BE(manifestBytes.length);
  yield ARCHIVE_MAGIC;
  yield manifestLength;
  yield manifestBytes;
  for (const entry of manifest.entries) {
    const header = Buffer.from(JSON.stringify(archiveEntryHeader(entry)));
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(header.length);
    yield length;
    yield header;
    if (entry.type === 'file') {
      const filename = path.resolve(payloadRoot, validateRelativePath(entry.path));
      assertInside(payloadRoot, filename, 'Encrypted archive source');
      yield* fileChunks(filename, entry);
    }
  }
  yield Buffer.alloc(4);
  invariant(validated.archiveBytes > 0, 'Encrypted archive size is invalid.', 'BACKUP_LIMIT_INVALID');
}

async function encryptPayload(payloadRoot, destination, integrity, options = {}) {
  const privateManifest = privateManifestFromIntegrity(integrity);
  const envelopeVersion = options.envelopeVersion || ENVELOPE_VERSION;
  const profile = SCRYPT_PROFILES[envelopeVersion];
  invariant(profile, 'Encrypted backup format is unsupported.', 'BACKUP_FORMAT_UNSUPPORTED');
  const passphrase = await readPassphrase(options);
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const outerIntegrity = {
    format: 'scalvin-backup',
    formatVersion: envelopeVersion,
    backupId: privateManifest.backupId,
    createdAt: privateManifest.createdAt,
    encryption: {
      envelopeVersion,
      payloadFormat: PAYLOAD_FORMAT,
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      N: profile.N,
      r: profile.r,
      p: profile.p,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: null
    }
  };
  let key;
  let destinationHandle = null;
  let destinationCreated = false;
  try {
    key = await deriveKey(passphrase, salt, profile);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aadForIntegrity(outerIntegrity));
    await rejectSymlinkPath(destination, { allowMissing: true });
    destinationHandle = await fsp.open(destination, 'wx', PRIVATE_FILE_MODE);
    destinationCreated = true;
    await pipeline(
      Readable.from(archiveChunks(payloadRoot, privateManifest)),
      cipher,
      fs.createWriteStream(destination, { fd: destinationHandle.fd, autoClose: false })
    );
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = null;
    outerIntegrity.encryption.tag = cipher.getAuthTag().toString('base64');
    validateEncryptedIntegrity(outerIntegrity);
    for (const keyName of Object.keys(integrity)) delete integrity[keyName];
    Object.assign(integrity, outerIntegrity);
    return await sha256BoundedRegularFile(destination, {
      minBytes: 1,
      maxBytes: LIMITS.maxArchiveBytes,
      code: 'BACKUP_LIMIT_EXCEEDED'
    });
  } catch (error) {
    await destinationHandle?.close().catch(() => {});
    destinationHandle = null;
    if (destinationCreated) await fsp.rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => {});
    passphrase.fill(0);
    key?.fill(0);
    salt.fill(0);
    nonce.fill(0);
  }
}

async function decryptArchive(encryptedFile, archiveFile, integrity, options = {}) {
  const validated = validateEncryptedIntegrity(integrity);
  const opened = await openBoundedRegularFile(encryptedFile, {
    minBytes: 1,
    maxBytes: LIMITS.maxArchiveBytes,
    code: 'BACKUP_LIMIT_EXCEEDED',
    message: 'Encrypted backup payload is missing, special, or exceeds the supported byte limit.'
  });
  let passphrase;
  let key;
  try {
    passphrase = await readPassphrase(options);
    key = await deriveKey(passphrase, validated.salt, validated.profile);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, validated.nonce, { authTagLength: 16 });
    decipher.setAAD(aadForIntegrity(integrity));
    decipher.setAuthTag(validated.tag);
    try {
      await pipeline(
        opened.handle.createReadStream({ start: 0, end: opened.stat.size - 1, autoClose: false }),
        decipher,
        fs.createWriteStream(archiveFile, { flags: 'wx', mode: PRIVATE_FILE_MODE })
      );
      await assertFileUnchanged(opened.handle, opened.stat);
      const archiveStat = await fsp.lstat(archiveFile);
      invariant(archiveStat.isFile() && archiveStat.size > 0 && archiveStat.size <= LIMITS.maxArchiveBytes,
        'Decrypted backup archive exceeds the supported byte limit.', 'BACKUP_LIMIT_EXCEEDED');
    } catch (error) {
      await fsp.rm(archiveFile, { force: true }).catch(() => {});
      if (error instanceof ScalvinError && ['BACKUP_FILE_CHANGED', 'BACKUP_LIMIT_EXCEEDED'].includes(error.code)) throw error;
      if (error?.code === 'EEXIST') throw new ScalvinError('Decryption staging file already exists.', 'BACKUP_TEMP_COLLISION');
      throw new ScalvinError('Encrypted backup authentication failed; the passphrase is wrong or the backup was modified.', 'BACKUP_AUTHENTICATION_FAILED');
    }
  } finally {
    await opened.handle.close().catch(() => {});
    passphrase?.fill(0);
    key?.fill(0);
    validated.salt.fill(0);
    validated.nonce.fill(0);
    validated.tag.fill(0);
  }
}

async function readExact(handle, length, position, stat) {
  invariant(Number.isSafeInteger(length) && length >= 0 && position + length <= stat.size,
    'Encrypted backup archive ended unexpectedly.', 'BACKUP_CONTENT_MISMATCH');
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    invariant(bytesRead > 0, 'Encrypted backup archive ended unexpectedly.', 'BACKUP_CONTENT_MISMATCH');
    offset += bytesRead;
  }
  return buffer;
}

async function unpackArchive(archiveFile, payloadRoot) {
  const opened = await openBoundedRegularFile(archiveFile, {
    minBytes: ARCHIVE_MAGIC.length + 8,
    maxBytes: LIMITS.maxArchiveBytes,
    code: 'BACKUP_CONTENT_MISMATCH',
    message: 'Decrypted backup archive is invalid or exceeds the supported byte limit.'
  });
  let createdRoot = false;
  let position = 0;
  try {
    await rejectSymlinkPath(payloadRoot, { allowMissing: true });
    await fsp.mkdir(payloadRoot, { recursive: false, mode: PRIVATE_DIR_MODE });
    createdRoot = true;
    if (process.platform !== 'win32') await fsp.chmod(payloadRoot, PRIVATE_DIR_MODE);

    const magic = await readExact(opened.handle, ARCHIVE_MAGIC.length, position, opened.stat);
    position += ARCHIVE_MAGIC.length;
    invariant(magic.equals(ARCHIVE_MAGIC), 'Encrypted backup archive magic is invalid.', 'BACKUP_CONTENT_MISMATCH');
    const manifestLengthBuffer = await readExact(opened.handle, 4, position, opened.stat);
    position += 4;
    const manifestLength = manifestLengthBuffer.readUInt32BE();
    invariant(manifestLength > 0 && manifestLength <= LIMITS.manifestMaxBytes, 'Encrypted backup payload manifest is too large.', 'BACKUP_LIMIT_EXCEEDED');
    const rawManifest = await readExact(opened.handle, manifestLength, position, opened.stat);
    position += manifestLength;
    let manifest;
    try {
      manifest = JSON.parse(decodeUtf8(rawManifest, 'BACKUP_CONTENT_MISMATCH', 'Encrypted backup payload manifest is not valid UTF-8.'));
    } catch (error) {
      if (error instanceof ScalvinError) throw error;
      throw new ScalvinError('Encrypted backup payload manifest is invalid JSON.', 'BACKUP_CONTENT_MISMATCH');
    }
    validatePayloadManifest(manifest);

    const seen = new Set();
    for (const expected of manifest.entries) {
      const lengthBuffer = await readExact(opened.handle, 4, position, opened.stat);
      position += 4;
      const headerLength = lengthBuffer.readUInt32BE();
      invariant(headerLength > 0 && headerLength <= LIMITS.headerMaxBytes, 'Encrypted backup archive header is invalid.', 'BACKUP_CONTENT_MISMATCH');
      const rawHeader = await readExact(opened.handle, headerLength, position, opened.stat);
      position += headerLength;
      let header;
      try {
        header = JSON.parse(decodeUtf8(rawHeader, 'BACKUP_CONTENT_MISMATCH', 'Encrypted backup archive header is not valid UTF-8.'));
      } catch (error) {
        if (error instanceof ScalvinError) throw error;
        throw new ScalvinError('Encrypted backup archive header is invalid JSON.', 'BACKUP_CONTENT_MISMATCH');
      }
      exactKeys(header, expected.type === 'file' ? ['path', 'type', 'mode', 'size'] : ['path', 'type', 'mode'], 'BACKUP_CONTENT_MISMATCH');
      invariant(canonicalJson(header) === canonicalJson(archiveEntryHeader(expected)), 'Encrypted backup archive record does not match its private manifest.', 'BACKUP_CONTENT_MISMATCH');
      const relative = validateRelativePath(header.path);
      invariant(!seen.has(relative), 'Encrypted backup archive contains a duplicate path.', 'BACKUP_CONTENT_MISMATCH');
      const parent = path.posix.dirname(relative);
      if (parent !== '.') invariant(seen.has(parent), 'Encrypted backup archive parent directory is missing.', 'BACKUP_CONTENT_MISMATCH');
      seen.add(relative);
      const destination = path.resolve(payloadRoot, relative);
      assertInside(payloadRoot, destination, 'Decrypted backup target');
      await rejectSymlinkPath(destination, { allowMissing: true });
      if (header.type === 'directory') {
        await fsp.mkdir(destination, { recursive: false, mode: PRIVATE_DIR_MODE });
        if (process.platform !== 'win32') await fsp.chmod(destination, PRIVATE_DIR_MODE);
        continue;
      }
      invariant(position + header.size <= opened.stat.size, 'Encrypted backup archive file ended unexpectedly.', 'BACKUP_CONTENT_MISMATCH');
      const output = await fsp.open(destination, 'wx', PRIVATE_FILE_MODE);
      try {
        let remaining = header.size;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (remaining > 0) {
          const requested = Math.min(buffer.length, remaining);
          const { bytesRead } = await opened.handle.read(buffer, 0, requested, position);
          invariant(bytesRead > 0, 'Encrypted backup archive file ended unexpectedly.', 'BACKUP_CONTENT_MISMATCH');
          await output.write(buffer, 0, bytesRead);
          position += bytesRead;
          remaining -= bytesRead;
        }
        await output.sync();
      } finally {
        await output.close();
      }
    }
    const terminal = await readExact(opened.handle, 4, position, opened.stat);
    position += 4;
    invariant(terminal.readUInt32BE() === 0, 'Encrypted backup archive terminator is invalid.', 'BACKUP_CONTENT_MISMATCH');
    invariant(position === opened.stat.size, 'Encrypted backup archive has trailing data.', 'BACKUP_CONTENT_MISMATCH');
    await assertFileUnchanged(opened.handle, opened.stat);
    return manifest;
  } catch (error) {
    if (createdRoot) await fsp.rm(payloadRoot, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ScalvinError) throw new ScalvinError(error.message, error.code, undefined, error.exitCode);
    throw new ScalvinError('Encrypted backup extraction failed without exposing private archive metadata.', 'BACKUP_CONTENT_MISMATCH');
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

module.exports = {
  ARCHIVE_MAGIC,
  ENVELOPE_VERSION,
  PAYLOAD_FORMAT,
  SCRYPT,
  SCRYPT_PROFILES,
  LIMITS,
  BACKUP_ID_PATTERN,
  canonicalJson,
  aadForIntegrity,
  exactKeys,
  validTimestamp,
  readBoundedRegularFile,
  sha256BoundedRegularFile,
  readPassphrase,
  validatePayloadManifest,
  validateEncryptedIntegrity,
  encryptPayload,
  decryptArchive,
  unpackArchive
};
