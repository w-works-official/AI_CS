import type { EnvironmentTarget } from "./config.ts";

type JsonObject = Record<string, unknown>;

const readActions = new Set(["health", "overview", "cases", "case", "answerLibrary"]);
const writeActions = new Set(["syncRun", "reviewDraft"]);
const readParams = new Set([
  "record_type",
  "market",
  "channel",
  "ui_type",
  "reply_state",
  "ai_draft_state",
  "limit",
  "cursor",
  "case_key",
  "query",
  "intent",
]);

export class AppsScriptClient {
  private readonly target: EnvironmentTarget;
  private readonly fetchImpl: typeof fetch;

  constructor(
    target: EnvironmentTarget,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.target = target;
    this.fetchImpl = fetchImpl;
  }

  private assertSafeResponse(payload: JsonObject): JsonObject {
    if (payload.ok !== true) throw new Error(`APPS_SCRIPT_REJECTED:${String(payload.error ?? "UNKNOWN")}`);
    if (payload.environment !== this.target.name) throw new Error("UPSTREAM_ENVIRONMENT_MISMATCH");
    if (payload.auto_send !== false) throw new Error("UNSAFE_UPSTREAM_AUTO_SEND_STATE");
    if ("marketplace_write_actions" in payload && Number(payload.marketplace_write_actions) !== 0) {
      throw new Error("UNSAFE_UPSTREAM_WRITE_COUNT");
    }
    return payload;
  }

  async read(action: "health" | "overview" | "cases" | "case" | "answerLibrary", params: JsonObject = {}): Promise<JsonObject> {
    if (!readActions.has(action)) throw new Error("APPS_SCRIPT_ACTION_NOT_ALLOWED");
    const body: JsonObject = {
      action,
      api_key: this.target.appsScriptKey,
      environment: this.target.name,
    };
    for (const [key, raw] of Object.entries(params)) {
      if (!readParams.has(key)) throw new Error(`APPS_SCRIPT_PARAM_NOT_ALLOWED:${key}`);
      if (raw !== undefined && raw !== null && raw !== "") body[key] = raw;
    }
    const response = await this.fetchImpl(this.target.appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8", Accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "follow",
      cache: "no-store",
    });
    return this.parse(response);
  }

  async write(action: "syncRun" | "reviewDraft", body: JsonObject): Promise<JsonObject> {
    if (!writeActions.has(action)) throw new Error("APPS_SCRIPT_ACTION_NOT_ALLOWED");
    if ("api_key" in body || "environment" in body || "action" in body) {
      throw new Error("APPS_SCRIPT_RESERVED_PARAM");
    }
    const response = await this.fetchImpl(this.target.appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8", Accept: "application/json" },
      body: JSON.stringify({
        action,
        environment: this.target.name,
        api_key: this.target.appsScriptKey,
        ...body,
      }),
      redirect: "follow",
      cache: "no-store",
    });
    return this.parse(response);
  }

  private async parse(response: Response): Promise<JsonObject> {
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`APPS_SCRIPT_INVALID_JSON:${response.status}`);
    }
    if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`APPS_SCRIPT_HTTP_${response.status}`);
    }
    return this.assertSafeResponse(payload as JsonObject);
  }
}
