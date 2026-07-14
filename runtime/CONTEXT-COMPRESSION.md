<!-- version: 2.0.0 -->
# Context Compression

Compression keeps default context small while preserving consented, retained history and provenance. It is never a substitute for deletion, forgetting, or expiration.

## Gates

Before compression:

- continuity consent is on and memory is not paused
- retention is enforced first
- source/session/review IDs and integrity references are available
- the user has not asked to forget the material

Never include paused-window, expired, deleted, disputed-as-fact, or unauthorized transcript/source content in a summary.

## Suggested Triggers

- more than 30 active individual session notes
- more than 10 unconsolidated reviews
- profile no longer fits quick session-start reading
- the user or a review identifies context overload

Thresholds propose compression; they do not authorize sensitive writes outside consent.

## Session Consolidation

For fully completed past months:

1. create `sessions/YYYY-MM--<summary-uuid>--summary.md` with exclusive creation
2. record source session IDs, covered timestamps/timezone, creation timestamp, consent event, and AI authorship
3. summarize main threads, shifts, counter-evidence, unresolved items, and which stable memory IDs changed
4. verify that every referenced session ID exists and the coverage has no accidental omission
5. move originals only if retention permits; otherwise leave them and treat the summary as an index
6. keep recent 10–15 individual notes readily available

A summary does not become live confirmation of the items it mentions.

## Review Consolidation

Create `archive/reviews/YYYY-Q#--<summary-uuid>--review-summary.md`. Record all source review IDs and covered session IDs. Keep recent reviews individual. Update the review index only after verification.

## Profile Pruning

- keep durable active items and compact provenance in `profile.md`
- move consented historical detail to a unique archive artifact
- leave stable IDs/references in the deep-memory index
- preserve corrections and counter-evidence
- do not convert provisional/source-derived claims into facts through summarization

## Retrieval

Summaries are selective-access. Reopen when a current question, stable ID, or review scope points to them. Do not load all summaries at session start.

If the user deletes a source record, trace summaries and indexes that derived from it. Remove or rewrite affected content under the deletion rules rather than letting the summary resurrect it.

## Verification

After compression:

- check unique filenames and no-clobber creation
- verify source IDs and links
- confirm active layers do not duplicate the summarized statements
- confirm expired/deleted material is absent
- record only a content-free operational event if a ledger is used
