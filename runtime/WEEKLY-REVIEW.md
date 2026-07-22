<!-- version: 4.1.0 -->
# Weekly And Interim Review

Reviews are consented, session-triggered reflection. They are not background jobs and do not silently rewrite memory or behavior.

## Canonical Weekly Rule

The user's confirmed timezone defines a Monday 00:00–Sunday 23:59:59 calendar week.

A weekly review is due at session start when all are true:

1. this is a returning workspace with at least one valid, completed session dated before the current week's Monday
2. no valid, completed, non-hidden weekly-review artifact exists with a creation date in the current week and not in the future
3. continuity persistence is on and memory is not paused
4. the user's IANA timezone is confirmed

It runs on the first returning session that meets those conditions, whether Monday, Tuesday, or any later weekday. If the user does not return, no review runs. There is no Tuesday-only catch-up window.

The canonical deterministic authority is the cross-platform Node command. It
is terminal-only in the development preview and runs from the retained public
checkout against the private workspace:

```bash
node bin/scalvin.js review-due --workspace "<workspace>" --timezone <confirmed-IANA-timezone>
```

`review_due_check.py` is a developer compatibility/reference implementation
and must maintain tested parity with the Node command; it is not a normal
user-facing fallback. `REVIEW-INDEX.md` is navigation only. The user may defer
or skip a due review. Record a content-free deferral so it is not repeatedly
pushed during the same session.

An unconfirmed device timezone may be shown as a candidate but cannot produce `DUE`. The explicit `--date YYYY-MM-DD` override may produce `DUE` only for deterministic tests; it is not a substitute for confirming the user's timezone during a real session.

## What Counts As Completed

For current seconds-plus-UUID filenames, the artifact must contain leading YAML frontmatter with exactly one standalone, top-level, unquoted marker:

```yaml
completion: complete
```

An empty file, filename-only placeholder, missing/malformed frontmatter, missing marker, duplicate marker, or any non-`complete` value is ignored for due-check purposes. `interrupted_partial`, `incomplete`, `active`, and similar values never count as complete.

Legacy `YYYY-MM-DD-HHMM.md` sessions and `YYYY-MM-DD-HHMM-weekly-review.md` reviews remain compatible only when nonempty. A nonempty legacy artifact without a standalone top-level completion marker may count because old versions did not write the field. If a legacy artifact contains such a marker, it counts only when there is exactly one unquoted marker with value `complete`; an explicit incomplete or duplicate marker never counts.

This compatibility rule does not upgrade or rewrite legacy records. New artifacts never receive the legacy exception.

## Review Types

### Weekly

Looks across the period since the prior weekly review, emphasizing the previous completed week. It checks continuity, drift, counter-evidence, context health, stale items, and optional change proposals.

### Interim

Runs only on explicit request or a consented significant trigger such as major source integration, reformulation, rupture, or architecture concern. It focuses on that trigger rather than repeating a weekly review.

### Manual

Runs whenever the user requests a review, reset, audit, or pattern check. Manual review is not proof that the automatic weekly review occurred unless saved as a weekly artifact for the current week.

## Read Scope

Respect consent, retention, and sealed pause. Start with:

- profile, active themes, current focus
- session notes since the prior review
- prior weekly review and approved current overlays

Open older archive/source records only when a specific review question requires them. Do not auto-read transcripts or external-care records without their separate permitted scope.

## Artifact Identity

- weekly: `archive/reviews/YYYY-MM-DD-HHMMSS--<review-uuid>--weekly-review.md`
- interim: `archive/reviews/YYYY-MM-DD-HHMMSS--<review-uuid>--interim-review.md`

Use confirmed timezone, seconds, UUID, and exclusive/no-clobber creation. Frontmatter includes review ID, created timestamp/timezone, sessions covered, consent event, and completion status. Write `completion: complete` only after the artifact body and required index/state updates have succeeded; a partial write remains explicitly incomplete and cannot suppress a future review.

## Review Questions

- What repeated, shifted, disappeared, or contradicted the current map?
- What healthy capacities or counter-examples complicate wound-focused formulations?
- Which item is source-derived, disputed, duplicated, overconfident, or in the wrong layer?
- Which items meet the ~90-day plus 3-session stale-review threshold?
- Is context near compression thresholds?
- Did any interaction preference or repair pattern merit a user-visible change proposal?
- Are retention expirations or known backup reminders due?

Absence is not avoidance by default. Stale is not false. A source claim is not live confirmation.

## Output

```markdown
---
record_kind: ai_authored_weekly_review
review_id: review-<uuid>
created_at: YYYY-MM-DDTHH:MM:SS+HH:MM
timezone: Area/City
covered_session_ids: []
consent_event_id: consent-<uuid>
completion: complete
---

# Weekly Review

## Recurring Or Shifting Patterns

## Emerging Or Dormant Themes

## Counter-Evidence And Healthy Capacities

## What May Be Over-Interpreted

## Stale-Memory Offers

## Proposed Memory Changes

## Proposed Behavioral Changes

## Suggested Focus

## Context And Retention Health
```

Proposals include stable IDs and concise before/after wording. Do not include a raw transcript or source dump.

## Approval Boundary

- Memory writes still require active consent and provenance.
- A user correction applies immediately under the correction command.
- Behavioral/persona/moveset/source-trigger changes require `SELF-MODIFICATION.md` proposal approval.
- A weekly review cannot approve its own proposals.
- If nothing should change, say so.

Update `REVIEW-INDEX.md` only after the review artifact is successfully created and verified.
