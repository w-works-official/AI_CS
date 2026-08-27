import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewRequest, normalizeSyncRequest } from "./policy.ts";

test("development review request allows only bounded review fields", () => {
  assert.deepEqual(normalizeReviewRequest({
    draft_id: "DRAFT:test",
    draft_state: "APPROVED",
    review_note: "사람 검수 완료",
    human_revision: "확인 후 안내드리겠습니다.",
  }), {
    action: "reviewDraft",
    draft_id: "DRAFT:test",
    draft_state: "APPROVED",
    review_note: "사람 검수 완료",
    human_revision: "확인 후 안내드리겠습니다.",
  });
});

test("review request rejects unsafe fields and unmasked PII", () => {
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "USED", human_revision: "ok" }), /INVALID_DRAFT_STATE/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "APPROVED", human_revision: "010-1234-5678" }), /UNMASKED_PHONE/);
  assert.throws(() => normalizeReviewRequest({ draft_id: "DRAFT:test", draft_state: "APPROVED", human_revision: "ok", api_key: "no" }), /REVIEW_PARAM_NOT_ALLOWED/);
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
});

test("sync request rejects secret overrides, PII, and draft-state mismatches", () => {
  const base = { action: "syncRun", report: { schema_version: 1, summary: { marketplace_write_actions: 0 }, records: [safeRecord] } };
  assert.throws(() => normalizeSyncRequest({ ...base, api_key: "no" }), /SYNC_PARAM_NOT_ALLOWED:api_key/);
  assert.throws(() => normalizeSyncRequest({ ...base, report: { ...base.report, summary: { marketplace_write_actions: 1 } } }), /MARKETPLACE_WRITE_ACTIONS_NOT_ALLOWED/);
  assert.throws(() => normalizeSyncRequest({ ...base, report: { ...base.report, records: [{ ...safeRecord, preview: "010-1234-5678" }] } }), /UNMASKED_PHONE/);
  assert.throws(() => normalizeSyncRequest({ ...base, report: { ...base.report, records: [{ ...safeRecord, reply_state: "ANSWERED" }] } }), /AI_DRAFT_REPLY_STATE_MISMATCH/);
});
