-- Local-first D1 schema for the masked, review-only CS data store.
-- This migration intentionally contains no customer raw data or marketplace mutation fields.
PRAGMA foreign_keys = ON;

CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('local', 'development')),
  mode TEXT NOT NULL DEFAULT 'READ_ONLY' CHECK (mode = 'READ_ONLY'),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  collected_count INTEGER NOT NULL DEFAULT 0 CHECK (collected_count >= 0),
  new_count INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  changed_count INTEGER NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  draft_created_count INTEGER NOT NULL DEFAULT 0 CHECK (draft_created_count >= 0),
  pii_rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (pii_rejected_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cs_cases (
  case_key TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  channel TEXT NOT NULL,
  ui_type TEXT NOT NULL CHECK (ui_type IN ('CHAT', 'POST')),
  occurred_at TEXT,
  source_status TEXT,
  category_masked TEXT,
  customer_masked TEXT NOT NULL,
  subject_masked TEXT,
  preview_masked TEXT,
  product_id TEXT,
  product_name_masked TEXT,
  order_no_masked TEXT,
  product_order_no_masked TEXT,
  source_url TEXT,
  source_url_kind TEXT NOT NULL DEFAULT 'UNAVAILABLE' CHECK (source_url_kind IN ('EXACT', 'LIST', 'UNAVAILABLE')),
  source_reference_masked TEXT,
  product_url TEXT,
  product_thumbnail_url TEXT,
  reply_state TEXT NOT NULL CHECK (reply_state IN ('NEEDS_REPLY', 'ANSWERED', 'REVIEW', 'NO_REPLY', 'NO_REPLY_REQUIRED', 'CLOSED')),
  processing_state TEXT NOT NULL CHECK (processing_state IN ('NEW', 'CHANGED', 'UNCHANGED', 'REVIEW')),
  last_actor TEXT NOT NULL CHECK (last_actor IN ('CUSTOMER', 'SELLER', 'AUTOMATIC', 'SYSTEM', 'UNKNOWN')),
  last_message_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  image_count INTEGER NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  conversation_complete INTEGER NOT NULL CHECK (conversation_complete IN (0, 1)),
  conversation_incomplete_reason TEXT,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  last_sync_run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cs_messages (
  message_key TEXT PRIMARY KEY,
  case_key TEXT NOT NULL REFERENCES cs_cases(case_key) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  actor TEXT NOT NULL CHECK (actor IN ('CUSTOMER', 'SELLER', 'AUTOMATIC', 'SYSTEM', 'UNKNOWN')),
  text_masked TEXT,
  sent_at TEXT,
  has_image INTEGER NOT NULL DEFAULT 0 CHECK (has_image IN (0, 1)),
  image_count INTEGER NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  content_hash TEXT NOT NULL,
  captured_run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (case_key, sequence, content_hash)
);

CREATE TABLE ai_drafts (
  draft_id TEXT PRIMARY KEY,
  case_key TEXT NOT NULL REFERENCES cs_cases(case_key) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('REPLY', 'EVAL')),
  state TEXT NOT NULL CHECK (state IN ('READY', 'APPROVED', 'REJECTED', 'REVISED', 'USED', 'SUPERSEDED', 'FAILED')),
  draft_text_masked TEXT NOT NULL,
  intent TEXT,
  required_checks TEXT,
  reference_ids_json TEXT NOT NULL DEFAULT '[]',
  source_content_hash TEXT NOT NULL,
  source_customer_message_key TEXT NOT NULL REFERENCES cs_messages(message_key) ON DELETE RESTRICT,
  source_seller_message_key TEXT REFERENCES cs_messages(message_key) ON DELETE RESTRICT,
  generation_version TEXT NOT NULL,
  pii_scan TEXT NOT NULL CHECK (pii_scan = 'PASS'),
  created_run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (purpose = 'REPLY' AND source_seller_message_key IS NULL)
    OR (purpose = 'EVAL' AND source_seller_message_key IS NOT NULL)
  ),
  UNIQUE (case_key, purpose, source_content_hash, generation_version)
);

CREATE TABLE draft_decisions (
  decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  case_key TEXT NOT NULL REFERENCES cs_cases(case_key) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('REPLY', 'EVAL')),
  source_content_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('GENERATE', 'SKIP')),
  reason_code TEXT NOT NULL,
  draft_id TEXT REFERENCES ai_drafts(draft_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (decision = 'GENERATE' AND draft_id IS NOT NULL)
    OR (decision = 'SKIP' AND draft_id IS NULL)
  ),
  UNIQUE (run_id, case_key, purpose, source_content_hash)
);

CREATE TABLE review_events (
  review_event_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES ai_drafts(draft_id) ON DELETE CASCADE,
  case_key TEXT NOT NULL REFERENCES cs_cases(case_key) ON DELETE CASCADE,
  reviewer_ref TEXT NOT NULL,
  review_state TEXT NOT NULL CHECK (review_state IN ('APPROVED', 'REJECTED', 'REVISED')),
  review_note_masked TEXT,
  human_revision_masked TEXT,
  pii_scan TEXT NOT NULL CHECK (pii_scan = 'PASS'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cs_cases_reply_state_last_seen_at
  ON cs_cases (reply_state, last_seen_at DESC);

CREATE INDEX idx_cs_cases_market_channel_last_seen_at
  ON cs_cases (market, channel, last_seen_at DESC);

CREATE INDEX idx_cs_messages_case_key_sequence
  ON cs_messages (case_key, sequence);

CREATE INDEX idx_ai_drafts_case_key_state_created_at
  ON ai_drafts (case_key, state, created_at DESC);

CREATE INDEX idx_draft_decisions_case_key_created_at
  ON draft_decisions (case_key, created_at DESC);

CREATE INDEX idx_review_events_draft_id_created_at
  ON review_events (draft_id, created_at DESC);

CREATE INDEX idx_sync_runs_started_at
  ON sync_runs (started_at DESC);
