import assert from "node:assert/strict";
import {
  buildAiDraftJob,
  buildAnswerSearchRequest,
  extractLastCustomerTurn,
  selectDraftCandidates,
  validateGeneratedDraft,
} from "./ai-draft-core.mjs";

const replyRecord = {
  source_key: "smartstore:talktalk:test",
  market: "smartstore",
  channel: "talktalk",
  category: "배송",
  subject: "배송 문의",
  product_name: "샘플 피어싱",
  change_state: "NEW",
  reply_state: "NEEDS_REPLY",
  messages: [
    { direction: "customer", text: "언제 출고되나요?", at: "오전 10:00" },
    { direction: "seller", text: "확인하겠습니다.", at: "오전 10:01" },
    { direction: "customer", text: "오늘 출고 가능한가요?", at: "오전 10:02" },
  ],
};

assert.equal(extractLastCustomerTurn(replyRecord).text, "오늘 출고 가능한가요?");
assert.equal(extractLastCustomerTurn({ ...replyRecord, messages: [{ direction: "customer", text: "", image_count: 1 }] }).skip_reason, "IMAGE_ONLY_CUSTOMER_TURN");
assert.equal(extractLastCustomerTurn({ ...replyRecord, channel: "comments", messages: [], preview: "상품 길이가 궁금합니다." }).source, "POST_FALLBACK");
assert.equal(extractLastCustomerTurn({ ...replyRecord, messages: [] }).ok, false);

const answeredRecord = { ...replyRecord, source_key: "zigzag:item:test", channel: "item_question", reply_state: "ANSWERED" };
const selected = selectDraftCandidates({ records: [replyRecord, answeredRecord] }, new Map(), { includeAnsweredForEval: true, evalLimit: 1 });
assert.equal(selected.candidates.length, 2);
assert.equal(selected.candidates[0].purpose, "REPLY");
assert.equal(selected.candidates[1].purpose, "EVAL");
assert.equal(JSON.stringify(selected.candidates[1]).includes("seller_replies"), false);

const unchanged = selectDraftCandidates({ records: [{ ...replyRecord, change_state: "UNCHANGED" }] });
assert.equal(unchanged.candidates.length, 0);
assert.equal(unchanged.skipped[0].reason, "UNCHANGED");

const search = buildAnswerSearchRequest(selected.candidates[0]);
assert.equal(search.limit, 3);
assert.match(search.query, /출고/);

const library = Array.from({ length: 5 }, (_, index) => ({
  example_id: `ANS_${index}`,
  enabled: true,
  quality_state: "USE",
  pii_scan: "PASS",
  intent: "배송",
  market: "SMARTSTORE",
  channel: "talktalk",
  customer_question: "배송은 언제 되나요?",
  human_answer: "주문 상태 확인 후 안내드리겠습니다.",
  required_checks: "실제 출고 상태 확인",
}));
const job = buildAiDraftJob(selected.candidates[0], library);
assert.equal(job.references.length, 3);
assert.equal(job.reference_ids.length, 3);
assert.equal(JSON.stringify(job).includes("seller_replies"), false);
const apiShapeJob = buildAiDraftJob(selected.candidates[0], library.map((entry) => {
  const copy = { ...entry };
  delete copy.enabled;
  delete copy.quality_state;
  delete copy.pii_scan;
  return copy;
}));
assert.equal(apiShapeJob.references.length, 3);

const evalAfterSkipped = selectDraftCandidates({ records: [
  { ...answeredRecord, source_key: "eval:skip", channel: "inquiry", messages: [], preview: "" },
  { ...answeredRecord, source_key: "eval:usable" },
] }, new Map(), { includeAnsweredForEval: true, evalLimit: 1 });
assert.equal(evalAfterSkipped.candidates.length, 1);
assert.equal(evalAfterSkipped.candidates[0].source_key, "eval:usable");

const safe = validateGeneratedDraft(job, { text: "안녕하세요. 실제 출고 상태를 확인한 뒤 안내드리겠습니다." });
assert.equal(safe.ok, true);
assert.equal(safe.draft.ai_draft_origin, "AI");
assert.equal(safe.draft.ai_draft_purpose, "REPLY");
assert.equal(safe.draft.ai_draft_pii_scan, "PASS");
const inventedReference = validateGeneratedDraft(job, { text: "안녕하세요. 확인 후 안내드리겠습니다.", reference_ids: ["FAKE_REFERENCE"] });
assert.equal(inventedReference.draft.ai_draft_required_checks.includes("FAKE_REFERENCE"), false);
assert.equal(validateGeneratedDraft(job, { text: "연락처는 010-1234-5678입니다." }).ok, false);

console.log("marketplace-cs-monitor AI draft core: PASS");
