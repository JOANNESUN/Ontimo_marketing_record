-- One table of JSON documents, grouped by collection
-- (promoters, locations, contacts, sessions, inspo, stock, settings).
-- Deleted rows stay as tombstones (deleted = 1) so other phones learn about the delete on their next sync.
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS docs_updated_at ON docs (updated_at);
