# Changelog

All notable changes to Scalvin.

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
- `Hazel` as an additional persona option

### Changed

- unified the system around a single living runtime
- replaced tool-specific repo identity with generic setup docs and adapters
- preserved original persona, modality, and structure selection while rebuilding the operating layer around the new runtime
