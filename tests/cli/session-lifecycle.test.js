'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  artifactPaths,
  beginSession,
  checkpointTurn,
  closeSession,
  findInterruptedSessions,
  recoverSession,
  normalizeTranscript
} = require('../../cli/session-lifecycle');
const { hardenTree, verifyWindowsPrivateAcl } = require('../../cli/lib/fs-safe');

const FIXTURE = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'fixtures', 'session-lifecycle', 'cases.json'), 'utf8'));
const START = '2026-07-14T14:32:05+03:00';
const CLOSE = '2026-07-14T15:03:09+03:00';
const ROOT = path.resolve(__dirname, '..', '..');
const IDS = {
  collision: '11111111-1111-4111-8111-111111111111',
  first: '22222222-2222-4222-8222-222222222222',
  second: '33333333-3333-4333-8333-333333333333',
  recovery: '44444444-4444-4444-8444-444444444444',
  transcript: '55555555-5555-4555-8555-555555555555'
};

function state(name = 'allowed') {
  return structuredClone(FIXTURE[name]);
}

async function workspace(label) {
  await fsp.mkdir(path.join(ROOT, '.test-tmp'), { recursive: true });
  const root = await fsp.mkdtemp(path.join(ROOT, '.test-tmp', `scalvin-lifecycle-${label}-`));
  await fsp.mkdir(path.join(root, 'sessions'), { recursive: true });
  return { root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

function oneId(id) {
  return () => id;
}

async function start(root, id = IDS.first, canonicalState = state()) {
  return beginSession({ workspace: root, canonicalState, now: START, timezone: 'Europe/Istanbul', idFactory: oneId(id) });
}

test('same-second session allocation uses UUID no-clobber names and skips an occupied identity', async () => {
  const box = await workspace('no-clobber');
  try {
    const occupied = artifactPaths(START, `s-${IDS.collision}`).checkpoint;
    await fsp.mkdir(path.dirname(path.join(box.root, occupied)), { recursive: true });
    await fsp.writeFile(path.join(box.root, occupied), 'belongs-to-someone-else\n');
    const sequence = [IDS.collision, IDS.first];
    const first = await beginSession({
      workspace: box.root,
      canonicalState: state(),
      now: START,
      timezone: 'Europe/Istanbul',
      idFactory: () => sequence.shift()
    });
    const second = await start(box.root, IDS.second);

    assert.equal(first.session.id, `s-${IDS.first}`);
    assert.equal(second.session.id, `s-${IDS.second}`);
    assert.notEqual(first.session.paths.sessionNote, second.session.paths.sessionNote);
    assert.match(first.session.paths.sessionNote, /^sessions\/2026-07-14-143205--/);
    assert.equal(await fsp.readFile(path.join(box.root, occupied), 'utf8'), 'belongs-to-someone-else\n');
    assert.equal(first.canonicalPatch.sessionLifecycle.state, 'active');
    assert.equal(first.canonicalPatch.consent.currentSessionId, `s-${IDS.first}`);
  } finally {
    await box.cleanup();
  }
});

test('session paths are derived from timestamp plus UUID and caller path substitution is rejected', async () => {
  const box = await workspace('path-binding');
  try {
    const begun = await start(box.root);
    const tampered = structuredClone(begun.session);
    tampered.paths.sessionNote = 'NEXT-PRIMER.md';
    await assert.rejects(closeSession({
      workspace: box.root, canonicalState: state(), session: tampered,
      explicit: true, now: CLOSE, noteBody: '# Session Note\n'
    }), { code: 'SESSION_PATH_MISMATCH' });
    assert.equal(await fsp.stat(path.join(box.root, 'NEXT-PRIMER.md')).then(() => true, () => false), false);
  } finally {
    await box.cleanup();
  }
});

test('close creates one deterministic consent-gated deep dive with AI provenance and retry-safe no-clobber semantics', async () => {
  const box = await workspace('deep-dive');
  try {
    const begun = await start(box.root);
    const options = {
      workspace: box.root, canonicalState: state(), session: begun.session,
      explicit: true, now: CLOSE,
      noteBody: '# Session Note\n\nConcise continuity.',
      deepDiveBody: '# Deep Dive\n\nHistorical detail with uncertainty.'
    };
    const first = await closeSession(options);
    const expected = `archive/2026-07-14-143205--${IDS.first}--deep-dive.md`;
    assert.equal(first.session.paths.deepDive, expected);
    assert.deepEqual(first.written, [expected, begun.session.paths.sessionNote]);
    const deepDive = await fsp.readFile(path.join(box.root, expected), 'utf8');
    assert.match(deepDive, /^record_kind: ai_authored_deep_dive$/m);
    assert.match(deepDive, /^artifact_id: artifact-22222222-2222-4222-8222-222222222222$/m);
    assert.match(deepDive, /^author_role: ai_companion$/m);
    assert.match(deepDive, new RegExp(`^session_id: ${begun.session.id}$`, 'm'));
    assert.match(deepDive, /^consent_event_id: consent-123e4567-e89b-42d3-a456-426614174000$/m);
    const note = await fsp.readFile(path.join(box.root, begun.session.paths.sessionNote), 'utf8');
    assert.match(note, new RegExp(`^deep_dive: ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

    const retried = await closeSession(options);
    assert.deepEqual(retried.written, first.written);
    assert.equal(await fsp.readFile(path.join(box.root, expected), 'utf8'), deepDive);

    await fsp.writeFile(path.join(box.root, expected), deepDive.replace('source_ids: []', 'source_ids: [tampered]'));
    await assert.rejects(closeSession(options), { code: 'ARTIFACT_COLLISION' });
  } finally {
    await box.cleanup();
  }
});

test('timestamps and IANA zones are canonical and real', async () => {
  const box = await workspace('time-validation');
  try {
    await assert.rejects(beginSession({
      workspace: box.root, canonicalState: state(), now: '2026-02-30T12:00:00+03:00',
      timezone: 'Europe/Istanbul', idFactory: oneId(IDS.first)
    }), { code: 'INVALID_TIMESTAMP' });
    await assert.rejects(beginSession({
      workspace: box.root, canonicalState: state(), now: START,
      timezone: 'Europe/Definitely_Not_Real', idFactory: oneId(IDS.first)
    }), { code: 'INVALID_TIMEZONE' });
    await assert.rejects(beginSession({
      workspace: box.root, canonicalState: state(), now: '2026-07-14 14:32:05+03:00',
      timezone: 'Europe/Istanbul', idFactory: oneId(IDS.first)
    }), { code: 'INVALID_TIMESTAMP' });
  } finally {
    await box.cleanup();
  }
});

test('every persisted turn atomically replaces only its owned checkpoint and emits a deterministic patch', async () => {
  const box = await workspace('checkpoint');
  try {
    const begun = await start(box.root);
    const first = await checkpointTurn({
      workspace: box.root,
      canonicalState: state(),
      session: begun.session,
      turnNumber: 1,
      now: '2026-07-14T14:33:00+03:00',
      liveThread: 'First safely persisted turn.',
      unresolved: 'One question remains.',
      transcript: { state: 'recording', sessionId: begun.session.id, captureGrade: 'turn_captured', coveredTurns: { first: 1, last: 1, count: 1 } }
    });
    const second = await checkpointTurn({
      workspace: box.root,
      canonicalState: state(),
      session: first.session,
      turnNumber: 2,
      now: '2026-07-14T14:34:00+03:00',
      liveThread: 'Second safely persisted turn.',
      unresolved: '',
      carryForward: 'Continue from turn two.'
    });
    const checkpoint = path.join(box.root, second.session.paths.checkpoint);
    const beforeFailure = await fsp.readFile(checkpoint, 'utf8');

    process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT = 'checkpoint-before-write';
    await assert.rejects(checkpointTurn({
      workspace: box.root, canonicalState: state(), session: second.session, turnNumber: 3,
      now: '2026-07-14T14:35:00+03:00', liveThread: 'must not appear'
    }), { code: 'TEST_FAILPOINT' });
    delete process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT;

    assert.equal(await fsp.readFile(checkpoint, 'utf8'), beforeFailure);
    assert.match(beforeFailure, /last_persisted_turn: 2/);
    assert.match(beforeFailure, /Second safely persisted turn\./);
    assert.equal(second.canonicalPatch.sessionLifecycle.checkpoint.lastPersistedTurn, 2);
    assert.equal(second.canonicalPatch.sessionLifecycle.transcript.verbatimClaim, false);
    await assert.rejects(checkpointTurn({
      workspace: box.root, canonicalState: state(), session: second.session, turnNumber: 2,
      now: '2026-07-14T14:35:00+03:00', liveThread: 'duplicate'
    }), { code: 'NON_MONOTONIC_TURN' });
  } finally {
    delete process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT;
    await box.cleanup();
  }
});

test('consent-off and memory-pause states write nothing and return no canonical patch', async () => {
  for (const fixtureName of ['consentOff', 'writePause', 'sealedPause']) {
    const box = await workspace(`no-write-${fixtureName}`);
    try {
      const begun = await start(box.root, IDS.first, state(fixtureName));
      assert.equal(begun.status, 'active_ephemeral');
      assert.equal(begun.canonicalPatch, null);
      const checkpoint = await checkpointTurn({
        workspace: box.root, canonicalState: state(fixtureName), session: begun.session,
        turnNumber: 1, now: START, liveThread: 'sensitive payload must stay ephemeral'
      });
      assert.equal(checkpoint.status, 'skipped');
      assert.equal(checkpoint.canonicalPatch, null);
      const closed = await closeSession({
        workspace: box.root, canonicalState: state(fixtureName), session: begun.session,
        explicit: true, now: CLOSE, noteBody: 'must not persist', deepDiveBody: 'must not persist', primerBody: 'must not persist',
        transcript: { captureGrade: 'best_effort_context', turns: [], expectedLastTurn: 0 }
      });
      assert.equal(closed.writeDisposition, 'no_write');
      assert.equal(closed.canonicalPatch, null);
      assert.deepEqual(await fsp.readdir(path.join(box.root, 'sessions')), []);
      assert.equal(await fsp.stat(path.join(box.root, begun.session.paths.deepDive)).then(() => true, () => false), false);
      assert.equal(await fsp.stat(box.root).then(() => true), true);
    } finally {
      await box.cleanup();
    }
  }
});

test('transcript-only consent remains independent from continuity memory', async () => {
  const box = await workspace('transcript-only');
  try {
    const begun = await start(box.root, IDS.transcript, state('transcriptOnly'));
    assert.equal(begun.status, 'active');
    const checkpoint = await checkpointTurn({
      workspace: box.root, canonicalState: state('transcriptOnly'), session: begun.session,
      turnNumber: 1, now: START, liveThread: 'must not become a checkpoint'
    });
    assert.equal(checkpoint.status, 'skipped');
    const closed = await closeSession({
      workspace: box.root, canonicalState: state('transcriptOnly'), session: begun.session,
      explicit: true, now: CLOSE, noteBody: 'must not become a note', primerBody: 'must not become a primer',
      transcript: {
        captureGrade: 'turn_captured', captureComplete: true, expectedLastTurn: 1,
        turns: [{ number: 1, speaker: 'user', capturedAt: START, content: 'Transcript-consented visible turn.' }]
      }
    });
    assert.deepEqual(closed.written, [begun.session.paths.transcript]);
    assert.equal(closed.skipped.sessionNote, 'continuity_consent_off');
    assert.equal(closed.canonicalPatch.consent.currentSessionId, null);
    assert.deepEqual(await fsp.readdir(path.join(box.root, 'sessions')), []);
    assert.equal(await fsp.readFile(path.join(box.root, begun.session.paths.transcript), 'utf8').then((value) => value.includes('Transcript-consented visible turn.')), true);
  } finally {
    await box.cleanup();
  }
});

test('explicit close is retry-safe and retains the checkpoint until every artifact succeeds', async () => {
  const box = await workspace('close');
  try {
    const begun = await start(box.root);
    const checkpointed = await checkpointTurn({
      workspace: box.root, canonicalState: state(), session: begun.session,
      turnNumber: 1, now: '2026-07-14T14:33:00+03:00', liveThread: 'Close safely.'
    });
    await assert.rejects(closeSession({
      workspace: box.root, canonicalState: state(), session: checkpointed.session,
      explicit: false, now: CLOSE, noteBody: '# Session Note\n\nNo close.'
    }), { code: 'EXPLICIT_CLOSE_REQUIRED' });

    const closeOptions = {
      workspace: box.root, canonicalState: state(), session: checkpointed.session,
      explicit: true, now: CLOSE,
      noteBody: '# Session Note\n\nOnly confirmed material.',
      primerBody: '# Next Primer\n\nContinue gently.'
    };
    process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT = 'close-before-checkpoint-remove';
    await assert.rejects(closeSession(closeOptions), { code: 'TEST_FAILPOINT' });
    delete process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT;

    const checkpointPath = path.join(box.root, checkpointed.session.paths.checkpoint);
    const notePath = path.join(box.root, checkpointed.session.paths.sessionNote);
    assert.equal(await fsp.stat(checkpointPath).then(() => true), true);
    const noteBeforeRetry = await fsp.readFile(notePath, 'utf8');
    const incomplete = await findInterruptedSessions({ workspace: box.root, canonicalState: state() });
    assert.equal(incomplete.candidates[0].recoveryReason, 'close_incomplete');

    const closed = await closeSession(closeOptions);
    assert.equal(await fsp.readFile(notePath, 'utf8'), noteBeforeRetry);
    await assert.rejects(fsp.stat(checkpointPath), { code: 'ENOENT' });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.canonicalPatch.consent.currentSessionId, null);
    assert.equal(closed.canonicalPatch.sessionLifecycle.state, 'closed');
    assert.equal(closed.canonicalPatch.sessionLifecycle.checkpoint, null);
  } finally {
    delete process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT;
    await box.cleanup();
  }
});

test('a prior checkpoint remains canonically referenced when its retention is later disabled', async () => {
  const box = await workspace('retained-checkpoint');
  try {
    const begun = await start(box.root);
    const checkpointed = await checkpointTurn({
      workspace: box.root, canonicalState: state(), session: begun.session,
      turnNumber: 1, now: '2026-07-14T14:33:00+03:00', liveThread: 'Retain existing checkpoint.'
    });
    const changed = state();
    changed.consent.retention.primers_and_checkpoints = 'do_not_store';
    const closed = await closeSession({
      workspace: box.root, canonicalState: changed, session: checkpointed.session,
      explicit: true, now: CLOSE, noteBody: '# Session Note\n\nClosed without silently deleting prior checkpoint.'
    });
    assert.equal(closed.checkpointRetained, true);
    assert.equal(closed.canonicalPatch.sessionLifecycle.state, 'closed');
    assert.equal(closed.canonicalPatch.consent.currentSessionId, null);
    assert.equal(closed.canonicalPatch.sessionLifecycle.checkpoint.path, checkpointed.session.paths.checkpoint);
    assert.equal(await fsp.stat(path.join(box.root, checkpointed.session.paths.checkpoint)).then(() => true), true);
    const discovery = await findInterruptedSessions({ workspace: box.root, canonicalState: changed });
    assert.equal(discovery.status, 'retention_disabled');
    assert.equal(discovery.checkpointFilesRead, false);
  } finally {
    await box.cleanup();
  }
});

test('interrupted checkpoint discovery exposes metadata only and recovery requires real context proof', async () => {
  const box = await workspace('recovery');
  try {
    const begun = await start(box.root, IDS.recovery);
    const checkpointed = await checkpointTurn({
      workspace: box.root, canonicalState: state(), session: begun.session,
      turnNumber: 4, now: '2026-07-14T14:45:00+03:00',
      liveThread: 'Private checkpoint body.', unresolved: 'Unknown ending.'
    });
    const sealed = await findInterruptedSessions({ workspace: box.root, canonicalState: state('sealedPause') });
    assert.equal(sealed.status, 'sealed');
    assert.deepEqual(sealed.candidates, []);

    const found = await findInterruptedSessions({ workspace: box.root, canonicalState: state() });
    assert.equal(found.status, 'recovery_available');
    assert.equal(found.candidates.length, 1);
    assert.equal(JSON.stringify(found.candidates).includes('Private checkpoint body.'), false);
    const recovered = found.candidates[0].session;
    await assert.rejects(recoverSession({
      workspace: box.root, canonicalState: state(), session: recovered,
      action: 'continue', now: '2026-07-14T16:00:00+03:00'
    }), { code: 'RESUME_CONTEXT_UNAVAILABLE' });
    const continued = await recoverSession({
      workspace: box.root, canonicalState: state(), session: recovered,
      action: 'continue', canResumeContext: true, now: '2026-07-14T16:00:00+03:00'
    });
    assert.equal(continued.canonicalPatch.sessionLifecycle.state, 'active');
    assert.deepEqual(continued.canonicalPatch.sessionLifecycle.resumedAt, ['2026-07-14T16:00:00+03:00']);

    const partial = await recoverSession({
      workspace: box.root, canonicalState: state(), session: { ...continued.session, state: 'interrupted' },
      action: 'close_interrupted', now: '2026-07-14T16:01:00+03:00',
      noteBody: '# Interrupted Session Note\n\nKnown material only.', primerBody: '# Next Primer\n'
    });
    assert.equal(partial.canonicalPatch.sessionLifecycle.completion, 'interrupted_partial');
    const note = await fsp.readFile(path.join(box.root, partial.session.paths.sessionNote), 'utf8');
    assert.match(note, /completion: interrupted_partial/);
    assert.doesNotMatch(note, /Private checkpoint body\./);
    assert.equal((await findInterruptedSessions({ workspace: box.root, canonicalState: state() })).status, 'none');
  } finally {
    await box.cleanup();
  }
});

test('malformed checkpoint coverage metadata fails closed instead of becoming an empty gap list', async () => {
  const box = await workspace('malformed-recovery');
  try {
    const begun = await start(box.root);
    const checkpointed = await checkpointTurn({
      workspace: box.root, canonicalState: state(), session: begun.session,
      turnNumber: 1, now: '2026-07-14T14:33:00+03:00', liveThread: 'Metadata validation.'
    });
    const filename = path.join(box.root, checkpointed.session.paths.checkpoint);
    const raw = await fsp.readFile(filename, 'utf8');
    await fsp.writeFile(filename, raw.replace('known_gaps: []', 'known_gaps: {not-json'), 'utf8');
    await assert.rejects(findInterruptedSessions({ workspace: box.root, canonicalState: state() }), { code: 'CHECKPOINT_METADATA_INVALID' });
  } finally {
    await box.cleanup();
  }
});

for (const field of ['record_kind', 'session_id', 'covered_turns']) {
  test(`checkpoint discovery rejects duplicate ${field} frontmatter before assignment`, async () => {
    const box = await workspace(`duplicate-checkpoint-${field}`);
    try {
      const begun = await start(box.root);
      const checkpointed = await checkpointTurn({
        workspace: box.root, canonicalState: state(), session: begun.session,
        turnNumber: 1, now: '2026-07-14T14:33:00+03:00', liveThread: 'Duplicate-field test.'
      });
      const filename = path.join(box.root, checkpointed.session.paths.checkpoint);
      const raw = await fsp.readFile(filename, 'utf8');
      const value = raw.match(new RegExp(`^${field}: (.*)$`, 'm'))[1];
      await fsp.writeFile(filename, raw.replace(/^---$/m, `---\n${field}: ${value}`));
      await assert.rejects(findInterruptedSessions({ workspace: box.root, canonicalState: state() }), { code: 'CHECKPOINT_METADATA_INVALID' });
    } finally {
      await box.cleanup();
    }
  });
}

for (const field of ['record_kind', 'session_id']) {
  test(`idempotent close verification rejects duplicate ${field} frontmatter`, async () => {
    const box = await workspace(`duplicate-note-${field}`);
    try {
      const begun = await start(box.root);
      const options = {
        workspace: box.root, canonicalState: state(), session: begun.session,
        explicit: true, now: CLOSE, noteBody: '# Session Note\n\nExact bytes.'
      };
      await closeSession(options);
      const filename = path.join(box.root, begun.session.paths.sessionNote);
      const raw = await fsp.readFile(filename, 'utf8');
      const value = raw.match(new RegExp(`^${field}: (.*)$`, 'm'))[1];
      await fsp.writeFile(filename, raw.replace(/^---$/m, `---\n${field}: ${value}`));
      await assert.rejects(closeSession(options), { code: 'ARTIFACT_INVALID' });
    } finally {
      await box.cleanup();
    }
  });
}

test('transcript evidence reports capture method, coverage and gaps without promising verbatim text', async () => {
  const box = await workspace('transcript');
  try {
    const begun = await start(box.root, IDS.transcript);
    const checkpointed = await checkpointTurn({
      workspace: box.root, canonicalState: state(), session: begun.session,
      turnNumber: 4, now: '2026-07-14T14:50:00+03:00', liveThread: 'Transcript coverage test.'
    });
    const transcript = {
      captureGrade: 'turn_captured',
      captureComplete: false,
      expectedLastTurn: 4,
      pausedIntervals: [{ startedAt: '2026-07-14T14:40:00+03:00', endedAt: '2026-07-14T14:42:00+03:00' }],
      turns: [
        { number: 1, speaker: 'user', capturedAt: '2026-07-14T14:33:00+03:00', content: 'Visible user turn.' },
        { number: 3, speaker: 'companion', capturedAt: '2026-07-14T14:43:00+03:00', content: 'Visible companion turn.' }
      ]
    };
    const closed = await closeSession({
      workspace: box.root, canonicalState: state(), session: checkpointed.session,
      explicit: true, now: CLOSE, noteBody: '# Session Note\n\nCoverage is partial.', transcript
    });
    const evidence = closed.canonicalPatch.sessionLifecycle.transcript;
    assert.equal(evidence.captureMethod, 'turn_captured');
    assert.equal(evidence.captureGrade, 'partial');
    assert.equal(evidence.fullCoverageProven, false);
    assert.equal(evidence.verbatimClaim, false);
    assert.ok(evidence.knownGaps.some((gap) => gap.reason === 'not_captured'));
    assert.ok(evidence.knownGaps.some((gap) => gap.reason === 'capture_ended_early'));
    assert.ok(evidence.knownGaps.some((gap) => gap.reason === 'paused_no_backfill'));
    const stored = await fsp.readFile(path.join(box.root, closed.session.paths.transcript), 'utf8');
    assert.match(stored, /capture_grade: partial/);
    assert.match(stored, /capture_method: turn_captured/);
    assert.match(stored, /verbatim_claim: false/);
    assert.doesNotMatch(stored, /verbatim_claim: true/);
    const bodyStart = stored.indexOf('\n---\n', 4) + 5;
    const declaredHash = stored.match(/^body_sha256: ([a-f0-9]{64})$/m)[1];
    assert.equal(crypto.createHash('sha256').update(stored.slice(bodyStart)).digest('hex'), declaredHash);

    const bestEffort = normalizeTranscript({
      captureGrade: 'best_effort_context', captureComplete: true, expectedLastTurn: 1,
      turns: [{ number: 1, speaker: 'user', capturedAt: START, content: 'Available context only.' }]
    }, begun.session, CLOSE);
    assert.equal(bestEffort.captureGrade, 'best_effort_context');
    assert.equal(bestEffort.verbatimClaim, false);
  } finally {
    await box.cleanup();
  }
});

test('high-grade transcript claims require verified adapter capability evidence', async () => {
  const box = await workspace('capture-proof');
  try {
    const begun = await start(box.root);
    const base = {
      captureGrade: 'turn_captured', captureComplete: true, expectedLastTurn: 1,
      turns: [{ number: 1, speaker: 'user', capturedAt: START, content: 'Visible turn.' }]
    };
    const unverified = normalizeTranscript(base, begun.session, CLOSE);
    assert.equal(unverified.captureMethod, 'turn_captured');
    assert.equal(unverified.captureGrade, 'best_effort_context');
    assert.equal(unverified.capabilityProofVerified, false);
    assert.equal(unverified.fullCoverageProven, false);

    const verified = normalizeTranscript({
      ...base,
      capabilityProof: {
        verified: true,
        sessionId: begun.session.id,
        captureGrade: 'turn_captured',
        capability: 'transactional_per_turn_capture'
      }
    }, begun.session, CLOSE);
    assert.equal(verified.captureGrade, 'turn_captured');
    assert.equal(verified.capabilityProofVerified, true);
    assert.equal(verified.fullCoverageProven, true);
    assert.equal(verified.verbatimClaim, false);

    assert.throws(() => normalizeTranscript({
      ...base,
      knownGaps: [{ fromTurn: 1, toTurn: 1, reason: 'made_up_reason' }]
    }, begun.session, CLOSE), { code: 'INVALID_TRANSCRIPT_COVERAGE' });
    assert.throws(() => normalizeTranscript({
      ...base,
      pausedIntervals: [{ startedAt: CLOSE, endedAt: START }]
    }, begun.session, CLOSE), { code: 'INVALID_TRANSCRIPT_COVERAGE' });
  } finally {
    await box.cleanup();
  }
});

test('exclusive artifact creation has a tested marker-backed fallback when hard links are unavailable', async () => {
  const box = await workspace('exclusive-fallback');
  try {
    await hardenTree(box.root);
    const begun = await start(box.root);
    process.env.SCALVIN_TEST_FORCE_NO_HARDLINK = '1';
    const checkpointed = await checkpointTurn({
      workspace: box.root, canonicalState: state(), session: begun.session,
      turnNumber: 1, now: '2026-07-14T14:33:00+03:00', liveThread: 'Portable exclusive create.'
    });
    const filename = path.join(box.root, checkpointed.session.paths.checkpoint);
    assert.equal(await fsp.stat(filename).then(() => true), true);
    assert.equal(await fsp.stat(`${filename}.incomplete`).then(() => true, () => false), false);
    if (process.platform === 'win32') {
      assert.deepEqual(await verifyWindowsPrivateAcl(box.root), { ok: true });
    }

    const second = await start(box.root, IDS.second);
    process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT = 'exclusive-fallback-crash';
    await assert.rejects(checkpointTurn({
      workspace: box.root, canonicalState: state(), session: second.session,
      turnNumber: 1, now: '2026-07-14T14:34:00+03:00', liveThread: 'Simulated crash.'
    }), { code: 'TEST_FAILPOINT' });
    const incomplete = path.join(box.root, second.session.paths.checkpoint);
    assert.equal(await fsp.stat(`${incomplete}.incomplete`).then(() => true), true);
    delete process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT;
    await assert.rejects(checkpointTurn({
      workspace: box.root, canonicalState: state(), session: second.session,
      turnNumber: 1, now: '2026-07-14T14:34:01+03:00', liveThread: 'Must fail closed.'
    }), { code: 'ARTIFACT_INCOMPLETE' });
  } finally {
    delete process.env.SCALVIN_TEST_FORCE_NO_HARDLINK;
    delete process.env.SCALVIN_TEST_LIFECYCLE_FAILPOINT;
    await box.cleanup();
  }
});

test('lifecycle module exports no process, network, or dynamic-evaluation path', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', '..', 'cli', 'session-lifecycle.js'), 'utf8');
  assert.doesNotMatch(source, /child_process|execFile|spawn\s*\(|\beval\s*\(|new Function|\bfetch\s*\(/);
  assert.match(source, /atomicExclusiveWrite/);
  assert.match(source, /canonicalPatch/);
  assert.equal(typeof crypto.randomUUID, 'function');
});

test('runtime and artifact templates carry the same per-turn, no-clobber, no-verbatim contract', async () => {
  const runtime = await fsp.readFile(path.join(ROOT, 'runtime', 'SESSION-LIFECYCLE.md'), 'utf8');
  const checkpoint = await fsp.readFile(path.join(ROOT, 'templates', 'archive', 'checkpoints', 'CHECKPOINT.template.md'), 'utf8');
  const transcript = await fsp.readFile(path.join(ROOT, 'templates', 'archive', 'transcripts', 'TRANSCRIPT.template.md'), 'utf8');
  assert.match(runtime, /after every completed user-visible turn/i);
  assert.match(runtime, /no-clobber\/exclusive-create/i);
  assert.match(runtime, /failed checkpoint attempt must leave the preceding valid checkpoint intact/i);
  assert.match(runtime, /no canonical patch/i);
  assert.match(runtime, /verbatim_claim: false/i);
  assert.match(runtime, /verified transactional per-turn capture/i);
  assert.match(runtime, /\.incomplete.*marker/i);
  assert.doesNotMatch(runtime, /approximately every 10 substantive turns/i);
  assert.match(checkpoint, /last_persisted_turn: null/);
  assert.match(checkpoint, /known_gaps: \[\]/);
  assert.match(transcript, /capture_method:/);
  assert.match(transcript, /capability_proof_verified: false/);
  assert.match(transcript, /full_coverage_proven: false/);
  assert.match(transcript, /verbatim_claim: false/);
});
