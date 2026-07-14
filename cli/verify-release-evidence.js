#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { TextDecoder } = require('node:util');
const {
  evaluateCaptureFile,
  sha256,
  stableJson
} = require('./evaluate-captured-responses');
const {
  PRIVATE_FILE_MODE,
  preparePrivateDirectory
} = require('./lib/fs-safe');

const ROOT = path.resolve(__dirname, '..');
const GATE_NAME = 'scalvin-stable-release-evidence';
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURES = 64;
const REQUIRED_COMPONENTS = [
  'consent-and-data-controls',
  'default-modalities',
  'default-personas',
  'localization-and-accessibility',
  'memory-and-context',
  'runtime',
  'safety-protocol',
  'session-structures'
];
const ARTIFACT_PATHS = Object.freeze({
  manifestSha256: 'manifest.json',
  safetyProtocolSha256: 'safety-protocol.md',
  behavioralCorpusSha256: 'evals/behavioral-release-corpus.json',
  releaseEvidencePolicySha256: 'evals/release-evidence-policy.json',
  safetyCorpusSha256: 'evals/safety-corpus.json',
  sourceBoundaryCorpusSha256: 'evals/source-boundary-corpus.json'
});

class EvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

function exactKeys(value, expected, code = 'EVIDENCE_STRUCTURE_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvidenceError(code, 'The release evidence structure is invalid.');
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new EvidenceError(code, 'The release evidence contains missing or unknown fields.');
  }
}

function decodeUtf8(buffer, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new EvidenceError(code, 'The release evidence is not valid UTF-8.');
  }
}

async function readBoundedRegularFile(filePath, maxBytes) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    throw new EvidenceError('EVIDENCE_PATH_INVALID', 'The release evidence path is invalid.');
  }
  let before;
  try {
    before = await fsp.lstat(filePath);
  } catch {
    throw new EvidenceError('EVIDENCE_UNREADABLE', 'The release evidence cannot be read.');
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new EvidenceError('EVIDENCE_NOT_REGULAR', 'The release evidence must be a regular non-symlink file.');
  }
  if (before.size > maxBytes) {
    throw new EvidenceError('EVIDENCE_TOO_LARGE', 'The compressed release evidence exceeds the byte limit.');
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let handle;
  try {
    handle = await fsp.open(filePath, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new EvidenceError('EVIDENCE_CHANGED', 'The release evidence changed while it was being opened.');
    }
    if (opened.size > maxBytes) {
      throw new EvidenceError('EVIDENCE_TOO_LARGE', 'The compressed release evidence exceeds the byte limit.');
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new EvidenceError('EVIDENCE_TOO_LARGE', 'The compressed release evidence exceeds the byte limit.');
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new EvidenceError('EVIDENCE_CHANGED', 'The release evidence changed while it was being read.');
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('EVIDENCE_UNREADABLE', 'The release evidence cannot be read.');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function parseEnvelope(compressed) {
  let inflated;
  try {
    inflated = zlib.gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch {
    throw new EvidenceError('EVIDENCE_GZIP_INVALID', 'The release evidence is not a valid bounded gzip document.');
  }
  let envelope;
  try {
    envelope = JSON.parse(decodeUtf8(inflated, 'EVIDENCE_UTF8_INVALID'));
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('EVIDENCE_JSON_INVALID', 'The release evidence JSON is invalid.');
  }
  exactKeys(envelope, [
    'schemaVersion',
    'artifactType',
    'review',
    'reviewSignature',
    'reviewerPublicKey',
    'captures'
  ]);
  if (envelope.schemaVersion !== 1 || envelope.artifactType !== 'scalvin-stable-release-evidence') {
    throw new EvidenceError('EVIDENCE_SCHEMA_UNSUPPORTED', 'The release evidence schema is unsupported.');
  }
  if (!Array.isArray(envelope.captures) || envelope.captures.length === 0 || envelope.captures.length > MAX_CAPTURES) {
    throw new EvidenceError('EVIDENCE_CAPTURE_COUNT_INVALID', 'The release evidence capture count is invalid.');
  }
  return envelope;
}

function canonicalTimestamp(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new EvidenceError(code, 'The clinical review timestamp is invalid.');
  }
  return Date.parse(value);
}

function semver(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value);
}

function fullCommit(value) {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function tuplePart(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/.test(value);
}

function nonEmptyText(value, max = 2000) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !value.includes('\0');
}

function validateTextList(value, code, { min = 0, max = 64 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      new Set(value).size !== value.length || value.some((item) => !nonEmptyText(item))) {
    throw new EvidenceError(code, 'A clinical review text list is invalid.');
  }
}

function canonicalLocale(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 35) return null;
  try {
    const canonical = Intl.getCanonicalLocales(value);
    return canonical.length === 1 && canonical[0] === value ? value : null;
  } catch {
    return null;
  }
}

async function currentArtifactHashes() {
  const entries = await Promise.all(Object.entries(ARTIFACT_PATHS).map(async ([key, relative]) => {
    const bytes = await fsp.readFile(path.join(ROOT, relative));
    return [key, sha256(bytes)];
  }));
  return Object.fromEntries(entries);
}

async function bundledLocalePacks() {
  const directory = path.join(ROOT, 'hooks', 'safety-locales');
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const locales = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
  if (locales.length === 0 || locales.some((locale) => canonicalLocale(locale) === null)) {
    throw new EvidenceError('REVIEW_LOCALE_SCOPE_INVALID', 'Bundled locale-pack scope is invalid.');
  }
  return locales;
}

async function releaseEvidencePolicy() {
  let policy;
  try {
    policy = JSON.parse(await fsp.readFile(path.join(ROOT, 'evals', 'release-evidence-policy.json'), 'utf8'));
  } catch {
    throw new EvidenceError('RELEASE_POLICY_INVALID', 'The stable-release evidence policy cannot be read.');
  }
  exactKeys(policy, [
    'schemaVersion',
    'artifactType',
    'requiredClientAdapters',
    'minimumCaptureTuplesPerAdapter',
    'languageContract',
    'localeEvidenceMeaning'
  ], 'RELEASE_POLICY_INVALID');
  if (policy.schemaVersion !== 1 || policy.artifactType !== 'scalvin-release-evidence-policy' ||
      policy.languageContract !== 'language-neutral-bcp47-unicode' ||
      policy.localeEvidenceMeaning !== 'finite-corpus-samples-not-product-language-tiers' ||
      policy.minimumCaptureTuplesPerAdapter !== 1 ||
      !Array.isArray(policy.requiredClientAdapters) || policy.requiredClientAdapters.length === 0 ||
      new Set(policy.requiredClientAdapters).size !== policy.requiredClientAdapters.length ||
      [...policy.requiredClientAdapters].sort().some((item, index) => item !== policy.requiredClientAdapters[index]) ||
      policy.requiredClientAdapters.some((item) => !tuplePart(item))) {
    throw new EvidenceError('RELEASE_POLICY_INVALID', 'The stable-release evidence policy is invalid.');
  }
  return policy;
}

function tupleKey(value) {
  return `${value.provider}\u0000${value.model}\u0000${value.adapter}`;
}

function evidenceMatrixKey(value, locales) {
  return `${tupleKey(value)}\u0000${[...locales].sort().join(',')}`;
}

function validateReviewShape(review, expected) {
  exactKeys(review, [
    'schemaVersion',
    'artifactType',
    'candidate',
    'reviewedAt',
    'validUntil',
    'reviewer',
    'scope',
    'decision',
    'limitations',
    'requiredChanges',
    'unresolvedDisagreements',
    'reReviewTriggers',
    'statement'
  ], 'REVIEW_STRUCTURE_INVALID');
  if (review.schemaVersion !== 1 || review.artifactType !== 'scalvin-independent-clinical-safety-review') {
    throw new EvidenceError('REVIEW_SCHEMA_UNSUPPORTED', 'The clinical review schema is unsupported.');
  }
  exactKeys(review.candidate, ['version', 'commit'], 'REVIEW_CANDIDATE_INVALID');
  if (!semver(review.candidate.version) || !fullCommit(review.candidate.commit) ||
      review.candidate.version !== expected.version || review.candidate.commit !== expected.commit) {
    throw new EvidenceError('REVIEW_CANDIDATE_MISMATCH', 'The clinical review does not belong to the exact release candidate.');
  }

  const reviewedAt = canonicalTimestamp(review.reviewedAt, 'REVIEW_TIMESTAMP_INVALID');
  const validUntil = canonicalTimestamp(review.validUntil, 'REVIEW_EXPIRY_INVALID');
  const now = Date.now();
  if (reviewedAt > now + 10 * 60 * 1000 || validUntil <= reviewedAt || validUntil <= now) {
    throw new EvidenceError('REVIEW_EXPIRED', 'The clinical review is expired or has an invalid validity window.');
  }

  exactKeys(review.reviewer, [
    'role',
    'qualification',
    'independenceAttested',
    'conflictsOfInterest'
  ], 'REVIEW_REVIEWER_INVALID');
  if (!nonEmptyText(review.reviewer.role, 500) || !nonEmptyText(review.reviewer.qualification, 1000) ||
      review.reviewer.independenceAttested !== true || !nonEmptyText(review.reviewer.conflictsOfInterest, 1000)) {
    throw new EvidenceError('REVIEW_REVIEWER_INVALID', 'The independent reviewer attestation is invalid.');
  }

  exactKeys(review.scope, [
    'reviewedComponents',
    'localePackReviews',
    'captureMatrix',
    'artifacts'
  ], 'REVIEW_SCOPE_INVALID');
  if (!Array.isArray(review.scope.reviewedComponents) ||
      review.scope.reviewedComponents.length !== REQUIRED_COMPONENTS.length ||
      [...review.scope.reviewedComponents].sort().some((item, index) => item !== REQUIRED_COMPONENTS[index])) {
    throw new EvidenceError('REVIEW_COMPONENT_SCOPE_INVALID', 'The clinical review component scope is incomplete.');
  }

  exactKeys(review.scope.artifacts, Object.keys(ARTIFACT_PATHS), 'REVIEW_ARTIFACT_SCOPE_INVALID');
  for (const [key, hash] of Object.entries(expected.artifactHashes)) {
    if (review.scope.artifacts[key] !== hash) {
      throw new EvidenceError('REVIEW_ARTIFACT_MISMATCH', 'A reviewed artifact does not match the release candidate.');
    }
  }

  if (!Array.isArray(review.scope.localePackReviews) ||
      review.scope.localePackReviews.length !== expected.locales.length) {
    throw new EvidenceError('REVIEW_LOCALE_SCOPE_INVALID', 'The clinical review locale-pack scope is incomplete.');
  }
  const localeMap = new Map();
  for (const item of review.scope.localePackReviews) {
    exactKeys(item, ['locale', 'fluentReviewerAttested', 'decision', 'limitations'], 'REVIEW_LOCALE_SCOPE_INVALID');
    if (canonicalLocale(item.locale) === null || localeMap.has(item.locale) ||
        item.fluentReviewerAttested !== true || item.decision !== 'approve') {
      throw new EvidenceError('REVIEW_LOCALE_SCOPE_INVALID', 'A locale-pack review is invalid or not approved.');
    }
    validateTextList(item.limitations, 'REVIEW_LOCALE_SCOPE_INVALID', { max: 32 });
    localeMap.set(item.locale, item);
  }
  if (expected.locales.some((locale) => !localeMap.has(locale))) {
    throw new EvidenceError('REVIEW_LOCALE_SCOPE_INVALID', 'A bundled locale pack lacks fluent review.');
  }

  if (!Array.isArray(review.scope.captureMatrix) || review.scope.captureMatrix.length === 0 ||
      review.scope.captureMatrix.length > MAX_CAPTURES) {
    throw new EvidenceError('REVIEW_CAPTURE_SCOPE_INVALID', 'The reviewed capture matrix is invalid.');
  }
  const matrix = new Map();
  for (const item of review.scope.captureMatrix) {
    exactKeys(item, [
      'provider',
      'model',
      'adapter',
      'evaluatedLocales',
      'capturedAt',
      'captureCanonicalSha256',
      'corpusSha256',
      'candidateMetadataSha256',
      'realModelCaptureAttested',
      'captureMethod',
      'provenanceSha256',
      'decision',
      'limitations'
    ], 'REVIEW_CAPTURE_SCOPE_INVALID');
    if (!tuplePart(item.provider) || !tuplePart(item.model) || !tuplePart(item.adapter) || item.decision !== 'approve') {
      throw new EvidenceError('REVIEW_CAPTURE_SCOPE_INVALID', 'A captured-response tuple is invalid or not approved.');
    }
    if (!Array.isArray(item.evaluatedLocales) || item.evaluatedLocales.length === 0 ||
        new Set(item.evaluatedLocales).size !== item.evaluatedLocales.length ||
        item.evaluatedLocales.some((locale) => canonicalLocale(locale) === null) ||
        [...item.evaluatedLocales].sort().some((locale, index) => locale !== item.evaluatedLocales[index])) {
      throw new EvidenceError('REVIEW_CAPTURE_SCOPE_INVALID', 'The evaluated locale set is invalid or non-canonical.');
    }
    canonicalTimestamp(item.capturedAt, 'REVIEW_CAPTURE_SCOPE_INVALID');
    if (![item.captureCanonicalSha256, item.corpusSha256, item.candidateMetadataSha256]
      .every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
      throw new EvidenceError('REVIEW_CAPTURE_SCOPE_INVALID', 'The signed captured-response hashes are invalid.');
    }
    if (item.realModelCaptureAttested !== true ||
        !['provider_api', 'client_export', 'client_hook'].includes(item.captureMethod) ||
        typeof item.provenanceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.provenanceSha256)) {
      throw new EvidenceError('REVIEW_CAPTURE_PROVENANCE_INVALID', 'Real-model capture provenance is missing or invalid.');
    }
    validateTextList(item.limitations, 'REVIEW_CAPTURE_SCOPE_INVALID', { max: 32 });
    const key = evidenceMatrixKey(item, item.evaluatedLocales);
    if (matrix.has(key)) throw new EvidenceError('REVIEW_CAPTURE_SCOPE_INVALID', 'The reviewed capture matrix contains a duplicate tuple.');
    matrix.set(key, item);
  }

  if (review.decision !== 'approve') {
    throw new EvidenceError('REVIEW_NOT_APPROVED', 'The independent clinical and safety review does not approve this stable release.');
  }
  validateTextList(review.limitations, 'REVIEW_DECISION_INVALID', { min: 1 });
  validateTextList(review.requiredChanges, 'REVIEW_DECISION_INVALID');
  validateTextList(review.unresolvedDisagreements, 'REVIEW_DECISION_INVALID');
  validateTextList(review.reReviewTriggers, 'REVIEW_DECISION_INVALID', { min: 1 });
  if (review.requiredChanges.length !== 0 || review.unresolvedDisagreements.length !== 0 ||
      review.statement !== 'I independently reviewed the listed candidate and evidence and approve only the stated scope and limitations.') {
    throw new EvidenceError('REVIEW_DECISION_INVALID', 'The clinical review decision is not an unambiguous scoped approval.');
  }
  return { reviewedAt, validUntil, matrix };
}

function requireAdapterCoverage(matrix, policy) {
  const counts = new Map(policy.requiredClientAdapters.map((adapter) => [adapter, 0]));
  for (const item of matrix.values()) {
    if (counts.has(item.adapter)) counts.set(item.adapter, counts.get(item.adapter) + 1);
  }
  const missing = [...counts].filter(([, count]) => count < policy.minimumCaptureTuplesPerAdapter).map(([adapter]) => adapter);
  if (missing.length > 0) {
    throw new EvidenceError('REVIEW_ADAPTER_SCOPE_INCOMPLETE', 'The signed captured-response matrix does not cover every shipped client adapter.');
  }
}

function verifyReviewSignature(envelope, expectedFingerprint) {
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new EvidenceError('REVIEW_KEY_PIN_INVALID', 'The configured reviewer-key fingerprint is invalid.');
  }
  if (typeof envelope.reviewerPublicKey !== 'string' || envelope.reviewerPublicKey.length > 2000 ||
      typeof envelope.reviewSignature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.reviewSignature)) {
    throw new EvidenceError('REVIEW_SIGNATURE_INVALID', 'The clinical review signature material is invalid.');
  }
  let publicKey;
  let signature;
  try {
    publicKey = crypto.createPublicKey(envelope.reviewerPublicKey);
    signature = Buffer.from(envelope.reviewSignature, 'base64');
  } catch {
    throw new EvidenceError('REVIEW_SIGNATURE_INVALID', 'The clinical review signature material is invalid.');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64) {
    throw new EvidenceError('REVIEW_SIGNATURE_INVALID', 'The clinical review must use an Ed25519 signature.');
  }
  const fingerprint = sha256(publicKey.export({ type: 'spki', format: 'der' }));
  if (fingerprint !== expectedFingerprint) {
    throw new EvidenceError('REVIEW_KEY_MISMATCH', 'The clinical review was not signed by the pinned independent reviewer key.');
  }
  const signed = Buffer.from(stableJson(envelope.review), 'utf8');
  if (!crypto.verify(null, signed, publicKey, signature)) {
    throw new EvidenceError('REVIEW_SIGNATURE_INVALID', 'The clinical review signature is invalid.');
  }
  return fingerprint;
}

async function evaluateCaptures(captures, expected, reviewedAt) {
  const requestedParent = process.env.RUNNER_TEMP || os.tmpdir();
  await fsp.mkdir(requestedParent, { recursive: true });
  const parent = await fsp.realpath(requestedParent);
  const temporary = await fsp.mkdtemp(path.join(parent, 'scalvin-release-evidence-'));
  const results = [];
  try {
    try {
      await preparePrivateDirectory(temporary);
    } catch {
      throw new EvidenceError(
        'EVIDENCE_TEMPORARY_STORAGE_UNSAFE',
        'A private temporary directory could not be prepared for captured-response verification.'
      );
    }
    for (let index = 0; index < captures.length; index += 1) {
      const target = path.join(temporary, `capture-${String(index).padStart(3, '0')}.json`);
      let serialized;
      try {
        serialized = `${JSON.stringify(captures[index])}\n`;
      } catch {
        throw new EvidenceError('EVIDENCE_CAPTURE_INVALID', 'A captured-response document cannot be serialized.');
      }
      try {
        await fsp.writeFile(target, serialized, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
      } catch {
        throw new EvidenceError(
          'EVIDENCE_TEMPORARY_STORAGE_UNSAFE',
          'A captured-response document could not be written to private temporary storage.'
        );
      }
      let result;
      try {
        result = await evaluateCaptureFile(target, { commit: expected.commit, version: expected.version });
      } catch {
        throw new EvidenceError('EVIDENCE_CAPTURE_INVALID', 'A captured-response set is invalid or does not belong to the candidate.');
      }
      if (result.status !== 'pass') {
        throw new EvidenceError('EVIDENCE_CAPTURE_FAILED', 'A real captured-response set failed the behavioral release gate.');
      }
      if (Date.parse(result.candidate.capturedAt) > reviewedAt) {
        throw new EvidenceError('EVIDENCE_CAPTURE_NOT_REVIEWED', 'A captured-response set was created after the signed review.');
      }
      results.push(result);
    }
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  const seen = new Set();
  for (const result of results) {
    const key = evidenceMatrixKey(result.candidate, result.corpus.coverageLocales);
    if (seen.has(key)) throw new EvidenceError('EVIDENCE_CAPTURE_DUPLICATE', 'The release evidence contains a duplicate captured-response tuple.');
    seen.add(key);
  }
  return { results, tupleKeys: seen };
}

function compareCaptureScope(results, matrix) {
  if (results.tupleKeys.size !== matrix.size ||
      [...results.tupleKeys].some((key) => !matrix.has(key))) {
    throw new EvidenceError('REVIEW_CAPTURE_SCOPE_MISMATCH', 'The signed review and captured-response matrix do not match exactly.');
  }
  for (const result of results.results) {
    const key = evidenceMatrixKey(result.candidate, result.corpus.coverageLocales);
    const reviewed = matrix.get(key);
    if (reviewed.capturedAt !== result.candidate.capturedAt ||
        reviewed.captureCanonicalSha256 !== result.capture.canonicalSha256 ||
        reviewed.corpusSha256 !== result.corpus.sha256 ||
        reviewed.candidateMetadataSha256 !== result.capture.candidateMetadataSha256) {
      throw new EvidenceError('REVIEW_CAPTURE_EVIDENCE_MISMATCH', 'A captured-response set is not the exact evidence approved by the signed review.');
    }
  }
}

async function verifyEvidence(inputPath, expected) {
  const compressed = await readBoundedRegularFile(inputPath, MAX_COMPRESSED_BYTES);
  const envelope = parseEnvelope(compressed);
  const artifactHashes = await currentArtifactHashes();
  const locales = await bundledLocalePacks();
  const policy = await releaseEvidencePolicy();
  const signatureFingerprint = verifyReviewSignature(envelope, expected.reviewerKeySha256);
  const review = validateReviewShape(envelope.review, { ...expected, artifactHashes, locales });
  requireAdapterCoverage(review.matrix, policy);
  const captures = await evaluateCaptures(envelope.captures, expected, review.reviewedAt);
  compareCaptureScope(captures, review.matrix);
  return {
    schemaVersion: 1,
    gate: GATE_NAME,
    status: 'pass',
    candidate: { version: expected.version, commit: expected.commit },
    review: {
      sha256: sha256(Buffer.from(stableJson(envelope.review), 'utf8')),
      reviewerKeySha256: signatureFingerprint,
      reviewedAt: envelope.review.reviewedAt,
      validUntil: envelope.review.validUntil,
      localePackCount: locales.length,
      captureTupleCount: captures.results.length,
      requiredClientAdapters: [...policy.requiredClientAdapters]
    },
    captures: captures.results.map((result) => ({
      provider: result.candidate.provider,
      model: result.candidate.model,
      adapter: result.candidate.adapter,
      evaluatedLocales: result.corpus.coverageLocales,
      capturedAt: result.candidate.capturedAt,
      sha256: result.capture.sha256,
      canonicalSha256: result.capture.canonicalSha256,
      corpusSha256: result.corpus.sha256
    }))
  };
}

function takeOption(argv, index, name, current) {
  if (current !== undefined || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
    throw new EvidenceError('ARGUMENT_INVALID', `Use exactly one --${name} value.`);
  }
  return argv[index + 1];
}

function parseArguments(argv) {
  let input;
  let commit;
  let version;
  let reviewerKeySha256;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help') return { help: true };
    if (value === '--input') {
      input = takeOption(argv, index, 'input', input);
      index += 1;
    } else if (value === '--expected-commit') {
      commit = takeOption(argv, index, 'expected-commit', commit);
      index += 1;
    } else if (value === '--expected-version') {
      version = takeOption(argv, index, 'expected-version', version);
      index += 1;
    } else if (value === '--reviewer-key-sha256') {
      reviewerKeySha256 = takeOption(argv, index, 'reviewer-key-sha256', reviewerKeySha256);
      index += 1;
    } else {
      throw new EvidenceError('ARGUMENT_UNKNOWN', 'An unknown command option was provided.');
    }
  }
  if (input === undefined || commit === undefined || version === undefined || reviewerKeySha256 === undefined) {
    throw new EvidenceError('ARGUMENT_REQUIRED', 'Input, exact commit, version, and reviewer-key fingerprint are required.');
  }
  if (!fullCommit(commit) || !semver(version) || !/^[a-f0-9]{64}$/.test(reviewerKeySha256)) {
    throw new EvidenceError('ARGUMENT_INVALID', 'A release-evidence argument is invalid.');
  }
  return { input, commit, version, reviewerKeySha256 };
}

function invalidResult(error) {
  const known = error instanceof EvidenceError;
  return {
    schemaVersion: 1,
    gate: GATE_NAME,
    status: 'invalid',
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'The stable-release evidence could not be verified.'
    }
  };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write('Usage: node cli/verify-release-evidence.js --input <evidence.json.gz> --expected-commit <full-hash> --expected-version <semver> --reviewer-key-sha256 <sha256>\n');
      return 0;
    }
    const result = await verifyEvidence(options.input, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(invalidResult(error))}\n`);
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  ARTIFACT_PATHS,
  EvidenceError,
  REQUIRED_COMPONENTS,
  currentArtifactHashes,
  main,
  parseEnvelope,
  releaseEvidencePolicy,
  verifyEvidence
};
