/** Minimal D1 contract used by the local CS data repository. */
export type D1Value = string | number | boolean | null | Uint8Array;
export type D1Meta = { changes?: number; last_row_id?: number; duration?: number };
export type D1Result<T = Record<string, unknown>> = { results: T[]; success: boolean; meta: D1Meta };
export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database { prepare(query: string): D1PreparedStatement; batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>; }

/** HTTP handlers spread this onto every response; repository results are domain-only. */
export type DevelopmentResponseSafety = { environment: "development"; auto_send: false; marketplace_write_actions: 0 };
export const DEVELOPMENT_RESPONSE_SAFETY: DevelopmentResponseSafety = Object.freeze({ environment: "development", auto_send: false, marketplace_write_actions: 0 });

export type Actor = "CUSTOMER" | "SELLER" | "AUTOMATIC" | "SYSTEM" | "UNKNOWN";
export type ReplyState = "NEEDS_REPLY" | "ANSWERED" | "REVIEW" | "NO_REPLY" | "NO_REPLY_REQUIRED" | "CLOSED";
export type ProcessingState = "NEW" | "CHANGED" | "UNCHANGED" | "REVIEW";
export type DraftPurpose = "REPLY" | "EVAL";
export type DraftDecisionPurpose = DraftPurpose;
export type DraftState = "READY" | "APPROVED" | "REJECTED" | "REVISED" | "USED" | "SUPERSEDED" | "FAILED";
export type QualityState = "CANDIDATE" | "USE" | "EXCLUDE";
export type AnswerLibrarySourceType = "ACTUAL_SELLER_REPLY" | "REVIEWED_AI_REVISION" | "REVIEWED_TEMPLATE_REVISION" | "MANUAL_REVIEW_REPLY";
export type CompositionSourceType = "AI_DRAFT" | "REPLY_TEMPLATE" | "ANSWER_LIBRARY_ENTRY" | "MANUAL";

/** These fields map one-to-one to cs_cases in 0001_initial.sql. */
export type CsCaseInput = {
  case_key: string; market: string; channel: string; ui_type: string;
  occurred_at: string; source_status: string; category_masked: string;
  customer_masked: string; subject_masked: string; preview_masked: string;
  product_id: string; product_name_masked: string; order_no_masked: string; product_order_no_masked: string;
  source_url: string; source_url_kind: "EXACT" | "LIST" | "UNAVAILABLE"; source_reference_masked: string;
  product_url: string; product_thumbnail_url: string;
  reply_state: ReplyState; processing_state: ProcessingState; last_actor: Actor; last_message_at: string;
  message_count: number; image_count: number; conversation_complete: boolean; conversation_incomplete_reason: string;
  content_hash: string; first_seen_at: string; last_seen_at: string;
};
/** message_key is supplied by the collector; it is never synthesized by this layer. */
export type CsMessageInput = { message_key: string; case_key: string; sequence: number; actor: Actor; text_masked: string; sent_at: string; has_image: boolean; image_count: number; content_hash: string };
export type CsAttachmentInput = {
  attachment_key: string; message_key: string; case_key: string; ordinal: number;
  asset_url: string; thumbnail_url: string; alt_text_masked: string; media_type: "IMAGE";
  access_state: "PUBLIC_URL" | "SESSION_REQUIRED" | "UNAVAILABLE";
};
/** EVAL identifies the actual seller message; it never stores seller text in ai_drafts. */
export type DraftInput = {
  draft_id: string; case_key: string; purpose: DraftPurpose; state?: DraftState;
  draft_text_masked: string; intent: string; required_checks: string; reference_ids: string[];
  source_content_hash: string; source_customer_message_key: string; source_seller_message_key: string | null;
  generation_version: string; created_at: string; created_run_id: string;
};
export type DraftDecisionInput = { decision_id: string; run_id: string; case_key: string; purpose: DraftDecisionPurpose; source_content_hash: string; decision: "GENERATE" | "SKIP"; reason_code: string; required_checks: string[]; draft_id: string | null; created_at: string };
export type SyncRunInput = {
  run_id: string; environment?: "local" | "development"; mode?: "READ_ONLY"; started_at: string; finished_at: string | null;
  pii_rejected_count?: number; error_count?: number; cases: CsCaseInput[]; messages: CsMessageInput[]; attachments?: CsAttachmentInput[]; drafts: DraftInput[]; decisions?: DraftDecisionInput[];
  case_summaries?: CaseSummaryInput[]; answer_library_entries?: AnswerLibraryEntryInput[]; no_reply_patterns?: NoReplyPatternInput[];
};
export type CaseFilters = Partial<Pick<CsCaseInput, "market" | "channel" | "ui_type" | "reply_state">> & { ai_draft_state?: DraftState | "NONE" };
export type CursorListInput = { limit?: number; cursor?: number; filters?: CaseFilters };
export type DraftReviewInput = {
  draft_id: string; draft_state: "APPROVED" | "REJECTED" | "REVISED"; review_note_masked: string; human_revision_masked: string; reviewed_at: string; reviewer_ref: string;
  composition_source_type?: CompositionSourceType | null; composition_source_id?: string | null; composition_source_version?: string | null;
  base_text_hash?: string | null; final_text_hash?: string | null; unresolved_variables?: string[]; source_content_hash?: string | null;
};
export type CaseSummaryInput = {
  case_key: string; summary_text_masked: string; summary_version: string; source_content_hash: string;
  created_run_id: string; created_at: string;
};
export type AnswerLibraryEntryInput = {
  library_entry_id: string; case_key: string; source_type: AnswerLibrarySourceType; source_id: string; source_version: string;
  question_text_masked: string; answer_text_masked: string; market: string; channel: string; intent: string;
  quality_state?: QualityState; source_content_hash: string; created_run_id: string; created_at: string;
};
export type NoReplyPatternInput = {
  pattern_id: string; case_key: string; pattern_text_masked: string; reason_code: string; quality_state?: QualityState;
  source_content_hash: string; created_run_id: string; created_at: string;
};
export type ReplyTemplateInput = {
  template_id: string; template_key: string; template_version: string; template_name_masked: string; template_text_masked: string;
  market?: string | null; channel?: string | null; intent?: string | null; required_checks: string[]; quality_state?: QualityState; created_at: string;
};
export type LibraryEntryReviewInput = { library_entry_id: string; quality_state: "USE" | "EXCLUDE"; review_note_masked: string; reviewer_ref: string; reviewed_at: string };
export type TemplateStateInput = { template_id: string; quality_state: "USE" | "EXCLUDE"; updated_at: string };
export type HealthResult = { ok: true; service: "ai-cs-d1-repository"; schema_version: "v1"; write_policy: "MASKED_DTO_ONLY" };
export type LatestSyncResult = { run_id: string; status: string; started_at: string; finished_at: string | null; collected_count: number; new_count: number; changed_count: number; unchanged_count: number; draft_created_count: number; pii_rejected_count: number; error_count: number } | null;
export type OverviewResult = { total_live: number; needs_reply: number; answered: number; review: number; no_reply_required: number; ai_ready: number; closed: number; by_market: Record<string, number>; latest_sync: LatestSyncResult };
export type CaseListItem = {
  case_key: string; market: string; channel: string; ui_type: string; occurred_at: string | null;
  customer_masked: string; subject_masked: string | null; preview_masked: string | null;
  product_id: string | null; product_name_masked: string | null; source_url: string | null;
  source_url_kind: "EXACT" | "LIST" | "UNAVAILABLE"; product_url: string | null; product_thumbnail_url: string | null;
  reply_state: ReplyState; ai_draft_state: string; last_seen_at: string;
};
export type CursorListResult = { items: CaseListItem[]; cursor: number; next_cursor: number | null };
export type CaseDetailResult = { case: Record<string, unknown>; summary?: Record<string, unknown> | null; messages: Record<string, unknown>[]; attachments: Record<string, unknown>[]; drafts: Record<string, unknown>[]; decisions: Record<string, unknown>[]; review_events: Record<string, unknown>[]; learning_candidates: Record<string, unknown>[] };
export type SyncRunResult = { run_id: string; duplicate_run: boolean; inserted_cases: number; updated_cases: number; inserted_messages: number; inserted_attachments: number; inserted_drafts: number };
export type DraftReviewResult = { draft_id: string; case_key: string; draft_state: "APPROVED" | "REJECTED" | "REVISED"; reviewed_at: string; reply_state_changed: false; human_revision_saved: boolean };
