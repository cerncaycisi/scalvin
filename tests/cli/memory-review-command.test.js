'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, session, memory } = require('../../cli/operations');
const { sandbox, readJson } = require('./helpers');

const MEMORY_ID = 'mem-10000000-0000-4000-8000-000000000001';

function memoryBlock() {
  return [
    `### ${MEMORY_ID} — Older item`, '',
    '- Statement: A synthetic older statement.',
    '- Kind: reported_fact',
    '- Status: user_confirmed',
    '- First observed: 2026-03-01T00:00:00.000Z',
    '- First session: imported',
    '- Imported at: null',
    '- Source IDs: []',
    '- Last live confirmed: 2026-03-01T00:00:00.000Z',
    '- Last confirmed session: null',
    '- Confidence: user_stated',
    '- Review state: current',
    '- Current revision: 1', '',
    '#### Revision history', '',
    '- r1 — 2026-03-01T00:00:00.000Z — synthetic fixture', ''
  ].join('\n');
}

function sessionNote(id, closedAt) {
  return [
    '---',
    'record_kind: ai_authored_session_note',
    'author_role: ai_companion',
    `session_id: ${id}`,
    `started_at: ${closedAt}`,
    `closed_at: ${closedAt}`,
    'timezone: UTC',
    'completion: complete',
    'source_transcript: none',
    'consent_event_id: consent-50000000-0000-4000-8000-000000000005',
    '---', '', '# Session Note', ''
  ].join('\n');
}

test('memory review command offers bounded candidates and updates only one explicitly selected item', async (t) => {
  const box = await sandbox('memory-review-command');
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  const begun = await session({ target: box.workspace, action: 'begin', now: '2026-07-14T10:00:00Z' });
  await fsp.writeFile(path.join(box.workspace, 'profile.md'), `# Profile\n\n${memoryBlock()}`);
  const sessions = [
    ['s-60000000-0000-4000-8000-000000000001', '2026-04-01T10:00:00.000Z'],
    ['s-60000000-0000-4000-8000-000000000002', '2026-05-01T10:00:00.000Z'],
    ['s-60000000-0000-4000-8000-000000000003', '2026-06-01T10:00:00.000Z']
  ];
  for (const [id, closedAt] of sessions) {
    await fsp.writeFile(path.join(box.workspace, 'sessions', `${closedAt.slice(0, 10)}-100000--${id.slice(2)}--session.md`), sessionNote(id, closedAt));
  }

  const due = await memory({ target: box.workspace, action: 'review-due', now: '2026-07-14T12:00:00.000Z' });
  assert.equal(due.status, 'due');
  assert.equal(due.offeredCount, 1);
  assert.equal(due.bulkRefresh, false);
  assert.equal(due.due[0].id, MEMORY_ID);

  const dry = await memory({
    target: box.workspace, action: 'review-confirm', id: MEMORY_ID,
    'session-id': begun.sessionId, now: '2026-07-14T12:00:00.000Z', 'dry-run': true
  });
  assert.equal(dry.status, 'dry-run');
  assert.match(await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8'), /Current revision: 1/);

  const confirmed = await memory({
    target: box.workspace, action: 'review-confirm', id: MEMORY_ID,
    'session-id': begun.sessionId, now: '2026-07-14T12:00:00.000Z'
  });
  assert.equal(confirmed.status, 'updated');
  assert.equal(confirmed.selectedCount, 1);
  assert.equal(confirmed.bulkRefresh, false);
  const profile = await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8');
  assert.match(profile, /Current revision: 2/);
  assert.match(profile, /Last live confirmed: 2026-07-14T12:00:00.000Z/);

  const suppressed = await memory({ target: box.workspace, action: 'review-suppress', id: MEMORY_ID });
  assert.equal(suppressed.status, 'updated');
  const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
  assert.deepEqual(state.consent.reviewPreferences.suppressedMemoryIds, [MEMORY_ID]);
});
