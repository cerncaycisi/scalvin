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
framework needed to operate it. Its logical areas are:

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
    ├── consent and machine state
    └── integrity registry
```

The exact file list is defined by `manifest.json`, not by a second hardcoded
registry.

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

The normal session context is intentionally small:

- rolling next-session primer;
- current focus;
- recent relevant session material;
- selected persona and user overlay;
- minimal current safety/consent state.

Profile, active themes, archive, source files, and historical compression
outputs are opened selectively.

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

Natural-language requests route to these commands; the model does not recreate
their behavior from memory.

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
verifies extracted state before activation. Encryption is an explicit option,
not an implied property of a plain archive.

Encrypted backup v2 keeps the private integrity manifest and payload in one
AES-256-GCM authenticated ciphertext. The public envelope contains only the
artifact ID, timestamp, fixed bounded scrypt parameters, random salt/nonce, and
authentication tag; a separate checksum detects ordinary corruption before
decryption. Decryption and extraction use private sibling stages, exact schemas,
bounded regular-file reads, entry/byte limits, exclusive file creation, and the
same traversal/symlink checks as plain restore. Only a fully verified stage is
made available to the restore transaction.

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
