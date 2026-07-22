'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  ARCHIVE_MAGIC,
  LIMITS,
  SCRYPT_PROFILES,
  aadForIntegrity,
  unpackArchive,
  validateEncryptedIntegrity,
  validatePayloadManifest
} = require('../../cli/lib/backup-crypto');
const { ROOT } = require('./helpers');

const TEST_ROOT = process.env.SCALVIN_TEST_ROOT || path.join(ROOT, '.test-tmp');
const BACKUP_ID = 'backup-123e4567-e89b-42d3-a456-426614174000';
const CREATED_AT = '2026-07-15T00:00:00.000Z';

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function encryptedIntegrity(version = 3) {
  const profile = SCRYPT_PROFILES[version];
  return {
    format: 'scalvin-backup',
    formatVersion: version,
    backupId: BACKUP_ID,
    createdAt: CREATED_AT,
    encryption: {
      envelopeVersion: version,
      payloadFormat: 'scalvin-archive-v2',
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      N: profile.N,
      r: profile.r,
      p: profile.p,
      salt: Buffer.alloc(16, 0x11).toString('base64'),
      nonce: Buffer.alloc(12, 0x22).toString('base64'),
      tag: Buffer.alloc(16, 0x33).toString('base64')
    }
  };
}

function payloadManifest(entries = []) {
  return {
    format: 'scalvin-backup-payload',
    formatVersion: 1,
    backupId: BACKUP_ID,
    createdAt: CREATED_AT,
    workspaceId: null,
    entries
  };
}

function fileEntry(name, data) {
  return { path: name, type: 'file', mode: 0o600, size: data.length, sha256: sha256(data) };
}

function archiveBytes(manifest, records, suffix = Buffer.alloc(0)) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestLength = Buffer.alloc(4);
  manifestLength.writeUInt32BE(manifestBytes.length);
  const chunks = [ARCHIVE_MAGIC, manifestLength, manifestBytes];
  const recordOffsets = [];
  let offset = ARCHIVE_MAGIC.length + 4 + manifestBytes.length;
  for (const record of records) {
    const header = Buffer.from(JSON.stringify(record.header));
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32BE(header.length);
    recordOffsets.push({ length: offset, body: offset + 4 });
    chunks.push(headerLength, header, record.data || Buffer.alloc(0));
    offset += 4 + header.length + (record.data?.length || 0);
  }
  const terminalOffset = offset;
  chunks.push(Buffer.alloc(4), suffix);
  return {
    buffer: Buffer.concat(chunks),
    manifestBodyOffset: ARCHIVE_MAGIC.length + 4,
    recordOffsets,
    terminalOffset
  };
}

async function temporaryDirectory(label) {
  await fsp.mkdir(TEST_ROOT, { recursive: true });
  return fsp.mkdtemp(path.join(TEST_ROOT, `${label}-`));
}

async function expectRejectedWithoutResidue(root, label, bytes, expectedCodes) {
  const archive = path.join(root, `${label}.archive`);
  const output = path.join(root, `${label}-output`);
  await fsp.writeFile(archive, bytes, { mode: 0o600 });
  await assert.rejects(unpackArchive(archive, output), (error) => {
    assert.ok(expectedCodes.includes(error.code), `${label}:${error.code}`);
    return true;
  });
  await assert.rejects(fsp.access(output), undefined, `${label}: extraction residue`);
}

test('encrypted envelope exact-field and canonical-encoding contract covers every parser field', () => {
  for (const version of [2, 3]) assert.doesNotThrow(() => validateEncryptedIntegrity(encryptedIntegrity(version)));

  const topLevelKeys = ['format', 'formatVersion', 'backupId', 'createdAt', 'encryption'];
  const encryptionKeys = ['envelopeVersion', 'payloadFormat', 'algorithm', 'kdf', 'N', 'r', 'p', 'salt', 'nonce', 'tag'];
  let exactFieldMutations = 0;

  for (const key of topLevelKeys) {
    const candidate = encryptedIntegrity();
    delete candidate[key];
    assert.throws(() => validateEncryptedIntegrity(candidate), { code: 'BACKUP_MANIFEST_INVALID' }, `missing:${key}`);
    exactFieldMutations += 1;
  }
  for (const key of encryptionKeys) {
    const candidate = encryptedIntegrity();
    delete candidate.encryption[key];
    assert.throws(() => validateEncryptedIntegrity(candidate), { code: 'BACKUP_MANIFEST_INVALID' }, `missing:encryption.${key}`);
    exactFieldMutations += 1;
  }
  for (const location of ['outer', 'encryption']) {
    const candidate = encryptedIntegrity();
    if (location === 'outer') candidate.unexpected = true;
    else candidate.encryption.unexpected = true;
    assert.throws(() => validateEncryptedIntegrity(candidate), { code: 'BACKUP_MANIFEST_INVALID' }, `unknown:${location}`);
    exactFieldMutations += 1;
  }
  assert.equal(exactFieldMutations, 17, 'every exact envelope field plus both object boundaries must be mutated');

  const encodingMutations = [
    ['', 'empty'],
    ['AAAAAAAAAAAAAAAAAAAAAA', 'missing-padding'],
    ['AAAAAAAAAAAAAAAAAAAAAA=_', 'invalid-alphabet'],
    ['AAAAAAAAAAAAAAAAAAAAAA==\n', 'whitespace'],
    ['AAAAAAAAAAAAAAAAAAAAAB==', 'noncanonical-pad-bits'],
    [Buffer.alloc(15).toString('base64'), 'wrong-length']
  ];
  for (const field of ['salt', 'tag']) {
    for (const [value, label] of encodingMutations) {
      const candidate = encryptedIntegrity();
      candidate.encryption[field] = value;
      assert.throws(() => validateEncryptedIntegrity(candidate), { code: 'BACKUP_MANIFEST_INVALID' }, `${field}:${label}`);
    }
  }
  for (const [value, label] of encodingMutations) {
    const candidate = encryptedIntegrity();
    candidate.encryption.nonce = value;
    assert.throws(() => validateEncryptedIntegrity(candidate), { code: 'BACKUP_MANIFEST_INVALID' }, `nonce:${label}`);
  }
});

test('envelope AAD is insertion-order independent, authenticates metadata, and excludes only the tag', () => {
  const original = encryptedIntegrity();
  const reordered = {
    createdAt: original.createdAt,
    encryption: {
      tag: original.encryption.tag,
      nonce: original.encryption.nonce,
      salt: original.encryption.salt,
      p: original.encryption.p,
      r: original.encryption.r,
      N: original.encryption.N,
      kdf: original.encryption.kdf,
      algorithm: original.encryption.algorithm,
      payloadFormat: original.encryption.payloadFormat,
      envelopeVersion: original.encryption.envelopeVersion
    },
    backupId: original.backupId,
    formatVersion: original.formatVersion,
    format: original.format
  };
  assert.deepEqual(aadForIntegrity(original), aadForIntegrity(reordered));

  const changedTag = clone(original);
  changedTag.encryption.tag = Buffer.alloc(16, 0x44).toString('base64');
  assert.deepEqual(aadForIntegrity(original), aadForIntegrity(changedTag));

  const changedId = clone(original);
  changedId.backupId = 'backup-123e4567-e89b-42d3-a456-426614174001';
  assert.notDeepEqual(aadForIntegrity(original), aadForIntegrity(changedId));

  const nullTag = clone(original);
  nullTag.encryption.tag = null;
  assert.doesNotThrow(() => aadForIntegrity(nullTag));
  assert.throws(() => validateEncryptedIntegrity(nullTag), { code: 'BACKUP_MANIFEST_INVALID' });
});

test('payload manifest exact-field mutations and path ordering fail before extraction', () => {
  const data = Buffer.from('synthetic');
  const valid = payloadManifest([fileEntry('note.txt', data)]);
  assert.doesNotThrow(() => validatePayloadManifest(valid));

  const topLevelKeys = ['format', 'formatVersion', 'backupId', 'createdAt', 'workspaceId', 'entries'];
  const entryKeys = ['path', 'type', 'mode', 'size', 'sha256'];
  let mutations = 0;
  for (const key of topLevelKeys) {
    const candidate = clone(valid);
    delete candidate[key];
    assert.throws(() => validatePayloadManifest(candidate), { code: 'BACKUP_MANIFEST_INVALID' }, `manifest:${key}`);
    mutations += 1;
  }
  for (const key of entryKeys) {
    const candidate = clone(valid);
    delete candidate.entries[0][key];
    assert.throws(() => validatePayloadManifest(candidate), { code: 'BACKUP_MANIFEST_INVALID' }, `entry:${key}`);
    mutations += 1;
  }
  const unknownManifest = clone(valid);
  unknownManifest.unexpected = true;
  assert.throws(() => validatePayloadManifest(unknownManifest), { code: 'BACKUP_MANIFEST_INVALID' });
  const unknownEntry = clone(valid);
  unknownEntry.entries[0].unexpected = true;
  assert.throws(() => validatePayloadManifest(unknownEntry), { code: 'BACKUP_MANIFEST_INVALID' });
  mutations += 2;
  assert.equal(mutations, 13);

  const childWithoutParent = payloadManifest([fileEntry('folder/note.txt', data)]);
  assert.throws(() => validatePayloadManifest(childWithoutParent), { code: 'BACKUP_MANIFEST_INVALID' });
  const duplicate = payloadManifest([fileEntry('note.txt', data), fileEntry('note.txt', data)]);
  assert.throws(() => validatePayloadManifest(duplicate), { code: 'BACKUP_MANIFEST_INVALID' });
});

test('archive parser survives deterministic structural mutation without extraction residue', async () => {
  const root = await temporaryDirectory('archive-structural-properties');
  const data = Buffer.from('synthetic archive payload');
  const entry = fileEntry('café.txt', data);
  const valid = archiveBytes(payloadManifest([entry]), [{
    header: { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size },
    data
  }]);

  try {
    const validArchive = path.join(root, 'valid.archive');
    const validOutput = path.join(root, 'valid-output');
    await fsp.writeFile(validArchive, valid.buffer, { mode: 0o600 });
    const unpacked = await unpackArchive(validArchive, validOutput);
    assert.deepEqual(unpacked, payloadManifest([entry]));
    assert.deepEqual(await fsp.readFile(path.join(validOutput, entry.path)), data);

    let magicMutations = 0;
    for (let index = 0; index < ARCHIVE_MAGIC.length; index += 1) {
      const mutated = Buffer.from(valid.buffer);
      mutated[index] ^= 0x01;
      await expectRejectedWithoutResidue(root, `magic-${index}`, mutated, ['BACKUP_CONTENT_MISMATCH']);
      magicMutations += 1;
    }
    assert.equal(magicMutations, ARCHIVE_MAGIC.length, 'every magic byte must be covered by a one-byte mutation');

    const truncationPoints = new Set();
    for (let index = 0; index < 24; index += 1) {
      truncationPoints.add(Math.floor(((valid.buffer.length - 1) * index) / 23));
    }
    assert.equal(truncationPoints.size, 24, 'truncation sampling must retain 24 distinct boundaries');
    let truncations = 0;
    for (const cut of truncationPoints) {
      await expectRejectedWithoutResidue(
        root,
        `truncated-${truncations}`,
        valid.buffer.subarray(0, cut),
        ['BACKUP_CONTENT_MISMATCH', 'BACKUP_LIMIT_EXCEEDED']
      );
      truncations += 1;
    }
    assert.equal(truncations, 24);

    for (const [label, value] of [['zero', 0], ['over-limit', LIMITS.manifestMaxBytes + 1], ['uint32-max', 0xffffffff]]) {
      const mutated = Buffer.from(valid.buffer);
      mutated.writeUInt32BE(value, ARCHIVE_MAGIC.length);
      await expectRejectedWithoutResidue(root, `manifest-length-${label}`, mutated, ['BACKUP_LIMIT_EXCEEDED']);
    }
    for (const [label, value] of [['zero', 0], ['over-limit', LIMITS.headerMaxBytes + 1], ['uint32-max', 0xffffffff]]) {
      const mutated = Buffer.from(valid.buffer);
      mutated.writeUInt32BE(value, valid.recordOffsets[0].length);
      await expectRejectedWithoutResidue(root, `header-length-${label}`, mutated, ['BACKUP_CONTENT_MISMATCH']);
    }

    const invalidManifestUtf8 = Buffer.from(valid.buffer);
    invalidManifestUtf8[valid.manifestBodyOffset + 2] = 0xff;
    await expectRejectedWithoutResidue(root, 'manifest-invalid-utf8', invalidManifestUtf8, ['BACKUP_CONTENT_MISMATCH']);
    const invalidHeaderUtf8 = Buffer.from(valid.buffer);
    invalidHeaderUtf8[valid.recordOffsets[0].body + 2] = 0xff;
    await expectRejectedWithoutResidue(root, 'header-invalid-utf8', invalidHeaderUtf8, ['BACKUP_CONTENT_MISMATCH']);

    const nonzeroTerminator = Buffer.from(valid.buffer);
    nonzeroTerminator.writeUInt32BE(1, valid.terminalOffset);
    await expectRejectedWithoutResidue(root, 'nonzero-terminator', nonzeroTerminator, ['BACKUP_CONTENT_MISMATCH']);
    await expectRejectedWithoutResidue(
      root,
      'trailing-byte',
      Buffer.concat([valid.buffer, Buffer.from([0])]),
      ['BACKUP_CONTENT_MISMATCH']
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('archive record/header equivalence is exact across every field', async () => {
  const root = await temporaryDirectory('archive-header-properties');
  const data = Buffer.from('x');
  const entry = fileEntry('note.txt', data);
  const manifest = payloadManifest([entry]);
  const baseHeader = { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size };
  const mutations = [
    ['path', { ...baseHeader, path: 'other.txt' }],
    ['type', { ...baseHeader, type: 'directory' }],
    ['mode', { ...baseHeader, mode: 0o700 }],
    ['size', { ...baseHeader, size: 2 }],
    ['unknown', { ...baseHeader, unexpected: true }],
    ['missing', Object.fromEntries(Object.entries(baseHeader).filter(([key]) => key !== 'size'))]
  ];
  try {
    for (const [label, header] of mutations) {
      const candidate = archiveBytes(manifest, [{ header, data }]).buffer;
      await expectRejectedWithoutResidue(root, `header-${label}`, candidate, ['BACKUP_CONTENT_MISMATCH']);
    }
    assert.equal(mutations.length, 6, 'every file-header field plus unknown/missing boundaries must remain covered');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
