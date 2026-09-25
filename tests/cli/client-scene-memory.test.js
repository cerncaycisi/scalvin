'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  applyPlan,
  memoryBlocks,
  planClientSceneCreate,
  planMemoryCreate,
  planCorrection,
  planForgetMany
} = require('../../cli/memory-data');

const SESSION_ID = 's-223e4567-e89b-42d3-a456-426614174000';
const CONSENT_ID = 'consent-323e4567-e89b-42d3-a456-426614174000';
const MEMORY_ID = 'mem-423e4567-e89b-42d3-a456-426614174000';

test('client-scene planner writes one canonical bounded record with broker-derived authority fields', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-client-scene-plan-'));
  await fsp.mkdir(path.join(root, 'sources'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const input = {
    title: 'The railway platform',
    statement: 'I felt supported when my friend stayed with me.',
    scene: 'My friend waited beside me on the platform until the train arrived.'
  };
  const plan = await planClientSceneCreate(root, {
    id: MEMORY_ID,
    ...input,
    observedAt: '2026-07-15T12:00:00.000Z',
    sessionId: SESSION_ID,
    consentEventId: CONSENT_ID
  });
  assert.equal(plan.retentionClass, 'client_scene_memories');
  assert.equal(plan.category, 'client-scenes');
  assert.deepEqual(plan.affectedPaths, ['sources/client-told-memories.md']);
  await applyPlan(root, plan);

  const persisted = await fsp.readFile(path.join(root, 'sources', 'client-told-memories.md'), 'utf8');
  const records = memoryBlocks(persisted);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, MEMORY_ID);
  assert.equal(records[0].kind, 'client_scene');
  assert.equal(records[0].statement, input.statement);
  assert.match(persisted, /^> My friend waited beside me/m);
  assert.match(persisted, /^#### Companion Interpretation\n\n> none$/m);

  const correction = await planCorrection(root, MEMORY_ID, 'I felt cared for when my friend stayed.', '2026-07-16T12:00:00.000Z');
  assert.equal(correction.retentionClass, 'client_scene_memories');
  assert.equal(correction.category, 'client-scenes');
  assert.deepEqual(correction.affectedPaths, ['sources/client-told-memories.md']);
  const corrected = correction.writes.get('sources/client-told-memories.md');
  const correctedRecords = memoryBlocks(corrected);
  assert.equal(correctedRecords.length, 1);
  assert.equal(correctedRecords[0].id, MEMORY_ID);
  assert.equal(correctedRecords[0].statement, 'I felt cared for when my friend stayed.');
  assert.equal(correctedRecords[0].currentRevision, '2');
  assert.match(corrected, /user correction; prior wording retired: "I felt supported when my friend stayed with me\."/);
});

test('client-scene planner rejects structural injection and an existing generated identity', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-client-scene-reject-'));
  await fsp.mkdir(path.join(root, 'sources'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const input = {
    title: 'Bounded scene',
    statement: 'A bounded statement.',
    scene: 'A bounded user-told scene.'
  };
  const canonical = {
    id: MEMORY_ID,
    ...input,
    observedAt: '2026-07-15T12:00:00.000Z',
    sessionId: SESSION_ID,
    consentEventId: CONSENT_ID
  };
  await assert.rejects(
    planClientSceneCreate(root, { ...canonical, scene: 'safe\n### mem-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa — injected' }),
    { code: 'CLIENT_SCENE_INVALID' }
  );
  const plan = await planClientSceneCreate(root, canonical);
  await applyPlan(root, plan);
  await assert.rejects(planClientSceneCreate(root, canonical), { code: 'MEMORY_ID_DUPLICATED' });
});

test('general memory planner binds category, kind, active session, consent provenance, and canonical placement', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-memory-create-plan-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, 'profile.md'), '# Profile\n');
  await fsp.writeFile(path.join(root, 'ACTIVE-THEMES.md'), '# Active Themes\n');
  await fsp.writeFile(path.join(root, 'CURRENT-FOCUS.md'), '# Current Focus\n');
  const cases = [
    { id: MEMORY_ID, category: 'profile', kind: 'preference', target: 'profile.md' },
    { id: 'theme-523e4567-e89b-42d3-a456-426614174000', category: 'themes', kind: 'theme', target: 'ACTIVE-THEMES.md' },
    { id: 'focus-623e4567-e89b-42d3-a456-426614174000', category: 'focus', kind: 'goal', target: 'CURRENT-FOCUS.md' }
  ];
  for (const item of cases) {
    const plan = await planMemoryCreate(root, {
      id: item.id,
      category: item.category,
      kind: item.kind,
      title: 'Canonical live memory',
      statement: 'This statement was explicitly confirmed during the active session.',
      observedAt: '2026-07-15T12:00:00.000Z',
      sessionId: SESSION_ID,
      consentEventId: CONSENT_ID
    });
    assert.deepEqual(plan.affectedPaths, [item.target]);
    await applyPlan(root, plan);
    const persisted = await fsp.readFile(path.join(root, item.target), 'utf8');
    const record = memoryBlocks(persisted).find((candidate) => candidate.id === item.id);
    assert.equal(record.kind, item.kind);
    assert.equal(record.status, 'user_confirmed');
    assert.equal(record.firstSession, SESSION_ID);
    assert.match(persisted, new RegExp(`Consent event: ${CONSENT_ID}`));
  }
  await assert.rejects(planMemoryCreate(root, {
    id: 'theme-723e4567-e89b-42d3-a456-426614174000', category: 'themes', kind: 'goal',
    title: 'Wrong category-kind pair', statement: 'This must be refused.',
    observedAt: '2026-07-15T12:00:00.000Z', sessionId: SESSION_ID, consentEventId: CONSENT_ID
  }), { code: 'MEMORY_CREATE_INVALID' });
});

test('memory correction rejects every noncanonical line separator before rendering', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-memory-correction-line-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const injectedId = 'mem-523e4567-e89b-42d3-a456-426614174000';
  for (const separator of ['\u0085', '\u2028', '\u2029']) {
    await assert.rejects(
      planCorrection(root, MEMORY_ID, `bounded${separator}### ${injectedId} — injected`),
      { code: 'INVALID_MEMORY_STATEMENT' }
    );
  }
  await assert.rejects(planCorrection(root, MEMORY_ID, ' padded wording '), { code: 'INVALID_MEMORY_STATEMENT' });
  await assert.rejects(planCorrection(root, MEMORY_ID, '😀'.repeat(501)), { code: 'INVALID_MEMORY_STATEMENT' });
});

test('memory deletion requires exactly one active record for every selected ID', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-memory-forget-duplicate-'));
  await fsp.mkdir(path.join(root, 'sources'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const canonical = {
    id: MEMORY_ID,
    title: 'One stable identity',
    statement: 'The same identity must not exist in two active layers.',
    scene: 'A bounded client-told scene.',
    observedAt: '2026-07-15T12:00:00.000Z',
    sessionId: SESSION_ID,
    consentEventId: CONSENT_ID
  };
  const created = await planClientSceneCreate(root, canonical);
  await applyPlan(root, created);
  const duplicated = await fsp.readFile(path.join(root, 'sources', 'client-told-memories.md'), 'utf8');
  await fsp.writeFile(path.join(root, 'profile.md'), duplicated);

  await assert.rejects(planForgetMany(root, [MEMORY_ID]), { code: 'MEMORY_ID_DUPLICATED' });
  assert.match(await fsp.readFile(path.join(root, 'profile.md'), 'utf8'), new RegExp(MEMORY_ID));
  assert.match(await fsp.readFile(path.join(root, 'sources', 'client-told-memories.md'), 'utf8'), new RegExp(MEMORY_ID));
});

test('a correction is a live confirmation: stale review metadata moves with the new wording', async (t) => {
  const { dueState } = require('../../cli/memory-review');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-correction-review-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const oldSession = 's-523e4567-e89b-42d3-a456-426614174000';
  await fsp.writeFile(path.join(root, 'profile.md'), [
    '# Profile',
    '',
    `### ${MEMORY_ID} — Preference`,
    '',
    '- Statement: I prefer morning check-ins.',
    '- Kind: preference',
    '- Status: user_confirmed',
    '- First observed: 2026-01-01T09:00:00.000Z',
    `- First session: ${oldSession}`,
    '- Imported at: null',
    '- Last live confirmed: 2026-01-01T09:00:00.000Z',
    `- Last confirmed session: ${oldSession}`,
    '- Review state: due',
    '- Current revision: 1',
    ''
  ].join('\n'));
  const sessions = ['2026-03-01', '2026-04-01', '2026-05-01'].map((day, index) => ({
    sessionId: `s-${index}23e4567-e89b-42d3-a456-426614174111`,
    closedAt: Date.parse(`${day}T12:00:00.000Z`)
  }));
  const now = { value: '2026-09-04T12:00:00.000Z', milliseconds: Date.parse('2026-09-04T12:00:00.000Z') };
  const [before] = memoryBlocks(await fsp.readFile(path.join(root, 'profile.md'), 'utf8'));
  assert.equal(dueState(before, sessions, now).due, true);

  const plan = await planCorrection(root, MEMORY_ID, 'I prefer evening check-ins.', now.value, { sessionId: SESSION_ID });
  const corrected = plan.writes.get('profile.md');
  const [after] = memoryBlocks(corrected);
  assert.equal(after.statement, 'I prefer evening check-ins.');
  assert.equal(after.lastLiveConfirmed, now.value);
  assert.equal(after.lastConfirmedSession, SESSION_ID);
  assert.equal(after.reviewState, 'current');
  assert.doesNotMatch(corrected, /Review declined/);
  assert.match(corrected, new RegExp(`r2 — ${now.value} — user correction in ${SESSION_ID}; prior wording retired`));
  assert.equal(dueState(after, sessions, now).due, false);

  const offSession = await planCorrection(root, MEMORY_ID, 'I prefer evening check-ins.', now.value);
  const [unbound] = memoryBlocks(offSession.writes.get('profile.md'));
  assert.equal(unbound.lastConfirmedSession, 'null');
  assert.equal(unbound.lastLiveConfirmed, now.value);
  await assert.rejects(planCorrection(root, MEMORY_ID, 'x', now.value, { sessionId: 'not-a-session' }), { code: 'SESSION_ID_REQUIRED' });
});
