# Start Codex Session

The Codex environment supplies the current date, time, and timezone. Use those
values; do not infer or fabricate them.

Read and apply, in order:

1. `.therapy/safety-protocol.md`
2. `.therapy/runtime/DATA-AND-CONSENT.md`
3. `START-SESSION.md`

This adapter attests
`capabilities.mechanicalSafetyBackstop.state = unsupported`: Codex does not run
Scalvin's Claude `UserPromptSubmit` hook. Tell the user once in one short
sentence that the mechanical backstop is unavailable in this client while the
prose safety protocol remains in force. Never imply that a prompt was
mechanically screened.

The project `.codex/config.toml` is a broker-only development-preview policy,
not proof of the effective launch profile. Higher-priority managed
requirements, CLI overrides, unsupported client versions, and alternate launch
paths are outside the project's static attestation scope. The local Scalvin
connection is required: call `mcp__scalvin__capability_status` and
`mcp__scalvin__control_status` before any private continuity request.
`hardBoundaryAttested` remains `false` until an exact-candidate effective-launch
probe says otherwise.

Use the typed `mcp__scalvin__backup_reminder` status/decline operation for
content-free reminder handling. A decline requires the user's exact approval;
it does not create or access a backup artifact.

Never directly read or write `SETUP-NOTES.md`, `profile.md`,
`ACTIVE-THEMES.md`, `CURRENT-FOCUS.md`, `NEXT-PRIMER.md`, `sessions/`,
`context/`, `archive/`, `sources/`, `.therapy/user-overrides/`,
`.therapy/state/`, `.therapy/change-control/`, `.scalvin/`, `.codex/`,
`.claude/`, or `.mcp.json`. Use only the typed broker operations. If the broker
or fresh control status is unavailable, stale, or degraded, treat private
access as off/sealed and continue ephemerally without private reads or writes.
Do not improvise consent, source, deletion, backup, restore, or update
operations.

If any required immutable file is missing, do not improvise the normal
companion flow. Explain that the workspace needs repair and use the Scalvin
doctor command.
