<!-- version: 1.0.0 -->
# Session Close Review

Use this workflow at the end of every normal session.

This is a brief memory review, not a full archive-wide meta-review.

## Purpose

- place important material into the correct memory layer
- keep medium-term threads alive
- prevent drift, clutter, and missed carry-forward points
- govern what gets updated after the session note is written

## What To Review

- the current session
- `profile.md`
- `ACTIVE-THEMES.md`
- `CURRENT-FOCUS.md`
- any relevant living operational layer if the session exposed a process issue:
  - `.therapy/runtime/LIVE-MOVESET.md`
  - `.therapy/runtime/DISAMBIGUATION-GRID.md`
  - `.therapy/runtime/MEMORY-INFLATION-GUARD.md`
  - `.therapy/runtime/RUPTURE-AND-REPAIR.md`
- the most recent session note if helpful
- any clinically meaningful somatic state that shaped the session
- any healthy, non-defensive, or counter-pattern material that should remain visible

Do not reread the full archive by default.

## Decision Rules

### Update `profile.md` When

- something seems durable beyond the current session
- something appears structurally important to the person's ongoing psychology
- something is likely to matter again in future sessions

### Update `ACTIVE-THEMES.md` When

- a theme seems likely to remain clinically alive beyond the current session
- an existing theme meaningfully changed, deepened, narrowed, or resolved
- a healthy or non-wound thread becomes a live medium-term part of the work

### Update Only The Session Note When

- the material feels important for continuity but not yet durable
- the material is unfinished and should stay warm without being elevated

### Move Detail To `archive/` When

- richness is useful but would overload the main session note
- multiple major continuations happened in one day
- dense source-text interpretation would clutter the active memory layers

### Update A Living Operational Layer When

- the live moves felt missing, stale, too ritualized, or newly effective
- an important line was repeatedly confused with the wrong theme
- the relationship needed a repair move that should be remembered
- the memory system showed fresh inflation, duplication, or wrong-layer promotion

## Companion Self-Evolution

The companion is expected to evolve its own operational files as it learns the user. This is not optional maintenance; it is how the system matures.

### Persona Adjustments

When the companion notices repeated relational patterns with the user across 2 to 3 sessions, it should update `.therapy/persona.md` by adding a `## Client-Specific Adjustments` section at the end.

This section should capture things like:

- if the client consistently uses analysis as a defense, note the specific patterns and what interventions work
- if the client responds poorly to certain phrasings, note what to avoid
- if the client has a distinctive humor style that matters therapeutically, note how to work with it
- if the client has specific "solved it" exit phrases, list them
- if output length matters, note that

Do not replace the base persona. Add to it. The base persona is the starting character; the client-specific section is the learned relationship.

Review and potentially update this section during weekly reviews.

### Source Triggers

When a new source document is added to `sources/`, extend `.therapy/runtime/SOURCE-TRIGGERS.md` with a dedicated section for that source.

The section should include:

- what themes or questions should trigger reopening this source
- any usage principles specific to this source
- what the source should not be used for

Do not wait for a review cycle to do this. Add the section as soon as the source is integrated.

### Disambiguation Grid

When a confusion between two therapeutic lines keeps recurring and is not yet captured in `.therapy/runtime/DISAMBIGUATION-GRID.md`, add a new entry.

Each entry needs:

- markers that signal this line
- a first question to separate it from what it gets confused with

If an existing entry has become stale or inaccurate, update or remove it.

### Live Moveset

When a specific intervention style proves repeatedly effective or ineffective with this user, update `.therapy/runtime/LIVE-MOVESET.md`.

This includes:

- adding new move categories that the existing 9 do not cover
- customizing example phrasings in the user's preferred language
- noting moves that have become ritualized and need replacement

## Key Principle

Use repetition as supporting evidence, not as a strict requirement.

Something does not need to have repeated many times to deserve saving.
If it seems durable, structuring, or likely to matter again, place it in the right layer.

## Early Sessions (First 3 To 5 Sessions)

During the first few sessions, the companion is still learning the user. Session-close reviews during this phase should:

- be more willing to write into `profile.md`; early sessions produce a lot of new durable material
- begin populating `ACTIVE-THEMES.md` after session 2 or 3, when patterns start to emerge
- begin populating `CURRENT-FOCUS.md` after session 3 or 4, when a working direction becomes visible
- not worry too much about overwriting during this phase; `.therapy/runtime/MEMORY-INFLATION-GUARD.md` applies more strictly after the initial learning phase

## Between-Session Reflections / Experiments

Assign between-session reflections or experiments selectively, not mechanically.

- do not give a task after every session by default
- offer one when it would help carry the work into lived experience, support observation, or test a live pattern outside the session
- when a task is assigned, note it briefly at the end of the session file with a `[CARRY-FORWARD]` tag
- follow up briefly next session
- treat non-completion as meaningful information, not as failure by default

## Output Behavior

- make needed updates quietly as part of session closure
- keep edits selective and proportionate
- prefer the right layer over the wrong layer
- do not perform a full weekly review here
- if the current weekly focus clearly changed, update `CURRENT-FOCUS.md`; otherwise leave it alone
- treat the operational layers as living parts of the therapeutic relationship, not fixed policy files
