'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, consent, memory, transcript, session, source, contextGraph, changes, preferences, doctor } = require('../../cli/operations');
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

test('sealed control and status paths do not traverse unrelated private content', async (t) => {
  const box = await sandbox('sealed-status-no-private-traversal');
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    await memory({ workspace: box.workspace, action: 'seal' });
    const profile = path.join(box.workspace, 'profile.md');
    const privateTarget = path.join(box.base, 'private-target.md');
    await fsp.writeFile(privateTarget, 'private bytes must not be inspected\n');
    await fsp.unlink(profile);
    try {
      await fsp.symlink(privateTarget, profile);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`symlink creation is unavailable on this platform: ${error.code}`);
        return;
      }
      throw error;
    }

    const memoryStatus = await memory({ workspace: box.workspace, action: 'status' });
    assert.equal(memoryStatus.memoryPause, 'sealed_pause');
    const transcriptStatus = await transcript({ workspace: box.workspace, action: 'status' });
    assert.equal(transcriptStatus.status, 'unchanged');
    const sessionStatus = await session({ workspace: box.workspace, action: 'status' });
    assert.equal(sessionStatus.status, 'sealed');
    assert.equal(sessionStatus.checkpointFilesRead, false);
    const repeatedSeal = await memory({ workspace: box.workspace, action: 'seal' });
    assert.equal(repeatedSeal.status, 'unchanged');

    await assert.rejects(memory({ workspace: box.workspace, action: 'view', scope: 'profile' }), { code: 'MEMORY_SEALED' });
    await assert.rejects(memory({ workspace: box.workspace, action: 'pause' }), { code: 'MEMORY_SEALED' });
    await assert.rejects(source({ workspace: box.workspace, action: 'status' }), { code: 'MEMORY_SEALED' });
    await assert.rejects(contextGraph({ workspace: box.workspace, action: 'status' }), { code: 'MEMORY_SEALED' });
    await assert.rejects(changes({ workspace: box.workspace, action: 'history' }), { code: 'MEMORY_SEALED' });
    await assert.rejects(preferences({ workspace: box.workspace }), { code: 'MEMORY_SEALED' });
    await assert.rejects(preferences({ workspace: box.workspace, 'show-preferred-user-name': true }), { code: 'MEMORY_SEALED' });
  } finally {
    await box.cleanup();
  }
});

test('transcript lifecycle requires consent and records pause gaps without backfill', async () => {
  const box = await sandbox('transcript-controls');
  const unrelatedSessionId = 's-123e4567-e89b-42d3-a456-426614174000';
  try {
    await install({ workspace: box.workspace });
    await assert.rejects(transcript({ workspace: box.workspace, action: 'start', 'session-id': unrelatedSessionId, 'capture-grade': 'best_effort_context' }), { code: 'TRANSCRIPT_CONSENT_REQUIRED' });
    await consent({ workspace: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'until_deleted' });
    const begun = await session({ workspace: box.workspace, action: 'begin', now: '2026-07-15T10:00:00Z' });
    const sessionId = begun.sessionId;
    await assert.rejects(
      transcript({ workspace: box.workspace, action: 'start', 'session-id': unrelatedSessionId, 'capture-grade': 'best_effort_context' }),
      { code: 'SESSION_ID_MISMATCH' }
    );
    await assert.rejects(
      transcript({ workspace: box.workspace, action: 'start', 'session-id': sessionId, 'capture-grade': 'turn_captured' }),
      { code: 'TRANSCRIPT_CAPABILITY_UNVERIFIED' }
    );
    let result = await transcript({
      workspace: box.workspace, action: 'start', 'session-id': sessionId,
      'capture-grade': 'best_effort_context', now: '2026-07-15T10:00:05Z'
    });
    assert.equal(result.transcriptState, 'recording');
    let state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.sessionLifecycle.transcript.state, 'recording');
    assert.equal(state.sessionLifecycle.transcript.sessionId, sessionId);
    result = await transcript({ workspace: box.workspace, action: 'pause', now: '2026-07-15T10:05:00Z' });
    assert.equal(result.transcriptState, 'paused');
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.sessionLifecycle.transcript.state, 'paused');
    assert.equal(state.sessionLifecycle.transcript.pausedIntervals.length, 1);
    result = await transcript({ workspace: box.workspace, action: 'resume', now: '2026-07-15T10:06:00Z' });
    assert.equal(result.noBackfill, true);
    assert.ok(result.knownGaps.some((gap) => gap.reason === 'capture_started_late'));
    assert.ok(result.knownGaps.some((gap) => gap.reason === 'paused_no_backfill'));
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.sessionLifecycle.transcript.state, 'recording');
    assert.deepEqual(state.sessionLifecycle.transcript.knownGaps, result.knownGaps);
    result = await transcript({ workspace: box.workspace, action: 'stop', now: '2026-07-15T10:10:00Z' });
    assert.equal(result.transcriptState, 'stopped');
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.transcriptState.sessionId, sessionId);
    assert.equal(state.consent.transcriptState.captureGrade, 'partial');
    assert.ok(state.consent.transcriptState.knownGaps.some((gap) => gap.reason === 'paused_no_backfill'));
    assert.equal(state.sessionLifecycle.transcript.state, 'stopped');
    assert.deepEqual(state.sessionLifecycle.transcript.knownGaps, state.consent.transcriptState.knownGaps);
    const explicitStoppedAt = state.consent.transcriptState.stoppedAt;
    const controls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
    assert.match(controls, /## Transcript State[\s\S]*- State: stopped/);

    await assert.rejects(
      transcript({ workspace: box.workspace, action: 'start', 'session-id': sessionId, 'capture-grade': 'best_effort_context' }),
      { code: 'TRANSCRIPT_STATE_INVALID' }
    );
    await assert.rejects(session({
      workspace: box.workspace,
      action: 'close',
      'session-id': sessionId,
      now: new Date(Date.parse(explicitStoppedAt) - 1).toISOString(),
      noteBody: 'A close cannot predate transcript stop evidence.',
      'dry-run': true
    }), { code: 'INVALID_TRANSCRIPT_COVERAGE' });
    const closed = await session({
      workspace: box.workspace, action: 'close', 'session-id': sessionId,
      now: '2026-07-16T00:00:00Z', noteBody: 'Close preserves terminal transcript evidence without inventing an artifact.'
    });
    assert.equal(closed.lifecycleState, 'closed');
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.sessionLifecycle.transcript.state, 'stopped');
    assert.equal(state.consent.transcriptState.state, 'stopped');
    assert.equal(state.sessionLifecycle.transcript.sessionId, sessionId);
    assert.equal(state.consent.transcriptState.sessionId, sessionId);
    assert.equal(state.sessionLifecycle.transcript.finalizedAt, explicitStoppedAt);
    assert.equal(state.consent.transcriptState.stoppedAt, explicitStoppedAt);
    assert.ok(state.sessionLifecycle.transcript.knownGaps.some((gap) => gap.reason === 'capture_ended_early'
      && gap.from === explicitStoppedAt && gap.to === '2026-07-16T00:00:00Z'));

    const second = await session({ workspace: box.workspace, action: 'begin', now: '2026-07-16T00:01:00Z' });
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.sessionLifecycle.sessionId, second.sessionId);
    assert.equal(state.sessionLifecycle.transcript.state, 'off');
    assert.equal(state.sessionLifecycle.transcript.sessionId, null);
    assert.equal(state.consent.transcriptState.state, 'off');
    assert.equal(state.consent.transcriptState.sessionId, null);
    assert.equal((await doctor({ workspace: box.workspace })).errors, 0);
  } finally {
    await box.cleanup();
  }
});

test('deleting historical transcript artifacts preserves unrelated active capture evidence', async () => {
  const box = await sandbox('transcript-delete-all-preserves-active-evidence');
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    await consent({ workspace: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'until_deleted' });
    const transcriptRoot = path.join(box.workspace, 'archive', 'transcripts');
    await fsp.mkdir(transcriptRoot, { recursive: true, mode: 0o700 });
    const historicalPath = path.join(transcriptRoot, '2026-07-14-000000--historical--transcript.md');
    await fsp.writeFile(historicalPath, 'historical private transcript\n', { mode: 0o600 });

    const begun = await session({ workspace: box.workspace, action: 'begin', now: '2026-07-15T10:00:00Z' });
    await transcript({
      workspace: box.workspace, action: 'start', 'session-id': begun.sessionId,
      'capture-grade': 'best_effort_context'
    });
    const before = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    const preview = await transcript({ workspace: box.workspace, action: 'delete', scope: 'all' });
    await transcript({
      workspace: box.workspace, action: 'delete', scope: 'all',
      confirm: preview.confirmationRequired
    });

    const after = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.deepEqual(after.consent.transcriptState, before.consent.transcriptState);
    assert.deepEqual(after.sessionLifecycle.transcript, before.sessionLifecycle.transcript);
    await assert.rejects(fsp.access(historicalPath), { code: 'ENOENT' });
    await assert.rejects(transcript({
      workspace: box.workspace, action: 'start', 'session-id': begun.sessionId,
      'capture-grade': 'best_effort_context'
    }), { code: 'TRANSCRIPT_STATE_INVALID' });
  } finally {
    await box.cleanup();
  }
});

test('session close cannot omit canonical transcript pause gaps from supplied capture evidence', async () => {
  const box = await sandbox('transcript-close-canonical-gaps');
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    await consent({ workspace: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'until_deleted' });
    const begun = await session({ workspace: box.workspace, action: 'begin', now: '2026-07-15T12:00:00Z' });
    await transcript({
      workspace: box.workspace, action: 'start', 'session-id': begun.sessionId,
      'capture-grade': 'best_effort_context', now: '2026-07-15T12:00:05Z'
    });
    await transcript({ workspace: box.workspace, action: 'pause', now: '2026-07-15T12:01:00Z' });
    await transcript({ workspace: box.workspace, action: 'resume', now: '2026-07-15T12:02:00Z' });

    const beforeClose = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    const canonicalGaps = structuredClone(beforeClose.sessionLifecycle.transcript.knownGaps);
    const canonicalPauses = structuredClone(beforeClose.sessionLifecycle.transcript.pausedIntervals);
    assert.ok(canonicalGaps.some((gap) => gap.reason === 'paused_no_backfill'));
    assert.ok(canonicalGaps.some((gap) => gap.reason === 'capture_started_late'));
    assert.equal(canonicalPauses.length, 1);
    await assert.rejects(session({
      workspace: box.workspace,
      action: 'checkpoint',
      'session-id': begun.sessionId,
      'turn-number': '1',
      now: '2026-07-15T12:10:00Z',
      liveThread: 'A caller cannot erase transcript evidence at checkpoint time.',
      transcript: { state: 'off' }
    }), { code: 'TRANSCRIPT_EVIDENCE_MISMATCH' });
    assert.deepEqual(await readJson(path.join(box.workspace, '.scalvin', 'state.json')), beforeClose);

    await session({
      workspace: box.workspace, action: 'close', 'session-id': begun.sessionId,
      now: '2026-07-16T00:00:00Z', noteBody: 'Canonical gap evidence must survive.',
      transcript: {
        captureGrade: 'best_effort_context',
        turns: [],
        expectedLastTurn: 0,
        knownGaps: [],
        pausedIntervals: []
      }
    });

    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.sessionLifecycle.transcript.state, 'finalized');
    assert.equal(state.sessionLifecycle.transcript.captureGrade, 'partial');
    assert.deepEqual(state.sessionLifecycle.transcript.knownGaps, canonicalGaps);
    assert.deepEqual(state.sessionLifecycle.transcript.pausedIntervals, canonicalPauses);
    assert.equal(state.consent.transcriptState.state, 'stopped');
    assert.deepEqual(state.consent.transcriptState.knownGaps, canonicalGaps);
    assert.deepEqual(state.consent.transcriptState.pausedIntervals, canonicalPauses);

    const transcriptDirectory = path.join(box.workspace, 'archive', 'transcripts');
    const transcriptName = (await fsp.readdir(transcriptDirectory))
      .find((name) => name.includes(`--${begun.sessionId.slice(2)}--transcript.md`));
    assert.ok(transcriptName);
    const artifact = await fsp.readFile(path.join(transcriptDirectory, transcriptName), 'utf8');
    const artifactGaps = JSON.parse(artifact.match(/^known_gaps: (.*)$/m)[1]);
    const artifactPauses = JSON.parse(artifact.match(/^paused_intervals: (.*)$/m)[1]);
    assert.deepEqual(artifactGaps, canonicalGaps);
    assert.deepEqual(artifactPauses, canonicalPauses);
    assert.equal((await doctor({ workspace: box.workspace })).errors, 0);
  } finally {
    await box.cleanup();
  }
});

test('a memory pause atomically pauses active transcript capture and resume never auto-resumes it', async () => {
  const box = await sandbox('memory-transcript-coupling');
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    await consent({ workspace: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'until_deleted' });
    const sessionId = (await session({ workspace: box.workspace, action: 'begin', now: '2026-07-15T11:00:00Z' })).sessionId;
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
