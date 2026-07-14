'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageJson = require('../../package.json');
const { human, humanError } = require('../../cli/index');
const { ROOT } = require('./helpers');

function run(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'scalvin.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SCALVIN_ALLOW_REPO_TARGET: '1', SCALVIN_DISABLE_LOCAL_POINTER: '1' }
  });
}

test('help and version expose the stable command surface', () => {
  const version = run(['version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageJson.version);
  const help = run(['help']);
  assert.equal(help.status, 0);
  for (const command of ['install', 'update', 'doctor', 'backup', 'restore', 'consent', 'memory', 'transcript', 'session', 'context', 'changes', 'preferences', 'source', 'review-due']) assert.match(help.stdout, new RegExp(`scalvin ${command}`));
});

test('JSON errors are one machine-readable record with nonzero exit', () => {
  const result = run(['unknown', '--json']);
  assert.equal(result.status, 2);
  const error = JSON.parse(result.stderr);
  assert.equal(error.status, 'error');
  assert.equal(error.code, 'UNKNOWN_COMMAND');
});

test('unknown options and boolean assignments are rejected before destructive work', () => {
  const unknown = run(['install', '--workspace', 'ignored', '--unknown', 'value', '--json']);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stderr).code, 'UNKNOWN_OPTION');
  const booleanValue = run(['restore', '--backup', 'ignored', '--workspace', 'ignored', '--force=false', '--json']);
  assert.equal(booleanValue.status, 2);
  assert.equal(JSON.parse(booleanValue.stderr).code, 'INVALID_ARGUMENT');
});

test('human context previews include the exact merge and backfill content under review', () => {
  const output = human({
    status: 'preview',
    canonicalEntity: { id: 'person-a', label: 'Canonical' },
    mergedEntity: { id: 'person-b', label: 'Merged' },
    proposedEntity: { id: 'person-a', aliases: ['Merged'] },
    candidates: [{ id: 'person-c', label: 'Candidate' }],
    approvedIds: ['person-c'],
    possibleDuplicates: [{ candidateId: 'person-c', existingIds: ['person-a'] }],
    confirmationRequired: 'exact-token'
  });
  for (const marker of ['Canonical', 'Merged', 'Candidate', 'person-c', 'person-a', 'exact-token']) assert.match(output, new RegExp(marker));
});

test('human cleanup failures expose the retained private stage and recovery action', () => {
  const output = humanError({
    code: 'UPDATE_STAGE_CLEANUP_FAILED',
    message: 'A private prepared update stage could not be removed safely.',
    details: {
      retainedPrivateStagePath: '/private/.workspace.update-stage.example',
      cleanupErrorCode: 'EACCES',
      originalErrorCode: 'STALE_CONFIRMATION',
      nextAction: 'remove-retained-private-stage-before-retrying'
    }
  });
  for (const marker of [
    'UPDATE_STAGE_CLEANUP_FAILED',
    'retainedPrivateStagePath: /private/.workspace.update-stage.example',
    'cleanupErrorCode: EACCES',
    'originalErrorCode: STALE_CONFIRMATION',
    'nextAction: remove-retained-private-stage-before-retrying'
  ]) assert.match(output, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
