'use strict';

const packageJson = require('../package.json');
const { parseArgs } = require('./lib/args');
const { ScalvinError } = require('./lib/errors');
const operations = require('./operations');
const { reviewDue } = require('./review-due');
const { inspectSource } = require('./source-inspect');

const HELP = `Scalvin ${packageJson.version}

Usage:
  scalvin install [--workspace PATH] [--force --confirm TOKEN] [--dry-run] [--json]
  scalvin update --workspace PATH --manifest-sha256 HASH [--release VERSION] [--force --confirm TOKEN]
  scalvin doctor --workspace PATH [--json]
  scalvin backup --workspace PATH [--action create|status|verify|delete] [--id BACKUP_ID] [--backup PATH] [backup options] [--json]
  scalvin backup --action key-create --output RECOVERY_KEY_FILE [--dry-run] [--json]
  scalvin restore --backup BACKUP_DIR --workspace PATH [--passphrase-file FILE] [--force] [--confirm TOKEN] [--dry-run] [--json]
  scalvin consent --workspace PATH (--status STATUS | --category CATEGORY --value VALUE) [--retention POLICY] [--dry-run] [--json]
  scalvin memory --workspace PATH --action pause|seal|resume|status|view|export|correct|forget|delete-all|review-due|review-confirm|review-decline|review-suppress|review-unsuppress [memory options] [--json]
  scalvin memory --workspace PATH --action retention-status [--data-class CLASS] [--now RFC3339] [--json]
  scalvin memory --workspace PATH --action retention-set --data-class CLASS --policy POLICY [--days N | --expires-at RFC3339] [--now RFC3339] [--dry-run] [--json]
  scalvin memory --workspace PATH --action retention-apply --data-class CLASS [--now RFC3339] [--confirm TOKEN] [--dry-run] [--json]
  scalvin transcript --workspace PATH --action start|pause|resume|stop|status|delete [--session-id ID | --scope all] [--confirm TOKEN] [--json]
  scalvin session begin|checkpoint|close|recover|status --workspace PATH [session options] [--json]
  scalvin context status|show|add|correct|status-change|forget|merge|backfill --workspace PATH [context options] [--json]
  scalvin changes propose|approve|reject|history|rollback --workspace PATH [change options] [--json]
  scalvin client launch --workspace PATH [--client codex|claude] [--client-bin PATH] [--json]
  scalvin preferences --workspace PATH [--language auto|BCP-47] [--timezone IANA] [--preferred-user-name NAME | --clear-preferred-user-name] [accessibility flags] [--dry-run] [--json]
  scalvin source inspect --path FILE [--json]
  scalvin source add|status|process|proposals|integrate|reject|delete --workspace PATH [source options] [--json]
  scalvin review-due --workspace PATH [--date YYYY-MM-DD] [--timezone IANA] [--json]
  scalvin help
  scalvin version

Install selections:
  --companion-name NAME   Companion display name (default: Susan)
  --language LANGUAGE     auto or a canonical BCP-47 conversation-language tag
  --persona SLUG          Active persona
  --structure SLUG        Active session structure
  --modality SLUG         Active modality; repeat or comma-separate
  --consent STATUS        not-decided, granted, or declined (default: not-decided)
  --status STATUS         consent command target state: not-decided, granted, or declined
  --category CATEGORY     scoped consent category (for example raw_transcripts)
  --value VALUE           category-specific value such as on, off, ask, or ask_each_import
  --retention POLICY      Consent storage policy: until_deleted or do_not_store

Safety and automation:
  --non-interactive       Confirm no prompts will be used (the CLI never prompts)
  --force                 Request replacement; non-empty install/conflicting update also require the exact preview token
  --dry-run               Validate and report without modifying the workspace
  --json                  Emit one machine-readable JSON result
  --backup-output DIR     Directory for automatic safety backups
  --passphrase-file FILE  Read an encryption passphrase from a private regular file
  --backup-passphrase-file FILE  Protect an automatic safety backup with this private file
  --recovery-key-output DIR  Private directory for generated recovery-key files
  --allow-plaintext-backup  Explicitly create a confidentiality-unprotected backup
  --allow-plaintext-export  Explicitly create a confidentiality-unprotected memory export
  --decline-reminder      Suppress backup reminders for 30 days

Memory and deletion:
  --id ID                 Stable memory or transcript/session ID
  --scope SCOPE           Explicit view, export, forget, or deletion scope
  --statement TEXT        Replacement wording for memory correction
  --output DIR            User-selected export destination
  --confirm TOKEN         Exact confirmation token returned by a destructive preview
  --preferred-user-name NAME  Persist a bounded preferred name only with continuity consent on
  --clear-preferred-user-name Remove the saved preferred user name
  --show-preferred-user-name  Include the saved preferred name in this explicit response
  --reduced-metaphor MODE     unset, on, or off
  --extra-processing-time MODE  unset, on, or off
  Memory review actions always select one --id; review-due offers at most 3.

Retention cleanup:
  --data-class CLASS      Exact retained-data class; status may omit it to inspect all classes
  --policy POLICY         inherit, session_only, rolling_days, or expire_at
  --days N                1..36500; required only with rolling_days
  --expires-at RFC3339    Exact expiry; required only with expire_at
  --now RFC3339           Optional deterministic inspection/preview timestamp
  retention-set changes the cleanup control only; it neither changes consent nor deletes data.
  retention-apply is manual: it previews content-free counts and returns an exact
  confirmation token before deleting supported due items. It is not a background scheduler.
  Ambiguous or unsupported items remain blocked. Backups remain separate copies.

Session lifecycle:
  --session-id ID         Exact s-<UUID-v4> session identity
  --turn-number N         Positive checkpoint turn number
  --live-thread-file FILE Bounded checkpoint live-thread input
  --unresolved-file FILE  Bounded checkpoint unresolved-item input
  --carry-forward-file FILE Bounded checkpoint carry-forward input
  --note-file FILE        Bounded session-note body input
  --deep-dive-file FILE   Optional bounded deep-dive body for session close
  --primer-file FILE      Bounded next-primer body input
  --transcript-file FILE  Bounded transcript JSON input
  --recovery-action MODE  continue, close_interrupted, delete, or abandon
  --can-resume-context    Assert the same client context is available

Context graph:
  --id ID                 Exact person-, place-, or event-<UUID-v4> identity
  --candidate-file FILE   Canonical candidate JSON for add
  --patch-file FILE       Canonical correction patch JSON
  --status STATUS         Core, Active, Provisional, or Dormant
  --canonical-id ID       Entity retained by merge
  --merged-id ID          Entity retired by merge
  --candidates-file FILE  Canonical one-to-five candidate batch for backfill
  --approved-id ID        Explicit approved backfill ID; repeat or comma-separate
  Context forget, merge, and backfill return exact confirmation tokens first.

Controlled behavior changes:
  --change-target TARGET  persona, live-moveset, disambiguation, rupture-and-repair,
                          source-triggers, session-style, or accessibility
  --setting NAME          Allowed setting within the selected change target
  --value VALUE           Registered enumerated value; file form gets the same validation
  --evidence-status KIND  user_requested, observed_once, or observed_repeatedly
  --why TEXT              Bounded single-line reason; --why-file is also supported
  --expected-effect TEXT  Bounded single-line effect; file form is also supported
  --risks-or-tradeoffs TEXT  Bounded single-line tradeoff; --risks-file is supported
  --change-id ID          Exact pending chg-<UUID-v4> identity
  --revision-id ID        Exact rev-<UUID-v4> identity to roll back
  Approval and rollback first return an exact before/after preview and token.
  They apply only when that exact token is supplied with --confirm.

Source lifecycle:
  --path FILE             One exact regular file for inspect or add
  --source-id ID          Exact src-<UUID-v4> identity
  --revision N            Positive source revision
  --kind KIND             imported_source or external_care_note
  --locale BCP-47         Optional canonical source metadata only
  --provenance-file FILE  Bounded JSON provenance object; source text stays inert
  --client NAME           Isolated source-worker client: codex or claude
  --client-bin PATH       Optional exact absolute client executable
  --proposed-memory-id ID Explicit user-approved candidate ID; repeat or comma-separate
  Source processing uses a separate ephemeral client with built-in tools,
  filesystem access, network tools, and session persistence disabled. The main
  companion never receives raw source chunks. Integration requires the exact
  attested proposal and an explicit candidate-ID selection.
  Reject/delete use a separate exact token.

Update source:
  --manifest PATH|HTTPS   Exact incoming manifest (defaults to bundled manifest)
  --source PATH|HTTPS     Source root for files named by the manifest
  --release VERSION       Additional manifest version constraint; never a trust pin
  --manifest-sha256 HASH  Require the exact manifest bytes (mandatory for HTTPS)
`;

function human(result) {
  const lines = [];
  if (result.status) lines.push(`status: ${result.status}`);
  for (const key of ['workspacePath', 'workspaceId', 'version', 'language', 'client', 'clientVersion', 'projectPolicy', 'brokerRequired', 'historyPersistence', 'freshContextRequired', 'hardBoundaryAttested', 'backupPath', 'backupId', 'backupStatus', 'encrypted', 'recoveryKeyPath', 'recoveryKeyCreated', 'backupRecoveryKeyPath', 'displacedWorkspaceBackup', 'displacedWorkspaceRecoveryKeyPath', 'recoveryKeyDeleted', 'secretIncluded', 'sourceId', 'revision', 'sha256', 'byteLength', 'files', 'changes', 'changed', 'changeId', 'revisionId', 'sourceRevisionId', 'changeTarget', 'setting', 'entityId', 'type', 'contextStatus', 'counts', 'total', 'dormantCountOnly', 'entity', 'canonicalEntity', 'mergedEntity', 'proposedEntity', 'candidates', 'approvedIds', 'possibleDuplicates', 'addedCount', 'referenceRewrites', 'dataClass', 'basePolicy', 'previousPolicy', 'cleanupPolicy', 'enforcementMode', 'inspectedAt', 'planTimestamp', 'inventoryAvailable', 'dueCount', 'blockedCount', 'prePolicyCount', 'retainedCount', 'affectedFiles', 'contentIncluded', 'objectIdentifiersIncluded', 'backupCopies', 'backupsRemainSeparateCopies', 'knownBackupRecords', 'backupLedgerAvailable', 'receiptPlanned', 'receiptWritten', 'receiptReason', 'managedArtifactCount', 'deletedArtifactCount', 'resetArtifactCount', 'deletedCategories', 'retainedOperationalCategories', 'retainedSeparateCopies', 'activeWorkspaceUpdated', 'deletionComplete', 'workspaceApplied', 'localPointerWritten', 'restoreApplied', 'artifactDeleted', 'ledgerWritten', 'ledgerReason', 'mutationLockReleased', 'commandCompleted', 'fromRevision', 'toRevision', 'before', 'after', 'expectedHash', 'confirmationRequired', 'recordCount', 'operationReceiptCount', 'offeredCount', 'selectedCount', 'persisted', 'deepDiveWritten', 'operationReceiptWritten', 'errors', 'warnings', 'capabilities', 'nextAction']) {
    if (result[key] !== undefined && result[key] !== null) {
      const value = typeof result[key] === 'object' ? JSON.stringify(result[key]) : result[key];
      lines.push(`${key}: ${value}`);
    }
  }
  if (Array.isArray(result.history)) for (const item of result.history) lines.push(`history: ${JSON.stringify(item)}`);
  if (Array.isArray(result.records)) for (const item of result.records) lines.push(`record: ${JSON.stringify(item)}`);
  if (Array.isArray(result.due)) for (const item of result.due) lines.push(`due: ${JSON.stringify(item)}`);
  if (Array.isArray(result.classes)) for (const item of result.classes) lines.push(`retentionClass: ${JSON.stringify(item)}`);
  if (Array.isArray(result.conflicts) && result.conflicts.length) lines.push(`conflicts: ${result.conflicts.length}`);
  if (Array.isArray(result.findings)) {
    for (const item of result.findings) lines.push(`[${item.severity}] ${item.code}: ${item.message}`);
  }
  return `${lines.join('\n')}\n`;
}

function humanError(error) {
  const lines = [`error [${error.code}]: ${error.message}`];
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  const safeKeys = [
    'status', 'workspaceId', 'artifactDeleted', 'backupCreated', 'backupPath', 'backupId', 'deletedAt', 'activeWorkspaceUpdated',
    'workspaceApplied', 'restoreApplied', 'exportCreated', 'exportPath',
    'ledgerReconciled', 'mutationLockReleased', 'finalizationStep',
    'retainedRollbackPath', 'retainedPrivateStagePath', 'stageInspectionPath', 'cleanupStatus',
    'cleanupErrorCode', 'originalErrorCode', 'nextAction'
  ];
  for (const key of safeKeys) {
    const value = details[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    }
  }
  if (Array.isArray(details.warnings)) {
    const warnings = details.warnings.map((warning) => ({
      code: String(warning?.code || 'UNKNOWN_WARNING'),
      ...(warning?.reason ? { reason: String(warning.reason) } : {}),
      ...(warning?.errorCode ? { errorCode: String(warning.errorCode) } : {})
    }));
    lines.push(`warnings: ${JSON.stringify(warnings)}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.options.version || parsed.command === 'version') {
      process.stdout.write(`${packageJson.version}\n`);
      return;
    }
    if (parsed.options.help || parsed.command === 'help') {
      process.stdout.write(HELP);
      return;
    }
    const commands = {
      install: operations.install,
      update: operations.update,
      doctor: operations.doctor,
      backup: operations.backup,
      restore: operations.restore,
      consent: operations.consent,
      memory: operations.memory,
      transcript: operations.transcript,
      session: operations.session,
      context: operations.contextGraph,
      changes: operations.changes,
      preferences: operations.preferences,
      'review-due': reviewDue
    };
    let command = commands[parsed.command];
    if (parsed.command === 'source') {
      if (parsed.positionals.length !== 1 || !['inspect', 'add', 'status', 'process', 'proposals', 'integrate', 'reject', 'delete'].includes(parsed.positionals[0])) {
        throw new ScalvinError('Usage: scalvin source inspect|add|status|process|proposals|integrate|reject|delete [options]', 'INVALID_ARGUMENT', undefined, 2);
      }
      const action = parsed.positionals[0];
      if (action === 'inspect') {
        if (!parsed.options.path) throw new ScalvinError('source inspect requires --path.', 'INVALID_ARGUMENT', undefined, 2);
        if (parsed.options.target) throw new ScalvinError('source inspect does not accept --workspace.', 'INVALID_ARGUMENT', undefined, 2);
        command = async (options) => inspectSource(options.path);
      } else {
        command = operations.source;
        parsed.options.action = action;
      }
      parsed.positionals = [];
    }
    if (parsed.command === 'session') {
      if (parsed.positionals.length !== 1 || !['begin', 'checkpoint', 'close', 'recover', 'status'].includes(parsed.positionals[0])) {
        throw new ScalvinError('Usage: scalvin session begin|checkpoint|close|recover|status --workspace PATH', 'INVALID_ARGUMENT', undefined, 2);
      }
      parsed.options.action = parsed.positionals[0];
      parsed.positionals = [];
    }
    if (parsed.command === 'context') {
      if (parsed.positionals.length !== 1 || !['status', 'show', 'add', 'correct', 'status-change', 'forget', 'merge', 'backfill'].includes(parsed.positionals[0])) {
        throw new ScalvinError('Usage: scalvin context status|show|add|correct|status-change|forget|merge|backfill --workspace PATH', 'INVALID_ARGUMENT', undefined, 2);
      }
      parsed.options.action = parsed.positionals[0];
      parsed.positionals = [];
    }
    if (parsed.command === 'changes') {
      if (parsed.positionals.length !== 1 || !['propose', 'approve', 'reject', 'history', 'rollback'].includes(parsed.positionals[0])) {
        throw new ScalvinError('Usage: scalvin changes propose|approve|reject|history|rollback --workspace PATH', 'INVALID_ARGUMENT', undefined, 2);
      }
      parsed.options.action = parsed.positionals[0];
      parsed.positionals = [];
    }
    if (parsed.command === 'client') {
      if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'launch') {
        throw new ScalvinError('Usage: scalvin client launch --workspace PATH [--client codex|claude]', 'INVALID_ARGUMENT', undefined, 2);
      }
      if (!parsed.options.target) throw new ScalvinError('client launch requires --workspace.', 'INVALID_ARGUMENT', undefined, 2);
      const { launchSupervisedClient } = require('./session-supervisor');
      command = (options) => launchSupervisedClient({
        workspace: options.target,
        client: options.client,
        clientExecutable: options['client-bin']
      });
      parsed.positionals = [];
    }
    if (!command) throw new ScalvinError(`Unknown command: ${parsed.command}`, 'UNKNOWN_COMMAND', undefined, 2);
    if (parsed.positionals.length) throw new ScalvinError('Unexpected positional arguments.', 'INVALID_ARGUMENT', { positionals: parsed.positionals }, 2);
    const result = await command(parsed.options);
    process.stdout.write(parsed.options.json ? `${JSON.stringify(result)}\n` : human(result));
    if (result.errors > 0) process.exitCode = 1;
  } catch (error) {
    const normalized = error instanceof ScalvinError
      ? error
      : new ScalvinError(error.message || 'Unexpected failure.', 'UNEXPECTED_ERROR');
    const output = { status: 'error', code: normalized.code, message: normalized.message, ...(normalized.details ? { details: normalized.details } : {}) };
    if (parsed?.options?.json || argv.includes('--json')) process.stderr.write(`${JSON.stringify(output)}\n`);
    else process.stderr.write(humanError(normalized));
    process.exitCode = normalized.exitCode || 1;
  }
}

module.exports = { main, HELP, human, humanError };
