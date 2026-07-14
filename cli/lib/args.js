'use strict';

const { ScalvinError } = require('./errors');

const BOOLEAN_OPTIONS = new Set([
  'dry-run', 'force', 'json', 'help', 'version', 'non-interactive', 'check', 'encrypt', 'clear-preferred-user-name', 'show-preferred-user-name', 'can-resume-context', 'decline-reminder'
]);
const REPEATABLE_OPTIONS = new Set(['modality', 'proposed-memory-id', 'approved-id']);
const COMMON = ['help', 'version', 'json'];
const COMMAND_OPTIONS = {
  help: COMMON,
  version: COMMON,
  install: [...COMMON, 'workspace', 'target', 'companion-name', 'language', 'persona', 'structure', 'modality', 'consent', 'force', 'confirm', 'dry-run', 'non-interactive', 'backup-output'],
  update: [...COMMON, 'workspace', 'target', 'companion-name', 'language', 'persona', 'structure', 'modality', 'force', 'confirm', 'dry-run', 'non-interactive', 'backup-output', 'manifest', 'source', 'release', 'manifest-sha256'],
  doctor: [...COMMON, 'workspace', 'target'],
  backup: [...COMMON, 'workspace', 'target', 'action', 'id', 'backup', 'output', 'confirm', 'dry-run', 'encrypt', 'passphrase-file', 'decline-reminder'],
  restore: [...COMMON, 'workspace', 'target', 'backup', 'backup-output', 'force', 'confirm', 'dry-run', 'passphrase-file'],
  consent: [...COMMON, 'workspace', 'target', 'status', 'category', 'value', 'retention', 'dry-run'],
  memory: [...COMMON, 'workspace', 'target', 'action', 'id', 'scope', 'statement', 'output', 'confirm', 'session-id', 'limit', 'dry-run'],
  transcript: [...COMMON, 'workspace', 'target', 'action', 'session-id', 'capture-grade', 'scope', 'confirm', 'dry-run'],
  session: [...COMMON, 'workspace', 'target', 'timezone', 'now', 'author-name', 'session-id', 'turn-number', 'live-thread-file', 'unresolved-file', 'carry-forward-file', 'note-file', 'deep-dive-file', 'primer-file', 'transcript-file', 'completion', 'recovery-action', 'can-resume-context', 'confirm', 'dry-run'],
  context: [...COMMON, 'workspace', 'target', 'id', 'candidate-file', 'patch-file', 'candidates-file', 'approved-id', 'status', 'canonical-id', 'merged-id', 'session-id', 'now', 'confirm', 'dry-run'],
  changes: [...COMMON, 'workspace', 'target', 'change-target', 'setting', 'value', 'value-file', 'evidence-status', 'why', 'why-file', 'expected-effect', 'expected-effect-file', 'risks-or-tradeoffs', 'risks-file', 'session-id', 'change-id', 'revision-id', 'wording', 'wording-file', 'confirm', 'dry-run'],
  preferences: [...COMMON, 'workspace', 'target', 'language', 'timezone', 'preferred-user-name', 'clear-preferred-user-name', 'show-preferred-user-name', 'response-load', 'one-question-at-a-time', 'plain-language-summaries', 'reduced-metaphor', 'extra-processing-time', 'body-prompts', 'sensory-grounding', 'between-session-experiments', 'stale-memory-offers', 'dry-run'],
  source: [...COMMON, 'workspace', 'target', 'path', 'kind', 'locale', 'source-id', 'revision', 'provenance-file', 'proposed-memory-id', 'proposed-memory-file', 'import-consent-event', 'import-retention', 'external-care-consent-event', 'external-care-retention', 'confirm', 'dry-run'],
  'review-due': [...COMMON, 'workspace', 'target', 'date', 'timezone']
};

function parseArgs(argv) {
  const input = [...argv];
  let command = 'help';
  if (input[0] && !input[0].startsWith('-')) command = input.shift();
  const options = {};
  const positionals = [];

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (token === '--') {
      positionals.push(...input.slice(index + 1));
      break;
    }
    if (token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '-v') {
      options.version = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    const key = token.slice(2, equals === -1 ? undefined : equals);
    if (!key) throw new ScalvinError('Empty option name.', 'INVALID_ARGUMENT', { token }, 2);
    let value;
    if (equals !== -1) {
      if (BOOLEAN_OPTIONS.has(key)) {
        throw new ScalvinError(`--${key} does not accept a value; include the flag only when enabled.`, 'INVALID_ARGUMENT', { option: key }, 2);
      }
      value = token.slice(equals + 1);
    } else if (BOOLEAN_OPTIONS.has(key)) {
      value = true;
    } else {
      index += 1;
      value = input[index];
      if (value === undefined || value.startsWith('--')) {
        throw new ScalvinError(`--${key} requires a value.`, 'INVALID_ARGUMENT', { option: key }, 2);
      }
    }

    if (REPEATABLE_OPTIONS.has(key)) {
      options[key] = [...(options[key] || []), ...String(value).split(',').filter(Boolean)];
    } else if (Object.hasOwn(options, key)) {
      throw new ScalvinError(`--${key} may only be provided once.`, 'INVALID_ARGUMENT', { option: key }, 2);
    } else {
      options[key] = value;
    }
  }

  if (options.workspace && options.target && options.workspace !== options.target) {
    throw new ScalvinError('--workspace and --target disagree.', 'INVALID_ARGUMENT', undefined, 2);
  }
  if (options.workspace && !options.target) options.target = options.workspace;
  const allowed = new Set(COMMAND_OPTIONS[command] || COMMON);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new ScalvinError(`Unknown option for ${command}: --${key}`, 'UNKNOWN_OPTION', { command, option: key }, 2);
  }
  return { command, options, positionals };
}

module.exports = { parseArgs };
