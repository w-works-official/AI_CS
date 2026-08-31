import assert from "node:assert/strict";
import { buildSyncRequest, makeRunId, readCsData, searchVerifiedAnswers, syncReport, validateSyncReport } from "./sync-client.mjs";

const report = {
  schema_version: 1,
  collected_at: "2026-08-25T04:00:00.000Z",
  summary: { marketplace_write_actions: 0 },
  channels: {
    smartstore_comments: {
      market: "smartstore",
      channel: "comments",
      open_queue_complete: true,
      open_queue_visible_total: 1,
      open_queue_source_keys: ["smartstore:comments:abc"],
    },
  },
  records: [{ source_key: "smartstore:comments:abc", content_hash: "hash-1", customer_masked: "고*", subject: "한글 문의", preview: "바 길이 변경 문의" }],
};

assert.equal(makeRunId(report), makeRunId(structuredClone(report)));
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

console.log("marketplace-cs-monitor sync client: PASS");
