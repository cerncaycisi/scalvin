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

// Derive dates from the registry so re-verification stays a pure data edit.
const DAY_MS = 24 * 60 * 60 * 1000;
function shiftDay(date, days) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
const REGISTRY_DATES = (() => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const verified = registry.jurisdictions.map((entry) => entry.verifiedAt).sort();
  const expires = registry.jurisdictions.map((entry) => entry.expiresAt).sort();
  return { latestVerifiedAt: verified.at(-1), earliestVerifiedAt: verified[0], earliestExpiresAt: expires[0] };
})();

test('registry contains only bounded country-scoped official routes with an exact TTL', () => {
  const registry = loadRegistry();
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.ttlDays, 30);
  assert.deepEqual(registry.jurisdictions.map((entry) => entry.countryCode), ['CA', 'TR', 'US']);
  for (const jurisdiction of registry.jurisdictions) {
    assert.equal(jurisdiction.scope, 'national');
    assert.match(jurisdiction.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(jurisdiction.expiresAt, shiftDay(jurisdiction.verifiedAt, registry.ttlDays));
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
  const { latestVerifiedAt, earliestVerifiedAt, earliestExpiresAt } = REGISTRY_DATES;
  const currentDay = shiftDay(latestVerifiedAt, 3);
  assert.ok(currentDay < earliestExpiresAt);
  assert.deepEqual(assessRegistry(registry, currentDay), {
    state: 'current',
    reasonCode: null,
    checkedOn: currentDay,
    earliestExpiresAt,
    affectedJurisdictions: []
  });
  const beforeDay = shiftDay(earliestVerifiedAt, -1);
  assert.deepEqual(assessRegistry(registry, beforeDay), {
    state: 'not_yet_valid',
    reasonCode: 'EMERGENCY_RESOURCE_REGISTRY_NOT_YET_VALID',
    checkedOn: beforeDay,
    earliestExpiresAt,
    affectedJurisdictions: registry.jurisdictions.filter((entry) => entry.verifiedAt > beforeDay).map((entry) => entry.countryCode)
  });
  assert.deepEqual(assessRegistry(registry, earliestExpiresAt), {
    state: 'stale',
    reasonCode: 'EMERGENCY_RESOURCE_REGISTRY_STALE',
    checkedOn: earliestExpiresAt,
    earliestExpiresAt,
    affectedJurisdictions: registry.jurisdictions.filter((entry) => entry.expiresAt <= earliestExpiresAt).map((entry) => entry.countryCode)
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
  const current = spawnSync(process.execPath, [CHECKER, '--now', shiftDay(REGISTRY_DATES.latestVerifiedAt, 3)], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(current.status, 0);
  assert.match(current.stdout, new RegExp(`3 jurisdictions; earliest expiry ${REGISTRY_DATES.earliestExpiresAt}`));
  assert.equal(current.stderr, '');

  const stale = spawnSync(process.execPath, [CHECKER, '--now', shiftDay(REGISTRY_DATES.latestVerifiedAt, 90)], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(stale.status, 1);
  assert.equal(stale.stdout, '');
  assert.match(stale.stderr, /EMERGENCY_RESOURCE_REGISTRY_STALE \(CA,TR,US\)/);
  assert.doesNotMatch(stale.stderr, /\/Users\/|\/Volumes\/|[A-Za-z]:\\/);
});
