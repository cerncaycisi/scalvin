<!-- version: 1.0.0 -->
# Memory Provenance And Review

This is the authority for item-level identity, evidence, revision history, and stale-memory review in `profile.md`, `ACTIVE-THEMES.md`, `CURRENT-FOCUS.md`, and companion-maintained client memories.

## Core Principles

- A formulation is a hypothesis unless the user explicitly confirms it.
- Imported material proves only that a source said something; it is not live confirmation by the user.
- Every durable item has a stable ID and its own dates. Do not assign one bulk date to multiple legacy items.
- Never fabricate when something was first learned or last confirmed.
- New evidence revises an item; it does not silently rewrite its history.
- The current user's correction outranks an older model inference.

## Required Item Fields

Each durable item uses a stable prefix appropriate to its canonical home: `mem-<uuid>`, `theme-<uuid>`, or `focus-<uuid>`. Client scenes use `mem-<uuid>`. All use this compact block (with layer-specific fields added after it):

```markdown
### <mem|theme|focus>-<uuid> — Short human title

- Statement: concise current wording
- Kind: reported_fact | preference | goal | strength | theme | focus | working_hypothesis | client_scene
- Status: user_confirmed | observed | provisional | stale_review_due | disputed | retired
- First observed: YYYY-MM-DDTHH:MM:SS+HH:MM | unknown
- First session: s-<uuid> | imported
- Imported at: YYYY-MM-DDTHH:MM:SS+HH:MM | null
- Source IDs: [src-<uuid>] | []
- Last live confirmed: YYYY-MM-DDTHH:MM:SS+HH:MM | never | unknown
- Last confirmed session: s-<uuid> | null
- Confidence: user_stated | corroborated | tentative
- Review state: current | due | declined_until_YYYY-MM-DD
- Current revision: 1
```

Keep the human statement short. Revision detail belongs in an item's compact `Revision history` list or a content-controlled change ledger, not duplicated across memory layers.

For legacy content whose original date is unavailable, use `unknown`; the migration timestamp goes only in `Imported at`. Never use migration/import time as `First observed` or `Last live confirmed`.

## Revision Rules

An item retains its stable ID for its lifetime.

```markdown
#### Revision history

- r1 — YYYY-MM-DDTHH:MM:SS+HH:MM — created from live report in s-…
- r2 — YYYY-MM-DDTHH:MM:SS+HH:MM — user correction in s-…; prior wording retired
```

Revision notes must be factual and brief. Do not preserve deleted sensitive wording in the history after a forget/delete request. In that case retain only a content-free event such as `r3 — user-requested removal completed`.

If two items are duplicates, choose one canonical ID, redirect safe references, and retire the duplicate ID without copying sensitive content into a ledger.

## Layer Placement

- `profile.md`: durable user facts, preferences, goals, strengths, and carefully bounded working formulations
- `ACTIVE-THEMES.md`: medium-term threads that remain live across sessions
- `CURRENT-FOCUS.md`: the small set of near-term, direction-setting items
- session note: meaningful but not yet durable material
- archive: rich historical context that no longer belongs in active memory

An item has one canonical active home. Other layers reference its ID instead of duplicating the statement.

## Live Confirmation

Live confirmation requires a current user statement that clearly affirms the item. Mere silence, lack of correction, model agreement, repeated source text, or conversational continuation does not count.

When the user confirms:

- set `Last live confirmed` to the actual timestamp
- set `Last confirmed session` to the current session ID
- append a revision event only if the wording or status changed

When the user disputes an item, mark it `disputed` immediately and stop using it as an interpretive premise. Resolve, correct, or delete it based on the user's choice.

## Stale Review

An item is eligible for a neutral stale review only when both are true:

1. at least about 90 days have passed since `Last live confirmed`; and
2. at least 3 completed sessions have occurred since that confirmation.

Items with `never` or `unknown` confirmation may be reviewed after 3 subsequent sessions, but introduce them as imported/legacy material, not old truths.

Offer, do not interrogate:

> I have an older note that says [short neutral wording]. Does that still fit, should I change it, or would you rather leave it alone?

Ask about no more than 1–3 stale items in a normal session. Do not turn a support session into database maintenance.

If the user declines review:

- leave the item unchanged
- record `review_declined_at`
- do not ask again until both at least 30 days and at least 3 more completed sessions have passed
- if the user says “don't ask me about this again,” suppress review until they reverse that choice

Stale does not mean false. Do not demote or delete an item only because it was not discussed recently.

## Profile, Theme, And Focus Updates

Before writing:

1. confirm the relevant persistence category is on and not paused
2. decide whether this is a new item, revision, or session-only material
3. assign or retain a stable ID
4. record actual provenance and confidence
5. avoid duplicating the item in another active layer
6. if the content came from a source, link its source ID and keep `Last live confirmed: never` until the user confirms it live

Early sessions do not waive provenance or consent. They may produce more provisional items, not more confident ones.

## Client-Told Scene Memories

Concrete scenes use stable `mem-<uuid>` IDs and retain their first-told history.

When a later session adds detail:

- keep the original ID, `First observed`, and `First session`
- update `Last revised` and increment `Current revision`
- append the new session ID and a brief revision note
- do not move the scene under a new date or delete its first-told provenance
- preserve user wording where consent allows, clearly separating user words from companion interpretation

One scene has one canonical record. If the user asks to forget it, remove the content and all retrieval references under the deletion rules.
