-- ===========================================================================
-- 0024_close_record_admin_action.sql — the revoke that 0019 thought it had made.
-- ===========================================================================
--
-- **`record_admin_action()` was callable by anonymous clients.** A POST to
-- `/rest/v1/rpc/record_admin_action` from the browser key answered `204` and
-- appended a row to `admin_actions`. Anybody on the internet could write
-- arbitrary lines into the audit log — with `actor_id` null, since `jwt_uid()`
-- is null for anon, so they read as "a deleted account" on `/admin/reports`.
--
-- Nothing else was reachable: every other privileged function guards itself
-- (`is_admin()`, or a null-`jwt_uid()` check) and refuses anon with its own
-- sentence. This one had no guard at all, because `0019` believed it had made
-- the function unreachable and therefore did not need one.
--
-- -----------------------------------------------------------------------------
-- WHY THE REVOKE IN 0019 DID NOTHING
-- -----------------------------------------------------------------------------
-- `0019` ends with
--
--   revoke all on function public.record_admin_action(...) from public;
--
-- which is the correct incantation on a stock Postgres, where `EXECUTE` on a new
-- function is granted to the `PUBLIC` pseudo-role by default and revoking from
-- `PUBLIC` is how you take it back.
--
-- A Supabase project is not a stock Postgres. Its bootstrap runs
--
--   alter default privileges in schema public
--     grant all on functions to anon, authenticated, service_role;
--
-- so every function created in `public` also receives an **explicit** grant to
-- each of those three roles. Revoking from `PUBLIC` does not touch an explicit
-- grant to a named role — they are separate entries in `proacl` — so the
-- function stayed executable by `anon` and by `authenticated`.
--
-- Every other privileged function in this schema carries the same invisible
-- grant. That is harmless for them and asserted to be: `scripts/probe-grants.mjs`
-- calls all fifteen client-reachable functions as anon, and everything except
-- this one answers 401 with its own refusal.
--
-- -----------------------------------------------------------------------------
-- THE RULE FOR EVERY FUTURE MIGRATION
-- -----------------------------------------------------------------------------
-- `revoke ... from public` is not enough to make a function unreachable here.
-- A function that no client should call must revoke from the three named roles
-- as well, exactly as below — and `verify:supabase` now asserts this one, so a
-- regression fails a suite rather than waiting to be noticed.
--
-- The alternative fix — moving the writer into a `private` schema PostgREST does
-- not expose — is structurally better and was not chosen here: it would mean
-- re-creating the five functions that call it, verbatim, to change one qualified
-- name in each, and every one of those bodies is a security boundary of its own.
-- Five re-typed boundaries to avoid one revoke is the worse trade.

revoke execute on function public.record_admin_action(public.admin_action_kind, uuid, text)
  from anon, authenticated, public;

-- `service_role` keeps nothing here either. It bypasses RLS by design, but this
-- function exists so that the audit table has exactly one writer reachable from
-- exactly one place, and a server-side key is not that place.
revoke execute on function public.record_admin_action(public.admin_action_kind, uuid, text)
  from service_role;

-- The owner keeps it, which is the only grant that was ever needed: the five
-- callers (`grant_admin`, `review_coach_application`, `remove_review`,
-- `resolve_report`, `set_coach_status`) are all SECURITY DEFINER functions owned
-- by `javelin_privileged`, so the nested call runs as the owner regardless of
-- who invoked the outer function.

comment on function public.record_admin_action(public.admin_action_kind, uuid, text) is
  'Appends one row to admin_actions. Called only from inside other privileged functions, and executable ONLY by javelin_privileged - 0024 revoked the anon/authenticated/service_role grants that Supabase default privileges had added behind 0019''s back.';
