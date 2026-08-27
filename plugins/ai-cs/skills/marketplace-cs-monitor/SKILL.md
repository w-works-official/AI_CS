---
name: marketplace-cs-monitor
description: Run the existing local Playwright marketplace CS macro, mask and deduplicate collected inquiries, prepare grounded AI reply drafts, and sync review-only data to the configured development Sheet. Use for CS collection, recurring monitoring, AI draft preparation, or sync checks. Never send marketplace replies or change inquiry state.
---

# Marketplace CS Monitor

Use the existing Playwright macro as the normal collection engine. Do not build another Chrome collector and do not drive Chrome interactively for an ordinary run.

## Current rollout gate

Smartstore is temporarily paused until the account holder can complete Naver reauthentication in the dedicated CS Chrome. The active vertical slice is ABLY `문의 관리` plus Zigzag/KakaoStyle `주문 문의` and `상품 문의`. Keep runs limited to today's changes until collection and masking are verified. Generate operational `REPLY` drafts only for real `NEEDS_REPLY` records. When the user explicitly requests training or skill verification, answered records may receive separate `EVAL` shadow drafts under the evaluation rules below. Do not treat a verified zero as a selector failure.

Canonical local macro:

- working directory: `C:/Users/hihi0/Documents/Codex/2026-08-12/cs`
- script: `C:/Users/hihi0/Documents/Codex/2026-08-12/cs/smartstore_cs_macro.mjs`
- command: `npm run scrape`

Read [references/local-playwright-macro.md](references/local-playwright-macro.md) before running it. Read [references/report-schema.md](references/report-schema.md) before changing the masked report and [references/answer-library.md](references/answer-library.md) before generating drafts. Read [references/sheet-sync.md](references/sheet-sync.md) before any health or sync request.

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
- Keep `AUTO_SEND` disabled and require `marketplace_write_actions=0` in every result.

## Vertical-slice workflow

1. Confirm the current collection operator has started the local CS Chrome and signed in. Resolve the active session file or the explicit loopback `SMARTSTORE_CDP_URL`; do not inspect cookies, tokens, saved passwords, or browser storage.
2. Run the existing macro in `prepare` mode with the explicitly requested channels, today's range, and `CS_KEEP_MASKED_OUTPUT=1`. The current gate uses `CS_CHANNELS=ably_inquiry,zigzag_order_inquiry,zigzag_item_question`. This prepares a masked JSON report and performs no Sheet write.
3. Check that only the requested channels have `attempted=true`. Verify visible totals, verified zero states, source keys, content hashes, PII scan, counts, and `marketplace_write_actions=0`.
4. For each `reply_state=NEEDS_REPLY`, retrieve at most three enabled `USE` examples from the development `06_ANSWER_LIBRARY` through `searchVerifiedAnswers` in `scripts/sync-client.mjs`. For an explicitly requested answered-case evaluation, hold the actual seller answer out while generating and set `ai_draft_purpose=EVAL`.
5. Generate a cautious AI draft using only those examples and current inquiry facts. Do not claim live price, stock, order, shipment, refund, compensation, or policy state without an explicit human check.
6. Attach drafts with `applyAiDrafts(report, drafts)` from `scripts/report-core.mjs`. Every draft must set `ai_draft_origin=AI`, `ai_draft_purpose=REPLY|EVAL`, required checks, and `ai_draft_pii_scan=PASS`; the helper recalculates `content_hash`. `EVAL` is valid only for `ANSWERED`, never changes `reply_state`, and never contributes to reply-needed or ready-to-send counts.
7. Load the existing local sync config, require `environment=development`, and call `readCsData("health")`. Stop before sync unless health returns `ok=true`, `environment=development`, `auto_send=false`, and `marketplace_write_actions=0`.
8. Call `syncReport(finalReport, config)` once. Do not retry browser collection when sync fails. Reusing the same deterministic run ID must be idempotent.
9. Verify the development review frontend shows the masked post and distinctly labels an operational draft as `AI 추천답변` or an answered-case shadow draft as `AI 검증 초안`. `EVAL` is comparison-only: disable approval/rejection and compare it with the actual human answer. The frontend never sends a marketplace reply.
10. Return a short Korean report with duration, collected count, new/changed/unchanged/reply-needed counts, draft count, PII result, sync result, and prohibited write count.

## Deterministic helpers

Use the installed skill directory from the available-skills entry:

```js
var marketCsCore = await import("C:/Users/hihi0/.codex/skills/marketplace-cs-monitor/scripts/report-core.mjs");
var marketCsSync = await import("C:/Users/hihi0/.codex/skills/marketplace-cs-monitor/scripts/sync-client.mjs");
var answerLibraryCore = await import("C:/Users/hihi0/.codex/skills/marketplace-cs-monitor/scripts/answer-library-core.mjs");
```

The macro already calls `buildReport()`. After generating drafts, call:

```js
var finalReport = marketCsCore.applyAiDrafts(maskedReport, aiDrafts);
```

Never recompute hashes ad hoc and never append directly to Sheet tabs.

## Implemented collection scope

- Existing standalone Playwright macro: Smartstore 문의 관리, 고객문의 관리, 고객센터 문의 관리, 톡톡 상담; Zigzag/KakaoStyle 주문 문의 and 상품 문의; ABLY 문의 관리.
- ABLY detail collection preserves customer/seller message direction. Zigzag uses the numeric detail route ID and reads existing seller replies without using reply inputs.
- Smartstore remains disabled in the current run until Naver reauthentication is completed by the account holder.

## Completion gate

Collection and masking have passed for a real answered ABLY record. Answered records may be used in a bounded `EVAL` shadow-draft run (normally 1–10 records) without changing operational state or promoting the AI output into the verified answer library. The next operational gate remains one real `NEEDS_REPLY` record from an enabled ABLY or Zigzag channel passing grounded AI drafting, development sync, frontend display, and separate human review. Smartstore can resume only after the account holder authenticates. Marketplace reply transmission must remain zero.
