# Stable Release Evidence

Scalvin does not turn deterministic test passage into a clinical or language-
support claim. A stable tag does not exist until the protected manual GitHub
Actions path verifies one private evidence envelope for the exact candidate
commit and package version.

The commands in this document require a full source checkout. The end-user
runtime package intentionally excludes tests, corpora, and maintainer scripts.

The envelope contains:

- complete real-model captured-response sets;
- the exact provider, model, adapter, and evaluated-locale matrix;
- a human review that binds the exact canonical capture, corpus, candidate,
  and reviewed framework hashes;
- an Ed25519 signature from the independently controlled reviewer key.

Synthetic repository fixtures are evaluator tests only. They are rejected as
release evidence by policy even when their shape passes the parser.

The signed clinical/safety envelope and build provenance are separate controls.
After this envelope passes, the protected workflow packs the exact candidate,
verifies canonical candidate metadata and a non-circular checksum list that
binds the archive, archive checksum, SPDX 2.3 SBOM, and metadata, then performs
a clean install. GitHub build provenance covers all four release-set subjects;
the separate SBOM attestation binds the SPDX document to the archive subject.
The metadata itself binds the candidate version and commit plus the manifest
and package-inventory hashes. Build provenance proves which workflow and
repository commit produced specific artifact bytes. Neither provenance nor the
SBOM proves clinical quality, fluent-language review, or safe model behavior,
and neither control may substitute for the signed review.

## What the gate proves

The automated gate proves that:

- every capture belongs to the exact Git commit and semantic version;
- every client adapter declared by the tracked release-evidence policy has at
  least one signed, passing real-model capture tuple;
- every required corpus case and prompt hash is present exactly once;
- every capture passes the deterministic behavioral rules;
- the signed review covers exactly the same capture matrix and canonical
  response content;
- every bundled mechanical locale pack has an approving fluent review entry;
- the review covers the current runtime, safety, consent, memory, modality,
  persona, structure, accessibility, and localization components;
- reviewed repository artifacts still have the signed hashes;
- the review is unexpired, approving, and signed by the pinned Ed25519 key.

It does not prove clinical efficacy, universal safety, reviewer independence by
itself, or behavioral parity in untested languages. Independence is a human and
governance property reinforced by separate key custody and the protected
`stable-release` GitHub environment.

`evaluatedLocales` is the exact finite sample in the behavioral corpus. It is
not a preferred-language list or a boundary on the language-neutral Unicode /
BCP-47 runtime. No language receives product-level privilege from appearing in
that sample.

## Review document contract

The reviewer receives the exact candidate commit, public framework diff,
machine results, real captured responses, and known limitations. The review is
a JSON object with this shape; placeholders must be replaced, arrays must not
contain duplicates, `evaluatedLocales` must be lexicographically sorted
canonical BCP-47, and hashes are lowercase SHA-256:

```json
{
  "schemaVersion": 1,
  "artifactType": "scalvin-independent-clinical-safety-review",
  "candidate": {
    "version": "<semver>",
    "commit": "<full-git-commit>"
  },
  "reviewedAt": "<RFC3339-UTC-with-milliseconds>",
  "validUntil": "<RFC3339-UTC-with-milliseconds>",
  "reviewer": {
    "role": "<independent-reviewer-role>",
    "qualification": "<relevant-qualification>",
    "independenceAttested": true,
    "conflictsOfInterest": "<disclosure>"
  },
  "scope": {
    "reviewedComponents": [
      "consent-and-data-controls",
      "default-modalities",
      "default-personas",
      "localization-and-accessibility",
      "memory-and-context",
      "runtime",
      "safety-protocol",
      "session-structures"
    ],
    "localePackReviews": [
      {
        "locale": "<canonical-pack-BCP-47-tag>",
        "fluentReviewerAttested": true,
        "decision": "approve",
        "limitations": ["<pack-specific-limit>"]
      }
    ],
    "captureMatrix": [
      {
        "provider": "<provider-id>",
        "model": "<model-id>",
        "adapter": "<adapter-id>",
        "evaluatedLocales": ["<canonical-BCP-47-tag>"],
        "capturedAt": "<exact-capture-RFC3339-UTC>",
        "captureCanonicalSha256": "<evaluator-canonical-capture-sha256>",
        "corpusSha256": "<evaluator-corpus-sha256>",
        "candidateMetadataSha256": "<evaluator-candidate-metadata-sha256>",
        "realModelCaptureAttested": true,
        "captureMethod": "<provider_api|client_export|client_hook>",
        "provenanceSha256": "<sha256-of-private-collection-provenance>",
        "decision": "approve",
        "limitations": ["<tuple-specific-limit>"]
      }
    ],
    "artifacts": {
      "manifestSha256": "<sha256>",
      "safetyProtocolSha256": "<sha256>",
      "behavioralCorpusSha256": "<sha256>",
      "releaseEvidencePolicySha256": "<sha256>",
      "safetyCorpusSha256": "<sha256>",
      "sourceBoundaryCorpusSha256": "<sha256>"
    }
  },
  "decision": "approve",
  "limitations": ["<concrete-release-limit>"],
  "requiredChanges": [],
  "unresolvedDisagreements": [],
  "reReviewTriggers": ["<material-change-trigger>"],
  "statement": "I independently reviewed the listed candidate and evidence and approve only the stated scope and limitations."
}
```

The evaluator emits the canonical capture hash, corpus hash, candidate-metadata
hash, exact candidate fields, and evaluated locales without emitting response
content:

```bash
node cli/evaluate-captured-responses.js \
  --input "<real-capture.json-or-jsonl>" \
  --expected-commit "<full-git-commit>" \
  --expected-version "<semver>"
```

Each capture covers every locale case declared by that exact corpus. The signed
matrix is the canonical evaluated provider/model/adapter/locale inventory for
the release. [`evals/release-evidence-policy.json`](../evals/release-evidence-policy.json)
defines the minimum shipped-adapter coverage and is itself hash-bound by the
review. Release notes must not imply evidence outside the signed matrix.

For every tuple, the reviewer also attests the real-model collection method and
signs the SHA-256 of the private collection provenance (for example, a bounded
provider request/response-ID export or client capture log with no user data).
The provenance material is not put in the public repository or envelope. The
automated gate proves that this attestation and digest were signed; it cannot
independently prove that an external provider produced the response. Separate
reviewer key custody and environment approval remain essential.

## Independent signing

The reviewer generates and retains an Ed25519 private key outside maintainer
custody. On Unix, the private-key file must be mode `0600`. The repository tool
canonicalizes the JSON before signing and emits only a detached signature,
public key, review hash, and public-key fingerprint:

```bash
node scripts/sign-clinical-review.mjs \
  --review "<review.json>" \
  --private-key "<reviewer-private.pem>" \
  --signature-output "<review.sig>" \
  --public-key-output "<reviewer-public.pem>"
```

Before signing, the reviewer independently compares the evaluator's canonical
capture, corpus, and candidate-metadata hashes with every matrix entry and
reviews the corresponding response content and collection provenance. The
reviewer then sends the review JSON, detached signature, and public key through
the agreed private channel. The private key is never sent to maintainers,
stored in GitHub, or included in the envelope.

## Maintainer assembly and local verification

Assemble every reviewed capture into one gzip envelope. The builder immediately
runs the same strict verifier used by CI and removes a failed output:

```bash
node scripts/build-release-evidence.mjs \
  --review "<review.json>" \
  --signature "<review.sig>" \
  --public-key "<reviewer-public.pem>" \
  --capture "<capture-one.json>" \
  --capture "<capture-two.jsonl>" \
  --output ".test-tmp/release-evidence.json.gz" \
  --expected-commit "<full-git-commit>" \
  --expected-version "<semver>" \
  --reviewer-key-sha256 "<independently-recorded-fingerprint>"
```

The expected candidate values come from the checked-out release candidate,
and the reviewer-key fingerprint comes from the separately approved release
environment configuration. Do not copy any of these pins back out of the
review or supplied public key: that would only prove self-consistency.

The compressed envelope is private because it contains model responses. Split
it into bounded secret values:

```bash
node scripts/encode-release-evidence-secret-chunks.mjs \
  --input ".test-tmp/release-evidence.json.gz" \
  --output-directory ".test-tmp/release-evidence-secrets"
```

The encoder creates one to eight files named for GitHub environment secrets
`SCALVIN_RELEASE_EVIDENCE_B64_01` through `_08`. Populate each emitted secret
in order and remove stale higher-numbered values from earlier candidates.

## GitHub environment and protected-tag contract

Before running a stable release, configure the `stable-release` environment:

1. require approval from release owners who did not assemble the evidence;
2. set environment variable `SCALVIN_CLINICAL_REVIEWER_KEY_SHA256` to the
   fingerprint emitted by the independent signing tool;
3. set the emitted `SCALVIN_RELEASE_EVIDENCE_B64_01` ... `_08` environment
   secrets without adding whitespace;
4. restrict deployment to the protected `main` branch and do not allow an
   initiating maintainer to self-approve; reviewers must be separate humans who
   did not assemble the evidence, and administrator environment bypass must be
   disabled;
5. keep an active `main-pr-required-ci` ruleset with no routine bypass so `main`
   requires a pull request and strict `Required CI` from GitHub Actions App ID
   `15368`;
6. keep an active `stable-tag-created-by-release-workflow` creation ruleset for
   `v*` whose only bypass is GitHub Actions App ID `15368`;
7. keep a separate active `stable-tag-immutable` ruleset for `v*` with no bypass
   for update or deletion.

These are live GitHub repository settings, not properties that a committed
workflow can impose. A repository admin must inspect and verify them before
calling the release path enforced.

From **Actions → CI → Run workflow**, select `main` and supply the canonical
package version without a `v` prefix as `stable_version`. The workflow first
reruns the complete CI matrix and proves that the dispatched commit is still
the remote `main` head. The protected environment job then reconstructs the
gzip file without printing a secret, pins the candidate to `GITHUB_SHA` and the
package version, verifies the complete signed matrix, and deletes the runner
copy. Only after all checks pass does GitHub Actions create the annotated
`v<version>` tag. A direct human tag push is rejected, and the workflow's
`GITHUB_TOKEN` tag push intentionally does not start a second workflow.

Missing chunks, an unpinned key, expired review, unknown field, hash mismatch,
substituted passing capture, non-approval decision, incomplete matrix, a stale
`main` head, or an existing tag blocks creation. An empty `stable_version`
performs CI only and cannot create a tag.

Keep the private evidence under the project's approved retention policy until
the release and audit window are complete, then delete or archive it according
to that policy. Never put real user conversations, care records, credentials,
or private performance feedback in a release envelope.
