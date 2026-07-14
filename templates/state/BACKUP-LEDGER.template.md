# Backup Ledger

Operational records only. Never list therapy content.

| Backup ID | Created at | Scope | Destination class | Encryption | Archive SHA-256 | Integrity check | Restore check | Status | Deleted at |
|---|---|---|---|---|---|---|---|---|---|

`Destination class` should be a non-sensitive label such as `local_user_selected`, not a full path exposed in conversation. Use stable `backup-<uuid>` IDs.

Operation receipts contain no paths or user content. A failed operation records
only its stable error code.

| Event ID | At | Operation | Backup ID | Phase | Status | Error code |
|---|---|---|---|---|---|---|

Reminder state:

- Last successful backup: null
- Last successful backup SHA-256: null
- Last destination class: null
- Sessions since successful backup: 0
- Last reminder at: null
- Reminder declined until: null
