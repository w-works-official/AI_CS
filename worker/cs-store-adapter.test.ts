import assert from "node:assert/strict";
import test from "node:test";
import { createCsApiHandler } from "./cs-api.ts";
import { CsStoreAdapter } from "./cs-store-adapter.ts";
import type { CaseDetailResult, CursorListInput, DraftInput, DraftReviewInput, SyncRunInput } from "./cs-data/types.ts";

const safety = { environment: "development", auto_send: false, marketplace_write_actions: 0 } as const;
const now = "2026-09-01T04:00:00.000Z";

class FakeRepository {
  sync?: SyncRunInput;
  draft?: DraftInput;
  review?: DraftReviewInput;
  detail: CaseDetailResult | null = null;
  async health() { return { ok: true as const, service: "ai-cs-d1-repository" as const, schema_version: "v1" as const, write_policy: "MASKED_DTO_ONLY" as const }; }
  async overview() { return { total_live: 1, needs_reply: 1, answered: 0, review: 0, no_reply_required: 0, ai_ready: 1, closed: 0, by_market: { SMARTSTORE: 1 }, latest_sync: null }; }
  async listCases(input: CursorListInput) { void input; return { items: [], cursor: 0, next_cursor: null }; }
  async getCase(caseKey: string) { void caseKey; return this.detail; }
  async syncRun(input: SyncRunInput) { this.sync = input; return { run_id: input.run_id, duplicate_run: false, inserted_cases: input.cases.length, updated_cases: 0, inserted_messages: input.messages.length, inserted_drafts: input.drafts.length }; }
  async upsertDraft(input: DraftInput) { this.draft = input; return { inserted: true }; }
  async reviewReplyDraft(input: DraftReviewInput) {
    this.review = input;
    return { draft_id: input.draft_id, case_key: "smartstore:talktalk:12345678901234", draft_state: input.draft_state, reviewed_at: input.reviewed_at, reply_state_changed: false as const, human_revision_saved: Boolean(input.human_revision_masked) };
  }
}

function report() {
  return {
    schema_version: 1,
    collected_at: now,
    summary: { marketplace_write_actions: 0 },
    draft_decisions: [{
      source_key: "smartstore:talktalk:12345678901234", purpose: "REPLY", decision: "GENERATE",
      reason_code: "DRAFT_GENERATED", required_checks: ["출고 일정 확인"], source_content_hash: "a".repeat(64),
    }],
    records: [{
      market: "smartstore", channel: "talktalk", source_key: "smartstore:talktalk:12345678901234",
      occurred_at: now, status: "미답변", category: "배송", customer_masked: "고***",
      subject: "배송 문의", preview: "언제 발송되나요", product_id: "98765432101234", product_name: "테스트 상품",
      order_no_masked: "2026********", product_order_no_masked: "2026********",
      source_url: "https://sell.smartstore.naver.com/#/talktalk/chat?chatUrl=SGsX",
      source_url_kind: "EXACT", source_reference: "room-***", product_url: "https://smartstore.naver.com/example/products/98765432101234",
      product_thumbnail_url: "https://shop-phinf.pstatic.net/example.jpg", last_actor: "customer",
      reply_state: "NEEDS_REPLY", change_state: "NEW", conversation_complete: true, conversation_incomplete_reason: "",
      messages: [{ source_message_id: "12345678901234", sequence: 1, actor: "customer", at: now, text: "언제 발송되나요", image_count: 0 }],
      ai_draft: "출고 일정을 확인한 뒤 안내드리겠습니다.", ai_draft_origin: "AI", ai_draft_purpose: "REPLY",
      ai_draft_required_checks: "출고 일정 확인", ai_draft_pii_scan: "PASS", pii_scan: "PASS", content_hash: "a".repeat(64),
    }],
  };
}

function jsonRequest(path: string, body: unknown, method = "POST") {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-CS-Sync-Key": "test-key" },
    body: JSON.stringify(body),
  });
}

test("HTTP sync maps a masked collector report into stable D1 DTOs", async () => {
  const repository = new FakeRepository();
  const api = createCsApiHandler({ store: new CsStoreAdapter(repository, () => now), syncKey: "test-key" });
  const response = await api(jsonRequest("/api/cs/sync", { run_id: "SYNC:20260901:001", report: report(), ...safety }));
  assert.equal(response.status, 200);
  assert.equal(repository.sync?.cases[0].ui_type, "CHAT");
  assert.equal(repository.sync?.cases[0].source_url_kind, "EXACT");
  assert.equal(repository.sync?.messages[0].actor, "CUSTOMER");
  assert.equal(repository.sync?.drafts[0].purpose, "REPLY");
  assert.equal(repository.sync?.drafts[0].created_run_id, "SYNC:20260901:001");
  assert.equal(repository.sync?.decisions?.[0].decision, "GENERATE");
  assert.deepEqual(repository.sync?.decisions?.[0].required_checks, ["출고 일정 확인"]);
  assert.match(repository.sync?.messages[0].message_key ?? "", /^MSG:[a-f0-9]{16}:[a-f0-9]{16}$/);
  assert.deepEqual(await response.json(), {
    ok: true, run_id: "SYNC:20260901:001", duplicate_run: false, inserted_cases: 1, updated_cases: 0,
    inserted_messages: 1, inserted_drafts: 1, ...safety,
  });
});

test("adapter rejects unsafe URL hosts and incomplete chat drafts", async () => {
  const repository = new FakeRepository();
  const api = createCsApiHandler({ store: new CsStoreAdapter(repository, () => now), syncKey: "test-key" });
  const unsafe = report();
  unsafe.records[0].source_url = "https://evil.example/customer";
  assert.equal((await api(jsonRequest("/api/cs/sync", { run_id: "SYNC:unsafe", report: unsafe, ...safety }))).status, 400);

  const incomplete = report();
  incomplete.records[0].conversation_complete = false;
  incomplete.records[0].conversation_incomplete_reason = "HISTORY_NOT_LOADED";
  incomplete.records[0].reply_state = "REVIEW";
  assert.equal((await api(jsonRequest("/api/cs/sync", { run_id: "SYNC:incomplete", report: incomplete, ...safety }))).status, 400);
});

test("direct draft creation and human review remain local and REPLY-only", async () => {
  const repository = new FakeRepository();
  repository.detail = {
    case: { case_key: "smartstore:talktalk:12345678901234", content_hash: "a".repeat(64), reply_state: "NEEDS_REPLY", conversation_complete: 1, last_sync_run_id: "SYNC:20260901:001" },
    messages: [{ message_key: "MSG:customer", actor: "CUSTOMER", sequence: 1 }], drafts: [], decisions: [], review_events: [],
  };
  const api = createCsApiHandler({ store: new CsStoreAdapter(repository, () => now), syncKey: "test-key" });
  const draft = await api(jsonRequest("/api/cs/drafts", {
    case_key: "smartstore:talktalk:12345678901234", purpose: "REPLY", draft_text: "확인 후 안내드리겠습니다.",
    source_content_hash: "a".repeat(64), ...safety,
  }));
  assert.equal(draft.status, 201);
  assert.equal(repository.draft?.created_run_id, "SYNC:20260901:001");
  assert.equal(repository.draft?.source_customer_message_key, "MSG:customer");

  const review = await api(jsonRequest(`/api/cs/drafts/${repository.draft?.draft_id}/review`, {
    draft_state: "APPROVED", human_revision: "확인 후 안내드리겠습니다.", ...safety,
  }, "PATCH"));
  assert.equal(review.status, 200);
  assert.equal(repository.review?.draft_state, "APPROVED");
  assert.equal((await review.json() as Record<string, unknown>).marketplace_write_actions, 0);
});
