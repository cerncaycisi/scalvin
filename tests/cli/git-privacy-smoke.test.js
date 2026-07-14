'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'scalvin.js');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: options.encoding,
    timeout: options.timeout || 60_000,
    windowsHide: true
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${String(result.stdout || '')}\nstderr:\n${String(result.stderr || '')}`
  );
  return result;
}

function sourceStatus() {
  return run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout;
}

test('fresh CLI bootstrap stays outside the source repo and a real Git init sees no private workspace files', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-git-privacy-'));
  const workspace = path.join(base, 'workspace');
  t.after(() => fsp.rm(base, { recursive: true, force: true }));

  const before = sourceStatus();
  const env = {
    ...process.env,
    SCALVIN_LOCAL_STATE_DIR: path.join(base, 'local-state')
  };
  delete env.SCALVIN_ALLOW_REPO_TARGET;
  delete env.SCALVIN_DISABLE_LOCAL_POINTER;

  const installed = run(process.execPath, [
    CLI,
    'install',
    '--workspace', workspace,
    '--consent', 'granted',
    '--non-interactive',
    '--json'
  ], { env, encoding: 'utf8' });
  const result = JSON.parse(installed.stdout);
  assert.equal(result.status, 'ready');
  assert.equal(path.resolve(result.workspacePath), path.resolve(workspace));

  run('git', ['init', '--quiet'], { cwd: workspace });
  const workspaceStatus = run(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: workspace }
  ).stdout;
  assert.deepEqual(
    workspaceStatus.toString('utf8').split('\0').filter(Boolean),
    ['?? .gitignore', '?? README.md'],
    'anything beyond the generic Git policy and workspace README escaped the default-deny .gitignore'
  );

  const after = sourceStatus();
  assert.deepEqual(after, before, 'bootstrap changed the public source repository status');
});
