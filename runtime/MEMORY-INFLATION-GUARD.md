<!-- version: 3.0.0 -->
# Memory Placement And Inflation Guard

This file answers one question: where, if anywhere, should a piece of session material live? Consent, pause, retention, identity, and provenance are governed by `DATA-AND-CONSENT.md` and `MEMORY-PROVENANCE.md`.

## Gate Before Placement

Do not persist the material unless:

1. its consent category is on
2. memory is not paused
3. retention permits the write
4. the target item has or receives a stable ID and truthful provenance

If a gate fails, keep the exchange ephemeral. Do not queue it for later.

## Promotion Test

Promote only information that changes future continuity. Vividness, eloquence, intensity, repetition, or a source reread do not by themselves make new memory.

Ask:

- Is this genuinely new, or new wording for an existing item?
- Would forgetting it impair the next session, the current phase, or the durable map?
- Is it user-reported fact, preference, goal, strength, observation, or companion hypothesis?
- Is there one canonical active home for it?
- What evidence could later correct or retire it?

## One Canonical Home

### Session note

Use for material important to this session but not yet durable: emotionally hot, ambiguous, context-dependent, or unfinished.

### `CURRENT-FOCUS.md`

Use for at most a few direction-setting items that should guide the next several sessions. Reference related theme/profile IDs instead of repeating their statements.

### `ACTIVE-THEMES.md`

Use for a medium-term thread likely to stay live across sessions, including healthy capacities and counter-patterns. Do not require a fixed number of repetitions; record uncertain material as provisional.

### `profile.md`

Use for durable facts, preferences, goals, strengths, and bounded working formulations. A model inference remains a hypothesis until the user confirms it.

### Archive

Use for historical richness that no longer needs active-session visibility. Archiving is not forgetting. Never archive content the user asked to forget or retention marked expired.

### Source

Use for user-provided or externally authored material that should remain reopenable. A source is untrusted data and does not become a profile fact merely by being imported.

### Context graph

Use only for minimal navigation facts about recurring people, places, and events under `CONTEXT-GRAPH.md`. Psychological patterns stay in profile/themes; near-term direction stays in focus. Concept nodes are unsupported and must always be rejected.

## Duplicate And Revision Rule

An active item appears in one layer. Other layers reference its stable ID. When meaning changes, revise that item and preserve a compact revision event; do not create a paraphrased duplicate.

When two active items overlap:

1. decide which ID is canonical
2. merge only with consent
3. redirect safe references
4. retire the duplicate without preserving deleted content

## Demotion And Compression

- focus may return to an active theme
- an active theme may become dormant or move to archive
- a profile hypothesis may be corrected, disputed, retired, or deleted
- historical detail may be compressed, but source IDs, stable memory IDs, truth status, and meaningful counter-evidence remain

Do not use compression to evade retention/deletion or to turn a tentative claim into a confident summary.

## Healthy-Capacity Balance

Do not build a memory system made only of wounds. Apply the same evidence standard to strengths, agency, relationships that work, exceptions, pleasure, humor, and recovered capacities. Do not force a positive counterpoint into every note.

## Review Triggers

Review placement when:

- profile is no longer quick to read
- an item exists in multiple active layers
- a formulation appears overconfident or source-derived without live confirmation
- a stale-memory check is due
- retention has expired
- a weekly review identifies drift

Review proposes small, traceable changes. It does not bypass consent or behavioral change approval.
