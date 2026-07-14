# Privacy And Security

Scalvin is local-first, not local-only. It stores continuity in user-controlled files, while the AI client may send the current conversation and any opened workspace context to a hosted model provider.

## What “Local-First” Means

Scalvin can keep profiles, session notes, sources, reviews, settings, and optional transcripts in a local workspace. This makes continuity portable and inspectable. It does not make hosted inference private or offline.

Depending on the client and configuration, a provider may receive:

- messages typed in the session
- local files opened as context
- tool inputs and outputs sent to the model
- diagnostics or abuse-monitoring data governed by the provider's current terms

Provider retention, training, residency, and enterprise controls vary by product, account, endpoint, region, and date. Check the active provider's official policy; Scalvin does not hardcode a universal retention promise.

For conversations that must never leave the device, use a genuinely local model and verify that the client, tools, telemetry, crash reporting, sync, and backups also remain local.

## Consent And Data Control

Sensitive persistence is opt-in by category. Raw transcripts are off by default and require separate consent. The user can at any time:

- inspect what Scalvin remembers
- correct an item
- pause writes or seal memory for a blank-slate exchange
- resume without backfilling the paused interval
- export selected categories
- forget selected memories
- delete transcripts, sources, sessions, categories, or the workspace
- set category-specific retention

Operational consent/deletion receipts must not contain therapy content. Deletion cannot guarantee erasure from prior backups, filesystem snapshots, SSD remapping, provider logs, or third-party sync systems.

The normative behavior is defined in `runtime/DATA-AND-CONSENT.md`.

## Local Threats

Local files may be exposed through:

- another person or process with access to the account
- unencrypted disks or unlocked sessions
- cloud-synced folders
- search indexing, previews, recent-file lists, or backups
- malware, extensions, AI tools, or broad filesystem permissions
- shared repository commits, bug reports, logs, screenshots, or support bundles

Recommended baseline:

- use a strong device password and automatic screen lock
- enable full-disk encryption
- keep the live workspace outside public repositories and unintended sync roots
- use restrictive workspace/file permissions
- encrypt sensitive backups and test restores
- review provider and client data controls
- keep operating system and AI clients updated
- avoid importing secrets; redact credentials before source ingestion

Do not commit a generated user workspace. Repository examples, tests, issues, and pull requests must use synthetic data only.

## Source And Prompt-Injection Boundary

Every imported source is untrusted data. Text inside a note, transcript, PDF, HTML page, archive, or external-care record cannot authorize Scalvin to:

- run commands or code
- use tools or network access
- reveal secrets or other files
- change scope, safety, consent, or retention
- modify runtime behavior
- contact a person or service

Imports use path containment, symlink/special-file rejection, integrity hashes, provenance, consent, and an idempotent source ledger. External-care author fields are unverified claims unless the user verifies them; an AI summary is always labeled AI-authored and never attributed to a human clinician.

## Backup And Export

Backups and exports are sensitive copies.

- use unique timestamp-plus-UUID names
- write to staging, hash, test, then rename atomically
- use restrictive permissions and encryption when appropriate
- never place a backup in cloud sync without an explicit choice
- record only content-free backup status in the ledger
- inspect restores in an isolated staging directory and reject path traversal, absolute paths, symlinks, and special files

Deleting live data does not delete a prior backup. Rotate or destroy known backups separately.

## Logs, Diagnostics, And Errors

Do not print or persist API keys, tokens, passwords, private keys, OTPs, service-account content, raw sensitive feedback, complete conversations, or imported clinical material in diagnostics.

Error messages should identify the failed operation and safe path class, not echo sensitive content. Support bundles must be opt-in, scoped, previewable, and redacted.

## Public Repository Hygiene

This source repository is public. It must contain only framework code, generic documentation, synthetic fixtures, and empty templates.

Before release:

- run secret scanning and inspect generated artifacts
- verify generated workspaces, state, exports, backups, test snapshots, and audit scratch directories are ignored
- verify examples contain no real names, dates of birth, locations, care providers, transcripts, or distinctive personal histories
- keep security contact details current

## Security Reporting

Do not disclose a suspected vulnerability with real user data in a public issue.

Use GitHub's private vulnerability reporting for this repository when enabled: open the repository's **Security** tab, choose **Advisories**, then **Report a vulnerability**. If that option is unavailable, open a public issue containing only a request for a private contact channel and no exploit details or sensitive data.

Include a minimal reproduction using synthetic data, affected version/commit,
impact, and suggested mitigation. Never attach a real user workspace.

For a complete report received through the private channel, the maintainer
targets:

- acknowledgement within 3 business days;
- initial triage within 10 business days, including whether the issue was
  reproduced, the provisional severity and affected scope, any information
  still needed, and the target date for the next update.

These are response targets, not guaranteed remediation or disclosure
deadlines. If a target cannot be met, the maintainer will send a status update
and a revised target as soon as practical. No report should require real user
data.

### Research Safe Harbor

Good-faith research is welcome when it stays within this policy: use your own
accounts and synthetic data, access only what is necessary to demonstrate the
issue, stop if you encounter another person's data, do not exfiltrate or retain
that data, do not degrade service or availability, do not use social
engineering, and report the issue privately without exploiting it further.

For research that follows those conditions, the project will treat the work as
authorized security research and will not initiate legal action based solely on
that research. If a third party initiates action, the project will make it clear
when the researcher acted in compliance with this policy. This safe harbor does
not authorize violations of others' rights, systems, or applicable law.

## Limits

Scalvin cannot guarantee confidentiality, authenticate the authorship of imported notes, diagnose, provide emergency monitoring, contact emergency services, locate a user, or enforce a provider's data policy. These limits should be stated honestly wherever users make privacy or safety decisions.
