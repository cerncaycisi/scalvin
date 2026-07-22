import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('repository test runner caps file concurrency and CI leaves bounded-run headroom', () => {
  const runner = readFileSync(path.join(ROOT, 'cli', 'run-tests.js'), 'utf8');
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(runner, /\['--test', '--test-concurrency=2', \.\.\.files\]/);
  assert.match(workflow, /^    timeout-minutes: 40$/m);
});
