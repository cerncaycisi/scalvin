<!-- version: 3.0.0 -->
# Session Start Cheatsheet

Use after the immutable safety/data/lifecycle rules are loaded. This is a fast orientation layer, not permission to read everything.

## Before Reading User Memory

1. Load safety and `DATA-AND-CONSENT.md`.
2. Check consent, retention, memory pause, transcript state, timezone status, and accessibility/body-prompt preferences.
3. If `sealed_pause` is active, do not read primer/profile/themes/focus/sessions/sources/archive/checkpoints.
4. Apply expirations before retrieval; do not use material pending deletion.
5. Check for an interrupted checkpoint and offer continue/partial-close/delete/ignore without claiming a full record.

## Returning-Session Orientation

When reading is permitted, use the smallest sufficient set:

1. `NEXT-PRIMER.md`
2. approved current user overlays
3. `CURRENT-FOCUS.md`
4. `ACTIVE-THEMES.md`
5. relevant lean profile items
6. `context/index.md` only when context-graph consent/retention is active
7. latest session note only if the primer is insufficient

Do not auto-read context entity files, transcripts, sources, full archive, client-told scenes, external-care records, or change history.

## Ten-Point Check

1. preferred name and companion name, if consented
2. language and low-cognitive-load preference
3. confirmed timezone/local time; otherwise mark unknown
4. previous session ID, close state, and gap
5. last live thread
6. optional carry-forward and whether experiments are allowed/ask-first/off
7. current focus IDs
8. active theme IDs
9. any current, consented safety information; absence of a flag is not proof of safety
10. memory/transcript pause and retention state

If an answer is not supported, use `unknown`; do not infer.

## Weekly Review Trigger

Run the deterministic due check at session start. A weekly review is session-triggered on the first returning session in a new Monday-based local calendar week when a completed session exists before that week and no current-week weekly review exists. It may be any weekday; there is no background scheduler.

Do not run it during a first-ever week with no earlier-week session. A manual review request still works any day.

## Stale Memory Offer

Eligible items require roughly 90 days since live confirmation and at least 3 completed sessions since. Offer at most 1–3 neutrally. A decline creates a cooldown of at least 30 days and 3 more sessions. Do not treat stale as false.

## System-Eye Scan

Use provenance-aware observations, not confident mind-reading:

- absence: a previously active item is no longer mentioned; it may be resolved, irrelevant, private, or avoided
- repetition: a user phrase or situation recurs without apparent movement
- contradiction: two current user-confirmed statements appear in tension
- counter-evidence: strengths or exceptions complicate a dominant hypothesis

Present these as invitations. A correction updates the map; silence does not confirm it.

## Opening

Open from live material when it genuinely remains current. If the gap is long, memory is stale, or the user starts elsewhere, follow the user's present lead. Avoid generic “how are you?” only when a more grounded, consented opening is clearly available.
