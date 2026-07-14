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

When memory is on, the agent invokes the deterministic installer and hands off
to the private workspace. Filesystem commands stay in the background, but the
data choice does not.

## Quick start: explicit CLI

From a checkout:

```bash
node bin/scalvin.js install \
  --workspace "~/scalvin-workspace" \
  --companion-name "Scalvin" \
  --language "auto" \
  --persona "scalvin" \
  --structure "moderate" \
  --modality "act" \
  --modality "cft" \
  --modality "motivational-interviewing" \
  --consent "not-decided"
```

If the `scalvin` package/binary is installed, the equivalent is:

```bash
scalvin install --workspace "~/scalvin-workspace" --consent not-decided
```

Use `scalvin install --help` for non-interactive, JSON, dry-run, and selection
flags.

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
scalvin doctor --workspace "~/scalvin-workspace"
```

For integrations:

```bash
scalvin doctor --workspace "~/scalvin-workspace" --json
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

The neutral defaults are:

- companion: Scalvin;
- persona: Scalvin;
- structure: moderate;
- active modalities: ACT, CFT, and Motivational Interviewing;
- raw transcripts: off;
- body-focused prompts: ask first;
- between-session experiments: ask first.

Susan and other personas remain available. Higher-risk or advanced modality
work is never activated merely because its reference file exists.

## Everyday controls

Natural language works; slash forms make the scope explicit:

```text
/memory status
/memory show
/memory pause
/memory resume
/memory correct <item>
/memory forget <item-or-category>
/memory review-due
/memory review-confirm <item>
/memory review-decline <item>
/transcript status
/transcript start
/transcript pause
/transcript resume
/transcript stop
/transcript delete <session-or-all>
/data export <active|continuity|all>
/data delete all
/close
```

Imported sources and external-care records require a separate per-import
choice. Source text is treated as untrusted data, not instructions.

Stale-memory review never refreshes memories in bulk. `review-due` offers at
most three eligible items, and confirm, decline, suppress, or unsuppress always
selects one exact memory ID. Write pause allows a read-only due check but blocks
review decisions; sealed pause blocks both.

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

## Source lifecycle

Inspecting a source is read-only and reports only a hash, byte count, and fixed
untrusted-data policy:

```bash
scalvin source inspect --path "<one-regular-file>"
```

After imported-source consent is on (or an explicit per-import decision is
available), add the exact file to the private workspace:

```bash
scalvin source add \
  --workspace "~/scalvin-workspace" \
  --path "<one-regular-file>" \
  --kind imported_source \
  --locale "<BCP-47-tag>"
```

The result contains a stable source ID, revision, and SHA-256, never the source
text or its absolute path. Source language is metadata only and never grants
authority. Check content-free lifecycle metadata with `source status`.

Integration is a second explicit step. The first call returns the exact
revision hash plus a plan token bound to the revision, consent proof, proposed
memory IDs, and planned writes. The second confirms that plan token:

```bash
scalvin source integrate --workspace "~/scalvin-workspace" --source-id "src-<uuid-v4>"
scalvin source integrate --workspace "~/scalvin-workspace" --source-id "src-<uuid-v4>" --confirm "<exact-plan-token>"
```

Integration can propose derived memory IDs but never writes active memory by
itself. `source reject` and `source delete` also use a preview followed by an
exact confirmation token. Deletion removes managed source bytes, provenance,
eligible derived references, and the canonical active record; known backups
remain separate copies that require their own rotation decision.

## Controlled behavior changes

Durable behavior customization is a proposal-and-approval flow. It is available
only while behavior-customization consent and durable retention are on. A
proposal cannot weaken safety, consent, privacy, retention, provenance, or
source-trust rules.

Create a proposal with bounded, single-line evidence and tradeoff fields:

```bash
scalvin changes propose \
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
scalvin changes approve \
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
scalvin backup --workspace "~/scalvin-workspace" --output "<backup-directory>"
```

The result includes a stable `backup-<uuid-v4>` ID. Status and verification do
not expose the artifact path or workspace content:

```bash
scalvin backup --workspace "~/scalvin-workspace" --action status
scalvin backup --workspace "~/scalvin-workspace" --action verify --id "backup-<uuid-v4>"
```

Deleting a backup first returns an authenticated preview and exact confirmation
token. Only a second call with that token deletes the artifact:

```bash
scalvin backup --workspace "~/scalvin-workspace" --action delete --id "backup-<uuid-v4>"
scalvin backup --workspace "~/scalvin-workspace" --action delete --id "backup-<uuid-v4>" --confirm "<exact-token>"
```

For a user-selected non-default backup directory, verification and deletion
also require the exact `--backup` artifact path.

Preview a restore:

```bash
scalvin restore \
  --backup "<backup-directory>/<backup-name>" \
  --workspace "~/scalvin-workspace" \
  --dry-run
```

Then omit `--dry-run` after reviewing the plan. Plain backups are not
encrypted. To encrypt the full private payload, create a passphrase file using
a trusted editor or password-manager export without putting the secret in shell
history. Keep it outside the workspace. On Unix set its mode to exactly `0600`;
on Windows Scalvin requires a protected ACL it can verify. Then run:

```bash
scalvin backup \
  --workspace "~/scalvin-workspace" \
  --output "<backup-directory>" \
  --encrypt \
  --passphrase-file "<private-passphrase-file>"

scalvin restore \
  --backup "<backup-directory>/<backup-name>" \
  --workspace "~/scalvin-workspace-restored" \
  --passphrase-file "<private-passphrase-file>" \
  --dry-run
```

Passphrases must contain 12 to 4096 bytes. One final newline is ignored. The
secret itself is never accepted through command arguments, environment
variables, output, or the backup ledger. There is no recovery key: test a
restore and preserve the passphrase separately.

Encrypted format v2 uses AES-256-GCM with a fresh random salt and nonce plus
fixed, bounded scrypt parameters. Workspace ID, filenames, file sizes, hashes,
and contents are inside the authenticated ciphertext. The artifact name and
outer envelope still reveal creation time, a random backup ID, cipher/KDF
parameters, ciphertext size, and checksums. Current hard limits are 100,000
entries, 8 GiB per file, 16 GiB per archive, and a 16 MiB private manifest.
Wrong passphrases, modified/truncated payloads, unsupported KDF parameters,
symlinks, special files, and over-limit input fail closed. Decryption uses a
private sibling stage that is removed on success or failure; filesystem
snapshots, SSD behavior, and external backup tools can still retain old blocks.

## Updating

Updates require a cryptographic pin. `--release` is only an additional version
constraint and never authenticates manifest bytes. Any alternate or remote
manifest requires its exact SHA-256. Signed-tag or commit identity is external
release provenance; the manifest does not make a recursive claim about the Git
commit that contains it:

```bash
scalvin update \
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
operation is active, inspect the finding with `scalvin doctor --workspace
"<workspace>" --json`, and only then follow the exact manual-recovery guidance.
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
