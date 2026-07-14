'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'persona-boundaries.json'), 'utf8'));

test('persona boundary corpus uses valid representative locales and accepted risk classes', () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.ok(corpus.description.includes('not claims about model output'));
  assert.ok(corpus.cases.length >= 18);
  const locales = new Set(corpus.cases.map((item) => item.locale));
  assert.ok(locales.size >= 2, 'representative corpus should exercise more than one locale');
  for (const locale of locales) {
    assert.deepEqual(Intl.getCanonicalLocales(locale), [locale], `non-canonical locale ${locale}`);
  }
  const risks = new Set(corpus.cases.map((item) => item.risk));
  for (const risk of [
    'dependency', 'identity_deception', 'fabricated_experience',
    'capability_deception', 'overconfident_challenge', 'harmful_validation',
    'rupture', 'technique_deception', 'response_shape'
  ]) assert.ok(risks.has(risk), `missing ${risk}`);
  const ids = new Set();
  for (const item of corpus.cases) {
    assert.match(item.id, /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9-]+$/);
    assert.ok(item.id.startsWith(`${item.locale}-`), `${item.id}: locale prefix mismatch`);
    assert.equal(ids.has(item.id), false, `duplicate ${item.id}`);
    ids.add(item.id);
    assert.ok(item.prompt.trim().length > 5);
    assert.ok(Array.isArray(item.expectedRules) && item.expectedRules.length >= 2);
  }
});

test('every persona declares bounded response shape and rejects identity fabrication', () => {
  const directory = path.join(ROOT, 'personas');
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.md')).sort()) {
    const body = fs.readFileSync(path.join(directory, name), 'utf8');
    assert.match(body, /^## Response Shape$/m, `${name}: response shape`);
    assert.match(body, /AI companion/i, `${name}: AI identity`);
    assert.match(body, /one|at most|short/i, `${name}: bounded default`);
    assert.match(body, /language/i, `${name}: missing language-neutral localization rule`);
    assert.doesNotMatch(body, /friend who's done|genuinely see how the pieces fit|that would mess with me too|someone who has seen a lot/i, `${name}: fabricated human cue`);
  }
});

test('runtime contracts cover corpus rule vocabulary without claiming model-output certification', () => {
  const runtime = [
    'runtime/START-SESSION.md',
    'runtime/RUPTURE-AND-REPAIR.md',
    'runtime/LIVE-MOVESET.md',
    'runtime/DATA-AND-CONSENT.md',
    'safety-protocol.md'
  ].map((name) => fs.readFileSync(path.join(ROOT, name), 'utf8')).join('\n');
  for (const pattern of [
    /independent functioning|independence/i,
    /AI\/user relationship|AI companion/i,
    /cannot guarantee confidentiality|do not imply confidentiality/i,
    /apolog/i,
    /stop/i,
    /one (?:good )?move|one question at a time|one conversational move/i,
    /harmful actions|violence|abuse/i,
    /explain.*approach|explain.*method|technique/i
  ]) assert.match(runtime, pattern);
});
