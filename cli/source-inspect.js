'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScalvinError, invariant } = require('./lib/errors');
const { resolvePortablePath } = require('./lib/fs-safe');

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

const SOURCE_POLICY = Object.freeze({
  trust: 'untrusted_data',
  instructionsExecutable: false,
  canExpandScope: false,
  canModifyRuntime: false,
  persistence: 'consent_required',
  networkAccess: false,
  toolExecution: false
});

function sourceError(message, code, details) {
  return new ScalvinError(message, code, details);
}

function validateSourceInput(input) {
  invariant(typeof input === 'string' && input.trim(), 'A source path is required.', 'INVALID_SOURCE_PATH');
  invariant(!/[\0\r\n]/.test(input), 'Source paths cannot contain NUL or newline characters.', 'INVALID_SOURCE_PATH');
}

async function safeLstat(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') throw sourceError('Source does not exist.', 'SOURCE_NOT_FOUND');
    if (error.code === 'ENOTDIR') throw sourceError('Source path has a non-directory component.', 'INVALID_SOURCE_PATH');
    throw sourceError('Unable to inspect source path.', 'SOURCE_PATH_INSPECTION_FAILED', { causeCode: error.code || 'UNKNOWN' });
  }
}

async function assertNoSymlinkComponents(absolute) {
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  let stat = await safeLstat(cursor);
  if (stat.isSymbolicLink()) throw sourceError('Source paths cannot contain symbolic links.', 'SOURCE_SYMLINK_REJECTED');

  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    stat = await safeLstat(cursor);
    if (stat.isSymbolicLink()) throw sourceError('Source paths cannot contain symbolic links.', 'SOURCE_SYMLINK_REJECTED');
  }
  return stat;
}

async function openReadOnlyRegularFile(absolute) {
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0);
  try {
    return await fsp.open(absolute, flags);
  } catch (error) {
    if (error.code === 'ELOOP') throw sourceError('Source paths cannot contain symbolic links.', 'SOURCE_SYMLINK_REJECTED');
    if (error.code === 'ENOENT') throw sourceError('Source does not exist.', 'SOURCE_NOT_FOUND');
    throw sourceError('Unable to open source for read-only inspection.', 'SOURCE_OPEN_FAILED', { causeCode: error.code || 'UNKNOWN' });
  }
}

function sameFileSnapshot(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function hashBounded(handle, maxBytes) {
  const hash = crypto.createHash('sha256');
  let byteLength = 0;
  while (true) {
    const remaining = maxBytes - byteLength + 1;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    byteLength += bytesRead;
    if (byteLength > maxBytes) {
      throw sourceError('Source exceeds the inspection size limit.', 'SOURCE_TOO_LARGE', { maxBytes });
    }
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { byteLength, sha256: hash.digest('hex') };
}

async function inspectSource(input, options = {}) {
  validateSourceInput(input);
  const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
  invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= MAX_SOURCE_BYTES, 'Invalid source inspection byte limit.', 'INVALID_SOURCE_LIMIT');

  let absolute;
  try {
    absolute = resolvePortablePath(input, { cwd: options.cwd || process.cwd() });
  } catch (error) {
    if (error instanceof ScalvinError) throw error;
    throw sourceError('Source path is invalid.', 'INVALID_SOURCE_PATH');
  }

  const pathStat = await assertNoSymlinkComponents(absolute);
  if (!pathStat.isFile()) throw sourceError('Source must be a regular file.', 'SOURCE_NOT_REGULAR_FILE');
  if (pathStat.size > maxBytes) throw sourceError('Source exceeds the inspection size limit.', 'SOURCE_TOO_LARGE', { maxBytes });

  let handle;
  try {
    handle = await openReadOnlyRegularFile(absolute);
    const before = await handle.stat();
    if (!before.isFile()) throw sourceError('Source must be a regular file.', 'SOURCE_NOT_REGULAR_FILE');
    if (before.size > maxBytes) throw sourceError('Source exceeds the inspection size limit.', 'SOURCE_TOO_LARGE', { maxBytes });
    const digest = await hashBounded(handle, maxBytes);
    const after = await handle.stat();
    if (!sameFileSnapshot(before, after) || digest.byteLength !== after.size) {
      throw sourceError('Source changed during inspection; retry with a stable file.', 'SOURCE_CHANGED_DURING_INSPECTION');
    }
    return {
      status: 'inspected',
      kind: 'regular_file',
      byteLength: digest.byteLength,
      sha256: digest.sha256,
      ...SOURCE_POLICY,
      contentIncluded: false,
      absolutePathIncluded: false,
      maxBytes
    };
  } catch (error) {
    if (error instanceof ScalvinError) throw error;
    throw sourceError('Source read failed.', 'SOURCE_READ_FAILED', { causeCode: error.code || 'UNKNOWN' });
  } finally {
    await handle?.close().catch(() => {});
  }
}

module.exports = {
  MAX_SOURCE_BYTES,
  READ_CHUNK_BYTES,
  SOURCE_POLICY,
  inspectSource
};
