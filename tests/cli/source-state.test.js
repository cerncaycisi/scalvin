'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEmptySourceLifecycle,
  validateSourceLifecyclePatch,
  applySourceLifecyclePatch
} = require('../../cli/lib/workspace');

const SOURCE_ID = 'src-10000000-0000-4000-8000-000000000001';
const CONSENT_ID = 'consent-20000000-0000-4000-8000-000000000002';
const HASH_ONE = '1'.repeat(64);
const HASH_TWO = '2'.repeat(64);

function record(revision = 1, overrides = {}) {
  const sha256 = revision === 1 ? HASH_ONE : HASH_TWO;
  const padded = String(revision).padStart(4, '0');
  return {
    sourceId: SOURCE_ID,
    revision,
    kind: 'imported_source',
    locale: 'tr-TR',
    sha256,
    byteLength: 20,
    status: 'ready',
    trust: 'untrusted_data',
    importedAt: '2026-07-14T14:00:00+03:00',
    consentEventId: CONSENT_ID,
    retention: 'until_deleted',
    contentObject: `sources/objects/${SOURCE_ID}/r${padded}--${sha256}.source`,
    recordObject: `sources/records/${SOURCE_ID}--r${padded}.md`,
    lastIntegratedHash: null,
    lastIntegratedAt: null,
    derivedMemoryIds: [],
    error: null,
    ...overrides
  };
}

function patch(item, operation = 'upsert') {
  return { sourceLifecycle: { operation, sourceId: item.sourceId, revision: item.revision, record: item } };
}

test('source lifecycle patches are strict, canonically sorted, and supersede earlier active revisions', () => {
  const state = { sourceLifecycle: createEmptySourceLifecycle() };
  applySourceLifecyclePatch(state, patch(record(1)));
  applySourceLifecyclePatch(state, patch(record(2)));
  assert.equal(state.sourceLifecycle.records.length, 2);
  assert.equal(state.sourceLifecycle.records[0].status, 'superseded');
  assert.equal(state.sourceLifecycle.records[1].revision, 2);

  const tampered = record(2, { contentObject: '../escape' });
  assert.throws(() => validateSourceLifecyclePatch(patch(tampered)), { code: 'SOURCE_PATCH_INVALID' });
  const unknown = { ...record(2), executable: true };
  assert.throws(() => validateSourceLifecyclePatch(patch(unknown)), { code: 'SOURCE_PATCH_INVALID' });
});

test('rejection leaves a strict tombstone while delete-many removes canonical records', () => {
  const state = { sourceLifecycle: createEmptySourceLifecycle() };
  applySourceLifecyclePatch(state, patch(record(1)));
  const rejected = record(1, { status: 'rejected', contentObject: null, recordObject: null });
  applySourceLifecyclePatch(state, patch(rejected));
  assert.equal(state.sourceLifecycle.records[0].status, 'rejected');

  const deleted = record(1, { status: 'deleted', contentObject: null, recordObject: null });
  const entry = { operation: 'delete', sourceId: SOURCE_ID, revision: 1, record: deleted };
  applySourceLifecyclePatch(state, { sourceLifecycle: { operation: 'delete_many', records: [entry] } });
  assert.deepEqual(state.sourceLifecycle.records, []);
});
