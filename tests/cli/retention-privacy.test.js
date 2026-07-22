'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, backup, consent, contextGraph, memory, session, source } = require('../../cli/operations');
const { parseArgs } = require('../../cli/lib/args');
const { RETENTION_CONTROL_PATH, renderPrimerSingleton } = require('../../cli/memory-data');
const { canonicalCandidateJson, canonicalEntityJson, entityRelative } = require('../../cli/context-graph');
const { sandbox } = require('./helpers');

const OLD_ID = 'mem-10000000-0000-4000-8000-000000000001';
const NEW_ID = 'mem-20000000-0000-4000-8000-000000000002';
const OLD_SESSION = 's-30000000-0000-4000-8000-000000000003';
const NEW_SESSION = 's-40000000-0000-4000-8000-000000000004';

function memoryBlock(id, statement, firstObserved, firstSession) {
  return [
    `### ${id} — Synthetic fixture`,
    '',
    `- Statement: ${statement}`,
    '- Kind: reported_fact',
    '- Status: user_confirmed',
    `- First observed: ${firstObserved}`,
    `- First session: ${firstSession}`,
    '- Imported at: null',
    '- Source IDs: []',
    `- Last live confirmed: ${firstObserved}`,
    `- Last confirmed session: ${firstSession}`,
    '- Confidence: user_stated',
    '- Review state: current',
    '- Current revision: 1',
    ''
  ].join('\n');
}

async function writeProfile(workspace, blocks) {
  await fsp.writeFile(path.join(workspace, 'profile.md'), `# Profile\n\n${blocks.join('\n')}`, { mode: 0o600 });
}

test('retention args parse and policy sidecar leaves canonical consent retention unchanged', async () => {
  const parsed = parseArgs([
    'memory', '--workspace', '/tmp/example', '--action', 'retention-set',
    '--data-class', 'profile_memory', '--policy', 'rolling_days', '--days', '30',
    '--now', '2026-07-15T00:00:00Z'
  ]);
  assert.equal(parsed.options['data-class'], 'profile_memory');
  assert.equal(parsed.options.policy, 'rolling_days');
  assert.equal(parsed.options.days, '30');

  const box = await sandbox('retention-sidecar');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await writeProfile(box.workspace, [memoryBlock(OLD_ID, 'PRIVATE-SENTINEL', '2026-06-01T00:00:00Z', OLD_SESSION)]);
    const before = JSON.parse(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'));
    const result = await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'profile_memory',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.enforcementMode, 'manual_preview_and_exact_confirmation');
    const controlPath = path.join(box.workspace, RETENTION_CONTROL_PATH);
    const control = JSON.parse(await fsp.readFile(controlPath, 'utf8'));
    assert.deepEqual(control.policies.profile_memory, {
      policy: 'rolling_days', configuredAt: '2026-07-15T00:00:00.000Z', days: 30
    });
    if (process.platform !== 'win32') assert.equal((await fsp.stat(controlPath)).mode & 0o777, 0o600);
    const after = JSON.parse(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'));
    assert.deepEqual(after.consent.retention, before.consent.retention);

    const status = await memory({ target: box.workspace, action: 'retention-status', now: '2026-07-15T00:00:00Z' });
    const profile = status.classes.find((item) => item.dataClass === 'profile_memory');
    assert.equal(profile.objectCount, 1);
    assert.equal(profile.dueCount, 1);
    assert.equal(status.contentIncluded, false);
    assert.equal(status.objectIdentifiersIncluded, false);
    const publicJson = JSON.stringify(status);
    assert.equal(publicJson.includes('PRIVATE-SENTINEL'), false);
    assert.equal(publicJson.includes(OLD_ID), false);
    assert.equal(publicJson.includes('profile.md'), false);

    await memory({ target: box.workspace, action: 'seal' });
    const sealed = await memory({ target: box.workspace, action: 'retention-status', now: '2026-07-15T00:00:00Z' });
    assert.equal(sealed.inventoryAvailable, false);
    assert.equal(sealed.classes.find((item) => item.dataClass === 'profile_memory').objectCount, null);
    assert.deepEqual(sealed.warnings.map((item) => item.code), ['RETENTION_INVENTORY_SEALED']);
    await assert.rejects(memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'profile_memory',
      policy: 'rolling_days', days: '60', now: '2026-07-15T00:00:00Z'
    }), { code: 'MEMORY_SEALED' });
    await assert.rejects(memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'profile_memory', now: '2026-07-15T00:00:00Z'
    }), { code: 'MEMORY_SEALED' });
  } finally {
    await box.cleanup();
  }
});

test('rolling retention requires preview, rejects stale confirmation, and leaves backup copies separate', async () => {
  const box = await sandbox('retention-rolling-apply');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await writeProfile(box.workspace, [memoryBlock(OLD_ID, 'Remove after exact preview.', '2026-06-01T00:00:00Z', OLD_SESSION)]);
    const separate = await backup({ target: box.workspace, 'allow-plaintext-backup': true });
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'profile_memory',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });
    const preview = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'profile_memory'
    });
    assert.equal(preview.status, 'preview');
    assert.match(preview.planTimestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(preview.dueCount, 1);
    assert.equal(preview.knownBackupRecords, 1);
    assert.equal(preview.backupsRemainSeparateCopies, true);
    assert.deepEqual(preview.retainedSeparateCopies, ['known_backups_outside_live_workspace']);
    await fsp.appendFile(path.join(box.workspace, 'profile.md'), '\n<!-- concurrent change -->\n');
    await assert.rejects(memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'profile_memory',
      now: preview.planTimestamp, confirm: preview.confirmationRequired
    }), { code: 'STALE_CONFIRMATION' });
    assert.match(await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8'), new RegExp(OLD_ID));

    const fresh = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'profile_memory'
    });
    const applied = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'profile_memory',
      now: fresh.planTimestamp, confirm: fresh.confirmationRequired
    });
    assert.equal(applied.status, 'deleted');
    assert.equal(applied.planTimestamp, fresh.planTimestamp);
    assert.equal(applied.backupsRemainSeparateCopies, true);
    assert.doesNotMatch(await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8'), new RegExp(OLD_ID));
    await fsp.access(separate.backupPath);
  } finally {
    await box.cleanup();
  }
});

test('source-owned memory is classified as blocked before retention apply', async () => {
  const box = await sandbox('retention-source-owned-memory');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await consent({ target: box.workspace, category: 'imported_sources', value: 'on', retention: 'until_deleted' });
    const sourcePath = path.join(box.base, 'source-owned.txt');
    await fsp.writeFile(sourcePath, 'synthetic source-owned memory provenance');
    const imported = await source({
      target: box.workspace, action: 'add', path: sourcePath, now: '2026-06-01T00:00:00Z'
    });
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    const record = state.sourceLifecycle.records.find((item) => item.sourceId === imported.sourceId);
    assert.ok(record);
    record.derivedMemoryIds = [OLD_ID];
    await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await writeProfile(box.workspace, [memoryBlock(OLD_ID, 'Source-owned item.', '2026-06-01T00:00:00Z', OLD_SESSION)]);
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'profile_memory',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });

    const status = await memory({
      target: box.workspace, action: 'retention-status', 'data-class': 'profile_memory', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(status.classes[0].dueCount, 0);
    assert.equal(status.classes[0].blockedCount, 1);
    const blocked = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'profile_memory', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.affectedFiles, 0);
    assert.match(await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8'), new RegExp(OLD_ID));
  } finally {
    await box.cleanup();
  }
});

test('session_only never backfills pre-policy memory and expire_at blocks malformed transcripts', async () => {
  const box = await sandbox('retention-session-expiry');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await writeProfile(box.workspace, [
      memoryBlock(OLD_ID, 'Pre-policy item remains.', '2026-07-14T00:00:00Z', OLD_SESSION),
      memoryBlock(NEW_ID, 'Post-policy closed-session item expires.', '2026-07-16T00:00:00Z', NEW_SESSION)
    ]);
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'profile_memory',
      policy: 'session_only', now: '2026-07-15T00:00:00Z'
    });
    const sessionPreview = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'profile_memory', now: '2026-07-17T00:00:00Z'
    });
    assert.equal(sessionPreview.dueCount, 1);
    assert.equal(sessionPreview.prePolicyCount, 1);
    const sessionApplied = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'profile_memory',
      now: '2026-07-17T00:00:00Z', confirm: sessionPreview.confirmationRequired
    });
    assert.equal(sessionApplied.status, 'deleted');
    const profile = await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8');
    assert.match(profile, new RegExp(OLD_ID));
    assert.doesNotMatch(profile, new RegExp(NEW_ID));

    const transcriptRoot = path.join(box.workspace, 'archive', 'transcripts');
    await fsp.mkdir(transcriptRoot, { recursive: true, mode: 0o700 });
    const validPath = path.join(transcriptRoot, '2026-07-16-000000--valid--transcript.md');
    const malformedPath = path.join(transcriptRoot, '2026-07-16-000000--malformed--transcript.md');
    const reversedPath = path.join(transcriptRoot, '2026-07-16-000000--reversed--transcript.md');
    const unfinishedPath = path.join(transcriptRoot, '2026-07-16-000000--unfinished--transcript.md');
    await fsp.writeFile(validPath, `---\nrecord_kind: transcript\nsession_id: ${NEW_SESSION}\nstarted_at: 2026-07-16T00:00:00Z\nfinalized_at: 2026-07-16T01:00:00Z\n---\n\nvalid private transcript\n`, { mode: 0o600 });
    await fsp.writeFile(malformedPath, '---\nrecord_kind: transcript\nstarted_at: not-a-date\n---\n\nmalformed private transcript\n', { mode: 0o600 });
    await fsp.writeFile(reversedPath, '---\nrecord_kind: transcript\nsession_id: s-50000000-0000-4000-8000-000000000005\nstarted_at: 2026-07-16T02:00:00Z\nfinalized_at: 2026-07-16T01:00:00Z\n---\n\nreversed private transcript\n', { mode: 0o600 });
    await fsp.writeFile(unfinishedPath, '---\nrecord_kind: transcript\nsession_id: s-60000000-0000-4000-8000-000000000006\nstarted_at: 2026-07-16T00:00:00Z\n---\n\nunfinished private transcript\n', { mode: 0o600 });
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'raw_transcripts',
      policy: 'expire_at', 'expires-at': '2026-07-16T12:00:00Z', now: '2026-07-15T00:00:00Z'
    });
    const transcriptPreview = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'raw_transcripts', now: '2026-07-17T00:00:00Z'
    });
    assert.equal(transcriptPreview.dueCount, 1);
    assert.equal(transcriptPreview.blockedCount, 3);
    const transcriptApplied = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'raw_transcripts',
      now: '2026-07-17T00:00:00Z', confirm: transcriptPreview.confirmationRequired
    });
    assert.equal(transcriptApplied.status, 'deleted');
    assert.equal(transcriptApplied.blockedCount, 3);
    await assert.rejects(fsp.access(validPath), { code: 'ENOENT' });
    await fsp.access(malformedPath);
    await fsp.access(reversedPath);
    await fsp.access(unfinishedPath);

    const controlPath = path.join(box.workspace, RETENTION_CONTROL_PATH);
    const poisoned = JSON.parse(await fsp.readFile(controlPath, 'utf8'));
    poisoned.untrusted = true;
    await fsp.writeFile(controlPath, `${JSON.stringify(poisoned, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(
      memory({ target: box.workspace, action: 'retention-status' }),
      { code: 'RETENTION_CONTROL_INVALID' }
    );
    await fsp.access(malformedPath);
  } finally {
    await box.cleanup();
  }
});

test('retention inventories one exact populated primer, resets a due primer to empty, and blocks malformed bytes', async () => {
  const box = await sandbox('retention-primer-singleton');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const primerPath = path.join(box.workspace, 'NEXT-PRIMER.md');
    const emptyStatus = await memory({
      target: box.workspace, action: 'retention-status', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z'
    });
    assert.equal(emptyStatus.classes[0].objectCount, 0);

    await fsp.writeFile(primerPath, 'not a canonical primer\n', { mode: 0o600 });
    const malformedInherit = await memory({
      target: box.workspace, action: 'retention-status', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z'
    });
    assert.equal(malformedInherit.classes[0].objectCount, 1);
    assert.equal(malformedInherit.classes[0].blockedCount, 1);
    assert.equal(malformedInherit.classes[0].retainedCount, 0);

    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'primers_and_checkpoints',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });
    const oldPrimer = renderPrimerSingleton({
      user: 'Alex', closedSession: OLD_SESSION, closedAt: '2026-06-01T00:00:00Z',
      whereWeAre: 'Old position.', whatsLive: 'Old thread.', carryForward: 'Ask before continuing.'
    });
    await fsp.writeFile(primerPath, oldPrimer, { mode: 0o600 });
    const preview = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z'
    });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.dueCount, 1);
    assert.equal(preview.blockedCount, 0);
    assert.equal(preview.affectedFiles, 1);
    const applied = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z', confirm: preview.confirmationRequired
    });
    assert.equal(applied.status, 'deleted');
    assert.equal(await fsp.readFile(primerPath, 'utf8'), '');
    const afterReset = await memory({
      target: box.workspace, action: 'retention-status', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z'
    });
    assert.equal(afterReset.classes[0].objectCount, 0);

    const futurePrimer = renderPrimerSingleton({
      user: 'Alex', closedSession: NEW_SESSION, closedAt: '2026-07-14T00:00:00Z',
      whereWeAre: 'Current position.', whatsLive: 'Current thread.', carryForward: 'Continue only with consent.'
    });
    await fsp.writeFile(primerPath, futurePrimer, { mode: 0o600 });
    const future = await memory({
      target: box.workspace, action: 'retention-status', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z'
    });
    assert.equal(future.classes[0].objectCount, 1);
    assert.equal(future.classes[0].dueCount, 0);
    assert.equal(future.classes[0].retainedCount, 1);
    assert.equal(future.classes[0].blockedCount, 0);

    await fsp.writeFile(primerPath, futurePrimer.replace('- User: Alex', '- User:  Alex'), { mode: 0o600 });
    const malformed = await memory({
      target: box.workspace, action: 'retention-status', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z'
    });
    assert.equal(malformed.classes[0].objectCount, 1);
    assert.equal(malformed.classes[0].dueCount, 0);
    assert.equal(malformed.classes[0].retainedCount, 0);
    assert.equal(malformed.classes[0].blockedCount, 1);
  } finally {
    await box.cleanup();
  }
});

test('retention blocks a canonical lifecycle checkpoint under rolling and future expire policies', async () => {
  const box = await sandbox('retention-active-checkpoint');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const begun = await session({ target: box.workspace, action: 'begin', now: '2026-06-01T00:00:00Z' });
    await session({
      target: box.workspace, action: 'checkpoint', 'session-id': begun.sessionId,
      'turn-number': '1', now: '2026-06-01T00:01:00Z', liveThread: 'Protected active checkpoint.'
    });
    const state = JSON.parse(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'));
    const checkpointPath = path.join(box.workspace, state.sessionLifecycle.checkpoint.path);
    const inherited = await memory({
      target: box.workspace, action: 'retention-status', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z'
    });
    assert.equal(inherited.classes[0].objectCount, 1);
    assert.equal(inherited.classes[0].blockedCount, 1);
    assert.equal(inherited.classes[0].retainedCount, 0);

    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'primers_and_checkpoints',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });
    const rolling = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z'
    });
    assert.equal(rolling.status, 'blocked');
    assert.equal(rolling.dueCount, 0);
    assert.equal(rolling.blockedCount, 1);
    assert.equal(rolling.affectedFiles, 0);
    await fsp.access(checkpointPath);

    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'primers_and_checkpoints',
      policy: 'expire_at', 'expires-at': '2026-07-20T00:00:00Z', now: '2026-07-15T00:00:00Z'
    });
    const futureExpiry = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'primers_and_checkpoints',
      now: '2026-07-15T00:00:00Z'
    });
    assert.equal(futureExpiry.status, 'blocked');
    assert.equal(futureExpiry.dueCount, 0);
    assert.equal(futureExpiry.blockedCount, 1);
    assert.equal(futureExpiry.retainedCount, 0);
    assert.equal(futureExpiry.affectedFiles, 0);
    await fsp.access(checkpointPath);
    const after = JSON.parse(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'));
    assert.equal(after.sessionLifecycle.checkpoint.path, state.sessionLifecycle.checkpoint.path);
  } finally {
    await box.cleanup();
  }
});

test('retention fails closed when duplicate transcript session IDs would widen deletion', async () => {
  const box = await sandbox('retention-duplicate-transcript-session');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const transcriptRoot = path.join(box.workspace, 'archive', 'transcripts');
    await fsp.mkdir(transcriptRoot, { recursive: true, mode: 0o700 });
    const oldPath = path.join(transcriptRoot, '2026-05-01-000000--old--transcript.md');
    const retainedPath = path.join(transcriptRoot, '2026-07-14-000000--retained--transcript.md');
    await fsp.writeFile(oldPath, `---\nrecord_kind: transcript\nsession_id: ${NEW_SESSION}\nstarted_at: 2026-05-01T00:00:00Z\nfinalized_at: 2026-05-01T01:00:00Z\n---\n\nold private transcript\n`, { mode: 0o600 });
    await fsp.writeFile(retainedPath, `---\nrecord_kind: transcript\nsession_id: ${NEW_SESSION}\nstarted_at: 2026-07-14T00:00:00Z\nfinalized_at: 2026-07-14T01:00:00Z\n---\n\nretained private transcript\n`, { mode: 0o600 });
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'raw_transcripts',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });

    const result = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'raw_transcripts', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.dueCount, 0);
    assert.equal(result.blockedCount, 1);
    assert.equal(result.retainedCount, 1);
    assert.equal(result.affectedFiles, 0);
    await fsp.access(oldPath);
    await fsp.access(retainedPath);
  } finally {
    await box.cleanup();
  }
});

test('retention and explicit deletion reject a malformed transcript that re-declares a requested session ID', async () => {
  const box = await sandbox('retention-malformed-duplicate-transcript-session');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const transcriptRoot = path.join(box.workspace, 'archive', 'transcripts');
    await fsp.mkdir(transcriptRoot, { recursive: true, mode: 0o700 });
    const canonicalPath = path.join(transcriptRoot, '2026-05-01-000000--canonical--transcript.md');
    const ambiguousPath = path.join(transcriptRoot, '2026-07-14-000000--ambiguous--transcript.md');
    await fsp.writeFile(canonicalPath, `---\nrecord_kind: transcript\nsession_id: ${NEW_SESSION}\nstarted_at: 2026-05-01T00:00:00Z\nfinalized_at: 2026-05-01T01:00:00Z\n---\n\ncanonical private transcript\n`, { mode: 0o600 });
    await fsp.writeFile(ambiguousPath, `---\nrecord_kind: transcript\nsession_id: ${NEW_SESSION}\nsession_id: ${NEW_SESSION}\nstarted_at: 2026-07-14T00:00:00Z\nfinalized_at: 2026-07-14T01:00:00Z\n---\n\nambiguous private transcript\n`, { mode: 0o600 });
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'raw_transcripts',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });

    await assert.rejects(memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'raw_transcripts',
      now: '2026-07-15T00:00:00Z'
    }), { code: 'TRANSCRIPT_IDENTITY_AMBIGUOUS' });
    await assert.rejects(require('../../cli/operations').transcript({
      target: box.workspace, action: 'delete', 'session-id': NEW_SESSION
    }), { code: 'TRANSCRIPT_IDENTITY_AMBIGUOUS' });
    await fsp.access(canonicalPath);
    await fsp.access(ambiguousPath);
  } finally {
    await box.cleanup();
  }
});

test('retention sidecar rejects symlink and hard-link substitution before inspection', async (t) => {
  const box = await sandbox('retention-sidecar-links');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'profile_memory',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });
    const controlPath = path.join(box.workspace, RETENTION_CONTROL_PATH);
    const outside = path.join(box.base, 'retention-control-outside.json');
    await fsp.rename(controlPath, outside);
    await fsp.symlink(outside, controlPath);
    await assert.rejects(memory({ target: box.workspace, action: 'retention-status' }), { code: 'SYMLINK_REJECTED' });
    await fsp.rm(controlPath);
    try {
      await fsp.link(outside, controlPath);
    } catch (error) {
      if (['ENOTSUP', 'EPERM', 'EACCES'].includes(error.code)) {
        t.skip(`hard links unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(memory({ target: box.workspace, action: 'retention-status' }), { code: 'HARDLINK_REJECTED' });
  } finally {
    await box.cleanup();
  }
});

test('retention deletes canonical reviews, maintains navigation, and blocks retained summary provenance', async () => {
  const box = await sandbox('retention-reviews');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const reviews = path.join(box.workspace, 'archive', 'reviews');
    const firstUuid = '50000000-0000-4000-8000-000000000005';
    const firstId = `review-${firstUuid}`;
    const firstName = `2026-06-01-120000--${firstUuid}--weekly-review.md`;
    await fsp.writeFile(path.join(reviews, firstName), `---\nrecord_kind: ai_authored_weekly_review\nreview_id: ${firstId}\ncreated_at: 2026-06-01T12:00:00Z\ntimezone: Europe/Istanbul\ncovered_session_ids: []\nconsent_event_id: consent-60000000-0000-4000-8000-000000000006\ncompletion: complete\n---\n\n# Weekly Review\n`, { mode: 0o600 });
    const indexPath = path.join(reviews, 'REVIEW-INDEX.md');
    await fsp.appendFile(indexPath, `- [${firstName}] — ${firstId}\n`);
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'reviews_and_summaries',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });
    const preview = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'reviews_and_summaries', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.dueCount, 1);
    const applied = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'reviews_and_summaries',
      now: '2026-07-15T00:00:00Z', confirm: preview.confirmationRequired
    });
    assert.equal(applied.status, 'deleted');
    await assert.rejects(fsp.access(path.join(reviews, firstName)), { code: 'ENOENT' });
    assert.equal((await fsp.readFile(indexPath, 'utf8')).includes(firstId), false);

    const secondUuid = '70000000-0000-4000-8000-000000000007';
    const secondId = `review-${secondUuid}`;
    const secondName = `2026-06-02-120000--${secondUuid}--interim-review.md`;
    await fsp.writeFile(path.join(reviews, secondName), `---\nrecord_kind: ai_authored_interim_review\nreview_id: ${secondId}\ncreated_at: 2026-06-02T12:00:00Z\ntimezone: Europe/Istanbul\ncovered_session_ids: []\nconsent_event_id: consent-80000000-0000-4000-8000-000000000008\ncompletion: complete\n---\n\n# Interim Review\n`, { mode: 0o600 });
    await fsp.writeFile(path.join(reviews, '2026-Q2--90000000-0000-4000-8000-000000000009--review-summary.md'), `# Summary\n\n- Source review: ${secondId}\n`, { mode: 0o600 });
    const blocked = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'reviews_and_summaries', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.dueCount, 0);
    assert.equal(blocked.blockedCount, 2);
    await fsp.access(path.join(reviews, secondName));
  } finally {
    await box.cleanup();
  }
});

test('retention uses native context deletion with exact confirmation', async () => {
  const box = await sandbox('retention-context-native');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await consent({ target: box.workspace, category: 'context_graph', value: 'on', retention: 'until_deleted' });
    const entityId = 'person-a0000000-0000-4000-8000-00000000000a';
    const candidatePath = path.join(box.base, 'context-candidate.json');
    await fsp.writeFile(candidatePath, canonicalCandidateJson({
      schemaVersion: 1, type: 'person', id: entityId, label: 'Synthetic context', aliases: [], summary: '',
      eventTime: null, participantIds: [], placeIds: [], relatedEntityIds: [], memoryIds: [], sourceRefs: [], sessionRefs: []
    }));
    await contextGraph({ target: box.workspace, action: 'add', 'candidate-file': candidatePath, now: '2026-06-01T00:00:00.000Z' });
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'context_graph',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });
    const preview = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'context_graph', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.dueCount, 1);
    const applied = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'context_graph',
      now: '2026-07-15T00:00:00Z', confirm: preview.confirmationRequired
    });
    assert.equal(applied.status, 'deleted');
    assert.equal(applied.receiptWritten, true);
    await assert.rejects(fsp.access(path.join(box.workspace, entityRelative(entityId))), { code: 'ENOENT' });
    assert.equal((await fsp.readFile(path.join(box.workspace, 'context', 'index.md'), 'utf8')).includes(entityId), false);
    const deletionLedger = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DELETION-LEDGER.md'), 'utf8');
    const contextReceipts = deletionLedger.split(/\r?\n/).filter((line) => line.includes('| context_graph |'));
    assert.equal(contextReceipts.length, 1);
    assert.match(contextReceipts[0], new RegExp(entityId));
    assert.match(contextReceipts[0], /\| retention:context_graph \|/);
  } finally {
    await box.cleanup();
  }
});

test('source retention blocks partial revision scope and deletes an all-due source through its native lifecycle', async () => {
  const box = await sandbox('retention-source-native');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await consent({ target: box.workspace, category: 'imported_sources', value: 'on', retention: 'until_deleted' });
    const sourcePath = path.join(box.base, 'source.txt');
    await fsp.writeFile(sourcePath, 'old source revision');
    const first = await source({ target: box.workspace, action: 'add', path: sourcePath, now: '2026-06-01T00:00:00Z' });
    await fsp.writeFile(sourcePath, 'new source revision');
    await source({
      target: box.workspace, action: 'add', path: sourcePath, 'source-id': first.sourceId,
      revision: 2, now: '2026-07-14T00:00:00Z'
    });
    await consent({ target: box.workspace, category: 'context_graph', value: 'on', retention: 'until_deleted' });
    const canonicalState = JSON.parse(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'));
    const contextId = 'person-b0000000-0000-4000-8000-00000000000b';
    const contextRelative = entityRelative(contextId);
    const contextBefore = canonicalEntityJson({
      schemaVersion: 1,
      type: 'person',
      id: contextId,
      status: 'Provisional',
      label: 'Retention source fixture',
      aliases: [],
      summary: '',
      eventTime: null,
      participantIds: [],
      placeIds: [],
      relatedEntityIds: [],
      memoryIds: [],
      consentEventId: canonicalState.consent.decisions.context_graph.eventId,
      provenance: {
        origin: 'imported',
        firstObservedAt: null,
        importedAt: '2026-07-14T00:00:00.000Z',
        lastLiveConfirmedAt: null,
        lastRelevantAt: null
      },
      sourceRefs: [
        { sourceId: first.sourceId, revision: 1 },
        { sourceId: first.sourceId, revision: 2 }
      ],
      sessionRefs: [],
      revision: 1,
      revisionHistory: [{ revision: 1, at: '2026-07-14T00:00:00.000Z', action: 'backfill', sessionId: null }]
    });
    await fsp.mkdir(path.dirname(path.join(box.workspace, contextRelative)), { recursive: true });
    await fsp.writeFile(path.join(box.workspace, contextRelative), contextBefore);
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'imported_sources',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });
    const partial = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'imported_sources', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(partial.status, 'blocked');
    assert.equal(partial.dueCount, 0);
    assert.equal(partial.blockedCount, 1);
    assert.equal(partial.retainedCount, 1);
    assert.equal(await fsp.readFile(path.join(box.workspace, contextRelative), 'utf8'), contextBefore);

    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'imported_sources',
      policy: 'expire_at', 'expires-at': '2026-07-16T00:00:00Z', now: '2026-07-15T00:00:00Z'
    });
    const preview = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'imported_sources', now: '2026-07-17T00:00:00Z'
    });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.dueCount, 2);
    const applied = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'imported_sources',
      now: '2026-07-17T00:00:00Z', confirm: preview.confirmationRequired
    });
    assert.equal(applied.status, 'deleted');
    const state = JSON.parse(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'));
    assert.deepEqual(state.sourceLifecycle.records, []);
    const contextAfter = JSON.parse(await fsp.readFile(path.join(box.workspace, contextRelative), 'utf8'));
    assert.deepEqual(contextAfter.sourceRefs, []);
    assert.equal(contextAfter.revision, 2);
  } finally {
    await box.cleanup();
  }
});

test('external-care retention uses the same source-wide native lifecycle', async () => {
  const box = await sandbox('retention-external-care-native');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await consent({ target: box.workspace, category: 'imported_sources', value: 'on', retention: 'until_deleted' });
    await consent({ target: box.workspace, category: 'external_care_records', value: 'on', retention: 'until_deleted' });
    const sourcePath = path.join(box.base, 'care-note.txt');
    await fsp.writeFile(sourcePath, 'synthetic external-care record');
    await source({
      target: box.workspace,
      action: 'add',
      path: sourcePath,
      kind: 'external_care_note',
      now: '2026-06-01T00:00:00Z',
      provenance: {
        title: 'Synthetic note', claimedAuthor: 'Example', claimedAuthorRole: 'therapist',
        claimedProviderOrOrg: 'Example Practice', sourceDate: '2026-05-31',
        userVerifiedAttribution: false, integrationAuthorRole: 'ai_companion'
      }
    });
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'external_care_records',
      policy: 'expire_at', 'expires-at': '2026-07-16T00:00:00Z', now: '2026-07-15T00:00:00Z'
    });
    const preview = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'external_care_records', now: '2026-07-17T00:00:00Z'
    });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.dueCount, 1);
    const applied = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'external_care_records',
      now: '2026-07-17T00:00:00Z', confirm: preview.confirmationRequired
    });
    assert.equal(applied.status, 'deleted');
    const state = JSON.parse(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'));
    assert.deepEqual(state.sourceLifecycle.records, []);
  } finally {
    await box.cleanup();
  }
});

test('behavior customization retention reports an exact native-retirement blocker', async () => {
  const box = await sandbox('retention-behavior-blocker');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await memory({
      target: box.workspace, action: 'retention-set', 'data-class': 'behavior_customization',
      policy: 'rolling_days', days: '30', now: '2026-07-15T00:00:00Z'
    });
    const history = path.join(box.workspace, '.therapy', 'change-control', 'history', 'synthetic.json');
    await fsp.writeFile(history, `${JSON.stringify({ createdAt: '2026-06-01T00:00:00Z' }, null, 2)}\n`, { mode: 0o600 });
    const status = await memory({
      target: box.workspace, action: 'retention-status', 'data-class': 'behavior_customization', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(status.classes[0].enforcementSupport, 'blocked_requires_native_retirement');
    assert.equal(status.classes[0].objectCount, 1);
    assert.equal(status.classes[0].blockedCount, 1);
    const blocked = await memory({
      target: box.workspace, action: 'retention-apply', 'data-class': 'behavior_customization', now: '2026-07-15T00:00:00Z'
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.affectedFiles, 0);
    await fsp.access(history);
  } finally {
    await box.cleanup();
  }
});
