'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageJson = require('../../package.json');
const packageLock = require('../../package-lock.json');
const { human, humanError } = require('../../cli/index');
const { ROOT } = require('./helpers');

function run(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'scalvin.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SCALVIN_ALLOW_REPO_TARGET: '1', SCALVIN_DISABLE_LOCAL_POINTER: '1' }
  });
}

test('package and lock expose the same CLI and broker entrypoints', () => {
  assert.deepEqual(packageLock.packages[''].bin, packageJson.bin);
  assert.deepEqual(packageJson.bin, {
    scalvin: 'bin/scalvin.js',
    'scalvin-mcp': 'bin/scalvin-mcp.js'
  });
});

test('help and version expose the stable command surface', () => {
  const version = run(['version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageJson.version);
  const help = run(['help']);
  assert.equal(help.status, 0);
  for (const command of ['install', 'update', 'doctor', 'backup', 'restore', 'consent', 'memory', 'transcript', 'session', 'context', 'changes', 'preferences', 'source', 'review-due']) assert.match(help.stdout, new RegExp(`scalvin ${command}`));
  for (const action of ['retention-status', 'retention-set', 'retention-apply']) assert.match(help.stdout, new RegExp(`--action ${action}`));
  for (const policy of ['inherit', 'session_only', 'rolling_days', 'expire_at']) assert.match(help.stdout, new RegExp(`\\b${policy}\\b`));
  assert.match(help.stdout, /retention-set changes the cleanup control only; it neither changes consent nor deletes data\./);
  assert.match(help.stdout, /retention-apply is manual:/);
  assert.match(help.stdout, /It is not a background scheduler\./);
  assert.match(help.stdout, /Backups remain separate copies\./);
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

test('human retention output exposes content-free policy, counts, backup limits, and confirmation', () => {
  const output = human({
    status: 'preview',
    dataClass: 'profile_memory',
    cleanupPolicy: { policy: 'rolling_days', configuredAt: '2026-07-15T00:00:00.000Z', days: 30, expiresAt: null },
    planTimestamp: '2026-07-15T00:00:00.000Z',
    inventoryAvailable: true,
    dueCount: 2,
    blockedCount: 1,
    prePolicyCount: 0,
    retainedCount: 3,
    affectedFiles: 1,
    contentIncluded: false,
    objectIdentifiersIncluded: false,
    backupCopies: { knownRecords: 1, includedInLiveRetention: false, deletionRequiresSeparateRotation: true },
    backupsRemainSeparateCopies: true,
    knownBackupRecords: 1,
    confirmationRequired: 'retention-confirm-token',
    classes: [{ dataClass: 'profile_memory', objectCount: 6, dueCount: 2, blockedCount: 1 }],
    nextAction: 'rerun-with-exact-confirmation'
  });
  for (const marker of [
    'dataClass: profile_memory',
    'cleanupPolicy: {"policy":"rolling_days"',
    'planTimestamp: 2026-07-15T00:00:00.000Z',
    'inventoryAvailable: true',
    'dueCount: 2',
    'blockedCount: 1',
    'prePolicyCount: 0',
    'retainedCount: 3',
    'contentIncluded: false',
    'objectIdentifiersIncluded: false',
    'backupsRemainSeparateCopies: true',
    'confirmationRequired: retention-confirm-token',
    'retentionClass: {"dataClass":"profile_memory"'
  ]) assert.match(output, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(output, /PRIVATE-SENTINEL|mem-[0-9a-f-]+/i);
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
