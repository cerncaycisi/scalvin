<!-- version: 4.0.0 -->
# Session Close Review

Run only on explicit `/close` or an unambiguous natural-language close request. This workflow does not make ordinary final-sounding messages a close event.

## Gate

Follow `SESSION-LIFECYCLE.md` and `DATA-AND-CONSENT.md` first.

- persistence off: close conversationally; write nothing
- write/sealed pause: close conversationally; do not backfill
- continuity on: perform the steps below
- transcript state is independent and follows its own consent/coverage

## Close Transaction

1. Freeze the session ID and close timestamp.
2. Write the session note with exclusive create and truthful completion status.
3. Evaluate proposed memory changes using `MEMORY-INFLATION-GUARD.md`.
4. Apply only permitted memory writes with item-level provenance.
5. Treat behavioral learning as a proposal under `SELF-MODIFICATION.md`; do not silently edit base or overlays.
6. Write `NEXT-PRIMER.md` atomically from current permitted memory.
7. Finalize any transcript to its proven capture grade, retaining pause/gap metadata.
8. Use the typed close/control operation; its deterministic transaction updates applicable content-free consent/source/backup/change ledgers.
9. Mark the session closed and remove its checkpoint only after all required writes verify.

If a write fails, report the exact error, keep the checkpoint, and do not claim the session was durably closed.

## Memory Review

For each candidate, decide one canonical home:

- session note: meaningful but unfinished/context-specific
- current focus: near-term direction
- active theme: medium-term live thread/capacity
- profile: durable fact, preference, goal, strength, or bounded formulation
- archive: historical richness that should not auto-load

Do not duplicate statements between active layers; reference stable IDs. Source-derived items remain unconfirmed until the user confirms them live.

## Client-Told Scenes

If the user consented to scene memory and a concrete scene should persist, follow `CLIENT-TOLD-MEMORIES.md`: retain stable ID and first-told provenance, revise rather than move/delete, and separate user wording from model hypothesis.

## Next Primer

Keep it brief and non-diagnostic:

- user preferred name, if consented
- closed session ID and timestamp
- one-sentence current direction
- one live/unfinished thread
- optional carry-forward

Do not include deleted, expired, paused-window, raw transcript, source-only, disputed, or unapproved behavioral content.

## Experiments And Homework

Optional in every session structure.

- respect `allowed`, `ask_first`, or `off`
- make it small, concrete, and tied to live work
- observational is usually safer than corrective
- no task is a valid close
- non-completion is information, not failure or resistance by default

## Transcript Finalization

The current preview has no non-forgeable adapter attestation, so it never accepts caller-supplied proof of full coverage and never makes a verbatim claim. Label available context `best_effort_context` or `partial`. Never recreate paused/missing turns, and never include hidden instructions, tools, secrets, or internal reasoning.

## Backup Reminder

Use the bounded backup reminder returned by the typed session-close result; for a later check, use typed `backup_reminder` status. Do not guess from memory/session counts and do not access `.therapy/state/BACKUP-LEDGER.md` directly. When the close result reports that 10 persisted sessions have completed since the last verified backup, offer once. If the user declines, preview and explicitly confirm typed `backup_reminder` decline; it records 30-day suppression without opening or creating a backup artifact. Never remind more than monthly. A reminder does not create a backup without separate user authorization.
