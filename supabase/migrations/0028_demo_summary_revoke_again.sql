-- ===========================================================================
-- 0028_demo_summary_revoke_again.sql — the revoke 0027 dropped on the floor.
-- ===========================================================================
--
-- `0027` extended `demo_data_summary` to cover three more tables, and did it the
-- only way a view can be extended: `drop view` then `create view`. **That threw
-- away the grants**, and on Supabase a freshly created view does not come back
-- ungranted — the project bootstrap runs
--
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated, service_role;
--
-- so the new view was immediately readable by the publishable key. `0007` had
-- closed exactly that leak on exactly this view, and `0027` re-opened it about
-- ninety seconds after somebody wrote a migration whose header talks about
-- being careful.
--
-- `verify:supabase` caught it on the next run, which is the reason that
-- assertion exists: 0007's own header says checking against the live project
-- with the publishable key is what found it the first time.
--
-- -----------------------------------------------------------------------------
-- THE RULE, since this is now the third time this schema has met it
-- -----------------------------------------------------------------------------
-- On this project, CREATING ANYTHING IN `public` GRANTS IT TO `anon` AND
-- `authenticated` BY DEFAULT. That applies to tables, to views, and — as `0024`
-- found the hard way, with an endpoint that let anonymous callers forge audit
-- rows — to functions.
--
-- So: any `create view` in `public` that is not meant to be public must be
-- followed by its revoke IN THE SAME MIGRATION, and `drop view` + `create view`
-- counts as creating it again. A revoke in an earlier migration does not
-- survive the object being replaced.

revoke all on public.demo_data_summary from anon, authenticated;

comment on view public.demo_data_summary is
  'Counts of fabricated rows per table, across all nine tables that carry is_demo. REVOKED from anon and authenticated (0007, and again in 0028 after 0027 recreated the view) - readable only with direct database access, because it is a pre-launch check rather than something the app shows. `select * from public.demo_data_summary where rows > 0;`';
