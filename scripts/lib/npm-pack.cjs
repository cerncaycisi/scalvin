'use strict';

const { execFileSync } = require('node:child_process');

const PACK_ARGUMENTS = Object.freeze(['pack', '--dry-run', '--json', '--ignore-scripts']);

function npmInvocation({
  platform = process.platform,
  env = process.env
} = {}) {
  if (platform === 'win32') {
    return {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json --ignore-scripts']
    };
  }
  return { command: 'npm', args: [...PACK_ARGUMENTS] };
}

function npmPackReport(options = {}) {
  const { command, args } = npmInvocation();
  const raw = execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
  const reports = JSON.parse(raw);
  if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0].files)) {
    throw new Error('npm pack returned an unexpected inventory report.');
  }
  return reports[0];
}

module.exports = { npmInvocation, npmPackReport, PACK_ARGUMENTS };
