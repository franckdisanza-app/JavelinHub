-- ===========================================================================
-- 0005_privileged_uid.sql — stop the privileged functions depending on the
--                           `auth` schema they can never be granted.
-- ===========================================================================
--
-- 0004 tried to fix this with `grant usage on schema auth to javelin_privileged`
-- and SILENTLY DID NOTHING. That is worth stating plainly, because the failure
-- mode is nastier than an error: PostgreSQL answers a GRANT you have no right
-- to make with a WARNING, not an exception, so `supabase db push` reported
-- success and `has_schema_privilege('javelin_privileged','auth','USAGE')` was
-- still false afterwards. The ACL says why:
--
--     auth: supabase_admin=UC/supabase_admin, ..., postgres=U/supabase_admin
--
-- `postgres` — the role migrations run as — holds USAGE on `auth` WITHOUT grant
-- option, and the schema is owned by `supabase_admin`, which is not a role this
-- project can become. So no migration can ever hand `auth` to a custom role.
--
-- WHY ONLY THESE THREE FUNCTIONS ARE AFFECTED, out of the 40 `auth.uid()` uses
-- in 0002: everything else is an RLS policy, and a policy is evaluated as the
-- CALLER — `anon` and `authenticated` both hold USAGE on `auth` from Supabase's
-- own bootstrap. Only a SECURITY DEFINER function owned by `javelin_privileged`
-- resolves `auth.uid()` as that role, and that role has nothing in `auth`.
-- (`grant_admin` and `record_listing_revision` share the owner but never call
-- it; the one occurrence in `handle_new_user` is inside a comment.)
--
-- The fix is to take the identity from the same place `auth.uid()` does — the
-- request's JWT claims, exposed as a GUC — through a function in `public`,
-- which `javelin_privileged` can reach. `current_setting()` is a built-in, so
-- this needs no schema privilege at all and cannot regress the same way.
--
-- THIS IS NOT A SECOND SOURCE OF IDENTITY. `public.jwt_uid()` reads the exact
-- claim `auth.uid()` reads, in the same order, with the same fallback; the RLS
-- policies continue to call `auth.uid()` and the two agree by construction. If
-- Supabase ever changes how the claim is published, both must move together.

-- ---------------------------------------------------------------------------
-- public.jwt_uid() — `auth.uid()` without the schema dependency.
--
-- SECURITY INVOKER (the default) and deliberately so: it reads a per-request
-- GUC, which is the same value whoever executes it, and making it DEFINER would
-- add an owner to reason about for no gain. `stable`, not `immutable` — the
-- answer changes between requests.
-- ---------------------------------------------------------------------------
create or replace function public.jwt_uid()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $jwt_uid$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$jwt_uid$;

comment on function public.jwt_uid() is
  'The calling user id, read from the request JWT claims exactly as auth.uid() reads it. Exists because SECURITY DEFINER functions owned by javelin_privileged cannot resolve auth.uid(): the auth schema is owned by supabase_admin and USAGE on it cannot be granted onward by the migration role. RLS policies still use auth.uid(); the two must always agree.';

revoke all on function public.jwt_uid() from public;
grant execute on function public.jwt_uid() to anon, authenticated, javelin_privileged;

-- ---------------------------------------------------------------------------
-- The three functions, re-created verbatim from 0002 with the single
-- substitution `auth.uid()` -> `public.jwt_uid()`. Nothing else differs.
--
-- `create or replace function` PRESERVES the existing owner, so these stay
-- owned by javelin_privileged and `current_user` inside them is unchanged —
-- which is what guard_profile_privilege_columns asserts on. Ownership is
-- re-stated at the bottom anyway, so this migration is also correct when
-- applied to a database where 0002 somehow left them owned by someone else.
-- ---------------------------------------------------------------------------


create or replace function public.redeem_invite_code(p_code text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := public.jwt_uid();
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
  v_user_id uuid := public.jwt_uid();
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
  v_admin_id uuid := public.jwt_uid();
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


-- ---------------------------------------------------------------------------
-- Re-assert ownership. See the note in 0002: the INCOMING owner needs CREATE on
-- the schema for the duration of the transfer, and gets it back afterwards.
-- ---------------------------------------------------------------------------
grant create on schema public to javelin_privileged;

alter function public.redeem_invite_code(text)                                       owner to javelin_privileged;
alter function public.apply_to_coach(text, text, text)                               owner to javelin_privileged;
alter function public.review_coach_application(uuid, public.application_status, text) owner to javelin_privileged;

revoke create on schema public from javelin_privileged;

-- `create or replace` resets neither the grants nor the revokes on a function,
-- but re-stating them costs nothing and keeps this file independently correct.
revoke all on function public.redeem_invite_code(text) from public;
revoke all on function public.apply_to_coach(text, text, text) from public;
revoke all on function public.review_coach_application(uuid, public.application_status, text) from public;

grant execute on function public.redeem_invite_code(text) to authenticated;
grant execute on function public.apply_to_coach(text, text, text) to authenticated;
grant execute on function public.review_coach_application(uuid, public.application_status, text) to authenticated;
