'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  DISTRIBUTION_MANIFEST,
  loadVerifiedSources
} = require('../../cli/operations');
const { loadManifest } = require('../../cli/lib/manifest');
const {
  normalizePreferences,
  buildTargetPlan,
  writePlan
} = require('../../cli/lib/workspace');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_ROOT = process.env.SCALVIN_TEST_ROOT || path.join(ROOT, '.test-tmp');

const ACTIVE_PATHS = Object.freeze({
  persona: '.therapy/persona.md',
  structure: '.therapy/session-structure.md',
  modality: (entry) => `.therapy/modalities/${path.posix.basename(entry.path)}`
});

function selectableRows(manifest) {
  return manifest.files.flatMap((entry) => entry.targets
    .filter((target) => target.activation)
    .map((target) => ({ entry, target, ...target.activation })));
}

function optionsFor(manifest, group, name) {
  return {
    persona: group === 'persona' ? name : manifest.defaults.persona,
    structure: group === 'structure' ? name : manifest.defaults.structure,
    modality: group === 'modality' ? [name] : manifest.defaults.modalities
  };
}

test('removed Scalvin selector is fail-closed unless the updater supplies exact legacy compatibility', async () => {
  const loaded = await loadManifest(DISTRIBUTION_MANIFEST);
  const legacyDefaults = {
    ...loaded.manifest.defaults,
    companionName: 'Scalvin',
    companionSlug: 'scalvin',
    persona: 'scalvin'
  };
  assert.throws(
    () => normalizePreferences(loaded.manifest, {}, legacyDefaults),
    { code: 'UNKNOWN_SELECTION' }
  );

  const migratedDefault = normalizePreferences(loaded.manifest, {}, legacyDefaults, {
    allowLegacyScalvin: true
  });
  assert.equal(migratedDefault.persona, 'susan');
  assert.equal(migratedDefault.companionName, 'Susan');
  assert.equal(migratedDefault.companionSlug, 'susan');

  const migratedCustom = normalizePreferences(loaded.manifest, {}, {
    ...legacyDefaults,
    companionName: 'Alex',
    companionSlug: 'alex'
  }, {
    allowLegacyScalvin: true
  });
  assert.equal(migratedCustom.persona, 'susan');
  assert.equal(migratedCustom.companionName, 'Alex');
  assert.equal(migratedCustom.companionSlug, 'alex');

  assert.throws(
    () => normalizePreferences(loaded.manifest, { persona: 'scalvin' }, legacyDefaults, {
      allowLegacyScalvin: true
    }),
    { code: 'UNKNOWN_SELECTION' }
  );
});

test('manifest-driven behavior fixture maps every selector byte-for-byte into the START-loaded active context', async (t) => {
  await fsp.mkdir(TEST_ROOT, { recursive: true });
  const fixtureRoot = await fsp.mkdtemp(path.join(TEST_ROOT, 'behavior-activation-'));
  t.after(() => fsp.rm(fixtureRoot, { recursive: true, force: true }));

  const loaded = await loadManifest(DISTRIBUTION_MANIFEST);
  const sourceBuffers = await loadVerifiedSources(loaded);
  const rows = selectableRows(loaded.manifest);

  const startEntry = loaded.manifest.files.find((entry) => entry.path === 'runtime/START-SESSION.md');
  assert.ok(startEntry, 'manifest must register the session entrypoint');
  const startBytes = sourceBuffers.get(startEntry.path);
  const defaultPlan = buildTargetPlan(
    loaded.manifest,
    sourceBuffers,
    normalizePreferences(loaded.manifest)
  );
  for (const target of ['START-SESSION.md', '.therapy/runtime/START-SESSION.md']) {
    const item = defaultPlan.find((candidate) => candidate.target === target);
    assert.ok(item, `install plan missing ${target}`);
    assert.deepEqual(item.data, startBytes, `${target} must contain exact START source bytes`);
  }

  const startText = startBytes.toString('utf8');
  assert.match(startText, /Read `\.therapy\/persona\.md`/);
  assert.match(startText, /`\.therapy\/session-structure\.md`/);
  assert.match(startText, /Read every regular Markdown file directly inside `\.therapy\/modalities\/`/);

  for (const group of ['persona', 'structure', 'modality']) {
    const groupRows = rows.filter((row) => row.group === group);
    assert.ok(groupRows.length > 0, `manifest has no selectable ${group}`);
    assert.equal(new Set(groupRows.map((row) => row.name)).size, groupRows.length, `${group} selectors must be unique`);

    for (const row of groupRows) {
      const expectedTarget = typeof ACTIVE_PATHS[group] === 'function'
        ? ACTIVE_PATHS[group](row.entry)
        : ACTIVE_PATHS[group];
      assert.equal(row.target.path, expectedTarget, `${group}:${row.name} has the wrong active path`);
      assert.equal(row.target.protection, 'active', `${group}:${row.name} must be an active target`);
      assert.equal(row.target.render, undefined, `${group}:${row.name} must not transform behavior bytes`);

      const preferences = normalizePreferences(
        loaded.manifest,
        optionsFor(loaded.manifest, group, row.name)
      );
      const plan = buildTargetPlan(loaded.manifest, sourceBuffers, preferences);
      const selected = plan.filter((item) => item.target === expectedTarget);
      assert.equal(selected.length, 1, `${group}:${row.name} must select exactly one active source`);
      assert.equal(selected[0].sourcePath, row.entry.path);
      assert.equal(selected[0].sourceHash, row.entry.sha256);
      assert.equal(selected[0].installedHash, row.entry.sha256);
      assert.deepEqual(selected[0].data, sourceBuffers.get(row.entry.path));

      const selectedBehavior = plan.filter((item) => item.role === row.entry.role && item.protection === 'active');
      if (group === 'modality') assert.deepEqual(selectedBehavior.map((item) => item.sourcePath), [row.entry.path]);
      else assert.equal(selectedBehavior.length, 1, `${group}:${row.name} selected competing active behavior`);

      const caseRoot = path.join(fixtureRoot, `${group}-${row.name}`);
      await fsp.mkdir(caseRoot);
      const startLoadedPlan = plan.filter((item) =>
        ['START-SESSION.md', '.therapy/runtime/START-SESSION.md', '.therapy/persona.md', '.therapy/session-structure.md']
          .includes(item.target) || item.target.startsWith('.therapy/modalities/'));
      await writePlan(caseRoot, startLoadedPlan);
      assert.deepEqual(
        await fsp.readFile(path.join(caseRoot, ...expectedTarget.split('/'))),
        sourceBuffers.get(row.entry.path),
        `${group}:${row.name} changed between source and active context`
      );
      for (const target of ['START-SESSION.md', '.therapy/runtime/START-SESSION.md']) {
        assert.deepEqual(
          await fsp.readFile(path.join(caseRoot, ...target.split('/'))),
          startBytes,
          `${group}:${row.name} did not install the exact START entrypoint`
        );
      }
      if (group === 'modality') {
        const installedModalities = (await fsp.readdir(path.join(caseRoot, '.therapy', 'modalities'), {
          withFileTypes: true
        }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort();
        assert.deepEqual(
          installedModalities,
          [path.posix.basename(row.entry.path)],
          `${group}:${row.name} left an unselected modality in START-loaded context`
        );
      }
    }
  }
});
