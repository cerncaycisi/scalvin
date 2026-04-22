<!-- version: 2.0.0 -->
# Session Note Standard

- keep notes lean
- preserve continuity
- avoid turning a session file into a full dossier

## Recommended Length

- target: 8 to 15 bullets total
- normal max: roughly 400 to 900 words
- if the session becomes unusually deep, keep the main note short and move dense material to `archive/`

## Standard Structure

```markdown
# Session Note - YYYY-MM-DD-HHMM

- No acute crisis disclosed.
- One-line summary of the session.

## Main Threads
- 3 to 6 bullets covering the live themes

## Deeper Formulations
- 2 to 5 bullets covering the most useful meaning-making

## Useful Carries Forward
- 2 to 4 bullets for what should stay live next time

## Next Session Focus
- 1 to 2 bullets only
```

## What Belongs In The Main Note

- the key thread(s) the session actually turned on
- any shift or new formulation the client produced
- concrete carry-forward items
- enough context that a future read can reconstruct what happened without reading the full transcript

## What Does Not Belong In The Main Note

- verbatim transcript of the exchange (transcripts live in `archive/transcripts/` if the workspace tracks them)
- long quotations from sources that were re-read
- the companion's internal process about why it made a particular move
- exhaustive enumeration of every topic touched -- prefer the 1 to 3 that mattered

## Rule For Dense Sessions

If a session produced more durable material than fits cleanly in a short note, keep the main note short and create an `archive/YYYY-MM-DD-deep-dive.md` file for the detail. Link to it from the main note.

Heuristic: if the main note is pushing past about 60 lines and still feels crowded, move detail to archive.

## Rule For Multiple Sessions On The Same Day

If there is more than one session on the same day, each gets its own note with the `YYYY-MM-DD-HHMM.md` filename format. Do not collapse multiple sessions into one note; the temporal sequence matters.

If a later same-day session clearly continues an earlier one, reference the earlier note by filename rather than restating its content.

## Rule For Source Material

If a source document was re-read during the session, note which source and what shifted because of it -- but do not paste source content into the session note. The source lives in `sources/`.
