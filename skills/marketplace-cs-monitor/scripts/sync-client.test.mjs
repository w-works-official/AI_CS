import assert from "node:assert/strict";
import { buildSyncRequest, makeRunId, syncReport, validateSyncReport } from "./sync-client.mjs";

const report = {
  schema_version: 1,
  collected_at: "2026-08-25T04:00:00.000Z",
  summary: { marketplace_write_actions: 0 },
  channels: {},
  records: [{ source_key: "smartstore:comments:abc", content_hash: "hash-1" }],
};

assert.equal(makeRunId(report), makeRunId(structuredClone(report)));
assert.equal(buildSyncRequest(report, { apiKey: "secret" }).action, "syncRun");
assert.equal(validateSyncReport(report), report);
assert.throws(
  () => validateSyncReport({ ...report, records: [...report.records, ...report.records] }),
  /DUPLICATE_SOURCE_KEY/,
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
const result = await syncReport(report, { web_app_url: "https://script.google.com/macros/s/test/exec", api_key: "secret" }, { fetchImpl });
assert.equal(result.ok, true);
assert.equal(captured.url.includes("secret"), false);
assert.equal(captured.init.headers["Content-Type"], "text/plain;charset=utf-8");
assert.equal(JSON.parse(captured.init.body).api_key, "secret");
assert.equal(JSON.parse(captured.init.body).report.records.length, 1);

console.log("marketplace-cs-monitor sync client: PASS");

