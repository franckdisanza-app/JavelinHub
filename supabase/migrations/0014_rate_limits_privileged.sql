-- ===========================================================================
-- 0014_rate_limits_privileged.sql — 0013's function could not reach 0013's
-- table.
-- ===========================================================================
--
-- `consume_rate_limit()` returned, for every call:
--
--     42501  permission denied for table rate_limits
--
-- Caught by `npm run verify:supabase` on the first run after 0013 was pushed,
-- which is precisely the class of failure that suite exists for: the function
-- is SECURITY DEFINER, it is unreachable from the mock, and nothing in
-- `verify:authz` or `verify:pages` executes a line of it. The mock twin was
-- green throughout.
--
-- TWO SEPARATE THINGS WERE MISSING, and either alone still fails:
--
--   1. **The GRANT.** SECURITY DEFINER makes the function run as
--      `javelin_privileged`, and that role holds only USAGE on the schema. It
--      is not the table's owner — 0013 creates the table as the MIGRATION role
--      — so it inherits no implicit rights and needs privileges named for it,
--      exactly as 0002 names them for `profiles`, `invites` and the rest.
--
--   2. **The POLICY.** RLS applies to a non-owner however it got there, and
--      0013 enables RLS with no policies at all. Without one admitting the
--      privileged role, the INSERT is refused and — more quietly — the UPDATE
--      and the housekeeping DELETE would match no row and silently do nothing.
--
-- The mistake was reading "SECURITY DEFINER" as "bypasses RLS". It does not.
-- It changes WHO the statement runs as; row-level security then applies to that
-- role like anyone else. `0002_rls.sql` already knew this — it pairs every
-- privileged grant with a `*_privileged` policy — and 0013 copied the table and
-- not the pairing.
--
-- 0013 IS LEFT AS IT WAS APPLIED rather than edited, on the same principle that
-- keeps 0004 in the tree as the record of a dead end: a migration file that no
-- longer matches what ran against the database is worse than a migration that
-- needed a follow-up.

grant select, insert, update, delete on public.rate_limits to javelin_privileged;

drop policy if exists rate_limits_privileged on public.rate_limits;
create policy rate_limits_privileged
  on public.rate_limits for all to javelin_privileged
  using (true) with check (true);

-- Still no policy for `anon` or `authenticated`, and there must never be one.
-- The table's buckets are derived from email addresses, so a readable
-- `rate_limits` is an "has this person asked for a password reset" oracle, and
-- with patience an address enumerator. `consume_rate_limit()` returns a boolean
-- and is the only way in.

comment on policy rate_limits_privileged on public.rate_limits is
  'The only policy on this table, and it admits only javelin_privileged - the role consume_rate_limit() runs as. SECURITY DEFINER does not bypass RLS; it changes which role the policies are evaluated for.';
