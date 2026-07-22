'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'hooks', 'emergency-resources.json');
const CHECKER = path.join(ROOT, 'scripts', 'check-emergency-resources.mjs');
const {
  MAX_REGISTRY_BYTES,
  validateRegistry,
  loadRegistry,
  assessRegistry
} = require('../../hooks/emergency-resources.cjs');

function canonicalRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

test('registry contains only bounded country-scoped official routes with an exact TTL', () => {
  const registry = loadRegistry();
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.ttlDays, 30);
  assert.deepEqual(registry.jurisdictions.map((entry) => entry.countryCode), ['CA', 'TR', 'US']);
  for (const jurisdiction of registry.jurisdictions) {
    assert.equal(jurisdiction.scope, 'national');
    assert.equal(jurisdiction.verifiedAt, '2026-07-14');
    assert.equal(jurisdiction.expiresAt, '2026-08-13');
    for (const resource of jurisdiction.resources) {
      assert.match(resource.contact, /^\d[\d-]*\d$|^\d$/);
      assert.match(resource.officialSource.url, /^https:\/\//);
      assert.equal(new URL(resource.officialSource.url).username, '');
      assert.equal(new URL(resource.officialSource.url).password, '');
    }
  }
});

test('UTC-date assessment is current before the exclusive expiry and stale on it', () => {
  const registry = canonicalRegistry();
  assert.deepEqual(assessRegistry(registry, '2026-07-17'), {
    state: 'current',
    reasonCode: null,
    checkedOn: '2026-07-17',
    earliestExpiresAt: '2026-08-13',
    affectedJurisdictions: []
  });
  assert.deepEqual(assessRegistry(registry, '2026-07-13'), {
    state: 'not_yet_valid',
    reasonCode: 'EMERGENCY_RESOURCE_REGISTRY_NOT_YET_VALID',
    checkedOn: '2026-07-13',
    earliestExpiresAt: '2026-08-13',
    affectedJurisdictions: ['CA', 'TR', 'US']
  });
  assert.deepEqual(assessRegistry(registry, '2026-08-13'), {
    state: 'stale',
    reasonCode: 'EMERGENCY_RESOURCE_REGISTRY_STALE',
    checkedOn: '2026-08-13',
    earliestExpiresAt: '2026-08-13',
    affectedJurisdictions: ['CA', 'TR', 'US']
  });
});

test('registry validation rejects authority expansion, long TTLs, and non-public sources', () => {
  const canonical = canonicalRegistry();
  assert.throws(
    () => validateRegistry({ ...canonical, languageMap: { en: 'US' } }),
    /fields are invalid/
  );
  assert.throws(
    () => validateRegistry({ ...canonical, ttlDays: 365 }),
    /TTL is invalid/
  );

  const localSource = structuredClone(canonical);
  localSource.jurisdictions[0].resources[0].officialSource.url = 'file:///private/example';
  assert.throws(() => validateRegistry(localSource), /public HTTPS source/);

  const loopbackSource = structuredClone(canonical);
  loopbackSource.jurisdictions[0].resources[0].officialSource.url = 'https://127.0.0.1/example';
  assert.throws(() => validateRegistry(loopbackSource), /public HTTPS source/);

  const duplicate = structuredClone(canonical);
  duplicate.jurisdictions.push(structuredClone(duplicate.jurisdictions[0]));
  assert.throws(() => validateRegistry(duplicate), /unique sorted country codes/);
});

test('bounded loader rejects symlinks and oversized registry data', { skip: process.platform === 'win32' }, (t) => {
  const parent = path.join(ROOT, '.test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'emergency-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.json');
  const link = path.join(root, 'link.json');
  fs.writeFileSync(target, fs.readFileSync(REGISTRY_PATH));
  fs.symlinkSync(target, link);
  assert.throws(() => loadRegistry(link), /file is invalid/);
  const oversized = path.join(root, 'oversized.json');
  fs.writeFileSync(oversized, Buffer.alloc(MAX_REGISTRY_BYTES + 1, 0x20));
  assert.throws(() => loadRegistry(oversized), /file is invalid/);
});

test('static checker passes current data and fails stale data without leaking a path', () => {
  const current = spawnSync(process.execPath, [CHECKER, '--now', '2026-07-17'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(current.status, 0);
  assert.match(current.stdout, /3 jurisdictions; earliest expiry 2026-08-13/);
  assert.equal(current.stderr, '');

  const stale = spawnSync(process.execPath, [CHECKER, '--now', '2026-08-13'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(stale.status, 1);
  assert.equal(stale.stdout, '');
  assert.match(stale.stderr, /EMERGENCY_RESOURCE_REGISTRY_STALE \(CA,TR,US\)/);
  assert.doesNotMatch(stale.stderr, /\/Users\/|\/Volumes\/|[A-Za-z]:\\/);
});
