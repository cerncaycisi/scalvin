# Scripts

Maintenance scripts for the Scalvin repo. Not required to use Scalvin -- only useful for contributors and maintainers.

## clean-for-distribution.sh

Removes macOS resource fork files (`._*`), Finder metadata (`.DS_Store`), and `__MACOSX/` directories from the working tree. Run before creating a release zip or committing work done on macOS.

    ./scripts/clean-for-distribution.sh

Safe to run repeatedly. Does not touch git-tracked files or the `.git/` directory.

## Emergency-resource freshness

`check-emergency-resources.mjs` validates the bounded machine-readable
jurisdiction registry without making a network request. It checks the exact
schema, official HTTPS source fields, the 30-day TTL, and UTC-date freshness.
Missing, malformed, not-yet-valid, or expired entries fail the static/release
check; the installed safety hook reports the same condition as a content-free
degraded capability state.

    node scripts/check-emergency-resources.mjs

## Stable-release evidence

The release-evidence tools are invoked with Node and never print private keys,
raw captures, or review content:

- `sign-clinical-review.mjs` canonicalizes and signs an independent review with
  an Ed25519 key held by the reviewer;
- `build-release-evidence.mjs` combines the signed review with exact real-model
  captures and runs the stable-tag verifier against externally supplied
  candidate and reviewer-key pins;
- `encode-release-evidence-secret-chunks.mjs` creates bounded base64 chunks for
  the protected GitHub release environment.

Keep generated evidence and secret chunks under `.test-tmp/`; they are private
release-process artifacts and must never be committed. See
[`docs/RELEASE-EVIDENCE.md`](../docs/RELEASE-EVIDENCE.md).

## Stable-release artifacts

- `build-release-artifacts.mjs` creates the exact npm archive, archive SHA-256,
  SPDX 2.3 SBOM, canonical candidate metadata, and a non-circular release-set
  checksum in a new output directory. It can require a clean checkout and binds
  the candidate commit and version.
- `verify-release-package.mjs` verifies exact metadata fields and all archive,
  checksum, SBOM, manifest, inventory, version, and commit bindings before it
  installs the archive into a fresh temporary prefix with scripts disabled,
  verifies the CLI surface, creates a synthetic memory-off workspace, and
  requires doctor to report zero errors.
- `verify-stable-readiness.mjs` is a fail-closed architecture gate. It blocks a
  stable run while any Codex, Claude Code, or generic shipped adapter lacks an
  independently verified effective-launch hard boundary, the typed private-data
  surface is incomplete, or the isolated source worker lacks an attestation. It
  is expected to fail for the current development preview; static project files
  and broker self-report booleans are never treated as effective-launch proof.

The protected stable workflow runs both scripts before separate provenance and
SBOM attestations, candidate upload, or immutable tag creation. These scripts
do not publish a release, enable npm publishing, or configure GitHub
rulesets/environments.
