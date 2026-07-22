'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  MUTATION_LOCK_MANUAL_RECOVERY,
  assertInside,
  rejectSymlinkPath,
  pathExists,
  sha256File,
  walkTree,
  validateRelativePath,
  verifyWindowsPrivateAcl,
  verifyDarwinNoAcl,
  readBoundedRegularFile,
  inspectMutationLock
} = require('./lib/fs-safe');
const { loadManifest, readSourceFile, verifyDistribution } = require('./lib/manifest');
const { loadWorkspaceState, consentProjectionDifferences, buildTargetPlan, normalizePreferences } = require('./lib/workspace');
const { JOURNAL_RELATIVE, MAX_JOURNAL_BYTES, validateReceipt } = require('./lib/operation-journal');
const {
  MAX_SOURCE_RECORD_BYTES,
  parseSourceFrontmatter: parseFrontmatter,
  lintExternalCareRecord,
  lintImportedSourceRecord
} = require('./lib/source-provenance');
const { parseBackupLedger, parseBackupOperationReceipts } = require('./lib/backup');
const { parseReminder } = require('./lib/backup-reminder');
const { statusSource } = require('./source-lifecycle');

const execFileAsync = promisify(execFile);
const MAX_CONSENT_PROJECTION_BYTES = 1024 * 1024;
const MAX_GITIGNORE_BYTES = 256 * 1024;
const MAX_CLIENT_SETTINGS_BYTES = 1024 * 1024;
const MAX_LOCAL_POINTER_BYTES = 64 * 1024;
const MAX_HOOK_SELF_TEST_BYTES = 16 * 1024;
const MAX_BROKER_SELF_TEST_BYTES = 16 * 1024;
const SAFETY_CAPABILITY = 'mechanical_safety_backstop';
const BROKER_ENTRY_RELATIVE = 'bin/scalvin-mcp.js';
const BROKER_SERVER_RELATIVE = 'cli/mcp-server.js';
const BROKER_SERVER_NAME = 'scalvin-capability-broker';
const SOURCE_WORKER_ENTRY_RELATIVE = 'bin/scalvin-source-worker.js';
const SOURCE_WORKER_SERVER_RELATIVE = 'cli/source-worker.js';
const SOURCE_WORKER_SERVER_NAME = 'scalvin-isolated-source-worker';
const BROKER_TOOL_NAMES = new Set([
  'capability_status', 'control_status', 'memory_show', 'memory_control',
  'memory_correct', 'memory_create', 'memory_add', 'backup_reminder', 'consent_set',
  'session_manage', 'source_status', 'source_proposals', 'source_integrate'
]);
const SAFE_CODEX_READ_TARGETS = new Set([
  '.therapy/safety-protocol.md', '.therapy/commands.md', '.therapy/runtime',
  '.therapy/library', '.therapy/persona.md', '.therapy/session-structure.md',
  '.therapy/modalities', 'START-SESSION.md', 'START-CODEX-SESSION.md'
]);
const SAFE_CODEX_WRITE_TARGETS = new Set();
const REQUIRED_CODEX_DENY_TARGETS = new Set([
  '.', 'SETUP-NOTES.md', 'profile.md', 'ACTIVE-THEMES.md', 'CURRENT-FOCUS.md',
  'NEXT-PRIMER.md', 'sessions', 'context', 'archive', 'sources',
  '.therapy/user-overrides', '.therapy/state', '.therapy/change-control',
  '.scalvin', '.codex', '.claude', '.mcp.json'
]);
const CLAUDE_FRAMEWORK_READ_RULES = [
  'Read(/.therapy/safety-protocol.md)', 'Read(/.therapy/commands.md)',
  'Read(/.therapy/runtime/**)', 'Read(/.therapy/library/**)',
  'Read(/.therapy/persona.md)', 'Read(/.therapy/session-structure.md)',
  'Read(/.therapy/modalities/**)', 'Read(/START-SESSION.md)',
  'Read(/START-CLAUDE-SESSION.md)'
];
const CLAUDE_SENSITIVE_TARGETS = [
  'SETUP-NOTES.md', 'profile.md', 'ACTIVE-THEMES.md', 'CURRENT-FOCUS.md',
  'NEXT-PRIMER.md', 'sessions/**', 'context/**', 'archive/**', 'sources/**',
  '.therapy/user-overrides/**', '.therapy/state/**',
  '.therapy/change-control/**', '.scalvin/**', '.claude/**', '.mcp.json',
  '.codex/**'
];
const CLAUDE_IMMUTABLE_TARGETS = [
  '.therapy/safety-protocol.md', '.therapy/commands.md', '.therapy/runtime/**',
  '.therapy/library/**', '.therapy/persona.md', '.therapy/session-structure.md',
  '.therapy/modalities/**', 'START-SESSION.md', 'START-CLAUDE-SESSION.md'
];
const CLAUDE_SANDBOX_ALLOW_READ = [
  './.therapy/safety-protocol.md', './.therapy/commands.md',
  './.therapy/runtime', './.therapy/library', './.therapy/persona.md',
  './.therapy/session-structure.md', './.therapy/modalities',
  './START-SESSION.md', './START-CLAUDE-SESSION.md'
];
const SAFETY_HEALTH_STATES = new Set(['available', 'degraded', 'unsupported']);
const SAFETY_HEALTH_REASON_CODES = new Set([
  'LOCALE_PACK_LOAD_FAILED',
  'LOCALE_PACK_UNAVAILABLE',
  'EMERGENCY_RESOURCE_REGISTRY_LOAD_FAILED',
  'EMERGENCY_RESOURCE_REGISTRY_NOT_YET_VALID',
  'EMERGENCY_RESOURCE_REGISTRY_STALE',
  'SYNTHETIC_CLASSIFICATION_FAILED',
  'SELF_TEST_FAILED'
]);

function finding(severity, code, message, details) {
  return { severity, code, message, ...(details ? { details } : {}) };
}

function safetyCapability(state, reasonCode, evidence) {
  if (!SAFETY_HEALTH_STATES.has(state)) throw new Error('Invalid mechanical safety capability state');
  return { state, reasonCode, evidence };
}

function capabilityEnvelope(mechanicalSafetyBackstop, brokeredDataBoundary = unavailableBoundaryCapability('DOCTOR_INCOMPLETE')) {
  return {
    mechanicalSafetyBackstop,
    brokeredDataBoundary
  };
}

function clientBoundary(configuration, reasonCodes = []) {
  return {
    configuration,
    runtimeAttested: false,
    reasonCodes: [...new Set(reasonCodes)].sort()
  };
}

function unavailableBoundaryCapability(reasonCode) {
  return {
    state: 'unavailable',
    hardBoundaryAttested: false,
    reasonCodes: [reasonCode],
    broker: {
      configured: false,
      available: false,
      runtimeAttested: false,
      version: null,
      evidence: 'doctor'
    },
    clients: {
      codex: clientBoundary('unavailable', [reasonCode]),
      claude: clientBoundary('unavailable', [reasonCode])
    },
    sealedPause: {
      state: 'unknown',
      readDenialRuntimeAttested: false
    },
    sourceIntegration: {
      state: 'disabled_until_isolated_worker_attested',
      isolatedWorkerAvailable: false,
      isolatedWorkerAttested: false,
      rawSourceToolExposed: null,
      runtimeAttested: false
    }
  };
}

async function probeIsolatedSourceWorker(distributionRoot, options = {}) {
  if (options.integrityVerified !== true) {
    return { state: 'degraded', reasonCode: options.reasonCode || 'SOURCE_WORKER_DISTRIBUTION_UNVERIFIED', version: null };
  }
  try {
    const filename = path.resolve(distributionRoot, SOURCE_WORKER_ENTRY_RELATIVE);
    assertInside(distributionRoot, filename, 'Isolated source worker');
    await rejectSymlinkPath(filename);
    const { stdout, stderr } = await execFileAsync(process.execPath, [filename, '--self-test', '--json'], {
      cwd: distributionRoot,
      encoding: 'utf8',
      timeout: 2_500,
      maxBuffer: MAX_BROKER_SELF_TEST_BYTES,
      env: {
        PATH: process.env.PATH || '',
        ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
      }
    });
    if (stderr !== '' || Buffer.byteLength(stdout) > MAX_BROKER_SELF_TEST_BYTES || stdout.trim().split('\n').length !== 1) {
      return { state: 'degraded', reasonCode: 'SOURCE_WORKER_SELF_TEST_PROTOCOL_INVALID', version: null };
    }
    const result = JSON.parse(stdout);
    const expectedKeys = ['arbitraryPathToolExposed', 'liveMemoryWriteToolExposed', 'networkToolExposed', 'rawSourceAccess', 'server', 'status', 'toolCount', 'version'];
    const actualKeys = Object.keys(result || {}).sort();
    const valid = actualKeys.length === expectedKeys.length
      && actualKeys.every((key, index) => key === expectedKeys[index])
      && result.status === 'ok'
      && result.server === SOURCE_WORKER_SERVER_NAME
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(result.version || '')
      && result.toolCount === 3
      && result.arbitraryPathToolExposed === false
      && result.networkToolExposed === false
      && result.liveMemoryWriteToolExposed === false
      && result.rawSourceAccess === 'bounded_assigned_source_only';
    return valid
      ? { state: 'available', reasonCode: null, version: result.version }
      : { state: 'degraded', reasonCode: 'SOURCE_WORKER_SELF_TEST_PROTOCOL_INVALID', version: null };
  } catch (_) {
    return { state: 'degraded', reasonCode: 'SOURCE_WORKER_SELF_TEST_EXECUTION_FAILED', version: null };
  }
}

function brokerProbe(state, reasonCode, details = {}) {
  return {
    state,
    reasonCode,
    evidence: 'doctor-self-test',
    version: details.version || null,
    rawSourceToolExposed: details.rawSourceToolExposed ?? null,
    networkToolExposed: details.networkToolExposed ?? null,
    arbitraryPathToolExposed: details.arbitraryPathToolExposed ?? null,
    hardBoundaryAttested: false
  };
}

async function probeCapabilityBroker(distributionRoot, options = {}) {
  if (options.integrityVerified !== true) {
    return brokerProbe('degraded', options.reasonCode || 'BROKER_DISTRIBUTION_UNVERIFIED');
  }
  try {
    const filename = path.resolve(distributionRoot, BROKER_ENTRY_RELATIVE);
    assertInside(distributionRoot, filename, 'Capability broker');
    await rejectSymlinkPath(filename);
    const { stdout, stderr } = await execFileAsync(process.execPath, [filename, '--self-test', '--json'], {
      cwd: distributionRoot,
      encoding: 'utf8',
      timeout: 2_500,
      maxBuffer: MAX_BROKER_SELF_TEST_BYTES,
      env: {
        PATH: process.env.PATH || '',
        ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
      }
    });
    if (stderr !== '' || Buffer.byteLength(stdout) > MAX_BROKER_SELF_TEST_BYTES || stdout.trim().split('\n').length !== 1) {
      return brokerProbe('degraded', 'BROKER_SELF_TEST_PROTOCOL_INVALID');
    }
    const result = JSON.parse(stdout);
    const expectedKeys = [
      'arbitraryPathToolExposed', 'completeTypedPrivateSurface',
      'hardBoundaryAttested', 'isolatedSourceWorkerAttested',
      'networkToolExposed', 'rawSourceToolExposed', 'server', 'status',
      'toolCount', 'version'
    ];
    const actualKeys = Object.keys(result || {}).sort();
    const protocolValid = actualKeys.length === expectedKeys.length
      && actualKeys.every((key, index) => key === expectedKeys[index])
      && result.status === 'ok'
      && result.server === BROKER_SERVER_NAME
      && typeof result.version === 'string'
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(result.version)
      && Number.isSafeInteger(result.toolCount)
      && result.toolCount > 0
      && result.toolCount <= 64
      && result.rawSourceToolExposed === false
      && result.networkToolExposed === false
      && result.arbitraryPathToolExposed === false
      && result.hardBoundaryAttested === false
      && result.completeTypedPrivateSurface === false
      && result.isolatedSourceWorkerAttested === false;
    if (!protocolValid) return brokerProbe('degraded', 'BROKER_SELF_TEST_PROTOCOL_INVALID');
    return brokerProbe('available', null, result);
  } catch (_) {
    return brokerProbe('degraded', 'BROKER_SELF_TEST_EXECUTION_FAILED');
  }
}

function tomlSection(raw, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\[${escaped}\\]\\s*$`, 'm').exec(raw);
  if (!match) return null;
  const rest = raw.slice(match.index + match[0].length);
  const next = /^\s*\[[^\n]+\]\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function parseTomlJsonValue(section, key) {
  if (typeof section !== 'string') return undefined;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...section.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, 'gm'))];
  if (matches.length !== 1) return undefined;
  try {
    return JSON.parse(matches[0][1]);
  } catch {
    return undefined;
  }
}

function parseTomlStringArray(section, key) {
  if (typeof section !== 'string') return undefined;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignments = [...section.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*\\[`, 'gm'))];
  if (assignments.length !== 1) return undefined;
  const assignment = assignments[0];
  const start = assignment.index + assignment[0].lastIndexOf('[');
  let quote = false;
  let escapedCharacter = false;
  let end = -1;
  for (let index = start + 1; index < section.length; index += 1) {
    const character = section[index];
    if (quote) {
      if (escapedCharacter) escapedCharacter = false;
      else if (character === '\\') escapedCharacter = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') quote = true;
    else if (character === ']') {
      end = index;
      break;
    }
  }
  if (end === -1 || quote) return undefined;
  const body = section.slice(start + 1, end);
  const values = [];
  const stringPattern = /"(?:[^"\\]|\\.)*"/g;
  let match;
  while ((match = stringPattern.exec(body)) !== null) {
    try {
      values.push(JSON.parse(match[0]));
    } catch {
      return undefined;
    }
  }
  if (body.replace(stringPattern, '').replace(/[\s,]/g, '') !== '') return undefined;
  return values;
}

function parseCodexWorkspaceRules(raw) {
  const section = tomlSection(raw, 'permissions.scalvin-broker-only.filesystem.":workspace_roots"');
  if (section === null) return null;
  const rules = new Map();
  for (const line of section.split(/\r?\n/u)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = /^\s*("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line);
    if (!match) return null;
    try {
      const target = JSON.parse(match[1]);
      if (rules.has(target)) return null;
      rules.set(target, JSON.parse(match[2]));
    } catch {
      return null;
    }
  }
  return rules;
}

async function executableLooksAvailable(command) {
  if (typeof command !== 'string' || !path.isAbsolute(command)) return false;
  try {
    await rejectSymlinkPath(command);
    const stat = await fsp.stat(command);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function inspectCodexBoundary(workspace, expectedBrokerPath, expectedRaw = null) {
  const reasons = [];
  let raw;
  try {
    raw = (await readBoundedRegularFile(path.join(workspace, '.codex', 'config.toml'), MAX_CLIENT_SETTINGS_BYTES, {
      typeCode: 'CODEX_CONFIG_INVALID', sizeCode: 'CODEX_CONFIG_TOO_LARGE', changedCode: 'CODEX_CONFIG_CHANGED'
    })).toString('utf8');
  } catch (error) {
    return clientBoundary(error.code === 'ENOENT' ? 'unavailable' : 'degraded', [
      error.code === 'ENOENT' ? 'CODEX_CONFIG_MISSING' : 'CODEX_CONFIG_UNREADABLE'
    ]);
  }

  if (typeof expectedRaw !== 'string') reasons.push('CODEX_CANONICAL_CONFIG_UNAVAILABLE');
  else if (raw !== expectedRaw) reasons.push('CODEX_CONFIG_NOT_CANONICAL');

  const mcpHeaders = [...raw.matchAll(/^\s*\[mcp_servers\.([^\].\s"]+|"(?:[^"\\]|\\.)+")(?:\.([^\]]+))?\]\s*$/gm)];
  const mcpServerNames = new Set(mcpHeaders.map((match) => {
    try {
      return match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
    } catch {
      return null;
    }
  }));
  const rootBrokerSections = mcpHeaders.filter((match) => {
    const rawName = match[1];
    let name;
    try {
      name = rawName.startsWith('"') ? JSON.parse(rawName) : rawName;
    } catch {
      return false;
    }
    return name === 'scalvin' && match[2] === undefined;
  });
  const allowedBrokerSubsections = new Set([
    'tools.capability_status', 'tools.control_status', 'tools.memory_show',
    'tools.source_status', 'tools.source_proposals'
  ]);
  if (rootBrokerSections.length !== 1
    || mcpServerNames.size !== 1
    || !mcpServerNames.has('scalvin')
    || mcpHeaders.some((match) => match[2] !== undefined && !allowedBrokerSubsections.has(match[2]))) {
    reasons.push('CODEX_EXTRA_MCP_CONFIG');
  }
  const brokerSection = tomlSection(raw, 'mcp_servers.scalvin');
  const command = parseTomlJsonValue(brokerSection, 'command');
  const args = parseTomlStringArray(brokerSection, 'args');
  if (!await executableLooksAvailable(command)) reasons.push('CODEX_NODE_EXECUTABLE_UNAVAILABLE');
  if (!Array.isArray(args) || args.length !== 3 || args[0] !== expectedBrokerPath || args[1] !== '--workspace' || args[2] !== '.') {
    reasons.push('CODEX_BROKER_REFERENCE_STALE');
  }
  if (parseTomlJsonValue(brokerSection, 'cwd') !== '.'
    || parseTomlJsonValue(brokerSection, 'required') !== true
    || parseTomlJsonValue(brokerSection, 'enabled') !== true
    || parseTomlJsonValue(brokerSection, 'startup_timeout_sec') !== 10
    || parseTomlJsonValue(brokerSection, 'tool_timeout_sec') !== 60) {
    reasons.push('CODEX_BROKER_STARTUP_POLICY_INVALID');
  }
  const enabledTools = parseTomlStringArray(brokerSection, 'enabled_tools');
  if (!Array.isArray(enabledTools)
    || enabledTools.length !== BROKER_TOOL_NAMES.size
    || new Set(enabledTools).size !== BROKER_TOOL_NAMES.size
    || enabledTools.some((name) => !BROKER_TOOL_NAMES.has(name))) {
    reasons.push('CODEX_BROKER_TOOL_SCOPE_INVALID');
  }
  const toolApprovalHeaders = mcpHeaders
    .filter((match) => {
      let name;
      try {
        name = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
      } catch {
        return false;
      }
      return name === 'scalvin' && typeof match[2] === 'string' && match[2].startsWith('tools.');
    })
    .map((match) => match[2].slice('tools.'.length));
  const expectedAutoTools = [
    'capability_status', 'control_status', 'memory_show',
    'source_status', 'source_proposals'
  ];
  const autoApprovalValid = arrayExactly(toolApprovalHeaders, expectedAutoTools)
    && expectedAutoTools.every((name) => parseTomlJsonValue(tomlSection(raw, `mcp_servers.scalvin.tools.${name}`), 'approval_mode') === 'auto');
  if (parseTomlJsonValue(brokerSection, 'default_tools_approval_mode') !== 'prompt' || !autoApprovalValid) {
    reasons.push('CODEX_BROKER_APPROVAL_INVALID');
  }
  const featuresSection = tomlSection(raw, 'features');
  const filesystemSection = tomlSection(raw, 'permissions.scalvin-broker-only.filesystem');
  const networkSection = tomlSection(raw, 'permissions.scalvin-broker-only.network');
  const shellEnvironmentSection = tomlSection(raw, 'shell_environment_policy');
  const workspaceRules = parseCodexWorkspaceRules(raw);
  const readTargets = workspaceRules
    ? new Set([...workspaceRules.entries()].filter(([, value]) => value === 'read').map(([target]) => target))
    : new Set();
  const writeTargets = workspaceRules
    ? new Set([...workspaceRules.entries()].filter(([, value]) => value === 'write').map(([target]) => target))
    : new Set();
  const unsafeRules = workspaceRules
    ? [...workspaceRules.entries()].filter(([target, value]) => !(
      (value === 'read' && SAFE_CODEX_READ_TARGETS.has(target))
      || (value === 'write' && SAFE_CODEX_WRITE_TARGETS.has(target))
      || value === 'deny'
    ))
    : [];
  if (
    parseTomlJsonValue(raw, 'default_permissions') !== 'scalvin-broker-only'
    || parseTomlJsonValue(raw, 'allow_login_shell') !== false
    || parseTomlJsonValue(raw, 'web_search') !== 'disabled'
    || parseTomlJsonValue(featuresSection, 'apps') !== false
    || parseTomlJsonValue(featuresSection, 'browser_use') !== false
    || parseTomlJsonValue(featuresSection, 'browser_use_external') !== false
    || parseTomlJsonValue(featuresSection, 'browser_use_full_cdp_access') !== false
    || parseTomlJsonValue(featuresSection, 'computer_use') !== false
    || parseTomlJsonValue(featuresSection, 'fast_mode') !== false
    || parseTomlJsonValue(featuresSection, 'goals') !== false
    || parseTomlJsonValue(featuresSection, 'hooks') !== false
    || parseTomlJsonValue(featuresSection, 'image_generation') !== false
    || parseTomlJsonValue(featuresSection, 'in_app_browser') !== false
    || parseTomlJsonValue(featuresSection, 'memories') !== false
    || parseTomlJsonValue(featuresSection, 'multi_agent') !== false
    || parseTomlJsonValue(featuresSection, 'personality') !== false
    || parseTomlJsonValue(featuresSection, 'remote_plugin') !== false
    || parseTomlJsonValue(featuresSection, 'shell_snapshot') !== false
    || parseTomlJsonValue(featuresSection, 'shell_tool') !== false
    || parseTomlJsonValue(featuresSection, 'unified_exec') !== false
    || parseTomlJsonValue(shellEnvironmentSection, 'inherit') !== 'core'
    || parseTomlJsonValue(shellEnvironmentSection, 'ignore_default_excludes') !== false
    || parseTomlJsonValue(filesystemSection, '":minimal"') !== 'read'
    || parseTomlJsonValue(networkSection, 'enabled') !== false
    || !workspaceRules
    || [...REQUIRED_CODEX_DENY_TARGETS].some((target) => workspaceRules.get(target) !== 'deny')
    || readTargets.size !== SAFE_CODEX_READ_TARGETS.size
    || [...SAFE_CODEX_READ_TARGETS].some((target) => !readTargets.has(target))
    || writeTargets.size !== SAFE_CODEX_WRITE_TARGETS.size
    || [...SAFE_CODEX_WRITE_TARGETS].some((target) => !writeTargets.has(target))
    || unsafeRules.length > 0
    || /^\s*sandbox_mode\s*=/m.test(raw)
  ) {
    reasons.push('CODEX_PRIVATE_BOUNDARY_POLICY_INCOMPLETE');
  }
  return clientBoundary(reasons.length ? 'degraded' : 'broker_only_unattested', reasons);
}

async function readClientJsonForBoundary(filename, code) {
  try {
    const value = JSON.parse((await readBoundedRegularFile(filename, MAX_CLIENT_SETTINGS_BYTES, {
      typeCode: `${code}_INVALID`, sizeCode: `${code}_TOO_LARGE`, changedCode: `${code}_CHANGED`
    })).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: `${code}_INVALID` };
    return { value };
  } catch (error) {
    return { error: error.code === 'ENOENT' ? `${code}_MISSING` : `${code}_UNREADABLE` };
  }
}

function arrayExactly(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && expected.every((item) => value.includes(item));
}

function claudeRequiredDenialsComplete(deny) {
  if (!Array.isArray(deny)) return false;
  const directTools = ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'NotebookEdit'];
  if (!directTools.every((entry) => deny.includes(entry))) return false;
  const sensitiveDenied = ['Read', 'Edit', 'Write'].every((tool) =>
    CLAUDE_SENSITIVE_TARGETS.every((target) => deny.includes(`${tool}(/${target})`)));
  const immutableWritesDenied = ['Edit', 'Write'].every((tool) =>
    CLAUDE_IMMUTABLE_TARGETS.every((target) => deny.includes(`${tool}(/${target})`)));
  return sensitiveDenied && immutableWritesDenied;
}

function claudeHooksAttested(hooks) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks) || !arrayExactly(Object.keys(hooks), ['UserPromptSubmit'])) return false;
  const registrations = hooks.UserPromptSubmit;
  if (!Array.isArray(registrations) || registrations.length !== 2) return false;
  const allowed = new Set([
    'node ".therapy/hooks/current-time.cjs"',
    'node ".therapy/hooks/safety-net.cjs"'
  ]);
  const seen = new Set();
  for (const registration of registrations) {
    if (!registration || typeof registration !== 'object' || Array.isArray(registration)
      || Object.keys(registration).some((key) => !['matcher', 'hooks'].includes(key))
      || registration.matcher !== ''
      || !Array.isArray(registration.hooks)
      || registration.hooks.length !== 1) return false;
    const hook = registration.hooks[0];
    if (!hook || typeof hook !== 'object' || Array.isArray(hook)
      || Object.keys(hook).some((key) => !['type', 'command', 'timeout'].includes(key))
      || hook.type !== 'command'
      || hook.timeout !== 2
      || !allowed.has(hook.command)
      || seen.has(hook.command)) return false;
    seen.add(hook.command);
  }
  return seen.size === allowed.size;
}

async function inspectClaudeBoundary(workspace, expectedBrokerPath) {
  const reasons = [];
  const settingsResult = await readClientJsonForBoundary(path.join(workspace, '.claude', 'settings.json'), 'CLAUDE_SETTINGS');
  const mcpResult = await readClientJsonForBoundary(path.join(workspace, '.mcp.json'), 'CLAUDE_MCP');
  if (settingsResult.error) reasons.push(settingsResult.error);
  if (mcpResult.error) reasons.push(mcpResult.error);
  if (settingsResult.error || mcpResult.error) {
    return clientBoundary(reasons.every((code) => code.endsWith('_MISSING')) ? 'unavailable' : 'degraded', reasons);
  }

  const settings = settingsResult.value;
  const projectMcp = mcpResult.value;
  const serverNames = Object.keys(projectMcp.mcpServers || {});
  if (!arrayExactly(serverNames, ['scalvin']) || Object.keys(projectMcp).some((key) => key !== 'mcpServers')) {
    reasons.push('CLAUDE_EXTRA_MCP_CONFIG');
  }
  const server = projectMcp.mcpServers?.scalvin;
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    reasons.push('CLAUDE_BROKER_CONFIG_MISSING');
  } else {
    if (!await executableLooksAvailable(server.command)) reasons.push('CLAUDE_NODE_EXECUTABLE_UNAVAILABLE');
    if (!Array.isArray(server.args) || server.args.length !== 3 || server.args[0] !== expectedBrokerPath || server.args[1] !== '--workspace' || server.args[2] !== '${CLAUDE_PROJECT_DIR:-.}') {
      reasons.push('CLAUDE_BROKER_REFERENCE_STALE');
    }
    if (server.type !== 'stdio'
      || !server.env
      || typeof server.env !== 'object'
      || Array.isArray(server.env)
      || Object.keys(server.env).length !== 0
      || Object.keys(server).some((key) => !['type', 'command', 'args', 'env'].includes(key))) {
      reasons.push('CLAUDE_BROKER_CONFIG_UNATTESTED');
    }
  }

  const allowedTopLevel = new Set([
    '$schema', 'hooks', 'disableClaudeAiConnectors',
    'disableRemoteControl', 'disableArtifact', 'disableSkillShellExecution',
    'disableBundledSkills', 'disableWorkflows', 'autoMemoryEnabled',
    'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'permissions', 'sandbox'
  ]);
  if (Object.keys(settings).some((key) => !allowedTopLevel.has(key))) reasons.push('CLAUDE_UNATTESTED_SETTINGS_PRESENT');
  if (!claudeHooksAttested(settings.hooks)) reasons.push('CLAUDE_HOOK_CONFIGURATION_UNATTESTED');
  if (
    settings.$schema !== 'https://json.schemastore.org/claude-code-settings.json'
    || settings.disableClaudeAiConnectors !== true
    || settings.disableRemoteControl !== true
    || settings.disableArtifact !== true
    || settings.disableSkillShellExecution !== true
    || settings.disableBundledSkills !== true
    || settings.disableWorkflows !== true
    || settings.autoMemoryEnabled !== false
    || settings.enableAllProjectMcpServers !== false
    || !arrayExactly(settings.enabledMcpjsonServers, ['scalvin'])
  ) {
    reasons.push('CLAUDE_MCP_SELECTION_UNATTESTED');
  }
  const permissions = settings.permissions || {};
  const allow = permissions.allow || [];
  const ask = permissions.ask || [];
  const expectedAllow = [
    ...CLAUDE_FRAMEWORK_READ_RULES,
    'mcp__scalvin__capability_status', 'mcp__scalvin__control_status',
    'mcp__scalvin__memory_show', 'mcp__scalvin__source_status',
    'mcp__scalvin__source_proposals'
  ];
  const expectedAsk = [
    'mcp__scalvin__source_integrate',
    'mcp__scalvin__memory_control',
    'mcp__scalvin__memory_correct', 'mcp__scalvin__memory_create', 'mcp__scalvin__memory_add',
    'mcp__scalvin__backup_reminder', 'mcp__scalvin__consent_set',
    'mcp__scalvin__session_manage'
  ];
  if (!arrayExactly(allow, expectedAllow) || !arrayExactly(ask, expectedAsk)) {
    reasons.push('CLAUDE_BROKER_APPROVAL_INVALID');
  }
  const sandbox = settings.sandbox || {};
  const filesystem = sandbox.filesystem || {};
  const network = sandbox.network || {};
  if (
    permissions.defaultMode !== 'default'
    || permissions.disableBypassPermissionsMode !== 'disable'
    || permissions.disableAutoMode !== 'disable'
    || Object.keys(permissions).some((key) => !['allow', 'ask', 'deny', 'defaultMode', 'disableBypassPermissionsMode', 'disableAutoMode'].includes(key))
    || !claudeRequiredDenialsComplete(permissions.deny)
    || expectedAllow.some((rule) => permissions.deny?.includes(rule))
    || sandbox.enabled !== true
    || sandbox.failIfUnavailable !== true
    || sandbox.autoAllowBashIfSandboxed !== false
    || sandbox.allowUnsandboxedCommands !== false
    || Object.keys(sandbox).some((key) => !['enabled', 'failIfUnavailable', 'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands', 'filesystem', 'network'].includes(key))
    || Object.keys(filesystem).some((key) => !['allowRead', 'denyRead', 'denyWrite'].includes(key))
    || Object.keys(network).some((key) => key !== 'allowedDomains')
    || !arrayExactly(filesystem.allowRead, CLAUDE_SANDBOX_ALLOW_READ)
    || !Array.isArray(filesystem.denyRead)
    || !filesystem.denyRead.includes('.')
    || !Array.isArray(filesystem.denyWrite)
    || !filesystem.denyWrite.includes('.')
    || !Array.isArray(network.allowedDomains)
    || network.allowedDomains.length !== 0
  ) {
    reasons.push('CLAUDE_PRIVATE_BOUNDARY_POLICY_INCOMPLETE');
  }
  return clientBoundary(reasons.length ? 'degraded' : 'broker_only_unattested', reasons);
}

async function inspectClientBoundaryArtifacts(workspace, expectedBrokerPath, options = {}) {
  const [codex, claude] = await Promise.all([
    inspectCodexBoundary(workspace, expectedBrokerPath, options.expectedCodexRaw),
    inspectClaudeBoundary(workspace, expectedBrokerPath)
  ]);
  return { codex, claude };
}

async function expectedCodexConfiguration(distributionRoot, expectedBrokerPath) {
  const filename = path.join(distributionRoot, 'adapters', 'workspace', 'codex.config.template.toml');
  await rejectSymlinkPath(filename);
  const raw = (await readBoundedRegularFile(filename, MAX_CLIENT_SETTINGS_BYTES, {
    typeCode: 'CODEX_TEMPLATE_INVALID', sizeCode: 'CODEX_TEMPLATE_TOO_LARGE', changedCode: 'CODEX_TEMPLATE_CHANGED'
  })).toString('utf8');
  const rendered = raw
    .replaceAll('{{NODE_EXECUTABLE_JSON}}', JSON.stringify(process.execPath))
    .replaceAll('{{SCALVIN_MCP_ENTRY_JSON}}', JSON.stringify(expectedBrokerPath));
  if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) throw new Error('unresolved Codex template placeholder');
  return rendered;
}

async function assessBrokeredDataBoundary(workspace, context, manifest, distributionErrors, state) {
  const expectedBrokerPath = path.join(context.distributionRoot, BROKER_ENTRY_RELATIVE);
  const registeredPaths = new Set(manifest.files.map((entry) => entry.path));
  const brokerRegistered = registeredPaths.has(BROKER_ENTRY_RELATIVE) && registeredPaths.has(BROKER_SERVER_RELATIVE);
  const sourceWorkerRegistered = registeredPaths.has(SOURCE_WORKER_ENTRY_RELATIVE) && registeredPaths.has(SOURCE_WORKER_SERVER_RELATIVE);
  const integrityVerified = brokerRegistered && distributionErrors.length === 0;
  const broker = await probeCapabilityBroker(context.distributionRoot, {
    integrityVerified,
    reasonCode: brokerRegistered ? 'BROKER_DISTRIBUTION_UNVERIFIED' : 'BROKER_ENTRY_UNREGISTERED'
  });
  const sourceWorker = await probeIsolatedSourceWorker(context.distributionRoot, {
    integrityVerified: sourceWorkerRegistered && distributionErrors.length === 0,
    reasonCode: sourceWorkerRegistered ? 'SOURCE_WORKER_DISTRIBUTION_UNVERIFIED' : 'SOURCE_WORKER_ENTRY_UNREGISTERED'
  });
  let expectedCodexRaw = null;
  try {
    expectedCodexRaw = await expectedCodexConfiguration(context.distributionRoot, expectedBrokerPath);
  } catch (_) {
    // The inspection below fails closed with CODEX_CANONICAL_CONFIG_UNAVAILABLE.
  }
  const clients = await inspectClientBoundaryArtifacts(workspace, expectedBrokerPath, { expectedCodexRaw });
  const clientReasons = [...clients.codex.reasonCodes, ...clients.claude.reasonCodes];
  const reasonCodes = new Set([
    'CLIENT_RUNTIME_UNATTESTED',
    'HARD_BOUNDARY_NOT_ATTESTED',
    'BROKER_ONLY_RUNTIME_UNATTESTED',
    'SOURCE_WORKER_RUNTIME_UNATTESTED',
    'STABLE_RELEASE_BLOCKED_UNATTESTED_BOUNDARY',
    ...clientReasons
  ]);
  if (broker.state !== 'available') reasonCodes.add(broker.reasonCode);
  if (sourceWorker.state !== 'available') reasonCodes.add(sourceWorker.reasonCode);
  const clientDegraded = clients.codex.configuration !== 'broker_only_unattested'
    || clients.claude.configuration !== 'broker_only_unattested';
  const degraded = broker.state !== 'available' || sourceWorker.state !== 'available' || clientDegraded;
  const anyBrokerOnlyProfile = clients.codex.configuration === 'broker_only_unattested'
    || clients.claude.configuration === 'broker_only_unattested';
  const capability = {
    state: degraded ? (anyBrokerOnlyProfile || broker.state === 'available' ? 'degraded' : 'unavailable') : 'broker_only_unattested',
    hardBoundaryAttested: false,
    reasonCodes: [...reasonCodes].sort(),
    broker: {
      configured: anyBrokerOnlyProfile,
      available: broker.state === 'available',
      runtimeAttested: false,
      version: broker.version,
      evidence: broker.evidence
    },
    clients,
    sealedPause: {
      state: state?.consent?.memoryPause?.state || 'unknown',
      readDenialRuntimeAttested: false
    },
    sourceIntegration: {
      state: sourceWorker.state === 'available' ? 'hmac_bound_prepared_proposals_only' : 'disabled_until_isolated_worker_available',
      isolatedWorkerAvailable: sourceWorker.state === 'available',
      isolatedWorkerAttested: false,
      rawSourceToolExposed: broker.state === 'available' ? broker.rawSourceToolExposed : null,
      runtimeAttested: false,
      perProposalAttestation: sourceWorker.state === 'available' ? 'hmac-sha256' : null,
      version: sourceWorker.version
    }
  };
  const findings = [];
  if (broker.state === 'available') {
    findings.push(finding('info', 'CAPABILITY_BROKER_SELF_TEST_OK', 'The bundled capability broker passed its content-free self-test.'));
  } else {
    findings.push(finding('warning', 'CAPABILITY_BROKER_DEGRADED', 'The bundled capability broker is unavailable or unverified.', { reasonCode: broker.reasonCode }));
  }
  if (clientDegraded) {
    findings.push(finding('warning', 'CLIENT_BOUNDARY_CONFIGURATION_DEGRADED', 'One or more installed client boundary configurations are missing, stale, or contain unattested authority.', {
      clients: ['codex', 'claude'].filter((name) => clients[name].configuration !== 'broker_only_unattested'),
      reasonCodes: [...new Set(clientReasons)].sort()
    }));
  } else {
    findings.push(finding('info', 'CLIENT_BROKER_ONLY_PROFILE_OK', 'Installed client artifacts contain the canonical broker-only project policy; direct private continuity access is denied by project configuration.'));
  }
  findings.push(finding('info', 'BROKER_ONLY_BOUNDARY_UNATTESTED', 'Project configuration denies direct private-file access, but static files cannot attest higher-priority configuration or the effective client runtime. Stable release remains blocked until exact-launch probes pass.'));
  if (sourceWorker.state === 'available') {
    findings.push(finding('info', 'ISOLATED_SOURCE_WORKER_SELF_TEST_OK', 'The bundled isolated source worker passed its content-free self-test; integration accepts only worker-attested prepared proposals.'));
  } else {
    findings.push(finding('warning', 'SOURCE_INTEGRATION_FAIL_CLOSED', 'Source processing and integration remain unavailable because the isolated worker is missing or unverified.', { reasonCode: sourceWorker.reasonCode }));
  }
  if (capability.sealedPause.state === 'sealed_pause') {
    findings.push(finding('warning', 'SEALED_PAUSE_RUNTIME_UNATTESTED', 'Sealed pause is active in canonical state, but this doctor run cannot attest denial by the active client runtime.'));
  }
  return { capability, findings };
}

async function probeMechanicalSafetyHook(workspace, relativeTarget) {
  try {
    const relative = validateRelativePath(relativeTarget);
    const filename = path.resolve(workspace, relative);
    assertInside(workspace, filename, 'Safety hook');
    await rejectSymlinkPath(filename);
    const { stdout, stderr } = await execFileAsync(process.execPath, [filename, '--self-test', '--json'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 2_500,
      maxBuffer: MAX_HOOK_SELF_TEST_BYTES,
      env: { ...process.env, SCALVIN_HOOK_TIMEOUT_MS: '1000' }
    });
    if (stderr !== '' || stdout.length > MAX_HOOK_SELF_TEST_BYTES || stdout.trim().split('\n').length !== 1) {
      return safetyCapability('degraded', 'SELF_TEST_PROTOCOL_INVALID', 'doctor-self-test');
    }
    const result = JSON.parse(stdout);
    const expectedKeys = ['capability', 'reasonCode', 'schemaVersion', 'state'];
    const actualKeys = Object.keys(result || {}).sort();
    if (
      actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])
      || result.schemaVersion !== 1
      || result.capability !== SAFETY_CAPABILITY
      || !['available', 'degraded'].includes(result.state)
      || !(result.reasonCode === null || SAFETY_HEALTH_REASON_CODES.has(result.reasonCode))
      || (result.state === 'available' && result.reasonCode !== null)
      || (result.state === 'degraded' && result.reasonCode === null)
    ) {
      return safetyCapability('degraded', 'SELF_TEST_PROTOCOL_INVALID', 'doctor-self-test');
    }
    return safetyCapability(result.state, result.reasonCode, 'doctor-self-test');
  } catch (_) {
    return safetyCapability('degraded', 'SELF_TEST_EXECUTION_FAILED', 'doctor-self-test');
  }
}

function hasSafetyIntegrityError(findings, relativeTarget) {
  return findings.some((item) => {
    if (item.severity !== 'error') return false;
    const target = item.details?.target;
    if (
      target === relativeTarget
      || String(target || '').startsWith('.therapy/hooks/safety-locales/')
      || /(?:^|\/)emergency-resources\.(?:cjs|json)$/.test(String(target || ''))
    ) return true;
    const files = Array.isArray(item.details?.files) ? item.details.files : [];
    return files.some((entry) => /(?:^|\/)hooks\/(?:safety-net\.cjs|safety-locales\/|emergency-resources\.(?:cjs|json)$)/.test(String(entry)));
  });
}

function validUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function containsCommand(value, command) {
  if (Array.isArray(value)) return value.some((item) => containsCommand(item, command));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsCommand(item, command));
  return value === command;
}

async function checkSensitiveGitTracking(workspace) {
  const sensitive = [
    'profile.md', 'ACTIVE-THEMES.md', 'CURRENT-FOCUS.md', 'NEXT-PRIMER.md',
    'SETUP-NOTES.md', 'sessions', 'sources', 'archive', 'context', '.therapy', '.scalvin', '.claude'
  ];
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--', ...sensitive], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 128) return [];
    if (/not a git repository/i.test(error.stderr || '')) return [];
    return [{ checkError: error.message }];
  }
}

async function checkExternalCareProvenance(workspace) {
  const findings = [];
  const sourcesRoot = path.join(workspace, 'sources');
  if (!(await pathExists(sourcesRoot))) return findings;
  let entries;
  try {
    entries = await walkTree(sourcesRoot);
  } catch (error) {
    return [finding('error', error.code || 'SOURCE_PROVENANCE_SCAN_FAILED', 'Source provenance scan failed.', { cause: error.message })];
  }
  for (const entry of entries.filter((item) => item.type === 'file' && item.path.toLowerCase().endsWith('.md'))) {
    try {
      if (entry.size > MAX_SOURCE_RECORD_BYTES) {
        findings.push(finding('error', 'SOURCE_RECORD_TOO_LARGE', 'A source record exceeds the safe provenance-scan limit.', { record: entry.path }));
        continue;
      }
      const markdown = (await readBoundedRegularFile(path.join(sourcesRoot, entry.path), MAX_SOURCE_RECORD_BYTES, {
        typeCode: 'SOURCE_RECORD_INVALID', sizeCode: 'SOURCE_RECORD_TOO_LARGE', changedCode: 'SOURCE_RECORD_CHANGED'
      })).toString('utf8');
      const managedRecord = entry.path.replaceAll('\\', '/').startsWith('records/');
      if (!managedRecord && !markdown.startsWith('---\nrecord_kind:')) continue;
      const fields = parseFrontmatter(markdown);
      if (!managedRecord && fields?.record_kind !== 'external_care_note') continue;
      const recordFindings = fields.record_kind === 'external_care_note'
        ? lintExternalCareRecord(markdown)
        : lintImportedSourceRecord(markdown);
      for (const item of recordFindings) {
        findings.push(finding(item.severity, item.code, item.message, { record: entry.path, ...(item.details || {}) }));
      }
    } catch (error) {
      findings.push(finding('error', error.code || 'SOURCE_PROVENANCE_SCAN_FAILED', 'An external-care provenance record could not be inspected.', { record: entry.path, cause: error.message }));
    }
  }
  if (!findings.some((item) => item.severity === 'error')) findings.push(finding('info', 'EXTERNAL_CARE_PROVENANCE_OK', 'External-care records have valid provenance boundaries.'));
  return findings;
}

async function checkBackupLedger(workspace, state) {
  const relative = path.join('.therapy', 'state', 'BACKUP-LEDGER.md');
  const filename = path.join(workspace, relative);
  if (!(await pathExists(filename))) {
    return state?.consent?.usageLedgers === 'on'
      ? [finding('error', 'BACKUP_LEDGER_MISSING', 'Backup ledger is missing while operational ledgers are enabled.')]
      : [];
  }
  try {
    await rejectSymlinkPath(filename);
    const markdown = (await readBoundedRegularFile(filename, 1024 * 1024, {
      typeCode: 'BACKUP_LEDGER_INVALID', sizeCode: 'BACKUP_LEDGER_INVALID', changedCode: 'BACKUP_LEDGER_CHANGED'
    })).toString('utf8');
    const parsed = parseBackupLedger(markdown);
    const operationReceipts = parseBackupOperationReceipts(markdown);
    const reminder = parseReminder(markdown);
    const lines = markdown.split(/\r?\n/u);
    const recordCandidates = lines.filter((line) => /^\|\s*backup-(?!op-)/i.test(line));
    const operationCandidates = lines.filter((line) => /^\|\s*backup-op-/i.test(line));
    if (recordCandidates.length !== parsed.records.length || operationCandidates.length !== operationReceipts.length) throw new Error('unparseable backup ledger row');
    const exactBullet = (label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = [...markdown.matchAll(new RegExp(`^- ${escaped}: ([^|\\r\\n]{1,128})$`, 'gm'))];
      if (matches.length !== 1) throw new Error('backup reminder field missing or duplicated');
      return matches[0][1];
    };
    const lastAt = exactBullet('Last successful backup');
    const lastHash = exactBullet('Last successful backup SHA-256');
    const destination = exactBullet('Last destination class');
    const nullTriple = lastAt === 'null' && lastHash === 'null' && destination === 'null';
    const completeTriple = lastAt !== 'null' && lastHash !== 'null' && destination !== 'null';
    if (!nullTriple && !completeTriple) throw new Error('backup reminder success fields are inconsistent');
    const newest = [...parsed.records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
    if (completeTriple) {
      if (Number.isNaN(Date.parse(lastAt)) || new Date(lastAt).toISOString() !== lastAt || !/^[a-f0-9]{64}$/.test(lastHash) || !/^[a-z0-9_]{1,64}$/.test(destination)) throw new Error('backup reminder success fields are invalid');
      if (!newest || newest.artifactStatus !== 'complete' || newest.createdAt !== lastAt || newest.checksum !== lastHash || newest.destinationClass !== destination) throw new Error('backup reminder state does not match the latest complete receipt');
    } else if (newest && newest.artifactStatus !== 'deleted') throw new Error('backup reminder state omits the latest complete receipt');
    if (reminder.reminderDeclinedUntil !== null && reminder.lastReminderAt === null) throw new Error('backup reminder suppression has no reminder event');
    return [finding('info', 'BACKUP_LEDGER_OK', 'Backup receipts, operation outcomes, and reminder state are structurally consistent.', {
      count: parsed.records.length,
      operationReceiptCount: operationReceipts.length,
      sessionsSinceSuccessfulBackup: reminder.sessionsSinceSuccessfulBackup
    })];
  } catch (error) {
    return [finding('error', 'BACKUP_LEDGER_INVALID', 'Backup ledger or reminder state is invalid.', { causeCode: error.code || 'INVALID' })];
  }
}

async function checkSourceLifecycle(workspace, state) {
  if (!state) return [];
  try {
    const ledger = await statusSource({ workspace });
    const active = ledger.records.filter((record) => !['deleted', 'pending_consent'].includes(record.status));
    const canonical = state.sourceLifecycle.records;
    if (active.length !== canonical.length) throw new Error('source lifecycle record count mismatch');
    for (const record of canonical) {
      const match = active.find((item) => item.sourceId === record.sourceId && item.revision === record.revision);
      if (!match) throw new Error('canonical source record missing from ledger');
      for (const key of ['kind', 'locale', 'sha256', 'byteLength', 'status', 'trust', 'retention', 'lastIntegratedHash', 'lastIntegratedAt', 'error']) {
        if (JSON.stringify(match[key]) !== JSON.stringify(record[key])) throw new Error(`source lifecycle ${key} mismatch`);
      }
      if (JSON.stringify(match.derivedMemoryIds) !== JSON.stringify(record.derivedMemoryIds)) throw new Error('source lifecycle derived-memory mismatch');
    }
    return [finding('info', 'SOURCE_LIFECYCLE_OK', 'Canonical source lifecycle state matches content-free ledger metadata.', { count: canonical.length })];
  } catch (error) {
    return [finding('error', 'SOURCE_LIFECYCLE_INVALID', 'Canonical source lifecycle state or ledger metadata is invalid.', { causeCode: error.code || 'INVALID' })];
  }
}

async function runDoctor(workspace, context) {
  const findings = [];
  let mechanicalSafetyBackstop = safetyCapability('degraded', 'DOCTOR_INCOMPLETE', 'doctor');
  let brokeredDataBoundary = unavailableBoundaryCapability('DOCTOR_INCOMPLETE');
  let workspaceMatchesDistribution = false;
  let loaded;
  try {
    loaded = await loadManifest(context.distributionManifest);
    findings.push(finding('info', 'MANIFEST_SCHEMA_OK', 'Distribution manifest schema v2 is valid.'));
  } catch (error) {
    return {
      status: 'errors', workspacePath: workspace, workspaceId: null,
      errors: 1, warnings: 0,
      findings: [finding('error', error.code || 'MANIFEST_INVALID', error.message, error.details)],
      capabilities: capabilityEnvelope(mechanicalSafetyBackstop, unavailableBoundaryCapability('MANIFEST_INVALID')),
      nextAction: 'repair-distribution'
    };
  }

  const distributionErrors = await verifyDistribution(loaded.manifest, context.distributionRoot);
  if (distributionErrors.length) findings.push(finding('error', 'DISTRIBUTION_INTEGRITY_FAILED', 'Distribution files do not match manifest hashes.', { files: distributionErrors }));
  else findings.push(finding('info', 'DISTRIBUTION_INTEGRITY_OK', 'All distribution file hashes match.'));

  try {
    await rejectSymlinkPath(workspace);
    const stat = await fsp.lstat(workspace);
    if (!stat.isDirectory()) findings.push(finding('error', 'WORKSPACE_NOT_DIRECTORY', 'Workspace is not a directory.'));
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'WORKSPACE_NOT_FOUND' : (error.code || 'WORKSPACE_UNAVAILABLE');
    const message = error.code === 'ENOENT' ? 'Workspace does not exist.' : error.message;
    findings.push(finding('error', code, message));
    mechanicalSafetyBackstop = safetyCapability('degraded', 'WORKSPACE_UNAVAILABLE', 'doctor');
    brokeredDataBoundary = unavailableBoundaryCapability('WORKSPACE_UNAVAILABLE');
    return summarize(workspace, null, findings, capabilityEnvelope(mechanicalSafetyBackstop, brokeredDataBoundary));
  }

  if (!context.mutationLockHeldByCaller) {
    try {
      const lock = await inspectMutationLock(workspace);
      if (lock.status === 'present') {
        findings.push(finding('warning', 'MUTATION_LOCK_PRESENT', 'A cooperative workspace mutation lock is present. It may be active or orphaned; Scalvin will never remove it automatically.', {
          lockPath: lock.lockPath,
          lockKind: lock.lockKind,
          ...(lock.ownerPid === undefined ? {} : { ownerPid: lock.ownerPid }),
          ...(lock.acquiredAt === undefined ? {} : { acquiredAt: lock.acquiredAt }),
          recovery: 'manual-only',
          guidance: MUTATION_LOCK_MANUAL_RECOVERY
        }));
      } else if (lock.status === 'unverifiable') {
        findings.push(finding('warning', 'MUTATION_LOCK_CHECK_FAILED', 'The cooperative mutation-lock location cannot be safely inspected and will not be changed automatically.', {
          lockPath: lock.lockPath,
          lockKind: lock.lockKind,
          recovery: 'manual-only',
          guidance: MUTATION_LOCK_MANUAL_RECOVERY
        }));
      } else {
        findings.push(finding('info', 'MUTATION_LOCK_CLEAR', 'No cooperative workspace mutation lock is present.'));
      }
    } catch (error) {
      findings.push(finding('warning', 'MUTATION_LOCK_CHECK_FAILED', 'The cooperative mutation-lock location cannot be safely inspected and will not be changed automatically.', {
        causeCode: error.code || 'INVALID',
        recovery: 'manual-only',
        guidance: MUTATION_LOCK_MANUAL_RECOVERY
      }));
    }
  }

  const stateResult = await loadWorkspaceState(workspace, loaded.manifest);
  let state = null;
  if (stateResult.kind === 'current') {
    state = stateResult.state;
    findings.push(finding('info', 'STATE_SCHEMA_OK', 'Workspace state schema v2 is valid.'));
  } else if (stateResult.kind === 'legacy') {
    findings.push(finding('warning', 'LEGACY_STATE', 'Legacy workspace state requires a pinned update to migrate safely.', { path: stateResult.path }));
  } else if (stateResult.kind === 'corrupt') {
    findings.push(finding('error', 'STATE_CORRUPT', 'Workspace state is corrupt.', { path: stateResult.path, cause: stateResult.error }));
  } else {
    findings.push(finding('error', 'STATE_MISSING', 'Workspace identity state is missing.'));
  }

  if (state) {
    if (!validUuid(state.workspaceId)) findings.push(finding('error', 'WORKSPACE_ID_INVALID', 'Workspace ID is missing or invalid.'));
    else findings.push(finding('info', 'WORKSPACE_ID_OK', 'Workspace identity is valid.'));
    const sameDistribution = state.product.manifestSha256 === loaded.sha256;
    workspaceMatchesDistribution = sameDistribution;
    if (!sameDistribution) findings.push(finding('warning', 'WORKSPACE_MANIFEST_DRIFT', 'Workspace was installed from a different manifest; run a pinned dry-run update.', { installed: state.product.manifestSha256, current: loaded.sha256 }));
    else findings.push(finding('info', 'WORKSPACE_MANIFEST_OK', 'Workspace manifest identity matches this distribution.'));
    if (sameDistribution) {
      const provenanceFields = [];
      if (state.product.version !== loaded.manifest.product.version) provenanceFields.push('product.version');
      if (state.source?.pinType !== 'manifest-sha256') provenanceFields.push('source.pinType');
      if (state.source?.pin !== loaded.sha256) provenanceFields.push('source.pin');
      if (provenanceFields.length) {
        findings.push(finding('error', 'STATE_DISTRIBUTION_PROVENANCE_MISMATCH', 'Canonical distribution provenance does not match the signed manifest.', { fields: provenanceFields }));
      } else {
        findings.push(finding('info', 'STATE_DISTRIBUTION_PROVENANCE_OK', 'Canonical distribution provenance matches the signed manifest.'));
      }
    } else if (state.source?.pinType === 'manifest-sha256' && state.source.pin !== state.product.manifestSha256) {
      findings.push(finding('error', 'STATE_DISTRIBUTION_PROVENANCE_MISMATCH', 'Canonical manifest identity and source pin disagree.', { fields: ['source.pin'] }));
    }
    if (!state.consent || state.consent.status === 'not-decided') findings.push(finding('warning', 'CONSENT_NOT_RECORDED', 'Consent choice has not been recorded; do not write sensitive user content yet.'));
    else if (!['granted', 'declined'].includes(state.consent.status)) findings.push(finding('error', 'CONSENT_STATE_INVALID', 'Consent state is invalid.'));
    else findings.push(finding('info', 'CONSENT_STATE_OK', `Consent state is ${state.consent.status}.`));
    try {
      const controls = (await readBoundedRegularFile(path.join(workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), MAX_CONSENT_PROJECTION_BYTES, {
        typeCode: 'CONSENT_PROJECTION_INVALID', sizeCode: 'CONSENT_PROJECTION_TOO_LARGE', changedCode: 'CONSENT_PROJECTION_CHANGED'
      })).toString('utf8');
      const differences = consentProjectionDifferences(controls, state);
      if (differences.length) findings.push(finding('error', 'CONSENT_PROJECTION_MISMATCH', 'Human-readable data controls disagree with canonical workspace state.', { fields: differences.map((item) => item.field) }));
      else findings.push(finding('info', 'CONSENT_PROJECTION_OK', 'Human-readable data controls match canonical workspace state.'));
      const needsLedger = Boolean(state.consent?.eventId || state.consent?.lastOperationalEvent?.eventId);
      const ledger = needsLedger
        ? (await readBoundedRegularFile(path.join(workspace, '.therapy', 'state', 'CONSENT-LEDGER.md'), MAX_CONSENT_PROJECTION_BYTES, {
          typeCode: 'CONSENT_LEDGER_INVALID', sizeCode: 'CONSENT_LEDGER_TOO_LARGE', changedCode: 'CONSENT_LEDGER_CHANGED'
        })).toString('utf8')
        : null;
      if (state.consent?.eventId) {
        if (!ledger.includes(`| ${state.consent.eventId} |`)) findings.push(finding('error', 'CONSENT_LEDGER_EVENT_MISSING', 'Canonical consent event is missing from the consent ledger.'));
        else findings.push(finding('info', 'CONSENT_LEDGER_OK', 'Canonical consent event is present in the content-free ledger.'));
      }
      if (state.consent?.lastOperationalEvent?.eventId) {
        if (!ledger.includes(`| ${state.consent.lastOperationalEvent.eventId} |`)) findings.push(finding('error', 'CONTROL_LEDGER_EVENT_MISSING', 'Canonical operational-control event is missing from the content-free ledger.'));
        else findings.push(finding('info', 'CONTROL_LEDGER_OK', 'Canonical operational-control event is present in the content-free ledger.'));
      }
    } catch (error) {
      findings.push(finding('error', 'CONSENT_PROJECTION_UNREADABLE', 'Consent projection or ledger cannot be read.', { causeCode: error.code || 'INVALID' }));
    }

    const sourceEntries = new Map(loaded.manifest.files.map((entry) => [entry.path, entry]));
    let expectedTargets = new Map();
    try {
      const buffers = new Map();
      for (const entry of loaded.manifest.files) buffers.set(entry.path, await readSourceFile(loaded, entry));
      const validatedPreferences = normalizePreferences(loaded.manifest, {}, state.preferences);
      expectedTargets = new Map(buildTargetPlan(loaded.manifest, buffers, validatedPreferences).map((item) => [item.target, item]));
    } catch (error) {
      findings.push(finding('error', 'EXPECTED_TARGET_BUILD_FAILED', 'Could not derive expected managed targets from the signed manifest.', { cause: error.message }));
    }
    for (const [target, record] of Object.entries(state.files || {})) {
      try {
        validateRelativePath(target);
        const expected = expectedTargets.get(target);
        const signedRole = expected?.role || record.role;
        const signedProtection = expected?.protection || record.protection;
        const safetyCritical = /hook|safety-protocol/i.test(signedRole);
        if (sameDistribution && expected) {
          const registryFields = ['sourcePath', 'sourceHash', 'version', 'role', 'protection']
            .filter((field) => record[field] !== expected[field]);
          if (registryFields.length) {
            findings.push(finding('error', 'STATE_TARGET_REGISTRY_MISMATCH', 'Canonical managed-target metadata does not match the signed manifest-derived target.', {
              target, role: expected.role, protection: expected.protection, fields: registryFields
            }));
          }
          if (!['seed', 'protected'].includes(expected.protection) && record.installedHash !== expected.installedHash) {
            findings.push(finding('error', 'STATE_INSTALLED_BASELINE_MISMATCH', 'Canonical installed baseline does not match the signed manifest-derived target.', {
              target,
              role: expected.role,
              protection: expected.protection,
              expectedHash: expected.installedHash,
              recordedHash: record.installedHash
            }));
          }
        }
        const filename = path.join(workspace, target);
        await rejectSymlinkPath(filename, { allowMissing: true });
        if (!(await pathExists(filename))) {
          const severity = signedProtection === 'seed' || signedProtection === 'protected' ? 'warning' : 'error';
          findings.push(finding(severity, 'MANAGED_FILE_MISSING', 'Managed file is missing.', { target, role: record.role }));
          continue;
        }
        const actual = await sha256File(filename);
        if (actual !== record.installedHash) {
          const severity = safetyCritical ? 'error' : signedProtection === 'framework' ? 'warning' : 'info';
          findings.push(finding(severity, 'MANAGED_FILE_CUSTOMIZED', 'Managed file differs from its installed baseline.', { target, role: signedRole, protection: signedProtection }));
        }
        const source = sourceEntries.get(record.sourcePath);
        if (!source) findings.push(finding('warning', 'SOURCE_NO_LONGER_REGISTERED', 'Installed file source is not present in this distribution manifest.', { target, sourcePath: record.sourcePath }));
        else if (record.sourceHash !== source.sha256 || record.version !== source.version) {
          findings.push(finding(sameDistribution ? 'error' : 'warning', 'STATE_SOURCE_REGISTRY_MISMATCH', 'Installed source hash/version differs from the signed distribution registry.', {
            target, sourcePath: record.sourcePath, expectedHash: source.sha256, installedHash: record.sourceHash,
            expectedVersion: source.version, installedVersion: record.version
          }));
        }
        if (expected && !['seed', 'protected'].includes(expected.protection) && actual !== expected.installedHash) {
          findings.push(finding(safetyCritical ? 'error' : 'warning', safetyCritical ? 'SAFETY_CRITICAL_HASH_MISMATCH' : 'SIGNED_TARGET_MISMATCH', 'Managed target does not match the signed manifest-derived content.', {
            target, role: record.role, expected: expected.installedHash, actual
          }));
        }
      } catch (error) {
        findings.push(finding('error', error.code || 'MANAGED_FILE_CHECK_FAILED', error.message, { target }));
      }
    }
    for (const [target, expected] of expectedTargets) {
      const record = state.files?.[target];
      if (!record) {
        const critical = ['framework', 'active'].includes(expected.protection);
        findings.push(finding(sameDistribution && critical ? 'error' : 'warning', 'EXPECTED_MANAGED_TARGET_MISSING', 'A manifest-selected target is absent from canonical state.', { target, role: expected.role, protection: expected.protection }));
      }
    }
    for (const [target, record] of Object.entries(state.files || {})) {
      if (!expectedTargets.has(target)) {
        findings.push(finding(sameDistribution ? 'error' : 'warning', 'UNEXPECTED_MANAGED_TARGET', 'Canonical state contains a target not selected by the manifest and preferences.', { target, role: record.role, protection: record.protection }));
      }
    }
  }

  findings.push(...await checkExternalCareProvenance(workspace));
  findings.push(...await checkSourceLifecycle(workspace, state));
  findings.push(...await checkBackupLedger(workspace, state));

  const journalPath = path.join(workspace, JOURNAL_RELATIVE);
  if (await pathExists(journalPath)) {
    try {
      const lines = (await readBoundedRegularFile(journalPath, MAX_JOURNAL_BYTES, {
        typeCode: 'OPERATION_JOURNAL_INVALID', sizeCode: 'OPERATION_JOURNAL_INVALID', changedCode: 'OPERATION_JOURNAL_CHANGED'
      })).toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) validateReceipt(JSON.parse(line));
      findings.push(finding('info', 'OPERATION_JOURNAL_OK', 'Content-free failed-operation receipts are structurally valid.', { count: lines.length }));
    } catch (error) {
      findings.push(finding('error', 'OPERATION_JOURNAL_INVALID', 'Failed-operation journal is invalid.', { causeCode: error.code || 'INVALID' }));
    }
  }

  const tracked = await checkSensitiveGitTracking(workspace);
  if (tracked.some((item) => typeof item === 'object')) findings.push(finding('warning', 'GIT_CHECK_FAILED', 'Could not verify sensitive Git tracking.', tracked[0]));
  else if (tracked.length) findings.push(finding('error', 'SENSITIVE_FILES_TRACKED', 'Sensitive living-workspace files are tracked by Git.', { files: tracked }));
  else findings.push(finding('info', 'SENSITIVE_FILES_NOT_TRACKED', 'No sensitive living-workspace paths are tracked by Git.'));

  const ignoreFile = path.join(workspace, '.gitignore');
  if (!(await pathExists(ignoreFile))) {
    findings.push(finding('error', 'WORKSPACE_GITIGNORE_MISSING', 'Workspace privacy .gitignore is missing.'));
  } else {
    try {
      const ignore = (await readBoundedRegularFile(ignoreFile, MAX_GITIGNORE_BYTES, {
        typeCode: 'WORKSPACE_GITIGNORE_INVALID', sizeCode: 'WORKSPACE_GITIGNORE_TOO_LARGE', changedCode: 'WORKSPACE_GITIGNORE_CHANGED'
      })).toString('utf8');
      const required = ['profile.md', 'sessions/', 'sources/', 'archive/', '.therapy/', '.scalvin/'];
      const defaultDeny = /^\s*\*\s*$/m.test(ignore);
      const missing = defaultDeny ? [] : required.filter((pattern) => !ignore.includes(pattern));
      if (missing.length) findings.push(finding('error', 'WORKSPACE_GITIGNORE_INCOMPLETE', 'Workspace privacy .gitignore is incomplete.', { missing }));
      else findings.push(finding('info', 'WORKSPACE_GITIGNORE_OK', 'Workspace privacy ignore rules are present.'));
    } catch (error) {
      findings.push(finding('error', 'WORKSPACE_GITIGNORE_INVALID', 'Workspace privacy .gitignore cannot be safely read.', { causeCode: error.code || 'INVALID' }));
    }
  }

  try {
    const parent = path.dirname(workspace);
    const prefix = `${path.basename(workspace)}.rollback.`;
    const retained = (await fsp.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .slice(0, 25)
      .map((entry) => path.join(parent, entry.name));
    if (retained.length) {
      findings.push(finding('warning', 'PRIVATE_ROLLBACK_RETAINED', 'One or more private activation rollback containers require explicit cleanup.', {
        count: retained.length,
        paths: retained
      }));
    } else {
      findings.push(finding('info', 'PRIVATE_ROLLBACKS_CLEAR', 'No retained private activation rollback container was found.'));
    }
  } catch (error) {
    findings.push(finding('warning', 'PRIVATE_ROLLBACK_CHECK_FAILED', 'Retained private rollback containers could not be checked.', { causeCode: error.code || 'INVALID' }));
  }

  if (process.platform !== 'win32') {
    try {
      const permissionProblems = [];
      const rootStat = await fsp.stat(workspace);
      if ((rootStat.mode & 0o777) !== PRIVATE_DIR_MODE) permissionProblems.push({ path: '.', expected: '0700', actual: (rootStat.mode & 0o777).toString(8) });
      const entries = await walkTree(workspace);
      for (const entry of entries) {
        const expected = entry.type === 'directory' ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE;
        if (entry.mode !== expected) permissionProblems.push({ path: entry.path, expected: expected.toString(8).padStart(4, '0'), actual: entry.mode.toString(8).padStart(4, '0') });
        if (permissionProblems.length >= 25) break;
      }
      if (process.platform === 'darwin') {
        const acl = await verifyDarwinNoAcl(workspace, { recursive: true });
        if (!acl.ok) permissionProblems.push({ path: '.', expected: 'no extended ACL', actual: 'extended ACL present or unverifiable' });
      }
      if (permissionProblems.length) findings.push(finding('warning', 'PERMISSIONS_TOO_BROAD', 'Workspace permissions or access-control lists are not private.', { files: permissionProblems }));
      else findings.push(finding('info', 'PERMISSIONS_OK', 'Workspace permissions are private and no broad access-control list is present.'));
    } catch (error) {
      findings.push(finding('error', 'WORKSPACE_TREE_INVALID', 'Workspace tree cannot be safely inspected.', { causeCode: error.code || 'INVALID' }));
    }
  } else {
    const acl = await verifyWindowsPrivateAcl(workspace);
    if (acl.ok) findings.push(finding('info', 'WINDOWS_ACL_OK', 'Workspace root ACL is protected; tree ownership and effective access are limited to the current user, SYSTEM, and built-in administrators.'));
    else findings.push(finding('error', 'WINDOWS_ACL_INVALID', 'Workspace does not have the required private Windows ACL.', { cause: acl.error }));
  }

  const boundaryAssessment = await assessBrokeredDataBoundary(
    workspace,
    context,
    loaded.manifest,
    distributionErrors,
    state
  );
  brokeredDataBoundary = boundaryAssessment.capability;
  findings.push(...boundaryAssessment.findings);

  const hookEntries = loaded.manifest.files.filter((entry) => /hook/i.test(entry.role));
  const integration = loaded.manifest.clientIntegrations?.claude;
  const safetyHook = integration?.hooks?.find((hook) => /(?:^|\/)safety-net\.cjs$/.test(hook.target));
  if (!safetyHook) {
    mechanicalSafetyBackstop = safetyCapability('unsupported', 'CLIENT_HOOK_NOT_DECLARED', 'manifest');
    findings.push(finding('info', 'SAFETY_HOOK_UNSUPPORTED', 'No mechanical safety prompt hook is declared for this client integration; the prose safety protocol remains authoritative.'));
    if (!hookEntries.length) findings.push(finding('info', 'HOOKS_NOT_DECLARED', 'No client hook is declared for this distribution; runtime safety remains authoritative.'));
  } else {
    findings.push(finding('info', 'HOOK_FILES_REGISTERED', 'Declared hook files are covered by managed-file integrity checks.', { count: hookEntries.length }));
    let safetyRegistrationAvailable = false;
    try {
      const settings = JSON.parse((await readBoundedRegularFile(path.join(workspace, integration.settingsPath), MAX_CLIENT_SETTINGS_BYTES, {
        typeCode: 'HOOK_SETTINGS_INVALID', sizeCode: 'HOOK_SETTINGS_TOO_LARGE', changedCode: 'HOOK_SETTINGS_CHANGED'
      })).toString('utf8'));
      const missingHooks = integration.hooks
        .map((hook) => `node "${hook.target}"`)
        .filter((command) => !containsCommand(settings, command));
      safetyRegistrationAvailable = containsCommand(settings, `node "${safetyHook.target}"`);
      if (missingHooks.length) findings.push(finding('error', 'HOOK_REGISTRATION_MISSING', 'One or more declared Claude hooks are not registered.', { count: missingHooks.length }));
      else findings.push(finding('info', 'HOOK_REGISTRATION_OK', 'Declared Claude hooks are surgically registered.'));
    } catch (error) {
      findings.push(finding('error', 'HOOK_SETTINGS_INVALID', 'Claude hook settings are missing or invalid.', { causeCode: error.code || 'INVALID' }));
    }

    const integrityError = !state
      || !workspaceMatchesDistribution
      || !state.files?.[safetyHook.target]
      || hasSafetyIntegrityError(findings, safetyHook.target);
    const probe = integrityError
      ? safetyCapability('degraded', 'HOOK_INTEGRITY_UNVERIFIED', 'doctor')
      : await probeMechanicalSafetyHook(workspace, safetyHook.target);
    if (!safetyRegistrationAvailable) {
      mechanicalSafetyBackstop = safetyCapability('degraded', 'HOOK_REGISTRATION_UNAVAILABLE', 'doctor');
    } else {
      mechanicalSafetyBackstop = probe;
    }

    if (mechanicalSafetyBackstop.state === 'available') {
      findings.push(finding('info', 'SAFETY_HOOK_HEALTH_AVAILABLE', 'The installed mechanical safety hook passed its synthetic content-free runtime self-test.'));
    } else {
      findings.push(finding('warning', 'SAFETY_HOOK_HEALTH_DEGRADED', 'The mechanical safety hook is degraded; prompt submission remains fail-open and the prose safety protocol remains authoritative.', {
        reasonCode: mechanicalSafetyBackstop.reasonCode
      }));
    }
  }

  const localPointerRoot = process.env.SCALVIN_LOCAL_STATE_DIR
    ? path.resolve(process.env.SCALVIN_LOCAL_STATE_DIR)
    : context.distributionRoot;
  const localPointer = process.env.SCALVIN_LOCAL_STATE_DIR
    ? path.join(localPointerRoot, 'local-state.json')
    : path.join(localPointerRoot, loaded.manifest.state?.localPointer || '.scalvin/local-state.json');
  if (process.env.SCALVIN_DISABLE_LOCAL_POINTER !== '1'
    && await pathExists(path.join(context.distributionRoot, '.git'))) {
    try {
      const pointer = JSON.parse((await readBoundedRegularFile(localPointer, MAX_LOCAL_POINTER_BYTES, {
        typeCode: 'LOCAL_POINTER_INVALID', sizeCode: 'LOCAL_POINTER_TOO_LARGE', changedCode: 'LOCAL_POINTER_CHANGED'
      })).toString('utf8'));
      if (pointer.workspacePath !== workspace || (state?.workspaceId && pointer.workspaceId !== state.workspaceId)) {
        findings.push(finding('warning', 'LOCAL_POINTER_MISMATCH', 'Source-repository local workspace pointer does not match this workspace.'));
      } else findings.push(finding('info', 'LOCAL_POINTER_OK', 'Source-repository local workspace pointer matches.'));
    } catch (error) {
      findings.push(finding('warning', 'LOCAL_POINTER_MISSING', 'Source-repository local workspace pointer is missing or invalid.', { causeCode: error.code || 'INVALID' }));
    }
  }

  try {
    await fsp.access(path.dirname(workspace), fsp.constants.W_OK);
    const token = crypto.randomUUID();
    if (typeof token !== 'string') throw new Error('Secure random unavailable.');
    findings.push(finding('info', 'RESTORE_CAPABILITY_OK', 'Backup staging and atomic sibling restore prerequisites are available.'));
  } catch (error) {
    findings.push(finding('error', 'RESTORE_CAPABILITY_FAILED', 'Restore staging prerequisites are unavailable.', { cause: error.message }));
  }

  return summarize(workspace, state?.workspaceId || null, findings, capabilityEnvelope(mechanicalSafetyBackstop, brokeredDataBoundary));
}

function summarize(workspace, workspaceId, findings, capabilities = capabilityEnvelope(safetyCapability('degraded', 'DOCTOR_INCOMPLETE', 'doctor'))) {
  const errors = findings.filter((item) => item.severity === 'error').length;
  const warnings = findings.filter((item) => item.severity === 'warning').length;
  return {
    status: errors ? 'errors' : warnings ? 'warnings' : 'healthy',
    workspacePath: workspace,
    workspaceId,
    errors,
    warnings,
    findings,
    capabilities,
    nextAction: errors ? 'repair-errors' : warnings ? 'review-warnings' : 'none'
  };
}

module.exports = {
  runDoctor,
  summarize,
  probeMechanicalSafetyHook,
  probeCapabilityBroker,
  probeIsolatedSourceWorker,
  inspectClientBoundaryArtifacts,
  assessBrokeredDataBoundary,
  checkSensitiveGitTracking,
  parseFrontmatter,
  checkExternalCareProvenance,
  checkSourceLifecycle,
  checkBackupLedger
};
