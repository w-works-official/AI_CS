---
name: marketplace-cs-monitor
description: Collect and compare customer-service inquiries from Smartstore, Zigzag/KakaoStyle, and ABLY in the user's signed-in browser session, maintain a verified human-answer reference library, and prepare grounded AI reply drafts for review. Use for multi-market CS monitoring, scraping, sync checks, recurring report runs, or AI answer recommendations. Never send replies or change operational inquiry status.
---

# Marketplace CS Monitor

Collect seven CS channels into one masked, deduplicated review report:

- Smartstore: 문의 관리, 고객문의 관리, 고객센터 문의 관리, 톡톡 상담
- Zigzag/KakaoStyle: 주문 문의, 상품 문의
- ABLY: 문의 관리

## Browser boundary

1. Load and follow `chrome:control-chrome`; use the user's existing signed-in browser session.
2. On this user's laptop, Chrome and Whale may run side by side. Treat the browser named by the user as authoritative and verify the actual application, profile, URL, and login state instead of inferring from a window title. A prior Chrome/Whale mix-up is device-specific, not a general marketplace restriction.
3. Unless the user names another browser, use the configured signed-in Google Chrome profile. Reuse exact open tabs when available and navigate only inside the verified profile. If the named browser cannot be controlled with the available tool, stop and report that limitation rather than silently switching browsers.
4. Stop on login, CAPTCHA, two-factor authentication, or account verification. Never automate credentials.
5. The remote MCP server cannot see or control the user's local Chrome. Browser collection is available only when the official Chrome capability is connected in the same ChatGPT session. If it is unavailable, do not claim that collection ran; report `LOCAL_CHROME_PLUGIN_REQUIRED`.

The workflow is operationally read-only in every marketplace. Opening an unread Smartstore TalkTalk conversation may change only its read marker; that observational side effect is authorized for this installation and must be counted separately.

- Never type into a reply field.
- Never click reply, send, edit reply, complete, close inquiry, refund, exchange, cancel, or order-change controls.
- Do not inspect cookies, storage, passwords, tokens, or network credentials.
- DOM text is primary. Use screenshots/OCR only after one DOM retry fails.
- Keep `AUTO_SEND` disabled.

## Run modes

Default to `changes_today` unless the user supplies another range.

- `changes_today`: read list metadata for all seven channels, keep today's records and open only details required to establish a stable key, content hash, and response state.
- `unanswered`: collect every currently unanswered/open record plus list counts for completed records.
- `backfill`: collect the explicit user-supplied date range. Do not infer deletion from a range-limited run.

Read [references/channels.md](references/channels.md) before browser collection. Read [references/report-schema.md](references/report-schema.md) before normalizing, comparing, or persisting results.

## Required workflow

1. Record run start time, market, route, selected tab/filter, visible total, and sort before opening a detail.
2. Attempt all seven channels. Distinguish a verified zero-state from selector failure.
3. Collect stable source IDs from the list or detail route:
   - Smartstore uses its existing channel IDs and thread IDs.
   - Zigzag uses the numeric ID in `/detail/<id>`.
   - ABLY uses `문의방 번호`.
4. Preserve existing seller replies and message direction. Do not treat an acknowledgement such as `감사합니다` or `넵` as needing another reply.
5. For Smartstore TalkTalk, open unread conversations when detail collection is needed. This installation authorizes unread-to-read transitions caused by opening a conversation. Preserve the pre-open unread count when visible and report `read_state_transition_count`; this authorization does not include replies, completion, tags, memos, or any order action.
6. Normalize and mask the raw in-memory collection with `scripts/report-core.mjs`. Never write or display the unmasked collection.
7. Compare by `source_key` and `content_hash`:
   - missing key: `NEW`
   - same key, different hash: `CHANGED`
   - same key and hash: `UNCHANGED`
   - absence from the current limited range is `NOT_SEEN`, never deletion.
8. When answered records contain both a real customer question and a real seller reply, refresh the verified reference library using [references/answer-library.md](references/answer-library.md). Include the approved three-month Notion archive by parsing each answered page's `메시지 흐름` with `scripts/notion-answer-adapter.mjs`; its empty preview properties do not mean the page has no conversation. Never use seller-only previews, system messages, acknowledgements, or AI drafts as human-answer examples.
9. Generate an AI draft only for `reply_state=NEEDS_REPLY`. Read [references/answer-library.md](references/answer-library.md), retrieve up to three enabled `USE` examples with `scripts/answer-library-core.mjs`, and combine them with active rules. Store the draft separately from seller replies, include reference IDs and required checks, label it as AI-generated, and run a second PII scan. Never send it.
10. Persist only when the user or configured workflow names a destination. The OAuth-fixed server environment owns the destination: `development` may use only its test Sheet, while `production` may use `Pink Rocket CS 운영 데이터 v1` only after explicit cutover approval. Read [references/sheet-sync.md](references/sheet-sync.md) before syncing. Do not attach raw JSON or fall back to sensitive local files.
11. Return a short Korean report with duration, per-channel totals, new/changed/unchanged/reply-needed counts, TalkTalk read-state transitions, reference-library refresh counts, draft counts, failures, and manual actions.

## Deterministic core

Resolve the directory that contains this loaded `SKILL.md` from the host's available-skill entry, then import the core from that absolute path in the persistent JavaScript environment. A plugin-installed skill may live under a plugin cache, so do not assume `$CODEX_HOME/skills`:

```js
var marketCsSkillRoot = "<absolute directory containing the loaded marketplace-cs-monitor SKILL.md>";
var marketCsCore = await import(`${marketCsSkillRoot}/scripts/report-core.mjs`);
var report = marketCsCore.buildReport(rawCollection, previousRecords);
```

Keep `rawCollection` in memory only. `report.records` is masked and safe for the configured review destination.

## AI answer grounding

For answer-library refreshes, import the deterministic helper. For normal plugin draft generation, call `search_verified_answers` with masked inquiry text and use only the returned examples:

```js
var answerLibraryCore = await import(`${marketCsSkillRoot}/scripts/answer-library-core.mjs`);
var libraryCandidates = answerLibraryCore.buildAnswerLibrary(report.records);
var draftContext = answerLibraryCore.buildDraftContext(needsReplyRecord, libraryRows, { limit: 3 });
```

The canonical reference sheet is `06_ANSWER_LIBRARY` in the OAuth-fixed environment's Sheet. Development must use its test library; production may use the library in `Pink Rocket CS 운영 데이터 v1` only after cutover approval. Only enabled `USE` rows with `pii_scan=PASS` may ground a draft. A retrieved example never authorizes copying customer data or asserting current price, stock, order, shipping, refund, or compensation state.

## Sheet synchronization

After all completion checks pass, call the plugin's `sync_masked_cs_run` MCP tool with the masked report. Do not pass an environment, Apps Script URL, API key, arbitrary action, or arbitrary URL. The server derives the target environment from the verified OAuth subject and derives the deterministic `run_id` from the report. `scripts/sync-client.mjs` remains only for legacy local tests and must not be used by the web plugin.

The Apps Script server, not the browser collector, is authoritative for case/message/draft upsert and change state. Never append directly to `01_CASES` through `04_SYNC_RUNS`. The bounded `06_ANSWER_LIBRARY` maintenance exception is defined in [references/answer-library.md](references/answer-library.md). Treat a repeated `run_id` as an idempotent replay, verify `marketplace_write_actions=0`, and report a sync failure without rerunning browser collection unless the user explicitly asks. `marketplace_write_actions` counts prohibited operational actions; authorized TalkTalk read-marker transitions are reported separately.

## Completion checks

Before reporting success, verify:

- all seven channels were attempted;
- visible nonzero totals reconcile to collected or explicitly skipped records for the locked range;
- every prepared record has nonempty `source_key` and `content_hash`;
- no duplicate `source_key` exists in the prepared batch;
- new + changed + unchanged equals prepared count;
- prohibited marketplace write actions equal zero;
- Smartstore TalkTalk unread-to-read transitions are allowed when caused by authorized detail inspection and are reported separately;
- AI drafts are clearly separated from human replies and were not sent.
- reference examples came from complete human question-answer pairs and passed PII checks;
- every populated AI draft records its reference IDs, required checks, `ai_draft_origin=AI`, and second PII scan result.
