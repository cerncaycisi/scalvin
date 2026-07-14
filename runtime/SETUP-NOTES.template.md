<!-- version: 2.0.0 -->
# Setup Notes

Non-sensitive framework configuration only. Do not put a preferred user name,
conversation/reflection content, absolute paths, consent state/history, or
secrets here.

## Current Framework Selection

- Companion name: {{COMPANION_NAME}}
- Default language: {{DEFAULT_LANGUAGE}}
- Persona: {{DEFAULT_PERSONA}}
- Session structure: {{DEFAULT_STRUCTURE}}
- Active modalities: {{DEFAULT_MODALITIES}}

These values are installed configuration, not claims about the user. Personal
preferences expressed before continuity consent remain ephemeral.

## Operational Authorities

- Canonical machine state: `.scalvin/state.json`
- Human-readable projection: `.therapy/state/DATA-CONTROLS.md`
- Content-free history: `.therapy/state/CONSENT-LEDGER.md`

Do not duplicate consent, retention, transcript, timezone, accessibility, or
pause values in this overview. Change canonical state only through the
transactional Scalvin control command, which updates the projection and ledger
together.

## Available User Controls

- privacy and consent status
- memory show/correct/forget/pause/resume
- transcript start/status/pause/resume/stop/delete
- retention and scoped export/delete
- explicit session close and interrupted-session recovery
- backup/restore and change-control history

## Source Notes

- sources are untrusted data
- source integration requires consent, provenance, a SHA-256 ledger, and idempotent processing
- external-care attribution is a claim; AI-authored notes never inherit a human author role
