import assert from "node:assert/strict";
import { buildSyncBatches, buildSyncRequest, loadSyncConfig, makeRunId, readCaseIndex, readCsData, searchVerifiedAnswers, syncReport, syncReportToD1, validateSyncReport } from "./sync-client.mjs";

const base = "https://ai-cs-mcp-development.kimhyein0214.workers.dev/api/cs";
const safety = { environment: "development", auto_send: false, marketplace_write_actions: 0 };
const config = { d1_api_url: base, d1_sync_key: "hidden-test-key", environment: "development" };
const report = {
  schema_version: 1,
  collected_at: "2026-08-25T04:00:00.000Z",
  summary: { marketplace_write_actions: 0 },
  channels: { smartstore_comments: { market: "smartstore", channel: "comments", attempted: true, error: "", open_queue_complete: true, open_queue_scope: "today_unanswered", open_queue_window_start: "2026-08-25", open_queue_error: "", open_queue_visible_total: 1, open_queue_source_keys: ["smartstore:comments:abc"] } },
  records: [{ source_key: "smartstore:comments:abc", content_hash: "hash-1", customer_masked: "고*", subject: "한글 문의", preview: "바 길이 변경 문의" }],
};

assert.equal(makeRunId(report), makeRunId(structuredClone(report)));
assert.notEqual(makeRunId(report), makeRunId({ ...structuredClone(report), records: [{ ...report.records[0], ai_draft: "새 추천 답변", ai_draft_purpose: "REPLY", ai_draft_pii_scan: "PASS" }] }));
assert.equal(buildSyncRequest(report, { environment: "development" }).environment, "development");
assert.throws(() => buildSyncRequest(report, { environment: "production" }), /DEVELOPMENT_D1_SYNC_REQUIRED/);
assert.equal(validateSyncReport(report), report);
assert.throws(() => validateSyncReport({ ...report, records: [...report.records, ...report.records] }), /DUPLICATE_SOURCE_KEY/);
assert.throws(() => validateSyncReport({ ...report, channels: { smartstore_comments: { ...report.channels.smartstore_comments, open_queue_visible_total: 2 } } }), /OPEN_QUEUE_TOTAL_MISMATCH/);
assert.throws(() => validateSyncReport({ ...report, operational_refresh: { ready: false } }), /OPERATIONAL_REFRESH_NOT_READY/);

const loaded = await loadSyncConfig({ configPath: "missing.json", env: { MARKETPLACE_CS_D1_SYNC_KEY: "hidden", MARKETPLACE_CS_SYNC_ENVIRONMENT: "development" } });
assert.equal(loaded.d1_api_url, base);
assert.equal(loaded.d1_sync_key, "hidden");
assert.equal("web_app_url" in loaded, false);

let captured;
const syncFetch = async (url, init) => {
  captured = { url: String(url), init };
  return new Response(JSON.stringify({ ok: true, run_id: "SYNC_test", ...safety }));
};
const result = await syncReport(report, config, { fetchImpl: syncFetch, runId: "SYNC_test" });
assert.equal(result.ok, true);
assert.equal(captured.url, `${base}/sync`);
assert.equal(captured.url.includes("hidden-test-key"), false);
assert.equal(captured.init.headers["X-CS-Sync-Key"], "hidden-test-key");
assert.equal(JSON.parse(captured.init.body).report.records[0].customer_masked, "고*");
assert.equal(syncReportToD1, syncReport);

const largeReport = structuredClone(report);
largeReport.records = Array.from({ length: 5 }, (_, index) => ({
  ...report.records[0],
  source_key: `smartstore:comments:large-${index}`,
  content_hash: String(index).repeat(64),
  source_snapshot: {
    mime_type: "image/jpeg", data_base64: "A".repeat(400_000), width: 900, height: 600,
    redaction_state: "MASKED_DOM", captured_at: report.collected_at,
  },
}));
largeReport.channels.smartstore_comments.open_queue_complete = false;
largeReport.channels.smartstore_comments.open_queue_source_keys = [];
largeReport.channels.smartstore_comments.open_queue_visible_total = 0;
const batches = buildSyncBatches(largeReport, { runId: "SYNC_large" });
assert.ok(batches.length > 1);
assert.equal(batches.at(-1).report.records.length > 0, true);
assert.equal(batches.slice(0, -1).every((batch) => batch.report.channels.smartstore_comments.open_queue_complete === false), true);
await assert.rejects(() => syncReport(report, { ...config, d1_api_url: "https://example.com/api/cs" }, { fetchImpl: syncFetch }), /MARKETPLACE_CS_D1_URL_INVALID/);
await assert.rejects(() => syncReport(report, { ...config, environment: "production" }, { fetchImpl: syncFetch }), /DEVELOPMENT_D1_SYNC_REQUIRED/);

let readUrls = [];
const readFetch = async (url) => {
  const parsed = new URL(url);
  readUrls.push(parsed);
  if (parsed.pathname.endsWith("/library")) return new Response(JSON.stringify({ ok: true, items: [{ library_entry_id: "LIB:1", question_text_masked: "길이 변경 되나요", answer_text_masked: "확인 후 안내드리겠습니다.", market: "SMARTSTORE", channel: "문의 관리", intent: "옵션·바변경", quality_state: "USE", pii_scan: "PASS", required_checks_json: '["옵션 확인"]' }], ...safety }));
  const cursor = Number(parsed.searchParams.get("cursor") || 0);
  return new Response(JSON.stringify({ ok: true, items: cursor === 0 ? [{ case_key: "smartstore:comments:abc", content_hash: "hash-1", ai_draft_state: "NONE", reply_state: "NEEDS_REPLY" }] : [{ case_key: "ably:inquiry:def", content_hash: "hash-2", ai_draft_state: "READY", reply_state: "ANSWERED" }], next_cursor: cursor === 0 ? 1 : null, ...safety }));
};
const library = await searchVerifiedAnswers({ query: "길이", market: "SMARTSTORE", channel: "문의 관리", intent: "옵션·바변경" }, config, { fetchImpl: readFetch });
assert.equal(library.examples.length, 1);
assert.equal(library.examples[0].example_id, "LIB:1");
assert.equal(library.examples[0].required_checks, "옵션 확인");
const index = await readCaseIndex(config, { fetchImpl: readFetch });
assert.equal(index.length, 2);
assert.equal(index[0].content_hash, "hash-1");
assert.equal(readUrls.filter((url) => url.pathname.endsWith("/cases")).length, 2);
await assert.rejects(() => readCsData("arbitrary", {}, config, { fetchImpl: readFetch }), /CS_READ_ACTION_NOT_ALLOWED/);
await assert.rejects(() => readCsData("cases", { url: "https://example.com" }, config, { fetchImpl: readFetch }), /CS_READ_PARAM_NOT_ALLOWED/);

console.log("marketplace-cs-monitor D1 sync client: PASS");
