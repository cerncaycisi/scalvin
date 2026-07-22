# Migrating Scalvin Workspaces

Migration changes framework and operational state while preserving user-owned
data. Never migrate by copying a new runtime over an old workspace manually.

## Before any migration

1. Use a trusted Scalvin checkout or release.
2. Run doctor on the current workspace.
3. Create and verify a full backup.
4. Run update in dry-run mode.
5. Review customized-file conflicts and the exact mutation plan.

The updater snapshots every target it will modify. That rollback snapshot is
separate from the full user backup.

## Verified legacy compatibility

Migration support is exact and fail-closed. `0.8.x` in historical prose means
only the two verified releases below; it is not a wildcard.

| `installed_from_version` | Supported | Migration route |
|---|---|---|
| `0.8.0` | Yes | Verified direct adapter to 1.0 |
| `0.8.1` | Yes | Verified direct adapter to 1.0 |
| `0.8.2` or any other version | No | Preserve an exact backup, then use a documented supported intermediate release or request manual migration help |
| Missing or malformed | No | Do not infer a version; recover metadata only from a known backup or matching trusted release |

Unsupported, missing, and malformed version metadata is rejected before the
updater inspects user artifacts, creates a backup, or stages any mutation.

## From 0.8.0 or 0.8.1 to 1.0

Version 1.0 replaces prose-driven setup/update with the deterministic CLI and
introduces a new trust and consent model.

From the trusted 1.0 checkout:

```bash
node bin/scalvin.js doctor \
  --workspace "<legacy-workspace>" \
  --json
```

Doctor may report legacy schema warnings. Preview migration with an explicit
manifest hash from the trusted release artifact:

```bash
node bin/scalvin.js update \
  --workspace "<legacy-workspace>" \
  --source "<trusted-scalvin-checkout>" \
  --manifest "<trusted-scalvin-checkout>/manifest.json" \
  --manifest-sha256 "<exact-trusted-manifest-sha256>" \
  --dry-run \
  --json
```

Apply the same command without `--dry-run` only after reviewing the plan.

### What is protected

Migration never treats these as replaceable framework:

- profile, active themes, current focus, and next primer;
- sessions, sources, context entities, archive, and transcripts;
- consent, deletion, source, backup, and change ledgers;
- user-specific overlays and approved adjustments;
- external-care records and provenance.

### Consent transition

Legacy data is not proof of current consent.

Migration preserves existing files but creates the versioned data-control
model with:

- raw transcripts off;
- sources and external-care imports requiring per-import choice;
- behavior customization requiring a choice;
- legacy continuity content awaiting confirmation when no explicit consent
  record exists.

Until that choice is recorded, the runtime does not silently add new sensitive
content or assume old data may be read.

### Runtime customization

The updater compares recorded and current hashes:

- an unchanged framework copy may be refreshed;
- a user-customized active/framework file is reported as a conflict;
- user-specific behavior belongs in the overlay/change-log system;
- immutable safety, consent, command, and update boundaries cannot be converted
  into an overlay.

Do not select force merely to clear a conflict. Review what the customization
was meant to achieve and re-express safe user-specific behavior as an overlay.

The legacy `warm-4o` persona selector is canonicalized to the provider-neutral
`casual-warm` selector. The conversation style is preserved; only the
model-branded name is retired.

### Historical filenames and transcripts

Legacy session names remain readable. New writes use seconds, a session UUID,
and no-clobber creation.

Legacy transcripts are preserved. A close-time or unknown-origin transcript is
not relabeled as authoritative verbatim capture; migration records its
available coverage grade.

### Weekly review transition

The old Monday/missed-Tuesday rule is retired. A review is session-triggered on
the first returning session of a new week when the prior week contains a
completed session. Legacy review files remain valid historical records.

### Launchers

Absolute-path `.command` and `.bat` launchers are deprecated. Migration removes
only a known, unmodified generated launcher. A customized file is left in place
and reported.

### Source registry

Legacy sources are not auto-integrated again. Migration creates source-ledger
entries using available hashes and marks uncertain status for review. It does
not invent original import dates or live-confirmation dates.

## From 1.x to a later 1.x release

Use an explicit release:

```bash
scalvin update \
  --workspace "<workspace>" \
  --manifest "<trusted-release>/manifest.json" \
  --manifest-sha256 "<exact-manifest-sha256>" \
  --release "<expected-version>" \
  --dry-run
```

Then apply after review. A no-op update should produce no file changes.

### Development snapshot `a98dfba`: Scalvin persona to Susan

Commit `a98dfba` used manifest SHA-256
`2e6d3b99399e7d36c96aeb419f3da8d44c6d721cfd20a954f4d1c0c7e7e4182f`
and selected the now-removed `scalvin` persona by default. The current updater
recognizes only that exact product-manifest hash plus the matching state pin in
order to canonicalize the selector to `susan`. If the old preferences still
have the complete default-shaped tuple (`Scalvin`, `scalvin`, `scalvin`), the
companion name and slug also become `Susan` and `susan`. A different companion
name is preserved. Pass an explicit `--companion-name` during the update if the
literal display name `Scalvin` is intentional.

This recognition is compatibility routing, not an overwrite trust root. The
old distribution is not bundled with the new release, and mutable workspace
state is never accepted as proof that a file is unmodified. Therefore a real
`a98dfba` workspace can report:

- `LEGACY_SCALVIN_PERSONA_CANONICALIZED`;
- `UNVERIFIED_PRIOR_TARGETS_PRESERVED`;
- changed framework targets as conflicts with `priorHash: null`.

That result is expected and fail-closed. The non-forced update must stop with
`CUSTOMIZATIONS_DETECTED`. Review the dry-run conflict list against the trusted
old checkout and any intentional local changes. If replacement is correct,
rerun with `--force` and the exact fresh confirmation token. The updater creates
a full safety backup before activation; verify and retain its reported recovery
material. Do not copy `susan.md` or edit `.scalvin/state.json` by hand.

Removed or user-owned targets that the new release cannot independently prove
safe to replace are preserved rather than silently deleted or rewritten. A
real default `a98dfba` workspace therefore retains all of the following after
the forced migration:

- legacy `scalvin.md`;
- `.therapy/library/personas/scalvin.md`;
- the old companion/persona display lines in the seed file `SETUP-NOTES.md`.

The canonical `.scalvin/state.json`, active `.therapy/persona.md`, and new
`susan.md` select Susan after migration; the retained files above do not
override that canonical selection. After a successful update, backup
verification, and doctor run, review the two legacy files and the non-sensitive
setup-note lines against the trusted old checkout. Retire or correct them only
when their generated origin is confirmed or their customization is
intentionally no longer needed. Preservation is deliberate: the new updater
does not turn mutable old state hashes into deletion or overwrite authority.

Any other development-manifest hash with a `scalvin` selector is unsupported
and is not eligible for this compatibility canonicalization. Do not forge the
`a98dfba` hash. Use the exact trusted old checkout to select `susan` first, or
request manual migration help with only synthetic metadata and error codes.

## Rollback

If update fails, the CLI attempts automatic rollback and reports its status.
If the update succeeded but behavior is wrong:

1. stop new persistence;
2. run doctor and preserve its error codes;
3. inspect the update snapshot and full backup;
4. dry-run restore into a separate empty path when possible;
5. verify the restored workspace before replacing the active one.

Do not copy individual state files across schemas without the migration plan.

## Downgrades

In-place downgrade is unsupported unless a release explicitly documents it.
Restore a pre-update backup to a separate path instead.

## Getting help

Use synthetic metadata and error codes in public issues. Never attach a real
workspace. Security, privacy, or safety-bypass reports belong in
[private vulnerability reporting](https://github.com/cerncaycisi/scalvin/security/advisories/new).
