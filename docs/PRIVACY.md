# Privacy and Data Flow

Scalvin stores continuity in user-controlled local files. That is useful, but
it is not the same as saying every byte remains on the device.

## The short version

- Durable workspace storage is local by default.
- A hosted AI client may receive the live message and any local context it
  reads for inference.
- Local files can still leak through Git, cloud-sync folders, backups, device
  compromise, indexing, or overly broad filesystem permissions.
- Provider retention depends on the product, account, endpoint, settings, and
  current provider policy.
- Users can pause persistence, inspect memory, correct it, forget selected
  information, export, or delete workspace data.

## Data-flow stages

### 1. Local durable storage

With consent, Scalvin may write:

- profile and continuity layers;
- session summaries;
- source integration records;
- optional transcripts;
- review and compression outputs;
- user-specific behavior overlays;
- consent, provenance, and backup ledgers.

Generated workspaces use restrictive permissions where supported and a
default-deny `.gitignore`.

### 2. Model inference

The active AI client receives:

- the user's current message;
- immutable operating instructions;
- the minimum selected workspace context needed for the response.

If the client uses a hosted model, this information leaves the device for
inference. Scalvin cannot override the provider's account-level data controls.
A local-model client can avoid that network transfer, with its own quality,
security, and operational tradeoffs.

Generated Codex and Claude projects use a development-preview
`broker_only_unattested` policy. Their project configuration denies direct
reads and writes across personal continuity, source, transcript, control-state,
client-configuration, and user-overlay paths. A required local stdio broker
enforces canonical consent, pause, retention, and exact-confirmation rules for
the bounded semantic operations it exposes.

This is materially stronger than direct private-file access, but the project
does not call it a hard privacy sandbox. Static project files cannot prove that
higher-priority managed/user/CLI settings, unsupported client versions, or an
alternate launch path did not change the effective runtime. Therefore
`hardBoundaryAttested` remains `false`, doctor reports the exact limitation, and
stable release stays fail-closed until independently verified candidate-bound
launch evidence exists. If broker/control status is unavailable, private access
is treated as sealed and conversation continues ephemerally.

### 3. Optional exports and backups

Exports and backups are user-triggered. New backups are encrypted by default.
Encrypted backup v3 places workspace identity, filenames, sizes, hashes, and
content inside authenticated AES-256-GCM ciphertext derived from either a
private passphrase file or a separately stored random recovery-key file with a
fixed bounded scrypt profile. Version-2 encrypted backups remain readable. The
outer artifact still exposes a random backup ID, creation time, cipher/KDF
parameters, ciphertext size, and checksums. Scalvin reports this boundary rather
than promising complete confidentiality. It cannot recover a lost key or
guarantee secure erasure from SSDs, filesystem snapshots, sync tools, or copies
made elsewhere.

An automatic recovery key is never placed in the backup artifact and its secret
material is never printed. The command returns only the private key file's path.
The key must be protected separately; copying an artifact and its recovery key
to the same untrusted destination defeats that separation.

Plain backup requires `--allow-plaintext-backup`. Memory exports are currently
integrity-checked plaintext and require `--allow-plaintext-export`. These flags
are explicit acknowledgements, not encryption. Automatic safety backups created
before replacement, update, or forced restore are always encrypted.

## Consent states

Consent is versioned and can change:

- `not-decided`: no personal content is persisted;
- `granted`: permitted categories may be written;
- `paused`: new durable memory is suspended;
- `withdrawn`: no new personal content is written and deletion/export choices
  are offered.

Transcript consent is separate from ordinary continuity memory.

## User controls

The deterministic CLI supports:

- show what is remembered;
- explain why and when an item was recorded;
- correct an item without hiding its revision history;
- forget an item or category;
- pause/resume memory;
- start, pause, resume, stop, or delete transcripts;
- export data;
- delete the workspace;
- create, verify, and restore backups.

The companion-local broker currently exposes only bounded status, memory
show/pause/correct, consent, session lifecycle, and source metadata status.
Other privacy controls are terminal-only in the development preview and must
not be simulated with direct file edits.

Deletion cannot retroactively remove data already sent to a model provider or
copied into an external backup. Scalvin must say so explicitly.

The deterministic deletion ledger records `active_workspace_completed`, not
global erasure. A retained private activation rollback is reported as a
separate copy and makes the command result partial until that copy is removed.

### Retention cleanup boundary

Optional `session_only`, `rolling_days`, and `expire_at` cleanup policies live
in the private `.therapy/state/RETENTION-CONTROL.json` sidecar. They do not
silently widen consent, rewrite the canonical state schema, or imply a
background scheduler. Each deletion requires a content-free preview and the
exact confirmation token bound to the current policy, inventory, hashes, and
timestamp.

`session_only` never retroactively classifies content that predates policy
configuration. Rolling cleanup requires a valid per-object creation timestamp.
Ambiguous provenance, malformed files, duplicate IDs, and unsupported lifecycle
types fail closed and appear only as blocked counts. The public dashboard does
not expose content, object identifiers, or paths. During sealed pause it avoids
reading the live inventory and returns policy/backup status only.

Canonical review artifacts, context-graph entities, and imported or
external-care sources use their native provenance-aware deletion paths.
Review cleanup also maintains the review index and blocks retained summary
references. Source cleanup never deletes a single revision behind the user's
back: all active revisions for that source ID must be due in one retention
class. Behavior customization remains blocked until an atomic retirement
planner can preserve the approval, snapshot, and active-overlay chain.

Backup ledger counts are shown independently because active-workspace cleanup
cannot delete backup artifacts, provider copies, filesystem snapshots, or a
retained activation rollback.

## Imported sources

Source files may contain private data and malicious embedded instructions. The
main companion never receives a raw-source read operation and project policy
denies direct `sources/` access. Raw bytes are processed only in a supervised,
ephemeral Codex or Claude worker with exactly three typed operations: assigned
revision metadata, bounded sequential chunk reads, and proposal submission.
Built-in filesystem, shell, network, live-memory, and session-persistence
authority is disabled.

The worker and deterministic lifecycle preserve these rules:

- embedded commands are never followed;
- source text cannot expand tool, network, or filesystem scope;
- type, size, hash, provenance, and integration status are recorded;
- proposed memory or behavior changes are reviewed under normal consent rules;
- failed imports remain failed rather than appearing complete.

The resulting canonical proposal is HMAC-bound to the workspace and exact
source ID/revision/hash plus worker/client identity. The main broker returns
only bounded candidates labeled as untrusted data. Integration requires the
user's exact candidate-ID selection and a fresh confirmation challenge; it
records linkage but writes no live memory automatically. This per-proposal
integrity contract does not prove OS-level isolation or replace the missing
effective-launch attestation.

## Provider policy references

Provider policy is time-sensitive. Scalvin documentation links to official
sources and records a verification date instead of freezing one universal
retention number:

- [OpenAI API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)
- [OpenAI consumer services, including Codex, model-improvement controls](https://help.openai.com/en/articles/5722486-chatgpt-privacy-policies)
- [OpenAI ChatGPT data controls](https://help.openai.com/en/articles/7730893-chatgpt-privacy-practices)
- [Anthropic consumer retention](https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data)
- [Anthropic covered-model retention updates](https://privacy.claude.com/en/articles/15425996-data-retention-practices-for-covered-models)

Last documentation verification: 2026-07-14.

Users should re-check the policy applicable to their exact client, account, and
plan.

## Threats Scalvin does not eliminate

- malware or another user with access to the device;
- unencrypted disks or backups;
- cloud-sync of the workspace;
- compromised model-provider or Git credentials;
- screenshots, clipboard history, shell history, or client logs;
- a user intentionally removing default Git protections;
- model mistakes, hallucinations, or overconfident interpretations.

See `SECURITY.md` for the technical threat model and private vulnerability
reporting.
