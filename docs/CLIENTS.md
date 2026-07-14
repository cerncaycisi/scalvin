# Client Adapters

Scalvin has one runtime and thin adapters for different AI clients. A client
adapter may supply capabilities such as current time or a prompt hook, but it
must not fork safety, consent, memory, or modality policy.

## Shared startup order

Every supported client loads:

1. immutable safety protocol;
2. data-and-consent protocol;
3. client capability/time contract;
4. session runtime;
5. selected active configuration and minimum relevant memory.

Mutable memory and imported sources never precede the immutable prelude.

## Codex and similar repo-aware agents

The public source repo uses `AGENTS.md`. A generated workspace receives its own
adapter rendered from `adapters/workspace/AGENTS.template.md`.

Codex exposes the current date/time context directly. Scalvin uses that
verified value and does not install a shell hook for it.

## Claude Code

The source repo uses `CLAUDE.md`. A generated workspace receives:

- `CLAUDE.md`;
- `START-CLAUDE-SESSION.md`;
- a surgical settings merge for supported hooks.

The installer preserves existing Claude settings, makes a backup before
changing them, and adds only Scalvin-owned hook entries. It does not overwrite
an invalid settings file.

Supported hooks:

- current local time;
- locale-pack mechanical crisis-language backstop with finite, documented coverage.

The safety hook is defense in depth. It does not replace the full safety
protocol and it is not described as complete detection.

## Generic/manual clients

Clients without repo instructions can open the rendered named starter or
`START-SESSION.md`. If the client cannot provide a trustworthy current time,
the runtime leaves time-dependent behavior unknown instead of guessing.

Clients without prompt hooks operate in explicit degraded mode. Doctor reports
the missing capability as a warning when it is optional and an error when a
configured hook is corrupt.

## Launchers

Scalvin no longer generates absolute-path `.command` or `.bat` launchers by
default. They were fragile across moves, escaping rules, and client
installations.

Open the workspace in the chosen client, or run the client's documented
directory command. A future launcher may be added only if it is
platform-specific, relative/config-resolved, and covered by tests.

## Verifying an adapter

From any shell where the Scalvin CLI is installed:

```bash
scalvin doctor --workspace /absolute/path/to/workspace
```

Use `--json` for machine-readable integration. Doctor checks required adapter
files, active configuration, consent state, framework hashes, and configured
hooks without reading or printing private content.

## Privacy rule

Adapters must never copy a real workspace into the public source repository,
an issue, a PR, telemetry, or an unrelated tool. Logs and error messages use
paths and counts only when necessary and never print private file contents.
