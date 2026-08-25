# Roadmap

Maintainer planning document for the unreleased `1.0.0` development line.

This file records what currently blocks a stable release, in the order the
blockers unblock each other. It is a work plan, not a schedule, not a promise,
and not evidence of review. Nothing here states that a gate has been passed;
the gates themselves remain the authority. In particular, listing the clinical
and safety review as planned work does not imply that any review has started,
been scoped, or been approved.

Scope boundaries in [Scope and Evidence](SCOPE-AND-EVIDENCE.md) apply to this
document. Release mechanics live in [`RELEASING.md`](../RELEASING.md); shipped
and unshipped behavior lives in [`CHANGELOG.md`](../CHANGELOG.md). This file
adds only ordering and current state.

## Measured baseline

Snapshot taken 2026-08-25 at commit `e59afe5`, by running each gate. Refresh
this table by re-running the commands rather than editing it by hand.

| Gate | Command | Result |
|---|---|---|
| Syntax | `npm run check:syntax` | pass, 110 JavaScript files |
| Emergency resources | `npm run check:emergency-resources` | **fail**, stale (CA, TR, US) |
| Manifest | `npm run check:manifest` | pass, 121 files |
| Package inventory | `npm run check:package-inventory` | pass |
| Documentation links | `npm run check:links` | pass, 103 files |
| Public-repository scan | `npm run check:public` | pass, 253 candidate files |
| Test suite | `npm test` | **fail**, 599 pass / 11 fail / 8 skipped of 618 |
| Stable readiness | `node scripts/verify-stable-readiness.mjs` | **blocked**, 8 blockers |

`npm run check` stops at the emergency-resource gate, so the four gates after it
do not run in an aggregate invocation. They are listed above from individual
runs and are currently clean.

## P0 — Restore the green baseline

The bundled emergency-resource registry expired. All three jurisdictions in
`hooks/emergency-resources.json` carry `verifiedAt: 2026-07-14` and
`expiresAt: 2026-08-13` under a 30-day `ttlDays`, so the registry has been
stale since 2026-08-13.

This is the root of both red gates. The staleness degrades the mechanical
safety backstop, which changes the capability state and reason code reported by
the hook, the CLI, and doctor. Every one of the 11 test failures is consistent
with that single cause, and two were confirmed directly: the bounded-deadline
hook test asserts a reason code of `CLASSIFIER_UNAVAILABLE` or `HOOK_TIMEOUT`
and receives `EMERGENCY_RESOURCE_REGISTRY_STALE`, and the language-preference
test asserts a doctor run with zero warnings.

Work items:

1. Re-verify every `officialSource` for CA, TR, and US against the live
   official page, then update `verifiedAt` and the derived `expiresAt`. The
   checker performs no network fetch by design, so this step is manual and
   cannot be delegated to CI. Do not advance the dates without re-verifying;
   the dates are the assertion.
2. Re-run `npm run check` and `npm test` and confirm the count returns to
   610 pass / 0 fail / 8 skipped.
3. Decide the ownership and cadence for the 30-day TTL. Today `main` turns red
   on a calendar date with no code change and no maintainer signal beforehand.
   A scheduled reminder ahead of expiry would convert a surprise failure into
   planned work. The fail-closed behavior itself is correct and should stay.
4. Decide the reason-code precedence question this exposed. A stale registry
   currently supersedes the reason code that a test is exercising, so an
   expiry masks unrelated capability-state assertions instead of only failing
   the freshness gate. This will recur at every expiry regardless of item 1.
   Whether the runtime notice should carry one reason or several is a design
   decision, not a defect to patch silently.

Items 3 and 4 are the durable fix; item 1 alone buys 30 days.

## P1 — Architecture gate

`scripts/verify-stable-readiness.mjs` reports 8 blockers. Per
[`RELEASING.md`](../RELEASING.md), this gate is *intentionally* red in the
current `broker_only_unattested` preview, so these are known design work, not
regressions.

Capability broker:

- the hard private-data boundary is not implemented;
- the typed private read/write surface is incomplete;
- the isolated tool-free and network-free source worker is not attested.

Per-adapter effective-launch hard-boundary attestation is unavailable for the
exact candidate on all three shipped adapters — `claude-code`, `codex`, and
`generic`. Additionally, `generic` explicitly has no enforceable private-data
boundary and is preview-only.

The `generic` adapter needs a decision before the rest of this section can
close: implement an enforceable boundary for it, or exclude it from the stable
release and narrow `requiredClientAdapters` in
`evals/release-evidence-policy.json` accordingly. Carrying a preview-only
adapter into a stable release is the one option that is not available, because
the readiness gate fails closed on it.

## P2 — Independent human gates

These cannot be automated away and are the long pole. Each requires a person
who is not the author of the evidence.

**Clinical and safety review.**
[`docs/CLINICAL-SAFETY-REVIEW.md`](CLINICAL-SAFETY-REVIEW.md) records status
`not completed` for this development line. A stable release is blocked until an
artifact tied to the exact release commit records the reviewed scope, hashes,
reviewer role and conflicts, and a decision. `revise` and `block` do not permit
release, and an `approve` carrying required changes or unresolved disagreement
also blocks. Missing scope is not approval.

**Fluent locale reviewers.** Every bundled mechanical locale pack requires an
independent fluent reviewer in addition to the deterministic corpus. See
[Localization](LOCALIZATION.md).

**Captured-response evidence.** At least one provider/model/adapter tuple per
shipped adapter, covering every locale case in the exact corpus, captured from
the exact candidate commit, with the hash bindings and signing contract in
[Stable Release Evidence](RELEASE-EVIDENCE.md). Synthetic good/bad fixtures are
evaluator self-tests and are never acceptable as candidate evidence.
Deterministic passage does not certify a model: a maintainer must also read the
real captured responses for contextual quality and pattern-check gaming.

## P3 — Repository controls

A workflow file cannot impose these; a repository admin must verify them
server-side before the protected stable path is trusted. Enumerated in
[`RELEASING.md`](../RELEASING.md):

- `main-pr-required-ci` branch ruleset, no routine bypass, strict `Required CI`
  from GitHub Actions App ID `15368`, no deletion or non-fast-forward update;
- `stable-tag-created-by-release-workflow` tag ruleset for `v*`, sole creation
  bypass being that same App ID;
- separate `stable-tag-immutable` tag ruleset for `v*`, no bypass for update or
  deletion;
- `stable-release` environment restricted to `main`, administrator bypass
  disabled, self-review prevention enabled, approval by separate humans who did
  not assemble the evidence.

## P4 — Routine maintenance

Five open Dependabot pull requests, all GitHub Actions version bumps: #7
`actions/attest`, #8 `actions/setup-python`, #9 `codeql-action/analyze`, #10
`actions/checkout`, #11 `codeql-action/init`. The CodeQL bumps are the ones
that matter for release, because `Required CI` includes the pinned extended
JavaScript CodeQL analysis and none of it may be skipped.

## Not on this roadmap

Deliberate non-goals, restated so they are not mistaken for gaps. Scalvin does
not diagnose, determine treatment plans, act as a crisis service, or function
as a medical device, and framework text does not claim therapeutic outcomes.
See [Scope and Evidence](SCOPE-AND-EVIDENCE.md).

npm publishing is also intentionally unauthorized. GitHub source and release
publishing do not enable it; package ownership, provenance, 2FA/OIDC, and a
rollback policy must be configured first.

## Maintaining this file

Update the baseline table and its snapshot date whenever a gate's result
changes. Move an item out of this file when its gate turns green, and record
the shipped behavior in [`CHANGELOG.md`](../CHANGELOG.md) instead. Do not
record real workspace data, credentials, reviewer feedback, or local paths
here; this repository is public.
