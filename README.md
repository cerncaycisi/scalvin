# Scalvin

[![CI](https://github.com/cerncaycisi/scalvin/actions/workflows/ci.yml/badge.svg)](https://github.com/cerncaycisi/scalvin/actions/workflows/ci.yml)
[![Security](https://img.shields.io/badge/security-private%20reporting-blue)](https://github.com/cerncaycisi/scalvin/security/advisories/new)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Scalvin is a local-first AI companion framework for self-reflection,
conversation continuity, and user-controlled memory.

> **Development status:** the current `1.0.0` line is an unreleased development
> preview. Independent safety review and release-candidate behavior evaluation
> are not complete; this is not clinical validation.

It combines a natural conversational experience with a deterministic
installer, explicit data consent, multi-client adapters, layered memory,
source isolation, safety evals, and verifiable backup/update tooling.

Scalvin is not a therapist, clinician, medical device, crisis service, or
substitute for professional care. The supported public project is designed for
adults.

## What makes Scalvin different

Scalvin's architecture is built around:

- separate public framework and private user workspace;
- Codex, Claude Code, and generic client adapters;
- safety and consent loaded before mutable memory;
- profile, themes, current focus, primer, sessions, sources, context, and
  archive with clear ownership;
- item-level provenance and stale-memory review;
- controlled user overlays instead of silent base-prompt self-modification;
- deterministic install, update, doctor, backup, and restore;
- locale-pack mechanical safety backstop with precision/over-fire tests;
- source prompt-injection boundaries;
- explicit inspect, correct, pause, forget, export, transcript, and delete
  controls.

## Data-flow truth

```mermaid
flowchart LR
    A["Public Scalvin framework"] --> B["Verified installer / updater"]
    B --> C["Private local workspace"]
    C --> D["Selected minimum context"]
    U["User consent and controls"] --> C
    U --> D
    D --> E["AI client"]
    E --> F["Local model or hosted provider"]
```

Durable workspace storage is local by default. If the AI client uses a hosted
model, the live message and selected local context may be sent to that
provider. Scalvin does not override provider policy and does not describe
hosted inference as on-device.

Read [Privacy and Data Flow](docs/PRIVACY.md) before using Scalvin with
sensitive material.

## Quick start

Requirements: Git and Node.js 20 or newer.

```bash
git clone https://github.com/cerncaycisi/scalvin.git
cd scalvin
```

Open the folder in Codex, Claude Code, or another repo-aware agent and say
hello in any language. The default language preference is `auto`.

Scalvin first explains:

- what local continuity memory stores;
- what a hosted model provider may receive;
- how to inspect, correct, pause, export, forget, or delete data;
- that raw transcripts are a separate opt-in and off by default.

You may continue without saved memory.

For an explicit CLI install:

```bash
node bin/scalvin.js install \
  --workspace "~/scalvin-workspace" \
  --consent not-decided
```

Then verify:

```bash
node bin/scalvin.js doctor \
  --workspace "~/scalvin-workspace"
```

See [Getting Started](docs/GETTING-STARTED.md) for selections, JSON mode,
dry-runs, backups, restores, and updates.

## Neutral defaults

- companion: Scalvin;
- persona: Scalvin;
- structure: moderate;
- active modalities: ACT, CFT, Motivational Interviewing;
- transcripts: off;
- body prompts: ask first;
- between-session experiments: ask first.

Susan and the rest of the persona library remain optional. Advanced modality
references are installed as library material but are not automatically active.
Risk-tier and consent rules still apply after selection.

## User controls

Scalvin recognizes natural language and explicit forms:

```text
/memory status
/memory show
/memory pause
/memory resume
/memory correct <item>
/memory forget <item-or-category>
/memory review-due|review-confirm|review-decline <item>
/transcript start|status|pause|resume|stop
/transcript delete <session-or-all>
/data export <active|continuity|all>
/data delete all
/source add|status|integrate|reject|delete
/close
```

Memory and transcript consent are separate. Imported sources and external-care
records use per-import consent. A paused interval is not silently backfilled.

## Layered continuity

| Layer | Purpose |
|---|---|
| Profile | Lean durable context and user-confirmed preferences |
| Active themes | Medium-term recurring work |
| Current focus | Immediate working direction |
| Next primer | Short handoff to the next session |
| Sessions | Chronological summaries with provenance |
| Sources | User-provided untrusted documents and integration records |
| Context graph | Opt-in people, places, and events with lifecycle state |
| Archive | Historical/compressed material, opened selectively |
| Overlays | Approved user-specific behavior adjustments with rollback |

Current user statements outrank older model-authored summaries. Import time is
not treated as live confirmation. Users can inspect and correct what the
runtime relies on.

## Personas, structures, and modalities

The libraries provide conversation styles and reflection tools, not clinical
treatment.

- Personas control voice, length, challenge, and presence without fabricated
  human identity.
- Structures range from freeform to structured, while safety, consent, and
  accessibility always take precedence.
- Modalities provide questions and low-risk exercises informed by named
  traditions. Higher-intensity techniques are quarantined or limited to
  psychoeducation/clinician-guided use.

See [Scope and Evidence Boundary](docs/SCOPE-AND-EVIDENCE.md). Independent
clinical and safety review has not been completed; the requirements are
documented in the [Clinical and Safety Review Gate](docs/CLINICAL-SAFETY-REVIEW.md).

## Safety

Scalvin uses two layers:

1. an immutable prose safety protocol;
2. a bounded, locale-pack-driven mechanical hook for supported clients.

The hook scans all installed, validated locale packs; it does not define the
set of languages Scalvin can converse in. It is defense in depth, not complete
detection. CI tracks must-fire, silent-expected, known-boundary, and over-fire
cases per bundled pack. The runtime distinguishes
imminent self-harm, harm to others, abuse/safeguarding, possible
psychosis/medical emergency, and lower-immediacy distress.

Scalvin cannot call emergency services, locate or monitor a user, or guarantee
confidentiality. Current location-aware guidance lives in
[the safety protocol](safety-protocol.md).

## Deterministic lifecycle

```bash
scalvin install --help
scalvin doctor --workspace "<workspace>"
scalvin backup --workspace "<workspace>" --output "<directory>"
scalvin restore --backup "<backup>" --workspace "<workspace>" --dry-run
scalvin changes history --workspace "<workspace>"
scalvin update --workspace "<workspace>" --manifest-sha256 "<exact-manifest-sha256>" --dry-run
scalvin review-due --workspace "<workspace>" --json
```

Lifecycle commands support previews, verify managed files, preserve user data
and local customizations, and roll back failed mutations. Destructive changes
require the exact confirmation returned by a fresh preview.

Backups are integrity-checked and may be encrypted:

```bash
scalvin backup --workspace "<workspace>" --output "<directory>" \
  --encrypt --passphrase-file "<private-passphrase-file>"
scalvin restore --backup "<backup>" --workspace "<workspace>" \
  --passphrase-file "<private-passphrase-file>" --dry-run
```

The passphrase is read from a private file, never from a command argument or
environment value. Losing it makes the backup unrecoverable. See
[Getting Started](docs/GETTING-STARTED.md#backup-and-restore) for update,
backup, restore, and recovery details.

## Development

```bash
npm run check
npm test
```

`npm test` includes the evaluator suite. Use `npm run test:evals` only for a
focused evaluator run while developing those rules.

The test suite covers CLI transactions, path/symlink attacks, manifest hashes,
customized-file preservation, legacy migration, backup/restore, safety
precision/recall boundaries, public-repo hygiene, and documentation links.

Contributors must use synthetic data. Never commit a real profile, session,
transcript, source, local path, or credential. See [Contributing](CONTRIBUTING.md)
and [Security](SECURITY.md).

## Documentation

### Using Scalvin

- [Getting Started](docs/GETTING-STARTED.md)
- [Privacy and Data Flow](docs/PRIVACY.md)
- [Client Adapters](docs/CLIENTS.md)
- [Scope and Evidence Boundary](docs/SCOPE-AND-EVIDENCE.md)
- [Localization](docs/LOCALIZATION.md)
- [Accessibility](docs/ACCESSIBILITY.md)
- [Migration](MIGRATING.md)
- [Support](SUPPORT.md)

### Contributors and maintainers

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Clinical and Safety Review Gate](docs/CLINICAL-SAFETY-REVIEW.md)
- [Stable Release Evidence](docs/RELEASE-EVIDENCE.md)
- [Release Process](RELEASING.md)
- [Governance](GOVERNANCE.md)

## Attribution

Scalvin is an independent derivative of Anthony Taglianetti's
[Inner Dialogue](https://github.com/ataglianetti/inner-dialogue). The original
MIT copyright notice is preserved. See [Notices](NOTICE.md).

## License

[MIT](LICENSE)
