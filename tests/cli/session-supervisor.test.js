'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSealSupervisor,
  interactiveClientCommand
} = require('../../cli/session-supervisor');
const { notifySupervisor } = require('../../cli/mcp-server');

test('sealed-pause supervisor accepts only its exact content-free token', async (t) => {
  const supervisor = await createSealSupervisor();
  t.after(() => supervisor.close());
  const wrong = await notifySupervisor({ endpoint: supervisor.endpoint, token: 'supervisor-00000000-0000-4000-8000-000000000000' });
  assert.equal(wrong.delivered, true);
  const race = await Promise.race([
    supervisor.signal.then(() => 'signal'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 100))
  ]);
  assert.equal(race, 'timeout');
  const correct = await notifySupervisor({ endpoint: supervisor.endpoint, token: supervisor.token });
  assert.equal(correct.delivered, true);
  assert.deepEqual(await supervisor.signal, { event: 'sealed_pause' });
});

test('supervised Codex launch disables local history and Claude launch pins project settings and MCP', () => {
  const workspace = '/private/scalvin-workspace';
  const codex = interactiveClientCommand('codex', '/opt/codex', workspace);
  assert.ok(codex.args.includes('--ignore-user-config'));
  assert.ok(codex.args.includes('--ignore-rules'));
  assert.equal(codex.args.includes('-a'), false);
  assert.equal(codex.args.includes('--ask-for-approval'), false);
  assert.ok(codex.args.includes('--strict-config'));
  assert.equal(codex.args[codex.args.indexOf('-C') + 1], workspace);
  assert.ok(codex.args.includes('history.persistence="none"'));
  assert.equal(codex.args.includes('--search'), false);

  const claude = interactiveClientCommand('claude', '/opt/claude', workspace);
  assert.ok(claude.args.includes('--strict-mcp-config'));
  assert.equal(claude.args[claude.args.indexOf('--setting-sources') + 1], 'project');
  assert.equal(claude.args[claude.args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(claude.args.includes('--no-chrome'));
});
