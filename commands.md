<!-- version: 0.7.2 -->
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

### Transcript Tracking

- "start tracking transcripts"
- "save transcripts"
- "turn on transcripts"

### Backup / Export

- "back up my workspace"
- "export my data"
- "save a copy"
- "create a backup"

### Workspace Migration

- "migrate my workspace"
- "upgrade my workspace"

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

## Transcript Tracking

When the user asks to start tracking transcripts:

1. Create `archive/transcripts/` if it does not already exist.
2. Create `archive/transcripts/README.md` using the transcript template shipped with the repo (`templates/archive/transcripts/README.template.md`) when it is available; if the template is not locally accessible, recreate the same structure and guidance directly in the new README.
3. Tell the user simply that transcripts will be saved from this point forward.
4. Add a `## Transcripts` heading to `SETUP-NOTES.md` if it does not already exist, and below the heading add a single line: `Tracking started: YYYY-MM-DD`. This exact heading is what `runtime/START-SESSION.md` checks for to determine whether transcript tracking is enabled.
5. Do not retro-fill missing transcripts unless the user explicitly asks for that.

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

## Workspace Migration

When the user asks to migrate or upgrade their workspace:

1. Create a full backup of the current workspace first (follow Backup / Export).
2. Create a fresh workspace at a new path (or the same path with a `-v2` suffix) using the normal bootstrap in `SETUP.md`, but carry forward the old workspace's current setup defaults:
   - companion name and default language from `SETUP-NOTES.md`
   - base persona choice from `SETUP-NOTES.md` or the old `.therapy/persona.md` with any `## Client-Specific Adjustments` section stripped out
   - active modalities from `.therapy/modalities/`
   - session structure from `.therapy/session-structure.md`
   - transcript opt-in state: if the old `SETUP-NOTES.md` contains a `## Transcripts` heading, copy that heading and its body (including the `Tracking started` line) into the new `SETUP-NOTES.md` so transcript tracking continues across the migration
3. Copy user data from old to new:
   - `profile.md`, `ACTIVE-THEMES.md`, `CURRENT-FOCUS.md`, `NEXT-PRIMER.md` (as-is)
   - `sessions/` (all files)
   - `archive/` (all files)
   - `sources/` (all files)
   - from `.therapy/persona.md`: copy only the `## Client-Specific Adjustments` section if it exists, then append it to the new persona file
4. Do not copy old runtime files. The new workspace should keep its updated runtime versions.
5. Update the repo-root `SETUP-NOTES.md` to point to the new workspace path.
6. Tell the user simply: "Migrated. Your sessions, profile, and sources are in the new workspace. Runtime files have been updated. Your persona adjustments have been preserved."
7. Suggest verifying the new workspace, then optionally deleting the old one.

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
2. If `source_url` is configured and non-empty, fetch the remote `manifest.json` from `{source_url}/manifest.json` using web fetch.
3. If `source_url` is empty but `source_repo_path` exists locally, read `manifest.json` from that local path.
4. If neither works, ask the user for the repo URL or local path.
5. Read `base_url` from the source `manifest.json`. If `base_url` is missing or empty, use `source_url` as the remote fetch base.
6. Compare installed versions against source versions.
7. Show updates grouped by:
   - core components
   - library files
   - runtime files
   - adapter files

### Merge Strategy

Before applying any update to a runtime or persona file, check whether the workspace copy has been modified:

- For `.therapy/persona.md`: if a `## Client-Specific Adjustments` section exists, preserve it. Apply the base persona update, then re-append the preserved adjustments.
- For runtime files (`.therapy/runtime/*.md`): compare both the workspace file content and the version tag against the incoming file.
  - If the workspace file content matches the incoming file exactly: safe to overwrite.
  - If the version tags match but the content differs: assume the companion may have customized the file without a version bump. Ask the user.
  - If the workspace version is higher or different: the companion may have modified it. Ask the user:
    "This file has been customized during your sessions. Do you want to:
    a) Keep your version
    b) Take the new version (customizations will be lost)
    c) Take the new version and I'll try to re-apply your customizations"
- Never overwrite: `profile.md`, `ACTIVE-THEMES.md`, `CURRENT-FOCUS.md`, `NEXT-PRIMER.md`, `sessions/`, `archive/`, `sources/`
- Always overwrite without asking: `.therapy/safety-protocol.md` (safety updates are non-negotiable)

8. Apply only approved updates.

Always recommend safety updates.

For remote fetching, use web fetch to get `{base_url}/{file_path}` for each file that needs updating.
