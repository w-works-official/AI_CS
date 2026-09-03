import test from "node:test";
import assert from "node:assert/strict";
import { assertSingletonReadParams, normalizeCaseBatchKeys, normalizeLibraryReviewRequest, normalizeReviewRequest, normalizeSyncRequest, normalizeTemplateRequest, normalizeTemplateStateRequest } from "./policy.ts";

test("case batch accepts one to three distinct safe case keys", () => {
  assert.deepEqual(normalizeCaseBatchKeys("smartstore:talktalk:abc,ably:inquiry:def"), ["smartstore:talktalk:abc", "ably:inquiry:def"]);
  assert.throws(() => normalizeCaseBatchKeys(""), /CASE_KEYS_REQUIRED/);
  assert.throws(() => normalizeCaseBatchKeys("a,b,c,d"), /CASE_BATCH_TOO_LARGE/);
  assert.throws(() => normalizeCaseBatchKeys("a,a"), /DUPLICATE_CASE_KEY/);
  assert.throws(() => normalizeCaseBatchKeys("safe,unsafe key"), /CASE_KEY_INVALID/);
});

test("development review request allows only bounded review fields", () => {
  assert.deepEqual(normalizeReviewRequest({
    action: "reviewDraft",
    draft_id: "DRAFT:test",
    draft_state: "APPROVED",
    review_note: "사람 검수 완료",
    human_revision: "확인 후 안내드리겠습니다.",
    composition_source_type: "REPLY_TEMPLATE",
    composition_source_id: "delivery-delay",
    composition_source_version: "v3",
    base_text_hash: "a".repeat(64),
    final_text_hash: "b".repeat(64),
    unresolved_variables: [],
    source_content_hash: "c".repeat(64),
    environment: "development",
    auto_send: false,
    marketplace_write_actions: 0,
  }), {
    action: "reviewDraft",
    draft_id: "DRAFT:test",
    draft_state: "APPROVED",
    review_note: "사람 검수 완료",
    human_revision: "확인 후 안내드리겠습니다.",
    composition_source_type: "REPLY_TEMPLATE",
    composition_source_id: "delivery-delay",
    composition_source_version: "v3",
    base_text_hash: "a".repeat(64),
    final_text_hash: "b".repeat(64),
    unresolved_variables: [],
    source_content_hash: "c".repeat(64),
    environment: "development",
    auto_send: false,
    marketplace_write_actions: 0,
  });
});

test("review request rejects unsafe fields and unmasked PII", () => {
  assert.throws(() => normalizeReviewRequest({ action: "deleteDraft", draft_id: "DRAFT:test", draft_state: "REJECTED" }), /UNKNOWN_WRITE_ACTION/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "USED", human_revision: "ok" }), /INVALID_DRAFT_STATE/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "APPROVED", human_revision: "010-1234-5678" }), /UNMASKED_PHONE/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "APPROVED", human_revision: "ok", api_key: "no" }), /REVIEW_PARAM_NOT_ALLOWED/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "APPROVED", human_revision: "ok", composition_source_type: "AI" }), /INVALID_COMPOSITION_SOURCE_TYPE/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "APPROVED", human_revision: "ok", composition_source_type: "REPLY_TEMPLATE" }), /COMPOSITION_SOURCE_REFERENCE_REQUIRED/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "APPROVED", human_revision: "ok", final_text_hash: "not-a-hash" }), /INVALID_FINAL_TEXT_HASH/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "APPROVED", human_revision: "ok", unresolved_variables: ["[order_no]"] }), /UNRESOLVED_TEMPLATE_VARIABLES/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "APPROVED", human_revision: "ok", environment: "production", auto_send: false, marketplace_write_actions: 0 }), /DEVELOPMENT_SAFETY_REQUIRED/);
});

const safeRecord = {
  market: "ably",
  channel: "inquiry",
  source_key: "ably:inquiry:test",
  occurred_at: "2026-08-27T09:00:00+09:00",
  customer_masked: "고***",
  subject: "문의",
  preview: "문의 내용",
  messages: [{ direction: "customer", at: "2026-08-27T09:00:00+09:00", text: "문의 내용", image_count: 0 }],
  seller_replies: [],
  last_actor: "customer",
  reply_state: "NEEDS_REPLY",
  ai_draft: "확인 후 안내드리겠습니다.",
  ai_draft_origin: "AI",
  ai_draft_purpose: "REPLY",
  ai_draft_required_checks: "사람 검수",
  ai_draft_pii_scan: "PASS",
  pii_scan: "PASS",
  content_hash: "abc123",
  change_state: "NEW",
  source_url: "https://my.a-bly.com/inquiry",
  source_url_kind: "LIST",
  source_reference: "AB-masked-ref",
  product_url: "https://my.a-bly.com/product/123",
};

test("sync request accepts only a masked read-only report", () => {
  const result = normalizeSyncRequest({
    action: "syncRun",
    run_id: "SYNC_test",
    report: { schema_version: 1, mode: "READ_ONLY", collected_at: "2026-08-27T09:01:00+09:00", duration_ms: 10, summary: { marketplace_write_actions: 0 }, channels: {}, records: [safeRecord] },
  });
  assert.equal(result.action, "syncRun");
  assert.equal(result.report.records.length, 1);
  assert.equal(result.report.records[0].pii_scan, "PASS");
  assert.equal(result.report.records[0].source_url_kind, "LIST");
});

test("sync request preserves only allowlisted image metadata", () => {
  const record = structuredClone(safeRecord);
  record.messages[0].image_count = 2;
  (record.messages[0] as typeof record.messages[0] & { images: Array<Record<string, unknown>> }).images = [
    { url: "https://shop-phinf.pstatic.net/20260901/example.jpg", thumbnail_url: "https://shop-phinf.pstatic.net/20260901/thumb.jpg", alt_text: "상품 사진", access_state: "PUBLIC_URL" },
    { url: "https://evil.example/private.jpg", alt_text: "", access_state: "PUBLIC_URL" },
  ];
  const result = normalizeSyncRequest({ action: "syncRun", report: { schema_version: 1, summary: { marketplace_write_actions: 0 }, records: [record] } });
  const images = (result.report.records[0].messages as Array<Record<string, unknown>>)[0].images as Array<Record<string, unknown>>;
  assert.equal(images[0].access_state, "PUBLIC_URL");
  assert.equal(images[1].url, "");
  assert.equal(images[1].access_state, "SESSION_REQUIRED");
});

test("sync request preserves only bounded MASKED_DOM inquiry screenshots", () => {
  const record = {
    ...safeRecord,
    source_snapshot: {
      mime_type: "image/jpeg", data_base64: Buffer.from("masked-inquiry-screen").toString("base64"),
      width: 900, height: 600, redaction_state: "MASKED_DOM", captured_at: "2026-09-03T01:00:00.000Z",
    },
  };
  const result = normalizeSyncRequest({ action: "syncRun", report: { schema_version: 1, summary: { marketplace_write_actions: 0 }, records: [record] } });
  assert.equal((result.report.records[0].source_snapshot as Record<string, unknown>).redaction_state, "MASKED_DOM");
  assert.throws(() => normalizeSyncRequest({ action: "syncRun", report: { schema_version: 1, summary: { marketplace_write_actions: 0 }, records: [{ ...record, source_snapshot: { ...record.source_snapshot, redaction_state: "RAW" } }] } }), /INVALID_SOURCE_SNAPSHOT/);
});

test("template and learning mutations stay development-only and bounded", () => {
  assert.equal(normalizeTemplateRequest({ action: "upsertTemplate", template_key: "delivery", template_version: "v1", template_name: "배송", template_text: "확인 후 안내드리겠습니다.", required_checks: ["출고일 확인"], ...{ environment: "development", auto_send: false, marketplace_write_actions: 0 } }).quality_state, "USE");
  assert.equal(normalizeTemplateStateRequest({ action: "setTemplateState", template_id: "TEMPLATE:delivery", quality_state: "EXCLUDE", environment: "development", auto_send: false, marketplace_write_actions: 0 }).quality_state, "EXCLUDE");
  assert.equal(normalizeLibraryReviewRequest({ action: "reviewLibraryEntry", library_entry_id: "ANSWER:reviewed", quality_state: "USE", review_note: "사람 검증 완료", environment: "development", auto_send: false, marketplace_write_actions: 0 }).quality_state, "USE");
  assert.throws(() => normalizeTemplateRequest({ action: "upsertTemplate", template_key: "x", template_version: "v1", template_name: "x", template_text: "x", environment: "production", auto_send: false, marketplace_write_actions: 0 }), /DEVELOPMENT_SAFETY_REQUIRED/);
});

test("sync request rejects secret overrides, PII, and draft-state mismatches", () => {
  const base = { action: "syncRun", report: { schema_version: 1, summary: { marketplace_write_actions: 0 }, records: [safeRecord] } };
  assert.throws(() => normalizeSyncRequest({ ...base, api_key: "no" }), /SYNC_PARAM_NOT_ALLOWED:api_key/);
  assert.throws(() => normalizeSyncRequest({ ...base, report: { ...base.report, summary: { marketplace_write_actions: 1 } } }), /MARKETPLACE_WRITE_ACTIONS_NOT_ALLOWED/);
  assert.throws(() => normalizeSyncRequest({ ...base, report: { ...base.report, records: [{ ...safeRecord, preview: "010-1234-5678" }] } }), /UNMASKED_PHONE/);
  assert.throws(() => normalizeSyncRequest({ ...base, report: { ...base.report, records: [{ ...safeRecord, reply_state: "ANSWERED" }] } }), /AI_DRAFT_REPLY_STATE_MISMATCH/);
  assert.throws(() => normalizeSyncRequest({ ...base, report: { ...base.report, records: [{ ...safeRecord, source_url: "https://example.com/case" }] } }), /MARKETPLACE_URL_HOST_NOT_ALLOWED/);
  assert.throws(() => normalizeSyncRequest({ ...base, report: { ...base.report, records: [{ ...safeRecord, source_url: "https://my.a-bly.com/inquiry?sessionId=secret" }] } }), /MARKETPLACE_URL_SECRET_PARAM/);
  assert.throws(() => normalizeSyncRequest({ ...base, report: { ...base.report, records: [{ ...safeRecord, source_url: "https://my.a-bly.com/inquiry#detail?accessToken=secret" }] } }), /MARKETPLACE_URL_SECRET_PARAM/);
});

test("read params reject duplicate singleton values", () => {
  assert.throws(() => assertSingletonReadParams(new URLSearchParams("action=case&case_key=A&case_key=B")), /READ_PARAM_DUPLICATE:case_key/);
  assert.doesNotThrow(() => assertSingletonReadParams(new URLSearchParams("action=case&case_key=A")));
});
