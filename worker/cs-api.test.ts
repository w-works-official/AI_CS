import assert from "node:assert/strict";
import test from "node:test";
import {
  CsApiError,
  createCsApiHandler,
  type CaseListQuery,
  type CsStore,
  type ReviewDraftInput,
  type ReviewLibraryInput,
  type SyncRunInput,
  type UpdateTemplateStateInput,
  type UpsertDraftInput,
  type UpsertTemplateInput,
} from "./cs-api.ts";

const syncKey = "test-sync-key";

class FakeStore implements CsStore {
  readonly calls: Array<{ name: string; value?: unknown }> = [];
  async health(): Promise<Record<string, unknown>> { this.calls.push({ name: "health" }); return { ok: true, service: "cs", environment: "development", auto_send: false, marketplace_write_actions: 0 }; }
  async overview(): Promise<Record<string, unknown>> { this.calls.push({ name: "overview" }); return { ok: true, total_live: 1 }; }
  async listCases(query: CaseListQuery) { this.calls.push({ name: "listCases", value: query }); return { ok: true, items: [], limit: query.limit }; }
  async getCase(caseKey: string) { this.calls.push({ name: "getCase", value: caseKey }); return caseKey === "missing" ? null : { ok: true, case_key: caseKey }; }
  async listTemplates(qualityState?: "CANDIDATE" | "USE" | "EXCLUDE") { this.calls.push({ name: "listTemplates", value: qualityState }); return { ok: true, items: [] }; }
  async listLibraryEntries(qualityState?: "CANDIDATE" | "USE" | "EXCLUDE") { this.calls.push({ name: "listLibraryEntries", value: qualityState }); return { ok: true, items: [] }; }
  async syncRun(input: SyncRunInput) { this.calls.push({ name: "syncRun", value: input }); return { ok: true, run_id: input.run_id }; }
  async upsertDraft(input: UpsertDraftInput) { this.calls.push({ name: "upsertDraft", value: input }); return { ok: true, draft_id: "draft-1", purpose: input.purpose }; }
  async upsertTemplate(input: UpsertTemplateInput) { this.calls.push({ name: "upsertTemplate", value: input }); return { ok: true, template_id: input.template_key }; }
  async setTemplateState(templateId: string, input: UpdateTemplateStateInput) { this.calls.push({ name: "setTemplateState", value: { templateId, input } }); return { ok: true, template_id: templateId, quality_state: input.quality_state }; }
  async reviewLibraryEntry(entryId: string, input: ReviewLibraryInput) { this.calls.push({ name: "reviewLibraryEntry", value: { entryId, input } }); return { ok: true, library_entry_id: entryId, quality_state: input.quality_state }; }
  async reviewReplyDraft(draftId: string, input: ReviewDraftInput) {
    this.calls.push({ name: "reviewReplyDraft", value: { draftId, input } });
    if (draftId === "eval-draft") throw new CsApiError("EVAL_REVIEW_FORBIDDEN", 409);
    return { ok: true, draft_id: draftId, draft_state: input.draft_state };
  }
}

function makeApi(store = new FakeStore()) { return { store, api: createCsApiHandler({ store, syncKey, allowedOrigins: ["https://review.example"] }) }; }
function request(path: string, init: RequestInit = {}) { return new Request(`https://worker.example${path}`, init); }
function json(body: unknown, extra: HeadersInit = {}): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json", "X-CS-Sync-Key": syncKey, ...extra }, body: JSON.stringify(body) };
}
const safety = { environment: "development", auto_send: false, marketplace_write_actions: 0 } as const;

test("read routes are narrow, CORS allowlisted, and list limit is capped", async () => {
  const { api, store } = makeApi();
  const health = await api(request("/api/cs/health", { headers: { Origin: "https://review.example" } }));
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), "https://review.example");
  assert.deepEqual(await health.json(), { ok: true, service: "cs", ...safety });

  const list = await api(request("/api/cs/cases?limit=100&market=SMARTSTORE"));
  assert.equal(list.status, 200);
  assert.deepEqual((store.calls.at(-1)?.value as CaseListQuery), { limit: 100, cursor: null, filters: { market: "SMARTSTORE", channel: undefined, ui_type: undefined, reply_state: undefined, ai_draft_state: undefined } });

  assert.equal((await api(request("/api/cs/cases?limit=101"))).status, 400);
  assert.equal((await api(request("/api/cs/cases?limit=2&limit=3"))).status, 400);
  assert.equal((await api(request("/api/cs/cases?unknown=x"))).status, 400);
  assert.equal((await api(request("/api/cs/cases/missing"))).status, 404);
});

test("CORS preflight rejects other origins and route methods remain exact", async () => {
  const { api } = makeApi();
  assert.equal((await api(request("/api/cs/overview", { method: "OPTIONS", headers: { Origin: "https://other.example" } }))).status, 403);
  const preflight = await api(request("/api/cs/overview", { method: "OPTIONS", headers: { Origin: "https://review.example" } }));
  assert.equal(preflight.status, 204);
  assert.equal((await api(request("/api/cs/overview", { method: "POST" }))).status, 405);
  assert.equal((await api(request("/api/cs/marketplace/send", { method: "POST" }))).status, 404);
});

test("writes require the exact key and fixed development safety", async () => {
  const { api, store } = makeApi();
  const body = { run_id: "SYNC_x", report: { summary: { marketplace_write_actions: 0 } }, ...safety };
  assert.equal((await api(request("/api/cs/sync", { ...json(body), headers: { "Content-Type": "application/json", "X-CS-Sync-Key": "wrong" } }))).status, 401);
  const result = await api(request("/api/cs/sync", json(body)));
  assert.equal(result.status, 200);
  assert.equal(store.calls.at(-1)?.name, "syncRun");
  const datedReport = { ...body, run_id: "SYNC_dated", report: {
    range: { start: "2026-09-01", end: "2026-09-01" },
    summary: { marketplace_write_actions: 0 },
    records: [{ seller_replies: [{ text: "상품 링크 https://smartstore.naver.com/pink-rocket/products/4991864859" }] }],
  } };
  assert.equal((await api(request("/api/cs/sync", json(datedReport)))).status, 200);
  assert.equal((await api(request("/api/cs/sync", json({ ...body, auto_send: true })))).status, 400);
  assert.equal((await api(request("/api/cs/sync", json({ ...body, action: "send_reply" })))).status, 400);
});

test("write payloads reject PII, marketplace mutations, unknown fields, and large JSON", async () => {
  const { api, store } = makeApi();
  const draft = { case_key: "case-1", purpose: "REPLY", draft_text: "안내드립니다", source_content_hash: "hash", ...safety };
  assert.equal((await api(request("/api/cs/drafts", json(draft)))).status, 201);
  assert.equal(store.calls.at(-1)?.name, "upsertDraft");
  assert.equal((await api(request("/api/cs/drafts", json({ ...draft, draft_text: "연락처 010-1234-5678" })))).status, 400);
  assert.equal((await api(request("/api/cs/drafts", json({ ...draft, customer_email: "a@example.com" })))).status, 400);
  assert.equal((await api(request("/api/cs/drafts", json({ ...draft, draft_text: "주소: 서울시 중구 세종대로 1" })))).status, 400);
  assert.equal((await api(request("/api/cs/drafts", json({ ...draft, draft_text: "부산시 동구 중앙대로197 부산역온누리약국" })))).status, 400);
  assert.equal((await api(request("/api/cs/drafts", json({ ...draft, draft_text: "계좌 110-123-456789" })))).status, 400);
  assert.equal((await api(request("/api/cs/drafts", json({ ...draft, complete_case: true })))).status, 400);
  assert.equal((await api(request("/api/cs/drafts", json({ ...draft, arbitrary: true })))).status, 400);

  const limited = createCsApiHandler({ store: new FakeStore(), syncKey, maxJsonBytes: 1024 });
  const large = JSON.stringify({ ...draft, draft_text: "x".repeat(2_000) });
  assert.equal((await limited(request("/api/cs/drafts", { method: "POST", headers: { "Content-Type": "application/json", "X-CS-Sync-Key": syncKey }, body: large }))).status, 413);
});

test("legacy read output masks contact details and bare Korean road addresses", async () => {
  class LegacyPiiStore extends FakeStore {
    override async getCase(caseKey: string) {
      return {
        ok: true,
        case_key: caseKey,
        messages: [{ text_masked: "부산시 동구 중앙대로197 부산역온누리약국" }],
        note_masked: "연락처 010-1234-5678 / test@example.com",
      };
    }
  }
  const { api } = makeApi(new LegacyPiiStore());
  const result = await api(request("/api/cs/cases/smartstore%3Atalktalk%3Alegacy"));
  const body = await result.json() as { case_key: string; messages: Array<{ text_masked: string }>; note_masked: string };
  assert.equal(result.status, 200);
  assert.equal(body.case_key, "smartstore:talktalk:legacy");
  assert.equal(body.messages[0].text_masked, "[주소 마스킹]");
  assert.equal(body.note_masked, "연락처 010-****-**** / **@***");
});

test("EVAL reviews are rejected by API input and by the store contract", async () => {
  const { api, store } = makeApi();
  const review = { draft_state: "APPROVED", human_revision: "확인 후 안내드리겠습니다.", ...safety };
  assert.equal((await api(request("/api/cs/drafts/reply-draft/review", { ...json(review), method: "PATCH" }))).status, 200);
  assert.equal(store.calls.at(-1)?.name, "reviewReplyDraft");
  assert.equal((await api(request("/api/cs/drafts/reply-draft/review", { ...json({ ...review, purpose: "EVAL" }), method: "PATCH" }))).status, 409);
  assert.equal((await api(request("/api/cs/drafts/eval-draft/review", { ...json(review), method: "PATCH" }))).status, 409);
});

test("template and answer-library routes expose only review-safe operations", async () => {
  const { api, store } = makeApi();
  assert.equal((await api(request("/api/cs/templates?quality_state=USE"))).status, 200);
  assert.deepEqual(store.calls.at(-1), { name: "listTemplates", value: "USE" });
  assert.equal((await api(request("/api/cs/library?quality_state=CANDIDATE"))).status, 200);
  assert.deepEqual(store.calls.at(-1), { name: "listLibraryEntries", value: "CANDIDATE" });
  assert.equal((await api(request("/api/cs/templates?quality_state=USE&quality_state=EXCLUDE"))).status, 400);
  const template = { template_key: "delivery", template_version: "v1", template_name: "배송 확인", template_text: "출고 일정을 확인해 안내드리겠습니다.", required_checks: ["출고 일정 확인"], ...safety };
  assert.equal((await api(request("/api/cs/templates", json(template)))).status, 201);
  assert.equal(store.calls.at(-1)?.name, "upsertTemplate");
  const templateState = { quality_state: "EXCLUDE", ...safety };
  assert.equal((await api(request("/api/cs/templates/TEMPLATE_abc", { ...json(templateState), method: "PATCH" }))).status, 200);
  assert.equal(store.calls.at(-1)?.name, "setTemplateState");
  const libraryReview = { quality_state: "USE", review_note: "검증 완료", ...safety };
  assert.equal((await api(request("/api/cs/library/ANSWER_abc", { ...json(libraryReview), method: "PATCH" }))).status, 200);
  assert.equal(store.calls.at(-1)?.name, "reviewLibraryEntry");
  assert.equal((await api(request("/api/cs/library/ANSWER_abc", { ...json({ ...libraryReview, quality_state: "CANDIDATE" }), method: "PATCH" }))).status, 400);
});

test("unsafe store output is fail-closed", async () => {
  class UnsafeStore extends FakeStore {
    override async overview() { return { ok: true, auto_send: true }; }
  }
  const store: CsStore = new UnsafeStore();
  const api = createCsApiHandler({ store, syncKey });
  const response = await api(request("/api/cs/overview"));
  assert.equal(response.status, 502);
  assert.equal((await response.json() as { error: string }).error, "STORE_SAFETY_INVARIANT_FAILED");
});
