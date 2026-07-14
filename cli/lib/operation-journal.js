'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScalvinError, invariant } = require('./errors');
const { rejectSymlinkPath, atomicWriteFile, readBoundedRegularFile } = require('./fs-safe');

const JOURNAL_RELATIVE = '.scalvin/operation-journal.jsonl';
const MAX_JOURNAL_BYTES = 1024 * 1024;
const JOURNAL_LOCK_WAIT_MS = 15_000;
const JOURNAL_LOCK_RETRY_MIN_MS = 10;
const JOURNAL_LOCK_RETRY_MAX_MS = 50;
const ALLOWED_KEYS = Object.freeze(['schemaVersion', 'operationId', 'timestamp', 'operation', 'errorCode', 'rollbackStatus']);

function validateReceipt(receipt) {
  invariant(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'Operation journal receipt is invalid.', 'OPERATION_JOURNAL_INVALID');
  invariant(Object.keys(receipt).every((key) => ALLOWED_KEYS.includes(key)), 'Operation journal receipt contains disallowed fields.', 'OPERATION_JOURNAL_INVALID');
  invariant(receipt.schemaVersion === 1, 'Operation journal schema is invalid.', 'OPERATION_JOURNAL_INVALID');
  invariant(/^operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.operationId || ''), 'Operation journal ID is invalid.', 'OPERATION_JOURNAL_INVALID');
  invariant(typeof receipt.timestamp === 'string' && !Number.isNaN(Date.parse(receipt.timestamp)) && new Date(receipt.timestamp).toISOString() === receipt.timestamp, 'Operation journal timestamp is invalid.', 'OPERATION_JOURNAL_INVALID');
  invariant(['update', 'source_import'].includes(receipt.operation), 'Operation journal operation is invalid.', 'OPERATION_JOURNAL_INVALID');
  invariant(/^[A-Z][A-Z0-9_]{1,80}$/.test(receipt.errorCode || ''), 'Operation journal error code is invalid.', 'OPERATION_JOURNAL_INVALID');
  invariant(['not_started_or_target_unchanged', 'not_required_target_unchanged', 'rolled_back', 'rollback_incomplete', 'active_workspace_updated'].includes(receipt.rollbackStatus), 'Operation journal rollback state is invalid.', 'OPERATION_JOURNAL_INVALID');
  return receipt;
}

async function appendOperationFailure(workspace, input) {
  const statePath = path.join(workspace, '.scalvin', 'state.json');
  await rejectSymlinkPath(statePath);
  const state = JSON.parse((await readBoundedRegularFile(statePath, 1024 * 1024, {
    typeCode: 'OPERATION_JOURNAL_UNAVAILABLE', sizeCode: 'OPERATION_JOURNAL_UNAVAILABLE', changedCode: 'OPERATION_JOURNAL_UNAVAILABLE'
  })).toString('utf8'));
  invariant(state.schemaVersion === 2 && typeof state.workspaceId === 'string', 'Operation journal requires a valid workspace.', 'OPERATION_JOURNAL_UNAVAILABLE');
  if (state.consent?.usageLedgers !== 'on' || state.consent?.retention?.usage_ledgers === 'do_not_store') {
    return { written: false, reason: 'disabled-by-data-controls', operationId: input.operationId, rollbackStatus: input.rollbackStatus };
  }
  const journalPath = path.join(workspace, JOURNAL_RELATIVE);
  const lockPath = path.join(workspace, '.scalvin', 'operation-journal.lock');
  let locked = false;
  try {
    const deadline = Date.now() + JOURNAL_LOCK_WAIT_MS;
    let attempt = 0;
    while (!locked) {
      try {
        await fsp.mkdir(lockPath, { mode: 0o700 });
        locked = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const backoff = Math.min(
          JOURNAL_LOCK_RETRY_MAX_MS,
          JOURNAL_LOCK_RETRY_MIN_MS * (2 ** Math.min(attempt, 3))
        );
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(backoff, remaining)));
      }
    }
    invariant(locked, 'Operation journal is busy.', 'OPERATION_JOURNAL_BUSY');
    await rejectSymlinkPath(journalPath, { allowMissing: true });
    let raw = '';
    try {
      raw = (await readBoundedRegularFile(journalPath, MAX_JOURNAL_BYTES, {
        typeCode: 'OPERATION_JOURNAL_INVALID', sizeCode: 'OPERATION_JOURNAL_INVALID', changedCode: 'OPERATION_JOURNAL_INVALID'
      })).toString('utf8');
      for (const line of raw.split(/\r?\n/).filter(Boolean)) validateReceipt(JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const receipt = validateReceipt({
      schemaVersion: 1,
      operationId: input.operationId || `operation-${crypto.randomUUID()}`,
      timestamp: input.timestamp || new Date().toISOString(),
      operation: input.operation,
      errorCode: input.errorCode,
      rollbackStatus: input.rollbackStatus
    });
    const line = `${JSON.stringify(receipt)}\n`;
    invariant(Buffer.byteLength(raw) + Buffer.byteLength(line) <= MAX_JOURNAL_BYTES, 'Operation journal reached its safe size limit.', 'OPERATION_JOURNAL_FULL');
    await atomicWriteFile(journalPath, `${raw}${line}`);
    const verified = (await readBoundedRegularFile(journalPath, MAX_JOURNAL_BYTES, {
      typeCode: 'OPERATION_JOURNAL_VERIFY_FAILED', sizeCode: 'OPERATION_JOURNAL_VERIFY_FAILED', changedCode: 'OPERATION_JOURNAL_VERIFY_FAILED'
    })).toString('utf8').trimEnd().split(/\r?\n/).at(-1);
    invariant(verified === JSON.stringify(receipt), 'Operation journal readback verification failed.', 'OPERATION_JOURNAL_VERIFY_FAILED');
    return { ...receipt, written: true };
  } finally {
    if (locked) await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

function rollbackStatusFor(error) {
  if (error?.details?.activeWorkspaceUpdated === true) return 'active_workspace_updated';
  if (error?.code === 'ACTIVATION_FAILED') return error.details?.recoveryError ? 'rollback_incomplete' : 'rolled_back';
  if (error?.code === 'TEST_FAILPOINT') return 'not_required_target_unchanged';
  return 'not_started_or_target_unchanged';
}

module.exports = { JOURNAL_RELATIVE, MAX_JOURNAL_BYTES, validateReceipt, appendOperationFailure, rollbackStatusFor };
