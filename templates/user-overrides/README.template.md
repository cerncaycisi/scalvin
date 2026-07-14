# User Overrides

Approved, user-specific behavior layered over immutable shipped defaults.

Possible scoped overlays:

- `persona.json`
- `live-moveset.json`
- `disambiguation.json`
- `rupture-and-repair.json`
- `source-triggers.json`
- `session-style.json`
- `accessibility.json`

Every active entry is canonical generated JSON, references an approved
`chg-<uuid>` and revision, and carries the fixed authority
`user_preference_below_safety_consent_privacy_and_source_trust`. No override may
weaken safety, consent, deletion, retention, provenance, source trust, or
accessibility/body-prompt boundaries.

Base updates do not silently rewrite overlays. Conflicts are quarantined and resolved through a proposed diff. Rollback creates a new event and restores a verified prior snapshot.
