-- ===========================================================================
-- 0033 — record that somebody agreed to the terms, and which terms.
-- ===========================================================================
--
-- WHAT WAS MISSING. The signup form took a name, an email and a password.
-- Nothing asked the person to agree to anything, and nothing recorded that they
-- had — so for every account in this database the honest answer to "did this
-- user accept the terms?" was "we do not know". A marketplace that intends to
-- take money cannot answer a chargeback, a takedown or a change of terms from
-- that position.
--
-- THE TWO COLUMNS ARE A RECORD, WHICH MEANS THE SUBJECT MAY NOT WRITE THEM.
-- That is the whole design, and it is why this file is not just an `alter
-- table`:
--
--   * `handle_new_user()` stamps them, so they are written exactly once, by the
--     database, at the moment the account is created;
--   * `guard_profile_privilege_columns()` pins them, so no `PATCH /profiles`
--     through PostgREST can move them afterwards;
--   * the timestamp is `now()` — the DATABASE clock — and never a value the
--     caller supplied. The version IS caller-supplied, and deliberately: it
--     says which documents were displayed, which only the client knows.
--
-- NULL MEANS NO RECORD, AND IS NEVER BACKFILLED. Every account that exists
-- today was created before signup asked, so every existing row keeps `null`.
-- Inventing a timestamp for those rows would produce a consent record
-- indistinguishable from a real one, which is worse than having none: the
-- column would stop being evidence of anything.

alter table public.profiles
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version     text;

comment on column public.profiles.terms_accepted_at is
  'When this account agreed to the terms and privacy notice, from the DATABASE clock. NULL means no record — every account created before signup asked, and anyone who called GoTrue directly. Never backfill it: an invented consent record cannot be told from a real one.';

comment on column public.profiles.terms_version is
  'Which version of the documents was accepted — LEGAL_LAST_UPDATED at the time, e.g. 2026-09-01. Supplied by the client because only the client knows what it displayed; bounded below.';

-- A version marker is a short date string. The bound is not about storage: it
-- is what stops a caller parking a paragraph in the consent record through
-- GoTrue's user metadata, which is the one field in this pair they control.
alter table public.profiles
  drop constraint if exists profiles_terms_version_length;
alter table public.profiles
  add constraint profiles_terms_version_length
  check (terms_version is null or char_length(terms_version) between 1 and 40);

-- ---------------------------------------------------------------------------
-- handle_new_user() — now stamps the consent record.
--
-- Unchanged in every other respect, and restated in full rather than patched
-- because `create or replace function` has no other form. The `on conflict (id)
-- do nothing` and the reasoning behind its targeting are carried over verbatim
-- from 0002; read that file's version before editing this one.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Trimmed and emptied-to-null in one step, so that metadata carrying `""`
  -- records "no version" rather than an empty string that reads as a version.
  v_terms_version text := nullif(btrim(new.raw_user_meta_data ->> 'terms_version'), '');
begin
  insert into public.profiles (
    id, email, full_name, role, coach_status, terms_accepted_at, terms_version
  )
  values (
    new.id,
    new.email,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    'learner',
    'none',
    -- BOTH OR NEITHER. A timestamp with no version says somebody agreed to
    -- something unidentifiable; a version with no timestamp says nothing about
    -- when. Signing up through anything other than this app's form supplies
    -- neither, and lands on (null, null), which is the honest record of that.
    case when v_terms_version is null then null else now() end,
    -- Truncated rather than rejected. This is an AFTER INSERT trigger on
    -- auth.users: raising here would fail a signup that GoTrue has already
    -- accepted, leaving a credential with no profile — the exact failure the
    -- `on conflict` targeting below exists to avoid. The CHECK constraint above
    -- is the bound; this keeps the trigger inside it without ever refusing.
    left(v_terms_version, 40)
  )
  -- Targeted on the PRIMARY KEY, and nothing else. See 0002_rls.sql for why an
  -- untargeted `on conflict do nothing` here would be a bug.
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'AFTER INSERT trigger on auth.users: creates the matching public.profiles row as a learner, and stamps the terms acceptance when the signup carried a terms_version in its user metadata.';

alter function public.handle_new_user() owner to javelin_privileged;

-- ---------------------------------------------------------------------------
-- guard_profile_privilege_columns() — now pins the consent record too.
--
-- Restated in full for the same reason as above. The only change is the block
-- marked below; everything else is 0002's text.
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

  if (new.coach_headline       is distinct from old.coach_headline
   or new.coach_bio            is distinct from old.coach_bio
   or new.coach_years_coaching is distinct from old.coach_years_coaching)
     and not public.is_approved_coach() then
    raise exception 'Only approved coaches can edit a public coach profile.'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id then
    raise exception 'You cannot change a profile id.' using errcode = '42501';
  end if;

  if new.email is distinct from old.email then
    raise exception 'You cannot change your email here.' using errcode = '42501';
  end if;

  -- ADDED IN 0033. A consent record its subject can edit is not a consent
  -- record: without this, the same `PATCH /rest/v1/profiles?id=eq.<self>` that
  -- updates a display name could move the acceptance date, change which
  -- documents were agreed to, or clear the record entirely. `is distinct from`
  -- rather than `<>` because NULL is the normal value on every existing row,
  -- and `NULL <> NULL` is NULL — which would not fire the guard at all.
  --
  -- Note that the ADMIN arm above returns before this. That is consistent with
  -- the rest of the guard rather than a hole: an administrator can already read
  -- and write every profile, and the audited record of what an administrator
  -- did lives in `admin_actions`.
  if new.terms_accepted_at is distinct from old.terms_accepted_at
   or new.terms_version    is distinct from old.terms_version then
    raise exception 'You cannot change your own record of accepting the terms.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.guard_profile_privilege_columns() is
  'BEFORE UPDATE guard on profiles: rejects self-service changes to role, coach_status, id, email and the terms-acceptance record outright, and rejects changes to coach_headline / coach_bio / coach_years_coaching unless the writer is an approved coach. SECURITY INVOKER on purpose, so current_user identifies the real writer. Exists because an RLS with-check cannot reference OLD.';

-- The trigger already points at this function by name and needs no re-creation;
-- restated here only so that reading this file tells you it is still attached.
drop trigger if exists profiles_guard_privilege_columns on public.profiles;
create trigger profiles_guard_privilege_columns
  before update on public.profiles
  for each row execute function public.guard_profile_privilege_columns();

-- ---------------------------------------------------------------------------
-- delete_my_account() is deliberately NOT changed.
--
-- Anonymising an account clears the name, the address, the picture and the
-- three coach columns. It does not clear this record, and should not: the fact
-- that a person agreed to the terms on a date is what the platform relies on
-- for the transactions that already happened, and those survive the deletion
-- for exactly the reasons `0018` sets out. The record names no personal data
-- on its own — a timestamp and a version string, attached to a row whose
-- identifying columns are gone.
-- ---------------------------------------------------------------------------
