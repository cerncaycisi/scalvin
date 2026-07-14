'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, update, consent } = require('../../cli/operations');
const { JOURNAL_RELATIVE } = require('../../cli/lib/operation-journal');
const { ROOT, sandbox, incomingDistribution, readJson } = require('./helpers');

async function bundledUpdateOptions(target, extra = {}) {
  const manifestPath = path.join(ROOT, 'manifest.json');
  const bytes = await fsp.readFile(manifestPath);
  const manifest = JSON.parse(bytes);
  return {
    target,
    manifest: manifestPath,
    'manifest-sha256': crypto.createHash('sha256').update(bytes).digest('hex'),
    release: manifest.release.version,
    ...extra
  };
}

test('pinned update verifies sources, snapshots, updates, and becomes a no-op', async () => {
  const box = await sandbox('update');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const incoming = await incomingDistribution(box.base, '1.0.1', async ({ source }) => {
      await fsp.appendFile(path.join(source, 'commands.md'), '\n<!-- synthetic update -->\n');
    });
    const dry = await update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1', 'dry-run': true });
    assert.equal(dry.status, 'dry-run');
    assert.ok(dry.changes.some((change) => change.target === '.therapy/commands.md'));
    const result = await update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1' });
    assert.equal(result.status, 'updated');
    assert.ok(result.backupPath);
    assert.match(await fsp.readFile(path.join(box.workspace, '.therapy', 'commands.md'), 'utf8'), /synthetic update/);
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.product.version, '1.0.1');
    const noOp = await update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1' });
    assert.equal(noOp.status, 'up-to-date');
  } finally {
    await box.cleanup();
  }
});

test('customized framework is reported and force overwrites only after backup', async () => {
  const box = await sandbox('update-conflict');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const commands = path.join(box.workspace, '.therapy', 'commands.md');
    await fsp.appendFile(commands, '\nlocal customization\n');
    const incoming = await incomingDistribution(box.base, '1.0.1', async ({ source }) => {
      await fsp.appendFile(path.join(source, 'commands.md'), '\nincoming version\n');
    });
    const dry = await update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1', 'dry-run': true });
    assert.ok(dry.conflicts.some((conflict) => conflict.target === '.therapy/commands.md'));
    assert.match(dry.confirmationRequired, /^update-replace:\d{13}:[a-f0-9]{64}$/);
    await assert.rejects(update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1' }), { code: 'CUSTOMIZATIONS_DETECTED' });
    await fsp.appendFile(commands, '\nchanged after preview\n');
    await assert.rejects(update({
      target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1', force: true, confirm: dry.confirmationRequired
    }), { code: 'STALE_CONFIRMATION' });
    assert.deepEqual(
      (await fsp.readdir(box.base)).filter((entry) => entry.startsWith('.workspace.update-stage.')),
      []
    );
    process.env.SCALVIN_TEST_FAILPOINT = 'update-stage-cleanup';
    let retainedPrivateStagePath;
    await assert.rejects(update({
      target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1', force: true, confirm: dry.confirmationRequired
    }), (error) => {
      assert.equal(error.code, 'UPDATE_STAGE_CLEANUP_FAILED');
      assert.equal(error.details.cleanupErrorCode, 'TEST_FAILPOINT');
      assert.equal(error.details.originalErrorCode, 'STALE_CONFIRMATION');
      assert.equal(error.details.nextAction, 'remove-retained-private-stage-before-retrying');
      retainedPrivateStagePath = error.details.retainedPrivateStagePath;
      return true;
    });
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await fsp.access(retainedPrivateStagePath);
    await fsp.rm(retainedPrivateStagePath, { recursive: true, force: true });
    const fresh = await update({
      target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1', force: true
    });
    const forced = await update({
      target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1', force: true, confirm: fresh.confirmationRequired
    });
    assert.ok(forced.backupPath);
    assert.match(await fsp.readFile(commands, 'utf8'), /incoming version/);
    assert.doesNotMatch(await fsp.readFile(commands, 'utf8'), /local customization/);
  } finally {
    await box.cleanup();
  }
});

test('poisoned state baseline cannot authorize a same-manifest overwrite', async () => {
  const box = await sandbox('update-poisoned-baseline');
  try {
    await install({ target: box.workspace, consent: 'granted', language: 'en' });
    const agents = path.join(box.workspace, 'AGENTS.md');
    const signedBytes = await fsp.readFile(agents);
    await fsp.appendFile(agents, '\nlocal adapter customization\n');
    const customizedBytes = await fsp.readFile(agents);
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const poisoned = await readJson(statePath);
    const signedBaseline = poisoned.files['AGENTS.md'].installedHash;
    poisoned.files['AGENTS.md'].installedHash = crypto.createHash('sha256').update(customizedBytes).digest('hex');
    await fsp.writeFile(statePath, `${JSON.stringify(poisoned, null, 2)}\n`, { mode: 0o600 });
    const poisonedState = await fsp.readFile(statePath);

    const dry = await update(await bundledUpdateOptions(box.workspace, { 'dry-run': true }));
    const conflict = dry.conflicts.find((item) => item.target === 'AGENTS.md');
    assert.ok(conflict);
    assert.equal(conflict.priorHash, signedBaseline);
    assert.notEqual(conflict.priorHash, poisoned.files['AGENTS.md'].installedHash);
    await assert.rejects(update(await bundledUpdateOptions(box.workspace)), { code: 'CUSTOMIZATIONS_DETECTED' });
    assert.deepEqual(await fsp.readFile(agents), customizedBytes);
    assert.deepEqual(await fsp.readFile(statePath), poisonedState);

    const preview = await update(await bundledUpdateOptions(box.workspace, { force: true }));
    assert.equal(preview.status, 'preview');
    await assert.rejects(update(await bundledUpdateOptions(box.workspace, {
      force: true,
      confirm: `${preview.confirmationRequired.slice(0, -1)}${preview.confirmationRequired.endsWith('0') ? '1' : '0'}`
    })), { code: 'STALE_CONFIRMATION' });
    assert.deepEqual(await fsp.readFile(agents), customizedBytes);

    const result = await update(await bundledUpdateOptions(box.workspace, { force: true, confirm: preview.confirmationRequired }));
    assert.equal(result.status, 'updated');
    assert.ok(result.backupPath);
    assert.deepEqual(await fsp.readFile(agents), signedBytes);
  } finally {
    await box.cleanup();
  }
});

test('removed signed targets use the trusted previous plan and customized targets still require force', async () => {
  const box = await sandbox('update-trusted-removal');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const cft = path.join(box.workspace, '.therapy', 'modalities', 'cft.md');
    const signedBytes = await fsp.readFile(cft);
    await fsp.appendFile(cft, '\nlocal modality customization\n');
    const customizedBytes = await fsp.readFile(cft);
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const poisoned = await readJson(statePath);
    poisoned.files['.therapy/modalities/cft.md'].installedHash = crypto.createHash('sha256').update(customizedBytes).digest('hex');
    await fsp.writeFile(statePath, `${JSON.stringify(poisoned, null, 2)}\n`, { mode: 0o600 });

    const dry = await update(await bundledUpdateOptions(box.workspace, { modality: ['act'], 'dry-run': true }));
    const conflict = dry.conflicts.find((item) => item.target === '.therapy/modalities/cft.md');
    assert.ok(conflict);
    assert.notEqual(conflict.priorHash, poisoned.files['.therapy/modalities/cft.md'].installedHash);
    await assert.rejects(update(await bundledUpdateOptions(box.workspace, { modality: ['act'] })), { code: 'CUSTOMIZATIONS_DETECTED' });
    assert.deepEqual(await fsp.readFile(cft), customizedBytes);

    await fsp.writeFile(cft, signedBytes);
    const cleanActualPoisonedState = await readJson(statePath);
    cleanActualPoisonedState.files['.therapy/modalities/cft.md'].installedHash = 'e'.repeat(64);
    await fsp.writeFile(statePath, `${JSON.stringify(cleanActualPoisonedState, null, 2)}\n`, { mode: 0o600 });
    const result = await update(await bundledUpdateOptions(box.workspace, { modality: ['act'] }));
    assert.equal(result.status, 'updated');
    await assert.rejects(fsp.access(cft), { code: 'ENOENT' });
    await fsp.access(path.join(box.workspace, '.therapy', 'library', 'modalities', 'cft.md'));
    assert.deepEqual((await readJson(statePath)).preferences.modalities, ['act']);
  } finally {
    await box.cleanup();
  }
});

test('state-only synthetic records cannot authorize deletion of user files', async () => {
  const box = await sandbox('update-synthetic-delete');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const personal = path.join(box.workspace, 'personal-notes.md');
    const personalBytes = Buffer.from('private user-owned note\n');
    await fsp.writeFile(personal, personalBytes, { mode: 0o600 });
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const poisoned = await readJson(statePath);
    poisoned.files['personal-notes.md'] = {
      ...poisoned.files['.therapy/commands.md'],
      installedHash: crypto.createHash('sha256').update(personalBytes).digest('hex')
    };
    await fsp.writeFile(statePath, `${JSON.stringify(poisoned, null, 2)}\n`, { mode: 0o600 });
    const incoming = await incomingDistribution(box.base, '1.0.1', async ({ source }) => {
      await fsp.appendFile(path.join(source, 'commands.md'), '\nsigned incoming update\n');
    });

    const dry = await update({
      target: box.workspace,
      manifest: incoming.manifestPath,
      'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1',
      'dry-run': true
    });
    assert.equal(dry.changes.some((item) => item.target === 'personal-notes.md'), false);
    const result = await update({
      target: box.workspace,
      manifest: incoming.manifestPath,
      'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1'
    });
    assert.equal(result.status, 'updated');
    assert.deepEqual(await fsp.readFile(personal), personalBytes);
    assert.equal(Object.hasOwn((await readJson(statePath)).files, 'personal-notes.md'), false);
  } finally {
    await box.cleanup();
  }
});

test('unknown prior manifests fail closed for changing managed files', async () => {
  const box = await sandbox('update-unknown-prior');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const commands = path.join(box.workspace, '.therapy', 'commands.md');
    const beforeCommands = await fsp.readFile(commands);
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const state = await readJson(statePath);
    const unknownHash = 'd'.repeat(64);
    state.product.manifestSha256 = unknownHash;
    state.source.pin = unknownHash;
    await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    const beforeState = await fsp.readFile(statePath);
    const incoming = await incomingDistribution(box.base, '1.0.1', async ({ source }) => {
      await fsp.appendFile(path.join(source, 'commands.md'), '\nunknown-prior incoming bytes\n');
    });
    const options = {
      target: box.workspace,
      manifest: incoming.manifestPath,
      'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1'
    };

    const dry = await update({ ...options, 'dry-run': true });
    assert.ok(dry.conflicts.some((item) => item.target === '.therapy/commands.md' && item.priorHash === null));
    assert.ok(dry.warnings.some((item) => item.code === 'UNVERIFIED_PRIOR_TARGETS_PRESERVED'));
    await assert.rejects(update(options), { code: 'CUSTOMIZATIONS_DETECTED' });
    assert.deepEqual(await fsp.readFile(commands), beforeCommands);
    assert.deepEqual(await fsp.readFile(statePath), beforeState);
  } finally {
    await box.cleanup();
  }
});

test('metadata-only pinned releases refresh canonical distribution provenance', async () => {
  const box = await sandbox('update-metadata-only');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const incoming = await incomingDistribution(box.base, '1.0.1');
    const result = await update({
      target: box.workspace,
      manifest: incoming.manifestPath,
      'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1'
    });
    assert.equal(result.status, 'updated');
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.product.version, '1.0.1');
    assert.equal(state.product.manifestSha256, incoming.manifestSha256);
    assert.equal(state.source.pin, incoming.manifestSha256);
  } finally {
    await box.cleanup();
  }
});

test('hash mismatch and missing pin fail before workspace writes', async () => {
  const box = await sandbox('update-hash');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const before = await fsp.readFile(path.join(box.workspace, '.therapy', 'commands.md'), 'utf8');
    const incoming = await incomingDistribution(box.base, '1.0.1');
    await assert.rejects(update({ target: box.workspace, manifest: incoming.manifestPath }), { code: 'UPDATE_PIN_REQUIRED' });
    await assert.rejects(update({ target: box.workspace, manifest: incoming.manifestPath, release: '1.0.1' }), { code: 'UPDATE_PIN_REQUIRED' });
    await assert.rejects(update({ target: box.workspace, manifest: incoming.manifestPath, release: '1.0.1' }), { code: 'UPDATE_PIN_REQUIRED' });
    await fsp.appendFile(path.join(incoming.source, 'commands.md'), 'tamper');
    await assert.rejects(update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1' }), { code: 'SOURCE_HASH_MISMATCH' });
    assert.equal(await fsp.readFile(path.join(box.workspace, '.therapy', 'commands.md'), 'utf8'), before);
  } finally {
    await box.cleanup();
  }
});

test('legacy state migrates only with explicit force and backup', async () => {
  const box = await sandbox('legacy');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    await fsp.rm(path.join(box.workspace, '.scalvin', 'state.json'));
    await fsp.writeFile(path.join(box.workspace, '.therapy', 'version.json'), JSON.stringify({ installed_from_version: '0.8.1' }));
    const incoming = await incomingDistribution(box.base, '1.0.1');
    const dry = await update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1', 'dry-run': true });
    assert.equal(dry.stateMigration, true);
    assert.ok(Array.isArray(dry.conflicts));
    const result = await update({
      target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1', force: true, confirm: dry.confirmationRequired
    });
    assert.equal(result.stateMigrated, true);
    assert.ok(result.backupPath);
    assert.equal((await readJson(path.join(box.workspace, '.scalvin', 'state.json'))).schemaVersion, 2);
  } finally {
    await box.cleanup();
  }
});

test('update failpoint preserves the old workspace byte-for-byte at target', async () => {
  const box = await sandbox('update-rollback');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const commands = path.join(box.workspace, '.therapy', 'commands.md');
    const before = await fsp.readFile(commands, 'utf8');
    const incoming = await incomingDistribution(box.base, '1.0.1', async ({ source }) => {
      await fsp.appendFile(path.join(source, 'commands.md'), '\nnew bytes\n');
    });
    process.env.SCALVIN_TEST_FAILPOINT = 'update-before-activate';
    await assert.rejects(update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1' }), (error) => {
      assert.equal(error.code, 'TEST_FAILPOINT');
      assert.equal(error.details.operationJournal.written, true);
      assert.equal(error.details.operationJournal.rollbackStatus, 'not_required_target_unchanged');
      return true;
    });
    assert.equal(await fsp.readFile(commands, 'utf8'), before);
    const receipt = JSON.parse((await fsp.readFile(path.join(box.workspace, JOURNAL_RELATIVE), 'utf8')).trim());
    assert.deepEqual(Object.keys(receipt).sort(), ['errorCode', 'operation', 'operationId', 'rollbackStatus', 'schemaVersion', 'timestamp']);
    assert.equal(receipt.operation, 'update');
    assert.equal(receipt.errorCode, 'TEST_FAILPOINT');
  } finally {
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await box.cleanup();
  }
});

test('update post-activation failure records that the active workspace was updated', async () => {
  const box = await sandbox('update-post-activation-truth');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const commands = path.join(box.workspace, '.therapy', 'commands.md');
    const incoming = await incomingDistribution(box.base, '1.0.1', async ({ source }) => {
      await fsp.appendFile(path.join(source, 'commands.md'), '\npost-activation incoming version\n');
    });
    process.env.SCALVIN_TEST_FAILPOINT = 'update-after-activate';
    await assert.rejects(update({
      target: box.workspace,
      manifest: incoming.manifestPath,
      'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1'
    }), (error) => {
      assert.equal(error.code, 'TEST_FAILPOINT');
      assert.equal(error.details.activeWorkspaceUpdated, true);
      assert.equal(error.details.operationJournal.rollbackStatus, 'active_workspace_updated');
      assert.equal(error.details.nextAction, 'inspect-active-workspace-and-run-doctor');
      return true;
    });
    assert.match(await fsp.readFile(commands, 'utf8'), /post-activation incoming version/);
    const receipts = (await fsp.readFile(path.join(box.workspace, JOURNAL_RELATIVE), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(receipts.at(-1).rollbackStatus, 'active_workspace_updated');
  } finally {
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await box.cleanup();
  }
});

test('update aborts when a managed file becomes customized after inspection', async () => {
  const box = await sandbox('update-post-inspection-customization');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const commands = path.join(box.workspace, '.therapy', 'commands.md');
    const incoming = await incomingDistribution(box.base, '1.0.1', async ({ source }) => {
      await fsp.appendFile(path.join(source, 'commands.md'), '\nincoming post-inspection version\n');
    });
    process.env.SCALVIN_TEST_UPDATE_HOOKS = '1';
    await assert.rejects(update({
      target: box.workspace,
      manifest: incoming.manifestPath,
      'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1',
      afterInspection: async () => {
        await fsp.appendFile(commands, '\ncustomized during update inspection window\n');
      }
    }), { code: 'STALE_CONFIRMATION' });
    assert.match(await fsp.readFile(commands, 'utf8'), /customized during update inspection window/);
    assert.doesNotMatch(await fsp.readFile(commands, 'utf8'), /incoming post-inspection version/);
  } finally {
    delete process.env.SCALVIN_TEST_UPDATE_HOOKS;
    await box.cleanup();
  }
});

test('policy refusals are not journaled and disabled usage ledgers suppress attempted-failure receipts', async () => {
  const box = await sandbox('update-journal-policy');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const commands = path.join(box.workspace, '.therapy', 'commands.md');
    await fsp.appendFile(commands, '\nlocal customization\n');
    const incoming = await incomingDistribution(box.base, '1.0.1', async ({ source }) => {
      await fsp.appendFile(path.join(source, 'commands.md'), '\nincoming version\n');
    });
    await assert.rejects(update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1' }), { code: 'CUSTOMIZATIONS_DETECTED' });
    await assert.rejects(fsp.access(path.join(box.workspace, JOURNAL_RELATIVE)), { code: 'ENOENT' });

    await consent({ target: box.workspace, category: 'usage_ledgers', value: 'off', retention: 'do_not_store' });
    const preview = await update({
      target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256,
      release: '1.0.1', force: true
    });
    process.env.SCALVIN_TEST_FAILPOINT = 'update-before-activate';
    await assert.rejects(update({ target: box.workspace, manifest: incoming.manifestPath, 'manifest-sha256': incoming.manifestSha256, release: '1.0.1', force: true, confirm: preview.confirmationRequired }), (error) => {
      assert.equal(error.code, 'TEST_FAILPOINT');
      assert.equal(error.details.operationJournal.written, false);
      assert.equal(error.details.operationJournal.reason, 'disabled-by-data-controls');
      return true;
    });
    await assert.rejects(fsp.access(path.join(box.workspace, JOURNAL_RELATIVE)), { code: 'ENOENT' });
  } finally {
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await box.cleanup();
  }
});
