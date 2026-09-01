import { createHash } from "node:crypto";
import { isCustomerAcknowledgement } from "./conversation-policy.mjs";

const CHANNEL_KEYS = [
  "smartstore_comments",
  "smartstore_customer_qna",
  "smartstore_customer_center",
  "smartstore_talktalk",
  "zigzag_order_inquiry",
  "zigzag_item_question",
  "ably_inquiry",
];

const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const MARKETPLACE_HOST_SUFFIXES = ["naver.com", "kakaostyle.com", "a-bly.com"];
const SENSITIVE_URL_KEY_PARTS = ["token", "secret", "session", "cookie", "auth", "authorization", "password", "passwd", "credential", "signature", "jwt", "apikey", "accesskey", "refreshtoken"];
const isSensitiveUrlKey = (key) => {
  const normalized = String(key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "key" || SENSITIVE_URL_KEY_PARTS.some((part) => normalized.includes(part));
};

function normalizeMarketplaceUrl(value) {
  const text = compact(value);
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("MARKETPLACE_URL_INVALID");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("MARKETPLACE_URL_UNSAFE");
  }
  const host = parsed.hostname.toLowerCase();
  if (!MARKETPLACE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new Error("MARKETPLACE_URL_HOST_NOT_ALLOWED");
  }
  for (const [key, item] of parsed.searchParams) {
    if (isSensitiveUrlKey(key)) throw new Error("MARKETPLACE_URL_SECRET_PARAM");
    if (/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(item) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(item)) {
      throw new Error("MARKETPLACE_URL_PII_PARAM");
    }
  }
  let decodedHash = "";
  try {
    decodedHash = decodeURIComponent(parsed.hash || "");
  } catch {
    throw new Error("MARKETPLACE_URL_INVALID_FRAGMENT");
  }
  const fragmentQuery = decodedHash.includes("?")
    ? decodedHash.slice(decodedHash.indexOf("?") + 1)
    : decodedHash.replace(/^#/, "");
  for (const [key, item] of new URLSearchParams(fragmentQuery)) {
    if (isSensitiveUrlKey(key)) throw new Error("MARKETPLACE_URL_SECRET_FRAGMENT");
    if (/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(item) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(item)) {
      throw new Error("MARKETPLACE_URL_PII_FRAGMENT");
    }
  }
  return parsed.toString();
}

function normalizeSourceUrlKind(value, sourceUrl) {
  const requested = compact(value).toUpperCase();
  const kind = requested || (sourceUrl ? "LIST" : "UNAVAILABLE");
  if (!["EXACT", "LIST", "UNAVAILABLE"].includes(kind)) throw new Error("SOURCE_URL_KIND_INVALID");
  if (kind === "EXACT" && !sourceUrl) throw new Error("SOURCE_URL_EXACT_REQUIRED");
  if (kind === "UNAVAILABLE" && sourceUrl) throw new Error("SOURCE_URL_UNAVAILABLE_MISMATCH");
  return kind;
}

function contentHashForRecord(record) {
  const material = { ...record };
  material.messages = (material.messages ?? []).map((message) => {
    const normalized = { ...message };
    // Array order and lowercase direction already carry the inquiry content.
    // Collector evidence must not churn every legacy content hash.
    delete normalized.actor;
    delete normalized.sequence;
    delete normalized.direction_confidence;
    return normalized;
  });
  if (material.conversation_complete !== false) delete material.conversation_complete;
  if (!material.conversation_incomplete_reason) delete material.conversation_incomplete_reason;
  delete material.conversation_order;
  delete material.last_actor_confidence;
  for (const field of [
    "content_hash",
    "change_state",
    "source_url",
    "source_url_kind",
    "source_reference",
    "product_url",
    "product_thumbnail_url",
    "ai_draft",
    "ai_draft_origin",
    "ai_draft_purpose",
    "ai_draft_required_checks",
    "ai_draft_pii_scan",
    "ai_draft_decision",
    "ai_draft_decision_purpose",
    "ai_draft_reason_code",
    "ai_draft_decision_checks",
  ]) {
    delete material[field];
  }
  return sha256(stableJson(material));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function maskName(value) {
  const text = compact(value);
  if (!text) return "";
  if (text.includes("*")) return text;
  return `${text.slice(0, 1)}${"*".repeat(Math.max(2, text.length - 1))}`;
}

function maskId(value) {
  const text = compact(value);
  if (!text || text.includes("*")) return text;
  if (text.length <= 2) return `${text.slice(0, 1)}*`;
  return `${text.slice(0, 2)}***${text.slice(-1)}`;
}

function maskLongNumber(value) {
  const text = compact(value);
  if (!/^\d{10,}$/.test(text)) return text;
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function maskSensitiveText(value) {
  return compact(value)
    .replace(/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/g, "010-****-****")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "**@***")
    .replace(/((?:상품\s*)?주문번호\s*[:：]?\s*)\d{6,}/gi, "$1[마스킹]")
    .replace(/\b\d{12,}\b/g, (number) => maskLongNumber(number))
    .replace(/(주소\s*[:：]?)[^,;]+/gi, "$1 [주소 마스킹]");
}

export function inspectUnmaskedPii(value) {
  const text = compact(value);
  const issues = [];
  if (/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(text)) issues.push("PHONE");
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) issues.push("EMAIL");
  if (/\b\d{12,}\b/.test(text)) issues.push("LONG_NUMBER");
  if (/(?:계좌|은행)\s*[:：]?\s*[0-9-]{6,}/.test(text)) issues.push("ACCOUNT");
  if (/(?:상품\s*)?(?:주문번호|송장번호|운송장)\s*[:：]?\s*\d{6,}/i.test(text)) issues.push("ORDER_OR_TRACKING");
  if (/(?:주소|배송지)\s*[:：]\s*[^,;]{5,}/i.test(text)) issues.push("ADDRESS");
  return [...new Set(issues)];
}

function rawSourceId(market, channel, record) {
  if (record.source_id) return compact(record.source_id);
  if (market === "zigzag") return compact(record.inquiry_id);
  if (market === "ably") return compact(record.room_id);
  if (channel === "talktalk") return compact(record.thread_id);
  if (channel === "customer_center") return compact(record.inquiry_id);
  if (channel === "customer_qna") {
    return compact([record.product_order_no, record.received_at, record.subject].join("|"));
  }
  if (channel === "comments") {
    return compact([record.product_id, record.created_at, record.customer_id, record.customer_id_masked, record.body].join("|"));
  }
  return compact([record.occurred_at, record.customer_id, record.subject, record.preview].join("|"));
}

function sourceKeyForRaw(market, channel, record) {
  const sourceId = rawSourceId(market, channel, record);
  if (!sourceId) throw new Error(`Missing stable source id for ${market}/${channel}`);
  return `${market}:${channel}:${sha256(sourceId).slice(0, 24)}`;
}

function inferReplyState(status, lastActor, lastMessage) {
  const state = compact(status);
  if (lastActor === "customer" && isCustomerAcknowledgement(lastMessage)) return "NO_REPLY";
  if (lastActor === "customer") return "NEEDS_REPLY";
  if (lastActor === "seller") return "ANSWERED";
  if (/답변완료|완료|종료/.test(state)) return "ANSWERED";
  if (/미답변|답변대기|대기/.test(state)) return "NEEDS_REPLY";
  if (/진행중|처리중/.test(state)) return "REVIEW";
  return "REVIEW";
}

function normalizeMessage(message) {
  const actor = compact(message?.direction ?? message?.actor).toLowerCase();
  return {
    source_message_id: compact(message?.source_message_id),
    sequence: Number.isFinite(Number(message?.sequence)) ? Number(message.sequence) : null,
    actor: ["customer", "seller", "automatic", "system"].includes(actor) ? actor.toUpperCase() : "UNKNOWN",
    direction: ["customer", "seller", "automatic", "system"].includes(actor) ? actor : "unknown",
    direction_confidence: compact(message?.direction_confidence).toUpperCase(),
    at: compact(message?.at ?? message?.time),
    text: maskSensitiveText(message?.text),
    image_count: Number(message?.image_count ?? 0) || 0,
  };
}

function normalizeConversationState(raw, messages) {
  const explicit = typeof raw?.conversation_complete === "boolean" ? raw.conversation_complete : null;
  const issue = compact(raw?.conversation_incomplete_reason ?? raw?.conversation_issue).toUpperCase();
  const lastConversationalMessage = [...messages]
    .reverse()
    .find((message) => message.direction === "customer" || message.direction === "seller");
  return {
    complete: explicit,
    incomplete_reason: explicit === false ? (issue || "CONVERSATION_INCOMPLETE") : issue,
    last_actor: lastConversationalMessage?.direction ?? "unknown",
    last_actor_confidence: compact(raw?.last_actor_confidence ?? lastConversationalMessage?.direction_confidence).toUpperCase(),
    last_message: lastConversationalMessage ?? null,
  };
}

function normalizeReply(reply) {
  return {
    at: compact(reply?.at ?? reply?.replied_at),
    text: maskSensitiveText(reply?.text ?? reply?.body),
  };
}

function normalizeRecord(market, channel, raw) {
  const sourceId = rawSourceId(market, channel, raw);
  if (!sourceId) throw new Error(`Missing stable source id for ${market}/${channel}`);

  const messages = (raw.messages ?? []).map(normalizeMessage);
  const sellerReplies = (raw.seller_replies ?? raw.replies ?? []).map(normalizeReply);
  if (raw.seller_reply) sellerReplies.push({ at: compact(raw.processed_at), text: maskSensitiveText(raw.seller_reply) });

  const conversation = normalizeConversationState(raw, messages);
  const lastMessage = conversation.last_message;
  const requestedLastActor = compact(raw.last_actor).toLowerCase();
  const lastActor = ["customer", "seller"].includes(requestedLastActor)
    ? requestedLastActor
    : (conversation.last_actor !== "unknown" ? conversation.last_actor : (sellerReplies.length ? "seller" : "unknown"));
  const customer = raw.customer_name ?? raw.customer ?? raw.customer_id ?? raw.customer_id_masked ?? "";
  const inferredReplyState = market === "ably" && /완료|종료/.test(compact(raw.status))
    ? (lastActor === "seller" ? "ANSWERED" : "NO_REPLY")
    : inferReplyState(raw.status, lastActor, lastMessage?.text ?? raw.last_message ?? "");
  const isChat = channel === "talktalk" || channel === "inquiry" || compact(raw.ui_type ?? raw.conversation_type).toUpperCase() === "CHAT";
  const replyState = isChat && conversation.complete !== true ? "REVIEW" : inferredReplyState;
  const aiDraft = maskSensitiveText(raw.ai_draft);
  const requestedDraftPurpose = compact(raw.ai_draft_purpose).toUpperCase();
  const aiDraftPurpose = aiDraft
    ? (requestedDraftPurpose || (replyState === "NEEDS_REPLY" ? "REPLY" : ""))
    : "";
  const draftAllowed = (replyState === "NEEDS_REPLY" && aiDraftPurpose === "REPLY")
    || (replyState === "ANSWERED" && aiDraftPurpose === "EVAL");
  if (aiDraft && !draftAllowed) {
    throw new Error("AI_DRAFT_REPLY_STATE_MISMATCH");
  }
  if (aiDraft && raw.ai_draft_origin !== "AI") {
    throw new Error("AI_DRAFT_ORIGIN_REQUIRED");
  }
  const sourceUrl = normalizeMarketplaceUrl(raw.source_url);
  const productUrl = normalizeMarketplaceUrl(raw.product_url);
  const productThumbnailUrl = normalizeMarketplaceUrl(raw.product_thumbnail_url);
  const masked = {
    market,
    channel,
    source_key: sourceKeyForRaw(market, channel, raw),
    occurred_at: compact(raw.occurred_at ?? raw.created_at ?? raw.received_at ?? raw.updated_at ?? raw.message_date),
    status: compact(raw.status),
    category: compact(raw.category ?? raw.tag ?? raw.type),
    customer_masked: /\*/.test(String(customer)) ? compact(customer) : (String(customer).includes(" ") ? maskName(customer) : maskId(customer)),
    subject: maskSensitiveText(raw.subject ?? raw.title ?? raw.body),
    preview: maskSensitiveText(raw.preview ?? raw.body),
    product_id: compact(raw.product_id),
    product_name: maskSensitiveText(raw.product_name ?? raw.product),
    source_url: sourceUrl,
    source_url_kind: normalizeSourceUrlKind(raw.source_url_kind, sourceUrl),
    source_reference: maskSensitiveText(raw.source_reference_masked),
    product_url: productUrl,
    product_thumbnail_url: productThumbnailUrl,
    order_no_masked: maskLongNumber(raw.order_no ?? raw.order_id),
    product_order_no_masked: maskLongNumber(raw.product_order_no),
    messages,
    seller_replies: sellerReplies,
    last_actor: ["customer", "seller", "automatic", "system"].includes(lastActor) ? lastActor : "unknown",
    last_actor_confidence: conversation.last_actor_confidence,
    conversation_complete: conversation.complete,
    conversation_incomplete_reason: conversation.incomplete_reason,
    conversation_order: compact(raw.conversation_order).toUpperCase(),
    reply_state: replyState,
    ai_draft: draftAllowed ? aiDraft : "",
    ai_draft_origin: draftAllowed && aiDraft ? "AI" : "",
    ai_draft_purpose: draftAllowed && aiDraft ? aiDraftPurpose : "",
    ai_draft_required_checks: draftAllowed && aiDraft ? maskSensitiveText(raw.ai_draft_required_checks) : "",
    ai_draft_pii_scan: draftAllowed && aiDraft && raw.ai_draft_pii_scan === "PASS" ? "PASS" : "REVIEW",
    pii_scan: "PASS",
  };
  masked.content_hash = contentHashForRecord(masked);
  return masked;
}

function normalizePrevious(previousRecords = []) {
  return new Map(previousRecords.filter((row) => row?.source_key).map((row) => [row.source_key, row]));
}

export function buildReport(rawCollection, previousRecords = []) {
  const channels = rawCollection?.channels ?? {};
  const previous = normalizePrevious(previousRecords);
  const records = [];
  const channelReports = {};

  for (const key of CHANNEL_KEYS) {
    const source = channels[key] ?? {};
    const market = source.market ?? key.split("_")[0];
    const channel = source.channel ?? key;
    const channelRows = [];
    for (const raw of source.records ?? []) {
      const normalized = normalizeRecord(market, channel, raw);
      const old = previous.get(normalized.source_key);
      normalized.change_state = !old ? "NEW" : old.content_hash === normalized.content_hash ? "UNCHANGED" : "CHANGED";
      channelRows.push(normalized);
      records.push(normalized);
    }
    const openQueueKeys = (source.open_queue_records ?? []).map((raw) => sourceKeyForRaw(market, channel, raw));
    const uniqueOpenQueueKeys = [...new Set(openQueueKeys)];
    if (openQueueKeys.length !== uniqueOpenQueueKeys.length) {
      throw new Error(`OPEN_QUEUE_DUPLICATE_SOURCE_KEY:${key}`);
    }
    const openQueueVisibleTotal = Number(source.open_queue_visible_total ?? uniqueOpenQueueKeys.length) || 0;
    const requestedOpenQueueComplete = Boolean(source.open_queue_complete);
    if (requestedOpenQueueComplete && openQueueVisibleTotal !== uniqueOpenQueueKeys.length) {
      throw new Error(`OPEN_QUEUE_TOTAL_MISMATCH:${key}:${openQueueVisibleTotal}:${uniqueOpenQueueKeys.length}`);
    }
    const queueBlockers = [];
    if (!source.attempted) queueBlockers.push("CHANNEL_NOT_ATTEMPTED");
    if (compact(source.error)) queueBlockers.push("CHANNEL_ERROR");
    if (compact(source.open_queue_error)) queueBlockers.push("QUEUE_ERROR");
    if (!compact(source.open_queue_scope)) queueBlockers.push("SCOPE_MISSING");
    if (!compact(source.open_queue_window_start)) queueBlockers.push("WINDOW_MISSING");
    const openQueueComplete = requestedOpenQueueComplete && queueBlockers.length === 0;
    const openQueueError = compact(source.open_queue_error)
      || (requestedOpenQueueComplete && queueBlockers.length ? `OPEN_QUEUE_NOT_RECONCILABLE:${queueBlockers.join("+")}` : "")
      || (!requestedOpenQueueComplete && source.attempted ? "OPEN_QUEUE_INCOMPLETE" : "");
    channelReports[key] = {
      market,
      channel,
      attempted: Boolean(source.attempted),
      visible_total: Number(source.visible_total ?? 0) || 0,
      collected_count: channelRows.length,
      skipped_count: Number(source.skipped_count ?? 0) || 0,
      new_count: channelRows.filter((row) => row.change_state === "NEW").length,
      changed_count: channelRows.filter((row) => row.change_state === "CHANGED").length,
      unchanged_count: channelRows.filter((row) => row.change_state === "UNCHANGED").length,
      needs_reply_count: channelRows.filter((row) => row.reply_state === "NEEDS_REPLY").length,
      read_state_transition_count: Number(source.read_state_transition_count ?? 0) || 0,
      error: compact(source.error),
      filter: compact(source.filter),
      sort: compact(source.sort),
      open_queue_complete: openQueueComplete,
      open_queue_scope: compact(source.open_queue_scope),
      open_queue_window_start: compact(source.open_queue_window_start),
      open_queue_visible_total: openQueueVisibleTotal,
      open_queue_observed_count: uniqueOpenQueueKeys.length,
      open_queue_source_keys: uniqueOpenQueueKeys,
      open_queue_error: openQueueError,
    };
  }

  const keys = records.map((row) => row.source_key);
  const duplicateCount = keys.length - new Set(keys).size;
  const missingKeyCount = records.filter((row) => !row.source_key).length;
  const missingHashCount = records.filter((row) => !row.content_hash).length;
  const report = {
    schema_version: 1,
    mode: rawCollection?.mode ?? "changes_today",
    range: rawCollection?.range ?? {},
    collected_at: rawCollection?.collected_at ?? new Date().toISOString(),
    duration_ms: Number(rawCollection?.duration_ms ?? 0) || 0,
    summary: {
      prepared_count: records.length,
      new_count: records.filter((row) => row.change_state === "NEW").length,
      changed_count: records.filter((row) => row.change_state === "CHANGED").length,
      unchanged_count: records.filter((row) => row.change_state === "UNCHANGED").length,
      needs_reply_count: records.filter((row) => row.reply_state === "NEEDS_REPLY").length,
      duplicate_count: duplicateCount,
      missing_key_count: missingKeyCount,
      missing_hash_count: missingHashCount,
      talktalk_read_state_transitions: channelReports.smartstore_talktalk?.read_state_transition_count ?? 0,
      reconciled_channel_count: Object.values(channelReports).filter((channel) => channel.open_queue_complete).length,
      marketplace_write_actions: 0,
    },
    channels: channelReports,
    records,
  };

  if (duplicateCount || missingKeyCount || missingHashCount) {
    throw new Error(`Report verification failed: duplicates=${duplicateCount}, missing_keys=${missingKeyCount}, missing_hashes=${missingHashCount}`);
  }
  if (report.summary.new_count + report.summary.changed_count + report.summary.unchanged_count !== records.length) {
    throw new Error("Report comparison totals do not reconcile");
  }
  return report;
}

export function applyAiDrafts(report, drafts = []) {
  if (!report || Number(report.schema_version) !== 1 || !Array.isArray(report.records)) {
    throw new Error("INVALID_REPORT_SCHEMA");
  }
  const draftByKey = new Map();
  for (const draft of drafts) {
    const sourceKey = compact(draft?.source_key);
    if (!sourceKey) throw new Error("AI_DRAFT_SOURCE_KEY_REQUIRED");
    if (draftByKey.has(sourceKey)) throw new Error(`DUPLICATE_AI_DRAFT:${sourceKey}`);
    draftByKey.set(sourceKey, draft);
  }

  const next = structuredClone(report);
  for (const record of next.records) {
    const draft = draftByKey.get(record.source_key);
    if (!draft) continue;
    const purpose = compact(draft.ai_draft_purpose).toUpperCase()
      || (record.reply_state === "NEEDS_REPLY" ? "REPLY" : "");
    const allowed = (record.reply_state === "NEEDS_REPLY" && purpose === "REPLY")
      || (record.reply_state === "ANSWERED" && purpose === "EVAL");
    if (!allowed) throw new Error(`AI_DRAFT_REPLY_STATE_MISMATCH:${record.source_key}`);
    if (draft.ai_draft_origin !== "AI") throw new Error("AI_DRAFT_ORIGIN_REQUIRED");
    if (draft.ai_draft_pii_scan !== "PASS") throw new Error("AI_DRAFT_PII_SCAN_REQUIRED");
    const rawText = compact(draft.ai_draft);
    const piiIssues = inspectUnmaskedPii(rawText);
    if (piiIssues.length) throw new Error(`AI_DRAFT_UNMASKED_PII:${piiIssues.join(",")}`);
    const text = maskSensitiveText(rawText);
    if (!text) throw new Error("AI_DRAFT_TEXT_REQUIRED");
    record.ai_draft = text;
    record.ai_draft_origin = "AI";
    record.ai_draft_purpose = purpose;
    record.ai_draft_required_checks = maskSensitiveText(draft.ai_draft_required_checks);
    record.ai_draft_pii_scan = "PASS";
    record.content_hash = contentHashForRecord(record);
    draftByKey.delete(record.source_key);
  }
  if (draftByKey.size) throw new Error(`AI_DRAFT_CASE_NOT_FOUND:${[...draftByKey.keys()][0]}`);
  next.summary.reply_draft_count = next.records.filter((row) => row.ai_draft_purpose === "REPLY").length;
  next.summary.eval_draft_count = next.records.filter((row) => row.ai_draft_purpose === "EVAL").length;
  return next;
}

export function applyDraftDecisions(report, decisions = []) {
  if (!report || Number(report.schema_version) !== 1 || !Array.isArray(report.records)) {
    throw new Error("INVALID_REPORT_SCHEMA");
  }
  const next = structuredClone(report);
  const recordByKey = new Map(next.records.map((record) => [record.source_key, record]));
  const seen = new Set();
  next.draft_decisions = (decisions ?? []).map((decision) => {
    const sourceKey = compact(decision?.source_key);
    const purpose = compact(decision?.purpose).toUpperCase();
    const action = compact(decision?.decision).toUpperCase();
    const reasonCode = compact(decision?.reason_code).toUpperCase();
    const record = recordByKey.get(sourceKey);
    if (!record) throw new Error(`DRAFT_DECISION_CASE_NOT_FOUND:${sourceKey}`);
    if (!["REPLY", "EVAL"].includes(purpose)) throw new Error(`DRAFT_DECISION_PURPOSE_INVALID:${sourceKey}`);
    if (!["GENERATE", "SKIP"].includes(action)) throw new Error(`DRAFT_DECISION_INVALID:${sourceKey}`);
    if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(reasonCode)) throw new Error(`DRAFT_DECISION_REASON_INVALID:${sourceKey}`);
    const identity = sourceKey;
    if (seen.has(identity)) throw new Error(`DUPLICATE_DRAFT_DECISION:${identity}`);
    seen.add(identity);
    const checks = [...new Set((decision?.required_checks ?? []).map(compact).filter(Boolean))]
      .map((value) => maskSensitiveText(value));
    record.ai_draft_decision = action;
    record.ai_draft_decision_purpose = purpose;
    record.ai_draft_reason_code = reasonCode;
    record.ai_draft_decision_checks = checks;
    return {
      source_key: sourceKey,
      source_content_hash: record.content_hash,
      purpose,
      decision: action,
      reason_code: reasonCode,
      required_checks: checks,
    };
  });
  next.summary.draft_decision_count = next.draft_decisions.length;
  next.summary.draft_generated_count = next.draft_decisions.filter((item) => item.decision === "GENERATE").length;
  next.summary.draft_skipped_count = next.draft_decisions.filter((item) => item.decision === "SKIP").length;
  next.summary.draft_skip_reason_counts = next.draft_decisions
    .filter((item) => item.decision === "SKIP")
    .reduce((counts, item) => ({ ...counts, [item.reason_code]: Number(counts[item.reason_code] ?? 0) + 1 }), {});
  return next;
}

export { CHANNEL_KEYS, maskSensitiveText, normalizeMarketplaceUrl, normalizeRecord, sourceKeyForRaw };
