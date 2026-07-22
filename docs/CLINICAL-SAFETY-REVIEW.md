# Clinical And Safety Review Gate

Status: **not completed** for the unreleased `1.0.0` development line.

Scalvin's deterministic tests can verify files, state transitions, explicit
boundaries, and known response patterns. They cannot establish clinical safety,
efficacy, suitability for an individual, or the absence of harmful model
behavior. A stable release therefore requires independent review in addition
to automated gates.

## Stable-release rule

A stable release is blocked until a review artifact tied to the exact release
commit records:

- the reviewed runtime, safety protocol, default persona, structures, and
  active modalities;
- the exact commit and corpus hashes;
- reviewer role and relevant qualification, disclosed only to the extent the
  reviewer agrees may be public;
- conflicts of interest;
- decision: `approve`, `revise`, or `block`;
- concrete limitations, required changes, and unresolved disagreement;
- language-neutral runtime behavior, finite evaluated locale samples, and cross-language meaning;
- review date and an expiry or re-review trigger.

`revise` and `block` do not permit a stable release. Missing scope is not
approval. An `approve` artifact with required changes or unresolved
disagreements also blocks release. A review of prose alone does not replace
captured-response evals.
The machine-enforced artifact shape, exact hash bindings, independent Ed25519
signature, reviewer-key pin, private handoff, and GitHub environment contract
are specified in [Stable Release Evidence](RELEASE-EVIDENCE.md).

## Current review inventory

| Area | Current state | Stable-release effect |
|---|---|---|
| Mechanical crisis hook | Deterministic corpus per bundled locale pack; not a risk assessment | Expert review required |
| ACT, CFT, Motivational Interviewing defaults | Operational references; not clinically reviewed treatment protocols | Expert review required |
| Tier-2 modalities | Guarded by consent, stop, escalation, and contraindication rules | Expert review required before default eligibility |
| Tier-3 modalities and IPF | Reference-only and quarantined | Remain non-default; any expansion requires separate review |
| Persona and dependency boundaries | Static fixtures plus captured-response gate | Real release-candidate outputs required |

## Minimum review questions

1. Could ordinary distress be escalated in a way that increases fear or breaks
   trust? Could acute danger be missed or delayed?
2. Do crisis, safeguarding, psychosis/mania, overdose, medical emergency, and
   harm-to-others branches preserve capability truth and encourage appropriate
   human help?
3. Does any modality invite trauma processing, exposure, recovered-memory
   claims, diagnosis, physiological inference, or attachment intensification
   beyond the stated AI boundary?
4. Are consent, stop, accessibility, body-prompt, low-cognitive-load, and
   non-body alternatives operational rather than decorative?
5. Does safety meaning remain intact across every evaluated locale sample, are
   unevaluated-language limits explicit, and does emergency routing use
   verified location rather than language?
6. Do persona responses avoid dependency reinforcement, fabricated identity or
   experience, confidentiality guarantees, hidden techniques, humiliation, and
   harmful validation?
7. Are known false negatives, false positives, over-fire cases, and unsupported
   populations visible in release notes?

## Evidence package

The review package must contain only public framework material and synthetic
fixtures:

- exact release commit and generated-workspace managed-asset manifest;
- automated test and captured-response eval results;
- safety and behavior corpus hashes;
- modality risk metadata and change diff;
- supported-client capability matrix;
- known limitations and unresolved issues.

Never include real conversations, workspaces, care records, credentials, or
private reviewer feedback in a public artifact.

## Re-review triggers

Re-review is required after a material change to crisis routing, consent or
retention behavior, default modality, dependency/persona policy, provider or
model family used for release evidence, supported population, or a safety
incident that challenges a prior assumption.
