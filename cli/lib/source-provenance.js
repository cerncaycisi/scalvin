'use strict';

const { ScalvinError, invariant } = require('./errors');

const SOURCE_ID_PATTERN = /^src-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSENT_ID_PATTERN = /^consent-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_STATUSES = new Set(['pending_consent', 'ready', 'integrated', 'rejected', 'superseded', 'deleted', 'failed']);
const EXTERNAL_CARE_ROLES = new Set(['therapist', 'psychiatrist', 'psychologist', 'physician', 'coach', 'service', 'care_team', 'unknown']);
const INTEGRATION_STATUSES = new Set(['none', 'proposed', 'approved', 'rejected']);
const MAX_SOURCE_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_RECORD_BYTES = 512 * 1024;
const MAX_PROVENANCE_FIELD_BYTES = 1_000;
const COMMON_FIELDS = new Set([
  'record_kind', 'source_id', 'revision', 'title', 'source_date', 'imported_at', 'imported_by',
  'consent_event_id', 'integrity_sha256', 'byte_length', 'locale', 'content_object', 'trust', 'status',
  'last_integrated_hash', 'last_integrated_at', 'derived_memory_ids', 'proposed_memory_ids', 'error_code', 'error_message'
]);
const IMPORTED_FIELDS = new Set([...COMMON_FIELDS, 'claimed_author', 'claimed_author_role']);
const EXTERNAL_FIELDS = new Set([
  ...COMMON_FIELDS, 'claimed_author', 'claimed_author_role', 'claimed_provider_or_org',
  'user_verified_attribution', 'integration_author_role', 'ai_authored_integration_status'
]);

function provenanceError(message, code, details) {
  return new ScalvinError(message, code, details);
}

function parseSourceFrontmatter(markdown) {
  if (typeof markdown !== 'string' || !markdown.startsWith('---\n')) throw provenanceError('Source record frontmatter is missing.', 'SOURCE_FRONTMATTER_MISSING');
  const end = markdown.indexOf('\n---\n', 4);
  if (end === -1) throw provenanceError('Source record frontmatter is incomplete.', 'SOURCE_FRONTMATTER_MALFORMED');
  const fields = {};
  const lines = markdown.slice(4, end).split('\n');
  for (const line of lines) {
    if (!line.trim()) throw provenanceError('Source record frontmatter contains a blank field line.', 'SOURCE_FRONTMATTER_MALFORMED');
    const match = line.match(/^([a-z][a-z0-9_]*):\s*(.*)$/);
    if (!match) throw provenanceError('Source record frontmatter contains a malformed field.', 'SOURCE_FRONTMATTER_MALFORMED');
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(fields, key)) throw provenanceError('Source record frontmatter contains a duplicate field.', 'SOURCE_FRONTMATTER_DUPLICATE', { field: key });
    const raw = match[2].trim();
    if (Buffer.byteLength(raw) > MAX_PROVENANCE_FIELD_BYTES) throw provenanceError('Source record frontmatter field is too large.', 'SOURCE_FRONTMATTER_MALFORMED', { field: key });
    if (raw.startsWith('"')) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'string') throw new Error('not a string');
        fields[key] = parsed;
      } catch {
        throw provenanceError('Source record frontmatter contains invalid quoted text.', 'SOURCE_FRONTMATTER_MALFORMED', { field: key });
      }
    } else if (raw.startsWith("'")) {
      if (!/^'[^']*'$/.test(raw)) throw provenanceError('Source record frontmatter contains invalid quoted text.', 'SOURCE_FRONTMATTER_MALFORMED', { field: key });
      fields[key] = raw.slice(1, -1);
    } else {
      fields[key] = raw;
    }
    if (/[\0\r\n]/.test(fields[key])) throw provenanceError('Source record frontmatter contains invalid field text.', 'SOURCE_FRONTMATTER_MALFORMED', { field: key });
  }
  const allowed = fields.record_kind === 'external_care_note'
    ? EXTERNAL_FIELDS
    : fields.record_kind === 'imported_source'
      ? IMPORTED_FIELDS
      : null;
  if (!allowed) throw provenanceError('Source record kind is invalid.', 'SOURCE_RECORD_KIND_INVALID');
  const unknown = Object.keys(fields).filter((key) => !allowed.has(key));
  if (unknown.length) throw provenanceError('Source record frontmatter contains an unknown field.', 'SOURCE_FRONTMATTER_UNKNOWN_FIELD', { fields: unknown });
  return fields;
}

function normalizeSourceLocale(value) {
  if (value === undefined || value === null || value === '' || value === 'unknown') return null;
  invariant(typeof value === 'string' && value.length <= 100 && !/[\0\r\n]/.test(value), 'Source locale metadata is invalid.', 'INVALID_SOURCE_LOCALE');
  try {
    return new Intl.Locale(value).toString();
  } catch {
    throw provenanceError('Source locale metadata must be a valid BCP-47 tag.', 'INVALID_SOURCE_LOCALE');
  }
}

function canonicalTimestamp(value) {
  const match = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/) : null;
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone, sign, offsetHour = '00', offsetMinute = '00'] = match;
  if (Number(second) > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute));
  const local = new Date(parsed + offset * 60_000);
  return local.getUTCFullYear() === Number(year)
    && local.getUTCMonth() + 1 === Number(month)
    && local.getUTCDate() === Number(day)
    && local.getUTCHours() === Number(hour)
    && local.getUTCMinutes() === Number(minute)
    && local.getUTCSeconds() === Number(second);
}

function safeRelativeContentObject(value, sourceId, revision) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || value.includes('\n') || value.startsWith('/') || value.split('/').includes('..')) return false;
  const escaped = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^sources/objects/${escaped}/r${String(revision).padStart(4, '0')}--[a-f0-9]{64}\\.source$`, 'i').test(value);
}

function realSourceDate(value) {
  if (value === 'unknown') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseIdArray(value, pattern) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 100) return null;
    const normalized = parsed.map((item) => typeof item === 'string' ? item.toLowerCase() : null);
    if (normalized.some((item) => item === null || !pattern.test(item))) return null;
    if (new Set(normalized).size !== normalized.length) return null;
    return normalized;
  } catch {
    return null;
  }
}

function lintCommon(fields) {
  const findings = [];
  const required = [...COMMON_FIELDS];
  const missing = required.filter((key) => !fields || !Object.prototype.hasOwnProperty.call(fields, key));
  if (missing.length) findings.push({ severity: 'error', code: 'SOURCE_PROVENANCE_INCOMPLETE', message: 'Source record is missing required provenance fields.', details: { missing } });
  if (!fields) return findings;
  if (!SOURCE_ID_PATTERN.test(fields.source_id || '') || fields.source_id !== fields.source_id.toLowerCase()) findings.push({ severity: 'error', code: 'SOURCE_ID_INVALID', message: 'Source record has an invalid source ID.' });
  const revision = Number(fields.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) findings.push({ severity: 'error', code: 'SOURCE_REVISION_INVALID', message: 'Source record has an invalid revision.' });
  if (!canonicalTimestamp(fields.imported_at)) findings.push({ severity: 'error', code: 'SOURCE_IMPORTED_AT_INVALID', message: 'Source import timestamp is invalid.' });
  if (!CONSENT_ID_PATTERN.test(fields.consent_event_id || '')) findings.push({ severity: 'error', code: 'SOURCE_CONSENT_EVENT_INVALID', message: 'Source consent event is invalid.' });
  if (!SHA256_PATTERN.test(fields.integrity_sha256 || '')) findings.push({ severity: 'error', code: 'SOURCE_HASH_INVALID', message: 'Source integrity hash is invalid.' });
  const byteLength = Number(fields.byte_length);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_SOURCE_CONTENT_BYTES) findings.push({ severity: 'error', code: 'SOURCE_BYTE_LENGTH_INVALID', message: 'Source byte length is invalid.' });
  if (fields.trust !== 'untrusted_data') findings.push({ severity: 'error', code: 'SOURCE_TRUST_INVALID', message: 'Source records must remain explicitly untrusted data.' });
  if (!SOURCE_STATUSES.has(fields.status)) findings.push({ severity: 'error', code: 'SOURCE_STATUS_INVALID', message: 'Source lifecycle status is invalid.' });
  if (SOURCE_ID_PATTERN.test(fields.source_id || '') && Number.isSafeInteger(revision) && revision > 0 && !safeRelativeContentObject(fields.content_object, fields.source_id, revision)) {
    findings.push({ severity: 'error', code: 'SOURCE_CONTENT_OBJECT_INVALID', message: 'Source content-object identity is invalid.' });
  }
  if (SHA256_PATTERN.test(fields.integrity_sha256 || '') && !String(fields.content_object || '').endsWith(`--${fields.integrity_sha256}.source`)) findings.push({ severity: 'error', code: 'SOURCE_CONTENT_OBJECT_HASH_MISMATCH', message: 'Source content-object hash does not match its provenance hash.' });
  if (fields.locale && fields.locale !== 'unknown') {
    try {
      if (normalizeSourceLocale(fields.locale) !== fields.locale) findings.push({ severity: 'error', code: 'INVALID_SOURCE_LOCALE', message: 'Source locale metadata must use its canonical BCP-47 form.' });
    } catch (error) { findings.push({ severity: 'error', code: error.code, message: error.message }); }
  }
  if (!realSourceDate(fields.source_date)) findings.push({ severity: 'error', code: 'SOURCE_DATE_INVALID', message: 'Source date is invalid.' });
  if (fields.imported_by !== 'user_request') findings.push({ severity: 'error', code: 'SOURCE_IMPORTER_INVALID', message: 'Source material must be imported by an explicit user request.' });
  const memoryPattern = /^(?:mem|theme|focus)-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (parseIdArray(fields.derived_memory_ids, memoryPattern) === null || parseIdArray(fields.proposed_memory_ids, memoryPattern) === null) findings.push({ severity: 'error', code: 'SOURCE_MEMORY_IDS_INVALID', message: 'Source memory ID provenance is invalid.' });
  const hasIntegratedHash = fields.last_integrated_hash !== 'null';
  const hasIntegratedAt = fields.last_integrated_at !== 'null';
  if (hasIntegratedHash !== hasIntegratedAt || (hasIntegratedHash && (fields.last_integrated_hash !== fields.integrity_sha256 || !canonicalTimestamp(fields.last_integrated_at)))) findings.push({ severity: 'error', code: 'SOURCE_INTEGRATION_PROVENANCE_INVALID', message: 'Source integration provenance is inconsistent.' });
  if (fields.status === 'integrated' && !hasIntegratedHash) findings.push({ severity: 'error', code: 'SOURCE_INTEGRATION_PROVENANCE_INVALID', message: 'Integrated source record lacks an exact integration hash and timestamp.' });
  const hasErrorCode = fields.error_code !== 'null';
  const hasErrorMessage = fields.error_message !== 'null';
  if (hasErrorCode !== hasErrorMessage || (hasErrorCode && !/^[A-Z0-9_]+$/.test(fields.error_code))) findings.push({ severity: 'error', code: 'SOURCE_ERROR_PROVENANCE_INVALID', message: 'Source error provenance is inconsistent.' });
  if (fields.status === 'failed' && !hasErrorCode) findings.push({ severity: 'error', code: 'SOURCE_ERROR_PROVENANCE_INVALID', message: 'Failed source record lacks an error code.' });
  return findings;
}

function lintExternalCareRecord(markdown) {
  let fields;
  try {
    fields = parseSourceFrontmatter(markdown);
  } catch (error) {
    return [{ severity: 'error', code: error.code || 'SOURCE_FRONTMATTER_MALFORMED', message: error.message, ...(error.details ? { details: error.details } : {}) }];
  }
  const findings = lintCommon(fields);
  if (!fields || fields.record_kind !== 'external_care_note') {
    findings.push({ severity: 'error', code: 'EXTERNAL_CARE_KIND_INVALID', message: 'External-care record kind is invalid.' });
    return findings;
  }
  const required = [...EXTERNAL_FIELDS].filter((key) => !COMMON_FIELDS.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(fields, key));
  if (missing.length) findings.push({ severity: 'error', code: 'EXTERNAL_CARE_PROVENANCE_INCOMPLETE', message: 'External-care record is missing required provenance fields.', details: { missing } });
  if (!fields.claimed_author || !fields.claimed_provider_or_org) findings.push({ severity: 'error', code: 'EXTERNAL_CARE_PROVENANCE_INCOMPLETE', message: 'External-care author and provider claims must be explicit or unknown.' });
  if (!EXTERNAL_CARE_ROLES.has(fields.claimed_author_role)) findings.push({ severity: 'error', code: 'EXTERNAL_CARE_ROLE_INVALID', message: 'External-care claimed author role is invalid.' });
  if (!realSourceDate(fields.source_date)) findings.push({ severity: 'error', code: 'EXTERNAL_CARE_SOURCE_DATE_INVALID', message: 'External-care source date is invalid.' });
  if (fields.imported_by !== 'user_request') findings.push({ severity: 'error', code: 'EXTERNAL_CARE_IMPORTER_INVALID', message: 'External-care material must be imported by an explicit user request.' });
  if (!['true', 'false'].includes(fields.user_verified_attribution)) findings.push({ severity: 'error', code: 'EXTERNAL_CARE_VERIFICATION_INVALID', message: 'External-care attribution verification state is invalid.' });
  if (fields.integration_author_role !== 'ai_companion') findings.push({ severity: 'error', code: 'EXTERNAL_CARE_INTEGRATION_AUTHOR_INVALID', message: 'External-care integration text cannot be attributed to a human professional.' });
  if (!INTEGRATION_STATUSES.has(fields.ai_authored_integration_status)) findings.push({ severity: 'error', code: 'EXTERNAL_CARE_AI_INTEGRATION_STATUS_INVALID', message: 'AI-authored integration status is invalid.' });
  if (!markdown.includes('\n## AI-Authored Integration Note\n')) findings.push({ severity: 'error', code: 'EXTERNAL_CARE_AI_LABEL_MISSING', message: 'External-care record lacks the AI-authored integration label.' });
  if (fields.user_verified_attribution === 'false') findings.push({ severity: 'warning', code: 'EXTERNAL_CARE_ATTRIBUTION_UNVERIFIED', message: 'External-care attribution has not been user-verified.' });
  return findings;
}

function lintImportedSourceRecord(markdown) {
  let fields;
  try {
    fields = parseSourceFrontmatter(markdown);
  } catch (error) {
    return [{ severity: 'error', code: error.code || 'SOURCE_FRONTMATTER_MALFORMED', message: error.message, ...(error.details ? { details: error.details } : {}) }];
  }
  const findings = lintCommon(fields);
  if (!fields || fields.record_kind !== 'imported_source') findings.push({ severity: 'error', code: 'SOURCE_RECORD_KIND_INVALID', message: 'Imported-source record kind is invalid.' });
  if (fields) {
    const required = [...IMPORTED_FIELDS].filter((key) => !COMMON_FIELDS.has(key));
    const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(fields, key));
    if (missing.length) findings.push({ severity: 'error', code: 'SOURCE_PROVENANCE_INCOMPLETE', message: 'Imported-source record is missing required provenance fields.', details: { missing } });
    if (!fields.claimed_author || !/^[a-z][a-z0-9_-]{0,99}$/.test(fields.claimed_author_role || '')) findings.push({ severity: 'error', code: 'SOURCE_PROVENANCE_INCOMPLETE', message: 'Imported-source claimed author provenance is invalid.' });
  }
  return findings;
}

function validateExternalCareRecord(markdown) {
  const findings = lintExternalCareRecord(markdown);
  const error = findings.find((item) => item.severity === 'error');
  if (error) throw provenanceError(error.message, error.code, error.details);
  return { fields: parseSourceFrontmatter(markdown), findings };
}

function validateImportedSourceRecord(markdown) {
  const findings = lintImportedSourceRecord(markdown);
  const error = findings.find((item) => item.severity === 'error');
  if (error) throw provenanceError(error.message, error.code, error.details);
  return { fields: parseSourceFrontmatter(markdown), findings };
}

module.exports = {
  SOURCE_ID_PATTERN,
  CONSENT_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_STATUSES,
  EXTERNAL_CARE_ROLES,
  MAX_SOURCE_RECORD_BYTES,
  parseSourceFrontmatter,
  normalizeSourceLocale,
  lintExternalCareRecord,
  lintImportedSourceRecord,
  validateExternalCareRecord,
  validateImportedSourceRecord
};
