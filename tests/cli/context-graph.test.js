'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { sandbox } = require('./helpers');
const {
  canonicalCandidateJson,
  validateCandidate,
  parseCandidateJson,
  parseCorrectionPatchJson,
  entityRelative,
  loadAllEntities,
  planStatus,
  planShow,
  planAdd,
  planCorrect,
  planStatusChange,
  planRemoveMemoryReferences,
  planForget,
  planMerge,
  planBackfill
} = require('../../cli/context-graph');

const NOW = '2026-07-14T10:00:00.000Z';
const LATER = '2026-07-14T10:01:00.000Z';
const LATEST = '2026-07-14T10:02:00.000Z';
const FUTURE = '2026-07-14T10:03:00.000Z';
const FUTURE_LATER = '2026-07-14T10:04:00.000Z';
const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const CONSENT_ID = 'consent-20000000-0000-4000-8000-000000000002';
const SESSION_ID = 's-30000000-0000-4000-8000-000000000003';
const SOURCE_ID = 'src-40000000-0000-4000-8000-000000000004';
const MEMORY_ID = 'mem-50000000-0000-4000-8000-000000000005';

function uuid(number) {
  const first = number.toString(16).padStart(8, '0');
  const tail = number.toString(16).padStart(12, '0');
  return `${first}-0000-4000-8000-${tail}`;
}

function entityId(type, number) {
  return `${type}-${uuid(number)}`;
}

function canonicalState(overrides = {}) {
  const consentOverrides = overrides.consent || {};
  return {
    workspaceId: WORKSPACE_ID,
    ...overrides,
    consent: {
      continuityMemory: 'on',
      contextGraph: 'on',
      usageLedgers: 'on',
      currentSessionId: SESSION_ID,
      memoryPause: { state: 'none', startedAt: null },
      retention: { context_graph: 'until_deleted', usage_ledgers: 'until_deleted' },
      decisions: { context_graph: { at: NOW, eventId: CONSENT_ID } },
      ...consentOverrides,
      memoryPause: consentOverrides.memoryPause || { state: 'none', startedAt: null },
      retention: {
        context_graph: 'until_deleted',
        usage_ledgers: 'until_deleted',
        ...(consentOverrides.retention || {})
      },
      decisions: {
        context_graph: { at: NOW, eventId: CONSENT_ID },
        ...(consentOverrides.decisions || {})
      }
    }
  };
}

function candidate(type, number, overrides = {}) {
  return {
    schemaVersion: 1,
    type,
    id: entityId(type, number),
    label: `${type}-${number}`,
    aliases: [],
    summary: '',
    eventTime: type === 'event' ? { value: null, precision: 'unknown' } : null,
    participantIds: [],
    placeIds: [],
    relatedEntityIds: [],
    memoryIds: [],
    sourceRefs: [],
    sessionRefs: [],
    ...overrides
  };
}

async function prepare(t, label) {
  const box = await sandbox(`context-graph-${label}`);
  t.after(box.cleanup);
  await fsp.mkdir(path.join(box.workspace, 'context', 'people'), { recursive: true });
  await fsp.mkdir(path.join(box.workspace, 'context', 'places'), { recursive: true });
  await fsp.mkdir(path.join(box.workspace, 'context', 'events'), { recursive: true });
  await fsp.mkdir(path.join(box.workspace, '.therapy', 'state'), { recursive: true });
  await fsp.writeFile(path.join(box.workspace, 'context', 'README.md'), '# Context\n');
  await fsp.writeFile(path.join(box.workspace, '.therapy', 'state', 'DELETION-LEDGER.md'), [
    '# Deletion Ledger',
    '',
    '| Event ID | At | Session ID | Data class | Object IDs | Scope | Derived references handled | Known backup warning shown | Result |',
    '|---|---|---|---|---|---|---|---|---|',
    ''
  ].join('\n'));
  await fsp.writeFile(path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md'), [
    '# Backup Ledger',
    '',
    '| Backup ID | Created at | Scope | Destination class | Encryption | Archive SHA-256 | Integrity check | Restore check | Status | Deleted at |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ''
  ].join('\n'));
  return box;
}

async function applyPlan(root, plan) {
  for (const [relative, content] of plan.writes || []) {
    const target = path.join(root, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.test-stage`;
    await fsp.writeFile(temporary, content, { mode: 0o600 });
    await fsp.rename(temporary, target);
  }
  for (const relative of plan.deletes || []) await fsp.rm(path.join(root, relative), { force: true });
}

async function add(root, state, value, status = 'Active', now = NOW) {
  const plan = await planAdd(root, state, { candidate: value, status, now });
  await applyPlan(root, plan);
  return plan;
}

test('every graph read/write gate requires both consents, durable retention, and no memory pause', async (t) => {
  const box = await prepare(t, 'gates');
  const value = candidate('person', 10);
  await assert.rejects(planAdd(box.workspace, canonicalState({ consent: { continuityMemory: 'off' } }), { candidate: value, now: NOW }), { code: 'CONTEXT_CONTINUITY_CONSENT_REQUIRED' });
  await assert.rejects(planStatus(box.workspace, canonicalState({ consent: { contextGraph: 'off' } }), { now: NOW }), { code: 'CONTEXT_GRAPH_CONSENT_REQUIRED' });
  await assert.rejects(planStatus(box.workspace, canonicalState({ consent: { retention: { context_graph: 'do_not_store' } } }), { now: NOW }), { code: 'CONTEXT_RETENTION_NOT_DURABLE' });
  await assert.rejects(planAdd(box.workspace, canonicalState({ consent: { retention: { context_graph: 'session_only' } } }), { candidate: value, now: NOW }), { code: 'CONTEXT_RETENTION_NOT_DURABLE' });
  await assert.rejects(planStatus(box.workspace, canonicalState({ consent: { memoryPause: { state: 'write_pause', startedAt: NOW } } }), { now: NOW }), { code: 'MEMORY_PAUSE_ACTIVE' });
  await assert.rejects(planShow(box.workspace, canonicalState({ consent: { memoryPause: { state: 'sealed_pause', startedAt: NOW } } }), { id: value.id }), { code: 'MEMORY_SEALED' });
  assert.deepEqual(await fsp.readdir(path.join(box.workspace, 'context', 'people')), [], 'failed gates must not write');
});

test('candidate and entity JSON reject malformed, unknown, duplicate, unsorted, and noncanonical input', async (t) => {
  const box = await prepare(t, 'canonical');
  const good = candidate('person', 11, { aliases: ['Zed', 'Åsa'] });
  assert.equal(parseCandidateJson(canonicalCandidateJson(good)).id, good.id);
  await assert.rejects(async () => parseCandidateJson(JSON.stringify(good)), { code: 'CONTEXT_RECORD_NONCANONICAL' });
  await assert.rejects(async () => parseCandidateJson('{broken'), { code: 'CONTEXT_CANDIDATE_INVALID' });
  assert.throws(() => validateCandidate({ ...good, diagnosis: 'forbidden' }), { code: 'CONTEXT_CANDIDATE_INVALID' });
  assert.throws(() => validateCandidate({ ...good, aliases: ['Åsa', 'Zed'] }), { code: 'CONTEXT_RECORD_NONCANONICAL' });
  assert.throws(() => validateCandidate({ ...good, aliases: ['Zed', 'Zed'] }), { code: 'CONTEXT_DUPLICATE' });
  assert.equal(validateCandidate({ ...good, aliases: ['\uE000', '😀'] }).aliases[0], '\uE000', 'sorting must use Unicode scalar values, not UTF-16 or locale order');
  assert.throws(() => validateCandidate({ ...good, aliases: ['😀', '\uE000'] }), { code: 'CONTEXT_RECORD_NONCANONICAL' });
  assert.throws(() => validateCandidate({ ...good, label: 'x'.repeat(121) }), { code: 'CONTEXT_VALUE_INVALID' });
  assert.throws(() => validateCandidate({ ...good, summary: 'x'.repeat(2_001) }), { code: 'CONTEXT_VALUE_INVALID' });
  assert.throws(() => validateCandidate({ ...good, aliases: Array.from({ length: 13 }, (_, index) => `alias-${String(index).padStart(2, '0')}`) }), { code: 'CONTEXT_VALUE_INVALID' });
  assert.throws(() => validateCandidate(candidate('concept', 12)), { code: 'CONTEXT_CANDIDATE_INVALID' });
  assert.throws(() => parseCorrectionPatchJson('{\n  "diagnosis": "no"\n}\n'), { code: 'CONTEXT_PATCH_INVALID' });
  const offsetPlan = await planAdd(box.workspace, canonicalState(), {
    candidate: candidate('place', 12),
    now: '2026-07-14T13:00:00.000+03:00'
  });
  assert.ok(offsetPlan.writes.get(entityRelative(entityId('place', 12))).includes('2026-07-14T13:00:00.000+03:00'));

  await add(box.workspace, canonicalState(), good);
  const relative = entityRelative(good.id);
  const filename = path.join(box.workspace, relative);
  const raw = await fsp.readFile(filename, 'utf8');
  await fsp.writeFile(filename, JSON.stringify(JSON.parse(raw)));
  await assert.rejects(planShow(box.workspace, canonicalState(), { id: good.id }), { code: 'CONTEXT_RECORD_NONCANONICAL' });
  await fsp.writeFile(filename, '{invalid');
  await assert.rejects(planStatus(box.workspace, canonicalState(), { now: NOW }), { code: 'CONTEXT_RECORD_INVALID' });
  const unknown = { ...JSON.parse(raw), contact: 'forbidden' };
  await fsp.writeFile(filename, `${JSON.stringify(unknown, null, 2)}\n`);
  await assert.rejects(planStatus(box.workspace, canonicalState(), { now: NOW }), { code: 'CONTEXT_RECORD_INVALID' });
});

test('managed paths reject traversal, mismatched filenames, concept directories, and symlinks; add is no-clobber', async (t) => {
  const box = await prepare(t, 'paths');
  const value = candidate('person', 13);
  assert.throws(() => entityRelative('../outside'), { code: 'INVALID_CONTEXT_ID' });
  await add(box.workspace, canonicalState(), value);
  await assert.rejects(planAdd(box.workspace, canonicalState(), { candidate: value, now: LATER }), { code: 'CONTEXT_ALREADY_EXISTS' });

  const mismatched = path.join(box.workspace, 'context', 'people', `${entityId('person', 14)}.json`);
  await fsp.copyFile(path.join(box.workspace, entityRelative(value.id)), mismatched);
  await assert.rejects(loadAllEntities(box.workspace), { code: 'CONTEXT_PATH_INVALID' });
  await fsp.rm(mismatched);

  await fsp.mkdir(path.join(box.workspace, 'context', 'concepts'));
  await assert.rejects(planStatus(box.workspace, canonicalState(), { now: NOW }), { code: 'CONTEXT_PATH_INVALID' });
  await fsp.rm(path.join(box.workspace, 'context', 'concepts'), { recursive: true });

  const people = path.join(box.workspace, 'context', 'people');
  await fsp.rename(people, `${people}-real`);
  await fsp.symlink(`${people}-real`, people);
  await assert.rejects(planStatus(box.workspace, canonicalState(), { now: NOW }), { code: 'SYMLINK_REJECTED' });
});

test('correction preserves stable identity, increments revision, and retires prior wording without retaining it in history', async (t) => {
  const box = await prepare(t, 'correction');
  const value = candidate('person', 15, { label: 'Old wording', summary: 'Current neutral context.' });
  await add(box.workspace, canonicalState(), value);
  const planned = await planCorrect(box.workspace, canonicalState(), {
    id: value.id,
    patch: { label: 'Corrected wording' },
    now: LATER
  });
  assert.equal(planned.revision, 2);
  assert.equal((await fsp.readFile(path.join(box.workspace, entityRelative(value.id)), 'utf8')).includes('Corrected wording'), false, 'planning must not mutate');
  await applyPlan(box.workspace, planned);
  const corrected = JSON.parse(await fsp.readFile(path.join(box.workspace, entityRelative(value.id)), 'utf8'));
  assert.equal(corrected.id, value.id);
  assert.equal(corrected.revision, 2);
  assert.equal(corrected.label, 'Corrected wording');
  assert.equal(JSON.stringify(corrected.revisionHistory).includes('Old wording'), false);
  assert.equal(corrected.provenance.lastLiveConfirmedAt, LATER);
  await assert.rejects(planCorrect(box.workspace, canonicalState(), { id: value.id, patch: { diagnosis: 'x' }, now: LATEST }), { code: 'CONTEXT_PATCH_INVALID' });

  const changed = await planStatusChange(box.workspace, canonicalState(), { id: value.id, status: 'Dormant', now: LATEST });
  await applyPlan(box.workspace, changed);
  const dormant = JSON.parse(await fsp.readFile(path.join(box.workspace, entityRelative(value.id)), 'utf8'));
  assert.equal(dormant.status, 'Dormant');
  assert.equal(dormant.revision, 3);
});

test('index regeneration is deterministic, reports total counts, caps visible entries, and keeps Dormant count-only', { timeout: 30_000 }, async (t) => {
  const box = await prepare(t, 'index-caps');
  const state = canonicalState();
  const groups = [
    ['Core', 13, 100],
    ['Active', 25, 200],
    ['Provisional', 11, 300],
    ['Dormant', 2, 400]
  ];
  for (const [status, count, offset] of groups) {
    for (let index = 0; index < count; index += 1) await add(box.workspace, state, candidate('person', offset + index), status);
  }
  const markdown = await fsp.readFile(path.join(box.workspace, 'context', 'index.md'), 'utf8');
  assert.match(markdown, /- Core count: 13/);
  assert.match(markdown, /- Active count: 25/);
  assert.match(markdown, /- Provisional count: 11/);
  assert.match(markdown, /- Dormant count: 2/);
  const core = markdown.slice(markdown.indexOf('## Core'), markdown.indexOf('## Active'));
  const active = markdown.slice(markdown.indexOf('## Active'), markdown.indexOf('## Provisional'));
  const provisional = markdown.slice(markdown.indexOf('## Provisional'), markdown.indexOf('## Dormant'));
  const dormant = markdown.slice(markdown.indexOf('## Dormant'));
  assert.equal((core.match(/^\| person-/gm) || []).length, 12);
  assert.equal((active.match(/^\| person-/gm) || []).length, 24);
  assert.equal((provisional.match(/^\| person-/gm) || []).length, 10);
  assert.equal((dormant.match(/person-/g) || []).length, 0);

  const status = await planStatus(box.workspace, state, { now: NOW });
  assert.deepEqual(status.counts, { Core: 13, Active: 25, Provisional: 11, Dormant: 2 });
  assert.equal(status.total, 51);
  assert.equal(status.visible.Core.length, 12);
  assert.deepEqual(status.visible.Core, [...status.visible.Core].sort());
});

test('forget remains available during sealed pause, emits no content, cleans graph references, and leaves historical source/session bodies untouched', async (t) => {
  const box = await prepare(t, 'sealed-forget');
  const state = canonicalState();
  const person = candidate('person', 500, {
    label: 'Private label must not leak',
    summary: 'Private summary must not leak',
    sourceRefs: [{ sourceId: SOURCE_ID, revision: 2 }],
    sessionRefs: [SESSION_ID]
  });
  const event = candidate('event', 501, {
    label: 'Neutral event',
    participantIds: [person.id]
  });
  await add(box.workspace, state, person);
  await add(box.workspace, state, event);
  await fsp.appendFile(path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md'), `| backup-${uuid(502)} | ${NOW} | full | local_user_selected | yes | opaque | passed | not_run | ready | null |\n`);
  await fsp.mkdir(path.join(box.workspace, 'sessions'), { recursive: true });
  await fsp.mkdir(path.join(box.workspace, 'sources'), { recursive: true });
  const sessionBody = `Historical body keeps ${person.id}.\n`;
  const sourceBody = `Original source keeps ${person.id}.\n`;
  await fsp.writeFile(path.join(box.workspace, 'sessions', 'historical.md'), sessionBody);
  await fsp.writeFile(path.join(box.workspace, 'sources', 'original.txt'), sourceBody);

  const sealed = canonicalState({ consent: { memoryPause: { state: 'sealed_pause', startedAt: LATER } } });
  const planned = await planForget(box.workspace, sealed, { id: person.id, now: LATEST, idFactory: () => uuid(503) });
  assert.equal(planned.knownBackupRecords, 1);
  assert.equal(planned.receiptPlanned, true);
  assert.equal(planned.referenceRewrites, 1);
  const publicMetadata = { ...planned, writes: undefined, deletes: planned.deletes.length };
  assert.equal(JSON.stringify(publicMetadata).includes('Private label'), false);
  assert.equal(JSON.stringify(publicMetadata).includes('Private summary'), false);
  const receipt = planned.writes.get('.therapy/state/DELETION-LEDGER.md');
  assert.equal(receipt.includes('Private label'), false);
  assert.equal(receipt.includes('Private summary'), false);
  assert.equal(receipt.toLowerCase().includes('hash'), false);
  assert.ok(receipt.includes(person.id));
  assert.ok(receipt.includes(`${SOURCE_ID}:r2`));
  await applyPlan(box.workspace, planned);

  await assert.rejects(fsp.access(path.join(box.workspace, entityRelative(person.id))), { code: 'ENOENT' });
  const rewrittenEvent = JSON.parse(await fsp.readFile(path.join(box.workspace, entityRelative(event.id)), 'utf8'));
  assert.deepEqual(rewrittenEvent.participantIds, []);
  assert.equal(rewrittenEvent.revision, 2);
  assert.equal(await fsp.readFile(path.join(box.workspace, 'sessions', 'historical.md'), 'utf8'), sessionBody);
  assert.equal(await fsp.readFile(path.join(box.workspace, 'sources', 'original.txt'), 'utf8'), sourceBody);
  assert.equal((await fsp.readFile(path.join(box.workspace, 'context', 'index.md'), 'utf8')).includes(person.id), false);

  const repeated = await planForget(box.workspace, sealed, { id: person.id, now: LATEST });
  assert.equal(repeated.alreadyAbsent, true);
  assert.equal(repeated.writes.size, 0);
});

test('memory deletion can mechanically remove JSON graph references during sealed pause without touching historical bodies', async (t) => {
  const box = await prepare(t, 'memory-ref-cleanup');
  const value = candidate('person', 550, { memoryIds: [MEMORY_ID] });
  await add(box.workspace, canonicalState(), value);
  await fsp.mkdir(path.join(box.workspace, 'sessions'), { recursive: true });
  const historical = `Historical session retains ${MEMORY_ID} under its own retention.\n`;
  await fsp.writeFile(path.join(box.workspace, 'sessions', 'historical.md'), historical);
  const sealed = canonicalState({ consent: {
    continuityMemory: 'off',
    contextGraph: 'off',
    retention: { context_graph: 'do_not_store' },
    memoryPause: { state: 'sealed_pause', startedAt: LATER }
  } });
  const planned = await planRemoveMemoryReferences(box.workspace, sealed, { ids: [MEMORY_ID], now: LATEST });
  assert.equal(planned.referenceRewrites, 1);
  assert.equal((await fsp.readFile(path.join(box.workspace, entityRelative(value.id)), 'utf8')).includes(MEMORY_ID), true, 'planning must not mutate');
  assert.equal([...planned.writes.keys()].some((relative) => relative.startsWith('sessions/')), false);
  await applyPlan(box.workspace, planned);
  const rewritten = JSON.parse(await fsp.readFile(path.join(box.workspace, entityRelative(value.id)), 'utf8'));
  assert.deepEqual(rewritten.memoryIds, []);
  assert.equal(rewritten.revision, 2);
  assert.equal(await fsp.readFile(path.join(box.workspace, 'sessions', 'historical.md'), 'utf8'), historical);
  await assert.rejects(planRemoveMemoryReferences(box.workspace, sealed, { ids: [MEMORY_ID, MEMORY_ID], now: LATEST }), { code: 'CONTEXT_DUPLICATE' });
});

test('sealed forget still deletes a malformed target and cleans references without parsing or exposing target content', async (t) => {
  const box = await prepare(t, 'malformed-sealed-forget');
  const state = canonicalState();
  const person = candidate('person', 560, { label: 'Do not expose malformed target' });
  const event = candidate('event', 561, { participantIds: [person.id] });
  await add(box.workspace, state, person);
  await add(box.workspace, state, event);
  await fsp.writeFile(path.join(box.workspace, entityRelative(person.id)), '{malformed private bytes');
  const sealed = canonicalState({ consent: { memoryPause: { state: 'sealed_pause', startedAt: LATER } } });
  const planned = await planForget(box.workspace, sealed, { id: person.id, now: LATEST, idFactory: () => uuid(562) });
  assert.equal(planned.targetRecordValid, false);
  assert.equal(planned.referenceRewrites, 1);
  assert.equal(planned.writes.get('.therapy/state/DELETION-LEDGER.md').includes('malformed private bytes'), false);
  await applyPlan(box.workspace, planned);
  await assert.rejects(fsp.access(path.join(box.workspace, entityRelative(person.id))), { code: 'ENOENT' });
  const cleaned = JSON.parse(await fsp.readFile(path.join(box.workspace, entityRelative(event.id)), 'utf8'));
  assert.deepEqual(cleaned.participantIds, []);
});

test('merge previews both entities, binds exact current state, rewrites references, and suppresses only content-free provenance', async (t) => {
  const box = await prepare(t, 'merge');
  const state = canonicalState();
  const canonical = candidate('person', 600, { label: 'Canonical', summary: 'Keep this current context.' });
  const duplicate = candidate('person', 601, { label: 'Duplicate', summary: 'Conflicting context.', sourceRefs: [{ sourceId: SOURCE_ID, revision: 1 }] });
  const event = candidate('event', 602, { label: 'Linked event', participantIds: [duplicate.id] });
  await add(box.workspace, state, canonical);
  await add(box.workspace, state, duplicate);
  await add(box.workspace, state, event);

  const firstPreview = await planMerge(box.workspace, state, { canonicalId: canonical.id, mergedId: duplicate.id, now: LATER });
  assert.equal(firstPreview.preview, true);
  assert.equal(firstPreview.writes.size, 0);
  assert.equal(firstPreview.knownBackupRecords, 0);
  assert.ok(firstPreview.conflicts.includes('label'));
  assert.equal(firstPreview.canonicalEntity.id, canonical.id);
  assert.equal(firstPreview.mergedEntity.id, duplicate.id);
  await assert.rejects(planMerge(box.workspace, state, { canonicalId: canonical.id, mergedId: duplicate.id, confirm: 'wrong', now: LATEST }), { code: 'CONTEXT_CONFIRMATION_MISMATCH' });

  const correction = await planCorrect(box.workspace, state, { id: canonical.id, patch: { summary: 'Newer canonical context.' }, now: LATEST });
  await applyPlan(box.workspace, correction);
  await assert.rejects(planMerge(box.workspace, state, { canonicalId: canonical.id, mergedId: duplicate.id, confirm: firstPreview.confirmation, now: LATEST }), { code: 'CONTEXT_CONFIRMATION_MISMATCH' });

  const preview = await planMerge(box.workspace, state, { canonicalId: canonical.id, mergedId: duplicate.id, now: FUTURE });
  const merged = await planMerge(box.workspace, state, {
    canonicalId: canonical.id,
    mergedId: duplicate.id,
    confirm: preview.confirmation,
    now: FUTURE_LATER,
    idFactory: () => uuid(603)
  });
  assert.equal(merged.preview, false);
  await applyPlan(box.workspace, merged);
  await assert.rejects(fsp.access(path.join(box.workspace, entityRelative(duplicate.id))), { code: 'ENOENT' });
  const result = JSON.parse(await fsp.readFile(path.join(box.workspace, entityRelative(canonical.id)), 'utf8'));
  assert.equal(result.id, canonical.id);
  assert.ok(result.aliases.includes('Duplicate'));
  assert.equal(result.summary, 'Newer canonical context.');
  const linked = JSON.parse(await fsp.readFile(path.join(box.workspace, entityRelative(event.id)), 'utf8'));
  assert.deepEqual(linked.participantIds, [canonical.id]);
  const receipt = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DELETION-LEDGER.md'), 'utf8');
  assert.ok(receipt.includes(duplicate.id));
  assert.equal(receipt.includes('Duplicate'), false);
  assert.equal(receipt.includes('Conflicting context'), false);
});

test('supervised backfill is max-five, no-write before exact confirmation, token-bound, provisional, idempotent, and retains no rejected content', async (t) => {
  const box = await prepare(t, 'backfill');
  const state = canonicalState();
  const approved = candidate('person', 700, {
    label: 'Approved legacy person',
    summary: 'Approved imported context.',
    sourceRefs: [{ sourceId: SOURCE_ID, revision: 3 }]
  });
  const rejected = candidate('place', 701, {
    label: 'REJECTED PRIVATE PLACE',
    summary: 'REJECTED PRIVATE CONTENT'
  });
  const tooMany = Array.from({ length: 6 }, (_, index) => candidate('person', 710 + index));
  await assert.rejects(planBackfill(box.workspace, state, { candidates: tooMany, approvedIds: [], now: NOW }), { code: 'CONTEXT_BACKFILL_LIMIT' });

  const preview = await planBackfill(box.workspace, state, {
    candidates: [rejected, approved],
    approvedIds: [approved.id],
    now: NOW
  });
  assert.equal(preview.preview, true);
  assert.equal(preview.writes.size, 0);
  assert.deepEqual(await fsp.readdir(path.join(box.workspace, 'context', 'people')), []);

  const changedRejected = { ...rejected, summary: 'Changed rejected content still binds the token.' };
  await assert.rejects(planBackfill(box.workspace, state, {
    candidates: [approved, changedRejected],
    approvedIds: [approved.id],
    confirm: preview.confirmation,
    now: LATER
  }), { code: 'CONTEXT_CONFIRMATION_MISMATCH' });
  await assert.rejects(planBackfill(box.workspace, state, {
    candidates: [approved, rejected],
    approvedIds: [rejected.id],
    confirm: preview.confirmation,
    now: LATER
  }), { code: 'CONTEXT_CONFIRMATION_MISMATCH' });

  const applied = await planBackfill(box.workspace, state, {
    candidates: [approved, rejected],
    approvedIds: [approved.id],
    confirm: preview.confirmation,
    now: LATER
  });
  assert.equal(applied.addedCount, 1);
  assert.equal([...applied.writes.values()].join('\n').includes('REJECTED PRIVATE'), false);
  await applyPlan(box.workspace, applied);
  const imported = JSON.parse(await fsp.readFile(path.join(box.workspace, entityRelative(approved.id)), 'utf8'));
  assert.equal(imported.status, 'Provisional');
  assert.equal(imported.provenance.origin, 'imported');
  assert.equal(imported.provenance.importedAt, LATER);
  assert.equal(imported.provenance.firstObservedAt, null);
  assert.equal(imported.provenance.lastLiveConfirmedAt, null);
  await assert.rejects(fsp.access(path.join(box.workspace, entityRelative(rejected.id))), { code: 'ENOENT' });
  assert.equal((await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DELETION-LEDGER.md'), 'utf8')).includes('REJECTED PRIVATE'), false);

  const repeatPreview = await planBackfill(box.workspace, state, { candidates: [approved, rejected], approvedIds: [approved.id] });
  const repeat = await planBackfill(box.workspace, state, {
    candidates: [approved, rejected], approvedIds: [approved.id], confirm: repeatPreview.confirmation, now: LATEST
  });
  assert.equal(repeat.addedCount, 0);
  assert.deepEqual(repeat.alreadyPresentIds, [approved.id]);
  assert.equal(repeat.writes.size, 0);

  const forgotten = await planForget(box.workspace, canonicalState({ consent: { memoryPause: { state: 'sealed_pause', startedAt: LATEST } } }), {
    id: approved.id, now: LATEST, idFactory: () => uuid(720)
  });
  await applyPlan(box.workspace, forgotten);
  const suppressedPreview = await planBackfill(box.workspace, state, { candidates: [approved], approvedIds: [approved.id] });
  await assert.rejects(planBackfill(box.workspace, state, {
    candidates: [approved], approvedIds: [approved.id], confirm: suppressedPreview.confirmation, now: LATEST
  }), { code: 'CONTEXT_BACKFILL_SUPPRESSED' });

  const sameProvenance = candidate('person', 721, {
    label: 'A regenerated ID for the same forgotten provenance',
    sourceRefs: [{ sourceId: SOURCE_ID, revision: 3 }]
  });
  const provenancePreview = await planBackfill(box.workspace, state, { candidates: [sameProvenance], approvedIds: [sameProvenance.id] });
  await assert.rejects(planBackfill(box.workspace, state, {
    candidates: [sameProvenance], approvedIds: [sameProvenance.id], confirm: provenancePreview.confirmation, now: LATEST
  }), { code: 'CONTEXT_BACKFILL_SUPPRESSED' });
});
