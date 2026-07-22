'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { validateRelativePath } = require('../../cli/lib/fs-safe');
const { validateManifest } = require('../../cli/lib/manifest');
const { ROOT } = require('./helpers');

async function baseManifest() {
  return JSON.parse(await fsp.readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
}

test('portable path validator keeps a fixed adversarial boundary matrix', () => {
  const invalid = [
    ['', 'empty'],
    ['.', 'dot'],
    ['..', 'dot-dot'],
    ['../escape', 'leading-traversal'],
    ['safe/../escape', 'embedded-traversal'],
    ['/absolute', 'posix-absolute'],
    ['C:\\absolute', 'windows-drive'],
    ['\\\\server\\share', 'windows-unc'],
    ['safe\\file.md', 'backslash'],
    ['safe//file.md', 'empty-component'],
    ['./safe.md', 'leading-dot-component'],
    ['safe/.', 'trailing-dot-component'],
    ['safe/', 'trailing-slash'],
    ['CON', 'windows-con'],
    ['aux.txt', 'windows-aux'],
    ['clock$', 'windows-clock'],
    ['com1.log', 'windows-com'],
    ['lpt9', 'windows-lpt'],
    ['name.', 'trailing-period'],
    ['name ', 'trailing-space'],
    ['name:stream', 'alternate-data-stream'],
    ['line\nfeed', 'line-feed'],
    ['nul\0byte', 'nul-byte'],
    ['cafe\u0301.md', 'non-nfc']
  ];
  assert.equal(invalid.length, 24, 'removing a portable-path attack class requires an explicit contract change');
  for (const [candidate, label] of invalid) {
    assert.throws(() => validateRelativePath(candidate), undefined, label);
  }

  const valid = [
    'café/notes.md',
    'Ελληνικά/Σημείωση.md',
    'Кириллица/Заметка.md',
    '日本語/メモ.md',
    'İstanbul/günlük.md',
    'emoji-😀/note.md'
  ];
  assert.equal(valid.length, 6);
  for (const candidate of valid) assert.equal(validateRelativePath(candidate), candidate);
});

test('manifest source and target collision checks cover multiple Unicode scripts', async () => {
  const pairs = [
    ['Alpha.md', 'alpha.md'],
    ['Écho.md', 'écho.md'],
    ['Σigma.md', 'σigma.md'],
    ['Бeta.md', 'бeta.md']
  ];
  assert.equal(pairs.length, 4, 'ASCII, Latin, Greek, and Cyrillic case boundaries are required');

  for (const [upper, lower] of pairs) {
    const sourceCollision = await baseManifest();
    sourceCollision.files[0].path = `case-source/${upper}`;
    sourceCollision.files[1].path = `case-source/${lower}`;
    assert.throws(() => validateManifest(sourceCollision), { code: 'INVALID_MANIFEST' }, `source:${upper}`);

    const targetCollision = await baseManifest();
    targetCollision.files[0].targets[0].path = `case-target/${upper}`;
    targetCollision.files[1].targets[0].path = `case-target/${lower}`;
    assert.throws(() => validateManifest(targetCollision), { code: 'INVALID_MANIFEST' }, `target:${upper}`);
  }
});

test('manifest rejects canonically equivalent NFD spelling at both trust boundaries', async () => {
  const nfd = 'cafe\u0301.md';
  assert.notEqual(nfd, nfd.normalize('NFC'));

  const source = await baseManifest();
  source.files[0].path = `unicode/${nfd}`;
  assert.throws(() => validateManifest(source), { code: 'INVALID_MANIFEST_PATH' });

  const target = await baseManifest();
  target.files[0].targets[0].path = `unicode/${nfd}`;
  assert.throws(() => validateManifest(target), { code: 'INVALID_MANIFEST_PATH' });
});

test('case-collision detection is independent of manifest entry order', async () => {
  const seedOrder = [3, 1, 4, 0, 2];
  const names = ['ALPHA.md', 'Bravo.md', 'charlie.md', 'delta.md', 'alpha.md'];
  assert.equal(seedOrder.length, names.length);

  for (let rotation = 0; rotation < seedOrder.length; rotation += 1) {
    const candidate = await baseManifest();
    const order = seedOrder.map((value) => (value + rotation) % seedOrder.length);
    for (let index = 0; index < order.length; index += 1) {
      candidate.files[index].path = `order-${rotation}/${names[order[index]]}`;
    }
    assert.throws(() => validateManifest(candidate), { code: 'INVALID_MANIFEST' }, `rotation:${rotation}`);
  }
});
