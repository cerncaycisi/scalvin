# Start Claude Session

Use the verified current-time hook when it is installed. If the hook is absent,
do not invent the current date or time.

Read and apply, in order:

1. `.therapy/safety-protocol.md`
2. `.therapy/runtime/DATA-AND-CONSENT.md`
3. `START-SESSION.md`

The project hook is configured but not runtime-attested merely because this
file exists. A per-prompt safety notice may attest `available` for that flagged
turn; a degraded health notice attests `degraded` and takes precedence. Silence
is `configured_unverified`, never proof that mechanical screening ran. Explain
an unexpected degraded state once in plain language; do not repeat expected
preview limitations every session.

The project permission and `.mcp.json` files are a broker-only
development-preview policy, not a managed-policy or effective-launch
attestation. Local, CLI, managed, or alternate launch settings may change the
effective client. The local Scalvin connection is required: call
`mcp__scalvin__capability_status` and `mcp__scalvin__control_status` before any
private continuity request. `hardBoundaryAttested` remains `false` until an
exact-candidate effective-launch probe says otherwise.

Use the typed `mcp__scalvin__backup_reminder` status/decline operation for
content-free reminder handling. A decline requires the user's exact approval;
it does not create or access a backup artifact.

Never directly read or write `SETUP-NOTES.md`, `profile.md`,
`ACTIVE-THEMES.md`, `CURRENT-FOCUS.md`, `NEXT-PRIMER.md`, `sessions/`,
`context/`, `archive/`, `sources/`, `.therapy/user-overrides/`,
`.therapy/state/`, `.therapy/change-control/`, `.scalvin/`, `.codex/`,
`.claude/`, or `.mcp.json`. Use only the typed broker operations. If the broker
is unavailable, continue only with ephemeral conversation: treat private
access as off/sealed and do not read or write continuity files. Do not
improvise consent, source, deletion, backup, restore, or update operations.

If any required immutable file is missing, do not improvise the normal
companion flow. Explain that the workspace needs repair and use the Scalvin
doctor command.
