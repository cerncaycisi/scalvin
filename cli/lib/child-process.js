'use strict';

// Environment and termination policy for client child processes.
//
// The isolated source worker reads untrusted source text, so it receives an
// explicit allowlist: operating-system basics, locale, proxy/CA settings, and
// the provider credentials its selected client needs. Everything else,
// including unrelated secrets and runtime-injection variables such as
// NODE_OPTIONS, is dropped.
//
// The interactive client is the user's own tool and keeps the user's
// environment, minus Scalvin-internal variables and interpreter-injection
// variables that would silently change what the launched client executes.

const BASE_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'TZ', 'LANG', 'LANGUAGE',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Windows process basics.
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME'
]);
const BASE_PREFIXES = ['LC_'];

const CLIENT_NAMES = {
  codex: new Set(['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID']),
  claude: new Set([
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
    'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
    'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'
  ])
};

const INJECTION_NAMES = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
  'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  'BASH_ENV', 'ENV', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT'
]);

function isScalvinInternal(upper) {
  return upper.startsWith('SCALVIN_');
}

function workerEnvironment(client, source = process.env) {
  const clientNames = CLIENT_NAMES[client];
  if (!clientNames) throw new Error('Unknown client environment policy');
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    const upper = key.toUpperCase();
    if (isScalvinInternal(upper) || INJECTION_NAMES.has(upper)) continue;
    if (BASE_NAMES.has(upper) || clientNames.has(upper) || BASE_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

function interactiveEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    const upper = key.toUpperCase();
    if (isScalvinInternal(upper) || INJECTION_NAMES.has(upper)) continue;
    env[key] = value;
  }
  return env;
}

function childRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function signalChild(child, signal, group) {
  try {
    // A detached POSIX child leads its own process group; signalling the
    // negative PID reaches helpers it spawned, such as MCP servers.
    if (group && process.platform !== 'win32' && Number.isSafeInteger(child.pid)) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (_) {
    try { child.kill(signal); } catch (__) { /* already gone */ }
  }
}

// Ask the child to stop, force it after a bounded grace period, and resolve
// only once its exit is observed (or report that it could not be confirmed).
function terminateChild(child, { graceMs = 2_000, confirmMs = 2_000, group = false } = {}) {
  return new Promise((resolve) => {
    if (!childRunning(child)) {
      if (group) signalChild(child, 'SIGKILL', true);
      resolve({ exited: true, forced: false });
      return;
    }
    let forced = false;
    let settled = false;
    let confirmTimer = null;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(confirmTimer);
      child.removeListener('exit', onExit);
      // Sweep any surviving group members even when the leader exited.
      if (group) signalChild(child, 'SIGKILL', true);
      resolve({ exited, forced });
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    const graceTimer = setTimeout(() => {
      if (!childRunning(child)) return finish(true);
      forced = true;
      signalChild(child, 'SIGKILL', group);
      confirmTimer = setTimeout(() => finish(!childRunning(child)), confirmMs);
    }, graceMs);
    signalChild(child, 'SIGTERM', group);
  });
}

module.exports = {
  INJECTION_NAMES,
  workerEnvironment,
  interactiveEnvironment,
  terminateChild
};
