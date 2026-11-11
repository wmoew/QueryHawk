-- QueryHawk app database schema
--
-- Creates every table the backend uses. Safe to run more than once: all
-- statements are idempotent, and existing databases are upgraded in place.
--
-- Run it once against your own Supabase project:
--   Supabase dashboard -> SQL Editor -> paste this file -> Run
-- or from a shell:
--   psql "$POSTGRES_URI" -f server/db/migrations.sql
--
-- user_account.user_id links to Supabase's built-in auth.users table, which
-- the GitHub OAuth flow (server/models/OAuthModel.ts) writes to.

-- ---------- Users ----------
CREATE TABLE IF NOT EXISTS user_account (
  id          SERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  email       TEXT,
  password    TEXT,
  first_name  TEXT,
  last_name   TEXT,
  github_id   TEXT UNIQUE,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_account_email ON user_account(email);

-- ---------- Saved queries ----------
CREATE TABLE IF NOT EXISTS queries (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  query_name  TEXT,
  query_text  TEXT NOT NULL,
  uri_string  TEXT,
  query_hash  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upgrade older databases created before these columns existed
ALTER TABLE queries ADD COLUMN IF NOT EXISTS uri_string TEXT;
ALTER TABLE queries ADD COLUMN IF NOT EXISTS query_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_queries_user_id ON queries(user_id);
CREATE INDEX IF NOT EXISTS idx_queries_query_hash ON queries(query_hash);

-- ---------- EXPLAIN ANALYZE results ----------
CREATE TABLE IF NOT EXISTS metrics (
  id                  SERIAL PRIMARY KEY,
  query_id            INTEGER NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  execution_time      DOUBLE PRECISION DEFAULT 0,
  planning_time       DOUBLE PRECISION DEFAULT 0,
  rows_returned       BIGINT DEFAULT 0,
  actual_loops        BIGINT DEFAULT 0,
  shared_hit_blocks   BIGINT DEFAULT 0,
  shared_read_blocks  BIGINT DEFAULT 0,
  work_mem            INTEGER DEFAULT 0,
  cache_hit_ratio     DECIMAL(5,2) DEFAULT 0,
  startup_cost        DOUBLE PRECISION DEFAULT 0,
  total_cost          DOUBLE PRECISION DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE metrics ADD COLUMN IF NOT EXISTS shared_hit_blocks BIGINT DEFAULT 0;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS shared_read_blocks BIGINT DEFAULT 0;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS cache_hit_ratio DECIMAL(5,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_metrics_query_id ON metrics(query_id);

-- ---------- Monitored databases (one per user) ----------
CREATE TABLE IF NOT EXISTS user_connections (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES user_account(id) ON DELETE CASCADE,
  uri_string  TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_connections_active
  ON user_connections(is_active) WHERE is_active = true;

-- ---------- Convenience view ----------
CREATE OR REPLACE VIEW query_analysis_view AS
SELECT
  q.id,
  q.query_name,
  q.query_text,
  q.created_at,
  m.execution_time,
  m.planning_time,
  m.total_cost,
  m.shared_hit_blocks,
  m.shared_read_blocks,
  m.cache_hit_ratio,
  m.rows_returned,
  m.actual_loops,
  m.startup_cost,
  q.user_id
FROM queries q
JOIN metrics m ON q.id = m.query_id;

-- These tables hold connection strings (with passwords) and are only meant
-- to be read by the backend, which connects as the database owner. Turning
-- on row level security with no policies blocks Supabase's public REST API
-- (anon / authenticated roles) from reading them.
ALTER TABLE user_account     ENABLE ROW LEVEL SECURITY;
ALTER TABLE queries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_connections ENABLE ROW LEVEL SECURITY;

-- Supabase grants anon/authenticated access to new objects in public by
-- default, and views skip RLS, so revoke that access from the view as well.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON query_analysis_view FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON query_analysis_view FROM authenticated;
  END IF;
END $$;
