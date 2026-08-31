-- ===========================================================================
-- 0018_delete_my_account.sql — leaving, without rewriting anybody else.
-- ===========================================================================
--
-- Deletion is not optional under GDPR, and the naive version — remove the row —
-- is either impossible or destructive here. The foreign-key graph decides it,
-- not the application:
--
--   profiles.id      -> auth.users   CASCADE   deleting the GoTrue user deletes
--                                              the profile
--   listings.coach_id -> profiles    CASCADE   ...which deletes their offers
--   orders.listing_id -> listings    RESTRICT  ...but an offer that SOLD cannot
--                                              be deleted, so the cascade
--                                              hits a wall halfway
--   orders.learner_id -> profiles    CASCADE   deleting a buyer deletes their
--                                              purchases
--   reviews.author_id -> profiles    CASCADE   ...and their reviews
--   invites.created_by -> profiles   RESTRICT  an admin who minted a code
--                                              cannot be deleted at all
--
-- Read together: **a coach who has ever sold anything cannot be deleted**, and a
-- learner who deletes silently reduces some coach's sales count and rating —
-- rewriting a third party's history to honour a first party's request.
--
-- -----------------------------------------------------------------------------
-- SO: ANONYMISE, DO NOT ERASE
-- -----------------------------------------------------------------------------
-- Erasure covers personal data. The transaction records a marketplace keeps —
-- who bought what, what it cost, what was said about it — rest on a different
-- basis and belong to the counterparty as much as to the departing user. So the
-- personal data goes and the rows stay:
--
--   full_name    -> 'Deleted account'
--   email        -> deleted+<id>@javelinhub.invalid  (.invalid is reserved by
--                   RFC 2606 and can never route anywhere)
--   avatar_path  -> null; the object is deleted by the application
--   the three coach columns -> null
--   role/coach_status -> learner/none, so a departed coach stops being one
--   deleted_at   -> now(), which is what the app refuses a session on
--
-- Nobody else's rating, sales count or purchase history moves. A review by a
-- departed user still renders, attributed to "Deleted account", because
-- `public_profiles` publishes `full_name` and that is now what it says.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS FUNCTION DELIBERATELY DOES NOT DO, and why it refuses instead
-- -----------------------------------------------------------------------------
-- **It does not withdraw the caller's offers, and it will not run until
-- somebody else has.**
--
-- It cannot. `guard_listing_update()` is SECURITY INVOKER and assigns
-- `new.deleted_by := auth.uid()` on any change to `deleted_at`. Inside a
-- SECURITY DEFINER function owned by `javelin_privileged`, that call is the dead
-- end `0004` is kept in the tree to record: the role holds no USAGE on the
-- `auth` schema and never can, which is why `public.jwt_uid()` exists at all.
-- A withdrawal issued from here would fail with 42501 naming a schema the caller
-- has never heard of.
--
-- The alternative was to rewire that trigger onto `jwt_uid()` the way 0005
-- rewired three functions. Rejected: it is a core trigger on the write path of
-- every offer in the system, and changing it to enable a rarely-used flow is a
-- large blast radius for a small feature.
--
-- Instead the ordering becomes an INVARIANT rather than a convention. The
-- application withdraws each offer through the ordinary owner path — where
-- `auth.uid()` resolves, because the statement really is coming from that user —
-- and this function REFUSES while any of them is still on sale. So "deleted the
-- account but left the offers selling" is not a state that can exist, however
-- the caller sequences their requests.
--
-- -----------------------------------------------------------------------------
-- AND IT DOES NOT TOUCH auth.users
-- -----------------------------------------------------------------------------
-- Same reason, and here it matters more: `javelin_privileged` cannot reach that
-- schema, so the GoTrue user survives this call and its JWT stays valid. The
-- application bans it through the admin API immediately afterwards, and refuses
-- the session on its own side in the meantime — see
-- `src/lib/auth/account-deletion.ts`. Deleting the GoTrue user would have been
-- worse than useless: `profiles.id` cascades from it, so it would destroy the
-- very row this function just took such care to preserve.

alter table public.profiles add column if not exists deleted_at timestamptz;

comment on column public.profiles.deleted_at is
  'When the owner deleted their account. The row survives and is ANONYMISED - orders, reviews and listings reference it, and erasing it would rewrite other people''s sales and ratings. The application refuses a session whose profile carries this.';

-- Partial, because the only question ever asked of it is "is this one deleted",
-- and almost every row answers no.
create index if not exists profiles_deleted_at_idx
  on public.profiles (deleted_at) where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- delete_my_account() — the caller's own account, and only ever their own.
--
-- No parameter, deliberately: there is no id to pass and therefore no id to
-- forge. The subject is `public.jwt_uid()` and nothing else.
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := public.jwt_uid();
  v_profile public.profiles;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to delete your account.' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where id = v_user_id for update;
  if not found then
    raise exception 'Your account could not be found.' using errcode = 'P0002';
  end if;

  -- Already gone. Idempotent rather than an error: a second click, or a retry
  -- after the ban step failed, should not look like a failure to the user.
  if v_profile.deleted_at is not null then
    return;
  end if;

  -- THE INVARIANT. See the header: this function cannot withdraw offers itself,
  -- so it refuses to leave any selling. The message names the action rather than
  -- the mechanism, because the person reading it is trying to leave.
  if exists (
    select 1 from public.listings l
     where l.coach_id = v_user_id and l.deleted_at is null
  ) then
    raise exception 'Take your offers off sale before deleting your account.'
      using errcode = '22023';
  end if;

  -- AN ADMINISTRATOR CANNOT DELETE THEMSELVES, and this is the accepted answer
  -- rather than a bug. `invites.created_by` is ON DELETE RESTRICT because an
  -- invite is the audit record of who granted somebody coach status; relaxing it
  -- to SET NULL would weaken that record to enable a rare flow. So an
  -- administrator is removed by another administrator, and this says so.
  --
  -- Checked on the ROLE rather than on whether they hold invites: an admin who
  -- happens to have minted none today could still delete themselves and then
  -- mint one tomorrow, which is a rule nobody could predict.
  if v_profile.role = 'admin' then
    raise exception 'An administrator account is removed by another administrator.'
      using errcode = '42501';
  end if;

  update public.profiles
     set full_name            = 'Deleted account',
         -- RFC 2606 reserves `.invalid`, so this can never reach a mailbox — and
         -- it stays unique per account, which matters because `signUp` checks
         -- the credential table for duplicates.
         email                = 'deleted+' || v_user_id::text || '@javelinhub.invalid',
         avatar_path          = null,
         coach_headline       = null,
         coach_bio            = null,
         coach_years_coaching = null,
         -- A departed coach stops being one. `public_coaches` filters on
         -- `coach_status = 'approved'`, so this alone removes them from the
         -- directory with no extra predicate anywhere.
         role                 = 'learner',
         coach_status         = 'none',
         deleted_at           = now()
   where id = v_user_id;
end;
$$;

comment on function public.delete_my_account() is
  'Anonymises the CALLER OWN profile and marks it deleted. Takes no id: the subject is jwt_uid() and cannot be forged. Refuses while any of their offers is still on sale, because it cannot withdraw them itself - guard_listing_update() calls auth.uid(), which javelin_privileged cannot reach. Does not touch auth.users; the application bans the GoTrue user separately.';

-- Ownership and grants: the same CREATE-then-revoke dance as every other
-- privileged function here.
grant create on schema public to javelin_privileged;
alter function public.delete_my_account() owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.delete_my_account() from public;
-- `authenticated` only. An anonymous caller has no account to delete, and the
-- function refuses them anyway — but there is no reason to let them reach it.
grant execute on function public.delete_my_account() to authenticated;
