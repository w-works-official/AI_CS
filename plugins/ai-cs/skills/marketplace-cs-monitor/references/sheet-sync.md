# Development D1 synchronization

The filename is retained for older skill links. Local collection no longer synchronizes operational cases through Google Sheets or Apps Script.

## Destination

- Fixed API: `https://ai-cs-mcp-development.kimhyein0214.workers.dev/api/cs`
- Optional non-secret config: `config/d1-target.json`, copied from `config/d1-target.example.json`
- Hidden Windows user secret: `MARKETPLACE_CS_D1_SYNC_KEY`
- Required environment: `MARKETPLACE_CS_SYNC_ENVIRONMENT=development`

Prompts cannot override the host, environment, key, or write policy. Production is not supported by this local collector.

## Contract

After `buildReport` and all completion checks pass, `scripts/sync-client.mjs` sends exactly one UTF-8 JSON request to `/api/cs/sync`. The D1 server is authoritative for case/message/draft upserts and deterministic `run_id` idempotency.

Before writing, require `/api/cs/health` to return `ok=true`, `environment=development`, `auto_send=false`, and `marketplace_write_actions=0`. The local client sends the key only through `X-CS-Sync-Key`; it never prints it or puts it in a URL. Apps Script environment variables are ignored.

When a report contains `operational_refresh`, `ready` must be true. A missing same-window case from a complete history scan or a list-count mismatch rejects the request locally before any HTTP write. Incomplete pagination never closes a case and remains visible as a run warning.

The collector reads the paginated D1 case index for `source_key + content_hash` comparison and reads at most three `quality_state=USE` answer-library examples for grounded draft generation. Only masked DTOs may cross the boundary. A failed PII check rejects the write.

Complete unanswered snapshots may reconcile a previously open case only when channel, count, date window, and completeness checks pass. One absence yields `REVIEW`; two consecutive absences yield `CLOSED`; reappearance yields `NEEDS_REPLY`.

Apps Script remains a narrow relay for the public review Site's template, learning, and review mutations. It is not part of local collection synchronization.
