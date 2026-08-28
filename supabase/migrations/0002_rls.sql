-- ---------------------------------------------------------------------------
-- 0002_rls.sql — Row Level Security: the privileged role, the SECURITY DEFINER
-- helpers and RPCs, the profile column guard, and the full policy set.
--
-- !! NOT APPLIED TO A LIVE DATABASE IN THIS PHASE !!
-- There is no running Postgres / Supabase project for this POC. These policies
-- are verified by *static review* only. The same authorization rules are
-- independently enforced in application code by the mock data layer at
-- src/lib/data/mock/mockClient.ts (defense in depth). Every policy and function
-- name below appears verbatim in a comment above the matching code check, and
-- the mapping is tabulated in supabase/README.md.
--
-- Threat model recap:
--   * anon                -> reads PUBLISHED listings, public_profiles, reviews
--                            and the offer_stats / coach_stats aggregate views;
--                            NOT orders, which name a buyer, a seller and a
--                            price, and NOT listing_revisions, which would be a
--                            price history per offer
--   * authenticated       -> owns its own profile + applications; cannot self-promote
--   * approved coach      -> may additionally create and EDIT its own listings,
--                            and read their revision history
--   * any owning coach    -> may WITHDRAW and RESTORE its own listings even if
--                            approval has since been revoked
--   * admin               -> invites + application review + listing TAKEDOWN.
--                            Deliberately NOT listing edits: an admin who could
--                            rewrite a coach's copy would publish words under
--                            that coach's byline
--   * javelin_privileged  -> NOLOGIN role that owns the promotion RPCs; the only
--                            identity permitted to move role / coach_status
--
-- Ordering matters in this file: the role must exist before policies can name
-- it, and functions must exist before their ownership can be transferred.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The privileged role
--
-- Promotion (learner -> coach, coach_status -> approved/pending_review/rejected)
-- is not something any client may do to itself. It happens only inside the
-- SECURITY DEFINER functions at the bottom of this file, and those functions
-- are OWNED BY this role. Inside a SECURITY DEFINER function `current_user` is
-- the function owner, so `current_user = 'javelin_privileged'` is an identity
-- assertion that no client can forge: the role is NOLOGIN, is never granted to
-- anon / authenticated / service_role, and unlike a GUC there is no `SET` that
-- fakes it.
--
-- The role deliberately does NOT bypass RLS (it is not a table owner and has no
-- BYPASSRLS attribute, which would need superuser). Instead it is given explicit
-- table grants plus the `*_privileged` policies below. That keeps the migration
-- runnable as an ordinary CREATEROLE user, which is what Supabase gives you.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'javelin_privileged') then
    create role javelin_privileged nologin;
  end if;
end
$$;

-- WHAT THIS BLOCK HAS TO ACHIEVE, stated precisely, because two plausible-
-- looking versions of it both failed against a real PostgreSQL 17:
--
-- The migration runner must be able to **SET ROLE** to javelin_privileged. The
-- `alter function ... owner to javelin_privileged` statements at the bottom of
-- this file require it — you may only give an object away to a role you could
-- become. ADMIN OPTION is NOT sufficient and is a different privilege.
--
-- On PostgreSQL 16+ `create role` automatically grants the new role back to its
-- creator, but with `ADMIN TRUE, SET FALSE`: administer it, never become it. On
-- Supabase, where migrations run as the non-superuser `postgres`, that is
-- exactly the state this block starts in — and the two failures it produced,
-- in order, were:
--
--   0LP01  ADMIN option cannot be granted back to your own grantor
--          -- from `grant ... with admin option` when ADMIN is already held.
--          Aborted 0002 on its FIRST statement.
--   42501  must be able to SET ROLE "javelin_privileged"
--          -- 150 statements later, at the first `alter function ... owner to`,
--          once the ADMIN re-grant was made conditional. The real gap.
--
-- So: ask for the SET option specifically, and only when it is actually absent.
-- `set_option` is a PG16 addition to pg_auth_members, hence the catalog probe
-- rather than a bare column reference — on an older server that column does not
-- exist and merely naming it would abort the migration with `undefined_column`,
-- swapping one spurious failure for another.
do $$
declare
  v_has_set boolean := false;
  v_modern  boolean := false;
begin
  select exists (
    select 1
      from pg_attribute
     where attrelid = 'pg_catalog.pg_auth_members'::regclass
       and attname  = 'set_option'
       and not attisdropped
  ) into v_modern;

  if v_modern then
    execute $probe$
      select coalesce(bool_or(m.set_option), false)
        from pg_auth_members m
        join pg_roles granted on granted.oid = m.roleid
        join pg_roles member  on member.oid  = m.member
       where granted.rolname = 'javelin_privileged'
         and member.rolname  = current_user
    $probe$ into v_has_set;

    if not v_has_set then
      -- Deliberately WITHOUT `admin option`: re-requesting ADMIN is what raised
      -- 0LP01, and it is already held here anyway.
      execute format('grant javelin_privileged to %I with set true', current_user);
    end if;
  else
    -- Pre-16, membership implies the right to SET ROLE, so the classic form is
    -- both necessary and sufficient.
    execute format('grant javelin_privileged to %I with admin option', current_user);
  end if;
exception
  -- A superuser needs none of this, and a re-run against a role somebody else
  -- created may legitimately refuse. What must NOT happen is this block killing
  -- the migration: if the runner already has what it needs by another route,
  -- there is nothing here to fail about, and if it genuinely cannot SET ROLE
  -- the `alter function` statements below say so far more clearly than a
  -- re-raise from here would.
  when insufficient_privilege or duplicate_object or invalid_grant_operation then null;
end
$$;

-- (No COMMENT ON ROLE here: commenting on a role needs superuser on older
-- Postgres, and a migration that aborts on a comment is not worth it. The
-- explanation lives in the block above.)

-- ---------------------------------------------------------------------------
-- Helpers
--
-- WHY SECURITY DEFINER:
-- A policy on `profiles` that needs to ask "is the caller an admin?" must read
-- `profiles` — and that read is itself subject to the `profiles` policies,
-- which would re-enter this check. Postgres reports that as
-- "infinite recursion detected in policy for relation profiles" (42P17).
-- Wrapping the lookup in a SECURITY DEFINER function makes the inner read run
-- as the function OWNER, for whom RLS is not enforced, breaking the cycle.
--
-- `set search_path = public, pg_temp` is mandatory hardening for any
-- SECURITY DEFINER function: without it a caller can prepend a schema they
-- control and hijack the function body's name resolution.
--
-- These take NO PARAMETER, on purpose. An earlier revision exposed
-- is_admin(uuid) to anon, which let any visitor probe whether a given uuid was
-- an administrator. The policies only ever ask about the current user, so the
-- parameterised overloads are dropped rather than restricted — a function that
-- does not exist cannot be granted by accident later.
-- ---------------------------------------------------------------------------

drop function if exists public.is_admin(uuid);
drop function if exists public.is_approved_coach(uuid);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

comment on function public.is_admin() is
  'True when the CURRENT user has role = admin. SECURITY DEFINER so that policies on profiles can call it without recursing into profiles RLS. Takes no uuid: callers must not be able to probe other users.';

create or replace function public.is_approved_coach()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.coach_status = 'approved'
  );
$$;

comment on function public.is_approved_coach() is
  'True when the CURRENT user has coach_status = approved. SECURITY DEFINER; see is_admin() for the rationale.';

revoke all on function public.is_admin() from public;
revoke all on function public.is_approved_coach() from public;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_approved_coach() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Privilege-column guard for profiles
--
-- WHY A TRIGGER AND NOT A `with check`:
-- The requirement is "a user may update their own profile row but must not
-- change their own role or coach_status". A `with check` expression is
-- evaluated against the NEW row only — it has no access to OLD — so it cannot
-- express "this column must equal what it was before". The two workable
-- mechanisms are (a) column-level GRANTs, which Supabase's generated API does
-- not model well, or (b) a BEFORE UPDATE trigger that compares OLD to NEW.
-- We use (b): the trigger is the authoritative guard, and it fires for every
-- writer regardless of which policy admitted the statement.
--
-- WHY SECURITY INVOKER (i.e. why no `security definer` below):
-- the guard's whole job is to observe WHO is writing. Inside a SECURITY DEFINER
-- function `current_user` collapses to that function's owner for every caller,
-- which would make the identity test below meaningless. Running as the invoker
-- means `current_user` is `authenticated` for an API write and
-- `javelin_privileged` for a write from one of our promotion RPCs.
--
-- The three exemptions, each deliberate and narrow:
--   1. current_user = 'javelin_privileged' — a write from inside one of the
--      promotion RPCs. Unforgeable: the role is NOLOGIN and never granted out.
--   2. session_user <> 'authenticator' — the connection is not a PostgREST
--      request at all: psql, the SQL editor, a migration. See below.
--   3. public.is_admin() — admins legitimately flip other people's coach_status.
--
-- WHY EXEMPTION 2 IS AN ALLOWLIST, NOT A DENYLIST:
-- this used to read `current_user not in ('anon', 'authenticated')`, which
-- fails OPEN. PostgREST does `SET LOCAL ROLE <the JWT's role claim>`, and
-- Supabase supports custom roles there — so the day this project adds a
-- `moderator` or a per-tenant role, every holder of it would sail past the
-- guard and be able to set their own role to 'admin'. Enumerating the roles
-- that are NOT allowed is the wrong shape for the most privileged column pair
-- in the schema.
--
-- `session_user` is the role the connection AUTHENTICATED as. It is not changed
-- by SET ROLE and not changed by SECURITY DEFINER, so a request can never alter
-- it. Every PostgREST request — anon, authenticated, service_role, and any
-- custom role added later — arrives on a connection whose session_user is
-- `authenticator`. So "session_user is not authenticator" means "this is a
-- direct database connection", i.e. someone who already has table-level access
-- and for whom this guard was never the real control. It is closed by
-- construction: new roles are covered automatically.
--
-- NOTE the consequence for the service_role key: it now goes through PostgREST
-- like everyone else, so it is NOT exempt here and cannot set role/coach_status
-- by a plain UPDATE. Admin bootstrap needs a direct connection — see
-- public.grant_admin() and supabase/README.md.
--
-- Tested on session_user and NOT on `auth.uid() is null`: an anonymous API
-- request also has a null auth.uid(), and must stay guarded.
-- ---------------------------------------------------------------------------

create or replace function public.guard_profile_privilege_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_privileged boolean := false;
begin
  if current_user = 'javelin_privileged' then
    v_privileged := true;
  elsif session_user <> 'authenticator' then
    v_privileged := true;
  elsif public.is_admin() then
    v_privileged := true;
  end if;

  if v_privileged then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'You cannot change your own role.'
      using errcode = '42501';
  end if;

  if new.coach_status is distinct from old.coach_status then
    raise exception 'You cannot change your own coach status.'
      using errcode = '42501';
  end if;

  -- THE THREE COACH COLUMNS ARE WRITABLE ONLY BY AN APPROVED COACH.
  --
  -- Without this the two backends publish DIFFERENT TEXT for the same user
  -- actions, which is worse than either behaviour on its own.
  -- `updateMyCoachProfile()` in mockClient.ts refuses a non-approved actor;
  -- `profiles_update_own` on its own has no such predicate, so through
  -- PostgREST a plain learner could `PATCH` their own `coach_bio` before ever
  -- applying. That is not merely an unused column: `review_coach_application()`
  -- copies the application bio with
  -- `coalesce(nullif(btrim(p.coach_bio), ''), v_app.bio)`, so a pre-written bio
  -- SUPPRESSES the one-time copy at approval — and the coach ends up published
  -- with self-written text on Supabase and with their application bio on the
  -- mock. Closed here rather than recorded as a divergence, because a
  -- divergence that changes what gets published is not a documentation problem.
  --
  -- `public.is_approved_coach()` reads `auth.uid()`'s OWN stored status, which
  -- is the same fact the mock re-reads from the store. The privileged arms above
  -- (javelin_privileged, a direct connection, an admin) have already returned,
  -- so this cannot block the approval copy itself: that write happens inside
  -- review_coach_application(), which is owned by javelin_privileged.
  --
  -- `is distinct from` and not `<>`: NULL is the normal value for all three, and
  -- `NULL <> NULL` is NULL, which would not fire the guard.
  if (new.coach_headline       is distinct from old.coach_headline
   or new.coach_bio            is distinct from old.coach_bio
   or new.coach_years_coaching is distinct from old.coach_years_coaching)
     and not public.is_approved_coach() then
    raise exception 'Only approved coaches can edit a public coach profile.'
      using errcode = '42501';
  end if;

  -- WHAT IS DELIBERATELY *NOT* PINNED HERE, so nobody adds it later thinking it
  -- was an oversight: `full_name`. It is profile CONTENT with no privilege
  -- attached, bounded by the CHECK constraints in 0001_init.sql rather than by
  -- this guard. The columns below are the ones that decide what a user may DO.
  --
  -- id and email are identity, not profile content: pin them too.
  if new.id is distinct from old.id then
    raise exception 'You cannot change a profile id.' using errcode = '42501';
  end if;

  if new.email is distinct from old.email then
    raise exception 'You cannot change your email here.' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.guard_profile_privilege_columns() is
  'BEFORE UPDATE guard on profiles: rejects self-service changes to role, coach_status, id and email outright, and rejects changes to coach_headline / coach_bio / coach_years_coaching unless the writer is an approved coach. SECURITY INVOKER on purpose, so current_user identifies the real writer. Exists because an RLS with-check cannot reference OLD.';

drop trigger if exists profiles_guard_privilege_columns on public.profiles;
create trigger profiles_guard_privilege_columns
  before update on public.profiles
  for each row execute function public.guard_profile_privilege_columns();

-- ---------------------------------------------------------------------------
-- Enable RLS (deny-by-default: with RLS on and no matching policy, access is
-- refused for every non-owner, non-superuser role).
-- ---------------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.coach_applications  enable row level security;
alter table public.invites             enable row level security;
alter table public.listings            enable row level security;
alter table public.listing_revisions   enable row level security;
alter table public.orders              enable row level security;
alter table public.reviews             enable row level security;

-- Table owners bypass RLS unless FORCE is set. FORCE is deliberately NOT
-- enabled: is_admin() / is_approved_coach() are owned by the table owner and
-- rely on that bypass to break policy recursion.

-- ---------------------------------------------------------------------------
-- Grants + policies for javelin_privileged
--
-- The promotion RPCs run as this role, which is NOT a table owner, so RLS does
-- apply to it. These blanket policies are what let it work — and they are safe
-- precisely because no client can ever be this role.
-- ---------------------------------------------------------------------------

grant usage on schema public to javelin_privileged;
grant select, insert, update on public.profiles           to javelin_privileged;
grant select, insert, update on public.coach_applications to javelin_privileged;
grant select, insert, update on public.invites            to javelin_privileged;
grant select                 on public.listings           to javelin_privileged;
-- INSERT only, and only ever from record_listing_revision(): the table is
-- append-only and nothing, privileged or not, updates or deletes a row in it.
grant select, insert         on public.listing_revisions  to javelin_privileged;

drop policy if exists profiles_privileged on public.profiles;
create policy profiles_privileged
  on public.profiles for all to javelin_privileged
  using (true) with check (true);

drop policy if exists coach_applications_privileged on public.coach_applications;
create policy coach_applications_privileged
  on public.coach_applications for all to javelin_privileged
  using (true) with check (true);

drop policy if exists invites_privileged on public.invites;
create policy invites_privileged
  on public.invites for all to javelin_privileged
  using (true) with check (true);

-- INSERT only — deliberately NOT `for all`. The revision log is append-only,
-- and the privileged role has no more business rewriting history than a client
-- does.
drop policy if exists listing_revisions_privileged_insert on public.listing_revisions;
create policy listing_revisions_privileged_insert
  on public.listing_revisions for insert to javelin_privileged
  with check (true);

drop policy if exists listing_revisions_privileged_select on public.listing_revisions;
create policy listing_revisions_privileged_select
  on public.listing_revisions for select to javelin_privileged
  using (true);

-- ---------------------------------------------------------------------------
-- profiles
--
-- `profiles` carries email, so it is NOT publicly readable. Anonymous and
-- cross-user reads go through the public_profiles view below, which projects
-- only the columns a browse page needs. An earlier revision had
-- `using (true)` here and leaked every user's email to anonymous visitors.
-- ---------------------------------------------------------------------------

drop policy if exists profiles_select_public on public.profiles;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin
  on public.profiles
  for select
  to authenticated
  using (public.is_admin());

-- A user may edit only their own row. Role/coach_status escalation is blocked
-- by the profiles_guard_privilege_columns trigger above, not by this policy.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Admin may edit any profile (the review flow flips coach_status).
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin
  on public.profiles
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Normally the handle_new_user trigger creates the row; this policy exists so a
-- client-side profile bootstrap is possible without being able to mint a coach.
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
  on public.profiles
  for insert
  to authenticated
  with check (
    id = auth.uid()
    and role = 'learner'
    and coach_status = 'none'
  );

-- No DELETE policy: profile rows disappear only by cascade from auth.users.

-- The public projection: three columns, and no raw privilege state.
--
-- WHAT IT DELIBERATELY DOES NOT PUBLISH:
--   * `role`         — publishing it to anon turns this view into an
--                      administrator ENUMERATOR. `select id, full_name from
--                      public_profiles where role = 'admin'` with nothing but
--                      the anon key returns the whole admin roster: strictly
--                      worse than the is_admin(uuid) probe that was removed,
--                      because it lists instead of guessing and needs no uuid.
--   * `coach_status` — the raw enum makes every user's 'pending_review' /
--                      'rejected' state world-readable, i.e. a rejected
--                      coaching application becomes public.
-- Neither column is needed to render a coach's name on a browse page. What the
-- UI legitimately needs is a verified-coach badge, so the one derived boolean
-- below is published instead: it says "this person may sell coaching", which is
-- already evident from their listings, and reveals nothing else.
--
-- HOW IT READS THE TABLE (this is the opposite of what an earlier comment
-- claimed): the view is NOT `security_invoker`, so it executes as its OWNER,
-- who is the owner of `profiles` and therefore BYPASSES that table's RLS. That
-- bypass is the entire point — `profiles` itself is readable only by its owner
-- and admins, and this view is how anonymous browse pages still get a name.
--
-- CONSEQUENCE, do not miss this: `alter table public.profiles force row level
-- security` would subject even the owner to RLS, the view would collapse to
-- rows the caller can already see, and every public page would silently lose
-- its coach names. If you ever enable FORCE, this view needs its own explicit
-- policy first.
drop view if exists public.public_profiles;
create view public.public_profiles as
  select
    p.id,
    p.full_name,
    (p.coach_status = 'approved') as is_approved_coach
  from public.profiles p;

comment on view public.public_profiles is
  'Public projection of profiles: id, full_name and a derived is_approved_coach flag. Deliberately excludes email, role and coach_status — publishing role to anon would enumerate every administrator. Runs as its owner and so bypasses profiles RLS; breaks if FORCE RLS is ever enabled on profiles.';

grant select on public.public_profiles to anon, authenticated;

-- The public COACH DIRECTORY.
--
-- Read this next to public_profiles above: it is the same trick, filtered.
--
-- WHY IT CARRIES NO STATUS COLUMN AND NO STATUS FILTER:
-- the `where` clause is IN THE VIEW, so the row's mere EXISTENCE is the
-- approval. A caller cannot ask for `coach_status = 'rejected'`, cannot ask for
-- `role = 'admin'`, and cannot ask for "everyone" — there is no such column to
-- put in a predicate and no wider relation they hold any privilege on
-- (`profiles` itself is readable only by its owner and by admins). Publishing
-- `is_approved_coach` here would be a constant-`true` column; publishing the
-- raw enum would be exactly the enumerator public_profiles drops it to prevent.
--
-- Selecting a row that is not here therefore returns nothing, and it returns
-- the same nothing for a learner, a pending applicant, a rejected applicant, an
-- administrator and a uuid that belongs to no one. That is strictly less than
-- `public_profiles.is_approved_coach`, which is already public.
--
-- The three coach columns are the PROFILE's own; nothing here touches
-- `coach_applications`, whose bio and experience stay owner-and-admin-only.
-- See the column comments in 0001_init.sql for the one-time copy at approval.
--
-- Like public_profiles this view is NOT `security_invoker`, so it runs as its
-- owner and reads past profiles' RLS — which is the only way an anonymous
-- browse page gets a coach at all. The same FORCE RLS caveat applies.
drop view if exists public.public_coaches;
create view public.public_coaches as
  select
    p.id,
    p.full_name,
    p.coach_headline,
    p.coach_bio,
    p.coach_years_coaching
  from public.profiles p
  where p.coach_status = 'approved';

comment on view public.public_coaches is
  'Public coach directory: id, full_name and the three coach-authored columns, for APPROVED coaches only. The where-clause lives in the view, so the row''s existence IS the approval and no caller-supplied predicate can widen it — there is deliberately no role, coach_status or is_approved_coach column to filter on. Carries nothing from coach_applications. Runs as its owner and so bypasses profiles RLS; breaks if FORCE RLS is ever enabled on profiles.';

grant select on public.public_coaches to anon, authenticated;

-- ---------------------------------------------------------------------------
-- listings
--
-- WITHDRAWAL IS A SOFT DELETE, AND THAT SHAPES EVERY POLICY BELOW.
--
--   * the public SELECT policy carries `deleted_at is null`. This is the single
--     most important predicate in this file after the orders policies: miss it
--     in one place and a withdrawn offer is silently back on sale;
--   * three further SELECT policies exist so the row stays reachable by the
--     people entitled to a TOMBSTONE — the coach who owns it, an admin, and
--     anyone holding an order for it. Without the last of those, a buyer's
--     purchase history links into a 404;
--   * there is NO DELETE POLICY FOR ANYBODY. Both of the earlier ones
--     (`listings_delete_own_approved_coach`, `listings_delete_admin`) are
--     dropped below. A hard delete either cascades and destroys the offer's
--     reviews, or is refused outright by `orders.listing_id`'s ON DELETE
--     RESTRICT the moment the offer has sold. There is no version of it worth
--     keeping, so the verb is removed rather than restricted;
--   * UPDATE is admitted broadly (owner, or admin) and then constrained by the
--     BEFORE UPDATE trigger `guard_listing_update()` below, because the rules
--     that matter — "only the OWNER may change content", "the epoch derives
--     from the price change", "only an admin may lift an admin takedown" — are
--     all OLD-vs-NEW comparisons that a `with check` cannot express. Same mechanism, and the same reason, as
--     `guard_profile_privilege_columns` on profiles.
-- ---------------------------------------------------------------------------

-- Browse and listing-detail are public pages — for offers that are on sale.
drop policy if exists listings_select_public on public.listings;
create policy listings_select_public
  on public.listings
  for select
  to anon, authenticated
  using (deleted_at is null);

-- The three tombstone readers. Each is a SELECT policy rather than a widening
-- of the public one, so a withdrawn offer is visible to exactly these three and
-- to nobody else; policies are OR-ed, so a published offer is still public.

-- The owner: needed for the coach dashboard, which must list withdrawn offers
-- in order to offer a Restore control. Mirrors mockClient.listMyListings().
drop policy if exists listings_select_own_coach on public.listings;
create policy listings_select_own_coach
  on public.listings
  for select
  to authenticated
  using (coach_id = auth.uid());

-- The buyer. THIS is the policy that stops a purchase history linking into a
-- dead end: someone who paid for an offer can still see what they bought after
-- it is withdrawn. It reads `orders`, which is itself RLS-protected, but that
-- is fine here — the subquery is scoped to the caller's own rows, so it can
-- only ever confirm offers they personally bought.
drop policy if exists listings_select_purchaser on public.listings;
create policy listings_select_purchaser
  on public.listings
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.orders o
      where o.listing_id = listings.id
        and o.learner_id = auth.uid()
    )
  );

drop policy if exists listings_select_admin on public.listings;
create policy listings_select_admin
  on public.listings
  for select
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- deleted_by is NOT SELECTABLE BY ANY CLIENT ROLE.
--
-- RLS is row-level; the three policies above hand a coach, a buyer and an admin
-- the whole ROW, and `GET /rest/v1/listings?select=*` would therefore return
-- `deleted_by` to any of them. After a takedown that is an ADMINISTRATOR's id,
-- and PostgREST is reachable from a browser with the anon key — so the mock's
-- projection is not a boundary here, only a convention. A column-level revoke
-- is, and it is what makes the banner on `Listing.deleted_by` ("this column
-- never reaches a caller") true in Postgres rather than merely true in
-- TypeScript.
--
-- NOTE the shape, because the obvious one-liner does not work: in PostgreSQL a
-- column-level `revoke select (deleted_by)` does NOT subtract from a table-level
-- grant, and Supabase grants table-level SELECT to anon/authenticated by
-- default — so that form is a silent no-op. The table privilege has to be
-- revoked and the columns granted individually, which is what happens below.
--
-- CONSEQUENCE FOR THE CLIENT, and it is not optional: `SELECT *` expands to
-- every column, so a role holding only column privileges gets 42501 on
-- `select=*` rather than a row with the column quietly absent.
-- SupabaseDataClient must enumerate columns. Add any new listings column to the
-- grant below or it becomes unreadable to every client.
--
-- The privileged role keeps full access — guard_listing_update() has to read
-- old.deleted_by to decide who may restore.
--
-- THIS REVOKE IS UNDONE BY ANY LATER BLANKET GRANT, SILENTLY. A subsequent
-- `grant all on all tables in schema public to anon, authenticated` — which
-- Supabase tooling and several reset templates issue — restores the TABLE-level
-- privilege, and a table-level grant confers every column, so deleted_by
-- becomes readable again with no error raised anywhere. Re-apply this revoke
-- after any such grant, and treat "did a reset script run?" as the first
-- question when auditing whether the column is still hidden.
-- ---------------------------------------------------------------------------
revoke select on public.listings from anon, authenticated;
grant select (id, coach_id, title, description, price_cents, category,
              price_epoch, deleted_at, created_at, updated_at)
  on public.listings to anon, authenticated;

-- Only an APPROVED coach may create a listing, and only in their own name:
-- coach_id is pinned to auth.uid() so the id cannot be spoofed from the client.
drop policy if exists listings_insert_approved_coach on public.listings;
create policy listings_insert_approved_coach
  on public.listings
  for insert
  to authenticated
  with check (
    coach_id = auth.uid()
    and public.is_approved_coach()
  );

-- An owner may write to their own row. NOTE the `is_approved_coach()` clause
-- that used to be here is GONE, and the policy is renamed accordingly — it has
-- not been dropped, it has moved into guard_listing_update(), which can tell
-- WHICH columns are changing. The reason: approval gates EDITING an offer, but
-- it must not gate WITHDRAWING one. A coach whose approval is revoked and who
-- can no longer take their own offers off sale is the worst of both worlds —
-- the offers stay published and only an admin can act.
drop policy if exists listings_update_own_approved_coach on public.listings;
drop policy if exists listings_update_own_coach on public.listings;
create policy listings_update_own_coach
  on public.listings
  for update
  to authenticated
  using (coach_id = auth.uid())
  with check (coach_id = auth.uid());

-- Admin override, for the TAKEDOWN and nothing else. The policy admits the
-- statement; guard_listing_update() is what confines a non-owner to the
-- `deleted_at` column. An admin who could rewrite a coach's copy would be
-- publishing words under that coach's byline, which is worse than the problem
-- moderation is solving.
drop policy if exists listings_update_admin on public.listings;
create policy listings_update_admin
  on public.listings
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- NO DELETE POLICY, for anybody. Both of the earlier ones are dropped and not
-- replaced: deletion of a listing is always the `deleted_at` soft delete. Left
-- as DROPs rather than deleted so that re-applying this migration over an older
-- database actually removes them.
drop policy if exists listings_delete_own_approved_coach on public.listings;
drop policy if exists listings_delete_admin on public.listings;

-- ---------------------------------------------------------------------------
-- guard_listing_update() — the OLD-vs-NEW rules a `with check` cannot express.
--
-- Same mechanism, and the same justification, as
-- guard_profile_privilege_columns() on profiles: a `with check` sees only NEW,
-- so "this column may not change" and "this column derives from how that column
-- changed" both need a BEFORE UPDATE trigger. It fires for every writer
-- regardless of which policy admitted the statement, which is exactly the
-- property that makes it worth having.
--
-- It enforces six things:
--
--   1. OWNERSHIP IS NOT TRANSFERABLE. coach_id can never change.
--   2. ONLY THE OWNER MAY CHANGE CONTENT — title, description, price_cents,
--      category — and only while their coach_status is 'approved'. An admin is
--      refused here like anyone else, which is the deliberate asymmetry with
--      the takedown: `listings_update_admin` lets them set deleted_at and
--      nothing more. Mirrors mockClient.updateListing(), which is owner-only.
--   3. THE PRICE EPOCH IS DERIVED, NEVER SUPPLIED. It becomes old + 1 when the
--      new price is STRICTLY GREATER than the old one, and stays put otherwise
--      — an unchanged price does not bump it and neither does a price CUT,
--      because bumping archives the offer's rating, reviews and sales and doing
--      that for a discount would destroy an offer's social proof for nothing.
--      Deriving it here rather than in an RPC is what makes it unskippable: a
--      client that PATCHes `price_cents` straight through PostgREST gets the
--      archive whether it asked for one or not.
--   4. AN EDIT AND A WITHDRAWAL CANNOT BE THE SAME STATEMENT. Note this is NOT
--      "a withdrawn offer cannot be edited" — it can, and must be able to be:
--      once only an admin can lift a takedown, a coach who could not edit while
--      withdrawn could neither restore the offer nor fix what got it removed.
--      updateListing() allows the edit and leaves deleted_at alone. What this
--      rule forbids is changing content AND deleted_at in ONE statement, which
--      is what lets record_listing_revision() below tell an edit from a
--      withdrawal with a simple WHEN clause.
--   5. AN ADMIN TAKEDOWN MAY ONLY BE LIFTED BY AN ADMIN. A coach may clear
--      their OWN deleted_at freely; clearing one somebody else set is refused.
--   6. `deleted_by` IS DERIVED, NEVER SUPPLIED — auth.uid() on withdrawal,
--      NULL on restore. It decides rule 5, so the party it constrains must not
--      be able to write it.
--
-- SECURITY INVOKER, like the profile guard and for the same reason: its job is
-- to observe who is writing, and inside a definer function current_user would
-- collapse to the owner for every caller. The `session_user <> 'authenticator'`
-- exemption is the same allowlist-shaped test used there — it means "this is a
-- direct database connection", not "this role is on a list", so a custom
-- PostgREST role added later is covered automatically.
--
-- NOTE the epoch derivation is deliberately NOT exempted for direct
-- connections: it is a data-integrity rule, not an authorization one. A DBA who
-- genuinely needs to set an epoch by hand disables this trigger for the
-- statement.
-- ---------------------------------------------------------------------------

create or replace function public.guard_listing_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_content_changed boolean;
  v_deleted_changed boolean;
begin
  if new.coach_id is distinct from old.coach_id then
    raise exception 'An offer cannot change owner.' using errcode = '42501';
  end if;

  v_content_changed :=
       new.title       is distinct from old.title
    or new.description is distinct from old.description
    or new.price_cents is distinct from old.price_cents
    or new.category    is distinct from old.category;

  v_deleted_changed := new.deleted_at is distinct from old.deleted_at;

  if v_content_changed and v_deleted_changed then
    raise exception 'Withdraw or restore an offer as its own action, not as part of an edit.'
      using errcode = '42501';
  end if;

  -- Rule 5. AN ADMIN TAKEDOWN MAY ONLY BE LIFTED BY AN ADMIN.
  --
  -- Both the owner and an admin may withdraw, so deleted_at alone cannot tell a
  -- coach's own withdrawal apart from a moderation action — and a takedown the
  -- coach reverses in one click is not a takedown. Checked here rather than in a
  -- policy because it is an OLD-row question: it is old.deleted_by that decides.
  --
  -- A NULL old.deleted_by is treated as unattributed and the owner may restore.
  -- Failing open on an audit column grants nothing an owner did not already
  -- have; failing closed would strand a row nobody could restore.
  if old.deleted_at is not null
     and new.deleted_at is null
     and old.deleted_by is not null
     and old.deleted_by <> auth.uid()
     and not public.is_admin()
     and session_user = 'authenticator'
  then
    raise exception 'An administrator removed this offer. Only an administrator can restore it.'
      using errcode = '42501';
  end if;

  -- Rule 6. deleted_by is DERIVED, never client-supplied — same treatment as
  -- price_epoch below, and for the same reason: a column that decides an
  -- authorization outcome must not be writable by the party it constrains.
  -- Withdrawing stamps the actor; restoring clears it, so a published row never
  -- carries a stale attribution for the next restore to be judged against.
  if v_deleted_changed then
    if new.deleted_at is null then
      new.deleted_by := null;
    else
      new.deleted_by := auth.uid();
    end if;
  else
    new.deleted_by := old.deleted_by;
  end if;

  -- Rule 2. Skipped for a direct database connection (psql, the SQL editor, a
  -- migration), which is not what this guard is protecting against.
  if v_content_changed and session_user = 'authenticator' then
    if old.coach_id <> auth.uid() then
      raise exception 'Only the coach who published an offer can edit it.'
        using errcode = '42501';
    end if;
    if not public.is_approved_coach() then
      raise exception 'Only approved coaches can edit an offer.'
        using errcode = '42501';
    end if;
  end if;

  -- Rule 3. Unconditional: whatever the client sent in price_epoch is
  -- discarded and the value is recomputed from the price movement.
  new.price_epoch := old.price_epoch
    + (case when new.price_cents > old.price_cents then 1 else 0 end);

  return new;
end;
$$;

comment on function public.guard_listing_update() is
  'BEFORE UPDATE guard on listings: pins coach_id, confines a non-owner (an admin included) to the deleted_at column, requires approved-coach status to edit content, forbids editing and withdrawing in one statement, refuses a non-admin clearing a deleted_at somebody else set, and DERIVES both deleted_by (auth.uid() on withdrawal, NULL on restore) and price_epoch (+1 only when the price strictly increases). SECURITY INVOKER on purpose, so current_user identifies the real writer. Exists because an RLS with-check cannot reference OLD.';

drop trigger if exists listings_guard_update on public.listings;
create trigger listings_guard_update
  before update on public.listings
  for each row execute function public.guard_listing_update();

-- ---------------------------------------------------------------------------
-- record_listing_revision() — the append-only edit history.
--
-- Snapshots the version being SUPERSEDED (the OLD row), so `listing_revisions`
-- holds every previous version and `listings` holds the current one.
--
-- SECURITY DEFINER and owned by javelin_privileged (see the ALTER FUNCTION
-- block at the end) because no client role holds INSERT on listing_revisions —
-- which is the point: a coach cannot rewrite the history of their own offer,
-- and cannot suppress a revision by editing through the API instead of through
-- the app. Running it as the invoker would require granting clients INSERT,
-- which would hand them exactly that.
--
-- The WHEN clause skips withdrawals and restorations: those change no content,
-- and guard_listing_update() has already made "content AND deleted_at in one
-- statement" impossible, so this is exactly the set of content edits — including
-- an edit that happens to change nothing, which mockClient.updateListing()
-- also records.
-- ---------------------------------------------------------------------------

create or replace function public.record_listing_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.listing_revisions (listing_id, title, description, price_cents, category, created_at)
  values (old.id, old.title, old.description, old.price_cents, old.category, now());
  return null;
end;
$$;

comment on function public.record_listing_revision() is
  'AFTER UPDATE trigger on listings: appends the SUPERSEDED version to listing_revisions. SECURITY DEFINER, owned by javelin_privileged, because no client role may INSERT there — a coach must not be able to suppress or rewrite the history of their own offer.';

drop trigger if exists listings_record_revision on public.listings;
create trigger listings_record_revision
  after update on public.listings
  for each row
  when (new.deleted_at is not distinct from old.deleted_at)
  execute function public.record_listing_revision();

-- ---------------------------------------------------------------------------
-- listing_revisions — readable by the offer's coach and by admins. NOT public.
--
-- There is no anon policy and no public view, deliberately. A published
-- revision log is a published price history for every offer on the site, which
-- is strictly more than the `price_epoch` that `offer_stats` already withholds.
-- There is also no INSERT/UPDATE/DELETE policy for any client role: the table is
-- append-only and only record_listing_revision() writes to it.
-- ---------------------------------------------------------------------------

drop policy if exists listing_revisions_select_own_coach on public.listing_revisions;
create policy listing_revisions_select_own_coach
  on public.listing_revisions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.listings l
      where l.id = listing_revisions.listing_id
        and l.coach_id = auth.uid()
    )
  );

drop policy if exists listing_revisions_select_admin on public.listing_revisions;
create policy listing_revisions_select_admin
  on public.listing_revisions
  for select
  to authenticated
  using (public.is_admin());

grant select on public.listing_revisions to authenticated;

-- ---------------------------------------------------------------------------
-- orders
--
-- ORDERS ARE NOT PUBLIC, AND THE AGGREGATE OVER THEM IS. That sentence is the
-- entire design of this section, and it is the thing most likely to be undone by
-- somebody "simplifying" it later.
--
-- A single row says that THIS learner bought THAT offer from THAT coach for THAT
-- much. Published, it is a purchase history per person and a customer list per
-- coach. So there is no `to anon` policy here at all, and the three policies
-- below are the complete set: your own purchases, your own sales, or admin.
--
-- The public "12 sales" number does NOT come from this table through a policy.
-- It comes from public.offer_stats / public.coach_stats, which are views that
-- run as their OWNER and therefore read past this RLS — publishing counts
-- without publishing a single row. Same mechanism as public_profiles, and the
-- same caveat: `alter table public.orders force row level security` would break
-- it, and the fix would be a policy on the aggregate, never `using (true)` here.
--
-- There is deliberately NO INSERT policy, for anyone. Nothing in this POC sells
-- anything: orders arrive from seed.sql (run by the table owner) and nowhere
-- else. A checkout gets its own RPC when it exists — a client-supplied
-- `price_cents_at_purchase` is not a thing that should ever be insertable.
-- ---------------------------------------------------------------------------

drop policy if exists orders_select_own_learner on public.orders;
create policy orders_select_own_learner
  on public.orders
  for select
  to authenticated
  using (learner_id = auth.uid());

drop policy if exists orders_select_own_coach on public.orders;
create policy orders_select_own_coach
  on public.orders
  for select
  to authenticated
  using (coach_id = auth.uid());

drop policy if exists orders_select_admin on public.orders;
create policy orders_select_admin
  on public.orders
  for select
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- reviews
--
-- Public to READ THROUGH A VIEW, purchase-gated to WRITE.
--
-- Note there is NO `to anon` policy on this table, and the earlier
-- `reviews_select_public using (true)` is dropped below. A review ROW carries
-- `order_id` and `author_id`; publishing those to anon would hand out valid
-- arguments to the order reads above, which are otherwise scoped to the buyer,
-- the selling coach and an admin — i.e. `orders` would be half-public through
-- the back door. Anonymous callers read `public.public_reviews` instead, which
-- projects exactly what a review renders as. Same shape as profiles /
-- public_profiles, for the same reason.
--
-- The three SELECT policies that remain on the table exist because three
-- parties legitimately need the whole row: an author (to know they have already
-- reviewed a purchase), the coach whose offer it is (so a sales list can show
-- which sales were reviewed), and an admin (moderation).
--
-- The insert policy is the whole anti-spam mechanism, and every clause in it is
-- load-bearing:
--
--   author_id = auth.uid()   the review is written in the writer's own name
--   the EXISTS               the writer owns the order being reviewed, and the
--                            listing being reviewed is the one that order
--                            bought — otherwise a genuine purchase of a £3 offer
--                            could be used to review any offer on the site
--   the NOT EXISTS           a coach cannot review their own offer
--   (unique on order_id)     one review per purchase, from 0001_init.sql
--
-- Note the second clause: pinning listing_id to the order's listing is why the
-- denormalised column cannot drift. price_epoch is not constrained by the policy
-- — application code stamps it — because a with-check cannot see the listing's
-- row without a subquery that a reviewer could not satisfy anyway; the column is
-- not privilege-bearing, and its worst misuse is a review filed under the wrong
-- pricing generation of an offer the writer demonstrably bought.
--
-- There is NO update policy for authors, for the same reason applicants have no
-- update path on coach_applications: an UPDATE grant would let them rewrite
-- order_id, listing_id or price_epoch, and pinning those columns for a
-- self-update needs an OLD-vs-NEW comparison, i.e. another guard trigger. Editing
-- a review is withdraw-and-rewrite. Admins may update/delete for moderation.
-- ---------------------------------------------------------------------------

-- Dropped, deliberately: it published order_id and author_id to anon. Left as a
-- DROP rather than deleted, so re-applying this migration over an older database
-- removes it.
drop policy if exists reviews_select_public on public.reviews;

drop policy if exists reviews_select_own_author on public.reviews;
create policy reviews_select_own_author
  on public.reviews
  for select
  to authenticated
  using (author_id = auth.uid());

drop policy if exists reviews_select_own_coach on public.reviews;
create policy reviews_select_own_coach
  on public.reviews
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.listings l
      where l.id = reviews.listing_id
        and l.coach_id = auth.uid()
    )
  );

drop policy if exists reviews_select_admin on public.reviews;
create policy reviews_select_admin
  on public.reviews
  for select
  to authenticated
  using (public.is_admin());

drop policy if exists reviews_insert_own_purchase on public.reviews;
create policy reviews_insert_own_purchase
  on public.reviews
  for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1
      from public.orders o
      where o.id = reviews.order_id
        and o.learner_id = auth.uid()
        and o.listing_id = reviews.listing_id
    )
    and not exists (
      select 1
      from public.listings l
      where l.id = reviews.listing_id
        and l.coach_id = auth.uid()
    )
  );

drop policy if exists reviews_update_admin on public.reviews;
create policy reviews_update_admin
  on public.reviews
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists reviews_delete_admin on public.reviews;
create policy reviews_delete_admin
  on public.reviews
  for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- public_reviews: the public shape of a review.
--
-- Runs as its owner (not `security_invoker`), so it reads past the table
-- policies above — that bypass is what lets an anonymous offer page show
-- reviews at all. What it projects is therefore the entire public surface of
-- the `reviews` table, and every omission is deliberate:
--
--   order_id    a valid argument to a read scoped to buyer/seller/admin. It is
--               not needed for "Verified purchase": a review can only exist if
--               an order exists, so every row here is one by construction.
--   author_id   the author is attributed by display name, which is what a
--               review is. The id only adds machine-linkability.
--   price_epoch how many times a coach has raised a price is not a visitor's
--               business. The epoch still selects WHICH reviews are returned;
--               it is simply not published beside them.
--   updated_at  authors have no UPDATE path, so it can only equal created_at.
--
-- The author name comes from public_profiles, never from profiles, which
-- carries email.
--
-- NOTE, and it is deliberate: this view carries NO `deleted_at` predicate. It
-- is the ACCOUNT-level source — `listReviewsForCoach` reads it for a coach
-- profile, where the reviews of a withdrawn offer must still appear, exactly as
-- they still count in coach_stats. The OFFER-level read
-- (`listReviewsForListing`) adds `join public.listings l on l.id = r.listing_id
-- and l.deleted_at is null` in its own query, which is what makes a withdrawn
-- offer's review list empty. Nothing is disclosed by the difference: those same
-- rows, with the same listing_id, are already published on the coach profile.
-- ---------------------------------------------------------------------------

drop view if exists public.public_reviews;
create view public.public_reviews as
  select
    r.id,
    r.listing_id,
    r.rating,
    r.body,
    r.created_at,
    pp.full_name as author_name
  from public.reviews r
  join public.public_profiles pp on pp.id = r.author_id;

comment on view public.public_reviews is
  'Public projection of reviews: id, listing_id, rating, body, created_at and the author display name. Deliberately excludes order_id (a valid argument to the buyer/seller-scoped order reads), author_id, price_epoch and updated_at. The reviews table itself has no anon policy; this view is the public read. Runs as its owner, so it breaks if FORCE RLS is ever enabled on reviews.';

grant select on public.public_reviews to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The aggregate views: public numbers over private rows.
--
-- Neither view is `security_invoker`, so both execute as their OWNER and read
-- `orders` past the RLS above. That bypass is the point — it is what lets an
-- anonymous browse page show "12 sales" without any visitor being able to ask
-- WHO. Check what they project before granting anything else: counts, an
-- average, and the ids that are already public. No learner_id, no price paid, no
-- created_at that could be correlated back to a buyer.
--
-- Same FORCE RLS caveat as public_profiles: enabling it on orders/reviews would
-- collapse these to rows the caller can already see and every public rating would
-- silently vanish.
-- ---------------------------------------------------------------------------

-- OFFER level: the CURRENT price epoch only, and PUBLISHED offers only.
--
-- `where l.deleted_at is null` in the outer FROM is the aggregate half of the
-- soft-delete rule: a withdrawn offer has no stats row at all, which is the
-- same answer an unknown id gets, which is what a public read of a withdrawn
-- offer should look like. The orders and reviews it counted are NOT deleted and
-- keep counting in coach_stats below.
--
-- Joining `l.price_epoch` into each predicate is what archives an offer's social
-- proof when its price goes up: nothing is deleted, it simply stops matching.
-- The epoch is the FILTER and is NOT projected: the count of price rises is the
-- coach's business, and nothing renders it. (It remains readable on
-- `public.listings` itself, which is world-readable and is the row the
-- offer-update path needs — closing that would mean projecting the public
-- listing read, which is a separate decision.)
-- avg() over no rows is NULL, and that NULL is deliberate all the way out to the
-- UI — a coalesce(...,0) here would render an unrated offer as "0.0", which reads
-- as a bad offer rather than a new one. Ratings are 1-5, so 0 is never a real
-- value and NULL is unambiguous.
drop view if exists public.offer_stats;
create view public.offer_stats as
  select
    l.id          as listing_id,
    (select count(*)
       from public.orders o
      where o.listing_id = l.id
        and o.price_epoch = l.price_epoch)                as sales_count,
    (select count(*)
       from public.reviews r
      where r.listing_id = l.id
        and r.price_epoch = l.price_epoch)                as review_count,
    (select round(avg(r.rating)::numeric, 1)
       from public.reviews r
      where r.listing_id = l.id
        and r.price_epoch = l.price_epoch)                as rating_average
  from public.listings l
 where l.deleted_at is null;

comment on view public.offer_stats is
  'Per-offer sales count, review count and rating average at the offer''s CURRENT price_epoch, for PUBLISHED offers only (deleted_at is null). The epoch filters and is not projected. Public: runs as its owner so it can count private orders rows without exposing any of them. rating_average is NULL when there are no reviews — no write path can store a rating of 0.';

-- COACH ACCOUNT level: every offer, every epoch.
--
-- TWO FILTERS THAT MUST NEVER BE ADDED HERE, whatever gets added to offer_stats
-- or to the public listing reads:
--
--   1. price_epoch. A coach who raised a price did not become a worse coach.
--   2. `l.deleted_at is null`. That predicate now exists, on offer_stats above
--      and on listings_select_public — and it must NOT be copied here.
--      Withdrawing an offer hides it from browse; it must not retroactively
--      delete the coaching that was sold and reviewed. The sales count reads
--      orders.coach_id directly and never touches `listings` at all, so it is
--      immune by construction; the review half joins `listings` only to find out
--      whose offer it was, and that join must stay unfiltered.
--
-- scripts/verify-authz.mts pins this by withdrawing a seeded offer through the
-- real method and asserting these three numbers do not move.
drop view if exists public.coach_stats;
create view public.coach_stats as
  select
    p.id as coach_id,
    (select count(*)
       from public.orders o
      where o.coach_id = p.id)                            as sales_count,
    (select count(*)
       from public.reviews r
       join public.listings l on l.id = r.listing_id
      where l.coach_id = p.id)                            as review_count,
    (select round(avg(r.rating)::numeric, 1)
       from public.reviews r
       join public.listings l on l.id = r.listing_id
      where l.coach_id = p.id)                            as rating_average
  from public.profiles p;

comment on view public.coach_stats is
  'Per-coach sales count, review count and rating average across EVERY offer and EVERY price_epoch. Deliberately ignores price_epoch, and must never gain a soft-delete filter: raising a price or withdrawing an offer does not undo the coaching that was sold. rating_average is NULL when there are no reviews — never 0.';

grant select on public.offer_stats to anon, authenticated;
grant select on public.coach_stats to anon, authenticated;

-- ---------------------------------------------------------------------------
-- coach_applications
-- ---------------------------------------------------------------------------

drop policy if exists coach_applications_select_own on public.coach_applications;
create policy coach_applications_select_own
  on public.coach_applications
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists coach_applications_select_admin on public.coach_applications;
create policy coach_applications_select_admin
  on public.coach_applications
  for select
  to authenticated
  using (public.is_admin());

-- An applicant may file only their own application, and only in the 'pending'
-- state with the review columns blank — they cannot self-approve on insert.
-- The partial unique index coach_applications_one_pending_per_user_idx
-- (0001_init.sql) enforces at most one pending application per user.
--
-- NOTE: applying ALSO has to move the applicant's coach_status to
-- 'pending_review', which this policy cannot do — that write is blocked by the
-- guard trigger. Clients must therefore call public.apply_to_coach() rather
-- than inserting directly; the RPC does both halves in one transaction. This
-- policy remains as the backstop that constrains what an insert may contain.
drop policy if exists coach_applications_insert_own on public.coach_applications;
create policy coach_applications_insert_own
  on public.coach_applications
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and review_note is null
  );

-- Only an admin may UPDATE an application. There is deliberately NO
-- self-update policy: giving the applicant an UPDATE path would let them set
-- status/reviewed_by/reviewed_at (a with-check cannot compare against OLD, so
-- pinning those columns for a self-update would need another guard trigger).
-- Applicants who want to change their pitch withdraw and re-apply.
drop policy if exists coach_applications_update_admin on public.coach_applications;
create policy coach_applications_update_admin
  on public.coach_applications
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists coach_applications_delete_admin on public.coach_applications;
create policy coach_applications_delete_admin
  on public.coach_applications
  for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- invites
--
-- Admin-only on all four verbs. Note there is no `for select` policy for
-- non-admins at all: a learner cannot even enumerate codes to guess at them.
-- Redemption therefore cannot go through the table — it goes through the
-- SECURITY DEFINER function redeem_invite_code() below.
-- ---------------------------------------------------------------------------

drop policy if exists invites_select_admin on public.invites;
create policy invites_select_admin
  on public.invites
  for select
  to authenticated
  using (public.is_admin());

drop policy if exists invites_insert_admin on public.invites;
create policy invites_insert_admin
  on public.invites
  for insert
  to authenticated
  with check (public.is_admin() and created_by = auth.uid());

drop policy if exists invites_update_admin on public.invites;
create policy invites_update_admin
  on public.invites
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists invites_delete_admin on public.invites;
create policy invites_delete_admin
  on public.invites
  for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- PROMOTION RPCs
--
-- Everything that writes profiles.role or profiles.coach_status lives here:
-- redeem_invite_code, apply_to_coach, review_coach_application and grant_admin
-- (plus handle_new_user, which only inserts). Every one of them is owned by
-- javelin_privileged — see the ALTER FUNCTION block at the end — and that
-- ownership is what satisfies the guard trigger's identity test.
--
-- THE PROMOTION RULE, shared by all of them: promotion may only RAISE
-- privilege, never lower it. `role` moves to 'coach' only when it is currently
-- 'learner'. An admin who redeems an invite code, or who is approved as a
-- coach, keeps role = 'admin' — an unconditional assignment would demote them
-- out of every admin policy with no supported way back.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- redeem_invite_code(p_code text)
--
-- Lets an ordinary authenticated user redeem a code without holding ANY
-- privilege on public.invites. The invite is claimed with a conditional UPDATE
-- (which is also the concurrency lock — two simultaneous redemptions cannot
-- both match `redeemed_by is null`), then the redeemer's profile is promoted,
-- in the same transaction.
--
-- Mirrors mockClient.redeemInviteCode().
-- ---------------------------------------------------------------------------

create or replace function public.redeem_invite_code(p_code text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_code    text := btrim(coalesce(p_code, ''));
  v_invite  public.invites;
  v_profile public.profiles;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to redeem an invite code.'
      using errcode = '42501';
  end if;

  if v_code = '' then
    raise exception 'Enter an invite code.' using errcode = '22023';
  end if;

  -- Case-insensitive, whitespace-trimmed lookup. The predicate doubles as the
  -- validity check so the claim is atomic; a losing racer updates 0 rows.
  update public.invites i
     set redeemed_by = v_user_id,
         redeemed_at = now()
   where lower(i.code) = lower(v_code)
     and i.redeemed_by is null
     and i.revoked_at is null
     and (i.expires_at is null or i.expires_at > now())
  returning i.* into v_invite;

  if v_invite.code is null then
    -- Deliberately one undifferentiated message: telling the caller whether a
    -- code exists but is spent turns this into a code oracle.
    raise exception 'That invite code is not valid.' using errcode = '22023';
  end if;

  -- Promotion raises privilege only. An admin redeeming a code stays an admin.
  update public.profiles p
     set role = (case when p.role = 'learner' then 'coach'::public.user_role else p.role end),
         coach_status = 'approved'
   where p.id = v_user_id
  returning p.* into v_profile;

  if v_profile.id is null then
    raise exception 'Your profile could not be found.' using errcode = 'P0002';
  end if;

  return v_profile;
end;
$$;

comment on function public.redeem_invite_code(text) is
  'Atomically claims an invite code for auth.uid() and promotes them to an approved coach (role only rises: an admin stays an admin). SECURITY DEFINER so non-admins can redeem without any privilege on public.invites.';

-- ---------------------------------------------------------------------------
-- apply_to_coach(p_bio, p_experience, p_sport)
--
-- Filing an application has TWO halves: insert the row, and move the
-- applicant's own coach_status to 'pending_review'. The second half is exactly
-- what guard_profile_privilege_columns() forbids a client to do to itself, so a
-- client that inserted directly would commit the application and then be
-- rejected with 42501 — leaving it permanently wedged, because the retry would
-- hit coach_applications_one_pending_per_user_idx. Both halves therefore live
-- here, in one transaction, mirroring the single mutateDb() in
-- mockClient.createCoachApplication().
-- ---------------------------------------------------------------------------

create or replace function public.apply_to_coach(
  p_bio        text,
  p_experience text,
  p_sport      text default null
)
returns public.coach_applications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_status  public.coach_status;
  v_app     public.coach_applications;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to apply.' using errcode = '42501';
  end if;

  if btrim(coalesce(p_bio, '')) = '' or btrim(coalesce(p_experience, '')) = '' then
    raise exception 'Tell us about your background and experience.' using errcode = '22023';
  end if;

  select p.coach_status into v_status from public.profiles p where p.id = v_user_id;

  if v_status is null then
    raise exception 'Your profile could not be found.' using errcode = 'P0002';
  end if;

  -- Mirrors the mock's conflict-on-already-approved check.
  if v_status = 'approved' then
    raise exception 'You are already an approved coach.' using errcode = '23505';
  end if;

  if exists (
    select 1 from public.coach_applications a
    where a.user_id = v_user_id and a.status = 'pending'
  ) then
    raise exception 'You already have an application awaiting review.' using errcode = '23505';
  end if;

  insert into public.coach_applications (user_id, bio, experience, sport)
  values (v_user_id, btrim(p_bio), btrim(p_experience), nullif(btrim(coalesce(p_sport, '')), ''))
  returning * into v_app;

  update public.profiles p
     set coach_status = 'pending_review'
   where p.id = v_user_id;

  return v_app;
end;
$$;

comment on function public.apply_to_coach(text, text, text) is
  'Files a coach application for auth.uid() AND moves their coach_status to pending_review, in one transaction. Clients must use this rather than inserting into coach_applications directly, because the profile half is blocked by guard_profile_privilege_columns().';

-- ---------------------------------------------------------------------------
-- review_coach_application(...)
--
-- Admin decision + applicant promotion in one transaction. Guarded by
-- is_admin() inside the body because SECURITY DEFINER bypasses the RLS that
-- would otherwise do the checking.
--
-- Mirrors mockClient.reviewCoachApplication().
-- ---------------------------------------------------------------------------

create or replace function public.review_coach_application(
  p_application_id uuid,
  p_decision       public.application_status,
  p_note           text default null
)
returns public.coach_applications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id uuid := auth.uid();
  v_app      public.coach_applications;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can review coach applications.'
      using errcode = '42501';
  end if;

  -- `is null` first: `null not in (...)` evaluates to NULL, so the IF would not
  -- fire and the UPDATE below would try to write a null status.
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'A review decision must be approved or rejected.'
      using errcode = '22023';
  end if;

  -- An admin must not review their own application: self-approval is the whole
  -- reason the review queue exists, and combined with promotion it is how an
  -- admin used to accidentally demote themselves.
  if exists (
    select 1 from public.coach_applications a
    where a.id = p_application_id and a.user_id = v_admin_id
  ) then
    raise exception 'You cannot review your own application.' using errcode = '42501';
  end if;

  -- `and status = 'pending'` makes double-review impossible under concurrency.
  update public.coach_applications a
     set status      = p_decision,
         review_note = p_note,
         reviewed_by = v_admin_id,
         reviewed_at = now()
   where a.id = p_application_id
     and a.status = 'pending'
  returning a.* into v_app;

  if v_app.id is null then
    if exists (select 1 from public.coach_applications a where a.id = p_application_id) then
      raise exception 'That application has already been reviewed.' using errcode = '23505';
    end if;
    raise exception 'Application not found.' using errcode = 'P0002';
  end if;

  -- Promotion raises privilege only; rejection never touches role at all.
  --
  -- The `coach_bio` assignment is THE ONE-TIME COPY, and it is the only place in
  -- this schema where text leaves `coach_applications` for anything public. It
  -- is a copy at approval and NOT a live join, because the application bio is a
  -- review artifact written for an administrator: a public profile that SELECTed
  -- it would republish the applicant's private text on every later edit, with no
  -- moment at which anybody decided to publish anything.
  --
  -- `coalesce(nullif(btrim(p.coach_bio), ''), v_app.bio)` is the "only when
  -- empty" rule: a coach who has since written their own bio (or been approved
  -- before) keeps it. `btrim` so a whitespace-only bio counts as empty, matching
  -- hasCoachBio() in mockClient.ts.
  --
  -- Only `bio` is copied. `experience` is prose written to a reviewer, `sport`
  -- is not a dimension in this product, and no integer can be recovered from
  -- free text — so coach_headline and coach_years_coaching stay NULL for the
  -- coach to fill in through policy profiles_update_own.
  update public.profiles p
     set coach_status = (case when p_decision = 'approved' then 'approved' else 'rejected' end)::public.coach_status,
         role = (case
                   when p_decision = 'approved' and p.role = 'learner' then 'coach'::public.user_role
                   else p.role
                 end),
         coach_bio = (case
                        when p_decision = 'approved'
                          then coalesce(nullif(btrim(p.coach_bio), ''), v_app.bio)
                        else p.coach_bio
                      end)
   where p.id = v_app.user_id;

  return v_app;
end;
$$;

comment on function public.review_coach_application(uuid, public.application_status, text) is
  'Admin-only: records a decision on a coach application and mirrors it onto the applicant profile (role only rises) in the same transaction. Refuses self-review.';

-- ---------------------------------------------------------------------------
-- grant_admin(p_user_id uuid)
--
-- The supported way to create or restore an administrator.
--
-- Without this there is no path at all: from psql or the SQL editor auth.uid()
-- is NULL, and every UPDATE that sets role = 'admin' from an API session is
-- refused by the guard trigger. seed.sql only works because INSERT is not
-- guarded — which is no help once the row already exists.
--
-- Callable by an existing admin, or from any non-PostgREST connection (psql,
-- the Supabase SQL editor, a migration). It has no counterpart in the mock,
-- where the seeded admin is created from SEED_ADMIN_EMAIL on first run.
-- ---------------------------------------------------------------------------

create or replace function public.grant_admin(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
begin
  -- NOTE the test is on session_user, not current_user: inside this SECURITY
  -- DEFINER function current_user is always 'javelin_privileged', so a
  -- current_user test would authorise everybody. session_user survives both
  -- SET ROLE and SECURITY DEFINER, and every PostgREST request arrives as
  -- 'authenticator' — so "not authenticator" means psql / SQL editor /
  -- migration, i.e. someone who already has direct database access.
  if not (public.is_admin() or session_user <> 'authenticator') then
    raise exception 'Only an administrator can grant administrator access.'
      using errcode = '42501';
  end if;

  update public.profiles p
     set role = 'admin'
   where p.id = p_user_id
  returning p.* into v_profile;

  if v_profile.id is null then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;

  return v_profile;
end;
$$;

comment on function public.grant_admin(uuid) is
  'Promotes a profile to role = admin. The supported bootstrap/repair path: callable from psql or the SQL editor (where auth.uid() is null) or by an existing admin.';

-- ---------------------------------------------------------------------------
-- handle_new_user()
--
-- Creates the profiles row for every new auth.users row, so a profile can never
-- be missing after signup. Runs as javelin_privileged (see below) because the
-- auth service inserts as supabase_auth_admin, which has no rights in public.
--
-- Always inserts role = 'learner' / coach_status = 'none': signup can never
-- mint a coach, exactly as in mockClient.signUp().
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name, role, coach_status)
  values (
    new.id,
    new.email,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    'learner',
    'none'
  )
  -- Targeted on the PRIMARY KEY, and nothing else. The only conflict worth
  -- swallowing is "a profile for this id already exists" — seed.sql pre-creating
  -- the row, or a replayed trigger — where the user ends up with a profile
  -- either way.
  --
  -- An UNTARGETED `on conflict do nothing` would be a bug: it also swallows a
  -- unique violation on some OTHER column, skipping the insert and leaving the
  -- new user authenticated with no profile row at all. They would then match no
  -- `id = auth.uid()` policy and get P0002 from every RPC, with nothing having
  -- failed visibly at signup. (This is why `profiles.email` no longer carries a
  -- unique constraint — see 0001_init.sql.) A loud signup failure is strictly
  -- better than a silently profile-less account.
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'AFTER INSERT trigger on auth.users: creates the matching public.profiles row as a learner.';

-- Creating a trigger on auth.users requires ownership of that table. On
-- Supabase the migration role has it; on a self-hosted GoTrue you may need to
-- run these two statements as the auth schema owner.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Ownership + grants for the privileged functions.
--
-- This block is what makes `current_user = 'javelin_privileged'` true inside
-- them, and therefore what makes the guard trigger let their profile writes
-- through. It must run AFTER the functions exist.
--
-- CREATE ON SCHEMA IS REQUIRED TO GIVE AN OBJECT AWAY. PostgreSQL checks that
-- the INCOMING owner may create objects in the containing schema, so
-- `alter function ... owner to javelin_privileged` fails with
--
--     42501  permission denied for schema public
--
-- while the role holds only USAGE (granted further up). The privilege is needed
-- for the six statements below and for nothing else, so it is granted here and
-- revoked immediately afterwards rather than left on the role: these functions
-- are SECURITY DEFINER and run AS javelin_privileged, and leaving them standing
-- permission to create objects in `public` widens what any future flaw in one
-- of them could reach. Ownership, once transferred, does not depend on it.
-- ---------------------------------------------------------------------------

grant create on schema public to javelin_privileged;

alter function public.redeem_invite_code(text)                                       owner to javelin_privileged;
alter function public.apply_to_coach(text, text, text)                               owner to javelin_privileged;
alter function public.review_coach_application(uuid, public.application_status, text) owner to javelin_privileged;
alter function public.grant_admin(uuid)                                              owner to javelin_privileged;
alter function public.handle_new_user()                                              owner to javelin_privileged;
-- The revision recorder, for the same reason: no client role holds INSERT on
-- listing_revisions, so the trigger has to write as somebody who does.
alter function public.record_listing_revision()                                      owner to javelin_privileged;

-- Handed back. USAGE (granted earlier) is all the role needs from here on: it
-- must be able to REACH objects in `public`, never to add to it.
revoke create on schema public from javelin_privileged;

revoke all on function public.redeem_invite_code(text) from public;
revoke all on function public.apply_to_coach(text, text, text) from public;
revoke all on function public.review_coach_application(uuid, public.application_status, text) from public;
revoke all on function public.grant_admin(uuid) from public;

grant execute on function public.redeem_invite_code(text) to authenticated;
grant execute on function public.apply_to_coach(text, text, text) to authenticated;
grant execute on function public.review_coach_application(uuid, public.application_status, text) to authenticated;
-- grant_admin is intentionally NOT granted to authenticated: an existing admin
-- runs it from the SQL editor. Grant it explicitly if you build an admin UI for
-- promoting other admins.

-- javelin_privileged must be able to call is_admin() from inside
-- review_coach_application / grant_admin.
grant execute on function public.is_admin() to javelin_privileged;
grant execute on function public.is_approved_coach() to javelin_privileged;
