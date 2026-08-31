import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_SYNC_CONFIG = fileURLToPath(
  new URL("../config/sheet-target.json", import.meta.url),
);

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const READ_ACTIONS = new Set(["health", "overview", "cases", "case", "answerLibrary"]);
const READ_PARAMS = new Set(["case_key", "record_type", "market", "channel", "ui_type", "reply_state", "ai_draft_state", "limit", "cursor", "query", "intent"]);

export function makeRunId(report) {
  const identity = [
    report?.collected_at ?? "",
    ...(report?.records ?? []).map((row) => `${row.source_key}:${row.content_hash}`),
  ].join("|");
  return `SYNC_${sha256(identity).slice(0, 24)}`;
}

export function validateSyncReport(report) {
  if (!report || Number(report.schema_version) !== 1) throw new Error("INVALID_REPORT_SCHEMA");
  if (!Array.isArray(report.records)) throw new Error("REPORT_RECORDS_REQUIRED");
  if (Number(report.summary?.marketplace_write_actions ?? 0) !== 0) {
    throw new Error("MARKETPLACE_WRITE_ACTIONS_NOT_ALLOWED");
  }
  const keys = report.records.map((row) => row?.source_key);
  if (keys.some((key) => !key)) throw new Error("SOURCE_KEY_REQUIRED");
  if (new Set(keys).size !== keys.length) throw new Error("DUPLICATE_SOURCE_KEY");
  if (report.records.some((row) => !row?.content_hash)) throw new Error("CONTENT_HASH_REQUIRED");
  for (const [channelKey, channel] of Object.entries(report.channels ?? {})) {
    if (!channel?.open_queue_complete) continue;
    const openKeys = channel.open_queue_source_keys;
    if (!Array.isArray(openKeys)) throw new Error(`OPEN_QUEUE_SOURCE_KEYS_REQUIRED:${channelKey}`);
    if (new Set(openKeys).size !== openKeys.length) throw new Error(`OPEN_QUEUE_DUPLICATE_SOURCE_KEY:${channelKey}`);
    if (openKeys.some((key) => !String(key).startsWith(`${channel.market}:`))) {
      throw new Error(`OPEN_QUEUE_SOURCE_KEY_SCOPE_MISMATCH:${channelKey}`);
    }
    if (Number(channel.open_queue_visible_total ?? -1) !== openKeys.length) {
      throw new Error(`OPEN_QUEUE_TOTAL_MISMATCH:${channelKey}`);
    }
  }
  return report;
}

export function buildSyncRequest(report, options = {}) {
  validateSyncReport(report);
  if (options.environment !== "development" && options.environment !== "production") {
    throw new Error("SYNC_ENVIRONMENT_NOT_CONFIGURED");
  }
  return {
    action: "syncRun",
    environment: options.environment,
    run_id: options.runId ?? makeRunId(report),
    report,
    model: options.model ?? "Codex",
    prompt_version: options.promptVersion ?? "marketplace-cs-monitor-v1",
    api_key: options.apiKey ?? "",
  };
}

export async function loadSyncConfig({
  configPath = DEFAULT_SYNC_CONFIG,
  env = globalThis.process?.env ?? {},
} = {}) {
  let file = {};
  try {
    file = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const syncUrl = env.MARKETPLACE_CS_SYNC_URL;
  const syncKey = env.MARKETPLACE_CS_SYNC_KEY;
  const environment = env.MARKETPLACE_CS_SYNC_ENVIRONMENT;
  return {
    ...file,
    web_app_url: syncUrl || file.web_app_url || "",
    api_key: syncKey || "",
    environment: environment || file.environment || "",
  };
}

export async function syncReport(report, config, { fetchImpl = globalThis.fetch, ...options } = {}) {
  if (!config?.web_app_url) throw new Error("MARKETPLACE_CS_SYNC_URL_NOT_CONFIGURED");
  if (!config?.api_key) throw new Error("MARKETPLACE_CS_SYNC_KEY_NOT_CONFIGURED");
  if (config?.environment !== "development" && config?.environment !== "production") {
    throw new Error("MARKETPLACE_CS_SYNC_ENVIRONMENT_NOT_CONFIGURED");
  }
  if (typeof fetchImpl !== "function") throw new Error("FETCH_NOT_AVAILABLE");

  const payload = buildSyncRequest(report, { ...options, apiKey: config.api_key, environment: config.environment });
  const response = await fetchImpl(config.web_app_url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`SYNC_RESPONSE_NOT_JSON:${response.status}`);
  }
  if (!response.ok || !parsed.ok) {
    throw new Error(`SHEET_SYNC_FAILED:${parsed.error || response.status}`);
  }
  if (Number(parsed.marketplace_write_actions ?? 0) !== 0 || parsed.auto_send !== false) {
    throw new Error("UNSAFE_SYNC_RESPONSE");
  }
  return parsed;
}

export async function readCsData(action, params, config, { fetchImpl = globalThis.fetch } = {}) {
  if (!READ_ACTIONS.has(action)) throw new Error("CS_READ_ACTION_NOT_ALLOWED");
  if (!config?.web_app_url) throw new Error("MARKETPLACE_CS_SYNC_URL_NOT_CONFIGURED");
  if (!config?.api_key) throw new Error("MARKETPLACE_CS_SYNC_KEY_NOT_CONFIGURED");
  if (config?.environment !== "development" && config?.environment !== "production") {
    throw new Error("MARKETPLACE_CS_SYNC_ENVIRONMENT_NOT_CONFIGURED");
  }
  if (typeof fetchImpl !== "function") throw new Error("FETCH_NOT_AVAILABLE");
  const body = { action, environment: config.environment, api_key: config.api_key };
  for (const [key, value] of Object.entries(params ?? {})) {
    if (!READ_PARAMS.has(key)) throw new Error(`CS_READ_PARAM_NOT_ALLOWED:${key}`);
    if (value !== undefined && value !== null && value !== "") body[key] = value;
  }
  const response = await fetchImpl(config.web_app_url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8", Accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "follow",
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`CS_READ_RESPONSE_NOT_JSON:${response.status}`);
  }
  if (!response.ok || !parsed.ok) throw new Error(`CS_READ_FAILED:${parsed.error || response.status}`);
  if (parsed.environment !== config.environment || parsed.auto_send !== false || Number(parsed.marketplace_write_actions ?? 0) !== 0) {
    throw new Error("UNSAFE_READ_RESPONSE");
  }
  return parsed;
}

export function searchVerifiedAnswers(params, config, options) {
  return readCsData("answerLibrary", { ...params, limit: Math.min(3, Number(params?.limit ?? 3) || 3) }, config, options);
}
