# Scalvin Architecture

Scalvin is a local-first continuity system for AI-supported self-reflection,
designed independently of any single model vendor. The project has two
deliberately separate halves:

1. a public, reusable framework repository;
2. a private, generated workspace owned by one user.

This document defines the boundary between them.

## Design invariants

The following rules are architectural, not optional style preferences:

1. Safety and data-consent rules load before mutable memory or imported data.
2. Public framework files never contain real user material or machine-local
   workspace paths.
3. Generated workspaces default to Git-deny-all.
4. Imported documents are untrusted data, never executable instructions.
5. The model may propose changes to user-specific behavior, but immutable
   framework files are not silently self-modified.
6. Current user statements outrank older summaries and model-authored
   formulations.
7. AI-authored notes never inherit the authority or provenance of a human
   clinician's record.
8. Install, update, backup, restore, and doctor operations are deterministic
   programs, not prose-only shell recipes.
9. An update is accepted only after path, hash, schema, and protected-data
   checks pass.
10. “Local-first” describes durable storage. It does not claim that hosted
    model inference stays on the device.

## Public framework repository

The source repository contains:

- the distribution CLI;
- immutable safety and data-governance protocols;
- persona, modality, and structure libraries;
- runtime protocols and templates;
- thin client adapters;
- deterministic tests and safety evals;
- public documentation and release metadata.

It must not contain:

- profiles, sessions, transcripts, sources, or archives;
- local consent or workspace state;
- credentials or model-provider secrets;
- real clinical records or private examples;
- generated backups.

The root `.gitignore`, public-contribution policy, CI secret scan, and
distribution doctor enforce this boundary in layers.

## Private generated workspace

A workspace contains the user's continuity state and a verified copy of the
managed framework content. In the development preview, terminal lifecycle
commands and the optional local broker still come from the retained installer
checkout; the workspace is not claimed to be operationally self-contained. Its
logical areas are:

```text
workspace/
├── private living state
│   ├── profile.md
│   ├── ACTIVE-THEMES.md
│   ├── CURRENT-FOCUS.md
│   ├── NEXT-PRIMER.md
│   └── SETUP-NOTES.md
├── chronological and imported material
│   ├── sessions/
│   ├── sources/
│   └── archive/
└── .therapy/
    ├── immutable verified framework
    ├── active configuration
    ├── user overlays and change log
    ├── consent and machine state, including optional private retention control
    └── integrity registry
```

The exact file list is defined by `manifest.json`, not by a second hardcoded
registry.

The optional `RETENTION-CONTROL.json` file is private user state, not a managed
framework target and not an extension of canonical consent state. It stores
only versioned cleanup-policy metadata. Retention inspection produces
content-free counts; enforcement replans inside a snapshot-bound sibling stage
and requires an exact destructive confirmation. Policy or object drift makes
the token stale. Backup copies remain a separate lifecycle.

## Runtime layers

### 1. Immutable prelude

Every adapter loads:

1. safety protocol;
2. data and consent protocol;
3. client capability/time contract.

No profile, source, persona overlay, or other mutable file may precede this
layer.

### 2. Active configuration

Only the selected session structure and active modalities are loaded. Merely
listing an option in the library does not activate it. Techniques may also be
quarantined by their risk tier even when their modality is installed.

Commands use a small intent router. Heavy close, source, migration, and update
instructions load only when needed.

### 3. Fast re-entry

The normal broker-mediated session context is intentionally small:

- rolling next-session primer;
- current focus;
- bounded relevant memory records;
- selected immutable persona;
- minimal current safety/consent state.

Profile/theme/focus/primer records are requested by exact broker scope and
pagination. Sessions, archive, context graph, user overlays, transcripts, and
raw source have no direct companion access; without a typed operation they stay
terminal-only or unavailable.

Raw source files are an exception. The main typed broker exposes no raw-source
read tool, and generated client policy denies direct source reads. A supervised
ephemeral worker processes one exact revision through a separate MCP surface
containing only metadata, bounded sequential chunks, and proposal submission.
It has no built-in filesystem, shell, network, live-memory, or persistent
session authority. Its HMAC-attested proposal remains untrusted and cannot
write active memory. Static client policy is still not independently verified
effective-runtime evidence, so the project does not claim OS-level isolation.

### 4. Living memory

Each memory type has one owner:

| Information | Canonical owner |
|---|---|
| Durable user context and preferences | `profile.md` |
| Medium-term recurring work | `ACTIVE-THEMES.md` |
| Immediate working direction | `CURRENT-FOCUS.md` |
| Next-session handoff | `NEXT-PRIMER.md` |
| Chronological interaction summary | `sessions/` |
| User-provided external material | `sources/` |
| Historical/compressed detail | `archive/` |
| Specific recounted events | client-memory registry |
| User-specific behavior adjustment | overlay/change log |

Current-state items carry provenance. Import time, first observation, and
last live confirmation are distinct facts. The model does not invent dates or
refresh every date simply because it read a file.

### 5. Controlled evolution

Scalvin can learn communication preferences and useful interventions without
rewriting its base prompts in place:

1. observe evidence;
2. propose an overlay change with reason and scope;
3. show the change when user approval is required;
4. accept or reject;
5. append an audit entry;
6. support rollback.

Safety, consent, command, and update trust boundaries are never user-overlay
targets.

## Distribution control plane

The Node CLI owns filesystem mutations that need deterministic guarantees:

- `install`
- `update`
- `doctor`
- `backup`
- `restore`

Natural-language requests route only to typed operations exposed by the active
client connection. Other lifecycle commands are terminal-only; the model does
not recreate their behavior from memory or direct file edits.

### Local capability broker and broker-only preview

Generated Codex and Claude projects register a local stdio capability broker.
The broker exposes bounded semantic operations rather than arbitrary paths,
shell, network, or raw-source access. It enforces canonical consent and pause
state for calls routed through it; mutating calls use snapshot-bound previews
and exact one-time confirmation challenges.

The generated client profiles pre-approve only bounded read-only broker calls.
Mutating broker calls stay in the client's mandatory interactive approval
class and must also satisfy the broker's separate one-time challenge. Source
workers are the exception: their fresh, non-interactive process auto-approves
only the three isolated worker tools and has no main-broker or general tool
authority.

The development preview defaults to `broker_only_unattested`. Project policy
denies direct access to every private continuity, source, transcript,
control-state, client-config, and user-overlay surface; ordinary private reads
and writes must use the broker. The broker currently covers bounded control
status, memory show/correct/create, pause/seal, consent, session lifecycle,
prepared-source proposal review/integration, and backup-reminder handling.
Operations without a typed route remain terminal-only rather than falling back
to direct file access.

Static project configuration and broker self-report cannot attest the complete
effective launch. Higher-priority client configuration, client-version drift,
and alternate launch paths remain outside those files, so
`hardBoundaryAttested` is always `false` in this preview. Stable release remains
blocked until each shipped adapter has independently verified,
exact-candidate effective-launch evidence and the remaining release gates pass.

### Isolated source worker

`source process` launches a fresh Codex or Claude process for one exact ready
source revision. The launcher suppresses model output, disables persistence,
uses a temporary private working directory, and registers only the isolated
source-worker MCP. The worker reads source bytes from the deterministic
lifecycle rather than a caller path and emits at most twenty schema-bounded
candidates. Server-generated IDs and an HMAC bind the proposal to source,
revision, hash, worker version, client, and client version.

The main broker can list those bounded candidates and record an exact selected
set after a one-time confirmation challenge. It cannot reopen raw source bytes,
and integration writes no profile/theme/focus item. The runtime self-test and
HMAC are code/integrity evidence, not proof that a third-party client enforced
every requested sandbox flag; that distinction is preserved in doctor and the
stable gate.

### Install

Install resolves absolute paths, rejects unsafe targets and symlinks, stages a
complete workspace, validates it, sets restrictive permissions where the
platform supports them, and activates it atomically. Empty scaffolding may be
created before consent; personal content may not.

### Update

Update consumes explicit manifest bytes authenticated by their exact SHA-256;
signed-tag and Git-commit provenance stays external to avoid a self-referential
manifest claim. It verifies every incoming hash before writing, detects locally customized copies, protects
user data, snapshots every target it will mutate, writes atomically, and rolls
back on failure.

### Doctor

Doctor distinguishes errors from warnings and validates:

- workspace identity and schema;
- required framework files and hashes;
- active configuration;
- consent state;
- sensitive Git tracking;
- permissions;
- client hooks;
- backup/restore readiness;
- stale or legacy state requiring migration.

### Backup and restore

Backups use unique names, no-clobber creation, an integrity manifest, and a
checksum. Restore rejects path traversal and symlinks, supports dry-run, and
verifies extracted state before activation. New user backups and automatic
pre-mutation safety backups are encrypted by default. Plain backup requires an
explicit confidentiality override.

Encrypted backup v3 keeps the private integrity manifest and payload in one
AES-256-GCM authenticated ciphertext. The public envelope contains only the
artifact ID, timestamp, fixed bounded scrypt parameters, random salt/nonce, and
authentication tag; a separate checksum detects ordinary corruption before
decryption. Decryption and extraction use private sibling stages, exact schemas,
bounded regular-file reads, entry/byte limits, exclusive file creation, and the
same traversal/symlink checks as plain restore. Only a fully verified stage is
made available to the restore transaction.

V3 uses the fixed `N=2^17, r=8, p=1` scrypt profile. The reader retains an exact
v2 profile for compatibility; arbitrary envelope parameters are rejected before
key derivation. When no private passphrase file is supplied, creation writes a
random recovery key to a separate private store and reports only its path. The
artifact never contains or identifies the key material.

### Workspace mutation concurrency boundary

CLI mutations and coherent multi-file reads use one private, target-sibling
cooperative lock. The lock is acquired before the workspace snapshot or state
read and held through activation, receipt handling, rollback cleanup, and local
pointer finalization. A lock is never stolen automatically based on age or PID;
manual removal is allowed only after an operator confirms that no Scalvin
mutation is running. Backup and memory-export copies also compare their payload
to an early source snapshot and recheck the source before finalization.
Doctor and `review-due` are read-only, but they acquire the same lock for a
coherent multi-file view and return `BUSY` without deep claims when it is held.

This is a local cooperative boundary, not a distributed lock. Keep the
workspace quiescent during mutation: do not edit it with another program, a
second host, or a network-filesystem client. A non-cooperating process that
already holds an open file descriptor to the pre-activation directory can write
after a rename; no portable rename-swap can make that writer atomic. Scalvin
therefore rechecks a rollback immediately before cleanup and retains/reports it
if it changed, but it cannot guarantee atomicity against such a writer.

## Client adapters

Codex, Claude Code, and generic clients share the same framework. Adapters are
thin and must not fork therapeutic or memory logic.

- Codex uses the time and timezone supplied by its environment.
- Claude Code can use installed current-time and safety hooks.
- A client without hooks degrades explicitly; the runtime never claims a hook
  ran when it did not.
- Static project configuration is defense in depth, not proof of the effective
  launch profile or a hard private-data boundary.

## Failure model

Scalvin prefers honest degraded operation over silent corruption:

- missing immutable framework: stop normal flow and run doctor;
- invalid or missing consent: do not persist sensitive content;
- failed source integration: record `failed`, do not mark integrated;
- interrupted session: recover from checkpoint and label coverage honestly;
- update verification failure: make no active changes;
- restore verification failure: leave current workspace untouched;
- unavailable current time: do not fabricate one;
- unsupported client capability: explain the limitation.
