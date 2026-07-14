'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, consent, doctor } = require('../../cli/operations');
const { acquireMutationLock } = require('../../cli/lib/fs-safe');
const { sandbox, readJson } = require('./helpers');

test('consent command atomically changes canonical state, projection, and ledger', async () => {
  const box = await sandbox('consent-command');
  try {
    await install({ workspace: box.workspace });
    const dry = await consent({ workspace: box.workspace, status: 'granted', 'dry-run': true });
    assert.equal(dry.status, 'dry-run');
    assert.equal((await readJson(path.join(box.workspace, '.scalvin', 'state.json'))).consent.status, 'not-decided');

    const result = await consent({ workspace: box.workspace, status: 'granted' });
    assert.equal(result.status, 'updated');
    assert.equal(result.previousValue, 'ask');
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    const controls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
    const ledger = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'CONSENT-LEDGER.md'), 'utf8');
    assert.equal(state.consent.status, 'granted');
    assert.match(controls, /\| continuity_memory \| on \| until_deleted \|/);
    assert.ok(ledger.includes(`| ${state.consent.eventId} |`));
    assert.match(ledger, /\| cli-consent \| continuity_memory \| ask \| on \|/);
    assert.equal((await doctor({ workspace: box.workspace })).errors, 0);

    const declined = await consent({ workspace: box.workspace, status: 'declined' });
    assert.equal(declined.previousValue, 'on');
    const declinedState = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(declinedState.consent.continuityMemory, 'off');
    assert.equal(declinedState.consent.transcripts, 'off');
    assert.equal(declinedState.consent.contextGraph, 'off');
    assert.equal((await doctor({ workspace: box.workspace })).errors, 0);
  } finally {
    await box.cleanup();
  }
});

test('category consent atomically controls transcript and context retention independently', async () => {
  const box = await sandbox('consent-categories');
  try {
    await install({ workspace: box.workspace });
    const transcript = await consent({
      workspace: box.workspace,
      category: 'raw_transcripts',
      value: 'on',
      retention: 'until_deleted'
    });
    assert.equal(transcript.category, 'raw_transcripts');
    assert.equal(transcript.previousValue, 'off');
    let state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.status, 'not-decided');
    assert.equal(state.consent.transcripts, 'on');
    assert.equal(state.consent.retention.raw_transcripts, 'until_deleted');
    let controls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
    assert.match(controls, /\| raw_transcripts \| on \| until_deleted \|/);

    await consent({ workspace: box.workspace, category: 'context_graph', value: 'on' });
    state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.contextGraph, 'on');
    assert.equal(state.consent.retention.context_graph, 'until_deleted');
    controls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
    assert.match(controls, /\| context_graph \| on \| until_deleted \|/);
    assert.equal((await doctor({ workspace: box.workspace })).errors, 0);
  } finally {
    await box.cleanup();
  }
});

test('invalid consent enum and retention fail before writes', async () => {
  const box = await sandbox('consent-invalid');
  try {
    await install({ workspace: box.workspace });
    const before = await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8');
    await assert.rejects(consent({ workspace: box.workspace, category: 'raw_transcripts', value: 'banana' }), { code: 'INVALID_CONSENT_VALUE' });
    await assert.rejects(consent({ workspace: box.workspace, category: 'raw_transcripts', value: 'on', retention: 'forever-ish' }), { code: 'INVALID_RETENTION' });
    for (const retention of ['session_only', 'rolling_days: 30', 'until: 2030-01-01']) {
      await assert.rejects(consent({ workspace: box.workspace, category: 'raw_transcripts', value: 'on', retention }), { code: 'UNSUPPORTED_RETENTION_POLICY' });
    }
    assert.equal(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'), before);
  } finally {
    await box.cleanup();
  }
});

test('consent failpoint keeps the prior canonical and projected state', async () => {
  const box = await sandbox('consent-rollback');
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    const beforeState = await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8');
    const beforeControls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
    process.env.SCALVIN_TEST_FAILPOINT = 'consent-before-activate';
    await assert.rejects(consent({ workspace: box.workspace, status: 'declined' }), { code: 'TEST_FAILPOINT' });
    assert.equal(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'), beforeState);
    assert.equal(await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8'), beforeControls);
  } finally {
    await box.cleanup();
  }
});

test('consent rejects a concurrent valid state write made after its state read', async () => {
  const box = await sandbox('consent-state-read-race');
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    let injected = false;
    const options = {
      target: box.workspace,
      category: 'imported_sources',
      value: 'on',
      retention: 'until_deleted'
    };
    Object.defineProperty(options, 'dry-run', {
      enumerable: true,
      get() {
        if (!injected) {
          injected = true;
          const concurrent = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          concurrent.consent.preferredUserName = 'Concurrent Name';
          concurrent.updatedAt = new Date(Date.parse(concurrent.updatedAt) + 1000).toISOString();
          fs.writeFileSync(statePath, `${JSON.stringify(concurrent, null, 2)}\n`, { mode: 0o600 });
        }
        return false;
      }
    });

    await assert.rejects(consent(options), { code: 'STALE_WORKSPACE' });
    assert.equal((await readJson(statePath)).consent.preferredUserName, 'Concurrent Name');
  } finally {
    await box.cleanup();
  }
});

test('a cooperating CLI mutation is rejected while the workspace mutation lock is held', async () => {
  const box = await sandbox('consent-mutation-lock');
  let release = null;
  try {
    await install({ workspace: box.workspace, consent: 'granted' });
    const before = await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8');
    release = await acquireMutationLock(box.workspace);
    await assert.rejects(consent({
      workspace: box.workspace,
      category: 'imported_sources',
      value: 'on',
      retention: 'until_deleted'
    }), { code: 'MUTATION_LOCKED' });
    assert.equal(await fsp.readFile(path.join(box.workspace, '.scalvin', 'state.json'), 'utf8'), before);
  } finally {
    await release?.().catch(() => {});
    await box.cleanup();
  }
});
