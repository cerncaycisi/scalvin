'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'hooks', 'safety-net.cjs');
const RESOURCE_LIBRARY = path.join(ROOT, 'hooks', 'emergency-resources.cjs');
const RESOURCE_REGISTRY = path.join(ROOT, 'hooks', 'emergency-resources.json');
const CORPUS_PATH = path.join(ROOT, 'evals', 'safety-corpus.json');
const {
  MAX_STDIN_CHARS,
  classify,
  normalize,
  buildNotice,
  buildHealthNotice,
  loadLocalePacks,
  runSelfTest
} = require(HOOK);
const corpusDocument = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const corpus = corpusDocument.cases;

test('corpus covers every installed locale pack and all three gates without a favored pair', () => {
  assert.ok(corpus.length >= 75, `expected at least 75 cases, got ${corpus.length}`);
  const packLocales = loadLocalePacks().map((pack) => pack.locale);
  assert.ok(packLocales.length >= 1);
  for (const locale of packLocales) {
    assert.deepEqual(Intl.getCanonicalLocales(locale), [locale]);
    assert.ok(corpus.filter((entry) => entry.language === locale).length >= 25, `${locale}: insufficient corpus coverage`);
  }
  for (const gate of ['must-fire', 'must-silent', 'known-overfire']) {
    assert.ok(corpus.some((entry) => entry.gate === gate), `missing ${gate}`);
  }
  for (const topic of ['self-harm', 'passive-ideation', 'overdose', 'medical', 'harm-to-others', 'psychosis', 'abuse', 'grief', 'quoted', 'third-party', 'media', 'professional', 'ordinary-distress', 'venting']) {
    assert.ok(corpus.some((entry) => entry.topic === topic), `missing topic ${topic}`);
  }
});

test('every urgent risk class has must-fire and must-silent cases in every installed locale', () => {
  const riskTopics = ['overdose', 'medical', 'harm-to-others', 'psychosis', 'abuse'];
  const packLocales = loadLocalePacks().map((pack) => pack.locale);
  for (const language of packLocales) {
    for (const topic of riskTopics) {
      const paired = corpus.filter((entry) => entry.language === language && entry.topic === topic);
      assert.ok(paired.some((entry) => entry.gate === 'must-fire'), `${language}:${topic} missing must-fire case`);
      assert.ok(paired.some((entry) => entry.gate === 'must-silent'), `${language}:${topic} missing must-silent case`);
    }
  }
});

test('must-fire corpus never stays silent', async (t) => {
  for (const entry of corpus.filter((item) => item.gate === 'must-fire')) {
    await t.test(entry.id, () => {
      const result = classify(entry.text);
      assert.equal(result.fire, true, `${entry.id}: ${entry.text}`);
      if (entry.expected_domain) {
        assert.ok(
          result.domains.includes(entry.expected_domain),
          `${entry.id}: expected domain ${entry.expected_domain}, got ${result.domains.join(', ')}`
        );
      }
    });
  }
});

test('must-silent corpus never fires', async (t) => {
  for (const entry of corpus.filter((item) => item.gate === 'must-silent')) {
    await t.test(entry.id, () => {
      const result = classify(entry.text);
      assert.equal(result.fire, false, `${entry.id}: ${entry.text}`);
    });
  }
});

test('known overfires stay explicit and measurable', () => {
  const cases = corpus.filter((item) => item.gate === 'known-overfire');
  const budget = corpusDocument.known_overfire_budget;
  assert.ok(budget && Number.isInteger(budget.max_count));
  assert.ok(Number.isFinite(budget.max_rate));
  assert.deepEqual(
    cases.map((entry) => entry.id).sort(),
    [...budget.allowed_ids].sort(),
    'every known overfire must be explicitly allowlisted'
  );
  assert.ok(cases.length <= budget.max_count, `known-overfire count ${cases.length} exceeds budget ${budget.max_count}`);
  assert.ok(cases.length / corpus.length <= budget.max_rate, 'known-overfire rate exceeds budget');
  for (const entry of cases) {
    assert.ok(entry.reason && entry.reason.trim(), `${entry.id} needs a documented reason`);
    assert.equal(entry.tracking, 'documented-recall-first-boundary');
  }
  const liveOverfires = cases.filter((entry) => classify(entry.text).fire);
  assert.equal(liveOverfires.length, cases.length);
});

test('normalization handles Unicode compatibility, smart punctuation, case folding, and line breaks', () => {
  assert.equal(normalize('ＦＵＬＬ－ＷＩＤＴＨ'), 'full-width');
  assert.equal(normalize('İNTİHAR ETMEK İSTİYORUM'), 'intihar etmek istiyorum');
  assert.equal(classify('I don’t want to\nlive.').fire, true);
  assert.equal(classify('KENDİMİ ÖLDÜRECEĞİM').fire, true);
});

test('notice states limitations, capacity truth, and protocol authority', () => {
  const result = classify('I want to die.');
  const notice = buildNotice(result).hookSpecificOutput;
  assert.equal(notice.hookEventName, 'UserPromptSubmit');
  assert.match(notice.additionalContext, /capability state: available/i);
  assert.match(notice.additionalContext, /not a risk assessment/i);
  assert.match(notice.additionalContext, /can both miss crises and over-fire/i);
  assert.match(notice.additionalContext, /\.therapy\/safety-protocol\.md/);
  assert.match(notice.additionalContext, /cannot call services, locate the user, contact anyone, or monitor/i);
  assert.match(notice.additionalContext, /ask for location only when necessary/i);
  assert.match(notice.additionalContext, /jurisdiction-appropriate resources/i);
  assert.match(notice.additionalContext, /user's current language/i);
});

test('degraded notice is fixed, content-free, and keeps the prose protocol authoritative', () => {
  const privatePrompt = 'PRIVATE_PROMPT_4d2b9f /private/path/person-name';
  const notice = buildHealthNotice(privatePrompt).hookSpecificOutput;
  const serialized = JSON.stringify(notice);
  assert.equal(notice.hookEventName, 'UserPromptSubmit');
  assert.match(notice.additionalContext, /capability state: degraded/i);
  assert.match(notice.additionalContext, /prompt was not blocked/i);
  assert.match(notice.additionalContext, /HOOK_PROCESSING_FAILED/);
  assert.match(notice.additionalContext, /safety-protocol\.md/i);
  assert.equal(serialized.includes(privatePrompt), false);
  assert.equal(serialized.includes('/private/path'), false);
});

function runHook(input, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, SCALVIN_HOOK_TIMEOUT_MS: '1500', ...env }
  });
}

function runHookSelfTest(hook = HOOK, env = {}) {
  return spawnSync(process.execPath, [hook, '--self-test', '--json'], {
    encoding: 'utf8',
    timeout: 10000,
    cwd: ROOT,
    env: { ...process.env, SCALVIN_HOOK_TIMEOUT_MS: '500', ...env }
  });
}

test('self-test reports one content-free available attestation', async () => {
  const direct = await runSelfTest(500);
  assert.deepEqual(direct, {
    schemaVersion: 1,
    capability: 'mechanical_safety_backstop',
    state: 'available',
    reasonCode: null
  });

  const privateValue = 'PRIVATE_SELF_TEST_VALUE_d8d557';
  const result = runHookSelfTest(HOOK, { SCALVIN_PRIVATE_SELF_TEST_VALUE: privateValue });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, direct);
  assert.equal(result.stdout.includes(privateValue), false);
  assert.equal(result.stdout.includes(ROOT), false);
});

function makeHookFixture(parent, pack, registry = JSON.parse(fs.readFileSync(RESOURCE_REGISTRY, 'utf8'))) {
  const root = fs.mkdtempSync(path.join(parent, 'safety-hook-'));
  const localeRoot = path.join(root, 'safety-locales');
  fs.mkdirSync(localeRoot);
  fs.copyFileSync(HOOK, path.join(root, 'safety-net.cjs'));
  fs.copyFileSync(RESOURCE_LIBRARY, path.join(root, 'emergency-resources.cjs'));
  if (registry !== null) {
    fs.writeFileSync(path.join(root, 'emergency-resources.json'), `${JSON.stringify(registry)}\n`);
  }
  fs.writeFileSync(path.join(localeRoot, 'en.json'), `${JSON.stringify(pack)}\n`);
  return path.join(root, 'safety-net.cjs');
}

test('CLI emits valid UserPromptSubmit JSON only when fired', () => {
  const firedCase = corpus.find((entry) => entry.gate === 'must-fire');
  const silentCase = corpus.find((entry) => entry.gate === 'must-silent');
  const fired = runHook(JSON.stringify({ prompt: firedCase.text }));
  assert.equal(fired.status, 0);
  const parsed = JSON.parse(fired.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');

  const silent = runHook(JSON.stringify({ prompt: silentCase.text }));
  assert.equal(silent.status, 0);
  assert.equal(silent.stdout, '');
});

test('CLI preserves fail-open availability and exposes content-free degraded health for malformed, missing, and oversized input', () => {
  for (const input of ['', '{broken', JSON.stringify({ noPrompt: true })]) {
    const result = runHook(input);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const notice = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(notice, /capability state: degraded/i);
    assert.match(notice, /prompt was not blocked/i);
    if (input) assert.equal(notice.includes(input), false);
  }
  const privateValue = 'PRIVATE_OVERSIZED_VALUE_90421e';
  const oversized = runHook(JSON.stringify({ prompt: `${privateValue} ${'x'.repeat(MAX_STDIN_CHARS)}` }));
  assert.equal(oversized.status, 0);
  assert.equal(oversized.stderr, '');
  const notice = JSON.parse(oversized.stdout).hookSpecificOutput.additionalContext;
  assert.match(notice, /capability state: degraded/i);
  assert.equal(notice.includes(privateValue), false);
  assert.equal(notice.includes(ROOT), false);
});

test('classifier bounds direct calls as well as stdin', () => {
  assert.equal(classify('x'.repeat(MAX_STDIN_CHARS + 1)).fire, false);
  assert.equal(classify(null).fire, false);
});

test('locale-pack loader validates bounded data-only packs and fails closed on malformed packs', async (t) => {
  const parent = path.join(ROOT, '.test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(parent, 'safety-locales-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'safety-locales', 'en.json'), 'utf8'));

  await t.test('canonical pack loads', () => {
    const directory = path.join(tempRoot, 'valid');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'en.json'), `${JSON.stringify(source)}\n`);
    assert.deepEqual(loadLocalePacks(directory).map((pack) => pack.locale), ['en']);
  });

  await t.test('unknown field is rejected', () => {
    const directory = path.join(tempRoot, 'unknown');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'en.json'), `${JSON.stringify({ ...source, privileged: true })}\n`);
    assert.throws(() => loadLocalePacks(directory), /fields are invalid/);
  });

  await t.test('noncanonical locale and filename mismatch are rejected', () => {
    const directory = path.join(tempRoot, 'locale');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'EN.json'), `${JSON.stringify({ ...source, locale: 'EN' })}\n`);
    assert.throws(() => loadLocalePacks(directory), /canonical locale/);
  });

  await t.test('invalid regex and oversized pack are rejected', () => {
    const invalid = path.join(tempRoot, 'regex');
    fs.mkdirSync(invalid);
    const broken = JSON.parse(JSON.stringify(source));
    broken.domains.self_harm[0] = '(';
    fs.writeFileSync(path.join(invalid, 'en.json'), `${JSON.stringify(broken)}\n`);
    assert.throws(() => loadLocalePacks(invalid));

    const oversized = path.join(tempRoot, 'oversized');
    fs.mkdirSync(oversized);
    fs.writeFileSync(path.join(oversized, 'en.json'), Buffer.alloc(64 * 1024 + 1, 0x20));
    assert.throws(() => loadLocalePacks(oversized), /file is invalid/);
  });
});

test('standalone hook fails open when an installed locale pack is malformed', (t) => {
  const parent = path.join(ROOT, '.test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'safety-locales', 'en.json'), 'utf8'));
  source.domains.self_harm[0] = '(';
  const fixture = makeHookFixture(parent, source);
  t.after(() => fs.rmSync(path.dirname(fixture), { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fixture], {
    input: JSON.stringify({ prompt: 'synthetic safety text' }),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, SCALVIN_HOOK_TIMEOUT_MS: '200' }
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const notice = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(notice, /capability state: degraded/i);
  assert.match(notice, /LOCALE_PACK_LOAD_FAILED/);

  const selfTest = runHookSelfTest(fixture);
  assert.equal(selfTest.status, 0);
  assert.deepEqual(JSON.parse(selfTest.stdout), {
    schemaVersion: 1,
    capability: 'mechanical_safety_backstop',
    state: 'degraded',
    reasonCode: 'LOCALE_PACK_LOAD_FAILED'
  });
});

test('standalone hook visibly degrades when emergency resources are stale or missing', async (t) => {
  const parent = path.join(ROOT, '.test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'safety-locales', 'en.json'), 'utf8'));
  const staleRegistry = JSON.parse(fs.readFileSync(RESOURCE_REGISTRY, 'utf8'));
  for (const jurisdiction of staleRegistry.jurisdictions) {
    jurisdiction.verifiedAt = '2000-01-01';
    jurisdiction.expiresAt = '2000-01-31';
  }
  const scenarios = [
    ['stale', staleRegistry, 'EMERGENCY_RESOURCE_REGISTRY_STALE'],
    ['missing', null, 'EMERGENCY_RESOURCE_REGISTRY_LOAD_FAILED']
  ];
  for (const [label, registry, reasonCode] of scenarios) {
    await t.test(label, () => {
      const fixture = makeHookFixture(parent, pack, registry);
      t.after(() => fs.rmSync(path.dirname(fixture), { recursive: true, force: true }));
      const selfTest = runHookSelfTest(fixture);
      assert.equal(selfTest.status, 0);
      assert.deepEqual(JSON.parse(selfTest.stdout), {
        schemaVersion: 1,
        capability: 'mechanical_safety_backstop',
        state: 'degraded',
        reasonCode
      });
      const privatePrompt = 'PRIVATE_RESOURCE_PROMPT_42';
      const result = spawnSync(process.execPath, [fixture], {
        input: JSON.stringify({ prompt: privatePrompt }),
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, SCALVIN_HOOK_TIMEOUT_MS: '200' }
      });
      assert.equal(result.status, 0);
      const notice = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
      assert.match(notice, new RegExp(reasonCode));
      assert.match(notice, /Do not present bundled contacts as current/i);
      assert.equal(notice.includes(privatePrompt), false);
      assert.equal(notice.includes(ROOT), false);
    });
  }
});

test('standalone hook terminates catastrophic locale regex work within its deadline', (t) => {
  const parent = path.join(ROOT, '.test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'safety-locales', 'en.json'), 'utf8'));
  source.domains.self_harm[0] = '(?:a+)+$';
  const fixture = makeHookFixture(parent, source);
  t.after(() => fs.rmSync(path.dirname(fixture), { recursive: true, force: true }));
  const started = Date.now();
  const result = spawnSync(process.execPath, [fixture], {
    input: JSON.stringify({ prompt: `${'a'.repeat(100_000)}!` }),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, SCALVIN_HOOK_TIMEOUT_MS: '150' }
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const notice = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(notice, /capability state: degraded/i);
  assert.match(notice, /CLASSIFIER_UNAVAILABLE|HOOK_TIMEOUT/);
  assert.ok(Date.now() - started < 5000, 'hook exceeded the bounded fail-open deadline plus process-start allowance');
});
