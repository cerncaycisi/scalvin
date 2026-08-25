import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const SCHEDULED_WORKFLOW = readFileSync(path.join(WORKFLOW_DIR, 'codeql.yml'), 'utf8');
const REQUIRED_WORKFLOW = readFileSync(path.join(WORKFLOW_DIR, 'ci.yml'), 'utf8');

// The security property is that every action resolves to an immutable commit,
// not that it resolves to one particular commit forever. Asserting a literal
// SHA here would only mirror the workflow file — an unauthorized edit would
// change both — while making every legitimate dependency bump fail Required CI.
// Branch protection and review are what gate the change; these tests gate the
// shape.
const COMMIT_PIN = /^[0-9a-f]{40}$/;

function pinsFor(workflow, action) {
  const pattern = new RegExp(`${action.replace(/[/]/g, '\\/')}@([^\\s#]+)`, 'g');
  return [...workflow.matchAll(pattern)].map((match) => match[1]);
}

function codeqlPin(workflow) {
  const init = pinsFor(workflow, 'github/codeql-action/init');
  const analyze = pinsFor(workflow, 'github/codeql-action/analyze');
  assert.equal(init.length, 1, 'exactly one CodeQL init step is expected');
  assert.equal(analyze.length, 1, 'exactly one CodeQL analyze step is expected');
  assert.match(init[0], COMMIT_PIN, 'CodeQL init must be pinned to a full commit SHA');
  assert.match(analyze[0], COMMIT_PIN, 'CodeQL analyze must be pinned to a full commit SHA');
  assert.equal(init[0], analyze[0], 'CodeQL init and analyze must run the same pinned commit');
  return init[0];
}

function assertPinnedExtendedJavaScriptAnalysis(workflow) {
  for (const pin of pinsFor(workflow, 'actions/checkout')) {
    assert.match(pin, COMMIT_PIN, 'checkout must be pinned to a full commit SHA');
  }
  const pin = codeqlPin(workflow);

  assert.match(workflow, /^          languages: javascript-typescript$/m);
  assert.match(workflow, /^          queries: security-extended$/m);

  const init = workflow.indexOf(`github/codeql-action/init@${pin}`);
  const analyze = workflow.indexOf(`github/codeql-action/analyze@${pin}`);
  assert.ok(init >= 0 && analyze > init);
}

test('scheduled CodeQL workflow is least-privilege and immutable', () => {
  assert.match(SCHEDULED_WORKFLOW, /^name: CodeQL$/m);
  assert.doesNotMatch(SCHEDULED_WORKFLOW, /^  (?:push|pull_request|pull_request_target):$/m);
  assert.match(SCHEDULED_WORKFLOW, /^  schedule:$/m);
  assert.match(SCHEDULED_WORKFLOW, /^  workflow_dispatch:$/m);

  assert.equal((SCHEDULED_WORKFLOW.match(/^  contents: read$/gm) || []).length, 1);
  assert.equal((SCHEDULED_WORKFLOW.match(/^  security-events: write$/gm) || []).length, 1);
  assert.doesNotMatch(SCHEDULED_WORKFLOW, /contents: write|id-token: write|packages: write/);
  assertPinnedExtendedJavaScriptAnalysis(SCHEDULED_WORKFLOW);
});

test('Required CI cannot pass before the pinned CodeQL analysis succeeds', () => {
  assert.match(REQUIRED_WORKFLOW, /^  codeql:$/m);
  assert.match(REQUIRED_WORKFLOW, /^      security-events: write$/m);
  assertPinnedExtendedJavaScriptAnalysis(REQUIRED_WORKFLOW);
  assert.match(REQUIRED_WORKFLOW, /^      - codeql$/m);
  assert.match(REQUIRED_WORKFLOW, /CODEQL_RESULT: \$\{\{ needs\.codeql\.result \}\}/);
  assert.match(REQUIRED_WORKFLOW, /\$CODEQL_RESULT" != "success"/);
});

test('both workflows analyze with the same pinned CodeQL commit', () => {
  assert.equal(
    codeqlPin(SCHEDULED_WORKFLOW),
    codeqlPin(REQUIRED_WORKFLOW),
    'the scheduled and Required CI analyses must not drift apart'
  );
});

test('every workflow pins each third-party action to an immutable commit', () => {
  const workflows = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(workflows.length > 0, 'expected at least one workflow file');
  for (const name of workflows) {
    const workflow = readFileSync(path.join(WORKFLOW_DIR, name), 'utf8');
    const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    for (const reference of uses) {
      // Local composite actions and reusable workflows in this repository are
      // pinned by the commit being built, not by a reference of their own.
      if (reference.startsWith('./')) continue;
      const [action, pin] = reference.split('@');
      assert.ok(pin, `${name}: ${action} must carry an explicit reference`);
      assert.match(pin, COMMIT_PIN, `${name}: ${action} must be pinned to a full commit SHA, got ${pin}`);
    }
  }
});
