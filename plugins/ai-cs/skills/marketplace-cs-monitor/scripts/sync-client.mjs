import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_SYNC_CONFIG = fileURLToPath(new URL("../config/d1-target.json", import.meta.url));
export const DEVELOPMENT_D1_API_URL = "https://ai-cs-mcp-development.kimhyein0214.workers.dev/api/cs";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const READ_ACTIONS = new Set(["health", "overview", "cases", "case", "caseBatch", "caseIndex", "answerLibrary"]);
const READ_PARAMS = new Set(["case_key", "case_keys", "market", "channel", "ui_type", "reply_state", "ai_draft_state", "limit", "cursor", "query", "intent"]);
const CASE_FILTER_PARAMS = new Set(["market", "channel", "ui_type", "reply_state", "ai_draft_state", "limit", "cursor"]);
const MAX_SYNC_REQUEST_BYTES = 1_600_000;
const RECORD_SCOPED_ARRAYS = [
  "draft_decisions",
  "case_summaries",
  "answer_library_candidates",
  "no_reply_pattern_candidates",
];

export function makeRunId(report) {
  const identity = [
    report?.collected_at ?? "",
    ...(report?.records ?? []).map((row) => `${row.source_key}:${row.content_hash}:${sha256([
      row.ai_draft ?? "", row.ai_draft_purpose ?? "", row.ai_draft_required_checks ?? "", row.ai_draft_pii_scan ?? "",
    ].join("|")).slice(0, 16)}`),
  ].join("|");
  return `SYNC_${sha256(identity).slice(0, 24)}`;
}

export function validateSyncReport(report) {
  if (!report || Number(report.schema_version) !== 1) throw new Error("INVALID_REPORT_SCHEMA");
  if (!Array.isArray(report.records)) throw new Error("REPORT_RECORDS_REQUIRED");
  if (Number(report.summary?.marketplace_write_actions ?? 0) !== 0) throw new Error("MARKETPLACE_WRITE_ACTIONS_NOT_ALLOWED");
  if (report.operational_refresh && report.operational_refresh.ready !== true) {
    throw new Error("OPERATIONAL_REFRESH_NOT_READY");
  }
  const keys = report.records.map((row) => row?.source_key);
  if (keys.some((key) => !key)) throw new Error("SOURCE_KEY_REQUIRED");
  if (new Set(keys).size !== keys.length) throw new Error("DUPLICATE_SOURCE_KEY");
  if (report.records.some((row) => !row?.content_hash)) throw new Error("CONTENT_HASH_REQUIRED");
  for (const [channelKey, channel] of Object.entries(report.channels ?? {})) {
    if (!channel?.open_queue_complete) continue;
    if (!channel.attempted || channel.error || channel.open_queue_error || !channel.open_queue_scope || !channel.open_queue_window_start) {
      throw new Error(`OPEN_QUEUE_NOT_RECONCILABLE:${channelKey}`);
    }
    const openKeys = channel.open_queue_source_keys;
    if (!Array.isArray(openKeys)) throw new Error(`OPEN_QUEUE_SOURCE_KEYS_REQUIRED:${channelKey}`);
    if (new Set(openKeys).size !== openKeys.length) throw new Error(`OPEN_QUEUE_DUPLICATE_SOURCE_KEY:${channelKey}`);
    if (openKeys.some((key) => !String(key).startsWith(`${channel.market}:`))) throw new Error(`OPEN_QUEUE_SOURCE_KEY_SCOPE_MISMATCH:${channelKey}`);
    if (Number(channel.open_queue_visible_total ?? -1) !== openKeys.length) throw new Error(`OPEN_QUEUE_TOTAL_MISMATCH:${channelKey}`);
  }
  return report;
}

export function buildSyncRequest(report, options = {}) {
  validateSyncReport(report);
  if (options.environment !== "development") throw new Error("DEVELOPMENT_D1_SYNC_REQUIRED");
  return {
    run_id: options.runId ?? makeRunId(report), report, environment: "development", auto_send: false, marketplace_write_actions: 0,
  };
}

function recordScopeKey(item) {
  return String(item?.source_key || item?.source_case_key || item?.case_key || "");
}

function batchedReport(report, records, { final }) {
  const keys = new Set(records.map((record) => String(record.source_key)));
  const next = { ...report, records };
  for (const field of RECORD_SCOPED_ARRAYS) {
    if (Array.isArray(report[field])) next[field] = report[field].filter((item) => keys.has(recordScopeKey(item)));
  }
  if (!final) {
    next.channels = Object.fromEntries(Object.entries(report.channels ?? {}).map(([key, channel]) => [key, {
      ...channel,
      open_queue_complete: false,
      open_queue_error: channel?.open_queue_complete ? "SYNC_BATCH_PENDING" : channel?.open_queue_error,
    }]));
  }
  return next;
}

function requestBytes(report, runId) {
  return Buffer.byteLength(JSON.stringify(buildSyncRequest(report, { environment: "development", runId })), "utf8");
}

export function buildSyncBatches(report, options = {}) {
  validateSyncReport(report);
  const baseRunId = options.runId ?? makeRunId(report);
  if (requestBytes(report, baseRunId) <= MAX_SYNC_REQUEST_BYTES) return [{ runId: baseRunId, report }];

  const groups = [];
  let current = [];
  for (const record of report.records) {
    const candidate = [...current, record];
    const probe = batchedReport(report, candidate, { final: false });
    if (current.length && requestBytes(probe, `${baseRunId}_PART`) > MAX_SYNC_REQUEST_BYTES) {
      groups.push(current);
      current = [record];
    } else {
      current = candidate;
    }
    const single = batchedReport(report, current, { final: false });
    if (requestBytes(single, `${baseRunId}_PART`) > MAX_SYNC_REQUEST_BYTES) throw new Error(`SYNC_RECORD_TOO_LARGE:${record.source_key}`);
  }
  if (current.length) groups.push(current);
  if (!groups.length) throw new Error("SYNC_REPORT_TOO_LARGE_WITHOUT_RECORDS");
  return groups.map((records, index) => ({
    runId: `${baseRunId}_P${index + 1}OF${groups.length}`,
    report: batchedReport(report, records, { final: index === groups.length - 1 }),
  }));
}

export async function loadSyncConfig({ configPath = DEFAULT_SYNC_CONFIG, env = globalThis.process?.env ?? {} } = {}) {
  let file = {};
  try { file = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  return {
    d1_api_url: env.MARKETPLACE_CS_D1_URL || file.d1_api_url || DEVELOPMENT_D1_API_URL,
    d1_sync_key: env.MARKETPLACE_CS_D1_SYNC_KEY || "",
    environment: env.MARKETPLACE_CS_SYNC_ENVIRONMENT || file.environment || "development",
  };
}

function developmentD1BaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("MARKETPLACE_CS_D1_URL_INVALID"); }
  const expected = new URL(DEVELOPMENT_D1_API_URL);
  const path = url.pathname.replace(/\/$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== expected.origin || path !== expected.pathname) {
    throw new Error("MARKETPLACE_CS_D1_URL_INVALID");
  }
  url.pathname = expected.pathname;
  url.search = "";
  url.hash = "";
  return url;
}

function assertSafeResponse(parsed) {
  if (!parsed?.ok) throw new Error("D1_RESPONSE_NOT_OK");
  if (parsed.environment !== "development" || parsed.auto_send !== false || Number(parsed.marketplace_write_actions ?? 0) !== 0) {
    throw new Error("UNSAFE_D1_RESPONSE");
  }
  return parsed;
}

async function parseResponse(response, label) {
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${label}_RESPONSE_NOT_JSON:${response.status}`); }
  if (!response.ok || !parsed.ok) throw new Error(`${label}_FAILED:${parsed.error || response.status}`);
  return assertSafeResponse(parsed);
}

function makeReadUrl(action, params, config) {
  const base = developmentD1BaseUrl(config?.d1_api_url);
  const url = new URL(`${base.toString().replace(/\/$/, "")}/`);
  if (action === "health" || action === "overview") url.pathname += action;
  else if (action === "cases" || action === "caseIndex") {
    url.pathname += "cases";
    for (const [key, value] of Object.entries(params ?? {})) {
      if (CASE_FILTER_PARAMS.has(key) && value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
  } else if (action === "case") url.pathname += `cases/${encodeURIComponent(String(params.case_key || ""))}`;
  else if (action === "answerLibrary") {
    url.pathname += "library";
    url.searchParams.set("quality_state", "USE");
  }
  return url;
}

export async function syncReport(report, config, { fetchImpl = globalThis.fetch, ...options } = {}) {
  if (config?.environment !== "development") throw new Error("DEVELOPMENT_D1_SYNC_REQUIRED");
  if (!config?.d1_api_url) throw new Error("MARKETPLACE_CS_D1_URL_NOT_CONFIGURED");
  if (!config?.d1_sync_key) throw new Error("MARKETPLACE_CS_D1_SYNC_KEY_NOT_CONFIGURED");
  if (typeof fetchImpl !== "function") throw new Error("FETCH_NOT_AVAILABLE");
  const base = developmentD1BaseUrl(config.d1_api_url);
  const batches = buildSyncBatches(report, options);
  const results = [];
  for (const batch of batches) {
    const payload = buildSyncRequest(batch.report, { environment: "development", runId: batch.runId });
    const response = await fetchImpl(`${base.toString().replace(/\/$/, "")}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CS-Sync-Key": config.d1_sync_key },
      body: JSON.stringify(payload),
      redirect: "error",
    });
    results.push(await parseResponse(response, "D1_SYNC"));
  }
  if (results.length === 1) return results[0];
  const totals = ["inserted_cases", "updated_cases", "inserted_messages", "inserted_attachments", "inserted_snapshots", "inserted_drafts"];
  return {
    ...results.at(-1),
    run_id: options.runId ?? makeRunId(report),
    batch_count: results.length,
    duplicate_run: results.every((result) => result.duplicate_run === true),
    ...Object.fromEntries(totals.map((field) => [field, results.reduce((sum, result) => sum + Number(result[field] || 0), 0)])),
  };
}

// Older callers can keep this import; it no longer performs a second/shadow write.
export const syncReportToD1 = syncReport;

export async function readCsData(action, params = {}, config, { fetchImpl = globalThis.fetch } = {}) {
  if (!READ_ACTIONS.has(action)) throw new Error("CS_READ_ACTION_NOT_ALLOWED");
  for (const key of Object.keys(params ?? {})) if (!READ_PARAMS.has(key)) throw new Error(`CS_READ_PARAM_NOT_ALLOWED:${key}`);
  if (config?.environment !== "development") throw new Error("DEVELOPMENT_D1_READ_REQUIRED");
  if (!config?.d1_api_url) throw new Error("MARKETPLACE_CS_D1_URL_NOT_CONFIGURED");
  if (typeof fetchImpl !== "function") throw new Error("FETCH_NOT_AVAILABLE");
  if (action === "caseBatch") {
    const keys = Array.isArray(params.case_keys) ? params.case_keys.slice(0, 50) : [];
    const items = await Promise.all(keys.map((case_key) => readCsData("case", { case_key }, config, { fetchImpl })));
    return { ok: true, items, environment: "development", auto_send: false, marketplace_write_actions: 0 };
  }
  const response = await fetchImpl(makeReadUrl(action, params, config), { method: "GET", headers: { Accept: "application/json" }, redirect: "error" });
  const parsed = await parseResponse(response, "D1_READ");
  if (action !== "answerLibrary") return parsed;

  const query = String(params.query || "").toLowerCase().split(/\s+/).filter((token) => token.length >= 2);
  const market = String(params.market || "").toUpperCase();
  const channel = String(params.channel || "");
  const intent = String(params.intent || "");
  const limit = Math.min(3, Math.max(1, Number(params.limit ?? 3) || 3));
  const examples = (Array.isArray(parsed.items) ? parsed.items : []).map((item) => ({
    ...item,
    example_id: String(item.library_entry_id || ""),
    customer_question: String(item.question_text_masked || ""),
    human_answer: String(item.answer_text_masked || ""),
    product_name: "",
    required_checks: (() => { try { const value = JSON.parse(String(item.required_checks_json || "[]")); return Array.isArray(value) ? value.join(" · ") : ""; } catch { return ""; } })(),
    enabled: true,
    pii_scan: String(item.pii_scan || "PASS"),
    last_verified_at: String(item.reviewed_at || item.updated_at || item.created_at || ""),
  })).filter((item) => {
    if (market && String(item.market || "").toUpperCase() !== market) return false;
    if (channel && String(item.channel || "") !== channel) return false;
    if (intent && String(item.intent || "") !== intent) return false;
    if (!query.length) return true;
    const haystack = `${item.customer_question} ${item.human_answer} ${item.intent}`.toLowerCase();
    return query.some((token) => haystack.includes(token));
  }).slice(0, limit);
  return { ...parsed, examples };
}

export function searchVerifiedAnswers(params, config, options) {
  return readCsData("answerLibrary", { ...params, limit: Math.min(3, Number(params?.limit ?? 3) || 3) }, config, options);
}

export async function readCaseIndex(config, { fetchImpl = globalThis.fetch } = {}) {
  const items = [];
  let cursor = 0;
  do {
    const result = await readCsData("cases", { limit: 100, cursor }, config, { fetchImpl });
    const page = Array.isArray(result.items) ? result.items : [];
    items.push(...page);
    if (items.length > 5000) throw new Error("CASE_INDEX_TOO_LARGE");
    cursor = result.next_cursor === null || result.next_cursor === undefined ? null : Number(result.next_cursor);
  } while (cursor !== null);
  const keys = items.map((item) => String(item?.case_key || item?.source_key || ""));
  if (keys.some((key) => !key)) throw new Error("CASE_INDEX_KEY_REQUIRED");
  if (new Set(keys).size !== keys.length) throw new Error("CASE_INDEX_DUPLICATE_KEY");
  return items.map((item, index) => ({
    source_key: keys[index], content_hash: String(item.content_hash || ""), ai_draft_state: String(item.ai_draft_state || "NONE"),
    reply_state: String(item.reply_state || ""), occurred_at: String(item.occurred_at || ""),
    preview: String(item.preview || item.preview_masked || ""),
    market: String(item.market || ""), channel: String(item.channel || ""),
    last_seen_at: String(item.last_seen_at || ""),
  }));
}
