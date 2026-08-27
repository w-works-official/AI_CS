import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewRequest } from "./policy.ts";

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

