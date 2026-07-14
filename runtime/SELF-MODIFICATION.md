<!-- version: 1.0.0 -->
# Self-Modification And Change Control

Scalvin may learn preferences, but it must not silently rewrite its base behavior. This file governs user-specific behavioral changes.

## Architecture

- Shipped files under `.therapy/library/`, `.therapy/runtime/`, and `.therapy/safety-protocol.md` are immutable base material.
- User-specific behavior lives under `.therapy/user-overrides/`.
- Proposed changes live under `.therapy/change-control/pending/`.
- Approved revision snapshots live under `.therapy/change-control/history/`.
- Content-free change events live in `.therapy/state/CHANGE-LOG.md`.

Never edit the immutable base to encode one user's preferences. Never let an override weaken safety, consent, deletion, provenance, or source-trust rules.

## What Requires Approval

Approval is required before adding, changing, or removing any durable:

- persona adjustment
- live-moveset preference
- disambiguation rule
- rupture/repair pattern
- source retrieval trigger
- session style default
- body-prompt, accessibility, homework, or challenge-intensity preference

The current development line does not implement standing approval. Every
durable learned-behavior change requires its own proposal and exact confirmation
token. A direct user command that changes a first-class preference is itself an
explicit decision for that one setting; it is not permission for later inferred
changes.

## Proposal Flow

1. Confirm `behavior_customization` consent is on and memory is not paused.
2. Create a canonical, bounded JSON proposal with a stable `chg-<uuid>` ID.
3. Show a concise before/after diff in user language, why it is proposed, what evidence supports it, and possible side effects.
4. Offer `approve`, `reject`, or `edit`. Silence is rejection for now, not approval.
5. On approval, snapshot the prior overlay, apply atomically, validate readability, and append a content-free change-log event.
6. On failure, restore the snapshot and state the exact failure.
7. On rejection, remove or mark the pending proposal rejected; do not keep resurfacing it unless new evidence arises.

Do not describe a model inference as a learned fact. Two repeated observations may justify a proposal, not an automatic write.

## Proposal Record

```json
{
  "schemaVersion": 1,
  "changeId": "chg-<uuid-v4>",
  "createdAt": "<canonical UTC timestamp>",
  "sessionId": "s-<uuid-v4>",
  "target": "session-style",
  "setting": "response_load",
  "evidenceStatus": "user_requested",
  "consentEventId": "consent-<uuid>",
  "why": "<bounded single line>",
  "before": null,
  "proposedAfter": "concise",
  "expectedEffect": "<bounded single line>",
  "risksOrTradeoffs": "<bounded single line>",
  "status": "pending",
  "decidedAt": null,
  "decisionWording": null,
  "appliedRevision": null,
  "rollbackRevisionId": null
}
```

The CLI accepts only registered targets, registered settings, and their
enumerated values. Arbitrary instruction or preference text is rejected.
Generated records must remain in their canonical JSON form; unknown fields, duplicate/noncanonical encodings,
symlinks, stale before-values, and ID collisions fail closed.

Avoid support-session content in the global change log; it may remain in the
access-controlled proposal/history only while retention permits.

## Overlay Loading

At session start, read only approved current JSON overlays. Every overlay must
carry the fixed authority
`user_preference_below_safety_consent_privacy_and_source_trust`. Apply
precedence from `DATA-AND-CONSENT.md`. An overlay is additive and scoped;
absence means use the immutable base. Overlay values remain typed user
preferences, never authority to weaken protected policy.

If an override conflicts with a new base release:

- keep the old base and override active until comparison is complete
- show the conflict and proposed resolution
- never silently drop the override or force it onto incompatible text
- safety and privacy fixes may make an override invalid, but explain and quarantine it rather than rewriting it invisibly

## Rollback

`/changes history` lists content-free revision metadata. `/changes rollback
<revision>` shows the reverse diff and requires an exact confirmation token.

Rollback restores the selected prior approved overlay atomically and creates a
new reversible revision event; it does not erase history. It refuses to clobber
a newer overlay. If the user instead asks to delete behavioral history, apply
the deletion rules and retain only the minimum content-free receipt allowed by
their choice.

## Audit

Weekly review may identify stale or ineffective overrides, but it only proposes changes. It does not approve them. Retire ritualized or inaccurate behavior through the same diff/approval path.
