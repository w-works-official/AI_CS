const ALLOWED_REVIEW_STATES = new Set(["APPROVED", "REJECTED"]);
const ALLOWED_COMPOSITION_SOURCE_TYPES = new Set(["AI_DRAFT", "REPLY_TEMPLATE", "ANSWER_LIBRARY_ENTRY", "MANUAL"]);
const ALLOWED_REVIEW_KEYS = new Set([
  "action",
  "draft_id", "draft_state", "review_note", "human_revision",
  "composition_source_type", "composition_source_id", "composition_source_version",
  "base_text_hash", "final_text_hash", "unresolved_variables", "source_content_hash",
  "environment", "auto_send", "marketplace_write_actions",
]);
const ALLOWED_SYNC_KEYS = new Set(["action", "run_id", "report", "model", "prompt_version"]);
const ALLOWED_TEMPLATE_KEYS = new Set(["action", "template_key", "template_version", "template_name", "template_text", "market", "channel", "intent", "required_checks", "quality_state", "environment", "auto_send", "marketplace_write_actions"]);
const ALLOWED_TEMPLATE_STATE_KEYS = new Set(["action", "template_id", "quality_state", "environment", "auto_send", "marketplace_write_actions"]);
const ALLOWED_LIBRARY_REVIEW_KEYS = new Set(["action", "library_entry_id", "quality_state", "review_note", "environment", "auto_send", "marketplace_write_actions"]);
const ALLOWED_REPORT_KEYS = new Set(["schema_version", "mode", "range", "collected_at", "duration_ms", "summary", "channels", "records"]);
const ALLOWED_RECORD_KEYS = new Set([
  "market", "channel", "source_key", "occurred_at", "status", "category", "customer_masked",
  "subject", "preview", "product_id", "product_name", "order_no_masked", "product_order_no_masked",
  "source_url", "source_url_kind", "source_reference", "product_url", "product_thumbnail_url",
  "messages", "seller_replies", "last_actor", "reply_state", "ai_draft", "ai_draft_origin",
  "ai_draft_purpose", "ai_draft_required_checks", "ai_draft_pii_scan", "pii_scan", "content_hash", "change_state",
]);
const ALLOWED_MESSAGE_KEYS = new Set(["source_message_id", "direction", "actor", "at", "text", "image_count", "images"]);
const ALLOWED_IMAGE_KEYS = new Set(["ordinal", "url", "src", "thumbnail_url", "thumbnail", "alt_text", "alt", "media_type", "access_state"]);

function safeText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

const ALLOWED_MARKETPLACE_SUFFIXES = ["naver.com", "kakaostyle.com", "a-bly.com"];
const ALLOWED_ASSET_SUFFIXES = [...ALLOWED_MARKETPLACE_SUFFIXES, "pstatic.net", "kakaocdn.net", "daumcdn.net"];
const SENSITIVE_URL_PARTS = ["token", "secret", "session", "cookie", "auth", "authorization", "password", "passwd", "credential", "signature", "jwt", "apikey", "accesskey", "refreshtoken"];
function isSensitiveUrlKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "key" || SENSITIVE_URL_PARTS.some((part) => normalized.includes(part));
}

function safeMarketplaceUrl(value: unknown): string {
  const textValue = safeText(value, 3000);
  if (!textValue) return "";
  let url: URL;
  try { url = new URL(textValue); } catch { throw new Error("MARKETPLACE_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("MARKETPLACE_URL_UNSAFE");
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_MARKETPLACE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) throw new Error("MARKETPLACE_URL_HOST_NOT_ALLOWED");
  const inspectParams = (params: URLSearchParams) => {
    for (const [key, item] of params) {
      if (isSensitiveUrlKey(key)) throw new Error("MARKETPLACE_URL_SECRET_PARAM");
      assertMaskedReviewText(item);
    }
  };
  inspectParams(url.searchParams);
  const hashQuery = decodeURIComponent(url.hash || "");
  if (hashQuery.includes("?")) inspectParams(new URLSearchParams(hashQuery.slice(hashQuery.indexOf("?") + 1)));
  return url.toString();
}

function safeAssetUrl(value: unknown): string {
  const textValue = safeText(value, 3000);
  if (!textValue) return "";
  let url: URL;
  try { url = new URL(textValue); } catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_ASSET_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return "";
  for (const key of url.searchParams.keys()) if (isSensitiveUrlKey(key)) return "";
  return url.toString();
}

export function assertMaskedReviewText(value: string): void {
  if (/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(value)) throw new Error("UNMASKED_PHONE");
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) throw new Error("UNMASKED_EMAIL");
  if (/\b\d{12,}\b/.test(value)) throw new Error("UNMASKED_LONG_NUMBER");
}

function optionalMaskedText(value: unknown, maxLength: number, error: string): string {
  const normalized = safeText(value, maxLength);
  assertMaskedReviewText(normalized);
  if (String(value ?? "").trim().length > maxLength) throw new Error(error);
  return normalized;
}

function optionalHash(value: unknown, error: string): string {
  const normalized = safeText(value, 64).toLowerCase();
  if (!normalized) return "";
  if (!/^[a-f0-9]{64}$/.test(normalized) || String(value ?? "").trim().length !== 64) throw new Error(error);
  return normalized;
}

function normalizedUnresolvedVariables(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error("INVALID_UNRESOLVED_VARIABLES");
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("INVALID_UNRESOLVED_VARIABLES");
    const variable = item.trim();
    if (!/^\[[^\[\]\r\n]{1,80}\]$/.test(variable)) throw new Error("INVALID_UNRESOLVED_VARIABLES");
    assertMaskedReviewText(variable);
    return variable;
  });
}

export function normalizeCaseBatchKeys(value: string): string[] {
  const keys = String(value ?? "").split(",").map((key) => key.trim()).filter(Boolean);
  if (!keys.length) throw new Error("CASE_KEYS_REQUIRED");
  if (keys.length > 3) throw new Error("CASE_BATCH_TOO_LARGE");
  if (new Set(keys).size !== keys.length) throw new Error("DUPLICATE_CASE_KEY");
  if (keys.some((key) => key.length > 300 || !/^[A-Za-z0-9:_-]+$/.test(key))) throw new Error("CASE_KEY_INVALID");
  return keys;
}

export function assertSingletonReadParams(params: URLSearchParams): void {
  for (const key of new Set(params.keys())) {
    if (params.getAll(key).length !== 1) throw new Error(`READ_PARAM_DUPLICATE:${key}`);
  }
}

export function normalizeReviewRequest(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_REVIEW_REQUEST");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_REVIEW_KEYS.has(key)) throw new Error(`REVIEW_PARAM_NOT_ALLOWED:${key}`);
  }
  if (raw.action !== undefined && raw.action !== "reviewDraft") throw new Error("UNKNOWN_WRITE_ACTION");
  const draftId = safeText(raw.draft_id, 300);
  const draftState = safeText(raw.draft_state, 20).toUpperCase();
  const reviewNote = safeText(raw.review_note, 1000);
  const humanRevision = safeText(raw.human_revision, 4000);
  const sourceType = safeText(raw.composition_source_type, 50).toUpperCase() || "MANUAL";
  const sourceId = optionalMaskedText(raw.composition_source_id, 300, "COMPOSITION_SOURCE_ID_TOO_LONG");
  const sourceVersion = optionalMaskedText(raw.composition_source_version, 100, "COMPOSITION_SOURCE_VERSION_TOO_LONG");
  const baseTextHash = optionalHash(raw.base_text_hash, "INVALID_BASE_TEXT_HASH");
  const finalTextHash = optionalHash(raw.final_text_hash, "INVALID_FINAL_TEXT_HASH");
  const sourceContentHash = optionalHash(raw.source_content_hash, "INVALID_SOURCE_CONTENT_HASH");
  const unresolvedVariables = normalizedUnresolvedVariables(raw.unresolved_variables);
  const environment = raw.environment === undefined ? "development" : safeText(raw.environment, 30);
  const autoSend = raw.auto_send === undefined ? false : raw.auto_send;
  const marketplaceWrites = raw.marketplace_write_actions === undefined ? 0 : raw.marketplace_write_actions;
  if (!draftId) throw new Error("DRAFT_ID_REQUIRED");
  if (!ALLOWED_REVIEW_STATES.has(draftState)) throw new Error("INVALID_DRAFT_STATE");
  if (draftState === "APPROVED" && !humanRevision) throw new Error("HUMAN_REVISION_REQUIRED");
  if (!ALLOWED_COMPOSITION_SOURCE_TYPES.has(sourceType)) throw new Error("INVALID_COMPOSITION_SOURCE_TYPE");
  if (sourceType !== "MANUAL" && (!sourceId || !sourceVersion)) throw new Error("COMPOSITION_SOURCE_REFERENCE_REQUIRED");
  if (environment !== "development" || autoSend !== false || Number(marketplaceWrites) !== 0) throw new Error("DEVELOPMENT_SAFETY_REQUIRED");
  if (draftState === "APPROVED" && unresolvedVariables.length > 0) throw new Error("UNRESOLVED_TEMPLATE_VARIABLES");
  assertMaskedReviewText(reviewNote);
  assertMaskedReviewText(humanRevision);
  return {
    action: "reviewDraft" as const,
    draft_id: draftId,
    draft_state: draftState as "APPROVED" | "REJECTED",
    review_note: reviewNote,
    human_revision: humanRevision,
    composition_source_type: sourceType as "AI_DRAFT" | "REPLY_TEMPLATE" | "ANSWER_LIBRARY_ENTRY" | "MANUAL",
    composition_source_id: sourceId,
    composition_source_version: sourceVersion,
    base_text_hash: baseTextHash,
    final_text_hash: finalTextHash,
    unresolved_variables: unresolvedVariables,
    source_content_hash: sourceContentHash,
    environment: "development" as const,
    auto_send: false as const,
    marketplace_write_actions: 0 as const,
  };
}

function assertDevelopmentMutation(raw: Record<string, unknown>): void {
  const environment = raw.environment === undefined ? "development" : safeText(raw.environment, 30);
  const autoSend = raw.auto_send === undefined ? false : raw.auto_send;
  const marketplaceWrites = raw.marketplace_write_actions === undefined ? 0 : raw.marketplace_write_actions;
  if (environment !== "development" || autoSend !== false || Number(marketplaceWrites) !== 0) throw new Error("DEVELOPMENT_SAFETY_REQUIRED");
}

function normalizedQualityState(value: unknown, allowCandidate = true): "CANDIDATE" | "USE" | "EXCLUDE" {
  const state = safeText(value, 20).toUpperCase() || (allowCandidate ? "USE" : "");
  const allowed = allowCandidate ? ["CANDIDATE", "USE", "EXCLUDE"] : ["USE", "EXCLUDE"];
  if (!allowed.includes(state)) throw new Error("INVALID_QUALITY_STATE");
  return state as "CANDIDATE" | "USE" | "EXCLUDE";
}

export function normalizeTemplateRequest(input: unknown) {
  const raw = plainObject(input, "INVALID_TEMPLATE_REQUEST");
  assertOnlyKeys(raw, ALLOWED_TEMPLATE_KEYS, "TEMPLATE_PARAM_NOT_ALLOWED");
  if (raw.action !== "upsertTemplate") throw new Error("UNKNOWN_WRITE_ACTION");
  assertDevelopmentMutation(raw);
  const templateKey = optionalMaskedText(raw.template_key, 200, "TEMPLATE_KEY_TOO_LONG");
  const version = optionalMaskedText(raw.template_version, 100, "TEMPLATE_VERSION_TOO_LONG");
  const name = optionalMaskedText(raw.template_name, 500, "TEMPLATE_NAME_TOO_LONG");
  const body = optionalMaskedText(raw.template_text, 20_000, "TEMPLATE_TEXT_TOO_LONG");
  if (!templateKey || !version || !name || !body) throw new Error("TEMPLATE_REQUIRED_FIELD_MISSING");
  const checks = Array.isArray(raw.required_checks) ? raw.required_checks.map((item) => optionalMaskedText(item, 500, "TEMPLATE_CHECK_TOO_LONG")) : [];
  if (checks.length > 20) throw new Error("INVALID_REQUIRED_CHECKS");
  return {
    action: "upsertTemplate" as const, template_key: templateKey, template_version: version,
    template_name: name, template_text: body,
    market: optionalMaskedText(raw.market, 50, "TEMPLATE_MARKET_TOO_LONG"),
    channel: optionalMaskedText(raw.channel, 100, "TEMPLATE_CHANNEL_TOO_LONG"),
    intent: optionalMaskedText(raw.intent, 100, "TEMPLATE_INTENT_TOO_LONG"),
    required_checks: checks, quality_state: normalizedQualityState(raw.quality_state),
    environment: "development" as const, auto_send: false as const, marketplace_write_actions: 0 as const,
  };
}

export function normalizeTemplateStateRequest(input: unknown) {
  const raw = plainObject(input, "INVALID_TEMPLATE_STATE_REQUEST");
  assertOnlyKeys(raw, ALLOWED_TEMPLATE_STATE_KEYS, "TEMPLATE_STATE_PARAM_NOT_ALLOWED");
  if (raw.action !== "setTemplateState") throw new Error("UNKNOWN_WRITE_ACTION");
  assertDevelopmentMutation(raw);
  const templateId = optionalMaskedText(raw.template_id, 300, "TEMPLATE_ID_TOO_LONG");
  if (!templateId || !/^[A-Za-z0-9:_-]+$/.test(templateId)) throw new Error("INVALID_TEMPLATE_ID");
  return { action: "setTemplateState" as const, template_id: templateId, quality_state: normalizedQualityState(raw.quality_state, false) as "USE" | "EXCLUDE", environment: "development" as const, auto_send: false as const, marketplace_write_actions: 0 as const };
}

export function normalizeLibraryReviewRequest(input: unknown) {
  const raw = plainObject(input, "INVALID_LIBRARY_REVIEW_REQUEST");
  assertOnlyKeys(raw, ALLOWED_LIBRARY_REVIEW_KEYS, "LIBRARY_REVIEW_PARAM_NOT_ALLOWED");
  if (raw.action !== "reviewLibraryEntry") throw new Error("UNKNOWN_WRITE_ACTION");
  assertDevelopmentMutation(raw);
  const entryId = optionalMaskedText(raw.library_entry_id, 300, "LIBRARY_ENTRY_ID_TOO_LONG");
  if (!entryId || !/^[A-Za-z0-9:_-]+$/.test(entryId)) throw new Error("INVALID_LIBRARY_ENTRY_ID");
  return { action: "reviewLibraryEntry" as const, library_entry_id: entryId, quality_state: normalizedQualityState(raw.quality_state, false) as "USE" | "EXCLUDE", review_note: optionalMaskedText(raw.review_note, 1_000, "REVIEW_NOTE_TOO_LONG"), environment: "development" as const, auto_send: false as const, marketplace_write_actions: 0 as const };
}

function plainObject(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(raw: Record<string, unknown>, allowed: Set<string>, error: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${error}:${key}`);
  }
}

function normalizedMessage(value: unknown): Record<string, unknown> {
  const raw = plainObject(value, "INVALID_MESSAGE");
  assertOnlyKeys(raw, ALLOWED_MESSAGE_KEYS, "MESSAGE_PARAM_NOT_ALLOWED");
  const text = safeText(raw.text, 8000);
  assertMaskedReviewText(text);
  const images = Array.isArray(raw.images) ? raw.images.slice(0, 20).map((value, index) => {
    const image = plainObject(value, "INVALID_MESSAGE_IMAGE");
    assertOnlyKeys(image, ALLOWED_IMAGE_KEYS, "MESSAGE_IMAGE_PARAM_NOT_ALLOWED");
    const assetUrl = safeAssetUrl(image.url ?? image.src);
    const thumbnailUrl = safeAssetUrl(image.thumbnail_url ?? image.thumbnail ?? image.url ?? image.src);
    const accessState = assetUrl || thumbnailUrl ? "PUBLIC_URL" : safeText(image.access_state, 30).toUpperCase() === "UNAVAILABLE" ? "UNAVAILABLE" : "SESSION_REQUIRED";
    const altText = optionalMaskedText(image.alt_text ?? image.alt, 500, "MESSAGE_IMAGE_ALT_TOO_LONG");
    return { ordinal: index + 1, url: assetUrl, thumbnail_url: thumbnailUrl, alt_text: altText, media_type: "IMAGE", access_state: accessState };
  }) : [];
  return {
    ...(raw.source_message_id !== undefined ? { source_message_id: safeText(raw.source_message_id, 300) } : {}),
    ...(raw.direction !== undefined ? { direction: safeText(raw.direction, 20) } : {}),
    ...(raw.actor !== undefined ? { actor: safeText(raw.actor, 20) } : {}),
    at: safeText(raw.at, 50),
    text,
    image_count: Math.max(images.length, Math.max(0, Math.min(Number(raw.image_count) || 0, 100))),
    images,
  };
}

function normalizedRecord(value: unknown): Record<string, unknown> {
  const raw = plainObject(value, "INVALID_RECORD");
  assertOnlyKeys(raw, ALLOWED_RECORD_KEYS, "RECORD_PARAM_NOT_ALLOWED");
  const sourceKey = safeText(raw.source_key, 500);
  const contentHash = safeText(raw.content_hash, 200);
  if (!sourceKey) throw new Error("SOURCE_KEY_REQUIRED");
  if (!contentHash) throw new Error("CONTENT_HASH_REQUIRED");
  if (safeText(raw.pii_scan, 20).toUpperCase() !== "PASS") throw new Error("PII_SCAN_PASS_REQUIRED");

  const customerMasked = safeText(raw.customer_masked, 500);
  if (customerMasked && !customerMasked.includes("*")) throw new Error("CUSTOMER_NOT_MASKED");
  const textFields = ["customer_masked", "subject", "preview", "product_name", "ai_draft", "ai_draft_required_checks"] as const;
  for (const field of textFields) assertMaskedReviewText(safeText(raw[field], field === "ai_draft" ? 8000 : 2000));
  for (const field of ["order_no_masked", "product_order_no_masked"] as const) {
    if (/^\d{10,}$/.test(safeText(raw[field], 200))) throw new Error(`UNMASKED_LONG_NUMBER:${field}`);
  }

  const replyState = safeText(raw.reply_state, 30).toUpperCase();
  const draftText = safeText(raw.ai_draft, 8000);
  const draftPurpose = safeText(raw.ai_draft_purpose, 20).toUpperCase();
  if (draftText) {
    if (safeText(raw.ai_draft_origin, 20).toUpperCase() !== "AI") throw new Error("AI_DRAFT_ORIGIN_REQUIRED");
    if (safeText(raw.ai_draft_pii_scan, 20).toUpperCase() !== "PASS") throw new Error("AI_DRAFT_PII_SCAN_REQUIRED");
    const replyDraft = replyState === "NEEDS_REPLY" && draftPurpose === "REPLY";
    const evalDraft = replyState === "ANSWERED" && draftPurpose === "EVAL";
    if (!replyDraft && !evalDraft) throw new Error("AI_DRAFT_REPLY_STATE_MISMATCH");
  }

  const messages = Array.isArray(raw.messages) ? raw.messages.map(normalizedMessage) : [];
  const sellerReplies = Array.isArray(raw.seller_replies) ? raw.seller_replies.map(normalizedMessage) : [];
  const sourceUrl = safeMarketplaceUrl(raw.source_url);
  const sourceUrlKind = safeText(raw.source_url_kind, 20).toUpperCase() || (sourceUrl ? "LIST" : "UNAVAILABLE");
  if (!["EXACT", "LIST", "UNAVAILABLE"].includes(sourceUrlKind)) throw new Error("SOURCE_URL_KIND_INVALID");
  if (sourceUrlKind === "EXACT" && !sourceUrl) throw new Error("SOURCE_URL_EXACT_REQUIRED");
  if (sourceUrlKind === "UNAVAILABLE" && sourceUrl) throw new Error("SOURCE_URL_UNAVAILABLE_MISMATCH");
  const sourceReference = safeText(raw.source_reference, 500);
  assertMaskedReviewText(sourceReference);
  return {
    market: safeText(raw.market, 50), channel: safeText(raw.channel, 100), source_key: sourceKey,
    occurred_at: safeText(raw.occurred_at, 50), status: safeText(raw.status, 100), category: safeText(raw.category, 300),
    customer_masked: customerMasked, subject: safeText(raw.subject, 2000), preview: safeText(raw.preview, 2000),
    product_id: safeText(raw.product_id, 300), product_name: safeText(raw.product_name, 2000),
    source_url: sourceUrl, source_url_kind: sourceUrlKind, source_reference: sourceReference,
    product_url: safeMarketplaceUrl(raw.product_url), product_thumbnail_url: safeMarketplaceUrl(raw.product_thumbnail_url),
    order_no_masked: safeText(raw.order_no_masked, 300), product_order_no_masked: safeText(raw.product_order_no_masked, 300),
    messages, seller_replies: sellerReplies, last_actor: safeText(raw.last_actor, 20), reply_state: replyState,
    ai_draft: draftText, ai_draft_origin: safeText(raw.ai_draft_origin, 20).toUpperCase(), ai_draft_purpose: draftPurpose,
    ai_draft_required_checks: safeText(raw.ai_draft_required_checks, 2000), ai_draft_pii_scan: safeText(raw.ai_draft_pii_scan, 20).toUpperCase(),
    pii_scan: "PASS", content_hash: contentHash, change_state: safeText(raw.change_state, 30).toUpperCase(),
  };
}

export function normalizeSyncRequest(input: unknown) {
  const raw = plainObject(input, "INVALID_SYNC_REQUEST");
  assertOnlyKeys(raw, ALLOWED_SYNC_KEYS, "SYNC_PARAM_NOT_ALLOWED");
  if (raw.action !== "syncRun") throw new Error("UNKNOWN_WRITE_ACTION");
  const report = plainObject(raw.report, "INVALID_REPORT");
  assertOnlyKeys(report, ALLOWED_REPORT_KEYS, "REPORT_PARAM_NOT_ALLOWED");
  if (Number(report.schema_version) !== 1) throw new Error("INVALID_REPORT_SCHEMA");
  const summary = plainObject(report.summary ?? {}, "INVALID_REPORT_SUMMARY");
  if (Number(summary.marketplace_write_actions ?? 0) !== 0) throw new Error("MARKETPLACE_WRITE_ACTIONS_NOT_ALLOWED");
  const records = Array.isArray(report.records) ? report.records : [];
  if (records.length > 2000) throw new Error("SYNC_BATCH_TOO_LARGE");
  const normalizedRecords = records.map(normalizedRecord);
  if (new Set(normalizedRecords.map((record) => record.source_key)).size !== normalizedRecords.length) throw new Error("DUPLICATE_SOURCE_KEY");
  return {
    action: "syncRun" as const,
    run_id: safeText(raw.run_id, 300),
    model: safeText(raw.model, 100),
    prompt_version: safeText(raw.prompt_version, 100),
    report: {
      schema_version: 1,
      mode: safeText(report.mode, 50),
      range: report.range,
      collected_at: safeText(report.collected_at, 50),
      duration_ms: Math.max(0, Number(report.duration_ms) || 0),
      summary,
      channels: report.channels,
      records: normalizedRecords,
    },
  };
}
