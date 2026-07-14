'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, consent, memory, transcript, contextGraph } = require('../../cli/operations');
const { sandbox, readJson } = require('./helpers');

const MEMORY_ID = 'mem-723e4567-e89b-42d3-a456-426614174000';
const OTHER_MEMORY_ID = 'mem-923e4567-e89b-42d3-a456-426614174002';
const SESSION_ID = 's-823e4567-e89b-42d3-a456-426614174000';

function memoryBlock(statement = 'Original user-confirmed wording.', id = MEMORY_ID) {
  return `\n### ${id} — Stable fact\n\n- Statement: ${statement}\n- Kind: reported_fact\n- Status: user_confirmed\n- Last live confirmed: 2026-07-14T10:00:00Z\n- Confidence: confirmed\n- Review state: current\n- Current revision: 1\n`;
}

test('memory view, correction and forget obey pause modes and use transactional deletion receipts', async () => {
  const box = await sandbox('memory-data-controls');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const profilePath = path.join(box.workspace, 'profile.md');
    const primerPath = path.join(box.workspace, 'NEXT-PRIMER.md');
    await fsp.appendFile(profilePath, memoryBlock());
    await fsp.appendFile(primerPath, `\n- Continue with ${MEMORY_ID}.\n`);

    let result = await memory({ target: box.workspace, action: 'view', id: MEMORY_ID });
    assert.equal(result.count, 1);
    assert.equal(result.items[0].statement, 'Original user-confirmed wording.');

    await memory({ target: box.workspace, action: 'pause' });
    result = await memory({ target: box.workspace, action: 'view', id: MEMORY_ID });
    assert.equal(result.count, 1);
    await assert.rejects(memory({ target: box.workspace, action: 'correct', id: MEMORY_ID, statement: 'Changed.' }), { code: 'MEMORY_PERSISTENCE_DISABLED' });
    await assert.rejects(memory({ target: box.workspace, action: 'export', scope: 'active', output: path.join(box.base, 'exports') }), { code: 'MEMORY_PAUSE_ACTIVE' });
    await memory({ target: box.workspace, action: 'seal' });
    await assert.rejects(memory({ target: box.workspace, action: 'view', id: MEMORY_ID }), { code: 'MEMORY_SEALED' });
    await memory({ target: box.workspace, action: 'resume' });

    result = await memory({ target: box.workspace, action: 'correct', id: MEMORY_ID, statement: 'Corrected user-confirmed wording.' });
    assert.equal(result.status, 'updated');
    assert.match(await fsp.readFile(profilePath, 'utf8'), /- Statement: Corrected user-confirmed wording\.[\s\S]*- Current revision: 2/);

    let preview = await memory({ target: box.workspace, action: 'forget', id: MEMORY_ID });
    assert.equal(preview.status, 'preview');
    assert.match(preview.confirmationRequired, /^memory-forget:\d{13}:[a-f0-9]{64}$/);
    await assert.rejects(memory({ target: box.workspace, action: 'forget', id: MEMORY_ID, confirm: 'wrong' }), { code: 'STALE_CONFIRMATION' });

    await fsp.appendFile(profilePath, memoryBlock('Unrelated newly added memory.', OTHER_MEMORY_ID));
    await assert.rejects(
      memory({ target: box.workspace, action: 'forget', id: MEMORY_ID, confirm: preview.confirmationRequired }),
      { code: 'STALE_CONFIRMATION' }
    );
    assert.match(await fsp.readFile(profilePath, 'utf8'), new RegExp(MEMORY_ID));
    assert.match(await fsp.readFile(profilePath, 'utf8'), new RegExp(OTHER_MEMORY_ID));
    preview = await memory({ target: box.workspace, action: 'forget', id: MEMORY_ID });

    const beforeFailure = await fsp.readFile(profilePath, 'utf8');
    process.env.SCALVIN_TEST_FAILPOINT = 'memory-forget-before-activate';
    await assert.rejects(memory({ target: box.workspace, action: 'forget', id: MEMORY_ID, confirm: preview.confirmationRequired }), { code: 'TEST_FAILPOINT' });
    delete process.env.SCALVIN_TEST_FAILPOINT;
    assert.equal(await fsp.readFile(profilePath, 'utf8'), beforeFailure);

    result = await memory({ target: box.workspace, action: 'forget', id: MEMORY_ID, confirm: preview.confirmationRequired });
    assert.equal(result.status, 'deleted');
    assert.equal(result.receiptWritten, true);
    assert.doesNotMatch(await fsp.readFile(profilePath, 'utf8'), new RegExp(MEMORY_ID));
    assert.match(await fsp.readFile(profilePath, 'utf8'), new RegExp(OTHER_MEMORY_ID));
    assert.doesNotMatch(await fsp.readFile(primerPath, 'utf8'), new RegExp(MEMORY_ID));
    assert.match(await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DELETION-LEDGER.md'), 'utf8'), new RegExp(MEMORY_ID));
  } finally {
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await box.cleanup();
  }
});

test('transcript all deletion rejects a token when a new transcript enters scope', async () => {
  const box = await sandbox('transcript-delete-stale-all');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const directory = path.join(box.workspace, 'archive', 'transcripts');
    const first = path.join(directory, '2026-07-14--first--transcript.md');
    const second = path.join(directory, '2026-07-14--second--transcript.md');
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(first, 'first private transcript\n');
    const preview = await transcript({ target: box.workspace, action: 'delete', scope: 'all' });
    await fsp.writeFile(second, 'second private transcript\n');
    await assert.rejects(
      transcript({ target: box.workspace, action: 'delete', scope: 'all', confirm: preview.confirmationRequired }),
      { code: 'STALE_CONFIRMATION' }
    );
    await fsp.access(first);
    await fsp.access(second);
    const fresh = await transcript({ target: box.workspace, action: 'delete', scope: 'all' });
    assert.equal(fresh.transcriptCount, 2);
    const deleted = await transcript({ target: box.workspace, action: 'delete', scope: 'all', confirm: fresh.confirmationRequired });
    assert.equal(deleted.transcriptCount, 2);
    await assert.rejects(fsp.access(first), { code: 'ENOENT' });
    await assert.rejects(fsp.access(second), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('all export includes retained pending and historical behavior-change records', async () => {
  const box = await sandbox('all-export-change-control');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await consent({ target: box.workspace, category: 'behavior_customization', value: 'on', retention: 'until_deleted' });
    const pending = path.join(box.workspace, '.therapy', 'change-control', 'pending', 'private-pending.json');
    const history = path.join(box.workspace, '.therapy', 'change-control', 'history', 'private-history.json');
    await fsp.writeFile(pending, '{"private":"pending"}\n');
    await fsp.writeFile(history, '{"private":"history"}\n');
    const exported = await memory({ target: box.workspace, action: 'export', scope: 'all', output: path.join(box.base, 'exports') });
    await fsp.access(path.join(exported.exportPath, 'payload', '.therapy', 'change-control', 'pending', 'private-pending.json'));
    await fsp.access(path.join(exported.exportPath, 'payload', '.therapy', 'change-control', 'history', 'private-history.json'));
  } finally {
    await box.cleanup();
  }
});

test('explicit inspect and all export remain available after consent revocation without enabling runtime retrieval', async () => {
  const box = await sandbox('revoked-consent-data-access');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await fsp.appendFile(path.join(box.workspace, 'profile.md'), memoryBlock('Retained before revocation.'));
    await consent({ target: box.workspace, category: 'context_graph', value: 'on', retention: 'until_deleted' });
    await consent({ target: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'until_deleted' });
    await consent({ target: box.workspace, category: 'imported_sources', value: 'on', retention: 'until_deleted' });
    await consent({ target: box.workspace, category: 'behavior_customization', value: 'on', retention: 'until_deleted' });

    const representatives = [
      ['archive/transcripts/retained.md', 'retained transcript\n'],
      ['sources/objects/retained.source', 'retained source\n'],
      ['context/events/retained.json', '{"retained":true}\n'],
      ['.therapy/change-control/pending/retained.json', '{"retained":true}\n'],
      ['.therapy/user-overrides/retained.json', '{"retained":true}\n']
    ];
    for (const [relative, content] of representatives) {
      const filename = path.join(box.workspace, relative);
      await fsp.mkdir(path.dirname(filename), { recursive: true });
      await fsp.writeFile(filename, content);
    }

    await consent({ target: box.workspace, category: 'context_graph', value: 'off', retention: 'do_not_store' });
    await consent({ target: box.workspace, category: 'raw_transcripts', value: 'off', retention: 'do_not_store' });
    await consent({ target: box.workspace, category: 'imported_sources', value: 'off', retention: 'do_not_store' });
    await consent({ target: box.workspace, category: 'behavior_customization', value: 'off', retention: 'do_not_store' });
    await consent({ target: box.workspace, category: 'continuity_memory', value: 'off', retention: 'do_not_store' });

    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.continuityMemory, 'off');
    assert.equal(state.consent.retention.profile_memory, 'do_not_store');
    const viewed = await memory({ target: box.workspace, action: 'view', id: MEMORY_ID });
    assert.equal(viewed.count, 1);
    assert.equal(viewed.items[0].statement, 'Retained before revocation.');
    await assert.rejects(contextGraph({ target: box.workspace, action: 'status' }), { code: 'CONTEXT_CONTINUITY_CONSENT_REQUIRED' });

    const exported = await memory({ target: box.workspace, action: 'export', scope: 'all', output: path.join(box.base, 'exports') });
    await fsp.access(path.join(exported.exportPath, 'payload', 'profile.md'));
    for (const [relative] of representatives) await fsp.access(path.join(exported.exportPath, 'payload', relative));

    await memory({ target: box.workspace, action: 'seal' });
    await assert.rejects(memory({ target: box.workspace, action: 'view', id: MEMORY_ID }), { code: 'MEMORY_SEALED' });
  } finally {
    await box.cleanup();
  }
});

test('transcript delete removes the artifact and derived references only after exact confirmation', async () => {
  const box = await sandbox('transcript-delete');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const transcriptPath = path.join(box.workspace, 'archive', 'transcripts', `2026-07-14--${SESSION_ID.slice(2)}--transcript.md`);
    const sessionPath = path.join(box.workspace, 'sessions', `2026-07-14--${SESSION_ID.slice(2)}--session.md`);
    await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fsp.writeFile(transcriptPath, `---\nsession_id: ${SESSION_ID}\n---\nprivate transcript\n`);
    await fsp.mkdir(path.dirname(sessionPath), { recursive: true });
    await fsp.writeFile(sessionPath, `---\nsource_transcript: archive/transcripts/${path.basename(transcriptPath)}\n---\nsummary\n`);

    const preview = await transcript({ target: box.workspace, action: 'delete', 'session-id': SESSION_ID });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.transcriptCount, 1);
    const result = await transcript({ target: box.workspace, action: 'delete', 'session-id': SESSION_ID, confirm: preview.confirmationRequired });
    assert.equal(result.status, 'deleted');
    await assert.rejects(fsp.access(transcriptPath), { code: 'ENOENT' });
    assert.match(await fsp.readFile(sessionPath, 'utf8'), /^source_transcript: none$/m);
  } finally {
    await box.cleanup();
  }
});

test('delete-all resets personal state but preserves the separate backup ledger', async () => {
  const box = await sandbox('memory-delete-all');
  try {
    await install({
      target: box.workspace,
      consent: 'granted',
      language: 'es-419',
      'companion-name': 'Private Name',
      persona: 'susan',
      structure: 'freeform',
      modality: ['act']
    });
    await fsp.appendFile(path.join(box.workspace, 'profile.md'), memoryBlock());
    await fsp.writeFile(path.join(box.workspace, 'sessions', 'private-session.md'), 'private\n');
    await fsp.writeFile(path.join(box.workspace, '.therapy', 'change-control', 'pending', 'private-pending.json'), '{"private":true}\n');
    await fsp.writeFile(path.join(box.workspace, '.therapy', 'change-control', 'history', 'private-history.json'), '{"private":true}\n');
    const backupLedgerPath = path.join(box.workspace, '.therapy', 'state', 'BACKUP-LEDGER.md');
    const backupLedgerBefore = await fsp.readFile(backupLedgerPath, 'utf8');

    await memory({ target: box.workspace, action: 'seal' });
    let preview = await memory({ target: box.workspace, action: 'delete-all' });
    assert.equal(preview.managedArtifactCount > 0, true);
    assert.equal(Object.hasOwn(preview, 'objectCount'), false);
    assert.deepEqual(preview.retainedOperationalCategories, ['usage_ledgers']);
    assert.deepEqual(preview.retainedSeparateCopies, []);
    assert.equal(preview.deletedCategories.includes('session_notes'), true);
    await fsp.writeFile(path.join(box.workspace, 'sessions', 'entered-after-preview.md'), 'new private data\n');
    await assert.rejects(
      memory({ target: box.workspace, action: 'delete-all', confirm: preview.confirmationRequired }),
      { code: 'STALE_CONFIRMATION' }
    );
    await fsp.access(path.join(box.workspace, 'sessions', 'private-session.md'));
    await fsp.access(path.join(box.workspace, 'sessions', 'entered-after-preview.md'));
    preview = await memory({ target: box.workspace, action: 'delete-all' });
    const result = await memory({ target: box.workspace, action: 'delete-all', confirm: preview.confirmationRequired });
    assert.equal(result.status, 'deleted');
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.status, 'declined');
    assert.equal(state.preferences.language, 'auto');
    assert.deepEqual(state.preferences, {
      companionName: 'Scalvin', companionSlug: 'scalvin', language: 'auto', persona: 'scalvin',
      structure: 'moderate', modalities: ['act', 'cft', 'motivational-interviewing']
    });
    assert.equal(state.sessionLifecycle.state, 'none');
    assert.equal(await fsp.readFile(backupLedgerPath, 'utf8'), backupLedgerBefore);
    await assert.rejects(fsp.access(path.join(box.workspace, 'sessions', 'private-session.md')), { code: 'ENOENT' });
    assert.equal(await fsp.readFile(path.join(box.workspace, 'profile.md'), 'utf8'), '');
    assert.match(await fsp.readFile(path.join(box.workspace, 'SETUP-NOTES.md'), 'utf8'), /^- Default language: auto$/m);
    assert.match(await fsp.readFile(path.join(box.workspace, 'scalvin.md'), 'utf8'), /Scalvin/);
    await assert.rejects(fsp.access(path.join(box.workspace, 'private-name.md')), { code: 'ENOENT' });
    assert.match(await fsp.readFile(path.join(box.workspace, '.therapy', 'persona.md'), 'utf8'), /Scalvin/i);
    assert.match(await fsp.readFile(path.join(box.workspace, '.therapy', 'session-structure.md'), 'utf8'), /moderate/i);
    await fsp.access(path.join(box.workspace, '.therapy', 'modalities', 'cft.md'));
    await fsp.access(path.join(box.workspace, '.therapy', 'modalities', 'motivational-interviewing.md'));
    assert.deepEqual(await fsp.readdir(path.join(box.workspace, '.therapy', 'change-control', 'pending')), []);
    assert.deepEqual(await fsp.readdir(path.join(box.workspace, '.therapy', 'change-control', 'history')), []);
  } finally {
    await box.cleanup();
  }
});
