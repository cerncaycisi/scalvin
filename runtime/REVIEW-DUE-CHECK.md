<!-- version: 2.0.0 -->
# Review Due Check

## Purpose

Check whether a weekly review is due today, and if so, whether it should be conducted at the start of this session. This is a deterministic check -- not a judgment call -- so that review timing does not depend on the companion's in-session mood or the client's initiative.

## Output Contract

Running the check must produce one of three clear states:

1. **No review due** -- proceed with the normal session
2. **Weekly review due** -- conduct the weekly review before the normal session flow
3. **Late review allowed** -- Monday was missed but today is still within the catch-up window; conduct the review before the normal session flow

The check should never return an ambiguous state. If the logic cannot determine the state, default to "no review due" and let the user or the weekly-review trigger take over.

*This is the technical layer for deciding whether a weekly review is due. It is not a therapy-content layer, but it may be updated when review cadence, naming rules, timezone logic, or folder behavior changes.*

## Canonical Rule

- whether a weekly review is due must be determined from actual non-hidden `archive/reviews/*-weekly-review.md` files for the current review week
- do not decide this from memory
- do not decide this from `archive/reviews/REVIEW-INDEX.md` alone
- ignore hidden metadata files such as `._*`
- ignore any weekly-review file dated later than today

## Current Review Week

- the current review week starts Monday 00:00 in the user's local timezone
- Monday: if no weekly review file exists for the current review week, weekly review is due
- Tuesday: if Monday was missed and no weekly review file exists for the current review week, a late weekly review is due
- any other day: no weekly review is automatically due, though manual review requests still override

## Deterministic Tool

Preferred check:

```bash
python3 .therapy/runtime/review_due_check.py
```

Optional date override:

```bash
python3 .therapy/runtime/review_due_check.py --date 2026-04-14
```

## Update Triggers

Update this file when:
- the weekly cadence changes (for example, user asks for biweekly reviews)
- the catch-up window needs to shift
- a new review type is added that also needs a due-check

Do not change the logic on the basis of a single missed review -- use the standing catch-up rule instead.
