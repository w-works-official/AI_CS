import assert from "node:assert/strict";
import { attachSummaryLibraryArtifacts, buildSummaryLibraryArtifacts } from "./summary-library-core.mjs";

const answered = {
  market: "smartstore",
  channel: "comments",
  source_key: "smartstore:comments:answered",
  content_hash: "case-hash-answered",
  reply_state: "ANSWERED",
  pii_scan: "PASS",
  messages: [
    { source_message_id: "customer-1", sequence: 1, actor: "CUSTOMER", text: "바변경 가능한가요?", image_count: 0 },
    { source_message_id: "seller-1", sequence: 2, actor: "SELLER", text: "가능한 상품이며 주문 요청사항에 남겨주세요.", image_count: 0 },
  ],
};

const closed = {
  ...answered,
  source_key: "smartstore:comments:closed",
  content_hash: "case-hash-closed",
  reply_state: "CLOSED",
};

const noReply = {
  market: "smartstore",
  channel: "customer_qna",
  source_key: "smartstore:customer_qna:no-reply",
  content_hash: "case-hash-no-reply",
  reply_state: "NO_REPLY_REQUIRED",
  pii_scan: "PASS",
  messages: [{ source_message_id: "customer-2", sequence: 1, actor: "CUSTOMER", text: "감사합니다.", image_count: 0 }],
};

const incomplete = {
  ...answered,
  source_key: "smartstore:talktalk:incomplete",
  channel: "talktalk",
  conversation_complete: false,
};
const unknown = {
  ...answered,
  source_key: "smartstore:comments:unknown",
  messages: [...answered.messages, { source_message_id: "unknown-1", sequence: 3, actor: "UNKNOWN", text: "누구 발화인지 알 수 없음", image_count: 0 }],
};
const imageOnly = {
  ...answered,
  source_key: "smartstore:comments:image-only",
  messages: [{ source_message_id: "customer-image", sequence: 1, actor: "CUSTOMER", text: "", image_count: 1 }],
};
const piiFailure = { ...answered, source_key: "smartstore:comments:pii", pii_scan: "REVIEW" };
const evalDraft = { ...answered, source_key: "smartstore:comments:eval", ai_draft: "비교용 초안", ai_draft_origin: "AI", ai_draft_purpose: "EVAL" };
const aiReplyDraft = { ...answered, source_key: "smartstore:comments:ai-reply", ai_draft: "AI 초안", ai_draft_origin: "AI", ai_draft_purpose: "REPLY" };

const report = {
  schema_version: 1,
  summary: { marketplace_write_actions: 0 },
  records: [answered, closed, noReply, incomplete, unknown, imageOnly, piiFailure, evalDraft, aiReplyDraft],
};
const beforeHashes = report.records.map((record) => record.content_hash);
const artifacts = buildSummaryLibraryArtifacts(report);

assert.equal(artifacts.case_summaries.length, report.records.length);
assert.equal(artifacts.answer_library_candidates.length, 4);
assert.deepEqual(artifacts.answer_library_candidates.map((row) => row.source_case_key), [answered.source_key, closed.source_key, evalDraft.source_key, aiReplyDraft.source_key]);
assert.equal(artifacts.answer_library_candidates[0].candidate_state, "CANDIDATE");
assert.equal(artifacts.answer_library_candidates[0].source_type, "ACTUAL_SELLER_REPLY");
assert.equal(artifacts.no_reply_pattern_candidates.length, 1);
assert.equal(artifacts.no_reply_pattern_candidates[0].source_case_key, noReply.source_key);
assert.equal(artifacts.no_reply_pattern_candidates[0].reply_state, "NO_REPLY_REQUIRED");
assert.ok(artifacts.case_summaries.find((row) => row.source_key === incomplete.source_key).answer_candidate_exclusion_reasons.includes("CONVERSATION_INCOMPLETE"));
assert.equal(artifacts.case_summaries.find((row) => row.source_key === evalDraft.source_key).answer_candidate_eligible, true);
assert.ok(!artifacts.answer_library_candidates.find((row) => row.source_case_key === evalDraft.source_key).human_answer_masked.includes(evalDraft.ai_draft));
assert.match(artifacts.case_summaries[0].summary_text_masked, /실제 처리 답변/);
assert.ok(artifacts.case_summaries.find((row) => row.source_key === imageOnly.source_key).answer_candidate_exclusion_reasons.includes("IMAGE_ONLY"));

const attached = attachSummaryLibraryArtifacts(report);
assert.deepEqual(attached.records.map((record) => record.content_hash), beforeHashes);
assert.deepEqual(report.records.map((record) => record.content_hash), beforeHashes);
assert.equal(attached.summary.case_summary_count, 9);
assert.equal(attached.summary.answer_library_candidate_count, 4);
assert.equal(attached.summary.no_reply_pattern_candidate_count, 1);

const stableAgain = buildSummaryLibraryArtifacts(structuredClone(report));
assert.deepEqual(stableAgain.answer_library_candidates, artifacts.answer_library_candidates);
assert.deepEqual(stableAgain.no_reply_pattern_candidates, artifacts.no_reply_pattern_candidates);

console.log("marketplace-cs-monitor summary library core: PASS");
