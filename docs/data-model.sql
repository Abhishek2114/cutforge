-- CutForge — Postgres 16 data model (reference DDL; becomes Alembic migration 0001 in Deliverable 2).
-- Times inside media are integer flicks (705,600,000 per second), stored as bigint.
-- Every user-owned row carries owner_id; RLS policies (bottom) are defence in depth on top of API checks.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy search across Devanagari + Roman text
CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────────────────── Users & auth ─────────────────────────
CREATE TYPE plan_tier AS ENUM ('free', 'creator', 'pro');

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164      text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email           citext UNIQUE,
  google_sub      text UNIQUE,
  display_name    text NOT NULL DEFAULT '' CHECK (length(display_name) <= 100),
  ui_locale       text NOT NULL DEFAULT 'hi' CHECK (ui_locale IN ('hi', 'en')),
  plan            plan_tier NOT NULL DEFAULT 'free',
  birth_year      smallint CHECK (birth_year BETWEEN 1900 AND 2100),   -- DPDP age gate
  guardian_consent_at timestamptz,                                      -- required when under 18
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,                                          -- erasure requested; purge job hard-deletes
  CHECK (phone_e164 IS NOT NULL OR google_sub IS NOT NULL)
);

CREATE TABLE otp_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164      text NOT NULL,
  code_hash       text NOT NULL,                     -- argon2id; plain code never stored
  attempts        smallint NOT NULL DEFAULT 0 CHECK (attempts <= 5),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_phone_recent ON otp_challenges (phone_e164, created_at DESC);

CREATE TABLE refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id       uuid NOT NULL,                     -- rotation family; reuse of a rotated token revokes the family
  token_hash      bytea NOT NULL UNIQUE,             -- sha256 of opaque token
  device_label    text NOT NULL DEFAULT '',
  expires_at      timestamptz NOT NULL,
  rotated_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Billing & quotas ─────────────────────────
CREATE TABLE subscriptions (
  owner_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan                     plan_tier NOT NULL,
  razorpay_subscription_id text UNIQUE,
  status                   text NOT NULL CHECK (status IN ('created','active','pending','halted','cancelled','completed')),
  current_period_end       timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE usage_metric AS ENUM ('storage_bytes', 'transcribe_seconds', 'translate_chars', 'cloud_export_seconds', 'ai_clip_jobs');

-- Append-only ledger; quota checks sum the current period. Storage is a signed delta (+upload, -delete).
CREATE TABLE usage_ledger (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric          usage_metric NOT NULL,
  amount          bigint NOT NULL,
  job_id          uuid,
  asset_id        uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_owner_metric_time ON usage_ledger (owner_id, metric, created_at);

-- ───────────────────────── Assets ─────────────────────────
CREATE TYPE asset_kind   AS ENUM ('video', 'audio', 'image', 'lut');
CREATE TYPE asset_status AS ENUM ('uploading', 'processing', 'ready', 'failed', 'quarantined', 'deleted');

CREATE TABLE assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              asset_kind,                           -- NULL until magic bytes are sniffed
  status            asset_status NOT NULL DEFAULT 'uploading',
  original_filename text NOT NULL CHECK (length(original_filename) <= 255),
  declared_size     bigint NOT NULL CHECK (declared_size > 0),
  size_bytes        bigint,
  sniffed_mime      text,                                 -- from libmagic, never from the extension
  sha256            bytea,
  duration_flicks   bigint CHECK (duration_flicks >= 0),
  probe             jsonb,                                -- trimmed ffprobe: streams, codecs, color tags, rotation
  log_profile       text CHECK (log_profile IN ('none','slog3','applelog','dlogm','vlog','hlg','pq','unknown')),
  source_url        text,                                 -- URL import provenance
  tus_upload_id     text UNIQUE,
  failure_reason    text,
  -- S3 keys, all under u/{owner_id}/a/{id}/
  key_original      text,
  key_proxy         text,
  key_thumbs        text,
  key_thumbs_index  text,
  key_peaks         text,
  key_audio16k      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  ready_at          timestamptz,
  deleted_at        timestamptz
);
CREATE INDEX assets_owner_recent ON assets (owner_id, created_at DESC) WHERE deleted_at IS NULL;

-- ───────────────────────── Projects ─────────────────────────
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  schema_version  integer NOT NULL,
  revision        bigint NOT NULL DEFAULT 0,
  doc             jsonb NOT NULL,                       -- current project document (validated against project.schema.json)
  key_thumbnail   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX projects_owner_recent ON projects (owner_id, updated_at DESC) WHERE deleted_at IS NULL;

-- Op log for sync; rows older than the newest version snapshot are pruned.
CREATE TABLE project_ops (
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision        bigint NOT NULL,                      -- revision produced by this op batch
  client_id       text NOT NULL,
  patches         jsonb NOT NULL,                       -- RFC 6902 array
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, revision)
);

CREATE TYPE version_kind AS ENUM ('auto', 'manual', 'conflict', 'pre_migration');

CREATE TABLE project_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision        bigint NOT NULL,
  schema_version  integer NOT NULL,
  kind            version_kind NOT NULL,
  label           text NOT NULL DEFAULT '',
  doc             jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_versions_recent ON project_versions (project_id, created_at DESC);

-- Which assets a project references: access checks for render jobs + storage GC refcount.
-- Maintained by the API on every ops write (diff of doc.assets keys).
CREATE TABLE project_assets (
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES assets(id),
  PRIMARY KEY (project_id, asset_id)
);
CREATE INDEX project_assets_asset ON project_assets (asset_id);

-- ───────────────────────── Jobs ─────────────────────────
CREATE TYPE job_type AS ENUM (
  'ingest', 'import_url', 'transcribe', 'translate', 'transliterate', 'fix_subtitles',
  'diarize', 'scenes', 'reframe', 'highlights', 'export'
);
CREATE TYPE job_status AS ENUM ('queued', 'running', 'delayed', 'succeeded', 'failed', 'canceled');

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            job_type NOT NULL,
  status          job_status NOT NULL DEFAULT 'queued',
  priority        smallint NOT NULL DEFAULT 5,          -- paid plans get lower numbers
  asset_id        uuid REFERENCES assets(id),
  project_id      uuid REFERENCES projects(id),
  parent_job_id   uuid REFERENCES jobs(id),
  idempotency_key text,
  params          jsonb NOT NULL DEFAULT '{}',
  progress        real NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  eta_seconds     integer,
  checkpoint      jsonb,                                -- e.g. completed chunk/segment indexes, for resume
  result          jsonb,                                -- small results inline; large ones reference S3 keys
  error           jsonb,                                -- {code, message, retryable}
  attempts        smallint NOT NULL DEFAULT 0,
  celery_task_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  heartbeat_at    timestamptz,                          -- reaper requeues running jobs with stale heartbeat
  finished_at     timestamptz,
  UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX jobs_owner_recent ON jobs (owner_id, created_at DESC);
CREATE INDEX jobs_active ON jobs (status, heartbeat_at) WHERE status IN ('queued', 'running', 'delayed');

-- ───────────────────────── Transcripts ─────────────────────────
-- One row per (asset, model run). Word arrays live in S3 (1 h ≈ 1 MB); the row holds metadata + full text for search.
CREATE TABLE transcripts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  job_id          uuid REFERENCES jobs(id),
  language        text NOT NULL CHECK (language IN ('hi', 'en', 'hi-Latn', 'mixed')),
  script          text NOT NULL CHECK (script IN ('Deva', 'Latn')),
  kind            text NOT NULL CHECK (kind IN ('transcript', 'translation', 'transliteration')),
  derived_from    uuid REFERENCES transcripts(id),
  model           text NOT NULL,
  model_version   text NOT NULL,
  key_words       text NOT NULL,                        -- S3 JSON: segments[{start,end,text,words[{text,start,end,conf}]}]
  full_text       text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcripts_asset ON transcripts (asset_id, created_at DESC);

-- ───────────────────────── Clip library ─────────────────────────
CREATE TABLE library_clips (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  start_flicks    bigint NOT NULL CHECK (start_flicks >= 0),
  end_flicks      bigint NOT NULL,
  title           text NOT NULL DEFAULT '',
  tags            text[] NOT NULL DEFAULT '{}',
  transcript_text text NOT NULL DEFAULT '',             -- original script
  transcript_latn text NOT NULL DEFAULT '',             -- romanised copy so "matlab" finds "मतलब"
  score           real CHECK (score BETWEEN 0 AND 1),   -- highlight score when AI-suggested
  reason          text,
  source          text NOT NULL CHECK (source IN ('manual', 'highlight', 'scene')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_flicks > start_flicks)
);
CREATE INDEX library_owner_recent ON library_clips (owner_id, created_at DESC);
CREATE INDEX library_tags ON library_clips USING gin (tags);
-- No Hindi stemmer in Postgres: trigram search over title + both scripts.
CREATE INDEX library_search_trgm ON library_clips
  USING gin ((title || ' ' || transcript_text || ' ' || transcript_latn) gin_trgm_ops);

-- ───────────────────────── Custom dictionary & fillers ─────────────────────────
CREATE TABLE dictionary_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('name', 'brand', 'term', 'filler')),
  term            text NOT NULL CHECK (length(term) BETWEEN 1 AND 100),   -- preferred spelling (any script)
  variants        text[] NOT NULL DEFAULT '{}',                           -- misspellings / other-script forms
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, kind, term)
);

-- ───────────────────────── Row-level security (defence in depth) ─────────────────────────
-- API sets per-transaction: SET LOCAL app.user_id = '<uuid>'. Unset or empty = no rows. Workers use a role with BYPASSRLS.
ALTER TABLE assets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_clips      ENABLE ROW LEVEL SECURITY;
ALTER TABLE dictionary_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger       ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_only ON assets             USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY owner_only ON projects           USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY owner_only ON jobs               USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY owner_only ON transcripts        USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY owner_only ON library_clips      USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY owner_only ON dictionary_entries USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY owner_only ON usage_ledger       USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
-- project_ops / project_versions / project_assets are reached only through a project the caller owns (API joins on projects).
