'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { install, consent, contextGraph, memory } = require('../../cli/operations');
const { canonicalCandidateJson, entityRelative } = require('../../cli/context-graph');
const { ROOT, sandbox, readJson } = require('./helpers');

const NOW = '2026-07-14T12:00:00.000Z';
const PERSON_ID = 'person-10000000-0000-4000-8000-000000000001';
const MEMORY_ID = 'mem-20000000-0000-4000-8000-000000000002';
const DUPLICATE_ID = 'person-10000000-0000-4000-8000-000000000003';
const REFERRER_ID = 'event-10000000-0000-4000-8000-000000000004';

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    type: 'person',
    id: PERSON_ID,
    label: 'Private person label',
    aliases: [],
    summary: 'Private summary shown only by explicit show or merge preview.',
    eventTime: null,
    participantIds: [],
    placeIds: [],
    relatedEntityIds: [],
    memoryIds: [],
    sourceRefs: [],
    sessionRefs: [],
    ...overrides
  };
}

async function enableGraph(workspace) {
  await install({ workspace, consent: 'granted' });
  await consent({ workspace, category: 'context_graph', value: 'on', retention: 'until_deleted' });
}

test('context access gate runs before candidate, patch, or backfill input files are opened', async (t) => {
  const box = await sandbox('context-input-gate');
  t.after(box.cleanup);
  await install({ workspace: box.workspace, consent: 'granted' });
  const missing = path.join(box.base, 'missing-sensitive-input.json');
  await assert.rejects(
    contextGraph({ workspace: box.workspace, action: 'add', 'candidate-file': missing, now: NOW }),
    { code: 'CONTEXT_GRAPH_CONSENT_REQUIRED' }
  );
  await consent({ workspace: box.workspace, category: 'context_graph', value: 'on', retention: 'until_deleted' });
  await memory({ workspace: box.workspace, action: 'seal' });
  await assert.rejects(
    contextGraph({ workspace: box.workspace, action: 'backfill', 'candidates-file': missing }),
    { code: 'MEMORY_SEALED' }
  );
});

test('public context command applies canonical files atomically and emits no internal plan', async (t) => {
  const box = await sandbox('context-command');
  t.after(box.cleanup);
  await enableGraph(box.workspace);
  const candidateFile = path.join(box.base, 'candidate.json');
  await fsp.writeFile(candidateFile, canonicalCandidateJson(candidate()));

  const dry = await contextGraph({ workspace: box.workspace, action: 'add', 'candidate-file': candidateFile, now: NOW, 'dry-run': true });
  assert.equal(dry.status, 'dry-run');
  assert.equal(dry.persisted, false);
  await assert.rejects(fsp.access(path.join(box.workspace, entityRelative(PERSON_ID))), { code: 'ENOENT' });

  const added = await contextGraph({ workspace: box.workspace, action: 'add', 'candidate-file': candidateFile, now: NOW });
  assert.equal(added.status, 'updated');
  assert.equal(added.entityId, PERSON_ID);
  assert.equal(Object.hasOwn(added, 'writes'), false);
  assert.equal(Object.hasOwn(added, 'deletes'), false);
  assert.equal(JSON.stringify(added).includes('Private summary'), false);

  const shown = await contextGraph({ workspace: box.workspace, action: 'show', id: PERSON_ID });
  assert.equal(shown.entity.summary, candidate().summary);
  const status = await contextGraph({ workspace: box.workspace, action: 'status', now: NOW });
  assert.equal(status.total, 1);
  assert.deepEqual(status.counts, { Core: 0, Active: 1, Provisional: 0, Dormant: 0 });
  assert.equal(Object.hasOwn(status, 'expectedIndex'), false);

  const patchFile = path.join(box.base, 'patch.json');
  await fsp.writeFile(patchFile, `${JSON.stringify({ label: 'Corrected label' }, null, 2)}\n`);
  const corrected = await contextGraph({ workspace: box.workspace, action: 'correct', id: PERSON_ID, 'patch-file': patchFile, now: '2026-07-14T12:01:00.000Z' });
  assert.equal(corrected.revision, 2);
  const dormant = await contextGraph({ workspace: box.workspace, action: 'status-change', id: PERSON_ID, status: 'Dormant', now: '2026-07-14T12:02:00.000Z' });
  assert.equal(dormant.contextStatus, 'Dormant');

  const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'scalvin.js'), 'context', 'status', '--workspace', box.workspace, '--now', NOW, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SCALVIN_ALLOW_REPO_TARGET: '1', SCALVIN_DISABLE_LOCAL_POINTER: '1' }
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).total, 1);

  const customized = path.join(box.workspace, '.therapy', 'runtime', 'START-SESSION.md');
  await fsp.appendFile(customized, '\n<!-- user customization -->\n');
  let preview = await contextGraph({ workspace: box.workspace, action: 'forget', id: PERSON_ID, now: '2026-07-14T12:03:00.000Z' });
  assert.equal(preview.status, 'preview');
  assert.equal(JSON.stringify(preview).includes('Corrected label'), false);
  await assert.rejects(
    contextGraph({ workspace: box.workspace, action: 'forget', id: PERSON_ID, confirm: preview.confirmationRequired, now: '2026-07-14T12:04:00.000Z' }),
    { code: 'STALE_CONFIRMATION' }
  );
  await fsp.access(path.join(box.workspace, entityRelative(PERSON_ID)));
  preview = await contextGraph({ workspace: box.workspace, action: 'forget', id: PERSON_ID, now: '2026-07-14T12:04:00.000Z' });
  const forgotten = await contextGraph({ workspace: box.workspace, action: 'forget', id: PERSON_ID, confirm: preview.confirmationRequired, now: '2026-07-14T12:04:00.000Z' });
  assert.equal(forgotten.status, 'deleted');
  assert.match(await fsp.readFile(customized, 'utf8'), /user customization/);
  await assert.rejects(fsp.access(path.join(box.workspace, entityRelative(PERSON_ID))), { code: 'ENOENT' });
  const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
  assert.equal(state.consent.lastOperationalEvent.category, 'context_graph');
});

test('memory forget removes context JSON memory references even when graph is off and memory is sealed', async (t) => {
  const box = await sandbox('memory-context-cleanup');
  t.after(box.cleanup);
  await enableGraph(box.workspace);
  const candidateFile = path.join(box.base, 'candidate.json');
  await fsp.writeFile(candidateFile, canonicalCandidateJson(candidate({ memoryIds: [MEMORY_ID] })));
  await contextGraph({ workspace: box.workspace, action: 'add', 'candidate-file': candidateFile, now: NOW });
  await fsp.appendFile(path.join(box.workspace, 'profile.md'), [
    '',
    `## ${MEMORY_ID} — Private memory`,
    '',
    '- Statement: Private memory statement.',
    '- Kind: explicit',
    '- Status: user_confirmed',
    '- Current revision: 1',
    ''
  ].join('\n'));
  await consent({ workspace: box.workspace, category: 'context_graph', value: 'off', retention: 'do_not_store' });
  await memory({ workspace: box.workspace, action: 'seal' });

  const preview = await memory({ workspace: box.workspace, action: 'forget', id: MEMORY_ID });
  assert.equal(preview.contextReferenceRewrites, 1);
  assert.equal(JSON.stringify(preview).includes('Private memory statement'), false);
  const result = await memory({ workspace: box.workspace, action: 'forget', id: MEMORY_ID, confirm: preview.confirmationRequired });
  assert.equal(result.status, 'deleted');
  assert.equal(result.contextReferenceRewrites, 1);
  const entity = await readJson(path.join(box.workspace, entityRelative(PERSON_ID)));
  assert.deepEqual(entity.memoryIds, []);
  assert.equal(entity.revisionHistory.at(-1).action, 'reference_rewrite');
  assert.equal((await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8')).includes(MEMORY_ID), false);
});

test('context merge confirmation becomes stale when a third-party referrer changes', async (t) => {
  const box = await sandbox('context-merge-stale-referrer');
  t.after(box.cleanup);
  await enableGraph(box.workspace);
  const candidates = [
    candidate({ id: PERSON_ID, label: 'Canonical person' }),
    candidate({ id: DUPLICATE_ID, label: 'Duplicate person' }),
    {
      ...candidate({
        id: REFERRER_ID,
        type: 'event',
        label: 'Referring event',
        eventTime: { value: null, precision: 'unknown' }
      }),
      participantIds: [DUPLICATE_ID]
    }
  ];
  for (const [index, value] of candidates.entries()) {
    const filename = path.join(box.base, `merge-candidate-${index}.json`);
    await fsp.writeFile(filename, canonicalCandidateJson(value));
    await contextGraph({ workspace: box.workspace, action: 'add', 'candidate-file': filename, now: `2026-07-14T12:0${index}:00.000Z` });
  }

  let preview = await contextGraph({
    workspace: box.workspace, action: 'merge', 'canonical-id': PERSON_ID,
    'merged-id': DUPLICATE_ID, now: '2026-07-14T12:10:00.000Z'
  });
  assert.match(preview.confirmationRequired, /^context-merge:\d{13}:[a-f0-9]{64}$/);
  const patchFile = path.join(box.base, 'referrer-patch.json');
  await fsp.writeFile(patchFile, `${JSON.stringify({ label: 'Referring event changed after preview' }, null, 2)}\n`);
  await contextGraph({
    workspace: box.workspace, action: 'correct', id: REFERRER_ID,
    'patch-file': patchFile, now: '2026-07-14T12:11:00.000Z'
  });
  await assert.rejects(contextGraph({
    workspace: box.workspace, action: 'merge', 'canonical-id': PERSON_ID,
    'merged-id': DUPLICATE_ID, confirm: preview.confirmationRequired
  }), { code: 'STALE_CONFIRMATION' });
  await fsp.access(path.join(box.workspace, entityRelative(DUPLICATE_ID)));

  preview = await contextGraph({
    workspace: box.workspace, action: 'merge', 'canonical-id': PERSON_ID,
    'merged-id': DUPLICATE_ID, now: '2026-07-14T12:12:00.000Z'
  });
  const result = await contextGraph({
    workspace: box.workspace, action: 'merge', 'canonical-id': PERSON_ID,
    'merged-id': DUPLICATE_ID, confirm: preview.confirmationRequired
  });
  assert.equal(result.status, 'updated');
  const referrer = await readJson(path.join(box.workspace, entityRelative(REFERRER_ID)));
  assert.deepEqual(referrer.participantIds, [PERSON_ID]);
  await assert.rejects(fsp.access(path.join(box.workspace, entityRelative(DUPLICATE_ID))), { code: 'ENOENT' });
});
