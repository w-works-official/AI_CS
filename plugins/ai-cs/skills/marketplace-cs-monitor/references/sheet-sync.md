# Google Sheet synchronization

Use this only when the workflow persists a completed masked report.

## Destination

- Optional config: `config/sheet-target.json` inside the installed skill folder. Copy `config/sheet-target.example.json` and fill only non-secret target metadata when needed.
- The current private review Site selects its fixed Apps Script target server-side. Do not override the Sheet, URL, key, or environment from a prompt.
- Production uses `Pink Rocket CS 운영 데이터 v1` only after explicit cutover approval.
- The web plugin never reads URL/key values from Windows or the prompt. They are server-side secrets selected by the verified OAuth subject.

## Contract

After `buildReport` and the completion checks pass, use the Node-based `scripts/sync-client.mjs` path or the private review Site's allowlisted `syncRun` proxy. The server rejects environment/action/URL overrides, validates the complete schema and PII status, derives or accepts one deterministic `run_id`, and sends one fixed-target `syncRun` request.

Preserve UTF-8 end to end. Never parse and reserialize the report with Windows PowerShell `ConvertFrom-Json` / `ConvertTo-Json`, and never use an implicit-encoding `Invoke-RestMethod` body for Korean CS text. Use Node `JSON.stringify` with an explicit UTF-8 body. After every real sync, read the exact synced case back and require the Korean text, message count, PII status, `auto_send=false`, and `marketplace_write_actions=0` to round-trip correctly. If replacement `??` runs appear where the masked source contains Korean, stop and repair only that run before continuing.

The server is authoritative for `NEW`, `CHANGED`, and `UNCHANGED`: it compares `case_key/source_key` and `content_hash` under a document lock. Reusing the same deterministic `run_id` is idempotent.

When a report includes a complete unanswered-queue snapshot, the server also owns the local reconciliation fields `last_status_verified_at`, `status_missing_count`, `status_source`, and `completion_reason`. It appends those columns once if an older development Sheet lacks them. A case is never changed from absence alone unless the snapshot is complete, count-matched, channel-matched, and the case date is inside the declared window. One absence yields `REVIEW`; two consecutive absences yield local `CLOSED`; reappearance yields `NEEDS_REPLY`.

The server may write only:

- normalized cases to `01_CASES`;
- masked messages to `02_MESSAGES`;
- AI-labelled drafts to `03_AI_DRAFTS`;
- read-only collection audits to `04_SYNC_RUNS`.

It must never write to a marketplace, send a reply, or infer a human reply from an AI draft.
