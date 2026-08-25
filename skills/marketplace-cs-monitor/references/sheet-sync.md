# Google Sheet synchronization

Use this only when the workflow persists a completed masked report.

## Destination

- Optional config: `config/sheet-target.json` inside the installed skill folder. Copy `config/sheet-target.example.json` and fill only non-secret target metadata when needed.
- Spreadsheet: `Pink Rocket CS 운영 데이터 v1`
- The Apps Script web-app URL comes from `MARKETPLACE_CS_SYNC_URL`.
- The write key comes from `MARKETPLACE_CS_SYNC_KEY`; never print or store it in reports.

## Contract

Import `scripts/sync-client.mjs`, load the config, and call `syncReport(report, config)` only after `buildReport` and the completion checks pass. The client sends one `syncRun` request containing the masked report.

The server is authoritative for `NEW`, `CHANGED`, and `UNCHANGED`: it compares `case_key/source_key` and `content_hash` under a document lock. Reusing the same deterministic `run_id` is idempotent.

The server may write only:

- normalized cases to `01_CASES`;
- masked messages to `02_MESSAGES`;
- AI-labelled drafts to `03_AI_DRAFTS`;
- read-only collection audits to `04_SYNC_RUNS`.

It must never write to a marketplace, send a reply, or infer a human reply from an AI draft.
