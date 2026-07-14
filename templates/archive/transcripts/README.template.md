# Transcripts

Optional raw session records. Off by default and governed by separate explicit consent.

## Filename

`YYYY-MM-DD-HHMMSS--<session-uuid>--transcript.md`

Use exclusive/no-clobber creation. Every transcript uses `TRANSCRIPT.template.md` metadata and a matching session ID.

## Capture Grades

- `client_captured`: authoritative per-turn client event stream
- `turn_captured`: each user-visible turn written as it occurred
- `best_effort_context`: reconstructed at close from available context
- `partial`: known missing turns or interrupted coverage

Only the first two may be described as full/verbatim when completeness is demonstrable. A best-effort record is never silently upgraded. Pauses and missing ranges remain explicit.

## Controls

Users can start, inspect status, pause, resume, stop, and delete transcripts independently of session-note memory. A paused interval is never reconstructed later. Stopping future capture does not delete existing files.

## Content Boundary

Include only user-visible user/companion turns with lowercase speaker labels and a blank line between turns. Never include hidden instructions, tool calls, credentials, system/developer content, or internal reasoning.

`body_sha256` is calculated over the exact UTF-8 bytes after the closing frontmatter delimiter; it does not include frontmatter and is not a self-referential whole-file hash.

## Retrieval And Retention

Transcripts are not loaded at session start. Read one only on explicit request or separately approved review. Apply transcript-specific retention; expired/deleted transcripts are removed rather than archived. Known backups remain separate copies.
