# Getting Started

Scalvin combines a conversational first contact with a deterministic local
workspace. The conversation stays natural; install, update, backup, and
restore do not depend on an AI model improvising shell commands.

## Requirements

- Node.js 20 or newer;
- Git;
- a repo-aware AI client such as Codex or Claude Code, or another client that
  can follow `START-SESSION.md`;
- a local directory where private workspace data may be stored.

Scalvin is designed for adults and for self-reflection/emotional support. It is
not professional care or a crisis service.

## Quick start: conversational

1. Clone and enter the public source repository:

   ```bash
   git clone https://github.com/cerncaycisi/scalvin.git
   cd scalvin
   ```

2. Open the directory in Codex, Claude Code, or another repo-aware client.
3. Say hello in any language. The default language preference is `auto`.

The adapter loads safety and consent rules first. Scalvin briefly explains:

- what it can store locally;
- that a hosted client may send the live message and selected local context to
  its model provider;
- that raw transcripts are separate and off by default;
- how memory can be inspected, corrected, paused, exported, forgotten, or
  deleted.

You may choose local continuity memory on, off, or decide later. Continued
conversation is not treated as consent.

When memory is on, the agent invokes the deterministic installer and then stops
the bootstrap session. Open the generated private workspace as a new client
project so its local policy and connection actually take effect; do not
continue into it from the source-repository session.

## Quick start: explicit CLI

From a checkout:

```bash
node bin/scalvin.js install \
  --workspace "~/scalvin-workspace" \
  --consent "not-decided"
```

The development preview is not published as a global package. Use the retained
checkout's `node bin/scalvin.js` command. Susan, automatic language, the
moderate structure, and the default modalities are already defaults.

After installation:

1. keep the checkout in place;
2. close the current client session;
3. open `~/scalvin-workspace` as a new project;
4. approve the local Scalvin connection if prompted; and
5. begin a fresh session there.

Use `node bin/scalvin.js install --help` for non-interactive, JSON, dry-run,
and selection flags.

The installer:

- resolves `~` before filesystem writes;
- rejects unsafe paths, symlinks, and accidental non-empty targets;
- stages and validates a complete workspace before activation;
- uses restrictive permissions where supported;
- creates a default-deny workspace `.gitignore`;
- records file hashes and active configuration;
- installs supported client hooks without replacing unrelated settings;
- runs post-install validation.

## Verify a workspace

```bash
node bin/scalvin.js doctor --workspace "~/scalvin-workspace"
```

For integrations:

```bash
node bin/scalvin.js doctor --workspace "~/scalvin-workspace" --json
```

Doctor checks structure, schema, framework hashes, active configuration,
consent state, permissions, sensitive Git tracking, hooks, and backup/restore
readiness without printing private content.

## What gets created

The generated workspace has three conceptual layers:

- living continuity (`profile`, themes, focus, primer);
- chronological/imported material (`sessions`, `sources`, `archive`,
  opt-in context entities);
- verified framework and operational state under `.therapy/` and `.scalvin/`.

You do not fill templates manually. With continuity memory on, Scalvin writes
only the categories permitted by current data controls.

## Default behavior

The defaults are:

- companion: Susan;
- persona: Susan;
- structure: moderate;
- active modalities: ACT, CFT, and Motivational Interviewing;
- raw transcripts: off;
- body-focused prompts: ask first;
- between-session experiments: ask first.

Other personas remain available. Higher-risk or advanced modality
work is never activated merely because its reference file exists.

## Everyday controls

The local development-preview connection supports bounded status, memory
inspection/correction/creation, pause/seal, consent, session lifecycle,
prepared-source proposal review/integration, and backup-reminder handling. The
following operations remain terminal-only:

```text
sealed-memory resume; forget/delete/export/review/retention;
transcript controls; context mutations; preferences; backup/restore/update;
behavior changes; source add/process/reject/delete
```

Run `node bin/scalvin.js help` from the retained checkout for exact terminal
forms. Per-import consent alone does not make source text available to the main
companion. Raw bytes are available only to the isolated ephemeral source
worker; its prepared candidates remain untrusted and require exact user
selection.

All terminal examples below run from the retained public checkout.

Stale-memory review never refreshes memories in bulk. `review-due` offers at
most three eligible items, and confirm, decline, suppress, or unsuppress always
selects one exact memory ID. Write pause allows a read-only due check but blocks
review decisions; sealed pause blocks both.

### Retention dashboard and cleanup policies

The canonical consent state keeps its compatibility policies
(`until_deleted` or `do_not_store`). A separate private retention-control file
can add an explicit cleanup schedule without changing that state schema:

```bash
node bin/scalvin.js memory --workspace "~/scalvin-workspace" --action retention-status

node bin/scalvin.js memory --workspace "~/scalvin-workspace" --action retention-set \
  --data-class session_notes --policy rolling_days --days 30

node bin/scalvin.js memory --workspace "~/scalvin-workspace" --action retention-set \
  --data-class raw_transcripts --policy expire_at \
  --expires-at "2026-12-31T23:59:59Z"

node bin/scalvin.js memory --workspace "~/scalvin-workspace" --action retention-set \
  --data-class primers_and_checkpoints --policy session_only
```

`retention-status` returns counts and policy metadata only; it never returns
statements, object IDs, or artifact paths. During sealed pause it reports the
policy and known-backup boundary without reading the live-memory inventory.

Cleanup is not a background job. Run `retention-apply --data-class CLASS` to
receive an exact, snapshot-bound preview token, then rerun with the returned
`--confirm TOKEN`. Missing, duplicated, malformed, or unsupported metadata is
counted as blocked and is never deleted automatically. `session_only` is
prospective: content created before the policy's configuration timestamp is not
silently backfilled into its deletion scope. Use `--policy inherit` to remove a
cleanup override.

Current deterministic deletion support covers stable active-memory blocks,
session notes and deep dives with valid provenance, checkpoints, valid raw
transcripts, canonical weekly/interim reviews, context-graph entities, and
imported/external-care source lifecycles. Review cleanup removes canonical
navigation rows but blocks a review that is still referenced by another review
or summary. Source cleanup is source-wide: every active revision under the
source ID must be due in the same data class, otherwise the whole source is
blocked rather than partially deleted. Context cleanup uses the native graph
planner, rewrites retained entity references once, and records content-free
suppression provenance.

Behavior-customization records are inventoried but remain deterministically
blocked with `behavior_provenance_requires_native_retirement`. Deleting an
approval/snapshot/overlay file independently could change live behavior or
orphan its approval chain; a future native retirement operation must update
that chain atomically before scheduled cleanup can delete these records.

Every dashboard and deletion result shows known backup records separately.
Live-workspace retention never deletes an external backup or retained
activation rollback; rotate those copies independently.

## Session close and deep dives

`session close` is an explicit staged transaction. For a dense session, pass
one bounded regular Markdown body with `--deep-dive-file FILE`. The CLI derives
`archive/<seconds>--<session-uuid>--deep-dive.md`, adds AI-authorship and consent
provenance, links it from the session note, and creates it exclusively without
clobbering an existing artifact. The deep dive uses the `session_notes` consent
and retention gate; a memory pause or disallowed retention writes nothing.

The public CLI applies close artifacts, canonical state, primer changes, and
checkpoint removal in a sibling stage and activates them together. The lower
level lifecycle adapter is retry-safe through byte-identical exclusive writes;
its direct API deliberately leaves already verified artifacts available for an
identical retry if a later adapter step fails.

## Imported sources: isolated processing

The deterministic CLI retains a consent-bound source lifecycle. Susan never
opens raw imported documents. To process one ready source revision, launch the
separate ephemeral worker from the retained checkout:

```bash
node bin/scalvin.js source process \
  --workspace "~/scalvin-workspace" \
  --source-id "<src-uuid>" \
  --client codex

node bin/scalvin.js source proposals \
  --workspace "~/scalvin-workspace" \
  --source-id "<src-uuid>"
```

The worker receives only three typed operations: metadata for the assigned
revision, bounded sequential chunk reads, and proposal submission. It receives
no normal filesystem, shell, network, live-memory, or session-persistence
authority. Its stdout/stderr is suppressed from the companion and the accepted
proposal is bound to the exact source ID, revision, hash, worker version, and
client version.

Integrate only explicitly selected proposal IDs. The first call returns an
exact confirmation token; rerun the same selection with that token:

```bash
node bin/scalvin.js source integrate \
  --workspace "~/scalvin-workspace" \
  --source-id "<src-uuid>" \
  --proposed-memory-id "<candidate-id>"
```

Integration records the approved proposal linkage and writes no live memory.
Saving a candidate as active profile/theme/focus memory requires a separate
live confirmation through the broker. Direct source-file access is never an
acceptable workaround.

## Controlled behavior changes

Durable behavior customization is a proposal-and-approval flow. It is available
only while behavior-customization consent and durable retention are on. A
proposal cannot weaken safety, consent, privacy, retention, provenance, or
source-trust rules.

Create a proposal with bounded, single-line evidence and tradeoff fields:

```bash
node bin/scalvin.js changes propose \
  --workspace "~/scalvin-workspace" \
  --change-target session-style \
  --setting response_load \
  --value concise \
  --evidence-status user_requested \
  --why-file "<private-single-line-reason-file>" \
  --expected-effect-file "<private-single-line-effect-file>" \
  --risks-file "<private-single-line-tradeoff-file>"
```

Approval always starts with a read-only exact diff:

```bash
node bin/scalvin.js changes approve \
  --workspace "~/scalvin-workspace" \
  --change-id "chg-<uuid-v4>"
```

Review `before`, `after`, and `confirmationRequired`, then rerun the same
command with `--confirm "<exact-token>"`. The CLI never supplies that token for
you. `changes rollback --revision-id "rev-<uuid-v4>"` follows the same preview
and exact-confirmation flow. `changes history` returns metadata only; rejection
uses `changes reject --change-id "chg-<uuid-v4>"`.

## Backup and restore

Create a unique integrity-checked backup:

```bash
node bin/scalvin.js backup --workspace "~/scalvin-workspace" --output "<backup-directory>"
```

Backup creation is encrypted by default. If `--passphrase-file` is omitted,
Scalvin creates a random 256-bit recovery-key file in a separate private sibling
store and returns only its path, never the key material. Move or copy that key to
a separately protected recovery location and test a restore before relying on
the backup. A backup cannot be recovered when its key is lost.

To create a portable recovery key before the backup:

```bash
node bin/scalvin.js backup --action key-create --output "<private-recovery-key-file>"
node bin/scalvin.js backup \
  --workspace "~/scalvin-workspace" \
  --output "<backup-directory>" \
  --passphrase-file "<private-recovery-key-file>"
```

The key command uses operating-system randomness, creates a no-clobber private
file, and prints metadata only. On Unix the file is exactly `0600`; on Windows
Scalvin creates and verifies a protected ACL.

The result includes a stable `backup-<uuid-v4>` ID. Status and verification do
not expose the artifact path or workspace content:

```bash
node bin/scalvin.js backup --workspace "~/scalvin-workspace" --action status
node bin/scalvin.js backup --workspace "~/scalvin-workspace" --action verify --id "backup-<uuid-v4>"
```

Deleting a backup first returns an authenticated preview and exact confirmation
token. Only a second call with that token deletes the artifact:

```bash
node bin/scalvin.js backup --workspace "~/scalvin-workspace" --action delete --id "backup-<uuid-v4>"
node bin/scalvin.js backup --workspace "~/scalvin-workspace" --action delete --id "backup-<uuid-v4>" --confirm "<exact-token>"
```

For a user-selected non-default backup directory, verification and deletion
also require the exact `--backup` artifact path.

Preview a restore:

```bash
node bin/scalvin.js restore \
  --backup "<backup-directory>/<backup-name>" \
  --workspace "~/scalvin-workspace" \
  --dry-run
```

Then omit `--dry-run` after reviewing the plan. A supplied passphrase or
recovery-key file must stay outside the workspace. Do not put its contents in
shell history, an environment variable, logs, or the same artifact directory.
On Unix set a user-created file to exactly `0600`; on Windows Scalvin requires a
protected ACL it can verify. Then run:

```bash
node bin/scalvin.js backup \
  --workspace "~/scalvin-workspace" \
  --output "<backup-directory>" \
  --passphrase-file "<private-passphrase-file>"

node bin/scalvin.js restore \
  --backup "<backup-directory>/<backup-name>" \
  --workspace "~/scalvin-workspace-restored" \
  --passphrase-file "<private-passphrase-file>" \
  --dry-run
```

Passphrases must contain 12 to 4096 bytes. One final newline is ignored. The
secret itself is never accepted through command arguments, environment
variables, output, or the backup ledger. In this custom-passphrase mode Scalvin
does not generate an additional recovery-key file: test a restore and preserve
the passphrase separately.

Encrypted format v3 uses AES-256-GCM with a fresh random salt and nonce plus the
fixed scrypt profile `N=2^17, r=8, p=1`. Version-2 encrypted artifacts remain
readable with their original bounded profile; new artifacts use v3. Workspace
ID, filenames, file sizes, hashes, and contents are inside the authenticated
ciphertext. The artifact name and outer envelope still reveal creation time, a
random backup ID, cipher/KDF parameters, ciphertext size, and checksums. Current
hard limits are 100,000 entries, 8 GiB per file, 16 GiB per archive, and a 16 MiB
private manifest. Wrong passphrases, modified/truncated payloads, unknown or
resource-escalated KDF parameters, symlinks, special files, and over-limit input
fail closed. Decryption uses a private sibling stage that is removed on success
or failure; filesystem snapshots, SSD behavior, and external backup tools can
still retain old blocks.

Plaintext backup remains available only as an explicit compatibility choice:

```bash
node bin/scalvin.js backup \
  --workspace "~/scalvin-workspace" \
  --output "<private-local-directory>" \
  --allow-plaintext-backup
```

This flag confirms that confidentiality is not provided. Restrictive file
permissions and integrity hashes do not encrypt the payload.

Install replacement, update, and forced restore also create encrypted safety
backups before mutation. Pass `--backup-passphrase-file` to protect one with an
existing private key file. Otherwise Scalvin generates a separate recovery-key
file and returns its path as `backupRecoveryKeyPath` or
`displacedWorkspaceRecoveryKeyPath`. `--recovery-key-output` selects a private
directory for generated key files; it must not overlap the workspace or backup
artifact tree.

Memory exports are currently integrity-checked plaintext directories. They are
created only when the caller explicitly adds `--allow-plaintext-export`; use a
private local destination and secure or remove the export after use.

## Updating

Updates require a cryptographic pin. `--release` is only an additional version
constraint and never authenticates manifest bytes. Any alternate or remote
manifest requires its exact SHA-256. Signed-tag or commit identity is external
release provenance; the manifest does not make a recursive claim about the Git
commit that contains it:

```bash
node bin/scalvin.js update \
  --workspace "~/scalvin-workspace" \
  --manifest "<trusted-checkout>/manifest.json" \
  --manifest-sha256 "<exact-manifest-sha256>" \
  --release "<expected-version>" \
  --dry-run
```

Review the dry-run before applying. Update verifies the incoming manifest and
file hashes, protects user data, detects local framework customization,
snapshots every target it will modify, and rolls back on failure. Mutable raw
`main` is not an update trust root.

## Concurrent access and recovery locks

Keep the workspace quiescent while any Scalvin command is writing, backing up,
exporting, or restoring it. Do not edit it from another program, host, or
network-filesystem client during that operation. Local Scalvin commands share
one private target-sibling lock and compare exact workspace snapshots, but no
portable rename transaction can make a non-cooperating process with an already
open file descriptor atomic.

If a command reports `MUTATION_LOCKED`, do not remove the lock merely because
it is old or its recorded PID is not running. First confirm that no Scalvin
operation is active, inspect the finding from the retained checkout with
`node bin/scalvin.js doctor --workspace "<workspace>" --json`, and only then
follow the exact manual-recovery guidance.
Scalvin never steals or auto-deletes an existing lock. A
`PRIVATE_ROLLBACK_RETAINED` warning similarly means a private pre-activation
copy still exists; follow the returned `nextAction` instead of assuming the old
copy was deleted.

## No double-click launchers

Scalvin no longer creates absolute-path `.command` or `.bat` launchers by
default. Open the workspace in the chosen client. This avoids stale paths,
escaping bugs, and client-specific assumptions.

## Next reading

- [Architecture](ARCHITECTURE.md)
- [Privacy and data flow](PRIVACY.md)
- [Client adapters](CLIENTS.md)
- [Scope and evidence boundary](SCOPE-AND-EVIDENCE.md)
- [Security](../SECURITY.md)
