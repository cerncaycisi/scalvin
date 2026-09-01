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

1. **Blocked — needs a human or an egress allowance.** Tracked as issue #12,
   which carries the per-source checklist. Re-verify every `officialSource` for
   CA, TR, and US against the live official page, then update `verifiedAt` and
   the derived `expiresAt`. The checker performs no network fetch by design, so
   this step is manual and cannot be delegated to CI. Do not advance the dates
   without re-verifying; the dates are the assertion, not a formality.

   All five sources are currently unreachable from the agent session that
   raised this item, because the egress policy denies `www.canada.ca`,
   `www.112.gov.tr`, and `www.911.gov`. Either a maintainer performs the
   verification, or those three hosts are allowed for the session that does.

   Refreshing the dates also requires updating the exact `verifiedAt` and
   `expiresAt` values asserted in `tests/safety/emergency-resources.test.cjs`,
   so this is not a pure data edit.

2. Re-run `npm run check` and `npm test` after item 1 and confirm the suite
   returns to 0 failures.

3. **Done.** Ownership and cadence for the 30-day TTL. The checker now emits a
   lead-time notice while the registry is still current, and a scheduled
   `Emergency resource freshness` workflow runs it weekly with
   `--fail-expiring`, so an approaching lapse surfaces before the expiry date
   instead of on it. The fail-closed stale behavior is unchanged, and the
   notice is deliberately not a runtime capability state.

   That job is not running yet. GitHub runs `schedule` triggers only from the
   default branch's copy of a workflow file, and both the notice and the
   workflow are still on the branch in #13. The early warning starts protecting
   the next expiry once that branch merges, which waits on item 1. Clearing
   item 1 is therefore what both fixes the current red and switches the future
   warning on.

Item 3 stops the recurrence; item 1 still has to be done by a person.

### Reason-code precedence: resolved as not-a-defect

An earlier revision of this roadmap listed the reason-code overlap as an open
design question, on the grounds that a stale registry supersedes the reason
code a test is exercising. On review it should stay as it is.

When the registry is stale the mechanical backstop genuinely is degraded, and
a workspace built on it genuinely does warrant a doctor warning. Tests that
assert a clean doctor run or a specific hook reason code are therefore failing
honestly, and relaxing them — by pinning time, injecting a fresh fixture
registry, or reordering the reason codes — would make the suite green while a
real degradation persisted. Freshness is the fix; the coupling is the feature.
The one narrow exception was the checker reporting a usage error as
`EMERGENCY_RESOURCE_REGISTRY_LOAD_FAILED`, which is now a distinct usage
message.

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

All five were red, and not because the bumps were wrong.
`tests/repository/codeql-workflow.test.mjs` asserted the literal
`actions/checkout` and `github/codeql-action` commit SHAs, so every legitimate
bump failed `Required CI` by construction. PR #11's run on 2026-08-01 — while
the registry was still current — failed only that assertion.

The test now asserts the property that carries the security value: every action
in every workflow resolves to a full 40-hex commit SHA, CodeQL `init` and
`analyze` run the same pinned commit, the scheduled and `Required CI` analyses
do not drift apart, and no step uses a floating `@vN` tag. Pinning a literal
SHA in a test that lives beside the workflow never gated an unauthorized
change — an edit would touch both files — so nothing was given up.

These pull requests still need item P0-1 before they can go green, because
`npm run check` fails for every branch while the registry is stale.

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
