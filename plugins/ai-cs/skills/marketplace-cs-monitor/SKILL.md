---
name: marketplace-cs-monitor
description: Run the existing local Playwright marketplace CS macro, mask and deduplicate collected inquiries, prepare grounded AI reply drafts, and sync review-only data to the configured development stores. Use for CS collection, recurring monitoring, AI draft preparation, or sync checks. Never send marketplace replies or change inquiry state.
---

# Marketplace CS Monitor

Use the existing Playwright macro as the normal collection engine. Do not build another Chrome collector and do not drive Chrome interactively for an ordinary run.

## Default operating mode

Use `collect_and_reconcile` unless the user asks for a prepare-only diagnostic. It collects new and changed cases, carries a complete current unanswered-queue snapshot when the marketplace proves the count, and lets the development sync target reconcile stale open cases. Generate operational `REPLY` drafts only for real `NEEDS_REPLY` records. When the user explicitly requests training or skill verification, answered records may receive separate `EVAL` shadow drafts under the evaluation rules below. Do not treat a verified zero as a selector failure.

Canonical local macro:

- working directory: `C:/Users/hihi0/Documents/Codex/2026-08-12/cs/work/AI_CS`
- script: `tools/marketplace-cs/smartstore_cs_macro.mjs`
- command: `npm run collect:cs`

Read [references/local-playwright-macro.md](references/local-playwright-macro.md) before running it. Read [references/report-schema.md](references/report-schema.md) before changing the masked report and [references/answer-library.md](references/answer-library.md) before generating drafts. Read [references/sheet-sync.md](references/sheet-sync.md) before any health or sync request. Read [references/automation.md](references/automation.md) before proposing or enabling recurring collection.

## Browser and profile boundary

- The macro attaches with Playwright `chromium.connectOverCDP()` to the user-selected active CS Chrome session. Do not hard-code a person's name, Chrome profile directory, window title, tab index, or process ID.
- A user starts or reuses the dedicated local session with `scripts/start-cs-chrome.cmd`. The launcher records only a loopback CDP URL, process ID, non-secret browser instance ID, and timestamp in `%LOCALAPPDATA%/PinkRocketCS/active-browser.json`; it never reads cookies, passwords, or tokens.
- `SMARTSTORE_CDP_URL` is an optional explicit local override. Both the session file and override accept loopback HTTP addresses only. The macro rejects Whale and non-Chrome endpoints.
- Scheduled runs may reuse an already active session but must not launch a browser, scan ports, guess among profiles, or switch browsers automatically.
- If the active session is missing, stale, logged out, or ambiguous, stop and ask the current collection operator to start the CS Chrome and sign in. Different review users do not need a collection browser.
- Allow only one local collector run at a time. The deterministic lock is local; Sheet idempotency remains responsible for duplicate runs from different PCs.
- Stop on login, CAPTCHA, two-factor authentication, or account verification. Never automate credentials.
- Normal collection runs the macro; use `chrome:control-chrome` only when the user explicitly asks to diagnose a selector or visible browser state.

## Safety boundary

- Marketplace access is read-only. Never type into a reply field or click reply, send, edit, complete, close, cancel, refund, exchange, memo, tag, or order-change controls.
- Smartstore TalkTalk unread-to-read transitions remain the only authorized observational side effect when that channel is later enabled; report the count separately.
- Raw collection values remain inside the macro process. Only the masked report may be written to `output/`, displayed, or synchronized.
- Attachment bytes, cookies, and signed session URLs must never be persisted. Keep only allowlisted HTTPS image metadata; use `SESSION_REQUIRED` when a safe reusable URL is unavailable.
- Keep `AUTO_SEND` disabled and require `marketplace_write_actions=0` in every result.

## Vertical-slice workflow

1. Confirm the current collection operator has started the local CS Chrome and signed in. Resolve the active session file or the explicit loopback `SMARTSTORE_CDP_URL`; do not inspect cookies, tokens, saved passwords, or browser storage.
2. Run the existing macro with the explicitly requested channels, today's range, `CS_RUN_MODE=collect_and_reconcile`, `CS_SYNC_MODE=prepare`, and `CS_KEEP_MASKED_OUTPUT=1`. The macro may read the development case index for deterministic NEW/CHANGED/UNCHANGED classification, but it must not sync yet. A collection-only run with no drafts may use direct `sync` only when the user explicitly requests it.
3. Check that only the requested channels have `attempted=true`. Verify visible totals, verified zero states, source keys, content hashes, PII scan, counts, image metadata, and `marketplace_write_actions=0`. A channel may reconcile old cases only when `open_queue_complete=true`, `open_queue_visible_total=open_queue_observed_count`, and the snapshot declares its window. An incomplete or failed list must never close a stored case.
4. Normalize chat messages with `normalizeChatConversation` from `scripts/collector-ui-core.mjs`. Preserve `CUSTOMER`, `SELLER`, `AUTOMATIC`, and `SYSTEM`; never guess `UNKNOWN` as a customer or seller. A TalkTalk history scan must explicitly report `conversation_complete` and `conversation_incomplete_reason`. System and automatic messages may remain visible for context but do not determine `last_actor`.
5. Use `selectDraftCandidates`, `buildAnswerSearchRequest`, and `buildAiDraftJob` from `scripts/ai-draft-core.mjs`. For each candidate, retrieve at most three enabled `USE` examples through `searchVerifiedAnswers` in `scripts/sync-client.mjs`. Generate `REPLY` only when the final conversational actor is the customer. For an explicitly requested answered-case evaluation, require an actual seller answer, hold that answer out of the generation job, and set `ai_draft_purpose=EVAL`.
6. Every new or changed record that does not become a candidate must return a structured skip reason. Use the stable codes `ACTIVE_DRAFT_EXISTS`, `CONVERSATION_INCOMPLETE`, `ACTOR_UNCERTAIN`, `CUSTOMER_TURN_NOT_FOUND`, `IMAGE_REVIEW_REQUIRED`, `EVAL_DISABLED`, `EVAL_LIMIT_REACHED`, `SELLER_ANSWER_NOT_FOUND`, or `NO_REPLY_REQUIRED`; unchanged records use `UNCHANGED`. Keep the reason and required checks for the run report and review UI.
7. Generate a cautious AI draft using only the masked job, returned examples, and active rules. Do not claim live price, stock, order, shipment, refund, compensation, or policy state without an explicit human check. Validate each result with `validateGeneratedDraft`; isolate a failed candidate instead of aborting all other drafts.
8. Attach validated drafts with `applyAiDrafts(report, drafts)`, then build a decision for every record with `buildDraftDecisions(report, selection, drafts)` and attach it with `applyDraftDecisions(report, decisions)`. Every generated draft must set `ai_draft_origin=AI`, `ai_draft_purpose=REPLY|EVAL`, required checks, and `ai_draft_pii_scan=PASS`; every non-generated record must retain its stable skip reason and required checks. AI and decision fields are deliberately excluded from the inquiry `content_hash`, so adding or revising them cannot turn an unchanged customer inquiry into `CHANGED`. `EVAL` is valid only for `ANSWERED`, never changes `reply_state`, and never contributes to reply-needed or ready-to-send counts.
9. Attach review-only case summaries and learning candidates with `attachSummaryLibraryArtifacts(finalReport)` from `scripts/summary-library-core.mjs`. A human answer is only an `answer_library_candidate` in `ANSWERED|CLOSED` when an observed `CUSTOMER -> SELLER` pair exists. `NO_REPLY_REQUIRED` produces only a no-reply pattern candidate. Exclude incomplete chat, `UNKNOWN` actor, image-only, and unmasked-PII evidence. AI and `EVAL` text are never candidates, but their presence must not hide a separately observed actual seller reply; only that real seller reply may become a candidate. Candidates remain `CANDIDATE`; they never become verified examples without a separate human decision. This helper adds top-level report artifacts only and must not change any record `content_hash`.
10. Load the existing local D1 config, require `environment=development`, and call `readCsData("health")`. Stop before sync unless health returns `ok=true`, `environment=development`, `auto_send=false`, and `marketplace_write_actions=0`.
11. Call `syncReport(finalReport, config)` exactly once. This is the sole development D1 write; do not call Apps Script and do not perform a second shadow sync. The D1 URL is fixed to the approved development Worker and the hidden key is sent only in the `X-CS-Sync-Key` header. Do not retry browser collection when sync fails. Reusing the same run ID must be idempotent. For complete unanswered snapshots, one consecutive absence changes an old open case to `REVIEW`; two consecutive complete-snapshot absences change it to `CLOSED`. A later reappearance reopens it as `NEEDS_REPLY`. Preserve the original case and messages for training and audit.
12. Verify the development review frontend shows the masked post, collected image metadata, and distinctly labels an operational draft as `AI 추천답변` or an answered-case shadow draft as `AI 검증 초안`. `EVAL` is comparison-only: disable approval/rejection and compare it with the actual human answer. Template CRUD and answer-library promotion are explicit human review actions only. The frontend never sends a marketplace reply.
13. Return a short Korean report with duration, collected count, new/changed/unchanged/reply-needed counts, draft count, skip reasons, PII result, sync result, and prohibited write count.

## Deterministic helpers

Use the installed skill directory from the available-skills entry:

```js
var marketCsCore = await import("C:/Users/hihi0/.codex/skills/marketplace-cs-monitor/scripts/report-core.mjs");
var marketCsSync = await import("C:/Users/hihi0/.codex/skills/marketplace-cs-monitor/scripts/sync-client.mjs");
var answerLibraryCore = await import("C:/Users/hihi0/.codex/skills/marketplace-cs-monitor/scripts/answer-library-core.mjs");
var aiDraftCore = await import("C:/Users/hihi0/.codex/skills/marketplace-cs-monitor/scripts/ai-draft-core.mjs");
var summaryLibraryCore = await import("C:/Users/hihi0/.codex/skills/marketplace-cs-monitor/scripts/summary-library-core.mjs");
```

The macro already calls `buildReport()`. After generating drafts, call:

```js
var reportWithDrafts = marketCsCore.applyAiDrafts(maskedReport, aiDrafts);
var draftDecisions = aiDraftCore.buildDraftDecisions(reportWithDrafts, draftSelection, aiDrafts);
var finalReport = marketCsCore.applyDraftDecisions(reportWithDrafts, draftDecisions);
finalReport = summaryLibraryCore.attachSummaryLibraryArtifacts(finalReport);
```

Never recompute hashes ad hoc and never append directly to Sheet tabs.

## Implemented collection scope

- Existing standalone Playwright macro: Smartstore 문의 관리, 고객문의 관리, 고객센터 문의 관리, 톡톡 상담; Zigzag/KakaoStyle 주문 문의 and 상품 문의; ABLY 문의 관리.
- ABLY detail collection preserves customer/seller message direction. Zigzag uses the numeric detail route ID and reads existing seller replies without using reply inputs.
- All seven implemented channels are available when the current collection operator is signed in. A login or account-verification screen still stops only the affected run and must never be automated.

## Completion gate

Answered records may be used in a bounded `EVAL` shadow-draft run (normally 1–10 records) without changing operational state or promoting the AI output into the verified answer library. Reconciliation is accepted only when incomplete snapshots produce zero status transitions and two consecutive complete-snapshot absences close a synthetic test case. Marketplace reply transmission must remain zero.
