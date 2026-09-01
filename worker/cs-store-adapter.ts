import { CsApiError, type CaseListQuery, type CsStore, type JsonObject, type ReviewDraftInput, type ReviewLibraryInput, type SyncRunInput as ApiSyncRunInput, type UpsertDraftInput, type UpsertTemplateInput } from "./cs-api.ts";
import type { CsDataRepository } from "./cs-data/repository.ts";
import type { Actor, AnswerLibraryEntryInput, AnswerLibrarySourceType, CaseSummaryInput, CsCaseInput, CsMessageInput, DraftDecisionInput, DraftInput, DraftReviewInput, LibraryEntryReviewInput, NoReplyPatternInput, ReplyState, ReplyTemplateInput, SyncRunInput } from "./cs-data/types.ts";

type RepositoryPort = Pick<CsDataRepository, "health" | "overview" | "listCases" | "getCase" | "listTemplates" | "listLibraryEntries" | "syncRun" | "upsertDraft" | "upsertTemplate" | "upsertLibraryEntry" | "reviewLibraryEntry" | "reviewReplyDraft">;

const CHANNELS: Record<string, { market: string; channel: string; ui_type: "CHAT" | "POST" }> = {
  smartstore_comments: { market: "SMARTSTORE", channel: "문의 관리", ui_type: "POST" },
  smartstore_customer_qna: { market: "SMARTSTORE", channel: "고객문의 관리", ui_type: "POST" },
  smartstore_customer_center: { market: "SMARTSTORE", channel: "고객센터 문의 관리", ui_type: "POST" },
  smartstore_talktalk: { market: "SMARTSTORE", channel: "톡톡 상담", ui_type: "CHAT" },
  zigzag_order_inquiry: { market: "ZIGZAG", channel: "주문 문의", ui_type: "POST" },
  zigzag_item_question: { market: "ZIGZAG", channel: "상품 문의", ui_type: "POST" },
  ably_inquiry: { market: "ABLY", channel: "문의 관리", ui_type: "CHAT" },
};

const SAFE_URL_SUFFIXES = ["naver.com", "pstatic.net", "kakaostyle.com", "kakaocdn.net", "a-bly.com"];
const SECRET_URL_KEYS = ["token", "secret", "session", "cookie", "auth", "password", "credential", "signature", "jwt", "apikey", "accesskey", "refreshtoken"];
const ACTORS = new Set<Actor>(["CUSTOMER", "SELLER", "AUTOMATIC", "SYSTEM", "UNKNOWN"]);
const REPLY_STATES = new Set<ReplyState>(["NEEDS_REPLY", "ANSWERED", "REVIEW", "NO_REPLY", "NO_REPLY_REQUIRED", "CLOSED"]);

function object(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CsApiError(code, 400);
  return value as JsonObject;
}

function text(value: unknown, maximum = 20_000): string {
  return String(value ?? "").trim().slice(0, maximum);
}

function rows(value: unknown, maximum: number, code: string): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new CsApiError(code, 400);
  return value.map((item) => object(item, code));
}

function stableToken(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

function actorFor(message: JsonObject): Actor {
  const raw = text(message.actor || message.direction, 20).toUpperCase();
  const normalized = raw === "CUSTOMER" || raw === "INBOUND" ? "CUSTOMER"
    : raw === "SELLER" || raw === "OUTBOUND" ? "SELLER"
      : raw === "AUTOMATIC" || raw === "BOT" ? "AUTOMATIC"
        : raw === "SYSTEM" ? "SYSTEM" : "UNKNOWN";
  return ACTORS.has(normalized) ? normalized : "UNKNOWN";
}

function channelFor(record: JsonObject): { market: string; channel: string; ui_type: "CHAT" | "POST" } {
  const market = text(record.market, 50).toLowerCase();
  const channel = text(record.channel, 100).toLowerCase();
  const known = CHANNELS[`${market}_${channel}`];
  if (known) return known;
  throw new CsApiError("UNKNOWN_CHANNEL", 400);
}

function safeUrl(value: unknown): string {
  const raw = text(value, 3_000);
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new CsApiError("MARKETPLACE_URL_INVALID", 400); }
  if (url.protocol !== "https:" || url.username || url.password) throw new CsApiError("MARKETPLACE_URL_UNSAFE", 400);
  const host = url.hostname.toLowerCase();
  if (!SAFE_URL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) throw new CsApiError("MARKETPLACE_URL_HOST_NOT_ALLOWED", 400);
  const encoded = `${url.search}${url.hash}`.toLowerCase().replace(/[^a-z0-9=&]/g, "");
  if (SECRET_URL_KEYS.some((part) => encoded.includes(part))) throw new CsApiError("MARKETPLACE_URL_SECRET_PARAM", 400);
  return url.toString();
}

function assertMaskedRecord(record: JsonObject): void {
  const customer = text(record.customer_masked, 500);
  if (customer && !customer.includes("*")) throw new CsApiError("CUSTOMER_NOT_MASKED", 400);
  for (const key of ["order_no_masked", "product_order_no_masked"]) {
    if (/^\d{10,}$/.test(text(record[key], 300))) throw new CsApiError("UNMASKED_LONG_NUMBER", 400);
  }
  if (text(record.pii_scan, 20).toUpperCase() !== "PASS") throw new CsApiError("PII_SCAN_PASS_REQUIRED", 400);
}

function assertNoPlainContact(value: string): void {
  if (/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/.test(value)) throw new CsApiError("UNMASKED_PHONE", 400);
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) throw new CsApiError("UNMASKED_EMAIL", 400);
}

function messageInputs(record: JsonObject, caseKey: string): CsMessageInput[] {
  const raw = rows(record.messages, 2_000, "INVALID_MESSAGES");
  return raw.map((message, index) => {
    const sequence = Number.isInteger(Number(message.sequence)) && Number(message.sequence) > 0 ? Number(message.sequence) : index + 1;
    const actor = actorFor(message);
    const messageText = text(message.text, 8_000);
    const sentAt = text(message.at, 50);
    const imageCount = Math.max(0, Math.min(Number(message.image_count) || 0, 100));
    const contentHash = stableToken(`${actor}|${sentAt}|${messageText}|${imageCount}`);
    const sourceMessageId = text(message.source_message_id, 300);
    return {
      message_key: `MSG:${stableToken(caseKey)}:${sourceMessageId ? stableToken(sourceMessageId) : `${sequence}:${contentHash}`}`,
      case_key: caseKey,
      sequence,
      actor,
      text_masked: messageText,
      sent_at: sentAt,
      has_image: imageCount > 0,
      image_count: imageCount,
      content_hash: contentHash,
    };
  });
}

function publicCase(item: Record<string, unknown>): JsonObject {
  return {
    ...item,
    subject: item.subject_masked ?? "",
    preview: item.preview_masked ?? "",
    product_name: item.product_name_masked ?? "",
    category: item.category_masked ?? "",
    source_reference: item.source_reference_masked ?? "",
  };
}

function publicDetail(
  detail: NonNullable<Awaited<ReturnType<RepositoryPort["getCase"]>>>,
  templates: Record<string, unknown>[] = [],
  libraryEntries: Record<string, unknown>[] = [],
): JsonObject {
  return {
    ok: true,
    case: publicCase(detail.case),
    messages: detail.messages.map((message) => ({ ...message, message_text_masked: message.text_masked ?? "" })),
    drafts: detail.drafts.map((draft) => ({ ...draft, draft_text: draft.draft_text_masked ?? "", draft_state: draft.state ?? "" })),
    decisions: detail.decisions,
    review_events: detail.review_events,
    summary: detail.summary ?? null,
    templates: templates.map((item) => ({
      ...item,
      id: item.template_id,
      title: item.template_name_masked,
      text: item.template_text_masked,
      version: item.template_version,
      variables: item.required_checks_json,
    })),
    library_examples: libraryEntries.slice(0, 3).map((item) => ({
      ...item,
      id: item.library_entry_id,
      title: item.intent || "검증된 과거 답변",
      text: item.answer_text_masked,
      version: item.source_version,
    })),
    human_reply_source: "MARKETPLACE_ONLY",
  };
}

function draftFromRecord(record: JsonObject, messages: CsMessageInput[], runId: string, createdAt: string): DraftInput | null {
  const draftText = text(record.ai_draft, 20_000);
  if (!draftText) return null;
  if (text(record.ai_draft_origin, 20).toUpperCase() !== "AI" || text(record.ai_draft_pii_scan, 20).toUpperCase() !== "PASS") {
    throw new CsApiError("AI_DRAFT_SAFETY_REQUIRED", 400);
  }
  const purpose = text(record.ai_draft_purpose, 20).toUpperCase();
  const replyState = text(record.reply_state, 30).toUpperCase();
  if (!((purpose === "REPLY" && replyState === "NEEDS_REPLY") || (purpose === "EVAL" && replyState === "ANSWERED"))) {
    throw new CsApiError("AI_DRAFT_REPLY_STATE_MISMATCH", 400);
  }
  const customer = [...messages].reverse().find((message) => message.actor === "CUSTOMER");
  const seller = [...messages].reverse().find((message) => message.actor === "SELLER");
  if (!customer) throw new CsApiError("DRAFT_CUSTOMER_MESSAGE_REQUIRED", 400);
  if (purpose === "EVAL" && !seller) throw new CsApiError("EVAL_SELLER_MESSAGE_REQUIRED", 400);
  const caseKey = text(record.source_key, 300);
  const sourceHash = text(record.content_hash, 128);
  const generationVersion = "worker-v1";
  return {
    draft_id: `DRAFT:${stableToken(`${caseKey}|${purpose}|${sourceHash}|${generationVersion}`)}`,
    case_key: caseKey,
    purpose: purpose as "REPLY" | "EVAL",
    state: "READY",
    draft_text_masked: draftText,
    intent: text(record.intent, 100),
    required_checks: text(record.ai_draft_required_checks, 20_000),
    reference_ids: rows(record.ai_draft_references, 3, "INVALID_REFERENCE_IDS").map((value) => text(value.id, 300)).filter(Boolean),
    source_content_hash: sourceHash,
    source_customer_message_key: customer.message_key,
    source_seller_message_key: purpose === "EVAL" ? seller?.message_key ?? null : null,
    generation_version: generationVersion,
    created_at: createdAt,
    created_run_id: runId,
  };
}

function repositoryInput(input: ApiSyncRunInput): SyncRunInput {
  const report = object(input.report, "INVALID_REPORT");
  if (Number(report.schema_version) !== 1) throw new CsApiError("INVALID_REPORT_SCHEMA", 400);
  const summary = object(report.summary ?? {}, "INVALID_REPORT_SUMMARY");
  if (Number(summary.marketplace_write_actions ?? 0) !== 0) throw new CsApiError("MARKETPLACE_WRITE_ACTIONS_FORBIDDEN", 400);
  const records = rows(report.records, 2_000, "INVALID_RECORDS");
  const collectedAt = text(report.collected_at, 50) || new Date().toISOString();
  const seen = new Set<string>();
  const cases: CsCaseInput[] = [];
  const messages: CsMessageInput[] = [];
  const drafts: DraftInput[] = [];
  for (const record of records) {
    assertMaskedRecord(record);
    const caseKey = text(record.source_key, 300);
    const contentHash = text(record.content_hash, 128);
    if (!caseKey || !contentHash) throw new CsApiError("CASE_IDENTITY_REQUIRED", 400);
    if (seen.has(caseKey)) throw new CsApiError("DUPLICATE_SOURCE_KEY", 400);
    seen.add(caseKey);
    const channel = channelFor(record);
    const caseMessages = messageInputs(record, caseKey);
    const replyState = text(record.reply_state, 30).toUpperCase() as ReplyState;
    if (!REPLY_STATES.has(replyState)) throw new CsApiError("INVALID_REPLY_STATE", 400);
    const changeState = text(record.change_state, 30).toUpperCase();
    const processingState = replyState === "REVIEW" ? "REVIEW" : changeState === "NEW" || changeState === "CHANGED" || changeState === "UNCHANGED" ? changeState : "REVIEW";
    const lastActor = caseMessages.at(-1)?.actor ?? (ACTORS.has(text(record.last_actor, 20).toUpperCase() as Actor) ? text(record.last_actor, 20).toUpperCase() as Actor : "UNKNOWN");
    const explicitComplete = typeof record.conversation_complete === "boolean" ? record.conversation_complete : channel.ui_type === "POST";
    const incompleteReason = explicitComplete ? "" : text(record.conversation_incomplete_reason, 500) || "COMPLETENESS_NOT_REPORTED";
    const sourceUrl = safeUrl(record.source_url);
    const sourceUrlKindRaw = text(record.source_url_kind, 20).toUpperCase() || (sourceUrl ? "LIST" : "UNAVAILABLE");
    if (!new Set(["EXACT", "LIST", "UNAVAILABLE"]).has(sourceUrlKindRaw)) throw new CsApiError("INVALID_SOURCE_URL_KIND", 400);
    if ((sourceUrlKindRaw === "UNAVAILABLE") !== !sourceUrl) throw new CsApiError("SOURCE_URL_KIND_MISMATCH", 400);
    const imageCount = caseMessages.reduce((total, message) => total + message.image_count, 0);
    cases.push({
      case_key: caseKey, market: channel.market, channel: channel.channel, ui_type: channel.ui_type,
      occurred_at: text(record.occurred_at, 50), source_status: text(record.status, 100), category_masked: text(record.category, 300),
      customer_masked: text(record.customer_masked, 500) || "***", subject_masked: text(record.subject, 2_000),
      preview_masked: text(record.preview, 8_000), product_id: text(record.product_id, 300), product_name_masked: text(record.product_name, 2_000),
      order_no_masked: text(record.order_no_masked, 300), product_order_no_masked: text(record.product_order_no_masked, 300),
      source_url: sourceUrl, source_url_kind: sourceUrlKindRaw as "EXACT" | "LIST" | "UNAVAILABLE",
      source_reference_masked: text(record.source_reference, 500), product_url: safeUrl(record.product_url),
      product_thumbnail_url: safeUrl(record.product_thumbnail_url), reply_state: replyState,
      processing_state: processingState, last_actor: lastActor,
      last_message_at: caseMessages.at(-1)?.sent_at || text(record.occurred_at, 50) || collectedAt,
      message_count: caseMessages.length, image_count: imageCount, conversation_complete: explicitComplete,
      conversation_incomplete_reason: incompleteReason, content_hash: contentHash,
      first_seen_at: collectedAt, last_seen_at: collectedAt,
    });
    messages.push(...caseMessages);
    if (!explicitComplete && text(record.ai_draft, 20_000)) {
      throw new CsApiError("CONVERSATION_INCOMPLETE_DRAFT_FORBIDDEN", 400);
    }
    const draft = draftFromRecord(record, caseMessages, input.run_id, collectedAt);
    if (draft) drafts.push(draft);
  }
  const decisionKeys = new Set<string>();
  const decisions: DraftDecisionInput[] = rows(report.draft_decisions, 4_000, "INVALID_DRAFT_DECISIONS").map((decision) => {
    const caseKey = text(decision.source_key, 300);
    if (decisionKeys.has(caseKey)) throw new CsApiError("DUPLICATE_DRAFT_DECISION", 400);
    decisionKeys.add(caseKey);
    const caseRow = cases.find((item) => item.case_key === caseKey);
    if (!caseRow) throw new CsApiError("DRAFT_DECISION_CASE_NOT_FOUND", 400);
    const purpose = text(decision.purpose, 20).toUpperCase();
    if (!new Set(["REPLY", "EVAL"]).has(purpose)) throw new CsApiError("DRAFT_DECISION_PURPOSE_INVALID", 400);
    const action = text(decision.decision, 20).toUpperCase();
    if (action !== "GENERATE" && action !== "SKIP") throw new CsApiError("DRAFT_DECISION_INVALID", 400);
    const reasonCode = text(decision.reason_code, 100).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(reasonCode)) throw new CsApiError("DRAFT_DECISION_REASON_INVALID", 400);
    const sourceHash = text(decision.source_content_hash, 128);
    if (sourceHash !== caseRow.content_hash) throw new CsApiError("DRAFT_DECISION_CONTENT_HASH_MISMATCH", 400);
    const rawChecks = decision.required_checks;
    if (rawChecks !== undefined && (!Array.isArray(rawChecks) || rawChecks.length > 20 || rawChecks.some((item) => typeof item !== "string" || item.length > 500))) {
      throw new CsApiError("DRAFT_DECISION_CHECKS_INVALID", 400);
    }
    for (const check of (rawChecks as string[] | undefined) ?? []) assertNoPlainContact(check);
    const draft = drafts.find((item) => item.case_key === caseKey && item.purpose === purpose);
    if (action === "GENERATE" && !draft) throw new CsApiError("DRAFT_DECISION_GENERATED_DRAFT_REQUIRED", 400);
    return {
      decision_id: `DECISION:${stableToken(`${input.run_id}|${caseKey}|${purpose}|${sourceHash}`)}`,
      run_id: input.run_id,
      case_key: caseKey,
      purpose: purpose as "REPLY" | "EVAL",
      source_content_hash: sourceHash,
      decision: action,
      reason_code: reasonCode,
      required_checks: (rawChecks as string[] | undefined) ?? [],
      draft_id: action === "GENERATE" ? draft?.draft_id ?? null : null,
      created_at: collectedAt,
    };
  });
  const caseByKey = new Map(cases.map((item) => [item.case_key, item] as const));
  const caseSummaries: CaseSummaryInput[] = rows(report.case_summaries, 2_000, "INVALID_CASE_SUMMARIES").map((summaryRow) => {
    const caseKey = text(summaryRow.source_key, 300);
    const caseRow = caseByKey.get(caseKey);
    if (!caseRow) throw new CsApiError("CASE_SUMMARY_CASE_NOT_FOUND", 400);
    const sourceHash = text(summaryRow.source_content_hash, 128);
    if (sourceHash !== caseRow.content_hash) throw new CsApiError("CASE_SUMMARY_CONTENT_HASH_MISMATCH", 400);
    if (text(summaryRow.pii_scan, 20).toUpperCase() !== "PASS") throw new CsApiError("CASE_SUMMARY_PII_SCAN_REQUIRED", 400);
    const summaryText = text(summaryRow.summary_text_masked, 20_000);
    if (!summaryText) throw new CsApiError("CASE_SUMMARY_TEXT_REQUIRED", 400);
    assertNoPlainContact(summaryText);
    return {
      case_key: caseKey,
      summary_text_masked: summaryText,
      summary_version: text(summaryRow.summary_version, 100) || "summary-v1",
      source_content_hash: sourceHash,
      created_run_id: input.run_id,
      created_at: collectedAt,
    };
  });
  const answerLibraryEntries: AnswerLibraryEntryInput[] = rows(report.answer_library_candidates, 2_000, "INVALID_ANSWER_LIBRARY_CANDIDATES").map((candidate) => {
    const caseKey = text(candidate.source_case_key, 300);
    const caseRow = caseByKey.get(caseKey);
    if (!caseRow) throw new CsApiError("ANSWER_LIBRARY_CASE_NOT_FOUND", 400);
    if (caseRow.reply_state !== "ANSWERED" && caseRow.reply_state !== "CLOSED") throw new CsApiError("ANSWER_LIBRARY_REPLY_STATE_INVALID", 400);
    const sourceHash = text(candidate.source_content_hash, 128);
    if (sourceHash !== caseRow.content_hash) throw new CsApiError("ANSWER_LIBRARY_CONTENT_HASH_MISMATCH", 400);
    if (text(candidate.candidate_state, 20).toUpperCase() !== "CANDIDATE" || text(candidate.source_type, 50).toUpperCase() !== "ACTUAL_SELLER_REPLY") {
      throw new CsApiError("ANSWER_LIBRARY_CANDIDATE_INVALID", 400);
    }
    const question = text(candidate.customer_question_masked, 20_000);
    const answer = text(candidate.human_answer_masked, 20_000);
    if (!question || !answer) throw new CsApiError("ANSWER_LIBRARY_TEXT_REQUIRED", 400);
    assertNoPlainContact(question); assertNoPlainContact(answer);
    const candidateId = text(candidate.candidate_id, 300);
    const sourceId = text(candidate.seller_message_key, 300);
    if (!candidateId || !sourceId) throw new CsApiError("ANSWER_LIBRARY_IDENTITY_REQUIRED", 400);
    return {
      library_entry_id: candidateId,
      case_key: caseKey,
      source_type: "ACTUAL_SELLER_REPLY",
      source_id: sourceId,
      source_version: text(candidate.seller_message_hash, 128) || sourceHash,
      question_text_masked: question,
      answer_text_masked: answer,
      market: caseRow.market,
      channel: caseRow.channel,
      intent: text(candidate.category, 100),
      quality_state: "CANDIDATE",
      source_content_hash: sourceHash,
      created_run_id: input.run_id,
      created_at: collectedAt,
    };
  });
  const noReplyPatterns: NoReplyPatternInput[] = rows(report.no_reply_pattern_candidates, 2_000, "INVALID_NO_REPLY_PATTERN_CANDIDATES").map((candidate) => {
    const caseKey = text(candidate.source_case_key, 300);
    const caseRow = caseByKey.get(caseKey);
    if (!caseRow) throw new CsApiError("NO_REPLY_PATTERN_CASE_NOT_FOUND", 400);
    if (caseRow.reply_state !== "NO_REPLY" && caseRow.reply_state !== "NO_REPLY_REQUIRED") throw new CsApiError("NO_REPLY_PATTERN_REPLY_STATE_INVALID", 400);
    const sourceHash = text(candidate.source_content_hash, 128);
    if (sourceHash !== caseRow.content_hash) throw new CsApiError("NO_REPLY_PATTERN_CONTENT_HASH_MISMATCH", 400);
    if (text(candidate.candidate_state, 20).toUpperCase() !== "CANDIDATE" || text(candidate.reply_state, 30).toUpperCase() !== "NO_REPLY_REQUIRED") {
      throw new CsApiError("NO_REPLY_PATTERN_CANDIDATE_INVALID", 400);
    }
    const patternText = text(candidate.customer_question_masked, 20_000);
    if (!patternText) throw new CsApiError("NO_REPLY_PATTERN_TEXT_REQUIRED", 400);
    assertNoPlainContact(patternText);
    const candidateId = text(candidate.candidate_id, 300);
    if (!candidateId) throw new CsApiError("NO_REPLY_PATTERN_IDENTITY_REQUIRED", 400);
    return {
      pattern_id: candidateId,
      case_key: caseKey,
      pattern_text_masked: patternText,
      reason_code: "NO_REPLY_REQUIRED",
      quality_state: "CANDIDATE",
      source_content_hash: sourceHash,
      created_run_id: input.run_id,
      created_at: collectedAt,
    };
  });
  return {
    run_id: input.run_id, environment: "development", mode: "READ_ONLY",
    started_at: collectedAt, finished_at: collectedAt, cases, messages, drafts, decisions,
    case_summaries: caseSummaries, answer_library_entries: answerLibraryEntries, no_reply_patterns: noReplyPatterns,
  };
}

export class CsStoreAdapter implements CsStore {
  private readonly repository: RepositoryPort;
  private readonly now: () => string;

  constructor(repository: RepositoryPort, now: () => string = () => new Date().toISOString()) {
    this.repository = repository;
    this.now = now;
  }

  async health(): Promise<JsonObject> { return { ...(await this.repository.health()) }; }
  async overview(): Promise<JsonObject> { return { ok: true, ...(await this.repository.overview()) }; }
  async listCases(query: CaseListQuery): Promise<JsonObject> {
    const result = await this.repository.listCases({ limit: query.limit, cursor: query.cursor ?? 0, filters: query.filters });
    return { ok: true, ...result, items: result.items.map((item) => publicCase(item as unknown as Record<string, unknown>)) };
  }
  async getCase(caseKey: string): Promise<JsonObject | null> {
    const [detail, templates, libraryEntries] = await Promise.all([
      this.repository.getCase(caseKey),
      this.repository.listTemplates("USE"),
      this.repository.listLibraryEntries("USE"),
    ]);
    return detail ? publicDetail(detail, templates, libraryEntries) : null;
  }
  async listTemplates(qualityState?: "CANDIDATE" | "USE" | "EXCLUDE"): Promise<JsonObject> {
    return { ok: true, items: await this.repository.listTemplates(qualityState) };
  }
  async listLibraryEntries(qualityState?: "CANDIDATE" | "USE" | "EXCLUDE"): Promise<JsonObject> {
    return { ok: true, items: await this.repository.listLibraryEntries(qualityState) };
  }
  async syncRun(input: ApiSyncRunInput): Promise<JsonObject> { return { ok: true, ...(await this.repository.syncRun(repositoryInput(input))) }; }

  async upsertDraft(input: UpsertDraftInput): Promise<JsonObject> {
    const detail = await this.repository.getCase(input.case_key);
    if (!detail) throw new CsApiError("CASE_NOT_FOUND", 404);
    const caseRow = detail.case;
    if (text(caseRow.content_hash, 128) !== input.source_content_hash) throw new CsApiError("SOURCE_CONTENT_HASH_STALE", 409);
    if (Number(caseRow.conversation_complete) !== 1) throw new CsApiError("CONVERSATION_INCOMPLETE_DRAFT_FORBIDDEN", 409);
    const messages = detail.messages as Array<Record<string, unknown>>;
    const customer = [...messages].reverse().find((message) => message.actor === "CUSTOMER");
    const seller = [...messages].reverse().find((message) => message.actor === "SELLER");
    if (!customer) throw new CsApiError("DRAFT_CUSTOMER_MESSAGE_REQUIRED", 409);
    if (input.purpose === "EVAL" && !seller) throw new CsApiError("EVAL_SELLER_MESSAGE_REQUIRED", 409);
    const replyState = text(caseRow.reply_state, 30);
    if (!((input.purpose === "REPLY" && replyState === "NEEDS_REPLY") || (input.purpose === "EVAL" && replyState === "ANSWERED"))) {
      throw new CsApiError("AI_DRAFT_REPLY_STATE_MISMATCH", 409);
    }
    const generation = input.generation_version || "worker-v1";
    const createdAt = this.now();
    const draft: DraftInput = {
      draft_id: `DRAFT:${stableToken(`${input.case_key}|${input.purpose}|${input.source_content_hash}|${generation}`)}`,
      case_key: input.case_key, purpose: input.purpose, state: "READY", draft_text_masked: input.draft_text,
      intent: input.intent ?? "", required_checks: input.required_checks ?? "", reference_ids: input.reference_ids ?? [],
      source_content_hash: input.source_content_hash, source_customer_message_key: text(customer.message_key, 300),
      source_seller_message_key: input.purpose === "EVAL" ? text(seller?.message_key, 300) : null,
      generation_version: generation, created_at: createdAt, created_run_id: text(caseRow.last_sync_run_id, 300),
    };
    return { ok: true, draft_id: draft.draft_id, purpose: draft.purpose, ...(await this.repository.upsertDraft(draft)) };
  }

  async upsertTemplate(input: UpsertTemplateInput): Promise<JsonObject> {
    assertNoPlainContact(input.template_name); assertNoPlainContact(input.template_text);
    for (const check of input.required_checks ?? []) assertNoPlainContact(check);
    const createdAt = this.now();
    const template: ReplyTemplateInput = {
      template_id: `TEMPLATE:${stableToken(`${input.template_key}|${input.template_version}`)}`,
      template_key: input.template_key,
      template_version: input.template_version,
      template_name_masked: input.template_name,
      template_text_masked: input.template_text,
      market: input.market ?? null,
      channel: input.channel ?? null,
      intent: input.intent ?? null,
      required_checks: input.required_checks ?? [],
      quality_state: input.quality_state ?? "CANDIDATE",
      created_at: createdAt,
    };
    return { ok: true, template_id: template.template_id, ...(await this.repository.upsertTemplate(template)) };
  }

  async reviewLibraryEntry(entryId: string, input: ReviewLibraryInput): Promise<JsonObject> {
    const review: LibraryEntryReviewInput = {
      library_entry_id: entryId,
      quality_state: input.quality_state,
      review_note_masked: input.review_note ?? "",
      reviewer_ref: "development-reviewer",
      reviewed_at: this.now(),
    };
    const result = await this.repository.reviewLibraryEntry(review);
    if (!result.reviewed) throw new CsApiError("LIBRARY_ENTRY_NOT_FOUND", 404);
    return { ok: true, ...result };
  }

  async reviewReplyDraft(draftId: string, input: ReviewDraftInput): Promise<JsonObject> {
    const reviewedAt = this.now();
    const review: DraftReviewInput = {
      draft_id: draftId, draft_state: input.draft_state,
      review_note_masked: input.review_note ?? "", human_revision_masked: input.human_revision ?? "",
      reviewed_at: reviewedAt, reviewer_ref: "development-reviewer",
      composition_source_type: input.composition_source_type ?? "MANUAL",
      composition_source_id: input.composition_source_id ?? null,
      composition_source_version: input.composition_source_version ?? null,
      base_text_hash: input.base_text_hash ?? null,
      final_text_hash: input.final_text_hash ?? null,
      unresolved_variables: input.unresolved_variables ?? [],
      source_content_hash: input.source_content_hash ?? null,
    };
    try {
      const result = await this.repository.reviewReplyDraft(review);
      let libraryCandidateId: string | null = null;
      if (input.draft_state === "APPROVED" && input.human_revision) {
        const detail = await this.repository.getCase(result.case_key);
        if (!detail) throw new CsApiError("CASE_NOT_FOUND", 404);
        const customer = [...detail.messages].reverse().find((message) => text(message.actor, 20) === "CUSTOMER" && text(message.text_masked, 20_000));
        if (!customer) throw new CsApiError("DRAFT_CUSTOMER_MESSAGE_REQUIRED", 409);
        const question = text(customer.text_masked, 20_000);
        const answer = input.human_revision;
        assertNoPlainContact(question); assertNoPlainContact(answer);
        const sourceType: AnswerLibrarySourceType = input.composition_source_type === "REPLY_TEMPLATE" ? "REVIEWED_TEMPLATE_REVISION"
          : input.composition_source_type === "AI_DRAFT" ? "REVIEWED_AI_REVISION" : "MANUAL_REVIEW_REPLY";
        const sourceId = input.composition_source_id || draftId;
        const sourceVersion = input.composition_source_version || input.final_text_hash || stableToken(answer);
        libraryCandidateId = `ANSWER:${stableToken(`${sourceType}|${sourceId}|${sourceVersion}|${result.case_key}`)}`;
        const entry: AnswerLibraryEntryInput = {
          library_entry_id: libraryCandidateId,
          case_key: result.case_key,
          source_type: sourceType,
          source_id: sourceId,
          source_version: sourceVersion,
          question_text_masked: question,
          answer_text_masked: answer,
          market: text(detail.case.market, 50),
          channel: text(detail.case.channel, 100),
          intent: text(detail.drafts.find((item) => text(item.draft_id, 300) === draftId)?.intent, 100),
          quality_state: "CANDIDATE",
          source_content_hash: text(detail.case.content_hash, 128),
          created_run_id: text(detail.case.last_sync_run_id, 300),
          created_at: reviewedAt,
        };
        await this.repository.upsertLibraryEntry(entry);
      }
      return { ok: true, ...result, library_candidate_id: libraryCandidateId };
    }
    catch (error) {
      if (error instanceof Error && error.message === "REPLY_DRAFT_NOT_FOUND") throw new CsApiError("EVAL_REVIEW_FORBIDDEN_OR_NOT_FOUND", 409);
      if (error instanceof Error && error.message === "SOURCE_CONTENT_HASH_STALE") throw new CsApiError("SOURCE_CONTENT_HASH_STALE", 409);
      throw error;
    }
  }
}
