'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  MUTATION_LOCK_MANUAL_RECOVERY,
  rejectSymlinkPath,
  pathExists,
  sha256File,
  walkTree,
  validateRelativePath,
  verifyWindowsPrivateAcl,
  verifyDarwinNoAcl,
  readBoundedRegularFile,
  inspectMutationLock
} = require('./lib/fs-safe');
const { loadManifest, readSourceFile, verifyDistribution } = require('./lib/manifest');
const { loadWorkspaceState, consentProjectionDifferences, buildTargetPlan, normalizePreferences } = require('./lib/workspace');
const { JOURNAL_RELATIVE, MAX_JOURNAL_BYTES, validateReceipt } = require('./lib/operation-journal');
const {
  MAX_SOURCE_RECORD_BYTES,
  parseSourceFrontmatter: parseFrontmatter,
  lintExternalCareRecord,
  lintImportedSourceRecord
} = require('./lib/source-provenance');
const { parseBackupLedger, parseBackupOperationReceipts } = require('./lib/backup');
const { parseReminder } = require('./lib/backup-reminder');
const { statusSource } = require('./source-lifecycle');

const execFileAsync = promisify(execFile);
const MAX_CONSENT_PROJECTION_BYTES = 1024 * 1024;
const MAX_GITIGNORE_BYTES = 256 * 1024;
const MAX_CLIENT_SETTINGS_BYTES = 1024 * 1024;
const MAX_LOCAL_POINTER_BYTES = 64 * 1024;

function finding(severity, code, message, details) {
  return { severity, code, message, ...(details ? { details } : {}) };
}

function validUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function containsCommand(value, command) {
  if (Array.isArray(value)) return value.some((item) => containsCommand(item, command));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsCommand(item, command));
  return value === command;
}

async function checkSensitiveGitTracking(workspace) {
  const sensitive = [
    'profile.md', 'ACTIVE-THEMES.md', 'CURRENT-FOCUS.md', 'NEXT-PRIMER.md',
    'SETUP-NOTES.md', 'sessions', 'sources', 'archive', 'context', '.therapy', '.scalvin', '.claude'
  ];
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--', ...sensitive], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 128) return [];
    if (/not a git repository/i.test(error.stderr || '')) return [];
    return [{ checkError: error.message }];
  }
}

async function checkExternalCareProvenance(workspace) {
  const findings = [];
  const sourcesRoot = path.join(workspace, 'sources');
  if (!(await pathExists(sourcesRoot))) return findings;
  let entries;
  try {
    entries = await walkTree(sourcesRoot);
  } catch (error) {
    return [finding('error', error.code || 'SOURCE_PROVENANCE_SCAN_FAILED', 'Source provenance scan failed.', { cause: error.message })];
  }
  for (const entry of entries.filter((item) => item.type === 'file' && item.path.toLowerCase().endsWith('.md'))) {
    try {
      if (entry.size > MAX_SOURCE_RECORD_BYTES) {
        findings.push(finding('error', 'SOURCE_RECORD_TOO_LARGE', 'A source record exceeds the safe provenance-scan limit.', { record: entry.path }));
        continue;
      }
      const markdown = (await readBoundedRegularFile(path.join(sourcesRoot, entry.path), MAX_SOURCE_RECORD_BYTES, {
        typeCode: 'SOURCE_RECORD_INVALID', sizeCode: 'SOURCE_RECORD_TOO_LARGE', changedCode: 'SOURCE_RECORD_CHANGED'
      })).toString('utf8');
      const managedRecord = entry.path.replaceAll('\\', '/').startsWith('records/');
      if (!managedRecord && !markdown.startsWith('---\nrecord_kind:')) continue;
      const fields = parseFrontmatter(markdown);
      if (!managedRecord && fields?.record_kind !== 'external_care_note') continue;
      const recordFindings = fields.record_kind === 'external_care_note'
        ? lintExternalCareRecord(markdown)
        : lintImportedSourceRecord(markdown);
      for (const item of recordFindings) {
        findings.push(finding(item.severity, item.code, item.message, { record: entry.path, ...(item.details || {}) }));
      }
    } catch (error) {
      findings.push(finding('error', error.code || 'SOURCE_PROVENANCE_SCAN_FAILED', 'An external-care provenance record could not be inspected.', { record: entry.path, cause: error.message }));
    }
  }
  if (!findings.some((item) => item.severity === 'error')) findings.push(finding('info', 'EXTERNAL_CARE_PROVENANCE_OK', 'External-care records have valid provenance boundaries.'));
  return findings;
}

async function checkBackupLedger(workspace, state) {
  const relative = path.join('.therapy', 'state', 'BACKUP-LEDGER.md');
  const filename = path.join(workspace, relative);
  if (!(await pathExists(filename))) {
    return state?.consent?.usageLedgers === 'on'
      ? [finding('error', 'BACKUP_LEDGER_MISSING', 'Backup ledger is missing while operational ledgers are enabled.')]
      : [];
  }
  try {
    await rejectSymlinkPath(filename);
    const markdown = (await readBoundedRegularFile(filename, 1024 * 1024, {
      typeCode: 'BACKUP_LEDGER_INVALID', sizeCode: 'BACKUP_LEDGER_INVALID', changedCode: 'BACKUP_LEDGER_CHANGED'
    })).toString('utf8');
    const parsed = parseBackupLedger(markdown);
    const operationReceipts = parseBackupOperationReceipts(markdown);
    const reminder = parseReminder(markdown);
    const lines = markdown.split(/\r?\n/u);
    const recordCandidates = lines.filter((line) => /^\|\s*backup-(?!op-)/i.test(line));
    const operationCandidates = lines.filter((line) => /^\|\s*backup-op-/i.test(line));
    if (recordCandidates.length !== parsed.records.length || operationCandidates.length !== operationReceipts.length) throw new Error('unparseable backup ledger row');
    const exactBullet = (label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = [...markdown.matchAll(new RegExp(`^- ${escaped}: ([^|\\r\\n]{1,128})$`, 'gm'))];
      if (matches.length !== 1) throw new Error('backup reminder field missing or duplicated');
      return matches[0][1];
    };
    const lastAt = exactBullet('Last successful backup');
    const lastHash = exactBullet('Last successful backup SHA-256');
    const destination = exactBullet('Last destination class');
    const nullTriple = lastAt === 'null' && lastHash === 'null' && destination === 'null';
    const completeTriple = lastAt !== 'null' && lastHash !== 'null' && destination !== 'null';
    if (!nullTriple && !completeTriple) throw new Error('backup reminder success fields are inconsistent');
    const newest = [...parsed.records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
    if (completeTriple) {
      if (Number.isNaN(Date.parse(lastAt)) || new Date(lastAt).toISOString() !== lastAt || !/^[a-f0-9]{64}$/.test(lastHash) || !/^[a-z0-9_]{1,64}$/.test(destination)) throw new Error('backup reminder success fields are invalid');
      if (!newest || newest.artifactStatus !== 'complete' || newest.createdAt !== lastAt || newest.checksum !== lastHash || newest.destinationClass !== destination) throw new Error('backup reminder state does not match the latest complete receipt');
    } else if (newest && newest.artifactStatus !== 'deleted') throw new Error('backup reminder state omits the latest complete receipt');
    if (reminder.reminderDeclinedUntil !== null && reminder.lastReminderAt === null) throw new Error('backup reminder suppression has no reminder event');
    return [finding('info', 'BACKUP_LEDGER_OK', 'Backup receipts, operation outcomes, and reminder state are structurally consistent.', {
      count: parsed.records.length,
      operationReceiptCount: operationReceipts.length,
      sessionsSinceSuccessfulBackup: reminder.sessionsSinceSuccessfulBackup
    })];
  } catch (error) {
    return [finding('error', 'BACKUP_LEDGER_INVALID', 'Backup ledger or reminder state is invalid.', { causeCode: error.code || 'INVALID' })];
  }
}

async function checkSourceLifecycle(workspace, state) {
  if (!state) return [];
  try {
    const ledger = await statusSource({ workspace });
    const active = ledger.records.filter((record) => !['deleted', 'pending_consent'].includes(record.status));
    const canonical = state.sourceLifecycle.records;
    if (active.length !== canonical.length) throw new Error('source lifecycle record count mismatch');
    for (const record of canonical) {
      const match = active.find((item) => item.sourceId === record.sourceId && item.revision === record.revision);
      if (!match) throw new Error('canonical source record missing from ledger');
      for (const key of ['kind', 'locale', 'sha256', 'byteLength', 'status', 'trust', 'retention', 'lastIntegratedHash', 'lastIntegratedAt', 'error']) {
        if (JSON.stringify(match[key]) !== JSON.stringify(record[key])) throw new Error(`source lifecycle ${key} mismatch`);
      }
      if (JSON.stringify(match.derivedMemoryIds) !== JSON.stringify(record.derivedMemoryIds)) throw new Error('source lifecycle derived-memory mismatch');
    }
    return [finding('info', 'SOURCE_LIFECYCLE_OK', 'Canonical source lifecycle state matches content-free ledger metadata.', { count: canonical.length })];
  } catch (error) {
    return [finding('error', 'SOURCE_LIFECYCLE_INVALID', 'Canonical source lifecycle state or ledger metadata is invalid.', { causeCode: error.code || 'INVALID' })];
  }
}

async function runDoctor(workspace, context) {
  const findings = [];
  let loaded;
  try {
    loaded = await loadManifest(context.distributionManifest);
    findings.push(finding('info', 'MANIFEST_SCHEMA_OK', 'Distribution manifest schema v2 is valid.'));
  } catch (error) {
    return {
      status: 'errors', workspacePath: workspace, workspaceId: null,
      errors: 1, warnings: 0,
      findings: [finding('error', error.code || 'MANIFEST_INVALID', error.message, error.details)],
      nextAction: 'repair-distribution'
    };
  }

  const distributionErrors = await verifyDistribution(loaded.manifest, context.distributionRoot);
  if (distributionErrors.length) findings.push(finding('error', 'DISTRIBUTION_INTEGRITY_FAILED', 'Distribution files do not match manifest hashes.', { files: distributionErrors }));
  else findings.push(finding('info', 'DISTRIBUTION_INTEGRITY_OK', 'All distribution file hashes match.'));

  try {
    await rejectSymlinkPath(workspace);
    const stat = await fsp.lstat(workspace);
    if (!stat.isDirectory()) findings.push(finding('error', 'WORKSPACE_NOT_DIRECTORY', 'Workspace is not a directory.'));
  } catch (error) {
    findings.push(finding('error', error.code || 'WORKSPACE_NOT_FOUND', error.message));
    return summarize(workspace, null, findings);
  }

  if (!context.mutationLockHeldByCaller) {
    try {
      const lock = await inspectMutationLock(workspace);
      if (lock.status === 'present') {
        findings.push(finding('warning', 'MUTATION_LOCK_PRESENT', 'A cooperative workspace mutation lock is present. It may be active or orphaned; Scalvin will never remove it automatically.', {
          lockPath: lock.lockPath,
          lockKind: lock.lockKind,
          ...(lock.ownerPid === undefined ? {} : { ownerPid: lock.ownerPid }),
          ...(lock.acquiredAt === undefined ? {} : { acquiredAt: lock.acquiredAt }),
          recovery: 'manual-only',
          guidance: MUTATION_LOCK_MANUAL_RECOVERY
        }));
      } else if (lock.status === 'unverifiable') {
        findings.push(finding('warning', 'MUTATION_LOCK_CHECK_FAILED', 'The cooperative mutation-lock location cannot be safely inspected and will not be changed automatically.', {
          lockPath: lock.lockPath,
          lockKind: lock.lockKind,
          recovery: 'manual-only',
          guidance: MUTATION_LOCK_MANUAL_RECOVERY
        }));
      } else {
        findings.push(finding('info', 'MUTATION_LOCK_CLEAR', 'No cooperative workspace mutation lock is present.'));
      }
    } catch (error) {
      findings.push(finding('warning', 'MUTATION_LOCK_CHECK_FAILED', 'The cooperative mutation-lock location cannot be safely inspected and will not be changed automatically.', {
        causeCode: error.code || 'INVALID',
        recovery: 'manual-only',
        guidance: MUTATION_LOCK_MANUAL_RECOVERY
      }));
    }
  }

  const stateResult = await loadWorkspaceState(workspace, loaded.manifest);
  let state = null;
  if (stateResult.kind === 'current') {
    state = stateResult.state;
    findings.push(finding('info', 'STATE_SCHEMA_OK', 'Workspace state schema v2 is valid.'));
  } else if (stateResult.kind === 'legacy') {
    findings.push(finding('warning', 'LEGACY_STATE', 'Legacy workspace state requires a pinned update to migrate safely.', { path: stateResult.path }));
  } else if (stateResult.kind === 'corrupt') {
    findings.push(finding('error', 'STATE_CORRUPT', 'Workspace state is corrupt.', { path: stateResult.path, cause: stateResult.error }));
  } else {
    findings.push(finding('error', 'STATE_MISSING', 'Workspace identity state is missing.'));
  }

  if (state) {
    if (!validUuid(state.workspaceId)) findings.push(finding('error', 'WORKSPACE_ID_INVALID', 'Workspace ID is missing or invalid.'));
    else findings.push(finding('info', 'WORKSPACE_ID_OK', 'Workspace identity is valid.'));
    const sameDistribution = state.product.manifestSha256 === loaded.sha256;
    if (!sameDistribution) findings.push(finding('warning', 'WORKSPACE_MANIFEST_DRIFT', 'Workspace was installed from a different manifest; run a pinned dry-run update.', { installed: state.product.manifestSha256, current: loaded.sha256 }));
    else findings.push(finding('info', 'WORKSPACE_MANIFEST_OK', 'Workspace manifest identity matches this distribution.'));
    if (sameDistribution) {
      const provenanceFields = [];
      if (state.product.version !== loaded.manifest.product.version) provenanceFields.push('product.version');
      if (state.source?.pinType !== 'manifest-sha256') provenanceFields.push('source.pinType');
      if (state.source?.pin !== loaded.sha256) provenanceFields.push('source.pin');
      if (provenanceFields.length) {
        findings.push(finding('error', 'STATE_DISTRIBUTION_PROVENANCE_MISMATCH', 'Canonical distribution provenance does not match the signed manifest.', { fields: provenanceFields }));
      } else {
        findings.push(finding('info', 'STATE_DISTRIBUTION_PROVENANCE_OK', 'Canonical distribution provenance matches the signed manifest.'));
      }
    } else if (state.source?.pinType === 'manifest-sha256' && state.source.pin !== state.product.manifestSha256) {
      findings.push(finding('error', 'STATE_DISTRIBUTION_PROVENANCE_MISMATCH', 'Canonical manifest identity and source pin disagree.', { fields: ['source.pin'] }));
    }
    if (!state.consent || state.consent.status === 'not-decided') findings.push(finding('warning', 'CONSENT_NOT_RECORDED', 'Consent choice has not been recorded; do not write sensitive user content yet.'));
    else if (!['granted', 'declined'].includes(state.consent.status)) findings.push(finding('error', 'CONSENT_STATE_INVALID', 'Consent state is invalid.'));
    else findings.push(finding('info', 'CONSENT_STATE_OK', `Consent state is ${state.consent.status}.`));
    try {
      const controls = (await readBoundedRegularFile(path.join(workspace, '.therapy', 'state', 'DATA-CONTROLS.md'), MAX_CONSENT_PROJECTION_BYTES, {
        typeCode: 'CONSENT_PROJECTION_INVALID', sizeCode: 'CONSENT_PROJECTION_TOO_LARGE', changedCode: 'CONSENT_PROJECTION_CHANGED'
      })).toString('utf8');
      const differences = consentProjectionDifferences(controls, state);
      if (differences.length) findings.push(finding('error', 'CONSENT_PROJECTION_MISMATCH', 'Human-readable data controls disagree with canonical workspace state.', { fields: differences.map((item) => item.field) }));
      else findings.push(finding('info', 'CONSENT_PROJECTION_OK', 'Human-readable data controls match canonical workspace state.'));
      const needsLedger = Boolean(state.consent?.eventId || state.consent?.lastOperationalEvent?.eventId);
      const ledger = needsLedger
        ? (await readBoundedRegularFile(path.join(workspace, '.therapy', 'state', 'CONSENT-LEDGER.md'), MAX_CONSENT_PROJECTION_BYTES, {
          typeCode: 'CONSENT_LEDGER_INVALID', sizeCode: 'CONSENT_LEDGER_TOO_LARGE', changedCode: 'CONSENT_LEDGER_CHANGED'
        })).toString('utf8')
        : null;
      if (state.consent?.eventId) {
        if (!ledger.includes(`| ${state.consent.eventId} |`)) findings.push(finding('error', 'CONSENT_LEDGER_EVENT_MISSING', 'Canonical consent event is missing from the consent ledger.'));
        else findings.push(finding('info', 'CONSENT_LEDGER_OK', 'Canonical consent event is present in the content-free ledger.'));
      }
      if (state.consent?.lastOperationalEvent?.eventId) {
        if (!ledger.includes(`| ${state.consent.lastOperationalEvent.eventId} |`)) findings.push(finding('error', 'CONTROL_LEDGER_EVENT_MISSING', 'Canonical operational-control event is missing from the content-free ledger.'));
        else findings.push(finding('info', 'CONTROL_LEDGER_OK', 'Canonical operational-control event is present in the content-free ledger.'));
      }
    } catch (error) {
      findings.push(finding('error', 'CONSENT_PROJECTION_UNREADABLE', 'Consent projection or ledger cannot be read.', { causeCode: error.code || 'INVALID' }));
    }

    const sourceEntries = new Map(loaded.manifest.files.map((entry) => [entry.path, entry]));
    let expectedTargets = new Map();
    try {
      const buffers = new Map();
      for (const entry of loaded.manifest.files) buffers.set(entry.path, await readSourceFile(loaded, entry));
      const validatedPreferences = normalizePreferences(loaded.manifest, {}, state.preferences);
      expectedTargets = new Map(buildTargetPlan(loaded.manifest, buffers, validatedPreferences).map((item) => [item.target, item]));
    } catch (error) {
      findings.push(finding('error', 'EXPECTED_TARGET_BUILD_FAILED', 'Could not derive expected managed targets from the signed manifest.', { cause: error.message }));
    }
    for (const [target, record] of Object.entries(state.files || {})) {
      try {
        validateRelativePath(target);
        const expected = expectedTargets.get(target);
        const signedRole = expected?.role || record.role;
        const signedProtection = expected?.protection || record.protection;
        const safetyCritical = /hook|safety-protocol/i.test(signedRole);
        if (sameDistribution && expected) {
          const registryFields = ['sourcePath', 'sourceHash', 'version', 'role', 'protection']
            .filter((field) => record[field] !== expected[field]);
          if (registryFields.length) {
            findings.push(finding('error', 'STATE_TARGET_REGISTRY_MISMATCH', 'Canonical managed-target metadata does not match the signed manifest-derived target.', {
              target, role: expected.role, protection: expected.protection, fields: registryFields
            }));
          }
          if (!['seed', 'protected'].includes(expected.protection) && record.installedHash !== expected.installedHash) {
            findings.push(finding('error', 'STATE_INSTALLED_BASELINE_MISMATCH', 'Canonical installed baseline does not match the signed manifest-derived target.', {
              target,
              role: expected.role,
              protection: expected.protection,
              expectedHash: expected.installedHash,
              recordedHash: record.installedHash
            }));
          }
        }
        const filename = path.join(workspace, target);
        await rejectSymlinkPath(filename, { allowMissing: true });
        if (!(await pathExists(filename))) {
          const severity = signedProtection === 'seed' || signedProtection === 'protected' ? 'warning' : 'error';
          findings.push(finding(severity, 'MANAGED_FILE_MISSING', 'Managed file is missing.', { target, role: record.role }));
          continue;
        }
        const actual = await sha256File(filename);
        if (actual !== record.installedHash) {
          const severity = safetyCritical ? 'error' : signedProtection === 'framework' ? 'warning' : 'info';
          findings.push(finding(severity, 'MANAGED_FILE_CUSTOMIZED', 'Managed file differs from its installed baseline.', { target, role: signedRole, protection: signedProtection }));
        }
        const source = sourceEntries.get(record.sourcePath);
        if (!source) findings.push(finding('warning', 'SOURCE_NO_LONGER_REGISTERED', 'Installed file source is not present in this distribution manifest.', { target, sourcePath: record.sourcePath }));
        else if (record.sourceHash !== source.sha256 || record.version !== source.version) {
          findings.push(finding(sameDistribution ? 'error' : 'warning', 'STATE_SOURCE_REGISTRY_MISMATCH', 'Installed source hash/version differs from the signed distribution registry.', {
            target, sourcePath: record.sourcePath, expectedHash: source.sha256, installedHash: record.sourceHash,
            expectedVersion: source.version, installedVersion: record.version
          }));
        }
        if (expected && !['seed', 'protected'].includes(expected.protection) && actual !== expected.installedHash) {
          findings.push(finding(safetyCritical ? 'error' : 'warning', safetyCritical ? 'SAFETY_CRITICAL_HASH_MISMATCH' : 'SIGNED_TARGET_MISMATCH', 'Managed target does not match the signed manifest-derived content.', {
            target, role: record.role, expected: expected.installedHash, actual
          }));
        }
      } catch (error) {
        findings.push(finding('error', error.code || 'MANAGED_FILE_CHECK_FAILED', error.message, { target }));
      }
    }
    for (const [target, expected] of expectedTargets) {
      const record = state.files?.[target];
      if (!record) {
        const critical = ['framework', 'active'].includes(expected.protection);
        findings.push(finding(sameDistribution && critical ? 'error' : 'warning', 'EXPECTED_MANAGED_TARGET_MISSING', 'A manifest-selected target is absent from canonical state.', { target, role: expected.role, protection: expected.protection }));
      }
    }
    for (const [target, record] of Object.entries(state.files || {})) {
      if (!expectedTargets.has(target)) {
        findings.push(finding(sameDistribution ? 'error' : 'warning', 'UNEXPECTED_MANAGED_TARGET', 'Canonical state contains a target not selected by the manifest and preferences.', { target, role: record.role, protection: record.protection }));
      }
    }
  }

  findings.push(...await checkExternalCareProvenance(workspace));
  findings.push(...await checkSourceLifecycle(workspace, state));
  findings.push(...await checkBackupLedger(workspace, state));

  const journalPath = path.join(workspace, JOURNAL_RELATIVE);
  if (await pathExists(journalPath)) {
    try {
      const lines = (await readBoundedRegularFile(journalPath, MAX_JOURNAL_BYTES, {
        typeCode: 'OPERATION_JOURNAL_INVALID', sizeCode: 'OPERATION_JOURNAL_INVALID', changedCode: 'OPERATION_JOURNAL_CHANGED'
      })).toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) validateReceipt(JSON.parse(line));
      findings.push(finding('info', 'OPERATION_JOURNAL_OK', 'Content-free failed-operation receipts are structurally valid.', { count: lines.length }));
    } catch (error) {
      findings.push(finding('error', 'OPERATION_JOURNAL_INVALID', 'Failed-operation journal is invalid.', { causeCode: error.code || 'INVALID' }));
    }
  }

  const tracked = await checkSensitiveGitTracking(workspace);
  if (tracked.some((item) => typeof item === 'object')) findings.push(finding('warning', 'GIT_CHECK_FAILED', 'Could not verify sensitive Git tracking.', tracked[0]));
  else if (tracked.length) findings.push(finding('error', 'SENSITIVE_FILES_TRACKED', 'Sensitive living-workspace files are tracked by Git.', { files: tracked }));
  else findings.push(finding('info', 'SENSITIVE_FILES_NOT_TRACKED', 'No sensitive living-workspace paths are tracked by Git.'));

  const ignoreFile = path.join(workspace, '.gitignore');
  if (!(await pathExists(ignoreFile))) {
    findings.push(finding('error', 'WORKSPACE_GITIGNORE_MISSING', 'Workspace privacy .gitignore is missing.'));
  } else {
    try {
      const ignore = (await readBoundedRegularFile(ignoreFile, MAX_GITIGNORE_BYTES, {
        typeCode: 'WORKSPACE_GITIGNORE_INVALID', sizeCode: 'WORKSPACE_GITIGNORE_TOO_LARGE', changedCode: 'WORKSPACE_GITIGNORE_CHANGED'
      })).toString('utf8');
      const required = ['profile.md', 'sessions/', 'sources/', 'archive/', '.therapy/', '.scalvin/'];
      const defaultDeny = /^\s*\*\s*$/m.test(ignore);
      const missing = defaultDeny ? [] : required.filter((pattern) => !ignore.includes(pattern));
      if (missing.length) findings.push(finding('error', 'WORKSPACE_GITIGNORE_INCOMPLETE', 'Workspace privacy .gitignore is incomplete.', { missing }));
      else findings.push(finding('info', 'WORKSPACE_GITIGNORE_OK', 'Workspace privacy ignore rules are present.'));
    } catch (error) {
      findings.push(finding('error', 'WORKSPACE_GITIGNORE_INVALID', 'Workspace privacy .gitignore cannot be safely read.', { causeCode: error.code || 'INVALID' }));
    }
  }

  try {
    const parent = path.dirname(workspace);
    const prefix = `${path.basename(workspace)}.rollback.`;
    const retained = (await fsp.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .slice(0, 25)
      .map((entry) => path.join(parent, entry.name));
    if (retained.length) {
      findings.push(finding('warning', 'PRIVATE_ROLLBACK_RETAINED', 'One or more private activation rollback containers require explicit cleanup.', {
        count: retained.length,
        paths: retained
      }));
    } else {
      findings.push(finding('info', 'PRIVATE_ROLLBACKS_CLEAR', 'No retained private activation rollback container was found.'));
    }
  } catch (error) {
    findings.push(finding('warning', 'PRIVATE_ROLLBACK_CHECK_FAILED', 'Retained private rollback containers could not be checked.', { causeCode: error.code || 'INVALID' }));
  }

  if (process.platform !== 'win32') {
    try {
      const permissionProblems = [];
      const rootStat = await fsp.stat(workspace);
      if ((rootStat.mode & 0o777) !== PRIVATE_DIR_MODE) permissionProblems.push({ path: '.', expected: '0700', actual: (rootStat.mode & 0o777).toString(8) });
      const entries = await walkTree(workspace);
      for (const entry of entries) {
        const expected = entry.type === 'directory' ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE;
        if (entry.mode !== expected) permissionProblems.push({ path: entry.path, expected: expected.toString(8).padStart(4, '0'), actual: entry.mode.toString(8).padStart(4, '0') });
        if (permissionProblems.length >= 25) break;
      }
      if (process.platform === 'darwin') {
        const acl = await verifyDarwinNoAcl(workspace, { recursive: true });
        if (!acl.ok) permissionProblems.push({ path: '.', expected: 'no extended ACL', actual: 'extended ACL present or unverifiable' });
      }
      if (permissionProblems.length) findings.push(finding('warning', 'PERMISSIONS_TOO_BROAD', 'Workspace permissions or access-control lists are not private.', { files: permissionProblems }));
      else findings.push(finding('info', 'PERMISSIONS_OK', 'Workspace permissions are private and no broad access-control list is present.'));
    } catch (error) {
      findings.push(finding('error', 'WORKSPACE_TREE_INVALID', 'Workspace tree cannot be safely inspected.', { causeCode: error.code || 'INVALID' }));
    }
  } else {
    const acl = await verifyWindowsPrivateAcl(workspace);
    if (acl.ok) findings.push(finding('info', 'WINDOWS_ACL_OK', 'Workspace root ACL is protected; tree ownership and effective access are limited to the current user, SYSTEM, and built-in administrators.'));
    else findings.push(finding('error', 'WINDOWS_ACL_INVALID', 'Workspace does not have the required private Windows ACL.', { cause: acl.error }));
  }

  const hookEntries = loaded.manifest.files.filter((entry) => /hook/i.test(entry.role));
  if (!hookEntries.length) {
    findings.push(finding('info', 'HOOKS_NOT_DECLARED', 'No client hook is declared for this distribution; runtime safety remains authoritative.'));
  } else {
    findings.push(finding('info', 'HOOK_FILES_REGISTERED', 'Declared hook files are covered by managed-file integrity checks.', { count: hookEntries.length }));
    const integration = loaded.manifest.clientIntegrations?.claude;
    try {
      const settings = JSON.parse((await readBoundedRegularFile(path.join(workspace, integration.settingsPath), MAX_CLIENT_SETTINGS_BYTES, {
        typeCode: 'HOOK_SETTINGS_INVALID', sizeCode: 'HOOK_SETTINGS_TOO_LARGE', changedCode: 'HOOK_SETTINGS_CHANGED'
      })).toString('utf8'));
      const missingHooks = integration.hooks
        .map((hook) => `node "${hook.target}"`)
        .filter((command) => !containsCommand(settings, command));
      if (missingHooks.length) findings.push(finding('error', 'HOOK_REGISTRATION_MISSING', 'One or more declared Claude hooks are not registered.', { count: missingHooks.length }));
      else findings.push(finding('info', 'HOOK_REGISTRATION_OK', 'Declared Claude hooks are surgically registered.'));
    } catch (error) {
      findings.push(finding('error', 'HOOK_SETTINGS_INVALID', 'Claude hook settings are missing or invalid.', { causeCode: error.code || 'INVALID' }));
    }
  }

  const localPointerRoot = process.env.SCALVIN_LOCAL_STATE_DIR
    ? path.resolve(process.env.SCALVIN_LOCAL_STATE_DIR)
    : context.distributionRoot;
  const localPointer = process.env.SCALVIN_LOCAL_STATE_DIR
    ? path.join(localPointerRoot, 'local-state.json')
    : path.join(localPointerRoot, loaded.manifest.state?.localPointer || '.scalvin/local-state.json');
  if (await pathExists(path.join(context.distributionRoot, '.git'))) {
    try {
      const pointer = JSON.parse((await readBoundedRegularFile(localPointer, MAX_LOCAL_POINTER_BYTES, {
        typeCode: 'LOCAL_POINTER_INVALID', sizeCode: 'LOCAL_POINTER_TOO_LARGE', changedCode: 'LOCAL_POINTER_CHANGED'
      })).toString('utf8'));
      if (pointer.workspacePath !== workspace || (state?.workspaceId && pointer.workspaceId !== state.workspaceId)) {
        findings.push(finding('warning', 'LOCAL_POINTER_MISMATCH', 'Source-repository local workspace pointer does not match this workspace.'));
      } else findings.push(finding('info', 'LOCAL_POINTER_OK', 'Source-repository local workspace pointer matches.'));
    } catch (error) {
      findings.push(finding('warning', 'LOCAL_POINTER_MISSING', 'Source-repository local workspace pointer is missing or invalid.', { causeCode: error.code || 'INVALID' }));
    }
  }

  try {
    await fsp.access(path.dirname(workspace), fsp.constants.W_OK);
    const token = crypto.randomUUID();
    if (typeof token !== 'string') throw new Error('Secure random unavailable.');
    findings.push(finding('info', 'RESTORE_CAPABILITY_OK', 'Backup staging and atomic sibling restore prerequisites are available.'));
  } catch (error) {
    findings.push(finding('error', 'RESTORE_CAPABILITY_FAILED', 'Restore staging prerequisites are unavailable.', { cause: error.message }));
  }

  return summarize(workspace, state?.workspaceId || null, findings);
}

function summarize(workspace, workspaceId, findings) {
  const errors = findings.filter((item) => item.severity === 'error').length;
  const warnings = findings.filter((item) => item.severity === 'warning').length;
  return {
    status: errors ? 'errors' : warnings ? 'warnings' : 'healthy',
    workspacePath: workspace,
    workspaceId,
    errors,
    warnings,
    findings,
    nextAction: errors ? 'repair-errors' : warnings ? 'review-warnings' : 'none'
  };
}

module.exports = { runDoctor, summarize, checkSensitiveGitTracking, parseFrontmatter, checkExternalCareProvenance, checkSourceLifecycle, checkBackupLedger };
