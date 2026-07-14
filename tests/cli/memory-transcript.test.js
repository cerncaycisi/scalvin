'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, consent, memory, transcript, doctor } = require('../../cli/operations');
const { sandbox, readJson } = require('./helpers');

test('memory pause, seal, resume are atomic, projected, and never backfilled', async () => {
  const box = await sandbox('memory-controls');
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    let result = await memory({ workspace: box.workspace, action: 'pause' });
    assert.equal(result.memoryPause, 'write_pause');
    let controls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
    assert.match(controls, /- Memory pause: write_pause/);
    result = await memory({ workspace: box.workspace, action: 'seal' });
    assert.equal(result.memoryPause, 'sealed_pause');
    const beforeDry = await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8');
    const dry = await memory({ workspace: box.workspace, action: 'resume', 'dry-run': true });
    assert.equal(dry.status, 'dry-run');
    assert.equal(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'), beforeDry);
    result = await memory({ workspace: box.workspace, action: 'resume' });
    assert.equal(result.memoryPause, 'none');
    assert.equal(result.noBackfill, true);
    controls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
    assert.match(controls, /- Memory pause: none/);
    assert.equal((await doctor({ workspace: box.workspace })).errors, 0);
  } finally {
    await box.cleanup();
  }
});

test('transcript lifecycle requires consent and records pause gaps without backfill', async () => {
  const box = await sandbox('transcript-controls');
  const sessionId = 's-123e4567-e89b-42d3-a456-426614174000';
  try {
    await install({ workspace: box.workspace });
    await assert.rejects(transcript({ workspace: box.workspace, action: 'start', 'session-id': sessionId, 'capture-grade': 'best_effort_context' }), { code: 'TRANSCRIPT_CONSENT_REQUIRED' });
    await consent({ workspace: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'until_deleted' });
    await assert.rejects(
      transcript({ workspace: box.workspace, action: 'start', 'session-id': sessionId, 'capture-grade': 'turn_captured' }),
      { code: 'TRANSCRIPT_CAPABILITY_UNVERIFIED' }
    );
    let result = await transcript({ workspace: box.workspace, action: 'start', 'session-id': sessionId, 'capture-grade': 'best_effort_context' });
    assert.equal(result.transcriptState, 'recording');
    result = await transcript({ workspace: box.workspace, action: 'pause' });
    assert.equal(result.transcriptState, 'paused');
    result = await transcript({ workspace: box.workspace, action: 'resume' });
    assert.equal(result.noBackfill, true);
    assert.equal(result.knownGaps.length, 1);
    result = await transcript({ workspace: box.workspace, action: 'stop' });
    assert.equal(result.transcriptState, 'stopped');
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.transcriptState.sessionId, sessionId);
    assert.equal(state.consent.transcriptState.captureGrade, 'best_effort_context');
    assert.equal(state.consent.transcriptState.knownGaps[0].reason, 'paused_no_backfill');
    const controls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
    assert.match(controls, /## Transcript State[\s\S]*- State: stopped/);
    assert.equal((await doctor({ workspace: box.workspace })).errors, 0);
  } finally {
    await box.cleanup();
  }
});

test('a memory pause atomically pauses active transcript capture and resume never auto-resumes it', async () => {
  const box = await sandbox('memory-transcript-coupling');
  const sessionId = 's-323e4567-e89b-42d3-a456-426614174000';
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    await consent({ workspace: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'until_deleted' });
    await transcript({ workspace: box.workspace, action: 'start', 'session-id': sessionId, 'capture-grade': 'partial' });
    const paused = await memory({ workspace: box.workspace, action: 'pause' });
    assert.equal(paused.memoryPause, 'write_pause');
    assert.equal(paused.transcriptState, 'paused');
    assert.deepEqual(paused.transcriptTransition, { from: 'recording', to: 'paused', reason: 'memory_pause_no_backfill' });

    const resumed = await memory({ workspace: box.workspace, action: 'resume' });
    assert.equal(resumed.memoryPause, 'none');
    assert.equal(resumed.transcriptState, 'paused');
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.transcriptState.pausedIntervals.length, 1);
    assert.equal(state.consent.transcriptState.pausedIntervals[0].endedAt, null);
  } finally {
    await box.cleanup();
  }
});

test('memory/transcript failpoints preserve canonical and projected state', async () => {
  const box = await sandbox('control-rollback');
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    const before = await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8');
    process.env.SCALVIN_TEST_FAILPOINT = 'memory-before-activate';
    await assert.rejects(memory({ workspace: box.workspace, action: 'pause' }), { code: 'TEST_FAILPOINT' });
    assert.equal(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'), before);
  } finally {
    await box.cleanup();
  }
});

test('privacy controls and deletion remain executable when an unrelated framework file is customized', async (t) => {
  const customize = async (box) => {
    const filename = path.join(box.workspace, '.therapy', 'runtime', 'START-SESSION.md');
    await fsp.appendFile(filename, '\n<!-- unrelated user customization -->\n');
    return filename;
  };

  await t.test('consent', async () => {
    const box = await sandbox('privacy-drift-consent');
    try {
      await install({ workspace: box.workspace, consent: 'granted' });
      const customized = await customize(box);
      const result = await consent({ workspace: box.workspace, status: 'declined' });
      assert.equal(result.status, 'updated');
      assert.match(await fsp.readFile(customized, 'utf8'), /unrelated user customization/);
    } finally { await box.cleanup(); }
  });

  await t.test('pause', async () => {
    const box = await sandbox('privacy-drift-pause');
    try {
      await install({ workspace: box.workspace, consent: 'granted' });
      const customized = await customize(box);
      const result = await memory({ workspace: box.workspace, action: 'pause' });
      assert.equal(result.memoryPause, 'write_pause');
      assert.match(await fsp.readFile(customized, 'utf8'), /unrelated user customization/);
    } finally { await box.cleanup(); }
  });

  await t.test('delete-all', async () => {
    const box = await sandbox('privacy-drift-delete');
    try {
      await install({ workspace: box.workspace, consent: 'granted' });
      const customized = await customize(box);
      const preview = await memory({ workspace: box.workspace, action: 'delete-all' });
      const result = await memory({ workspace: box.workspace, action: 'delete-all', confirm: preview.confirmationRequired });
      assert.equal(result.status, 'deleted');
      assert.match(await fsp.readFile(customized, 'utf8'), /unrelated user customization/);
      const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
      assert.equal(state.consent.status, 'declined');
    } finally { await box.cleanup(); }
  });
});
