<!-- version: 2.0.0 -->
# Context Graph

The optional context graph is a compact navigation layer for recurring people,
places, and events. It is not a psychological model, contact database,
surveillance record, or replacement for profile, themes, focus, sessions, or
sources.

## Consent, Retention, And Pause Gate

Every graph read and ordinary write requires all of the following current
canonical controls:

- `continuity_memory` is `on`
- `context_graph` is `on`
- `context_graph` retention is `until_deleted`; other persistence policies are
  unsupported by the current deterministic engine
- memory pause is `none`
- the current context-graph consent event is valid

Do not discover the index, enumerate entity filenames, read an entity, create a
candidate, or persist a graph change before this gate. Both `write_pause` and
`sealed_pause` stop graph reads and ordinary writes.

Forget and deletion are the exception: they remain available even when consent
is off, retention is disabled, or either pause is active. During `sealed_pause`,
perform only the mechanical deletion and derived-reference cleanup needed to
honor the request. Return content-free counts and random IDs; do not expose the
entity label, aliases, summary, source text, or nearby graph content.

## Scope And Third-Party Minimization

The schema supports only `person`, `place`, and `event`. Concept entities and a
`context/concepts/` directory are unsupported and must be rejected.

Use the smallest user-approved label and neutral context needed for navigation.
The schema deliberately has no address, contact, phone, email, account-handle,
routine-tracking, diagnosis, inferred-personality, or third-party clinical
fields. Do not hide those data classes inside a generic field. Prefer a role or
user-chosen pseudonym over a legal identity, and never investigate or enrich a
person from the network.

The graph may contain user-provided text in any language. Do not translate it
for storage merely to normalize the graph. Generated JSON uses NFC text and
Unicode code-point ordering, never locale-sensitive sorting.

## Canonical Ownership

Use exactly one canonical owner:

- `profile.md`: durable facts, preferences, goals, strengths, and bounded
  psychological formulations about the user
- `ACTIVE-THEMES.md`: medium-term reflective patterns and capacities
- `CURRENT-FOCUS.md`: near-term working direction
- `context/`: neutral navigation facts about recurring people, places, and
  events
- `sessions/`: chronological session bodies
- `sources/`: original imported material

The graph may reference stable memory, session, and source IDs; it must not copy
their formulations or source text. A neutral role such as “manager at current
job” may be graph context. A formulation such as “authority figures trigger
shame” belongs in themes or profile as a hypothesis.

## On-Disk Structure

```text
context/
  README.md
  index.md
  people/person-<uuid-v4>.json
  places/place-<uuid-v4>.json
  events/event-<uuid-v4>.json
```

IDs are lowercase and type-exact: `person-<uuid-v4>`, `place-<uuid-v4>`, or
`event-<uuid-v4>`. An ID never changes. A file path must match the entity type
and ID exactly. Symlinks, special files, unexpected directories, unknown
fields, duplicate keys/IDs, noncanonical JSON, and path traversal fail closed.

Entity files are generated JSON, never handwritten Markdown. They use two-space
indentation, the exact key order below, and one final newline:

```json
{
  "schemaVersion": 1,
  "type": "person",
  "id": "person-00000000-0000-4000-8000-000000000000",
  "status": "Provisional",
  "label": "minimal user-approved label",
  "aliases": [],
  "summary": "",
  "eventTime": null,
  "participantIds": [],
  "placeIds": [],
  "relatedEntityIds": [],
  "memoryIds": [],
  "consentEventId": "consent-00000000-0000-4000-8000-000000000000",
  "provenance": {
    "origin": "live",
    "firstObservedAt": "2026-01-01T00:00:00.000Z",
    "importedAt": null,
    "lastLiveConfirmedAt": null,
    "lastRelevantAt": "2026-01-01T00:00:00.000Z"
  },
  "sourceRefs": [],
  "sessionRefs": [],
  "revision": 1,
  "revisionHistory": [
    {
      "revision": 1,
      "at": "2026-01-01T00:00:00.000Z",
      "action": "add",
      "sessionId": null
    }
  ]
}
```

The example UUIDs are illustrative only; the generator must create fresh UUID-v4
identities. Person and place entities have `eventTime: null`,
`participantIds: []`, and `placeIds: []`. Event entities use exactly:

```json
{
  "value": null,
  "precision": "unknown"
}
```

or a bounded value with `exact`, `approximate`, or `range` precision. Never
turn an inferred chronology into an exact date.

Timestamps are real canonical RFC 3339 instants with millisecond precision.
Use `Z` while timezone is unconfirmed and the confirmed numeric UTC offset when
the workspace timezone contract requires it.

Consent, provenance, sources, and sessions remain separate:

- `consentEventId` identifies the graph consent that allowed creation
- `provenance` records only origin and factual timestamps
- `sourceRefs` contains exact `{sourceId, revision}` pairs
- `sessionRefs` contains exact `s-<uuid-v4>` IDs

An imported source proves only that the source said something. It is not a live
user confirmation.

## Status And Revision

- `Core`: rare, essential orientation that remains visible in the index
- `Active`: current recurring context that is normally visible
- `Provisional`: incomplete or imported context; never use it as fact
- `Dormant`: valid historical navigation context retrieved only on a specific
  trigger

Status is retrieval priority, not importance or truth. A status change is an
explicit revision; it does not change the stable ID. Correction replaces the
current wording, increments `revision`, and records only a content-free revision
event. Do not retain corrected-away wording in revision history.

Current explicit user correction outranks live confirmation, older live
confirmation, provisional live reports, imported source claims, and companion
inference, in that order. Never merge incompatible entities merely because
their labels match.

## Deterministic Index

`context/index.md` is generated from the validated entity set in the same
full-workspace staged transaction as every graph mutation. Never update entity
files first and repair the index later.

The header counts all entities by status. Visible rows are sorted by entity ID
using Unicode code-point order and capped as follows:

- Core: 12 visible, total count retained
- Active: 24 visible, total count retained
- Provisional: 10 visible, total count retained
- Dormant: count-only, with no default labels or IDs

Exceeding a display cap never deletes or silently demotes an entity.

At normal session start, read only `context/index.md` after the access gate.
Open the smallest relevant entity set for the live question; never auto-read all
entities.

## Operations

- `status`: content-minimized counts and capped visible IDs
- `show`: one exact entity after the read gate
- `add`: no-clobber creation with a fresh exact type ID
- `correct`: stable ID, current wording replacement, and revision increment
- `status-change`: explicit status transition and revision increment
- `forget`: delete entity content, aliases, index entry, and graph edges
- `merge`: preview both entities and proposed canonical result; require the exact
  confirmation token before retaining the chosen canonical ID, rewriting graph
  references, and deleting the duplicate

All core planners are read-only with respect to the filesystem. They return
relative `writes` and `deletes`; the caller combines them with canonical state,
projections, and operational receipts in one staged full-workspace transaction.
Create paths use no-clobber semantics. Existing entity revisions are replaced
only by the exact planned revision. Index writes are atomic at transaction
activation.

Merge and forget rewrite only derived graph references. They do not rewrite
historical session bodies or original/imported source bodies. Those records
remain under their own retention classes and must be reported separately when
they may still contain the underlying words.

When `usage_ledgers` is on with durable retention, a forgotten or merged-away
ID receives a content-free suppression receipt containing only the random
entity ID and already-known source revision/session IDs. It must not contain a
label, alias, summary, filename, content-derived hash, or reason text. When
usage ledgers are disabled, do not create a substitute receipt.

Known backups are separate copies. Report known backup records separately from
the live graph result and offer backup rotation; never imply that live deletion
erased offline, provider, snapshot, or third-party copies.

When a memory item is forgotten, mechanically remove its ID from graph
`memoryIds` in the same staged transaction, including during sealed pause. Do
not use that cleanup to read or rewrite historical source/session bodies.

## Supervised Backfill

Backfill is never automatic and never writes a scan result directly.

1. Pass the ordinary graph consent, durable-retention, and no-pause gate.
2. Scan only the user-approved session/source scope without changing it.
3. Produce one to five canonical candidate objects in memory.
4. Show their separate source/session provenance and possible duplicates.
5. Resupply the complete exact candidate set plus an explicit approved-ID set.
6. Bind the confirmation token to the workspace, every candidate byte, and the
   exact approved-ID set.
7. Write only explicitly approved candidates, always as `Provisional`.
8. Retain no rejected label, summary, alias, candidate record, or content hash.
9. Regenerate the index and verify graph links in the same transaction.

The confirmation call must resupply candidates; no pending-candidate file is
created. A changed rejected candidate also invalidates the token because the
token binds the complete reviewed set. Repeating an already-applied candidate
ID is idempotent and never clobbers the current entity.

For imported candidates, scan time is only `importedAt`. Keep
`firstObservedAt` and `lastLiveConfirmedAt` null until a current live user
statement supplies real evidence. Do not assign today as a legacy observation
or confirmation date.
