CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS repos (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('github','local','page')),
  source        text NOT NULL UNIQUE,      -- normalized URL or absolute path
  title         text NOT NULL,
  commit_sha    text,                      -- NULL for pages/local without git
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','indexing','ready','failed')),
  stats         jsonb NOT NULL DEFAULT '{}',  -- files, chunks, skipped, seconds
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (             -- full text for the code viewer
  repo_id     bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path        text NOT NULL,
  lang        text,
  content     text NOT NULL,
  PRIMARY KEY (repo_id, path)
);

CREATE TABLE IF NOT EXISTS chunks (
  id           bigserial PRIMARY KEY,
  repo_id      bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  strategy     text NOT NULL CHECK (strategy IN ('ast','line')),
  path         text NOT NULL,
  start_line   int  NOT NULL,
  end_line     int  NOT NULL,
  lang         text,
  symbol       text,                       -- e.g. "AuthService.login"; NULL for line chunks
  content      text NOT NULL,
  search_text  text NOT NULL,              -- content + path + split identifiers
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  embedding    vector(768) NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_repo_strategy ON chunks (repo_id, strategy);
CREATE INDEX IF NOT EXISTS chunks_tsv  ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS jobs (
  id          bigserial PRIMARY KEY,
  repo_id     bigint REFERENCES repos(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('index','eval')),
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','failed')),
  progress    int  NOT NULL DEFAULT 0,     -- 0..100
  message     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS eval_questions (
  id          bigserial PRIMARY KEY,
  repo_id     bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  question    text NOT NULL,
  gold_path   text NOT NULL,
  gold_start  int  NOT NULL,
  gold_end    int  NOT NULL,
  origin      text NOT NULL CHECK (origin IN ('synthetic','manual'))
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id          bigserial PRIMARY KEY,
  repo_id     bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  mode        text NOT NULL,   -- keyword | vector | hybrid | hybrid_rerank
  strategy    text NOT NULL,   -- ast | line
  n           int  NOT NULL,
  hit_at_5    real NOT NULL,
  mrr_at_10   real NOT NULL,
  p50_ms      real NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repo_artifacts (     -- cached diagram + tour
  repo_id     bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('diagram','tour')),
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, kind)
);
