#!/usr/bin/env node
// <!-- version: 1.4.0 -->
// Locale-pack-driven mechanical safety backstop for UserPromptSubmit-compatible
// clients. It is deliberately bounded and fail-open. It does not assess risk,
// replace safety-protocol.md, or prove that an unflagged message is safe.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

let emergencyResourceTools = null;
try {
  emergencyResourceTools = require('./emergency-resources.cjs');
} catch (_) {
  // A fixed degraded state is emitted below; never expose loader details.
}

const MAX_STDIN_CHARS = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_PACKS = 64;
const MAX_PACK_BYTES = 64 * 1024;
const MAX_PATTERNS_PER_LIST = 128;
const MAX_PATTERN_CHARS = 1200;
const HEALTH_SCHEMA_VERSION = 1;
const HEALTH_CAPABILITY = 'mechanical_safety_backstop';
const SELF_TEST_PROMPT = 'I want to die.';
const HEALTH_REASON_CODES = new Set([
  'LOCALE_PACK_LOAD_FAILED',
  'LOCALE_PACK_UNAVAILABLE',
  'EMERGENCY_RESOURCE_REGISTRY_LOAD_FAILED',
  'EMERGENCY_RESOURCE_REGISTRY_NOT_YET_VALID',
  'EMERGENCY_RESOURCE_REGISTRY_STALE',
  'SYNTHETIC_CLASSIFICATION_FAILED',
  'SELF_TEST_FAILED',
  'SELF_TEST_ARGUMENTS_INVALID',
  'HOOK_TIMEOUT',
  'HOOK_INPUT_ERROR',
  'INPUT_BOUNDED',
  'HOOK_INPUT_INVALID',
  'CLASSIFIER_UNAVAILABLE',
  'HOOK_PROCESSING_FAILED',
  'HOOK_START_FAILED'
]);
const ALLOWED_DOMAINS = new Set([
  'self_harm', 'overdose', 'medical_emergency', 'harm_to_others',
  'psychosis_or_disorientation', 'abuse_or_safeguarding'
]);
const PACK_KEYS = [
  'schemaVersion', 'locale', 'speakerStartPattern', 'speakerPivotPattern',
  'currentSelfQuotedDisclosurePatterns', 'clearNonSelfContextPatterns',
  'ambiguousPatterns', 'domains'
];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function compilePatternList(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATTERNS_PER_LIST) {
    throw new Error(`${label} pattern count is invalid`);
  }
  return value.map((source) => {
    if (typeof source !== 'string' || source.length === 0 || source.length > MAX_PATTERN_CHARS) {
      throw new Error(`${label} contains an invalid pattern`);
    }
    return new RegExp(source, 'u');
  });
}

function canonicalLocale(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) {
    throw new Error('Locale is invalid');
  }
  const [canonical] = Intl.getCanonicalLocales(value);
  if (!canonical) throw new Error('Locale is invalid');
  return canonical;
}

function compilePack(document, filename) {
  exactKeys(document, PACK_KEYS, 'Locale pack');
  if (document.schemaVersion !== 1) throw new Error('Locale pack schema is unsupported');
  const locale = canonicalLocale(document.locale);
  if (filename !== `${locale}.json`) throw new Error('Locale pack filename must match its canonical locale');
  const domains = {};
  exactKeys(document.domains, [...ALLOWED_DOMAINS], 'Locale pack domains');
  for (const [domain, patterns] of Object.entries(document.domains)) {
    domains[domain] = compilePatternList(patterns, `${locale}:${domain}`);
  }
  const scalar = (source, label) => compilePatternList([source], label)[0];
  return Object.freeze({
    locale,
    speakerStartPattern: scalar(document.speakerStartPattern, `${locale}:speakerStartPattern`),
    speakerPivotPattern: scalar(document.speakerPivotPattern, `${locale}:speakerPivotPattern`),
    currentSelfQuotedDisclosurePatterns: compilePatternList(document.currentSelfQuotedDisclosurePatterns, `${locale}:quotedDisclosure`),
    clearNonSelfContextPatterns: compilePatternList(document.clearNonSelfContextPatterns, `${locale}:nonSelfContext`),
    ambiguousPatterns: compilePatternList(document.ambiguousPatterns, `${locale}:ambiguous`),
    domains: Object.freeze(domains)
  });
}

function loadLocalePacks(directory = path.join(__dirname, 'safety-locales')) {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Safety locale pack directory is invalid');
  const names = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (names.length === 0 || names.length > MAX_PACKS) throw new Error('Safety locale pack count is invalid');
  const locales = new Set();
  return names.map((name) => {
    if (!/^[A-Za-z0-9-]+\.json$/.test(name)) throw new Error('Safety locale pack filename is invalid');
    const target = path.join(directory, name);
    const preflight = fs.lstatSync(target);
    if (!preflight.isFile() || preflight.isSymbolicLink()) throw new Error('Safety locale pack file is invalid');
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const descriptor = fs.openSync(target, flags);
    let bytes;
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.size <= 0 || opened.size > MAX_PACK_BYTES) {
        throw new Error('Safety locale pack file is invalid');
      }
      bytes = fs.readFileSync(descriptor, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
    const pack = compilePack(JSON.parse(bytes), name);
    if (locales.has(pack.locale)) throw new Error('Safety locale pack locale is duplicated');
    locales.add(pack.locale);
    return pack;
  });
}

// A malformed or unavailable optional pack must never make the client hook
// block a user prompt. The standalone loader still throws so doctor/tests can
// fail closed; the runtime hook emits only a fixed content-free degraded notice
// and leaves the prose safety authority in control.
let LOCALE_PACKS = [];
let LOCALE_PACK_HEALTH = { state: 'available', reasonCode: null };
try {
  LOCALE_PACKS = loadLocalePacks();
} catch (_) {
  LOCALE_PACKS = [];
  LOCALE_PACK_HEALTH = { state: 'degraded', reasonCode: 'LOCALE_PACK_LOAD_FAILED' };
}

let EMERGENCY_RESOURCE_HEALTH = {
  state: 'degraded',
  reasonCode: 'EMERGENCY_RESOURCE_REGISTRY_LOAD_FAILED'
};
if (emergencyResourceTools) {
  try {
    const registry = emergencyResourceTools.loadRegistry();
    const assessment = emergencyResourceTools.assessRegistry(registry);
    EMERGENCY_RESOURCE_HEALTH = assessment.state === 'current'
      ? { state: 'available', reasonCode: null }
      : { state: 'degraded', reasonCode: assessment.reasonCode };
  } catch (_) {
    EMERGENCY_RESOURCE_HEALTH = {
      state: 'degraded',
      reasonCode: 'EMERGENCY_RESOURCE_REGISTRY_LOAD_FAILED'
    };
  }
}

function installedSafetyHealth() {
  if (LOCALE_PACK_HEALTH.state !== 'available' || LOCALE_PACKS.length === 0) {
    return {
      state: 'degraded',
      reasonCode: LOCALE_PACK_HEALTH.reasonCode || 'LOCALE_PACK_UNAVAILABLE'
    };
  }
  return EMERGENCY_RESOURCE_HEALTH;
}

function normalize(input) {
  return String(input)
    .normalize('NFKC')
    .replace(/[‘’‛ʼ`´]/g, "'")
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .toLowerCase()
    .replace(/i\u0307/g, 'i')
    .trim();
}

function removeQuotedMaterial(text) {
  return text
    .replace(/“[^”\n]{0,500}”/g, ' [quote] ')
    .replace(/"[^"\n]{0,500}"/g, ' [quote] ')
    .replace(/‘[^’\n]{0,500}’/g, ' [quote] ');
}

function matches(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function splitContextSegments(text) {
  return text
    .split(/(?<=[.!?;])\s+|\n{2,}/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function speakerLedClauses(segment, pack) {
  const clauses = [];
  if (pack.speakerStartPattern.test(segment)) clauses.push(segment);

  const pivot = new RegExp(pack.speakerPivotPattern.source, 'gu');
  let match;
  while ((match = pivot.exec(segment)) !== null) {
    clauses.push(segment.slice(match.index + match[0].length));
  }
  return clauses;
}

function matchesInSpeakerContext(patterns, text, pack) {
  const segments = splitContextSegments(text);
  for (const segment of segments) {
    if (!matches(patterns, segment)) continue;
    if (!matches(pack.clearNonSelfContextPatterns, segment)) return true;
    if (speakerLedClauses(segment, pack).some((clause) => matches(patterns, clause))) return true;
  }
  return false;
}

function isCurrentSelfQuotedDisclosure(text) {
  return LOCALE_PACKS.some((pack) => matches(pack.currentSelfQuotedDisclosurePatterns, text));
}

function classify(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > MAX_STDIN_CHARS) {
    return { fire: false, level: null, domains: [], reason: 'invalid-or-bounded' };
  }

  const normalized = normalize(prompt);
  const scanText = isCurrentSelfQuotedDisclosure(normalized) ? normalized : removeQuotedMaterial(normalized);

  const domains = new Set();
  const matchedLocales = new Set();
  for (const pack of LOCALE_PACKS) {
    for (const [domain, patterns] of Object.entries(pack.domains)) {
      if (matchesInSpeakerContext(patterns, scanText, pack)) {
        domains.add(domain);
        matchedLocales.add(pack.locale);
      }
    }
  }

  if (domains.size > 0) {
    return { fire: true, level: 'urgent-review', domains: [...domains], matchedLocales: [...matchedLocales], reason: 'direct-pattern' };
  }

  for (const pack of LOCALE_PACKS) {
    if (matchesInSpeakerContext(pack.ambiguousPatterns, scanText, pack)) {
      return { fire: true, level: 'clarify', domains: ['ambiguous_distress'], matchedLocales: [pack.locale], reason: 'ambiguous-pattern' };
    }
  }

  return { fire: false, level: null, domains: [], matchedLocales: [], reason: 'no-pattern' };
}

function buildNotice(result) {
  const domainList = result.domains.join(', ');
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        'SCALVIN SAFETY BACKSTOP: A bounded locale-pack matcher flagged possible safety-relevant language.',
        'Mechanical safety backstop capability state: available.',
        `Classifier level: ${result.level}; domains: ${domainList}.`,
        'This is not a risk assessment and can both miss crises and over-fire. Never treat silence as proof of safety.',
        'Re-read .therapy/safety-protocol.md before replying. Use the user\'s current meaning and context; distinguish passive thoughts, active/imminent self-harm, harm to others, abuse/safeguarding, psychosis, and medical emergency.',
        'State capability truth: you cannot call services, locate the user, contact anyone, or monitor them. Ask only the minimum questions needed. Ask for location only when necessary, use only non-expired registry-backed or live-verified jurisdiction-appropriate resources, and phrase them in the user\'s current language.'
      ].join('\n')
    }
  };
}

function healthState(state, reasonCode = null) {
  const safeState = ['available', 'degraded', 'unsupported'].includes(state) ? state : 'degraded';
  const safeReason = safeState === 'available'
    ? null
    : HEALTH_REASON_CODES.has(reasonCode) ? reasonCode : 'HOOK_PROCESSING_FAILED';
  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    capability: HEALTH_CAPABILITY,
    state: safeState,
    reasonCode: safeReason
  };
}

function buildHealthNotice(reasonCode) {
  const safeReason = HEALTH_REASON_CODES.has(reasonCode) ? reasonCode : 'HOOK_PROCESSING_FAILED';
  const resourceGuidance = safeReason.startsWith('EMERGENCY_RESOURCE_')
    ? 'Bundled emergency-resource verification is unavailable or stale. Do not present bundled contacts as current without live official verification; do not delay immediate local emergency help.'
    : null;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        'SCALVIN SAFETY BACKSTOP HEALTH: The mechanical safety backstop is degraded for this prompt.',
        `Capability state: degraded; reason code: ${safeReason}.`,
        'The prompt was not blocked, and this notice contains no prompt content.',
        resourceGuidance,
        'Do not claim that mechanical screening ran. Re-read .therapy/safety-protocol.md before replying and use the full prose safety protocol as the authority.'
      ].filter(Boolean).join('\n')
    }
  };
}

function classifyIsolated(prompt, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(__filename, {
      workerData: { kind: 'classify', prompt },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 }
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(null);
    }, timeoutMs);
    worker.once('message', (value) => finish(value));
    worker.once('error', () => finish(null));
    worker.once('exit', (code) => {
      if (code !== 0) finish(null);
    });
  });
}

async function runSelfTest(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const installedHealth = installedSafetyHealth();
  if (installedHealth.state !== 'available') {
    return healthState('degraded', installedHealth.reasonCode);
  }
  const result = await classifyIsolated(SELF_TEST_PROMPT, Math.max(1, timeoutMs - 25));
  if (!result || result.fire !== true || !result.domains.includes('self_harm')) {
    return healthState('degraded', 'SYNTHETIC_CLASSIFICATION_FAILED');
  }
  return healthState('available');
}

function writeJsonLine(value, callback) {
  const output = `${JSON.stringify(value)}\n`;
  if (callback) process.stdout.write(output, callback);
  else process.stdout.write(output);
}

function runFromStdin() {
  let input = '';
  let overflowed = false;
  let settled = false;
  const configured = Number(process.env.SCALVIN_HOOK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
  const finish = (output, forceExit = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (output) {
      if (forceExit) writeJsonLine(output, () => process.exit(0));
      else writeJsonLine(output);
    } else if (forceExit) {
      process.exit(0);
    }
  };
  const timer = setTimeout(() => finish(buildHealthNotice('HOOK_TIMEOUT'), true), timeoutMs);
  if (timer.unref) timer.unref();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (overflowed) return;
    if (input.length + chunk.length > MAX_STDIN_CHARS) {
      overflowed = true;
      input = '';
      return;
    }
    input += chunk;
  });
  process.stdin.on('error', () => finish(buildHealthNotice('HOOK_INPUT_ERROR'), true));
  process.stdout.on('error', () => process.exit(0));
  process.stdin.on('end', async () => {
    if (overflowed) {
      finish(buildHealthNotice('INPUT_BOUNDED'));
      return;
    }
    try {
      const payload = JSON.parse(input);
      if (typeof payload?.prompt !== 'string' || payload.prompt.length === 0 || payload.prompt.length > MAX_STDIN_CHARS) {
        finish(buildHealthNotice('HOOK_INPUT_INVALID'));
        return;
      }
      const installedHealth = installedSafetyHealth();
      if (installedHealth.state !== 'available') {
        finish(buildHealthNotice(installedHealth.reasonCode));
        return;
      }
      const result = await classifyIsolated(payload.prompt, Math.max(1, timeoutMs - 25));
      if (!result) {
        finish(buildHealthNotice('CLASSIFIER_UNAVAILABLE'));
        return;
      }
      finish(result.fire ? buildNotice(result) : null);
    } catch (_) {
      // Fail open: report a content-free degraded state without blocking.
      finish(buildHealthNotice('HOOK_PROCESSING_FAILED'));
    }
  });
}

module.exports = {
  MAX_STDIN_CHARS,
  normalize,
  classify,
  buildNotice,
  buildHealthNotice,
  healthState,
  installedSafetyHealth,
  loadLocalePacks,
  classifyIsolated,
  runSelfTest
};

if (!isMainThread && workerData?.kind === 'classify') {
  try {
    parentPort.postMessage(classify(workerData.prompt));
  } catch (_) {
    // The parent converts a missing worker result into a content-free degraded notice.
  }
} else if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--self-test' && args[1] === '--json') {
    runSelfTest()
      .then((result) => writeJsonLine(result))
      .catch(() => writeJsonLine(healthState('degraded', 'SELF_TEST_FAILED')));
  } else if (args.length === 0) {
    try {
      runFromStdin();
    } catch (_) {
      writeJsonLine(buildHealthNotice('HOOK_START_FAILED'));
    }
  } else {
    writeJsonLine(healthState('degraded', 'SELF_TEST_ARGUMENTS_INVALID'));
  }
}
