import test from "node:test";
import assert from "node:assert/strict";
import { AppsScriptClient } from "./apps-script-client.ts";
import { maskedReportSchema, syncRunInputSchema } from "./schemas.ts";
import { assertSafeSync, makeRunId, safeToolError } from "./safety.ts";

const emptyChannel = {
  attempted: true,
  visible_total: 0,
  collected_count: 0,
  skipped_count: 0,
  new_count: 0,
  changed_count: 0,
  unchanged_count: 0,
  needs_reply_count: 0,
  read_state_transition_count: 0,
  error: "",
  filter: "today",
  sort: "recent",
};

function emptyReport() {
  return maskedReportSchema.parse({
    schema_version: 1,
    mode: "changes_today",
    range: { start: "2026-08-25", end: "2026-08-25" },
    collected_at: "2026-08-25T06:00:00.000Z",
    duration_ms: 100,
    summary: {
      prepared_count: 0,
      new_count: 0,
      changed_count: 0,
      unchanged_count: 0,
      needs_reply_count: 0,
      duplicate_count: 0,
      missing_key_count: 0,
      missing_hash_count: 0,
      talktalk_read_state_transitions: 0,
      marketplace_write_actions: 0,
    },
    channels: {
      smartstore_comments: emptyChannel,
      smartstore_customer_qna: emptyChannel,
      smartstore_customer_center: emptyChannel,
      smartstore_talktalk: emptyChannel,
      zigzag_order_inquiry: emptyChannel,
      zigzag_item_question: emptyChannel,
      ably_inquiry: emptyChannel,
    },
    records: [],
  });
}

test("deterministic run id is stable and safe report passes", () => {
  const report = emptyReport();
  const input = syncRunInputSchema.parse({ report });
  assertSafeSync(input);
  assert.equal(makeRunId(report), makeRunId(structuredClone(report)));
  assert.match(makeRunId(report), /^SYNC_[a-f0-9]{24}$/);
});

test("upstream failures are classified without exposing credentials or URLs", () => {
  assert.equal(safeToolError(new Error("APPS_SCRIPT_REJECTED:INVALID_API_KEY")), "UPSTREAM_AUTH_FAILED");
  assert.equal(safeToolError(new Error("APPS_SCRIPT_REJECTED:INVALID_SECRET")), "UPSTREAM_AUTH_FAILED");
  assert.equal(safeToolError(new Error("fetch failed for https://secret.example/exec")), "UPSTREAM_CONNECTION_FAILED");
  assert.equal(safeToolError(new Error("token verification failed")), "TOOL_FAILED");
});

test("PII scan blocks an unmasked phone before Apps Script", () => {
  const report = emptyReport();
  const unsafe = {
    ...report,
    summary: { ...report.summary, prepared_count: 1, new_count: 1 },
    records: [{
      market: "smartstore",
      channel: "comments",
      source_key: "smartstore:comments:aaaaaaaaaaaaaaaaaaaaaaaa",
      content_hash: "b".repeat(64),
      change_state: "NEW",
      occurred_at: "2026-08-25T06:00:00.000Z",
      status: "미답변",
      category: "상품 문의",
      customer_masked: "고***",
      subject: "연락처 010-1234-5678",
      preview: "",
      product_id: "",
      product_name: "상품",
      order_no_masked: "",
      product_order_no_masked: "",
      messages: [],
      seller_replies: [],
      last_actor: "customer",
      reply_state: "NEEDS_REPLY",
      ai_draft: "",
      ai_draft_origin: "",
      ai_draft_required_checks: "",
      ai_draft_pii_scan: "REVIEW",
      pii_scan: "PASS",
    }],
  };
  const input = syncRunInputSchema.parse({ report: unsafe });
  assert.throws(() => assertSafeSync(input), /PII_SCAN_FAILED:UNMASKED_PHONE/);
});

test("Apps Script client allowlists params and enforces environment response", async () => {
  let requested = "";
  let init: RequestInit | undefined;
  let fetchUsedGlobalThis = false;
  const fetchImpl = async function (this: unknown, input: RequestInfo | URL, requestInit?: RequestInit) {
    fetchUsedGlobalThis = this === globalThis;
    requested = String(input);
    init = requestInit;
    return Response.json({ ok: true, environment: "development", auto_send: false, marketplace_write_actions: 0, total_live: 0 });
  } as typeof fetch;
  const client = new AppsScriptClient({
    name: "development",
    appsScriptUrl: "https://script.google.com/macros/s/dev/exec",
    appsScriptKey: "dev-secret",
  }, fetchImpl);
  await client.read("overview", { limit: 10 });
  assert.equal(fetchUsedGlobalThis, true);
  assert.equal(requested, "https://script.google.com/macros/s/dev/exec");
  assert.equal(init?.method, "POST");
  assert.equal("cache" in (init ?? {}), false);
  const body = JSON.parse(String(init?.body));
  assert.deepEqual(body, { action: "overview", api_key: "dev-secret", environment: "development", limit: 10 });
  assert.doesNotMatch(requested, /dev-secret/);
  await assert.rejects(() => client.read("overview", { url: "https://evil.example" }), /APPS_SCRIPT_PARAM_NOT_ALLOWED:url/);

  const mismatch = new AppsScriptClient({
    name: "development",
    appsScriptUrl: "https://script.google.com/macros/s/dev/exec",
    appsScriptKey: "dev-secret",
  }, async () => Response.json({ ok: true, environment: "production", auto_send: false, marketplace_write_actions: 0 }));
  await assert.rejects(() => mismatch.read("health"), /UPSTREAM_ENVIRONMENT_MISMATCH/);
});

test("Apps Script fetch failures expose only a safe error class", async () => {
  const failure = Object.assign(new TypeError("fetch failed for https://secret.example/exec"), {
    cause: { code: "ECONNRESET" },
  });
  const client = new AppsScriptClient(
    { name: "development", appsScriptUrl: "https://script.google.com/macros/s/test/exec", appsScriptKey: "secret" },
    async () => { throw failure; },
  );
  await assert.rejects(
    () => client.read("health"),
    (error: Error) => error.message === "APPS_SCRIPT_FETCH_FAILED:TypeError:ECONNRESET:fetch failed for <url>",
  );
});
