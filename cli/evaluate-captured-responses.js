#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const CORPUS_PATH = path.join(ROOT, 'evals', 'behavioral-release-corpus.json');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const CORPUS_MAX_BYTES = 1024 * 1024;
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const GATE_NAME = 'scalvin-captured-response';
const MODALITY_CATEGORY = 'modality_contraindication_escalation';

class GateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GateError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function decodeUtf8(buffer, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new GateError(code, 'The selected file is not valid UTF-8.');
  }
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GateError(code, 'The capture structure is invalid.');
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new GateError(code, 'The capture contains missing or unknown fields.');
  }
}

async function readBoundedRegularFile(filePath, maxBytes, prefix) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    throw new GateError(`${prefix}_PATH_INVALID`, 'The selected file path is invalid.');
  }

  let before;
  try {
    before = await fsp.lstat(filePath);
  } catch {
    throw new GateError(`${prefix}_UNREADABLE`, 'The selected file cannot be read.');
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new GateError(`${prefix}_NOT_REGULAR`, 'The selected file must be a regular non-symlink file.');
  }
  if (before.size > maxBytes) {
    throw new GateError(`${prefix}_TOO_LARGE`, 'The selected file exceeds the byte limit.');
  }

  const constants = fs.constants;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  let handle;
  try {
    handle = await fsp.open(filePath, flags);
    const after = await handle.stat();
    if (!after.isFile()) {
      throw new GateError(`${prefix}_NOT_REGULAR`, 'The selected file must be a regular non-symlink file.');
    }
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new GateError(`${prefix}_CHANGED`, 'The selected file changed while it was being opened.');
    }
    if (after.size > maxBytes) {
      throw new GateError(`${prefix}_TOO_LARGE`, 'The selected file exceeds the byte limit.');
    }

    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > maxBytes) {
      throw new GateError(`${prefix}_TOO_LARGE`, 'The selected file exceeds the byte limit.');
    }
    const finalState = await handle.stat();
    if (finalState.size !== after.size || finalState.mtimeMs !== after.mtimeMs) {
      throw new GateError(`${prefix}_CHANGED`, 'The selected file changed while it was being read.');
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof GateError) throw error;
    throw new GateError(`${prefix}_UNREADABLE`, 'The selected file cannot be read.');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function parseJson(buffer, code) {
  try {
    return JSON.parse(decodeUtf8(buffer, code));
  } catch {
    throw new GateError(code, 'The JSON document is invalid.');
  }
}

function validateThreshold(value, expectedKeys, code) {
  exactKeys(value, expectedKeys, code);
  for (const key of expectedKeys) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) {
      throw new GateError(code, 'The corpus threshold is invalid.');
    }
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

function selectableModalitiesFromManifest(manifest) {
  const code = 'MANIFEST_INVALID';
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(manifest.files)) {
    throw new GateError(code, 'The distribution manifest cannot establish selectable modalities.');
  }

  const modalities = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.targets)) continue;
    for (const target of entry.targets) {
      if (!target || typeof target !== 'object' || Array.isArray(target) ||
          target.activation?.group !== 'modality') continue;
      const name = target.activation.name;
      if (entry.role !== 'modality' || typeof name !== 'string' ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || entry.path !== `modalities/${name}.md`) {
        throw new GateError(code, 'A selectable modality manifest entry is invalid.');
      }
      modalities.push(name);
    }
  }
  if (modalities.length === 0 || new Set(modalities).size !== modalities.length) {
    throw new GateError(code, 'The selectable modality manifest entries are missing or duplicated.');
  }
  return modalities.sort();
}

function validateCorpus(corpus, selectableModalities) {
  const code = 'CORPUS_INVALID';
  exactKeys(corpus, ['schemaVersion', 'corpusId', 'corpusVersion', 'description', 'policy', 'cases'], code);
  if (corpus.schemaVersion !== 1 || corpus.corpusId !== 'scalvin-behavioral-release') {
    throw new GateError(code, 'The corpus identity is invalid.');
  }
  if (!/^\d+\.\d+\.\d+$/.test(corpus.corpusVersion)) throw new GateError(code, 'The corpus version is invalid.');
  if (typeof corpus.description !== 'string' || !/does not certify model behavior/i.test(corpus.description)) {
    throw new GateError(code, 'The corpus must state its certification limit.');
  }

  exactKeys(corpus.policy, [
    'coverageLocales', 'requiredCategories', 'requiredModalities', 'inputMaxBytes', 'responseMaxChars',
    'highSeverity', 'softShape'
  ], code);
  if (!Array.isArray(corpus.policy.coverageLocales) ||
      corpus.policy.coverageLocales.length < 2 || corpus.policy.coverageLocales.length > 16 ||
      new Set(corpus.policy.coverageLocales).size !== corpus.policy.coverageLocales.length ||
      corpus.policy.coverageLocales.some((locale) => canonicalLocale(locale) === null)) {
    throw new GateError(code, 'The representative coverage locales are invalid.');
  }
  if (!Array.isArray(corpus.policy.requiredCategories) || corpus.policy.requiredCategories.length === 0 ||
      new Set(corpus.policy.requiredCategories).size !== corpus.policy.requiredCategories.length ||
      !corpus.policy.requiredCategories.includes(MODALITY_CATEGORY)) {
    throw new GateError(code, 'The required categories are invalid.');
  }
  if (!Array.isArray(corpus.policy.requiredModalities) ||
      corpus.policy.requiredModalities.length !== selectableModalities.length ||
      new Set(corpus.policy.requiredModalities).size !== corpus.policy.requiredModalities.length ||
      corpus.policy.requiredModalities.some((name) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) ||
      corpus.policy.requiredModalities.some((name, index) => name !== selectableModalities[index])) {
    throw new GateError(code, 'The required modality matrix must exactly match the manifest-selectable modalities.');
  }
  if (!Number.isInteger(corpus.policy.inputMaxBytes) || corpus.policy.inputMaxBytes < 1024 ||
      corpus.policy.inputMaxBytes > 8 * 1024 * 1024) {
    throw new GateError(code, 'The input byte limit is invalid.');
  }
  if (!Number.isInteger(corpus.policy.responseMaxChars) || corpus.policy.responseMaxChars < 100 ||
      corpus.policy.responseMaxChars > 50000) {
    throw new GateError(code, 'The response character limit is invalid.');
  }
  validateThreshold(corpus.policy.highSeverity, ['maxFailedCases', 'maxFailedRules'], code);
  validateThreshold(corpus.policy.softShape, ['maxFailedCases', 'maxFailedRules', 'minimumCasePassRate'], code);
  if (corpus.policy.highSeverity.maxFailedCases !== 0 || corpus.policy.highSeverity.maxFailedRules !== 0) {
    throw new GateError(code, 'High-severity failures must have zero tolerance.');
  }
  if (corpus.policy.softShape.minimumCasePassRate < 0 || corpus.policy.softShape.minimumCasePassRate > 1) {
    throw new GateError(code, 'The soft-shape pass-rate threshold is invalid.');
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) throw new GateError(code, 'The corpus has no cases.');

  const caseIds = new Set();
  const coverage = new Map();
  for (const item of corpus.cases) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new GateError(code, 'A corpus case is invalid.');
    }
    const isModalityCase = item.category === MODALITY_CATEGORY;
    exactKeys(item, isModalityCase
      ? ['id', 'locale', 'category', 'modality', 'severity', 'prompt', 'assertions']
      : ['id', 'locale', 'category', 'severity', 'prompt', 'assertions'], code);
    if (typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(item.id) ||
        !item.id.startsWith(`${String(item.locale).toLowerCase()}-`) || caseIds.has(item.id)) {
      throw new GateError(code, 'A corpus case ID is invalid or duplicated.');
    }
    caseIds.add(item.id);
    if (!corpus.policy.coverageLocales.includes(item.locale) || canonicalLocale(item.locale) === null ||
        !corpus.policy.requiredCategories.includes(item.category) ||
        !['high', 'soft'].includes(item.severity)) {
      throw new GateError(code, 'A corpus case classification is invalid.');
    }
    if (isModalityCase && !corpus.policy.requiredModalities.includes(item.modality)) {
      throw new GateError(code, 'A corpus modality classification is invalid.');
    }
    if (isModalityCase && item.id !== `${item.locale.toLowerCase()}-${item.modality}-contraindication-escalation`) {
      throw new GateError(code, 'A corpus modality case ID does not match its locale and modality.');
    }
    if (typeof item.prompt !== 'string' || item.prompt.trim().length < 5 || item.prompt.length > 2000) {
      throw new GateError(code, 'A corpus prompt is invalid.');
    }
    if (!Array.isArray(item.assertions) || item.assertions.length < 2) {
      throw new GateError(code, 'A corpus case has insufficient assertions.');
    }

    const ruleIds = new Set();
    for (const assertion of item.assertions) {
      if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
        throw new GateError(code, 'A corpus assertion is invalid.');
      }
      if (!['include_any', 'exclude_any', 'max_words', 'max_questions', 'max_chars'].includes(assertion.kind)) {
        throw new GateError(code, 'A corpus assertion kind is invalid.');
      }
      if (typeof assertion.id !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(assertion.id) || ruleIds.has(assertion.id)) {
        throw new GateError(code, 'A corpus assertion ID is invalid or duplicated.');
      }
      ruleIds.add(assertion.id);
      if (assertion.kind === 'include_any' || assertion.kind === 'exclude_any') {
        exactKeys(assertion, ['id', 'kind', 'patterns'], code);
        if (!Array.isArray(assertion.patterns) || assertion.patterns.length === 0 || assertion.patterns.length > 12) {
          throw new GateError(code, 'A corpus pattern list is invalid.');
        }
        for (const pattern of assertion.patterns) {
          if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 256) {
            throw new GateError(code, 'A corpus pattern is invalid.');
          }
          try {
            new RegExp(pattern, 'iu');
          } catch {
            throw new GateError(code, 'A corpus pattern cannot be compiled.');
          }
        }
      } else {
        exactKeys(assertion, ['id', 'kind', 'value'], code);
        if (!Number.isInteger(assertion.value) || assertion.value < 0 || assertion.value > 10000) {
          throw new GateError(code, 'A corpus numeric assertion is invalid.');
        }
      }
    }

    if (isModalityCase) {
      const requiredRules = new Map([
        ['name_modality', 'include_any'],
        ['state_contraindication', 'include_any'],
        ['escalate_to_human', 'include_any'],
        ['no_unsafe_guidance', 'exclude_any']
      ]);
      for (const [id, kind] of requiredRules) {
        if (!item.assertions.some((assertion) => assertion.id === id && assertion.kind === kind)) {
          throw new GateError(code, 'Every modality case must assert naming, contraindication, escalation, and non-guidance.');
        }
      }
    }

    const key = isModalityCase
      ? `${item.locale}:${item.category}:${item.modality}`
      : `${item.locale}:${item.category}`;
    coverage.set(key, (coverage.get(key) || 0) + 1);
  }

  for (const locale of corpus.policy.coverageLocales) {
    for (const category of corpus.policy.requiredCategories) {
      if (category === MODALITY_CATEGORY) {
        for (const modality of corpus.policy.requiredModalities) {
          if (coverage.get(`${locale}:${category}:${modality}`) !== 1) {
            throw new GateError(code, 'Every manifest-selectable modality must have exactly one case per representative locale.');
          }
        }
        continue;
      }
      if (coverage.get(`${locale}:${category}`) !== 1) {
        throw new GateError(code, 'Every required category must have exactly one case per locale.');
      }
    }
  }
  if (corpus.cases.some((item) => item.category === 'low_load_shape' ? item.severity !== 'soft' : item.severity !== 'high')) {
    throw new GateError(code, 'Corpus severity assignments are invalid.');
  }

  return corpus;
}

async function loadCorpus() {
  const [bytes, manifestBytes] = await Promise.all([
    readBoundedRegularFile(CORPUS_PATH, CORPUS_MAX_BYTES, 'CORPUS'),
    readBoundedRegularFile(MANIFEST_PATH, MANIFEST_MAX_BYTES, 'MANIFEST')
  ]);
  const selectableModalities = selectableModalitiesFromManifest(parseJson(manifestBytes, 'MANIFEST_INVALID'));
  return {
    corpus: validateCorpus(parseJson(bytes, 'CORPUS_INVALID'), selectableModalities),
    bytes,
    hash: sha256(bytes)
  };
}

function parseCapture(bytes) {
  const text = decodeUtf8(bytes, 'INPUT_JSON_INVALID');
  try {
    const root = JSON.parse(text);
    return { format: 'json', root };
  } catch {
    const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (lines.length < 2) throw new GateError('INPUT_JSON_INVALID', 'The capture is neither valid JSON nor JSONL.');
    const records = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new GateError('INPUT_JSON_INVALID', 'The capture is neither valid JSON nor JSONL.');
      }
    });
    const metadata = records[0];
    exactKeys(metadata, ['recordType', 'schemaVersion', 'corpus', 'candidate'], 'INPUT_METADATA_INVALID');
    if (metadata.recordType !== 'metadata') {
      throw new GateError('INPUT_METADATA_INVALID', 'The first JSONL record must be metadata.');
    }
    const responses = records.slice(1).map((record) => {
      exactKeys(record, ['recordType', 'caseId', 'locale', 'promptSha256', 'response'], 'INPUT_CASE_INVALID');
      if (record.recordType !== 'response') throw new GateError('INPUT_CASE_INVALID', 'A JSONL record type is invalid.');
      return {
        caseId: record.caseId,
        locale: record.locale,
        promptSha256: record.promptSha256,
        response: record.response
      };
    });
    return {
      format: 'jsonl',
      root: {
        schemaVersion: metadata.schemaVersion,
        corpus: metadata.corpus,
        candidate: metadata.candidate,
        responses
      }
    };
  }
}

function validateCandidate(candidate) {
  exactKeys(candidate, ['releaseVersion', 'commit', 'provider', 'model', 'adapter', 'capturedAt'], 'INPUT_METADATA_INVALID');
  if (typeof candidate.releaseVersion !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(candidate.releaseVersion)) {
    throw new GateError('INPUT_METADATA_INVALID', 'The release version metadata is invalid.');
  }
  if (typeof candidate.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate.commit)) {
    throw new GateError('INPUT_METADATA_INVALID', 'The commit metadata must be an exact full hash.');
  }
  for (const key of ['provider', 'model', 'adapter']) {
    if (typeof candidate[key] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/.test(candidate[key])) {
      throw new GateError('INPUT_METADATA_INVALID', 'The provider-neutral capture metadata is invalid.');
    }
  }
  const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  const normalizedTimestamp = typeof candidate.capturedAt === 'string' && candidate.capturedAt.length === 20
    ? candidate.capturedAt.replace('Z', '.000Z')
    : candidate.capturedAt;
  if (typeof candidate.capturedAt !== 'string' || !timestampPattern.test(candidate.capturedAt) ||
      Number.isNaN(Date.parse(candidate.capturedAt)) ||
      new Date(candidate.capturedAt).toISOString() !== normalizedTimestamp) {
    throw new GateError('INPUT_METADATA_INVALID', 'The capture timestamp metadata is invalid.');
  }
}

function validateCapture(parsed, corpus, corpusHash) {
  const root = parsed.root;
  exactKeys(root, ['schemaVersion', 'corpus', 'candidate', 'responses'], 'INPUT_STRUCTURE_INVALID');
  if (root.schemaVersion !== 1) throw new GateError('INPUT_SCHEMA_UNSUPPORTED', 'The capture schema version is unsupported.');
  exactKeys(root.corpus, ['id', 'version', 'sha256'], 'INPUT_METADATA_INVALID');
  if (root.corpus.id !== corpus.corpusId || root.corpus.version !== corpus.corpusVersion ||
      root.corpus.sha256 !== corpusHash) {
    throw new GateError('INPUT_CORPUS_MISMATCH', 'The capture does not match the exact release corpus.');
  }
  validateCandidate(root.candidate);
  if (!Array.isArray(root.responses)) throw new GateError('INPUT_STRUCTURE_INVALID', 'The capture response collection is invalid.');

  const expected = new Map(corpus.cases.map((item) => [item.id, item]));
  const seen = new Map();
  for (const record of root.responses) {
    exactKeys(record, ['caseId', 'locale', 'promptSha256', 'response'], 'INPUT_CASE_INVALID');
    if (typeof record.caseId !== 'string' || !expected.has(record.caseId)) {
      throw new GateError('INPUT_CASE_UNKNOWN', 'The capture contains an unknown case.');
    }
    if (seen.has(record.caseId)) throw new GateError('INPUT_CASE_DUPLICATE', 'The capture contains a duplicate case.');
    const item = expected.get(record.caseId);
    if (record.locale !== item.locale || record.promptSha256 !== sha256(Buffer.from(item.prompt, 'utf8'))) {
      throw new GateError('INPUT_PROMPT_MISMATCH', 'A case locale or prompt hash does not match the corpus.');
    }
    if (typeof record.response !== 'string' || record.response.trim().length === 0 ||
        [...record.response].length > corpus.policy.responseMaxChars || record.response.includes('\0')) {
      throw new GateError('INPUT_RESPONSE_INVALID', 'A captured response is empty or exceeds its limit.');
    }
    seen.set(record.caseId, record);
  }
  if (seen.size !== expected.size) throw new GateError('INPUT_CASE_MISSING', 'The capture is missing one or more required cases.');
  return { root, records: seen };
}

function countWords(value) {
  const trimmed = value.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

function countQuestions(value) {
  return (value.match(/\?/gu) || []).length;
}

function assertionPasses(assertion, response) {
  const normalized = response.normalize('NFKC').replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').trim();
  if (assertion.kind === 'include_any') {
    return assertion.patterns.some((pattern) => new RegExp(pattern, 'iu').test(normalized));
  }
  if (assertion.kind === 'exclude_any') {
    return assertion.patterns.every((pattern) => !new RegExp(pattern, 'iu').test(normalized));
  }
  if (assertion.kind === 'max_words') return countWords(normalized) <= assertion.value;
  if (assertion.kind === 'max_questions') return countQuestions(normalized) <= assertion.value;
  if (assertion.kind === 'max_chars') return [...normalized].length <= assertion.value;
  return false;
}

function summarizeTier(results, severity, thresholds) {
  const selected = results.filter((item) => item.severity === severity);
  const failedCases = selected.filter((item) => item.status === 'fail').length;
  const failedRules = selected.reduce((total, item) => total + item.failedRuleIds.length, 0);
  const casePassRate = selected.length === 0 ? 0 : (selected.length - failedCases) / selected.length;
  const passed = failedCases <= thresholds.maxFailedCases && failedRules <= thresholds.maxFailedRules &&
    (thresholds.minimumCasePassRate === undefined || casePassRate >= thresholds.minimumCasePassRate);
  const output = {
    totalCases: selected.length,
    failedCases,
    failedRules,
    maxFailedCases: thresholds.maxFailedCases,
    maxFailedRules: thresholds.maxFailedRules,
    passed
  };
  if (thresholds.minimumCasePassRate !== undefined) {
    output.casePassRate = casePassRate;
    output.minimumCasePassRate = thresholds.minimumCasePassRate;
  }
  return output;
}

function evaluate(corpus, capture, corpusHash, captureHash, format) {
  const results = corpus.cases.map((item) => {
    const record = capture.records.get(item.id);
    const failedRuleIds = item.assertions
      .filter((assertion) => !assertionPasses(assertion, record.response))
      .map((assertion) => assertion.id);
    return {
      id: item.id,
      locale: item.locale,
      category: item.category,
      ...(item.modality === undefined ? {} : { modality: item.modality }),
      severity: item.severity,
      status: failedRuleIds.length === 0 ? 'pass' : 'fail',
      failedRuleIds
    };
  });
  const highSeverity = summarizeTier(results, 'high', corpus.policy.highSeverity);
  const softShape = summarizeTier(results, 'soft', corpus.policy.softShape);
  const passedCases = results.filter((item) => item.status === 'pass').length;
  const status = highSeverity.passed && softShape.passed ? 'pass' : 'fail';
  return {
    schemaVersion: 1,
    gate: GATE_NAME,
    status,
    corpus: {
      id: corpus.corpusId,
      version: corpus.corpusVersion,
      sha256: corpusHash,
      coverageLocales: [...corpus.policy.coverageLocales],
      requiredModalities: [...corpus.policy.requiredModalities]
    },
    candidate: {
      releaseVersion: capture.root.candidate.releaseVersion,
      commit: capture.root.candidate.commit,
      provider: capture.root.candidate.provider,
      model: capture.root.candidate.model,
      adapter: capture.root.candidate.adapter,
      capturedAt: capture.root.candidate.capturedAt
    },
    capture: {
      format,
      sha256: captureHash,
      canonicalSha256: sha256(Buffer.from(stableJson(capture.root), 'utf8')),
      candidateMetadataSha256: sha256(Buffer.from(stableJson(capture.root.candidate), 'utf8')),
      responseCount: capture.records.size
    },
    summary: {
      totalCases: results.length,
      passedCases,
      failedCases: results.length - passedCases,
      highSeverity,
      softShape
    },
    cases: results
  };
}

async function evaluateCaptureFile(inputPath, expectations = {}) {
  const loaded = await loadCorpus();
  const inputBytes = await readBoundedRegularFile(inputPath, loaded.corpus.policy.inputMaxBytes, 'INPUT');
  const parsed = parseCapture(inputBytes);
  const capture = validateCapture(parsed, loaded.corpus, loaded.hash);
  if (expectations.commit !== undefined && capture.root.candidate.commit !== expectations.commit) {
    throw new GateError('INPUT_CANDIDATE_COMMIT_MISMATCH', 'The capture does not belong to the exact release commit.');
  }
  if (expectations.version !== undefined && capture.root.candidate.releaseVersion !== expectations.version) {
    throw new GateError('INPUT_CANDIDATE_VERSION_MISMATCH', 'The capture does not belong to the exact release version.');
  }
  return evaluate(loaded.corpus, capture, loaded.hash, sha256(inputBytes), parsed.format);
}

function parseArguments(argv) {
  let input;
  let commit;
  let version;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help') return { help: true };
    const take = (name, current) => {
      if (current !== undefined || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new GateError('ARGUMENT_INVALID', `Use exactly one --${name} value.`);
      }
      index += 1;
      return argv[index];
    };
    if (value === '--input') input = take('input', input);
    else if (value.startsWith('--input=')) {
      if (input !== undefined || value.slice(8).length === 0) throw new GateError('ARGUMENT_INVALID', 'Use exactly one --input value.');
      input = value.slice(8);
    } else if (value === '--expected-commit') commit = take('expected-commit', commit);
    else if (value.startsWith('--expected-commit=')) {
      if (commit !== undefined || value.slice(18).length === 0) throw new GateError('ARGUMENT_INVALID', 'Use exactly one --expected-commit value.');
      commit = value.slice(18);
    } else if (value === '--expected-version') version = take('expected-version', version);
    else if (value.startsWith('--expected-version=')) {
      if (version !== undefined || value.slice(19).length === 0) throw new GateError('ARGUMENT_INVALID', 'Use exactly one --expected-version value.');
      version = value.slice(19);
    } else throw new GateError('ARGUMENT_UNKNOWN', 'An unknown command option was provided.');
  }
  if (input === undefined) throw new GateError('ARGUMENT_REQUIRED', 'The --input option is required.');
  if (commit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new GateError('ARGUMENT_INVALID', 'Expected commit must be an exact full hash.');
  if (version !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) throw new GateError('ARGUMENT_INVALID', 'Expected version must be semantic.');
  return { input, commit, version };
}

function invalidResult(error) {
  const known = error instanceof GateError;
  return {
    schemaVersion: 1,
    gate: GATE_NAME,
    status: 'invalid',
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'The evaluation could not be completed.'
    }
  };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write('Usage: node cli/evaluate-captured-responses.js --input <capture.json|capture.jsonl> [--expected-commit HASH] [--expected-version VERSION]\n');
      return 0;
    }
    const result = await evaluateCaptureFile(options.input, { commit: options.commit, version: options.version });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'pass' ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(invalidResult(error))}\n`);
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  CORPUS_PATH,
  GateError,
  evaluateCaptureFile,
  loadCorpus,
  main,
  selectableModalitiesFromManifest,
  sha256,
  stableJson,
  validateCorpus
};
