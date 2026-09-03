-- Sanitized inquiry-screen captures only. Raw marketplace screenshots are never persisted.
CREATE TABLE cs_case_snapshots (
  case_key TEXT PRIMARY KEY REFERENCES cs_cases(case_key) ON DELETE CASCADE,
  mime_type TEXT NOT NULL CHECK (mime_type = 'image/jpeg'),
  data_base64 TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0 AND width <= 2400),
  height INTEGER NOT NULL CHECK (height > 0 AND height <= 12000),
  redaction_state TEXT NOT NULL CHECK (redaction_state = 'MASKED_DOM'),
  captured_at TEXT NOT NULL,
  captured_run_id TEXT NOT NULL REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cs_case_snapshots_captured_at
  ON cs_case_snapshots (captured_at DESC);
