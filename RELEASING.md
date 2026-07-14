# Releasing Scalvin

Releases are cut from `main` after required CI checks and a clean lifecycle
smoke test pass. This document is for maintainers.

Release commands require a full source checkout. The end-user runtime package
intentionally excludes tests, corpora, and maintainer-only scripts.

## 1. Define scope

- Confirm every shipped behavior has tests and documentation.
- Identify safety, consent, schema, migration, or protected-data impact.
- Update `CHANGELOG.md`.
- Add migration notes before changing an existing workspace schema.
- Do not include real workspace data in fixtures, logs, issues, or the release.
- For a stable release, complete the independent gate in
  `docs/CLINICAL-SAFETY-REVIEW.md`; an absent or non-approving artifact blocks
  release.

## 2. Version sources

Set the same semantic version in:

- `package.json`;
- `manifest.json` product metadata;
- relevant runtime/component headers;
- changelog release heading.

Regenerate the manifest from the working tree:

```bash
npm run manifest:refresh
npm run manifest:verify
```

The manifest is the canonical registry for generated-workspace managed assets;
it does not claim to enumerate the CLI, package metadata, or maintainer docs.
`package-inventory.json` is the separate canonical npm package-file contract.
Refresh and verify it whenever package contents change:

```bash
npm run inventory:refresh
npm run check:package-inventory
```

## 3. Run quality gates

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

For every provider/model/client-adapter combination evaluated for the release,
capture a complete behavioral response set from the exact candidate commit.
At least one tuple is mandatory for every shipped adapter declared by
`evals/release-evidence-policy.json`.
Each set contains every locale case declared by the exact corpus. Run:

```bash
node cli/evaluate-captured-responses.js --input <release-candidate-capture.json-or-jsonl>
```

Every set must pass independently. Record the candidate commit, provider/model/
adapter tuple, evaluated locale set, corpus SHA-256, canonical capture SHA-256,
candidate-metadata SHA-256, capture method, private provenance SHA-256, and
machine-result artifact in the signed release evidence. The synthetic good/bad
fixtures are evaluator self-tests
and are never acceptable as release-candidate evidence. Deterministic passage
does not certify a model: a maintainer must also inspect the real captured
responses for contextual quality, unsafe evasions, and pattern-check gaming.
Every bundled mechanical locale pack also requires an independent fluent
reviewer. The corpus's current representative locales are a finite sample, not
a statement of preferred or complete product-language support. Follow the
exact signing, assembly, secret handoff, and stable-tag contract in
[`docs/RELEASE-EVIDENCE.md`](docs/RELEASE-EVIDENCE.md).

Required coverage includes:

- clean install and doctor;
- no-op update;
- customized-file preservation;
- legacy migration;
- path traversal and symlink rejection;
- partial-write rollback;
- backup checksum and restore dry-run/extraction;
- multilingual safety must-fire and silent-expected boundaries for every
  bundled detector pack;
- over-fire budget;
- source prompt-injection boundary;
- complete provider-neutral captured responses for every evaluated
  provider/model/client-adapter tuple and every locale case in the exact
  corpus, with zero high-severity dependency,
  deception, consent, safety, or contraindication violations and the documented
  soft-shape thresholds;
- public-repository secret/private-path scan;
- relative documentation links;
- Linux, macOS, and Windows CI.

## 4. Artifact smoke test

Build the package:

```bash
npm pack
```

In a repo-local isolated fixture:

1. install from the packed artifact;
2. create a workspace with synthetic values;
3. run doctor;
4. create and verify a backup;
5. create an encrypted backup from a synthetic private passphrase file, verify
   wrong-passphrase and tamper rejection, and dry-run restore to a new path;
6. update from the previous supported release;
7. verify user-protected fixture hashes are unchanged.

Delete only the generated fixture after the checks pass. Never use a real
workspace for release testing.

## 5. Commit and protected stable tag

The release commit contains version, manifest, changelog, and migration notes.
Merge it to protected `main` only after the required `Required CI` check passes.
Humans do not create `v*` tags directly. In GitHub, open **Actions → CI → Run
workflow**, select `main`, enter the canonical version without the `v` prefix in
`stable_version`, and start the run.

The manual stable-release path reruns the complete cross-platform matrix,
verifies version and manifest agreement, enters the protected `stable-release`
environment, verifies the signed private evidence for that exact `main` commit,
and only then creates an annotated `v<version>` tag. The repository's tag
settings must enforce creation by the GitHub Actions App only and prohibit every
update or deletion after creation.

Before relying on that path, a repository admin must verify all of these live
server-side controls; the workflow file cannot impose them by itself:

- active `main-pr-required-ci` branch ruleset, with no routine bypass, requiring
  a pull request, strict `Required CI` from GitHub Actions App ID `15368`, and no
  branch deletion or non-fast-forward update;
- active `stable-tag-created-by-release-workflow` tag ruleset for `v*`, whose
  only creation bypass is GitHub Actions App ID `15368`;
- separate active `stable-tag-immutable` tag ruleset for `v*`, with no bypass
  for update or deletion;
- `stable-release` environment restricted to `main`, with administrator bypass
  disabled, self-review prevention enabled, and approval by separate human
  reviewers who did not assemble the evidence.

Do not run the stable-release path until the independent clinical, fluent-
reviewer, and real captured-response prerequisites are complete. An empty
`stable_version` is a CI-only dispatch and cannot create a tag.

## 6. GitHub release

Create a GitHub release from the exact tag:

- title `Scalvin v<version>`;
- changelog summary;
- safety/privacy/migration notices first;
- supported Node and client versions;
- known limitations and accepted safety-eval boundaries;
- package archive and SHA-256 checksum.

Verify the release page and install instructions from a clean environment.

## 7. Package publishing

GitHub source and release publishing do not automatically authorize npm
publishing. Enable npm publishing only after package ownership, provenance,
2FA/OIDC, and rollback policy are configured.

If enabled, use npm trusted publishing with provenance and verify that the
registry version, Git tag, package version, and manifest version all match.

## 8. Post-release

- Run the public install command from the release.
- Confirm CI badge and release links.
- Confirm private vulnerability reporting remains enabled.
- Open follow-up issues for every documented known limitation.
- Never edit a published release artifact in place; issue a new patch release.
