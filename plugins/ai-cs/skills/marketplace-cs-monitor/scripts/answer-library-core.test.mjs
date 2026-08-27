import assert from "node:assert/strict";
import {
  ANSWER_LIBRARY_HEADERS,
  buildAnswerLibrary,
  buildDraftContext,
  parseSheetRows,
  retrieveAnswerExamples,
  toSheetRows,
} from "./answer-library-core.mjs";

const records = [
  {
    market: "smartstore",
    channel: "comments",
    source_key: "smartstore:comments:bar-change",
    reply_state: "ANSWERED",
    pii_scan: "PASS",
    category: "상품",
    preview: "0.8mm 얇은 바로 변경할 수 있나요?",
    product_name: "써지컬 바 피어싱",
    messages: [{ direction: "customer", at: "2026-08-25 09:00", text: "0.8mm 얇은 바로 변경할 수 있나요?" }],
    seller_replies: [{ at: "2026-08-25 09:10", text: "바변경 가능한 제품이며 주문 후 요청사항을 남겨주세요." }],
  },
  {
    market: "smartstore",
    channel: "talktalk",
    source_key: "smartstore:talktalk:seller-only",
    reply_state: "ANSWERED",
    pii_scan: "PASS",
    preview: "확인했습니다",
    messages: [{ direction: "seller", text: "확인했습니다" }],
  },
  {
    market: "smartstore",
    channel: "comments",
    source_key: "smartstore:comments:pii",
    reply_state: "ANSWERED",
    pii_scan: "REVIEW",
    preview: "전화번호 문의",
    seller_replies: [{ text: "010-1234-5678로 연락주세요" }],
  },
];

const library = buildAnswerLibrary(records, { verifiedAt: "2026-08-25T07:00:00.000Z" });
assert.equal(library.length, 1);
assert.equal(library[0].intent, "옵션·바변경");
assert.equal(library[0].quality_state, "USE");
assert.equal(library[0].pii_scan, "PASS");

const rows = toSheetRows(library);
assert.deepEqual(rows[0], ANSWER_LIBRARY_HEADERS);
assert.equal(parseSheetRows(rows)[0].enabled, true);

const examples = retrieveAnswerExamples({
  market: "smartstore",
  channel: "comments",
  subject: "피어싱 바를 0.8mm로 바꾸고 싶어요",
  product_name: "써지컬 피어싱",
}, parseSheetRows(rows));
assert.equal(examples.length, 1);
assert.ok(examples[0].score >= 12);

const disabled = parseSheetRows(rows);
disabled[0].enabled = false;
assert.equal(retrieveAnswerExamples({ subject: "바변경" }, disabled).length, 0);

const context = buildDraftContext({ subject: "0.8mm 바변경 문의" }, parseSheetRows(rows));
assert.deepEqual(context.reference_ids, [library[0].example_id]);
assert.match(context.generation_policy.join(" "), /전송하지 않습니다/);
assert.equal(library[0].source_url, "");

console.log("marketplace-cs-monitor answer library core: PASS");
