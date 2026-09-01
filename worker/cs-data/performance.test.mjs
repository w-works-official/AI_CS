import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("./migrations/0001_initial.sql", import.meta.url));

function queryPlan(db, sql, ...values) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((row) => String(row.detail)).join(" | ");
}

test("indexed fake-data reads stay fast enough for the review desk", async (context) => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(await readFile(schemaPath, "utf8"));
    db.exec("BEGIN");
    db.prepare("INSERT INTO sync_runs (run_id, environment, mode, started_at, finished_at, collected_count, status) VALUES (?, 'development', 'READ_ONLY', ?, ?, ?, 'COMPLETED')")
      .run("SYNC:PERF", "2026-09-01T00:00:00.000Z", "2026-09-01T00:01:00.000Z", 2_000);
    const insertCase = db.prepare(`INSERT INTO cs_cases
      (case_key, market, channel, ui_type, occurred_at, source_status, category_masked, customer_masked,
       subject_masked, preview_masked, product_id, product_name_masked, order_no_masked, product_order_no_masked,
       source_url, source_url_kind, source_reference_masked, product_url, product_thumbnail_url, reply_state,
       processing_state, last_actor, last_message_at, message_count, image_count, conversation_complete,
       conversation_incomplete_reason, content_hash, first_seen_at, last_seen_at, created_run_id, last_sync_run_id)
      VALUES (?, 'SMARTSTORE', '톡톡 상담', 'CHAT', ?, '미답변', '배송', '고***', '배송 문의', '언제 발송되나요',
       ?, '테스트 상품', 'order-***', 'product-order-***', 'https://sell.smartstore.naver.com/#/talktalk/chat',
       'LIST', 'room-***', 'https://smartstore.naver.com/example/products/1',
       'https://shop-phinf.pstatic.net/example.jpg', ?, 'NEW', 'CUSTOMER', ?, 3, 0, 1, '', ?, ?, ?, 'SYNC:PERF', 'SYNC:PERF')`);
    const insertMessage = db.prepare(`INSERT INTO cs_messages
      (message_key, case_key, sequence, actor, text_masked, sent_at, has_image, image_count, content_hash, captured_run_id)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'SYNC:PERF')`);
    const insertDraft = db.prepare(`INSERT INTO ai_drafts
      (draft_id, case_key, purpose, state, draft_text_masked, intent, required_checks, reference_ids_json,
       source_content_hash, source_customer_message_key, source_seller_message_key, generation_version, pii_scan,
       created_run_id, created_at, updated_at)
      VALUES (?, ?, 'REPLY', 'READY', '확인 후 안내드리겠습니다.', 'DELIVERY', '출고일 확인', '[]', ?, ?, NULL,
       'perf-v1', 'PASS', 'SYNC:PERF', ?, ?)`);
    for (let index = 0; index < 2_000; index += 1) {
      const caseKey = `smartstore:talktalk:perf-${index}`;
      const timestamp = `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
      const replyState = index % 3 === 0 ? "NEEDS_REPLY" : index % 3 === 1 ? "ANSWERED" : "NO_REPLY_REQUIRED";
      const hash = index.toString(16).padStart(64, "0");
      insertCase.run(caseKey, timestamp, `product-${index}`, replyState, timestamp, hash, timestamp, timestamp);
      for (let sequence = 1; sequence <= 3; sequence += 1) {
        insertMessage.run(`MSG:${index}:${sequence}`, caseKey, sequence, sequence % 2 ? "CUSTOMER" : "SELLER", `masked message ${index}-${sequence}`, timestamp, `${hash}${sequence}`);
      }
      if (replyState === "NEEDS_REPLY") insertDraft.run(`DRAFT:${index}`, caseKey, hash, `MSG:${index}:3`, timestamp, timestamp);
    }
    db.exec("COMMIT");

    const listSql = "SELECT case_key, last_seen_at FROM cs_cases WHERE reply_state = ? ORDER BY last_seen_at DESC LIMIT 100";
    const messagesSql = "SELECT * FROM cs_messages WHERE case_key = ? ORDER BY sequence";
    const draftsSql = "SELECT * FROM ai_drafts WHERE case_key = ? AND state = ? ORDER BY created_at DESC";
    assert.match(queryPlan(db, listSql, "NEEDS_REPLY"), /idx_cs_cases_reply_state_last_seen_at/);
    assert.match(queryPlan(db, messagesSql, "smartstore:talktalk:perf-0"), /idx_cs_messages_case_key_sequence/);
    assert.match(queryPlan(db, draftsSql, "smartstore:talktalk:perf-0", "READY"), /idx_ai_drafts_case_key_state_created_at/);

    const started = performance.now();
    const list = db.prepare(listSql).all("NEEDS_REPLY");
    const listMs = performance.now() - started;
    const detailStarted = performance.now();
    const messages = db.prepare(messagesSql).all(String(list[0].case_key));
    const drafts = db.prepare(draftsSql).all(String(list[0].case_key), "READY");
    const detailMs = performance.now() - detailStarted;
    assert.equal(list.length, 100);
    assert.equal(messages.length, 3);
    assert.ok(drafts.length <= 1);
    assert.ok(listMs < 250, `list query took ${listMs.toFixed(2)}ms`);
    assert.ok(detailMs < 250, `detail query took ${detailMs.toFixed(2)}ms`);
    context.diagnostic(`fake rows: cases=2000 messages=6000 drafts=667; list=${listMs.toFixed(2)}ms detail=${detailMs.toFixed(2)}ms`);
  } finally {
    db.close();
  }
});
