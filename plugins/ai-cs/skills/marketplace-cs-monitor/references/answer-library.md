# AI answer reference library

Read this reference whenever creating, refreshing, or using AI answer recommendations.

## Destination and ownership

- Spreadsheet: the OAuth-fixed environment target. Development uses only its test Sheet; production uses `Pink Rocket CS 운영 데이터 v1` only after approved cutover.
- Sheet: `06_ANSWER_LIBRARY`
- The library contains masked, verified human question-answer examples only.
- `01_CASES`, `02_MESSAGES`, and `03_AI_DRAFTS` remain the source-of-truth logs. Do not replace or rewrite them to refresh the library.

Use Google Sheets metadata and bounded range reads. The canonical library range is `06_ANSWER_LIBRARY!A1:T3000`. Read the live header before every write and match `ANSWER_LIBRARY_HEADERS` from `scripts/answer-library-core.mjs` exactly.

## Eligible sources

Build candidates with `buildAnswerLibrary(maskedRecords)` and keep only rows that meet every condition:

- `reply_state=ANSWERED` and `pii_scan=PASS`;
- a real customer question and a real seller answer are both present;
- the customer message is not a simple acknowledgement;
- the seller answer is not an automatic/system message or a context-free acknowledgement;
- no unmasked phone, email, long order number, address, account, or customer identifier remains.

Seller-only TalkTalk previews, metadata-only historical records, AI drafts, and rejected/unused drafts are not human-answer examples. Never promote them automatically.

In the development D1 review desk, saving an approved human revision creates only a `CANDIDATE`. The reviewer must press `AI 학습시키기`, inspect the masked question and answer, and record a reason before the entry becomes `USE`. Rejection or omission must not promote the entry. This is an explicit review action in the local knowledge store, not model fine-tuning and not a marketplace action.

The installed reference pool has two approved inputs:

- current masked Sheet cases that contain the complete customer question and human reply;
- the masked three-month Notion archive `CS 상담 운영 로그` (`collection://c8eca414-a4e1-42ea-bc86-46796aa172cf`). For this source, fetch each answered page and parse its `메시지 흐름` with `scripts/notion-answer-adapter.mjs`; the empty `최근 고객 메시지` and `최근 판매자 답변` properties are not proof that the page lacks a conversation.

Create one candidate for each contiguous customer turn followed by a contiguous seller turn. Preserve the Notion page URL in `source_url`. Run a second free-text PII scan before adding the row; account details, depositor names, order or tracking identifiers, addresses, phones, emails, and image-only turns must be excluded.

## Refresh procedure

1. Normalize and mask the collection first.
2. Run `buildAnswerLibrary(report.records)` in memory.
3. Read `06_ANSWER_LIBRARY!A1:T3000` and parse it with `parseSheetRows`.
4. Upsert by `example_id`; update the same ID only when the human-answer hash or verification metadata changed.
5. Never delete missing rows during a range-limited run. Set `enabled=FALSE` or `quality_state=REVIEW` only after an explicit review decision.
6. Preserve manually edited `enabled`, `quality_state`, `risk_level`, and `note` cells when the example ID already exists.
7. Verify the final row count, exact header, PII status, dropdown values, frozen header, filter, and wrapping.

The normal Apps Script sync contract owns `01_CASES` through `04_SYNC_RUNS`. The MCP tool `search_verified_answers` provides bounded, read-only access to eligible `06_ANSWER_LIBRARY` examples. Maintaining that library remains the one explicit exception: use the Google Sheets connector only after exact-header validation and only in the fixed environment's Sheet. Never use this exception to write collection tabs directly.

Allowed review values:

- `quality_state`: `USE`, `REVIEW`, `EXCLUDE`
- `risk_level`: `STANDARD`, `REVIEW_REQUIRED`
- `enabled`: Boolean

## Draft grounding procedure

For each normalized record with `reply_state=NEEDS_REPLY`:

1. Call `search_verified_answers` with masked inquiry text and read active rules from `05_RULES` when available.
2. For local deterministic tests, the equivalent helper is `buildDraftContext(inquiry, libraryRows, { limit: 3 })`.
3. Use only returned `quality_state=USE`, `enabled=TRUE`, `pii_scan=PASS` examples.
4. Treat examples as tone and workflow evidence, not as proof of current price, stock, order, shipping, refund, or compensation state.
5. Generate a concise Korean draft. If required facts are missing, ask for confirmation or state the manual check instead of inventing facts.
6. Store the draft separately with:
   - `ai_draft_origin=AI`
   - `ai_draft_required_checks` containing the checks and reference example IDs
   - `ai_draft_pii_scan=PASS` only after the second scan
7. Never copy customer identifiers from an example and never send the draft.

If no example reaches the retrieval threshold, do not force a match. Produce a conservative draft from active rules only and label the missing reference evidence for human review.

## Answered-case shadow evaluation

Use this only when the user explicitly asks for training data or skill verification, normally on a bounded sample of 1–10 `ANSWERED` records with `pii_scan=PASS`.

1. Build the generation prompt from the customer question, product context, active rules, and verified answer-library examples only.
2. Hold the actual seller reply out until generation is complete. Never let it leak into the proposed wording.
3. Store the generated text with `ai_draft_origin=AI`, `ai_draft_purpose=EVAL`, and `ai_draft_pii_scan=PASS`.
4. Preserve `reply_state=ANSWERED`; do not increment reply-needed or operational AI-ready counts.
5. After generation, compare the `EVAL` draft with the actual human reply for omissions, unsupported claims, tone, and required checks.
6. Never approve, send, or promote the `EVAL` draft into `06_ANSWER_LIBRARY`. Only the actual verified human reply may become a reference example.
