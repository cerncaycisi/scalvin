<!-- version: 1.0.0 -->
# Context Compression

This layer governs how the workspace manages growing context over time. The companion reads this when compression thresholds are approaching and applies the rules to keep the working context readable without losing history.

## When To Compress

Compress when any of these is true:

- `sessions/` contains more than 30 session files
- `archive/reviews/` contains more than 10 review files
- a weekly review reports difficulty holding all context at once
- `profile.md` has grown past the point of being readable at session start

## Session Consolidation

When `sessions/` exceeds 30 files:

1. Group older sessions into monthly batches
2. Write a summary for each batch to `sessions/YYYY-MM-summary.md`
3. Each summary should capture: main threads of the month, key shifts, important carry-forwards, and what fed into profile or themes changes
4. Move the original individual session files to `archive/sessions/YYYY-MM/` (create the subdirectory)
5. Keep the most recent 10 to 15 individual session files in `sessions/` untouched

Do not consolidate the current month -- only fully-completed past months.

## Review Consolidation

When `archive/reviews/` exceeds 10 files:

1. Write a consolidated summary covering the oldest batch to `archive/reviews/YYYY-Q#-summary.md` (quarterly is a reasonable cadence)
2. Move the individual reviews that fed the summary into `archive/reviews/history/`
3. Keep the most recent 4 to 5 reviews as individual files

## Profile Pruning

When `profile.md` has grown past session-start readability:

- Move historical detail to `archive/profile-detailed-YYYY-MM-DD.md`
- Keep `profile.md` lean and current
- Update the Deep Memory Index in `profile.md` to point at the archived detail

## Compression Frequency

Run when thresholds are crossed, not on a schedule. The companion may suggest compression during a weekly review if thresholds are close but not yet exceeded.

## Principle

Compression serves readability. The goal is not to lose information but to layer it -- lean core for session start, consolidated summaries for medium-term, full originals in archive for deep detail.
