<!-- version: 1.0.0 -->
# Source Triggers

*This file explains when the companion should reopen source materials from `sources/`. It is a living file and should be extended as new source documents are added.*

## General Rule

- do not reopen source materials casually
- reopen them when the current session clearly touches a theme that a source can illuminate better than memory alone
- use the smallest relevant source set, not everything at once
- do not build a strong interpretation from one narrow snippet if the source is central to the question
- for short sources, read the full file
- for long sources, read the relevant document in sequential chunks rather than sampling one excerpt and guessing
- if a source has a companion retrieval map, it may be used first to locate relevant passages quickly, but it does not replace reopening the underlying source text
- if only one excerpt was read from a long source, keep the interpretation explicitly provisional

## When A New Source Is Added

When a new document is placed in `sources/` -- whether by the companion during an import, or because the user asks to add material -- the following chain runs automatically within the same session or session-close:

### Step 1: Read The Source

- for short sources (under about 5000 words): read the full file
- for long sources: read in sequential chunks to cover the full document, then summarize before interpreting
- do not sample one excerpt and treat it as representative

### Step 2: Extend This File

Add a dedicated section for the new source in this file following the format:

```markdown
## `sources/filename.md`

Reopen when the session centers on:

- ...
- ...

Use principle:

- ...
```

If the source has a companion retrieval map, note that in the section.

### Step 3: Assess Profile And Theme Impact

Determine whether the source material:

- introduces durable new information that belongs in `profile.md`
- introduces or reshapes a medium-term therapeutic thread that belongs in `ACTIVE-THEMES.md`
- changes the near-term working direction in `CURRENT-FOCUS.md`

Apply updates where justified. Follow the placement rules in `.therapy/runtime/MEMORY-INFLATION-GUARD.md`.

### Step 4: Write An Interim Review If Warranted

If the source is major (a full autobiographical text, a clinical report, substantial relationship material, or a large quantitative dataset), write an interim review in `archive/reviews/` following `.therapy/runtime/WEEKLY-REVIEW.md`.

If the source is minor (a short note, a single document, or a small addition), skip the interim review and let the next weekly review absorb it.

### Step 5: Notify The User Simply

Do not dump a technical summary. Instead, acknowledge the source naturally:

- "I've read through that. It gives me a much clearer picture of [theme]."
- "That's useful material. I'll keep it in mind when [relevant topic] comes up."

Do not list file operations, path names, or review procedures.

## Do Not Reopen A Source When

- `CURRENT-FOCUS.md`, the latest session note, and the relevant active themes already hold enough context for the live question
- you are reaching for a source mainly to reconfirm something that is already well established
- the urge to reopen is atmospheric, archival, or reassurance-seeking rather than driven by a specific clinical question
- the client is in immediate feeling and the source would mostly pull the work upward into explanation
- you do not yet know what exact question the source is supposed to answer

When in doubt during a normal session, stay with live material first and source retrieval second.

## How To Extend This File

When a new meaningful source is added to `sources/`, create a new section for it:

```markdown
## `sources/file-name.md`

Reopen when the session centers on:

- ...
- ...

Use principle:

- ...
```

If a source has a companion map, note that in the section.
