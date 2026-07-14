'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, session, doctor } = require('../../cli/operations');
const { sandbox, readJson } = require('./helpers');

const START = '2026-07-14T11:00:00Z';

test('session command atomically begins, checkpoints and explicitly closes canonical lifecycle state', async () => {
  const box = await sandbox('session-command');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const begun = await session({ target: box.workspace, action: 'begin', now: START });
    assert.equal(begun.status, 'active');
    assert.equal(begun.lifecycleState, 'active');
    assert.match(begun.sessionId, /^s-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const privateCheckpoint = 'Sensitive checkpoint text must not appear in the command result.';
    const checkpointed = await session({
      target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
      'turn-number': '1', now: '2026-07-14T11:01:00Z', liveThread: privateCheckpoint
    });
    assert.equal(checkpointed.status, 'checkpointed');
    assert.equal(checkpointed.checkpointPresent, true);
    assert.equal(JSON.stringify(checkpointed).includes(privateCheckpoint), false);
    let state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    const checkpointPath = path.join(box.workspace, state.sessionLifecycle.checkpoint.path);
    assert.match(await fsp.readFile(checkpointPath, 'utf8'), new RegExp(privateCheckpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const beforeFailure = await fsp.readFile(checkpointPath, 'utf8');
    process.env.SCALVIN_TEST_FAILPOINT = 'session-checkpoint-before-activate';
    await assert.rejects(session({
      target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
      'turn-number': '2', now: '2026-07-14T11:02:00Z', liveThread: 'must roll back'
    }), { code: 'TEST_FAILPOINT' });
    delete process.env.SCALVIN_TEST_FAILPOINT;
    assert.equal(await fsp.readFile(checkpointPath, 'utf8'), beforeFailure);

    const privateNote = '# Session Note\n\nUser-confirmed summary only.';
    const privateDeepDive = '# Deep Dive\n\nDetailed AI-authored working interpretation.';
    const deepDiveInput = path.join(box.base, 'deep-dive.md');
    await fsp.writeFile(deepDiveInput, privateDeepDive);
    const closed = await session({
      target: box.workspace, action: 'close', 'session-id': begun.sessionId,
      now: '2026-07-14T11:10:00Z', noteBody: privateNote, 'deep-dive-file': deepDiveInput, primerBody: '# Next Primer\n'
    });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.lifecycleState, 'closed');
    assert.equal(closed.checkpointPresent, false);
    assert.equal(closed.deepDiveWritten, true);
    assert.equal(JSON.stringify(closed).includes(privateNote), false);
    assert.equal(JSON.stringify(closed).includes(privateDeepDive), false);
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.currentSessionId, null);
    assert.equal(state.sessionLifecycle.completion, 'complete');
    const deepDive = path.join(box.workspace, 'archive', `2026-07-14-110000--${begun.sessionId.slice(2)}--deep-dive.md`);
    assert.match(await fsp.readFile(deepDive, 'utf8'), /^record_kind: ai_authored_deep_dive$/m);
    await assert.rejects(fsp.access(checkpointPath), { code: 'ENOENT' });
    assert.equal((await doctor({ target: box.workspace })).errors, 0);
  } finally {
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await box.cleanup();
  }
});

test('session recovery exposes metadata only, requires context proof, and deletion uses exact confirmation', async () => {
  const box = await sandbox('session-recovery-command');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const begun = await session({ target: box.workspace, action: 'begin', now: START });
    await session({
      target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
      'turn-number': '1', now: '2026-07-14T11:01:00Z', liveThread: 'Private recovery body.'
    });

    const status = await session({ target: box.workspace, action: 'status' });
    assert.equal(status.recoveryStatus, 'recovery_available');
    assert.equal(status.checkpointBodyExposed, false);
    assert.equal(JSON.stringify(status).includes('Private recovery body.'), false);
    await assert.rejects(session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'continue', now: '2026-07-14T11:02:00Z'
    }), { code: 'RESUME_CONTEXT_UNAVAILABLE' });

    const continued = await session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'continue', 'can-resume-context': true, now: '2026-07-14T11:02:00Z'
    });
    assert.equal(continued.lifecycleState, 'active');

    let preview = await session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'delete'
    });
    assert.equal(preview.status, 'preview');
    await assert.rejects(session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'delete', confirm: 'wrong'
    }), { code: 'STALE_CONFIRMATION' });
    await session({
      target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
      'turn-number': '2', now: '2026-07-14T11:03:00Z', liveThread: 'Changed checkpoint body.'
    });
    await assert.rejects(session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'delete', confirm: preview.confirmationRequired
    }), { code: 'STALE_CONFIRMATION' });
    const afterStale = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    await fsp.access(path.join(box.workspace, afterStale.sessionLifecycle.checkpoint.path));
    preview = await session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'delete'
    });
    const deleted = await session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'delete', confirm: preview.confirmationRequired
    });
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.lifecycleState, 'abandoned');
    assert.equal(deleted.filesDeleted, 1);
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.currentSessionId, null);
    assert.equal(state.sessionLifecycle.checkpoint, null);
  } finally {
    await box.cleanup();
  }
});
