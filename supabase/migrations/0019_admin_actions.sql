-- ===========================================================================
-- 0019_admin_actions.sql — what an administrator did, and why.
-- ===========================================================================
--
-- `docs/ROADMAP.md` §7: *"No audit log. `grant_admin()` and application
-- decisions leave nothing behind but the mutated row."* Still true of both, and
-- about to be true of two more powers — resolving a report and suspending a
-- coach — so the table comes first and they are written against it rather than
-- retrofitted onto it.
--
-- WHAT IT IS NOT: `removed_reviews`. That table holds review CONTENT, so that
-- somebody can be shown what was taken down, and it has its own erasure path
-- because the content is sometimes exactly what must not persist. This one holds
-- a fact — who did what to whom, when, and why — and it is not erasable by
-- anybody through the application. Folding the two together would mean either
-- an audit log full of other people's text, or a takedown record that can be
-- purged along with the text it justifies.
--
-- NO SUBJECT FOREIGN KEY, deliberately, and the same reasoning as
-- `removed_reviews.review_id`: the subject may be a row that no longer exists by
-- the time anybody reads the log, and an audit record that a cascade can delete
-- is not an audit record. `actor_id` DOES get one, because profiles are never
-- hard-deleted in this application — deletion anonymises — so the reference
-- always resolves to something, even if that something is now called "Deleted
-- account".

do $$
begin
  if not exists (select 1 from pg_type where typname = 'admin_action_kind') then
    create type public.admin_action_kind as enum (
      -- 0002's privileged RPCs, which have always been silent.
      'grant_admin',
      'review_application',
      -- 0016's moderation, which writes `removed_reviews` for the content and
      -- will write here for the fact.
      'remove_review',
      -- 0020 and 0022.
      'resolve_report',
      'set_coach_status'
    );
  end if;
end
$$;

create table if not exists public.admin_actions (
  id           uuid primary key default gen_random_uuid(),
  -- The administrator. Nullable only because ON DELETE SET NULL is the honest
  -- treatment of an audit column — see `removed_reviews.removed_by` and the
  -- lesson `invites.created_by` taught by choosing RESTRICT instead.
  actor_id     uuid references public.profiles (id) on delete set null,
  action       public.admin_action_kind not null,
  -- What it was done to. A profile id, a review id, an application id, a report
  -- id — whatever the action names. Not a foreign key: see the header.
  subject_id   uuid,
  -- Free text from the administrator, or from the RPC describing what it did.
  reason       text,
  created_at   timestamptz not null default now(),

  constraint admin_actions_reason_length check (reason is null or char_length(reason) <= 1000)
);

create index if not exists admin_actions_created_idx on public.admin_actions (created_at desc);
create index if not exists admin_actions_subject_idx on public.admin_actions (subject_id);

comment on table public.admin_actions is
  'Who did what, to whom, when and why - for every power only an administrator holds. Holds FACTS, never content: removed_reviews keeps the text of a removed review, and has its own erasure path, because that text is sometimes exactly what must not persist. Written only by privileged functions; no client role may insert.';

alter table public.admin_actions enable row level security;

-- Administrators read it. Nobody writes it through the API, ever: a client
-- INSERT would let anyone with an admin session fabricate a record of an action
-- that never happened, or — worse — of one somebody else never took.
drop policy if exists admin_actions_select_admin on public.admin_actions;
create policy admin_actions_select_admin
  on public.admin_actions for select to authenticated
  using (public.is_admin());

-- NO INSERT, UPDATE OR DELETE POLICY FOR ANY CLIENT ROLE. An audit row that an
-- administrator can edit or remove is not an audit row, and this is the one
-- table in the schema where even a takedown path would be wrong.
drop policy if exists admin_actions_privileged on public.admin_actions;
create policy admin_actions_privileged
  on public.admin_actions for all to javelin_privileged
  using (true) with check (true);

revoke all on public.admin_actions from anon;
grant select on public.admin_actions to authenticated;
grant select, insert on public.admin_actions to javelin_privileged;

-- ---------------------------------------------------------------------------
-- record_admin_action() — the one writer.
--
-- A function rather than an inline INSERT in each caller, so that "what gets
-- logged" is one thing to read rather than five, and so a caller cannot forget
-- the actor. It is NOT granted to any client role: it is called from inside
-- other privileged functions, which already run as `javelin_privileged`.
-- ---------------------------------------------------------------------------
create or replace function public.record_admin_action(
  p_action public.admin_action_kind,
  p_subject_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.admin_actions (actor_id, action, subject_id, reason)
  values (
    -- `jwt_uid()` and not `auth.uid()`: this runs as javelin_privileged, which
    -- holds no USAGE on the auth schema. 0004 and 0005 are the record of that.
    public.jwt_uid(),
    p_action,
    p_subject_id,
    nullif(btrim(coalesce(p_reason, '')), '')
  );
end;
$$;

comment on function public.record_admin_action(public.admin_action_kind, uuid, text) is
  'Appends one row to admin_actions. Called from inside other privileged functions; deliberately not granted to any client role, because the point of the table is that nothing outside those functions can write it.';

grant create on schema public to javelin_privileged;
alter function public.record_admin_action(public.admin_action_kind, uuid, text) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.record_admin_action(public.admin_action_kind, uuid, text) from public;

-- ---------------------------------------------------------------------------
-- Retrofitting the two powers that were already silent.
--
-- `grant_admin` and `review_coach_application` are re-created verbatim from
-- 0005 with ONE added line each. Recreated in full because CREATE OR REPLACE
-- FUNCTION cannot patch a body — the same reason 0011 restated `claim_offer`.
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
  if not (public.is_admin() or session_user <> 'authenticator') then
    raise exception 'Only an administrator can grant administrator access.'
      using errcode = '42501';
  end if;

  update public.profiles
     set role = 'admin'
   where id = p_user_id
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'That user could not be found.' using errcode = 'P0002';
  end if;

  -- ADDED IN 0019. Note this one can be called from a direct connection, where
  -- `jwt_uid()` is NULL — bootstrapping the first administrator has no actor by
  -- definition. A null `actor_id` there is the honest record.
  perform public.record_admin_action('grant_admin', p_user_id, null);

  return v_profile;
end;
$$;

grant create on schema public to javelin_privileged;
alter function public.grant_admin(uuid) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;
revoke all on function public.grant_admin(uuid) from public;
