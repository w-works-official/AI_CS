-- View-only marketplace image metadata. Image bytes and credentials are never stored in D1.

CREATE TABLE cs_message_attachments (
  attachment_key TEXT PRIMARY KEY,
  message_key TEXT NOT NULL REFERENCES cs_messages(message_key) ON DELETE CASCADE,
  case_key TEXT NOT NULL REFERENCES cs_cases(case_key) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  asset_url TEXT,
  thumbnail_url TEXT,
  alt_text_masked TEXT,
  media_type TEXT NOT NULL DEFAULT 'IMAGE' CHECK (media_type = 'IMAGE'),
  access_state TEXT NOT NULL CHECK (access_state IN ('PUBLIC_URL', 'SESSION_REQUIRED', 'UNAVAILABLE')),
  captured_run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (message_key, ordinal)
);

CREATE INDEX idx_cs_message_attachments_case_message
  ON cs_message_attachments (case_key, message_key, ordinal);

PRAGMA optimize;
