'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { ScalvinError, invariant } = require('./lib/errors');
const {
  resolvePortablePath,
  isInside,
  assertInside,
  validateRelativePath,
  rejectSymlinkPath,
  isNonEmptyDirectory,
  pathExists,
  makeSiblingTemp,
  copyTree,
  hardenTree,
  activateDirectory,
  snapshotWorkspaceTree,
  acquireMutationLock,
  inspectMutationLock,
  sha256File,
  atomicWriteFile,
  ensurePrivateDir,
  preparePrivateDirectory,
  createPrivateExclusiveFile,
  walkTree,
  readBoundedRegularFile
} = require('./lib/fs-safe');
const { loadManifest, readSourceFile, verifyDistribution } = require('./lib/manifest');
const {
  normalizePreferences,
  normalizeLanguagePreference,
  createEmptySessionLifecycle,
  createEmptySourceLifecycle,
  applySourceLifecyclePatch,
  buildTargetPlan,
  writePlan,
  ensureWorkspaceDirectories,
  clientIntegrationsNeedChange,
  applyClientIntegrations,
  createState,
  projectConsentState,
  consentProjectionNeedsChange,
  writeState,
  loadWorkspaceState,
  migrateLegacyState,
  validateLegacyStateVersion,
  validateConsentOption,
  validateWorkspaceStage,
  validatePrivacyWorkspaceStage,
  CONSENT_CATEGORY_SPECS,
  applyConsentChoice
} = require('./lib/workspace');
const {
  createBackup,
  verifyBackup,
  getBackupSummary,
  backupArtifactIdentity,
  deleteBackupArtifact,
  findDefaultBackupById,
  readBackupLedgerStatus,
  markBackupDeleted,
  appendBackupOperationReceipt
} = require('./lib/backup');
const { BACKUP_ID_PATTERN } = require('./lib/backup-crypto');
const { recordPersistedSessionClose, declineBackupReminder } = require('./lib/backup-reminder');
const { runDoctor } = require('./doctor');
const { appendOperationFailure, rollbackStatusFor } = require('./lib/operation-journal');
const {
  listMemoryItems,
  confirmationToken,
  planForget,
  planCorrection,
  planDeleteAll,
  planTranscriptDelete,
  applyPlan,
  appendDeletionReceipt,
  createMemoryExport
} = require('./memory-data');
const {
  SESSION_ID_PATTERN,
  artifactPaths,
  validateSessionLifecyclePatch,
  beginSession,
  checkpointTurn,
  closeSession,
  findInterruptedSessions,
  recoverSession
} = require('./session-lifecycle');
const {
  CHANGE_ID,
  REVISION_ID,
  planProposal,
  planApprove,
  planReject,
  planRollback,
  listHistory,
  validateSnapshot
} = require('./change-control');
const {
  LEDGER_SEPARATOR,
  statusSource,
  importSource,
  integrateSource,
  planSourceRemoval,
  applySourceRemoval
} = require('./source-lifecycle');
const { evaluateStaleMemory, planReviewDecision } = require('./memory-review');
const {
  STATUSES: CONTEXT_STATUSES,
  graphAccess,
  parseCandidateJson,
  parseCandidateBatchJson,
  parseCorrectionPatchJson,
  loadAllEntities,
  planStatus: planContextStatus,
  planShow: planContextShow,
  planAdd: planContextAdd,
  planCorrect: planContextCorrect,
  planStatusChange: planContextStatusChange,
  planRemoveMemoryReferences,
  planForget: planContextForget,
  planMerge: planContextMerge,
  planBackfill: planContextBackfill
} = require('./context-graph');

const DISTRIBUTION_ROOT = path.resolve(__dirname, '..');
const DISTRIBUTION_MANIFEST = path.join(DISTRIBUTION_ROOT, 'manifest.json');

function assertSafeWorkspaceTarget(target) {
  const absolute = path.resolve(target);
  const filesystemRoot = path.parse(absolute).root;
  const home = path.resolve(require('node:os').homedir());
  invariant(absolute !== filesystemRoot, 'Filesystem root cannot be a Scalvin workspace target.', 'UNSAFE_WORKSPACE_TARGET', { target: absolute });
  invariant(absolute !== home, 'The user home directory itself cannot be a Scalvin workspace target.', 'UNSAFE_WORKSPACE_TARGET', { target: absolute });
  const targetInsideSource = isInside(DISTRIBUTION_ROOT, absolute);
  const sourceInsideTarget = isInside(absolute, DISTRIBUTION_ROOT);
  if (sourceInsideTarget || (targetInsideSource && process.env.SCALVIN_ALLOW_REPO_TARGET !== '1')) {
    throw new ScalvinError('Workspace target overlaps the public Scalvin source repository.', 'WORKSPACE_SOURCE_OVERLAP', { target: absolute, source: DISTRIBUTION_ROOT });
  }
  return absolute;
}

function assertSafeBackupOutput(output) {
  if (!output) return undefined;
  const absolute = resolvePortablePath(output);
  if (isInside(DISTRIBUTION_ROOT, absolute) && process.env.SCALVIN_ALLOW_REPO_TARGET !== '1') {
    throw new ScalvinError('Backup output cannot be inside the public Scalvin source repository.', 'BACKUP_INSIDE_SOURCE_REPO', { output: absolute });
  }
  return absolute;
}

function stableOperationErrorCode(error) {
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(error?.code || '') ? error.code : 'UNEXPECTED_ERROR';
}

async function appendFailedBackupReceipt(workspace, event, error) {
  try {
    const receipt = await appendBackupOperationReceipt(workspace, {
      ...event,
      status: 'failed',
      errorCode: stableOperationErrorCode(error)
    });
    error.details = { ...(error.details || {}), backupOperationReceipt: receipt.written
      ? { written: true, eventId: receipt.eventId }
      : { written: false, reason: receipt.reason } };
  } catch (receiptError) {
    error.details = { ...(error.details || {}), backupOperationReceipt: { written: false, errorCode: stableOperationErrorCode(receiptError) } };
  }
  return error;
}

function testFailpoint(name) {
  if (process.env.SCALVIN_TEST_FAILPOINT === name) {
    throw new ScalvinError(`Injected test failure at ${name}.`, 'TEST_FAILPOINT', { name });
  }
}

async function loadVerifiedSources(loaded) {
  const buffers = new Map();
  for (const entry of loaded.manifest.files) buffers.set(entry.path, await readSourceFile(loaded, entry));
  return buffers;
}

function distributionMatchesState(loaded, state) {
  return state.product?.manifestSha256 === loaded.sha256 &&
    state.product?.version === loaded.manifest.product.version;
}

async function resolveTrustedInstalledPlan(stateResult, incomingLoaded, incomingSourceBuffers) {
  if (stateResult.kind !== 'current') return null;
  const state = stateResult.state;
  let trustedLoaded;
  let trustedSources;

  if (distributionMatchesState(incomingLoaded, state)) {
    trustedLoaded = incomingLoaded;
    trustedSources = incomingSourceBuffers;
  } else {
    const bundled = await loadManifest(DISTRIBUTION_MANIFEST);
    if (!distributionMatchesState(bundled, state)) return null;
    trustedLoaded = bundled;
    trustedSources = await loadVerifiedSources(bundled);
  }

  const preferences = normalizePreferences(trustedLoaded.manifest, {}, state.preferences);
  return buildTargetPlan(trustedLoaded.manifest, trustedSources, preferences);
}

function sourcePin(_options, loaded) {
  return { pin: loaded.sha256, pinType: 'manifest-sha256' };
}

function assertPinned(options, loaded, allowBundled = false) {
  const hasCryptographicPin = Boolean(options['manifest-sha256']);
  invariant(hasCryptographicPin || allowBundled, 'Update requires an exact --manifest-sha256 pin; --release is only an additional version constraint.', 'UPDATE_PIN_REQUIRED', undefined);
  if (options['manifest-sha256']) {
    invariant(/^[a-f0-9]{64}$/.test(options['manifest-sha256']), '--manifest-sha256 must be a lowercase SHA-256.', 'INVALID_PIN');
    invariant(options['manifest-sha256'] === loaded.sha256, 'Manifest SHA-256 pin does not match.', 'MANIFEST_PIN_MISMATCH', { expected: options['manifest-sha256'], actual: loaded.sha256 });
  }
  if (options.release) {
    invariant(loaded.manifest.release?.version === options.release, 'Release pin does not match the manifest.', 'RELEASE_PIN_MISMATCH', { expected: options.release, actual: loaded.manifest.release?.version });
  }
  if (loaded.manifest.release?.channel === 'development') {
    invariant(Boolean(options['manifest-sha256']), 'Development manifests require an exact --manifest-sha256 pin.', 'DEVELOPMENT_MANIFEST_HASH_REQUIRED');
  }
  if (loaded.remote) invariant(Boolean(options['manifest-sha256']), 'Remote manifests require --manifest-sha256.', 'REMOTE_MANIFEST_HASH_REQUIRED');
  const bundledManifest = !loaded.remote && path.resolve(loaded.locator) === DISTRIBUTION_MANIFEST;
  if (!bundledManifest) invariant(Boolean(options['manifest-sha256']), 'Alternate manifests require an exact --manifest-sha256 pin; release metadata is a constraint, not a trust root.', 'ALTERNATE_MANIFEST_HASH_REQUIRED');
}

function withSourceOverride(loaded, source) {
  if (!source) return loaded;
  if (/^https:\/\//i.test(source)) {
    const sourceRoot = source.endsWith('/') ? source : `${source}/`;
    return { ...loaded, sourceRoot, remote: true };
  }
  const sourceRoot = resolvePortablePath(source);
  return { ...loaded, sourceRoot, remote: false };
}

async function reconcilePlanHashes(root, plan) {
  for (const item of plan) {
    const filename = path.join(root, item.target);
    if (await pathExists(filename)) item.installedHash = await sha256File(filename);
  }
}

function nextActionForConsent(consent) {
  if (!consent || consent === 'not-decided') return 'collect-consent';
  if (consent === 'declined') return 'keep-memory-disabled';
  return 'start-session';
}

async function writeLocalPointer(workspacePath, workspaceId) {
  if (process.env.SCALVIN_DISABLE_LOCAL_POINTER === '1') return null;
  const stateRoot = process.env.SCALVIN_LOCAL_STATE_DIR
    ? resolvePortablePath(process.env.SCALVIN_LOCAL_STATE_DIR)
    : path.join(DISTRIBUTION_ROOT, '.scalvin');
  try {
    await ensurePrivateDir(stateRoot);
    await preparePrivateDirectory(stateRoot);
    const pointer = {
      schemaVersion: 1,
      workspacePath,
      workspaceId
    };
    const pointerPath = path.join(stateRoot, 'local-state.json');
    await atomicWriteFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    await preparePrivateDirectory(stateRoot);
    return pointerPath;
  } catch (error) {
    if (process.env.SCALVIN_LOCAL_STATE_DIR) throw error;
    return null;
  }
}

async function preflightExplicitLocalPointerDestination() {
  if (process.env.SCALVIN_DISABLE_LOCAL_POINTER === '1' || !process.env.SCALVIN_LOCAL_STATE_DIR) return;
  const stateRoot = resolvePortablePath(process.env.SCALVIN_LOCAL_STATE_DIR);
  let handle = null;
  let probePath = null;
  let identity = null;
  try {
    await ensurePrivateDir(stateRoot);
    await preparePrivateDirectory(stateRoot);
    probePath = path.join(stateRoot, `.pointer-probe-${process.pid}-${crypto.randomUUID()}`);
    handle = await createPrivateExclusiveFile(probePath);
    identity = await handle.stat();
    await handle.close();
    handle = null;
    const current = await fsp.lstat(probePath);
    invariant(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
      current.dev === identity.dev && current.ino === identity.ino,
    'Local pointer preflight identity changed.', 'LOCAL_POINTER_PREFLIGHT_FAILED');
    await fsp.unlink(probePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (probePath && identity) {
      try {
        const current = await fsp.lstat(probePath);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
          await fsp.unlink(probePath);
        }
      } catch {}
    }
    if (error instanceof ScalvinError && error.code === 'LOCAL_POINTER_PREFLIGHT_FAILED') throw error;
    throw new ScalvinError('The explicit local pointer destination is not safely writable.', 'LOCAL_POINTER_PREFLIGHT_FAILED');
  }
}

function postActivationFailure(error, details) {
  const failure = error instanceof ScalvinError
    ? error
    : new ScalvinError(error?.message || 'A post-activation finalization step failed.', 'POST_ACTIVATION_FAILED');
  failure.details = {
    ...(failure.details || {}),
    status: 'partial',
    activeWorkspaceUpdated: true,
    workspaceId: details.workspaceId,
    finalizationStep: details.finalizationStep,
    nextAction: details.nextAction,
    ...(details.activation?.retainedRollbackPath
      ? { retainedRollbackPath: details.activation.retainedRollbackPath }
      : {})
  };
  return failure;
}

async function finalizeLocalPointerAfterActivation(target, workspaceId, activation, label) {
  try {
    testFailpoint(`${label}-after-activate`);
    return await writeLocalPointer(target, workspaceId);
  } catch (error) {
    activation.workspaceApplied = true;
    activation.finalizationWarnings = [
      ...(activation.finalizationWarnings || []),
      { code: 'LOCAL_POINTER_WRITE_FAILED', errorCode: error.code || 'UNEXPECTED_ERROR' }
    ];
    activation.finalizationNextAction = 'repair-local-workspace-pointer';
    return null;
  }
}

const REPLACEMENT_TOKEN_EXCLUDED_PATHS = new Set(['.therapy/state/BACKUP-LEDGER.md']);

async function replacementPlannedWriteHash(root, relative) {
  const filename = path.join(root, relative);
  if (relative !== '.scalvin/state.json') return sha256File(filename);
  const bytes = await readBoundedRegularFile(filename, 2 * 1024 * 1024, {
    typeCode: 'WORKSPACE_STATE_INVALID',
    sizeCode: 'WORKSPACE_STATE_INVALID',
    changedCode: 'WORKSPACE_STATE_INVALID'
  });
  let state;
  try {
    state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ScalvinError('Proposed workspace state is invalid.', 'WORKSPACE_STATE_INVALID');
  }
  for (const excluded of REPLACEMENT_TOKEN_EXCLUDED_PATHS) {
    if (state?.files?.[excluded]) state.files[excluded].installedHash = 'excluded-operational-file-hash';
  }
  return crypto.createHash('sha256').update(`${JSON.stringify(state)}\n`).digest('hex');
}

async function exactReplacementPlan(currentRoot, proposedRoot, selector) {
  const currentEntries = (await walkTree(currentRoot))
    .filter((entry) => !REPLACEMENT_TOKEN_EXCLUDED_PATHS.has(entry.path))
    .map((entry) => ({ path: entry.path, type: entry.type, mode: entry.mode, ...(entry.type === 'file' ? { size: entry.size } : {}) }));
  const proposedEntries = (await walkTree(proposedRoot))
    .filter((entry) => !REPLACEMENT_TOKEN_EXCLUDED_PATHS.has(entry.path))
    .map((entry) => ({ path: entry.path, type: entry.type, mode: entry.mode, ...(entry.type === 'file' ? { size: entry.size } : {}) }));
  const currentFiles = currentEntries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
  const proposedFiles = proposedEntries.filter((entry) => entry.type === 'file');
  const plannedWriteHashes = [];
  for (const entry of proposedFiles) {
    plannedWriteHashes.push({ path: entry.path, sha256: await replacementPlannedWriteHash(proposedRoot, entry.path) });
  }
  const proposedPaths = new Set(proposedFiles.map((entry) => entry.path));
  return {
    selector,
    ids: [],
    writes: null,
    plannedWriteHashes,
    deletes: currentFiles.filter((relative) => !proposedPaths.has(relative)).sort(),
    affectedPaths: [...new Set([...currentFiles, ...proposedFiles.map((entry) => entry.path)])].sort(),
    currentEntries,
    proposedEntries
  };
}

async function replacementConfirmation(root, proposedRoot, workspaceId, operation, selector, options = {}) {
  const plan = await exactReplacementPlan(root, proposedRoot, selector);
  const token = await destructivePlanToken(root, workspaceId, operation, plan, {
    ...options,
    currentEntries: plan.currentEntries,
    proposedEntries: plan.proposedEntries,
    excludedOperationalPaths: [...REPLACEMENT_TOKEN_EXCLUDED_PATHS].sort()
  });
  return { plan, token };
}

async function prepareInstallStage({
  target, manifest, loaded, plan, preferences, consent, existingStateResult, planNow, expectedTargetSnapshot
}) {
  invariant(expectedTargetSnapshot, 'Install activation requires the target snapshot captured during preflight.', 'ACTIVATION_SNAPSHOT_REQUIRED');
  const stage = await makeSiblingTemp(target, 'install-stage');
  let stageIdentity = null;
  try {
    const created = await fsp.lstat(stage);
    invariant(created.isDirectory() && !created.isSymbolicLink(), 'Prepared install stage identity is invalid.', 'INSTALL_STAGE_IDENTITY_CHANGED');
    stageIdentity = { dev: created.dev, ino: created.ino };
    if (expectedTargetSnapshot.state !== 'missing') await copyTree(target, stage, { expectedSourceSnapshot: expectedTargetSnapshot });
    const stagePlan = plan.map((item) => ({ ...item, data: Buffer.from(item.data) }));
    await ensureWorkspaceDirectories(stage, manifest);
    await writePlan(stage, stagePlan, { preserveExisting: expectedTargetSnapshot.state !== 'missing' });
    await applyClientIntegrations(stage, manifest);
    const pin = { pin: loaded.sha256, pinType: 'manifest-sha256' };
    const deterministicWorkspaceId = existingStateResult?.kind === 'current'
      ? existingStateResult.state.workspaceId
      : deterministicUuidV4(`${loaded.sha256}\0install-workspace\0${planNow}`);
    const state = createState(manifest, preferences, stagePlan, {
      locator: loaded.locator,
      manifestSha256: loaded.sha256,
      ...pin
    }, {
      now: planNow,
      consent,
      workspaceId: deterministicWorkspaceId,
      consentEventId: consent === 'not-decided' ? undefined : `consent-${deterministicUuidV4(`${deterministicWorkspaceId}\0${consent}\0${planNow}`)}`,
      createdAt: existingStateResult?.kind === 'current' ? existingStateResult.state.createdAt : planNow
    });
    if (existingStateResult?.kind === 'current') state.consent = existingStateResult.state.consent;
    await projectConsentState(stage, state);
    await reconcilePlanHashes(stage, stagePlan);
    for (const item of stagePlan) if (state.files[item.target]) state.files[item.target].installedHash = item.installedHash;
    await writeState(stage, state, manifest);
    await hardenTree(stage);
    await validateWorkspaceStage(stage, { manifest, manifestSha256: loaded.sha256, expectedPlan: stagePlan });
    return { stage, stageIdentity, state, expectedTargetSnapshot };
  } catch (error) {
    await discardPreparedInstallStage({ stage, stageIdentity }, error);
  }
}

async function install(options = {}) {
  const loaded = await loadManifest(DISTRIBUTION_MANIFEST);
  const manifest = loaded.manifest;
  const sourceErrors = await verifyDistribution(manifest, DISTRIBUTION_ROOT);
  invariant(sourceErrors.length === 0, 'The bundled distribution does not match its manifest.', 'DISTRIBUTION_INTEGRITY_FAILED', { errors: sourceErrors });
  const sourceBuffers = await loadVerifiedSources(loaded);
  const target = assertSafeWorkspaceTarget(resolvePortablePath(options.target || options.workspace || manifest.defaults.workspace));
  await rejectSymlinkPath(target, { allowMissing: true });
  const nonEmpty = await isNonEmptyDirectory(target);
  const initialTargetSnapshot = await snapshotWorkspaceTree(target);
  const snapshotNonEmpty = initialTargetSnapshot.state === 'directory' && initialTargetSnapshot.entries.length > 0;
  invariant(snapshotNonEmpty === nonEmpty, 'The install target changed during preflight; inspect it and try again.', 'STALE_WORKSPACE');
  if (nonEmpty && !options.force) {
    throw new ScalvinError('Target is not empty. Use update for an installed workspace or --force to replace framework files after a backup.', 'TARGET_NOT_EMPTY', { target });
  }
  let existingStateResult = null;
  if (nonEmpty) existingStateResult = await loadWorkspaceState(target, manifest);
  const requestedConsent = validateConsentOption(options.consent);
  const consent = existingStateResult?.kind === 'current'
    ? existingStateResult.state.consent?.status || 'not-decided'
    : requestedConsent;
  const ignoredPreferences = [];
  const preferenceOptions = { ...options };
  if (preferenceOptions.language !== undefined) preferenceOptions.language = normalizeLanguagePreference(preferenceOptions.language);
  if (consent !== 'granted') {
    for (const field of ['companion-name', 'language', 'persona', 'structure', 'modality']) {
      if (options[field] !== undefined) ignoredPreferences.push(field);
      delete preferenceOptions[field];
    }
  }
  const preferences = normalizePreferences(manifest, preferenceOptions);
  const plan = buildTargetPlan(manifest, sourceBuffers, preferences);
  const plannedBackup = nonEmpty
    ? await createBackup(target, { output: assertSafeBackupOutput(options['backup-output']), dryRun: true })
    : null;
  if (options['dry-run'] && !nonEmpty) {
    return {
      status: 'dry-run',
      workspacePath: target,
      workspaceId: null,
      files: plan.length,
      backupPath: plannedBackup?.backupPath || null,
      nextAction: nextActionForConsent(consent),
      warnings: ignoredPreferences.length ? [{ code: 'SENSITIVE_PREFERENCES_IGNORED', fields: ignoredPreferences }] : []
    };
  }

  const planNow = nonEmpty ? destructivePlanTimestamp('install-replace', options) : new Date().toISOString();
  let prepared = await prepareInstallStage({
    target, manifest, loaded, plan, preferences, consent, existingStateResult, planNow,
    expectedTargetSnapshot: initialTargetSnapshot
  });
  let expectedConfirmation = null;
  const authorizationOptions = {
    manifestSha256: loaded.sha256,
    preferences,
    consent,
    backupOutput: options['backup-output'] || null,
    planTimestamp: planNow
  };
  if (nonEmpty) {
    try {
      const authorization = await replacementConfirmation(
        target, prepared.stage, prepared.state.workspaceId, 'install-replace', loaded.sha256, authorizationOptions
      );
      expectedConfirmation = authorization.token;
    } catch (error) {
      const failedPrepared = prepared;
      prepared = null;
      await discardPreparedInstallStage(failedPrepared, error);
    }
    const preview = {
      status: options['dry-run'] ? 'dry-run' : 'preview',
      workspacePath: target,
      workspaceId: prepared.state.workspaceId,
      files: plan.length,
      backupPath: plannedBackup?.backupPath || null,
      confirmationRequired: expectedConfirmation,
      nextAction: `rerun-with---force-and---confirm-${expectedConfirmation}`,
      warnings: ignoredPreferences.length ? [{ code: 'SENSITIVE_PREFERENCES_IGNORED', fields: ignoredPreferences }] : []
    };
    if (!options.confirm || options['dry-run']) {
      await discardPreparedInstallStage(prepared);
      return preview;
    }
    const obsoletePrepared = prepared;
    prepared = null;
    let confirmationError = null;
    try {
      assertFreshConfirmation(options.confirm, expectedConfirmation);
    } catch (error) {
      confirmationError = error;
    }
    await discardPreparedInstallStage(obsoletePrepared, confirmationError);
  }

  let backup = null;
  if (nonEmpty) backup = await createBackup(target, { output: assertSafeBackupOutput(options['backup-output']) });
  if (nonEmpty) {
    const postBackupTargetSnapshot = await snapshotWorkspaceTree(target);
    prepared = await prepareInstallStage({
      target, manifest, loaded, plan, preferences, consent, existingStateResult, planNow,
      expectedTargetSnapshot: postBackupTargetSnapshot
    });
    try {
      const afterBackup = await replacementConfirmation(
        target, prepared.stage, prepared.state.workspaceId, 'install-replace', loaded.sha256, authorizationOptions
      );
      assertFreshConfirmation(options.confirm, afterBackup.token);
    } catch (error) {
      const failedPrepared = prepared;
      prepared = null;
      await discardPreparedInstallStage(failedPrepared, error);
    }
  }
  const { stage, state, expectedTargetSnapshot } = prepared;
  try {
    if (nonEmpty) {
      const finalAuthorization = await replacementConfirmation(
        target, stage, state.workspaceId, 'install-replace', loaded.sha256, authorizationOptions
      );
      assertFreshConfirmation(options.confirm, finalAuthorization.token);
    }
    await preflightExplicitLocalPointerDestination();
    testFailpoint('install-before-activate');
    const activation = await activateDirectory(target, stage, { expectedTargetSnapshot });
    const localStatePath = await finalizeLocalPointerAfterActivation(target, state.workspaceId, activation, 'install');
    const activationInfo = activationDisclosure(activation);
    const warnings = [
      ...(ignoredPreferences.length ? [{ code: 'SENSITIVE_PREFERENCES_IGNORED', fields: ignoredPreferences }] : []),
      ...(activationInfo.warnings || [])
    ];
    return {
      status: consent === 'granted' ? 'ready' : 'scaffolded',
      workspacePath: target,
      workspaceId: state.workspaceId,
      version: manifest.product.version,
      files: plan.length,
      backupPath: backup?.backupPath || null,
      localStatePath,
      nextAction: activationInfo.nextAction || nextActionForConsent(consent),
      warnings,
      ...(activationInfo.workspaceApplied ? { workspaceApplied: true, localPointerWritten: false } : {}),
      ...(activationInfo.retainedSeparateCopies ? { retainedSeparateCopies: activationInfo.retainedSeparateCopies } : {})
    };
  } catch (caught) {
    let error = caught;
    try {
      await discardPreparedInstallStage(prepared, error);
    } catch (cleanupOrOriginal) {
      error = cleanupOrOriginal;
    }
    throw error;
  }
}

function stateRegistryMatchesPlan(stateResult, incomingPlan) {
  if (stateResult.kind !== 'current') return false;
  const stateFiles = stateResult.state.files || {};
  if (Object.keys(stateFiles).length !== incomingPlan.length) return false;
  for (const item of incomingPlan) {
    const record = stateFiles[item.target];
    if (!record || record.sourcePath !== item.sourcePath || record.sourceHash !== item.sourceHash ||
      record.version !== item.version || record.role !== item.role || record.protection !== item.protection) return false;
    if (!['seed', 'protected'].includes(item.protection) && record.installedHash !== item.installedHash) return false;
  }
  return true;
}

async function inspectUpdateActions(workspace, incomingPlan, stateResult, trustedInstalledPlan = null) {
  const trustedByTarget = trustedInstalledPlan
    ? new Map(trustedInstalledPlan.map((item) => [item.target, item]))
    : null;
  const actions = [];
  const conflicts = [];
  const incomingTargets = new Set(incomingPlan.map((item) => item.target));

  for (const item of incomingPlan) {
    const filename = path.join(workspace, item.target);
    const exists = await pathExists(filename);
    const actualHash = exists ? await sha256File(filename) : null;
    const trustedPrior = trustedByTarget?.get(item.target);
    const sameIncoming = actualHash === item.installedHash;
    if (item.protection === 'seed' || item.protection === 'protected') {
      if (!exists) actions.push({ type: 'write', item, reason: 'missing-protected-seed' });
      continue;
    }
    if (exists && trustedPrior && ['seed', 'protected'].includes(trustedPrior.protection)) {
      conflicts.push({
        target: item.target,
        role: item.role,
        actualHash,
        priorHash: trustedPrior.installedHash,
        incomingHash: item.installedHash
      });
      actions.push({ type: 'write', item, reason: 'ownership-transition' });
      continue;
    }
    if (sameIncoming) continue;
    const trustedPriorOwned = trustedPrior && !['seed', 'protected'].includes(trustedPrior.protection);
    const customized = exists && (!trustedPriorOwned || actualHash !== trustedPrior.installedHash);
    if (customized) conflicts.push({
      target: item.target,
      role: item.role,
      actualHash,
      priorHash: trustedPriorOwned ? trustedPrior.installedHash : null,
      incomingHash: item.installedHash
    });
    actions.push({ type: 'write', item, reason: exists ? (customized ? 'customized' : 'version-change') : 'missing' });
  }

  for (const prior of trustedInstalledPlan || []) {
    if (incomingTargets.has(prior.target) || prior.protection === 'seed' || prior.protection === 'protected') continue;
    const normalizedTarget = validateRelativePath(prior.target);
    invariant(normalizedTarget === prior.target, 'Trusted installed target is not normalized.', 'UPDATE_PLAN_INVALID', { target: prior.target });
    const filename = path.resolve(workspace, normalizedTarget);
    assertInside(workspace, filename, 'Workspace state target');
    await rejectSymlinkPath(filename, { allowMissing: true });
    if (!(await pathExists(filename))) continue;
    const actualHash = await sha256File(filename);
    const customized = actualHash !== prior.installedHash;
    if (customized) conflicts.push({ target: normalizedTarget, role: prior.role, actualHash, priorHash: prior.installedHash, incomingHash: null });
    actions.push({ type: 'remove', target: normalizedTarget, prior, reason: customized ? 'customized-removed-file' : 'removed-from-manifest' });
  }
  const notices = stateResult.kind === 'current' && !trustedInstalledPlan
    ? [{ code: 'UNVERIFIED_PRIOR_TARGETS_PRESERVED' }]
    : [];
  return {
    actions,
    conflicts,
    notices,
    stateRegistryNeedsRefresh: !stateRegistryMatchesPlan(stateResult, incomingPlan)
  };
}

function knownLegacyLauncher(relative, content, workspace) {
  if (relative === 'start-session.command') {
    const match = content.match(/^#!\/bin\/bash\ncd "([^"\r\n]+)"\nclaude\n$/);
    return Boolean(match && path.resolve(match[1]) === path.resolve(workspace));
  }
  if (relative === 'start-session.bat') {
    const normalized = content.replaceAll('\r\n', '\n');
    const match = normalized.match(/^@echo off\ncd \/d "([^"\r\n]+)"\nclaude\n$/i);
    return Boolean(match && path.resolve(match[1]) === path.resolve(workspace));
  }
  return false;
}

async function inspectLegacyArtifacts(workspace, stateResult) {
  if (stateResult.kind !== 'legacy') return { actions: [], notices: [], sourceRecords: [] };
  const actions = [];
  const notices = [];
  for (const relative of ['start-session.command', 'start-session.bat']) {
    const filename = path.join(workspace, relative);
    await rejectSymlinkPath(filename, { allowMissing: true });
    if (!(await pathExists(filename))) continue;
    const content = (await readBoundedRegularFile(filename, 64 * 1024, {
      typeCode: 'LEGACY_ARTIFACT_INVALID', sizeCode: 'LEGACY_ARTIFACT_INVALID', changedCode: 'LEGACY_ARTIFACT_CHANGED'
    })).toString('utf8');
    if (knownLegacyLauncher(relative, content, workspace)) actions.push({ type: 'remove', target: relative, reason: 'known-unmodified-legacy-launcher' });
    else notices.push({ code: 'CUSTOMIZED_LEGACY_LAUNCHER_PRESERVED', artifact: relative });
  }

  const sourceRecords = [];
  const sourcesRoot = path.join(workspace, 'sources');
  if (await pathExists(sourcesRoot)) {
    for (const entry of await walkTree(sourcesRoot)) {
      if (entry.type !== 'file' || entry.path === 'README.md' || entry.path.split('/').some((part) => part.startsWith('.') || part.startsWith('._'))) continue;
      const hash = await sha256File(path.join(sourcesRoot, entry.path));
      const raw = require('node:crypto').createHash('sha256').update(`legacy-source\0${entry.path}\0${hash}`).digest('hex');
      const uuid = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
      sourceRecords.push({ sourceId: `src-${uuid}`, sha256: hash, byteLength: entry.size });
    }
  }
  return { actions, notices, sourceRecords };
}

async function appendLegacySourceRecords(stage, records) {
  if (!records.length) return 0;
  const ledgerPath = path.join(stage, '.therapy', 'state', 'SOURCE-LEDGER.md');
  await rejectSymlinkPath(ledgerPath);
  let markdown = await fsp.readFile(ledgerPath, 'utf8');
  invariant(markdown.includes(LEDGER_SEPARATOR), 'Source ledger template is invalid.', 'SOURCE_LEDGER_INVALID');
  let added = 0;
  for (const record of records) {
    if (markdown.includes(`| ${record.sourceId} |`) || markdown.includes(`| ${record.sha256} |`)) continue;
    const row = `| ${record.sourceId} | 1 | unknown | unknown | imported_source | unknown | unknown | ${record.sha256} | ${record.byteLength} | untrusted_data | pending_consent | null | do_not_store | null | null | none | null | null |`;
    markdown = markdown.replace(LEDGER_SEPARATOR, `${LEDGER_SEPARATOR}\n${row}`);
    added += 1;
  }
  if (added) await atomicWriteFile(ledgerPath, markdown);
  return added;
}

function updateInspectionFingerprint(inspection, legacyArtifacts) {
  return JSON.stringify({
    actions: inspection.actions.map((action) => ({
      type: action.type,
      target: action.item?.target || action.target,
      reason: action.reason,
      incomingHash: action.item?.installedHash || null
    })),
    conflicts: inspection.conflicts.map((conflict) => ({
      target: conflict.target,
      role: conflict.role,
      actualHash: conflict.actualHash,
      priorHash: conflict.priorHash,
      incomingHash: conflict.incomingHash
    })),
    notices: legacyArtifacts.notices,
    sourceRecords: legacyArtifacts.sourceRecords,
    inspectionNotices: inspection.notices,
    stateRegistryNeedsRefresh: inspection.stateRegistryNeedsRefresh
  });
}

async function prepareUpdateStage({
  target, loaded, incomingPlan, trustedInstalledPlan, inspection, legacyArtifacts, stateResult, preferences, options, planNow
}) {
  const expectedTargetSnapshot = await snapshotWorkspaceTree(target);
  const stage = await makeSiblingTemp(target, 'update-stage');
  let stageIdentity = null;
  try {
    const created = await fsp.lstat(stage);
    invariant(created.isDirectory() && !created.isSymbolicLink(), 'Prepared update stage identity is invalid.', 'UPDATE_STAGE_IDENTITY_CHANGED');
    stageIdentity = { dev: created.dev, ino: created.ino };
    const refreshedState = await loadWorkspaceState(target, loaded.manifest);
    invariant(refreshedState.kind === stateResult.kind && JSON.stringify(refreshedState.state) === JSON.stringify(stateResult.state),
      'Workspace state changed after update inspection; preview again.', 'STALE_CONFIRMATION');
    const refreshedInspection = await inspectUpdateActions(target, incomingPlan, stateResult, trustedInstalledPlan);
    const refreshedLegacy = await inspectLegacyArtifacts(target, stateResult);
    refreshedInspection.actions.push(...refreshedLegacy.actions);
    invariant(
      updateInspectionFingerprint(refreshedInspection, refreshedLegacy) === updateInspectionFingerprint(inspection, legacyArtifacts),
      'Workspace files changed after update inspection; preview again.',
      'STALE_CONFIRMATION'
    );
    await copyTree(target, stage, { expectedSourceSnapshot: expectedTargetSnapshot });
    const stageIncomingPlan = incomingPlan.map((item) => ({ ...item, data: Buffer.from(item.data) }));
    const incomingByTarget = new Map(stageIncomingPlan.map((item) => [item.target, item]));
    await ensureWorkspaceDirectories(stage, loaded.manifest);
    for (const action of inspection.actions) {
      if (action.type === 'remove') {
        const removal = path.resolve(stage, validateRelativePath(action.target));
        assertInside(stage, removal, 'Update removal');
        await rejectSymlinkPath(removal, { allowMissing: true });
        await fsp.rm(removal, { force: true, recursive: true });
      } else {
        const item = incomingByTarget.get(action.item.target);
        invariant(item, 'Update action target is missing from the incoming plan.', 'UPDATE_PLAN_INVALID');
        await writePlan(stage, [item], { preserveExisting: item.protection === 'seed' || item.protection === 'protected' });
      }
    }
    const migratedSourceRecords = await appendLegacySourceRecords(stage, legacyArtifacts.sourceRecords);
    await applyClientIntegrations(stage, loaded.manifest);
    const pin = sourcePin(options, loaded);
    const source = { locator: loaded.locator, manifestSha256: loaded.sha256, ...pin };
    let newState;
    if (stateResult.kind === 'current') {
      newState = createState(loaded.manifest, preferences, stageIncomingPlan, source, {
        now: planNow,
        workspaceId: stateResult.state.workspaceId,
        createdAt: stateResult.state.createdAt
      });
      newState.consent = structuredClone(stateResult.state.consent);
      newState.sessionLifecycle = structuredClone(stateResult.state.sessionLifecycle);
      newState.sourceLifecycle = structuredClone(stateResult.state.sourceLifecycle);
    } else {
      newState = migrateLegacyState(stateResult, loaded.manifest, preferences, stageIncomingPlan, source, {
        now: planNow,
        workspaceId: deterministicUuidV4(`${loaded.sha256}\0legacy-migration\0${planNow}`)
      });
    }
    await projectConsentState(stage, newState);
    await reconcilePlanHashes(stage, stageIncomingPlan);
    for (const item of stageIncomingPlan) if (newState.files[item.target]) newState.files[item.target].installedHash = item.installedHash;
    await writeState(stage, newState, loaded.manifest);
    await hardenTree(stage);
    await validateWorkspaceStage(stage, { manifest: loaded.manifest, manifestSha256: loaded.sha256, expectedPlan: stageIncomingPlan });
    return { stage, stageIdentity, newState, migratedSourceRecords, expectedTargetSnapshot };
  } catch (error) {
    await discardPreparedUpdateStage({ stage, stageIdentity }, error);
  }
}

async function preparedReplacementStageRetention(prepared) {
  try {
    const current = await fsp.lstat(prepared.stage);
    if (prepared.stageIdentity && !current.isSymbolicLink() && current.isDirectory() &&
      current.dev === prepared.stageIdentity.dev && current.ino === prepared.stageIdentity.ino) {
      return { cleanupStatus: 'retained', retainedPrivateStagePath: prepared.stage };
    }
    return { cleanupStatus: 'identity-changed', stageInspectionPath: prepared.stage };
  } catch (error) {
    if (error.code === 'ENOENT') return { cleanupStatus: 'absent-after-cleanup-error' };
    return { cleanupStatus: 'inspection-failed', stageInspectionPath: prepared.stage };
  }
}

async function assertPathMissing(filename, label, code) {
  try {
    await fsp.lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new ScalvinError(`${label} did not remove the exact prepared path.`, code);
}

async function discardPreparedReplacementStage(prepared, operation, priorError = null) {
  invariant(['install', 'update'].includes(operation), 'Prepared-stage cleanup operation is invalid.', 'INVALID_ARGUMENT');
  const operationCode = operation.toUpperCase();
  let current;
  try {
    current = await fsp.lstat(prepared.stage);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (priorError) throw priorError;
      return;
    }
    const retention = await preparedReplacementStageRetention(prepared);
    throw new ScalvinError(`A private prepared ${operation} stage could not be inspected for safe removal.`, `${operationCode}_STAGE_CLEANUP_FAILED`, {
      ...(priorError?.details || {}),
      ...retention,
      cleanupErrorCode: error.code || 'UNKNOWN',
      originalErrorCode: priorError?.code || null,
      nextAction: 'inspect-stage-path-and-workspace-before-retrying'
    });
  }
  try {
    testFailpoint(`${operation}-stage-cleanup`);
    invariant(prepared?.stageIdentity, 'Prepared replacement stage identity is unavailable; refusing recursive cleanup.', `${operationCode}_STAGE_IDENTITY_CHANGED`);
    invariant(
      !current.isSymbolicLink() && current.isDirectory() &&
        current.dev === prepared.stageIdentity.dev && current.ino === prepared.stageIdentity.ino,
      'Prepared replacement stage identity changed; refusing recursive cleanup.',
      `${operationCode}_STAGE_IDENTITY_CHANGED`
    );
    await fsp.rm(prepared.stage, { recursive: true, force: true });
    await assertPathMissing(prepared.stage, 'Prepared replacement stage cleanup', `${operationCode}_STAGE_CLEANUP_VERIFY_FAILED`);
  } catch (cleanupError) {
    const retention = await preparedReplacementStageRetention(prepared);
    throw new ScalvinError(`A private prepared ${operation} stage could not be removed safely.`, `${operationCode}_STAGE_CLEANUP_FAILED`, {
      ...(priorError?.details || {}),
      ...retention,
      cleanupErrorCode: cleanupError.code || 'UNKNOWN',
      originalErrorCode: priorError?.code || null,
      nextAction: retention.cleanupStatus === 'retained'
        ? 'remove-retained-private-stage-before-retrying'
        : 'inspect-stage-path-and-workspace-before-retrying'
    });
  }
  if (priorError) throw priorError;
}

async function discardPreparedUpdateStage(prepared, priorError = null) {
  return discardPreparedReplacementStage(prepared, 'update', priorError);
}

async function discardPreparedInstallStage(prepared, priorError = null) {
  return discardPreparedReplacementStage(prepared, 'install', priorError);
}

async function updateInternal(options = {}) {
  const target = assertSafeWorkspaceTarget(resolvePortablePath(options.target || options.workspace || '~/scalvin-workspace'));
  await rejectSymlinkPath(target);
  invariant(await isNonEmptyDirectory(target), 'Workspace does not exist or is empty.', 'WORKSPACE_NOT_FOUND', { target });
  const manifestLocator = options.manifest || DISTRIBUTION_MANIFEST;
  let loaded = await loadManifest(manifestLocator);
  assertPinned(options, loaded, false);
  loaded = withSourceOverride(loaded, options.source);
  const sourceBuffers = await loadVerifiedSources(loaded);
  const stateResult = await loadWorkspaceState(target, loaded.manifest);
  invariant(stateResult.kind !== 'corrupt', 'Workspace state is corrupt.', 'WORKSPACE_STATE_CORRUPT', { path: stateResult.path, cause: stateResult.error });
  invariant(stateResult.kind === 'current' || stateResult.kind === 'legacy', 'Update target is not an installed or legacy Scalvin workspace.', 'WORKSPACE_STATE_MISSING', { path: stateResult.path });
  const legacyVersion = stateResult.kind === 'legacy' ? validateLegacyStateVersion(stateResult.state) : null;
  const existingPreferences = stateResult.kind === 'current' ? stateResult.state.preferences : undefined;
  const consentStatus = stateResult.state?.consent?.status || 'not-decided';
  const preferenceOptions = { ...options };
  if (preferenceOptions.language !== undefined) preferenceOptions.language = normalizeLanguagePreference(preferenceOptions.language);
  const ignoredPreferences = [];
  if (consentStatus !== 'granted') {
    for (const field of ['companion-name', 'language', 'persona', 'structure', 'modality']) {
      if (options[field] !== undefined) ignoredPreferences.push(field);
      delete preferenceOptions[field];
    }
  }
  const safeExistingPreferences = consentStatus === 'granted' ? existingPreferences : loaded.manifest.defaults;
  const preferences = normalizePreferences(loaded.manifest, preferenceOptions, safeExistingPreferences);
  const incomingPlan = buildTargetPlan(loaded.manifest, sourceBuffers, preferences);
  const trustedInstalledPlan = await resolveTrustedInstalledPlan(stateResult, loaded, sourceBuffers);
  const inspection = await inspectUpdateActions(target, incomingPlan, stateResult, trustedInstalledPlan);
  const legacyArtifacts = await inspectLegacyArtifacts(target, stateResult);
  inspection.actions.push(...legacyArtifacts.actions);
  const integrationNeedsChange = await clientIntegrationsNeedChange(target, loaded.manifest);
  const requiresStateMigration = stateResult.kind !== 'current';
  const consentProjectionChange = stateResult.kind === 'current'
    ? await consentProjectionNeedsChange(target, stateResult.state)
    : true;
  const requiresStateRefresh = stateResult.kind === 'current' && (
    !distributionMatchesState(loaded, stateResult.state) ||
    stateResult.state.source?.pinType !== 'manifest-sha256' ||
    stateResult.state.source?.pin !== loaded.sha256 ||
    JSON.stringify(stateResult.state.preferences) !== JSON.stringify(preferences) ||
    inspection.stateRegistryNeedsRefresh
  );
  if (process.env.SCALVIN_TEST_UPDATE_HOOKS === '1' && typeof options.afterInspection === 'function') {
    await options.afterInspection({ target, inspection });
  }
  const authorizationRequired = inspection.conflicts.length > 0;
  const planNow = authorizationRequired ? destructivePlanTimestamp('update-replace', options) : new Date().toISOString();
  const previewChanges = [
    ...inspection.actions.map((action) => ({ type: action.type, target: action.item?.target || action.target, reason: action.reason })),
    ...(requiresStateRefresh ? [{ type: 'refresh-state', target: '.scalvin/state.json', reason: 'signed-distribution-registry' }] : []),
    ...(integrationNeedsChange ? [{ type: 'integrate-client', target: loaded.manifest.clientIntegrations.claude.settingsPath, reason: 'missing-hook-registration' }] : []),
    ...(consentProjectionChange ? [{ type: 'project-consent', target: '.therapy/state/DATA-CONTROLS.md', reason: 'canonical-state-projection' }] : [])
  ];
  const previewWarnings = [
    ...(ignoredPreferences.length ? [{ code: 'SENSITIVE_PREFERENCES_IGNORED', fields: ignoredPreferences }] : []),
    ...inspection.notices,
    ...legacyArtifacts.notices
  ];
  if (authorizationRequired && !options.force && !options['dry-run']) {
    throw new ScalvinError('Customized framework files were detected. Review the dry-run or use --force; a complete backup is created before forced replacement.', 'CUSTOMIZATIONS_DETECTED', { conflicts: inspection.conflicts });
  }
  if (inspection.actions.length === 0 && !requiresStateMigration && !requiresStateRefresh && !integrationNeedsChange && !consentProjectionChange) {
    return {
      status: 'up-to-date',
      workspacePath: target,
      workspaceId: stateResult.state.workspaceId,
      version: stateResult.state.product.version,
      changes: 0,
      nextAction: 'none'
    };
  }

  let prepared = null;
  let expectedConfirmation = null;
  const authorizationOptions = {
    manifestSha256: loaded.sha256,
    fromVersion: stateResult.state?.product?.version || legacyVersion,
    toVersion: loaded.manifest.product.version,
    conflicts: inspection.conflicts.map((conflict) => ({
      target: conflict.target,
      actualHash: conflict.actualHash,
      priorHash: conflict.priorHash,
      incomingHash: conflict.incomingHash
    })),
    planTimestamp: planNow
  };
  if (authorizationRequired) {
    prepared = await prepareUpdateStage({
      target, loaded, incomingPlan, trustedInstalledPlan, inspection, legacyArtifacts, stateResult, preferences, options, planNow
    });
    try {
      const authorization = await replacementConfirmation(
        target, prepared.stage, prepared.newState.workspaceId, 'update-replace', loaded.sha256, authorizationOptions
      );
      expectedConfirmation = authorization.token;
    } catch (error) {
      const failedPrepared = prepared;
      prepared = null;
      await discardPreparedUpdateStage(failedPrepared, error);
    }
  }
  if (options['dry-run'] || (authorizationRequired && !options.confirm)) {
    if (prepared) await discardPreparedUpdateStage(prepared);
    return {
      status: options['dry-run'] ? 'dry-run' : 'preview',
      workspacePath: target,
      workspaceId: prepared?.newState.workspaceId || stateResult.state?.workspaceId || null,
      fromVersion: stateResult.state?.product?.version || legacyVersion,
      toVersion: loaded.manifest.product.version,
      changes: previewChanges,
      conflicts: inspection.conflicts,
      stateMigration: requiresStateMigration,
      legacySourcesPendingConsent: legacyArtifacts.sourceRecords.length,
      ...(expectedConfirmation ? { confirmationRequired: expectedConfirmation } : {}),
      nextAction: expectedConfirmation
        ? `rerun-with---force-and---confirm-${expectedConfirmation}`
        : 'run-update',
      warnings: previewWarnings
    };
  }
  if (authorizationRequired) {
    const obsoletePrepared = prepared;
    prepared = null;
    let confirmationError = null;
    try {
      assertFreshConfirmation(options.confirm, expectedConfirmation);
    } catch (error) {
      confirmationError = error;
    }
    await discardPreparedUpdateStage(obsoletePrepared, confirmationError);
  }

  let backup;
  let stage = null;
  let activation = null;
  let activatedWorkspaceId = null;
  try {
    backup = await createBackup(target, { output: assertSafeBackupOutput(options['backup-output']) });
    prepared = await prepareUpdateStage({
      target, loaded, incomingPlan, trustedInstalledPlan, inspection, legacyArtifacts, stateResult, preferences, options, planNow
    });
    ({ stage } = prepared);
    const { newState, migratedSourceRecords, expectedTargetSnapshot } = prepared;
    if (authorizationRequired) {
      const afterBackup = await replacementConfirmation(
        target, stage, newState.workspaceId, 'update-replace', loaded.sha256, authorizationOptions
      );
      assertFreshConfirmation(options.confirm, afterBackup.token);
      const finalAuthorization = await replacementConfirmation(
        target, stage, newState.workspaceId, 'update-replace', loaded.sha256, authorizationOptions
      );
      assertFreshConfirmation(options.confirm, finalAuthorization.token);
    }
    testFailpoint('update-before-activate');
    activation = await activateDirectory(target, stage, { expectedTargetSnapshot });
    activatedWorkspaceId = newState.workspaceId;
    testFailpoint('update-after-activate');
    const warnings = [
      ...previewWarnings,
      ...(activation.retainedRollbackPath ? [{ code: 'PRIVATE_ROLLBACK_RETAINED', path: activation.retainedRollbackPath }] : [])
    ];
    return {
      status: 'updated',
      workspacePath: target,
      workspaceId: newState.workspaceId,
      version: loaded.manifest.product.version,
      changes: inspection.actions.length + (requiresStateRefresh ? 1 : 0) + (integrationNeedsChange ? 1 : 0) + (consentProjectionChange ? 1 : 0),
      conflictsOverwritten: options.force ? inspection.conflicts.length : 0,
      stateMigrated: requiresStateMigration,
      legacySourceRecords: migratedSourceRecords,
      backupPath: backup.backupPath,
      nextAction: activation.retainedRollbackPath ? 'remove-retained-private-rollback' : newState.consent?.status === 'not-decided' ? 'collect-consent' : 'run-doctor',
      warnings
    };
  } catch (caught) {
    let error = activation && caught?.details?.activeWorkspaceUpdated !== true
      ? postActivationFailure(caught, {
          workspaceId: activatedWorkspaceId,
          activation,
          finalizationStep: 'update-result-finalization',
          nextAction: 'inspect-active-workspace-and-run-doctor'
        })
      : caught;
    if (prepared) {
      try {
        await discardPreparedUpdateStage(prepared, error);
      } catch (cleanupOrOriginal) {
        error = cleanupOrOriginal;
      }
    }
    try { Object.defineProperty(error, 'scalvinOperationAttempted', { value: true }); } catch {}
    throw error;
  }
}

async function update(options = {}) {
  const operationId = `operation-${require('node:crypto').randomUUID()}`;
  try {
    return await updateInternal(options);
  } catch (caught) {
    const error = caught instanceof ScalvinError
      ? caught
      : new ScalvinError(caught.message || 'Update failed.', 'UNEXPECTED_ERROR');
    if (caught?.scalvinOperationAttempted && !error.scalvinOperationAttempted) {
      try { Object.defineProperty(error, 'scalvinOperationAttempted', { value: true }); } catch {}
    }
    let target = null;
    try { target = resolvePortablePath(options.target || options.workspace || '~/scalvin-workspace'); } catch {}
    if (error.scalvinOperationAttempted && target && await pathExists(path.join(target, '.scalvin', 'state.json')).catch(() => false)) {
      try {
        const receipt = await appendOperationFailure(target, {
          operationId,
          operation: 'update',
          errorCode: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'UNEXPECTED_ERROR',
          rollbackStatus: rollbackStatusFor(error)
        });
        error.details = { ...(error.details || {}), operationJournal: receipt.written
          ? { written: true, operationId: receipt.operationId, rollbackStatus: receipt.rollbackStatus }
          : { written: false, reason: receipt.reason, operationId: receipt.operationId, rollbackStatus: receipt.rollbackStatus } };
      } catch (journalError) {
        error.details = { ...(error.details || {}), operationJournal: { written: false, errorCode: journalError.code || 'OPERATION_JOURNAL_WRITE_FAILED' } };
      }
    }
    throw error;
  }
}

async function backup(options = {}) {
  const target = options.target || options.workspace;
  invariant(target, 'backup requires --workspace (or --target).', 'INVALID_ARGUMENT');
  const resolved = assertSafeWorkspaceTarget(resolvePortablePath(target));
  const loaded = await loadManifest(DISTRIBUTION_MANIFEST);
  const stateResult = await loadWorkspaceState(resolved, loaded.manifest);
  invariant(stateResult.kind === 'current' || stateResult.kind === 'legacy', 'Backup target is not a Scalvin workspace.', 'WORKSPACE_STATE_MISSING', { target: resolved });
  const action = options.action || 'create';
  invariant(['create', 'status', 'verify', 'delete'].includes(action), 'backup --action must be create, status, verify, or delete.', 'INVALID_ARGUMENT');
  if (action === 'create') {
    invariant(options.id === undefined && options.backup === undefined && options.confirm === undefined && !options['decline-reminder'], 'Backup create does not accept --id, --backup, --confirm, or --decline-reminder.', 'INVALID_ARGUMENT');
    let created = null;
    try {
      created = await createBackup(resolved, {
        output: assertSafeBackupOutput(options.output),
        dryRun: options['dry-run'],
        encrypt: options.encrypt,
        passphraseFile: options['passphrase-file']
      });
      if (options['dry-run']) return created;
      const receipt = await appendBackupOperationReceipt(resolved, {
        operation: 'create', backupId: created.backupId, phase: 'complete', status: 'passed'
      });
      return { ...created, operationReceiptWritten: receipt.written };
    } catch (error) {
      if (created && !options['dry-run']) error.details = {
        ...(error.details || {}),
        backupCreated: true,
        backupId: created.backupId,
        backupPath: created.backupPath
      };
      if (!options['dry-run']) await appendFailedBackupReceipt(resolved, {
        operation: 'create', backupId: created?.backupId || error.details?.backupId || null,
        phase: created || error.details?.backupCreated ? 'complete' : 'payload'
      }, error);
      throw error;
    }
  }

  invariant(stateResult.kind === 'current', `Backup ${action} requires a schema v2 workspace.`, 'WORKSPACE_STATE_MIGRATION_REQUIRED');

  invariant(options.output === undefined && !options.encrypt, `Backup ${action} does not accept --output or --encrypt.`, 'INVALID_ARGUMENT');
  if (options.id !== undefined) invariant(BACKUP_ID_PATTERN.test(options.id), 'Backup ID must be backup-<UUID-v4>.', 'BACKUP_ID_INVALID');
  if (action === 'status') {
    invariant(options.backup === undefined && options.confirm === undefined && options['passphrase-file'] === undefined, 'Backup status accepts only an optional --id.', 'INVALID_ARGUMENT');
    invariant(!(options['decline-reminder'] && options.id), 'A reminder decline cannot be combined with a backup ID lookup.', 'INVALID_ARGUMENT');
    let reminderDecline = null;
    if (options['decline-reminder']) {
      if (options['dry-run']) reminderDecline = { recorded: false, dryRun: true, nextAction: 'rerun-without-dry-run' };
      else reminderDecline = await declineBackupReminder(resolved);
    }
    const ledger = await readBackupLedgerStatus(resolved, { backupId: options.id });
    const record = options.id ? ledger.record : ledger.latest;
    if (ledger.reminder) invariant(/^\d+$/.test(ledger.reminder.sessionsSinceSuccessfulBackup || ''), 'Backup reminder state is invalid.', 'BACKUP_LEDGER_INVALID');
    return {
      status: options['dry-run'] && options['decline-reminder'] ? 'dry-run' : ledger.status,
      workspaceId: stateResult.state?.workspaceId || null,
      backupId: record?.backupId || options.id || null,
      recordCount: ledger.recordCount,
      operationReceiptCount: ledger.operationReceiptCount,
      backupStatus: record?.artifactStatus || null,
      createdAt: record?.createdAt || null,
      encrypted: record ? record.encryption !== 'none' : null,
      destinationClass: record?.destinationClass || null,
      deletedAt: record?.deletedAt || null,
      reminder: ledger.reminder ? {
        sessionsSinceSuccessfulBackup: Number(ledger.reminder.sessionsSinceSuccessfulBackup),
        lastReminderAt: ledger.reminder.lastReminderAt === 'null' ? null : ledger.reminder.lastReminderAt,
        reminderDeclinedUntil: ledger.reminder.reminderDeclinedUntil === 'null' ? null : ledger.reminder.reminderDeclinedUntil
      } : null,
      reminderDecline,
      contentIncluded: false,
      artifactPathIncluded: false,
      nextAction: record ? 'none' : 'create-or-identify-backup'
    };
  }

  invariant(options.id !== undefined, `Backup ${action} requires --id.`, 'BACKUP_ID_REQUIRED');
  invariant(!options['decline-reminder'], `Backup ${action} does not accept --decline-reminder.`, 'INVALID_ARGUMENT');
  let artifact;
  if (options.backup !== undefined) artifact = assertSafeBackupOutput(options.backup);
  else artifact = await findDefaultBackupById(resolved, options.id);
  invariant(artifact, 'This backup is not in the default sibling store; provide its exact artifact path with --backup.', 'BACKUP_PATH_REQUIRED', { backupId: options.id });
  let summary;
  try {
    summary = await getBackupSummary(artifact, { passphraseFile: options['passphrase-file'], verify: true });
    invariant(summary.backupId === options.id, 'Backup ID does not match the authenticated artifact.', 'BACKUP_ID_MISMATCH');
  } catch (error) {
    await appendFailedBackupReceipt(resolved, {
      operation: action, backupId: options.id, phase: 'verify'
    }, error);
    throw error;
  }
  if (action === 'verify') {
    invariant(options.confirm === undefined, 'Backup verify does not accept --confirm.', 'INVALID_ARGUMENT');
    if (options['dry-run']) {
      return {
        ...summary, status: 'dry-run', workspaceId: stateResult.state?.workspaceId || null,
        operationReceiptWritten: false, contentIncluded: false, artifactPathIncluded: false,
        nextAction: 'rerun-backup-verify'
      };
    }
    const receipt = await appendBackupOperationReceipt(resolved, {
      operation: 'verify', backupId: summary.backupId, phase: 'complete', status: 'passed'
    });
    return { ...summary, workspaceId: stateResult.state?.workspaceId || null, operationReceiptWritten: receipt.written, contentIncluded: false, artifactPathIncluded: false, nextAction: 'none' };
  }

  const artifactIdentity = backupArtifactIdentity(artifact);
  const selector = `${summary.backupId}:${summary.checksum}:${artifactIdentity}`;
  const expectedConfirmation = confirmationToken(stateResult.state.workspaceId, 'backup-delete', selector);
  if (!options.confirm || options['dry-run']) {
    return {
      status: 'preview', workspaceId: stateResult.state.workspaceId, backupId: summary.backupId,
      createdAt: summary.createdAt, encrypted: summary.encrypted, files: summary.files,
      confirmationRequired: expectedConfirmation, contentIncluded: false, artifactPathIncluded: false,
      nextAction: `rerun-with---confirm-${expectedConfirmation}`
    };
  }
  try {
    assertFreshConfirmation(options.confirm, expectedConfirmation);
  } catch (error) {
    await appendFailedBackupReceipt(resolved, {
      operation: 'delete', backupId: summary.backupId, phase: 'preflight'
    }, error);
    throw error;
  }
  let deleted = null;
  let deletionLedger = null;
  try {
    deleted = await deleteBackupArtifact(artifact, {
      expectedBackupId: summary.backupId,
      expectedChecksum: summary.checksum,
      expectedArtifactIdentity: artifactIdentity,
      passphraseFile: options['passphrase-file']
    });
    const ledger = await markBackupDeleted(resolved, { backupId: deleted.backupId, deletedAt: deleted.deletedAt });
    deletionLedger = ledger;
    const receipt = await appendBackupOperationReceipt(resolved, {
      operation: 'delete', backupId: deleted.backupId, phase: 'complete', status: 'passed'
    });
    const ledgerGap = ledger.written === false && ledger.reason !== 'usage-ledgers-off';
    return {
      status: ledgerGap ? 'partial' : 'deleted', workspaceId: stateResult.state.workspaceId, backupId: deleted.backupId,
      deletedAt: deleted.deletedAt, ledgerWritten: ledger.written, operationReceiptWritten: receipt.written,
      artifactDeleted: true,
      ...(ledger.reason ? { ledgerReason: ledger.reason } : {}),
      ...(ledgerGap ? { warnings: [{ code: 'BACKUP_DELETION_LEDGER_RECONCILIATION_REQUIRED', reason: ledger.reason }] } : {}),
      contentIncluded: false, artifactPathIncluded: false,
      nextAction: ledgerGap ? 'reconcile-backup-deletion-ledger' : 'none'
    };
  } catch (error) {
    if (deleted) {
      const ledgerReconciled = deletionLedger?.written === true || deletionLedger?.reason === 'usage-ledgers-off';
      error.details = {
        ...(error.details || {}),
        status: 'partial',
        artifactDeleted: true,
        backupId: deleted.backupId,
        deletedAt: deleted.deletedAt,
        ledgerReconciled,
        nextAction: ledgerReconciled
          ? 'reconcile-backup-delete-operation-receipt'
          : 'reconcile-backup-deletion-ledger'
      };
    }
    await appendFailedBackupReceipt(resolved, {
      operation: 'delete', backupId: summary.backupId, phase: 'apply'
    }, error);
    throw error;
  }
}

const RESTORE_UNBOUND_OPERATIONAL_PATHS = new Set(['.therapy/state/BACKUP-LEDGER.md']);

async function planRestoreReplacement(target, verified) {
  const currentEntries = (await walkTree(target))
    .filter((entry) => !RESTORE_UNBOUND_OPERATIONAL_PATHS.has(entry.path))
    .map((entry) => ({ path: entry.path, type: entry.type, mode: entry.mode, ...(entry.type === 'file' ? { size: entry.size } : {}) }));
  const currentFiles = currentEntries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
  const incomingFiles = verified.integrity.entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({ path: validateRelativePath(entry.path), sha256: entry.sha256 }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const incomingSnapshotPaths = incomingFiles.map((entry) => entry.path).filter((relative) => !RESTORE_UNBOUND_OPERATIONAL_PATHS.has(relative));
  return {
    selector: verified.integrity.backupId,
    ids: [verified.integrity.backupId],
    plannedWriteHashes: incomingFiles,
    writes: null,
    deletes: currentFiles,
    affectedPaths: [...new Set([...currentFiles, ...incomingSnapshotPaths])].sort(),
    currentEntries,
    incomingFileCount: incomingFiles.length
  };
}

function restoreTokenOptions(plan, verified) {
  return {
    backupId: verified.integrity.backupId,
    backupChecksum: verified.checksum,
    incomingWorkspaceId: verified.integrity.workspaceId,
    currentEntries: plan.currentEntries,
    unboundOperationalPaths: [...RESTORE_UNBOUND_OPERATIONAL_PATHS].sort()
  };
}

async function restore(options = {}) {
  invariant(options.backup, 'restore requires --backup.', 'INVALID_ARGUMENT');
  invariant(options.target || options.workspace, 'restore requires --workspace (or --target).', 'INVALID_ARGUMENT');
  const target = assertSafeWorkspaceTarget(resolvePortablePath(options.target || options.workspace));
  let verified = null;
  let stage = null;
  let nonEmpty = false;
  let receiptPhase = 'preflight';
  let backupId = null;
  let receiptEligible = false;
  let targetWorkspaceId = null;
  let initialTargetSnapshot = null;
  try {
    await rejectSymlinkPath(target, { allowMissing: true });
    nonEmpty = await isNonEmptyDirectory(target);
    initialTargetSnapshot = await snapshotWorkspaceTree(target);
    const snapshotNonEmpty = initialTargetSnapshot.state === 'directory' && initialTargetSnapshot.entries.length > 0;
    invariant(snapshotNonEmpty === nonEmpty, 'The restore target changed during preflight; inspect it and try again.', 'STALE_WORKSPACE');
    if (options['passphrase-file']) {
      const passphrasePath = resolvePortablePath(options['passphrase-file']);
      await rejectSymlinkPath(passphrasePath);
      invariant(!isInside(target, passphrasePath), 'Restore passphrase file must be outside the target workspace so an automatic displaced-workspace backup cannot copy it.', 'PASSPHRASE_INSIDE_WORKSPACE');
    }
    if (nonEmpty) {
      const bundled = await loadManifest(DISTRIBUTION_MANIFEST);
      const targetState = await loadWorkspaceState(target, bundled.manifest);
      invariant(targetState.kind === 'current' || targetState.kind === 'legacy', 'Forced restore target is not a Scalvin workspace.', 'RESTORE_TARGET_NOT_SCALVIN', { target });
      targetWorkspaceId = targetState.state.workspaceId || 'legacy-workspace';
    }
    if (nonEmpty && !options.force) {
      throw new ScalvinError('Restore target is not empty. Use --force to create a safety backup and replace it.', 'TARGET_NOT_EMPTY', { target });
    }
    receiptPhase = 'verify';
    verified = await verifyBackup(options.backup, {
      passphraseFile: options['passphrase-file'],
      materialize: !options['dry-run']
    });
    backupId = verified.integrity.backupId;
    if (nonEmpty) {
      const replacementPlan = await planRestoreReplacement(target, verified);
      const expectedConfirmation = await destructivePlanToken(
        target,
        targetWorkspaceId,
        'restore-replace',
        replacementPlan,
        restoreTokenOptions(replacementPlan, verified)
      );
      if (!options.confirm) {
        return {
          status: 'preview', workspacePath: target, workspaceId: verified.integrity.workspaceId,
          backupPath: verified.backupPath, files: replacementPlan.incomingFileCount,
          targetBackupRequired: true, replacedFiles: replacementPlan.deletes.length,
          confirmationRequired: expectedConfirmation,
          nextAction: `rerun-with---confirm-${expectedConfirmation}`
        };
      }
      assertFreshConfirmation(options.confirm, expectedConfirmation);
      receiptEligible = true;
    }
    if (options['dry-run']) {
      return {
        status: 'dry-run',
        workspacePath: target,
        workspaceId: verified.integrity.workspaceId,
        backupPath: verified.backupPath,
        files: verified.integrity.entries.filter((entry) => entry.type === 'file').length,
        targetBackupRequired: nonEmpty,
        nextAction: nonEmpty ? 'run-restore-with-force-and-exact-confirmation' : 'run-restore'
      };
    }
    receiptPhase = 'payload';
    let targetBackup = null;
    if (nonEmpty) {
      const beforeBackupPlan = await planRestoreReplacement(target, verified);
      const beforeBackupToken = await destructivePlanToken(target, targetWorkspaceId, 'restore-replace', beforeBackupPlan, restoreTokenOptions(beforeBackupPlan, verified));
      assertFreshConfirmation(options.confirm, beforeBackupToken);
      targetBackup = await createBackup(target, { output: assertSafeBackupOutput(options['backup-output']) });
      const afterBackupPlan = await planRestoreReplacement(target, verified);
      const afterBackupToken = await destructivePlanToken(target, targetWorkspaceId, 'restore-replace', afterBackupPlan, restoreTokenOptions(afterBackupPlan, verified));
      assertFreshConfirmation(options.confirm, afterBackupToken);
    }
    receiptPhase = 'apply';
    const expectedTargetSnapshot = nonEmpty ? await snapshotWorkspaceTree(target) : initialTargetSnapshot;
    stage = await makeSiblingTemp(target, 'restore-stage');
    await copyTree(verified.payloadPath, stage);
    await hardenTree(stage);
    await validateWorkspaceStage(stage);
    if (nonEmpty) {
      const finalPlan = await planRestoreReplacement(target, verified);
      const finalToken = await destructivePlanToken(target, targetWorkspaceId, 'restore-replace', finalPlan, restoreTokenOptions(finalPlan, verified));
      assertFreshConfirmation(options.confirm, finalToken);
    }
    testFailpoint('restore-before-activate');
    const activation = await activateDirectory(target, stage, { expectedTargetSnapshot });
    stage = null;
    receiptEligible = true;
    receiptPhase = 'complete';
    let receipt = { written: false };
    let receiptError = null;
    try {
      testFailpoint('restore-after-activate');
      receipt = await appendBackupOperationReceipt(target, {
        operation: 'restore', backupId, phase: 'complete', status: 'passed'
      });
    } catch (error) {
      receiptError = error;
      await appendFailedBackupReceipt(target, {
        operation: 'restore', backupId, phase: 'complete'
      }, error);
    }
    const activationInfo = activationDisclosure(activation);
    const warnings = [
      ...(activationInfo.warnings || []),
      ...(receiptError ? [{ code: 'RESTORE_RECEIPT_RECONCILIATION_REQUIRED', errorCode: stableOperationErrorCode(receiptError) }] : [])
    ];
    const nextAction = receiptError && activation.retainedRollbackPath
      ? 'reconcile-restore-receipt-and-remove-retained-private-rollback'
      : receiptError
        ? 'reconcile-restore-operation-receipt'
        : activationInfo.nextAction || 'run-doctor';
    return {
      status: receiptError ? 'partial' : 'restored',
      restoreApplied: true,
      workspacePath: target,
      workspaceId: verified.integrity.workspaceId,
      backupPath: verified.backupPath,
      displacedWorkspaceBackup: targetBackup?.backupPath || null,
      files: verified.integrity.entries.filter((entry) => entry.type === 'file').length,
      operationReceiptWritten: receipt.written,
      ...activationInfo,
      warnings,
      nextAction
    };
  } catch (error) {
    if (stage) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (!options['dry-run'] && receiptEligible) {
      await appendFailedBackupReceipt(target, {
        operation: 'restore', backupId, phase: receiptPhase
      }, error);
    }
    throw error;
  } finally {
    if (verified) await verified.cleanup();
  }
}

async function consent(options = {}) {
  invariant(options.target || options.workspace, 'consent requires --workspace (or --target).', 'INVALID_ARGUMENT');
  const shorthand = options.status !== undefined;
  const categoryMode = options.category !== undefined || options.value !== undefined;
  invariant(shorthand !== categoryMode, 'consent requires either --status or --category with --value.', 'INVALID_ARGUMENT');
  let category;
  let value;
  if (shorthand) {
    const consentStatus = validateConsentOption(options.status);
    category = 'continuity_memory';
    value = consentStatus === 'granted' ? 'on' : consentStatus === 'declined' ? 'off' : 'ask';
  } else {
    invariant(options.category && options.value, 'Category consent requires both --category and --value.', 'INVALID_ARGUMENT');
    category = options.category;
    value = options.value;
    invariant(CONSENT_CATEGORY_SPECS[category], 'Unknown consent category.', 'INVALID_CONSENT_CATEGORY', { category, available: Object.keys(CONSENT_CATEGORY_SPECS) });
  }
  const target = assertSafeWorkspaceTarget(resolvePortablePath(options.target || options.workspace));
  await rejectSymlinkPath(target);
  invariant(await isNonEmptyDirectory(target), 'Workspace does not exist or is empty.', 'WORKSPACE_NOT_FOUND', { target });
  const expectedTargetSnapshot = await snapshotWorkspaceTree(target);
  const loaded = await loadManifest(DISTRIBUTION_MANIFEST);
  const stateResult = await loadWorkspaceState(target, loaded.manifest);
  invariant(stateResult.kind === 'current', 'Consent changes require a schema v2 workspace; run a pinned update first.', 'WORKSPACE_STATE_MIGRATION_REQUIRED', { kind: stateResult.kind });
  const projectionChange = await consentProjectionNeedsChange(target, stateResult.state);
  const preview = structuredClone(stateResult.state);
  const change = applyConsentChoice(preview, { category, value, retention: options.retention, eventSource: 'cli-consent' });
  if (!change.changed && !projectionChange) {
    return {
      status: 'unchanged',
      workspacePath: target,
      workspaceId: stateResult.state.workspaceId,
      category,
      value,
      previousValue: change.previousValue,
      consentStatus: preview.consent.status,
      nextAction: nextActionForConsent(preview.consent.status)
    };
  }
  if (options['dry-run']) {
    return {
      status: 'dry-run',
      workspacePath: target,
      workspaceId: stateResult.state.workspaceId,
      category,
      value,
      previousValue: change.previousValue,
      consentStatus: preview.consent.status,
      retention: change.retention,
      projectionRepair: projectionChange,
      nextAction: 'run-consent-update'
    };
  }

  const stage = await makeSiblingTemp(target, 'consent-stage');
  try {
    await copyTree(target, stage, { expectedSourceSnapshot: expectedTargetSnapshot });
    const state = preview;
    await projectConsentState(stage, state);
    await writeState(stage, state, loaded.manifest);
    await hardenTree(stage);
    await validatePrivacyWorkspaceStage(stage, { expectedState: state });
    await preflightExplicitLocalPointerDestination();
    testFailpoint('consent-before-activate');
    const activation = await activateDirectory(target, stage, { expectedTargetSnapshot });
    await finalizeLocalPointerAfterActivation(target, state.workspaceId, activation, 'consent');
    return {
      status: change.changed ? 'updated' : 'repaired',
      workspacePath: target,
      workspaceId: state.workspaceId,
      category,
      value,
      previousValue: change.previousValue,
      consentStatus: state.consent.status,
      retention: change.retention,
      eventId: state.consent?.eventId || null,
      nextAction: nextActionForConsent(state.consent.status),
      ...activationDisclosure(activation)
    };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function controlEvent(category, from, to, now = new Date().toISOString()) {
  return { eventId: `control-${require('node:crypto').randomUUID()}`, at: now, category, from, to };
}

function activationDisclosure(activation, destructive = false, existingCopies = []) {
  const rollbackRetained = Boolean(activation?.retainedRollbackPath);
  const pointerWarning = Boolean(activation?.finalizationWarnings?.length);
  if (!rollbackRetained && !pointerWarning) return {};
  const warnings = [
    ...(rollbackRetained ? [{ code: 'PRIVATE_ROLLBACK_RETAINED', path: activation.retainedRollbackPath }] : []),
    ...(activation.finalizationWarnings || [])
  ];
  const nextAction = rollbackRetained && pointerWarning
    ? 'repair-local-workspace-pointer-and-remove-retained-private-rollback'
    : rollbackRetained
      ? 'remove-retained-private-rollback'
      : activation.finalizationNextAction;
  const common = {
    ...(rollbackRetained
      ? { retainedSeparateCopies: [...existingCopies, { kind: 'activation_rollback', path: activation.retainedRollbackPath }] }
      : {}),
    ...(pointerWarning ? { workspaceApplied: true, localPointerWritten: false } : {}),
    warnings,
    nextAction
  };
  return destructive && rollbackRetained
    ? { ...common, status: 'partial', activeWorkspaceUpdated: true, deletionComplete: false }
    : common;
}

async function currentWorkspaceContext(options, label) {
  invariant(options.target || options.workspace, `${label} requires --workspace (or --target).`, 'INVALID_ARGUMENT');
  const target = assertSafeWorkspaceTarget(resolvePortablePath(options.target || options.workspace));
  await rejectSymlinkPath(target);
  invariant(await isNonEmptyDirectory(target), 'Workspace does not exist or is empty.', 'WORKSPACE_NOT_FOUND', { target });
  const expectedTargetSnapshot = await snapshotWorkspaceTree(target);
  const loaded = await loadManifest(DISTRIBUTION_MANIFEST);
  const stateResult = await loadWorkspaceState(target, loaded.manifest);
  invariant(stateResult.kind === 'current', `${label} requires a valid schema v2 workspace; run a pinned update first.`, 'WORKSPACE_STATE_MIGRATION_REQUIRED', { kind: stateResult.kind });
  return { target, loaded, state: structuredClone(stateResult.state), expectedTargetSnapshot };
}

async function applyContentTransaction(context, label, plan, receipt, options = {}) {
  const { expectedTargetSnapshot } = context;
  invariant(expectedTargetSnapshot, 'Content transaction requires the pre-read workspace snapshot.', 'ACTIVATION_SNAPSHOT_REQUIRED');
  const stage = await makeSiblingTemp(context.target, `${label}-stage`);
  try {
    await copyTree(context.target, stage, { expectedSourceSnapshot: expectedTargetSnapshot });
    const appliedPlan = options.replan ? await options.replan(stage) : plan;
    await applyPlan(stage, appliedPlan);
    const receiptWritten = receipt && context.state.consent.usageLedgers === 'on'
      ? await appendDeletionReceipt(stage, receipt)
      : false;
    if (label === 'memory-delete-all') await projectLanguagePreference(stage, context.state.preferences.language);
    await projectConsentState(stage, context.state);
    await writeState(stage, context.state, context.loaded.manifest);
    await hardenTree(stage);
    await validatePrivacyWorkspaceStage(stage, { expectedState: context.state });
    await preflightExplicitLocalPointerDestination();
    testFailpoint(`${label}-before-activate`);
    const activation = await activateDirectory(context.target, stage, { expectedTargetSnapshot });
    await finalizeLocalPointerAfterActivation(context.target, context.state.workspaceId, activation, label);
    return { receiptWritten, activation };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function refreshLanguageRenderedTargets(stage, loaded, state, previousPreferences) {
  invariant(
    state.product?.version === loaded.manifest.product.version && state.product?.manifestSha256 === loaded.sha256,
    'Language projection requires the exact installed distribution; run a pinned update first.',
    'WORKSPACE_UPDATE_REQUIRED'
  );
  const sourceBuffers = await loadVerifiedSources(loaded);
  const previousPlan = buildTargetPlan(loaded.manifest, sourceBuffers, previousPreferences);
  const expectedPlan = buildTargetPlan(loaded.manifest, sourceBuffers, state.preferences);
  const previousByTarget = new Map(previousPlan.map((item) => [item.target, item]));
  const expectedTargets = expectedPlan.map((item) => item.target).sort();
  const previousTargets = previousPlan.map((item) => item.target).sort();
  const stateTargets = Object.keys(state.files || {}).sort();
  invariant(
    JSON.stringify(previousTargets) === JSON.stringify(stateTargets) &&
      JSON.stringify(expectedTargets) === JSON.stringify(stateTargets),
    'Language projection target membership differs from the installed workspace; run a pinned update first.',
    'WORKSPACE_UPDATE_REQUIRED'
  );

  const updates = [];
  const writes = [];
  for (const item of expectedPlan) {
    const previous = previousByTarget.get(item.target);
    const record = state.files[item.target];
    invariant(
      previous && record && record.sourcePath === item.sourcePath && record.sourceHash === item.sourceHash &&
        record.version === item.version && record.role === item.role && record.protection === item.protection,
      'Language projection found managed-target registry drift; run a pinned update first.',
      'WORKSPACE_UPDATE_REQUIRED',
      { target: item.target }
    );
    if (['seed', 'protected'].includes(item.protection) || previous.installedHash === item.installedHash) continue;
    const filename = path.resolve(stage, item.target);
    assertInside(stage, filename, 'Language-rendered target');
    await rejectSymlinkPath(filename, { allowMissing: true });
    invariant(await pathExists(filename), 'A language-rendered managed target is missing.', 'PREFERENCE_TARGET_CUSTOMIZED', { target: item.target });
    const actualHash = await sha256File(filename);
    invariant(
      actualHash === previous.installedHash || actualHash === item.installedHash,
      'A language-rendered managed target was customized; refusing to overwrite it.',
      'PREFERENCE_TARGET_CUSTOMIZED',
      { target: item.target }
    );
    if (actualHash !== item.installedHash) writes.push(item);
    updates.push(item);
  }

  if (writes.length) await writePlan(stage, writes);
  for (const item of updates) {
    const actualHash = await sha256File(path.join(stage, item.target));
    invariant(actualHash === item.installedHash, 'Language-rendered target verification failed.', 'PREFERENCE_TARGET_VERIFY_FAILED', { target: item.target });
    state.files[item.target] = {
      sourcePath: item.sourcePath,
      sourceHash: item.sourceHash,
      installedHash: item.installedHash,
      version: item.version,
      role: item.role,
      protection: item.protection
    };
  }
  return updates.map((item) => item.target);
}

async function controlTransaction(options, label, mutate) {
  invariant(options.target || options.workspace, `${label} requires --workspace (or --target).`, 'INVALID_ARGUMENT');
  const target = assertSafeWorkspaceTarget(resolvePortablePath(options.target || options.workspace));
  await rejectSymlinkPath(target);
  invariant(await isNonEmptyDirectory(target), 'Workspace does not exist or is empty.', 'WORKSPACE_NOT_FOUND', { target });
  const expectedTargetSnapshot = await snapshotWorkspaceTree(target);
  const loaded = await loadManifest(DISTRIBUTION_MANIFEST);
  const stateResult = await loadWorkspaceState(target, loaded.manifest);
  invariant(stateResult.kind === 'current', `${label} requires a schema v2 workspace; run a pinned update first.`, 'WORKSPACE_STATE_MIGRATION_REQUIRED', { kind: stateResult.kind });
  const state = structuredClone(stateResult.state);
  const previousPreferences = structuredClone(state.preferences);
  const previousLanguage = state.preferences.language;
  const result = mutate(state);
  if (!result.changed) return { status: 'unchanged', workspacePath: target, workspaceId: state.workspaceId, ...result.output };
  if (options['dry-run']) return { status: 'dry-run', workspacePath: target, workspaceId: state.workspaceId, ...result.output, nextAction: `run-${label}-update` };
  const stage = await makeSiblingTemp(target, `${label}-stage`);
  try {
    await copyTree(target, stage, { expectedSourceSnapshot: expectedTargetSnapshot });
    let refreshedManagedTargets = [];
    if (state.preferences.language !== previousLanguage) {
      await projectLanguagePreference(stage, state.preferences.language);
      refreshedManagedTargets = await refreshLanguageRenderedTargets(stage, loaded, state, previousPreferences);
    }
    await projectConsentState(stage, state);
    await writeState(stage, state, loaded.manifest);
    await hardenTree(stage);
    await validatePrivacyWorkspaceStage(stage, { expectedState: state });
    await preflightExplicitLocalPointerDestination();
    testFailpoint(`${label}-before-activate`);
    const activation = await activateDirectory(target, stage, { expectedTargetSnapshot });
    await finalizeLocalPointerAfterActivation(target, state.workspaceId, activation, label);
    return {
      status: 'updated', workspacePath: target, workspaceId: state.workspaceId, ...result.output,
      ...(refreshedManagedTargets.length ? { refreshedManagedTargets } : {}),
      ...activationDisclosure(activation)
    };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function verifyChangePlan(stage, plan) {
  invariant(plan?.writes instanceof Map && Array.isArray(plan.deletes), 'Change-control plan is invalid.', 'CHANGE_PLAN_INVALID');
  for (const [relative, content] of plan.writes) {
    const normalized = validateRelativePath(relative);
    const filename = path.resolve(stage, normalized);
    assertInside(stage, filename, 'Change-control write');
    await rejectSymlinkPath(filename);
    const expected = Buffer.from(String(content));
    const actual = await readBoundedRegularFile(filename, Math.max(expected.length, 1), {
      typeCode: 'CHANGE_RECORD_NOT_REGULAR', sizeCode: 'CHANGE_RECORD_TOO_LARGE', changedCode: 'CHANGE_RECORD_CHANGED'
    });
    invariant(actual.equals(expected), 'Change-control write verification failed.', 'CHANGE_WRITE_VERIFY_FAILED');
  }
  for (const relative of plan.deletes) {
    const normalized = validateRelativePath(relative);
    const filename = path.resolve(stage, normalized);
    assertInside(stage, filename, 'Change-control deletion');
    invariant(!(await pathExists(filename)), 'Change-control deletion verification failed.', 'CHANGE_DELETE_VERIFY_FAILED');
  }
}

async function applyChangeTransaction(context, label, options, planner) {
  const { expectedTargetSnapshot } = context;
  invariant(expectedTargetSnapshot, 'Change transaction requires the pre-read workspace snapshot.', 'ACTIVATION_SNAPSHOT_REQUIRED');
  const stage = await makeSiblingTemp(context.target, `${label}-stage`);
  try {
    await copyTree(context.target, stage, { expectedSourceSnapshot: expectedTargetSnapshot });
    const plan = await planner(stage);
    if (options['dry-run']) {
      await fsp.rm(stage, { recursive: true, force: true });
      return { plan, persisted: false };
    }
    await applyPlan(stage, plan);
    await verifyChangePlan(stage, plan);
    const state = structuredClone(context.state);
    state.updatedAt = new Date().toISOString();
    await projectConsentState(stage, state);
    await writeState(stage, state, context.loaded.manifest);
    await hardenTree(stage);
    await validateWorkspaceStage(stage);
    await preflightExplicitLocalPointerDestination();
    testFailpoint(`${label}-before-activate`);
    const activation = await activateDirectory(context.target, stage, { expectedTargetSnapshot });
    await finalizeLocalPointerAfterActivation(context.target, state.workspaceId, activation, label);
    return { plan, persisted: true, activation };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function rollbackPreviewValues(root, revisionId) {
  invariant(REVISION_ID.test(revisionId || ''), 'Revision ID is invalid.', 'CHANGE_ID_INVALID');
  const relative = `.therapy/change-control/history/${revisionId.toLowerCase()}.json`;
  const filename = path.resolve(root, relative);
  assertInside(root, filename, 'Change revision');
  await rejectSymlinkPath(filename);
  const raw = (await readBoundedRegularFile(filename, 512 * 1024, {
    typeCode: 'CHANGE_RECORD_NOT_REGULAR', sizeCode: 'CHANGE_RECORD_TOO_LARGE', changedCode: 'CHANGE_RECORD_CHANGED'
  })).toString('utf8');
  let snapshot;
  try { snapshot = JSON.parse(raw); } catch { throw new ScalvinError('Change revision is invalid JSON.', 'CHANGE_RECORD_INVALID'); }
  validateSnapshot(snapshot);
  invariant(snapshot.revisionId === revisionId.toLowerCase(), 'Revision ID does not match its record.', 'CHANGE_RECORD_INVALID');
  invariant(raw === `${JSON.stringify(snapshot, null, 2)}\n`, 'Change revision is not canonical.', 'CHANGE_RECORD_NONCANONICAL');
  return {
    before: snapshot.afterOverlay?.settings || null,
    after: snapshot.beforeOverlay?.settings || null
  };
}

async function changes(options = {}) {
  const action = options.action;
  invariant(['propose', 'approve', 'reject', 'history', 'rollback'].includes(action), 'changes action must be propose, approve, reject, history, or rollback.', 'INVALID_ARGUMENT');
  const context = await currentWorkspaceContext(options, 'changes');
  assertSupportedRetentionClasses(context.state, ['behavior_customization']);

  if (action === 'history') {
    invariant(!options.confirm && !options['dry-run'], 'Change history is read-only and does not accept --confirm or --dry-run.', 'INVALID_ARGUMENT');
    const records = await listHistory(context.target, context.state);
    return {
      status: 'inspected', workspacePath: context.target, workspaceId: context.state.workspaceId,
      recordCount: records.length, history: records, contentIncluded: false, nextAction: 'none'
    };
  }

  if (action === 'propose') {
    invariant(!options.confirm && !options['change-id'] && !options['revision-id'], 'Change proposal does not accept approval, change, or revision selectors.', 'INVALID_ARGUMENT');
    const [value, why, expectedEffect, risksOrTradeoffs] = await Promise.all([
      readSessionInput(options, 'value', 'value-file', 'Change value', 16 * 1024),
      readSessionInput(options, 'why', 'why-file', 'Change reason', 16 * 1024),
      readSessionInput(options, 'expected-effect', 'expected-effect-file', 'Expected effect', 16 * 1024),
      readSessionInput(options, 'risks-or-tradeoffs', 'risks-file', 'Risks or tradeoffs', 16 * 1024)
    ]);
    const transaction = await applyChangeTransaction(context, 'changes-propose', options, (stage) => planProposal(stage, context.state, {
      target: options['change-target'], setting: options.setting, value,
      evidenceStatus: options['evidence-status'], why, expectedEffect, risksOrTradeoffs,
      sessionId: options['session-id'], now: options.now
    }));
    return {
      status: transaction.persisted ? 'proposed' : 'dry-run',
      workspacePath: context.target, workspaceId: context.state.workspaceId,
      changeId: transaction.plan.changeId, changeTarget: transaction.plan.target,
      setting: transaction.plan.setting, before: transaction.plan.before,
      after: transaction.plan.proposedAfter, persisted: transaction.persisted,
      nextAction: transaction.persisted ? 'review-changes-approve-preview' : 'rerun-changes-propose',
      ...activationDisclosure(transaction.activation)
    };
  }

  if (action === 'approve') {
    invariant(CHANGE_ID.test(options['change-id'] || ''), 'changes approve requires --change-id chg-<UUID-v4>.', 'CHANGE_ID_INVALID');
    invariant(!options['revision-id'], 'Change approval does not accept --revision-id.', 'INVALID_ARGUMENT');
    const preview = await planApprove(context.target, context.state, { changeId: options['change-id'] });
    const response = {
      status: 'preview', workspacePath: context.target, workspaceId: context.state.workspaceId,
      changeId: preview.changeId, changeTarget: preview.target, setting: preview.setting,
      before: preview.before, after: preview.proposedAfter,
      confirmationRequired: preview.confirmation,
      nextAction: 'review-exact-diff-then-rerun-with-confirm'
    };
    if (!options.confirm || options['dry-run']) return response;
    const transaction = await applyChangeTransaction(context, 'changes-approve', options, (stage) => planApprove(stage, context.state, {
      changeId: options['change-id'], confirm: options.confirm, now: options.now
    }));
    return {
      ...response, status: 'approved', confirmationRequired: undefined,
      revisionId: transaction.plan.revisionId, revision: transaction.plan.revision,
      persisted: transaction.persisted, nextAction: 'none',
      ...activationDisclosure(transaction.activation)
    };
  }

  if (action === 'reject') {
    invariant(CHANGE_ID.test(options['change-id'] || ''), 'changes reject requires --change-id chg-<UUID-v4>.', 'CHANGE_ID_INVALID');
    invariant(!options.confirm && !options['revision-id'], 'Change rejection does not accept --confirm or --revision-id.', 'INVALID_ARGUMENT');
    const wording = await readSessionInput(options, 'wording', 'wording-file', 'Change rejection wording', 16 * 1024);
    const transaction = await applyChangeTransaction(context, 'changes-reject', options, (stage) => planReject(stage, context.state, {
      changeId: options['change-id'], wording, now: options.now
    }));
    return {
      status: transaction.persisted ? 'rejected' : 'dry-run',
      workspacePath: context.target, workspaceId: context.state.workspaceId,
      changeId: transaction.plan.changeId, changeTarget: transaction.plan.target,
      sealedDeletion: transaction.plan.sealedDeletion, persisted: transaction.persisted,
      nextAction: transaction.persisted ? 'none' : 'rerun-changes-reject',
      ...activationDisclosure(transaction.activation, true)
    };
  }

  invariant(REVISION_ID.test(options['revision-id'] || ''), 'changes rollback requires --revision-id rev-<UUID-v4>.', 'CHANGE_ID_INVALID');
  invariant(!options['change-id'], 'Change rollback does not accept --change-id.', 'INVALID_ARGUMENT');
  const preview = await planRollback(context.target, context.state, { revisionId: options['revision-id'] });
  const values = await rollbackPreviewValues(context.target, preview.revisionId);
  const response = {
    status: 'preview', workspacePath: context.target, workspaceId: context.state.workspaceId,
    revisionId: preview.revisionId, changeTarget: preview.target,
    fromRevision: preview.fromRevision, toRevision: preview.toRevision,
    before: values.before, after: values.after,
    confirmationRequired: preview.confirmation,
    nextAction: 'review-exact-diff-then-rerun-with-confirm'
  };
  if (!options.confirm || options['dry-run']) return response;
  const transaction = await applyChangeTransaction(context, 'changes-rollback', options, (stage) => planRollback(stage, context.state, {
    revisionId: options['revision-id'], confirm: options.confirm,
    sessionId: options['session-id'], now: options.now
  }));
  return {
    ...response, status: 'rolled-back', confirmationRequired: undefined,
    sourceRevisionId: preview.revisionId, revisionId: transaction.plan.revisionId,
    changeId: transaction.plan.changeId, persisted: transaction.persisted, nextAction: 'none',
    ...activationDisclosure(transaction.activation)
  };
}

async function readJsonObjectOption(options, directKey, fileKey, label, maxBytes = 128 * 1024) {
  invariant(!(options[directKey] !== undefined && options[fileKey] !== undefined), `${label} accepts either direct JSON or a file, not both.`, 'INVALID_ARGUMENT');
  if (options[directKey] !== undefined) {
    invariant(options[directKey] && typeof options[directKey] === 'object' && !Array.isArray(options[directKey]), `${label} must be a JSON object.`, 'INVALID_ARGUMENT');
    return structuredClone(options[directKey]);
  }
  if (options[fileKey] === undefined) return undefined;
  const filename = resolvePortablePath(String(options[fileKey]));
  await rejectSymlinkPath(filename);
  const raw = (await readBoundedRegularFile(filename, maxBytes, {
    typeCode: 'SOURCE_INPUT_INVALID', sizeCode: 'SOURCE_INPUT_TOO_LARGE', changedCode: 'SOURCE_INPUT_CHANGED'
  })).toString('utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new ScalvinError(`${label} is not valid JSON.`, 'INVALID_ARGUMENT'); }
  invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} must be a JSON object.`, 'INVALID_ARGUMENT');
  return parsed;
}

async function sourceMemoryIds(options) {
  invariant(!(options.proposedMemoryIds !== undefined && options['proposed-memory-file'] !== undefined), 'Proposed memory IDs accept either direct input or a file, not both.', 'INVALID_ARGUMENT');
  if (options.proposedMemoryIds !== undefined) {
    invariant(Array.isArray(options.proposedMemoryIds), 'Proposed memory IDs must be an array.', 'INVALID_ARGUMENT');
    return [...options.proposedMemoryIds];
  }
  if (options['proposed-memory-id'] !== undefined) return [...options['proposed-memory-id']];
  if (options['proposed-memory-file'] === undefined) return [];
  const filename = resolvePortablePath(String(options['proposed-memory-file']));
  await rejectSymlinkPath(filename);
  const raw = (await readBoundedRegularFile(filename, 128 * 1024, {
    typeCode: 'SOURCE_INPUT_INVALID', sizeCode: 'SOURCE_INPUT_TOO_LARGE', changedCode: 'SOURCE_INPUT_CHANGED'
  })).toString('utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new ScalvinError('Proposed memory ID file is not valid JSON.', 'INVALID_ARGUMENT'); }
  invariant(Array.isArray(parsed), 'Proposed memory ID file must contain one JSON array.', 'INVALID_ARGUMENT');
  return parsed;
}

function sourceConsentOptions(options) {
  const proof = (direct, eventKey, retentionKey, category) => {
    if (direct !== undefined) return structuredClone(direct);
    if (options[eventKey] === undefined && options[retentionKey] === undefined) return undefined;
    invariant(options[eventKey] !== undefined && options[retentionKey] !== undefined, `Per-import ${category} consent requires both event ID and retention.`, 'INVALID_ARGUMENT');
    return { approved: true, category, eventId: options[eventKey], retention: options[retentionKey] };
  };
  return {
    importConsent: proof(options.importConsent, 'import-consent-event', 'import-retention', 'imported_sources'),
    externalCareConsent: proof(options.externalCareConsent, 'external-care-consent-event', 'external-care-retention', 'external_care_records')
  };
}

async function verifySourceResult(stage, result) {
  invariant(Array.isArray(result.written || []) && Array.isArray(result.deleted || []), 'Source operation result paths are invalid.', 'SOURCE_RESULT_INVALID');
  for (const relative of result.written || []) {
    const normalized = validateRelativePath(relative);
    const filename = path.resolve(stage, normalized);
    assertInside(stage, filename, 'Source lifecycle artifact');
    await rejectSymlinkPath(filename);
    const stat = await fsp.lstat(filename);
    invariant(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'Source lifecycle artifact verification failed.', 'SOURCE_ARTIFACT_VERIFY_FAILED');
  }
  for (const relative of result.deleted || []) {
    const normalized = validateRelativePath(relative);
    const filename = path.resolve(stage, normalized);
    assertInside(stage, filename, 'Source lifecycle deletion');
    invariant(!(await pathExists(filename)), 'Source lifecycle deletion verification failed.', 'SOURCE_ARTIFACT_VERIFY_FAILED');
  }
}

async function sourceTransaction(context, label, options, run) {
  const { expectedTargetSnapshot } = context;
  invariant(expectedTargetSnapshot, 'Source transaction requires the pre-read workspace snapshot.', 'ACTIVATION_SNAPSHOT_REQUIRED');
  const stage = await makeSiblingTemp(context.target, `${label}-stage`);
  try {
    await copyTree(context.target, stage, { expectedSourceSnapshot: expectedTargetSnapshot });
    const result = await run(stage);
    await verifySourceResult(stage, result);
    if (!result.canonicalPatch) {
      invariant((result.written || []).length === 0 && (result.deleted || []).length === 0, 'Source writes require a canonical state patch.', 'SOURCE_PATCH_REQUIRED');
      await fsp.rm(stage, { recursive: true, force: true });
      return { result, persisted: false };
    }
    const state = structuredClone(context.state);
    const priorLifecycle = JSON.stringify(state.sourceLifecycle);
    applySourceLifecyclePatch(state, result.canonicalPatch);
    if ((result.written || []).length === 0 && (result.deleted || []).length === 0 && JSON.stringify(state.sourceLifecycle) === priorLifecycle) {
      await fsp.rm(stage, { recursive: true, force: true });
      return { result, persisted: false };
    }
    state.updatedAt = new Date().toISOString();
    await projectConsentState(stage, state);
    await writeState(stage, state, context.loaded.manifest);
    await hardenTree(stage);
    if (['source-reject', 'source-delete'].includes(label)) await validatePrivacyWorkspaceStage(stage, { expectedState: state });
    else await validateWorkspaceStage(stage);
    if (options['dry-run']) {
      await fsp.rm(stage, { recursive: true, force: true });
      return { result, persisted: false, dryRun: true };
    }
    await preflightExplicitLocalPointerDestination();
    testFailpoint(`${label}-before-activate`);
    const activation = await activateDirectory(context.target, stage, { expectedTargetSnapshot });
    await finalizeLocalPointerAfterActivation(context.target, state.workspaceId, activation, label);
    return { result, persisted: true, activation };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function sourceMutationOutput(context, transaction, action) {
  const result = transaction.result;
  return {
    status: transaction.dryRun ? 'dry-run' : result.status,
    workspacePath: context.target,
    workspaceId: context.state.workspaceId,
    sourceId: result.sourceId || null,
    revision: result.revision ?? null,
    sha256: result.sha256 || null,
    byteLength: result.byteLength ?? null,
    kind: result.kind || null,
    locale: result.locale || null,
    trust: result.trust || 'untrusted_data',
    reason: result.reason || null,
    error: result.error || null,
    persisted: transaction.persisted,
    filesWritten: (result.written || []).length,
    filesDeleted: (result.deleted || []).length,
    proposedMemoryCount: (result.proposedMemoryIds || []).length,
    memoryWritten: result.memoryWritten === true,
    instructionsExecutable: false,
    contentIncluded: false,
    absolutePathIncluded: false,
    nextAction: result.status === 'pending_consent'
      ? 'record-explicit-source-consent'
      : transaction.dryRun
        ? `run-source-${action}`
        : result.status === 'ready'
          ? 'review-source-before-integration'
          : 'none',
    ...activationDisclosure(transaction.activation, ['reject', 'delete'].includes(action))
  };
}

async function source(options = {}) {
  const action = options.action;
  invariant(['add', 'status', 'integrate', 'reject', 'delete'].includes(action), 'source action must be add, status, integrate, reject, or delete.', 'INVALID_ARGUMENT');
  const context = await currentWorkspaceContext(options, 'source');
  if (!['status', 'delete'].includes(action)) assertSupportedRetentionClasses(context.state, ['imported_sources', 'external_care_records']);
  if (action === 'status') {
    invariant(options.path === undefined && options.confirm === undefined && !options['dry-run'], 'Source status is read-only and does not accept --path, --confirm, or --dry-run.', 'INVALID_ARGUMENT');
    const result = await statusSource({ workspace: context.target, sourceId: options['source-id'], revision: options.revision });
    return { ...result, workspacePath: context.target, workspaceId: context.state.workspaceId };
  }

  const consentOptions = sourceConsentOptions(options);
  if (action === 'add') {
    invariant(options.path || options.sourcePath, 'source add requires one exact --path.', 'INVALID_SOURCE_PATH');
    invariant(options.confirm === undefined, 'Source add does not accept --confirm.', 'INVALID_ARGUMENT');
    const provenance = await readJsonObjectOption(options, 'provenance', 'provenance-file', 'Source provenance');
    const transaction = await sourceTransaction(context, 'source-add', options, (stage) => importSource({
      workspace: stage, canonicalState: context.state, sourcePath: options.path || options.sourcePath,
      kind: options.kind, locale: options.locale, sourceId: options['source-id'], revision: options.revision,
      provenance, now: options.now, ...consentOptions
    }));
    return sourceMutationOutput(context, transaction, action);
  }

  invariant(options.path === undefined, `Source ${action} does not accept --path.`, 'INVALID_ARGUMENT');
  invariant(options['source-id'] !== undefined, `source ${action} requires --source-id.`, 'INVALID_SOURCE_ID');
  if (action === 'integrate') {
    const proposedMemoryIds = (await sourceMemoryIds(options)).map((item) => String(item).toLowerCase()).sort();
    const preview = await integrateSource({
      workspace: context.target, canonicalState: context.state, sourceId: options['source-id'],
      revision: options.revision, approved: false, proposedMemoryIds, ...consentOptions
    });
    if (preview.status === 'pending_consent') {
      return sourceMutationOutput(context, { result: preview, persisted: false }, action);
    }
    if (preview.status === 'already_integrated') {
      const patchRecord = preview.canonicalPatch?.sourceLifecycle?.record;
      const currentRecord = context.state.sourceLifecycle.records.find((item) => item.sourceId === patchRecord?.sourceId && item.revision === patchRecord?.revision);
      if (currentRecord && JSON.stringify(currentRecord) === JSON.stringify(patchRecord)) {
        return sourceMutationOutput(context, { result: preview, persisted: false }, action);
      }
      const transaction = await sourceTransaction(context, 'source-integrate', options, (stage) => integrateSource({
        workspace: stage, canonicalState: context.state, sourceId: options['source-id'],
        revision: options.revision, approved: false, proposedMemoryIds, ...consentOptions
      }));
      return sourceMutationOutput(context, transaction, action);
    }
    invariant(preview.status === 'approval_required' && typeof preview.sha256 === 'string', 'Source integration preview is invalid.', 'SOURCE_RESULT_INVALID');
    const planNow = destructivePlanTimestamp('source-integrate', options);
    const planned = await integrateSource({
      workspace: context.target, canonicalState: context.state, sourceId: options['source-id'],
      revision: options.revision, approved: true, expectedHash: preview.sha256,
      proposedMemoryIds, now: planNow, planOnly: true, ...consentOptions
    });
    invariant(planned.status === 'integration_planned' && planned.plannedWrites instanceof Map, 'Source integration plan is invalid.', 'SOURCE_RESULT_INVALID');
    const integrationPlan = {
      selector: `${planned.sourceId}:r${planned.revision}`,
      ids: proposedMemoryIds,
      revisions: [planned.revision],
      writes: planned.plannedWrites,
      deletes: [],
      affectedPaths: [planned.contentObject, ...planned.plannedWrites.keys()]
    };
    const tokenOptions = {
      sourceId: planned.sourceId,
      revision: planned.revision,
      contentHash: planned.sha256,
      proposedMemoryIds,
      consentProof: consentOptions,
      planTimestamp: planNow
    };
    const expectedConfirmation = await destructivePlanToken(
      context.target, context.state.workspaceId, 'source-integrate', integrationPlan, tokenOptions
    );
    const response = {
      status: 'preview', workspacePath: context.target, workspaceId: context.state.workspaceId,
      sourceId: preview.sourceId, revision: preview.revision, before: 'ready', after: 'integrated',
      expectedHash: preview.sha256, confirmationRequired: expectedConfirmation,
      proposedMemoryCount: proposedMemoryIds.length, memoryWritten: false,
      instructionsExecutable: false, contentIncluded: false, absolutePathIncluded: false,
      nextAction: 'review-exact-hash-then-rerun-with-confirm'
    };
    if (!options.confirm || options['dry-run']) return response;
    assertFreshConfirmation(options.confirm, expectedConfirmation);
    const transaction = await sourceTransaction(context, 'source-integrate', options, async (stage) => {
      const stagedPreview = await integrateSource({
        workspace: stage, canonicalState: context.state, sourceId: options['source-id'],
        revision: options.revision, approved: false, proposedMemoryIds, ...consentOptions
      });
      invariant(stagedPreview.status === 'approval_required', 'Source integration stage is no longer approval-ready.', 'SOURCE_PLAN_STALE');
      const stagedPlanned = await integrateSource({
        workspace: stage, canonicalState: context.state, sourceId: options['source-id'],
        revision: options.revision, approved: true, expectedHash: stagedPreview.sha256,
        proposedMemoryIds, now: planNow, planOnly: true, ...consentOptions
      });
      const stagedPlan = {
        selector: `${stagedPlanned.sourceId}:r${stagedPlanned.revision}`,
        ids: proposedMemoryIds,
        revisions: [stagedPlanned.revision],
        writes: stagedPlanned.plannedWrites,
        deletes: [],
        affectedPaths: [stagedPlanned.contentObject, ...stagedPlanned.plannedWrites.keys()]
      };
      const stagedExpected = await destructivePlanToken(stage, context.state.workspaceId, 'source-integrate', stagedPlan, tokenOptions);
      assertFreshConfirmation(options.confirm, stagedExpected);
      return integrateSource({
        workspace: stage, canonicalState: context.state, sourceId: options['source-id'],
        revision: options.revision, approved: true, expectedHash: stagedPreview.sha256,
        proposedMemoryIds, now: planNow, ...consentOptions
      });
    });
    return sourceMutationOutput(context, transaction, action);
  }

  const preview = await planSourceRemoval({
    workspace: context.target, canonicalState: context.state,
    sourceId: options['source-id'], revision: options.revision, action
  });
  const sourceConfirmation = await destructivePlanToken(context.target, context.state.workspaceId, `source-${action}`, preview, {
    sourceId: preview.sourceId,
    revision: options.revision === undefined ? null : Number(options.revision),
    action
  });
  const response = {
    status: 'preview', workspacePath: context.target, workspaceId: context.state.workspaceId,
    sourceId: preview.sourceId, revisions: preview.revisions, operation: action,
    affectedFiles: preview.affectedPaths.length, derivedMemoryCount: preview.derivedMemoryIds.length,
    knownBackupRecords: preview.knownBackupRecords, backupsRemainSeparateCopies: preview.backupActionRequired,
    confirmationRequired: sourceConfirmation,
    instructionsExecutable: false, contentIncluded: false, absolutePathIncluded: false,
    nextAction: 'review-exact-scope-then-rerun-with-confirm'
  };
  if (!options.confirm || options['dry-run']) return response;
  assertFreshConfirmation(options.confirm, sourceConfirmation);
  const transaction = await sourceTransaction(context, `source-${action}`, options, async (stage) => {
    const stagedPlan = await planSourceRemoval({
      workspace: stage, canonicalState: context.state,
      sourceId: options['source-id'], revision: options.revision, action
    });
    const stagedConfirmation = await destructivePlanToken(stage, context.state.workspaceId, `source-${action}`, stagedPlan, {
      sourceId: stagedPlan.sourceId,
      revision: options.revision === undefined ? null : Number(options.revision),
      action
    });
    assertFreshConfirmation(options.confirm, stagedConfirmation);
    return applySourceRemoval({
      workspace: stage, plan: stagedPlan, confirm: true, confirmationToken: stagedPlan.confirmationToken
    });
  });
  const output = sourceMutationOutput(context, transaction, action);
  return {
    ...output, revisions: transaction.result.revisions,
    derivedMemoryCount: (transaction.result.derivedMemoryIdsRemoved || []).length,
    knownBackupRecords: transaction.result.knownBackupRecords || 0,
    backupsRemainSeparateCopies: transaction.result.backupActionRequired === true || Boolean(transaction.activation?.retainedRollbackPath),
    nextAction: transaction.activation?.retainedRollbackPath && transaction.activation?.finalizationNextAction
      ? 'repair-local-workspace-pointer-and-remove-retained-private-rollback'
      : transaction.activation?.retainedRollbackPath
        ? 'remove-retained-private-rollback'
        : transaction.activation?.finalizationNextAction || (transaction.result.backupActionRequired ? 'review-backup-rotation-separately' : 'none')
  };
}

function timestampForTimezone(timezone) {
  const instant = new Date();
  if (timezone === 'unconfirmed') return instant.toISOString();
  let parts;
  try {
    parts = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
      timeZoneName: 'longOffset'
    }).formatToParts(instant);
  } catch {
    throw new ScalvinError('Timezone must be a real IANA name.', 'INVALID_TIMEZONE');
  }
  const field = (type) => parts.find((part) => part.type === type)?.value;
  const zone = field('timeZoneName');
  const match = /^(?:GMT|UTC)(?:([+-])(\d{2}):?(\d{2}))?$/.exec(zone || '');
  invariant(match, 'Timezone offset could not be represented safely.', 'INVALID_TIMEZONE');
  const offset = match[1] ? `${match[1]}${match[2]}:${match[3]}` : '+00:00';
  return `${field('year')}-${field('month')}-${field('day')}T${field('hour')}:${field('minute')}:${field('second')}.${field('fractionalSecond')}${offset}`;
}

function sessionTimezone(state, options) {
  if (options.timezone !== undefined) return String(options.timezone);
  return state.consent.timezone?.status === 'confirmed' ? state.consent.timezone.value : 'unconfirmed';
}

async function readSessionInput(options, directKey, fileKey, label, maximumBytes = 8 * 1024 * 1024) {
  invariant(!(options[directKey] !== undefined && options[fileKey] !== undefined), `${label} accepts either direct input or a file, not both.`, 'INVALID_ARGUMENT');
  if (options[directKey] !== undefined) {
    const value = String(options[directKey]);
    invariant(!value.includes('\0') && Buffer.byteLength(value) <= maximumBytes, `${label} is invalid or too large.`, 'INVALID_ARTIFACT_CONTENT');
    return value;
  }
  if (options[fileKey] === undefined) return undefined;
  const filename = resolvePortablePath(String(options[fileKey]));
  await rejectSymlinkPath(filename);
  return (await readBoundedRegularFile(filename, maximumBytes, {
    typeCode: 'ARTIFACT_INPUT_INVALID',
    sizeCode: 'ARTIFACT_INPUT_TOO_LARGE',
    changedCode: 'ARTIFACT_INPUT_CHANGED'
  })).toString('utf8');
}

async function readTranscriptInput(options) {
  if (options.transcript !== undefined) {
    invariant(options['transcript-file'] === undefined, 'Transcript accepts either direct input or a file, not both.', 'INVALID_ARGUMENT');
    invariant(options.transcript && typeof options.transcript === 'object' && !Array.isArray(options.transcript), 'Transcript input must be an object.', 'INVALID_TRANSCRIPT_COVERAGE');
    return structuredClone(options.transcript);
  }
  const raw = await readSessionInput(options, 'transcriptJson', 'transcript-file', 'Transcript JSON');
  if (raw === undefined) return undefined;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new ScalvinError('Transcript input is not valid JSON.', 'INVALID_TRANSCRIPT_COVERAGE'); }
  invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Transcript input must be an object.', 'INVALID_TRANSCRIPT_COVERAGE');
  return parsed;
}

function lifecycleSessionFromState(state, requestedSessionId) {
  const lifecycle = state.sessionLifecycle;
  invariant(lifecycle && ['active', 'interrupted'].includes(lifecycle.state), 'No active or interrupted canonical session exists.', 'SESSION_NOT_ACTIVE');
  if (requestedSessionId !== undefined) {
    invariant(SESSION_ID_PATTERN.test(requestedSessionId), 'Session ID must be s-<UUID-v4>.', 'INVALID_SESSION_ID');
    invariant(requestedSessionId.toLowerCase() === lifecycle.sessionId.toLowerCase(), 'Requested session does not match canonical session state.', 'SESSION_ID_MISMATCH');
  }
  return {
    id: lifecycle.sessionId,
    state: lifecycle.state,
    startedAt: lifecycle.startedAt,
    startedAtUtc: lifecycle.startedAtUtc,
    timezone: lifecycle.timezone,
    resumedAt: structuredClone(lifecycle.resumedAt),
    closedAt: lifecycle.closedAt,
    completion: lifecycle.completion,
    consentEventId: state.consent.eventId,
    authorName: state.preferences.companionName,
    lastPersistedTurn: lifecycle.checkpoint?.lastPersistedTurn || null,
    paths: artifactPaths(lifecycle.startedAt, lifecycle.sessionId),
    checkpoint: structuredClone(lifecycle.checkpoint),
    transcript: structuredClone(lifecycle.transcript)
  };
}

async function planSessionRecoveryDelete(root, state, requestedSessionId) {
  const sessionId = requestedSessionId.toLowerCase();
  const found = await findInterruptedSessions({ workspace: root, canonicalState: state });
  let recovered = found.candidates.find((candidate) => candidate.sessionId.toLowerCase() === sessionId)?.session || null;
  if (!recovered && state.sessionLifecycle?.sessionId?.toLowerCase() === sessionId) {
    recovered = lifecycleSessionFromState(state, requestedSessionId);
    recovered.state = 'interrupted';
  }
  invariant(recovered?.checkpoint?.path, 'No matching interrupted session checkpoint was found.', 'SESSION_RECOVERY_NOT_FOUND');
  const checkpointPath = validateRelativePath(recovered.checkpoint.path);
  invariant(checkpointPath === recovered.paths.checkpoint, 'Checkpoint path does not match the canonical session identity.', 'CHECKPOINT_METADATA_INVALID');
  const filename = path.resolve(root, checkpointPath);
  assertInside(root, filename, 'Session recovery deletion');
  await rejectSymlinkPath(filename);
  invariant(await pathExists(filename), 'No matching interrupted session checkpoint was found.', 'SESSION_RECOVERY_NOT_FOUND');
  return {
    selector: sessionId,
    ids: [sessionId],
    writes: new Map(),
    deletes: [checkpointPath],
    affectedPaths: [checkpointPath],
    session: recovered
  };
}

async function verifyLifecycleResult(stage, result) {
  invariant(Array.isArray(result.written || []) && Array.isArray(result.deleted || []), 'Lifecycle result paths are invalid.', 'SESSION_RESULT_INVALID');
  for (const relative of result.written || []) {
    const normalized = validateRelativePath(relative);
    const filename = path.resolve(stage, normalized);
    assertInside(stage, filename, 'Lifecycle artifact');
    await rejectSymlinkPath(filename);
    const stat = await fsp.lstat(filename);
    invariant(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'Lifecycle artifact verification failed.', 'ARTIFACT_VERIFY_FAILED');
  }
  for (const relative of result.deleted || []) {
    const normalized = validateRelativePath(relative);
    const filename = path.resolve(stage, normalized);
    assertInside(stage, filename, 'Lifecycle deletion');
    invariant(!(await pathExists(filename)), 'Lifecycle deletion verification failed.', 'ARTIFACT_VERIFY_FAILED');
  }
}

async function lifecycleTransaction(context, label, options, run) {
  const { expectedTargetSnapshot } = context;
  invariant(expectedTargetSnapshot, 'Lifecycle transaction requires the pre-read workspace snapshot.', 'ACTIVATION_SNAPSHOT_REQUIRED');
  const stage = await makeSiblingTemp(context.target, `${label}-stage`);
  try {
    await copyTree(context.target, stage, { expectedSourceSnapshot: expectedTargetSnapshot });
    const result = await run(stage);
    await verifyLifecycleResult(stage, result);
    const deepDiveWritten = Boolean(result.session?.paths?.deepDive && (result.written || []).includes(result.session.paths.deepDive));
    if (!result.canonicalPatch) {
      invariant((result.written || []).length === 0 && (result.deleted || []).length === 0, 'Lifecycle writes require a canonical patch.', 'SESSION_PATCH_REQUIRED');
      await fsp.rm(stage, { recursive: true, force: true });
      return {
        status: result.status,
        workspacePath: context.target,
        workspaceId: context.state.workspaceId,
        sessionId: result.session?.id || null,
        lifecycleState: result.session?.state || context.state.sessionLifecycle.state,
        persisted: false,
        reason: result.reason || null,
        filesWritten: 0,
        filesDeleted: 0,
        deepDiveWritten: false,
        nextAction: 'none'
      };
    }
    validateSessionLifecyclePatch(result.canonicalPatch);
    const nextState = structuredClone(context.state);
    nextState.consent.currentSessionId = result.canonicalPatch.consent.currentSessionId;
    nextState.sessionLifecycle = structuredClone(result.canonicalPatch.sessionLifecycle);
    nextState.updatedAt = new Date().toISOString();
    if (['closed', 'abandoned'].includes(nextState.sessionLifecycle.state)) {
      const evidence = nextState.sessionLifecycle.transcript;
      const stoppedAt = nextState.sessionLifecycle.closedAt || nextState.updatedAt;
      const pausedIntervals = evidence.pausedIntervals.map((interval) => interval.endedAt === null ? { ...interval, endedAt: stoppedAt } : interval);
      const knownGaps = structuredClone(evidence.knownGaps);
      for (const interval of pausedIntervals) {
        if (!knownGaps.some((gap) => gap.reason === 'paused_no_backfill' && gap.from === interval.startedAt)) {
          knownGaps.push({ from: interval.startedAt, to: interval.endedAt, reason: 'paused_no_backfill' });
        }
      }
      nextState.consent.transcriptState = {
        state: 'stopped',
        sessionId: nextState.sessionLifecycle.sessionId,
        captureGrade: evidence.captureGrade,
        startedAt: context.state.consent.transcriptState.startedAt || nextState.sessionLifecycle.startedAt,
        pausedIntervals,
        stoppedAt,
        knownGaps
      };
    }
    const backupReminder = nextState.sessionLifecycle.state === 'closed' && context.state.sessionLifecycle.state !== 'closed'
      ? await recordPersistedSessionClose(stage, { at: nextState.sessionLifecycle.closedAt || nextState.updatedAt })
      : null;
    await projectConsentState(stage, nextState);
    await writeState(stage, nextState, context.loaded.manifest);
    await hardenTree(stage);
    if (options.privacyValidation === true) await validatePrivacyWorkspaceStage(stage, { expectedState: nextState });
    else await validateWorkspaceStage(stage);
    if (options['dry-run']) {
      await fsp.rm(stage, { recursive: true, force: true });
      return {
        status: 'dry-run', workspacePath: context.target, workspaceId: nextState.workspaceId,
        sessionId: nextState.sessionLifecycle.sessionId, lifecycleState: nextState.sessionLifecycle.state,
        persisted: false, filesWritten: (result.written || []).length, filesDeleted: (result.deleted || []).length,
        deepDiveWritten,
        backupReminder: backupReminder ? { ...backupReminder, recorded: false, dryRun: true } : null,
        nextAction: `run-${label}`
      };
    }
    await preflightExplicitLocalPointerDestination();
    testFailpoint(`${label}-before-activate`);
    const activation = await activateDirectory(context.target, stage, { expectedTargetSnapshot });
    await finalizeLocalPointerAfterActivation(context.target, nextState.workspaceId, activation, label);
    return {
      status: result.status,
      workspacePath: context.target,
      workspaceId: nextState.workspaceId,
      sessionId: nextState.sessionLifecycle.sessionId,
      lifecycleState: nextState.sessionLifecycle.state,
      persisted: true,
      filesWritten: (result.written || []).length,
      filesDeleted: (result.deleted || []).length,
      deepDiveWritten,
      checkpointPresent: nextState.sessionLifecycle.checkpoint !== null,
      transcriptEvidence: {
        state: nextState.sessionLifecycle.transcript.state,
        captureGrade: nextState.sessionLifecycle.transcript.captureGrade,
        coveredTurns: nextState.sessionLifecycle.transcript.coveredTurns,
        knownGapCount: nextState.sessionLifecycle.transcript.knownGaps.length,
        fullCoverageProven: nextState.sessionLifecycle.transcript.fullCoverageProven,
        verbatimClaim: false
      },
      backupReminder,
      nextAction: activation.retainedRollbackPath ? 'remove-retained-private-rollback' : backupReminder?.due ? 'offer-backup' : 'none',
      ...activationDisclosure(activation, options.destructiveActivation === true)
    };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function session(options = {}) {
  invariant(['begin', 'checkpoint', 'close', 'recover', 'status'].includes(options.action), 'Session action is invalid.', 'INVALID_ARGUMENT');
  invariant(options.action === 'close' || (options['deep-dive-file'] === undefined && options.deepDiveBody === undefined), '--deep-dive-file is accepted only by session close.', 'INVALID_ARGUMENT');
  const context = await currentWorkspaceContext(options, 'session');
  const recoveryAction = options.action === 'recover' ? String(options['recovery-action'] || '').replaceAll('-', '_') : null;
  if (!(options.action === 'recover' && recoveryAction === 'delete')) {
    assertSupportedRetentionClasses(context.state, ['session_notes', 'primers_and_checkpoints', 'raw_transcripts']);
  }
  if (options.action === 'status') {
    const discovery = await findInterruptedSessions({ workspace: context.target, canonicalState: context.state });
    return {
      status: 'inspected', workspacePath: context.target, workspaceId: context.state.workspaceId,
      lifecycleState: context.state.sessionLifecycle.state,
      sessionId: context.state.sessionLifecycle.sessionId,
      currentSessionId: context.state.consent.currentSessionId,
      checkpointPresent: context.state.sessionLifecycle.checkpoint !== null,
      recoveryStatus: discovery.status,
      recoveryCandidates: discovery.candidates.map((candidate) => ({
        sessionId: candidate.sessionId, startedAt: candidate.startedAt, updatedAt: candidate.updatedAt,
        timezone: candidate.timezone, lifecycleState: candidate.lifecycleState,
        lastPersistedTurn: candidate.lastPersistedTurn, captureGrade: candidate.captureGrade,
        knownGapCount: candidate.knownGaps.length, recoveryReason: candidate.recoveryReason
      })),
      checkpointFilesRead: discovery.checkpointFilesRead,
      checkpointBodyExposed: false,
      nextAction: discovery.candidates.length ? 'choose-recovery-action' : 'none'
    };
  }

  if (options.action === 'begin') {
    const timezone = sessionTimezone(context.state, options);
    const now = options.now || timestampForTimezone(timezone);
    const authorName = options['author-name'] === undefined ? context.state.preferences.companionName : String(options['author-name']);
    invariant(authorName.length > 0 && authorName.length <= 100 && !/[\0\r\n]/.test(authorName), 'Session author name is invalid.', 'INVALID_ARTIFACT_CONTENT');
    return lifecycleTransaction(context, 'session-begin', options, (stage) => beginSession({
      workspace: stage, canonicalState: context.state, now, timezone, authorName
    }));
  }

  if (options.action === 'checkpoint') {
    const sessionState = lifecycleSessionFromState(context.state, options['session-id']);
    const turnNumber = Number(options['turn-number']);
    invariant(Number.isSafeInteger(turnNumber) && turnNumber > 0 && String(turnNumber) === String(options['turn-number']), 'Checkpoint requires a positive integer --turn-number.', 'INVALID_ARGUMENT');
    const [liveThread, unresolved, carryForward, transcriptInput] = await Promise.all([
      readSessionInput(options, 'liveThread', 'live-thread-file', 'Checkpoint live thread'),
      readSessionInput(options, 'unresolved', 'unresolved-file', 'Checkpoint unresolved item'),
      readSessionInput(options, 'carryForward', 'carry-forward-file', 'Checkpoint carry-forward'),
      readTranscriptInput(options)
    ]);
    return lifecycleTransaction(context, 'session-checkpoint', options, (stage) => checkpointTurn({
      workspace: stage, canonicalState: context.state, session: sessionState, turnNumber,
      now: options.now, liveThread: liveThread || '', unresolved: unresolved || '', carryForward: carryForward || '',
      ...(transcriptInput ? { transcript: transcriptInput } : {})
    }));
  }

  if (options.action === 'close') {
    const sessionState = lifecycleSessionFromState(context.state, options['session-id']);
    const [noteBody, deepDiveBody, primerBody, transcriptInput] = await Promise.all([
      readSessionInput(options, 'noteBody', 'note-file', 'Session note'),
      readSessionInput(options, 'deepDiveBody', 'deep-dive-file', 'Deep dive'),
      readSessionInput(options, 'primerBody', 'primer-file', 'Next primer'),
      readTranscriptInput(options)
    ]);
    return lifecycleTransaction(context, 'session-close', options, (stage) => closeSession({
      workspace: stage, canonicalState: context.state, session: sessionState, explicit: true,
      now: options.now, completion: options.completion, noteBody, deepDiveBody, primerBody,
      ...(transcriptInput ? { transcript: transcriptInput } : {})
    }));
  }

  invariant(['continue', 'close_interrupted', 'delete', 'abandon'].includes(recoveryAction), 'Session recover requires --recovery-action continue, close_interrupted, delete, or abandon.', 'INVALID_ARGUMENT');
  invariant(SESSION_ID_PATTERN.test(options['session-id'] || ''), 'Session recover requires --session-id s-<UUID-v4>.', 'INVALID_SESSION_ID');
  let recoveryDeletePlan = null;
  if (recoveryAction === 'delete') {
    recoveryDeletePlan = await planSessionRecoveryDelete(context.target, context.state, options['session-id']);
    const expected = await destructivePlanToken(context.target, context.state.workspaceId, 'session-recovery-delete', recoveryDeletePlan, {
      sessionId: recoveryDeletePlan.selector
    });
    if (!options.confirm || options['dry-run']) {
      return {
        status: 'preview', workspacePath: context.target, workspaceId: context.state.workspaceId,
        sessionId: options['session-id'].toLowerCase(), operation: 'session-recovery-delete',
        affectedFiles: recoveryDeletePlan.affectedPaths.length,
        confirmationRequired: expected, nextAction: `rerun-with---confirm-${expected}`
      };
    }
    assertFreshConfirmation(options.confirm, expected);
  }
  const [noteBody, primerBody, transcriptInput] = await Promise.all([
    readSessionInput(options, 'noteBody', 'note-file', 'Session note'),
    readSessionInput(options, 'primerBody', 'primer-file', 'Next primer'),
    readTranscriptInput(options)
  ]);
  return lifecycleTransaction(context, 'session-recover', {
    ...options,
    privacyValidation: recoveryAction === 'delete',
    destructiveActivation: recoveryAction === 'delete'
  }, async (stage) => {
    if (recoveryAction === 'delete') {
      const stagedPlan = await planSessionRecoveryDelete(stage, context.state, options['session-id']);
      const stagedExpected = await destructivePlanToken(stage, context.state.workspaceId, 'session-recovery-delete', stagedPlan, {
        sessionId: stagedPlan.selector
      });
      assertFreshConfirmation(options.confirm, stagedExpected);
      recoveryDeletePlan = stagedPlan;
    }
    const found = await findInterruptedSessions({ workspace: stage, canonicalState: context.state });
    let recovered = recoveryDeletePlan?.session
      || found.candidates.find((candidate) => candidate.sessionId.toLowerCase() === options['session-id'].toLowerCase())?.session;
    if (!recovered && context.state.sessionLifecycle.sessionId?.toLowerCase() === options['session-id'].toLowerCase()) {
      recovered = lifecycleSessionFromState(context.state, options['session-id']);
      recovered.state = 'interrupted';
    }
    invariant(recovered, 'No matching interrupted session checkpoint was found.', 'SESSION_RECOVERY_NOT_FOUND');
    recovered.authorName = context.state.preferences.companionName;
    recovered.consentEventId = context.state.consent.eventId;
    return recoverSession({
      workspace: stage, canonicalState: context.state, session: recovered, action: recoveryAction,
      canResumeContext: options['can-resume-context'] === true, now: options.now,
      noteBody, primerBody, ...(transcriptInput ? { transcript: transcriptInput } : {})
    });
  });
}

async function projectLanguagePreference(root, language) {
  const filename = path.join(root, 'SETUP-NOTES.md');
  await rejectSymlinkPath(filename);
  const markdown = (await readBoundedRegularFile(filename, 1024 * 1024, {
    typeCode: 'PREFERENCE_PROJECTION_INVALID',
    sizeCode: 'PREFERENCE_PROJECTION_TOO_LARGE',
    changedCode: 'PREFERENCE_PROJECTION_CHANGED'
  })).toString('utf8');
  const expression = /^- Default language:.*$/gm;
  const matches = [...markdown.matchAll(expression)];
  invariant(matches.length === 1, 'The language preference projection is missing or ambiguous.', 'PREFERENCE_PROJECTION_INVALID');
  await atomicWriteFile(filename, markdown.replace(expression, `- Default language: ${language}`));
}

async function readContextJsonInput(options, directKey, fileKey, label, parser, maximumBytes = 256 * 1024) {
  invariant(!(options[directKey] !== undefined && options[fileKey] !== undefined), `${label} accepts either a direct value or one file, not both.`, 'INVALID_ARGUMENT');
  if (options[directKey] !== undefined) return structuredClone(options[directKey]);
  invariant(options[fileKey] !== undefined, `${label} requires --${fileKey}.`, 'INVALID_ARGUMENT');
  const filename = resolvePortablePath(String(options[fileKey]));
  await rejectSymlinkPath(filename);
  const raw = (await readBoundedRegularFile(filename, maximumBytes, {
    typeCode: 'CONTEXT_INPUT_INVALID', sizeCode: 'CONTEXT_INPUT_TOO_LARGE', changedCode: 'CONTEXT_INPUT_CHANGED'
  })).toString('utf8');
  return parser(raw);
}

function combineContentPlans(primary, addition) {
  invariant(primary?.writes instanceof Map && Array.isArray(primary.deletes), 'Primary content plan is invalid.', 'CONTENT_PLAN_INVALID');
  invariant(addition?.writes instanceof Map && Array.isArray(addition.deletes), 'Additional content plan is invalid.', 'CONTENT_PLAN_INVALID');
  const writes = new Map(primary.writes);
  const deletes = new Set(primary.deletes);
  for (const [relative, content] of addition.writes) {
    invariant(!deletes.has(relative), 'A content plan cannot both delete and write the same path.', 'CONTENT_PLAN_CONFLICT', { path: relative });
    if (writes.has(relative)) invariant(writes.get(relative) === content, 'Two content plans disagree on one write.', 'CONTENT_PLAN_CONFLICT', { path: relative });
    else writes.set(relative, content);
  }
  for (const relative of addition.deletes) {
    invariant(!writes.has(relative), 'A content plan cannot both write and delete the same path.', 'CONTENT_PLAN_CONFLICT', { path: relative });
    deletes.add(relative);
  }
  return {
    ...primary,
    writes,
    deletes: [...deletes].sort(),
    affectedPaths: [...new Set([...(primary.affectedPaths || []), ...writes.keys(), ...deletes])].sort()
  };
}

async function planAllMemoryReferenceCleanup(root, state, ids, now) {
  if (ids.length <= 64) return planRemoveMemoryReferences(root, state, { ids, now });
  const stage = await makeSiblingTemp(root, 'context-reference-plan');
  try {
    const source = path.join(root, 'context');
    if (await pathExists(source)) await copyTree(source, path.join(stage, 'context'));
    const touched = new Set();
    let referenceRewrites = 0;
    for (let offset = 0; offset < ids.length; offset += 64) {
      const plan = await planRemoveMemoryReferences(stage, state, { ids: ids.slice(offset, offset + 64), now });
      referenceRewrites += plan.referenceRewrites;
      for (const relative of plan.writes.keys()) touched.add(relative);
      await applyPlan(stage, plan);
    }
    const writes = new Map();
    for (const relative of [...touched].sort()) {
      const filename = path.resolve(stage, validateRelativePath(relative));
      assertInside(stage, filename, 'Context reference cleanup result');
      const bytes = await readBoundedRegularFile(filename, 2 * 1024 * 1024, {
        typeCode: 'CONTEXT_RECORD_NOT_REGULAR', sizeCode: 'CONTEXT_RECORD_TOO_LARGE', changedCode: 'CONTEXT_RECORD_CHANGED'
      });
      writes.set(relative, bytes.toString('utf8'));
    }
    return { operation: 'remove-memory-references', memoryIds: [...ids].sort(), referenceRewrites, writes, deletes: [] };
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

async function addDefaultPersonalizationReset(context, plan) {
  const buffers = await loadVerifiedSources(context.loaded);
  const preferences = normalizePreferences(context.loaded.manifest, {});
  const defaults = buildTargetPlan(context.loaded.manifest, buffers, preferences);
  const resetItems = defaults.filter((item) => item.protection === 'active' || item.target === 'SETUP-NOTES.md');
  const defaultTargets = new Set(resetItems.map((item) => item.target));
  const writes = new Map(plan.writes);
  const deletes = new Set(plan.deletes);
  const stateFiles = structuredClone(context.state.files || {});
  for (const [target, record] of Object.entries(stateFiles)) {
    if (record.protection !== 'active' || defaultTargets.has(target)) continue;
    writes.delete(target);
    deletes.add(target);
    delete stateFiles[target];
  }
  for (const item of resetItems) {
    deletes.delete(item.target);
    writes.set(item.target, item.data);
    stateFiles[item.target] = {
      sourcePath: item.sourcePath,
      sourceHash: item.sourceHash,
      installedHash: item.installedHash,
      version: item.version,
      role: item.role,
      protection: item.protection
    };
  }
  return {
    ...plan,
    writes,
    deletes: [...deletes].sort(),
    affectedPaths: [...new Set([...writes.keys(), ...deletes])].sort(),
    stateFiles
  };
}

async function planMemoryDestruction(root, context, action, options, planNow) {
  let plan = action === 'forget'
    ? await planForget(root, { id: options.id, scope: options.scope })
    : await planDeleteAll(root);
  if (action === 'delete-all') plan = await addDefaultPersonalizationReset(context, plan);
  let contextReferenceRewrites = 0;
  if (action === 'forget') {
    const cleanup = await planAllMemoryReferenceCleanup(root, context.state, plan.ids, planNow);
    contextReferenceRewrites = cleanup.referenceRewrites;
    plan = combineContentPlans(plan, cleanup);
  }
  return { plan, contextReferenceRewrites };
}

function deterministicUuidV4(material) {
  const bytes = crypto.createHash('sha256').update(String(material)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function destructivePlanTimestamp(operation, options = {}) {
  if (options.now !== undefined) {
    const parsed = new Date(options.now);
    invariant(!Number.isNaN(parsed.valueOf()), 'Destructive plan timestamp is invalid.', 'DESTRUCTIVE_PLAN_INVALID');
    return parsed.toISOString();
  }
  const parts = typeof options.confirm === 'string' ? options.confirm.split(':') : [];
  if (parts.length === 3 && parts[0] === operation && /^\d{13}$/.test(parts[1]) && /^[a-f0-9]{64}$/.test(parts[2])) {
    const parsed = new Date(Number(parts[1]));
    invariant(!Number.isNaN(parsed.valueOf()), 'Destructive plan timestamp is invalid.', 'DESTRUCTIVE_PLAN_INVALID');
    return parsed.toISOString();
  }
  return new Date().toISOString();
}

async function monotonicContextTimestamp(root, desired) {
  let epoch = Date.parse(desired);
  invariant(!Number.isNaN(epoch), 'Destructive context timestamp is invalid.', 'DESTRUCTIVE_PLAN_INVALID');
  for (const entity of await loadAllEntities(root)) {
    const latest = entity.revisionHistory.at(-1)?.at;
    if (latest) epoch = Math.max(epoch, Date.parse(latest));
  }
  return new Date(epoch).toISOString();
}

async function destructivePlanToken(root, workspaceId, operation, plan, options = {}) {
  invariant(typeof workspaceId === 'string' && workspaceId.length > 0, 'Destructive plan workspace identity is invalid.', 'DESTRUCTIVE_PLAN_INVALID');
  const paths = [...new Set([
    '.scalvin/state.json',
    ...(plan.affectedPaths || []),
    ...(plan.writes instanceof Map ? [...plan.writes.keys()] : []),
    ...(Array.isArray(plan.deletes) ? plan.deletes : [])
  ])].map(validateRelativePath).sort();
  const snapshots = [];
  for (const relative of paths) {
    const filename = path.resolve(root, relative);
    assertInside(root, filename, 'Destructive confirmation snapshot');
    await rejectSymlinkPath(filename, { allowMissing: true });
    if (!(await pathExists(filename))) {
      snapshots.push({ path: relative, state: 'missing' });
      continue;
    }
    const bytes = await readBoundedRegularFile(filename, 16 * 1024 * 1024, {
      typeCode: 'DESTRUCTIVE_SNAPSHOT_INVALID', sizeCode: 'DESTRUCTIVE_SNAPSHOT_TOO_LARGE', changedCode: 'DESTRUCTIVE_SNAPSHOT_CHANGED'
    });
    snapshots.push({ path: relative, state: 'file', sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const writeArtifacts = plan.writes instanceof Map
    ? [...plan.writes.entries()].map(([relative, content]) => ({
      path: validateRelativePath(relative),
      sha256: crypto.createHash('sha256').update(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')).digest('hex')
    })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    : Array.isArray(plan.plannedWriteHashes)
      ? plan.plannedWriteHashes.map((entry) => {
        invariant(entry && typeof entry === 'object' && /^[a-f0-9]{64}$/.test(entry.sha256 || ''), 'A planned write hash is invalid.', 'DESTRUCTIVE_PLAN_INVALID');
        return { path: validateRelativePath(entry.path), sha256: entry.sha256 };
      }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      : [];
  const material = `${JSON.stringify({
    schemaVersion: 1,
    workspaceId,
    operation,
    selector: plan.selector || null,
    ids: [...(plan.ids || [])].sort(),
    revisions: [...(plan.revisions || [])].sort((left, right) => left - right),
    derivedIds: [...(plan.derivedMemoryIds || [])].sort(),
    knownBackupRecords: plan.knownBackupRecords ?? null,
    writeArtifacts,
    deletePaths: Array.isArray(plan.deletes) ? [...plan.deletes].sort() : [],
    affectedPaths: [...(plan.affectedPaths || [])].sort(),
    options,
    snapshots
  })}\n`;
  const digest = crypto.createHash('sha256').update(material).digest('hex');
  return options.planTimestamp
    ? `${operation}:${String(Date.parse(options.planTimestamp)).padStart(13, '0')}:${digest}`
    : `${operation}:${digest}`;
}

function assertFreshConfirmation(provided, expected) {
  const left = Buffer.from(String(provided || ''), 'utf8');
  const right = Buffer.from(expected, 'utf8');
  const equal = left.length === right.length && crypto.timingSafeEqual(left, right);
  invariant(equal, 'The destructive preview is stale or does not match the current exact plan. Preview again before deleting.', 'STALE_CONFIRMATION');
}

async function verifyContentPlan(stage, plan, label = 'Content') {
  invariant(plan?.writes instanceof Map && Array.isArray(plan.deletes), `${label} plan is invalid.`, 'CONTENT_PLAN_INVALID');
  for (const [relative, content] of plan.writes) {
    const normalized = validateRelativePath(relative);
    const filename = path.resolve(stage, normalized);
    assertInside(stage, filename, `${label} write`);
    await rejectSymlinkPath(filename);
    const expected = Buffer.from(String(content));
    const actual = await readBoundedRegularFile(filename, Math.max(expected.length, 1), {
      typeCode: 'CONTENT_WRITE_INVALID', sizeCode: 'CONTENT_WRITE_TOO_LARGE', changedCode: 'CONTENT_WRITE_CHANGED'
    });
    invariant(actual.equals(expected), `${label} write verification failed.`, 'CONTENT_WRITE_VERIFY_FAILED', { path: normalized });
  }
  for (const relative of plan.deletes) {
    const normalized = validateRelativePath(relative);
    const filename = path.resolve(stage, normalized);
    assertInside(stage, filename, `${label} deletion`);
    invariant(!(await pathExists(filename)), `${label} deletion verification failed.`, 'CONTENT_DELETE_VERIFY_FAILED', { path: normalized });
  }
}

function contextPlanOutput(plan) {
  const common = { operation: plan.operation };
  if (plan.operation === 'status') return {
    ...common,
    counts: plan.counts,
    total: plan.total,
    visible: plan.visible,
    dormantCountOnly: plan.dormantCountOnly,
    indexPresent: plan.indexPresent
  };
  if (plan.operation === 'show') return { ...common, entity: plan.entity };
  if (plan.operation === 'add') return { ...common, entityId: plan.entityId, type: plan.type, contextStatus: plan.status, revision: plan.revision };
  if (plan.operation === 'correct') return { ...common, entityId: plan.entityId, revision: plan.revision };
  if (plan.operation === 'status-change') return { ...common, entityId: plan.entityId, previousStatus: plan.previousStatus, contextStatus: plan.status, revision: plan.revision };
  if (plan.operation === 'forget') return {
    ...common,
    entityId: plan.entityId,
    alreadyAbsent: plan.alreadyAbsent,
    targetRecordValid: plan.targetRecordValid ?? null,
    referenceRewrites: plan.referenceRewrites,
    knownBackupRecords: plan.knownBackupRecords,
    backupLedgerAvailable: plan.backupLedgerAvailable,
    receiptPlanned: plan.receiptPlanned,
    receiptReason: plan.receiptReason
  };
  if (plan.operation === 'merge' && plan.preview) return {
    ...common,
    preview: true,
    canonicalId: plan.canonicalId,
    mergedId: plan.mergedId,
    canonicalEntity: plan.canonicalEntity,
    mergedEntity: plan.mergedEntity,
    proposedEntity: plan.proposedEntity,
    conflicts: plan.conflicts,
    knownBackupRecords: plan.knownBackupRecords,
    backupLedgerAvailable: plan.backupLedgerAvailable,
    confirmationRequired: plan.confirmation
  };
  if (plan.operation === 'merge') return {
    ...common,
    preview: false,
    canonicalId: plan.canonicalId,
    mergedId: plan.mergedId,
    revision: plan.revision,
    referenceRewrites: plan.referenceRewrites,
    knownBackupRecords: plan.knownBackupRecords,
    backupLedgerAvailable: plan.backupLedgerAvailable,
    receiptPlanned: plan.receiptPlanned,
    receiptReason: plan.receiptReason
  };
  if (plan.operation === 'backfill' && plan.preview) return {
    ...common,
    preview: true,
    candidates: plan.candidates,
    approvedIds: plan.approvedIds,
    possibleDuplicates: plan.possibleDuplicates,
    confirmationRequired: plan.confirmation
  };
  if (plan.operation === 'backfill') return {
    ...common,
    preview: false,
    addedIds: plan.addedIds,
    alreadyPresentIds: plan.alreadyPresentIds,
    addedCount: plan.addedCount,
    alreadyPresentCount: plan.alreadyPresentCount
  };
  throw new ScalvinError('Unknown context plan output.', 'CONTEXT_PLAN_INVALID');
}

async function contextTransaction(context, label, options, planner) {
  const { expectedTargetSnapshot } = context;
  invariant(expectedTargetSnapshot, 'Context transaction requires the pre-read workspace snapshot.', 'ACTIVATION_SNAPSHOT_REQUIRED');
  const stage = await makeSiblingTemp(context.target, `${label}-stage`);
  try {
    await copyTree(context.target, stage, { expectedSourceSnapshot: expectedTargetSnapshot });
    const plan = await planner(stage);
    const output = contextPlanOutput(plan);
    if (plan.preview || options['dry-run'] || (plan.writes.size === 0 && plan.deletes.length === 0)) {
      await fsp.rm(stage, { recursive: true, force: true });
      return { plan, persisted: false, dryRun: Boolean(options['dry-run']), output };
    }
    await applyPlan(stage, plan);
    await verifyContentPlan(stage, plan, 'Context graph');
    const state = structuredClone(context.state);
    const now = options.now || new Date().toISOString();
    const selector = plan.entityId || plan.canonicalId || (plan.addedIds || []).join(',') || plan.operation;
    state.consent.lastOperationalEvent = controlEvent('context_graph', selector, plan.operation, now);
    state.updatedAt = now;
    await projectConsentState(stage, state);
    await writeState(stage, state, context.loaded.manifest);
    await hardenTree(stage);
    await validatePrivacyWorkspaceStage(stage, { expectedState: state });
    await preflightExplicitLocalPointerDestination();
    testFailpoint(`${label}-before-activate`);
    const activation = await activateDirectory(context.target, stage, { expectedTargetSnapshot });
    await finalizeLocalPointerAfterActivation(context.target, state.workspaceId, activation, label);
    return { plan, persisted: true, dryRun: false, output, activation };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function contextGraph(options = {}) {
  const action = options.action;
  invariant(['status', 'show', 'add', 'correct', 'status-change', 'forget', 'merge', 'backfill'].includes(action), 'context action is invalid.', 'INVALID_ARGUMENT');
  const commonKeys = new Set(['action', 'target', 'workspace', 'json', 'help', 'version']);
  const actionKeys = {
    status: ['now'],
    show: ['id'],
    add: ['candidate', 'candidate-file', 'status', 'session-id', 'now', 'dry-run'],
    correct: ['id', 'patch', 'patch-file', 'session-id', 'now', 'dry-run'],
    'status-change': ['id', 'status', 'session-id', 'now', 'dry-run'],
    forget: ['id', 'session-id', 'now', 'confirm', 'dry-run'],
    merge: ['canonical-id', 'merged-id', 'session-id', 'now', 'confirm', 'dry-run'],
    backfill: ['candidates', 'candidates-file', 'approvedIds', 'approved-id', 'now', 'confirm', 'dry-run']
  };
  const allowed = new Set([...commonKeys, ...actionKeys[action]]);
  const ignored = Object.keys(options).filter((key) => options[key] !== undefined && !allowed.has(key));
  invariant(ignored.length === 0, `Context ${action} received options that do not apply to this action.`, 'INVALID_ARGUMENT', { options: ignored.sort() });
  const context = await currentWorkspaceContext(options, 'context');
  if (action !== 'forget') assertSupportedRetentionClasses(context.state, ['context_graph']);
  if (action !== 'forget') graphAccess(context.state);
  if (action === 'status') {
    const plan = await planContextStatus(context.target, context.state, { now: options.now });
    return { status: 'inspected', workspacePath: context.target, workspaceId: context.state.workspaceId, ...contextPlanOutput(plan), nextAction: 'none' };
  }
  if (action === 'show') {
    invariant(options.id !== undefined, 'Context show requires --id.', 'INVALID_ARGUMENT');
    const plan = await planContextShow(context.target, context.state, { id: options.id });
    return { status: 'inspected', workspacePath: context.target, workspaceId: context.state.workspaceId, ...contextPlanOutput(plan), nextAction: 'none' };
  }

  let planner;
  if (action === 'add') {
    const candidate = await readContextJsonInput(options, 'candidate', 'candidate-file', 'Context add', parseCandidateJson);
    invariant(options.status === undefined || CONTEXT_STATUSES.includes(options.status), 'Context status is invalid.', 'CONTEXT_STATUS_INVALID');
    planner = (stage) => planContextAdd(stage, context.state, { candidate, status: options.status, now: options.now, sessionId: options['session-id'] });
  } else if (action === 'correct') {
    const patch = await readContextJsonInput(options, 'patch', 'patch-file', 'Context correction', parseCorrectionPatchJson);
    planner = (stage) => planContextCorrect(stage, context.state, { id: options.id, patch, now: options.now, sessionId: options['session-id'] });
  } else if (action === 'status-change') {
    planner = (stage) => planContextStatusChange(stage, context.state, { id: options.id, status: options.status, now: options.now, sessionId: options['session-id'] });
  } else if (action === 'forget') {
    invariant(options.id !== undefined, 'Context forget requires --id.', 'INVALID_CONTEXT_ID');
    const planNow = await monotonicContextTimestamp(context.target, destructivePlanTimestamp('context-forget', options));
    const receiptUuid = deterministicUuidV4(`${context.state.workspaceId}\0context-forget\0${options.id}\0${planNow}`);
    const currentPlan = await planContextForget(context.target, context.state, {
      id: options.id, now: planNow, sessionId: options['session-id'], idFactory: () => receiptUuid
    });
    const expected = await destructivePlanToken(context.target, context.state.workspaceId, 'context-forget', currentPlan, {
      entityId: options.id,
      referenceRewrites: currentPlan.referenceRewrites,
      targetRecordValid: currentPlan.targetRecordValid ?? null,
      planTimestamp: planNow
    });
    if (!options.confirm || options['dry-run']) {
      return {
        status: 'preview', workspacePath: context.target, workspaceId: context.state.workspaceId,
        ...contextPlanOutput(currentPlan), confirmationRequired: expected,
        nextAction: `rerun-with---confirm-${expected}`
      };
    }
    assertFreshConfirmation(options.confirm, expected);
    planner = async (stage) => {
      const stagedPlanNow = await monotonicContextTimestamp(stage, planNow);
      const stagedPlan = await planContextForget(stage, context.state, {
        id: options.id, now: stagedPlanNow, sessionId: options['session-id'], idFactory: () => receiptUuid
      });
      const stagedExpected = await destructivePlanToken(stage, context.state.workspaceId, 'context-forget', stagedPlan, {
        entityId: options.id,
        referenceRewrites: stagedPlan.referenceRewrites,
        targetRecordValid: stagedPlan.targetRecordValid ?? null,
        planTimestamp: stagedPlanNow
      });
      assertFreshConfirmation(options.confirm, stagedExpected);
      return stagedPlan;
    };
  } else if (action === 'merge') {
    const planNow = await monotonicContextTimestamp(context.target, destructivePlanTimestamp('context-merge', options));
    const receiptUuid = deterministicUuidV4(`${context.state.workspaceId}\0context-merge\0${options['canonical-id']}\0${options['merged-id']}\0${planNow}`);
    const inputs = {
      canonicalId: options['canonical-id'], mergedId: options['merged-id'],
      now: planNow, sessionId: options['session-id']
    };
    const mergePreview = await planContextMerge(context.target, context.state, inputs);
    const currentPlan = await planContextMerge(context.target, context.state, {
      ...inputs, confirm: mergePreview.confirmation, idFactory: () => receiptUuid
    });
    const expected = await destructivePlanToken(context.target, context.state.workspaceId, 'context-merge', currentPlan, {
      canonicalId: currentPlan.canonicalId,
      mergedId: currentPlan.mergedId,
      referenceRewrites: currentPlan.referenceRewrites,
      knownBackupRecords: currentPlan.knownBackupRecords,
      planTimestamp: planNow
    });
    if (!options.confirm || options['dry-run']) {
      planner = async () => ({ ...mergePreview, confirmation: expected });
    } else {
      assertFreshConfirmation(options.confirm, expected);
      planner = async (stage) => {
        const stagedPreview = await planContextMerge(stage, context.state, inputs);
        const stagedPlan = await planContextMerge(stage, context.state, {
          ...inputs, confirm: stagedPreview.confirmation, idFactory: () => receiptUuid
        });
        const stagedExpected = await destructivePlanToken(stage, context.state.workspaceId, 'context-merge', stagedPlan, {
          canonicalId: stagedPlan.canonicalId,
          mergedId: stagedPlan.mergedId,
          referenceRewrites: stagedPlan.referenceRewrites,
          knownBackupRecords: stagedPlan.knownBackupRecords,
          planTimestamp: planNow
        });
        assertFreshConfirmation(options.confirm, stagedExpected);
        return stagedPlan;
      };
    }
  } else {
    const candidates = await readContextJsonInput(options, 'candidates', 'candidates-file', 'Context backfill', parseCandidateBatchJson, 512 * 1024);
    const approvedIds = options.approvedIds || options['approved-id'] || [];
    planner = (stage) => planContextBackfill(stage, context.state, {
      candidates, approvedIds, confirm: options.confirm, now: options.now
    });
  }
  const transaction = await contextTransaction(context, `context-${action}`, options, planner);
  const preview = transaction.plan.preview === true;
  return {
    status: preview ? 'preview' : transaction.dryRun ? 'dry-run' : transaction.persisted ? (action === 'forget' ? 'deleted' : 'updated') : 'unchanged',
    workspacePath: context.target,
    workspaceId: context.state.workspaceId,
    ...transaction.output,
    persisted: transaction.persisted,
    nextAction: preview ? 'review-exact-content-and-rerun-with-confirm' : transaction.dryRun ? `run-context-${action}` : 'none',
    ...activationDisclosure(transaction.activation, ['forget', 'merge'].includes(action))
  };
}

function assertSupportedRetentionClasses(state, dataClasses) {
  const policies = state.consent?.retention || {};
  for (const dataClass of dataClasses) {
    const policy = policies[dataClass];
    invariant(['until_deleted', 'do_not_store'].includes(policy), 'This workspace uses a retention policy that the current deterministic engine cannot safely enforce.', 'UNSUPPORTED_RETENTION_POLICY', {
      dataClass,
      policy,
      supported: ['until_deleted', 'do_not_store']
    });
  }
}

async function memory(options = {}) {
  const action = options.action;
  const reviewActions = ['review-due', 'review-confirm', 'review-decline', 'review-suppress', 'review-unsuppress'];
  invariant(['pause', 'seal', 'resume', 'status', 'view', 'show', 'export', 'correct', 'forget', 'delete-all', ...reviewActions].includes(action), 'memory --action is invalid.', 'INVALID_ARGUMENT');
  if (reviewActions.includes(action)) {
    const context = await currentWorkspaceContext(options, 'memory review');
    assertSupportedRetentionClasses(context.state, ['profile_memory', 'themes_and_focus', 'client_scene_memories']);
    if (action === 'review-due') {
      invariant(options.id === undefined && options.confirm === undefined, 'Review-due does not accept --id or --confirm.', 'INVALID_ARGUMENT');
      const result = await evaluateStaleMemory(context.target, context.state, { now: options.now, limit: options.limit });
      return {
        ...result, workspacePath: context.target, workspaceId: context.state.workspaceId,
        offeredCount: result.due.length, bulkRefresh: false
      };
    }
    invariant(options.id !== undefined, `${action} requires one exact --id.`, 'INVALID_MEMORY_ID');
    invariant(options.confirm === undefined, `${action} does not accept --confirm.`, 'INVALID_ARGUMENT');
    const decision = action.slice('review-'.length);
    const plan = await planReviewDecision(context.target, context.state, {
      action: decision, id: options.id, sessionId: options['session-id'], now: options.now
    });
    if (!plan.changed) {
      return {
        status: 'unchanged', workspacePath: context.target, workspaceId: context.state.workspaceId,
        memoryId: plan.id, reviewAction: plan.action, selectedCount: 1, bulkRefresh: false, nextAction: 'none'
      };
    }
    if (options['dry-run']) {
      return {
        status: 'dry-run', workspacePath: context.target, workspaceId: context.state.workspaceId,
        memoryId: plan.id, reviewAction: plan.action, selectedCount: 1, bulkRefresh: false,
        affectedFiles: plan.writes.size, nextAction: `run-memory-${action}`
      };
    }
    context.state.consent.reviewPreferences = structuredClone(plan.reviewPreferences);
    context.state.updatedAt = new Date().toISOString();
    const transaction = await applyContentTransaction(context, `memory-${action}`, plan, null);
    return {
      status: 'updated', workspacePath: context.target, workspaceId: context.state.workspaceId,
      memoryId: plan.id, reviewAction: plan.action, selectedCount: 1, bulkRefresh: false,
      affectedFiles: plan.writes.size, nextAction: 'none',
      ...activationDisclosure(transaction.activation)
    };
  }
  if (['view', 'show', 'export', 'correct', 'forget', 'delete-all'].includes(action)) {
    const context = await currentWorkspaceContext(options, 'memory');
    if (action === 'view' || action === 'show') {
      invariant(context.state.consent.memoryPause.state !== 'sealed_pause', 'Memory cannot be read while sealed pause is active.', 'MEMORY_SEALED');
      const categoryRetention = {
        profile: 'profile_memory', themes: 'themes_and_focus', focus: 'themes_and_focus',
        primer: 'primers_and_checkpoints', 'client-scenes': 'client_scene_memories'
      };
      assertSupportedRetentionClasses(context.state, [...new Set(Object.values(categoryRetention))]);
      if (options.id !== undefined) invariant(/^(?:mem|theme|focus)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.id), 'Memory ID is invalid.', 'INVALID_MEMORY_ID');
      const readableCategories = Object.keys(categoryRetention);
      let items = await listMemoryItems(context.target, { id: options.id, categories: readableCategories });
      if (options.scope) {
        const allowed = ['profile', 'themes', 'focus', 'primer', 'client-scenes', 'all-active'];
        invariant(allowed.includes(options.scope), 'Unknown memory view scope.', 'INVALID_MEMORY_SCOPE', { available: allowed });
        if (options.scope !== 'all-active') items = items.filter((item) => item.category === options.scope);
      }
      return { status: 'inspected', workspacePath: context.target, workspaceId: context.state.workspaceId, scope: options.scope || (options.id ? 'item' : 'all-active'), items, count: items.length, nextAction: 'none' };
    }
    if (action === 'export') {
      invariant(context.state.consent.memoryPause.state === 'none', 'Memory export creates a sensitive copy and is unavailable during either pause mode.', 'MEMORY_PAUSE_ACTIVE');
      assertSupportedRetentionClasses(context.state, Object.keys(context.state.consent.retention));
      const output = assertSafeBackupOutput(options.output);
      return createMemoryExport(context.target, { scope: options.scope, output, dryRun: options['dry-run'] });
    }
    if (action === 'correct') {
      invariant(context.state.consent.continuityMemory === 'on' && context.state.consent.memoryPause.state === 'none', 'Memory correction requires continuity memory on and unpaused.', 'MEMORY_PERSISTENCE_DISABLED');
      const retentionClass = String(options.id || '').startsWith('theme-') || String(options.id || '').startsWith('focus-') ? 'themes_and_focus' : 'profile_memory';
      assertSupportedRetentionClasses(context.state, [retentionClass]);
      invariant(context.state.consent.retention?.[retentionClass] === 'until_deleted', 'Memory correction is disabled by retention policy.', 'RETENTION_DO_NOT_STORE');
      const plan = await planCorrection(context.target, options.id, options.statement);
      if (options['dry-run']) return { status: 'dry-run', workspacePath: context.target, workspaceId: context.state.workspaceId, memoryId: plan.id, affectedFiles: plan.affectedPaths.length, nextAction: 'run-memory-correction' };
      const now = new Date().toISOString();
      context.state.consent.lastOperationalEvent = controlEvent('memory_correction', plan.id, plan.id, now);
      context.state.updatedAt = now;
      const transaction = await applyContentTransaction(context, 'memory-correct', plan, null);
      return {
        status: 'updated', workspacePath: context.target, workspaceId: context.state.workspaceId,
        memoryId: plan.id, affectedFiles: plan.affectedPaths.length, nextAction: 'use-corrected-memory',
        ...activationDisclosure(transaction.activation)
      };
    }

    const planningContext = { ...context, state: structuredClone(context.state) };
    const planNow = action === 'forget'
      ? await monotonicContextTimestamp(context.target, destructivePlanTimestamp(`memory-${action}`, options))
      : null;
    const planned = await planMemoryDestruction(context.target, planningContext, action, options, planNow);
    const { plan, contextReferenceRewrites } = planned;
    const expectedConfirmation = await destructivePlanToken(context.target, context.state.workspaceId, `memory-${action}`, plan, {
      scope: plan.selector,
      contextReferenceRewrites,
      deletedCategories: plan.deletedCategories || [],
      retainedOperationalCategories: plan.retainedOperationalCategories || [],
      retainedSeparateCopies: plan.retainedSeparateCopies || [],
      ...(planNow ? { planTimestamp: planNow } : {})
    });
    const preview = {
      status: 'preview', workspacePath: context.target, workspaceId: context.state.workspaceId,
      operation: action, scope: plan.selector,
      ...(action === 'forget' ? { objectCount: plan.ids.length } : {
        managedArtifactCount: plan.affectedPaths.length,
        deletedArtifactCount: plan.deletes.length,
        resetArtifactCount: plan.writes.size,
        deletedCategories: plan.deletedCategories,
        retainedOperationalCategories: plan.retainedOperationalCategories,
        retainedSeparateCopies: plan.retainedSeparateCopies
      }),
      affectedFiles: plan.affectedPaths.length, knownBackupRecords: plan.knownBackupRecords,
      contextReferenceRewrites,
      backupsRemainSeparateCopies: plan.knownBackupRecords > 0,
      confirmationRequired: expectedConfirmation,
      nextAction: `rerun-with---confirm-${expectedConfirmation}`
    };
    if (!options.confirm || options['dry-run']) return preview;
    assertFreshConfirmation(options.confirm, expectedConfirmation);
    if (action === 'delete-all') context.state.files = structuredClone(plan.stateFiles);
    const now = new Date().toISOString();
    if (action === 'delete-all') {
      const consent = context.state.consent;
      consent.status = 'declined';
      consent.recordedAt = now;
      consent.continuityMemory = 'off';
      consent.contextGraph = 'off';
      consent.transcripts = 'off';
      consent.importedSources = 'off';
      consent.externalCare = 'off';
      consent.behaviorLearning = 'off';
      consent.preferredUserName = null;
      consent.currentSessionId = null;
      consent.memoryPause = { state: 'none', startedAt: null };
      consent.transcriptState = { state: 'off', sessionId: null, captureGrade: null, startedAt: null, pausedIntervals: [], stoppedAt: null, knownGaps: [] };
      consent.timezone = { value: 'unconfirmed', status: 'unconfirmed', confirmedAt: null };
      consent.accessibility = { responseLoad: 'standard', oneQuestionAtATime: 'unset', plainLanguageSummaries: 'unset', reducedMetaphor: 'unset', extraProcessingTime: 'unset', bodyPrompts: 'ask_first', sensoryGrounding: 'ask_first', betweenSessionExperiments: 'ask_first' };
      consent.reviewPreferences = { staleMemoryOffers: 'on', suppressedMemoryIds: [] };
      for (const dataClass of Object.keys(consent.retention)) if (dataClass !== 'usage_ledgers') consent.retention[dataClass] = 'do_not_store';
      context.state.preferences = normalizePreferences(context.loaded.manifest, {});
      context.state.sessionLifecycle = createEmptySessionLifecycle();
      context.state.sourceLifecycle = createEmptySourceLifecycle();
    }
    context.state.consent.lastOperationalEvent = controlEvent('memory_deletion', plan.selector, 'deleted', now);
    context.state.updatedAt = now;
    const receipt = {
      eventId: `delete-${require('node:crypto').randomUUID()}`, at: now, dataClass: 'continuity_memory', objectIds: plan.ids,
      scope: plan.selector, derivedCount: plan.writes.size, knownBackupRecords: plan.knownBackupRecords
    };
    const transaction = await applyContentTransaction(
      context,
      action === 'forget' ? 'memory-forget' : 'memory-delete-all',
      plan,
      receipt,
      {
        replan: async (stage) => {
          const stagedPlanNow = planNow ? await monotonicContextTimestamp(stage, planNow) : null;
          const staged = await planMemoryDestruction(stage, planningContext, action, options, stagedPlanNow);
          const stagedConfirmation = await destructivePlanToken(stage, planningContext.state.workspaceId, `memory-${action}`, staged.plan, {
            scope: staged.plan.selector,
            contextReferenceRewrites: staged.contextReferenceRewrites,
            deletedCategories: staged.plan.deletedCategories || [],
            retainedOperationalCategories: staged.plan.retainedOperationalCategories || [],
            retainedSeparateCopies: staged.plan.retainedSeparateCopies || [],
            ...(stagedPlanNow ? { planTimestamp: stagedPlanNow } : {})
          });
          assertFreshConfirmation(options.confirm, stagedConfirmation);
          return staged.plan;
        }
      }
    );
    return {
      status: 'deleted', workspacePath: context.target, workspaceId: context.state.workspaceId,
      operation: action, scope: plan.selector,
      ...(action === 'forget' ? { objectCount: plan.ids.length } : {
        managedArtifactCount: plan.affectedPaths.length,
        deletedArtifactCount: plan.deletes.length,
        resetArtifactCount: plan.writes.size,
        deletedCategories: plan.deletedCategories,
        retainedOperationalCategories: plan.retainedOperationalCategories,
        retainedSeparateCopies: plan.retainedSeparateCopies
      }),
      affectedFiles: plan.affectedPaths.length,
      contextReferenceRewrites,
      knownBackupRecords: plan.knownBackupRecords, backupsRemainSeparateCopies: plan.knownBackupRecords > 0,
      receiptWritten: transaction.receiptWritten,
      nextAction: plan.knownBackupRecords > 0 ? 'review-backup-rotation-separately' : 'none',
      ...activationDisclosure(transaction.activation, true, action === 'delete-all' ? plan.retainedSeparateCopies || [] : []),
      backupsRemainSeparateCopies: plan.knownBackupRecords > 0 || Boolean(transaction.activation?.retainedRollbackPath)
    };
  }
  return controlTransaction(options, 'memory', (state) => {
    const current = state.consent.memoryPause.state;
    if (action === 'status') return { changed: false, output: { memoryPause: current, startedAt: state.consent.memoryPause.startedAt, nextAction: 'none' } };
    const desired = action === 'pause' ? 'write_pause' : action === 'seal' ? 'sealed_pause' : 'none';
    if (current === desired) return { changed: false, output: { memoryPause: current, startedAt: state.consent.memoryPause.startedAt, nextAction: 'none' } };
    const now = new Date().toISOString();
    let transcriptTransition = null;
    if (desired !== 'none' && state.consent.transcriptState.state === 'recording') {
      state.consent.transcriptState.state = 'paused';
      state.consent.transcriptState.pausedIntervals.push({ startedAt: now, endedAt: null });
      transcriptTransition = { from: 'recording', to: 'paused', reason: 'memory_pause_no_backfill' };
    }
    state.consent.memoryPause = { state: desired, startedAt: desired === 'none' ? null : now };
    state.consent.lastOperationalEvent = controlEvent('memory_pause', transcriptTransition ? `${current};transcript=recording` : current, transcriptTransition ? `${desired};transcript=paused` : desired, now);
    state.updatedAt = now;
    return {
      changed: true,
      output: {
        memoryPause: desired,
        previousMemoryPause: current,
        startedAt: state.consent.memoryPause.startedAt,
        noBackfill: action === 'resume',
        transcriptState: state.consent.transcriptState.state,
        transcriptTransition,
        eventId: state.consent.lastOperationalEvent.eventId,
        nextAction: desired === 'none' ? 'continue-without-backfill' : 'honor-memory-pause'
      }
    };
  });
}

async function transcript(options = {}) {
  const action = options.action;
  invariant(['start', 'pause', 'resume', 'stop', 'status', 'delete'].includes(action), 'transcript --action must be start, pause, resume, stop, status, or delete.', 'INVALID_ARGUMENT');
  if (action === 'delete') {
    const context = await currentWorkspaceContext(options, 'transcript');
    const plan = await planTranscriptDelete(context.target, { sessionId: options['session-id'], scope: options.scope });
    const expectedConfirmation = await destructivePlanToken(context.target, context.state.workspaceId, 'transcript-delete', plan, {
      scope: plan.selector
    });
    const preview = {
      status: 'preview', workspacePath: context.target, workspaceId: context.state.workspaceId,
      operation: 'transcript-delete', scope: plan.selector, transcriptCount: plan.deletes.length,
      affectedFiles: plan.affectedPaths.length, knownBackupRecords: plan.knownBackupRecords,
      backupsRemainSeparateCopies: plan.knownBackupRecords > 0,
      confirmationRequired: expectedConfirmation,
      nextAction: `rerun-with---confirm-${expectedConfirmation}`
    };
    if (!options.confirm || options['dry-run']) return preview;
    assertFreshConfirmation(options.confirm, expectedConfirmation);
    const now = new Date().toISOString();
    const activeSession = context.state.consent.transcriptState.sessionId;
    if (options.scope === 'all' || activeSession === options['session-id']) {
      context.state.consent.transcriptState = { state: 'off', sessionId: null, captureGrade: null, startedAt: null, pausedIntervals: [], stoppedAt: null, knownGaps: [] };
    }
    context.state.consent.lastOperationalEvent = controlEvent('transcript_deletion', plan.selector, 'deleted', now);
    context.state.updatedAt = now;
    const receipt = {
      eventId: `delete-${require('node:crypto').randomUUID()}`, at: now, dataClass: 'raw_transcripts', objectIds: plan.ids,
      scope: plan.selector, derivedCount: plan.writes.size, knownBackupRecords: plan.knownBackupRecords
    };
    const transaction = await applyContentTransaction(context, 'transcript-delete', plan, receipt, {
      replan: async (stage) => {
        const stagedPlan = await planTranscriptDelete(stage, { sessionId: options['session-id'], scope: options.scope });
        const stagedConfirmation = await destructivePlanToken(stage, context.state.workspaceId, 'transcript-delete', stagedPlan, {
          scope: stagedPlan.selector
        });
        assertFreshConfirmation(options.confirm, stagedConfirmation);
        return stagedPlan;
      }
    });
    return {
      status: 'deleted', workspacePath: context.target, workspaceId: context.state.workspaceId,
      scope: plan.selector, transcriptCount: plan.deletes.length, affectedFiles: plan.affectedPaths.length,
      knownBackupRecords: plan.knownBackupRecords, backupsRemainSeparateCopies: plan.knownBackupRecords > 0,
      receiptWritten: transaction.receiptWritten,
      nextAction: plan.knownBackupRecords > 0 ? 'review-backup-rotation-separately' : 'none',
      ...activationDisclosure(transaction.activation, true),
      backupsRemainSeparateCopies: plan.knownBackupRecords > 0 || Boolean(transaction.activation?.retainedRollbackPath)
    };
  }
  return controlTransaction(options, 'transcript', (state) => {
    const transcriptState = state.consent.transcriptState;
    const current = transcriptState.state;
    if (action === 'status') return { changed: false, output: { transcriptState: current, sessionId: transcriptState.sessionId, captureGrade: transcriptState.captureGrade, knownGaps: transcriptState.knownGaps, nextAction: 'none' } };
    const now = new Date().toISOString();
    let desired;
    if (action === 'start') {
      invariant(state.consent.transcripts === 'on', 'Raw transcript consent must be on before capture starts.', 'TRANSCRIPT_CONSENT_REQUIRED');
      invariant(state.consent.memoryPause.state === 'none', 'Transcript capture cannot start while memory persistence is paused.', 'MEMORY_PAUSE_ACTIVE');
      invariant(current === 'off' || current === 'stopped', 'Transcript is already active.', 'TRANSCRIPT_STATE_INVALID', { current });
      invariant(/^s-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options['session-id'] || ''), 'transcript start requires --session-id s-<UUID-v4>.', 'INVALID_SESSION_ID');
      invariant(['client_captured', 'turn_captured', 'best_effort_context', 'partial'].includes(options['capture-grade']), 'transcript start requires a valid --capture-grade.', 'INVALID_CAPTURE_GRADE');
      invariant(['best_effort_context', 'partial'].includes(options['capture-grade']), 'This client has no verified adapter capability for authoritative per-turn capture; use best_effort_context or partial.', 'TRANSCRIPT_CAPABILITY_UNVERIFIED');
      Object.assign(transcriptState, {
        state: 'recording',
        sessionId: options['session-id'],
        captureGrade: options['capture-grade'],
        startedAt: now,
        pausedIntervals: [],
        stoppedAt: null,
        knownGaps: []
      });
      desired = 'recording';
    } else if (action === 'pause') {
      invariant(current === 'recording', 'Only a recording transcript can be paused.', 'TRANSCRIPT_STATE_INVALID', { current });
      transcriptState.state = 'paused';
      transcriptState.pausedIntervals.push({ startedAt: now, endedAt: null });
      desired = 'paused';
    } else if (action === 'resume') {
      invariant(state.consent.transcripts === 'on', 'Raw transcript consent must be on before capture resumes.', 'TRANSCRIPT_CONSENT_REQUIRED');
      invariant(state.consent.memoryPause.state === 'none', 'Transcript capture cannot resume while memory persistence is paused.', 'MEMORY_PAUSE_ACTIVE');
      invariant(current === 'paused', 'Only a paused transcript can resume.', 'TRANSCRIPT_STATE_INVALID', { current });
      const interval = transcriptState.pausedIntervals.at(-1);
      invariant(interval && interval.endedAt === null, 'Transcript pause interval is corrupt.', 'TRANSCRIPT_STATE_INVALID');
      interval.endedAt = now;
      transcriptState.knownGaps.push({ from: interval.startedAt, to: now, reason: 'paused_no_backfill' });
      transcriptState.state = 'recording';
      desired = 'recording';
    } else {
      invariant(current === 'recording' || current === 'paused', 'Only an active transcript can stop.', 'TRANSCRIPT_STATE_INVALID', { current });
      if (current === 'paused') {
        const interval = transcriptState.pausedIntervals.at(-1);
        if (interval?.endedAt === null) {
          interval.endedAt = now;
          transcriptState.knownGaps.push({ from: interval.startedAt, to: now, reason: 'paused_no_backfill' });
        }
      }
      transcriptState.state = 'stopped';
      transcriptState.stoppedAt = now;
      desired = 'stopped';
    }
    state.consent.lastOperationalEvent = controlEvent('transcript_state', current, desired, now);
    state.updatedAt = now;
    return {
      changed: true,
      output: {
        transcriptState: desired,
        previousTranscriptState: current,
        sessionId: transcriptState.sessionId,
        captureGrade: transcriptState.captureGrade,
        knownGaps: transcriptState.knownGaps,
        noBackfill: action === 'resume' || (action === 'stop' && current === 'paused'),
        eventId: state.consent.lastOperationalEvent.eventId,
        nextAction: desired === 'recording' ? 'capture-from-this-turn-only' : desired === 'paused' ? 'do-not-capture-or-backfill' : 'capture-stopped'
      }
    };
  });
}

async function preferences(options = {}) {
  return controlTransaction(options, 'preferences', (state) => {
    const mutations = [];
    const now = new Date().toISOString();
    const consentGranted = state.consent.status === 'granted' && state.consent.continuityMemory === 'on';
    if (options['show-preferred-user-name']) invariant(state.consent.memoryPause.state !== 'sealed_pause', 'Preferred-name memory cannot be read while sealed pause is active.', 'MEMORY_SEALED');
    invariant(!(options['preferred-user-name'] !== undefined && options['clear-preferred-user-name']), 'Use either --preferred-user-name or --clear-preferred-user-name, not both.', 'INVALID_ARGUMENT');
    if (options['preferred-user-name'] !== undefined) {
      invariant(state.consent.continuityMemory === 'on' && state.consent.memoryPause.state === 'none', 'A preferred user name can only be persisted while continuity memory is on and unpaused.', 'MEMORY_PERSISTENCE_DISABLED');
      const preferredName = String(options['preferred-user-name']);
      invariant(preferredName.trim() && preferredName.length <= 100 && !/[\0\r\n]/.test(preferredName), 'Preferred user name must be a non-empty single line of at most 100 characters.', 'INVALID_PREFERENCE');
      if (state.consent.preferredUserName !== preferredName) {
        mutations.push(['preferredUserName', state.consent.preferredUserName === null ? 'unset' : 'set', 'set']);
        state.consent.preferredUserName = preferredName;
      }
    } else if (options['clear-preferred-user-name'] && state.consent.preferredUserName !== null) {
      mutations.push(['preferredUserName', 'set', 'unset']);
      state.consent.preferredUserName = null;
    }
    if (options.language !== undefined) {
      const language = normalizeLanguagePreference(options.language);
      invariant(language === 'auto' || state.consent.status === 'granted', 'A specific language preference can only be persisted after consent is granted.', 'CONSENT_REQUIRED');
      if (state.preferences.language !== language) {
        mutations.push(['language', state.preferences.language, language]);
        state.preferences.language = language;
      }
    }
    if (options.timezone !== undefined) {
      const timezone = String(options.timezone);
      invariant(timezone === 'unconfirmed' || consentGranted, 'A timezone preference can only be persisted after consent is granted.', 'CONSENT_REQUIRED');
      if (timezone !== 'unconfirmed') {
        try { new Intl.DateTimeFormat(undefined, { timeZone: timezone }).format(new Date()); }
        catch { throw new ScalvinError('Unknown IANA timezone.', 'INVALID_TIMEZONE', { timezone }); }
      }
      const desired = timezone === 'unconfirmed'
        ? { value: 'unconfirmed', status: 'unconfirmed', confirmedAt: null }
        : { value: timezone, status: 'confirmed', confirmedAt: now };
      if (state.consent.timezone.value !== desired.value || state.consent.timezone.status !== desired.status) {
        mutations.push(['timezone', state.consent.timezone.value, desired.value]);
        state.consent.timezone = desired;
      }
    }
    const fields = {
      'response-load': ['responseLoad', ['concise', 'standard', 'detailed'], 'standard'],
      'one-question-at-a-time': ['oneQuestionAtATime', ['unset', 'on', 'off'], 'unset'],
      'plain-language-summaries': ['plainLanguageSummaries', ['unset', 'on', 'off'], 'unset'],
      'reduced-metaphor': ['reducedMetaphor', ['unset', 'on', 'off'], 'unset'],
      'extra-processing-time': ['extraProcessingTime', ['unset', 'on', 'off'], 'unset'],
      'body-prompts': ['bodyPrompts', ['allowed', 'ask_first', 'off'], 'ask_first'],
      'sensory-grounding': ['sensoryGrounding', ['allowed', 'ask_first', 'off'], 'ask_first'],
      'between-session-experiments': ['betweenSessionExperiments', ['allowed', 'ask_first', 'off'], 'ask_first']
    };
    for (const [option, [field, allowed, neutral]] of Object.entries(fields)) {
      if (options[option] === undefined) continue;
      invariant(allowed.includes(options[option]), `--${option} is invalid.`, 'INVALID_PREFERENCE', { value: options[option], allowed });
      invariant(consentGranted || options[option] === neutral, `--${option} can only persist a non-neutral preference after consent is granted.`, 'CONSENT_REQUIRED');
      if (state.consent.accessibility[field] !== options[option]) {
        mutations.push([`accessibility.${field}`, state.consent.accessibility[field], options[option]]);
        state.consent.accessibility[field] = options[option];
      }
    }
    if (options['stale-memory-offers'] !== undefined) {
      invariant(['on', 'off'].includes(options['stale-memory-offers']), '--stale-memory-offers must be on or off.', 'INVALID_PREFERENCE');
      invariant(consentGranted || options['stale-memory-offers'] === 'on', 'Stale-memory review preferences require consent.', 'CONSENT_REQUIRED');
      if (state.consent.reviewPreferences.staleMemoryOffers !== options['stale-memory-offers']) {
        mutations.push(['review.staleMemoryOffers', state.consent.reviewPreferences.staleMemoryOffers, options['stale-memory-offers']]);
        state.consent.reviewPreferences.staleMemoryOffers = options['stale-memory-offers'];
      }
    }
    if (!mutations.length) {
      return {
        changed: false,
        output: {
          timezone: state.consent.timezone,
          language: state.preferences.language,
          accessibility: state.consent.accessibility,
          reviewPreferences: state.consent.reviewPreferences,
          ...((options['show-preferred-user-name'] || options['clear-preferred-user-name']) ? { preferredUserName: state.consent.preferredUserName } : {}),
          nextAction: 'none'
        }
      };
    }
    const category = mutations.every((item) => item[0] === 'preferredUserName')
      ? 'identity_preference'
      : mutations.length === 1 && mutations[0][0] === 'timezone'
        ? 'timezone'
        : mutations.length === 1 && mutations[0][0] === 'language'
          ? 'language_preference'
          : 'accessibility';
    state.consent.lastOperationalEvent = controlEvent(category, mutations.map((item) => `${item[0]}=${item[1]}`).join(','), mutations.map((item) => `${item[0]}=${item[2]}`).join(','), now);
    state.updatedAt = now;
    return {
      changed: true,
      output: {
        timezone: state.consent.timezone,
        language: state.preferences.language,
        accessibility: state.consent.accessibility,
        reviewPreferences: state.consent.reviewPreferences,
        ...((options['preferred-user-name'] !== undefined || options['clear-preferred-user-name'] || options['show-preferred-user-name']) ? { preferredUserName: state.consent.preferredUserName } : {}),
        changedFields: mutations.map((item) => item[0]),
        eventId: state.consent.lastOperationalEvent.eventId,
        nextAction: 'use-updated-preferences'
      }
    };
  });
}

async function withWorkspaceMutationLock(operationName, operation, options = {}, defaultTarget = null) {
  const targetInput = options.target || options.workspace || defaultTarget;
  if (!targetInput) return operation(options);
  const target = assertSafeWorkspaceTarget(resolvePortablePath(targetInput));
  const release = await acquireMutationLock(target);
  let result;
  let operationError = null;
  try {
    result = await operation(options);
  } catch (error) {
    operationError = error;
  }

  try {
    await release();
  } catch (releaseError) {
    if (operationError) {
      operationError.details = {
        ...(operationError.details || {}),
        mutationLockReleased: false,
        warnings: [
          ...(operationError.details?.warnings || []),
          { code: 'MUTATION_LOCK_RELEASE_FAILED', errorCode: releaseError.code || 'MUTATION_LOCK_RELEASE_FAILED' }
        ],
        nextAction: operationError.details?.nextAction || 'inspect-workspace-and-reconcile-mutation-lock',
        mutationLockRelease: {
          released: false,
          errorCode: releaseError.code || 'MUTATION_LOCK_RELEASE_FAILED',
          nextAction: 'inspect-and-reconcile-mutation-lock'
        }
      };
      throw operationError;
    }
    return {
      ...(result && typeof result === 'object' ? result : {}),
      status: 'partial',
      command: operationName,
      commandCompleted: true,
      mutationLockReleased: false,
      warnings: [
        ...((result && Array.isArray(result.warnings)) ? result.warnings : []),
        { code: 'MUTATION_LOCK_RELEASE_FAILED', errorCode: releaseError.code || 'MUTATION_LOCK_RELEASE_FAILED' }
      ],
      nextAction: 'inspect-workspace-and-reconcile-mutation-lock'
    };
  }
  if (operationError) throw operationError;
  return result;
}

const lockedInstall = (options = {}) => withWorkspaceMutationLock('install', install, options, '~/scalvin-workspace');
const lockedUpdate = (options = {}) => withWorkspaceMutationLock('update', update, options, '~/scalvin-workspace');
const lockedBackup = (options = {}) => withWorkspaceMutationLock('backup', backup, options);
const lockedRestore = (options = {}) => withWorkspaceMutationLock('restore', restore, options);
const lockedConsent = (options = {}) => withWorkspaceMutationLock('consent', consent, options);
const lockedMemory = (options = {}) => withWorkspaceMutationLock('memory', memory, options);
const lockedTranscript = (options = {}) => withWorkspaceMutationLock('transcript', transcript, options);
const lockedSession = (options = {}) => withWorkspaceMutationLock('session', session, options);
const lockedContextGraph = (options = {}) => withWorkspaceMutationLock('context', contextGraph, options);
const lockedChanges = (options = {}) => withWorkspaceMutationLock('changes', changes, options);
const lockedSource = (options = {}) => withWorkspaceMutationLock('source', source, options);
const lockedPreferences = (options = {}) => withWorkspaceMutationLock('preferences', preferences, options);

async function doctor(options = {}) {
  const target = options.target || options.workspace;
  invariant(target, 'doctor requires --workspace (or --target).', 'INVALID_ARGUMENT');
  const resolved = assertSafeWorkspaceTarget(resolvePortablePath(target));
  let release;
  try {
    release = await acquireMutationLock(resolved);
  } catch (error) {
    if (error?.code !== 'MUTATION_LOCKED') throw error;
    const lock = await inspectMutationLock(resolved).catch(() => ({ status: 'unverifiable', lockPath: error.details?.lockPath || null }));
    return {
      status: 'busy',
      workspacePath: resolved,
      errors: 1,
      warnings: 0,
      findings: [{
        severity: 'error',
        code: 'WORKSPACE_MUTATION_BUSY',
        message: `Workspace inspection was not started because a cooperative mutation lock is ${lock.status}.${lock.lockPath ? ` Lock: ${lock.lockPath}.` : ''} ${error.details?.guidance || 'Confirm that no Scalvin mutation is running before manual lock recovery.'}`
      }],
      mutationLock: lock,
      nextAction: 'confirm-no-writer-then-remove-exact-lock-manually'
    };
  }
  let result;
  let operationError = null;
  try {
    result = await runDoctor(resolved, {
      distributionRoot: DISTRIBUTION_ROOT,
      distributionManifest: DISTRIBUTION_MANIFEST,
      mutationLockHeldByCaller: true
    });
  } catch (error) {
    operationError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    if (operationError) {
      operationError.details = {
        ...(operationError.details || {}),
        mutationLockReleased: false,
        warnings: [
          ...(operationError.details?.warnings || []),
          { code: 'MUTATION_LOCK_RELEASE_FAILED', errorCode: releaseError.code || 'MUTATION_LOCK_RELEASE_FAILED' }
        ],
        nextAction: operationError.details?.nextAction || 'inspect-workspace-and-reconcile-mutation-lock',
        mutationLockRelease: {
          released: false,
          errorCode: releaseError.code || 'MUTATION_LOCK_RELEASE_FAILED',
          nextAction: 'inspect-and-reconcile-mutation-lock'
        }
      };
      throw operationError;
    }
    return {
      ...result,
      status: 'partial',
      mutationLockReleased: false,
      warnings: Number(result?.warnings || 0) + 1,
      findings: [
        ...(result?.findings || []),
        { severity: 'warning', code: 'MUTATION_LOCK_RELEASE_FAILED', message: 'Doctor completed, but its cooperative mutation lock could not be released safely.' }
      ],
      nextAction: 'inspect-workspace-and-reconcile-mutation-lock'
    };
  }
  if (operationError) throw operationError;
  return result;
}

module.exports = {
  DISTRIBUTION_ROOT,
  DISTRIBUTION_MANIFEST,
  install: lockedInstall,
  update: lockedUpdate,
  doctor,
  backup: lockedBackup,
  restore: lockedRestore,
  consent: lockedConsent,
  memory: lockedMemory,
  transcript: lockedTranscript,
  session: lockedSession,
  contextGraph: lockedContextGraph,
  changes: lockedChanges,
  source: lockedSource,
  preferences: lockedPreferences,
  loadVerifiedSources,
  inspectUpdateActions,
  assertSafeWorkspaceTarget,
  assertSafeBackupOutput
};
