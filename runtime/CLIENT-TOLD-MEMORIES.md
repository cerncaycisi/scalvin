<!-- version: 1.0.1 -->
# Client-Told Memories

A living source file that the companion creates and maintains as the client recounts specific remembered scenes across sessions. Not present at bootstrap -- comes into being the first time the client tells a concrete, memorable episode that is likely to matter again.

This is different from other source files in two ways:

1. **The companion creates and writes it**, not the client. The client brings scenes verbally; the companion logs them.
2. **It grows session by session** rather than being imported once.

## When To Create The File

Do not create `sources/client-told-memories.md` on bootstrap. Create it the first time the client tells a specific remembered scene during a session that meets the criteria below.

## What Counts As A Scene Worth Logging

A scene is worth logging when:

- It is a specific episode or moment, not a summary or generalization
- It has enough texture that the client might want to return to it in a later session
- Losing it would reduce continuity -- the clinical value of the scene outlives the session it was first told in
- The scene clarifies something durable about the client's pattern, relationships, or self-understanding

What does not count:
- Generic statements ("my childhood was hard")
- Pure emotional summary without concrete content
- Scenes the client themselves flags as unimportant or already processed

## Structural Rules

- Each entry is self-contained under its own `###` heading
- Entries are grouped under `##` headings by date (`## 2026-04-22`) for the session the entry was logged in
- Never split one entry's content across sections
- Orphan bullets (bullets that appear between two `###` headings without belonging to either) are a structural error -- every bullet belongs to exactly one entry
- After appending, visually verify that the last entry in each date section ends cleanly

## Entry Format

Each entry should include:

- A short descriptive heading that names the scene (`### The phone call in 2019`)
- The scene itself in a few lines -- enough to reconstruct what the client told, in their own words where possible
- Optional: a brief clinical note about why this scene matters (separate from the scene itself, clearly marked)

## Updating Existing Entries

If a new session deepens an existing logged scene:

- Do not keep both the old and expanded entries
- Replace the old entry with the expanded version under the new date heading
- Delete the original entry from its old date section

Duplicates create confusion. One scene, one entry, under the most recent date it was told or deepened.

## Language Fidelity

When logging a scene, use the client's own words for the key phrases. Paraphrase the surrounding narrative but preserve verbatim any phrase the client used to name the scene or its meaning.

## Access Rules

- The companion may consult `sources/client-told-memories.md` when a scene is clinically relevant to the current session's material
- The companion does not read through the entire file at session start -- it is referenced selectively, like any other source
- `.therapy/runtime/SOURCE-TRIGGERS.md` may gain an entry for this file once it exists, describing when to reopen it
