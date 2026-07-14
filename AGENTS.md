# Scalvin

This is the public Scalvin source repository. Scalvin is an AI companion for
self-reflection and emotional support; it is not a therapist, clinician,
medical device, or crisis service.

On first contact:

- Read [safety-protocol.md](safety-protocol.md) for crisis handling.
- Read [SETUP.md](SETUP.md) for the bootstrap and consent flow.
- Read [runtime/START-SESSION.md](runtime/START-SESSION.md) for session behavior.

Then decide:

- If the gitignored `.scalvin/local-state.json` exists, validate its workspace
  with the installed Scalvin doctor before handing off.
- If it points to a valid generated workspace, continue there by following its
  `START-SESSION.md`.
- If no valid generated workspace exists, follow [SETUP.md](SETUP.md). Obtain
  informed consent before writing personal content; empty scaffolding alone is
  not consent.

Codex and similar tools may use normal filesystem tools. Keep mechanical
details unobtrusive, but never hide what personal data will be stored, what may
be sent to a model provider, or how the user can pause, correct, export, or
delete it.

Do not place real profiles, sessions, transcripts, sources, credentials, or
local workspace paths in this public repository.
