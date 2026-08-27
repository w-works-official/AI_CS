# Google Sheet synchronization

Use this only when the workflow persists a completed masked report.

## Destination

- Optional config: `config/sheet-target.json` inside the installed skill folder. Copy `config/sheet-target.example.json` and fill only non-secret target metadata when needed.
- Development uses only the configured test Sheet and development Apps Script deployment.
- Production uses `Pink Rocket CS 운영 데이터 v1` only after explicit cutover approval.
- The web plugin never reads URL/key values from Windows or the prompt. They are server-side secrets selected by the verified OAuth subject.

## Contract

Call `sync_masked_cs_run` only after `buildReport` and the completion checks pass. The MCP server rejects environment/action/URL overrides, validates the complete schema and PII status, derives the deterministic `run_id`, and sends one allowlisted `syncRun` request. `scripts/sync-client.mjs` is legacy local-test code, not the web-plugin path.

The server is authoritative for `NEW`, `CHANGED`, and `UNCHANGED`: it compares `case_key/source_key` and `content_hash` under a document lock. Reusing the same deterministic `run_id` is idempotent.

The server may write only:

- normalized cases to `01_CASES`;
- masked messages to `02_MESSAGES`;
- AI-labelled drafts to `03_AI_DRAFTS`;
- read-only collection audits to `04_SYNC_RUNS`.

It must never write to a marketplace, send a reply, or infer a human reply from an AI draft.
