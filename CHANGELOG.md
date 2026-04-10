# Changelog

All notable changes to Scalvin.

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
