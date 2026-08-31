-- ===========================================================================
-- 0017_sync_profile_email.sql — the half of an email change nothing could do.
-- ===========================================================================
--
-- `profiles.email` is a copy of `auth.users.email`, written ONCE:
-- `handle_new_user()` is an `AFTER INSERT` trigger, and there is no UPDATE
-- trigger on `auth.users` anywhere in this schema. Meanwhile
-- `guard_profile_privilege_columns()` pins the column against every client
-- write with its own sentence — *"You cannot change your email here."*
--
-- So the two halves together mean a successful GoTrue email change would leave
-- `profiles.email` holding the OLD address permanently, with no code path in
-- the application able to correct it. Not a stale cache that heals on the next
-- write: nothing writes it, ever again.
--
-- That column is not decorative. `changeMyPassword` reads it to verify a
-- current password (GoTrue has no "check this password" endpoint, so the
-- verification is a real sign-in for that address), and `/settings` renders it
-- as "the address you sign in with". Both would quietly be about an address the
-- user no longer has.
--
-- -----------------------------------------------------------------------------
-- WHY A TRIGGER RATHER THAN AN APPLICATION WRITE
-- -----------------------------------------------------------------------------
-- Because the moment the address actually changes is not a moment the
-- application is present for. With Supabase's "Secure email change" the change
-- lands only after BOTH the old and the new address have confirmed, and each
-- confirmation is a link clicked hours later, in a different browser, possibly
-- by a different person. GoTrue applies it server-side; there is no request of
-- ours in flight to observe it.
--
-- A trigger is the only place that sees it every time.
--
-- `OF email` narrows it to the column that matters: `auth.users` is written on
-- every sign-in (last_sign_in_at, token rotation), and firing a profile UPDATE
-- on each of those would put a write amplification on the hottest table in the
-- system for nothing.

create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- `is distinct from` rather than `<>`: NULL is a legal value for
  -- `auth.users.email` (a phone-only account), and `NULL <> NULL` is NULL,
  -- which would skip the update rather than perform it.
  if new.email is distinct from old.email and new.email is not null then
    update public.profiles p
       set email = new.email
     where p.id = new.id;
  end if;
  return new;
end;
$$;

comment on function public.sync_profile_email() is
  'AFTER UPDATE OF email trigger on auth.users: copies the new address onto public.profiles. The ONLY writer of that column after signup - guard_profile_privilege_columns refuses every client write to it, and handle_new_user only ever runs on INSERT.';

-- Owned by `javelin_privileged` for the same reason `handle_new_user` is, and
-- it is load-bearing rather than tidy: `guard_profile_privilege_columns()`
-- refuses any change to `profiles.email` unless `current_user` is that role (or
-- the connection is a direct one). A trigger owned by anybody else would be
-- refused by another trigger, and the failure would surface as a broken email
-- confirmation rather than as anything mentioning profiles.
--
-- Same CREATE-then-revoke dance as 0002 and 0013: the privilege is needed only
-- to hand the object over.
grant create on schema public to javelin_privileged;
alter function public.sync_profile_email() owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.sync_profile_email() from public;

-- Creating a trigger on `auth.users` requires ownership of that table. On
-- Supabase the migration role has it — 0002 already relies on exactly this for
-- `on_auth_user_created`.
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.sync_profile_email();
