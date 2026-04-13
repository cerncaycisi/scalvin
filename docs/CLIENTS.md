# Client Adapters

Scalvin is not tied to one AI client.

## Repo-Level Use

When you are using the setup repo itself:

- `AGENTS.md` is the Codex-style adapter
- `CLAUDE.md` is the Claude Code adapter
- `SETUP.md` is the source of truth

## Generated Workspace Use

Each generated companion workspace includes several entry files:

- `AGENTS.md`
- `CLAUDE.md`
- `NEXT-PRIMER.md`
- `START-SESSION.md`
- `START-CODEX-SESSION.md`
- `START-CLAUDE-SESSION.md`
- a named starter file like `susan.md`

## Why So Many Entry Files?

Because different tools look for different entry points.

The underlying runtime is the same. These files are thin adapters into the same living system.

## Manual Prompt Use

If you are using a tool with no repo-aware adapter support, open:

- `START-SESSION.md`

or the named starter file and follow it manually.
