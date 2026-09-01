import { createHash } from "node:crypto";
import { inspectUnmaskedPii, maskSensitiveText } from "./report-core.mjs";

const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const actorFor = (message) => compact(message?.actor ?? message?.direction).toUpperCase();
const textFor = (message) => compact(message?.text);

function messageHash(message) {
  const supplied = compact(message?.message_hash ?? message?.content_hash);
  return supplied || sha256(JSON.stringify({
    actor: actorFor(message),
    at: compact(message?.at),
    text: textFor(message),
    image_count: Number(message?.image_count ?? 0) || 0,
  }));
}

function messageKey(message, index) {
  const supplied = compact(message?.message_key ?? message?.source_message_id);
  return supplied || `message:${Number(message?.sequence ?? index + 1) || index + 1}:${messageHash(message).slice(0, 16)}`;
}

function normalizedMessages(record) {
  return (record?.messages ?? []).map((message, index) => ({
    ...message,
    _index: index,
    _actor: actorFor(message),
    _text: textFor(message),
    _key: messageKey(message, index),
    _hash: messageHash(message),
  })).sort((left, right) => {
    const leftSequence = Number(left.sequence);
    const rightSequence = Number(right.sequence);
    if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }
    return left._index - right._index;
  });
}

function isImageOnly(message) {
  return Number(message?.image_count ?? 0) > 0 && !textFor(message);
}

function isChat(record) {
  return ["talktalk", "inquiry"].includes(compact(record?.channel).toLowerCase())
    || compact(record?.ui_type ?? record?.conversation_type).toUpperCase() === "CHAT";
}

function baseExclusionReasons(record, messages) {
  const reasons = [];
  if (compact(record?.pii_scan).toUpperCase() !== "PASS") reasons.push("PII_SCAN_FAILED");
  if (record?.conversation_complete === false || (isChat(record) && record?.conversation_complete !== true)) {
    reasons.push("CONVERSATION_INCOMPLETE");
  }
  if (compact(record?.last_actor).toUpperCase() === "UNKNOWN" || messages.some((message) => message._actor === "UNKNOWN")) {
    reasons.push("UNKNOWN_ACTOR");
  }
  if (messages.some(isImageOnly)) reasons.push("IMAGE_ONLY");
  return reasons;
}

function hasCandidatePii(...values) {
  return values.some((value) => inspectUnmaskedPii(compact(value)).length > 0);
}

function latestCustomer(messages) {
  return [...messages].reverse().find((message) => message._actor === "CUSTOMER" && message._text) ?? null;
}

function latestCustomerSellerPair(messages) {
  let customer = null;
  let pair = null;
  for (const message of messages) {
    if (message._actor === "CUSTOMER" && message._text) customer = message;
    if (customer && message._actor === "SELLER" && message._text) pair = { customer, seller: message };
  }
  return pair;
}

function stableId(prefix, record, messages) {
  const material = [
    compact(record?.source_key),
    compact(record?.content_hash),
    ...messages.flatMap((message) => [message._key, message._hash]),
  ].join("|");
  return `${prefix}_${sha256(material).slice(0, 24)}`;
}

function caseSummary(record) {
  const messages = normalizedMessages(record);
  const commonReasons = baseExclusionReasons(record, messages);
  const customer = latestCustomer(messages);
  const answerPair = latestCustomerSellerPair(messages);
  const answerReasons = [...commonReasons];
  const noReplyReasons = [...commonReasons];

  if (!["ANSWERED", "CLOSED"].includes(compact(record?.reply_state).toUpperCase())) {
    answerReasons.push("REPLY_STATE_NOT_ANSWERED_OR_CLOSED");
  }
  if (!answerPair) answerReasons.push("CUSTOMER_SELLER_PAIR_NOT_FOUND");
  if (answerPair && hasCandidatePii(answerPair.customer._text, answerPair.seller._text)) answerReasons.push("UNMASKED_PII");

  if (compact(record?.reply_state).toUpperCase() !== "NO_REPLY_REQUIRED") {
    noReplyReasons.push("REPLY_STATE_NOT_NO_REPLY_REQUIRED");
  }
  if (!customer) noReplyReasons.push("CUSTOMER_MESSAGE_NOT_FOUND");
  if (customer && hasCandidatePii(customer._text)) noReplyReasons.push("UNMASKED_PII");

  const summaryMessages = answerPair ? [answerPair.customer, answerPair.seller] : (customer ? [customer] : []);
  const customerText = customer ? maskSensitiveText(customer._text) : "";
  const sellerText = answerPair ? maskSensitiveText(answerPair.seller._text) : "";
  const replyState = compact(record?.reply_state).toUpperCase();
  const summaryText = customerText
    ? `문의: ${customerText}${sellerText ? ` / 실제 처리 답변: ${sellerText}` : ` / 처리 상태: ${replyState || "미분류"}`}`
    : `문의 원문 미확인 / 처리 상태: ${replyState || "미분류"}`;
  return {
    summary_id: stableId("CASE", record, summaryMessages),
    source_key: compact(record?.source_key),
    source_content_hash: compact(record?.content_hash),
    market: compact(record?.market),
    channel: compact(record?.channel),
    category: compact(record?.category),
    reply_state: replyState,
    summary_text_masked: summaryText,
    summary_version: "summary-v1",
    pii_scan: compact(record?.pii_scan).toUpperCase(),
    conversation_complete: typeof record?.conversation_complete === "boolean" ? record.conversation_complete : null,
    last_actor: compact(record?.last_actor).toUpperCase(),
    message_count: messages.length,
    image_count: messages.reduce((total, message) => total + (Number(message.image_count) || 0), 0),
    customer_message_key: customer?._key ?? "",
    customer_message_hash: customer?._hash ?? "",
    customer_question_masked: customerText,
    seller_message_key: answerPair?.seller?._key ?? "",
    seller_message_hash: answerPair?.seller?._hash ?? "",
    seller_answer_masked: sellerText,
    answer_candidate_eligible: answerReasons.length === 0,
    no_reply_pattern_candidate_eligible: noReplyReasons.length === 0,
    answer_candidate_exclusion_reasons: [...new Set(answerReasons)],
    no_reply_pattern_candidate_exclusion_reasons: [...new Set(noReplyReasons)],
  };
}

/**
 * Builds masked, review-only summaries and candidate rows. It intentionally does
 * not promote candidates into the verified answer library.
 */
export function buildSummaryLibraryArtifacts(report) {
  if (!report || Number(report.schema_version) !== 1 || !Array.isArray(report.records)) {
    throw new Error("INVALID_REPORT_SCHEMA");
  }

  const case_summaries = report.records.map(caseSummary);
  const answer_library_candidates = [];
  const no_reply_pattern_candidates = [];
  for (const summary of case_summaries) {
    if (summary.answer_candidate_eligible) {
      answer_library_candidates.push({
        candidate_id: `ANSWER_${sha256([summary.source_key, summary.source_content_hash, summary.customer_message_key, summary.customer_message_hash, summary.seller_message_key, summary.seller_message_hash].join("|")).slice(0, 24)}`,
        candidate_state: "CANDIDATE",
        source_type: "ACTUAL_SELLER_REPLY",
        source_case_key: summary.source_key,
        source_content_hash: summary.source_content_hash,
        market: summary.market,
        channel: summary.channel,
        category: summary.category,
        customer_message_key: summary.customer_message_key,
        customer_message_hash: summary.customer_message_hash,
        customer_question_masked: summary.customer_question_masked,
        seller_message_key: summary.seller_message_key,
        seller_message_hash: summary.seller_message_hash,
        human_answer_masked: summary.seller_answer_masked,
      });
    }
    if (summary.no_reply_pattern_candidate_eligible) {
      no_reply_pattern_candidates.push({
        candidate_id: `NO_REPLY_${sha256([summary.source_key, summary.source_content_hash, summary.customer_message_key, summary.customer_message_hash].join("|")).slice(0, 24)}`,
        candidate_state: "CANDIDATE",
        source_case_key: summary.source_key,
        source_content_hash: summary.source_content_hash,
        market: summary.market,
        channel: summary.channel,
        category: summary.category,
        customer_message_key: summary.customer_message_key,
        customer_message_hash: summary.customer_message_hash,
        customer_question_masked: summary.customer_question_masked,
        reply_state: "NO_REPLY_REQUIRED",
      });
    }
  }
  return { case_summaries, answer_library_candidates, no_reply_pattern_candidates };
}

/**
 * Returns a report copy with review-only artifacts. Existing records and their
 * content_hash values are preserved byte-for-byte.
 */
export function attachSummaryLibraryArtifacts(report) {
  const next = structuredClone(report);
  const artifacts = buildSummaryLibraryArtifacts(report);
  next.case_summaries = artifacts.case_summaries;
  next.answer_library_candidates = artifacts.answer_library_candidates;
  next.no_reply_pattern_candidates = artifacts.no_reply_pattern_candidates;
  next.summary = {
    ...next.summary,
    case_summary_count: artifacts.case_summaries.length,
    answer_library_candidate_count: artifacts.answer_library_candidates.length,
    no_reply_pattern_candidate_count: artifacts.no_reply_pattern_candidates.length,
  };
  return next;
}
