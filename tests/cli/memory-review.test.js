'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { sandbox } = require('./helpers');
const { evaluateStaleMemory, planReviewDecision } = require('../../cli/memory-review');

const MEM_OLD = 'mem-10000000-0000-4000-8000-000000000001';
const MEM_RECENT = 'mem-20000000-0000-4000-8000-000000000002';
const FOCUS_IMPORTED = 'focus-30000000-0000-4000-8000-000000000003';
const SESSION_CURRENT = 's-40000000-0000-4000-8000-000000000004';

function state(overrides = {}) {
  return {
    consent: {
      continuityMemory: 'on',
      currentSessionId: SESSION_CURRENT,
      memoryPause: { state: 'none', startedAt: null },
      retention: {
        profile_memory: 'until_deleted',
        themes_and_focus: 'until_deleted',
        client_scene_memories: 'until_deleted'
      },
      reviewPreferences: { staleMemoryOffers: 'on', suppressedMemoryIds: [] },
      ...overrides
    }
  };
}

function block({ id, title, statement, firstObserved = '2026-03-01T00:00:00.000Z', firstSession = 'imported', importedAt = 'null', lastConfirmed = 'never', lastSession = 'null', reviewState = 'current', revision = 1 }) {
  return [
    `### ${id} — ${title}`,
    '',
    `- Statement: ${statement}`,
    '- Kind: reported_fact',
    '- Status: user_confirmed',
    `- First observed: ${firstObserved}`,
    `- First session: ${firstSession}`,
    `- Imported at: ${importedAt}`,
    '- Source IDs: []',
    `- Last live confirmed: ${lastConfirmed}`,
    `- Last confirmed session: ${lastSession}`,
    '- Confidence: user_stated',
    `- Review state: ${reviewState}`,
    `- Current revision: ${revision}`,
    '',
    '#### Revision history',
    '',
    `- r${revision} — ${firstObserved === 'unknown' ? '2026-03-01T00:00:00.000Z' : firstObserved} — synthetic fixture`,
    ''
  ].join('\n');
}

function sessionNote(id, closedAt, completion = 'complete') {
  return [
    '---',
    'record_kind: ai_authored_session_note',
    'author_role: ai_companion',
    `session_id: ${id}`,
    `started_at: ${closedAt}`,
    `closed_at: ${closedAt}`,
    'timezone: UTC',
    `completion: ${completion}`,
    'source_transcript: none',
    'consent_event_id: consent-50000000-0000-4000-8000-000000000005',
    '---',
    '',
    '# Session Note',
    ''
  ].join('\n');
}

async function prepare(t, label) {
  const box = await sandbox(`memory-review-${label}`);
  t.after(box.cleanup);
  await fsp.mkdir(path.join(box.workspace, 'sessions'), { recursive: true });
  await fsp.mkdir(path.join(box.workspace, 'sources'), { recursive: true });
  const dates = ['2026-04-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z', '2026-06-01T10:00:00.000Z', '2026-07-01T10:00:00.000Z'];
  for (let index = 0; index < dates.length; index += 1) {
    const id = `s-60000000-0000-4000-8000-00000000000${index + 1}`;
    const stamp = dates[index].replace(/[-:TZ.]/g, '').slice(0, 14);
    await fsp.writeFile(path.join(box.workspace, 'sessions', `${stamp.slice(0, 8)}-${stamp.slice(8, 14)}--${id.slice(2)}--session.md`), sessionNote(id, dates[index]));
  }
  await fsp.writeFile(path.join(box.workspace, 'profile.md'), [
    '# Profile', '',
    block({ id: MEM_OLD, title: 'Older item', statement: 'A synthetic older statement.', lastConfirmed: '2026-03-01T00:00:00.000Z' }),
    block({ id: MEM_RECENT, title: 'Recent item', statement: 'A synthetic recent statement.', firstObserved: '2026-06-15T00:00:00.000Z', lastConfirmed: '2026-06-15T00:00:00.000Z' })
  ].join('\n'));
  await fsp.writeFile(path.join(box.workspace, 'CURRENT-FOCUS.md'), [
    '# Current Focus', '',
    block({ id: FOCUS_IMPORTED, title: 'Imported item', statement: 'A synthetic imported statement.', firstObserved: 'unknown', importedAt: '2026-03-15T00:00:00.000Z', lastConfirmed: 'never' })
  ].join('\n'));
  return box;
}

async function apply(root, plan) {
  for (const [relative, content] of plan.writes) await fsp.writeFile(path.join(root, relative), content, { mode: 0o600 });
}

test('stale review requires both time/session evidence and treats imported material as unconfirmed', async (t) => {
  const box = await prepare(t, 'eligibility');
  const result = await evaluateStaleMemory(box.workspace, state(), { now: '2026-07-14T12:00:00.000Z' });
  assert.equal(result.status, 'due');
  assert.equal(result.totalDue, 2);
  assert.deepEqual(new Set(result.due.map((item) => item.id)), new Set([MEM_OLD, FOCUS_IMPORTED]));
  assert.equal(result.due.find((item) => item.id === FOCUS_IMPORTED).lastLiveConfirmed, 'never');
  assert.equal(result.due.some((item) => item.id === MEM_RECENT), false);
  assert.equal(result.completedSessionCount, 4);
});

test('offer limit is 1-3, suppression is exact, and global opt-out returns no content', async (t) => {
  const box = await prepare(t, 'preferences');
  const limited = await evaluateStaleMemory(box.workspace, state(), { now: '2026-07-14T12:00:00.000Z', limit: 1 });
  assert.equal(limited.due.length, 1);
  assert.equal(limited.totalDue, 2);
  await assert.rejects(evaluateStaleMemory(box.workspace, state(), { now: '2026-07-14T12:00:00.000Z', limit: 4 }), { code: 'MEMORY_REVIEW_LIMIT_INVALID' });
  const suppressed = await evaluateStaleMemory(box.workspace, state({ reviewPreferences: { staleMemoryOffers: 'on', suppressedMemoryIds: [MEM_OLD] } }), { now: '2026-07-14T12:00:00.000Z' });
  assert.equal(suppressed.due.some((item) => item.id === MEM_OLD), false);
  const off = await evaluateStaleMemory(box.workspace, state({ reviewPreferences: { staleMemoryOffers: 'off', suppressedMemoryIds: [] } }), { now: '2026-07-14T12:00:00.000Z' });
  assert.deepEqual(off.due, []);
  assert.equal(off.status, 'disabled');
});

test('write pause permits review reads but blocks decisions; sealed pause blocks reads', async (t) => {
  const box = await prepare(t, 'pause');
  const writePaused = state({ memoryPause: { state: 'write_pause', startedAt: '2026-07-14T11:00:00.000Z' } });
  const result = await evaluateStaleMemory(box.workspace, writePaused, { now: '2026-07-14T12:00:00.000Z' });
  assert.equal(result.totalDue, 2);
  await assert.rejects(planReviewDecision(box.workspace, writePaused, { action: 'confirm', id: MEM_OLD, now: '2026-07-14T12:00:00.000Z' }), { code: 'MEMORY_PAUSE_ACTIVE' });
  await assert.rejects(evaluateStaleMemory(box.workspace, state({ memoryPause: { state: 'sealed_pause', startedAt: '2026-07-14T11:00:00.000Z' } }), { now: '2026-07-14T12:00:00.000Z' }), { code: 'MEMORY_SEALED' });
});

test('disabled retention class is not read, even when its file is a symlink', async (t) => {
  const box = await prepare(t, 'retention');
  await fsp.rm(path.join(box.workspace, 'profile.md'));
  await fsp.symlink(path.join(box.workspace, 'CURRENT-FOCUS.md'), path.join(box.workspace, 'profile.md'));
  const scoped = state({ retention: { profile_memory: 'do_not_store', themes_and_focus: 'until_deleted', client_scene_memories: 'until_deleted' } });
  const result = await evaluateStaleMemory(box.workspace, scoped, { now: '2026-07-14T12:00:00.000Z' });
  assert.equal(result.totalDue, 1);
  assert.equal(result.due[0].id, FOCUS_IMPORTED);
});

test('confirm updates only the selected item with current live provenance and no bulk refresh', async (t) => {
  const box = await prepare(t, 'confirm');
  const before = await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8');
  const recentBefore = before.slice(before.indexOf(`### ${MEM_RECENT}`));
  const planned = await planReviewDecision(box.workspace, state(), { action: 'confirm', id: MEM_OLD, now: '2026-07-14T12:00:00.000Z' });
  await apply(box.workspace, planned);
  const after = await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8');
  assert.match(after, /- Last live confirmed: 2026-07-14T12:00:00\.000Z/);
  assert.match(after, new RegExp(`- Last confirmed session: ${SESSION_CURRENT}`));
  assert.match(after, /- Current revision: 2/);
  assert.match(after, /user live confirmation; wording unchanged/);
  assert.equal(after.includes('A synthetic older statement.'), true);
  assert.equal(after.slice(after.indexOf(`### ${MEM_RECENT}`)), recentBefore);
  const result = await evaluateStaleMemory(box.workspace, state(), { now: '2026-07-14T12:01:00.000Z' });
  assert.equal(result.due.some((item) => item.id === MEM_OLD), false);
});

test('decline suppresses re-offer for both 30 days and 3 subsequent completed sessions', async (t) => {
  const box = await prepare(t, 'decline');
  const planned = await planReviewDecision(box.workspace, state(), { action: 'decline', id: MEM_OLD, now: '2026-07-14T12:00:00.000Z' });
  await apply(box.workspace, planned);
  const profile = await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8');
  assert.match(profile, /- Review state: declined_until_2026-08-13/);
  assert.match(profile, /- Review declined at: 2026-07-14T12:00:00\.000Z/);
  let result = await evaluateStaleMemory(box.workspace, state(), { now: '2026-08-12T12:00:00.000Z' });
  assert.equal(result.due.some((item) => item.id === MEM_OLD), false);

  const future = ['2026-07-20T10:00:00.000Z', '2026-07-30T10:00:00.000Z', '2026-08-05T10:00:00.000Z'];
  for (let index = 0; index < future.length; index += 1) {
    const id = `s-70000000-0000-4000-8000-00000000000${index + 1}`;
    await fsp.writeFile(path.join(box.workspace, 'sessions', `2026080${index + 1}-100000--${id.slice(2)}--session.md`), sessionNote(id, future[index]));
  }
  result = await evaluateStaleMemory(box.workspace, state(), { now: '2026-08-13T12:00:00.000Z' });
  assert.equal(result.due.some((item) => item.id === MEM_OLD), true);
});

test('per-item suppress and unsuppress mutate state metadata only', async (t) => {
  const box = await prepare(t, 'suppress');
  const suppress = await planReviewDecision(box.workspace, state(), { action: 'suppress', id: MEM_OLD });
  assert.equal(suppress.changed, true);
  assert.deepEqual(suppress.reviewPreferences.suppressedMemoryIds, [MEM_OLD]);
  assert.equal(suppress.writes.size, 0);
  const suppressedState = state({ reviewPreferences: suppress.reviewPreferences });
  const unchanged = await planReviewDecision(box.workspace, suppressedState, { action: 'suppress', id: MEM_OLD });
  assert.equal(unchanged.changed, false);
  const unsuppress = await planReviewDecision(box.workspace, suppressedState, { action: 'unsuppress', id: MEM_OLD });
  assert.deepEqual(unsuppress.reviewPreferences.suppressedMemoryIds, []);
});

test('malformed session metadata and duplicate memory IDs fail closed', async (t) => {
  const box = await prepare(t, 'invalid');
  await fsp.writeFile(path.join(box.workspace, 'sessions', '20260702-100000--80000000-0000-4000-8000-000000000008--session.md'), '---\nsession_id: broken\nsession_id: duplicate\n---\n');
  await assert.rejects(evaluateStaleMemory(box.workspace, state(), { now: '2026-07-14T12:00:00.000Z' }), { code: 'SESSION_HISTORY_INVALID' });
  await fsp.rm(path.join(box.workspace, 'sessions', '20260702-100000--80000000-0000-4000-8000-000000000008--session.md'));
  await fsp.writeFile(path.join(box.workspace, 'ACTIVE-THEMES.md'), block({ id: MEM_OLD, title: 'Duplicate', statement: 'Duplicate fixture.', lastConfirmed: '2026-03-01T00:00:00.000Z' }));
  await assert.rejects(evaluateStaleMemory(box.workspace, state(), { now: '2026-07-14T12:00:00.000Z' }), { code: 'MEMORY_ID_DUPLICATED' });
});
