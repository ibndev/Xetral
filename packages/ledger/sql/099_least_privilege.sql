-- ============================================================================
--  022 — Least privilege for the application role.
--
--  WHAT THIS CLOSES, DEMONSTRATED RATHER THAN ARGUED. `011_ledger_immutability.sql`
--  puts a BEFORE UPDATE OR DELETE trigger on `journal_entries` and `postings`,
--  and that trigger is the thing standing between us and a rewritten financial
--  history. But the application connects as the role that OWNS those tables,
--  and a table's owner can turn its triggers off:
--
--      ALTER TABLE postings DISABLE TRIGGER USER;   -- ALTER TABLE
--      UPDATE postings SET amount_minor = …;        -- and now it works
--
--  So the immutability guarantee was really "nobody runs two statements". One
--  SQL injection reaching a second statement, one migration written in a hurry,
--  one operator with the application's own credentials — and the trigger is
--  gone with no trace beyond the balance drift it leaves behind.
--
--  OWNERSHIP IS THE PRIVILEGE THAT MATTERS HERE. Taking it away is what makes
--  the trigger un-removable by the application, and it is the reason this
--  migration exists at all rather than being a tidy-up.
--
--  THE GRANT MATRIX MIRRORS THE APPEND-ONLY RULES, so the two cannot drift:
--
--    append-only    SELECT, INSERT           journal_entries, postings,
--                                            admin_audit_log, card_reveals,
--                                            provider_balance_checks
--    retention      DELETE via a function     the tables the sweep prunes
--    everything     SELECT, INSERT, UPDATE    the rest
--
--  THE THIRD LINE IS NOT LAZINESS. Most tables here carry a PARTIAL
--  immutability trigger rather than a total one: a refresh token permits
--  consumption and refuses every other change, a deposit permits a suspense
--  resolution, a card freeze permits nothing but an insert. Revoking UPDATE
--  from those to satisfy a rule about the trigger's NAME would break the
--  product without adding a guarantee — the trigger already refuses the writes
--  that matter, and it does so for the owner too. What is revoked here is what
--  no correct code path ever needs.
--
--  A table that gains an append-only trigger later must be added to the first
--  list; `022_least_privilege.test.sql` fails the build if a table with such a
--  trigger still carries UPDATE or DELETE for the application role.
--
--  RUN THIS AS THE OWNER, AND RUN IT LAST. It grants against every table in the
--  schema, so a migration added after it arrives with no grant at all and the
--  application cannot read it. Numbered 099 rather than taking the next number
--  in sequence, so that ordering is stated by the filename instead of being a
--  fact somebody has to remember.
-- ============================================================================

BEGIN;

/**
 * The runtime role.
 *
 * NOLOGIN and no password here, deliberately: a password in a migration is a
 * password in git. The operator grants LOGIN and sets one out of band —
 * `deploy/README.md` says how — and points `DATABASE_URL` at it.
 */
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xetral_app') THEN
        CREATE ROLE xetral_app NOLOGIN;
    END IF;
END $$;

/**
 * No CREATE on the schema, for the application or for PUBLIC.
 *
 * Without this the app can create its own table, and a role that can create a
 * table owns it — which is the ownership problem again by another route.
 */
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM xetral_app;
GRANT USAGE ON SCHEMA public TO xetral_app;

/**
 * The tables whose history must never be rewritten.
 *
 * Written out rather than derived, because this list is the security decision
 * and a reader should be able to check it against the triggers by eye.
 */
DO $$
DECLARE
    v_append_only TEXT[] := ARRAY[
        'journal_entries',
        'postings',
        'admin_audit_log',
        'card_reveals',
        'provider_balance_checks',
        -- The record of where every sign-in came from, successes and failures
        -- alike. Its own trigger permits a DELETE only for rows past the
        -- retention window; taking the grant away as well means the
        -- application cannot even attempt one, at any age.
        'sign_in_events'
    ];
    v_table TEXT;
BEGIN
    -- Start from nothing rather than from ALL and subtract: a table added
    -- later then arrives with no grant and fails loudly, instead of silently
    -- inheriting write access.
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM xetral_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO xetral_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO xetral_app';

    FOREACH v_table IN ARRAY v_append_only LOOP
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table) THEN
            EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM xetral_app', v_table);
        END IF;
    END LOOP;
END $$;

/**
 * Deletion happens through a FUNCTION, never through a grant.
 *
 * The retention sweep is the only thing here that removes rows, and it now runs
 * as the OWNER rather than as the caller. That inverts the usual worry in the
 * right direction: the application can ask for the sweep and cannot delete a
 * row any other way, so "what may be deleted" is decided by the body of
 * `apply_retention()` — which names its tables literally and contains no
 * dynamic SQL — rather than by a permission somebody granted once.
 */
ALTER FUNCTION apply_retention() SECURITY DEFINER;
REVOKE ALL ON FUNCTION apply_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_retention() TO xetral_app;

/**
 * The same for every function that writes where a trigger otherwise refuses.
 *
 * `rotate_refresh_token` and `consume_password_reset_token` set `consumed_at`,
 * which the append-only triggers in `002_identity.sql` and `013` refuse from
 * anywhere else. They were already the only sanctioned path; running them as
 * the owner makes that structural rather than customary.
 *
 * THE SIGNATURE IS READ FROM THE CATALOGUE, not written out. Written out, this
 * block guessed `(TEXT, TEXT, INTEGER)` for a function that actually takes
 * `(text, text, interval)` and the migration failed — which is the good
 * outcome, but the same guess in a GRANT that happened to match a real
 * overload would have granted against the wrong function silently.
 */
DO $$
DECLARE
    v_named TEXT[] := ARRAY['rotate_refresh_token', 'consume_password_reset_token'];
    v_signature TEXT;
BEGIN
    FOR v_signature IN
        SELECT format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY(v_named)
    LOOP
        EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', v_signature);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO xetral_app', v_signature);
    END LOOP;
END $$;

COMMIT;
