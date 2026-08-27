# Local Playwright macro

## Canonical files

- Project: `C:/Users/hihi0/Documents/Codex/2026-08-12/cs`
- Entry point: `smartstore_cs_macro.mjs`
- Package command: `npm run scrape`
- Playwright connection: `chromium.connectOverCDP(active local CS Chrome session)`

The macro connects to an already running remote-debuggable Chrome context. It does not launch a browser, log in, read credentials, or call `browser.close()`. Normal runs resolve `%LOCALAPPDATA%/PinkRocketCS/active-browser.json`; `SMARTSTORE_CDP_URL` remains an explicit loopback-only override.

## Start or select the local CS Chrome

Run `scripts/start-cs-chrome.cmd` once during operator setup. It reuses a Chrome endpoint already listening on port 9222 or opens a visible Google Chrome with a dedicated per-Windows-user data directory. The user signs in manually. It records only the loopback CDP URL, process ID, non-secret browser instance ID, label, and timestamp. A later process on the same port is rejected when its instance ID differs.

Do not bind the session to a person's name or an ordinary Chrome window title. Scheduled collection reuses the registered session and never launches or switches browsers automatically. Whale and non-loopback endpoints are rejected. The macro uses a local lock so two collection runs on the same PC cannot overlap.

## Safe vertical-slice invocation

The launcher-managed session requires no persistent profile name or CDP environment variable. Set only non-secret run controls directly:

```powershell
$env:CS_START_DATE = (Get-Date).ToString('yyyy-MM-dd')
$env:CS_END_DATE = $env:CS_START_DATE
$env:CS_CHANNELS = 'comments'
$env:CS_SYNC_MODE = 'prepare'
$env:CS_KEEP_MASKED_OUTPUT = '1'
npm run scrape
```

For an explicitly selected remote-debuggable Google Chrome on the same PC, `SMARTSTORE_CDP_URL` may be set for that process. Only `http://127.0.0.1:<port>`, `http://localhost:<port>`, or the IPv6 loopback equivalent is accepted.

`prepare` is the default and performs no Apps Script or Sheet write. The masked report is written below the macro project's `output/` directory and its path is returned as `masked_output`.

## Supported channel controls

`CS_CHANNELS` accepts a comma-separated subset of `comments`, `customer_qna`, `customer_center`, `talktalk`, `zigzag_order_inquiry`, `zigzag_item_question`, and `ably_inquiry`. While Smartstore reauthentication is pending, the current rollout uses `ably_inquiry,zigzag_order_inquiry,zigzag_item_question` only.

## Masked report contract

The output file is schema version 1 with `range`, `collected_at`, `duration_ms`, `summary`, `channels`, and masked `records`. Every record contains `source_key`, `content_hash`, reply state, PII scan, masked customer/order fields, messages, seller replies, and optional AI draft fields. Raw records are not written.

Standard output contains only the range, selected channel names, masked summary, masked output path, and sync status. Do not enable full raw logging.

## Development sync preflight

The collector does not need Apps Script secrets in `prepare` mode. Before later synchronization, load these existing Windows user variables without displaying them:

- `MARKETPLACE_CS_SYNC_URL`
- `MARKETPLACE_CS_SYNC_KEY`
- `MARKETPLACE_CS_SYNC_ENVIRONMENT=development`

The URL and key must be the same existing development Apps Script target already used by the development system. Never create or rotate them during a collection run. Health must pass before `syncReport()` is called.
