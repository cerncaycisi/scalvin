'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  JOURNAL_RELATIVE,
  appendOperationFailure,
  validateReceipt,
  rollbackStatusFor
} = require('../../cli/lib/operation-journal');
const { sandbox } = require('./helpers');

async function writeJournalState(workspace, enabled = true) {
  const directory = path.join(workspace, '.scalvin');
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, 'state.json'), `${JSON.stringify({
    schemaVersion: 2,
    workspaceId: crypto.randomUUID(),
    consent: {
      usageLedgers: enabled ? 'on' : 'off',
      retention: { usage_ledgers: enabled ? 'until_deleted' : 'do_not_store' }
    }
  })}\n`);
}

test('operation failure journal serializes concurrent content-free receipts without loss', async () => {
  const box = await sandbox('operation-journal-concurrent');
  try {
    await writeJournalState(box.workspace);
    const writes = Array.from({ length: 12 }, (_, index) => appendOperationFailure(box.workspace, {
      operation: index % 2 ? 'update' : 'source_import',
      errorCode: index % 2 ? 'TEST_UPDATE_FAILURE' : 'TEST_IMPORT_FAILURE',
      rollbackStatus: 'not_required_target_unchanged'
    }));
    const results = await Promise.all(writes);
    assert.equal(results.every((item) => item.written), true);
    const lines = (await fsp.readFile(path.join(box.workspace, JOURNAL_RELATIVE), 'utf8')).trim().split('\n');
    assert.equal(lines.length, writes.length);
    const receipts = lines.map((line) => validateReceipt(JSON.parse(line)));
    assert.equal(new Set(receipts.map((item) => item.operationId)).size, writes.length);
    for (const receipt of receipts) {
      assert.deepEqual(Object.keys(receipt).sort(), [
        'errorCode', 'operation', 'operationId', 'rollbackStatus', 'schemaVersion', 'timestamp'
      ]);
      assert.match(receipt.operationId, /^operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  } finally {
    await box.cleanup();
  }
});

test('operation failure journal waits through a temporarily held lock', async () => {
  const box = await sandbox('operation-journal-held-lock');
  const lockPath = path.join(box.workspace, '.scalvin', 'operation-journal.lock');
  let releaseTimer;
  try {
    await writeJournalState(box.workspace);
    await fsp.mkdir(lockPath, { mode: 0o700 });
    const released = new Promise((resolve, reject) => {
      releaseTimer = setTimeout(() => {
        fsp.rmdir(lockPath).then(resolve, reject);
      }, 750);
    });
    const written = appendOperationFailure(box.workspace, {
      operation: 'update', errorCode: 'TEST_UPDATE_FAILURE', rollbackStatus: 'rolled_back'
    });
    await released;
    const result = await written;
    assert.equal(result.written, true);
    const receipt = validateReceipt(JSON.parse(
      (await fsp.readFile(path.join(box.workspace, JOURNAL_RELATIVE), 'utf8')).trim()
    ));
    assert.equal(receipt.operationId, result.operationId);
  } finally {
    clearTimeout(releaseTimer);
    await fsp.rm(lockPath, { recursive: true, force: true });
    await box.cleanup();
  }
});

test('operation failure journal honors usage-ledger controls without creating a file', async () => {
  const box = await sandbox('operation-journal-disabled');
  try {
    await writeJournalState(box.workspace, false);
    const result = await appendOperationFailure(box.workspace, {
      operation: 'update', errorCode: 'TEST_UPDATE_FAILURE', rollbackStatus: 'rolled_back'
    });
    assert.equal(result.written, false);
    assert.equal(result.reason, 'disabled-by-data-controls');
    await assert.rejects(fsp.access(path.join(box.workspace, JOURNAL_RELATIVE)), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('operation journal rejects content-bearing or malformed receipt fields', () => {
  assert.throws(() => validateReceipt({
    schemaVersion: 1,
    operationId: `operation-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    operation: 'update',
    errorCode: 'TEST_UPDATE_FAILURE',
    rollbackStatus: 'rolled_back',
    message: 'must not be stored'
  }), { code: 'OPERATION_JOURNAL_INVALID' });
});

test('post-activation truth takes precedence when classifying rollback status', () => {
  assert.equal(rollbackStatusFor({
    code: 'TEST_FAILPOINT',
    details: { activeWorkspaceUpdated: true }
  }), 'active_workspace_updated');
});
