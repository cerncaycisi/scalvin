'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, consent, source, doctor } = require('../../cli/operations');
const { canonicalEntityJson } = require('../../cli/context-graph');
const { sandbox, readJson } = require('./helpers');

test('source command stages add/delete, blocks unprepared integration, and exposes no content or absolute source path', async (t) => {
  const box = await sandbox('source-command-lifecycle');
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  await consent({
    target: box.workspace, category: 'imported_sources', value: 'on', retention: 'until_deleted'
  });
  await consent({
    target: box.workspace, category: 'context_graph', value: 'on', retention: 'until_deleted'
  });
  const sourcePath = path.join(box.base, 'private-source.txt');
  const privateText = 'Synthetic private source content must never appear in command results.';
  await fsp.writeFile(sourcePath, privateText);

  const dry = await source({ target: box.workspace, action: 'add', path: sourcePath, 'dry-run': true });
  assert.equal(dry.status, 'dry-run');
  assert.equal(dry.persisted, false);
  assert.deepEqual((await readJson(path.join(box.workspace, '.scalvin', 'state.json'))).sourceLifecycle.records, []);

  const added = await source({ target: box.workspace, action: 'add', path: sourcePath });
  assert.equal(added.status, 'ready');
  assert.equal(added.persisted, true);
  assert.equal(added.contentIncluded, false);
  assert.equal(added.absolutePathIncluded, false);
  assert.equal(JSON.stringify(added).includes(privateText), false);
  assert.equal(JSON.stringify(added).includes(sourcePath), false);
  let state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
  assert.equal(state.sourceLifecycle.records[0].sourceId, added.sourceId);
  assert.equal(state.sourceLifecycle.records[0].status, 'ready');
  const contextId = 'person-70000000-0000-4000-8000-000000000007';
  const contextRelative = `context/people/${contextId}.json`;
  const contextRecord = canonicalEntityJson({
    schemaVersion: 1,
    type: 'person',
    id: contextId,
    status: 'Provisional',
    label: 'Source cleanup fixture',
    aliases: [],
    summary: '',
    eventTime: null,
    participantIds: [],
    placeIds: [],
    relatedEntityIds: [],
    memoryIds: [],
    consentEventId: state.consent.decisions.context_graph.eventId,
    provenance: {
      origin: 'imported',
      firstObservedAt: null,
      importedAt: '2026-07-14T10:00:00.000Z',
      lastLiveConfirmedAt: null,
      lastRelevantAt: null
    },
    sourceRefs: [{ sourceId: added.sourceId, revision: 1 }],
    sessionRefs: [],
    revision: 1,
    revisionHistory: [{ revision: 1, at: '2026-07-14T10:00:00.000Z', action: 'backfill', sessionId: null }]
  });
  await fsp.mkdir(path.join(box.workspace, 'context', 'people'), { recursive: true });
  await fsp.writeFile(path.join(box.workspace, contextRelative), contextRecord);

  const status = await source({ target: box.workspace, action: 'status', 'source-id': added.sourceId });
  assert.equal(status.status, 'found');
  assert.equal(status.recordCount, 1);
  assert.equal(status.contentIncluded, false);
  assert.equal(JSON.stringify(status).includes(sourcePath), false);
  assert.equal(JSON.stringify(status).includes(privateText), false);

  await assert.rejects(source({
    target: box.workspace, action: 'integrate', 'source-id': added.sourceId
  }), { code: 'SOURCE_PROPOSAL_UNAVAILABLE' });
  state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
  assert.equal(state.sourceLifecycle.records[0].status, 'ready');

  const deletion = await source({ target: box.workspace, action: 'delete', 'source-id': added.sourceId });
  assert.equal(deletion.status, 'preview');
  assert.equal(deletion.revisions.length, 1);
  assert.equal(deletion.contextReferenceRewrites, 1);
  await assert.rejects(source({
    target: box.workspace, action: 'delete', 'source-id': added.sourceId, confirm: 'wrong'
  }), { code: 'STALE_CONFIRMATION' });
  await fsp.writeFile(sourcePath, `${privateText} revised`);
  const revised = await source({
    target: box.workspace, action: 'add', path: sourcePath, 'source-id': added.sourceId, revision: 2
  });
  assert.equal(revised.revision, 2);
  await assert.rejects(source({
    target: box.workspace, action: 'delete', 'source-id': added.sourceId,
    confirm: deletion.confirmationRequired
  }), { code: 'STALE_CONFIRMATION' });
  const contextBoundDeletion = await source({ target: box.workspace, action: 'delete', 'source-id': added.sourceId });
  assert.deepEqual(contextBoundDeletion.revisions, [1, 2]);
  const concurrentlyChangedContext = JSON.parse(contextRecord);
  concurrentlyChangedContext.summary = 'Concurrent context edit must survive.';
  await fsp.writeFile(path.join(box.workspace, contextRelative), canonicalEntityJson(concurrentlyChangedContext));
  await assert.rejects(source({
    target: box.workspace, action: 'delete', 'source-id': added.sourceId,
    confirm: contextBoundDeletion.confirmationRequired
  }), { code: 'STALE_CONFIRMATION' });
  const freshDeletion = await source({ target: box.workspace, action: 'delete', 'source-id': added.sourceId });
  const deleted = await source({
    target: box.workspace, action: 'delete', 'source-id': added.sourceId,
    confirm: freshDeletion.confirmationRequired
  });
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.contextReferenceRewrites, 1);
  state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
  assert.deepEqual(state.sourceLifecycle.records, []);
  const cleanedContext = JSON.parse(await fsp.readFile(path.join(box.workspace, contextRelative), 'utf8'));
  assert.deepEqual(cleanedContext.sourceRefs, []);
  assert.equal(cleanedContext.revision, 2);
  assert.equal(cleanedContext.summary, 'Concurrent context edit must survive.');
  assert.equal((await doctor({ target: box.workspace })).errors, 0);
});

test('source integration rejects caller-provided proposal files before changing state', async (t) => {
  const box = await sandbox('source-integrate-unavailable');
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  await consent({ target: box.workspace, category: 'imported_sources', value: 'on', retention: 'until_deleted' });
  const sourcePath = path.join(box.base, 'source.txt');
  await fsp.writeFile(sourcePath, 'proposal binding fixture');
  const added = await source({ target: box.workspace, action: 'add', path: sourcePath });
  const before = await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8');
  await assert.rejects(source({
    target: box.workspace, action: 'integrate', 'source-id': added.sourceId,
    'proposed-memory-file': path.join(box.base, 'does-not-exist.json')
  }), { code: 'INVALID_ARGUMENT' });
  assert.equal(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'), before);
});

test('source wrapper failpoint leaves live workspace and canonical state untouched', async (t) => {
  const box = await sandbox('source-command-rollback');
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  await consent({
    target: box.workspace, category: 'imported_sources', value: 'on', retention: 'until_deleted'
  });
  const sourcePath = path.join(box.base, 'source.txt');
  await fsp.writeFile(sourcePath, 'rollback fixture');
  const before = await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8');
  process.env.SCALVIN_TEST_FAILPOINT = 'source-add-before-activate';
  await assert.rejects(source({ target: box.workspace, action: 'add', path: sourcePath }), { code: 'TEST_FAILPOINT' });
  delete process.env.SCALVIN_TEST_FAILPOINT;
  assert.equal(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'), before);
  const sourceObjects = await fsp.readdir(path.join(box.workspace, 'sources', 'objects')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.equal(sourceObjects.length, 0);
});

test('source status and deletion remain available for legacy unsupported retention while normal source use fails closed', async (t) => {
  const box = await sandbox('source-command-legacy-retention-delete');
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  await consent({ target: box.workspace, category: 'imported_sources', value: 'on', retention: 'until_deleted' });
  const sourcePath = path.join(box.base, 'legacy-retention-source.txt');
  await fsp.writeFile(sourcePath, 'legacy retention deletion fixture');
  const added = await source({ target: box.workspace, action: 'add', path: sourcePath });
  const statePath = path.join(box.workspace, '.scalvin', 'state.json');
  const state = await readJson(statePath);
  state.consent.retention.imported_sources = 'rolling_days: 30';
  state.consent.retention.external_care_records = 'until: 2030-01-01';
  await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const status = await source({ target: box.workspace, action: 'status', 'source-id': added.sourceId });
  assert.equal(status.status, 'found');
  await assert.rejects(source({ target: box.workspace, action: 'add', path: sourcePath }), { code: 'UNSUPPORTED_RETENTION_POLICY' });
  const preview = await source({ target: box.workspace, action: 'delete', 'source-id': added.sourceId });
  const deleted = await source({
    target: box.workspace, action: 'delete', 'source-id': added.sourceId, confirm: preview.confirmationRequired
  });
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual((await readJson(statePath)).sourceLifecycle.records, []);
});
