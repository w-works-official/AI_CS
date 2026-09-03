# Local Playwright macro

## Canonical files

- Project: `C:/Users/hihi0/Documents/Codex/2026-08-12/cs/work/AI_CS`
- Entry point: `tools/marketplace-cs/smartstore_cs_macro.mjs`
- Package command: `npm run collect:cs`
- Playwright connection: `chromium.connectOverCDP(active local CS Chrome session)`

The macro connects to an already running remote-debuggable Chrome context. It does not launch a browser, log in, read credentials, or call `browser.close()`. Normal runs resolve `%LOCALAPPDATA%/PinkRocketCS/active-browser.json`; `SMARTSTORE_CDP_URL` remains an explicit loopback-only override.

## Start or select the local CS Chrome

Run `scripts/start-cs-chrome.cmd` once during operator setup. It reuses a Chrome endpoint already listening on port 9222 or opens a visible Google Chrome with a dedicated per-Windows-user data directory. The user signs in manually. It records only the loopback CDP URL, process ID, non-secret browser instance ID, label, and timestamp. A later process on the same port is rejected when its instance ID differs.

An unregistered Chrome already listening on that port is not adopted automatically. After visually confirming that it is the intended CS Chrome, the operator may explicitly register it once with `scripts/start-cs-chrome.cmd -RegisterExisting`. The launcher never chooses an existing profile on the operator's behalf.

Do not bind the session to a person's name or an ordinary Chrome window title. Scheduled collection reuses the registered session and never launches or switches browsers automatically. Whale and non-loopback endpoints are rejected. The macro uses a local lock so two collection runs on the same PC cannot overlap.

## Safe vertical-slice invocation

The launcher-managed session requires no persistent profile name or CDP environment variable. Set only non-secret run controls directly. Omit explicit dates for the normal operational candidate refresh:

```powershell
$env:CS_CHANNELS = 'comments'
$env:CS_COLLECTION_PROFILE = 'operational'
$env:CS_RUN_MODE = 'collect_and_reconcile'
$env:CS_SYNC_MODE = 'prepare'
$env:CS_KEEP_MASKED_OUTPUT = '1'
npm run collect:cs
```

For an explicitly selected remote-debuggable Google Chrome on the same PC, `SMARTSTORE_CDP_URL` may be set for that process. Only `http://127.0.0.1:<port>`, `http://localhost:<port>`, or the IPv6 loopback equivalent is accepted.

`prepare` is the default and performs no D1 write. It may use the read-only development D1 case index to classify records. The masked report is written below the macro project's `output/` directory and its path is returned as `masked_output`.

`collect_and_reconcile` with `CS_COLLECTION_PROFILE=operational` is the normal mode. With no date variables it checks the latest 7 days, reads the D1 case index before collection, and opens chat details only for new, unread, changed-preview, `NEEDS_REPLY`, or `REVIEW` candidates. There is no whole-run elapsed-time limit. Playwright navigation, detail-load, and selector waits remain individually bounded. The skill runs this command once per channel and completes AI generation plus D1 sync before advancing. Candidate scans deliberately declare `history_scan_complete=false`; an omitted completed room is not treated as missing or closed. Use `CS_COLLECTION_PROFILE=backfill` for a separately requested historical batch; the default is 30 days and `CS_LOOKBACK_DAYS` accepts 1–90. Explicit `CS_START_DATE`/`CS_END_DATE` remain bounded diagnostics. The macro carries hashed source keys only from complete unanswered views when a marketplace proves that view. It never changes marketplace state.

## Supported channel controls

`CS_CHANNELS` accepts a comma-separated subset of `comments`, `customer_qna`, `customer_center`, `talktalk`, `zigzag_order_inquiry`, `zigzag_item_question`, and `ably_inquiry`. While Smartstore reauthentication is pending, the current rollout uses `ably_inquiry,zigzag_order_inquiry,zigzag_item_question` only.

## Masked report contract

The output file is schema version 1 with `range`, `collected_at`, `duration_ms`, `summary`, `channels`, and masked `records`. Every record contains `source_key`, `content_hash`, reply state, PII scan, masked customer/order fields, messages, seller replies, and optional AI draft fields. When an inquiry region can be isolated, the record also contains a bounded JPEG `source_snapshot` captured only after the cloned DOM text and sensitive attributes are masked. Raw records and raw screenshots are not written.

Standard output contains only the range, selected channel names, masked summary, masked output path, and sync status. Do not enable full raw logging.

## Development sync preflight

The collector does not need a write secret in `prepare` mode. Before later synchronization, load these existing Windows user variables without displaying them:

- `MARKETPLACE_CS_D1_URL` (optional; omission uses the fixed approved development URL)
- `MARKETPLACE_CS_D1_SYNC_KEY`
- `MARKETPLACE_CS_SYNC_ENVIRONMENT=development`

The URL and key must be the existing development D1 Worker target. Apps Script URL/key variables are ignored by the collector. Never create or rotate secrets during a collection run. D1 health must pass before the single per-channel `syncReport()` call. Screenshot-heavy reports are split internally into bounded idempotent requests; this is transport batching, not a second collection or duplicate logical sync.
