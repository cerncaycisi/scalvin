# Scripts

Maintenance scripts for the Scalvin repo. Not required to use Scalvin -- only useful for contributors and maintainers.

## clean-for-distribution.sh

Removes macOS resource fork files (`._*`), Finder metadata (`.DS_Store`), and `__MACOSX/` directories from the working tree. Run before creating a release zip or committing work done on macOS.

    ./scripts/clean-for-distribution.sh

Safe to run repeatedly. Does not touch git-tracked files or the `.git/` directory.

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
