import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEDULED_WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'codeql.yml'), 'utf8');
const REQUIRED_WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const CODEQL_SHA = '99df26d4f13ea111d4ec1a7dddef6063f76b97e9';

function assertPinnedExtendedJavaScriptAnalysis(workflow) {
  assert.match(workflow, /actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/);
  assert.equal(workflow.split(`github/codeql-action/init@${CODEQL_SHA}`).length - 1, 1);
  assert.equal(workflow.split(`github/codeql-action/analyze@${CODEQL_SHA}`).length - 1, 1);
  assert.doesNotMatch(workflow, /github\/codeql-action\/(?:init|analyze)@v\d/);
  assert.match(workflow, /^          languages: javascript-typescript$/m);
  assert.match(workflow, /^          queries: security-extended$/m);

  const init = workflow.indexOf(`github/codeql-action/init@${CODEQL_SHA}`);
  const analyze = workflow.indexOf(`github/codeql-action/analyze@${CODEQL_SHA}`);
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
