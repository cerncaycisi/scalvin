'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  LEDGER_HEADER,
  LEDGER_SEPARATOR,
  parseLedger,
  objectPaths,
  statusSource,
  importSource,
  integrateSource,
  planSourceRemoval,
  applySourceRemoval
} = require('../../cli/source-lifecycle');
const { hardenTree, verifyWindowsPrivateAcl } = require('../../cli/lib/fs-safe');
const {
  parseSourceFrontmatter,
  validateImportedSourceRecord,
  validateExternalCareRecord,
  lintExternalCareRecord
} = require('../../cli/lib/source-provenance');
const { MAX_SOURCE_BYTES } = require('../../cli/source-inspect');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'source-lifecycle', 'cases.json'), 'utf8'));
const NOW = '2026-07-14T14:00:00+03:00';
const LATER = '2026-07-14T14:05:00+03:00';
const IDS = {
  first: '33333333-3333-4333-8333-333333333333',
  second: '44444444-4444-4444-8444-444444444444',
  failure: '55555555-5555-4555-8555-555555555555',
  external: '66666666-6666-4666-8666-666666666666',
  fake: '77777777-7777-4777-8777-777777777777'
};
const MEMORY_ID = 'mem-88888888-8888-4888-8888-888888888888';

function state(name = 'allowed') {
  return structuredClone(FIXTURE[name]);
}

async function workspace(label) {
  await fsp.mkdir(path.join(ROOT, '.test-tmp'), { recursive: true });
  const root = await fsp.mkdtemp(path.join(ROOT, '.test-tmp', `scalvin-source-lifecycle-${label}-`));
  await fsp.mkdir(path.join(root, '.therapy', 'state'), { recursive: true });
  const ledger = await fsp.readFile(path.join(ROOT, 'templates', 'state', 'SOURCE-LEDGER.template.md'));
  await fsp.writeFile(path.join(root, '.therapy', 'state', 'SOURCE-LEDGER.md'), ledger);
  return { root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

function oneId(id) {
  return () => id;
}

async function exists(filename) {
  return fsp.lstat(filename).then(() => true, () => false);
}

async function ledgerRecords(root) {
  return parseLedger(await fsp.readFile(path.join(root, '.therapy', 'state', 'SOURCE-LEDGER.md'), 'utf8'));
}

async function allRelativePaths(root) {
  const output = [];
  async function visit(directory, prefix = '') {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      output.push(relative);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
    }
  }
  await visit(root);
  return output.sort();
}

function safeSerialized(value) {
  return JSON.stringify(value);
}

test('consent-off, retention-off, usage-ledger-off, and both pause modes inspect and write nothing', async () => {
  for (const name of ['consentOff', 'writePause', 'sealedPause']) {
    const box = await workspace(`gate-${name}`);
    try {
      const ledgerBefore = await fsp.readFile(path.join(box.root, '.therapy', 'state', 'SOURCE-LEDGER.md'), 'utf8');
      let idCalls = 0;
      const result = await importSource({
        workspace: box.root,
        canonicalState: state(name),
        sourcePath: path.join(box.root, 'does-not-exist.txt'),
        idFactory: () => { idCalls += 1; return IDS.first; }
      });
      assert.equal(result.status, 'pending_consent');
      assert.equal(result.canonicalPatch, null);
      assert.deepEqual(result.written, []);
      assert.equal(idCalls, 0);
      assert.equal(await exists(path.join(box.root, 'sources')), false);
      assert.equal(await fsp.readFile(path.join(box.root, '.therapy', 'state', 'SOURCE-LEDGER.md'), 'utf8'), ledgerBefore);
    } finally {
      await box.cleanup();
    }
  }

  for (const mutation of [
    (value) => { value.consent.usageLedgers = 'off'; },
    (value) => { value.consent.retention.imported_sources = 'do_not_store'; }
  ]) {
    const box = await workspace('gate-derived');
    try {
      const canonicalState = state();
      mutation(canonicalState);
      const result = await importSource({ workspace: box.root, canonicalState, sourcePath: 'missing.txt' });
      assert.equal(result.status, 'pending_consent');
      assert.deepEqual(await ledgerRecords(box.root), []);
    } finally {
      await box.cleanup();
    }
  }
});

test('per-import proof is category-bound and carries a bounded retention decision', async () => {
  const box = await workspace('per-import');
  try {
    const canonicalState = state();
    canonicalState.consent.importedSources = 'ask_each_import';
    canonicalState.consent.retention.imported_sources = 'do_not_store';
    const source = path.join(box.root, 'approved.txt');
    await fsp.writeFile(source, 'approved bytes');
    const denied = await importSource({ workspace: box.root, canonicalState, sourcePath: source, importConsent: { approved: true, category: 'wrong', eventId: 'consent-11111111-1111-4111-8111-111111111111', retention: 'until_deleted' } });
    assert.equal(denied.status, 'pending_consent');
    await assert.rejects(importSource({
      workspace: box.root, canonicalState, sourcePath: source, now: NOW, idFactory: oneId(IDS.first),
      importConsent: { approved: true, category: 'imported_sources', eventId: 'consent-11111111-1111-4111-8111-111111111111', retention: 'rolling_days: 30' }
    }), { code: 'UNSUPPORTED_RETENTION_POLICY' });
    const approved = await importSource({
      workspace: box.root, canonicalState, sourcePath: source, now: NOW, idFactory: oneId(IDS.first),
      importConsent: { approved: true, category: 'imported_sources', eventId: 'consent-11111111-1111-4111-8111-111111111111', retention: 'until_deleted' }
    });
    assert.equal(approved.status, 'ready');
    assert.equal((await ledgerRecords(box.root))[0].retention, 'until_deleted');
  } finally {
    await box.cleanup();
  }
});

test('multilingual adversarial bytes stay exact, private, inert, and absent from results and ledgers', async () => {
  for (const [index, entry] of FIXTURE.adversarial.entries()) {
    const box = await workspace(`inert-${index}`);
    try {
      await hardenTree(box.root);
      const source = path.join(box.root, `payload-${index}.txt`);
      const marker = path.join(box.root, 'SOURCE_EXECUTED');
      const payload = `${entry.text}\nmarker=${marker}\nfetch('https://invalid.example')`;
      await fsp.writeFile(source, payload, 'utf8');
      let fetchCalls = 0;
      const originalFetch = global.fetch;
      global.fetch = async () => { fetchCalls += 1; throw new Error('must remain inert'); };
      let result;
      try {
        result = await importSource({
          workspace: box.root, canonicalState: state(), sourcePath: source, locale: entry.locale,
          now: NOW, idFactory: oneId(index === 0 ? IDS.first : IDS.second)
        });
      } finally {
        global.fetch = originalFetch;
      }
      assert.equal(result.status, 'ready');
      assert.equal(result.instructionsExecutable, false);
      assert.equal(result.trust, 'untrusted_data');
      assert.equal(fetchCalls, 0);
      assert.equal(await exists(marker), false);
      const paths = result.canonicalPatch.sourceLifecycle.record;
      assert.equal(await fsp.readFile(path.join(box.root, paths.contentObject), 'utf8'), payload);
      if (process.platform === 'win32') {
        assert.deepEqual(await verifyWindowsPrivateAcl(box.root), { ok: true });
      } else {
        assert.equal((await fsp.stat(path.join(box.root, paths.contentObject))).mode & 0o777, 0o600);
        assert.equal((await fsp.stat(path.join(box.root, paths.recordObject))).mode & 0o777, 0o600);
      }
      const record = await fsp.readFile(path.join(box.root, paths.recordObject), 'utf8');
      const ledger = await fsp.readFile(path.join(box.root, '.therapy', 'state', 'SOURCE-LEDGER.md'), 'utf8');
      validateImportedSourceRecord(record);
      for (const output of [safeSerialized(result), record, ledger]) {
        assert.equal(output.includes(payload), false);
        assert.equal(output.includes(source), false);
        assert.equal(output.includes(box.root), false);
      }
      assert.equal(result.locale, entry.locale);
      assert.equal(result.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    } finally {
      await box.cleanup();
    }
  }
});

test('source artifact creation has a marker-backed fallback when hard links are unavailable', async () => {
  const box = await workspace('exclusive-fallback');
  try {
    await hardenTree(box.root);
    const source = path.join(box.root, 'fallback-source.txt');
    await fsp.writeFile(source, 'portable source bytes', { mode: 0o600 });
    process.env.SCALVIN_TEST_FORCE_NO_HARDLINK = '1';
    const result = await importSource({
      workspace: box.root,
      canonicalState: state(),
      sourcePath: source,
      now: NOW,
      idFactory: oneId(IDS.first)
    });
    assert.equal(result.status, 'ready');
    const paths = result.canonicalPatch.sourceLifecycle.record;
    await fsp.access(path.join(box.root, paths.contentObject));
    await fsp.access(path.join(box.root, paths.recordObject));
    assert.equal((await allRelativePaths(box.root)).some((relative) => relative.endsWith('.incomplete')), false);
    if (process.platform === 'win32') {
      assert.deepEqual(await verifyWindowsPrivateAcl(box.root), { ok: true });
    }
  } finally {
    delete process.env.SCALVIN_TEST_FORCE_NO_HARDLINK;
    await box.cleanup();
  }
});

test('traversal, directories, archives, symlinks, special files, oversize files, and races fail without managed writes', async (t) => {
  const box = await workspace('unsupported');
  try {
    await assert.rejects(importSource({
      workspace: box.root, canonicalState: state(), sourcePath: '../outside.txt', cwd: box.root,
      now: NOW, idFactory: oneId(IDS.first)
    }), { code: 'SOURCE_PATH_TRAVERSAL' });

    const cases = [];
    cases.push({ path: box.root, code: 'SOURCE_NOT_REGULAR_FILE' });
    const archive = path.join(box.root, 'payload.zip');
    await fsp.writeFile(archive, 'not even a real archive');
    cases.push({ path: archive, code: 'SOURCE_ARCHIVE_UNSUPPORTED' });
    const oversized = path.join(box.root, 'oversized.bin');
    const handle = await fsp.open(oversized, 'w');
    try { await handle.truncate(MAX_SOURCE_BYTES + 1); } finally { await handle.close(); }
    cases.push({ path: oversized, code: 'SOURCE_TOO_LARGE' });

    const regular = path.join(box.root, 'regular.txt');
    const linked = path.join(box.root, 'linked.txt');
    await fsp.writeFile(regular, 'regular');
    try {
      await fsp.symlink(regular, linked);
      cases.push({ path: linked, code: 'SOURCE_SYMLINK_REJECTED' });
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) t.diagnostic(`symlink creation unavailable: ${error.code}`);
      else throw error;
    }
    if (process.platform !== 'win32') {
      const fifo = path.join(box.root, 'source.fifo');
      execFileSync('mkfifo', [fifo]);
      cases.push({ path: fifo, code: 'SOURCE_NOT_REGULAR_FILE' });
    }

    for (const item of cases) {
      const result = await importSource({
        workspace: box.root, canonicalState: state(), sourcePath: item.path,
        now: NOW, idFactory: oneId(IDS.first)
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, item.code);
      assert.equal(safeSerialized(result).includes(item.path), false);
      assert.deepEqual(result.written, []);
    }

    const raced = path.join(box.root, 'raced.txt');
    await fsp.writeFile(raced, 'before');
    process.env.SCALVIN_TEST_SOURCE_HOOKS = '1';
    const raceResult = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: raced, now: NOW,
      idFactory: oneId(IDS.first), afterInspect: () => fsp.writeFile(raced, 'after')
    });
    delete process.env.SCALVIN_TEST_SOURCE_HOOKS;
    assert.equal(raceResult.status, 'failed');
    assert.match(raceResult.error.code, /^SOURCE_CHANGED_/);
    assert.deepEqual(await ledgerRecords(box.root), []);
    assert.equal(await exists(path.join(box.root, 'sources')), false);
  } finally {
    delete process.env.SCALVIN_TEST_SOURCE_HOOKS;
    await box.cleanup();
  }
});

test('source IDs, revisions, hashes, supersession, conflicts, and exact tuple retries are deterministic', async () => {
  const box = await workspace('revision');
  try {
    const source = path.join(box.root, 'source.txt');
    await fsp.writeFile(source, 'version one');
    const first = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      now: NOW, idFactory: oneId(IDS.first)
    });
    assert.equal(first.sourceId, `src-${IDS.first}`);
    assert.equal(first.revision, 1);

    const exactRetry = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      sourceId: first.sourceId.toUpperCase(), revision: 1, now: LATER
    });
    assert.equal(exactRetry.status, 'already_ready');
    assert.deepEqual(exactRetry.written, []);
    assert.equal((await ledgerRecords(box.root)).length, 1);

    await fsp.writeFile(source, 'version two');
    const unrelated = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      now: LATER, idFactory: oneId(IDS.second)
    });
    assert.equal(unrelated.sourceId, `src-${IDS.second}`);
    assert.equal(unrelated.revision, 1);

    const revision = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      sourceId: first.sourceId, revision: 2, now: LATER
    });
    assert.equal(revision.sourceId, first.sourceId);
    assert.equal(revision.revision, 2);
    const records = await ledgerRecords(box.root);
    assert.equal(records.find((item) => item.sourceId === first.sourceId && item.revision === 1).status, 'superseded');
    assert.equal(records.find((item) => item.sourceId === first.sourceId && item.revision === 2).status, 'ready');
    const listed = await statusSource({ workspace: box.root });
    assert.equal(listed.status, 'listed');
    assert.equal(listed.recordCount, 3);
    assert.equal(listed.contentIncluded, false);
    assert.equal(safeSerialized(listed).includes(source), false);
    assert.equal(safeSerialized(listed).includes(box.root), false);
    const found = await statusSource({ workspace: box.root, sourceId: first.sourceId.toUpperCase(), revision: 2 });
    assert.equal(found.status, 'found');
    assert.equal(found.records[0].revision, 2);
    assert.deepEqual(found.written, []);
    const priorPaths = objectPaths(first.sourceId, 1, first.sha256);
    assert.match(await fsp.readFile(path.join(box.root, priorPaths.recordObject), 'utf8'), /status: superseded/);

    await fsp.writeFile(source, 'version three');
    const ledgerBeforeConflict = await fsp.readFile(path.join(box.root, '.therapy', 'state', 'SOURCE-LEDGER.md'), 'utf8');
    await assert.rejects(importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      sourceId: first.sourceId, revision: 9, now: LATER
    }), { code: 'INVALID_SOURCE_REVISION' });
    assert.equal(await fsp.readFile(path.join(box.root, '.therapy', 'state', 'SOURCE-LEDGER.md'), 'utf8'), ledgerBeforeConflict);
  } finally {
    await box.cleanup();
  }
});

test('import transaction rollback records a content-free failure and retry reuses the exact revision', async () => {
  const box = await workspace('rollback');
  try {
    const source = path.join(box.root, 'source.txt');
    await fsp.writeFile(source, 'transactional bytes');
    process.env.SCALVIN_TEST_SOURCE_FAILPOINT = 'import-after-create';
    const failed = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      now: NOW, idFactory: oneId(IDS.failure)
    });
    delete process.env.SCALVIN_TEST_SOURCE_FAILPOINT;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'TEST_FAILPOINT');
    const failedPaths = objectPaths(failed.sourceId, failed.revision, failed.sha256);
    assert.equal(await exists(path.join(box.root, failedPaths.contentObject)), false);
    assert.equal(await exists(path.join(box.root, failedPaths.recordObject)), false);
    assert.equal((await ledgerRecords(box.root))[0].status, 'failed');
    assert.equal((await allRelativePaths(box.root)).some((item) => item.endsWith('.incomplete') || item.endsWith('.tmp')), false);

    const retry = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      sourceId: failed.sourceId, revision: failed.revision, now: NOW
    });
    assert.equal(retry.status, 'ready');
    assert.equal(retry.sourceId, failed.sourceId);
    assert.equal(retry.revision, failed.revision);
    assert.equal(retry.sha256, failed.sha256);
    assert.equal((await ledgerRecords(box.root))[0].status, 'ready');
    assert.equal(await fsp.readFile(path.join(box.root, failedPaths.contentObject), 'utf8'), 'transactional bytes');
  } finally {
    delete process.env.SCALVIN_TEST_SOURCE_FAILPOINT;
    await box.cleanup();
  }
});

test('a failed changed revision preserves the prior current revision until retry succeeds', async () => {
  const box = await workspace('revision-retry');
  try {
    const source = path.join(box.root, 'source.txt');
    await fsp.writeFile(source, 'revision one');
    const first = await importSource({ workspace: box.root, canonicalState: state(), sourcePath: source, now: NOW, idFactory: oneId(IDS.first) });
    await fsp.writeFile(source, 'revision two');
    process.env.SCALVIN_TEST_SOURCE_FAILPOINT = 'import-after-create';
    const failed = await importSource({ workspace: box.root, canonicalState: state(), sourcePath: source, sourceId: first.sourceId, revision: 2, now: LATER });
    delete process.env.SCALVIN_TEST_SOURCE_FAILPOINT;
    assert.equal(failed.status, 'failed');
    let records = await ledgerRecords(box.root);
    assert.equal(records.find((item) => item.revision === 1).status, 'ready');
    assert.equal(records.find((item) => item.revision === 2).status, 'failed');

    const retry = await importSource({ workspace: box.root, canonicalState: state(), sourcePath: source, sourceId: first.sourceId, revision: 2, now: LATER });
    assert.equal(retry.status, 'ready');
    records = await ledgerRecords(box.root);
    assert.equal(records.find((item) => item.revision === 1).status, 'superseded');
    assert.equal(records.find((item) => item.revision === 2).status, 'ready');
  } finally {
    delete process.env.SCALVIN_TEST_SOURCE_FAILPOINT;
    await box.cleanup();
  }
});

test('integration requires exact approval, proposes memory changes, and never writes active memory itself', async () => {
  const box = await workspace('integration');
  try {
    const source = path.join(box.root, 'source.txt');
    await fsp.writeFile(source, 'integration source');
    await fsp.writeFile(path.join(box.root, 'profile.md'), '# Profile\n\nExisting memory stays untouched.\n');
    const imported = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      now: NOW, idFactory: oneId(IDS.first)
    });
    const sourcePaths = imported.canonicalPatch.sourceLifecycle.record;
    const recordBefore = await fsp.readFile(path.join(box.root, sourcePaths.recordObject), 'utf8');
    const approval = await integrateSource({
      workspace: box.root, canonicalState: state(), sourceId: imported.sourceId,
      revision: 1, approved: false
    });
    assert.equal(approval.status, 'approval_required');
    assert.deepEqual(approval.written, []);
    assert.equal(await fsp.readFile(path.join(box.root, sourcePaths.recordObject), 'utf8'), recordBefore);

    await assert.rejects(integrateSource({
      workspace: box.root, canonicalState: state(), sourceId: imported.sourceId,
      revision: 1, approved: true, proposedMemoryIds: [MEMORY_ID]
    }), { code: 'SOURCE_HASH_MISMATCH' });

    const integrated = await integrateSource({
      workspace: box.root, canonicalState: state(), sourceId: imported.sourceId,
      revision: 1, approved: true, expectedHash: imported.sha256,
      proposedMemoryIds: [MEMORY_ID], now: LATER
    });
    assert.equal(integrated.status, 'integrated');
    assert.equal(integrated.memoryWritten, false);
    assert.equal(integrated.proposedMemoryPatch.writesApplied, false);
    assert.deepEqual(integrated.proposedMemoryIds, [MEMORY_ID]);
    assert.equal(await fsp.readFile(path.join(box.root, 'profile.md'), 'utf8'), '# Profile\n\nExisting memory stays untouched.\n');
    const record = await fsp.readFile(path.join(box.root, sourcePaths.recordObject), 'utf8');
    validateImportedSourceRecord(record);
    assert.match(record, new RegExp(`last_integrated_hash: ${imported.sha256}`));
    assert.match(record, new RegExp(`derived_memory_ids: \\[${JSON.stringify(MEMORY_ID)}\\]`));
    const ledger = await ledgerRecords(box.root);
    assert.equal(ledger[0].status, 'integrated');
    assert.deepEqual(ledger[0].derivedMemoryIds, [MEMORY_ID]);

    const retry = await integrateSource({
      workspace: box.root, canonicalState: state(), sourceId: imported.sourceId,
      revision: 1, approved: true, expectedHash: imported.sha256,
      proposedMemoryIds: [MEMORY_ID], now: LATER
    });
    assert.equal(retry.status, 'already_integrated');
    assert.deepEqual(retry.written, []);
    for (const output of [safeSerialized(integrated), safeSerialized(retry)]) {
      assert.equal(output.includes('integration source'), false);
      assert.equal(output.includes(source), false);
      assert.equal(output.includes(box.root), false);
    }
  } finally {
    await box.cleanup();
  }
});

test('idempotency and integration fail closed when managed content bytes are missing or tampered', async () => {
  const box = await workspace('integrity');
  try {
    const source = path.join(box.root, 'source.txt');
    await fsp.writeFile(source, 'immutable managed bytes');
    const imported = await importSource({ workspace: box.root, canonicalState: state(), sourcePath: source, now: NOW, idFactory: oneId(IDS.first) });
    const object = path.join(box.root, imported.canonicalPatch.sourceLifecycle.record.contentObject);
    await fsp.writeFile(object, 'tampered managed bytes');
    await assert.rejects(integrateSource({
      workspace: box.root, canonicalState: state(), sourceId: imported.sourceId,
      revision: 1, approved: true, expectedHash: imported.sha256, now: LATER
    }), { code: 'SOURCE_CONTENT_OBJECT_INTEGRITY_FAILED' });
    await assert.rejects(importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      sourceId: imported.sourceId, revision: 1, now: LATER
    }), { code: 'SOURCE_CONTENT_OBJECT_INTEGRITY_FAILED' });
    assert.equal((await ledgerRecords(box.root))[0].status, 'ready');
  } finally {
    await box.cleanup();
  }
});

test('external-care provenance records claims while rejecting fake human integration authorship', async () => {
  const box = await workspace('external-care');
  try {
    const source = path.join(box.root, 'care.txt');
    await fsp.writeFile(source, 'A claimed external-care note.');
    const imported = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      kind: 'external_care_note', locale: 'tr-tr', now: NOW, idFactory: oneId(IDS.external),
      provenance: {
        title: 'Session summary', claimedAuthor: 'Dr. Example', claimedAuthorRole: 'therapist',
        claimedProviderOrOrg: 'Example Practice', sourceDate: '2026-07-10',
        userVerifiedAttribution: false, integrationAuthorRole: 'ai_companion'
      }
    });
    assert.equal(imported.status, 'ready');
    assert.equal(imported.locale, 'tr-TR');
    const importedPath = imported.canonicalPatch.sourceLifecycle.record.recordObject;
    const markdown = await fsp.readFile(path.join(box.root, importedPath), 'utf8');
    const validated = validateExternalCareRecord(markdown);
    assert.equal(validated.fields.claimed_author_role, 'therapist');
    assert.equal(validated.fields.integration_author_role, 'ai_companion');
    assert.ok(validated.findings.some((item) => item.code === 'EXTERNAL_CARE_ATTRIBUTION_UNVERIFIED'));

    const fakeSource = path.join(box.root, 'fake-care.txt');
    await fsp.writeFile(fakeSource, 'Do not attribute AI text to a therapist.');
    const fake = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: fakeSource,
      kind: 'external_care_note', now: NOW, idFactory: oneId(IDS.fake),
      provenance: { claimedAuthorRole: 'therapist', integrationAuthorRole: 'therapist' }
    });
    assert.equal(fake.status, 'failed');
    assert.equal(fake.error.code, 'EXTERNAL_CARE_INTEGRATION_AUTHOR_INVALID');
    const fakePaths = objectPaths(fake.sourceId, fake.revision, fake.sha256);
    assert.equal(await exists(path.join(box.root, fakePaths.contentObject)), false);
    assert.equal(await exists(path.join(box.root, fakePaths.recordObject)), false);
    assert.equal((await ledgerRecords(box.root)).find((item) => item.sourceId === fake.sourceId).status, 'failed');

    const duplicate = markdown.replace('source_id:', 'source_id: src-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nsource_id:');
    assert.throws(() => parseSourceFrontmatter(duplicate), { code: 'SOURCE_FRONTMATTER_DUPLICATE' });
    const unknown = markdown.replace('revision: 1', 'revision: 1\nsecret_authority: granted');
    assert.throws(() => parseSourceFrontmatter(unknown), { code: 'SOURCE_FRONTMATTER_UNKNOWN_FIELD' });
    const malformed = markdown.replace('revision: 1', 'revision = 1');
    assert.throws(() => parseSourceFrontmatter(malformed), { code: 'SOURCE_FRONTMATTER_MALFORMED' });
    const forged = markdown.replace('integration_author_role: ai_companion', 'integration_author_role: therapist');
    assert.ok(lintExternalCareRecord(forged).some((item) => item.code === 'EXTERNAL_CARE_INTEGRATION_AUTHOR_INVALID'));
  } finally {
    await box.cleanup();
  }
});

test('confirmed source deletion atomically removes bytes, provenance, references, derived memory, and reports backups', async () => {
  const box = await workspace('delete');
  try {
    const source = path.join(box.root, 'source.txt');
    const payload = 'deletion-sensitive source bytes';
    await fsp.writeFile(source, payload);
    const imported = await importSource({
      workspace: box.root, canonicalState: state(), sourcePath: source,
      now: NOW, idFactory: oneId(IDS.first)
    });
    await integrateSource({
      workspace: box.root, canonicalState: state(), sourceId: imported.sourceId,
      revision: 1, approved: true, expectedHash: imported.sha256,
      proposedMemoryIds: [MEMORY_ID], now: LATER
    });
    const profileBefore = `# Profile\n\n## ${MEMORY_ID} — Imported belief\n\n- Statement: Derived from source\n- Status: provisional\n- Source IDs: ${imported.sourceId}\n\n## Other\n\nKeep this.\n`;
    await fsp.writeFile(path.join(box.root, 'profile.md'), profileBefore);
    await fsp.writeFile(path.join(box.root, 'NEXT-PRIMER.md'), `# Primer\n\nReopen ${imported.sourceId} if needed.\n`);
    await fsp.writeFile(path.join(box.root, '.therapy', 'state', 'BACKUP-LEDGER.md'), '| backup-99999999-9999-4999-8999-999999999999 | 2026-07-14T10:00:00Z | all | local_user_selected | aes-256-gcm | a | passed | passed | complete | null |\n');
    const paths = imported.canonicalPatch.sourceLifecycle.record;

    const plan = await planSourceRemoval({
      workspace: box.root, canonicalState: state(), sourceId: imported.sourceId, action: 'delete'
    });
    assert.equal(plan.status, 'confirmation_required');
    assert.equal(plan.knownBackupRecords, 1);
    assert.equal(plan.backupActionRequired, true);
    assert.ok(plan.affectedPaths.includes(paths.contentObject));
    assert.ok(plan.affectedPaths.includes(paths.recordObject));
    assert.ok(plan.affectedPaths.includes('profile.md'));
    assert.equal(safeSerialized(plan).includes(payload), false);
    assert.equal(safeSerialized(plan).includes(box.root), false);
    await assert.rejects(applySourceRemoval({ workspace: box.root, plan, confirm: true, confirmationToken: 'wrong' }), { code: 'SOURCE_CONFIRMATION_REQUIRED' });

    process.env.SCALVIN_TEST_SOURCE_FAILPOINT = 'remove-after-delete';
    const failed = await applySourceRemoval({
      workspace: box.root, plan, confirm: true, confirmationToken: plan.confirmationToken
    });
    delete process.env.SCALVIN_TEST_SOURCE_FAILPOINT;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'TEST_FAILPOINT');
    assert.equal(await fsp.readFile(path.join(box.root, paths.contentObject), 'utf8'), payload);
    assert.equal(await fsp.readFile(path.join(box.root, 'profile.md'), 'utf8'), profileBefore);
    assert.equal((await ledgerRecords(box.root))[0].status, 'integrated');

    const removed = await applySourceRemoval({
      workspace: box.root, plan, confirm: true, confirmationToken: plan.confirmationToken
    });
    assert.equal(removed.status, 'deleted');
    assert.equal(await exists(path.join(box.root, paths.contentObject)), false);
    assert.equal(await exists(path.join(box.root, paths.recordObject)), false);
    assert.equal((await fsp.readFile(path.join(box.root, 'profile.md'), 'utf8')).includes(MEMORY_ID), false);
    assert.equal((await fsp.readFile(path.join(box.root, 'profile.md'), 'utf8')).includes('Keep this.'), true);
    assert.equal((await fsp.readFile(path.join(box.root, 'NEXT-PRIMER.md'), 'utf8')).includes(imported.sourceId), false);
    assert.equal((await ledgerRecords(box.root))[0].status, 'deleted');
    assert.equal(removed.knownBackupRecords, 1);
    assert.equal(removed.backupActionRequired, true);
    assert.equal((await allRelativePaths(box.root)).some((item) => item.endsWith('.incomplete') || item.endsWith('.tmp')), false);
  } finally {
    delete process.env.SCALVIN_TEST_SOURCE_FAILPOINT;
    await box.cleanup();
  }
});

test('a confirmed removal plan refuses to clobber files changed after preview', async () => {
  const box = await workspace('stale-plan');
  try {
    const source = path.join(box.root, 'source.txt');
    await fsp.writeFile(source, 'stale-plan bytes');
    const imported = await importSource({ workspace: box.root, canonicalState: state(), sourcePath: source, now: NOW, idFactory: oneId(IDS.first) });
    await fsp.writeFile(path.join(box.root, 'NEXT-PRIMER.md'), `Use ${imported.sourceId}.\n`);
    const plan = await planSourceRemoval({ workspace: box.root, canonicalState: state(), sourceId: imported.sourceId, action: 'delete' });
    await fsp.appendFile(path.join(box.root, 'NEXT-PRIMER.md'), 'A concurrent user edit.\n');
    const result = await applySourceRemoval({ workspace: box.root, plan, confirm: true, confirmationToken: plan.confirmationToken });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'SOURCE_PLAN_STALE');
    assert.equal(await exists(path.join(box.root, imported.canonicalPatch.sourceLifecycle.record.contentObject)), true);
    assert.match(await fsp.readFile(path.join(box.root, 'NEXT-PRIMER.md'), 'utf8'), /A concurrent user edit\./);
    assert.equal((await ledgerRecords(box.root))[0].status, 'ready');
  } finally {
    await box.cleanup();
  }
});

test('runtime and templates expose the executable lifecycle without language-specific authority', async () => {
  const [runtime, ledger, sourceRecord, externalRecord, readme, moduleSource] = await Promise.all([
    fsp.readFile(path.join(ROOT, 'runtime', 'SOURCE-TRIGGERS.md'), 'utf8'),
    fsp.readFile(path.join(ROOT, 'templates', 'state', 'SOURCE-LEDGER.template.md'), 'utf8'),
    fsp.readFile(path.join(ROOT, 'templates', 'sources', 'SOURCE-RECORD.template.md'), 'utf8'),
    fsp.readFile(path.join(ROOT, 'templates', 'sources', 'EXTERNAL-CARE-NOTE.template.md'), 'utf8'),
    fsp.readFile(path.join(ROOT, 'templates', 'sources', 'README.template.md'), 'utf8'),
    fsp.readFile(path.join(ROOT, 'cli', 'source-lifecycle.js'), 'utf8')
  ]);
  assert.match(ledger, new RegExp(LEDGER_HEADER.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
  assert.match(ledger, /failed/);
  assert.match(sourceRecord, /content_object: sources\/objects/);
  assert.match(sourceRecord, /byte_length:/);
  assert.match(externalRecord, /integration_author_role: ai_companion/);
  assert.match(externalRecord, /AI-Authored Integration Note/);
  for (const document of [runtime, readme]) {
    assert.match(document, /untrusted data/i);
    assert.match(document, /locale.*metadata/i);
    assert.match(document, /approval|confirmation/i);
    assert.match(document, /backup/i);
  }
  assert.doesNotMatch(moduleSource, /localeCompare\([^)]*,\s*['"]en['"]/);
  assert.doesNotMatch(moduleSource, /\beval\s*\(|new\s+Function\b|child_process|execFile|spawn|fetch\s*\(|https?\.request/);
});
