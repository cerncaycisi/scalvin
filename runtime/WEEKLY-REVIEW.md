<!-- version: 1.0.0 -->
# Weekly Review Standard

Use this workflow for a meta-review of the therapy process.

This is not a normal session.

## When To Run

### Weekly Review

The current review week means the 7-day period starting Monday 00:00 in the user's local time.

On any session start, if today is Monday and no weekly review exists for the current review week, create one before entering the normal session.
If Monday was missed, allow the next session on Tuesday to create a late weekly review, but only if no weekly review exists for that week yet.
Determine this from actual non-hidden `archive/reviews/*-weekly-review.md` files for the current review week.
Ignore hidden metadata files such as `._*`, and ignore any weekly-review file dated later than today.
Use `archive/reviews/REVIEW-INDEX.md` as an orientation layer for reading order, not as the authoritative due-check.

### Interim Review

An interim review may be created between two weekly reviews when one of the following occurs:

1. a major new source has been integrated
2. a significant narrative shift or major reformulation has occurred
3. a change to system architecture is needed that would affect profile, active themes, current focus, or runtime logic

Do not create more than one interim review between two weekly reviews unless there is a truly major source integration or clinical shift.

### Manual

Run the review workflow whenever the user explicitly asks for a review, reset, audit, or pattern check.

## Files To Review

- `profile.md`
- `ACTIVE-THEMES.md`
- `CURRENT-FOCUS.md`
- relevant living operational layers if the review is about process drift
- all session files in `sessions/`
- relevant archive files in `archive/`
- prior weekly and interim reviews in `archive/reviews/`
- important source materials in `sources/` when they are part of the ongoing record

This review should be broad and integrative, not minimal.

## Where To Save Review Outputs

- weekly reviews: `archive/reviews/YYYY-MM-DD-HHMM-weekly-review.md`
- interim reviews: `archive/reviews/YYYY-MM-DD-HHMM-interim-review.md`
- after saving a review, update `archive/reviews/REVIEW-INDEX.md`

## Goals

- detect repeated patterns that may be missed in single sessions
- identify themes that are no longer active
- identify themes that should be promoted into `ACTIVE-THEMES.md`
- identify profile statements that are outdated, overconfident, too broad, or no longer useful
- audit whether `profile.md` has become too dense, redundant, or over-formulated
- notice contradictions, drift, or over-formulation
- identify counter-evidence, healthy capacities, and material that does not fit the dominant wound narrative
- propose a cleaner therapeutic focus for the next phase
- notice operational drift in the live moves, disambiguation habits, rupture/repair handling, source logic, or memory hygiene

## Output Structure

```markdown
# Weekly Review - YYYY-MM-DD-HHMM

## Recurring Patterns
- 3 to 7 bullets

## Emerging Themes
- 1 to 5 bullets

## Themes To Downgrade Or Close
- 0 to 5 bullets

## Counter-Evidence / Healthy Signals
- 1 to 5 bullets

## What May Have Been Over-Interpreted
- 0 to 5 bullets

## Profile Update Suggestions
- concise suggestions only

## Active Themes Update Suggestions
- concise suggestions only

## Suggested Focus For The Next Week
- 2 to 5 bullets
- if no focus change is needed, say so explicitly
```

## Update Rules

- do not automatically rewrite everything
- only update `profile.md` and `ACTIVE-THEMES.md` if the review produces clear, useful, durable improvements
- if `profile.md` has become heavy or archive-like, compress it back toward lean core memory
- prefer small edits over large rewrites
- if nothing important changed, say so plainly
- if reviews show process drift rather than content drift, selectively update the relevant living operational layer instead of forcing the fix into profile/themes/focus
