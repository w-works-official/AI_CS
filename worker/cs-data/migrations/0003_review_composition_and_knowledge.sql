-- Derived, masked-only review knowledge. No marketplace mutation state is stored here.

ALTER TABLE review_events ADD COLUMN composition_source_type TEXT
  CHECK (composition_source_type IN ('AI_DRAFT', 'REPLY_TEMPLATE', 'ANSWER_LIBRARY_ENTRY', 'MANUAL'));
ALTER TABLE review_events ADD COLUMN composition_source_id TEXT;
ALTER TABLE review_events ADD COLUMN composition_source_version TEXT;
ALTER TABLE review_events ADD COLUMN base_text_hash TEXT;
ALTER TABLE review_events ADD COLUMN final_text_hash TEXT;
ALTER TABLE review_events ADD COLUMN unresolved_variables_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE review_events ADD COLUMN source_content_hash TEXT;

CREATE TABLE case_summaries (
  case_key TEXT PRIMARY KEY REFERENCES cs_cases(case_key) ON DELETE CASCADE,
  summary_text_masked TEXT NOT NULL,
  summary_version TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  pii_scan TEXT NOT NULL CHECK (pii_scan = 'PASS'),
  created_run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE answer_library_entries (
  library_entry_id TEXT PRIMARY KEY,
  case_key TEXT NOT NULL REFERENCES cs_cases(case_key) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'ACTUAL_SELLER_REPLY',
    'REVIEWED_AI_REVISION',
    'REVIEWED_TEMPLATE_REVISION',
    'MANUAL_REVIEW_REPLY'
  )),
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  question_text_masked TEXT NOT NULL,
  answer_text_masked TEXT NOT NULL,
  market TEXT NOT NULL,
  channel TEXT NOT NULL,
  intent TEXT,
  quality_state TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (quality_state IN ('CANDIDATE', 'USE', 'EXCLUDE')),
  review_note_masked TEXT,
  reviewed_at TEXT,
  reviewer_ref TEXT,
  source_content_hash TEXT NOT NULL,
  pii_scan TEXT NOT NULL CHECK (pii_scan = 'PASS'),
  created_run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_type, source_id, source_version)
);

CREATE TABLE no_reply_patterns (
  pattern_id TEXT PRIMARY KEY,
  case_key TEXT NOT NULL REFERENCES cs_cases(case_key) ON DELETE CASCADE,
  pattern_text_masked TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  quality_state TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (quality_state IN ('CANDIDATE', 'USE', 'EXCLUDE')),
  source_content_hash TEXT NOT NULL,
  pii_scan TEXT NOT NULL CHECK (pii_scan = 'PASS'),
  created_run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (case_key, source_content_hash, pattern_text_masked)
);

CREATE TABLE reply_templates (
  template_id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL,
  template_version TEXT NOT NULL,
  template_name_masked TEXT NOT NULL,
  template_text_masked TEXT NOT NULL,
  market TEXT,
  channel TEXT,
  intent TEXT,
  required_checks_json TEXT NOT NULL DEFAULT '[]',
  quality_state TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (quality_state IN ('CANDIDATE', 'USE', 'EXCLUDE')),
  pii_scan TEXT NOT NULL CHECK (pii_scan = 'PASS'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (template_key, template_version)
);

CREATE INDEX idx_answer_library_entries_quality_updated_at
  ON answer_library_entries (quality_state, updated_at DESC);
CREATE INDEX idx_answer_library_entries_market_channel_intent
  ON answer_library_entries (market, channel, intent, updated_at DESC);
CREATE INDEX idx_no_reply_patterns_quality_updated_at
  ON no_reply_patterns (quality_state, updated_at DESC);
CREATE INDEX idx_reply_templates_quality_updated_at
  ON reply_templates (quality_state, updated_at DESC);
CREATE INDEX idx_review_events_composition_source
  ON review_events (composition_source_type, composition_source_id, created_at DESC);

PRAGMA optimize;
