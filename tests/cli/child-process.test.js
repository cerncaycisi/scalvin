'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { workerEnvironment, interactiveEnvironment } = require('../../cli/lib/child-process');
const { runBoundedClient, cleanEnvironment } = require('../../cli/client-launcher');

const SYNTHETIC = {
  PATH: '/usr/bin',
  HOME: '/home/synthetic',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  HTTPS_PROXY: 'http://proxy.invalid:8080',
  OPENAI_API_KEY: 'synthetic-openai',
  ANTHROPIC_API_KEY: 'synthetic-anthropic',
  UNRELATED_SERVICE_TOKEN: 'synthetic-unrelated',
  NODE_OPTIONS: '--require /tmp/synthetic-inject.js',
  LD_PRELOAD: '/tmp/synthetic.so',
  SCALVIN_SUPERVISOR_TOKEN: 'synthetic-internal'
};

test('source-worker environment is an explicit per-client allowlist', () => {
  const codex = workerEnvironment('codex', SYNTHETIC);
  assert.deepEqual(Object.keys(codex).sort(), ['HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'OPENAI_API_KEY', 'PATH']);
  const claude = workerEnvironment('claude', SYNTHETIC);
  assert.deepEqual(Object.keys(claude).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'PATH']);
  assert.throws(() => workerEnvironment('generic', SYNTHETIC), /Unknown client/);
  // Windows environment names are case-insensitive.
  assert.deepEqual(workerEnvironment('codex', { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', node_options: '--x' }), {
    Path: 'C:\\Windows',
    SystemRoot: 'C:\\Windows'
  });
});

test('interactive environment keeps the user environment minus internal and injection variables', () => {
  const env = interactiveEnvironment(SYNTHETIC);
  assert.equal(env.UNRELATED_SERVICE_TOKEN, 'synthetic-unrelated');
  assert.equal(env.OPENAI_API_KEY, 'synthetic-openai');
  assert.equal('NODE_OPTIONS' in env, false);
  assert.equal('LD_PRELOAD' in env, false);
  assert.equal('SCALVIN_SUPERVISOR_TOKEN' in env, false);
});

test('launcher worker environment drops unrelated parent variables', () => {
  const previous = process.env.SCALVIN_TEST_UNRELATED_MARKER;
  process.env.UNRELATED_MARKER_FOR_WORKER_TEST = 'synthetic';
  try {
    const env = cleanEnvironment('codex');
    assert.equal('UNRELATED_MARKER_FOR_WORKER_TEST' in env, false);
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    delete process.env.UNRELATED_MARKER_FOR_WORKER_TEST;
    if (previous !== undefined) process.env.SCALVIN_TEST_UNRELATED_MARKER = previous;
  }
});

function running(pid) {
  try {
    // A killed helper can linger briefly as a zombie until init reaps it.
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z';
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertAllExited(pids) {
  for (let attempt = 0; attempt < 40 && pids.some(running); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const pid of pids) assert.equal(running(pid), false, `process ${pid} survived termination`);
}

async function stubbornChild(t, body) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-child-process-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'pids.json');
  const script = path.join(root, 'child.js');
  await fsp.writeFile(script, [
    "'use strict';",
    "const { spawn } = require('node:child_process');",
    "process.on('SIGTERM', () => {});",
    "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, grandchild.pid]));`,
    body
  ].join('\n'));
  return { script, pidFile, cwd: root };
}

async function waitForFile(filename) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filename)) return JSON.parse(fs.readFileSync(filename, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('child did not start');
}

test('output overflow terminates a SIGTERM-ignoring worker and its helpers before reporting', { skip: process.platform === 'win32' }, async (t) => {
  const child = await stubbornChild(t, [
    "setTimeout(() => {",
    "  const chunk = Buffer.alloc(1024 * 1024, 0x61);",
    "  for (let i = 0; i < 9; i += 1) process.stdout.write(chunk);",
    "  setInterval(() => {}, 1000);",
    "}, 100);"
  ].join('\n'));
  const started = Date.now();
  const run = runBoundedClient({ command: process.execPath, args: [child.script], cwd: child.cwd, env: { PATH: process.env.PATH } }, 30_000, { graceMs: 200, confirmMs: 2_000 });
  const pids = await waitForFile(child.pidFile);
  await assert.rejects(run, { code: 'SOURCE_WORKER_OUTPUT_TOO_LARGE' });
  assert.ok(Date.now() - started < 10_000);
  await assertAllExited(pids);
});

test('timeout uses the same bounded termination path', { skip: process.platform === 'win32' }, async (t) => {
  const child = await stubbornChild(t, 'setInterval(() => {}, 1000);');
  const run = runBoundedClient({ command: process.execPath, args: [child.script], cwd: child.cwd, env: { PATH: process.env.PATH } }, 400, { graceMs: 200, confirmMs: 2_000 });
  const pids = await waitForFile(child.pidFile);
  await assert.rejects(run, { code: 'SOURCE_WORKER_TIMEOUT' });
  await assertAllExited(pids);
});

test('a successful worker leaves no helper processes behind', { skip: process.platform === 'win32' }, async (t) => {
  const child = await stubbornChild(t, 'setTimeout(() => process.exit(0), 100);');
  await runBoundedClient({ command: process.execPath, args: [child.script], cwd: child.cwd, env: { PATH: process.env.PATH } }, 10_000);
  const pids = await waitForFile(child.pidFile);
  await assertAllExited(pids);
});
