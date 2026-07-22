#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blockers = [];
const EXPECTED_ADAPTERS = ['claude-code', 'codex', 'generic'];
const require = createRequire(import.meta.url);

let resourceCheckNow;
const readinessArguments = process.argv.slice(2);
if (readinessArguments.length === 0) {
  resourceCheckNow = undefined;
} else if (readinessArguments.length === 2 && readinessArguments[0] === '--now') {
  resourceCheckNow = readinessArguments[1];
} else {
  blockers.push('The stable-readiness check arguments are invalid.');
}

function block(adapter, message) {
  blockers.push(`[${adapter}] ${message}`);
}

try {
  const { loadRegistry, assessRegistry } = require('../hooks/emergency-resources.cjs');
  const registry = loadRegistry();
  const assessment = assessRegistry(registry, resourceCheckNow);
  if (assessment.state !== 'current') {
    block(
      'safety-resources',
      `the emergency-resource registry is not current (${assessment.reasonCode}; ${assessment.affectedJurisdictions.join(',')}).`
    );
  }
} catch (_) {
  block('safety-resources', 'the emergency-resource registry is unavailable or invalid.');
}

let requiredAdapters = [];
try {
  const policy = JSON.parse(readFileSync(path.join(ROOT, 'evals', 'release-evidence-policy.json'), 'utf8'));
  requiredAdapters = policy.requiredClientAdapters;
  if (!Array.isArray(requiredAdapters) ||
      JSON.stringify([...requiredAdapters].sort()) !== JSON.stringify(EXPECTED_ADAPTERS)) {
    blockers.push('The shipped-adapter release policy is incomplete or unexpected.');
    requiredAdapters = EXPECTED_ADAPTERS;
  }
} catch {
  blockers.push('The shipped-adapter release policy is unavailable.');
  requiredAdapters = EXPECTED_ADAPTERS;
}

const codex = readFileSync(path.join(ROOT, 'adapters', 'workspace', 'codex.config.template.toml'), 'utf8');
if (!/^default_permissions = "scalvin-broker-only"$/m.test(codex)) {
  block('codex', 'the shipped project policy is not the required broker-only profile.');
}
if (!/^required = true$/m.test(codex)) {
  block('codex', 'the local capability broker is not a required client boundary.');
}
if (/^"(?:profile\.md|ACTIVE-THEMES\.md|CURRENT-FOCUS\.md|NEXT-PRIMER\.md|sessions|context|archive)" = "write"$/m.test(codex)) {
  block('codex', 'the shipped policy still grants direct private continuity writes outside the broker.');
}

let claude;
try {
  claude = JSON.parse(readFileSync(path.join(ROOT, 'adapters', 'workspace', 'CLAUDE-PERMISSIONS.template.json'), 'utf8'));
} catch {
  block('claude-code', 'the shipped permission policy is unavailable or invalid.');
}
if (claude) {
  const allow = claude.permissions?.allow;
  const directPrivate = Array.isArray(allow) && allow.some((permission) => (
    /^(?:Read|Edit|Write)\(\/(?:profile\.md|ACTIVE-THEMES\.md|CURRENT-FOCUS\.md|NEXT-PRIMER\.md|sessions\/\*\*|context\/\*\*|archive\/\*\*)\)$/.test(permission)
  ));
  if (directPrivate) {
    block('claude-code', 'the shipped project policy still grants direct private continuity access outside the broker.');
  }
  if (claude.permissions?.disableBypassPermissionsMode !== 'disable' ||
      claude.sandbox?.enabled !== true || claude.sandbox?.failIfUnavailable !== true) {
    block('claude-code', 'the shipped project policy does not fail closed on sandbox or bypass controls.');
  }
}

const generic = readFileSync(path.join(ROOT, 'adapters', 'workspace', 'STARTER.template.md'), 'utf8');
if (/no enforceable private-data boundary/i.test(generic) || /ephemeral-only in the current preview/i.test(generic)) {
  block('generic', 'the shipped adapter explicitly has no enforceable private-data boundary and is preview-only.');
}

// Project files and a broker's own booleans cannot prove the effective client
// launch policy: user, CLI, managed, and additional-tool configuration may
// override them. Stable remains fail-closed until an independently verified,
// candidate-bound effective-launch attestation exists for every shipped
// adapter. No such verifier/evidence contract is shipped in this preview.
for (const adapter of requiredAdapters) {
  block(adapter, 'an independently verified effective-launch hard-boundary attestation for the exact candidate is unavailable.');
}

let broker;
try {
  broker = JSON.parse(execFileSync(process.execPath, [
    path.join(ROOT, 'bin', 'scalvin-mcp.js'), '--self-test', '--json'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }));
} catch {
  blockers.push('The capability broker self-test is unavailable.');
}

if (broker) {
  if (broker.hardBoundaryAttested !== true) {
    blockers.push('The broker self-test reports that the hard private-data boundary is not implemented.');
  }
  if (broker.completeTypedPrivateSurface !== true) {
    blockers.push('The typed private read/write surface is incomplete.');
  }
  if (broker.isolatedSourceWorkerAttested !== true) {
    blockers.push('The isolated tool-free and network-free source worker is not attested.');
  }
}

if (blockers.length) {
  process.stderr.write('Stable release is blocked:\n');
  for (const blocker of blockers) process.stderr.write(`- ${blocker}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Stable release data-boundary readiness: verified.\n');
}
