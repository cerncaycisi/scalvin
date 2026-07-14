#!/usr/bin/env node
// <!-- version: 1.0.0 -->
// Cross-platform local-time context hook. If time resolution fails it emits
// nothing; the runtime must never infer or fabricate a missing time signal.

'use strict';

const MAX_STDIN_CHARS = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 1500;

function resolveNow(env = process.env) {
  if (!env.SCALVIN_NOW) return new Date();
  const parsed = new Date(env.SCALVIN_NOW);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function localTimestamp(now, timeZone) {
  const formatter = new Intl.DateTimeFormat('und-u-ca-iso8601-nu-latn', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
    timeZoneName: 'longOffset'
  });
  const parts = formatter.formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const zoneName = value('timeZoneName');
  const zoneMatch = /^(?:GMT|UTC)(?:([+-])(\d{2}):(\d{2}))?$/.exec(zoneName || '');
  if (!zoneMatch) return null;
  const offset = !zoneMatch[1] || (zoneMatch[2] === '00' && zoneMatch[3] === '00')
    ? 'Z'
    : `${zoneMatch[1]}${zoneMatch[2]}:${zoneMatch[3]}`;
  const fields = ['year', 'month', 'day', 'hour', 'minute', 'second', 'fractionalSecond'];
  if (fields.some((field) => !value(field))) return null;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}.${value('fractionalSecond')}${offset}`;
}

function buildTimeContext(env = process.env) {
  const now = resolveNow(env);
  if (!now) return null;
  try {
    const options = Intl.DateTimeFormat().resolvedOptions();
    const timeZone = env.TZ || options.timeZone || 'unknown';
    const timestamp = localTimestamp(now, timeZone);
    if (!timestamp) return null;
    return [
      `Current local time signal: ${timestamp}`,
      `Device timezone hint: ${timeZone}.`,
      'Use this only for light pacing and temporal orientation. A device timezone is not the user\'s location or a confirmed timezone. If this signal is absent or invalid, do not guess the time, timezone, date, or part of day.'
    ].join('\n');
  } catch (_) {
    return null;
  }
}

function runFromStdin() {
  let input = '';
  let overflowed = false;
  const configured = Number(process.env.SCALVIN_HOOK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => process.exit(0), timeoutMs);
  if (timer.unref) timer.unref();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (overflowed) return;
    if (input.length + chunk.length > MAX_STDIN_CHARS) {
      overflowed = true;
      input = '';
      return;
    }
    input += chunk;
  });
  process.stdin.on('error', () => process.exit(0));
  process.stdout.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    if (overflowed) return;
    try {
      const payload = JSON.parse(input);
      if (!payload || typeof payload.prompt !== 'string') return;
      const additionalContext = buildTimeContext();
      if (!additionalContext) return;
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext }
      })}\n`);
    } catch (_) {
      // Fail open.
    }
  });
}

module.exports = { MAX_STDIN_CHARS, resolveNow, localTimestamp, buildTimeContext };

if (require.main === module) {
  try {
    runFromStdin();
  } catch (_) {
    process.exit(0);
  }
}
