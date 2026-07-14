'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const markdownFiles = (directory) => fs.readdirSync(path.join(ROOT, directory))
  .filter((name) => name.endsWith('.md'))
  .sort();

test('safety authority separates crisis branches and tells capability truth', () => {
  const safety = read('safety-protocol.md');
  for (const heading of [
    'Passive Death Wishes Or Non-Imminent Suicidal Thoughts',
    'Active Or Imminent Self-Harm / Suicide Risk',
    'Harm To Others',
    'Abuse, Domestic Violence, And Safeguarding',
    'Psychosis, Mania, Severe Disorientation',
    'Medical Emergency, Overdose, Or Severe Intoxication'
  ]) assert.match(safety, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(safety, /cannot call emergency services/i);
  assert.match(safety, /cannot locate the user/i);
  assert.match(safety, /cannot .* monitor/i);
  assert.match(safety, /United States[^\n]*2026-07-14[^\n]*988 Lifeline/);
  assert.match(safety, /Canada[^\n]*2026-07-14[^\n]*Public Health Agency of Canada/);
  assert.match(safety, /Türkiye[\s\S]*2026-07-14[\s\S]*112 Acil Çağrı Merkezi/);
  assert.match(safety, /not an exhaustive or language-based support list/i);
  assert.match(safety, /Never assume the user is in the United States from language alone/i);
  assert.match(safety, /memory is not paused/i);
  assert.match(safety, /body\/sensory prompts are `off`/i);
  assert.doesNotMatch(safety, /^- No acute crisis disclosed\.?$/m);
  assert.doesNotMatch(read('runtime/SESSION-NOTE-STANDARD.md'), /^- No acute crisis disclosed\.?$/m);
});

test('START keeps safety first and loads active runtime contracts before first-session branch', () => {
  const start = read('runtime/START-SESSION.md');
  const safetyIndex = start.indexOf('Read `.therapy/safety-protocol.md` first');
  const firstSessionIndex = start.indexOf('## First Session Handling');
  assert.ok(safetyIndex >= 0 && safetyIndex < firstSessionIndex);
  for (const token of [
    'DATA-AND-CONSENT.md',
    'SESSION-LIFECYCLE.md',
    'MEMORY-PROVENANCE.md',
    'CONTEXT-GRAPH.md',
    'SELF-MODIFICATION.md',
    '.therapy/session-structure.md',
    '.therapy/modalities/',
    'scalvin doctor --workspace <workspace> --json',
    'scalvin review-due --workspace .',
    '.therapy/state/SOURCE-LEDGER.md',
    '(source_id, revision, sha256)',
    'YYYY-MM-DD-HHMMSS--<uuid>--session.md'
  ]) assert.ok(start.includes(token), `START missing ${token}`);
  assert.match(start, /read only `context\/index\.md`/i);
  assert.match(start, /shipped base is immutable/i);
  assert.match(start, /If `continuity_memory` is not yet consented[\s\S]*do not inspect `profile\.md`/i);
  assert.match(start, /Transcript authority is `\.therapy\/state\/DATA-CONTROLS\.md`/i);
  assert.match(start, /`off`, `recording`, `paused`, and `stopped`/i);
  assert.match(start, /`best_effort_context` is allowed only when the user knowingly chose/i);
  assert.match(start, /IFS only when installed, explicitly opted into/i);
  assert.match(start, /do not mechanically translate clinical idioms/i);
  assert.doesNotMatch(start, /Monday, or missed-Monday Tuesday/i);
  assert.doesNotMatch(start, /using the filename format `YYYY-MM-DD-HHMM\.md`/i);
  assert.doesNotMatch(start, /SETUP-NOTES\.md` contains a `## Transcripts`/i);
});

test('all personas declare AI identity/localization and contain no vendor stereotypes or fabricated biography markers', () => {
  const files = markdownFiles('personas');
  assert.ok(files.includes('scalvin.md'));
  for (const file of files) {
    const body = read(path.join('personas', file));
    assert.match(body, /AI companion/i, `${file} missing AI identity`);
    assert.match(body, /language/i, `${file} missing localization rule`);
    assert.match(body, /## Response Shape/i, `${file} missing response-shape contract`);
    assert.doesNotMatch(body, /\*\*Background:\*\*/i, `${file} retains fabricated background`);
    assert.doesNotMatch(body, /GPT models:|Claude models:|Model-Specific Tendencies/i, `${file} retains vendor stereotype`);
    assert.doesNotMatch(body, /You've been through stuff|friend who's done a lot of their own work|Feels like a real person in the room|A human therapist cannot remember/i, `${file} retains identity fabrication`);
  }
});

test('every modality has explicit risk/default/consent/stop/escalation/localization metadata', () => {
  const files = markdownFiles('modalities');
  assert.ok(files.length >= 13);
  for (const file of files) {
    const body = read(path.join('modalities', file));
    for (const token of ['Risk tier', 'Default eligible', 'Review status', 'Consent', 'Stop', 'Escalate', 'Localization']) {
      assert.match(body, new RegExp(token, 'i'), `${file} missing ${token}`);
    }
    assert.doesNotMatch(body, /(?:language|locale)[ -]specific (?:calibration )?example/i, `${file} privileges one runtime language`);
  }
});

test('advanced modalities remain opt-in, quarantined, clinician-bounded, and language-neutral', () => {
  const highRisk = [
    'ideal-parent-figure.md',
    'ifs.md',
    'lifespan-integration.md',
    'somatic-experiencing.md'
  ];
  for (const file of highRisk) {
    const body = read(path.join('modalities', file));
    assert.match(body, /Risk tier:\*\* 3/i, `${file} must be tier 3`);
    assert.match(body, /Default eligible:\*\* no/i, `${file} must not be default`);
    assert.match(body, /Quarantined:/i, `${file} missing quarantine`);
    assert.match(body, /reference-only and quarantined/i, `${file} must be reference-only`);
    assert.match(body, /clinician/i, `${file} missing clinician boundary`);
    assert.match(body, /Localization:/i, `${file} missing language-neutral localization contract`);
    assert.doesNotMatch(body, /(?:language|locale)[ -]specific (?:calibration )?example/i, `${file} privileges one runtime language`);
  }
  assert.match(read('modalities/ideal-parent-figure.md'), /never a setup default/i);
  assert.match(read('modalities/ifs.md'), /unburdening[\s\S]*Do not simulate/i);
  assert.match(read('modalities/lifespan-integration.md'), /Do not simulate/i);
  assert.match(read('modalities/somatic-experiencing.md'), /without claiming trapped energy or discharge/i);
});

test('safety-sensitive moderate modalities include body safeguards without a required language script', () => {
  assert.match(read('modalities/dbt-skills.md'), /never during active self-harm risk/i);
  assert.match(read('modalities/cbt.md'), /formal (?:graded )?exposure only with a qualified clinician/i);
  assert.match(read('modalities/polyvagal.md'), /do not infer/i);
});
