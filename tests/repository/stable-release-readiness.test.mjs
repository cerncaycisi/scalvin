import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('stable release fails closed while exact effective-runtime attestation remains unavailable', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-stable-readiness.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Stable release is blocked:\n/);
  assert.doesNotMatch(result.stderr, /\[codex\].*soft compatibility profile/);
  assert.match(result.stderr, /\[codex\].*effective-launch hard-boundary attestation/);
  assert.doesNotMatch(result.stderr, /\[claude-code\].*direct private continuity access/);
  assert.match(result.stderr, /\[claude-code\].*effective-launch hard-boundary attestation/);
  assert.match(result.stderr, /\[generic\].*no enforceable private-data boundary/);
  assert.match(result.stderr, /\[generic\].*effective-launch hard-boundary attestation/);
  assert.match(result.stderr, /broker self-test reports.*hard private-data boundary/);
  assert.match(result.stderr, /typed private read\/write surface is incomplete/);
  assert.match(result.stderr, /isolated tool-free and network-free source worker is not attested/);
  assert.doesNotMatch(result.stderr, /\/Volumes\/|\/Users\/|[A-Za-z]:\\/);
});

test('stable release gate independently blocks an expired emergency-resource registry', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'verify-stable-readiness.mjs'),
    '--now',
    '2026-08-13'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[safety-resources\].*EMERGENCY_RESOURCE_REGISTRY_STALE; CA,TR,US/);
  assert.doesNotMatch(result.stderr, /\/Volumes\/|\/Users\/|[A-Za-z]:\\/);
});
