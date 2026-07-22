'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  applyClientIntegrations,
  clientIntegrationsNeedChange,
  inspectClientBoundary,
  renderString
} = require('../../cli/lib/workspace');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOKS = [
  { target: '.therapy/hooks/current-time.cjs', command: 'node .therapy/hooks/current-time.cjs', timeoutSeconds: 2 },
  { target: '.therapy/hooks/safety-net.cjs', command: 'node .therapy/hooks/safety-net.cjs', timeoutSeconds: 2 }
];
const MANIFEST = {
  clientIntegrations: {
    claude: { settingsPath: '.claude/settings.json', event: 'UserPromptSubmit', hooks: HOOKS }
  }
};

async function boundaryWorkspace(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-client-boundary-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const library = path.join(root, '.therapy', 'library', 'adapters', 'workspace');
  await fsp.mkdir(library, { recursive: true });
  for (const name of ['CLAUDE-PERMISSIONS.template.json', 'claude.mcp.template.json', 'codex.config.template.toml']) {
    await fsp.copyFile(path.join(ROOT, 'adapters', 'workspace', name), path.join(library, name));
  }
  await fsp.mkdir(path.join(root, '.codex'), { recursive: true });
  const codexTemplate = await fsp.readFile(path.join(library, 'codex.config.template.toml'), 'utf8');
  await fsp.writeFile(path.join(root, '.codex', 'config.toml'), renderString(codexTemplate));

  await fsp.mkdir(path.join(root, '.claude'), { recursive: true });
  const settings = { userPreferenceThatMustSurvive: true };
  if (options.userHook) {
    settings.hooks = {
      UserPromptSubmit: [{ matcher: 'user-owned', hooks: [{ type: 'command', command: 'node user-hook.cjs', timeout: 1 }] }]
    };
  }
  await fsp.writeFile(path.join(root, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  const mcpServers = options.userMcp
    ? { userOwnedServer: { command: 'preserve-me', args: [] } }
    : {};
  await fsp.writeFile(path.join(root, '.mcp.json'), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  return root;
}

test('Codex broker-only profile denies every private continuity surface and requires the broker', async () => {
  const template = await fsp.readFile(path.join(ROOT, 'adapters', 'workspace', 'codex.config.template.toml'), 'utf8');
  const rendered = renderString(template);
  assert.doesNotMatch(rendered, /\{\{[A-Z0-9_]+\}\}/);
  assert.match(rendered, /default_permissions = "scalvin-broker-only"/);
  assert.match(rendered, /command = "[^"]+"/);
  assert.match(rendered, /bin[\\/]scalvin-mcp\.js/);
  assert.match(rendered, /required = true/);
  assert.match(rendered, /cwd = "\."/);
  assert.match(rendered, /request_permissions = false/);
  assert.match(rendered, /web_search = "disabled"/);
  assert.match(rendered, /^apps = false$/m);
  assert.match(rendered, /^multi_agent = false$/m);
  assert.match(rendered, /^remote_plugin = false$/m);
  assert.match(rendered, /^shell_tool = false$/m);
  assert.match(rendered, /^unified_exec = false$/m);
  assert.match(rendered, /default_tools_approval_mode = "prompt"/);
  for (const name of ['capability_status', 'control_status', 'memory_show', 'source_status', 'source_proposals']) {
    assert.match(rendered, new RegExp(`\\[mcp_servers\\.scalvin\\.tools\\.${name}\\]\\napproval_mode = "auto"`));
  }
  assert.doesNotMatch(rendered, /\[mcp_servers\.scalvin\.tools\.(?:backup_reminder|source_integrate|memory_control|memory_correct|memory_create|memory_add|consent_set|session_manage)\]/);
  assert.doesNotMatch(rendered, /sandbox_mode\s*=/);
  assert.doesNotMatch(rendered, /hardBoundaryAttested\s*=\s*true/i);

  const workspaceBlock = rendered
    .split('[permissions.scalvin-broker-only.filesystem.":workspace_roots"]')[1]
    .split('[permissions.scalvin-broker-only.network]')[0];
  assert.match(workspaceBlock, /^"\." = "deny"$/m);
  assert.doesNotMatch(workspaceBlock, /^"\." = "read"$/m);
  const readable = [...workspaceBlock.matchAll(/^"([^"]+)" = "read"$/gm)].map((match) => match[1]);
  assert.deepEqual(readable, [
    '.therapy/safety-protocol.md',
    '.therapy/commands.md',
    '.therapy/runtime',
    '.therapy/library',
    '.therapy/persona.md',
    '.therapy/session-structure.md',
    '.therapy/modalities',
    'START-SESSION.md',
    'START-CODEX-SESSION.md'
  ]);
  const writable = [...workspaceBlock.matchAll(/^"([^"]+)" = "write"$/gm)].map((match) => match[1]);
  assert.deepEqual(writable, []);
  for (const privateSurface of [
    'SETUP-NOTES.md', 'profile.md', 'ACTIVE-THEMES.md', 'CURRENT-FOCUS.md',
    'NEXT-PRIMER.md', 'sessions', 'context', 'archive', 'sources',
    '.therapy/user-overrides', '.therapy/state', '.therapy/change-control',
    '.scalvin', '.codex', '.claude', '.mcp.json'
  ]) {
    assert.match(workspaceBlock, new RegExp(`^"${privateSurface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" = "deny"$`, 'm'));
  }
});

test('Claude broker-only policy denies built-in private access and exposes only typed broker operations', async () => {
  const template = await fsp.readFile(path.join(ROOT, 'adapters', 'workspace', 'CLAUDE-PERMISSIONS.template.json'), 'utf8');
  const policy = JSON.parse(renderString(template));
  assert.equal(policy.permissions.defaultMode, 'default');
  assert.equal(policy.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(policy.permissions.disableAutoMode, 'disable');
  assert.equal(policy.disableBypassPermissionsMode, undefined);
  assert.deepEqual(policy.sandbox.filesystem.denyRead, ['.']);
  assert.deepEqual(policy.sandbox.filesystem.denyWrite, ['.']);
  assert.ok(policy.sandbox.filesystem.allowRead.length > 0);
  assert.equal(policy.sandbox.allowUnsandboxedCommands, false);
  for (const surface of [
    '/SETUP-NOTES.md', '/profile.md', '/ACTIVE-THEMES.md', '/CURRENT-FOCUS.md',
    '/NEXT-PRIMER.md', '/sessions/**', '/context/**', '/archive/**', '/sources/**',
    '/.therapy/user-overrides/**', '/.therapy/state/**', '/.scalvin/**',
    '/.claude/**', '/.mcp.json', '/.codex/**'
  ]) {
    for (const tool of ['Read', 'Edit', 'Write']) {
      assert.ok(policy.permissions.deny.includes(`${tool}(${surface})`), `missing ${tool} deny for ${surface}`);
    }
  }
  for (const continuitySurface of [
    '/profile.md', '/ACTIVE-THEMES.md', '/CURRENT-FOCUS.md', '/NEXT-PRIMER.md',
    '/sessions/**', '/context/**', '/archive/**', '/.therapy/user-overrides/**'
  ]) {
    for (const tool of ['Read', 'Edit', 'Write']) {
      const rule = `${tool}(${continuitySurface})`;
      assert.equal(policy.permissions.allow.includes(rule), false, `unexpected continuity allow ${rule}`);
      assert.ok(policy.permissions.deny.includes(rule), `missing continuity deny ${rule}`);
    }
  }
  assert.ok(policy.permissions.allow.includes('Read(/.therapy/runtime/**)'));
  assert.ok(policy.permissions.deny.includes('Write(/.therapy/runtime/**)'));
  assert.equal(policy.sandbox.filesystem.allowRead.includes('./profile.md'), false);
  assert.equal(policy.sandbox.filesystem.allowRead.includes('./sources'), false);
  for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'NotebookEdit']) {
    assert.ok(policy.permissions.deny.includes(tool));
  }
  assert.deepEqual(
    policy.permissions.allow.filter((rule) => rule.startsWith('mcp__scalvin__')),
    [
      'mcp__scalvin__capability_status',
      'mcp__scalvin__control_status',
      'mcp__scalvin__memory_show',
      'mcp__scalvin__source_status',
      'mcp__scalvin__source_proposals'
    ]
  );
  assert.deepEqual(
    policy.permissions.ask.filter((rule) => rule.startsWith('mcp__scalvin__')),
    [
      'mcp__scalvin__source_integrate',
      'mcp__scalvin__memory_control',
      'mcp__scalvin__memory_correct',
      'mcp__scalvin__memory_create',
      'mcp__scalvin__memory_add',
      'mcp__scalvin__backup_reminder',
      'mcp__scalvin__consent_set',
      'mcp__scalvin__session_manage'
    ]
  );
});

test('Claude integration preserves unrelated settings but reports extra hooks and MCP servers as degraded', async (t) => {
  const root = await boundaryWorkspace(t, { userHook: true, userMcp: true });
  const added = await applyClientIntegrations(root, MANIFEST);
  assert.ok(added.includes('.mcp.json'));
  const settings = JSON.parse(await fsp.readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.userPreferenceThatMustSurvive, true);
  assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(settings.permissions.defaultMode, 'default');
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  assert.equal(settings.hooks.UserPromptSubmit.some((item) => item.matcher === 'user-owned'), true);
  const registeredCommands = settings.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks || []).map((entry) => entry.command);
  for (const hook of HOOKS) assert.ok(registeredCommands.includes(`node "${hook.target}"`));

  const mcp = JSON.parse(await fsp.readFile(path.join(root, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.userOwnedServer.command, 'preserve-me');
  assert.equal(mcp.mcpServers.scalvin.command, process.execPath);
  assert.match(mcp.mcpServers.scalvin.args[0], /bin[\\/]scalvin-mcp\.js$/);
  assert.equal(mcp.mcpServers.scalvin.args[2], '${CLAUDE_PROJECT_DIR:-.}');
  assert.equal(await clientIntegrationsNeedChange(root, MANIFEST), false);

  const inspection = await inspectClientBoundary(root, MANIFEST);
  assert.equal(inspection.state, 'degraded');
  assert.equal(inspection.hardBoundaryAttested, false);
  assert.equal(inspection.clientProfile, 'broker_only');
  assert.equal(inspection.claude.needsChange, false);
  assert.ok(inspection.claude.reasonCodes.includes('CLAUDE_EXTRA_HOOKS_UNATTESTED'));
  assert.ok(inspection.claude.reasonCodes.includes('CLAUDE_EXTRA_MCP_SERVERS_UNATTESTED'));

  settings.permissions.deny = settings.permissions.deny.filter((rule) => rule !== 'Bash');
  await fsp.writeFile(path.join(root, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  assert.equal(await clientIntegrationsNeedChange(root, MANIFEST), true);
});

test('an exact project profile is broker-only but never overclaims effective-runtime attestation', async (t) => {
  const root = await boundaryWorkspace(t);
  await applyClientIntegrations(root, MANIFEST);
  const inspection = await inspectClientBoundary(root, MANIFEST);
  assert.equal(inspection.state, 'broker_only_unattested');
  assert.equal(inspection.hardBoundaryAttested, false);
  assert.equal(inspection.clientProfile, 'broker_only');
  assert.equal(inspection.directPrivateFilesystem, 'denied_by_project_policy');
  assert.deepEqual(inspection.codex.reasonCodes, []);
  assert.deepEqual(inspection.claude.reasonCodes, []);
  assert.ok(inspection.limitations.includes('EFFECTIVE_HIGHER_PRIORITY_CONFIG_NOT_INSPECTED'));
  assert.ok(inspection.limitations.includes('STABLE_RELEASE_BLOCKED_UNATTESTED_BOUNDARY'));
});

test('upgrading from compatibility removes only the former managed private-access grants', async (t) => {
  const root = await boundaryWorkspace(t);
  await applyClientIntegrations(root, MANIFEST);
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const settings = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  const oldCompatibilityAllows = [
    'Read(/profile.md)', 'Edit(/profile.md)', 'Write(/profile.md)',
    'Read(/sessions/**)', 'Edit(/sessions/**)', 'Write(/sessions/**)',
    'Read(/.therapy/user-overrides/**)', 'Edit(/.therapy/user-overrides/**)',
    'Write(/.therapy/user-overrides/**)'
  ];
  settings.permissions.allow.push(...oldCompatibilityAllows);
  settings.permissions.deny = settings.permissions.deny.filter((rule) => !oldCompatibilityAllows.includes(rule));
  settings.sandbox.filesystem.allowRead.push('./profile.md', './sessions', './.therapy/user-overrides');
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  assert.equal(await clientIntegrationsNeedChange(root, MANIFEST), true);
  let inspection = await inspectClientBoundary(root, MANIFEST);
  assert.ok(inspection.claude.reasonCodes.includes('CLAUDE_REQUIRED_POLICY_MISSING'));

  await applyClientIntegrations(root, MANIFEST);
  const migrated = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  for (const rule of oldCompatibilityAllows) {
    assert.equal(migrated.permissions.allow.includes(rule), false, rule);
    assert.ok(migrated.permissions.deny.includes(rule), rule);
  }
  assert.equal(migrated.sandbox.filesystem.allowRead.includes('./profile.md'), false);
  assert.equal(migrated.sandbox.filesystem.allowRead.includes('./sessions'), false);
  assert.ok(migrated.permissions.deny.includes('Read(/sources/**)'));
  assert.ok(migrated.permissions.deny.includes('Read(/archive/**)'));
  inspection = await inspectClientBoundary(root, MANIFEST);
  assert.equal(inspection.state, 'broker_only_unattested');
});

test('preserved permission broadening and additional local config are detectable without creating an endless repair loop', async (t) => {
  const root = await boundaryWorkspace(t);
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const settings = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  settings.permissions = {
    allow: ['Read(/future-private/**)'],
    ask: ['mcp__other__read'],
    additionalDirectories: ['../outside']
  };
  settings.sandbox = { filesystem: { allowRead: ['./future-private'], allowWrite: ['./future-private'] } };
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await fsp.writeFile(path.join(root, '.claude', 'settings.local.json'), '{}\n');

  await applyClientIntegrations(root, MANIFEST);
  const preserved = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  assert.ok(preserved.permissions.allow.includes('Read(/future-private/**)'));
  assert.ok(preserved.sandbox.filesystem.allowRead.includes('./future-private'));
  assert.equal(await clientIntegrationsNeedChange(root, MANIFEST), false);
  const inspection = await inspectClientBoundary(root, MANIFEST);
  assert.equal(inspection.state, 'degraded');
  for (const code of [
    'CLAUDE_PERMISSION_ALLOW_BROADENING',
    'CLAUDE_PERMISSION_ASK_BROADENING',
    'CLAUDE_ADDITIONAL_DIRECTORIES_UNATTESTED',
    'CLAUDE_SANDBOX_READ_BROADENING',
    'CLAUDE_SANDBOX_WRITE_BROADENING',
    'CLAUDE_ADDITIONAL_CONFIG_UNATTESTED'
  ]) assert.ok(inspection.claude.reasonCodes.includes(code), code);
});

test('stale absolute broker bindings are detected and Claude bindings are safely rebound without hiding Codex drift', async (t) => {
  const root = await boundaryWorkspace(t);
  await applyClientIntegrations(root, MANIFEST);
  const staleBroker = path.join(path.parse(root).root, 'old-scalvin-checkout', 'bin', 'scalvin-mcp.js');

  const mcpPath = path.join(root, '.mcp.json');
  const mcp = JSON.parse(await fsp.readFile(mcpPath, 'utf8'));
  mcp.mcpServers.scalvin.command = path.join(path.parse(root).root, 'old-node');
  mcp.mcpServers.scalvin.args = [staleBroker, '--workspace', '.'];
  await fsp.writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);

  const codexPath = path.join(root, '.codex', 'config.toml');
  const currentBroker = path.join(ROOT, 'bin', 'scalvin-mcp.js');
  const codex = await fsp.readFile(codexPath, 'utf8');
  assert.ok(codex.includes(JSON.stringify(currentBroker)));
  await fsp.writeFile(codexPath, codex.replace(JSON.stringify(currentBroker), JSON.stringify(staleBroker)));

  let inspection = await inspectClientBoundary(root, MANIFEST);
  assert.ok(inspection.codex.reasonCodes.includes('CODEX_PROFILE_OR_BROKER_BINDING_MISMATCH'));
  assert.ok(inspection.claude.reasonCodes.includes('CLAUDE_BROKER_BINDING_MISMATCH'));
  assert.equal(await clientIntegrationsNeedChange(root, MANIFEST), true);

  await applyClientIntegrations(root, MANIFEST);
  const rebound = JSON.parse(await fsp.readFile(mcpPath, 'utf8'));
  assert.equal(rebound.mcpServers.scalvin.command, process.execPath);
  assert.equal(rebound.mcpServers.scalvin.args[0], currentBroker);
  assert.equal(rebound.mcpServers.scalvin.args[2], '${CLAUDE_PROJECT_DIR:-.}');
  inspection = await inspectClientBoundary(root, MANIFEST);
  assert.equal(inspection.claude.state, 'broker_only_unattested');
  assert.equal(inspection.codex.state, 'degraded');
  assert.equal(await clientIntegrationsNeedChange(root, MANIFEST), false);
});

test('Claude integration refuses a conflicting Scalvin MCP identity instead of blessing or overwriting it', async (t) => {
  const root = await boundaryWorkspace(t);
  const mcpPath = path.join(root, '.mcp.json');
  const hostile = `${JSON.stringify({
    mcpServers: { scalvin: { type: 'http', url: 'https://example.invalid/mcp' } }
  }, null, 2)}\n`;
  await fsp.writeFile(mcpPath, hostile);
  await assert.rejects(applyClientIntegrations(root, MANIFEST), { code: 'CLIENT_MCP_SERVER_CONFLICT' });
  assert.equal(await fsp.readFile(mcpPath, 'utf8'), hostile);
});

test('Claude integration refuses malformed security arrays instead of silently replacing them', async (t) => {
  const root = await boundaryWorkspace(t);
  const settingsPath = path.join(root, '.claude', 'settings.json');
  await fsp.writeFile(settingsPath, `${JSON.stringify({ permissions: { deny: 'Bash' } }, null, 2)}\n`);
  await assert.rejects(applyClientIntegrations(root, MANIFEST), { code: 'CLIENT_SETTINGS_INVALID' });
  const unchanged = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  assert.equal(unchanged.permissions.deny, 'Bash');
});
