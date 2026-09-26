# Roadmap

Maintainer planning document for the unreleased `1.0.0` development line.

This file records what currently blocks a stable release, in the order the
blockers unblock each other. It is a work plan, not a schedule, not a promise,
and not evidence of review. Nothing here states that a gate has been passed;
the gates themselves remain the authority. Listing the clinical and safety
review as planned work does not imply that any review has started, been
scoped, or been approved.

Scope boundaries in [Scope and Evidence](SCOPE-AND-EVIDENCE.md) apply to this
document. Release mechanics live in [`RELEASING.md`](../RELEASING.md); shipped
and unshipped behavior lives in [`CHANGELOG.md`](../CHANGELOG.md). This file
adds only ordering and current state.

## Measured baseline

Snapshot taken 2026-09-26 on `main` after pull requests #14 and #15 plus this
file's freshness and pinning changes, by running each gate. Refresh this table by re-running the commands rather than editing it by
hand.

| Gate | Command | Result |
|---|---|---|
| Syntax | `npm run check:syntax` | pass, 112 JavaScript files |
| Emergency resources | `npm run check:emergency-resources` | pass, earliest expiry 2026-10-25 |
| Manifest | `npm run check:manifest` | pass, 122 files |
| Package inventory | `npm run check:package-inventory` | pass |
| Documentation links | `npm run check:links` | pass, 105 files |
| Public-repository scan | `npm run check:public` | pass |
| Test suite | `npm test` | pass, 631 pass / 0 fail / 8 skipped of 639 |
| Stable readiness | `node scripts/verify-stable-readiness.mjs` | **blocked**, 7 blockers |

## P0 — Keep the emergency-resource registry current

The registry carries a 30-day TTL. The CA, TR, and US entries were
re-verified on 2026-09-25 and expire on 2026-10-25. A stale registry no longer
disables mechanical screening; it is reported as a separate
`emergencyResources` state, and the release gate still fails on it.

The `Emergency resource freshness` workflow runs weekly with
`--fail-expiring` and fails 14 days before the earliest expiry, so
re-verification is planned work. Re-verification stays manual: open every
`officialSource`, confirm the contacts, then update `verifiedAt` and the
derived `expiresAt`. Tests derive their dates from the registry, so this is a
pure data edit. Never advance the dates without re-verifying.

## P1 — Architecture gate

`scripts/verify-stable-readiness.mjs` reports 7 blockers. Per
[`RELEASING.md`](../RELEASING.md), this gate is intentionally red in the
current `broker_only_unattested` preview.

Capability broker:

- the hard private-data boundary is not implemented;
- the typed private read/write surface is incomplete;
- the isolated tool-free and network-free source worker is not attested.

Per-adapter effective-launch attestation is unavailable for `claude-code`,
`codex`, and `generic`, and `generic` has no enforceable private-data boundary.

Engineering probes (recorded in the
[experiment log](ENGINEERING-EXPERIMENT-LOG.md)) now exist for Codex 0.156 and
Claude Code 2.1.281 on Linux: private reads were denied by the client
permission or sandbox layer, and the broker, framework resources, and source
worker ran end to end. These are single-version, single-platform engineering
records, not the independent exact-candidate attestation the gate requires.

Open decision: implement an enforceable boundary for the `generic` adapter, or
exclude it from the stable release and narrow `requiredClientAdapters` in
`evals/release-evidence-policy.json`. Carrying a preview-only adapter into a
stable release is not available, because the gate fails closed on it.

## P2 — Independent human gates

These cannot be automated and are the long pole. Each requires a person who
is not the author of the evidence.

**Clinical and safety review.**
[`docs/CLINICAL-SAFETY-REVIEW.md`](CLINICAL-SAFETY-REVIEW.md) records status
`not completed`. A stable release is blocked until an artifact tied to the
exact release commit records the reviewed scope, hashes, reviewer role and
conflicts, and a decision.

**Fluent locale reviewers.** Every bundled mechanical locale pack requires an
independent fluent reviewer in addition to the deterministic corpus. See
[Localization](LOCALIZATION.md).

**Captured-response evidence.** At least one provider/model/adapter tuple per
shipped adapter, covering every locale case in the exact corpus, captured from
the exact candidate commit, with the bindings in
[Stable Release Evidence](RELEASE-EVIDENCE.md). A maintainer must also read the
real responses for contextual quality.

**Small usability study.** Before widening scope, a short study with a few
volunteers on synthetic-first workspaces should measure setup time, time to a
first useful session, consent-flow friction, wrong or stale memory use,
correction outcomes, backup restore, and next-week return. Operational
measures come first; this is not evidence of efficacy.

## P3 — Repository controls

Verified server-side on 2026-09-25:

- `main-pr-required-ci` is active: pull request required, strict
  `Required CI` from GitHub Actions App ID `15368`, no deletion or
  non-fast-forward update, no bypass;
- `stable-tag-immutable` is active for `v*`: no update or deletion, no bypass.

Still open:

- `stable-tag-created-by-release-workflow` cannot be created as specified on a
  user-owned repository, because GitHub accepts the Actions integration as a
  bypass actor only for organization-owned repositories. Move the repository
  to an organization, or record an alternative in `RELEASING.md`;
- the `stable-release` environment protections have not been verified.

## P4 — Routine maintenance

The CodeQL workflow test asserts the property that carries the security value
(every action pinned to a full commit SHA, CodeQL `init` and `analyze` on the
same commit, scheduled and required analyses in sync) instead of one literal
SHA, so legitimate action bumps can pass `Required CI`. Dependabot pull
requests are reviewed and merged when green.

The central `cli/operations.js` module is over 4,700 lines. Split domain
transitions (memory, source, session, data controls) into modules only where a
change needs it, keeping one shared transaction engine.

## Not on this roadmap

Scalvin does not diagnose, determine treatment plans, act as a crisis service,
or function as a medical device, and framework text does not claim therapeutic
outcomes. See [Scope and Evidence](SCOPE-AND-EVIDENCE.md).

npm publishing is intentionally unauthorized. Package ownership, provenance,
2FA/OIDC, and a rollback policy must be configured first.

## Maintaining this file

Update the baseline table and its snapshot date whenever a gate's result
changes. Move an item out of this file when its gate turns green, and record
the shipped behavior in [`CHANGELOG.md`](../CHANGELOG.md) instead. Do not
record real workspace data, credentials, reviewer feedback, or local paths
here; this repository is public.
