'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { classify } = require(path.join(ROOT, 'hooks', 'safety-net.cjs'));
const corpus = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'evals', 'safety-corpus.json'), 'utf8')
).cases;
const INSTALLED_LOCALES = fs.readdirSync(path.join(ROOT, 'hooks', 'safety-locales'))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -5))
  .sort();

const CLASSES = [
  'code-switching',
  'transliteration',
  'typo-vowel-drop',
  'slang',
  'irony',
  'long-tail-signal',
  'generated-versus-live'
];

test('every adversarial class has must-fire and must-silent cases in every installed locale', () => {
  const adversarial = corpus.filter((entry) => entry.adversarial_class);
  assert.ok(INSTALLED_LOCALES.length > 0);
  assert.equal(adversarial.length, CLASSES.length * INSTALLED_LOCALES.length * 2);
  assert.equal(new Set(adversarial.map((entry) => entry.id)).size, adversarial.length);

  for (const adversarialClass of CLASSES) {
    for (const language of INSTALLED_LOCALES) {
      const paired = adversarial.filter((entry) => (
        entry.adversarial_class === adversarialClass && entry.language === language
      ));
      assert.deepEqual(
        paired.map((entry) => entry.gate).sort(),
        ['must-fire', 'must-silent'],
        `${adversarialClass}:${language}`
      );
    }
  }
});

test('adversarial must-fire and must-silent pairs hold at the classifier boundary', () => {
  for (const entry of corpus.filter((item) => item.adversarial_class)) {
    const result = classify(entry.text);
    assert.equal(result.fire, entry.gate === 'must-fire', entry.id);
    if (entry.expected_domain) {
      assert.ok(result.domains.includes(entry.expected_domain), `${entry.id}:${result.domains.join(',')}`);
    }
  }
});

test('long-tail fixtures put the safety decision after substantial ordinary context', () => {
  const cases = corpus.filter((entry) => entry.adversarial_class === 'long-tail-signal');
  assert.equal(cases.length, INSTALLED_LOCALES.length * 2);
  for (const entry of cases) assert.ok(entry.text.length >= 350, `${entry.id}:${entry.text.length}`);
});
