# Changelog

All notable changes to Scalvin.

---

## [Unreleased]

This development line prepares a breaking architecture and safety release. It
is not a stable release or evidence of clinical review. Existing workspaces
must follow `MIGRATING.md`; do not copy new runtime files over an old workspace.

### Added

- deterministic Node 20+ CLI for install, doctor, review-due, pinned update,
  integrity-checked backup, and traversal-safe restore
- manifest schema v2 with per-file version, SHA-256, source, role, target, and
  protection metadata
- transactional staging, atomic writes, restrictive POSIX permissions,
  symlink/path-containment checks, customized-file detection, full mutation
  snapshots, and rollback
- explicit versioned consent categories, retention controls, consent/deletion/
  source/backup/change ledgers, and separate transcript state
- memory show, correct, pause, resume, forget, export, and delete contracts
- item-level provenance and stale-memory review for profile, themes, and focus
- controlled user overlays with proposal, approval, rejection, history, and
  rollback instead of silent base-runtime self-modification
- source prompt-injection boundary, stable IDs, content hashes, idempotent
  integration states, and external-care note provenance
- explicit session close/recovery lifecycle, seconds + UUID no-clobber names,
  checkpoints, and honest transcript coverage grades
- opt-in context graph for people, places, and events with
  Core/Active/Provisional/Dormant lifecycle and supervised backfill
- neutral Scalvin default persona; Susan remains optional
- opt-in guarded Ideal Parent Figure reference
- locale-pack mechanical safety hook, current-time hook, and
  deterministic must-fire/silent/over-fire eval corpus
- public-repository private-data/secret scan, Markdown link check, syntax and
  manifest gates, cross-platform CI, issue forms, CODEOWNERS, governance,
  support, accessibility, localization, architecture, privacy, migration, and
  release documentation

### Changed

- immutable startup order is now safety → consent → client capability → active
  session configuration → minimum mutable context
- active session structure and modalities are loaded explicitly; heavy command,
  source, and close protocols are lazy
- default active modalities are ACT, CFT, and Motivational Interviewing; IFS
  and higher-intensity techniques are no longer default
- persona language no longer fabricates human identity, lived experience, or
  superiority over human care
- modalities now include risk tiers, consent, AI limitations,
  contraindications, stop/escalation rules, localization, and accessible
  alternatives
- weekly reviews are session-triggered on the first return in a new week when
  the prior week contains a completed session, instead of Monday/Tuesday only
- local workspace pointers moved from tracked `SETUP-NOTES.md` to gitignored
  machine state
- generated workspaces use a default-deny `.gitignore`
- raw transcripts remain off by default and now support status, pause, resume,
  stop, deletion, coverage grade, and visible gaps
- local-first documentation now distinguishes local durable storage from
  hosted model inference
- runtime language is now `auto` or canonical BCP-47 with Unicode,
  code-switching, and language/location/timezone separation; finite detector
  packs are test coverage, not privileged product-language tiers
- the model-branded `warm-4o` persona is now provider-neutral `casual-warm`;
  existing selector state is canonicalized during install or update
- alternate-manifest update trust requires the exact manifest SHA-256;
  `--release` is only an additional version constraint and mutable raw `main`
  is rejected
- absolute-path `.command` and `.bat` launchers are no longer generated
- MIT license text is kept license-pure; attribution and product boundary moved
  to `NOTICE.md`

### Fixed

- first-session safety protocol could previously be skipped
- selected modalities, structure, and command behavior could be disconnected
  from the active runtime
- stale/incorrect version metadata and duplicated runtime-copy paths
- quoted-tilde bootstrap path risk and non-empty target clobber risk
- update/install partial-state activation and missing rollback
- mutable workspace-state hashes could authorize silent overwrite or removal;
  update authority now comes only from an independently verified signed prior
  plan, with unknown prior distributions preserved and conflict-gated
- language preference changes could leave rendered client adapters and their
  canonical hashes on the previous language
- a snapshot/copy ABA race could reactivate transient external edits; every
  clone-and-mutate transaction now proves its private stage matches the exact
  pre-read content snapshot before applying changes
- doctor diagnostics could trust mutable target metadata or incomplete
  distribution provenance when classifying state integrity
- untrusted source documents could influence runtime instructions
- session-note template could assert no acute crisis without an assessment
- crisis flow lacked clear risk-class branching and capability truth
- transcript, session, deep-dive, and backup filename collision risk
- `review_due_check.py` crashed when the review path was a file
- cleanup script was non-executable and did not enforce its tracked-file safety
  claim
- freeform/weekly-review and structured/homework precedence conflicts
- client-told memories lost first-observed provenance during revision
- generated workspaces were not fully self-contained

---

## [0.8.1] - 2026-04-22

### Fixed

- closed the CONTEXT-COMPRESSION read path: `runtime/CONTEXT-COMPRESSION.md` now documents when summaries get consulted on demand, and `runtime/profile.template.md`'s Deep Memory Index guidance now covers compression outputs so summaries can be indexed by theme
- updated `templates/archive/reviews/REVIEW-INDEX.template.md` to account for quarterly review summaries and the `history/` subdirectory introduced by compression, so the index stays consistent after first consolidation

### Added

- added `scripts/clean-for-distribution.sh` and `scripts/README.md` to remove macOS resource fork artifacts from the working tree, plus a "Pre-Release Hygiene" note in `CONTRIBUTING.md`

---

## [0.8.0] - 2026-04-22

### Added

- new `runtime/CONTEXT-COMPRESSION.md` layer with session consolidation, review consolidation, and profile pruning rules; registered in START-SESSION living layers and weekly review output template
- added "### Presence" subsections to the eight personas that were missing one (direct-challenging, warm-supportive, coach, grounded-real, contemplative, philosophical, creative, warm-4o), bringing the persona library into line with Susan's structure
- added "## How To Use In Session" sections to all twelve modality files, giving the companion concrete operational guidance for live session use

### Changed

- added a safety note to the TIPP section of `modalities/dbt-skills.md` warning that body-based crisis techniques should be framed as options, with extra care for clients with self-harm history

---

## [0.7.3] - 2026-04-22

### Changed

- refreshed `README.md` to mention client-told-memories, transcript tracking, and workspace migration
- added transcript tracking and workspace migration to the "Change Things Later" list in `docs/GETTING-STARTED.md`

---

## [0.7.2] - 2026-04-22

### Fixed

- closed the transcript write flow: `runtime/START-SESSION.md` now detects transcript opt-in from `SETUP-NOTES.md`, and `runtime/SESSION-CLOSE-REVIEW.md` now writes the verbatim session exchange to `archive/transcripts/` when tracking is enabled
- workspace migration now carries forward the transcript opt-in state (`## Transcripts` heading in `SETUP-NOTES.md`), so tracked workspaces do not silently lose transcript tracking when migrated
- extended `runtime/WEEKLY-REVIEW.md` self-evolution audit to cover rupture-and-repair evidence log and client-told-memories drift introduced in Phase 5

---

## [0.7.1] - 2026-04-22

### Fixed

- normalized "user" -> "client" in `runtime/CLIENT-TOLD-MEMORIES.md` and in the client-told-memories section of `runtime/SOURCE-TRIGGERS.md` so the therapeutic-context terminology matches the rest of the runtime layer

---

## [0.7.0] - 2026-04-22

### Added

- expanded `runtime/LIVE-MOVESET.md` with explicit purpose, open-ended question defaults, stuck-register handling, lighter-tone handling, Socratic intervention moves, trauma inventory guidance, and update triggers
- added evidence status tracking, repair rules, update rules, and status logging to `runtime/RUPTURE-AND-REPAIR.md`
- added deterministic purpose, output contract, and maintenance triggers to `runtime/REVIEW-DUE-CHECK.md`
- introduced `runtime/CLIENT-TOLD-MEMORIES.md` as a companion-maintained source type, added selective reopening guidance in `runtime/SOURCE-TRIGGERS.md`, and documented it in setup notes and workspace setup
- added optional transcript infrastructure with `templates/archive/transcripts/README.template.md`, transcript opt-in commands, and setup guidance for on-demand transcript tracking

### Changed

- replaced `runtime/SESSION-START-CHEATSHEET.md` with a full fast re-entry layer centered on `NEXT-PRIMER`, system-eye scanning, and opening-question discipline
- extended `runtime/SESSION-NOTE-STANDARD.md` with note-boundary rules, dense-session handling, same-day session handling, and source-note boundaries
- expanded `runtime/MEMORY-INFLATION-GUARD.md` with explicit decision buckets, compression rules, and update triggers for memory placement
- deepened `runtime/WEEKLY-REVIEW.md` with weekly vs interim review distinction and clearer review stance guidance
- extended `runtime/SESSION-CLOSE-REVIEW.md` with language fidelity, question-depth, and client-told-memories checks
- rewrote `personas/susan.md` with stronger drift-correction, presence, boundary, and language guidance while keeping the persona generic

### Fixed

- cleaned leftover zip and macOS metadata artifacts from the working tree and expanded ignore coverage for archive bundles

---

## [0.6.6] - 2026-04-13

### Fixed

- clarified `commands.md` update flow numbering by separating the merge strategy from the numbered update steps
- `commands.md` now explicitly reads `base_url` from the source manifest before remote file fetches, falling back to `source_url` only when needed
- cleaned residual macOS `._*` metadata files from the working tree

---

## [0.6.5] - 2026-04-13

### Fixed

- generated workspace `.therapy/version.json` now writes current package metadata, including `0.6.5` install version, `commands` component version, and the full runtime component map
- `commands.md` merge strategy now treats same-version runtime files as potentially customized when content differs, preventing silent overwrite of living runtime edits
- workspace migration now preserves the old workspace's setup defaults before moving user data into the fresh workspace
- launcher docs now clarify that `start-session.command` and `start-session.bat` are Claude Code launchers, avoiding mismatch with the repo's generic client support

---

## [0.6.4] - 2026-04-13

### Added

- workspace migration flow in `commands.md`, including backup-first upgrade handling, selective user-data copying, runtime refresh, and persona-adjustment preservation
- natural-language recognition for "migrate my workspace" and "upgrade my workspace"

---

## [0.6.3] - 2026-04-13

### Changed

- `commands.md` update flow now includes an explicit merge strategy for persona and runtime files, protecting client memory files and preserving customized workspace behavior during updates

---

## [0.6.2] - 2026-04-13

### Changed

- `manifest.json` now publishes the raw GitHub `base_url` for remote update fetching
- `commands.md` update flow now prefers `source_url`, falls back to local `source_repo_path`, and uses web fetch for remote file updates
- generated workspace `.therapy/version.json` now includes the raw GitHub `source_url` by default

---

## [0.6.1] - 2026-04-13

### Added

- workspace launcher script generation in `SETUP.md`: generated workspaces now include `start-session.command` and `start-session.bat` so sessions can be launched by double-click
- `GETTING-STARTED.md` note explaining launcher script use from the workspace folder

---

## [0.6.0] - 2026-04-13

### Added

- modality switching guidance in `runtime/START-SESSION.md`, mapping live moments to installed modalities and clarifying seamless pivots, blending, and somatic-first timing
- ethical guidelines in `runtime/START-SESSION.md`, covering therapeutic boundaries, harmful validation, cultural humility, autonomy, and honesty about limitations

### Changed

- renamed the `Hazel` persona to `Susan`
- made `Susan` the default companion persona for conversational bootstrap
- aligned generated workspace defaults so bootstrap now creates `susan.md` as the named starter file and uses `Susan` as the default companion name

---

## [0.5.1] - 2026-04-10

### Fixed

- `SETUP.md` version.json now correctly writes `0.5.1` as installed version
- updated stale version tags on runtime files modified in v0.2.0 through v0.5.0
- `manifest.json` `runtime_components` now lists all runtime files with correct versions
- added missing version tags to template files
- removed macOS metadata files from tracking

### Changed

- rewrote `README.md` to reflect the full v0.5 feature set including self-evolution, source integration, model awareness, backup, and session primer
- updated `GETTING-STARTED.md` with backup instructions and expanded "Change Things Later" list
- updated `CONTRIBUTING.md` with v0.2+ contribution areas
- updated `SECURITY.md` with backup command reference

---

## [0.5.0] - 2026-04-10

### Added

- backup and export command: users can ask to save a copy of their workspace as a zip archive
- gentle backup reminder after 10+ sessions without a backup (once per month maximum)
- profile template now includes growth guidance comments showing which sections to add and when
- deep memory index, important sources, primary defense patterns, and therapeutic notes sections are guided in the template

### Changed

- fully rewrote all three session structure files (freeform, moderate, structured) with real therapeutic depth
- freeform now includes guidance on when drift becomes avoidance
- moderate now integrates `NEXT-PRIMER` follow-up and carry-forward into the flow
- structured now includes deliberate technique application, single-thread focus, and specific homework approach
- profile template upgraded from blank headings to a living growth document with staged section guidance

---

## [0.4.0] - 2026-04-10

### Added

- full between-session experiment protocol with `CARRY-FORWARD` tags, follow-up rules, and non-completion-as-data principle
- rolling `NEXT-PRIMER.md` file: a 3-to-5-line handoff written at every session close, read first at every session start, giving the companion instant orientation without reading 15 files
- `NEXT-PRIMER.template.md` added to runtime templates and workspace generation
- model-specific drift awareness added to all persona files: GPT over-mirroring, Claude over-formulating, with instructions to note observed patterns in client-specific adjustments
- model drift tracking added to self-evolution audit in weekly reviews

### Changed

- between-session experiments section in `SESSION-CLOSE-REVIEW.md` fully rewritten with format, follow-up, and quality guidelines

---

## [0.3.0] - 2026-04-10

### Added

- companion self-evolution protocol: persona adjustments, source triggers, disambiguation grid, and live moveset now grow organically as the companion learns the user
- automatic source integration chain: new sources trigger reading, `SOURCE-TRIGGERS` extension, profile/theme assessment, and optional interim review
- source detection at session start for files added between sessions
- self-evolution audit section in weekly review output template

### Fixed

- removed residual `__pycache__` files from the repo and confirmed they are not tracked

---

## [0.2.0] - 2026-04-10

### Added

- first-session handling guidance in `runtime/START-SESSION.md`
- early-session auto-population guidance in `runtime/SESSION-CLOSE-REVIEW.md`
- name-usage guidance for warmer but non-ritualized openings
- anti-intellectualization protocol in `runtime/LIVE-MOVESET.md`

### Changed

- replaced the setup-wizard framing with a conversational bootstrap flow
- rewrote `AGENTS.md` and `CLAUDE.md` so repo entry begins with quiet workspace detection and immediate session start
- updated `README.md` and `docs/GETTING-STARTED.md` to reflect the "open folder and start talking" experience

### Fixed

- ignored `__MACOSX/` metadata alongside existing macOS and Python cache ignores
- cleaned stray macOS metadata files from the repo

---

## [0.1.0] - 2026-04-10

### Added

- first Scalvin repo scaffold
- single living runtime built around layered memory and review-driven continuity
- generic client adapters for Codex-style tools, Claude Code, and manual prompt use
- user-specific living workspace files:
  - `SETUP-NOTES.md`
  - `profile.md`
  - `ACTIVE-THEMES.md`
  - `CURRENT-FOCUS.md`
  - `sources/`
  - `archive/`
  - `archive/reviews/REVIEW-INDEX.md`
- living operational layers that the companion can revise:
  - `LIVE-MOVESET.md`
  - `DISAMBIGUATION-GRID.md`
  - `MEMORY-INFLATION-GUARD.md`
  - `RUPTURE-AND-REPAIR.md`
  - `SOURCE-TRIGGERS.md`
  - `WEEKLY-REVIEW.md`
- `Susan` as an additional persona option

### Changed

- unified the system around a single living runtime
- replaced tool-specific repo identity with generic setup docs and adapters
- preserved original persona, modality, and structure selection while rebuilding the operating layer around the new runtime
