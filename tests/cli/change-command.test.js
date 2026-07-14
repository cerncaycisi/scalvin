'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, consent, session, changes } = require('../../cli/operations');
const { sandbox } = require('./helpers');

const PROPOSAL = Object.freeze({
  action: 'propose',
  'change-target': 'session-style',
  setting: 'response_load',
  value: 'concise',
  'evidence-status': 'user_requested',
  why: 'The user explicitly requested a shorter default response style.',
  'expected-effect': 'Default responses use less cognitive load.',
  'risks-or-tradeoffs': 'Some nuance may require an explicit request for detail.'
});

async function preparedWorkspace(t, label) {
  const box = await sandbox(`changes-command-${label}`);
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  await consent({
    target: box.workspace,
    category: 'behavior_customization',
    value: 'on',
    retention: 'until_deleted'
  });
  const begun = await session({ target: box.workspace, action: 'begin', now: '2026-07-14T10:00:00Z' });
  return { ...box, sessionId: begun.sessionId };
}

test('changes command stages proposals and requires exact approval and rollback previews', async (t) => {
  const box = await preparedWorkspace(t, 'approve-rollback');
  const dryRun = await changes({ target: box.workspace, ...PROPOSAL, 'dry-run': true });
  assert.equal(dryRun.status, 'dry-run');
  assert.equal(dryRun.persisted, false);
  assert.equal((await fsp.readdir(path.join(box.workspace, '.therapy', 'change-control', 'pending'))).length, 0);

  const proposed = await changes({ target: box.workspace, ...PROPOSAL });
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.before, null);
  assert.equal(proposed.after, 'concise');
  assert.equal(proposed.persisted, true);

  const approval = await changes({ target: box.workspace, action: 'approve', 'change-id': proposed.changeId });
  assert.equal(approval.status, 'preview');
  assert.equal(approval.before, null);
  assert.equal(approval.after, 'concise');
  assert.match(approval.confirmationRequired, new RegExp(`^approve:${proposed.changeId}:[a-f0-9]{20}$`));
  await assert.rejects(changes({
    target: box.workspace, action: 'approve', 'change-id': proposed.changeId, confirm: 'wrong'
  }), { code: 'CONFIRMATION_REQUIRED' });

  const approved = await changes({
    target: box.workspace, action: 'approve', 'change-id': proposed.changeId,
    confirm: approval.confirmationRequired
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.confirmationRequired, undefined);
  const overlayPath = path.join(box.workspace, '.therapy', 'user-overrides', 'session-style.json');
  assert.equal(JSON.parse(await fsp.readFile(overlayPath, 'utf8')).settings.response_load, 'concise');

  const history = await changes({ target: box.workspace, action: 'history' });
  assert.equal(history.status, 'inspected');
  assert.equal(history.recordCount, 2);
  assert.equal(history.contentIncluded, false);
  assert.equal(JSON.stringify(history).includes(PROPOSAL.why), false);

  const rollback = await changes({
    target: box.workspace, action: 'rollback', 'revision-id': approved.revisionId
  });
  assert.equal(rollback.status, 'preview');
  assert.deepEqual(rollback.before, { response_load: 'concise' });
  assert.equal(rollback.after, null);
  assert.match(rollback.confirmationRequired, new RegExp(`^rollback:${approved.revisionId}:[a-f0-9]{20}$`));
  const rolledBack = await changes({
    target: box.workspace, action: 'rollback', 'revision-id': approved.revisionId,
    confirm: rollback.confirmationRequired
  });
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(rolledBack.sourceRevisionId, approved.revisionId);
  await assert.rejects(fsp.access(overlayPath), { code: 'ENOENT' });
});

test('changes rejection is staged and failpoints leave the pending proposal untouched', async (t) => {
  const box = await preparedWorkspace(t, 'reject');
  const proposed = await changes({ target: box.workspace, ...PROPOSAL });
  const pending = path.join(box.workspace, '.therapy', 'change-control', 'pending', `${proposed.changeId}.json`);
  const before = await fsp.readFile(pending, 'utf8');
  process.env.SCALVIN_TEST_FAILPOINT = 'changes-reject-before-activate';
  await assert.rejects(changes({
    target: box.workspace, action: 'reject', 'change-id': proposed.changeId,
    wording: 'The user chose to keep the current behavior.'
  }), { code: 'TEST_FAILPOINT' });
  delete process.env.SCALVIN_TEST_FAILPOINT;
  assert.equal(await fsp.readFile(pending, 'utf8'), before);

  const rejected = await changes({
    target: box.workspace, action: 'reject', 'change-id': proposed.changeId,
    wording: 'The user chose to keep the current behavior.'
  });
  assert.equal(rejected.status, 'rejected');
  await assert.rejects(fsp.access(pending), { code: 'ENOENT' });
});
