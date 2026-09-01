ALTER TABLE draft_decisions
  ADD COLUMN required_checks_json TEXT NOT NULL DEFAULT '[]';

PRAGMA optimize;
