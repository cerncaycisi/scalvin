'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { ScalvinError, invariant } = require('./errors');
const {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  resolvePortablePath,
  isInside,
  rejectSymlinkPath,
  ensurePrivateDir,
  atomicWriteFile,
  sha256Buffer,
  sha256File,
  pathExists,
  walkTree,
  copyTree,
  hardenTree,
  createPrivateStage,
  snapshotWorkspaceTree,
  assertWorkspaceSnapshot,
  fsyncDirectory,
  validateRelativePath
} = require('./fs-safe');
const {
  LIMITS,
  BACKUP_ID_PATTERN,
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
} = require('./backup-crypto');

function backupName(now = new Date()) {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replaceAll(':', '');
  return `scalvin-backup-${day}-${time}--${crypto.randomUUID()}.scalvin-backup`;
}

async function readWorkspaceId(workspace) {
  try {
    const state = JSON.parse(await fsp.readFile(path.join(workspace, '.scalvin', 'state.json'), 'utf8'));
    return state.workspaceId || null;
  } catch {
    return null;
  }
}

async function appendBackupLedger(workspace, event) {
  const statePath = path.join(workspace, '.scalvin', 'state.json');
  let state;
  try { state = JSON.parse(await fsp.readFile(statePath, 'utf8')); } catch { return { written: false, reason: 'not-a-stateful-workspace' }; }
  if (state.consent?.usageLedgers !== 'on') return { written: false, reason: 'usage-ledgers-off' };
  const ledgerPath = path.join(workspace, '.therapy', 'state', 'BACKUP-LEDGER.md');
  try {
    const ledgerBuffer = await readBoundedRegularFile(ledgerPath, {
      minBytes: 1,
      maxBytes: 1024 * 1024,
      code: 'BACKUP_LEDGER_INVALID',
      message: 'Backup ledger is not a bounded regular non-symlink file.'
    });
    let markdown;
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(ledgerBuffer);
    } catch {
      throw new ScalvinError('Backup ledger is not valid UTF-8.', 'BACKUP_LEDGER_INVALID');
    }
    const header = '|---|---|---|---|---|---|---|---|---|---|';
    invariant(markdown.includes(header), 'Backup ledger table header is invalid.', 'BACKUP_LEDGER_INVALID');
    invariant(!markdown.includes(`| ${event.backupId} |`), 'Backup ledger event ID already exists.', 'BACKUP_LEDGER_INVALID');
    const row = `| ${event.backupId} | ${event.createdAt} | full_workspace | ${event.destinationClass} | ${event.encryption} | ${event.checksum} | passed | passed | complete | null |`;
    markdown = markdown.replace(header, `${header}\n${row}`);
    const reminderValues = {
      'Last successful backup': event.createdAt,
      'Last successful backup SHA-256': event.checksum,
      'Last destination class': event.destinationClass,
      'Sessions since successful backup': '0',
      'Last reminder at': 'null',
      'Reminder declined until': 'null'
    };
    for (const [label, value] of Object.entries(reminderValues)) {
      const expression = new RegExp(`^- ${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}:.*$`, 'm');
      if (expression.test(markdown)) markdown = markdown.replace(expression, `- ${label}: ${value}`);
      else markdown = `${markdown.trimEnd()}\n- ${label}: ${value}\n`;
    }
    await atomicWriteFile(ledgerPath, markdown);
    const verified = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedRegularFile(ledgerPath, {
      minBytes: 1,
      maxBytes: 1024 * 1024,
      code: 'BACKUP_LEDGER_VERIFY_FAILED',
      message: 'Backup ledger verification could not read a bounded regular file.'
    }));
    invariant(verified.includes(row) && verified.includes(`- Last successful backup SHA-256: ${event.checksum}`), 'Backup ledger verification failed.', 'BACKUP_LEDGER_VERIFY_FAILED');
    return { written: true, backupId: event.backupId };
  } catch (error) {
    if (error instanceof ScalvinError) throw error;
    throw new ScalvinError('Backup was created but its content-free ledger receipt could not be written.', 'BACKUP_LEDGER_WRITE_FAILED', { backupCreated: true, causeCode: error.code || 'UNKNOWN' });
  }
}

async function buildIntegrity(payload, workspaceId, backupId) {
  const walked = await walkTree(payload);
  const entries = [];
  for (const entry of walked) {
    if (entry.type === 'directory') {
      entries.push({ path: entry.path, type: 'directory', mode: PRIVATE_DIR_MODE });
    } else {
      const filename = path.join(payload, entry.path);
      entries.push({
        path: entry.path,
        type: 'file',
        size: entry.size,
        mode: PRIVATE_FILE_MODE,
        sha256: await sha256File(filename)
      });
    }
  }
  return {
    format: 'scalvin-backup',
    formatVersion: 1,
    backupId,
    createdAt: new Date().toISOString(),
    workspaceId,
    encryption: 'none',
    entries
  };
}

function snapshotContentEntries(snapshot) {
  return snapshot.entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    ...(entry.type === 'file' ? { size: entry.size, sha256: entry.sha256 } : {})
  }));
}

function integrityContentEntries(integrity) {
  return integrity.entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    ...(entry.type === 'file' ? { size: entry.size, sha256: entry.sha256 } : {})
  }));
}

async function createBackup(workspaceInput, options = {}) {
  const workspace = resolvePortablePath(workspaceInput);
  await rejectSymlinkPath(workspace);
  const stat = await fsp.lstat(workspace).catch((error) => {
    if (error.code === 'ENOENT') throw new ScalvinError('Workspace does not exist.', 'WORKSPACE_NOT_FOUND', { workspace });
    throw error;
  });
  invariant(stat.isDirectory(), 'Workspace must be a directory.', 'INVALID_WORKSPACE');
  const sourceSnapshot = await snapshotWorkspaceTree(workspace);

  invariant(options.encrypt || !options.passphraseFile, '--passphrase-file is only valid with --encrypt.', 'PASSPHRASE_NOT_APPLICABLE');
  if (options.passphraseFile) {
    const passphrasePath = resolvePortablePath(options.passphraseFile);
    invariant(!isInside(workspace, passphrasePath), 'Passphrase file must be outside the workspace so it is never included in a backup.', 'PASSPHRASE_INSIDE_WORKSPACE');
  }

  const defaultRoot = path.join(path.dirname(workspace), '.scalvin-backups');
  const outputRoot = resolvePortablePath(options.output || defaultRoot);
  invariant(!isInside(workspace, outputRoot), 'Backup output must be outside the workspace to prevent recursion.', 'INVALID_BACKUP_LOCATION', { workspace, outputRoot });
  await rejectSymlinkPath(outputRoot, { allowMissing: true });
  const backupId = `backup-${crypto.randomUUID()}`;
  const finalPath = path.join(outputRoot, backupName(options.now));
  invariant(!(await pathExists(finalPath)), 'Backup destination already exists.', 'BACKUP_EXISTS', { path: finalPath });

  if (options.encrypt) {
    const passphrase = await readPassphrase(options);
    passphrase.fill(0);
  }
  if (options.dryRun) {
    return { status: 'dry-run', workspacePath: workspace, backupPath: finalPath, encrypted: Boolean(options.encrypt) };
  }

  await ensurePrivateDir(outputRoot);
  const stage = path.join(outputRoot, `.backup-stage-${process.pid}-${crypto.randomUUID()}`);
  const payload = path.join(stage, 'payload');
  let activated = false;
  try {
    await createPrivateStage(stage);
    await copyTree(workspace, payload);
    await hardenTree(payload);
    const workspaceId = await readWorkspaceId(payload);
    const integrity = await buildIntegrity(payload, workspaceId, backupId);
    invariant(
      JSON.stringify(integrityContentEntries(integrity)) === JSON.stringify(snapshotContentEntries(sourceSnapshot)),
      'The workspace changed while its backup payload was copied; no backup artifact was finalized.',
      'STALE_WORKSPACE'
    );
    await assertWorkspaceSnapshot(workspace, sourceSnapshot);
    const createdAt = integrity.createdAt;
    const fileCount = integrity.entries.filter((entry) => entry.type === 'file').length;
    let encryptedPayloadHash = null;
    if (options.encrypt) {
      encryptedPayloadHash = await encryptPayload(payload, path.join(stage, 'payload.enc'), integrity, options);
      await fsp.rm(payload, { recursive: true, force: true });
    }
    const raw = `${JSON.stringify(integrity, null, 2)}\n`;
    await atomicWriteFile(path.join(stage, 'integrity.json'), raw);
    const checksum = sha256Buffer(Buffer.from(raw));
    await atomicWriteFile(path.join(stage, 'CHECKSUM.sha256'), `${checksum}  integrity.json\n${encryptedPayloadHash ? `${encryptedPayloadHash}  payload.enc\n` : ''}`);
    await hardenTree(stage);
    await verifyBackup(stage, { passphraseFile: options.passphraseFile });
    invariant(!(await pathExists(finalPath)), 'Backup destination already exists.', 'BACKUP_EXISTS', { path: finalPath });
    await fsp.rename(stage, finalPath);
    activated = true;
    await fsyncDirectory(outputRoot);
    const ledger = await appendBackupLedger(workspace, {
      backupId,
      createdAt,
      destinationClass: options.output ? 'local_user_selected' : 'local_sibling_default',
      encryption: options.encrypt ? 'aes-256-gcm' : 'none',
      checksum
    });
    return {
      status: 'created',
      workspacePath: workspace,
      workspaceId,
      backupPath: finalPath,
      files: fileCount,
      checksum,
      encrypted: Boolean(options.encrypt),
      ledgerWritten: ledger.written,
      backupId: ledger.backupId || backupId
    };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (activated) {
      if (error instanceof ScalvinError) {
        error.details = { ...(error.details || {}), backupCreated: true, backupPath: finalPath, backupId };
        throw error;
      }
      throw new ScalvinError('Backup artifact was created but final receipt handling failed.', 'BACKUP_POST_ACTIVATION_FAILED', {
        backupCreated: true,
        backupPath: finalPath,
        backupId,
        causeCode: error.code || 'UNKNOWN'
      });
    }
    throw error;
  }
}

function parseChecksumFile(raw) {
  const checksums = new Map();
  for (const line of raw.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s{2}([A-Za-z0-9._-]+)$/);
    invariant(match && !checksums.has(match[2]), 'Backup checksum file is invalid.', 'BACKUP_CHECKSUM_INVALID');
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function payloadManifestFor(integrity) {
  if (integrity.format === 'scalvin-backup-payload') return integrity;
  return {
    format: 'scalvin-backup-payload',
    formatVersion: 1,
    backupId: integrity.backupId,
    createdAt: integrity.createdAt,
    workspaceId: integrity.workspaceId,
    entries: integrity.entries
  };
}

function validatePlainIntegrity(integrity) {
  exactKeys(integrity, ['format', 'formatVersion', 'backupId', 'createdAt', 'workspaceId', 'encryption', 'entries']);
  invariant(integrity.format === 'scalvin-backup' && integrity.formatVersion === 1 && integrity.encryption === 'none', 'Plain backup format is unsupported.', 'BACKUP_FORMAT_UNSUPPORTED');
  invariant(BACKUP_ID_PATTERN.test(integrity.backupId || '') && validTimestamp(integrity.createdAt), 'Plain backup identity metadata is invalid.', 'BACKUP_MANIFEST_INVALID');
  validatePayloadManifest(payloadManifestFor(integrity));
  return integrity;
}

function validateDeclaredEntries(integrity) {
  const payloadManifest = payloadManifestFor(integrity);
  validatePayloadManifest(payloadManifest);
  const declared = new Map();
  for (const entry of payloadManifest.entries) {
    const relative = validateRelativePath(entry.path);
    declared.set(relative, entry);
  }
  return declared;
}

async function walkPayloadBounded(root) {
  const output = [];
  let totalFileBytes = 0;
  async function visit(directory, relativeDirectory) {
    let handle;
    try {
      handle = await fsp.opendir(directory);
      for await (const item of handle) {
        const relativeRaw = relativeDirectory ? `${relativeDirectory}/${item.name}` : item.name;
        const relative = validateRelativePath(relativeRaw);
        invariant(relative === relativeRaw, 'Backup payload path encoding is invalid.', 'BACKUP_CONTENT_MISMATCH');
        const absolute = path.join(directory, item.name);
        const stat = await fsp.lstat(absolute);
        invariant(!stat.isSymbolicLink(), 'Backup payload cannot contain symbolic links.', 'SYMLINK_REJECTED');
        invariant(stat.isDirectory() || stat.isFile(), 'Backup payload contains an unsupported file type.', 'UNSUPPORTED_FILE_TYPE');
        output.push({ path: relative, type: stat.isDirectory() ? 'directory' : 'file', size: stat.isFile() ? stat.size : undefined });
        invariant(output.length <= LIMITS.maxEntries, 'Backup payload entry count exceeds the supported limit.', 'BACKUP_LIMIT_EXCEEDED');
        if (stat.isFile()) {
          invariant(stat.size <= LIMITS.maxFileBytes, 'Backup payload file exceeds the supported byte limit.', 'BACKUP_LIMIT_EXCEEDED');
          totalFileBytes += stat.size;
          invariant(Number.isSafeInteger(totalFileBytes) && totalFileBytes <= LIMITS.maxArchiveBytes, 'Backup payload exceeds the supported byte limit.', 'BACKUP_LIMIT_EXCEEDED');
        } else {
          await visit(absolute, relative);
        }
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  await visit(root, '');
  return output;
}

async function verifyPayload(payload, declared) {
  await rejectSymlinkPath(payload);
  const payloadStat = await fsp.lstat(payload).catch(() => null);
  invariant(payloadStat?.isDirectory(), 'Backup payload directory is missing.', 'BACKUP_CONTENT_MISMATCH');
  const actualEntries = await walkPayloadBounded(payload);
  const actual = new Map(actualEntries.map((entry) => [entry.path, entry]));
  invariant(actual.size === declared.size, 'Backup payload entry count does not match its integrity manifest.', 'BACKUP_CONTENT_MISMATCH', { declared: declared.size, actual: actual.size });
  for (const [relative, entry] of declared) {
    const found = actual.get(relative);
    invariant(found && found.type === entry.type, 'Backup entry is missing or has the wrong type.', 'BACKUP_CONTENT_MISMATCH', { path: relative });
    if (entry.type === 'file') {
      invariant(found.size === entry.size, 'Backup file size mismatch.', 'BACKUP_CONTENT_MISMATCH', { path: relative });
      const actualHash = await sha256BoundedRegularFile(path.join(payload, relative), {
        minBytes: entry.size,
        maxBytes: entry.size,
        code: 'BACKUP_CONTENT_MISMATCH',
        message: 'Backup payload file does not match its declared size or type.'
      });
      invariant(actualHash === entry.sha256, 'Backup file hash mismatch.', 'BACKUP_CONTENT_MISMATCH', { path: relative, expected: entry.sha256, actual: actualHash });
    }
  }
}

async function validateBackupLayout(backup, encrypted) {
  const expected = encrypted
    ? new Map([['CHECKSUM.sha256', 'file'], ['integrity.json', 'file'], ['payload.enc', 'file']])
    : new Map([['CHECKSUM.sha256', 'file'], ['integrity.json', 'file'], ['payload', 'directory']]);
  const entries = await fsp.readdir(backup, { withFileTypes: true });
  invariant(entries.length === expected.size, 'Backup root contains missing or unexpected components.', 'BACKUP_LAYOUT_INVALID');
  for (const entry of entries) {
    const type = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'unsupported';
    invariant(expected.get(entry.name) === type, 'Backup root contains a missing, special, or symlinked component.', 'BACKUP_LAYOUT_INVALID');
  }
}

function parseJsonBuffer(buffer) {
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ScalvinError('Backup integrity manifest is not valid UTF-8.', 'BACKUP_MANIFEST_INVALID');
  }
  try {
    return { value: JSON.parse(raw), raw };
  } catch {
    throw new ScalvinError('Backup integrity manifest is invalid JSON.', 'BACKUP_MANIFEST_INVALID');
  }
}

async function verifyBackupInternal(backupInput, options = {}) {
  const backup = resolvePortablePath(backupInput);
  await rejectSymlinkPath(backup);
  const rootStat = await fsp.lstat(backup).catch(() => null);
  invariant(rootStat?.isDirectory(), 'Backup must be a directory.', 'BACKUP_LAYOUT_INVALID');
  const rawBuffer = await readBoundedRegularFile(path.join(backup, 'integrity.json'), {
    minBytes: 2,
    maxBytes: LIMITS.manifestMaxBytes,
    code: 'BACKUP_MANIFEST_INVALID',
    message: 'Backup integrity manifest must be a bounded regular non-symlink file.'
  });
  const checksumBuffer = await readBoundedRegularFile(path.join(backup, 'CHECKSUM.sha256'), {
    minBytes: 1,
    maxBytes: 1024,
    code: 'BACKUP_CHECKSUM_INVALID',
    message: 'Backup checksum list must be a bounded regular non-symlink file.'
  });
  const { value: outerIntegrity } = parseJsonBuffer(rawBuffer);
  let checksumLine;
  try {
    checksumLine = new TextDecoder('utf-8', { fatal: true }).decode(checksumBuffer);
  } catch {
    throw new ScalvinError('Backup checksum list is not valid UTF-8.', 'BACKUP_CHECKSUM_INVALID');
  }
  const checksums = parseChecksumFile(checksumLine);
  const expectedChecksum = checksums.get('integrity.json');
  invariant(expectedChecksum, 'Backup integrity checksum is missing.', 'BACKUP_CHECKSUM_INVALID');
  invariant(sha256Buffer(rawBuffer) === expectedChecksum, 'Backup integrity manifest checksum mismatch.', 'BACKUP_CHECKSUM_MISMATCH');

  if (outerIntegrity?.formatVersion === 1) {
    const integrity = validatePlainIntegrity(outerIntegrity);
    invariant(checksums.size === 1 && !checksums.has('payload.enc'), 'Plain backup checksum list is invalid.', 'BACKUP_CHECKSUM_INVALID');
    await validateBackupLayout(backup, false);
    const declared = validateDeclaredEntries(integrity);
    const payload = path.join(backup, 'payload');
    await verifyPayload(payload, declared);
    return { backupPath: backup, payloadPath: payload, integrity, checksum: expectedChecksum, encrypted: false, cleanup: async () => {} };
  }

  const integrity = outerIntegrity;
  validateEncryptedIntegrity(integrity);
  invariant(checksums.size === 2 && checksums.has('payload.enc'), 'Encrypted backup checksum list is invalid.', 'BACKUP_CHECKSUM_INVALID');
  await validateBackupLayout(backup, true);
  const encrypted = path.join(backup, 'payload.enc');
  const encryptedChecksum = checksums.get('payload.enc');
  const actualEncryptedChecksum = await sha256BoundedRegularFile(encrypted, {
    minBytes: 1,
    maxBytes: LIMITS.maxArchiveBytes,
    code: 'BACKUP_LIMIT_EXCEEDED',
    message: 'Encrypted backup payload is missing, special, symlinked, or exceeds the supported byte limit.'
  });
  invariant(actualEncryptedChecksum === encryptedChecksum, 'Encrypted backup payload checksum mismatch.', 'BACKUP_CHECKSUM_MISMATCH');
  const temporaryRoot = path.join(path.dirname(backup), `.backup-decrypt-${process.pid}-${crypto.randomUUID()}`);
  const archiveFile = path.join(temporaryRoot, 'payload.archive');
  const payload = path.join(temporaryRoot, 'payload');
  const cleanup = async () => fsp.rm(temporaryRoot, { recursive: true, force: true });
  try {
    await createPrivateStage(temporaryRoot);
    await decryptArchive(encrypted, archiveFile, integrity, options);
    const payloadIntegrity = await unpackArchive(archiveFile, payload);
    invariant(payloadIntegrity.backupId === integrity.backupId && payloadIntegrity.createdAt === integrity.createdAt,
      'Encrypted private manifest does not match its authenticated outer envelope.', 'BACKUP_CONTENT_MISMATCH');
    const declared = validateDeclaredEntries(payloadIntegrity);
    await fsp.rm(archiveFile, { force: true });
    await hardenTree(payload);
    await verifyPayload(payload, declared);
    if (!options.materialize) {
      await cleanup();
      return { backupPath: backup, payloadPath: null, integrity: payloadIntegrity, envelope: integrity, checksum: expectedChecksum, encrypted: true, cleanup: async () => {} };
    }
    return { backupPath: backup, payloadPath: payload, integrity: payloadIntegrity, envelope: integrity, checksum: expectedChecksum, encrypted: true, cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

async function verifyBackup(backupInput, options = {}) {
  try {
    return await verifyBackupInternal(backupInput, options);
  } catch (error) {
    if (error instanceof ScalvinError) {
      throw new ScalvinError(error.message, error.code, undefined, error.exitCode);
    }
    throw new ScalvinError('Backup verification failed without exposing private artifact metadata.', 'BACKUP_VERIFY_FAILED');
  }
}

function parseBackupLedger(markdown) {
  const records = [];
  const ids = new Set();
  for (const line of markdown.split(/\r?\n/u)) {
    if (!/^\|\s*backup-[0-9a-f-]{36}\s*\|/i.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    invariant(cells.length === 10 && BACKUP_ID_PATTERN.test(cells[0]) && !ids.has(cells[0]), 'Backup ledger row is invalid or duplicated.', 'BACKUP_LEDGER_INVALID');
    invariant(validTimestamp(cells[1]) && /^[a-z0-9_]{1,64}$/.test(cells[2]) && /^[a-z0-9_]{1,64}$/.test(cells[3]), 'Backup ledger classification is invalid.', 'BACKUP_LEDGER_INVALID');
    invariant(['none', 'aes-256-gcm'].includes(cells[4]) && /^[a-f0-9]{64}$/.test(cells[5]), 'Backup ledger cryptographic metadata is invalid.', 'BACKUP_LEDGER_INVALID');
    invariant(/^[a-z0-9_-]{1,64}$/.test(cells[6]) && /^[a-z0-9_-]{1,64}$/.test(cells[7]) && ['complete', 'deleted'].includes(cells[8]), 'Backup ledger status is invalid.', 'BACKUP_LEDGER_INVALID');
    invariant(cells[9] === 'null' || validTimestamp(cells[9]), 'Backup ledger deletion timestamp is invalid.', 'BACKUP_LEDGER_INVALID');
    invariant((cells[8] === 'deleted') === (cells[9] !== 'null'), 'Backup ledger deletion state is inconsistent.', 'BACKUP_LEDGER_INVALID');
    ids.add(cells[0]);
    records.push({
      backupId: cells[0],
      createdAt: cells[1],
      scope: cells[2],
      destinationClass: cells[3],
      encryption: cells[4],
      checksum: cells[5],
      integrityCheck: cells[6],
      restoreCheck: cells[7],
      artifactStatus: cells[8],
      deletedAt: cells[9] === 'null' ? null : cells[9]
    });
  }
  const reminder = {};
  for (const [key, label] of [
    ['lastSuccessfulBackup', 'Last successful backup'],
    ['lastSuccessfulBackupSha256', 'Last successful backup SHA-256'],
    ['lastDestinationClass', 'Last destination class'],
    ['sessionsSinceSuccessfulBackup', 'Sessions since successful backup'],
    ['lastReminderAt', 'Last reminder at'],
    ['reminderDeclinedUntil', 'Reminder declined until']
  ]) {
    const match = markdown.match(new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ([^|\\r\\n]{1,128})$`, 'm'));
    reminder[key] = match ? match[1] : null;
  }
  return { records, reminder };
}

const OPERATION_HEADER = '| Event ID | At | Operation | Backup ID | Phase | Status | Error code |';
const OPERATION_DIVIDER = '|---|---|---|---|---|---|---|';

function parseBackupOperationReceipts(markdown) {
  const receipts = [];
  const ids = new Set();
  for (const line of markdown.split(/\r?\n/u)) {
    if (!/^\|\s*backup-op-[0-9a-f-]{36}\s*\|/i.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    invariant(cells.length === 7 && /^backup-op-[0-9a-f-]{36}$/i.test(cells[0]) && !ids.has(cells[0]), 'Backup operation receipt is invalid or duplicated.', 'BACKUP_LEDGER_INVALID');
    invariant(validTimestamp(cells[1]) && ['create', 'verify', 'restore', 'delete'].includes(cells[2]), 'Backup operation receipt classification is invalid.', 'BACKUP_LEDGER_INVALID');
    invariant(cells[3] === 'null' || BACKUP_ID_PATTERN.test(cells[3]), 'Backup operation receipt ID is invalid.', 'BACKUP_LEDGER_INVALID');
    invariant(['preflight', 'payload', 'verify', 'apply', 'complete'].includes(cells[4]) && ['passed', 'failed'].includes(cells[5]), 'Backup operation phase or status is invalid.', 'BACKUP_LEDGER_INVALID');
    invariant(cells[6] === 'null' || /^[A-Z][A-Z0-9_]{2,63}$/.test(cells[6]), 'Backup operation error code is invalid.', 'BACKUP_LEDGER_INVALID');
    invariant((cells[5] === 'failed') === (cells[6] !== 'null'), 'Backup operation failure code is inconsistent.', 'BACKUP_LEDGER_INVALID');
    ids.add(cells[0]);
    receipts.push({
      eventId: cells[0],
      at: cells[1],
      operation: cells[2],
      backupId: cells[3] === 'null' ? null : cells[3],
      phase: cells[4],
      status: cells[5],
      errorCode: cells[6] === 'null' ? null : cells[6]
    });
  }
  return receipts;
}

async function ledgerContext(workspaceInput) {
  const workspace = resolvePortablePath(workspaceInput);
  await rejectSymlinkPath(workspace);
  const stateBuffer = await readBoundedRegularFile(path.join(workspace, '.scalvin', 'state.json'), {
    minBytes: 2,
    maxBytes: 2 * 1024 * 1024,
    code: 'WORKSPACE_STATE_INVALID',
    message: 'Workspace state must be a bounded regular non-symlink file.'
  });
  let state;
  try {
    state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stateBuffer));
  } catch {
    throw new ScalvinError('Workspace state is invalid JSON or UTF-8.', 'WORKSPACE_STATE_INVALID');
  }
  if (state.consent?.usageLedgers !== 'on') return { workspace, enabled: false };
  const ledgerPath = path.join(workspace, '.therapy', 'state', 'BACKUP-LEDGER.md');
  const ledgerBuffer = await readBoundedRegularFile(ledgerPath, {
    minBytes: 1,
    maxBytes: 1024 * 1024,
    code: 'BACKUP_LEDGER_INVALID',
    message: 'Backup ledger must be a bounded regular non-symlink file.'
  });
  let markdown;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(ledgerBuffer);
  } catch {
    throw new ScalvinError('Backup ledger is not valid UTF-8.', 'BACKUP_LEDGER_INVALID');
  }
  const parsed = parseBackupLedger(markdown);
  return { workspace, enabled: true, ledgerPath, markdown, ...parsed };
}

async function readBackupLedgerStatus(workspaceInput, options = {}) {
  if (options.backupId !== undefined) invariant(BACKUP_ID_PATTERN.test(options.backupId), 'Backup ID is invalid.', 'BACKUP_ID_INVALID');
  const context = await ledgerContext(workspaceInput);
  if (!context.enabled) return { status: 'disabled', recordCount: 0, operationReceiptCount: 0, latest: null, reminder: null };
  if (options.backupId) {
    const record = context.records.find((item) => item.backupId === options.backupId) || null;
    return {
      status: record ? 'found' : 'not-found',
      recordCount: context.records.length,
      operationReceiptCount: parseBackupOperationReceipts(context.markdown).length,
      record,
      reminder: context.reminder
    };
  }
  const active = context.records.filter((item) => item.artifactStatus === 'complete');
  return {
    status: 'available',
    recordCount: context.records.length,
    operationReceiptCount: parseBackupOperationReceipts(context.markdown).length,
    latest: active.length ? active[active.length - 1] : null,
    reminder: context.reminder
  };
}

async function appendBackupOperationReceipt(workspaceInput, event = {}) {
  invariant(['create', 'verify', 'restore', 'delete'].includes(event.operation), 'Backup operation receipt operation is invalid.', 'BACKUP_OPERATION_INVALID');
  invariant(['preflight', 'payload', 'verify', 'apply', 'complete'].includes(event.phase), 'Backup operation receipt phase is invalid.', 'BACKUP_OPERATION_INVALID');
  invariant(['passed', 'failed'].includes(event.status), 'Backup operation receipt status is invalid.', 'BACKUP_OPERATION_INVALID');
  const errorCode = event.errorCode || null;
  invariant((event.status === 'failed') === Boolean(errorCode) && (errorCode === null || /^[A-Z][A-Z0-9_]{2,63}$/.test(errorCode)), 'Backup operation receipt error code is invalid.', 'BACKUP_OPERATION_INVALID');
  const backupId = event.backupId || null;
  invariant(backupId === null || BACKUP_ID_PATTERN.test(backupId), 'Backup operation receipt backup ID is invalid.', 'BACKUP_OPERATION_INVALID');
  const at = event.at || new Date().toISOString();
  invariant(validTimestamp(at), 'Backup operation receipt timestamp is invalid.', 'BACKUP_OPERATION_INVALID');
  const eventId = event.eventId || `backup-op-${crypto.randomUUID()}`;
  invariant(/^backup-op-[0-9a-f-]{36}$/i.test(eventId), 'Backup operation receipt event ID is invalid.', 'BACKUP_OPERATION_INVALID');
  const context = await ledgerContext(workspaceInput);
  if (!context.enabled) return { written: false, reason: 'usage-ledgers-off', eventId };
  const existing = parseBackupOperationReceipts(context.markdown);
  invariant(!existing.some((item) => item.eventId === eventId), 'Backup operation receipt event ID already exists.', 'BACKUP_LEDGER_INVALID');
  let markdown = context.markdown;
  if (!markdown.includes(`${OPERATION_HEADER}\n${OPERATION_DIVIDER}`)) {
    const section = `Operation receipts contain no paths or user content. A failed operation records only its stable error code.\n\n${OPERATION_HEADER}\n${OPERATION_DIVIDER}\n`;
    markdown = markdown.includes('Reminder state:')
      ? markdown.replace('Reminder state:', `${section}\nReminder state:`)
      : `${markdown.trimEnd()}\n\n${section}`;
  }
  const row = `| ${eventId} | ${at} | ${event.operation} | ${backupId || 'null'} | ${event.phase} | ${event.status} | ${errorCode || 'null'} |`;
  markdown = markdown.replace(
    `${OPERATION_HEADER}\n${OPERATION_DIVIDER}`,
    `${OPERATION_HEADER}\n${OPERATION_DIVIDER}\n${row}`
  );
  await atomicWriteFile(context.ledgerPath, markdown);
  const verifiedBuffer = await readBoundedRegularFile(context.ledgerPath, {
    minBytes: 1,
    maxBytes: 1024 * 1024,
    code: 'BACKUP_LEDGER_VERIFY_FAILED',
    message: 'Backup operation receipt could not be verified.'
  });
  const verifiedMarkdown = new TextDecoder('utf-8', { fatal: true }).decode(verifiedBuffer);
  invariant(parseBackupOperationReceipts(verifiedMarkdown).some((item) => item.eventId === eventId), 'Backup operation receipt verification failed.', 'BACKUP_LEDGER_VERIFY_FAILED');
  return { written: true, eventId, at, operation: event.operation, backupId, phase: event.phase, status: event.status, errorCode };
}

async function markBackupDeleted(workspaceInput, options = {}) {
  invariant(BACKUP_ID_PATTERN.test(options.backupId || ''), 'Backup ID is invalid.', 'BACKUP_ID_INVALID');
  const deletedAt = options.deletedAt || new Date().toISOString();
  invariant(validTimestamp(deletedAt), 'Backup deletion timestamp is invalid.', 'BACKUP_DELETE_INVALID');
  const context = await ledgerContext(workspaceInput);
  if (!context.enabled) return { written: false, reason: 'usage-ledgers-off', backupId: options.backupId, deletedAt };
  const record = context.records.find((item) => item.backupId === options.backupId);
  if (!record) return { written: false, reason: 'backup-id-not-found', backupId: options.backupId, deletedAt };
  if (record.artifactStatus === 'deleted') return { written: false, reason: 'already-deleted', backupId: options.backupId, deletedAt: record.deletedAt };
  const oldRow = `| ${record.backupId} | ${record.createdAt} | ${record.scope} | ${record.destinationClass} | ${record.encryption} | ${record.checksum} | ${record.integrityCheck} | ${record.restoreCheck} | complete | null |`;
  const newRow = `| ${record.backupId} | ${record.createdAt} | ${record.scope} | ${record.destinationClass} | ${record.encryption} | ${record.checksum} | ${record.integrityCheck} | ${record.restoreCheck} | deleted | ${deletedAt} |`;
  invariant(context.markdown.includes(oldRow), 'Backup ledger row cannot be updated exactly.', 'BACKUP_LEDGER_INVALID');
  let markdown = context.markdown.replace(oldRow, newRow);
  const lastSuccessful = context.reminder.lastSuccessfulBackup;
  if (lastSuccessful === record.createdAt) {
    for (const label of ['Last successful backup', 'Last successful backup SHA-256', 'Last destination class']) {
      markdown = markdown.replace(new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:.*$`, 'm'), `- ${label}: null`);
    }
  }
  await atomicWriteFile(context.ledgerPath, markdown);
  const verified = await readBackupLedgerStatus(context.workspace, { backupId: options.backupId });
  invariant(verified.record?.artifactStatus === 'deleted' && verified.record.deletedAt === deletedAt, 'Backup ledger deletion receipt verification failed.', 'BACKUP_LEDGER_VERIFY_FAILED');
  return { written: true, backupId: options.backupId, deletedAt };
}

async function getBackupSummary(backupInput, options = {}) {
  const verified = await verifyBackup(backupInput, { passphraseFile: options.passphraseFile });
  try {
    return {
      status: 'verified',
      backupId: verified.integrity.backupId,
      createdAt: verified.integrity.createdAt,
      encrypted: verified.encrypted,
      files: verified.integrity.entries.filter((entry) => entry.type === 'file').length,
      checksum: verified.checksum,
      verified: true
    };
  } finally {
    await verified.cleanup();
  }
}

function backupArtifactIdentity(backupInput) {
  return sha256Buffer(Buffer.from(resolvePortablePath(backupInput), 'utf8'));
}

async function deleteBackupArtifact(backupInput, options = {}) {
  invariant(BACKUP_ID_PATTERN.test(options.expectedBackupId || ''), 'Deleting a backup requires its exact backup ID.', 'BACKUP_ID_REQUIRED');
  invariant(/^[a-f0-9]{64}$/.test(options.expectedChecksum || ''), 'Deleting a backup requires its exact authenticated checksum.', 'BACKUP_CHECKSUM_REQUIRED');
  const backup = resolvePortablePath(backupInput);
  invariant(!options.expectedArtifactIdentity || options.expectedArtifactIdentity === backupArtifactIdentity(backup), 'Backup artifact identity does not match the approved path.', 'BACKUP_ARTIFACT_IDENTITY_MISMATCH');
  if (options.passphraseFile) {
    invariant(!isInside(backup, resolvePortablePath(options.passphraseFile)), 'Passphrase file cannot be inside the backup being deleted.', 'PASSPHRASE_INSIDE_BACKUP');
  }
  const deletedAt = options.deletedAt || new Date().toISOString();
  invariant(validTimestamp(deletedAt), 'Backup deletion timestamp is invalid.', 'BACKUP_DELETE_INVALID');
  const tombstoneRoot = path.join(path.dirname(backup), `.backup-delete-${process.pid}-${crypto.randomUUID()}`);
  const tombstone = path.join(tombstoneRoot, 'artifact');
  await createPrivateStage(tombstoneRoot);
  let moved = false;
  let frozen = null;
  try {
    await fsp.rename(backup, tombstone);
    moved = true;
    if (process.env.SCALVIN_TEST_BACKUP_DELETE_HOOKS === '1' && typeof options.afterTombstoneRename === 'function') {
      await options.afterTombstoneRename(tombstone);
    }
    frozen = await verifyBackup(tombstone, { passphraseFile: options.passphraseFile });
    invariant(frozen.integrity.backupId === options.expectedBackupId, 'Backup ID does not match the authenticated artifact.', 'BACKUP_ID_MISMATCH');
    invariant(frozen.checksum === options.expectedChecksum, 'Backup checksum no longer matches the approved artifact.', 'STALE_CONFIRMATION');
    await frozen.cleanup();
    frozen = null;
    await fsp.rm(tombstoneRoot, { recursive: true, force: false });
    moved = false;
    await fsyncDirectory(path.dirname(backup));
    return { status: 'deleted', backupId: options.expectedBackupId, deletedAt };
  } catch (error) {
    await frozen?.cleanup().catch(() => {});
    try {
      if (moved && !(await pathExists(backup)) && await pathExists(tombstone)) {
        await fsp.rename(tombstone, backup);
        moved = false;
      }
      invariant(await pathExists(backup), 'Backup artifact could not be restored after deletion failure.', 'BACKUP_DELETE_ROLLBACK_FAILED');
      const restored = await verifyBackup(backup, { passphraseFile: options.passphraseFile });
      try {
        invariant(restored.integrity.backupId === options.expectedBackupId && restored.checksum === options.expectedChecksum,
          'Restored backup does not match the exact approved artifact.', 'BACKUP_DELETE_ROLLBACK_FAILED');
      } finally {
        await restored.cleanup();
      }
      await fsp.rm(tombstoneRoot, { recursive: true, force: true });
      await fsyncDirectory(path.dirname(backup));
    } catch (rollbackError) {
      throw new ScalvinError('Backup deletion failed and exact automatic rollback could not be proven.', 'BACKUP_DELETE_ROLLBACK_FAILED', {
        backupId: options.expectedBackupId,
        retainedPrivateTombstone: moved
      });
    }
    throw new ScalvinError('Backup deletion failed; the artifact was restored.', 'BACKUP_DELETE_FAILED', { backupId: options.expectedBackupId, causeCode: error.code || 'UNKNOWN' });
  }
}

async function findDefaultBackupById(workspaceInput, backupId) {
  invariant(BACKUP_ID_PATTERN.test(backupId || ''), 'Backup ID is invalid.', 'BACKUP_ID_INVALID');
  const workspace = resolvePortablePath(workspaceInput);
  const root = path.join(path.dirname(workspace), '.scalvin-backups');
  if (!(await pathExists(root))) return null;
  await rejectSymlinkPath(root);
  const stat = await fsp.lstat(root);
  invariant(stat.isDirectory(), 'Default backup root is invalid.', 'BACKUP_LAYOUT_INVALID');
  const matches = [];
  let count = 0;
  const directory = await fsp.opendir(root);
  try {
    for await (const entry of directory) {
      count += 1;
      invariant(count <= 10000, 'Default backup root contains too many entries for ID lookup.', 'BACKUP_LIMIT_EXCEEDED');
      if (!entry.isDirectory() || !entry.name.endsWith('.scalvin-backup')) continue;
      const candidate = path.join(root, entry.name);
      try {
        const buffer = await readBoundedRegularFile(path.join(candidate, 'integrity.json'), {
          minBytes: 2,
          maxBytes: LIMITS.manifestMaxBytes,
          code: 'BACKUP_MANIFEST_INVALID'
        });
        const { value } = parseJsonBuffer(buffer);
        if (value.formatVersion === 1) validatePlainIntegrity(value);
        else validateEncryptedIntegrity(value);
        if (value.backupId === backupId) matches.push(candidate);
      } catch {
        // An unrelated malformed artifact cannot authorize or redirect an ID lookup.
      }
    }
  } finally {
    await directory.close().catch(() => {});
  }
  invariant(matches.length <= 1, 'Default backup ID is ambiguous.', 'BACKUP_ID_AMBIGUOUS');
  return matches[0] || null;
}

module.exports = {
  backupName,
  createBackup,
  verifyBackup,
  getBackupSummary,
  backupArtifactIdentity,
  deleteBackupArtifact,
  findDefaultBackupById,
  appendBackupLedger,
  appendBackupOperationReceipt,
  readBackupLedgerStatus,
  markBackupDeleted,
  parseBackupLedger,
  parseBackupOperationReceipts,
  parseChecksumFile,
  validateDeclaredEntries,
  verifyPayload
};
