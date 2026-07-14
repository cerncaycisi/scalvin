# Contributing to Scalvin

Scalvin welcomes carefully scoped contributions to its public framework,
distribution tooling, safety system, client adapters, memory model, and
documentation.

## Never contribute private user data

Do not commit or paste:

- real profiles, session notes, transcripts, sources, archives, or crisis
  disclosures;
- names, local workspace paths, screenshots, or identifying examples;
- API keys, tokens, credentials, or client settings containing secrets;
- imported clinician records;
- real behavior overlays or consent ledgers.

Use synthetic fixtures. Run:

```bash
npm run check:public
```

before opening a PR.

## Development setup

Requirements: Git and Node.js 20 or newer.

```bash
git clone https://github.com/cerncaycisi/scalvin.git
cd scalvin
npm ci --ignore-scripts
npm test
```

The framework has no reason to execute lifecycle scripts during dependency
installation.

## Required checks

```bash
npm run check
npm test
npm pack --dry-run
```

CI repeats these checks on supported Node versions across Linux, macOS, and
Windows.

## Architectural rules

- Safety and consent load before mutable context.
- Public source and private generated workspaces remain separate.
- Imported sources are untrusted data, never instructions.
- Base framework files are immutable at runtime; user-specific learning uses
  reviewable overlays.
- Current user statements outrank model-authored historical formulations.
- AI-authored notes never claim human-provider provenance.
- Install/update/backup/restore mutations belong in the deterministic CLI.
- Update input is release/commit/hash pinned; mutable raw `main` is not trusted.
- Client adapters stay thin and do not fork safety or memory policy.

Read [Architecture](docs/ARCHITECTURE.md) before changing runtime ownership.

## Safety-sensitive changes

The following need explicit failure analysis and deterministic tests:

- crisis detection or response;
- consent, retention, deletion, transcript, or source behavior;
- durable-memory placement or provenance;
- high-risk modality techniques;
- client hooks;
- installer/update trust;
- backup or restore.

In the PR, state:

1. what failure is possible today;
2. the new observable behavior;
3. false-positive and false-negative risks;
4. tests/eval cases added;
5. migration impact;
6. known limitations.

Do not make unsupported clinical, neurological, trauma, attachment, or efficacy
claims. See [Scope and Evidence Boundary](docs/SCOPE-AND-EVIDENCE.md).

## Persona, modality, and structure changes

- Preserve AI identity and user autonomy.
- Do not fabricate lived experience or hide the purpose of a technique.
- Keep challenge consent-based.
- Include AI limitations, contraindications, stop rules, and alternatives where
  relevant.
- Support low-cognitive-load interaction and body-prompt opt-out.
- Localize intent and idiom; do not mechanically translate safety language.
- Add behavior/eval coverage instead of relying on prose review alone.

## Manifest and versioning

Every generated-workspace managed framework asset belongs in `manifest.json`.
The manifest is generated from source metadata and hashes:

```bash
npm run manifest:refresh
npm run manifest:verify
```

Do not add a second managed-workspace registry. The exact npm package surface
is a different boundary and is tracked separately in `package-inventory.json`.

Version behavior changes with semantic versioning and update `CHANGELOG.md`.
Schema or protected-data changes require `MIGRATING.md`.

## Pull requests

- Keep a PR focused enough to review.
- Describe user impact and root cause.
- Include exact validation commands/results.
- Mark safety, privacy, bootstrap, migration, and client-adapter impact.
- Never attach a real generated workspace.
- Expect maintainer review for safety-sensitive paths in `CODEOWNERS`.

## External work

When adapting an idea or implementation from another project:

1. identify the behavior, not only the source diff;
2. evaluate it against Scalvin's architecture and safety boundary;
3. reimplement it with Scalvin-native tests and migration;
4. preserve attribution when required;
5. document the source and resulting design decision when relevant.

## Distribution cleanup

Before packaging on macOS:

```bash
./scripts/clean-for-distribution.sh
```

The script deletes only untracked metadata noise and skips tracked files.

## Community and reporting

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities or
safety bypasses through
[private vulnerability reporting](https://github.com/cerncaycisi/scalvin/security/advisories/new),
not a public issue.
