import assert from "node:assert/strict";
import { buildSyncRequest, makeRunId, readCaseIndex, readCsData, searchVerifiedAnswers, syncReport, syncReportToD1, validateSyncReport } from "./sync-client.mjs";

const report = {
  schema_version: 1,
  collected_at: "2026-08-25T04:00:00.000Z",
  summary: { marketplace_write_actions: 0 },
  channels: {
    smartstore_comments: {
      market: "smartstore",
      channel: "comments",
      attempted: true,
      error: "",
      open_queue_complete: true,
      open_queue_scope: "today_unanswered",
      open_queue_window_start: "2026-08-25",
      open_queue_error: "",
      open_queue_visible_total: 1,
      open_queue_source_keys: ["smartstore:comments:abc"],
    },
  },
  records: [{ source_key: "smartstore:comments:abc", content_hash: "hash-1", customer_masked: "고*", subject: "한글 문의", preview: "바 길이 변경 문의" }],
};

assert.equal(makeRunId(report), makeRunId(structuredClone(report)));
assert.notEqual(makeRunId(report), makeRunId({ ...structuredClone(report), records: [{ ...report.records[0], ai_draft: "새 추천 답변", ai_draft_purpose: "REPLY", ai_draft_pii_scan: "PASS" }] }));
assert.equal(buildSyncRequest(report, { apiKey: "secret", environment: "development" }).action, "syncRun");
assert.equal(buildSyncRequest(report, { apiKey: "secret", environment: "development" }).environment, "development");
assert.throws(() => buildSyncRequest(report, { apiKey: "secret" }), /SYNC_ENVIRONMENT_NOT_CONFIGURED/);
assert.equal(validateSyncReport(report), report);
assert.throws(
  () => validateSyncReport({ ...report, records: [...report.records, ...report.records] }),
  /DUPLICATE_SOURCE_KEY/,
);
assert.throws(
  () => validateSyncReport({
    ...report,
    channels: { smartstore_comments: { ...report.channels.smartstore_comments, open_queue_visible_total: 2 } },
  }),
  /OPEN_QUEUE_TOTAL_MISMATCH/,
);
assert.throws(
  () => validateSyncReport({
    ...report,
    channels: { smartstore_comments: { ...report.channels.smartstore_comments, attempted: false } },
  }),
  /OPEN_QUEUE_NOT_RECONCILABLE/,
);

let captured;
const fetchImpl = async (url, init) => {
  captured = { url, init };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, auto_send: false, marketplace_write_actions: 0 }),
  };
};
const result = await syncReport(report, { web_app_url: "https://script.google.com/macros/s/test/exec", api_key: "secret", environment: "development" }, { fetchImpl });
assert.equal(result.ok, true);
assert.equal(captured.url.includes("secret"), false);
assert.equal(captured.init.headers["Content-Type"], "text/plain;charset=utf-8");
assert.equal(JSON.parse(captured.init.body).api_key, "secret");
assert.equal(JSON.parse(captured.init.body).environment, "development");
assert.equal(JSON.parse(captured.init.body).report.records.length, 1);
assert.equal(JSON.parse(captured.init.body).report.records[0].subject, "한글 문의");
assert.equal(Buffer.from(captured.init.body, "utf8").toString("utf8").includes("바 길이 변경 문의"), true);

let d1Captured;
const d1Fetch = async (url, init) => {
  d1Captured = { url, init };
  return new Response(JSON.stringify({ ok: true, environment: "development", auto_send: false, marketplace_write_actions: 0, run_id: "SYNC_test" }));
};
const d1Result = await syncReportToD1(report, {
  environment: "development",
  d1_api_url: "https://ai-cs-mcp-development.kimhyein0214.workers.dev/api/cs",
  d1_sync_key: "hidden-test-key",
}, { fetchImpl: d1Fetch, runId: "SYNC_test" });
assert.equal(d1Result.ok, true);
assert.equal(d1Captured.url, "https://ai-cs-mcp-development.kimhyein0214.workers.dev/api/cs/sync");
assert.equal(d1Captured.url.includes("hidden-test-key"), false);
assert.equal(d1Captured.init.headers["X-CS-Sync-Key"], "hidden-test-key");
assert.equal(JSON.parse(d1Captured.init.body).report.records[0].customer_masked, "고*");
assert.equal(JSON.parse(d1Captured.init.body).marketplace_write_actions, 0);
await assert.rejects(() => syncReportToD1(report, { environment: "development", d1_api_url: "https://example.com/api/cs", d1_sync_key: "x" }, { fetchImpl: d1Fetch }), /MARKETPLACE_CS_D1_URL_INVALID/);
await assert.rejects(() => syncReportToD1(report, { environment: "production", d1_api_url: "https://ai-cs-mcp-development.kimhyein0214.workers.dev/api/cs", d1_sync_key: "x" }, { fetchImpl: d1Fetch }), /DEVELOPMENT_D1_SYNC_REQUIRED/);

const readConfig = { web_app_url: "https://script.google.com/macros/s/test/exec", api_key: "secret", environment: "development" };
let readPayload;
const readFetch = async (_url, init) => {
  readPayload = JSON.parse(init.body);
  return new Response(JSON.stringify({ ok: true, environment: "development", auto_send: false, marketplace_write_actions: 0, examples: [] }));
};
await searchVerifiedAnswers({ query: "길이", market: "SMARTSTORE", channel: "문의 관리" }, readConfig, { fetchImpl: readFetch });
assert.equal(readPayload.action, "answerLibrary");
assert.equal(readPayload.limit, 3);
assert.equal(readPayload.environment, "development");
await assert.rejects(() => readCsData("arbitrary", {}, readConfig, { fetchImpl: readFetch }), /CS_READ_ACTION_NOT_ALLOWED/);
await assert.rejects(() => readCsData("cases", { url: "https://example.com" }, readConfig, { fetchImpl: readFetch }), /CS_READ_PARAM_NOT_ALLOWED/);

const indexFetch = async (_url, init) => {
  const request = JSON.parse(init.body);
  assert.equal(request.action, "caseIndex");
  return new Response(JSON.stringify({
    ok: true,
    environment: "development",
    auto_send: false,
    marketplace_write_actions: 0,
    items: [{ source_key: "smartstore:comments:abc", content_hash: "hash-1", ai_draft_state: "NONE", reply_state: "NEEDS_REPLY" }],
  }));
};
const index = await readCaseIndex(readConfig, { fetchImpl: indexFetch });
assert.equal(index.length, 1);
assert.equal(index[0].content_hash, "hash-1");

console.log("marketplace-cs-monitor sync client: PASS");
