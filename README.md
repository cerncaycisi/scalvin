# Scalvin

Scalvin is a local-first AI companion system for long-form therapeutic continuity.

It started from the MIT-licensed [Inner Dialogue](https://github.com/ataglianetti/inner-dialogue) project, but this repo is now organized around a different core idea:

- one living runtime instead of multiple runtime modes
- user-specific working files instead of a thin generic shell
- archive and source layers as first-class parts of the system
- operational guardrails that the companion can revise over time
- client-agnostic setup with adapters for Codex, Claude Code, and manual prompt use

## What Stays From The Original

- switchable personas
- modality multi-select
- session structure selection
- local files and local continuity
- safety protocol
- import/update workflow

## What Changed

- the repo now centers on a single layered living-file runtime
- the repo identity is client-agnostic rather than tool-specific
- generated workspaces include user-specific living files such as:
  - `SETUP-NOTES.md`
  - `profile.md`
  - `ACTIVE-THEMES.md`
  - `CURRENT-FOCUS.md`
  - `sources/`
  - `archive/`
  - `archive/reviews/REVIEW-INDEX.md`

## Core Shape

Every generated companion workspace is meant to be self-maintaining:

- active files stay lean and readable
- archive files hold richer history
- source files can be reopened selectively
- operational layers can be edited by the companion when the work shows they need recalibration

## Client Adapters

The repo is tool-agnostic.

- Codex and similar agentic tools can use `AGENTS.md`
- Claude Code can use `CLAUDE.md`
- other tools can follow [SETUP.md](SETUP.md) directly

Generated companion workspaces also include:

- `AGENTS.md`
- `CLAUDE.md`
- `START-SESSION.md`
- a named starter file like `hazel.md`

More detail: [docs/CLIENTS.md](docs/CLIENTS.md)

## Setup

1. Install [Codex](https://github.com/openai/codex) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
2. Open this folder.
3. Type "start" or "başla" or just say hi.
4. That's it. The companion will take it from here.

Important:

- behind the scenes, Scalvin creates or reuses a separate living workspace and keeps the technical steps out of the conversation
- you do not need to fill templates or walk through a setup wizard
- the generated companion workspace is meant to live outside this repo
- this repo is the reusable setup system; the generated workspace is the user's living therapy system

Detailed walkthrough: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)

## Included Persona Library

The repo keeps the original persona library and adds `Hazel` as an additional option.

## Safety

Scalvin is for emotional support and self-reflection. It is not a substitute for licensed mental health care.

If you are in crisis:

- US/Canada: `988`
- International: [findahelpline.com](https://findahelpline.com)
- Immediate danger: contact local emergency services

## Attribution

Scalvin is a derivative work built from the MIT-licensed Inner Dialogue project. The original copyright notice and license are preserved in [LICENSE](LICENSE).
