<!-- version: 3.0.0 -->
# Session Note Standard

Session notes are optional continuity records, written only when continuity consent is on and memory is not paused. Use `templates/sessions/SESSION-NOTE.template.md`.

## Identity And Filename

Follow `SESSION-LIFECYCLE.md`:

`sessions/YYYY-MM-DD-HHMMSS--<session-uuid>--session.md`

Use exclusive/no-clobber creation. Frontmatter records AI authorship, session ID, timezone-aware start/close timestamps, completion state, consent event, and optional transcript reference.

## Truth Standard

- Do not insert a default “No acute crisis disclosed.”
- Include a safety assessment only if it was actually conducted.
- Distinguish `User-Reported`, `Companion Observations`, and `Working Hypotheses` where needed.
- Text behavior is not proof of diagnosis, physiology, intent, truth, or absence of risk.
- Use `unknown` rather than a confident negative when evidence is missing.
- Preserve user wording for key phrases; label companion reframing separately.
- AI-authored content never inherits a human clinician's author fields.

## Recommended Shape

- lean target: 8–15 bullets, roughly 400–900 words maximum
- 1–3 main threads, not every topic mentioned
- current shifts and concrete carry-forward
- source IDs/references without pasting source content
- memory item IDs when the note updates or references durable memory
- optional between-session experiment only when consent/accessibility/structure precedence allows

## Dense Sessions

Put historical richness in a unique deep-dive artifact using the same session UUID and seconds-based timestamp. Create with no-clobber semantics and link it from the note. Do not create a date-only file that can overwrite another session.

## Multiple Sessions

Every session has its own UUID and note. Same-second sessions remain distinct. A continuation references the earlier session ID rather than duplicating it.

## Interrupted Sessions

When the user chooses `close interrupted`, set `completion: interrupted_partial`. Record only confirmed available material, state meaningful gaps, and never reconstruct a full session from a checkpoint.

## Retention And Deletion

Apply the `continuity_memory` retention policy. Expired or user-deleted notes are removed, not archived. Update derived indexes and primers so deleted content is not reintroduced. Backups remain separate copies.
