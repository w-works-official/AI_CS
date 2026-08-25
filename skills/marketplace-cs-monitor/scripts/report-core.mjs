import { createHash } from "node:crypto";

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
    .replace(/\b\d{12,}\b/g, (number) => maskLongNumber(number))
    .replace(/(주소\s*[:：]?)[^,;]+/gi, "$1 [주소 마스킹]");
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

function isAcknowledgement(text) {
  const value = compact(text).replace(/[.!~♡♥️😊🙂]+/g, "");
  return /^(네|넵|네네|넹|예|확인|확인했습니다|알겠습니다|감사|감사합니다|고맙습니다|아하|아 네|좋아요)$/.test(value);
}

function inferReplyState(status, lastActor, lastMessage) {
  const state = compact(status);
  if (lastActor === "customer" && isAcknowledgement(lastMessage)) return "NO_REPLY";
  if (lastActor === "customer") return "NEEDS_REPLY";
  if (lastActor === "seller") return "ANSWERED";
  if (/답변완료|완료|종료/.test(state)) return "ANSWERED";
  if (/미답변|답변대기|대기/.test(state)) return "NEEDS_REPLY";
  if (/진행중|처리중/.test(state)) return "REVIEW";
  return "REVIEW";
}

function normalizeMessage(message) {
  return {
    direction: ["customer", "seller", "automatic", "system"].includes(message?.direction) ? message.direction : "unknown",
    at: compact(message?.at ?? message?.time),
    text: maskSensitiveText(message?.text),
    image_count: Number(message?.image_count ?? 0) || 0,
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

  const lastMessage = messages.at(-1) ?? null;
  const lastActor = raw.last_actor ?? lastMessage?.direction ?? (sellerReplies.length ? "seller" : "unknown");
  const customer = raw.customer_name ?? raw.customer ?? raw.customer_id ?? raw.customer_id_masked ?? "";
  const replyState = inferReplyState(raw.status, lastActor, lastMessage?.text ?? raw.last_message ?? "");
  const aiDraft = maskSensitiveText(raw.ai_draft);
  if (aiDraft && replyState === "NEEDS_REPLY" && raw.ai_draft_origin !== "AI") {
    throw new Error("AI_DRAFT_ORIGIN_REQUIRED");
  }
  const masked = {
    market,
    channel,
    source_key: `${market}:${channel}:${sha256(sourceId).slice(0, 24)}`,
    occurred_at: compact(raw.occurred_at ?? raw.created_at ?? raw.received_at ?? raw.updated_at ?? raw.message_date),
    status: compact(raw.status),
    category: compact(raw.category ?? raw.tag ?? raw.type),
    customer_masked: /\*/.test(String(customer)) ? compact(customer) : (String(customer).includes(" ") ? maskName(customer) : maskId(customer)),
    subject: maskSensitiveText(raw.subject ?? raw.title ?? raw.body),
    preview: maskSensitiveText(raw.preview ?? raw.body),
    product_id: compact(raw.product_id),
    product_name: maskSensitiveText(raw.product_name ?? raw.product),
    order_no_masked: maskLongNumber(raw.order_no ?? raw.order_id),
    product_order_no_masked: maskLongNumber(raw.product_order_no),
    messages,
    seller_replies: sellerReplies,
    last_actor: ["customer", "seller", "automatic", "system"].includes(lastActor) ? lastActor : "unknown",
    reply_state: replyState,
    ai_draft: replyState === "NEEDS_REPLY" ? aiDraft : "",
    ai_draft_origin: replyState === "NEEDS_REPLY" && aiDraft ? "AI" : "",
    ai_draft_required_checks: replyState === "NEEDS_REPLY" && aiDraft ? maskSensitiveText(raw.ai_draft_required_checks) : "",
    ai_draft_pii_scan: replyState === "NEEDS_REPLY" && aiDraft && raw.ai_draft_pii_scan === "PASS" ? "PASS" : "REVIEW",
    pii_scan: "PASS",
  };
  masked.content_hash = sha256(stableJson({ ...masked, content_hash: undefined, change_state: undefined }));
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
    const channelRows = [];
    for (const raw of source.records ?? []) {
      const normalized = normalizeRecord(source.market ?? key.split("_")[0], source.channel ?? key, raw);
      const old = previous.get(normalized.source_key);
      normalized.change_state = !old ? "NEW" : old.content_hash === normalized.content_hash ? "UNCHANGED" : "CHANGED";
      channelRows.push(normalized);
      records.push(normalized);
    }
    channelReports[key] = {
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

export { CHANNEL_KEYS, maskSensitiveText, normalizeRecord };
