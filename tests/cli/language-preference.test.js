'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, preferences, doctor } = require('../../cli/operations');
const { sandbox, readJson } = require('./helpers');

test('language preference uses one canonical BCP-47 validator across install and preferences', async () => {
  const box = await sandbox('language-preference');
  try {
    await install({ target: box.workspace, consent: 'granted', language: 'ES-419' });
    let state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.preferences.language, 'es-419');

    const changed = await preferences({ target: box.workspace, language: 'ZH-hant' });
    assert.equal(changed.language, 'zh-Hant');
    const renderedTargets = ['AGENTS.md', 'CLAUDE.md', 'susan.md'];
    assert.deepEqual(changed.refreshedManagedTargets, renderedTargets);
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.preferences.language, 'zh-Hant');
    assert.match(await fsp.readFile(path.join(box.workspace, 'SETUP-NOTES.md'), 'utf8'), /^- Default language: zh-Hant$/m);
    for (const relative of renderedTargets) {
      const bytes = await fsp.readFile(path.join(box.workspace, relative));
      assert.match(bytes.toString('utf8'), /zh-Hant/);
      assert.equal(state.files[relative].installedHash, crypto.createHash('sha256').update(bytes).digest('hex'));
    }
    const postChangeDoctor = await doctor({ target: box.workspace });
    assert.equal(postChangeDoctor.status, 'healthy');
    assert.equal(postChangeDoctor.errors, 0);
    assert.equal(postChangeDoctor.warnings, 0);
    assert.equal(
      postChangeDoctor.findings.some((finding) =>
        renderedTargets.includes(finding.target) && ['SIGNED_TARGET_MISMATCH', 'MANAGED_FILE_CUSTOMIZED'].includes(finding.code)),
      false
    );

    await assert.rejects(preferences({ target: box.workspace, language: 'not a BCP-47 tag' }), { code: 'INVALID_PREFERENCE' });
    const reset = await preferences({ target: box.workspace, language: 'auto' });
    assert.equal(reset.language, 'auto');
    const postResetDoctor = await doctor({ target: box.workspace });
    assert.equal(postResetDoctor.status, 'healthy');
    assert.equal(postResetDoctor.errors, 0);
    assert.equal(postResetDoctor.warnings, 0);
  } finally {
    await box.cleanup();
  }
});

test('language changes refuse to overwrite customized rendered client targets', async () => {
  const box = await sandbox('language-rendered-conflict');
  try {
    await install({ target: box.workspace, consent: 'granted', language: 'en' });
    const agentsPath = path.join(box.workspace, 'AGENTS.md');
    await fsp.appendFile(agentsPath, '\nlocal adapter customization\n');
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const setupPath = path.join(box.workspace, 'SETUP-NOTES.md');
    const preservedPaths = [agentsPath, path.join(box.workspace, 'CLAUDE.md'), path.join(box.workspace, 'susan.md'), setupPath];
    const beforeState = await fsp.readFile(statePath, 'utf8');
    const beforeFiles = new Map(await Promise.all(preservedPaths.map(async (filename) => [filename, await fsp.readFile(filename)])));
    await assert.rejects(preferences({ target: box.workspace, language: 'zh-Hant' }), {
      code: 'PREFERENCE_TARGET_CUSTOMIZED'
    });
    const state = await readJson(statePath);
    assert.equal(state.preferences.language, 'en');
    assert.match(await fsp.readFile(agentsPath, 'utf8'), /local adapter customization/);
    assert.equal(await fsp.readFile(statePath, 'utf8'), beforeState);
    for (const [filename, before] of beforeFiles) assert.deepEqual(await fsp.readFile(filename), before);

    const poisoned = JSON.parse(beforeState);
    poisoned.files['AGENTS.md'].installedHash = crypto.createHash('sha256').update(beforeFiles.get(agentsPath)).digest('hex');
    await fsp.writeFile(statePath, `${JSON.stringify(poisoned, null, 2)}\n`, { mode: 0o600 });
    const poisonedState = await fsp.readFile(statePath, 'utf8');
    await assert.rejects(preferences({ target: box.workspace, language: 'zh-Hant' }), {
      code: 'PREFERENCE_TARGET_CUSTOMIZED'
    });
    assert.equal(await fsp.readFile(statePath, 'utf8'), poisonedState);
    for (const [filename, before] of beforeFiles) assert.deepEqual(await fsp.readFile(filename), before);
  } finally {
    await box.cleanup();
  }
});

test('language changes repair a poisoned state baseline only when actual bytes remain signed', async () => {
  const box = await sandbox('language-baseline-repair');
  try {
    await install({ target: box.workspace, consent: 'granted', language: 'en' });
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const state = await readJson(statePath);
    state.files['AGENTS.md'].installedHash = 'f'.repeat(64);
    await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    const changed = await preferences({ target: box.workspace, language: 'zh-Hant' });
    assert.equal(changed.language, 'zh-Hant');
    const repaired = await readJson(statePath);
    const actual = await fsp.readFile(path.join(box.workspace, 'AGENTS.md'));
    assert.equal(repaired.files['AGENTS.md'].installedHash, crypto.createHash('sha256').update(actual).digest('hex'));
    const report = await doctor({ target: box.workspace });
    assert.equal(report.status, 'healthy');
    assert.equal(report.errors, 0);
    assert.equal(report.warnings, 0);
  } finally {
    await box.cleanup();
  }
});

test('language changes reject manifest identity drift without touching the workspace', async () => {
  const box = await sandbox('language-manifest-drift');
  try {
    await install({ target: box.workspace, consent: 'granted', language: 'en' });
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const state = await readJson(statePath);
    state.product.manifestSha256 = '0'.repeat(64);
    await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    const preservedPaths = [
      statePath,
      path.join(box.workspace, 'AGENTS.md'),
      path.join(box.workspace, 'CLAUDE.md'),
      path.join(box.workspace, 'susan.md'),
      path.join(box.workspace, 'SETUP-NOTES.md')
    ];
    const before = new Map(await Promise.all(preservedPaths.map(async (filename) => [filename, await fsp.readFile(filename)])));
    await assert.rejects(preferences({ target: box.workspace, language: 'zh-Hant' }), {
      code: 'WORKSPACE_UPDATE_REQUIRED'
    });
    for (const [filename, bytes] of before) assert.deepEqual(await fsp.readFile(filename), bytes);
  } finally {
    await box.cleanup();
  }
});

test('a specific language is not persisted before consent, while auto remains available', async () => {
  const box = await sandbox('language-consent');
  try {
    await install({ target: box.workspace });
    await assert.rejects(preferences({ target: box.workspace, language: 'es-419' }), { code: 'CONSENT_REQUIRED' });
    await assert.rejects(preferences({ target: box.workspace, timezone: 'Europe/Istanbul' }), { code: 'CONSENT_REQUIRED' });
    await assert.rejects(preferences({ target: box.workspace, 'response-load': 'concise' }), { code: 'CONSENT_REQUIRED' });
    await assert.rejects(preferences({ target: box.workspace, 'reduced-metaphor': 'on' }), { code: 'CONSENT_REQUIRED' });
    await assert.rejects(preferences({ target: box.workspace, 'extra-processing-time': 'on' }), { code: 'CONSENT_REQUIRED' });
    await assert.rejects(preferences({ target: box.workspace, 'stale-memory-offers': 'off' }), { code: 'CONSENT_REQUIRED' });
    const result = await preferences({ target: box.workspace, language: 'auto' });
    assert.equal(result.status, 'unchanged');
    assert.equal(result.language, 'auto');
    const neutral = await preferences({
      target: box.workspace, timezone: 'unconfirmed', 'response-load': 'standard',
      'reduced-metaphor': 'unset', 'extra-processing-time': 'unset'
    });
    assert.equal(neutral.status, 'unchanged');
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.deepEqual(state.consent.timezone, { value: 'unconfirmed', status: 'unconfirmed', confirmedAt: null });
    assert.equal(state.consent.accessibility.reducedMetaphor, 'unset');
    assert.equal(state.consent.accessibility.extraProcessingTime, 'unset');
  } finally {
    await box.cleanup();
  }
});

test('granted accessibility preferences persist reduced metaphor and extra processing time canonically', async () => {
  const box = await sandbox('accessibility-preferences');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const changed = await preferences({
      target: box.workspace,
      timezone: 'Europe/Istanbul',
      'response-load': 'concise',
      'one-question-at-a-time': 'on',
      'plain-language-summaries': 'on',
      'reduced-metaphor': 'on',
      'extra-processing-time': 'on'
    });
    assert.equal(changed.status, 'updated');
    assert.equal(changed.accessibility.reducedMetaphor, 'on');
    assert.equal(changed.accessibility.extraProcessingTime, 'on');
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.timezone.value, 'Europe/Istanbul');
    assert.equal(state.consent.accessibility.reducedMetaphor, 'on');
    assert.equal(state.consent.accessibility.extraProcessingTime, 'on');
    const controls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
    assert.match(controls, /^- Reduced metaphor: on$/m);
    assert.match(controls, /^- Extra processing time: on$/m);
  } finally {
    await box.cleanup();
  }
});

test('control transactions reject a concurrent canonical state write made after their state read', async () => {
  const box = await sandbox('preference-state-read-race');
  try {
    await install({ target: box.workspace, consent: 'granted', language: 'en' });
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    let injected = false;
    const options = { target: box.workspace, language: 'tr' };
    Object.defineProperty(options, 'show-preferred-user-name', {
      enumerable: true,
      get() {
        if (!injected) {
          injected = true;
          const concurrent = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          concurrent.consent.preferredUserName = 'Concurrent Name';
          concurrent.updatedAt = new Date(Date.parse(concurrent.updatedAt) + 1000).toISOString();
          fs.writeFileSync(statePath, `${JSON.stringify(concurrent, null, 2)}\n`, { mode: 0o600 });
        }
        return false;
      }
    });

    await assert.rejects(preferences(options), { code: 'STALE_WORKSPACE' });
    const state = await readJson(statePath);
    assert.equal(state.consent.preferredUserName, 'Concurrent Name');
    assert.equal(state.preferences.language, 'en');
  } finally {
    await box.cleanup();
  }
});
