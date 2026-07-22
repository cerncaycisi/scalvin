'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'hooks', 'current-time.cjs');
const { buildTimeContext, resolveNow, localTimestamp, MAX_STDIN_CHARS } = require(HOOK);

test('deterministic time context carries a timezone hint without a language signal', () => {
  const context = buildTimeContext({
    SCALVIN_NOW: '2026-07-14T12:04:05.000Z',
    TZ: 'America/Sao_Paulo',
    LANG: 'pt_BR.UTF-8'
  });
  assert.match(context, /Current local time signal:/);
  assert.match(context, /2026-07-14T09:04:05\.000-03:00/);
  assert.match(context, /Device timezone hint: America\/Sao_Paulo/);
  assert.doesNotMatch(context, /pt_BR|locale|language/i);
  assert.match(context, /not the user's location or a confirmed timezone/i);
  assert.match(context, /do not guess the time, timezone, date, or part of day/i);
});

test('machine time signal is locale-independent and preserves exact zone offset', () => {
  const instant = new Date('2026-07-14T12:04:05.006Z');
  assert.equal(localTimestamp(instant, 'Asia/Tokyo'), '2026-07-14T21:04:05.006+09:00');
  assert.equal(localTimestamp(instant, 'UTC'), '2026-07-14T12:04:05.006Z');
});

test('invalid override fails open instead of fabricating time', () => {
  assert.equal(resolveNow({ SCALVIN_NOW: 'not-a-date' }), null);
  assert.equal(buildTimeContext({ SCALVIN_NOW: 'not-a-date', TZ: 'America/Sao_Paulo' }), null);
});

function runHook(input, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    timeout: 3000,
    env: { ...process.env, SCALVIN_HOOK_TIMEOUT_MS: '1500', ...env }
  });
}

test('CLI emits valid deterministic UserPromptSubmit context', () => {
  const result = runHook(JSON.stringify({ prompt: 'hello' }), {
    SCALVIN_NOW: '2026-07-14T12:04:05.000Z',
    TZ: 'Asia/Tokyo',
    LANG: 'ja_JP.UTF-8'
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /Asia\/Tokyo/);
});

test('CLI fails open on invalid date, malformed input, and oversized input', () => {
  const invalidDate = runHook(JSON.stringify({ prompt: 'hello' }), { SCALVIN_NOW: 'invalid' });
  assert.equal(invalidDate.status, 0);
  assert.equal(invalidDate.stdout, '');

  const malformed = runHook('{broken');
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, '');

  const oversized = runHook(JSON.stringify({ prompt: 'x'.repeat(MAX_STDIN_CHARS + 1) }));
  assert.equal(oversized.status, 0);
  assert.equal(oversized.stdout, '');
});
