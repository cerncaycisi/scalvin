'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  DISTRIBUTION_MANIFEST,
  DISTRIBUTION_ROOT,
  install,
  doctor
} = require('../../cli/operations');
const { runDoctor, probeMechanicalSafetyHook } = require('../../cli/doctor');
const {
  acquireMutationLock,
  createPrivateExclusiveFile,
  mutationLockPath,
  verifyWindowsPrivateAcl
} = require('../../cli/lib/fs-safe');
const { sandbox, readJson } = require('./helpers');

const MANUAL_LOCK_GUIDANCE = 'Manual recovery only: inspect the lock, confirm no Scalvin mutation is running, then remove this exact lock path manually; never delete it based only on age or PID liveness.';

test('doctor reports a deeply missing workspace without attempting a mutation lock', async () => {
  const box = await sandbox('doctor-missing-workspace');
  try {
    const missingParent = path.join(box.base, 'missing-parent');
    const missingWorkspace = path.join(missingParent, 'workspace');
    const report = await doctor({ target: missingWorkspace });

    assert.equal(report.status, 'errors');
    assert.equal(report.errors, 1);
    assert.equal(report.warnings, 0);
    assert.ok(report.findings.some((item) => item.code === 'WORKSPACE_NOT_FOUND'));
    assert.equal(report.findings.some((item) => item.code === 'MUTATION_LOCK_FAILED'), false);
    await assert.rejects(fsp.access(missingParent));
  } finally {
    await box.cleanup();
  }
});

for (const consent of ['not-decided', 'granted', 'declined']) {
  test(`install projects canonical ${consent} consent consistently`, async () => {
    const box = await sandbox(`consent-${consent}`);
    try {
      const result = await install({ target: box.workspace, consent, json: true });
      assert.equal(result.workspacePath, box.workspace);
      assert.match(result.workspaceId, /^[0-9a-f-]{36}$/);
      const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
      const controls = await fsp.readFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), 'utf8');
      assert.equal(state.consent.status, consent);
      const expected = consent === 'granted' ? 'on' : consent === 'declined' ? 'off' : 'ask';
      assert.equal(state.consent.continuityMemory, expected);
      assert.match(controls, new RegExp(`\\| continuity_memory \\| ${expected} \\|`));
      assert.match(controls, /\| raw_transcripts \| off \| do_not_store \|/);
      assert.match(controls, /\| context_graph \| off \| do_not_store \|/);
      const report = await doctor({ target: box.workspace });
      assert.equal(report.errors, 0);
      assert.deepEqual(report.capabilities.mechanicalSafetyBackstop, {
        state: 'available',
        reasonCode: null,
        evidence: 'doctor-self-test'
      });
      assert.ok(report.findings.some((item) => item.code === 'SAFETY_HOOK_HEALTH_AVAILABLE'));
      assert.equal(report.findings.some((item) => item.code === 'CONSENT_PROJECTION_MISMATCH'), false);
      if (consent === 'not-decided') assert.equal(report.status, 'warnings');
      else assert.equal(report.status, 'healthy');
    } finally {
      await box.cleanup();
    }
  });
}

test('install is private, manifest-driven, hook-aware, and ignores a valid pre-consent language tag', async () => {
  const box = await sandbox('install-shape');
  try {
    const dry = await install({ target: box.workspace, 'dry-run': true, language: 'es-419' });
    assert.equal(dry.status, 'dry-run');
    await assert.rejects(fsp.access(box.workspace));
    const result = await install({
      workspace: box.workspace,
      'companion-name': 'Private Name',
      language: 'zh-Hant',
      persona: 'susan',
      structure: 'freeform',
      modality: ['act']
    });
    assert.deepEqual(result.warnings, [{
      code: 'SENSITIVE_PREFERENCES_IGNORED',
      fields: ['companion-name', 'language', 'persona', 'structure', 'modality']
    }]);
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.source.pinType, 'manifest-sha256');
    assert.equal(state.source.pin, state.product.manifestSha256);
    assert.equal(state.preferences.language, 'auto');
    assert.equal(state.preferences.companionName, 'Susan');
    assert.equal(state.preferences.persona, 'susan');
    assert.deepEqual(state.preferences.modalities, ['act', 'cft', 'motivational-interviewing']);
    const setupNotes = await fsp.readFile(path.join(box.workspace, 'SETUP-NOTES.md'), 'utf8');
    assert.doesNotMatch(setupNotes, /\{\{[A-Z0-9_]+\}\}|\[name\]/);
    for (const expected of ['Susan', 'auto', 'susan', 'moderate', 'act, cft, motivational-interviewing']) assert.ok(setupNotes.includes(expected), expected);
    assert.doesNotMatch(setupNotes, /^\s*[-|]\s*(?:continuity_memory|raw_transcripts)\s*(?:[:|])/mi);
    assert.doesNotMatch(setupNotes, /consent-[0-9a-f]{8}-[0-9a-f-]{27}/i);
    if (process.platform === 'win32') {
      assert.deepEqual(await verifyWindowsPrivateAcl(box.workspace), { ok: true });
    } else {
      assert.equal((await fsp.stat(box.workspace)).mode & 0o777, 0o700);
      assert.equal((await fsp.stat(path.join(box.workspace, 'profile.md'))).mode & 0o777, 0o600);
    }
    assert.match(await fsp.readFile(path.join(box.workspace, '.gitignore'), 'utf8'), /^\*$/m);
    const settings = await readJson(path.join(box.workspace, '.claude', 'settings.json'));
    const serialized = JSON.stringify(settings);
    assert.match(serialized, /safety-net\.cjs/);
    assert.match(serialized, /current-time\.cjs/);
    assert.equal((serialized.match(/safety-net\.cjs/g) || []).length, 1);
  } finally {
    await box.cleanup();
  }
});

test('doctor reports content-free available, degraded, and unsupported mechanical safety capability states', async () => {
  const box = await sandbox('doctor-safety-capability');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    let report = await doctor({ target: box.workspace });
    assert.deepEqual(report.capabilities.mechanicalSafetyBackstop, {
      state: 'available',
      reasonCode: null,
      evidence: 'doctor-self-test'
    });

    const privateValue = 'PRIVATE_DOCTOR_HEALTH_VALUE_9f3e2d';
    const safetyHook = path.join(box.workspace, '.therapy', 'hooks', 'safety-net.cjs');
    const executionMarker = path.join(box.base, 'modified-hook-executed');
    await fsp.writeFile(safetyHook, [
      "'use strict';",
      `require('node:fs').writeFileSync(${JSON.stringify(executionMarker)}, ${JSON.stringify(privateValue)});`,
      `process.stdout.write(JSON.stringify({schemaVersion:1,capability:'mechanical_safety_backstop',state:'degraded',reasonCode:${JSON.stringify(privateValue)}}) + '\\n');`
    ].join('\n'), { mode: 0o600 });
    report = await doctor({ target: box.workspace });
    assert.equal(report.capabilities.mechanicalSafetyBackstop.state, 'degraded');
    assert.equal(report.capabilities.mechanicalSafetyBackstop.reasonCode, 'HOOK_INTEGRITY_UNVERIFIED');
    await assert.rejects(fsp.access(executionMarker));
    const healthFinding = report.findings.find((item) => item.code === 'SAFETY_HOOK_HEALTH_DEGRADED');
    assert.ok(healthFinding);
    const healthOutput = JSON.stringify({ capability: report.capabilities.mechanicalSafetyBackstop, finding: healthFinding });
    assert.equal(healthOutput.includes(privateValue), false);
    assert.equal(healthOutput.includes(box.workspace), false);

    const untrustedProbe = path.join(box.base, 'untrusted-self-test.cjs');
    await fsp.writeFile(untrustedProbe, [
      "'use strict';",
      `process.stdout.write(JSON.stringify({schemaVersion:1,capability:'mechanical_safety_backstop',state:'degraded',reasonCode:${JSON.stringify(privateValue)}}) + '\\n');`
    ].join('\n'), { mode: 0o600 });
    const sanitizedProbe = await probeMechanicalSafetyHook(box.base, path.basename(untrustedProbe));
    assert.deepEqual(sanitizedProbe, {
      state: 'degraded',
      reasonCode: 'SELF_TEST_PROTOCOL_INVALID',
      evidence: 'doctor-self-test'
    });
    assert.equal(JSON.stringify(sanitizedProbe).includes(privateValue), false);
    assert.equal(JSON.stringify(sanitizedProbe).includes(box.base), false);

    const staleResourceProbe = path.join(box.base, 'stale-resource-self-test.cjs');
    await fsp.writeFile(staleResourceProbe, [
      "'use strict';",
      "process.stdout.write(JSON.stringify({schemaVersion:1,capability:'mechanical_safety_backstop',state:'degraded',reasonCode:'EMERGENCY_RESOURCE_REGISTRY_STALE'}) + '\\n');"
    ].join('\n'), { mode: 0o600 });
    assert.deepEqual(await probeMechanicalSafetyHook(box.base, path.basename(staleResourceProbe)), {
      state: 'degraded',
      reasonCode: 'EMERGENCY_RESOURCE_REGISTRY_STALE',
      evidence: 'doctor-self-test'
    });

    const manifest = JSON.parse(await fsp.readFile(DISTRIBUTION_MANIFEST, 'utf8'));
    manifest.clientIntegrations.claude.hooks = manifest.clientIntegrations.claude.hooks
      .filter((hook) => !hook.target.endsWith('/safety-net.cjs'));
    const unsupportedManifest = path.join(box.base, 'manifest-without-safety-hook.json');
    await fsp.writeFile(unsupportedManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const unsupported = await runDoctor(box.workspace, {
      distributionRoot: DISTRIBUTION_ROOT,
      distributionManifest: unsupportedManifest,
      mutationLockHeldByCaller: true
    });
    assert.deepEqual(unsupported.capabilities.mechanicalSafetyBackstop, {
      state: 'unsupported',
      reasonCode: 'CLIENT_HOOK_NOT_DECLARED',
      evidence: 'manifest'
    });
    assert.ok(unsupported.findings.some((item) => item.code === 'SAFETY_HOOK_UNSUPPORTED'));
  } finally {
    await box.cleanup();
  }
});

test('language preferences are canonicalized and invalid labels are rejected', async () => {
  const box = await sandbox('language-tags');
  try {
    await assert.rejects(
      install({ target: box.workspace, consent: 'granted', language: 'not a BCP-47 tag' }),
      { code: 'INVALID_PREFERENCE' }
    );
    await assert.rejects(
      install({ target: box.workspace, consent: 'granted', language: 'es-419\nmalformed' }),
      { code: 'INVALID_PREFERENCE' }
    );
    const result = await install({ target: box.workspace, consent: 'granted', language: 'ZH-hant' });
    assert.equal(result.status, 'ready');
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.preferences.language, 'zh-Hant');
  } finally {
    await box.cleanup();
  }
});

test('the legacy model-branded persona selector canonicalizes to casual-warm', async () => {
  const box = await sandbox('legacy-persona-alias');
  try {
    await install({ target: box.workspace, consent: 'granted', persona: 'warm-4o' });
    const state = await readJson(path.join(box.workspace, '.scalvin', 'state.json'));
    assert.equal(state.preferences.persona, 'casual-warm');
    const activePersona = await fsp.readFile(path.join(box.workspace, '.therapy', 'persona.md'), 'utf8');
    assert.match(activePersona, /^# Casual Warm Persona$/m);
    assert.doesNotMatch(activePersona, /4o/i);
  } finally {
    await box.cleanup();
  }
});

test('install binds an initially missing target and preserves content created during planning', async () => {
  const box = await sandbox('install-missing-target-race');
  try {
    const concurrent = path.join(box.workspace, '.therapy', 'persona.md');
    let injected = false;
    const options = { target: box.workspace };
    Object.defineProperty(options, 'consent', {
      enumerable: true,
      get() {
        if (!injected) {
          injected = true;
          fs.mkdirSync(path.dirname(concurrent), { recursive: true, mode: 0o700 });
          fs.writeFileSync(concurrent, 'concurrent content\n', { mode: 0o600 });
        }
        return 'granted';
      }
    });

    await assert.rejects(install(options), { code: 'STALE_WORKSPACE' });
    assert.equal(await fsp.readFile(concurrent, 'utf8'), 'concurrent content\n');
    await assert.rejects(fsp.access(path.join(box.workspace, 'profile.md')), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('install validates an explicit local pointer destination before workspace activation', async () => {
  const box = await sandbox('install-pointer-preflight');
  try {
    const blockedParent = path.join(box.base, 'not-a-directory');
    await fsp.writeFile(blockedParent, 'blocked\n');
    process.env.SCALVIN_LOCAL_STATE_DIR = path.join(blockedParent, 'state');
    await assert.rejects(install({ target: box.workspace, consent: 'granted' }), { code: 'LOCAL_POINTER_PREFLIGHT_FAILED' });
    await assert.rejects(fsp.access(box.workspace), { code: 'ENOENT' });
  } finally {
    delete process.env.SCALVIN_LOCAL_STATE_DIR;
    await box.cleanup();
  }
});

test('doctor omits source-checkout pointer findings when local pointers are explicitly disabled', async () => {
  const box = await sandbox('doctor-pointer-disabled');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    process.env.SCALVIN_DISABLE_LOCAL_POINTER = '1';
    const report = await doctor({ target: box.workspace });
    assert.equal(report.status, 'healthy');
    assert.equal(report.findings.some((item) => item.code.startsWith('LOCAL_POINTER_')), false);
  } finally {
    delete process.env.SCALVIN_DISABLE_LOCAL_POINTER;
    await box.cleanup();
  }
});

test('install reports a noncritical local-pointer warning after activation instead of inviting a rerun', async () => {
  const box = await sandbox('install-pointer-post-activation');
  try {
    process.env.SCALVIN_TEST_FAILPOINT = 'install-after-activate';
    const result = await install({ target: box.workspace, consent: 'granted' });
    assert.equal(result.status, 'ready');
    assert.equal(result.workspaceApplied, true);
    assert.equal(result.localPointerWritten, false);
    assert.equal(result.nextAction, 'repair-local-workspace-pointer');
    assert.deepEqual(result.warnings, [{ code: 'LOCAL_POINTER_WRITE_FAILED', errorCode: 'TEST_FAILPOINT' }]);
    await fsp.access(path.join(box.workspace, 'profile.md'));
  } finally {
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await box.cleanup();
  }
});

test('non-empty install refuses by default and force snapshots before preserving unknown data', async () => {
  const box = await sandbox('install-force');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    await fsp.writeFile(path.join(box.workspace, 'keep.txt'), 'keep me');
    await assert.rejects(install({ target: box.workspace }), { code: 'TARGET_NOT_EMPTY' });
    const preview = await install({ target: box.workspace, force: true, consent: 'granted' });
    assert.equal(preview.status, 'preview');
    assert.match(preview.confirmationRequired, /^install-replace:\d{13}:[a-f0-9]{64}$/);
    await fsp.appendFile(path.join(box.workspace, 'keep.txt'), '\nchanged after preview');
    await assert.rejects(install({
      target: box.workspace, force: true, consent: 'granted', confirm: preview.confirmationRequired
    }), { code: 'STALE_CONFIRMATION' });
    assert.deepEqual(
      (await fsp.readdir(box.base)).filter((entry) => entry.startsWith('.workspace.install-stage.')),
      []
    );
    process.env.SCALVIN_TEST_FAILPOINT = 'install-stage-cleanup';
    let retainedPrivateStagePath;
    await assert.rejects(install({
      target: box.workspace, force: true, consent: 'granted', confirm: preview.confirmationRequired
    }), (error) => {
      assert.equal(error.code, 'INSTALL_STAGE_CLEANUP_FAILED');
      assert.equal(error.details.cleanupStatus, 'retained');
      assert.equal(error.details.cleanupErrorCode, 'TEST_FAILPOINT');
      assert.equal(error.details.originalErrorCode, 'STALE_CONFIRMATION');
      retainedPrivateStagePath = error.details.retainedPrivateStagePath;
      return true;
    });
    delete process.env.SCALVIN_TEST_FAILPOINT;
    await fsp.access(retainedPrivateStagePath);
    await fsp.rm(retainedPrivateStagePath, { recursive: true, force: true });
    const fresh = await install({ target: box.workspace, force: true, consent: 'granted' });
    const result = await install({
      target: box.workspace, force: true, consent: 'granted', confirm: fresh.confirmationRequired
    });
    assert.ok(result.backupPath);
    assert.equal(await fsp.readFile(path.join(box.workspace, 'keep.txt'), 'utf8'), 'keep me\nchanged after preview');
    await fsp.access(path.join(result.backupPath, 'integrity.json'));
  } finally {
    await box.cleanup();
  }
});

test('install failpoint leaves the original target intact', async () => {
  const box = await sandbox('install-rollback');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    await fsp.writeFile(path.join(box.workspace, 'sentinel.txt'), 'original');
    const preview = await install({ target: box.workspace, force: true });
    process.env.SCALVIN_TEST_FAILPOINT = 'install-before-activate';
    await assert.rejects(install({
      target: box.workspace, force: true, confirm: preview.confirmationRequired
    }), { code: 'TEST_FAILPOINT' });
    assert.equal(await fsp.readFile(path.join(box.workspace, 'sentinel.txt'), 'utf8'), 'original');
    await assert.rejects(fsp.access(path.join(box.workspace, '.scalvin', 'state.json')));
  } finally {
    await box.cleanup();
  }
});

test('doctor fails closed for corrupt state and exact managed-target omissions', async () => {
  const box = await sandbox('doctor-state-targets');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const original = await fsp.readFile(statePath, 'utf8');
    await fsp.writeFile(statePath, '{not-json');
    let report = await doctor({ target: box.workspace });
    assert.ok(report.errors > 0);
    assert.ok(report.findings.some((item) => item.code === 'STATE_CORRUPT'));

    await fsp.writeFile(statePath, original);
    const state = JSON.parse(original);
    state.consent.transcriptState = {
      state: 'recording', sessionId: null, captureGrade: 'best_effort_context',
      startedAt: state.createdAt, pausedIntervals: [], stoppedAt: null, knownGaps: []
    };
    await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    report = await doctor({ target: box.workspace });
    assert.ok(report.errors > 0);
    assert.ok(report.findings.some((item) => item.code === 'STATE_CORRUPT'));

    await fsp.writeFile(statePath, original);
    Object.assign(state, JSON.parse(original));
    delete state.files['.therapy/commands.md'];
    await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    report = await doctor({ target: box.workspace });
    assert.ok(report.errors > 0);
    assert.ok(report.findings.some((item) => item.code === 'EXPECTED_MANAGED_TARGET_MISSING' && item.details?.target === '.therapy/commands.md'));
  } finally {
    await box.cleanup();
  }
});

test('doctor rejects poisoned signed baselines and trusts signed target metadata for severity', async () => {
  const box = await sandbox('doctor-signed-baseline');
  try {
    await install({ target: box.workspace, consent: 'granted' });
    const statePath = path.join(box.workspace, '.scalvin', 'state.json');
    const original = await readJson(statePath);
    const agents = path.join(box.workspace, 'AGENTS.md');

    const signedActualPoisoned = structuredClone(original);
    signedActualPoisoned.files['AGENTS.md'].installedHash = 'f'.repeat(64);
    signedActualPoisoned.files['AGENTS.md'].protection = 'seed';
    await fsp.writeFile(statePath, `${JSON.stringify(signedActualPoisoned, null, 2)}\n`, { mode: 0o600 });
    let report = await doctor({ target: box.workspace });
    let baseline = report.findings.find((item) => item.code === 'STATE_INSTALLED_BASELINE_MISMATCH' && item.details?.target === 'AGENTS.md');
    assert.ok(baseline);
    assert.equal(baseline.severity, 'error');
    assert.equal(baseline.details.protection, 'active');
    assert.equal(baseline.details.recordedHash, 'f'.repeat(64));
    assert.ok(report.findings.some((item) => item.code === 'STATE_TARGET_REGISTRY_MISMATCH' && item.details?.target === 'AGENTS.md'));
    assert.equal(report.findings.some((item) => item.code === 'SIGNED_TARGET_MISMATCH' && item.details?.target === 'AGENTS.md'), false);

    await fsp.appendFile(agents, '\ncustom adapter bytes\n');
    const customActualPoisoned = structuredClone(original);
    customActualPoisoned.files['AGENTS.md'].installedHash = crypto.createHash('sha256').update(await fsp.readFile(agents)).digest('hex');
    await fsp.writeFile(statePath, `${JSON.stringify(customActualPoisoned, null, 2)}\n`, { mode: 0o600 });
    report = await doctor({ target: box.workspace });
    baseline = report.findings.find((item) => item.code === 'STATE_INSTALLED_BASELINE_MISMATCH' && item.details?.target === 'AGENTS.md');
    assert.ok(baseline);
    assert.equal(baseline.severity, 'error');
    assert.ok(report.findings.some((item) => item.code === 'SIGNED_TARGET_MISMATCH' && item.details?.target === 'AGENTS.md'));
    assert.equal(report.findings.some((item) => item.code === 'MANAGED_FILE_CUSTOMIZED' && item.details?.target === 'AGENTS.md'), false);

    const unexpectedPath = path.join(box.workspace, 'unexpected-managed.md');
    const unexpectedBytes = Buffer.from('state-only managed target\n');
    await fsp.writeFile(unexpectedPath, unexpectedBytes, { mode: 0o600 });
    const protectionPoisoned = structuredClone(original);
    protectionPoisoned.files['unexpected-managed.md'] = {
      ...original.files['AGENTS.md'],
      protection: 'seed',
      installedHash: crypto.createHash('sha256').update(unexpectedBytes).digest('hex')
    };
    await fsp.writeFile(statePath, `${JSON.stringify(protectionPoisoned, null, 2)}\n`, { mode: 0o600 });
    report = await doctor({ target: box.workspace });
    const unexpected = report.findings.find((item) => item.code === 'UNEXPECTED_MANAGED_TARGET' && item.details?.target === 'unexpected-managed.md');
    assert.ok(unexpected);
    assert.equal(unexpected.severity, 'error');

    const provenancePoisoned = structuredClone(original);
    provenancePoisoned.product.version = '999.0.0';
    provenancePoisoned.source.pinType = 'release';
    provenancePoisoned.source.pin = '999.0.0';
    await fsp.writeFile(statePath, `${JSON.stringify(provenancePoisoned, null, 2)}\n`, { mode: 0o600 });
    report = await doctor({ target: box.workspace });
    let provenance = report.findings.find((item) => item.code === 'STATE_DISTRIBUTION_PROVENANCE_MISMATCH');
    assert.ok(provenance);
    assert.equal(provenance.severity, 'error');
    assert.deepEqual(provenance.details.fields, ['product.version', 'source.pinType', 'source.pin']);

    const pinOnlyPoisoned = structuredClone(original);
    pinOnlyPoisoned.source.pin = 'a'.repeat(64);
    await fsp.writeFile(statePath, `${JSON.stringify(pinOnlyPoisoned, null, 2)}\n`, { mode: 0o600 });
    report = await doctor({ target: box.workspace });
    provenance = report.findings.find((item) => item.code === 'STATE_DISTRIBUTION_PROVENANCE_MISMATCH');
    assert.ok(provenance);
    assert.equal(provenance.severity, 'error');
    assert.deepEqual(provenance.details.fields, ['source.pin']);
  } finally {
    await box.cleanup();
  }
});

test('doctor reports held and orphan-like mutation locks with exact manual-only guidance', async () => {
  const box = await sandbox('doctor-mutation-lock');
  let release;
  let lockPath;
  try {
    await fsp.mkdir(box.workspace);
    release = await acquireMutationLock(box.workspace);
    lockPath = await mutationLockPath(box.workspace);
    const busy = await doctor({ target: box.workspace });
    assert.equal(busy.status, 'busy');
    assert.equal(busy.errors, 1);
    assert.equal(busy.warnings, 0);
    assert.equal(busy.mutationLock.lockPath, lockPath);
    assert.equal(busy.mutationLock.ownerPid, process.pid);
    assert.equal(busy.findings.length, 1);
    assert.equal(busy.findings[0].code, 'WORKSPACE_MUTATION_BUSY');
    assert.match(busy.findings[0].message, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(busy.findings[0].message, new RegExp(MANUAL_LOCK_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(busy), /ownerToken|targetSha256/);
    let report = await runDoctor(box.workspace, {
      distributionRoot: DISTRIBUTION_ROOT,
      distributionManifest: DISTRIBUTION_MANIFEST
    });
    let finding = report.findings.find((item) => item.code === 'MUTATION_LOCK_PRESENT');
    assert.ok(finding, JSON.stringify(report.findings));
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.details.lockPath, lockPath);
    assert.equal(finding.details.lockKind, 'regular-file');
    assert.equal(finding.details.ownerPid, process.pid);
    assert.equal(new Date(finding.details.acquiredAt).toISOString(), finding.details.acquiredAt);
    assert.equal(finding.details.recovery, 'manual-only');
    assert.equal(finding.details.guidance, MANUAL_LOCK_GUIDANCE);
    assert.doesNotMatch(JSON.stringify(finding), /ownerToken|targetSha256/);
    await fsp.access(lockPath);

    const selfHeld = await runDoctor(box.workspace, {
      distributionRoot: DISTRIBUTION_ROOT,
      distributionManifest: DISTRIBUTION_MANIFEST,
      mutationLockHeldByCaller: true
    });
    assert.equal(selfHeld.findings.some((item) => item.code === 'MUTATION_LOCK_PRESENT'), false);

    await release();
    release = null;
    const orphan = await createPrivateExclusiveFile(lockPath);
    await orphan.writeFile('orphan-like lock with intentionally unverifiable metadata\n');
    await orphan.sync();
    await orphan.close();
    const old = new Date('2000-01-01T00:00:00.000Z');
    await fsp.utimes(lockPath, old, old);

    report = await runDoctor(box.workspace, {
      distributionRoot: DISTRIBUTION_ROOT,
      distributionManifest: DISTRIBUTION_MANIFEST
    });
    finding = report.findings.find((item) => item.code === 'MUTATION_LOCK_PRESENT');
    assert.ok(finding, JSON.stringify(report.findings));
    assert.equal(finding.details.lockPath, lockPath);
    assert.equal(finding.details.lockKind, 'regular-file-unverifiable');
    assert.equal(finding.details.ownerPid, undefined);
    assert.equal(finding.details.acquiredAt, undefined);
    assert.equal(finding.details.guidance, MANUAL_LOCK_GUIDANCE);
    await fsp.access(lockPath);
    await assert.rejects(acquireMutationLock(box.workspace), (error) => {
      assert.equal(error.code, 'MUTATION_LOCKED');
      assert.equal(error.details.lockPath, lockPath);
      assert.equal(error.details.guidance, MANUAL_LOCK_GUIDANCE);
      assert.doesNotMatch(JSON.stringify(error.details), /ownerToken|ownerPid|acquiredAt|targetSha256/);
      return true;
    });
    await fsp.access(lockPath);
  } finally {
    await release?.().catch(() => {});
    if (lockPath) await fsp.rm(lockPath, { force: true }).catch(() => {});
    await box.cleanup();
  }
});

test('doctor bounded no-follow reads reject oversized and symlinked controls, settings, and local pointers without exposing content', async (t) => {
  const cases = [
    {
      label: 'controls-oversized',
      mutate: async (box) => fsp.writeFile(path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), Buffer.alloc(1024 * 1024 + 1, 0x78)),
      finding: 'CONSENT_PROJECTION_UNREADABLE', causeCode: 'CONSENT_PROJECTION_TOO_LARGE'
    },
    {
      label: 'settings-oversized',
      mutate: async (box) => fsp.writeFile(path.join(box.workspace, '.claude', 'settings.json'), Buffer.alloc(1024 * 1024 + 1, 0x78)),
      finding: 'HOOK_SETTINGS_INVALID', causeCode: 'HOOK_SETTINGS_TOO_LARGE'
    },
    {
      label: 'pointer-oversized',
      mutate: async (box) => fsp.writeFile(path.join(box.base, 'local-state', 'local-state.json'), Buffer.alloc(64 * 1024 + 1, 0x78)),
      finding: 'LOCAL_POINTER_MISSING', causeCode: 'LOCAL_POINTER_TOO_LARGE'
    }
  ];
  if (process.platform !== 'win32') {
    cases.push(
      {
        label: 'controls-symlink',
        mutate: async (box) => {
          const filename = path.join(box.workspace, '.therapy', 'state', 'DATA-CONTROLS.md');
          const target = path.join(box.base, 'controls-target.md');
          await fsp.rename(filename, target);
          await fsp.symlink(target, filename);
        },
        finding: 'CONSENT_PROJECTION_UNREADABLE', causeCode: 'SYMLINK_REJECTED'
      },
      {
        label: 'settings-symlink',
        mutate: async (box) => {
          const filename = path.join(box.workspace, '.claude', 'settings.json');
          const target = path.join(box.base, 'settings-target.json');
          await fsp.rename(filename, target);
          await fsp.symlink(target, filename);
        },
        finding: 'HOOK_SETTINGS_INVALID', causeCode: 'SYMLINK_REJECTED'
      },
      {
        label: 'pointer-symlink',
        mutate: async (box) => {
          const filename = path.join(box.base, 'local-state', 'local-state.json');
          const target = path.join(box.base, 'pointer-target.json');
          await fsp.rename(filename, target);
          await fsp.symlink(target, filename);
        },
        finding: 'LOCAL_POINTER_MISSING', causeCode: 'SYMLINK_REJECTED'
      }
    );
  }

  for (const fixture of cases) {
    await t.test(fixture.label, async () => {
      const box = await sandbox(`doctor-bounded-${fixture.label}`);
      try {
        await install({ target: box.workspace, consent: 'granted' });
        await fixture.mutate(box);
        const report = await doctor({ target: box.workspace });
        const hit = report.findings.find((item) => item.code === fixture.finding && item.details?.causeCode === fixture.causeCode);
        assert.ok(hit, JSON.stringify(report.findings));
        assert.equal(JSON.stringify(hit).includes('xxxxxxxx'), false);
      } finally {
        await box.cleanup();
      }
    });
  }
});

test('install refuses oversized existing client settings before surgical merge', async () => {
  const box = await sandbox('client-settings-oversized');
  try {
    await fsp.mkdir(path.join(box.workspace, '.claude'), { recursive: true });
    await fsp.writeFile(path.join(box.workspace, '.claude', 'settings.json'), Buffer.alloc(1024 * 1024 + 1, 0x78));
    await assert.rejects(install({ target: box.workspace, force: true, consent: 'granted' }), { code: 'CLIENT_SETTINGS_TOO_LARGE' });
  } finally {
    await box.cleanup();
  }
});
