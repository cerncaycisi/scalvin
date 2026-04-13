<!-- version: 0.5.0 -->
# Customization Commands

The client can request setup changes during a session. Treat the workspace as self-contained.

## Natural Language Recognition

Recognize conversational requests, not only exact phrases.

### Persona changes

- "switch persona"
- "be more direct"
- "be gentler"
- "be more like Susan"

### Modality changes

- "add modality"
- "remove modality"
- "use more ACT"
- "less CBT, more somatic"

### Structure changes

- "change session structure"
- "more homework"
- "less structure"

### Language / Adapter changes

- "switch default language"
- "make Codex the main entry point"
- "refresh my adapter files"

### Imports / Sources

- "import notes"
- "add these old conversations"
- "put this document into sources"

### Backup / Export

- "back up my workspace"
- "export my data"
- "save a copy"
- "create a backup"

### Runtime / Memory changes

- "change how memory works"
- "tighten the guardrails"
- "we need a better review rhythm"
- "this source logic is wrong"

### Updates

- "check for updates"
- "update my companion"

## Persona Changes

1. Show available personas from `.therapy/library/personas/`.
2. Let the client choose.
3. Read the current `.therapy/persona.md` and preserve any existing `## Client-Specific Adjustments` section.
4. Copy the chosen base persona into `.therapy/persona.md`.
5. Re-append the preserved `## Client-Specific Adjustments` section if it exists.
6. Update `.therapy/version.json`.
7. Update `SETUP-NOTES.md` if the default persona changed.

## Modality Changes

1. List active modalities from `.therapy/modalities/`.
2. Show available modalities from `.therapy/library/modalities/`.
3. Copy new modalities in or remove selected ones.
4. Update `.therapy/version.json`.
5. Update `SETUP-NOTES.md` if the default active set changed.

## Structure Changes

1. Show `Structured`, `Moderate`, and `Freeform`.
2. Copy the selected file from `.therapy/library/structures/` to `.therapy/session-structure.md`.
3. Update `.therapy/version.json`.
4. Update `SETUP-NOTES.md` if the default changed.

## Language Or Adapter Changes

1. If the default language changes, update `SETUP-NOTES.md`.
2. Regenerate:
   - `AGENTS.md`
   - `CLAUDE.md`
   - `START-CODEX-SESSION.md`
   - `START-CLAUDE-SESSION.md`
   - the named starter file
3. Do not overwrite user-authored notes in those files unless the client asked for a full reset.

## Imports And Sources

1. Ask for file or folder paths.
2. Read the content.
3. If the material is dated conversation history or session history, convert it into files in `sessions/`.
4. If a document should remain reopenable later, store it in `sources/`.
5. When a new source is added to `sources/`, run the full source integration chain from `.therapy/runtime/SOURCE-TRIGGERS.md`:
   - read short sources fully and long sources in sequential chunks
   - extend `SOURCE-TRIGGERS.md` immediately with a dedicated section
   - assess whether `profile.md`, `ACTIVE-THEMES.md`, or `CURRENT-FOCUS.md` should change
   - write an interim review in `archive/reviews/` if the source is major
   - acknowledge the source naturally without exposing file operations
6. Follow `.therapy/runtime/MEMORY-INFLATION-GUARD.md` when deciding where imported material belongs.

## Backup / Export

When the user asks to back up or export their workspace:

1. Determine the backup destination:
   - if the user specifies a path, use that
   - if not, create the backup in the user's home directory as `scalvin-backup-YYYY-MM-DD.zip`
2. Create a zip archive of the entire generated workspace directory, including:
   - `profile.md`
   - `ACTIVE-THEMES.md`
   - `CURRENT-FOCUS.md`
   - `NEXT-PRIMER.md`
   - `SETUP-NOTES.md`
   - `sessions/`
   - `archive/`
   - `sources/`
   - `.therapy/` (including persona, modalities, runtime, and `version.json`)
3. Exclude:
   - `__pycache__/`
   - `.DS_Store` and `._*` files
   - any `.git/` directory if present
4. Tell the user where the backup was saved, simply:
   - "Done. Your backup is at ~/scalvin-backup-2026-04-10.zip"
5. Do not dump a file listing or explain what was included.

If the user asks for a partial export (just sessions, just sources, etc.), respect that.

Optionally, after 10+ sessions without a backup, the companion may mention it once:

> "By the way -- we've had quite a few sessions now. If you'd like me to save a backup of everything, just say the word."

Do not repeat this reminder more than once per month.

## Runtime / Memory Logic Changes

If the client asks to change how the system works, update the relevant living file directly:

- `.therapy/runtime/LIVE-MOVESET.md`
- `.therapy/runtime/DISAMBIGUATION-GRID.md`
- `.therapy/runtime/MEMORY-INFLATION-GUARD.md`
- `.therapy/runtime/RUPTURE-AND-REPAIR.md`
- `.therapy/runtime/SESSION-CLOSE-REVIEW.md`
- `.therapy/runtime/WEEKLY-REVIEW.md`
- `.therapy/runtime/REVIEW-DUE-CHECK.md`
- `.therapy/runtime/SOURCE-TRIGGERS.md`

Do not treat these as fixed doctrine.

## Update Flow

1. Read `.therapy/version.json`.
2. Resolve the source in this order:
   - local workspace libraries if the requested file already exists there
   - `source_repo_path` if it still exists locally
   - `source_url` if configured
3. Read the source `manifest.json`.
4. Compare installed versions against source versions.
5. Show updates grouped by:
   - core components
   - library files
   - runtime files
   - adapter files
6. Always recommend safety updates.
7. Apply only approved updates.
