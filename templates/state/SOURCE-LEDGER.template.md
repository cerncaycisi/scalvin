# Source Ledger

One row per immutable source revision. This operational ledger contains no source content and no absolute paths.

| Source ID | Revision | Imported at | Source date | Kind | Claimed author role | Locale | SHA-256 | Bytes | Trust | Status | Consent event | Retention | Last integrated hash | Last integrated at | Derived memory IDs | Error code | Error message |
|---|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|

Statuses: `pending_consent`, `ready`, `integrated`, `rejected`, `superseded`, `deleted`, `failed`.

Use stable lowercase `src-<uuid-v4>` IDs. An exact `(source ID, revision, SHA-256)` tuple is idempotent. Changed bytes create the next revision under an explicitly selected existing ID; otherwise they receive a new source ID. `Locale` is optional BCP-47 metadata and never changes trust, authority, consent, or execution rules.
