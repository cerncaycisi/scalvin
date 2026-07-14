'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  createBackup,
  verifyBackup,
  getBackupSummary,
  deleteBackupArtifact,
  findDefaultBackupById,
  appendBackupOperationReceipt,
  readBackupLedgerStatus,
  markBackupDeleted
} = require('../../cli/lib/backup');
const {
  ARCHIVE_MAGIC,
  LIMITS,
  sha256BoundedRegularFile,
  unpackArchive
} = require('../../cli/lib/backup-crypto');
const { applyWindowsPrivateAcl } = require('../../cli/lib/fs-safe');
const { sandbox } = require('./helpers');

const GOOD_SECRET = 'correct-horse-battery-staple';
const PRIVATE_FILENAME = 'private-personal-title.txt';
const PRIVATE_CONTENT = 'synthetic confidential backup canary';

async function writePrivateFile(filename, data) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(filename, data, { mode: 0o600 });
  if (process.platform !== 'win32') await fsp.chmod(filename, 0o600);
  else await applyWindowsPrivateAcl(filename);
  return filename;
}

async function fixture(label, options = {}) {
  const box = await sandbox(`encrypted-${label}`);
  const workspaceId = crypto.randomUUID();
  await fsp.mkdir(path.join(box.workspace, '.scalvin'), { recursive: true });
  await fsp.mkdir(path.join(box.workspace, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(box.workspace, '.scalvin', 'state.json'), `${JSON.stringify({
    workspaceId,
    consent: { usageLedgers: options.usageLedgers || 'off' }
  })}\n`);
  await fsp.writeFile(path.join(box.workspace, PRIVATE_FILENAME), PRIVATE_CONTENT);
  await fsp.writeFile(path.join(box.workspace, 'nested', 'note.txt'), 'nested synthetic note');
  if (options.ledger !== undefined) {
    const ledger = path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md');
    await fsp.mkdir(path.dirname(ledger), { recursive: true });
    await fsp.writeFile(ledger, options.ledger);
  }
  const passphraseFile = await writePrivateFile(path.join(box.base, 'passphrase.txt'), `${GOOD_SECRET}\n`);
  return { ...box, workspaceId, passphraseFile, output: path.join(box.base, 'backups') };
}

async function makeEncrypted(box, options = {}) {
  return createBackup(box.workspace, {
    output: box.output,
    encrypt: true,
    passphraseFile: options.passphraseFile || box.passphraseFile
  });
}

async function checksum(filename) {
  return crypto.createHash('sha256').update(await fsp.readFile(filename)).digest('hex');
}

async function rewriteChecksums(backupPath) {
  const integrityHash = await checksum(path.join(backupPath, 'integrity.json'));
  const payloadHash = await checksum(path.join(backupPath, 'payload.enc'));
  await fsp.writeFile(path.join(backupPath, 'CHECKSUM.sha256'), `${integrityHash}  integrity.json\n${payloadHash}  payload.enc\n`, { mode: 0o600 });
}

async function mutateEnvelope(backupPath, mutate) {
  const filename = path.join(backupPath, 'integrity.json');
  const integrity = JSON.parse(await fsp.readFile(filename, 'utf8'));
  mutate(integrity);
  await fsp.writeFile(filename, `${JSON.stringify(integrity, null, 2)}\n`, { mode: 0o600 });
  await rewriteChecksums(backupPath);
}

async function tempDecryptArtifacts(box) {
  const entries = await fsp.readdir(box.output).catch(() => []);
  return entries.filter((name) => name.startsWith('.backup-decrypt-'));
}

test('encrypted v2 roundtrip hides filenames, workspace metadata, and content', async () => {
  const box = await fixture('roundtrip');
  try {
    const made = await makeEncrypted(box);
    assert.equal(made.encrypted, true);
    assert.match(made.backupId, /^backup-[0-9a-f-]{36}$/);
    const rootEntries = (await fsp.readdir(made.backupPath)).sort();
    assert.deepEqual(rootEntries, ['CHECKSUM.sha256', 'integrity.json', 'payload.enc']);
    const outerRaw = await fsp.readFile(path.join(made.backupPath, 'integrity.json'), 'utf8');
    const outer = JSON.parse(outerRaw);
    assert.deepEqual(Object.keys(outer).sort(), ['backupId', 'createdAt', 'encryption', 'format', 'formatVersion']);
    assert.equal(outer.formatVersion, 2);
    assert.equal(outer.backupId, made.backupId);
    assert.equal(Object.hasOwn(outer, 'entries'), false);
    assert.equal(Object.hasOwn(outer, 'workspaceId'), false);
    for (const secret of [PRIVATE_FILENAME, PRIVATE_CONTENT, box.workspaceId, 'nested/note.txt']) {
      assert.equal(outerRaw.includes(secret), false);
      assert.equal((await fsp.readFile(path.join(made.backupPath, 'CHECKSUM.sha256'), 'utf8')).includes(secret), false);
      assert.equal((await fsp.readFile(path.join(made.backupPath, 'payload.enc'))).includes(Buffer.from(secret)), false);
    }
    await assert.rejects(fsp.access(path.join(made.backupPath, 'payload')));

    const verified = await verifyBackup(made.backupPath, { passphraseFile: box.passphraseFile, materialize: true });
    assert.equal(verified.encrypted, true);
    assert.equal(verified.integrity.backupId, made.backupId);
    assert.equal(verified.integrity.workspaceId, box.workspaceId);
    assert.equal(await fsp.readFile(path.join(verified.payloadPath, PRIVATE_FILENAME), 'utf8'), PRIVATE_CONTENT);
    const plaintextRoot = path.dirname(verified.payloadPath);
    await verified.cleanup();
    await assert.rejects(fsp.access(plaintextRoot));
    await verified.cleanup();
    assert.deepEqual(await tempDecryptArtifacts(box), []);
  } finally {
    await box.cleanup();
  }
});

test('wrong passphrase fails authentication and removes every plaintext stage', async () => {
  const box = await fixture('wrong-passphrase');
  try {
    const made = await makeEncrypted(box);
    const wrong = await writePrivateFile(path.join(box.base, 'wrong-passphrase.txt'), 'this-is-not-the-right-secret');
    await assert.rejects(
      verifyBackup(made.backupPath, { passphraseFile: wrong, materialize: true }),
      { code: 'BACKUP_AUTHENTICATION_FAILED' }
    );
    assert.deepEqual(await tempDecryptArtifacts(box), []);
  } finally {
    await box.cleanup();
  }
});

test('ciphertext tamper and truncation fail even after attacker rewrites public checksums', async (t) => {
  await t.test('tamper', async () => {
    const box = await fixture('ciphertext-tamper');
    try {
      const made = await makeEncrypted(box);
      const filename = path.join(made.backupPath, 'payload.enc');
      const payload = await fsp.readFile(filename);
      payload[Math.floor(payload.length / 2)] ^= 0x01;
      await fsp.writeFile(filename, payload, { mode: 0o600 });
      await rewriteChecksums(made.backupPath);
      await assert.rejects(verifyBackup(made.backupPath, { passphraseFile: box.passphraseFile }), { code: 'BACKUP_AUTHENTICATION_FAILED' });
      assert.deepEqual(await tempDecryptArtifacts(box), []);
    } finally {
      await box.cleanup();
    }
  });

  await t.test('truncation', async () => {
    const box = await fixture('ciphertext-truncated');
    try {
      const made = await makeEncrypted(box);
      const filename = path.join(made.backupPath, 'payload.enc');
      const stat = await fsp.stat(filename);
      await fsp.truncate(filename, stat.size - 1);
      await rewriteChecksums(made.backupPath);
      await assert.rejects(verifyBackup(made.backupPath, { passphraseFile: box.passphraseFile }), { code: 'BACKUP_AUTHENTICATION_FAILED' });
      assert.deepEqual(await tempDecryptArtifacts(box), []);
    } finally {
      await box.cleanup();
    }
  });
});

test('envelope validation is exact, canonical, and bounded before key derivation', async (t) => {
  await t.test('KDF resource escalation', async () => {
    const box = await fixture('kdf-escalation');
    try {
      const made = await makeEncrypted(box);
      await mutateEnvelope(made.backupPath, (integrity) => { integrity.encryption.N = 2 ** 30; });
      await assert.rejects(verifyBackup(made.backupPath, { passphraseFile: box.passphraseFile }), { code: 'BACKUP_FORMAT_UNSUPPORTED' });
    } finally {
      await box.cleanup();
    }
  });

  await t.test('unknown envelope field', async () => {
    const box = await fixture('envelope-extra');
    try {
      const made = await makeEncrypted(box);
      await mutateEnvelope(made.backupPath, (integrity) => { integrity.encryption.unboundedWork = 999; });
      await assert.rejects(verifyBackup(made.backupPath, { passphraseFile: box.passphraseFile }), { code: 'BACKUP_MANIFEST_INVALID' });
    } finally {
      await box.cleanup();
    }
  });

  await t.test('invalid base64', async () => {
    const box = await fixture('envelope-base64');
    try {
      const made = await makeEncrypted(box);
      await mutateEnvelope(made.backupPath, (integrity) => { integrity.encryption.salt = '!!!!!!!!!!!!!!!!!!!!!!!!'; });
      await assert.rejects(verifyBackup(made.backupPath, { passphraseFile: box.passphraseFile }), { code: 'BACKUP_MANIFEST_INVALID' });
    } finally {
      await box.cleanup();
    }
  });

  await t.test('bounded regular-file hashing rejects an over-limit component', async () => {
    const box = await fixture('bounded-component');
    try {
      const filename = path.join(box.base, 'over-limit.enc');
      await fsp.writeFile(filename, Buffer.alloc(2049, 0x61), { mode: 0o600 });
      await assert.rejects(sha256BoundedRegularFile(filename, {
        minBytes: 1,
        maxBytes: 2048,
        code: 'BACKUP_LIMIT_EXCEEDED'
      }), { code: 'BACKUP_LIMIT_EXCEEDED' });
    } finally {
      await box.cleanup();
    }
  });
});

test('passphrase is accepted only from a bounded private regular non-symlink file', async (t) => {
  await t.test('missing file option and environment values are ignored', async () => {
    const box = await fixture('passphrase-missing');
    try {
      process.env.SCALVIN_ALLOW_TEST_PASSPHRASE = '1';
      process.env.SCALVIN_TEST_BACKUP_PASSPHRASE = GOOD_SECRET;
      await assert.rejects(createBackup(box.workspace, { output: box.output, encrypt: true }), { code: 'PASSPHRASE_REQUIRED' });
      assert.equal((await fsp.readdir(box.output).catch(() => [])).some((name) => name.startsWith('.backup-stage-')), false);
    } finally {
      delete process.env.SCALVIN_ALLOW_TEST_PASSPHRASE;
      delete process.env.SCALVIN_TEST_BACKUP_PASSPHRASE;
      await box.cleanup();
    }
  });

  await t.test('short and oversized files', async () => {
    const box = await fixture('passphrase-bounds');
    try {
      const short = await writePrivateFile(path.join(box.base, 'short.txt'), 'too-short');
      await assert.rejects(makeEncrypted(box, { passphraseFile: short }), { code: 'PASSPHRASE_LENGTH_INVALID' });
      const oversized = await writePrivateFile(path.join(box.base, 'oversized.txt'), Buffer.alloc(LIMITS.passphraseMaxBytes + 3, 0x61));
      await assert.rejects(makeEncrypted(box, { passphraseFile: oversized }), { code: 'PASSPHRASE_FILE_INVALID' });
      const entries = await fsp.readdir(box.output).catch(() => []);
      assert.equal(entries.some((name) => name.startsWith('.backup-stage-')), false);
      assert.equal(entries.some((name) => name.endsWith('.scalvin-backup')), false);
    } finally {
      await box.cleanup();
    }
  });

  await t.test('directory', async () => {
    const box = await fixture('passphrase-directory');
    try {
      const directory = path.join(box.base, 'passphrase-directory');
      await fsp.mkdir(directory);
      await assert.rejects(makeEncrypted(box, { passphraseFile: directory }), { code: 'PASSPHRASE_FILE_INVALID' });
    } finally {
      await box.cleanup();
    }
  });

  await t.test('file inside the workspace', async () => {
    const box = await fixture('passphrase-inside-workspace');
    try {
      const inside = await writePrivateFile(path.join(box.workspace, 'secret-passphrase.txt'), GOOD_SECRET);
      await assert.rejects(makeEncrypted(box, { passphraseFile: inside }), { code: 'PASSPHRASE_INSIDE_WORKSPACE' });
      assert.equal((await fsp.readdir(box.output).catch(() => [])).some((name) => name.endsWith('.scalvin-backup')), false);
    } finally {
      await box.cleanup();
    }
  });

  await t.test('symlink', { skip: process.platform === 'win32' }, async () => {
    const box = await fixture('passphrase-symlink');
    try {
      const link = path.join(box.base, 'passphrase-link.txt');
      await fsp.symlink(box.passphraseFile, link);
      await assert.rejects(makeEncrypted(box, { passphraseFile: link }), { code: 'PASSPHRASE_FILE_INVALID' });
    } finally {
      await box.cleanup();
    }
  });

  await t.test('Unix permissions', { skip: process.platform === 'win32' }, async () => {
    const box = await fixture('passphrase-mode');
    try {
      await fsp.chmod(box.passphraseFile, 0o644);
      await assert.rejects(makeEncrypted(box), { code: 'PASSPHRASE_FILE_PERMISSIONS' });
    } finally {
      await box.cleanup();
    }
  });
});

test('backup child symlinks and unexpected root components fail closed', async (t) => {
  await t.test('encrypted payload symlink', { skip: process.platform === 'win32' }, async () => {
    const box = await fixture('payload-symlink');
    try {
      const made = await makeEncrypted(box);
      const payload = path.join(made.backupPath, 'payload.enc');
      const moved = path.join(box.base, 'moved-payload.enc');
      await fsp.rename(payload, moved);
      await fsp.symlink(moved, payload);
      await assert.rejects(verifyBackup(made.backupPath, { passphraseFile: box.passphraseFile }), { code: 'BACKUP_LAYOUT_INVALID' });
    } finally {
      await box.cleanup();
    }
  });

  await t.test('integrity symlink', { skip: process.platform === 'win32' }, async () => {
    const box = await fixture('integrity-symlink');
    try {
      const made = await makeEncrypted(box);
      const integrity = path.join(made.backupPath, 'integrity.json');
      const moved = path.join(box.base, 'moved-integrity.json');
      await fsp.rename(integrity, moved);
      await fsp.symlink(moved, integrity);
      await assert.rejects(verifyBackup(made.backupPath, { passphraseFile: box.passphraseFile }), { code: 'BACKUP_MANIFEST_INVALID' });
    } finally {
      await box.cleanup();
    }
  });

  await t.test('undeclared root file', async () => {
    const box = await fixture('root-extra');
    try {
      const made = await makeEncrypted(box);
      await fsp.writeFile(path.join(made.backupPath, 'extra.txt'), 'extra');
      await assert.rejects(verifyBackup(made.backupPath, { passphraseFile: box.passphraseFile }), { code: 'BACKUP_LAYOUT_INVALID' });
    } finally {
      await box.cleanup();
    }
  });
});

function archiveBuffer(manifest, records, suffix = Buffer.alloc(0)) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestLength = Buffer.alloc(4);
  manifestLength.writeUInt32BE(manifestBytes.length);
  const chunks = [ARCHIVE_MAGIC, manifestLength, manifestBytes];
  for (const record of records) {
    const header = Buffer.from(JSON.stringify(record.header));
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32BE(header.length);
    chunks.push(headerLength, header, record.data || Buffer.alloc(0));
  }
  chunks.push(Buffer.alloc(4), suffix);
  return Buffer.concat(chunks);
}

function privateManifest(entries = []) {
  return {
    format: 'scalvin-backup-payload',
    formatVersion: 1,
    backupId: `backup-${crypto.randomUUID()}`,
    createdAt: '2026-07-14T00:00:00.000Z',
    workspaceId: null,
    entries
  };
}

test('archive extraction rejects traversal, truncation, extra header fields, and trailing bytes without residue', async (t) => {
  await t.test('traversal manifest', async () => {
    const box = await fixture('archive-traversal');
    try {
      const manifest = privateManifest([{
        path: '../escape.txt', type: 'file', mode: 0o600, size: 1,
        sha256: crypto.createHash('sha256').update('x').digest('hex')
      }]);
      const archive = path.join(box.base, 'traversal.archive');
      const output = path.join(box.base, 'unpacked');
      await fsp.writeFile(archive, archiveBuffer(manifest, []), { mode: 0o600 });
      await assert.rejects(unpackArchive(archive, output), (error) => {
        assert.equal(error.code, 'PATH_TRAVERSAL');
        assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes('../escape.txt'), false);
        assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(output), false);
        return true;
      });
      await assert.rejects(fsp.access(output));
      await assert.rejects(fsp.access(path.join(box.base, 'escape.txt')));
    } finally {
      await box.cleanup();
    }
  });

  await t.test('truncated record', async () => {
    const box = await fixture('archive-truncated');
    try {
      const data = Buffer.from('hello');
      const entry = { path: 'note.txt', type: 'file', mode: 0o600, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
      const archive = path.join(box.base, 'truncated.archive');
      const output = path.join(box.base, 'unpacked');
      const complete = archiveBuffer(privateManifest([entry]), [{ header: { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size }, data }]);
      await fsp.writeFile(archive, complete.subarray(0, complete.length - 3), { mode: 0o600 });
      await assert.rejects(unpackArchive(archive, output), { code: 'BACKUP_CONTENT_MISMATCH' });
      await assert.rejects(fsp.access(output));
    } finally {
      await box.cleanup();
    }
  });

  await t.test('unknown header field', async () => {
    const box = await fixture('archive-header-extra');
    try {
      const data = Buffer.from('x');
      const entry = { path: 'note.txt', type: 'file', mode: 0o600, size: 1, sha256: crypto.createHash('sha256').update(data).digest('hex') };
      const archive = path.join(box.base, 'extra-header.archive');
      const output = path.join(box.base, 'unpacked');
      await fsp.writeFile(archive, archiveBuffer(privateManifest([entry]), [{
        header: { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size, unexpected: true }, data
      }]), { mode: 0o600 });
      await assert.rejects(unpackArchive(archive, output), { code: 'BACKUP_CONTENT_MISMATCH' });
      await assert.rejects(fsp.access(output));
    } finally {
      await box.cleanup();
    }
  });

  await t.test('trailing bytes', async () => {
    const box = await fixture('archive-trailing');
    try {
      const archive = path.join(box.base, 'trailing.archive');
      const output = path.join(box.base, 'unpacked');
      await fsp.writeFile(archive, archiveBuffer(privateManifest(), [], Buffer.from('extra')), { mode: 0o600 });
      await assert.rejects(unpackArchive(archive, output), { code: 'BACKUP_CONTENT_MISMATCH' });
      await assert.rejects(fsp.access(output));
    } finally {
      await box.cleanup();
    }
  });
});

test('failed encryption leaves no stage or artifact, while successful artifacts never clobber each other', async () => {
  const box = await fixture('atomic');
  try {
    const short = await writePrivateFile(path.join(box.base, 'short.txt'), 'short');
    await assert.rejects(makeEncrypted(box, { passphraseFile: short }), { code: 'PASSPHRASE_LENGTH_INVALID' });
    const afterFailure = await fsp.readdir(box.output).catch(() => []);
    assert.equal(afterFailure.some((name) => name.startsWith('.backup-stage-')), false);
    assert.equal(afterFailure.some((name) => name.endsWith('.scalvin-backup')), false);

    const first = await makeEncrypted(box);
    const firstHash = await checksum(path.join(first.backupPath, 'payload.enc'));
    const second = await makeEncrypted(box);
    assert.notEqual(first.backupPath, second.backupPath);
    assert.equal(await checksum(path.join(first.backupPath, 'payload.enc')), firstHash);
    assert.equal((await fsp.readdir(box.output)).filter((name) => name.endsWith('.scalvin-backup')).length, 2);
  } finally {
    await box.cleanup();
  }
});

test('ledger receipt uses authenticated backup ID and post-activation ledger failure reports the surviving artifact', async (t) => {
  const validLedger = `# Backup Ledger\n\n| Backup ID | Created at | Scope | Destination class | Encryption | Archive SHA-256 | Integrity check | Restore check | Status | Deleted at |\n|---|---|---|---|---|---|---|---|---|---|\n\n- Last successful backup: null\n- Last successful backup SHA-256: null\n- Last destination class: null\n- Sessions since successful backup: 0\n`;
  await t.test('authenticated ID parity', async () => {
    const box = await fixture('ledger-success', { usageLedgers: 'on', ledger: validLedger });
    try {
      const made = await makeEncrypted(box);
      const outer = JSON.parse(await fsp.readFile(path.join(made.backupPath, 'integrity.json'), 'utf8'));
      const ledger = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md'), 'utf8');
      assert.equal(made.backupId, outer.backupId);
      assert.match(ledger, new RegExp(`\\| ${made.backupId} \\|`));
      assert.equal(ledger.includes(GOOD_SECRET), false);
      assert.equal(ledger.includes(box.passphraseFile), false);
      assert.equal(ledger.includes(made.backupPath), false);
    } finally {
      await box.cleanup();
    }
  });

  await t.test('ledger failure preserves exact artifact identity', async () => {
    const box = await fixture('ledger-failure', { usageLedgers: 'on', ledger: '# malformed ledger\n' });
    try {
      let failure;
      try {
        await makeEncrypted(box);
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.code, 'BACKUP_LEDGER_INVALID');
      assert.equal(failure?.details?.backupCreated, true);
      assert.match(failure?.details?.backupId || '', /^backup-[0-9a-f-]{36}$/);
      await fsp.access(failure.details.backupPath);
      const outer = JSON.parse(await fsp.readFile(path.join(failure.details.backupPath, 'integrity.json'), 'utf8'));
      assert.equal(outer.backupId, failure.details.backupId);
      assert.equal((await fsp.readdir(box.output)).some((name) => name.startsWith('.backup-stage-')), false);
    } finally {
      await box.cleanup();
    }
  });
});

test('content-free core status and deletion APIs require authenticated artifact identity', async () => {
  const validLedger = `# Backup Ledger\n\n| Backup ID | Created at | Scope | Destination class | Encryption | Archive SHA-256 | Integrity check | Restore check | Status | Deleted at |\n|---|---|---|---|---|---|---|---|---|---|\n\n- Last successful backup: null\n- Last successful backup SHA-256: null\n- Last destination class: null\n- Sessions since successful backup: 0\n- Last reminder at: null\n- Reminder declined until: null\n`;
  const box = await fixture('core-actions', { usageLedgers: 'on', ledger: validLedger });
  try {
    const made = await makeEncrypted(box);
    const summary = await getBackupSummary(made.backupPath, { passphraseFile: box.passphraseFile });
    assert.deepEqual(Object.keys(summary).sort(), ['backupId', 'checksum', 'createdAt', 'encrypted', 'files', 'status', 'verified']);
    assert.equal(summary.backupId, made.backupId);
    assert.equal(summary.encrypted, true);
    assert.equal(JSON.stringify(summary).includes(made.backupPath), false);
    assert.equal(JSON.stringify(summary).includes(PRIVATE_FILENAME), false);

    const ledgerStatus = await readBackupLedgerStatus(box.workspace, { backupId: made.backupId });
    assert.equal(ledgerStatus.status, 'found');
    assert.equal(ledgerStatus.record.artifactStatus, 'complete');
    const failedReceipt = await appendBackupOperationReceipt(box.workspace, {
      operation: 'restore',
      backupId: made.backupId,
      phase: 'apply',
      status: 'failed',
      errorCode: 'TEST_RESTORE_FAILURE',
      at: '2026-07-14T11:00:00.000Z'
    });
    assert.equal(failedReceipt.written, true);
    const receiptLedger = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md'), 'utf8');
    assert.match(receiptLedger, /\| restore \| backup-[0-9a-f-]{36} \| apply \| failed \| TEST_RESTORE_FAILURE \|/);
    assert.equal(receiptLedger.includes(made.backupPath), false);
    assert.equal((await readBackupLedgerStatus(box.workspace)).operationReceiptCount, 1);
    await assert.rejects(
      deleteBackupArtifact(made.backupPath, {
        expectedBackupId: `backup-${crypto.randomUUID()}`,
        expectedChecksum: made.checksum,
        passphraseFile: box.passphraseFile
      }),
      { code: 'BACKUP_DELETE_ROLLBACK_FAILED' }
    );
    await fsp.access(made.backupPath);

    const deleted = await deleteBackupArtifact(made.backupPath, {
      expectedBackupId: made.backupId,
      expectedChecksum: made.checksum,
      passphraseFile: box.passphraseFile,
      deletedAt: '2026-07-14T12:00:00.000Z'
    });
    assert.deepEqual(deleted, { status: 'deleted', backupId: made.backupId, deletedAt: '2026-07-14T12:00:00.000Z' });
    await assert.rejects(fsp.access(made.backupPath));
    const receipt = await markBackupDeleted(box.workspace, { backupId: made.backupId, deletedAt: deleted.deletedAt });
    assert.equal(receipt.written, true);
    const after = await readBackupLedgerStatus(box.workspace, { backupId: made.backupId });
    assert.equal(after.record.artifactStatus, 'deleted');
    assert.equal(after.record.deletedAt, deleted.deletedAt);
  } finally {
    await box.cleanup();
  }
});

test('default backup ID lookup is bounded to the sibling backup root', async () => {
  const box = await fixture('default-lookup');
  try {
    const made = await createBackup(box.workspace, { encrypt: true, passphraseFile: box.passphraseFile });
    assert.equal(await findDefaultBackupById(box.workspace, made.backupId), made.backupPath);
    assert.equal(await findDefaultBackupById(box.workspace, `backup-${crypto.randomUUID()}`), null);
  } finally {
    await box.cleanup();
    await fsp.rm(path.join(path.dirname(box.workspace), '.scalvin-backups'), { recursive: true, force: true });
  }
});
