import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("./migrations/0001_initial.sql", import.meta.url));
const diagnosticsPath = fileURLToPath(new URL("./migrations/0002_draft_decision_diagnostics.sql", import.meta.url));
const schema = (await readFile(schemaPath, "utf8")).replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

function createTable(name) {
  const match = schema.match(new RegExp(`CREATE TABLE ${name} \\((.*?)\\);`, "i"));
  assert.ok(match, `missing CREATE TABLE ${name}`);
  return match[1];
}

test("migration executes in the local SQLite engine used for D1-compatible checks", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(await readFile(schemaPath, "utf8"));
    database.exec(await readFile(diagnosticsPath, "utf8"));
  } finally {
    database.close();
  }
});

test("draft decision diagnostics migration adds required checks without rebuilding stored decisions", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(await readFile(schemaPath, "utf8"));
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(`INSERT INTO draft_decisions
      (decision_id, run_id, case_key, purpose, source_content_hash, decision, reason_code, draft_id, created_at)
      VALUES (?, ?, ?, 'REPLY', ?, 'SKIP', ?, NULL, ?)`)
      .run("decision-existing", "run-existing", "case-existing", "a".repeat(64), "NO_REPLY_REQUIRED", "2026-09-01T00:00:00.000Z");
    database.exec(await readFile(diagnosticsPath, "utf8"));
    const columns = database.prepare("PRAGMA table_info(draft_decisions)").all();
    assert.equal(columns.some((column) => column.name === "required_checks_json"), true);
    const preserved = database.prepare("SELECT decision_id, required_checks_json FROM draft_decisions WHERE decision_id = ?").get("decision-existing");
    assert.equal(preserved.decision_id, "decision-existing");
    assert.equal(preserved.required_checks_json, "[]");
  } finally {
    database.close();
  }
});

test("D1 schema contains only the required masked CS entities", () => {
  for (const table of ["sync_runs", "cs_cases", "cs_messages", "ai_drafts", "draft_decisions", "review_events"]) {
    createTable(table);
  }

  assert.match(createTable("cs_cases"), /customer_masked TEXT NOT NULL/i);
  assert.match(createTable("cs_cases"), /source_url TEXT/i);
  assert.match(createTable("cs_cases"), /source_url_kind TEXT NOT NULL DEFAULT 'UNAVAILABLE'/i);
  assert.match(createTable("cs_cases"), /product_url TEXT/i);
  assert.match(createTable("cs_cases"), /product_thumbnail_url TEXT/i);
  assert.match(createTable("cs_cases"), /occurred_at TEXT/i);
  assert.match(createTable("cs_messages"), /text_masked TEXT/i);
  assert.match(createTable("ai_drafts"), /draft_text_masked TEXT NOT NULL/i);
  assert.match(createTable("review_events"), /human_revision_masked TEXT/i);
});

test("D1 schema defines idempotency keys and foreign-key ownership", () => {
  for (const [table, key] of [
    ["sync_runs", "run_id"],
    ["cs_cases", "case_key"],
    ["cs_messages", "message_key"],
    ["ai_drafts", "draft_id"],
  ]) {
    assert.match(createTable(table), new RegExp(`${key} TEXT PRIMARY KEY`, "i"));
  }

  assert.match(createTable("cs_messages"), /case_key TEXT NOT NULL REFERENCES cs_cases\(case_key\)/i);
  assert.match(createTable("ai_drafts"), /case_key TEXT NOT NULL REFERENCES cs_cases\(case_key\)/i);
  assert.match(createTable("ai_drafts"), /source_customer_message_key TEXT NOT NULL REFERENCES cs_messages\(message_key\)/i);
  assert.match(createTable("review_events"), /draft_id TEXT NOT NULL REFERENCES ai_drafts\(draft_id\)/i);
  assert.match(createTable("draft_decisions"), /run_id TEXT NOT NULL REFERENCES sync_runs\(run_id\)/i);
});

test("REPLY and EVAL remain distinct, with EVAL linked to a seller message instead of copied answer text", () => {
  const drafts = createTable("ai_drafts");
  assert.match(drafts, /purpose TEXT NOT NULL CHECK \(purpose IN \('REPLY', 'EVAL'\)\)/i);
  assert.match(drafts, /source_seller_message_key TEXT REFERENCES cs_messages\(message_key\)/i);
  assert.match(drafts, /purpose = 'REPLY' AND source_seller_message_key IS NULL/i);
  assert.match(drafts, /purpose = 'EVAL' AND source_seller_message_key IS NOT NULL/i);
  assert.doesNotMatch(drafts, /seller_(?:answer|reply|response)(?:_masked)?\s+TEXT/i);
});

test("required list, message, and draft query indexes are present", () => {
  assert.match(schema, /CREATE INDEX idx_cs_cases_reply_state_last_seen_at ON cs_cases \(reply_state, last_seen_at DESC\)/i);
  assert.match(schema, /CREATE INDEX idx_cs_messages_case_key_sequence ON cs_messages \(case_key, sequence\)/i);
  assert.match(schema, /CREATE INDEX idx_ai_drafts_case_key_state_created_at ON ai_drafts \(case_key, state, created_at DESC\)/i);
});

test("schema has no marketplace mutation or answer-transmission columns", () => {
  const forbiddenColumns = [
    "marketplace_write",
    "send_reply",
    "reply_send",
    "answer_send",
    "transmission",
    "submit_reply",
    "complete_inquiry",
    "customer_phone",
    "customer_email",
    "customer_address",
    "raw_message",
    "raw_text",
  ];

  for (const column of forbiddenColumns) {
    assert.doesNotMatch(schema, new RegExp(`\\b${column}\\b`, "i"), `forbidden column present: ${column}`);
  }
});
