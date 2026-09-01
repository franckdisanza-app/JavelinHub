-- ===========================================================================
-- 0031_close_grant_admin.sql — the second instance of 0024's trap.
-- ===========================================================================
--
-- !! NOT APPLIED. Push it, then re-run `npm run verify:supabase`. !!
--
-- ---------------------------------------------------------------------------
-- THE TRAP, RESTATED, BECAUSE IT WILL HAPPEN AGAIN
-- ---------------------------------------------------------------------------
-- Supabase's project bootstrap runs
--
--   alter default privileges in schema public
--     grant all on functions to anon, authenticated, service_role;
--
-- so EVERY function created in `public` is born with an explicit EXECUTE grant
-- to those three roles. `revoke all on function … from public` does not touch
-- an explicit grant to a named role — `public` is the pseudo-role, not "all
-- roles" — so the idiom this schema uses everywhere revokes nothing that the
-- bootstrap added.
--
-- 0019 hit this with `record_admin_action()`: for five migrations any anonymous
-- caller could POST to `/rest/v1/rpc/record_admin_action` and append a forged
-- line to the audit log. 0024 is the revoke that actually closed it and 0025
-- deleted the rows the probe wrote.
--
-- ---------------------------------------------------------------------------
-- `grant_admin` IS THE SAME SHAPE, AND ITS COMMENT SAYS OTHERWISE
-- ---------------------------------------------------------------------------
-- 0002 ends with:
--
--   > -- grant_admin is intentionally NOT granted to authenticated: an existing
--   > -- admin runs it from the SQL editor.
--
-- and then issues only `revoke all on function public.grant_admin(uuid) from
-- public`. 0019 repeats exactly the same pair. So the sentence describes an
-- intent that the SQL beneath it does not implement: the bootstrap's grant to
-- `anon`, `authenticated` and `service_role` is almost certainly still there.
--
-- **The function is not exploitable, and that is the point worth being precise
-- about.** Its body opens with
--
--   if not (public.is_admin() or session_user <> 'authenticator') then raise …
--
-- and every PostgREST request — anon, authenticated and service_role alike —
-- arrives on a connection whose `session_user` is `authenticator`. So a
-- non-admin caller is refused by the body whatever the grant says, and
-- `verify:supabase` confirms it live:
--
--   PASS  grant_admin is not callable through the API
--         42501: Only an administrator can grant administrator access.
--
-- What is wrong is therefore not an open door but a MISATTRIBUTED CONTROL. A
-- reader of 0002 believes the grant is what protects the most privileged
-- function in the schema; it is the body. Anybody who later relaxes that body —
-- to add an admin-promotion UI, say, which the same comment invites — would be
-- removing the only thing holding, while the comment tells them a second lock
-- exists. That is precisely how 0019 shipped.
--
-- So: make the SQL say what the comment says.
--
-- ---------------------------------------------------------------------------
-- WHY `record_admin_action` IS RE-REVOKED HERE TOO
-- ---------------------------------------------------------------------------
-- It is not: 0024 closed it and nothing since has recreated it. It is listed in
-- the sweep below only so that `scripts/probe-grants.mjs` and this file agree on
-- one list of client-reachable functions, and so that a future
-- `create or replace` of either one — which re-triggers the default privileges
-- for a NEW function, though not for a replaced one — has a file to be added to.

begin;

-- The bootstrap's three grants, named explicitly. `public` is in the list as
-- well because it is the one this schema's idiom already revokes, and leaving
-- it out would make this file look like it disagreed with 0002 rather than
-- completing it.
revoke execute on function public.grant_admin(uuid) from public, anon, authenticated;

-- Separately, and in its own statement, because `service_role` is a Supabase
-- role rather than a PostgreSQL one: on a plain Postgres it does not exist and
-- naming it in the statement above would abort the whole revoke. 0024 splits it
-- for the same reason.
do $$
begin
  execute 'revoke execute on function public.grant_admin(uuid) from service_role';
exception
  when undefined_object then null;
end
$$;

comment on function public.grant_admin(uuid) is
  'Promotes a profile to role = admin, and writes an admin_actions row. The supported bootstrap/repair path: callable from psql or the SQL editor (where jwt_uid() is null and session_user is not authenticator), or by an existing administrator. NOT executable by anon, authenticated or service_role — 0031 revoked the grants Supabase default privileges had added behind 0002''s back, the same trap 0024 found in record_admin_action. The body''s session_user test is still the control; this makes the grant agree with it.';

commit;

-- ---------------------------------------------------------------------------
-- AFTER PUSHING, the assertion belongs in the read-only tier of
-- `scripts/verify-supabase.mts`, beside the one already there. It currently
-- reads:
--
--   grant_admin → 42501: Only an administrator can grant administrator access.
--
-- and after this it should read:
--
--   grant_admin → 42501: permission denied for function grant_admin
--
-- **That change is the assertion.** The first sentence is the function's own,
-- which means it RAN; the second is the grant refusing before it does. Pin the
-- distinction the way 0024's assertion does — `verify:supabase` already checks
-- that `record_admin_action` is "refused by the GRANT, not by a guard inside
-- the function", and this is the same check for the same reason.
--
-- ALSO WORTH RUNNING, once, after any future migration that adds a function:
--
--   node --env-file=.env.local scripts/probe-grants.mjs
--
-- It sweeps every client-reachable RPC and prints RAN or refused for each.
-- `consume_rate_limit` is missing from its list and is granted to anon on
-- purpose; everything else in `public` should refuse.
--
-- ROLLBACK: `grant execute on function public.grant_admin(uuid) to service_role;`
-- — and note that restoring the anon/authenticated grants is never wanted.
-- ---------------------------------------------------------------------------
