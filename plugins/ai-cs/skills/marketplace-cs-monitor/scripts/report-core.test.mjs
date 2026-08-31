import assert from "node:assert/strict";
import { applyAiDrafts, buildReport } from "./report-core.mjs";

const base = {
  mode: "changes_today",
  range: { start: "2026-08-25", end: "2026-08-25" },
  collected_at: "2026-08-25T03:30:00.000Z",
  channels: {
    smartstore_comments: {
      market: "smartstore", channel: "comments", attempted: true, visible_total: 1,
      records: [{ product_id: "1", created_at: "2026-08-25 10:00", customer_id: "customer123", body: "전화 010-1234-5678", status: "답변완료" }],
    },
    smartstore_customer_qna: { market: "smartstore", channel: "customer_qna", attempted: true, visible_total: 0, records: [] },
    smartstore_customer_center: { market: "smartstore", channel: "customer_center", attempted: true, visible_total: 0, records: [] },
    smartstore_talktalk: { market: "smartstore", channel: "talktalk", attempted: true, visible_total: 0, read_state_transition_count: 2, records: [] },
    zigzag_order_inquiry: {
      market: "zigzag", channel: "order_inquiry", attempted: true, visible_total: 1,
      records: [{ inquiry_id: "23423568", status: "미답변", subject: "배송 문의", customer: "uneh****", occurred_at: "2026-08-25 10:01" }],
    },
    zigzag_item_question: { market: "zigzag", channel: "item_question", attempted: true, visible_total: 0, records: [] },
    ably_inquiry: {
      market: "ably", channel: "inquiry", attempted: true, visible_total: 1,
      records: [{ room_id: "95162904", status: "진행중", customer_name: "혜진", occurred_at: "2026-08-25 10:02", messages: [{ direction: "seller", text: "확인했습니다" }, { direction: "customer", text: "감사합니다" }] }],
    },
  },
};

const first = buildReport(base, []);
assert.equal(first.summary.prepared_count, 3);
assert.equal(first.summary.new_count, 3);
assert.equal(first.summary.needs_reply_count, 1);
assert.equal(first.summary.talktalk_read_state_transitions, 2);
assert.equal(first.channels.smartstore_talktalk.read_state_transition_count, 2);
assert.match(first.records[0].preview, /010-\*\*\*\*-\*\*\*\*/);
assert.equal(first.records.find((row) => row.market === "ably").reply_state, "NO_REPLY");
assert.equal(first.records.find((row) => row.market === "zigzag").reply_state, "NEEDS_REPLY");

const previous = first.records.map(({ source_key, content_hash }) => ({ source_key, content_hash }));
const second = buildReport(base, previous);
assert.equal(second.summary.unchanged_count, 3);
assert.equal(second.summary.changed_count, 0);

const changedInput = structuredClone(base);
changedInput.channels.zigzag_order_inquiry.records[0].subject = "배송 일정 문의";
const third = buildReport(changedInput, previous);
assert.equal(third.summary.changed_count, 1);
assert.equal(third.summary.unchanged_count, 2);

const withDraft = structuredClone(base);
withDraft.channels.zigzag_order_inquiry.records[0].ai_draft = "안녕하세요. 주문 상태 확인 후 배송 일정을 안내드리겠습니다.";
withDraft.channels.zigzag_order_inquiry.records[0].ai_draft_origin = "AI";
withDraft.channels.zigzag_order_inquiry.records[0].ai_draft_required_checks = "실제 주문·출고 상태 확인";
withDraft.channels.zigzag_order_inquiry.records[0].ai_draft_pii_scan = "PASS";
const drafted = buildReport(withDraft, []);
const draftRecord = drafted.records.find((row) => row.market === "zigzag");
assert.equal(draftRecord.ai_draft_origin, "AI");
assert.equal(draftRecord.ai_draft_pii_scan, "PASS");
assert.match(draftRecord.ai_draft_required_checks, /출고/);

const missingOrigin = structuredClone(withDraft);
missingOrigin.channels.zigzag_order_inquiry.records[0].ai_draft_origin = "";
assert.throws(() => buildReport(missingOrigin, []), /AI_DRAFT_ORIGIN_REQUIRED/);

const target = first.records.find((row) => row.reply_state === "NEEDS_REPLY");
const draftedAfterCollection = applyAiDrafts(first, [{
  source_key: target.source_key,
  ai_draft: "안녕하세요. 확인 후 안내드리겠습니다.",
  ai_draft_origin: "AI",
  ai_draft_required_checks: "실제 주문 상태 확인",
  ai_draft_pii_scan: "PASS",
}]);
const attached = draftedAfterCollection.records.find((row) => row.source_key === target.source_key);
assert.equal(attached.ai_draft_origin, "AI");
assert.equal(attached.ai_draft_purpose, "REPLY");
assert.equal(attached.ai_draft_pii_scan, "PASS");
assert.notEqual(attached.content_hash, target.content_hash);
assert.throws(() => applyAiDrafts(first, [{ source_key: target.source_key, ai_draft: "초안", ai_draft_origin: "AI", ai_draft_pii_scan: "REVIEW" }]), /AI_DRAFT_PII_SCAN_REQUIRED/);

const answered = first.records.find((row) => row.reply_state === "ANSWERED");
const evaluated = applyAiDrafts(first, [{
  source_key: answered.source_key,
  ai_draft: "안녕하세요. 확인 후 안내드리겠습니다.",
  ai_draft_origin: "AI",
  ai_draft_purpose: "EVAL",
  ai_draft_required_checks: "학습·검증용 · 실제 사람 답변과 비교 · 자동 전송 금지",
  ai_draft_pii_scan: "PASS",
}]);
const evalRecord = evaluated.records.find((row) => row.source_key === answered.source_key);
assert.equal(evalRecord.reply_state, "ANSWERED");
assert.equal(evalRecord.ai_draft_purpose, "EVAL");
assert.equal(evaluated.summary.eval_draft_count, 1);
assert.equal(evaluated.summary.needs_reply_count, first.summary.needs_reply_count);
assert.throws(() => applyAiDrafts(first, [{
  source_key: answered.source_key,
  ai_draft: "초안",
  ai_draft_origin: "AI",
  ai_draft_purpose: "REPLY",
  ai_draft_pii_scan: "PASS",
}]), /AI_DRAFT_REPLY_STATE_MISMATCH/);

console.log("marketplace-cs-monitor report core: PASS");
