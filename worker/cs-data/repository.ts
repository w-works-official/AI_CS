import type { CaseDetailResult, CaseFilters, CaseListItem, CsCaseInput, CsMessageInput, CursorListInput, CursorListResult, D1Database, D1PreparedStatement, DraftDecisionInput, DraftInput, DraftReviewInput, DraftReviewResult, HealthResult, OverviewResult, SyncRunInput, SyncRunResult } from "./types.ts";

const MAX_LIST_LIMIT = 100;
const SERVICE = "ai-cs-d1-repository" as const;
type ExistingRow = { value: string };
type CountRow = Record<string, number | string | null>;
type MarketRow = { market: string; count: number | string };
type ReviewDraftRow = { case_key: string };
const asNumber = (value: number | string | null | undefined): number => Number.isFinite(Number(value ?? 0)) ? Number(value ?? 0) : 0;
const asBoolean = (value: boolean): number => value ? 1 : 0;

function pageInput(input: CursorListInput): { limit: number; cursor: number } {
  const limit = input.limit ?? 50;
  const cursor = input.cursor ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new Error("LIST_LIMIT_INVALID");
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error("LIST_CURSOR_INVALID");
  return { limit, cursor };
}

/** D1-only persistence for already-masked DTOs. This class has no marketplace I/O methods. */
export class CsDataRepository {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async health(): Promise<HealthResult> {
    await this.db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return { ok: true, service: SERVICE, schema_version: "v1", write_policy: "MASKED_DTO_ONLY" };
  }

  async overview(): Promise<OverviewResult> {
    const [totals, markets, latestSync] = await Promise.all([
      this.db.prepare(`SELECT COUNT(*) AS total_live,
        SUM(CASE WHEN reply_state = 'NEEDS_REPLY' THEN 1 ELSE 0 END) AS needs_reply,
        SUM(CASE WHEN reply_state = 'ANSWERED' THEN 1 ELSE 0 END) AS answered,
        SUM(CASE WHEN reply_state = 'REVIEW' THEN 1 ELSE 0 END) AS review,
        SUM(CASE WHEN reply_state IN ('NO_REPLY', 'NO_REPLY_REQUIRED') THEN 1 ELSE 0 END) AS no_reply_required,
        SUM(CASE WHEN reply_state = 'CLOSED' THEN 1 ELSE 0 END) AS closed,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM ai_drafts d WHERE d.case_key = cs_cases.case_key AND d.state = 'READY') THEN 1 ELSE 0 END) AS ai_ready
        FROM cs_cases`).first<CountRow>(),
      this.db.prepare("SELECT market, COUNT(*) AS count FROM cs_cases GROUP BY market").all<MarketRow>(),
      this.db.prepare(`SELECT run_id, status, started_at, finished_at, collected_count, new_count, changed_count,
        unchanged_count, draft_created_count, pii_rejected_count, error_count
        FROM sync_runs ORDER BY COALESCE(finished_at, started_at) DESC, run_id DESC LIMIT 1`).first<Record<string, unknown>>(),
    ]);
    const by_market: Record<string, number> = {};
    for (const row of markets.results) by_market[row.market] = asNumber(row.count);
    return {
      total_live: asNumber(totals?.total_live), needs_reply: asNumber(totals?.needs_reply), answered: asNumber(totals?.answered),
      review: asNumber(totals?.review), no_reply_required: asNumber(totals?.no_reply_required), ai_ready: asNumber(totals?.ai_ready),
      closed: asNumber(totals?.closed), by_market,
      latest_sync: latestSync ? {
        run_id: String(latestSync.run_id ?? ""), status: String(latestSync.status ?? ""), started_at: String(latestSync.started_at ?? ""),
        finished_at: latestSync.finished_at == null ? null : String(latestSync.finished_at), collected_count: asNumber(latestSync.collected_count as number | string | null),
        new_count: asNumber(latestSync.new_count as number | string | null), changed_count: asNumber(latestSync.changed_count as number | string | null),
        unchanged_count: asNumber(latestSync.unchanged_count as number | string | null), draft_created_count: asNumber(latestSync.draft_created_count as number | string | null),
        pii_rejected_count: asNumber(latestSync.pii_rejected_count as number | string | null), error_count: asNumber(latestSync.error_count as number | string | null),
      } : null,
    };
  }

  async listCases(input: CursorListInput = {}): Promise<CursorListResult> {
    const { limit, cursor } = pageInput(input);
    const { clause, values } = this.caseFilterClause(input.filters ?? {});
    const rows = (await this.db.prepare(`SELECT c.case_key, c.market, c.channel, c.ui_type, c.occurred_at, c.customer_masked,
      c.subject_masked, c.preview_masked, c.product_id, c.product_name_masked, c.source_url, c.source_url_kind,
      c.product_url, c.product_thumbnail_url, c.reply_state, c.last_seen_at,
      COALESCE((SELECT d.state FROM ai_drafts d WHERE d.case_key = c.case_key ORDER BY d.created_at DESC, d.draft_id DESC LIMIT 1), 'NONE') AS ai_draft_state
      FROM cs_cases c WHERE 1 = 1${clause} ORDER BY c.last_seen_at DESC, c.case_key DESC LIMIT ? OFFSET ?`).bind(...values, limit + 1, cursor).all<CaseListItem>()).results;
    return { items: rows.slice(0, limit), cursor, next_cursor: rows.length > limit ? cursor + limit : null };
  }

  async getCase(caseKey: string): Promise<CaseDetailResult | null> {
    const item = await this.db.prepare("SELECT * FROM cs_cases WHERE case_key = ?").bind(caseKey).first<Record<string, unknown>>();
    if (!item) return null;
    const [messages, drafts, decisions, reviewEvents] = await Promise.all([
      this.db.prepare("SELECT * FROM cs_messages WHERE case_key = ? ORDER BY sequence ASC, message_key ASC").bind(caseKey).all<Record<string, unknown>>(),
      this.db.prepare(`SELECT d.*, seller.message_key AS comparison_seller_message_key, seller.text_masked AS comparison_seller_text_masked, seller.sent_at AS comparison_seller_sent_at
        FROM ai_drafts d LEFT JOIN cs_messages seller ON seller.message_key = d.source_seller_message_key
        WHERE d.case_key = ? ORDER BY d.created_at DESC, d.draft_id DESC`).bind(caseKey).all<Record<string, unknown>>(),
      this.db.prepare("SELECT * FROM draft_decisions WHERE case_key = ? ORDER BY created_at DESC, decision_id DESC").bind(caseKey).all<Record<string, unknown>>(),
      this.db.prepare("SELECT * FROM review_events WHERE case_key = ? ORDER BY created_at DESC, review_event_id DESC").bind(caseKey).all<Record<string, unknown>>(),
    ]);
    return { case: item, messages: messages.results, drafts: drafts.results, decisions: decisions.results, review_events: reviewEvents.results };
  }

  async syncRun(input: SyncRunInput): Promise<SyncRunResult> {
    const claim = await this.db.prepare(`INSERT INTO sync_runs
      (run_id, environment, mode, started_at, finished_at, collected_count, pii_rejected_count, error_count, status)
      VALUES (?, ?, 'READ_ONLY', ?, ?, ?, ?, ?, 'RUNNING') ON CONFLICT(run_id) DO NOTHING`).bind(
      input.run_id, input.environment ?? "development", input.started_at, input.finished_at, input.cases.length, input.pii_rejected_count ?? 0, input.error_count ?? 0,
    ).run();
    if (asNumber(claim.meta.changes) === 0) return { run_id: input.run_id, duplicate_run: true, inserted_cases: 0, updated_cases: 0, inserted_messages: 0, inserted_drafts: 0 };

    let insertedCases = 0; let updatedCases = 0;
    for (const item of input.cases) {
      const exists = await this.db.prepare("SELECT case_key AS value FROM cs_cases WHERE case_key = ?").bind(item.case_key).first<ExistingRow>();
      await this.upsertCase(item, input.run_id).run();
      if (exists) updatedCases += 1; else insertedCases += 1;
    }
    const messageResults = input.messages.length ? await this.db.batch(input.messages.map((item) => this.insertMessage(item, input.run_id))) : [];
    let insertedDrafts = 0;
    for (const item of input.drafts) {
      if (item.created_run_id !== input.run_id) throw new Error("DRAFT_RUN_ID_MISMATCH");
      const exists = await this.db.prepare("SELECT draft_id AS value FROM ai_drafts WHERE draft_id = ?").bind(item.draft_id).first<ExistingRow>();
      await this.upsertDraftStatement(item).run();
      if (!exists) insertedDrafts += 1;
    }
    if (input.decisions?.length) await this.db.batch(input.decisions.map((item) => this.insertDecision(item)));
    await this.db.prepare(`UPDATE sync_runs SET finished_at = ?, new_count = ?, changed_count = ?, unchanged_count = ?, draft_created_count = ?, status = 'COMPLETED' WHERE run_id = ?`).bind(
      input.finished_at, input.cases.filter((item) => item.processing_state === "NEW").length, input.cases.filter((item) => item.processing_state === "CHANGED").length,
      input.cases.filter((item) => item.processing_state === "UNCHANGED").length, insertedDrafts, input.run_id,
    ).run();
    return { run_id: input.run_id, duplicate_run: false, inserted_cases: insertedCases, updated_cases: updatedCases, inserted_messages: messageResults.reduce((total, result) => total + asNumber(result.meta.changes), 0), inserted_drafts: insertedDrafts };
  }

  async upsertDraft(input: DraftInput): Promise<{ inserted: boolean }> {
    const exists = await this.db.prepare("SELECT draft_id AS value FROM ai_drafts WHERE draft_id = ?").bind(input.draft_id).first<ExistingRow>();
    await this.upsertDraftStatement(input).run();
    return { inserted: !exists };
  }

  async reviewReplyDraft(input: DraftReviewInput): Promise<DraftReviewResult> {
    const draft = await this.db.prepare("SELECT case_key FROM ai_drafts WHERE draft_id = ? AND purpose = 'REPLY'").bind(input.draft_id).first<ReviewDraftRow>();
    if (!draft) throw new Error("REPLY_DRAFT_NOT_FOUND");
    await this.db.batch([
      this.db.prepare("UPDATE ai_drafts SET state = ?, updated_at = ? WHERE draft_id = ? AND purpose = 'REPLY'").bind(input.draft_state, input.reviewed_at, input.draft_id),
      this.db.prepare(`INSERT INTO review_events
        (review_event_id, draft_id, case_key, reviewer_ref, review_state, review_note_masked, human_revision_masked, pii_scan, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PASS', ?)`).bind(`REVIEW:${input.draft_id}:${input.reviewed_at}`, input.draft_id, draft.case_key, input.reviewer_ref, input.draft_state, input.review_note_masked, input.human_revision_masked, input.reviewed_at),
    ]);
    return { draft_id: input.draft_id, case_key: draft.case_key, draft_state: input.draft_state, reviewed_at: input.reviewed_at, reply_state_changed: false, human_revision_saved: Boolean(input.human_revision_masked) };
  }

  private caseFilterClause(filters: CaseFilters): { clause: string; values: string[] } {
    const clauses: string[] = []; const values: string[] = [];
    for (const key of ["market", "channel", "ui_type", "reply_state"] as const) {
      const value = filters[key]; if (!value) continue;
      if (key === "reply_state" && value === "NO_REPLY_REQUIRED") clauses.push(" AND c.reply_state IN ('NO_REPLY', 'NO_REPLY_REQUIRED')");
      else { clauses.push(` AND c.${key} = ?`); values.push(value); }
    }
    if (filters.ai_draft_state) {
      clauses.push(" AND COALESCE((SELECT d.state FROM ai_drafts d WHERE d.case_key = c.case_key ORDER BY d.created_at DESC, d.draft_id DESC LIMIT 1), 'NONE') = ?");
      values.push(filters.ai_draft_state);
    }
    return { clause: clauses.join(""), values };
  }

  private upsertCase(item: CsCaseInput, runId: string): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO cs_cases
      (case_key, market, channel, ui_type, occurred_at, source_status, category_masked, customer_masked,
       subject_masked, preview_masked, product_id, product_name_masked, order_no_masked, product_order_no_masked,
       source_url, source_url_kind, source_reference_masked, product_url, product_thumbnail_url, reply_state,
       processing_state, last_actor, last_message_at, message_count, image_count, conversation_complete,
       conversation_incomplete_reason, content_hash, first_seen_at, last_seen_at, created_run_id, last_sync_run_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_key) DO UPDATE SET market = excluded.market, channel = excluded.channel, ui_type = excluded.ui_type,
        occurred_at = excluded.occurred_at, source_status = excluded.source_status, category_masked = excluded.category_masked,
        customer_masked = excluded.customer_masked, subject_masked = excluded.subject_masked, preview_masked = excluded.preview_masked,
        product_id = excluded.product_id, product_name_masked = excluded.product_name_masked,
        order_no_masked = excluded.order_no_masked, product_order_no_masked = excluded.product_order_no_masked,
        source_url = excluded.source_url, source_url_kind = excluded.source_url_kind,
        source_reference_masked = excluded.source_reference_masked, product_url = excluded.product_url,
        product_thumbnail_url = excluded.product_thumbnail_url, reply_state = excluded.reply_state,
        processing_state = excluded.processing_state, last_actor = excluded.last_actor,
        last_message_at = excluded.last_message_at, message_count = excluded.message_count,
        image_count = excluded.image_count, conversation_complete = excluded.conversation_complete,
        conversation_incomplete_reason = excluded.conversation_incomplete_reason, content_hash = excluded.content_hash,
        last_seen_at = excluded.last_seen_at, last_sync_run_id = excluded.last_sync_run_id, updated_at = excluded.updated_at`).bind(
      item.case_key, item.market, item.channel, item.ui_type, item.occurred_at, item.source_status, item.category_masked,
      item.customer_masked, item.subject_masked, item.preview_masked, item.product_id, item.product_name_masked,
      item.order_no_masked, item.product_order_no_masked, item.source_url, item.source_url_kind,
      item.source_reference_masked, item.product_url, item.product_thumbnail_url, item.reply_state,
      item.processing_state, item.last_actor, item.last_message_at, item.message_count, item.image_count,
      asBoolean(item.conversation_complete), item.conversation_incomplete_reason, item.content_hash,
      item.first_seen_at, item.last_seen_at, runId, runId, item.last_seen_at,
    );
  }

  private insertMessage(item: CsMessageInput, runId: string): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO cs_messages (message_key, case_key, sequence, actor, text_masked, sent_at, has_image, image_count, content_hash, captured_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_key) DO NOTHING`).bind(item.message_key, item.case_key, item.sequence, item.actor, item.text_masked, item.sent_at, asBoolean(item.has_image), item.image_count, item.content_hash, runId);
  }

  private upsertDraftStatement(item: DraftInput): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO ai_drafts (draft_id, case_key, purpose, state, draft_text_masked, intent, required_checks, reference_ids_json, source_content_hash, source_customer_message_key, source_seller_message_key, generation_version, pii_scan, created_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PASS', ?, ?, ?)
      ON CONFLICT(draft_id) DO UPDATE SET state = CASE WHEN ai_drafts.state IN ('APPROVED', 'REJECTED', 'REVISED', 'USED') THEN ai_drafts.state ELSE excluded.state END, draft_text_masked = excluded.draft_text_masked, intent = excluded.intent, required_checks = excluded.required_checks, reference_ids_json = excluded.reference_ids_json, source_content_hash = excluded.source_content_hash, generation_version = excluded.generation_version, updated_at = excluded.updated_at`).bind(
      item.draft_id, item.case_key, item.purpose, item.state ?? "READY", item.draft_text_masked, item.intent, item.required_checks, JSON.stringify(item.reference_ids), item.source_content_hash, item.source_customer_message_key, item.source_seller_message_key, item.generation_version, item.created_run_id, item.created_at, item.created_at,
    );
  }

  private insertDecision(item: DraftDecisionInput): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO draft_decisions (decision_id, run_id, case_key, purpose, source_content_hash, decision, reason_code, required_checks_json, draft_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, case_key, purpose, source_content_hash) DO NOTHING`).bind(item.decision_id, item.run_id, item.case_key, item.purpose, item.source_content_hash, item.decision, item.reason_code, JSON.stringify(item.required_checks), item.draft_id, item.created_at);
  }
}
