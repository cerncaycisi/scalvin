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

## Development-preview data boundary

Generated Codex and Claude projects register a local stdio Scalvin connection.
It opens no listening port and exposes only bounded semantic operations; it has
no network, shell, arbitrary-path, or raw-source tool. The connection enforces
pause and consent rules for operations routed through it.

The preview surface includes bounded memory inspection/correction/creation,
user-confirmed client-scene creation, pause/seal, session lifecycle, consent
controls, prepared-source proposal review/integration, and content-free
backup-reminder status/decline. Reminder decline cannot access or create a
backup artifact.

Read-only broker calls for capability state, control state, bounded memory, and
prepared-source status/proposals are pre-approved. Every broker call that can
change private state remains in the client's mandatory approval class. The
broker then requires its separate snapshot-bound, one-time exact confirmation
challenge. The client approval and broker challenge are both required; a model
instruction alone is not authorization to mutate private state.

The current preview uses `broker_only_unattested` mode. Project policy denies
direct access to profile, themes, focus, primer, sessions, context, archive,
sources, transcripts, canonical state, client configuration, and user overlays.
Private operations without a typed broker route remain unavailable or
terminal-only; the companion must not fall back to direct files.

A separate ephemeral Codex/Claude source worker can read one assigned source
revision through bounded chunks and submit a schema-bound proposal. It has no
normal filesystem, shell, network, live-memory, or persistence tools. The main
companion receives bounded proposal candidates only, and integration requires
an exact selected-ID confirmation without automatically writing live memory.

Higher-priority client settings can still override project policy, and the
source worker's requested launch flags are not independent runtime evidence.
Therefore `hardBoundaryAttested` is always `false` and stable remains blocked
until every shipped adapter has exact-candidate effective-launch attestation.

Stable readiness is evaluated separately for `codex`, `claude-code`, and
`generic`, matching the shipped release-evidence policy. Repository templates
and broker self-report fields are diagnostic inputs, not proof of the effective
client launch. Each adapter requires independent, exact-candidate evidence that
the effective launch configuration actually enforces its hard boundary. That
evidence contract is not shipped in this preview, so the architecture gate is
intentionally fail-closed even if someone changes a boolean in a self-test.

## Codex and similar repo-aware agents

The public source repo uses `AGENTS.md`. A generated workspace receives its own
adapter rendered from `adapters/workspace/AGENTS.template.md`.

Codex exposes the current date/time context directly. Scalvin uses that
verified value and does not install a shell hook for it.

## Claude Code

The source repo uses `CLAUDE.md`. A generated workspace receives:

- `CLAUDE.md`;
- `START-CLAUDE-SESSION.md`;
- a surgical settings merge for supported hooks;
- a project-local stdio broker registration for bounded controls.

The installer preserves existing Claude settings, makes a backup before
changing them, and adds only Scalvin-owned hook entries. It does not overwrite
an invalid settings file.

Supported hooks:

- current local time;
- locale-pack mechanical crisis-language backstop with finite, documented coverage.

The safety hook is defense in depth. It does not replace the full safety
protocol and it is not described as complete detection.

The installed hook supports a content-free runtime probe:

```bash
node .therapy/hooks/safety-net.cjs --self-test --json
```

Doctor executes this synthetic probe rather than trusting file presence or
settings alone. Its machine-readable
`capabilities.mechanicalSafetyBackstop.state` is exactly one of:

- `available`: the installed Claude hook is registered, integrity-checked, and
  passed the runtime self-test;
- `degraded`: the hook was configured but could not be verified or failed at
  prompt time;
- `unsupported`: the active adapter has no verified prompt-hook integration.

Doctor attests the installed Claude integration; it does not infer which client
is currently running. The Codex and generic adapters therefore attest
`unsupported` even when a healthy Claude hook is installed in the same
workspace.

The probe and capability record contain no prompt, personal content, source
text, or local path. A prompt-time failure remains fail-open: the message is not
blocked, but the hook emits a fixed content-free degraded notice so the agent
cannot confuse detector failure with a normal silent result.

## Generic/manual clients

Clients without repo instructions can open the rendered named starter or
`START-SESSION.md`. If the client cannot provide a trustworthy current time,
the runtime leaves time-dependent behavior unknown instead of guessing.

Clients without prompt hooks operate in explicit visible degraded mode with the
capability state `unsupported`. A supported configured hook that is missing,
corrupt, or fails its runtime probe reports `degraded`; the prose safety protocol
remains authoritative in both states.

Generic clients also have no enforceable private-data boundary or trusted live
control status. They are ephemeral-only in this preview and must not open
private continuity, raw source, or canonical state files.

## Launchers

Scalvin no longer generates absolute-path `.command` or `.bat` launchers by
default. They were fragile across moves, escaping rules, and client
installations.

Open the workspace in the chosen client, or use the supervised launcher from
the retained checkout:

```bash
node bin/scalvin.js client launch --workspace /absolute/path/to/workspace --client codex
```

The launcher runs doctor first, requires the canonical broker-only project
profile, and terminates the client when an exact local sealed-pause signal is
received. Codex ignores user config and execpolicy rules for this launch, uses
the project profile, and disables local history persistence. Claude uses strict
project settings and MCP configuration. Mutating broker calls remain
interactive in both clients. Residual client/provider context behavior remains
explicitly unattested, and a fresh client context is required after sealed
pause.

## Verifying an adapter

From the retained development-preview checkout:

```bash
node bin/scalvin.js doctor --workspace /absolute/path/to/workspace
```

Use `--json` for machine-readable integration. Doctor checks required adapter
files, active configuration, consent state, framework hashes, and configured
hooks without reading or printing private content.

## Privacy rule

Adapters must never copy a real workspace into the public source repository,
an issue, a PR, telemetry, or an unrelated tool. Logs and error messages use
paths and counts only when necessary and never print private file contents.
