'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  probeCapabilityBroker,
  inspectClientBoundaryArtifacts,
  assessBrokeredDataBoundary
} = require('../../cli/doctor');
const { sandbox } = require('./helpers');

const ROOT = path.resolve(__dirname, '..', '..');

function renderRuntimeTemplate(raw, brokerPath) {
  return raw
    .replaceAll('{{NODE_EXECUTABLE_JSON}}', JSON.stringify(process.execPath))
    .replaceAll('{{SCALVIN_MCP_ENTRY_JSON}}', JSON.stringify(brokerPath));
}

async function compliantCodexConfig(brokerPath) {
  const raw = await fsp.readFile(path.join(ROOT, 'adapters', 'workspace', 'codex.config.template.toml'), 'utf8');
  return renderRuntimeTemplate(raw, brokerPath);
}

async function compliantClaudeSettings() {
  const raw = await fsp.readFile(path.join(ROOT, 'adapters', 'workspace', 'CLAUDE-PERMISSIONS.template.json'), 'utf8');
  const settings = JSON.parse(raw);
  settings.hooks = {
    UserPromptSubmit: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'node ".therapy/hooks/current-time.cjs"', timeout: 2 }]
      },
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'node ".therapy/hooks/safety-net.cjs"', timeout: 2 }]
      }
    ]
  };
  return settings;
}

async function writeCompliantClients(workspace, brokerPath) {
  await fsp.mkdir(path.join(workspace, '.codex'), { recursive: true });
  await fsp.mkdir(path.join(workspace, '.claude'), { recursive: true });
  await fsp.writeFile(path.join(workspace, '.codex', 'config.toml'), await compliantCodexConfig(brokerPath));
  await fsp.writeFile(path.join(workspace, '.claude', 'settings.json'), `${JSON.stringify(await compliantClaudeSettings(), null, 2)}\n`);
  const mcpRaw = await fsp.readFile(path.join(ROOT, 'adapters', 'workspace', 'claude.mcp.template.json'), 'utf8');
  await fsp.writeFile(path.join(workspace, '.mcp.json'), renderRuntimeTemplate(mcpRaw, brokerPath));
}

async function writeBrokerSelfTest(distributionRoot, payload, marker = null) {
  const bin = path.join(distributionRoot, 'bin');
  await fsp.mkdir(bin, { recursive: true });
  const lines = ["'use strict';"];
  if (marker) lines.push(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  lines.push(`process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)});`);
  await fsp.writeFile(path.join(bin, 'scalvin-mcp.js'), `${lines.join('\n')}\n`);
}

function validBrokerPayload() {
  return {
    status: 'ok',
    server: 'scalvin-capability-broker',
    version: '0.4.0',
    toolCount: 8,
    rawSourceToolExposed: false,
    networkToolExposed: false,
    arbitraryPathToolExposed: false,
    hardBoundaryAttested: false,
    completeTypedPrivateSurface: false,
    isolatedSourceWorkerAttested: false
  };
}

function validSourceWorkerPayload() {
  return {
    status: 'ok',
    server: 'scalvin-isolated-source-worker',
    version: '0.2.0',
    toolCount: 3,
    arbitraryPathToolExposed: false,
    networkToolExposed: false,
    liveMemoryWriteToolExposed: false,
    rawSourceAccess: 'bounded_assigned_source_only'
  };
}

async function writeSourceWorkerSelfTest(distributionRoot) {
  const bin = path.join(distributionRoot, 'bin');
  await fsp.mkdir(bin, { recursive: true });
  await fsp.writeFile(path.join(bin, 'scalvin-source-worker.js'), `'use strict';\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(validSourceWorkerPayload())}\n`)});\n`);
  await fsp.mkdir(path.join(distributionRoot, 'cli'), { recursive: true });
  await fsp.writeFile(path.join(distributionRoot, 'cli', 'source-worker.js'), "'use strict';\n");
}

test('broker doctor probe executes only integrity-verified code and accepts the fixed content-free protocol', async () => {
  const box = await sandbox('doctor-broker-probe');
  try {
    const distribution = path.join(box.base, 'distribution');
    const marker = path.join(box.base, 'must-not-execute');
    await writeBrokerSelfTest(distribution, validBrokerPayload(), marker);

    const unverified = await probeCapabilityBroker(distribution, { integrityVerified: false });
    assert.equal(unverified.state, 'degraded');
    assert.equal(unverified.reasonCode, 'BROKER_DISTRIBUTION_UNVERIFIED');
    await assert.rejects(fsp.readFile(marker), { code: 'ENOENT' });

    const available = await probeCapabilityBroker(distribution, { integrityVerified: true });
    assert.equal(available.state, 'available');
    assert.equal(available.reasonCode, null);
    assert.equal(available.hardBoundaryAttested, false);
    assert.equal(available.rawSourceToolExposed, false);
    assert.equal(await fsp.readFile(marker, 'utf8'), 'executed');
  } finally {
    await box.cleanup();
  }
});

test('client boundary inspection recognizes the canonical broker-only profile and still detects stale or extra authority without paths', async () => {
  const box = await sandbox('doctor-client-boundary');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    const expectedBroker = path.join(box.base, 'distribution', 'bin', 'scalvin-mcp.js');
    await writeCompliantClients(box.workspace, expectedBroker);
    const expectedCodexRaw = await compliantCodexConfig(expectedBroker);
    const configured = await inspectClientBoundaryArtifacts(box.workspace, expectedBroker, { expectedCodexRaw });
    assert.equal(configured.codex.configuration, 'broker_only_unattested');
    assert.equal(configured.claude.configuration, 'broker_only_unattested');
    assert.equal(configured.codex.runtimeAttested, false);
    assert.equal(configured.claude.runtimeAttested, false);
    const settings = JSON.parse(await fsp.readFile(path.join(box.workspace, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.permissions.defaultMode, 'default');
    assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
    assert.equal(settings.permissions.disableAutoMode, 'disable');
    assert.ok(settings.permissions.ask.includes('mcp__scalvin__source_integrate'));
    assert.ok(settings.permissions.allow.includes('mcp__scalvin__source_status'));
    assert.equal(settings.permissions.allow.includes('Read(/profile.md)'), false);
    assert.ok(settings.permissions.deny.includes('Read(/profile.md)'));
    assert.ok(settings.permissions.deny.includes('Write(/sessions/**)'));
    assert.ok(settings.permissions.deny.includes('Write(/.therapy/user-overrides/**)'));
    assert.ok(settings.permissions.deny.includes('Read(/sources/**)'));
    assert.ok(settings.permissions.deny.includes('Read(/archive/**)'));
    assert.ok(settings.permissions.deny.includes('Read(/.therapy/state/**)'));
    assert.ok(settings.permissions.deny.includes('Read(/.codex/**)'));
    assert.deepEqual(settings.sandbox.filesystem.denyRead, ['.']);
    assert.ok(settings.sandbox.filesystem.allowRead.includes('./.therapy/safety-protocol.md'));

    const privateSentinel = path.join(box.base, 'private-value', 'stale-scalvin-mcp.js');
    await fsp.appendFile(path.join(box.workspace, '.codex', 'config.toml'), [
      '',
      '[mcp_servers.rogue]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(privateSentinel)}]`,
      ''
    ].join('\n'));
    const projectMcp = JSON.parse(await fsp.readFile(path.join(box.workspace, '.mcp.json'), 'utf8'));
    projectMcp.mcpServers.rogue = { type: 'stdio', command: process.execPath, args: [privateSentinel], env: {} };
    projectMcp.mcpServers.scalvin.args[0] = privateSentinel;
    await fsp.writeFile(path.join(box.workspace, '.mcp.json'), `${JSON.stringify(projectMcp, null, 2)}\n`);

    const degraded = await inspectClientBoundaryArtifacts(box.workspace, expectedBroker, { expectedCodexRaw });
    assert.equal(degraded.codex.configuration, 'degraded');
    assert.ok(degraded.codex.reasonCodes.includes('CODEX_EXTRA_MCP_CONFIG'));
    assert.equal(degraded.claude.configuration, 'degraded');
    assert.ok(degraded.claude.reasonCodes.includes('CLAUDE_EXTRA_MCP_CONFIG'));
    assert.ok(degraded.claude.reasonCodes.includes('CLAUDE_BROKER_REFERENCE_STALE'));
    const serialized = JSON.stringify(degraded);
    assert.equal(serialized.includes(box.base), false);
    assert.equal(serialized.includes(privateSentinel), false);
  } finally {
    await box.cleanup();
  }
});

test('client boundary inspection fails closed on unapproved path and automatic-tool broadening', async () => {
  const box = await sandbox('doctor-client-boundary-broadening');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    const expectedBroker = path.join(box.base, 'distribution', 'bin', 'scalvin-mcp.js');
    await writeCompliantClients(box.workspace, expectedBroker);

    const codexPath = path.join(box.workspace, '.codex', 'config.toml');
    const codex = await fsp.readFile(codexPath, 'utf8');
    await fsp.writeFile(codexPath, codex.replace(
      '"START-CODEX-SESSION.md" = "read"',
      '"START-CODEX-SESSION.md" = "read"\n"future-private.md" = "read"'
    ));

    const claudePath = path.join(box.workspace, '.claude', 'settings.json');
    const settings = JSON.parse(await fsp.readFile(claudePath, 'utf8'));
    settings.permissions.ask.push('mcp__scalvin__source_status');
    settings.permissions.defaultMode = 'dontAsk';
    settings.permissions.disableAutoMode = false;
    settings.sandbox.filesystem.allowRead.push('./future-private');
    await fsp.writeFile(claudePath, `${JSON.stringify(settings, null, 2)}\n`);

    const degraded = await inspectClientBoundaryArtifacts(box.workspace, expectedBroker, {
      expectedCodexRaw: await compliantCodexConfig(expectedBroker)
    });
    assert.equal(degraded.codex.configuration, 'degraded');
    assert.ok(degraded.codex.reasonCodes.includes('CODEX_PRIVATE_BOUNDARY_POLICY_INCOMPLETE'));
    assert.equal(degraded.claude.configuration, 'degraded');
    assert.ok(degraded.claude.reasonCodes.includes('CLAUDE_BROKER_APPROVAL_INVALID'));
    assert.ok(degraded.claude.reasonCodes.includes('CLAUDE_PRIVATE_BOUNDARY_POLICY_INCOMPLETE'));
  } finally {
    await box.cleanup();
  }
});

test('Codex boundary inspection rejects non-canonical, duplicate, and invalid TOML instead of regex-blessing it', async () => {
  const box = await sandbox('doctor-codex-canonical');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    const expectedBroker = path.join(box.base, 'distribution', 'bin', 'scalvin-mcp.js');
    await writeCompliantClients(box.workspace, expectedBroker);
    const expectedCodexRaw = await compliantCodexConfig(expectedBroker);
    const configPath = path.join(box.workspace, '.codex', 'config.toml');
    const variants = [
      `${expectedCodexRaw}THIS IS NOT TOML\n`,
      `${expectedCodexRaw}\n[mcp_servers.scalvin]\nrequired = false\n`,
      expectedCodexRaw.replace('required = true', 'required = "yes"')
    ];
    for (const candidate of variants) {
      await fsp.writeFile(configPath, candidate);
      const inspected = await inspectClientBoundaryArtifacts(box.workspace, expectedBroker, { expectedCodexRaw });
      assert.equal(inspected.codex.configuration, 'degraded');
      assert.ok(inspected.codex.reasonCodes.includes('CODEX_CONFIG_NOT_CANONICAL'));
    }
    await fsp.writeFile(configPath, expectedCodexRaw.replace('required = true', 'required = false'));
    const startupBlocking = await inspectClientBoundaryArtifacts(box.workspace, expectedBroker, { expectedCodexRaw });
    assert.ok(startupBlocking.codex.reasonCodes.includes('CODEX_BROKER_STARTUP_POLICY_INVALID'));
  } finally {
    await box.cleanup();
  }
});

test('doctor boundary envelope keeps sealed and source state content-free while refusing runtime attestation', async () => {
  const box = await sandbox('doctor-boundary-envelope');
  try {
    const distribution = path.join(box.base, 'distribution');
    const brokerPath = path.join(distribution, 'bin', 'scalvin-mcp.js');
    await writeBrokerSelfTest(distribution, validBrokerPayload());
    await writeSourceWorkerSelfTest(distribution);
    await fsp.mkdir(path.join(distribution, 'cli'), { recursive: true });
    await fsp.writeFile(path.join(distribution, 'cli', 'mcp-server.js'), "'use strict';\n");
    await fsp.mkdir(path.join(distribution, 'adapters', 'workspace'), { recursive: true });
    await fsp.copyFile(
      path.join(ROOT, 'adapters', 'workspace', 'codex.config.template.toml'),
      path.join(distribution, 'adapters', 'workspace', 'codex.config.template.toml')
    );
    await fsp.mkdir(box.workspace, { recursive: true });
    await writeCompliantClients(box.workspace, brokerPath);

    const assessment = await assessBrokeredDataBoundary(
      box.workspace,
      { distributionRoot: distribution },
      { files: [
        { path: 'bin/scalvin-mcp.js' }, { path: 'cli/mcp-server.js' },
        { path: 'bin/scalvin-source-worker.js' }, { path: 'cli/source-worker.js' }
      ] },
      [],
      { consent: { memoryPause: { state: 'sealed_pause', startedAt: '2026-07-15T00:00:00.000Z' } } }
    );
    assert.equal(assessment.capability.state, 'broker_only_unattested');
    assert.equal(assessment.capability.hardBoundaryAttested, false);
    assert.equal(assessment.capability.broker.available, true);
    assert.equal(assessment.capability.broker.runtimeAttested, false);
    assert.equal(assessment.capability.sealedPause.state, 'sealed_pause');
    assert.equal(assessment.capability.sealedPause.readDenialRuntimeAttested, false);
    assert.equal(assessment.capability.sourceIntegration.state, 'hmac_bound_prepared_proposals_only');
    assert.equal(assessment.capability.sourceIntegration.isolatedWorkerAvailable, true);
    assert.equal(assessment.capability.sourceIntegration.isolatedWorkerAttested, false);
    assert.equal(assessment.capability.sourceIntegration.rawSourceToolExposed, false);
    assert.ok(assessment.capability.reasonCodes.includes('BROKER_ONLY_RUNTIME_UNATTESTED'));
    assert.ok(assessment.capability.reasonCodes.includes('STABLE_RELEASE_BLOCKED_UNATTESTED_BOUNDARY'));
    assert.ok(assessment.findings.some((item) => item.code === 'BROKER_ONLY_BOUNDARY_UNATTESTED'));
    assert.ok(assessment.findings.some((item) => item.code === 'ISOLATED_SOURCE_WORKER_SELF_TEST_OK'));
    assert.ok(assessment.findings.some((item) => item.code === 'SEALED_PAUSE_RUNTIME_UNATTESTED'));
    const serialized = JSON.stringify(assessment);
    assert.equal(serialized.includes(box.base), false);
    assert.equal(serialized.includes('2026-07-15T00:00:00.000Z'), false);

    const brokerDegraded = await assessBrokeredDataBoundary(
      box.workspace,
      { distributionRoot: distribution },
      { files: [
        { path: 'bin/scalvin-mcp.js' }, { path: 'cli/mcp-server.js' },
        { path: 'bin/scalvin-source-worker.js' }, { path: 'cli/source-worker.js' }
      ] },
      [{ code: 'SIMULATED_DISTRIBUTION_DRIFT' }],
      { consent: { memoryPause: { state: 'none', startedAt: null } } }
    );
    assert.equal(brokerDegraded.capability.state, 'degraded');
    assert.equal(brokerDegraded.capability.clients.codex.configuration, 'broker_only_unattested');
    assert.equal(brokerDegraded.capability.clients.claude.configuration, 'broker_only_unattested');
    assert.ok(brokerDegraded.findings.some((item) => item.code === 'CAPABILITY_BROKER_DEGRADED'));
    assert.ok(brokerDegraded.findings.some((item) => item.code === 'CLIENT_BROKER_ONLY_PROFILE_OK'));
    assert.equal(brokerDegraded.findings.some((item) => item.code === 'CLIENT_BOUNDARY_CONFIGURATION_DEGRADED'), false);

    const sourceWorkerMissing = await assessBrokeredDataBoundary(
      box.workspace,
      { distributionRoot: distribution },
      { files: [{ path: 'bin/scalvin-mcp.js' }, { path: 'cli/mcp-server.js' }] },
      [],
      { consent: { memoryPause: { state: 'none', startedAt: null } } }
    );
    assert.equal(sourceWorkerMissing.capability.state, 'degraded');
    assert.equal(sourceWorkerMissing.capability.broker.available, true);
    assert.equal(sourceWorkerMissing.capability.sourceIntegration.state, 'disabled_until_isolated_worker_available');
    assert.ok(sourceWorkerMissing.findings.some((item) => item.code === 'SOURCE_INTEGRATION_FAIL_CLOSED'));
  } finally {
    await box.cleanup();
  }
});
