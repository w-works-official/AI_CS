import assert from "node:assert/strict";
import {
  buildAiDraftJob,
  buildAnswerSearchRequest,
  buildDraftDecisions,
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
  conversation_complete: true,
  messages: [
    { direction: "customer", text: "언제 출고되나요?", at: "오전 10:00" },
    { direction: "seller", text: "확인하겠습니다.", at: "오전 10:01" },
    { direction: "customer", text: "오늘 출고 가능한가요?", at: "오전 10:02" },
  ],
};

assert.equal(extractLastCustomerTurn(replyRecord).text, "오늘 출고 가능한가요?");
assert.equal(extractLastCustomerTurn({ ...replyRecord, messages: [{ direction: "customer", text: "", image_count: 1 }] }).skip_reason, "IMAGE_REVIEW_REQUIRED");
assert.equal(extractLastCustomerTurn({ ...replyRecord, channel: "comments", messages: [], preview: "상품 길이가 궁금합니다." }).source, "POST_FALLBACK");
assert.equal(extractLastCustomerTurn({ ...replyRecord, messages: [] }).ok, false);

const answeredRecord = {
  ...replyRecord,
  source_key: "zigzag:item:test",
  channel: "item_question",
  reply_state: "ANSWERED",
  messages: [
    { direction: "customer", text: "교환 가능한가요?", at: "오전 10:00" },
    { direction: "seller", text: "SELLER_SECRET_ANSWER_SHOULD_NOT_LEAK", at: "오전 10:01" },
  ],
};
const selected = selectDraftCandidates({ records: [replyRecord, answeredRecord] }, new Map(), { includeAnsweredForEval: true, evalLimit: 1 });
assert.equal(selected.candidates.length, 2);
assert.equal(selected.candidates[0].purpose, "REPLY");
assert.equal(selected.candidates[1].purpose, "EVAL");
assert.equal(JSON.stringify(selected.candidates[1]).includes("seller_replies"), false);

const unchanged = selectDraftCandidates({ records: [{ ...replyRecord, change_state: "UNCHANGED" }] });
assert.equal(unchanged.candidates.length, 0);
assert.equal(unchanged.skipped[0].reason, "UNCHANGED");

const acknowledgementSkipped = selectDraftCandidates({ records: [{
  ...replyRecord,
  source_key: "smartstore:talktalk:acknowledgement",
  messages: [
    { direction: "seller", text: "안내드렸습니다." },
    { direction: "customer", text: "네네 감사합니다~!" },
  ],
}] });
assert.equal(acknowledgementSkipped.candidates.length, 0);
assert.equal(acknowledgementSkipped.skipped[0].reason, "NO_REPLY_REQUIRED");
const completenessMissing = selectDraftCandidates({ records: [{
  ...replyRecord,
  source_key: "smartstore:talktalk:completeness-missing",
  conversation_complete: null,
}] });
assert.equal(completenessMissing.candidates.length, 0);
assert.equal(completenessMissing.skipped[0].reason, "CONVERSATION_INCOMPLETE");
assert.ok(completenessMissing.skipped[0].required_checks.includes("COMPLETENESS_NOT_REPORTED"));
const decisionReport = { records: [replyRecord, {
  ...replyRecord,
  source_key: "smartstore:talktalk:decision-ack",
  messages: [{ direction: "customer", text: "네 감사합니다" }],
}] };
const decisionSelection = selectDraftCandidates(decisionReport);
const decisions = buildDraftDecisions(decisionReport, decisionSelection, [{ source_key: replyRecord.source_key }]);
assert.equal(decisions.length, 2);
assert.deepEqual(decisions.map((item) => [item.decision, item.reason_code, item.purpose]), [
  ["GENERATE", "DRAFT_GENERATED", "REPLY"],
  ["SKIP", "NO_REPLY_REQUIRED", "REPLY"],
]);

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
const evalJob = buildAiDraftJob(selected.candidates[1], library);
assert.equal(evalJob.purpose, "EVAL");
assert.equal(JSON.stringify(evalJob).includes("SELLER_SECRET_ANSWER_SHOULD_NOT_LEAK"), false);
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

const chatSkipCases = selectDraftCandidates({ records: [
  { ...replyRecord, source_key: "chat:unchanged", change_state: "UNCHANGED" },
  { ...replyRecord, source_key: "chat:incomplete", conversation_complete: false, conversation_incomplete_reason: "스크롤 범위 미확인" },
  { ...replyRecord, source_key: "chat:image-only", messages: [{ direction: "customer", text: "", image_count: 1 }] },
  { ...replyRecord, source_key: "chat:no-customer", reply_state: "ANSWERED", messages: [{ direction: "seller", text: "confirmed" }] },
  { ...replyRecord, source_key: "chat:actor-uncertain", last_actor: "seller" },
] }, new Map(), { includeAnsweredForEval: true });
const activeSkipped = selectDraftCandidates({ records: [{ ...replyRecord, source_key: "chat:active" }] }, new Map([
  ["chat:active", { ai_draft_state: "READY" }],
]));
assert.deepEqual(
  chatSkipCases.skipped.map((entry) => entry.reason),
  ["UNCHANGED", "CONVERSATION_INCOMPLETE", "IMAGE_REVIEW_REQUIRED", "CUSTOMER_TURN_NOT_FOUND", "ACTOR_UNCERTAIN"],
);
assert.equal(activeSkipped.skipped[0].reason, "ACTIVE_DRAFT_EXISTS");
assert.ok(chatSkipCases.skipped.find((entry) => entry.source_key === "chat:incomplete").required_checks.includes("스크롤 범위 미확인"));
for (const entry of [...chatSkipCases.skipped, ...activeSkipped.skipped]) {
  assert.equal(entry.reason_code, entry.reason);
  assert.equal(typeof entry.source_key, "string");
  assert.ok(Array.isArray(entry.required_checks));
}

const evalDisabled = selectDraftCandidates({ records: [answeredRecord] });
assert.equal(evalDisabled.skipped[0].reason, "EVAL_DISABLED");
const evalWithoutSellerAnswer = selectDraftCandidates({ records: [{
  ...answeredRecord,
  source_key: "zigzag:item:no-seller-answer",
  messages: [{ direction: "customer", text: "교환 가능한가요?" }],
  seller_replies: [],
}] }, new Map(), { includeAnsweredForEval: true });
assert.equal(evalWithoutSellerAnswer.skipped[0].reason, "SELLER_ANSWER_NOT_FOUND");
const evalLimit = selectDraftCandidates({ records: [answeredRecord, { ...answeredRecord, source_key: "zigzag:item:second" }] }, new Map(), {
  includeAnsweredForEval: true,
  evalLimit: 1,
});
assert.equal(evalLimit.candidates.length, 1);
assert.equal(evalLimit.skipped[0].reason, "EVAL_LIMIT_REACHED");

const talkTalkEval = selectDraftCandidates({ records: [{
  ...answeredRecord,
  source_key: "smartstore:talktalk:answered",
  channel: "talktalk",
}] }, new Map(), { includeAnsweredForEval: true });
assert.equal(talkTalkEval.candidates.length, 1);
assert.equal(talkTalkEval.candidates[0].purpose, "EVAL");
assert.equal(JSON.stringify(buildAiDraftJob(talkTalkEval.candidates[0], [])).includes("SELLER_SECRET_ANSWER_SHOULD_NOT_LEAK"), false);

const safe = validateGeneratedDraft(job, { text: "안녕하세요. 실제 출고 상태를 확인한 뒤 안내드리겠습니다." });
assert.equal(safe.ok, true);
assert.equal(safe.draft.ai_draft_origin, "AI");
assert.equal(safe.draft.ai_draft_purpose, "REPLY");
assert.equal(safe.draft.ai_draft_pii_scan, "PASS");
const inventedReference = validateGeneratedDraft(job, { text: "안녕하세요. 확인 후 안내드리겠습니다.", reference_ids: ["FAKE_REFERENCE"] });
assert.equal(inventedReference.draft.ai_draft_required_checks.includes("FAKE_REFERENCE"), false);
assert.equal(validateGeneratedDraft(job, { text: "연락처는 010-1234-5678입니다." }).ok, false);

console.log("marketplace-cs-monitor AI draft core: PASS");
