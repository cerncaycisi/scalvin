'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ScalvinError, invariant } = require('./lib/errors');
const { PRIVATE_DIR_MODE, rejectSymlinkPath, resolvePortablePath } = require('./lib/fs-safe');
const { interactiveEnvironment, terminateChild, missingClaudeSandboxDependencies } = require('./lib/child-process');
const operations = require('./operations');

const execFileAsync = promisify(execFile);
const MAX_SIGNAL_BYTES = 2048;

// The interactive client is the user's own tool: keep the user's environment
// minus Scalvin-internal and interpreter-injection variables.
function cleanEnvironment() {
  return interactiveEnvironment();
}

async function resolveInteractiveClient(client, explicit) {
  invariant(['codex', 'claude'].includes(client), 'Client must be codex or claude.', 'CLIENT_LAUNCH_INVALID');
  const candidates = explicit !== undefined
    ? [explicit]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, process.platform === 'win32' ? `${client}.exe` : client));
  for (const candidate of candidates) {
    try {
      invariant(path.isAbsolute(candidate), 'Client executable must be absolute.', 'CLIENT_LAUNCH_INVALID');
      const resolved = await fsp.realpath(candidate);
      await rejectSymlinkPath(resolved);
      const stat = await fsp.lstat(resolved);
      if (stat.isFile() && !stat.isSymbolicLink()) return resolved;
    } catch (error) {
      if (explicit !== undefined && error instanceof ScalvinError) throw error;
    }
  }
  throw new ScalvinError(`The ${client} client executable is unavailable.`, 'CLIENT_LAUNCH_UNAVAILABLE');
}

async function verifiedClientVersion(executable) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024, env: cleanEnvironment()
    });
    const version = `${stdout}${stderr}`.trim().split(/\r?\n/u)[0];
    invariant(version && version.length <= 200 && !/[\0\r\n]/.test(version), 'Client version is invalid.', 'CLIENT_LAUNCH_INVALID');
    return version;
  } catch (error) {
    if (error instanceof ScalvinError) throw error;
    throw new ScalvinError('The client version could not be verified.', 'CLIENT_LAUNCH_UNAVAILABLE');
  }
}

async function createSealSupervisor() {
  const token = `supervisor-${crypto.randomUUID()}`;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-client-supervisor-'));
  if (process.platform !== 'win32') await fsp.chmod(root, PRIVATE_DIR_MODE);
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\scalvin-${crypto.randomUUID()}`
    : path.join(root, 'seal.sock');
  let resolveSignal;
  const signal = new Promise((resolve) => { resolveSignal = resolve; });
  let signaled = false;
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (pending.length + chunk.length > MAX_SIGNAL_BYTES) {
        socket.destroy();
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline === -1) return;
      let value;
      try { value = JSON.parse(pending.subarray(0, newline).toString('utf8')); } catch { socket.destroy(); return; }
      if (!signaled && value?.event === 'sealed_pause' && value?.token === token) {
        signaled = true;
        resolveSignal({ event: 'sealed_pause' });
      }
      socket.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => { server.off('error', reject); resolve(); });
  });
  return {
    endpoint,
    token,
    signal,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function interactiveClientCommand(client, executable, workspace) {
  if (client === 'codex') {
    return {
      command: executable,
      args: [
        '--ignore-user-config', '--ignore-rules', '--strict-config',
        '-C', workspace, '--no-alt-screen',
        '-c', 'history.persistence="none"'
      ]
    };
  }
  return {
    command: executable,
    args: [
      '--strict-mcp-config', '--mcp-config', path.join(workspace, '.mcp.json'),
      '--settings', path.join(workspace, '.claude', 'settings.json'),
      '--setting-sources', 'project', '--permission-mode', 'default',
      '--disable-slash-commands', '--no-chrome'
    ]
  };
}

async function terminateClient(child) {
  await terminateChild(child, { graceMs: 2_000, confirmMs: 2_000 });
}

async function launchSupervisedClient(options = {}) {
  // Resolve `~/...` the same way as every other workspace command.
  const workspace = operations.assertSafeWorkspaceTarget(resolvePortablePath(options.workspace));
  const client = options.client || 'codex';
  const doctor = await operations.doctor({ target: workspace });
  invariant(doctor.errors === 0, 'Workspace doctor must pass before client launch.', 'CLIENT_LAUNCH_DOCTOR_FAILED');
  const boundary = doctor.capabilities?.brokeredDataBoundary;
  invariant(boundary?.broker?.available === true, 'The capability broker is unavailable.', 'CLIENT_LAUNCH_BROKER_UNAVAILABLE');
  invariant(boundary.clients?.[client]?.configuration === 'broker_only_unattested', 'The selected client policy is missing or degraded.', 'CLIENT_LAUNCH_POLICY_DEGRADED');
  if (client === 'claude') {
    const missing = missingClaudeSandboxDependencies();
    invariant(missing.length === 0, `Claude Code's sandbox needs ${missing.join(' and ')} on this Linux host; install them (for example the bubblewrap and socat packages) and relaunch.`, 'CLIENT_SANDBOX_DEPENDENCY_MISSING', { missing });
  }
  const executable = await resolveInteractiveClient(client, options.clientExecutable);
  const version = await verifiedClientVersion(executable);
  const supervisor = await createSealSupervisor();
  const command = interactiveClientCommand(client, executable, workspace);
  const env = {
    ...cleanEnvironment(),
    SCALVIN_SUPERVISOR_ENDPOINT: supervisor.endpoint,
    SCALVIN_SUPERVISOR_TOKEN: supervisor.token
  };
  const child = spawn(command.command, command.args, { cwd: workspace, env, stdio: 'inherit', windowsHide: false });
  let launchError = null;
  const closed = new Promise((resolve) => {
    child.once('error', () => { launchError = new ScalvinError('The client could not start.', 'CLIENT_LAUNCH_UNAVAILABLE'); resolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    const outcome = await Promise.race([
      closed.then((result) => ({ type: 'closed', result })),
      supervisor.signal.then(() => ({ type: 'sealed' }))
    ]);
    if (outcome.type === 'sealed') {
      await terminateClient(child);
      return {
        status: 'sealed-client-terminated',
        client,
        clientVersion: version,
        projectPolicy: 'broker_only',
        brokerRequired: true,
        historyPersistence: client === 'codex' ? 'none' : 'client_default_unattested',
        freshContextRequired: true,
        hardBoundaryAttested: false,
        nextAction: 'resume-memory-out-of-band-then-launch-a-fresh-client'
      };
    }
    if (launchError) throw launchError;
    invariant(outcome.result.code === 0, 'The client exited unsuccessfully.', 'CLIENT_LAUNCH_FAILED');
    return {
      status: 'client-exited',
      client,
      clientVersion: version,
      projectPolicy: 'broker_only',
      brokerRequired: true,
      historyPersistence: client === 'codex' ? 'none' : 'client_default_unattested',
      freshContextRequired: false,
      hardBoundaryAttested: false,
      nextAction: 'none'
    };
  } finally {
    await supervisor.close();
  }
}

module.exports = {
  cleanEnvironment,
  resolveInteractiveClient,
  verifiedClientVersion,
  createSealSupervisor,
  interactiveClientCommand,
  terminateClient,
  launchSupervisedClient
};
