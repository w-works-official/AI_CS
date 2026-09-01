/**
 * Narrow, review-only HTTP boundary for the local D1 CS store.
 *
 * This module intentionally has no Worker binding or network dependency.  A
 * Worker entrypoint injects a CsStore implementation; the router cannot send
 * marketplace messages, proxy arbitrary URLs, or mutate marketplace state.
 */

export type JsonObject = Record<string, unknown>;
export type CsStoreResult = JsonObject;

export type CaseListQuery = {
  limit: number;
  cursor: number | null;
  filters: {
    market?: "SMARTSTORE" | "ZIGZAG" | "ABLY";
    channel?: string;
    ui_type?: "CHAT" | "POST";
    reply_state?: "NEEDS_REPLY" | "ANSWERED" | "NO_REPLY" | "NO_REPLY_REQUIRED" | "REVIEW" | "CLOSED";
    ai_draft_state?: "NONE" | "READY" | "APPROVED" | "REJECTED" | "USED";
  };
};

export type SyncRunInput = {
  run_id: string;
  report: JsonObject;
  model?: string;
  prompt_version?: string;
  environment: "development";
  auto_send: false;
  marketplace_write_actions: 0;
};

export type UpsertDraftInput = {
  case_key: string;
  purpose: "REPLY" | "EVAL";
  draft_text: string;
  intent?: string;
  reference_ids?: string[];
  required_checks?: string;
  generation_version?: string;
  source_content_hash: string;
  environment: "development";
  auto_send: false;
  marketplace_write_actions: 0;
};

export type ReviewDraftInput = {
  draft_state: "APPROVED" | "REJECTED";
  review_note?: string;
  human_revision?: string;
  /**
   * When supplied it must be REPLY.  The store MUST also read the persisted
   * draft and reject an EVAL draft with EVAL_REVIEW_FORBIDDEN.
   */
  purpose?: "REPLY";
  composition_source_type?: "AI_DRAFT" | "REPLY_TEMPLATE" | "ANSWER_LIBRARY_ENTRY" | "MANUAL";
  composition_source_id?: string;
  composition_source_version?: string;
  base_text_hash?: string;
  final_text_hash?: string;
  unresolved_variables?: string[];
  source_content_hash?: string;
  environment: "development";
  auto_send: false;
  marketplace_write_actions: 0;
};

export type UpsertTemplateInput = {
  template_key: string; template_version: string; template_name: string; template_text: string;
  market?: string; channel?: string; intent?: string; required_checks?: string[];
  quality_state?: "CANDIDATE" | "USE" | "EXCLUDE";
  environment: "development"; auto_send: false; marketplace_write_actions: 0;
};

export type ReviewLibraryInput = {
  quality_state: "USE" | "EXCLUDE"; review_note?: string;
  environment: "development"; auto_send: false; marketplace_write_actions: 0;
};

export interface CsStore {
  health(): Promise<CsStoreResult>;
  overview(): Promise<CsStoreResult>;
  listCases(query: CaseListQuery): Promise<CsStoreResult>;
  getCase(caseKey: string): Promise<CsStoreResult | null>;
  listTemplates(qualityState?: "CANDIDATE" | "USE" | "EXCLUDE"): Promise<CsStoreResult>;
  listLibraryEntries(qualityState?: "CANDIDATE" | "USE" | "EXCLUDE"): Promise<CsStoreResult>;
  syncRun(input: SyncRunInput): Promise<CsStoreResult>;
  upsertDraft(input: UpsertDraftInput): Promise<CsStoreResult>;
  upsertTemplate(input: UpsertTemplateInput): Promise<CsStoreResult>;
  reviewLibraryEntry(entryId: string, input: ReviewLibraryInput): Promise<CsStoreResult>;
  /** Implementations must reject persisted EVAL drafts with EVAL_REVIEW_FORBIDDEN. */
  reviewReplyDraft(draftId: string, input: ReviewDraftInput): Promise<CsStoreResult>;
}

export type CsApiOptions = {
  store: CsStore;
  syncKey: string;
  allowedOrigins?: Iterable<string>;
  maxJsonBytes?: number;
};

export class CsApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_MAX_JSON_BYTES = 512 * 1024;
const safeMethods = new Set(["GET", "POST", "PATCH", "OPTIONS"]);
const rootFields = {
  sync: new Set(["run_id", "report", "model", "prompt_version", "environment", "auto_send", "marketplace_write_actions"]),
  draft: new Set(["case_key", "purpose", "draft_text", "intent", "reference_ids", "required_checks", "generation_version", "source_content_hash", "environment", "auto_send", "marketplace_write_actions"]),
  review: new Set(["draft_state", "review_note", "human_revision", "purpose", "composition_source_type", "composition_source_id", "composition_source_version", "base_text_hash", "final_text_hash", "unresolved_variables", "source_content_hash", "environment", "auto_send", "marketplace_write_actions"]),
  template: new Set(["template_key", "template_version", "template_name", "template_text", "market", "channel", "intent", "required_checks", "quality_state", "environment", "auto_send", "marketplace_write_actions"]),
  libraryReview: new Set(["quality_state", "review_note", "environment", "auto_send", "marketplace_write_actions"]),
};
const forbiddenMutationFields = new Set([
  "action", "marketplace_action", "marketplace_reply", "reply_action", "send", "send_reply", "send_message",
  "complete", "complete_case", "complete_inquiry", "close_case", "order_change", "change_order",
  "cancel_order", "refund", "exchange", "proxy_url", "request_url", "target_url", "endpoint",
]);
const forbiddenSensitiveKeys = new Set(["address", "shipping_address", "customer_address", "account", "account_number", "bank_account"]);
const piiPatterns: Array<[string, RegExp]> = [
  ["RAW_PHONE", /\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/],
  ["RAW_EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["RAW_LONG_NUMBER", /\b\d{10,}\b/],
  ["RAW_ACCOUNT", /(?:계좌|은행|bank\s*account|account\s*(?:no|number))\s*[:：#-]?\s*[0-9][0-9 -]{5,}/i],
  ["RAW_ACCOUNT", /\b\d{2,6}-\d{2,6}-\d{2,8}\b/],
  ["RAW_ADDRESS", /(?:주소|배송지|수령지|우편번호|address)\s*[:：#-]?\s*[^\n]{2,}/i],
];

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownFields(body: JsonObject, allowed: Set<string>): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new CsApiError("UNKNOWN_FIELD", 400);
  }
}

function requireString(value: unknown, code: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new CsApiError(code, 400);
  return value;
}

function requireOptionalString(value: unknown, code: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, code, maximum, 0);
}

function requireDevelopmentSafety(body: JsonObject): void {
  if (body.environment !== "development" || body.auto_send !== false || body.marketplace_write_actions !== 0) {
    throw new CsApiError("DEVELOPMENT_SAFETY_REQUIRED", 400);
  }
}

function inspectPayload(value: unknown, path = "body", depth = 0): void {
  if (depth > 20) throw new CsApiError("JSON_NESTING_TOO_DEEP", 400);
  if (typeof value === "string") {
    const structuralValue = /(?:^|\.)(?:run_id|case_key|draft_id|source_key|source_message_id|content_hash|source_content_hash|product_id|reference_ids|source_url|product_url|product_thumbnail_url)(?:\[\d+\])?$/.test(path);
    for (const [code, pattern] of piiPatterns) {
      if (code === "RAW_LONG_NUMBER" && structuralValue) continue;
      if (pattern.test(value)) throw new CsApiError(`PII_${code}`, 400);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new CsApiError("JSON_ARRAY_TOO_LARGE", 413);
    value.forEach((item, index) => inspectPayload(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (forbiddenMutationFields.has(normalized)) throw new CsApiError("MARKETPLACE_MUTATION_FIELD_FORBIDDEN", 400);
    if (forbiddenSensitiveKeys.has(normalized)) throw new CsApiError("PII_SENSITIVE_FIELD_FORBIDDEN", 400);
    inspectPayload(item, `${path}.${key}`, depth + 1);
  }
}

function parseBooleanFalse(value: unknown): false {
  if (value !== false) throw new CsApiError("AUTO_SEND_MUST_BE_FALSE", 400);
  return false;
}

function parseZero(value: unknown): 0 {
  if (value !== 0) throw new CsApiError("MARKETPLACE_WRITE_ACTIONS_MUST_BE_ZERO", 400);
  return 0;
}

function parseSync(body: JsonObject): SyncRunInput {
  rejectUnknownFields(body, rootFields.sync);
  requireDevelopmentSafety(body);
  if (!isObject(body.report)) throw new CsApiError("REPORT_REQUIRED", 400);
  return {
    run_id: requireString(body.run_id, "INVALID_RUN_ID", 300),
    report: body.report,
    model: requireOptionalString(body.model, "INVALID_MODEL", 100),
    prompt_version: requireOptionalString(body.prompt_version, "INVALID_PROMPT_VERSION", 100),
    environment: "development",
    auto_send: parseBooleanFalse(body.auto_send),
    marketplace_write_actions: parseZero(body.marketplace_write_actions),
  };
}

function parseDraft(body: JsonObject): UpsertDraftInput {
  rejectUnknownFields(body, rootFields.draft);
  requireDevelopmentSafety(body);
  const purpose = body.purpose;
  if (purpose !== "REPLY" && purpose !== "EVAL") throw new CsApiError("INVALID_DRAFT_PURPOSE", 400);
  const references = body.reference_ids;
  if (references !== undefined && (!Array.isArray(references) || references.length > 3 || references.some((id) => typeof id !== "string" || id.length > 300))) {
    throw new CsApiError("INVALID_REFERENCE_IDS", 400);
  }
  return {
    case_key: requireString(body.case_key, "INVALID_CASE_KEY", 300),
    purpose,
    draft_text: requireString(body.draft_text, "INVALID_DRAFT_TEXT", 20_000),
    intent: requireOptionalString(body.intent, "INVALID_INTENT", 100),
    reference_ids: references as string[] | undefined,
    required_checks: requireOptionalString(body.required_checks, "INVALID_REQUIRED_CHECKS", 20_000),
    generation_version: requireOptionalString(body.generation_version, "INVALID_GENERATION_VERSION", 100),
    source_content_hash: requireString(body.source_content_hash, "INVALID_SOURCE_CONTENT_HASH", 128),
    environment: "development",
    auto_send: parseBooleanFalse(body.auto_send),
    marketplace_write_actions: parseZero(body.marketplace_write_actions),
  };
}

function parseReview(body: JsonObject): ReviewDraftInput {
  rejectUnknownFields(body, rootFields.review);
  requireDevelopmentSafety(body);
  if (body.purpose === "EVAL") throw new CsApiError("EVAL_REVIEW_FORBIDDEN", 409);
  if (body.purpose !== undefined && body.purpose !== "REPLY") throw new CsApiError("INVALID_DRAFT_PURPOSE", 400);
  const state = body.draft_state;
  if (state !== "APPROVED" && state !== "REJECTED") throw new CsApiError("INVALID_DRAFT_STATE", 400);
  if (state === "APPROVED" && !body.human_revision) throw new CsApiError("HUMAN_REVISION_REQUIRED", 400);
  const sourceType = body.composition_source_type;
  if (sourceType !== undefined && !["AI_DRAFT", "REPLY_TEMPLATE", "ANSWER_LIBRARY_ENTRY", "MANUAL"].includes(String(sourceType))) {
    throw new CsApiError("INVALID_COMPOSITION_SOURCE_TYPE", 400);
  }
  const unresolved = body.unresolved_variables;
  if (unresolved !== undefined && (!Array.isArray(unresolved) || unresolved.length > 20 || unresolved.some((item) => typeof item !== "string" || item.length > 100))) {
    throw new CsApiError("INVALID_UNRESOLVED_VARIABLES", 400);
  }
  if (state === "APPROVED" && Array.isArray(unresolved) && unresolved.length > 0) throw new CsApiError("UNRESOLVED_TEMPLATE_VARIABLES", 409);
  return {
    draft_state: state,
    review_note: requireOptionalString(body.review_note, "INVALID_REVIEW_NOTE", 1_000),
    human_revision: requireOptionalString(body.human_revision, "INVALID_HUMAN_REVISION", 20_000),
    purpose: body.purpose as "REPLY" | undefined,
    composition_source_type: sourceType as ReviewDraftInput["composition_source_type"],
    composition_source_id: requireOptionalString(body.composition_source_id, "INVALID_COMPOSITION_SOURCE_ID", 300),
    composition_source_version: requireOptionalString(body.composition_source_version, "INVALID_COMPOSITION_SOURCE_VERSION", 100),
    base_text_hash: requireOptionalString(body.base_text_hash, "INVALID_BASE_TEXT_HASH", 128),
    final_text_hash: requireOptionalString(body.final_text_hash, "INVALID_FINAL_TEXT_HASH", 128),
    unresolved_variables: unresolved as string[] | undefined,
    source_content_hash: requireOptionalString(body.source_content_hash, "INVALID_SOURCE_CONTENT_HASH", 128),
    environment: "development",
    auto_send: parseBooleanFalse(body.auto_send),
    marketplace_write_actions: parseZero(body.marketplace_write_actions),
  };
}

function parseQualityState(value: unknown, allowCandidate = true): "CANDIDATE" | "USE" | "EXCLUDE" {
  const state = String(value ?? (allowCandidate ? "CANDIDATE" : "")).toUpperCase();
  const allowed = allowCandidate ? ["CANDIDATE", "USE", "EXCLUDE"] : ["USE", "EXCLUDE"];
  if (!allowed.includes(state)) throw new CsApiError("INVALID_QUALITY_STATE", 400);
  return state as "CANDIDATE" | "USE" | "EXCLUDE";
}

function parseTemplate(body: JsonObject): UpsertTemplateInput {
  rejectUnknownFields(body, rootFields.template);
  requireDevelopmentSafety(body);
  const checks = body.required_checks;
  if (checks !== undefined && (!Array.isArray(checks) || checks.length > 20 || checks.some((item) => typeof item !== "string" || item.length > 500))) {
    throw new CsApiError("INVALID_REQUIRED_CHECKS", 400);
  }
  return {
    template_key: requireString(body.template_key, "INVALID_TEMPLATE_KEY", 200),
    template_version: requireString(body.template_version, "INVALID_TEMPLATE_VERSION", 100),
    template_name: requireString(body.template_name, "INVALID_TEMPLATE_NAME", 500),
    template_text: requireString(body.template_text, "INVALID_TEMPLATE_TEXT", 20_000),
    market: requireOptionalString(body.market, "INVALID_MARKET", 50),
    channel: requireOptionalString(body.channel, "INVALID_CHANNEL", 100),
    intent: requireOptionalString(body.intent, "INVALID_INTENT", 100),
    required_checks: (checks as string[] | undefined) ?? [],
    quality_state: parseQualityState(body.quality_state),
    environment: "development", auto_send: false, marketplace_write_actions: 0,
  };
}

function parseLibraryReview(body: JsonObject): ReviewLibraryInput {
  rejectUnknownFields(body, rootFields.libraryReview);
  requireDevelopmentSafety(body);
  return {
    quality_state: parseQualityState(body.quality_state, false) as "USE" | "EXCLUDE",
    review_note: requireOptionalString(body.review_note, "INVALID_REVIEW_NOTE", 1_000),
    environment: "development", auto_send: false, marketplace_write_actions: 0,
  };
}

function corsHeaders(request: Request, allowedOrigins: Set<string>): Headers {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Origin" });
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-CS-Sync-Key");
    headers.set("Access-Control-Max-Age", "600");
  }
  return headers;
}

function response(request: Request, allowedOrigins: Set<string>, body: JsonObject, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders(request, allowedOrigins) });
}

function methodNotAllowed(request: Request, allowedOrigins: Set<string>, allowed: string[]): Response {
  const headers = corsHeaders(request, allowedOrigins);
  headers.set("Allow", allowed.join(", "));
  return new Response(null, { status: 405, headers });
}

function errorResponse(request: Request, allowedOrigins: Set<string>, error: unknown): Response {
  const known = error instanceof CsApiError ? error : new CsApiError("STORE_OPERATION_FAILED", 502);
  return response(request, allowedOrigins, {
    ok: false, error: known.code, environment: "development", auto_send: false, marketplace_write_actions: 0,
  }, known.status);
}

function assertSafeStoreResult(result: CsStoreResult): CsStoreResult {
  if (!isObject(result)) throw new CsApiError("STORE_RESPONSE_INVALID", 502);
  if (("environment" in result && result.environment !== "development")
    || ("auto_send" in result && result.auto_send !== false)
    || ("marketplace_write_actions" in result && result.marketplace_write_actions !== 0)) {
    throw new CsApiError("STORE_SAFETY_INVARIANT_FAILED", 502);
  }
  return { ...result, environment: "development", auto_send: false, marketplace_write_actions: 0 };
}

async function parseJson(request: Request, maxBytes: number): Promise<JsonObject> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) throw new CsApiError("JSON_BODY_TOO_LARGE", 413);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new CsApiError("JSON_CONTENT_TYPE_REQUIRED", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new CsApiError("JSON_BODY_REQUIRED", 400);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CsApiError("JSON_BODY_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(concat(chunks, total))); } catch { throw new CsApiError("INVALID_JSON", 400); }
  if (!isObject(parsed)) throw new CsApiError("JSON_OBJECT_REQUIRED", 400);
  inspectPayload(parsed);
  return parsed;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function parseListQuery(url: URL): CaseListQuery {
  const allowed = new Set(["limit", "cursor", "market", "channel", "ui_type", "reply_state", "ai_draft_state"]);
  for (const [key] of url.searchParams) if (!allowed.has(key)) throw new CsApiError("UNKNOWN_QUERY_PARAMETER", 400);
  for (const key of allowed) if (url.searchParams.getAll(key).length > 1) throw new CsApiError("DUPLICATE_QUERY_PARAMETER", 400);
  const integer = (key: string, fallback: number, minimum: number, maximum: number) => {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) throw new CsApiError("INVALID_QUERY_PARAMETER", 400);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new CsApiError("INVALID_QUERY_PARAMETER", 400);
    return value;
  };
  const enumValue = <T extends string>(key: string, values: readonly T[]): T | undefined => {
    const value = url.searchParams.get(key);
    if (value === null) return undefined;
    if (!(values as readonly string[]).includes(value)) throw new CsApiError("INVALID_QUERY_PARAMETER", 400);
    return value as T;
  };
  const channel = url.searchParams.get("channel") ?? undefined;
  if (channel !== undefined && (channel.length === 0 || channel.length > 100)) throw new CsApiError("INVALID_QUERY_PARAMETER", 400);
  return {
    limit: integer("limit", 50, 1, 100), cursor: url.searchParams.has("cursor") ? integer("cursor", 0, 0, 1_000_000) : null,
    filters: {
      channel, market: enumValue("market", ["SMARTSTORE", "ZIGZAG", "ABLY"]),
      ui_type: enumValue("ui_type", ["CHAT", "POST"]),
      reply_state: enumValue("reply_state", ["NEEDS_REPLY", "ANSWERED", "NO_REPLY", "NO_REPLY_REQUIRED", "REVIEW", "CLOSED"]),
      ai_draft_state: enumValue("ai_draft_state", ["NONE", "READY", "APPROVED", "REJECTED", "USED"]),
    },
  };
}

function requireSyncKey(request: Request, expected: string): void {
  if (!expected || request.headers.get("X-CS-Sync-Key") !== expected) throw new CsApiError("SYNC_KEY_REQUIRED", 401);
}

function caseKeyFromPath(pathname: string): string | null {
  const prefix = "/api/cs/cases/";
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes("/")) return null;
  let key: string;
  try { key = decodeURIComponent(raw); } catch { throw new CsApiError("INVALID_CASE_KEY", 400); }
  if (!/^[A-Za-z0-9:_-]{1,300}$/.test(key)) throw new CsApiError("INVALID_CASE_KEY", 400);
  return key;
}

function draftIdFromPath(pathname: string): string | null {
  const match = /^\/api\/cs\/drafts\/([^/]+)\/review$/.exec(pathname);
  if (!match) return null;
  let id: string;
  try { id = decodeURIComponent(match[1]); } catch { throw new CsApiError("INVALID_DRAFT_ID", 400); }
  if (!/^[A-Za-z0-9:_-]{1,300}$/.test(id)) throw new CsApiError("INVALID_DRAFT_ID", 400);
  return id;
}

function libraryEntryIdFromPath(pathname: string): string | null {
  const match = /^\/api\/cs\/library\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  let id: string;
  try { id = decodeURIComponent(match[1]); } catch { throw new CsApiError("INVALID_LIBRARY_ENTRY_ID", 400); }
  if (!/^[A-Za-z0-9:_-]{1,300}$/.test(id)) throw new CsApiError("INVALID_LIBRARY_ENTRY_ID", 400);
  return id;
}

function optionalQualityState(url: URL): "CANDIDATE" | "USE" | "EXCLUDE" | undefined {
  for (const [key] of url.searchParams) if (key !== "quality_state") throw new CsApiError("UNKNOWN_QUERY_PARAMETER", 400);
  if (url.searchParams.getAll("quality_state").length > 1) throw new CsApiError("DUPLICATE_QUERY_PARAMETER", 400);
  const raw = url.searchParams.get("quality_state");
  return raw === null ? undefined : parseQualityState(raw);
}

export function createCsApiHandler(options: CsApiOptions): (request: Request) => Promise<Response> {
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 1024 || maxJsonBytes > 2 * 1024 * 1024) throw new Error("INVALID_MAX_JSON_BYTES");

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      if (!origin || !allowedOrigins.has(origin)) return errorResponse(request, allowedOrigins, new CsApiError("CORS_ORIGIN_FORBIDDEN", 403));
      return new Response(null, { status: 204, headers: corsHeaders(request, allowedOrigins) });
    }
    if (!safeMethods.has(request.method)) return methodNotAllowed(request, allowedOrigins, ["GET", "POST", "PATCH", "OPTIONS"]);
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/cs/health") {
        if (request.method !== "GET") return methodNotAllowed(request, allowedOrigins, ["GET"]);
        return response(request, allowedOrigins, assertSafeStoreResult(await options.store.health()));
      }
      if (url.pathname === "/api/cs/overview") {
        if (request.method !== "GET") return methodNotAllowed(request, allowedOrigins, ["GET"]);
        return response(request, allowedOrigins, assertSafeStoreResult(await options.store.overview()));
      }
      if (url.pathname === "/api/cs/cases") {
        if (request.method !== "GET") return methodNotAllowed(request, allowedOrigins, ["GET"]);
        return response(request, allowedOrigins, assertSafeStoreResult(await options.store.listCases(parseListQuery(url))));
      }
      if (url.pathname === "/api/cs/templates") {
        if (request.method === "GET") {
          return response(request, allowedOrigins, assertSafeStoreResult(await options.store.listTemplates(optionalQualityState(url))));
        }
        if (request.method !== "POST") return methodNotAllowed(request, allowedOrigins, ["GET", "POST"]);
        requireSyncKey(request, options.syncKey);
        return response(request, allowedOrigins, assertSafeStoreResult(await options.store.upsertTemplate(parseTemplate(await parseJson(request, maxJsonBytes)))), 201);
      }
      if (url.pathname === "/api/cs/library") {
        if (request.method !== "GET") return methodNotAllowed(request, allowedOrigins, ["GET"]);
        return response(request, allowedOrigins, assertSafeStoreResult(await options.store.listLibraryEntries(optionalQualityState(url))));
      }
      const libraryEntryId = libraryEntryIdFromPath(url.pathname);
      if (libraryEntryId !== null) {
        if (request.method !== "PATCH") return methodNotAllowed(request, allowedOrigins, ["PATCH"]);
        requireSyncKey(request, options.syncKey);
        return response(request, allowedOrigins, assertSafeStoreResult(await options.store.reviewLibraryEntry(libraryEntryId, parseLibraryReview(await parseJson(request, maxJsonBytes)))));
      }
      const caseKey = caseKeyFromPath(url.pathname);
      if (caseKey !== null) {
        if (request.method !== "GET") return methodNotAllowed(request, allowedOrigins, ["GET"]);
        const stored = await options.store.getCase(caseKey);
        if (stored === null) throw new CsApiError("CASE_NOT_FOUND", 404);
        return response(request, allowedOrigins, assertSafeStoreResult(stored));
      }
      if (url.pathname === "/api/cs/sync") {
        if (request.method !== "POST") return methodNotAllowed(request, allowedOrigins, ["POST"]);
        requireSyncKey(request, options.syncKey);
        return response(request, allowedOrigins, assertSafeStoreResult(await options.store.syncRun(parseSync(await parseJson(request, maxJsonBytes)))));
      }
      if (url.pathname === "/api/cs/drafts") {
        if (request.method !== "POST") return methodNotAllowed(request, allowedOrigins, ["POST"]);
        requireSyncKey(request, options.syncKey);
        return response(request, allowedOrigins, assertSafeStoreResult(await options.store.upsertDraft(parseDraft(await parseJson(request, maxJsonBytes)))), 201);
      }
      const draftId = draftIdFromPath(url.pathname);
      if (draftId !== null) {
        if (request.method !== "PATCH") return methodNotAllowed(request, allowedOrigins, ["PATCH"]);
        requireSyncKey(request, options.syncKey);
        return response(request, allowedOrigins, assertSafeStoreResult(await options.store.reviewReplyDraft(draftId, parseReview(await parseJson(request, maxJsonBytes)))));
      }
      throw new CsApiError("NOT_FOUND", 404);
    } catch (error) {
      return errorResponse(request, allowedOrigins, error);
    }
  };
}
