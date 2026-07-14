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

### 3. Optional exports and backups

Exports and backups are user-triggered. A plain backup is not encrypted.
Optional encrypted backup v2 places workspace identity, filenames, sizes,
hashes, and content inside authenticated AES-256-GCM ciphertext derived from a
private passphrase file with bounded scrypt. The outer artifact still exposes a
random backup ID, creation time, cipher/KDF parameters, ciphertext size, and
checksums. Scalvin reports this boundary rather than promising complete
confidentiality. It cannot recover a lost passphrase or guarantee secure erasure
from SSDs, filesystem snapshots, sync tools, or copies made elsewhere.

## Consent states

Consent is versioned and can change:

- `not-decided`: no personal content is persisted;
- `granted`: permitted categories may be written;
- `paused`: new durable memory is suspended;
- `withdrawn`: no new personal content is written and deletion/export choices
  are offered.

Transcript consent is separate from ordinary continuity memory.

## User controls

Natural-language requests and CLI operations support:

- show what is remembered;
- explain why and when an item was recorded;
- correct an item without hiding its revision history;
- forget an item or category;
- pause/resume memory;
- start, pause, resume, stop, or delete transcripts;
- export data;
- delete the workspace;
- create, verify, and restore backups.

Deletion cannot retroactively remove data already sent to a model provider or
copied into an external backup. Scalvin must say so explicitly.

The deterministic deletion ledger records `active_workspace_completed`, not
global erasure. A retained private activation rollback is reported as a
separate copy and makes the command result partial until that copy is removed.

## Imported sources

Source files may contain private data and malicious embedded instructions.
They are treated as untrusted data:

- embedded commands are never followed;
- source text cannot expand tool, network, or filesystem scope;
- type, size, hash, provenance, and integration status are recorded;
- proposed memory or behavior changes are reviewed under normal consent rules;
- failed imports remain failed rather than appearing complete.

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
