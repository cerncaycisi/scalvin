# Getting Started

Scalvin is designed to feel like opening a conversation, not running a setup wizard.

## Open The Repo

You can use:

- Codex or another agentic coding tool
- Claude Code
- any tool that can read local files and follow repo instructions

If your tool supports repo instruction files:

- Codex-style tools can use `AGENTS.md`
- Claude Code can use `CLAUDE.md`

Otherwise, open [SETUP.md](../SETUP.md) directly.

## Start Talking

Type "start", "başla", "merhaba", or anything else at all.

The companion should:

- introduce itself briefly and warmly
- ask only for the name to use, the language that feels most natural, and roughly what brought you here
- move straight into the first real session instead of pausing for setup

By default, Scalvin quietly starts with:

- the `warm-supportive` persona
- the `moderate` session structure
- `ACT`, `IFS`, and `CFT`

You do not need to pick these up front unless you want to.

## What Happens In The Background

While the conversation begins, Scalvin silently creates or reuses a separate living workspace for the user.

That workspace usually lives outside this repo and holds the ongoing therapy files:

- `profile.md`
- `ACTIVE-THEMES.md`
- `CURRENT-FOCUS.md`
- `sessions/`
- `sources/`
- `archive/`

The user is not expected to fill these out manually.

During the first 2 to 3 sessions, the companion learns from the conversation and begins writing the memory files itself:

- `profile.md` starts lean after session 1
- `ACTIVE-THEMES.md` usually starts filling after session 2 or 3
- `CURRENT-FOCUS.md` usually starts filling after session 3 or 4

Keep `scalvin/` as the reusable source repo and let the generated workspace remain the user's separate living folder.

## Change Things Later

The default path should feel invisible. If the user later wants something different, they can ask in plain language.

Scalvin can still:

- switch personas
- add or remove modalities
- change session structure
- switch language
- import notes or source documents
- recalibrate its own runtime guardrails

That last part matters: Scalvin is built so the operational layers can evolve with use, not stay frozen.
