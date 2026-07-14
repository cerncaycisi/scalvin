'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScalvinError, invariant } = require('./lib/errors');
const {
  PRIVATE_FILE_MODE,
  resolvePortablePath,
  assertInside,
  validateRelativePath,
  rejectSymlinkPath,
  ensurePrivateDir,
  atomicWriteFile,
  fsyncDirectory,
  pathExists,
  sha256Buffer,
  walkTree,
  readBoundedRegularFile
} = require('./lib/fs-safe');
const { inspectSource, MAX_SOURCE_BYTES, SOURCE_POLICY } = require('./source-inspect');
const { memoryBlocks, knownBackupCount, confirmationToken } = require('./memory-data');
const {
  SOURCE_ID_PATTERN,
  CONSENT_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_STATUSES,
  EXTERNAL_CARE_ROLES,
  normalizeSourceLocale,
  validateExternalCareRecord,
  validateImportedSourceRecord,
  parseSourceFrontmatter
} = require('./lib/source-provenance');

const MEMORY_ID_PATTERN = /^(?:mem|theme|focus)-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = new Set(['imported_source', 'external_care_note']);
const LEDGER_RELATIVE = '.therapy/state/SOURCE-LEDGER.md';
const LEDGER_HEADER = '| Source ID | Revision | Imported at | Source date | Kind | Claimed author role | Locale | SHA-256 | Bytes | Trust | Status | Consent event | Retention | Last integrated hash | Last integrated at | Derived memory IDs | Error code | Error message |';
const LEDGER_SEPARATOR = '|---|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|';
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_PROPOSED_MEMORIES = 100;
const MAX_TEXT_FIELD = 500;
const PLAN_INTERNAL = Symbol('source-removal-plan');

function compareCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourceError(message, code, details) {
  return new ScalvinError(message, code, details);
}

function strictTimestamp(value, label = 'Timestamp') {
  const match = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/) : null;
  invariant(match, `${label} must be canonical RFC 3339.`, 'INVALID_TIMESTAMP');
  const [, year, month, day, hour, minute, second, zone, sign, offsetHour = '00', offsetMinute = '00'] = match;
  invariant(Number(second) <= 59 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59, `${label} must be canonical RFC 3339.`, 'INVALID_TIMESTAMP');
  const epoch = Date.parse(value);
  invariant(!Number.isNaN(epoch), `${label} must be canonical RFC 3339.`, 'INVALID_TIMESTAMP');
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute));
  const local = new Date(epoch + offset * 60_000);
  invariant(local.getUTCFullYear() === Number(year) && local.getUTCMonth() + 1 === Number(month) && local.getUTCDate() === Number(day) && local.getUTCHours() === Number(hour) && local.getUTCMinutes() === Number(minute) && local.getUTCSeconds() === Number(second), `${label} must be a real RFC 3339 instant.`, 'INVALID_TIMESTAMP');
  return value;
}

function textField(value, fallback = 'unknown') {
  if (value === undefined || value === null || value === '') return fallback;
  invariant(typeof value === 'string' && value.length <= MAX_TEXT_FIELD && !/[\0\r\n]/.test(value), 'Source provenance text is invalid.', 'INVALID_SOURCE_PROVENANCE');
  return value;
}

function claimedRole(value) {
  const role = textField(value, 'unknown');
  invariant(/^[a-z][a-z0-9_-]{0,99}$/.test(role), 'Claimed author role is invalid.', 'INVALID_SOURCE_PROVENANCE');
  return role;
}

function retentionPolicy(value) {
  return ['until_deleted', 'do_not_store'].includes(value) ? value : null;
}

function sourceDate(value) {
  const result = textField(value, 'unknown');
  invariant(result === 'unknown' || /^\d{4}-\d{2}-\d{2}$/.test(result), 'Source date must be YYYY-MM-DD or unknown.', 'INVALID_SOURCE_DATE');
  if (result !== 'unknown') {
    const parsed = new Date(`${result}T00:00:00.000Z`);
    invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === result, 'Source date is not a real calendar date.', 'INVALID_SOURCE_DATE');
  }
  return result;
}

function assertExactSourcePathSyntax(value) {
  invariant(typeof value === 'string' && value.trim() && !/[\0\r\n]/.test(value), 'One exact source file path is required.', 'INVALID_SOURCE_PATH');
  const segments = value.replaceAll('\\', '/').split('/');
  invariant(!segments.includes('..'), 'Source path traversal is not allowed.', 'SOURCE_PATH_TRAVERSAL');
}

function normalizedSourceId(value) {
  invariant(typeof value === 'string' && SOURCE_ID_PATTERN.test(value), 'Source ID is invalid.', 'INVALID_SOURCE_ID');
  return value.toLowerCase();
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function resolveManaged(workspace, relative) {
  const normalized = validateRelativePath(relative);
  const root = path.resolve(workspace);
  const absolute = path.resolve(root, normalized);
  assertInside(root, absolute, 'Source lifecycle target');
  return absolute;
}

async function readManagedOptional(workspace, relative, maxBytes = MAX_REFERENCE_BYTES) {
  const filename = resolveManaged(workspace, relative);
  try {
    return await readBoundedRegularFile(filename, maxBytes, {
      typeCode: 'UNSUPPORTED_FILE_TYPE',
      sizeCode: 'SOURCE_RECORD_TOO_LARGE',
      changedCode: 'SOURCE_ARTIFACT_CHANGED'
    });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function perImportDecision(proof, category) {
  if (!proof || proof.approved !== true || proof.category !== category || !CONSENT_ID_PATTERN.test(proof.eventId || '')) return null;
  const retention = retentionPolicy(proof.retention);
  invariant(retention !== null, 'This per-import retention policy is unsupported.', 'UNSUPPORTED_RETENTION_POLICY', {
    value: proof.retention,
    supported: ['until_deleted', 'do_not_store']
  });
  if (retention === 'do_not_store') return null;
  return { eventId: proof.eventId, retention };
}

function categoryDecision(canonicalState, category, proof) {
  const consent = canonicalState?.consent;
  if (!consent) return { allowed: false, reason: 'consent_state_missing' };
  const pause = consent.memoryPause?.state || 'none';
  if (pause !== 'none') return { allowed: false, reason: pause };
  if (consent.usageLedgers !== 'on') return { allowed: false, reason: 'usage_ledgers_off' };
  const field = category === 'imported_sources' ? 'importedSources' : 'externalCare';
  const retention = retentionPolicy(consent.retention?.[category]);
  if (consent[field] === 'on' && retention === 'until_deleted') {
    const eventId = consent.decisions?.[category]?.eventId;
    if (CONSENT_ID_PATTERN.test(eventId || '')) return { allowed: true, eventId, retention };
  }
  if (consent[field] === 'ask_each_import') {
    const explicit = perImportDecision(proof, category);
    if (explicit) return { allowed: true, ...explicit };
  }
  return { allowed: false, reason: consent[field] === 'off' ? `${category}_off` : `${category}_consent_required` };
}

function sourceConsentDecision(canonicalState, kind, options = {}) {
  const imported = categoryDecision(canonicalState, 'imported_sources', options.importConsent);
  if (!imported.allowed) return imported;
  if (kind !== 'external_care_note') return imported;
  const external = categoryDecision(canonicalState, 'external_care_records', options.externalCareConsent);
  if (!external.allowed) return external;
  return { allowed: true, eventId: external.eventId, retention: external.retention, importedEventId: imported.eventId };
}

function ledgerCell(value) {
  return String(value ?? 'null').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
}

function parseIdList(value) {
  if (!value || value === 'none' || value === 'null') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseLedger(markdown) {
  invariant(typeof markdown === 'string' && markdown.includes(LEDGER_HEADER) && markdown.includes(LEDGER_SEPARATOR), 'Source ledger schema is invalid.', 'SOURCE_LEDGER_INVALID');
  const records = [];
  const identities = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\|\s*src-[0-9a-f-]{36}\s*\|/i.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('\\|', '|'));
    invariant(cells.length === 18, 'Source ledger row has an invalid field count.', 'SOURCE_LEDGER_INVALID');
    const [sourceId, revisionRaw, importedAt, sourceDateValue, kind, claimedAuthorRole, locale, sha256, bytesRaw, trust, status, consentEventId, retention, lastIntegratedHash, lastIntegratedAt, derivedRaw, errorCode, errorMessage] = cells;
    const revision = Number(revisionRaw);
    const byteLength = Number(bytesRaw);
    invariant(SOURCE_ID_PATTERN.test(sourceId) && sourceId === sourceId.toLowerCase() && Number.isSafeInteger(revision) && revision > 0 && SHA256_PATTERN.test(sha256) && Number.isSafeInteger(byteLength) && byteLength >= 0 && SOURCE_KINDS.has(kind) && SOURCE_STATUSES.has(status), 'Source ledger row identity is invalid.', 'SOURCE_LEDGER_INVALID');
    const identity = `${sourceId}@${revision}`;
    invariant(!identities.has(identity), 'Source ledger contains a duplicate source revision.', 'SOURCE_LEDGER_DUPLICATE');
    identities.add(identity);
    records.push({
      sourceId, revision, importedAt, sourceDate: sourceDateValue, kind, claimedAuthorRole,
      locale: locale === 'unknown' ? null : locale, sha256, byteLength, trust, status,
      consentEventId, retention,
      lastIntegratedHash: lastIntegratedHash === 'null' ? null : lastIntegratedHash,
      lastIntegratedAt: lastIntegratedAt === 'null' ? null : lastIntegratedAt,
      derivedMemoryIds: parseIdList(derivedRaw),
      error: errorCode === 'null' ? null : { code: errorCode, message: errorMessage }
    });
  }
  return records;
}

function renderLedgerRow(record) {
  const values = [
    record.sourceId, record.revision, record.importedAt, record.sourceDate || 'unknown', record.kind,
    record.claimedAuthorRole || 'unknown', record.locale || 'unknown', record.sha256, record.byteLength,
    'untrusted_data', record.status, record.consentEventId, record.retention,
    record.lastIntegratedHash || 'null', record.lastIntegratedAt || 'null',
    record.derivedMemoryIds?.length ? record.derivedMemoryIds.join(',') : 'none',
    record.error?.code || 'null', record.error?.message || 'null'
  ];
  return `| ${values.map(ledgerCell).join(' | ')} |`;
}

function renderLedger(markdown, records) {
  const lines = markdown.split(/\r?\n/).filter((line) => !/^\|\s*src-[0-9a-f-]{36}\s*\|/i.test(line));
  const separator = lines.indexOf(LEDGER_SEPARATOR);
  invariant(separator !== -1 && lines[separator - 1] === LEDGER_HEADER, 'Source ledger schema is invalid.', 'SOURCE_LEDGER_INVALID');
  const rows = [...records].sort((a, b) => compareCodePoint(a.sourceId, b.sourceId) || a.revision - b.revision).map(renderLedgerRow);
  lines.splice(separator + 1, 0, ...rows);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function upsertRecord(records, next) {
  const output = records.filter((item) => !(item.sourceId === next.sourceId && item.revision === next.revision));
  output.push(next);
  return output;
}

async function loadLedger(workspace) {
  const raw = await readManagedOptional(workspace, LEDGER_RELATIVE, MAX_LEDGER_BYTES);
  invariant(raw !== null, 'Source ledger is missing.', 'SOURCE_LEDGER_MISSING');
  const markdown = raw.toString('utf8');
  return { markdown, records: parseLedger(markdown) };
}

function publicSourceRecord(record) {
  return {
    sourceId: record.sourceId,
    revision: record.revision,
    importedAt: record.importedAt,
    sourceDate: record.sourceDate,
    kind: record.kind,
    claimedAuthorRole: record.claimedAuthorRole,
    locale: record.locale,
    sha256: record.sha256,
    byteLength: record.byteLength,
    trust: 'untrusted_data',
    status: record.status,
    retention: record.retention,
    lastIntegratedHash: record.lastIntegratedHash,
    lastIntegratedAt: record.lastIntegratedAt,
    derivedMemoryIds: [...(record.derivedMemoryIds || [])],
    error: record.error ? { ...record.error } : null
  };
}

async function statusSource(options = {}) {
  const ledger = await loadLedger(options.workspace);
  const sourceId = options.sourceId === undefined ? null : normalizedSourceId(options.sourceId);
  let revision = null;
  if (options.revision !== undefined) {
    revision = Number(options.revision);
    invariant(Number.isSafeInteger(revision) && revision > 0, 'Source revision is invalid.', 'INVALID_SOURCE_REVISION');
    invariant(sourceId !== null, 'A source revision lookup also requires a source ID.', 'INVALID_ARGUMENT');
  }
  const records = ledger.records.filter((item) => (!sourceId || item.sourceId === sourceId) && (!revision || item.revision === revision));
  if (sourceId) invariant(records.length > 0, 'Source or source revision was not found.', revision ? 'SOURCE_REVISION_NOT_FOUND' : 'SOURCE_NOT_FOUND');
  return {
    status: sourceId ? 'found' : 'listed',
    sourceId,
    revision,
    recordCount: records.length,
    records: records.map(publicSourceRecord),
    instructionsExecutable: false,
    contentIncluded: false,
    absolutePathIncluded: false,
    written: []
  };
}

function objectPaths(sourceId, revision, sha256) {
  invariant(SOURCE_ID_PATTERN.test(sourceId), 'Source ID is invalid.', 'INVALID_SOURCE_ID');
  invariant(Number.isSafeInteger(revision) && revision > 0, 'Source revision is invalid.', 'INVALID_SOURCE_REVISION');
  invariant(SHA256_PATTERN.test(sha256), 'Source hash is invalid.', 'INVALID_SOURCE_HASH');
  const padded = String(revision).padStart(4, '0');
  return {
    contentObject: `sources/objects/${sourceId}/r${padded}--${sha256}.source`,
    recordObject: `sources/records/${sourceId}--r${padded}.md`
  };
}

function isArchive(sourcePath, data) {
  const lower = sourcePath.toLowerCase();
  if (/\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar|docx|xlsx|pptx|jar|war)$/.test(lower)) return true;
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && [0x03, 0x05, 0x07].includes(data[2])) return true;
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return true;
  if (data.length >= 6 && data.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return true;
  if (data.length >= 7 && data.subarray(0, 7).toString('ascii') === 'Rar!\x1a\x07') return true;
  if (data.length >= 262 && data.subarray(257, 262).toString('ascii') === 'ustar') return true;
  return false;
}

function sameStat(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readExactSource(input, inspection, options = {}) {
  let absolute;
  try {
    absolute = resolvePortablePath(input, { cwd: options.cwd || process.cwd() });
  } catch {
    throw sourceError('Source path is invalid.', 'INVALID_SOURCE_PATH');
  }
  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    handle = await fsp.open(absolute, flags);
    const before = await handle.stat();
    invariant(before.isFile(), 'Source must be a regular file.', 'SOURCE_NOT_REGULAR_FILE');
    invariant(before.size <= MAX_SOURCE_BYTES, 'Source exceeds the import size limit.', 'SOURCE_TOO_LARGE', { maxBytes: MAX_SOURCE_BYTES });
    const chunks = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SOURCE_BYTES - bytes + 1));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      invariant(bytes <= MAX_SOURCE_BYTES, 'Source exceeds the import size limit.', 'SOURCE_TOO_LARGE', { maxBytes: MAX_SOURCE_BYTES });
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    const after = await handle.stat();
    invariant(sameStat(before, after) && bytes === after.size, 'Source changed during import; retry with a stable file.', 'SOURCE_CHANGED_DURING_IMPORT');
    const data = Buffer.concat(chunks, bytes);
    const sha256 = sha256Buffer(data);
    invariant(sha256 === inspection.sha256 && bytes === inspection.byteLength, 'Source changed between inspection and import.', 'SOURCE_CHANGED_DURING_IMPORT');
    const verified = await inspectSource(input, { cwd: options.cwd || process.cwd() });
    invariant(verified.sha256 === sha256 && verified.byteLength === bytes, 'Source changed during import verification.', 'SOURCE_CHANGED_DURING_IMPORT');
    if (isArchive(input, data)) throw sourceError('Archive and package sources are unsupported; select one exact extracted regular file.', 'SOURCE_ARCHIVE_UNSUPPORTED');
    return { data, sha256, byteLength: bytes };
  } catch (error) {
    if (error instanceof ScalvinError) throw error;
    if (error.code === 'ELOOP') throw sourceError('Source paths cannot contain symbolic links.', 'SOURCE_SYMLINK_REJECTED');
    throw sourceError('Source read failed.', 'SOURCE_READ_FAILED', { causeCode: error.code || 'UNKNOWN' });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function exclusiveCreate(filename, data) {
  const directory = path.dirname(filename);
  await rejectSymlinkPath(directory, { allowMissing: true });
  await ensurePrivateDir(directory);
  await rejectSymlinkPath(filename, { allowMissing: true });
  const temp = path.join(directory, `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const marker = `${filename}.incomplete`;
  let handle;
  let created = false;
  let markerCreated = false;
  try {
    handle = await fsp.open(temp, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== 'win32') await fsp.chmod(temp, PRIVATE_FILE_MODE);
    try {
      if (process.env.SCALVIN_TEST_FORCE_NO_HARDLINK === '1') {
        throw Object.assign(new Error('forced hard-link unavailability'), { code: 'ENOTSUP' });
      }
      await fsp.link(temp, filename);
      created = true;
    } catch (error) {
      if (error.code === 'EEXIST') throw sourceError('Source artifact already exists and was not overwritten.', 'SOURCE_ARTIFACT_COLLISION');
      if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
      const markerHandle = await fsp.open(marker, 'wx', PRIVATE_FILE_MODE);
      markerCreated = true;
      await markerHandle.writeFile('incomplete source artifact activation\n');
      await markerHandle.sync();
      await markerHandle.close();
      await fsp.copyFile(temp, filename, fs.constants.COPYFILE_EXCL);
      created = true;
      if (process.platform !== 'win32') await fsp.chmod(filename, PRIVATE_FILE_MODE);
      const target = await fsp.open(filename, 'r+');
      try { await target.sync(); } finally { await target.close(); }
      await fsyncDirectory(directory);
      await fsp.rm(marker, { force: true });
      markerCreated = false;
    }
    await fsyncDirectory(directory);
  } catch (error) {
    if (created) await fsp.rm(filename, { force: true }).catch(() => {});
    if (markerCreated) await fsp.rm(marker, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

function testFailpoint(name) {
  if (process.env.SCALVIN_TEST_SOURCE_FAILPOINT === name) throw sourceError(`Injected source lifecycle failure at ${name}.`, 'TEST_FAILPOINT');
}

async function snapshotPath(workspace, relative) {
  const data = await readManagedOptional(workspace, relative);
  return data === null ? { exists: false, data: null } : { exists: true, data };
}

async function applyTransaction(workspace, plan, label) {
  const creates = [...(plan.creates || new Map()).entries()].sort(([a], [b]) => compareCodePoint(a, b));
  const writes = [...(plan.writes || new Map()).entries()].sort(([a], [b]) => compareCodePoint(a, b));
  const deletes = [...(plan.deletes || [])].sort(compareCodePoint);
  const snapshots = new Map();
  for (const relative of [...new Set([...writes.map(([item]) => item), ...deletes])]) snapshots.set(relative, await snapshotPath(workspace, relative));
  for (const [relative, expected] of plan.expected || []) {
    const current = snapshots.get(relative) || await snapshotPath(workspace, relative);
    invariant(current.exists === expected.exists && (!current.exists || current.data.equals(expected.data)), 'Source operation plan is stale; regenerate it before confirmation.', 'SOURCE_PLAN_STALE');
  }
  for (const [relative] of creates) invariant(!(await pathExists(resolveManaged(workspace, relative))), 'Source create target already exists.', 'SOURCE_ARTIFACT_COLLISION');
  const created = [];
  const deleted = [];
  const written = [];
  try {
    for (const [relative, data] of creates) {
      await exclusiveCreate(resolveManaged(workspace, relative), data);
      created.push(relative);
    }
    testFailpoint(`${label}-after-create`);
    for (const [relative, data] of writes) {
      await atomicWriteFile(resolveManaged(workspace, relative), data, { mode: PRIVATE_FILE_MODE });
      written.push(relative);
    }
    testFailpoint(`${label}-after-write`);
    for (const relative of deletes) {
      const filename = resolveManaged(workspace, relative);
      await rejectSymlinkPath(filename, { allowMissing: true });
      await fsp.rm(filename, { force: true });
      deleted.push(relative);
    }
    testFailpoint(`${label}-after-delete`);
    return { created, written, deleted };
  } catch (error) {
    let rollbackError = null;
    try {
      for (const relative of created) await fsp.rm(resolveManaged(workspace, relative), { force: true });
      for (const [relative, snapshot] of snapshots) {
        const filename = resolveManaged(workspace, relative);
        if (snapshot.exists) await atomicWriteFile(filename, snapshot.data, { mode: PRIVATE_FILE_MODE });
        else await fsp.rm(filename, { force: true });
      }
    } catch (rollback) {
      rollbackError = rollback.code || 'UNKNOWN';
    }
    if (rollbackError) throw sourceError('Source transaction failed and rollback was incomplete.', 'SOURCE_ROLLBACK_FAILED', { causeCode: error.code || 'UNKNOWN', rollbackCode: rollbackError });
    throw error;
  }
}

function safeOperationError(error) {
  const allowed = error instanceof ScalvinError && /^[A-Z0-9_]+$/.test(error.code || '');
  return allowed
    ? { code: error.code, message: String(error.message).replace(/[\r\n|]/g, ' ').slice(0, 300) }
    : { code: 'SOURCE_OPERATION_FAILED', message: 'Source operation failed.' };
}

function recordPathsForLedger(record) {
  return objectPaths(record.sourceId, record.revision, record.sha256);
}

function canonicalSourcePatch(record, paths, operation = 'upsert') {
  return {
    sourceLifecycle: {
      operation,
      sourceId: record.sourceId,
      revision: record.revision,
      record: {
        sourceId: record.sourceId,
        revision: record.revision,
        kind: record.kind,
        locale: record.locale || null,
        sha256: record.sha256,
        byteLength: record.byteLength,
        status: record.status,
        trust: 'untrusted_data',
        importedAt: record.importedAt,
        consentEventId: record.consentEventId,
        retention: record.retention,
        contentObject: record.status === 'deleted' || record.status === 'rejected' ? null : paths.contentObject,
        recordObject: record.status === 'deleted' || record.status === 'rejected' ? null : paths.recordObject,
        lastIntegratedHash: record.lastIntegratedHash || null,
        lastIntegratedAt: record.lastIntegratedAt || null,
        derivedMemoryIds: [...(record.derivedMemoryIds || [])],
        error: record.error ? { ...record.error } : null
      }
    }
  };
}

function sourceRecordMarkdown(record, paths, provenance = {}) {
  const common = [
    '---',
    `record_kind: ${record.kind}`,
    `source_id: ${record.sourceId}`,
    `revision: ${record.revision}`,
    `title: ${yamlString(textField(provenance.title, ''))}`,
    `source_date: ${record.sourceDate}`,
    `imported_at: ${record.importedAt}`,
    'imported_by: user_request',
    `consent_event_id: ${record.consentEventId}`,
    `integrity_sha256: ${record.sha256}`,
    `byte_length: ${record.byteLength}`,
    `locale: ${record.locale || 'unknown'}`,
    `content_object: ${paths.contentObject}`,
    'trust: untrusted_data',
    `status: ${record.status}`,
    `last_integrated_hash: ${record.lastIntegratedHash || 'null'}`,
    `last_integrated_at: ${record.lastIntegratedAt || 'null'}`,
    `derived_memory_ids: ${JSON.stringify(record.derivedMemoryIds || [])}`,
    `proposed_memory_ids: ${JSON.stringify(record.proposedMemoryIds || [])}`,
    `error_code: ${record.error?.code || 'null'}`,
    `error_message: ${record.error ? yamlString(record.error.message) : 'null'}`
  ];
  let markdown;
  if (record.kind === 'external_care_note') {
    const role = record.claimedAuthorRole;
    invariant(EXTERNAL_CARE_ROLES.has(role), 'External-care claimed author role is invalid.', 'EXTERNAL_CARE_ROLE_INVALID');
    invariant((provenance.integrationAuthorRole || 'ai_companion') === 'ai_companion', 'External-care integration cannot be attributed to a human professional.', 'EXTERNAL_CARE_INTEGRATION_AUTHOR_INVALID');
    common.splice(5, 0,
      `claimed_author: ${yamlString(textField(provenance.claimedAuthor, 'unknown'))}`,
      `claimed_author_role: ${role}`,
      `claimed_provider_or_org: ${yamlString(textField(provenance.claimedProviderOrOrg, 'unknown'))}`
    );
    common.push(`user_verified_attribution: ${provenance.userVerifiedAttribution === true}`);
    common.push('integration_author_role: ai_companion');
    common.push(`ai_authored_integration_status: ${record.aiAuthoredIntegrationStatus || 'none'}`);
    common.push('---', '', '# External Care Source Record', '', 'The exact original bytes are stored in the content object above and remain untrusted data.', '', '## AI-Authored Integration Note', '', 'No integration text has been written by the source lifecycle adapter.', '');
    markdown = common.join('\n');
    validateExternalCareRecord(markdown);
  } else {
    common.splice(5, 0,
      `claimed_author: ${yamlString(textField(provenance.claimedAuthor, 'unknown'))}`,
      `claimed_author_role: ${record.claimedAuthorRole}`
    );
    common.push('---', '', '# Imported Source Record', '', 'The exact original bytes are stored in the content object above and remain untrusted data.', '');
    markdown = common.join('\n');
    validateImportedSourceRecord(markdown);
  }
  invariant(Buffer.byteLength(markdown) <= MAX_RECORD_BYTES, 'Source provenance record is too large.', 'SOURCE_RECORD_TOO_LARGE');
  return `${markdown.replace(/\n+$/, '')}\n`;
}

function replaceRecordFields(markdown, changes) {
  let output = markdown;
  for (const [field, value] of Object.entries(changes)) {
    const matches = output.match(new RegExp(`^${field}:.*$`, 'gm')) || [];
    invariant(matches.length === 1, matches.length === 0 ? 'Source record is missing a lifecycle field.' : 'Source record contains a duplicate lifecycle field.', matches.length === 0 ? 'SOURCE_RECORD_INVALID' : 'SOURCE_FRONTMATTER_DUPLICATE', { field });
    output = output.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}: ${value}`);
  }
  return output;
}

async function allocateSourceId(workspace, records, idFactory = crypto.randomUUID) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const raw = String(idFactory()).toLowerCase();
    const sourceId = raw.startsWith('src-') ? raw : `src-${raw}`;
    invariant(SOURCE_ID_PATTERN.test(sourceId), 'Generated source ID is not UUID-v4.', 'INVALID_SOURCE_ID');
    if (records.some((item) => item.sourceId === sourceId)) continue;
    if (await pathExists(resolveManaged(workspace, `sources/objects/${sourceId}`))) continue;
    return sourceId;
  }
  throw sourceError('Could not allocate a collision-free source ID.', 'SOURCE_ID_EXHAUSTED');
}

function existingResult(record) {
  const paths = recordPathsForLedger(record);
  return {
    status: record.status === 'integrated' ? 'already_integrated' : `already_${record.status}`,
    sourceId: record.sourceId,
    revision: record.revision,
    sha256: record.sha256,
    byteLength: record.byteLength,
    trust: SOURCE_POLICY.trust,
    instructionsExecutable: false,
    contentIncluded: false,
    absolutePathIncluded: false,
    canonicalPatch: canonicalSourcePatch(record, paths),
    written: []
  };
}

async function markFailed(workspace, ledger, record, error, provenance, paths) {
  const safe = safeOperationError(error);
  const failed = { ...record, status: 'failed', error: safe };
  const nextRecords = upsertRecord(ledger.records, failed);
  const writes = new Map([[LEDGER_RELATIVE, Buffer.from(renderLedger(ledger.markdown, nextRecords))]]);
  const existingRecord = await readManagedOptional(workspace, paths.recordObject, MAX_RECORD_BYTES);
  if (existingRecord !== null) {
    const updated = replaceRecordFields(existingRecord.toString('utf8'), { status: 'failed', error_code: safe.code, error_message: yamlString(safe.message) });
    writes.set(paths.recordObject, Buffer.from(updated));
  }
  await applyTransaction(workspace, { writes }, 'failure');
  return {
    status: 'failed', sourceId: failed.sourceId, revision: failed.revision, sha256: failed.sha256,
    byteLength: failed.byteLength, trust: 'untrusted_data', contentIncluded: false, absolutePathIncluded: false,
    error: safe, canonicalPatch: canonicalSourcePatch(failed, paths), written: [LEDGER_RELATIVE, ...(existingRecord ? [paths.recordObject] : [])]
  };
}

async function importSource(options = {}) {
  const kind = options.kind || 'imported_source';
  invariant(SOURCE_KINDS.has(kind), 'Source kind is invalid.', 'INVALID_SOURCE_KIND');
  const consent = sourceConsentDecision(options.canonicalState, kind, options);
  if (!consent.allowed) {
    return {
      status: 'pending_consent', reason: consent.reason, trust: 'untrusted_data',
      instructionsExecutable: false, contentIncluded: false, absolutePathIncluded: false,
      canonicalPatch: null, written: []
    };
  }
  assertExactSourcePathSyntax(options.sourcePath);
  const locale = normalizeSourceLocale(options.locale);
  const importedAt = strictTimestamp(options.now || new Date().toISOString(), 'Source import time');
  const ledger = await loadLedger(options.workspace);
  let sourceId = options.sourceId === undefined || options.sourceId === null ? null : normalizedSourceId(options.sourceId);
  if (sourceId === null) sourceId = await allocateSourceId(options.workspace, ledger.records, options.idFactory);
  const existing = ledger.records.filter((item) => item.sourceId === sourceId).sort((a, b) => a.revision - b.revision);
  if (options.sourceId && existing.length === 0) throw sourceError('Explicit source ID does not exist; omit it for a new source.', 'SOURCE_ID_NOT_FOUND');

  let inspection;
  try {
    inspection = await inspectSource(options.sourcePath, { cwd: options.cwd || process.cwd() });
  } catch (error) {
    const safe = safeOperationError(error);
    return { status: 'failed', sourceId, revision: existing.length ? existing.at(-1).revision : 1, sha256: null, byteLength: null, trust: 'untrusted_data', contentIncluded: false, absolutePathIncluded: false, error: safe, canonicalPatch: null, written: [] };
  }
  if (process.env.SCALVIN_TEST_SOURCE_HOOKS === '1' && typeof options.afterInspect === 'function') await options.afterInspect();

  let exact;
  try {
    exact = await readExactSource(options.sourcePath, inspection, options);
  } catch (error) {
    const safe = safeOperationError(error);
    return { status: 'failed', sourceId, revision: existing.length ? existing.at(-1).revision : 1, sha256: inspection.sha256, byteLength: inspection.byteLength, trust: 'untrusted_data', contentIncluded: false, absolutePathIncluded: false, error: safe, canonicalPatch: null, written: [] };
  }

  const latest = existing.at(-1) || null;
  let revision = 1;
  if (latest) {
    const same = existing.find((item) => item.sha256 === exact.sha256 && (options.revision === undefined || item.revision === Number(options.revision)));
    if (same && same.status !== 'failed') {
      if (!['deleted', 'rejected'].includes(same.status)) await loadSourceArtifacts(options.workspace, same);
      return existingResult(same);
    }
    if (same?.status === 'failed') revision = same.revision;
    else {
      revision = latest.revision + 1;
      if (options.revision !== undefined) invariant(Number(options.revision) === revision, 'Changed source bytes require the next revision number.', 'INVALID_SOURCE_REVISION');
    }
  } else if (options.revision !== undefined) {
    invariant(Number(options.revision) === 1, 'A new source begins at revision 1.', 'INVALID_SOURCE_REVISION');
  }
  if (options.revision !== undefined && latest?.sha256 === exact.sha256) invariant(Number(options.revision) === revision, 'Source revision/hash tuple conflicts with the ledger.', 'SOURCE_REVISION_HASH_CONFLICT');

  const paths = objectPaths(sourceId, revision, exact.sha256);
  const provenance = options.provenance || {};
  const record = {
    sourceId, revision, importedAt, sourceDate: sourceDate(provenance.sourceDate), kind,
    claimedAuthorRole: claimedRole(provenance.claimedAuthorRole), locale,
    sha256: exact.sha256, byteLength: exact.byteLength, status: 'ready',
    consentEventId: consent.eventId, retention: consent.retention,
    lastIntegratedHash: null, lastIntegratedAt: null, derivedMemoryIds: [], proposedMemoryIds: [], error: null,
    aiAuthoredIntegrationStatus: 'none'
  };
  let recordMarkdown;
  try {
    recordMarkdown = sourceRecordMarkdown(record, paths, provenance);
  } catch (error) {
    return markFailed(options.workspace, ledger, record, error, provenance, paths);
  }

  let records = [...ledger.records];
  const writes = new Map();
  const priorActive = existing.filter((item) => item.revision < revision && !['deleted', 'rejected', 'superseded', 'failed'].includes(item.status)).at(-1) || null;
  if (priorActive) {
    const superseded = { ...priorActive, status: 'superseded', error: null };
    records = upsertRecord(records, superseded);
    const latestPaths = recordPathsForLedger(priorActive);
    const previousRecord = await readManagedOptional(options.workspace, latestPaths.recordObject, MAX_RECORD_BYTES);
    if (previousRecord !== null) writes.set(latestPaths.recordObject, Buffer.from(replaceRecordFields(previousRecord.toString('utf8'), { status: 'superseded' })));
  }
  records = upsertRecord(records, record);
  writes.set(LEDGER_RELATIVE, Buffer.from(renderLedger(ledger.markdown, records)));
  const creates = new Map([[paths.contentObject, exact.data], [paths.recordObject, Buffer.from(recordMarkdown)]]);
  try {
    const transaction = await applyTransaction(options.workspace, { creates, writes }, 'import');
    return {
      status: 'ready', sourceId, revision, sha256: exact.sha256, byteLength: exact.byteLength,
      kind, locale, trust: 'untrusted_data', instructionsExecutable: false,
      contentIncluded: false, absolutePathIncluded: false,
      canonicalPatch: canonicalSourcePatch(record, paths),
      written: [...transaction.created, ...transaction.written]
    };
  } catch (error) {
    return markFailed(options.workspace, ledger, record, error, provenance, paths);
  }
}

function validateMemoryIds(ids) {
  invariant(Array.isArray(ids) && ids.length <= MAX_PROPOSED_MEMORIES, 'Proposed memory IDs must be a bounded array.', 'INVALID_PROPOSED_MEMORY_IDS');
  const unique = [...new Set(ids.map((item) => String(item).toLowerCase()))].sort(compareCodePoint);
  invariant(unique.every((item) => MEMORY_ID_PATTERN.test(item)), 'A proposed memory ID is invalid.', 'INVALID_PROPOSED_MEMORY_IDS');
  return unique;
}

async function loadRecordFor(workspace, ledgerRecord) {
  const paths = recordPathsForLedger(ledgerRecord);
  const raw = await readManagedOptional(workspace, paths.recordObject, MAX_RECORD_BYTES);
  invariant(raw !== null, 'Source provenance record is missing.', 'SOURCE_RECORD_MISSING');
  const markdown = raw.toString('utf8');
  if (ledgerRecord.kind === 'external_care_note') validateExternalCareRecord(markdown);
  else validateImportedSourceRecord(markdown);
  const fields = parseSourceFrontmatter(markdown);
  const recordLocale = fields.locale === 'unknown' ? null : fields.locale;
  const recordDerivedIds = JSON.parse(fields.derived_memory_ids);
  invariant(
    fields.source_id === ledgerRecord.sourceId
      && Number(fields.revision) === ledgerRecord.revision
      && fields.integrity_sha256 === ledgerRecord.sha256
      && Number(fields.byte_length) === ledgerRecord.byteLength
      && fields.content_object === paths.contentObject
      && fields.record_kind === ledgerRecord.kind
      && fields.status === ledgerRecord.status
      && fields.imported_at === ledgerRecord.importedAt
      && fields.consent_event_id === ledgerRecord.consentEventId
      && recordLocale === ledgerRecord.locale
      && fields.last_integrated_hash === (ledgerRecord.lastIntegratedHash || 'null')
      && fields.last_integrated_at === (ledgerRecord.lastIntegratedAt || 'null')
      && JSON.stringify(recordDerivedIds) === JSON.stringify(ledgerRecord.derivedMemoryIds || []),
    'Source record does not match ledger identity.',
    'SOURCE_RECORD_IDENTITY_MISMATCH'
  );
  return { paths, markdown, fields };
}

async function loadSourceArtifacts(workspace, ledgerRecord) {
  const loaded = await loadRecordFor(workspace, ledgerRecord);
  const content = await readManagedOptional(workspace, loaded.paths.contentObject, MAX_SOURCE_BYTES);
  invariant(content !== null, 'Source content object is missing.', 'SOURCE_CONTENT_OBJECT_MISSING');
  invariant(content.length === ledgerRecord.byteLength && sha256Buffer(content) === ledgerRecord.sha256, 'Source content object failed its exact integrity check.', 'SOURCE_CONTENT_OBJECT_INTEGRITY_FAILED');
  return loaded;
}

async function integrateSource(options = {}) {
  const sourceId = normalizedSourceId(options.sourceId);
  const ledger = await loadLedger(options.workspace);
  const candidates = ledger.records.filter((item) => item.sourceId === sourceId);
  invariant(candidates.length > 0, 'Source was not found.', 'SOURCE_NOT_FOUND');
  const revision = options.revision === undefined ? Math.max(...candidates.map((item) => item.revision)) : Number(options.revision);
  let record = candidates.find((item) => item.revision === revision);
  invariant(record, 'Source revision was not found.', 'SOURCE_REVISION_NOT_FOUND');
  const consent = sourceConsentDecision(options.canonicalState, record.kind, options);
  if (!consent.allowed) return { status: 'pending_consent', reason: consent.reason, sourceId: record.sourceId, revision, canonicalPatch: null, written: [], contentIncluded: false, absolutePathIncluded: false };
  if (record.status === 'integrated' && record.lastIntegratedHash === record.sha256) return existingResult(record);
  invariant(['ready', 'failed'].includes(record.status), 'Source revision is not ready for integration.', 'SOURCE_STATE_TRANSITION_INVALID', { status: record.status });
  if (options.approved !== true) return { status: 'approval_required', sourceId: record.sourceId, revision, sha256: record.sha256, canonicalPatch: null, written: [], contentIncluded: false, absolutePathIncluded: false };
  invariant(SHA256_PATTERN.test(options.expectedHash || '') && options.expectedHash === record.sha256, 'Integration approval must bind the exact source revision hash.', 'SOURCE_HASH_MISMATCH');
  const proposedMemoryIds = validateMemoryIds(options.proposedMemoryIds || []);
  const loaded = await loadSourceArtifacts(options.workspace, record);
  const now = strictTimestamp(options.now || new Date().toISOString(), 'Source integration time');
  record = { ...record, status: 'integrated', lastIntegratedHash: record.sha256, lastIntegratedAt: now, derivedMemoryIds: proposedMemoryIds, error: null };
  const changes = {
    status: 'integrated',
    last_integrated_hash: record.sha256,
    last_integrated_at: now,
    derived_memory_ids: JSON.stringify(proposedMemoryIds),
    proposed_memory_ids: JSON.stringify(proposedMemoryIds),
    error_code: 'null',
    error_message: 'null'
  };
  if (record.kind === 'external_care_note') changes.ai_authored_integration_status = 'proposed';
  const updatedRecord = replaceRecordFields(loaded.markdown, changes);
  if (record.kind === 'external_care_note') validateExternalCareRecord(updatedRecord);
  else validateImportedSourceRecord(updatedRecord);
  const nextLedger = renderLedger(ledger.markdown, upsertRecord(ledger.records, record));
  const plannedWrites = new Map([[loaded.paths.recordObject, Buffer.from(updatedRecord)], [LEDGER_RELATIVE, Buffer.from(nextLedger)]]);
  const proposedMemoryPatch = {
    sourceId: record.sourceId,
    revision: record.revision,
    sha256: record.sha256,
    writesApplied: false,
    items: proposedMemoryIds.map((id) => ({ id, operation: 'propose', sourceIds: [record.sourceId], status: 'provisional', lastLiveConfirmed: 'never' }))
  };
  const plannedResult = {
    status: options.planOnly ? 'integration_planned' : 'integrated', sourceId: record.sourceId, revision, sha256: record.sha256,
    proposedMemoryIds, proposedMemoryPatch, memoryWritten: false,
    contentIncluded: false, absolutePathIncluded: false,
    canonicalPatch: canonicalSourcePatch(record, loaded.paths), written: []
  };
  Object.defineProperty(plannedResult, 'plannedWrites', { value: plannedWrites, enumerable: false });
  Object.defineProperty(plannedResult, 'contentObject', { value: loaded.paths.contentObject, enumerable: false });
  if (options.planOnly) return plannedResult;
  try {
    const transaction = await applyTransaction(options.workspace, { writes: plannedWrites }, 'integrate');
    return { ...plannedResult, written: transaction.written };
  } catch (error) {
    return markFailed(options.workspace, ledger, { ...record, status: 'ready', lastIntegratedHash: null, lastIntegratedAt: null }, error, {}, loaded.paths);
  }
}

function removeMemoryBlocks(markdown, ids) {
  const selected = memoryBlocks(markdown).filter((block) => ids.includes(block.id));
  let output = markdown;
  for (const block of selected.sort((a, b) => b.start - a.start)) output = `${output.slice(0, block.start)}${output.slice(block.end)}`;
  return output.replace(/\n{3,}/g, '\n\n');
}

function stripReferenceLines(markdown, needles) {
  return markdown.split(/(?<=\n)/).filter((line) => !needles.some((needle) => line.toLowerCase().includes(needle))).join('');
}

async function sourceReferenceWrites(workspace, sourceIds, derivedIds, excluded = new Set()) {
  const writes = new Map();
  const needles = [...sourceIds, ...derivedIds].map((item) => item.toLowerCase());
  const root = path.resolve(workspace);
  for (const entry of await walkTree(root)) {
    if (entry.type !== 'file' || !entry.path.toLowerCase().endsWith('.md') || excluded.has(entry.path)) continue;
    if (entry.path === LEDGER_RELATIVE || entry.path.startsWith('sources/records/') || entry.path.startsWith('.therapy/runtime/') || entry.path.startsWith('.therapy/library/')) continue;
    if (entry.size > MAX_REFERENCE_BYTES) throw sourceError('A source-derived reference file exceeds the cleanup limit.', 'SOURCE_REFERENCE_TOO_LARGE');
    const raw = await readManagedOptional(workspace, entry.path, MAX_REFERENCE_BYTES);
    invariant(raw !== null, 'A source-derived reference changed during cleanup planning.', 'SOURCE_REFERENCE_CHANGED');
    const original = raw.toString('utf8');
    let updated = ['profile.md', 'ACTIVE-THEMES.md', 'CURRENT-FOCUS.md', 'sources/client-told-memories.md'].includes(entry.path)
      ? removeMemoryBlocks(original, derivedIds)
      : original;
    updated = stripReferenceLines(updated, needles);
    if (updated !== original) writes.set(entry.path, Buffer.from(updated));
  }
  return writes;
}

async function planSourceRemoval(options = {}) {
  invariant(['reject', 'delete'].includes(options.action), 'Source removal action must be reject or delete.', 'INVALID_ARGUMENT');
  const sourceId = normalizedSourceId(options.sourceId);
  const ledger = await loadLedger(options.workspace);
  const all = ledger.records.filter((item) => item.sourceId === sourceId).sort((a, b) => a.revision - b.revision);
  invariant(all.length > 0, 'Source was not found.', 'SOURCE_NOT_FOUND');
  const selected = options.action === 'delete'
    ? all
    : [all.find((item) => item.revision === (options.revision === undefined ? all.at(-1).revision : Number(options.revision)))].filter(Boolean);
  invariant(selected.length > 0, 'Source revision was not found.', 'SOURCE_REVISION_NOT_FOUND');
  if (options.action === 'reject') invariant(selected[0].status !== 'deleted', 'A deleted source revision cannot transition back to rejected.', 'SOURCE_STATE_TRANSITION_INVALID');
  const status = options.action === 'delete' ? 'deleted' : 'rejected';
  const deletes = [];
  const excluded = new Set();
  const selectedKeys = new Set(selected.map((item) => `${item.sourceId}@${item.revision}`));
  const retainedDerivedIds = new Set(ledger.records
    .filter((item) => !selectedKeys.has(`${item.sourceId}@${item.revision}`) && !['deleted', 'rejected'].includes(item.status))
    .flatMap((item) => item.derivedMemoryIds || []));
  const derivedIds = [...new Set(selected.flatMap((item) => item.derivedMemoryIds || []))].filter((item) => !retainedDerivedIds.has(item));
  let nextRecords = [...ledger.records];
  for (const item of selected) {
    const paths = recordPathsForLedger(item);
    deletes.push(paths.contentObject, paths.recordObject);
    excluded.add(paths.recordObject);
    nextRecords = upsertRecord(nextRecords, { ...item, status, error: null });
  }
  const writes = await sourceReferenceWrites(options.workspace, [sourceId], derivedIds, excluded);
  writes.set(LEDGER_RELATIVE, Buffer.from(renderLedger(ledger.markdown, nextRecords)));
  const expected = new Map();
  for (const relative of new Set([...writes.keys(), ...deletes])) expected.set(relative, await snapshotPath(options.workspace, relative));
  const selector = `${sourceId}@${selected.map((item) => item.revision).join(',')}`;
  const token = confirmationToken(options.canonicalState?.workspaceId || 'unknown-workspace', `source-${options.action}`, selector);
  const backups = await knownBackupCount(options.workspace);
  const plan = {
    status: 'confirmation_required', action: options.action, sourceId,
    revisions: selected.map((item) => item.revision), affectedPaths: [...new Set([...writes.keys(), ...deletes])].sort(),
    derivedMemoryIds: derivedIds, knownBackupRecords: backups, backupActionRequired: backups > 0,
    confirmationToken: token, contentIncluded: false, absolutePathIncluded: false
  };
  Object.defineProperty(plan, 'plannedWriteHashes', {
    value: [...writes.entries()].map(([relative, content]) => ({
      path: relative,
      sha256: crypto.createHash('sha256').update(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')).digest('hex')
    })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    enumerable: false
  });
  Object.defineProperty(plan, PLAN_INTERNAL, { value: { writes, deletes, expected, selected, status, nextRecords }, enumerable: false });
  return plan;
}

async function applySourceRemoval(options = {}) {
  const plan = options.plan || await planSourceRemoval(options);
  invariant(options.confirm === true && options.confirmationToken === plan.confirmationToken, 'Source removal requires the exact confirmation token.', 'SOURCE_CONFIRMATION_REQUIRED');
  const internal = plan[PLAN_INTERNAL];
  invariant(internal, 'Source removal plan must be regenerated before execution.', 'SOURCE_PLAN_REQUIRED');
  try {
    const transaction = await applyTransaction(options.workspace, { writes: internal.writes, deletes: internal.deletes, expected: internal.expected }, 'remove');
    const patches = internal.selected.map((item) => {
      const changed = { ...item, status: internal.status, error: null };
      return canonicalSourcePatch(changed, recordPathsForLedger(item), internal.status === 'deleted' ? 'delete' : 'upsert').sourceLifecycle;
    });
    return {
      status: internal.status, action: plan.action, sourceId: plan.sourceId, revisions: plan.revisions,
      derivedMemoryIdsRemoved: plan.derivedMemoryIds, knownBackupRecords: plan.knownBackupRecords,
      backupActionRequired: plan.backupActionRequired, contentIncluded: false, absolutePathIncluded: false,
      canonicalPatch: { sourceLifecycle: { operation: internal.status === 'deleted' ? 'delete_many' : 'upsert_many', records: patches } },
      written: transaction.written, deleted: transaction.deleted
    };
  } catch (error) {
    const safe = safeOperationError(error);
    return { status: 'failed', action: plan.action, sourceId: plan.sourceId, revisions: plan.revisions, error: safe, canonicalPatch: null, written: [], deleted: [], contentIncluded: false, absolutePathIncluded: false };
  }
}

module.exports = {
  LEDGER_RELATIVE,
  LEDGER_HEADER,
  LEDGER_SEPARATOR,
  SOURCE_KINDS,
  sourceConsentDecision,
  parseLedger,
  renderLedger,
  objectPaths,
  canonicalSourcePatch,
  statusSource,
  importSource,
  integrateSource,
  planSourceRemoval,
  applySourceRemoval
};
