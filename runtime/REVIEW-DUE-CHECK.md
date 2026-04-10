<!-- version: 1.0.0 -->
# Review Due Check

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
