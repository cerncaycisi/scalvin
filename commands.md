<!-- version: 0.1.0 -->
# Customization Commands

The client can request setup changes during a session. Treat the workspace as self-contained.

## Natural Language Recognition

Recognize conversational requests, not only exact phrases.

### Persona changes

- "switch persona"
- "be more direct"
- "be gentler"
- "be more like Hazel"

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
3. Copy the chosen file into `.therapy/persona.md`.
4. Update `.therapy/version.json`.
5. Update `SETUP-NOTES.md` if the default persona changed.

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
3. Extract durable information into `profile.md`.
4. Convert dated material into files in `sessions/`.
5. If a document should remain reopenable later, store it in `sources/`.
6. Extend `SOURCE-TRIGGERS.md` when a new source becomes clinically relevant.
7. Update `ACTIVE-THEMES.md` or `CURRENT-FOCUS.md` only when the imported material clearly justifies it.

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
