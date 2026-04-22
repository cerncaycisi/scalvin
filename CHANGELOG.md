# Changelog

All notable changes to Scalvin.

---

## [0.7.1] - 2026-04-22

### Fixed

- 5.14 normalized "user" -> "client" in `runtime/CLIENT-TOLD-MEMORIES.md` and in the client-told-memories section of `runtime/SOURCE-TRIGGERS.md` so the therapeutic-context terminology matches the rest of the runtime layer

---

## [0.7.0] - 2026-04-22

### Added

- 5.1 expanded `runtime/LIVE-MOVESET.md` with explicit purpose, open-ended question defaults, stuck-register handling, lighter-tone handling, Socratic intervention moves, trauma inventory guidance, and update triggers
- 5.3 added evidence status tracking, repair rules, update rules, and status logging to `runtime/RUPTURE-AND-REPAIR.md`
- 5.7 added deterministic purpose, output contract, and maintenance triggers to `runtime/REVIEW-DUE-CHECK.md`
- 5.9 introduced `runtime/CLIENT-TOLD-MEMORIES.md` as a companion-maintained source type, added selective reopening guidance in `runtime/SOURCE-TRIGGERS.md`, and documented it in setup notes and workspace setup
- 5.10 added optional transcript infrastructure with `templates/archive/transcripts/README.template.md`, transcript opt-in commands, and setup guidance for on-demand transcript tracking

### Changed

- 5.2 replaced `runtime/SESSION-START-CHEATSHEET.md` with a full fast re-entry layer centered on `NEXT-PRIMER`, system-eye scanning, and opening-question discipline
- 5.4 extended `runtime/SESSION-NOTE-STANDARD.md` with note-boundary rules, dense-session handling, same-day session handling, and source-note boundaries
- 5.5 expanded `runtime/MEMORY-INFLATION-GUARD.md` with explicit decision buckets, compression rules, and update triggers for memory placement
- 5.6 deepened `runtime/WEEKLY-REVIEW.md` with weekly vs interim review distinction and clearer review stance guidance
- 5.8 extended `runtime/SESSION-CLOSE-REVIEW.md` with language fidelity, question-depth, and client-told-memories checks
- 5.11 rewrote `personas/susan.md` with stronger drift-correction, presence, boundary, and language guidance while keeping the persona generic

### Fixed

- 5.12 cleaned leftover zip and macOS metadata artifacts from the working tree and expanded ignore coverage for archive bundles

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
