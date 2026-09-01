import assert from "node:assert/strict";
import { applyAiDrafts, applyDraftDecisions, buildReport, normalizeMarketplaceUrl } from "./report-core.mjs";
import { selectDraftCandidates } from "./ai-draft-core.mjs";
import { isCustomerAcknowledgement } from "./conversation-policy.mjs";

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
      open_queue_complete: true,
      open_queue_scope: "one_week_unanswered",
      open_queue_window_start: "2026-08-19",
      open_queue_visible_total: 1,
      open_queue_records: [{ inquiry_id: "23423568" }],
    },
    zigzag_item_question: { market: "zigzag", channel: "item_question", attempted: true, visible_total: 0, records: [] },
    ably_inquiry: {
      market: "ably", channel: "inquiry", attempted: true, visible_total: 1,
      records: [{ room_id: "95162904", status: "진행중", customer_name: "혜진", occurred_at: "2026-08-25 10:02", conversation_complete: true, messages: [{ direction: "seller", text: "확인했습니다" }, { direction: "customer", text: "감사합니다" }] }],
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
assert.equal(first.summary.reconciled_channel_count, 1);
assert.equal(first.channels.zigzag_order_inquiry.open_queue_complete, true);
assert.equal(first.channels.zigzag_order_inquiry.open_queue_source_keys.length, 1);
assert.match(first.channels.zigzag_order_inquiry.open_queue_source_keys[0], /^zigzag:order_inquiry:/);
assert.equal(JSON.stringify(first).includes("23423568"), false);

assert.equal(isCustomerAcknowledgement("네네 감사합니다~!"), true);
assert.equal(isCustomerAcknowledgement("네에 감사합니다아"), true);
assert.equal(isCustomerAcknowledgement("감사합니다. 그런데 배송은 언제 오나요?"), false);
const acknowledgementInput = structuredClone(base);
acknowledgementInput.channels.smartstore_talktalk = {
  market: "smartstore", channel: "talktalk", attempted: true, visible_total: 3,
  records: [
    { thread_id: "ack-one", status: "진행중", conversation_complete: true, messages: [{ direction: "seller", text: "안내드렸습니다." }, { direction: "customer", text: "네네 감사합니다~!" }] },
    { thread_id: "ack-two", status: "진행중", conversation_complete: true, messages: [{ direction: "seller", text: "안내드렸습니다." }, { direction: "customer", text: "네에 감사합니다아" }] },
    { thread_id: "question-after-thanks", status: "진행중", conversation_complete: true, messages: [{ direction: "seller", text: "안내드렸습니다." }, { direction: "customer", text: "감사합니다. 그런데 배송은 언제 오나요?" }] },
  ],
};
const acknowledgementReport = buildReport(acknowledgementInput, []);
assert.equal(acknowledgementReport.records.find((row) => row.messages.at(-1)?.text === "네네 감사합니다~!")?.reply_state, "NO_REPLY");
assert.equal(acknowledgementReport.records.find((row) => row.messages.at(-1)?.text === "네에 감사합니다아")?.reply_state, "NO_REPLY");
assert.equal(acknowledgementReport.records.find((row) => row.messages.at(-1)?.text.includes("배송은 언제"))?.reply_state, "NEEDS_REPLY");
const incompleteChatInput = structuredClone(base);
incompleteChatInput.channels.smartstore_talktalk = {
  market: "smartstore", channel: "talktalk", attempted: true, visible_total: 1,
  records: [{ thread_id: "completeness-missing", status: "진행중", messages: [{ direction: "customer", text: "배송은 언제 오나요?" }] }],
};
const incompleteChatReport = buildReport(incompleteChatInput, []);
assert.equal(incompleteChatReport.records.find((row) => row.channel === "talktalk")?.reply_state, "REVIEW");

const unsafeQueueInput = structuredClone(base);
unsafeQueueInput.channels.zigzag_order_inquiry = {
  market: "zigzag", channel: "order_inquiry", attempted: false, visible_total: 0,
  error: "SELECTOR_FAILURE", records: [], open_queue_complete: true,
  open_queue_visible_total: 0, open_queue_records: [], open_queue_scope: "", open_queue_window_start: "",
};
const unsafeQueueReport = buildReport(unsafeQueueInput, []);
assert.equal(unsafeQueueReport.channels.zigzag_order_inquiry.open_queue_complete, false);
assert.match(unsafeQueueReport.channels.zigzag_order_inquiry.open_queue_error, /OPEN_QUEUE_NOT_RECONCILABLE/);
assert.equal(unsafeQueueReport.summary.reconciled_channel_count, 0);
const decisionTarget = first.records.find((row) => row.reply_state === "NEEDS_REPLY");
const decisionHash = decisionTarget.content_hash;
const withDecision = applyDraftDecisions(first, [{
  source_key: decisionTarget.source_key,
  purpose: "REPLY",
  decision: "SKIP",
  reason_code: "IMAGE_REVIEW_REQUIRED",
  required_checks: ["첨부 이미지 원문 확인"],
}]);
assert.equal(withDecision.summary.draft_decision_count, 1);
assert.equal(withDecision.summary.draft_skipped_count, 1);
assert.equal(withDecision.records.find((row) => row.source_key === decisionTarget.source_key).content_hash, decisionHash);
assert.equal(withDecision.draft_decisions[0].reason_code, "IMAGE_REVIEW_REQUIRED");

assert.equal(
  normalizeMarketplaceUrl("https://talk.naver.com/ct/example?filter.read=unread"),
  "https://talk.naver.com/ct/example?filter.read=unread",
);
assert.throws(() => normalizeMarketplaceUrl("http://talk.naver.com/ct/example"), /MARKETPLACE_URL_UNSAFE/);
assert.throws(() => normalizeMarketplaceUrl("https://example.com/ct/example"), /MARKETPLACE_URL_HOST_NOT_ALLOWED/);
assert.throws(() => normalizeMarketplaceUrl("https://talk.naver.com/ct/example?access_token=secret"), /MARKETPLACE_URL_SECRET_PARAM/);
assert.throws(() => normalizeMarketplaceUrl("https://talk.naver.com/ct/example?phone=010-1234-5678"), /MARKETPLACE_URL_PII_PARAM/);
assert.throws(() => normalizeMarketplaceUrl("https://talk.naver.com/#/chat?session_token=secret"), /MARKETPLACE_URL_SECRET_FRAGMENT/);
assert.throws(() => normalizeMarketplaceUrl("https://talk.naver.com/#%E0%A4%A"), /MARKETPLACE_URL_INVALID_FRAGMENT/);

const linkedTalktalkInput = structuredClone(base);
linkedTalktalkInput.channels.smartstore_talktalk.records = [{
  thread_id: "thread-123",
  message_date: "2026-08-25",
  customer_name: "고객",
  product: "샘플 피어싱",
  source_url: "https://talk.naver.com/ct/thread-123?filter.read=unread",
  source_url_kind: "EXACT",
  source_reference_masked: "TT-0b6d54a12345",
  messages: [{ direction: "customer", text: "사진을 확인해 주세요", image_count: 1 }],
  last_actor: "customer",
  conversation_complete: true,
}];
const linkedTalktalk = buildReport(linkedTalktalkInput, []);
const linkedRecord = linkedTalktalk.records.find((row) => row.channel === "talktalk");
assert.equal(linkedRecord.source_url_kind, "EXACT");
assert.match(linkedRecord.source_url, /^https:\/\/talk\.naver\.com\/ct\/thread-123/);
assert.equal(linkedRecord.source_reference, "TT-0b6d54a12345");
assert.equal(linkedRecord.product_name, "샘플 피어싱");
assert.equal(linkedRecord.messages[0].image_count, 1);
assert.equal(linkedRecord.conversation_complete, true);
const legacyCompletenessInput = structuredClone(linkedTalktalkInput);
delete legacyCompletenessInput.channels.smartstore_talktalk.records[0].conversation_complete;
const legacyCompletenessRecord = buildReport(legacyCompletenessInput, []).records.find((row) => row.channel === "talktalk");
assert.notEqual(linkedRecord.content_hash, legacyCompletenessRecord.content_hash);
assert.equal(legacyCompletenessRecord.reply_state, "REVIEW");

const incompleteTalktalkInput = structuredClone(linkedTalktalkInput);
incompleteTalktalkInput.channels.smartstore_talktalk.records[0].conversation_complete = false;
incompleteTalktalkInput.channels.smartstore_talktalk.records[0].conversation_incomplete_reason = "history_scroll_unstable";
const incompleteTalktalk = buildReport(incompleteTalktalkInput, []);
const incompleteTalktalkRecord = incompleteTalktalk.records.find((row) => row.channel === "talktalk");
assert.equal(incompleteTalktalkRecord.reply_state, "REVIEW");
assert.equal(incompleteTalktalkRecord.conversation_complete, false);
assert.equal(incompleteTalktalkRecord.conversation_incomplete_reason, "HISTORY_SCROLL_UNSTABLE");
assert.notEqual(incompleteTalktalkRecord.content_hash, linkedRecord.content_hash);

const systemTailInput = structuredClone(linkedTalktalkInput);
systemTailInput.channels.smartstore_talktalk.records[0].last_actor = "system";
systemTailInput.channels.smartstore_talktalk.records[0].messages = [
  { actor: "CUSTOMER", text: "언제 출고되나요?", sequence: 0, direction_confidence: "CLASS_VERIFIED" },
  { actor: "SYSTEM", text: "상담 안내" },
];
const systemTail = buildReport(systemTailInput, []);
const systemTailRecord = systemTail.records.find((row) => row.channel === "talktalk");
assert.equal(systemTailRecord.last_actor, "customer");
assert.equal(systemTailRecord.reply_state, "NEEDS_REPLY");
assert.equal(systemTailRecord.messages[0].sequence, 0);
assert.equal(systemTailRecord.messages[0].actor, "CUSTOMER");
assert.equal(systemTailRecord.last_actor_confidence, "CLASS_VERIFIED");
const systemTailCandidates = selectDraftCandidates({ records: [systemTailRecord] });
assert.equal(systemTailCandidates.candidates.length, 1);
assert.equal(systemTailCandidates.candidates[0].purpose, "REPLY");

const sellerTailInput = structuredClone(linkedTalktalkInput);
sellerTailInput.channels.smartstore_talktalk.records[0].last_actor = "system";
sellerTailInput.channels.smartstore_talktalk.records[0].messages = [
  { direction: "customer", text: "언제 출고되나요?", sequence: 0 },
  { direction: "seller", text: "실제 주문 상태 확인 후 안내드리겠습니다.", sequence: 1 },
  { direction: "system", text: "상담 안내", sequence: 2 },
];
const sellerTailRecord = buildReport(sellerTailInput, []).records.find((row) => row.channel === "talktalk");
assert.equal(sellerTailRecord.reply_state, "ANSWERED");
const sellerTailCandidates = selectDraftCandidates({ records: [sellerTailRecord] }, new Map(), { includeAnsweredForEval: true });
assert.equal(sellerTailCandidates.candidates.length, 1);
assert.equal(sellerTailCandidates.candidates[0].purpose, "EVAL");
assert.equal(JSON.stringify(sellerTailCandidates.candidates[0]).includes("실제 주문 상태"), false);

const incompleteTalktalkCandidates = selectDraftCandidates({ records: [incompleteTalktalkRecord] });
assert.equal(incompleteTalktalkCandidates.candidates.length, 0);
assert.equal(incompleteTalktalkCandidates.skipped[0].reason, "CONVERSATION_INCOMPLETE");
const linkOnlyChange = structuredClone(linkedTalktalkInput);
linkOnlyChange.channels.smartstore_talktalk.records[0].source_url = "https://talk.naver.com/ct/thread-123?filter.read=all";
const linkOnlyReport = buildReport(linkOnlyChange, [{ source_key: linkedRecord.source_key, content_hash: linkedRecord.content_hash }]);
assert.equal(linkOnlyReport.records.find((row) => row.channel === "talktalk").change_state, "UNCHANGED");
const missingExactLink = structuredClone(linkedTalktalkInput);
missingExactLink.channels.smartstore_talktalk.records[0].source_url = "";
assert.throws(() => buildReport(missingExactLink, []), /SOURCE_URL_EXACT_REQUIRED/);

const linkedChannelInput = structuredClone(base);
linkedChannelInput.channels.smartstore_comments.records = [{
  product_id: "1001",
  created_at: "2026-08-25 10:10",
  customer_id_masked: "ab***z",
  body: "상품 문의입니다.",
  status: "미답변",
  source_url: "https://sell.smartstore.naver.com/#/comment/",
  source_url_kind: "LIST",
  source_reference_masked: "SS-C-a1b2c3d4e5f6",
  product_url: "https://smartstore.naver.com/pinkrocket/products/1001",
}];
linkedChannelInput.channels.smartstore_customer_qna.visible_total = 1;
linkedChannelInput.channels.smartstore_customer_qna.records = [{
  product_order_no: "123456789012",
  received_at: "2026-08-25 10:11",
  subject: "교환 문의",
  status: "답변완료",
  source_url: "https://sell.smartstore.naver.com/#/naverpay/qnas",
  source_url_kind: "LIST",
  source_reference_masked: "SS-Q-a1b2c3d4e5f6",
}];
linkedChannelInput.channels.zigzag_item_question.visible_total = 1;
linkedChannelInput.channels.zigzag_item_question.records = [{
  source_id: "34567890",
  occurred_at: "2026-08-25 10:12",
  subject: "상품 문의",
  status: "미답변",
  source_url: "https://partners.kakaostyle.com/shop/pink-rocket/item_question/detail/34567890",
  source_url_kind: "EXACT",
  source_reference_masked: "ZZ-I-a1b2c3d4e5f6",
}];
linkedChannelInput.channels.ably_inquiry.records = [{
  room_id: "95162904",
  occurred_at: "2026-08-25 10:13",
  customer_name: "혜진",
  status: "진행중",
  source_url: "https://my.a-bly.com/inquiry",
  source_url_kind: "LIST",
  source_reference_masked: "AB-a1b2c3d4e5f6",
  messages: [{ direction: "customer", text: "문의합니다." }],
}];
const linkedChannels = buildReport(linkedChannelInput, []);
const linkedComment = linkedChannels.records.find((row) => row.channel === "comments");
const linkedQna = linkedChannels.records.find((row) => row.channel === "customer_qna");
const linkedZigzagItem = linkedChannels.records.find((row) => row.channel === "item_question");
const linkedAbly = linkedChannels.records.find((row) => row.market === "ably");
assert.equal(linkedComment.source_url_kind, "LIST");
assert.match(linkedComment.product_url, /^https:\/\/smartstore\.naver\.com\/pinkrocket\/products\/1001/);
assert.equal(linkedQna.source_reference, "SS-Q-a1b2c3d4e5f6");
assert.equal(linkedZigzagItem.source_url_kind, "EXACT");
assert.match(linkedZigzagItem.source_url, /\/item_question\/detail\/34567890$/);
assert.equal(linkedAbly.source_url_kind, "LIST");
assert.equal(linkedAbly.source_reference, "AB-a1b2c3d4e5f6");

const unsafeCamelCaseUrl = structuredClone(linkedChannelInput);
unsafeCamelCaseUrl.channels.zigzag_item_question.records[0].source_url = "https://partners.kakaostyle.com/shop/pink-rocket/item_question?sessionId=secret";
assert.throws(() => buildReport(unsafeCamelCaseUrl, []), /MARKETPLACE_URL_SECRET_PARAM/);

const incompleteQueue = structuredClone(base);
incompleteQueue.channels.zigzag_order_inquiry.open_queue_visible_total = 2;
assert.throws(() => buildReport(incompleteQueue, []), /OPEN_QUEUE_TOTAL_MISMATCH/);

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
assert.equal(attached.content_hash, target.content_hash);
assert.throws(() => applyAiDrafts(first, [{ source_key: target.source_key, ai_draft: "초안", ai_draft_origin: "AI", ai_draft_pii_scan: "REVIEW" }]), /AI_DRAFT_PII_SCAN_REQUIRED/);
assert.throws(() => applyAiDrafts(first, [{ source_key: target.source_key, ai_draft: "연락처는 010-1234-5678입니다.", ai_draft_origin: "AI", ai_draft_pii_scan: "PASS" }]), /AI_DRAFT_UNMASKED_PII/);

const ablyCompleted = structuredClone(base);
ablyCompleted.channels.ably_inquiry.records = [{
  room_id: "95162905",
  status: "완료",
  customer_name: "혜진",
  occurred_at: "2026-08-25 11:00",
  conversation_complete: true,
  messages: [{ direction: "customer", text: "전체 취소 철회가 가능한가요? 상품 주문번호 648997240" }],
  last_actor: "customer",
}];
const completedReport = buildReport(ablyCompleted, []);
const completedAbly = completedReport.records.find((row) => row.market === "ably");
assert.equal(completedAbly.reply_state, "NO_REPLY");
assert.match(completedAbly.messages[0].text, /상품 주문번호 \[마스킹\]/);
assert.equal(JSON.stringify(completedAbly).includes("648997240"), false);

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
