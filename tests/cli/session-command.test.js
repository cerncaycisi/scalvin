'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, consent, memory, transcript, session, doctor } = require('../../cli/operations');
const { readPrimerSingleton, renderPrimerSingleton } = require('../../cli/memory-data');
const { createEmptySessionLifecyclePatch } = require('../../cli/session-lifecycle');
const { sandbox, readJson } = require('./helpers');

const START = '2026-07-14T11:00:00Z';

async function treeSnapshot(root) {
  const records = [];
  async function visit(directory, prefix = '') {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        records.push(['directory', relative]);
        await visit(filename, relative);
      } else if (entry.isFile()) {
        records.push(['file', relative, (await fsp.readFile(filename)).toString('base64')]);
      } else {
        const stat = await fsp.lstat(filename);
        records.push(['other', relative, stat.mode, stat.size]);
      }
    }
  }
  await visit(root);
  return records;
}

async function sessionStageNames(workspace) {
  const prefix = `.${path.basename(workspace)}.session-`;
  return (await fsp.readdir(path.dirname(workspace)))
    .filter((name) => name.startsWith(prefix) && name.includes('-stage.'))
    .sort();
}

function privateArtifactSnapshot(records) {
  return records.filter(([, relative]) => relative === 'workspace/NEXT-PRIMER.md'
    || relative.startsWith('workspace/sessions/')
    || relative.startsWith('workspace/archive/'));
}

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
    const primerInput = path.join(box.base, 'next-primer.md');
    await fsp.writeFile(deepDiveInput, privateDeepDive);
    await fsp.writeFile(primerInput, renderPrimerSingleton({
      user: 'Alex', closedSession: begun.sessionId, closedAt: '2026-07-14T11:10:00Z',
      whereWeAre: 'Taking stock.', whatsLive: 'One unfinished thread.', carryForward: 'Ask before continuing.'
    }));
    const closed = await session({
      target: box.workspace, action: 'close', 'session-id': begun.sessionId,
      now: '2026-07-14T11:10:00Z', noteBody: privateNote, 'deep-dive-file': deepDiveInput,
      'primer-file': primerInput
    });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.lifecycleState, 'closed');
    assert.equal(closed.checkpointPresent, false);
    assert.equal(closed.deepDiveWritten, true);
    assert.equal(JSON.stringify(closed).includes(privateNote), false);
    assert.equal(JSON.stringify(closed).includes(privateDeepDive), false);
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.currentSessionId, null);
    assert.equal(state.consent.transcriptState.state, 'off');
    assert.equal(state.consent.transcriptState.sessionId, null);
    assert.equal(state.consent.transcriptState.stoppedAt, null);
    assert.equal(state.sessionLifecycle.completion, 'complete');
    assert.equal((await readPrimerSingleton(box.workspace)).fields.closedSession, begun.sessionId);
    const deepDive = path.join(box.workspace, 'archive', `2026-07-14-110000--${begun.sessionId.slice(2)}--deep-dive.md`);
    assert.match(await fsp.readFile(deepDive, 'utf8'), /^record_kind: ai_authored_deep_dive$/m);
    await assert.rejects(fsp.access(checkpointPath), { code: 'ENOENT' });
    assert.equal((await doctor({ target: box.workspace })).errors, 0);
  } finally {
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await box.cleanup();
  }
});

test('session dry-runs and a dry-run failpoint leave no bytes or sibling stages behind', async () => {
  const box = await sandbox('session-dry-run-zero-write');
  try {
    await install({ target: box.workspace, consent: 'granted' });

    const runWithoutWrites = async (operation) => {
      const before = await treeSnapshot(box.base);
      assert.deepEqual(await sessionStageNames(box.workspace), []);
      process.env.SCALVIN_TEST_FORBID_LIFECYCLE_STAGE = '1';
      try {
        const result = await operation();
        assert.deepEqual(await treeSnapshot(box.base), before);
        assert.deepEqual(await sessionStageNames(box.workspace), []);
        return result;
      } finally {
        delete process.env.SCALVIN_TEST_FORBID_LIFECYCLE_STAGE;
      }
    };

    const beginPreview = await runWithoutWrites(() => session({
      target: box.workspace, action: 'begin', now: START, 'dry-run': true
    }));
    assert.equal(beginPreview.status, 'dry-run');
    assert.equal(beginPreview.lifecycleState, 'active');

    const begun = await session({ target: box.workspace, action: 'begin', now: START });
    const checkpointPreview = await runWithoutWrites(() => session({
      target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
      'turn-number': '1', now: '2026-07-14T11:01:00Z', liveThread: 'Preview-only private checkpoint.',
      'dry-run': true
    }));
    assert.equal(checkpointPreview.status, 'dry-run');
    assert.equal(checkpointPreview.filesWritten, 1);

    await session({
      target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
      'turn-number': '1', now: '2026-07-14T11:01:00Z', liveThread: 'Persisted checkpoint remains unchanged.'
    });
    const closePreview = await runWithoutWrites(() => session({
      target: box.workspace, action: 'close', 'session-id': begun.sessionId,
      now: '2026-07-14T11:10:00Z', noteBody: 'Preview-only private note.', 'dry-run': true
    }));
    assert.equal(closePreview.status, 'dry-run');
    assert.equal(closePreview.lifecycleState, 'closed');

    const beforeFailure = await treeSnapshot(box.base);
    process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT = 'close-before-artifacts';
    await assert.rejects(session({
      target: box.workspace, action: 'close', 'session-id': begun.sessionId,
      now: '2026-07-14T11:10:00Z', noteBody: 'Failpoint preview must never be written.', 'dry-run': true
    }), { code: 'TEST_FAILPOINT' });
    assert.deepEqual(await treeSnapshot(box.base), beforeFailure);
    assert.deepEqual(await sessionStageNames(box.workspace), []);
  } finally {
    delete process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT;
    delete process.env.SCALVIN_TEST_FORBID_LIFECYCLE_STAGE;
    await box.cleanup();
  }
});

test('session close remains canonical but artifact-free when continuity is off or writes are paused', async (t) => {
  const scenarios = [
    {
      label: 'continuity-off',
      disable: (workspace) => consent({
        target: workspace, category: 'continuity_memory', value: 'off', retention: 'do_not_store'
      })
    },
    { label: 'write-pause', disable: (workspace) => memory({ target: workspace, action: 'pause' }) }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.label, async () => {
      const box = await sandbox(`session-close-${scenario.label}`);
      try {
        await install({ target: box.workspace, consent: 'granted' });
        const begun = await session({ target: box.workspace, action: 'begin', now: START });
        await session({
          target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
          'turn-number': '1', now: '2026-07-14T11:01:00Z', liveThread: 'Existing checkpoint must not be backfilled.'
        });
        let state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
        const checkpointRelative = state.sessionLifecycle.checkpoint.path;
        const checkpointPath = path.join(box.workspace, state.sessionLifecycle.checkpoint.path);
        const checkpointBefore = await fsp.readFile(checkpointPath);

        await scenario.disable(box.workspace);
        const artifactsBefore = privateArtifactSnapshot(await treeSnapshot(box.base));
        const closed = await session({
          target: box.workspace, action: 'close', 'session-id': begun.sessionId,
          now: '2026-07-14T11:10:00Z'
        });
        assert.equal(closed.status, 'closed_ephemeral');
        assert.equal(closed.lifecycleState, 'closed');
        assert.equal(closed.filesWritten, 0);
        assert.deepEqual(privateArtifactSnapshot(await treeSnapshot(box.base)), artifactsBefore);
        assert.deepEqual(await fsp.readFile(checkpointPath), checkpointBefore);

        state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
        assert.equal(state.consent.currentSessionId, null);
        assert.equal(state.sessionLifecycle.state, 'closed');
        assert.equal(state.sessionLifecycle.sessionId, begun.sessionId);
        assert.equal(state.sessionLifecycle.checkpoint.path, checkpointRelative);

        const next = await session({
          target: box.workspace, action: 'begin', now: '2026-07-14T11:11:00Z'
        });
        assert.equal(next.status, 'active_ephemeral');
        assert.equal(next.lifecycleState, 'active');
        assert.notEqual(next.sessionId, begun.sessionId);
        assert.deepEqual(privateArtifactSnapshot(await treeSnapshot(box.base)), artifactsBefore);
        state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
        assert.equal(state.consent.currentSessionId, null);
        assert.equal(state.sessionLifecycle.state, 'closed');
      } finally {
        await box.cleanup();
      }
    });
  }
});

test('recovery of orphan A cannot replace a different active canonical session B', async () => {
  const box = await sandbox('session-orphan-active-conflict');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const orphan = await session({ target: box.workspace, action: 'begin', now: START });
    await session({
      target: box.workspace, action: 'checkpoint', 'session-id': orphan.sessionId,
      'turn-number': '1', now: '2026-07-14T11:01:00Z', liveThread: 'Orphan A private checkpoint.'
    });
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const orphanedState = await readJson(statePath);
    const orphanPath = path.join(box.workspace, orphanedState.sessionLifecycle.checkpoint.path);
    const orphanBytes = await fsp.readFile(orphanPath);
    const empty = createEmptySessionLifecyclePatch();
    orphanedState.consent.currentSessionId = empty.consent.currentSessionId;
    orphanedState.sessionLifecycle = empty.sessionLifecycle;
    await fsp.writeFile(statePath, `${JSON.stringify(orphanedState, null, 2)}\n`, { mode: 0o600 });
    await fsp.unlink(orphanPath);

    const active = await session({
      target: box.workspace, action: 'begin', now: '2026-07-14T11:02:00Z'
    });
    await fsp.writeFile(orphanPath, orphanBytes, { mode: 0o600 });
    const before = await readJson(statePath);

    await assert.rejects(session({
      target: box.workspace, action: 'recover', 'session-id': orphan.sessionId,
      'recovery-action': 'continue', 'can-resume-context': true, now: '2026-07-14T11:03:00Z'
    }), { code: 'SESSION_ALREADY_ACTIVE' });

    const after = await readJson(statePath);
    assert.deepEqual(after, before);
    assert.equal(after.consent.currentSessionId, active.sessionId);
    assert.equal(after.sessionLifecycle.sessionId, active.sessionId);
    assert.deepEqual(await fsp.readFile(orphanPath), orphanBytes);
  } finally {
    await box.cleanup();
  }
});

test('abandoning an interrupted recording finalizes evidence and terminal checkpoint cleanup preserves lifecycle', async () => {
  const box = await sandbox('session-recovery-terminal-transcript');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await consent({ target: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'until_deleted' });
    const begun = await session({ target: box.workspace, action: 'begin', now: '2026-07-15T10:00:00Z' });
    await transcript({
      target: box.workspace, action: 'start', 'session-id': begun.sessionId,
      'capture-grade': 'best_effort_context', now: '2026-07-15T10:00:05Z'
    });
    await session({
      target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
      'turn-number': '1', now: '2026-07-16T00:00:00Z', liveThread: 'Interrupted recording evidence.'
    });

    const abandoned = await session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'abandon', now: '2026-07-16T00:01:00Z'
    });
    assert.equal(abandoned.lifecycleState, 'abandoned');
    let state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.currentSessionId, null);
    assert.equal(state.sessionLifecycle.transcript.state, 'stopped');
    assert.equal(state.consent.transcriptState.state, 'stopped');
    assert.equal(state.sessionLifecycle.transcript.finalizedAt, '2026-07-16T00:01:00Z');
    assert.equal(state.consent.transcriptState.stoppedAt, '2026-07-16T00:01:00Z');
    assert.deepEqual(state.sessionLifecycle.transcript.knownGaps, state.consent.transcriptState.knownGaps);
    assert.ok(state.sessionLifecycle.transcript.knownGaps.some((gap) => gap.reason === 'interrupted'));
    assert.equal((await doctor({ target: box.workspace })).errors, 0);

    const checkpointPath = path.join(box.workspace, state.sessionLifecycle.checkpoint.path);
    let preview = await session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'delete'
    });
    const deleted = await session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'delete', confirm: preview.confirmationRequired, now: '2026-07-16T00:02:00Z'
    });
    assert.equal(deleted.lifecycleState, 'abandoned');
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.sessionLifecycle.state, 'abandoned');
    assert.equal(state.sessionLifecycle.checkpoint, null);
    assert.equal(state.sessionLifecycle.transcript.state, 'stopped');
    assert.equal(state.consent.transcriptState.state, 'stopped');
    await assert.rejects(fsp.access(checkpointPath), { code: 'ENOENT' });
    assert.equal((await doctor({ target: box.workspace })).errors, 0);
  } finally {
    await box.cleanup();
  }
});

test('recovery prefers newer canonical transcript evidence over a stale checkpoint snapshot', async () => {
  const box = await sandbox('session-recovery-canonical-transcript-precedence');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await consent({ target: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'until_deleted' });
    const begun = await session({ target: box.workspace, action: 'begin', now: '2026-07-15T00:00:00Z' });
    await session({
      target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
      'turn-number': '1', now: '2026-07-15T00:01:00Z', liveThread: 'Checkpoint predates capture changes.'
    });
    await transcript({
      target: box.workspace, action: 'start', 'session-id': begun.sessionId,
      'capture-grade': 'best_effort_context'
    });
    await transcript({ target: box.workspace, action: 'pause' });
    const before = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(before.sessionLifecycle.transcript.state, 'paused');
    assert.equal(before.sessionLifecycle.transcript.pausedIntervals.length, 1);
    const recoveredAt = new Date(Date.now() + 60_000).toISOString();

    await session({
      target: box.workspace, action: 'recover', 'session-id': begun.sessionId,
      'recovery-action': 'continue', 'can-resume-context': true, now: recoveredAt
    });
    const after = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(after.sessionLifecycle.transcript.state, 'stopped');
    assert.equal(after.sessionLifecycle.transcript.finalizedAt, recoveredAt);
    assert.equal(after.sessionLifecycle.transcript.pausedIntervals[0].startedAt,
      before.sessionLifecycle.transcript.pausedIntervals[0].startedAt);
    assert.equal(after.sessionLifecycle.transcript.pausedIntervals[0].endedAt, recoveredAt);
    assert.ok(after.sessionLifecycle.transcript.knownGaps.some((gap) => gap.reason === 'paused_no_backfill'));
    assert.ok(after.sessionLifecycle.transcript.knownGaps.some((gap) => gap.reason === 'interrupted'
      && gap.from === '2026-07-15T00:01:00Z' && gap.to === recoveredAt));
    const checkpoint = await fsp.readFile(
      path.join(box.workspace, after.sessionLifecycle.checkpoint.path), 'utf8'
    );
    assert.match(checkpoint, /^transcript_state: stopped$/m);
    assert.match(checkpoint, new RegExp(`^finalized_at: ${recoveredAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(checkpoint, /"reason":"interrupted"/);
    assert.equal((await doctor({ target: box.workspace })).errors, 0);
  } finally {
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
