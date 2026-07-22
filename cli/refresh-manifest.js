#!/usr/bin/env node
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { sha256File, atomicWriteFile } = require('./lib/fs-safe');
const { validateManifest } = require('./lib/manifest');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const ROOT_FILES = ['safety-protocol.md', 'commands.md'];
const ROOTS = ['personas', 'modalities', 'structures', 'runtime', 'adapters/workspace', 'templates', 'hooks', 'schemas'];
const ALLOWED_EXTENSIONS = new Set(['.js', '.md', '.py', '.cjs', '.template', '.json', '.toml']);
const PACKAGE_FILES = require('../package.json').files;

async function discoverFiles() {
  const output = [...ROOT_FILES];
  async function visit(relativeDirectory) {
    const absolute = path.join(ROOT, relativeDirectory);
    let entries;
    try {
      entries = await fsp.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
      const relative = `${relativeDirectory}/${entry.name}`.replaceAll('\\', '/');
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name))) {
        if (/\/test_[^/]+\.py$/.test(relative)) continue;
        output.push(relative);
      }
    }
  }
  // Hash exactly the executable bin/CLI closure shipped by npm. Walking the
  // entire source-only cli directory would put development helpers in the
  // manifest even though they are absent from an installed package, making a
  // clean packed install fail its own distribution-integrity check.
  for (const packaged of PACKAGE_FILES.filter((entry) => entry === 'bin/' || entry.startsWith('cli/'))) {
    const relative = packaged.replace(/\/$/, '');
    const stat = await fsp.lstat(path.join(ROOT, relative));
    if (stat.isDirectory()) await visit(relative);
    else if (stat.isFile() && ALLOWED_EXTENSIONS.has(path.extname(relative))) output.push(relative);
  }
  for (const root of ROOTS) await visit(root);
  return [...new Set(output)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

async function versionOf(relative, productVersion) {
  const content = await fsp.readFile(path.join(ROOT, relative), 'utf8');
  const match = content.match(/(?:<!--\s*version:\s*|^#\s*version:\s*)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/mi);
  return match?.[1] || productVersion;
}

function baseTarget(targetPath, protection, extras = {}) {
  return { path: targetPath, protection, ...extras };
}

function stripTemplate(relative) {
  return relative.replace(/\.template(?=\.[^.]+$)/, '');
}

function infer(relative) {
  const name = path.posix.basename(relative);
  const stem = name.replace(/\.(?:md|py|cjs)$/, '').replace(/\.template$/, '');
  if (relative.startsWith('bin/') || relative.startsWith('cli/')) {
    return { role: 'distribution-code', protection: 'framework', targets: [] };
  }
  if (relative === 'safety-protocol.md') {
    return { role: 'safety-protocol', protection: 'framework', targets: [baseTarget('.therapy/safety-protocol.md', 'framework')] };
  }
  if (relative === 'commands.md') {
    return { role: 'command-router', protection: 'framework', targets: [baseTarget('.therapy/commands.md', 'framework')] };
  }
  if (relative.startsWith('personas/')) {
    return {
      role: 'persona', protection: 'framework',
      targets: [
        baseTarget(`.therapy/library/${relative}`, 'framework'),
        baseTarget('.therapy/persona.md', 'active', { activation: { group: 'persona', name: stem } })
      ]
    };
  }
  if (relative.startsWith('modalities/')) {
    return {
      role: 'modality', protection: 'framework',
      targets: [
        baseTarget(`.therapy/library/${relative}`, 'framework'),
        baseTarget(`.therapy/modalities/${name}`, 'active', { activation: { group: 'modality', name: stem } })
      ]
    };
  }
  if (relative.startsWith('structures/')) {
    return {
      role: 'session-structure', protection: 'framework',
      targets: [
        baseTarget(`.therapy/library/${relative}`, 'framework'),
        baseTarget('.therapy/session-structure.md', 'active', { activation: { group: 'structure', name: stem } })
      ]
    };
  }
  if (relative.startsWith('runtime/')) {
    const targets = [baseTarget(`.therapy/library/${relative}`, 'framework')];
    if (name.includes('.template.')) {
      const rootMap = {
        'profile.template.md': 'profile.md',
        'ACTIVE-THEMES.template.md': 'ACTIVE-THEMES.md',
        'CURRENT-FOCUS.template.md': 'CURRENT-FOCUS.md',
        'NEXT-PRIMER.template.md': 'NEXT-PRIMER.md',
        'SETUP-NOTES.template.md': 'SETUP-NOTES.md'
      };
      if (rootMap[name]) targets.push(baseTarget(rootMap[name], 'seed', { render: 'placeholders' }));
      return { role: 'living-template', protection: 'seed', targets };
    }
    targets.push(baseTarget(`.therapy/runtime/${name}`, 'framework'));
    if (name === 'START-SESSION.md') targets.push(baseTarget('START-SESSION.md', 'active'));
    return { role: name === 'START-SESSION.md' ? 'session-entrypoint' : 'runtime', protection: 'framework', targets };
  }
  if (relative.startsWith('adapters/workspace/')) {
    const targets = [baseTarget(`.therapy/library/${relative}`, 'framework')];
    const rootMap = {
      'AGENTS.template.md': 'AGENTS.md',
      'CLAUDE.template.md': 'CLAUDE.md',
      'START-CODEX-SESSION.template.md': 'START-CODEX-SESSION.md',
      'START-CLAUDE-SESSION.template.md': 'START-CLAUDE-SESSION.md',
      'STARTER.template.md': '{{COMPANION_SLUG}}.md',
      'codex.config.template.toml': '.codex/config.toml'
    };
    if (rootMap[name]) targets.push(baseTarget(rootMap[name], 'active', { render: 'placeholders' }));
    return { role: 'client-adapter', protection: 'framework', targets };
  }
  if (relative.startsWith('hooks/')) {
    if (relative.startsWith('hooks/safety-locales/')) {
      return {
        role: 'client-hook-data:safety-locale', protection: 'framework',
        targets: [baseTarget(`.therapy/${relative}`, 'framework')]
      };
    }
    if (/^hooks\/emergency-resources\.(?:cjs|json)$/.test(relative)) {
      return {
        role: 'client-hook-data:emergency-resources', protection: 'framework',
        targets: [baseTarget(`.therapy/hooks/${name}`, 'framework')]
      };
    }
    return { role: `client-hook:${stem}`, protection: 'framework', targets: [baseTarget(`.therapy/hooks/${name}`, 'framework')] };
  }
  if (relative.startsWith('schemas/')) {
    return { role: 'manifest-schema', protection: 'framework', targets: [baseTarget(`.therapy/library/${relative}`, 'framework')] };
  }
  if (relative.startsWith('templates/')) {
    const inner = relative.slice('templates/'.length);
    const targets = [baseTarget(`.therapy/templates/${inner}`, 'framework')];
    const active = new Map([
      ['workspace/README.template.md', 'README.md'],
      ['workspace/gitignore.template', '.gitignore'],
      ['archive/README.template.md', 'archive/README.md'],
      ['archive/reviews/REVIEW-INDEX.template.md', 'archive/reviews/REVIEW-INDEX.md'],
      ['sources/README.template.md', 'sources/README.md'],
      ['state/README.template.md', '.therapy/state/README.md'],
      ['state/BACKUP-LEDGER.template.md', '.therapy/state/BACKUP-LEDGER.md'],
      ['state/CHANGE-LOG.template.md', '.therapy/state/CHANGE-LOG.md'],
      ['state/CONSENT-LEDGER.template.md', '.therapy/state/CONSENT-LEDGER.md'],
      ['state/DATA-CONTROLS.template.md', '.therapy/state/DATA-CONTROLS.md'],
      ['state/DELETION-LEDGER.template.md', '.therapy/state/DELETION-LEDGER.md'],
      ['state/SOURCE-LEDGER.template.md', '.therapy/state/SOURCE-LEDGER.md'],
      ['user-overrides/README.template.md', '.therapy/user-overrides/README.md']
    ]).get(inner);
    if (active) targets.push(baseTarget(active, active === '.gitignore' || active === 'README.md' ? 'framework' : 'seed', { render: 'placeholders' }));
    return { role: 'workspace-template', protection: active?.startsWith('.therapy/state/') ? 'protected' : 'framework', targets };
  }
  throw new Error(`No manifest inference rule for ${relative}`);
}

async function buildManifest(existing) {
  const discovered = await discoverFiles();
  const oldEntries = new Map((existing.files || []).map((entry) => [entry.path, entry]));
  const files = [];
  for (const relative of discovered) {
    const inferred = infer(relative);
    const old = oldEntries.get(relative);
    files.push({
      path: relative,
      source: `repo:${relative}`,
      version: await versionOf(relative, existing.product.version),
      sha256: await sha256File(path.join(ROOT, relative)),
      role: inferred.role,
      protection: inferred.protection,
      targets: inferred.targets,
      ...(old?.notes ? { notes: old.notes } : {})
    });
  }
  const hookTargets = files
    .filter((entry) => entry.role.startsWith('client-hook:') && entry.path.endsWith('.cjs'))
    .flatMap((entry) => entry.targets.filter((target) => target.path.startsWith('.therapy/hooks/')).map((target) => target.path));
  return {
    ...existing,
    clientIntegrations: {
      ...existing.clientIntegrations,
      claude: {
        settingsPath: '.claude/settings.json',
        event: 'UserPromptSubmit',
        hooks: hookTargets.map((target) => ({ target, command: `node ${target}`, timeoutSeconds: 2 }))
      }
    },
    files
  };
}

async function main() {
  const check = process.argv.includes('--check');
  const existingRaw = await fsp.readFile(MANIFEST_PATH, 'utf8');
  const existing = JSON.parse(existingRaw);
  const refreshed = await buildManifest(existing);
  validateManifest(refreshed);
  const output = `${JSON.stringify(refreshed, null, 2)}\n`;
  if (check) {
    if (output !== existingRaw) {
      process.stderr.write('manifest.json is stale; run npm run manifest:refresh\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(`manifest verified: ${refreshed.files.length} files\n`);
    }
    return;
  }
  await atomicWriteFile(MANIFEST_PATH, output, { mode: 0o644 });
  process.stdout.write(`manifest refreshed: ${refreshed.files.length} files\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
