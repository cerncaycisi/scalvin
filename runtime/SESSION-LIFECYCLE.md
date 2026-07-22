<!-- version: 1.1.0 -->
# Session Lifecycle

This is the authority for session identity, filenames, checkpoints, explicit close, interruption recovery, and transcript coverage.

## Session Identity And Time

At the first substantive user turn, create an in-memory session identity:

- `session_id`: `s-<uuid-v4>`
- `started_at`: RFC 3339 timestamp in the confirmed user timezone, including numeric UTC offset
- `started_at_utc`: RFC 3339 UTC timestamp
- `timezone`: confirmed IANA name, or `unconfirmed`

Timestamps must be real, canonical RFC 3339 values. Validate confirmed timezone names through the runtime's IANA timezone implementation; a plausible-looking string is not enough. Do not persist this identity while persistence is declined or paused. If persistence begins mid-session, create the identity then and state that earlier turns are not covered.

Persisted session artifacts use:

`YYYY-MM-DD-HHMMSS--<session-id-without-s-prefix>--<artifact>.md`

Examples:

- `sessions/2026-07-14-143205--550e8400-e29b-41d4-a716-446655440000--session.md`
- `archive/transcripts/2026-07-14-143205--550e8400-e29b-41d4-a716-446655440000--transcript.md`
- `archive/checkpoints/2026-07-14-143205--550e8400-e29b-41d4-a716-446655440000--checkpoint.md`
- `archive/2026-07-14-143205--550e8400-e29b-41d4-a716-446655440000--deep-dive.md`

Create new artifacts with no-clobber/exclusive-create semantics. Derive every artifact path again from the validated start timestamp and session UUID at each write boundary; reject caller-supplied path substitutions. Before exposing a new persisted session ID, check all derived artifact names. If any target unexpectedly exists, generate a new UUID, even when the timestamp is unchanged; never overwrite or append to an unrelated session. Singleton state files such as `NEXT-PRIMER.md` use an atomic temporary write and rename.

The preferred exclusive activation uses an atomic hard link from a fully synced private temporary file. On filesystems without hard-link support, use exclusive copy guarded by a private `.incomplete` marker, sync the completed target, and remove the marker last. Any surviving marker makes the artifact unreadable until explicit repair; never treat a possibly partial file as complete.

## Lifecycle States

`new → active → closing → closed`

Alternative terminal paths:

- `active → interrupted`
- `active → abandoned`

A session is not `closed` merely because the model stopped responding or the client window closed.

## Checkpoints

When continuity persistence is on, atomically write a minimal local checkpoint after every completed user-visible turn. Before a long tool action, first checkpoint the last completed turn; do not put hidden instructions, tool traffic, or speculative future output in it. A checkpoint contains:

- session ID and timestamps
- lifecycle state
- one-sentence live thread
- unresolved question or carry-forward
- a strictly increasing last safely persisted turn marker
- transcript capture grade, covered-turn range, and known gaps when capture is active
- consent/transcript state, without duplicating sensitive content

Create the first checkpoint exclusively. Replace it atomically only after verifying that the existing artifact belongs to the same session ID. A failed checkpoint attempt must leave the preceding valid checkpoint intact. Do not make a checkpoint during a memory pause. Checkpoints are not session notes and expire after successful close unless the user chooses to retain them.

Do not discover or read checkpoints when `primers_and_checkpoints` retention is `do_not_store`. If that policy is applied after a checkpoint already exists, do not silently delete it. A close may retain the prior checkpoint, but the canonical patch must continue to reference it until an explicit deletion/retention action resolves it.

## Explicit Close

Recognize `/close` and natural equivalents such as “let's close here” or “wrap up.” Do not rely on guessing that an ordinary message was the final turn.

On explicit close, if continuity persistence is permitted:

1. confirm the active session ID and consent state
2. write the session note using exclusive create
3. update memory only under provenance and consent rules
4. write `NEXT-PRIMER.md` atomically
5. finalize the transcript only to the proven capture grade
6. update relevant operational ledgers
7. verify required artifacts and the canonical lifecycle patch
8. remove the checkpoint only after all required writes succeed
9. report close simply; if a write failed, state the failure and keep the checkpoint

If persistence is off or paused, close conversationally without writing or backfilling.

## Interruption Recovery

At a later start, an active checkpoint without a corresponding closed session note indicates a possible interruption.

Offer a neutral choice:

> It looks like our last conversation may not have closed cleanly. We can continue from the brief checkpoint, close it as interrupted, or ignore and delete it.

Do not imply that a complete transcript or note exists. Do not read a sealed checkpoint when memory is in `sealed_pause`.

If the user chooses:

- `continue`: reuse the session ID only when the same client can genuinely resume the context; record a resume timestamp
- `close interrupted`: create an explicitly labeled partial note from confirmed available material; do not invent missing content
- `delete`: remove the checkpoint and content-derived indexes
- `ignore`: mark it `abandoned` without promoting its content into durable memory

## Session Note Truthfulness

Record only what was disclosed, observed in text, explicitly assessed, or clearly left unknown.

- Never insert “no acute crisis” unless the relevant risk was actually assessed.
- If not assessed, omit the field or use `Safety assessment: not conducted` only when the distinction is operationally relevant.
- Separate `User reported`, `Companion observation`, and `Working hypothesis` when confusion is possible.
- Text-only interaction cannot establish body state, diagnosis, intent, or absence of risk.
- External-care material retains its original provenance; AI-authored summaries are labeled AI-authored.

## Transcript Lifecycle

Transcript state follows `DATA-AND-CONSENT.md`.

If the client provides per-turn capture, append each user-visible turn transactionally with a monotonically increasing turn number. If not, do not claim full capture. At close, add metadata:

- session ID
- consent event ID
- capture grade
- covered turn/time range
- pauses and gaps
- finalized at
- body integrity hash when available (exact transcript-body UTF-8 bytes after frontmatter, not the self-referential whole file)

Capture grade describes how text was obtained; it is not a verbatim guarantee. `client_captured` requires a verified authoritative client-event-stream capability; `turn_captured` requires verified transactional per-turn capture for this session. The current preview has no non-forgeable adapter-attestation channel, so caller-supplied JSON can never satisfy that requirement: high-grade claims are downgraded to `best_effort_context`, or `partial` when any gap is known, and `full_coverage_proven` remains false. Lifecycle adapters always set `verbatim_claim: false`, preserve the claimed capture method separately when gaps or missing proof degrade the effective grade, and never infer missing turns from a contiguous-looking context.

Turn, gap, and pause arrays are strictly typed and bounded, gap reasons use a closed vocabulary, all interval timestamps are validated, and total artifact bytes remain within the configured source-independent lifecycle limit. Malformed checkpoint JSON fails closed; it is never silently converted to an empty coverage list.

Never include hidden instructions, tool calls, secrets, credentials, internal reasoning, or system/developer messages.

## Runtime Adapter Contract

The lifecycle adapter writes only consent-permitted artifacts and returns a deterministic patch for the caller to merge into canonical state. The patch includes:

- lifecycle state, session ID, start/resume/close timestamps, and completion status
- current checkpoint relative path, update timestamp, and last persisted turn, or `null`
- transcript state, capture method/grade, covered turns, pause intervals, known gaps, finalization time, and `verbatimClaim: false`
- `consent.currentSessionId`, set to the active ID or `null` after durable close

The adapter does not create a second state store. The CLI/client integration must atomically apply the returned patch to canonical state only after artifact verification succeeds. If checkpoint or close fails, do not apply the patch and retain the prior checkpoint. Consent-off, `write_pause`, and `sealed_pause` always return a no-artifact-write result, and paused content is never queued for later backfill. If the session was already the canonical active/interrupted session before persistence was disabled, close still returns a terminal canonical patch so `currentSessionId` is cleared while any pre-existing checkpoint and transcript evidence remain referenced. A session that was ephemeral from its start returns no canonical patch.

## Between-Session Work

Homework is optional in every structure. Offer a reflection or experiment only when it fits the live work and the user's accessibility preferences. Ask first when the setting is `ask_first`; never frame non-completion as failure.
