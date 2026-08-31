const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");

const context = {
  console,
  Date,
  JSON,
  Math,
  Number,
  Object,
  String,
  Array,
  Boolean,
  RegExp,
  isNaN,
  Utilities: {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" },
    computeDigest(_algorithm, value) {
      return [...crypto.createHash("sha256").update(String(value)).digest()].map((byte) => byte > 127 ? byte - 256 : byte);
    },
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/Code.gs`, "utf8"), context);
const source = fs.readFileSync(`${__dirname}/Code.gs`, "utf8");
assert.match(source, /\['health', 'overview', 'dashboard', 'cases', 'case', 'answerLibrary'\]/);

const record = {
  market: "smartstore",
  channel: "comments",
  source_key: "smartstore:comments:test",
  content_hash: "hash-1",
  occurred_at: "2026-08-25 10:00",
  status: "미답변",
  category: "상품 정보",
  customer_masked: "고***",
  subject: "길이 문의",
  preview: "8mm가 가능한가요?",
  product_id: "12345678901",
  product_name: "샘플 피어싱",
  source_url: "https://sell.smartstore.naver.com/#/comment/detail?commentNo=masked-ref",
  source_url_kind: "EXACT",
  source_reference: "comment:masked-ref",
  product_url: "https://smartstore.naver.com/pink-rocket/products/12345678901",
  product_thumbnail_url: "https://sell.smartstore.naver.com/image/sample.jpg",
  order_no_masked: "2026****1234",
  messages: [{ direction: "customer", at: "2026-08-25 10:00", text: "8mm가 가능한가요?", image_count: 2 }],
  seller_replies: [],
  last_actor: "customer",
  reply_state: "NEEDS_REPLY",
  ai_draft: "안녕하세요. 옵션 확인 후 안내드리겠습니다.",
  ai_draft_origin: "AI",
  ai_draft_pii_scan: "PASS",
  pii_scan: "PASS",
};

context.assertMaskedRecord_(record);
assert.throws(() => context.assertMaskedRecord_({ ...record, preview: "010-1234-5678" }), /UNMASKED_PHONE/);

const draft = context.prepareDraft_(record, [], {}, new Date("2026-08-25T01:01:00Z"), {});
assert.equal(draft.isNew, true);
assert.equal(draft.object.draft_text, record.ai_draft);
assert.equal(draft.object.draft_state, "READY");
assert.equal(draft.object.content_hash, undefined);

const evaluationRecord = {
  ...record,
  status: "답변완료",
  reply_state: "ANSWERED",
  last_actor: "seller",
  ai_draft_purpose: "EVAL",
};
const evaluationDraft = context.prepareDraft_(evaluationRecord, [], {}, new Date("2026-08-25T01:02:00Z"), {});
assert.equal(evaluationDraft.isNew, true);
assert.equal(evaluationDraft.object.record_type, "EVAL");
assert.equal(evaluationDraft.object.draft_state, "EVAL");
assert.throws(() => context.prepareDraft_({ ...evaluationRecord, ai_draft_purpose: "REPLY" }, [], {}, new Date(), {}), /AI_DRAFT_REPLY_STATE_MISMATCH/);

const caseObject = context.caseObjectFromRecord_(record, null, "NEW", draft.object, new Date("2026-08-25T01:01:00Z"));
assert.equal(caseObject.subject, record.subject);
assert.equal(caseObject.preview, record.preview);
assert.equal(caseObject.source_status, "미답변");
assert.equal(caseObject.reply_required, true);
assert.equal(caseObject.ai_draft_state, "READY");
assert.equal(caseObject.active_ai_draft_preview, record.ai_draft);
assert.equal(caseObject.source_url, record.source_url);
assert.equal(caseObject.source_url_kind, "EXACT");
assert.equal(caseObject.source_reference, record.source_reference);
assert.equal(caseObject.product_url, record.product_url);
assert.equal(caseObject.product_thumbnail_url, record.product_thumbnail_url);
assert.equal(caseObject.image_count, 2);
assert.equal(caseObject.title, undefined);

const legacyCaseObject = context.caseObjectFromRecord_(
  { ...record, source_url: "", source_url_kind: "", source_reference: "", product_url: "", product_thumbnail_url: "", messages: undefined },
  { source_url: record.source_url, source_url_kind: "EXACT", source_reference: record.source_reference, product_url: record.product_url, product_thumbnail_url: record.product_thumbnail_url, image_count: 3 },
  "UNCHANGED",
  draft.object,
  new Date("2026-08-25T01:01:00Z"),
);
assert.equal(legacyCaseObject.source_url, record.source_url);
assert.equal(legacyCaseObject.source_url_kind, "EXACT");
assert.equal(legacyCaseObject.product_url, record.product_url);
assert.equal(legacyCaseObject.image_count, 3);
assert.throws(() => context.assertMaskedRecord_({ ...record, source_url: "http://sell.smartstore.naver.com/#/comment/" }), /UNSAFE_MARKETPLACE_URL/);
assert.throws(() => context.assertMaskedRecord_({ ...record, source_url: "https://example.com/case" }), /UNSAFE_MARKETPLACE_URL/);
assert.throws(() => context.assertMaskedRecord_({ ...record, source_url: "https://sell.smartstore.naver.com/#/comment/?token=secret" }), /SENSITIVE_MARKETPLACE_URL_PARAMETER/);
assert.throws(() => context.assertMaskedRecord_({ ...record, source_url_kind: "EXACT", source_url: "" }), /SOURCE_URL_KIND_MISMATCH/);

const messages = context.prepareMessages_(record, new Date("2026-08-25T01:01:00Z"));
assert.equal(messages.length, 1);
assert.match(messages[0].message_key, /^MSG2:/);
assert.equal(messages[0].actor_type, "CUSTOMER");
assert.equal(messages[0].message_text_masked, "8mm가 가능한가요?");
assert.equal(messages[0].image_count, 2);
assert.equal(messages[0].message_id, undefined);

const repeated = context.prepareMessages_({
  ...record,
  messages: [
    { source_message_id: '_msgId1', direction: 'customer', at: '오전 10:00', text: '네', image_count: 0 },
    { source_message_id: '_msgId2', direction: 'customer', at: '오전 10:00', text: '네', image_count: 0 },
  ],
}, new Date('2026-08-25T01:01:00Z'));
assert.equal(repeated.length, 2);
assert.notEqual(repeated[0].message_key, repeated[1].message_key);

assert.equal(context.mapReplyState_("NO_REPLY"), "NO_REPLY_REQUIRED");
assert.equal(context.channelInfo_("zigzag", "item_question").channel, "상품 문의");
assert.equal(context.mapReplyState_("CLOSED"), "CLOSED");

function tableFromObjects(objects) {
  const headers = Object.keys(objects[0]);
  const headerMap = Object.fromEntries(headers.map((header, index) => [header, index]));
  return {
    headers,
    headerMap,
    rows: objects.map((object, index) => ({ rowNumber: index + 2, values: headers.map((header) => object[header]) })),
  };
}

const openCase = {
  case_key: "smartstore:comments:test",
  record_type: "LIVE",
  market: "SMARTSTORE",
  channel: "문의 관리",
  occurred_at: "2026-08-25T01:00:00Z",
  reply_required: true,
  reply_state: "NEEDS_REPLY",
  source_status: "미답변",
  content_hash: "old-hash",
  status_missing_count: 0,
  status_source: "COLLECTED_DETAIL_OR_STATUS",
};
const missingReport = {
  channels: {
    smartstore_comments: {
      open_queue_complete: true,
      open_queue_window_start: "2026-08-01",
      open_queue_visible_total: 0,
      open_queue_source_keys: [],
    },
  },
};
const firstMissing = context.prepareOpenQueueReconciliation_(
  missingReport,
  tableFromObjects([openCase]),
  {},
  new Date("2026-08-31T01:00:00Z"),
);
assert.equal(firstMissing.review, 1);
assert.equal(firstMissing.closed, 0);
assert.equal(firstMissing.updates[0].object.reply_state, "REVIEW");
assert.equal(firstMissing.updates[0].object.status_missing_count, 1);
assert.equal(firstMissing.updates[0].object.ai_draft_state, "NONE");
assert.equal(firstMissing.updates[0].object.active_ai_draft_id, "");
assert.equal(firstMissing.updates[0].object.active_ai_draft_preview, "");
const historicalMissingWithDraft = {
  ...firstMissing.updates[0].object,
  active_ai_draft_id: "DRAFT:stale",
  active_ai_draft_preview: "stale draft",
  ai_draft_state: "READY",
  preview: "문의 종료하기",
};
assert.equal(context.publicCase_(historicalMissingWithDraft).ai_draft_state, "NONE");
assert.equal(context.publicCase_(historicalMissingWithDraft).preview, "과거 수집 데이터 · 원문 재확인 필요");
assert.equal(context.isUiControlText_(" 문의   종료하기 "), true);
assert.equal(context.isUiControlText_("문의 종료하기로 했어요"), false);
assert.equal(context.overviewFromCases_([historicalMissingWithDraft]).ai_ready, 0);
assert.equal(context.listCasesFromRows_([historicalMissingWithDraft], { ai_draft_state: "READY" }).total, 0);

const secondMissing = context.prepareOpenQueueReconciliation_(
  missingReport,
  tableFromObjects([firstMissing.updates[0].object]),
  {},
  new Date("2026-08-31T01:05:00Z"),
);
assert.equal(secondMissing.closed, 1);
assert.equal(secondMissing.updates[0].object.reply_state, "CLOSED");
assert.equal(secondMissing.updates[0].object.reply_required, false);
assert.equal(secondMissing.updates[0].object.completion_reason, "OPEN_QUEUE_MISSING_TWICE");

const incompleteReport = structuredClone(missingReport);
incompleteReport.channels.smartstore_comments.open_queue_complete = false;
const incomplete = context.prepareOpenQueueReconciliation_(
  incompleteReport,
  tableFromObjects([openCase]),
  {},
  new Date("2026-08-31T01:00:00Z"),
);
assert.equal(incomplete.checked, 0);

context.getObjects_ = () => [{
  example_id: "ANS_test",
  enabled: true,
  quality_state: "USE",
  pii_scan: "PASS",
  intent: "배송",
  market: "SMARTSTORE",
  channel: "톡톡 상담",
  risk_level: "REVIEW_REQUIRED",
  customer_question: "배송은 언제 출고되나요?",
  product_name: "샘플 피어싱",
  human_answer: "주문 상태를 확인한 뒤 출고 일정을 안내드리겠습니다.",
  required_checks: "실제 주문 및 출고 상태 확인",
  keywords: "배송, 출고",
  last_verified_at: "2026-08-25T01:01:00Z",
}];
const ranked = context.searchVerifiedAnswers_({
  query: "배송 출고 언제",
  market: "SMARTSTORE",
  channel: "톡톡 상담",
  intent: "배송",
  limit: 3,
});
assert.equal(ranked.reference_source, "VERIFIED_HUMAN_ANSWER_ONLY");
assert.equal(ranked.examples.length, 1);
assert.equal(ranked.examples[0].example_id, "ANS_test");
assert.equal(ranked.examples[0].human_answer.includes("주문 상태"), true);

console.log("Pink Rocket CS Apps Script sync contract: PASS");
