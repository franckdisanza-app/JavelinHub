-- ===========================================================================
-- 0004_privileged_auth_grant.sql — let javelin_privileged call auth.uid().
-- ===========================================================================
--
-- Found by calling the RPC against the real database immediately after
-- 0002/0003 applied. Every one of the four privileged functions failed, before
-- reaching a single line of its own logic, with:
--
--     42501  permission denied for schema auth
--
-- Why 0002 could not have caught it. The functions are `SECURITY DEFINER` and
-- OWNED BY `javelin_privileged`, which is the entire point — inside them
-- `current_user` is `javelin_privileged`, and that identity is what
-- `guard_profile_privilege_columns` trusts to let a role change through. But
-- ownership cuts both ways: a SECURITY DEFINER function runs with the OWNER's
-- privileges, not the caller's, so `auth.uid()` on their first line is resolved
-- as `javelin_privileged` — a bare `nologin` role created by 0002 with no
-- grants outside `public`.
--
-- `anon` and `authenticated` both have USAGE on `auth` from Supabase's own
-- bootstrap, which is why every other query in the app reaches `auth.uid()`
-- without trouble and why nothing in the RLS policies hit this. Only the four
-- functions that deliberately run as somebody else did.
--
-- This is also why it is invisible to static review and to `npm run
-- verify:authz`: the mock has no schemas and no function owners, `db push`
-- reports success because the DDL is all valid, and the failure only appears
-- when a function is actually CALLED.
--
-- The four affected functions, all reached through `SupabaseDataClient`:
--   public.redeem_invite_code(text)          -- redeemInviteCode
--   public.apply_to_coach(text, text, text)  -- createCoachApplication
--   public.review_coach_application(...)     -- reviewCoachApplication
--   public.grant_admin(uuid)                 -- the admin bootstrap
--
-- `public.handle_new_user()` shares the owner and is included by the same
-- grant, though its body reads only `NEW` and never calls `auth.uid()`.

-- USAGE only. This is the right to RESOLVE names in the schema — it confers
-- nothing over `auth.users` itself, which stays unreadable to this role: there
-- is no accompanying `grant select on auth.users`, and none should be added.
-- The role needs to ask "who is calling?", not to enumerate accounts.
grant usage on schema auth to javelin_privileged;

-- `auth.uid()` and `auth.role()` are executable by PUBLIC on a stock Supabase
-- project, so schema USAGE is normally sufficient. These two are explicit
-- anyway: a project that has tightened the default PUBLIC grant would
-- otherwise fail here again at run time, and in exactly the same invisible way
-- — a successful migration followed by four functions that refuse on their
-- first line. Idempotent, and harmless where the PUBLIC grant still stands.
do $$
begin
  execute 'grant execute on function auth.uid() to javelin_privileged';
exception
  when undefined_function or insufficient_privilege then null;
end
$$;

do $$
begin
  execute 'grant execute on function auth.role() to javelin_privileged';
exception
  when undefined_function or insufficient_privilege then null;
end
$$;
