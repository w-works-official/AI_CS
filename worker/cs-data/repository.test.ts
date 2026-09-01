import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CsDataRepository } from "./repository.ts";
import { DEVELOPMENT_RESPONSE_SAFETY, type D1Database, type D1PreparedStatement, type D1Result, type D1Value, type SyncRunInput } from "./types.ts";

type SqlCall = { sql: string; values: D1Value[]; method: "first" | "all" | "run" };
function sqliteValues(values: D1Value[]): Array<string | number | null | Uint8Array> {
  return values.map((value) => typeof value === "boolean" ? Number(value) : value) as Array<string | number | null | Uint8Array>;
}
class SqliteStatement implements D1PreparedStatement {
  private values: D1Value[] = [];
  private readonly db: SqliteD1;
  private readonly sql: string;
  constructor(db: SqliteD1, sql: string) { this.db = db; this.sql = sql; }
  bind(...values: D1Value[]): D1PreparedStatement { this.values = values; return this; }
  async first<T>(): Promise<T | null> { return this.db.first<T>(this.sql, this.values); }
  async all<T>(): Promise<D1Result<T>> { return this.db.all<T>(this.sql, this.values); }
  async run(): Promise<D1Result> { return this.db.run(this.sql, this.values); }
}
class SqliteD1 implements D1Database {
  readonly database = new DatabaseSync(":memory:");
  readonly calls: SqlCall[] = [];
  prepare(query: string): D1PreparedStatement { return new SqliteStatement(this, query); }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN");
    try { const results = await Promise.all(statements.map((statement) => statement.run())); this.database.exec("COMMIT"); return results as D1Result<T>[]; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  async first<T>(sql: string, values: D1Value[]): Promise<T | null> {
    this.calls.push({ sql, values, method: "first" });
    return (this.database.prepare(sql).get(...sqliteValues(values)) as T | undefined) ?? null;
  }
  async all<T>(sql: string, values: D1Value[]): Promise<D1Result<T>> {
    this.calls.push({ sql, values, method: "all" });
    return { results: this.database.prepare(sql).all(...sqliteValues(values)) as T[], success: true, meta: {} };
  }
  async run(sql: string, values: D1Value[]): Promise<D1Result> {
    this.calls.push({ sql, values, method: "run" });
    const run = this.database.prepare(sql).run(...sqliteValues(values));
    return { results: [], success: true, meta: { changes: Number(run.changes), last_row_id: Number(run.lastInsertRowid) } };
  }
  close(): void { this.database.close(); }
}

const time = "2026-09-01T10:00:00.000Z";
const caseRow = {
  case_key: "smartstore:talktalk:case-1", market: "SMARTSTORE", channel: "talktalk", ui_type: "CHAT",
  occurred_at: time, source_status: "unanswered", category_masked: "delivery",
  customer_masked: "고***", subject_masked: "배송 문의", preview_masked: "언제 배송되나요", product_name_masked: "상품",
  product_id: "product-1", order_no_masked: "order-***", product_order_no_masked: "product-order-***",
  source_url: "https://sell.smartstore.naver.com/#/talktalk/chat", source_url_kind: "LIST" as const,
  source_reference_masked: "room-***", product_url: "https://smartstore.naver.com/example/products/1",
  product_thumbnail_url: "https://shop-phinf.pstatic.net/example.jpg",
  reply_state: "NEEDS_REPLY" as const, processing_state: "NEW" as const, last_actor: "CUSTOMER" as const,
  last_message_at: time, message_count: 2, image_count: 0, conversation_complete: true,
  conversation_incomplete_reason: "", content_hash: "a".repeat(64), first_seen_at: time, last_seen_at: time,
};
function input(): SyncRunInput {
  return {
    run_id: "SYNC:case-1", environment: "development", started_at: "2026-09-01T09:59:00.000Z", finished_at: time, cases: [caseRow],
    messages: [
      { message_key: "MSG:case-1:customer", case_key: caseRow.case_key, sequence: 1, actor: "CUSTOMER", text_masked: "언제 배송되나요", sent_at: time, has_image: false, image_count: 0, content_hash: "b".repeat(64) },
      { message_key: "MSG:case-1:seller", case_key: caseRow.case_key, sequence: 2, actor: "SELLER", text_masked: "확인 중입니다", sent_at: time, has_image: false, image_count: 0, content_hash: "c".repeat(64) },
    ],
    drafts: [{ draft_id: "DRAFT:case-1", case_key: caseRow.case_key, purpose: "REPLY", draft_text_masked: "확인 후 안내드리겠습니다.", intent: "DELIVERY", required_checks: "송장 확인", reference_ids: ["answer-1"], source_content_hash: caseRow.content_hash, source_customer_message_key: "MSG:case-1:customer", source_seller_message_key: null, generation_version: "v1", created_at: time, created_run_id: "SYNC:case-1" }],
    decisions: [{ decision_id: "DECISION:case-1", run_id: "SYNC:case-1", case_key: caseRow.case_key, purpose: "REPLY", source_content_hash: caseRow.content_hash, decision: "GENERATE", reason_code: "ELIGIBLE", draft_id: "DRAFT:case-1", created_at: time }],
  };
}
async function repository(): Promise<{ db: SqliteD1; store: CsDataRepository }> {
  const db = new SqliteD1();
  const schemaPath = fileURLToPath(new URL("./migrations/0001_initial.sql", import.meta.url));
  db.database.exec(await readFile(schemaPath, "utf8"));
  return { db, store: new CsDataRepository(db) };
}

test("actual 0001 migration accepts repository sync, detail, overview, and cursor queries", async () => {
  const { db, store } = await repository();
  try {
    assert.deepEqual(await store.health(), { ok: true, service: "ai-cs-d1-repository", schema_version: "v1", write_policy: "MASKED_DTO_ONLY" });
    assert.deepEqual(await store.syncRun(input()), { run_id: "SYNC:case-1", duplicate_run: false, inserted_cases: 1, updated_cases: 0, inserted_messages: 2, inserted_drafts: 1 });
    assert.deepEqual(await store.overview(), { total_live: 1, needs_reply: 1, answered: 0, review: 0, no_reply_required: 0, ai_ready: 1, by_market: { SMARTSTORE: 1 } });
    const list = await store.listCases({ limit: 1, cursor: 0, filters: { market: "SMARTSTORE", ai_draft_state: "READY" } });
    assert.equal(list.items[0].case_key, caseRow.case_key); assert.equal(list.next_cursor, null);
    const detail = await store.getCase(caseRow.case_key);
    assert.equal(detail?.messages.length, 2); assert.equal(detail?.drafts.length, 1); assert.equal(detail?.decisions.length, 1);
  } finally { db.close(); }
});

test("sync run is idempotent through sync_runs.run_id and uses only bindings", async () => {
  const { db, store } = await repository();
  try {
    await store.syncRun(input());
    assert.deepEqual(await store.syncRun(input()), { run_id: "SYNC:case-1", duplicate_run: true, inserted_cases: 0, updated_cases: 0, inserted_messages: 0, inserted_drafts: 0 });
    assert.equal(db.calls.every((call) => !call.sql.includes(caseRow.case_key) && !call.sql.includes("DRAFT:case-1")), true);
  } finally { db.close(); }
});

test("only REPLY drafts receive human review, with a persistent review event and no case-state mutation", async () => {
  const { db, store } = await repository();
  try {
    await store.syncRun(input());
    const reviewed = await store.reviewReplyDraft({ draft_id: "DRAFT:case-1", draft_state: "APPROVED", review_note_masked: "검수 완료", human_revision_masked: "확인 후 안내드리겠습니다.", reviewed_at: "2026-09-01T10:01:00.000Z", reviewer_ref: "reviewer-1" });
    assert.equal(reviewed.reply_state_changed, false); assert.equal(reviewed.human_revision_saved, true);
    assert.equal((db.database.prepare("SELECT reply_state FROM cs_cases WHERE case_key = ?").get(caseRow.case_key) as { reply_state: string }).reply_state, "NEEDS_REPLY");
    assert.equal((db.database.prepare("SELECT review_state FROM review_events WHERE draft_id = ?").get("DRAFT:case-1") as { review_state: string }).review_state, "APPROVED");
    await assert.rejects(() => store.reviewReplyDraft({ draft_id: "missing", draft_state: "APPROVED", review_note_masked: "", human_revision_masked: "", reviewed_at: time, reviewer_ref: "reviewer-1" }), /REPLY_DRAFT_NOT_FOUND/);
  } finally { db.close(); }
});

test("D1 interface remains small and HTTP can append the fixed development safety fields", async () => {
  assert.deepEqual(DEVELOPMENT_RESPONSE_SAFETY, { environment: "development", auto_send: false, marketplace_write_actions: 0 });
  const { db, store } = await repository();
  try { await assert.rejects(() => store.listCases({ limit: 101 }), /LIST_LIMIT_INVALID/); }
  finally { db.close(); }
});
