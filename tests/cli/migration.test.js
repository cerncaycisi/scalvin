'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { update } = require('../../cli/operations');
const { validateLegacyStateVersion } = require('../../cli/lib/workspace');
const { sandbox, incomingDistribution, readJson } = require('./helpers');

test('legacy migration removes only known generated launchers and records legacy sources pending consent', async () => {
  const box = await sandbox('legacy-migration');
  try {
    await fsp.mkdir(path.join(box.workspace, '.therapy'), { recursive: true });
    await fsp.writeFile(path.join(box.workspace, '.therapy', 'version.json'), `${JSON.stringify({ installed_from_version: '0.8.0' })}\n`);
    await fsp.writeFile(path.join(box.workspace, 'start-session.command'), `#!/bin/bash\ncd "${box.workspace}"\nclaude\n`);
    await fsp.writeFile(path.join(box.workspace, 'start-session.bat'), '@echo off\nrem user customization\nclaude\n');
    await fsp.mkdir(path.join(box.workspace, 'sources'), { recursive: true });
    const sourceBody = 'legacy private source\n';
    await fsp.writeFile(path.join(box.workspace, 'sources', 'legacy.md'), sourceBody);

    const incoming = await incomingDistribution(box.base, '1.2.3');
    const dry = await update({
      target: box.workspace,
      manifest: incoming.manifestPath,
      'manifest-sha256': incoming.manifestSha256,
      source: incoming.source,
      'dry-run': true
    });
    assert.equal(dry.stateMigration, true);
    assert.equal(dry.legacySourcesPendingConsent, 1);
    assert.ok(dry.warnings.some((item) => item.code === 'CUSTOMIZED_LEGACY_LAUNCHER_PRESERVED' && item.artifact === 'start-session.bat'));

    const result = await update({
      target: box.workspace,
      manifest: incoming.manifestPath,
      'manifest-sha256': incoming.manifestSha256,
      source: incoming.source
    });
    assert.equal(result.stateMigrated, true);
    assert.equal(result.legacySourceRecords, 1);
    await assert.rejects(fsp.access(path.join(box.workspace, 'start-session.command')), { code: 'ENOENT' });
    assert.equal(await fsp.readFile(path.join(box.workspace, 'start-session.bat'), 'utf8'), '@echo off\nrem user customization\nclaude\n');

    const expectedHash = crypto.createHash('sha256').update(sourceBody).digest('hex');
    const ledger = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'SOURCE-LEDGER.md'), 'utf8');
    assert.match(ledger, new RegExp(`\\| src-[0-9a-f-]{36} \\| 1 \\| unknown \\| unknown \\| imported_source \\| unknown \\| unknown \\| ${expectedHash} \\| ${Buffer.byteLength(sourceBody)} \\| untrusted_data \\| pending_consent \\|`));
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.consent.importedSources, 'ask_each_import');
  } finally {
    await box.cleanup();
  }
});

test('legacy 0.8.1 has a verified migration route', async () => {
  const box = await sandbox('legacy-migration-081');
  try {
    await fsp.mkdir(path.join(box.workspace, '.therapy'), { recursive: true });
    await fsp.writeFile(path.join(box.workspace, '.therapy', 'version.json'), `${JSON.stringify({ installed_from_version: '0.8.1' })}\n`);
    const incoming = await incomingDistribution(box.base, '1.2.3');
    const result = await update({
      target: box.workspace,
      manifest: incoming.manifestPath,
      'manifest-sha256': incoming.manifestSha256,
      source: incoming.source,
      'dry-run': true
    });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.fromVersion, '0.8.1');
    assert.equal(result.stateMigration, true);
  } finally {
    await box.cleanup();
  }
});

test('legacy version compatibility is exact and fails closed', () => {
  assert.equal(validateLegacyStateVersion({ installed_from_version: '0.8.0' }), '0.8.0');
  assert.equal(validateLegacyStateVersion({ installed_from_version: '0.8.1' }), '0.8.1');
  assert.throws(() => validateLegacyStateVersion({ installed_from_version: '0.8.2' }), { code: 'LEGACY_VERSION_UNSUPPORTED' });
  assert.throws(() => validateLegacyStateVersion({}), { code: 'LEGACY_VERSION_INVALID' });
  assert.throws(() => validateLegacyStateVersion({ installed_from_version: '0.8' }), { code: 'LEGACY_VERSION_INVALID' });
  assert.throws(() => validateLegacyStateVersion({ installed_from_version: 801 }), { code: 'LEGACY_VERSION_INVALID' });
});

for (const fixture of [
  { label: 'unsupported', state: { installed_from_version: '0.8.2' }, code: 'LEGACY_VERSION_UNSUPPORTED' },
  { label: 'missing', state: {}, code: 'LEGACY_VERSION_INVALID' },
  { label: 'malformed', state: { installed_from_version: '0.8' }, code: 'LEGACY_VERSION_INVALID' }
]) {
  test(`update rejects ${fixture.label} legacy version metadata before migration`, async () => {
    const box = await sandbox(`legacy-version-${fixture.label}`);
    try {
      await fsp.mkdir(path.join(box.workspace, '.therapy'), { recursive: true });
      await fsp.writeFile(path.join(box.workspace, '.therapy', 'version.json'), `${JSON.stringify(fixture.state)}\n`);
      const incoming = await incomingDistribution(box.base, '1.2.3');
      await assert.rejects(update({
        target: box.workspace,
        manifest: incoming.manifestPath,
        'manifest-sha256': incoming.manifestSha256,
        source: incoming.source,
        'dry-run': true
      }), { code: fixture.code });
      await assert.rejects(fsp.access(path.join(box.workspace, '.scalvin')), { code: 'ENOENT' });
    } finally {
      await box.cleanup();
    }
  });
}
