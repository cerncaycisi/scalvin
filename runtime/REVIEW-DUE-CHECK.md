<!-- version: 3.1.0 -->
# Review Due Check

## Canonical Rule

A weekly review is due on the first returning session in a new Monday-based local calendar week when:

- at least one valid, completed session exists before the current week's Monday
- no valid, completed, non-hidden, non-future weekly-review artifact was created in the current week
- the user's IANA timezone is confirmed

This is session-triggered, not scheduled. It applies on any weekday. A first-ever week with no earlier-week session is not due. Manual reviews remain available any day.

An unconfirmed system timezone cannot produce `DUE`; confirm the user's timezone first. The explicit `--date` override may produce `DUE` for deterministic tests without a timezone, but must not be used as a production-session substitute.

Consent and pause are checked by session runtime before invoking the tool; the tool only answers calendar/artifact state.

## Preferred Command

Use the cross-platform Node CLI and pass the confirmed IANA timezone from `.therapy/state/DATA-CONTROLS.md`:

```bash
scalvin review-due --workspace . --timezone Europe/Istanbul
```

Deterministic test override:

```bash
scalvin review-due --workspace . --date 2026-07-14
```

`review_due_check.py` is a compatibility/reference implementation for environments that already have Python 3; it is not the cross-platform default:

```bash
python3 .therapy/runtime/review_due_check.py \
  --sessions-dir ./sessions \
  --reviews-dir ./archive/reviews \
  --timezone Europe/Istanbul
```

## Artifact Validity

Current-format artifacts are counted only when they use the expected seconds-plus-UUID filename and leading frontmatter contains exactly one standalone, top-level, unquoted `completion: complete` field. Empty files, incomplete artifacts, missing/malformed frontmatter, missing markers, and duplicate completion fields are ignored.

Legacy compatibility is deliberately narrower:

- a legacy artifact must contain non-whitespace content
- without any standalone top-level completion marker, it may count because older versions did not emit one
- with such a marker, it counts only when exactly one unquoted marker says `complete`
- an explicit incomplete/non-complete or duplicate marker never counts

Future-dated artifacts never satisfy today's check. Hidden metadata is ignored. Symlinks, unreadable entries, invalid dates/timezones, missing directories, and non-directory paths remain explicit errors rather than silent `NOT_DUE` results.

## Output Contract

- `STATUS=DUE` or `STATUS=NOT_DUE`
- `TODAY`
- `REVIEW_WEEK_START`
- `TIMEZONE`
- `TIMEZONE_STATUS=confirmed|unconfirmed|date_override` (`unconfirmed` can never accompany `DUE`)
- `REASON`
- `MATCHES`
- `PRIOR_SESSION_MATCHES`

Errors are explicit and exit nonzero. Missing directories, non-directory paths, invalid dates/timezones, and unreadable entries are errors; the tool must not silently convert them to `NOT_DUE`.
