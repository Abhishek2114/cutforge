-- Proves per-user isolation in docs/data-model.sql. Run after loading it, as a superuser.
\set ON_ERROR_STOP on

CREATE ROLE app_user NOLOGIN;   -- not owner, not superuser, so RLS applies
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO app_user;

INSERT INTO users (id, phone_e164) VALUES
  ('00000000-0000-0000-0000-00000000000a', '+919800000001'),
  ('00000000-0000-0000-0000-00000000000b', '+919800000002');
INSERT INTO projects (owner_id, name, schema_version, doc) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'A', 1, '{}'),
  ('00000000-0000-0000-0000-00000000000b', 'B', 1, '{}');

SET ROLE app_user;

-- No user set: sees nothing (fail closed, no error).
DO $$ BEGIN
  IF (SELECT count(*) FROM projects) <> 0 THEN RAISE EXCEPTION 'unset user sees rows'; END IF;
END $$;

SET app.user_id = '00000000-0000-0000-0000-00000000000a';
DO $$ BEGIN
  IF (SELECT count(*) FROM projects) <> 1 OR (SELECT name FROM projects) <> 'A' THEN
    RAISE EXCEPTION 'user A does not see exactly own project';
  END IF;
END $$;

-- Writing a row for another user is rejected.
DO $$ BEGIN
  INSERT INTO projects (owner_id, name, schema_version, doc)
    VALUES ('00000000-0000-0000-0000-00000000000b', 'X', 1, '{}');
  RAISE EXCEPTION 'cross-user insert allowed';
EXCEPTION WHEN insufficient_privilege THEN NULL;  -- expected: RLS violation
END $$;

-- Reset to empty string: still nothing, still no cast error.
RESET app.user_id;
DO $$ BEGIN
  IF (SELECT count(*) FROM projects) <> 0 THEN RAISE EXCEPTION 'reset user sees rows'; END IF;
END $$;

\echo 'ok: RLS isolation holds'
