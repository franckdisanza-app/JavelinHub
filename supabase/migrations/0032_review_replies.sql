-- ===========================================================================
-- 0032_review_replies.sql — the coach's right of reply.
-- ===========================================================================
--
-- !! NOT APPLIED. Push it, then re-run `npm run verify:supabase`. !!
--
-- ---------------------------------------------------------------------------
-- WHAT IS MISSING WITHOUT THIS
-- ---------------------------------------------------------------------------
-- `docs/ROADMAP.md` §7 leaves a coach exactly one response to a review they
-- think is wrong: report it, and wait for an administrator. That is a
-- moderation path, not an answer, and it is the wrong instrument for the
-- ordinary case — a review that is entirely legitimate and that the coach
-- would like to respond to. A public reply is what makes a bad review
-- survivable, and its absence is felt hardest by the coaches worth keeping.
--
-- ---------------------------------------------------------------------------
-- IT IS A NEW ROW, NEVER A MUTATION, AND THAT IS NOT NEGOTIABLE
-- ---------------------------------------------------------------------------
-- 0016 removed both of the UPDATE routes into `reviews` and said why:
--
--   > `reviews_update_admin` would let an administrator rewrite an opinion
--   > published under a named person's identity … `remove_review()` is now the
--   > only way a review can cease to exist.
--
-- So a reply may not touch the review. It is a separate table with its own
-- author, and the two are joined for display only. Nothing here weakens the
-- rule that a published review is immutable for everybody including its author.
--
-- ---------------------------------------------------------------------------
-- FOUR DECISIONS, EACH THE MIRROR OF ONE `reviews` ALREADY MADE
-- ---------------------------------------------------------------------------
-- 1. ONE REPLY PER REVIEW, as a UNIQUE constraint rather than as application
--    logic — the same instrument `reviews.order_id` uses to make "one review
--    per order" a property of the database. A thread is a different feature
--    with different moderation problems; this is a right of reply.
--
-- 2. NO UPDATE POLICY FOR ANYBODY. A reply is published under the coach's name
--    beside somebody else's words, and a buyer who read it should be reading
--    what is still there. The author's remedy for a bad reply is the same as
--    the review author's: there isn't one, so write it carefully. (This is the
--    stricter choice of the two available and is deliberately the one taken —
--    consistency with `reviews` is worth more here than convenience.)
--
-- 3. DELETE IS ADMIN-ONLY AND GOES THROUGH A FUNCTION, so it is audited. A
--    reply is public text a coach wrote about a named person's review, which is
--    precisely the shape of content that occasionally has to come down.
--    `remove_review_reply` joins the five kinds already in
--    `admin_action_kind`.
--
--    NOTE THE ASYMMETRY WITH `remove_review()`, which archives to
--    `removed_reviews` before deleting. There is no `removed_review_replies`
--    and there should not be: 0016 archives a review because deleting one is
--    the ONLY way it can cease to exist and the aggregate views must not be
--    filtered. A reply feeds no aggregate — it is not in `offer_stats`, not in
--    `coach_stats`, not in any rating — so a plain delete leaves nothing
--    inconsistent. What is kept is the FACT, in `admin_actions`.
--
-- 4. `on delete cascade` FROM THE REVIEW. `remove_review()` deletes the review
--    after archiving it, and a reply to a review that no longer exists is an
--    answer to a question nobody can read. The cascade is what stops one
--    surviving its subject.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--   drop function if exists public.remove_review_reply(uuid, text);
--   drop table if exists public.review_replies;
--   -- the enum value cannot be dropped; it is inert without the function.
--
-- ---------------------------------------------------------------------------
-- ASSERTIONS TO ADD TO `verify:supabase` ONCE APPLIED
-- ---------------------------------------------------------------------------
--   * anon INSERT into review_replies -> 42501
--   * anon UPDATE  into review_replies -> 42501 (no policy exists for any role)
--   * anon DELETE  from review_replies -> 42501
--   * public_review_replies is readable by anon -> 200
--   * remove_review_reply() answers anon with its own sentence
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The enum value, DELIBERATELY OUTSIDE THE TRANSACTION BELOW.
-- ---------------------------------------------------------------------------
-- PG 12+ permits `alter type ... add value` inside a transaction block, but
-- only as long as the new value is not USED in the same transaction — and the
-- rule is subtle enough that a later edit adding a seed row would break the
-- migration in a way that reads as unrelated. Outside the block there is no
-- rule to remember.
--
-- `if not exists` keeps it idempotent, which is what makes a re-run safe. It is
-- also why the rollback at the top does not drop it: Postgres cannot remove an
-- enum value, and an unused one is inert.
alter type public.admin_action_kind add value if not exists 'remove_review_reply';

begin;

create table if not exists public.review_replies (
  id         uuid primary key default gen_random_uuid(),
  -- UNIQUE: one reply per review. See decision 1.
  review_id  uuid not null unique references public.reviews (id) on delete cascade,
  -- The coach. Denormalised rather than derived through the listing join, for
  -- the same reason `reviews.listing_id` is: every read of a reply needs to
  -- know whose it is, and the insert policy pins it so it cannot drift.
  coach_id   uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (btrim(body) <> '' and char_length(body) <= 2000),
  created_at timestamptz not null default now(),
  -- 0006's flag, extended by 0027 to the tables added since. Every table that
  -- can hold a fixture carries it, so `demo_data_summary` and
  -- `npm run check:demo-data` see this one too.
  is_demo    boolean not null default false
);

comment on table public.review_replies is
  'A coach''s public answer to a review of their own offer. One per review, never editable by anybody, deletable only by an administrator through remove_review_reply(). Feeds no aggregate — not offer_stats, not coach_stats, not any rating.';

create index if not exists review_replies_coach_id_idx on public.review_replies (coach_id);
create index if not exists review_replies_is_demo_idx on public.review_replies (is_demo) where is_demo;

alter table public.review_replies enable row level security;

-- ---------------------------------------------------------------------------
-- SELECT — public. A reply is published beside a review that is already public.
-- ---------------------------------------------------------------------------
drop policy if exists review_replies_select_public on public.review_replies;
create policy review_replies_select_public
  on public.review_replies for select
  using (true);

-- ---------------------------------------------------------------------------
-- INSERT — the coach who owns the listing the review is about, and nobody else.
-- ---------------------------------------------------------------------------
-- Two conditions and both are load-bearing. `coach_id = auth.uid()` stops a
-- reply being filed under somebody else's name; the EXISTS stops a coach
-- replying to a review of an offer that is not theirs. Neither implies the
-- other: an approved coach passing only the first would be able to answer every
-- review on the site under their own byline.
--
-- The listing is read WITHOUT `deleted_at is null` on purpose. A withdrawn
-- offer keeps its reviews — `/offers/[id]` renders a tombstone for exactly that
-- case — and a coach who withdraws an offer should still be able to answer what
-- was said about it.
drop policy if exists review_replies_insert_coach on public.review_replies;
create policy review_replies_insert_coach
  on public.review_replies for insert
  to authenticated
  with check (
    coach_id = (select auth.uid())
    and exists (
      select 1
        from public.reviews r
        join public.listings l on l.id = r.listing_id
       where r.id = review_id
         and l.coach_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- UPDATE and DELETE — no policy, for any role. See decisions 2 and 3.
-- ---------------------------------------------------------------------------
-- Stated as an absence rather than left implicit: RLS denies what no policy
-- admits, so writing nothing here IS the rule. `remove_review_reply()` below is
-- SECURITY DEFINER and reaches the table as its owner, which is why it works
-- without one.

-- ---------------------------------------------------------------------------
-- THE REVOKE COMES FIRST, AND IT IS NOT DEFENSIVE TIDINESS.
-- ---------------------------------------------------------------------------
-- 0028's header states the rule this schema has now met three times: *"On this
-- project, CREATING ANYTHING IN `public` GRANTS IT TO `anon` AND
-- `authenticated` BY DEFAULT. That applies to tables, to views, and — as 0024
-- found the hard way … — to functions."* The bootstrap runs
--
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated, service_role;
--
-- so `create table` above has ALREADY handed every column, including `is_demo`,
-- to the publishable key. Adding column grants on top of that changes nothing;
-- the revoke is what makes them the only ones. 0020 does the same thing one
-- line before granting `reports`.
revoke all on public.review_replies from anon, authenticated;
do $$
begin
  execute 'revoke all on public.review_replies from service_role';
exception
  when undefined_object then null;
end
$$;

-- Column-level grants, the same shape 0002 uses everywhere. `is_demo` is
-- withheld from clients: it is an operator's flag, and publishing it tells a
-- visitor which rows are fabricated.
grant select (id, review_id, coach_id, body, created_at) on public.review_replies to anon, authenticated;
grant insert (review_id, coach_id, body) on public.review_replies to authenticated;

-- ---------------------------------------------------------------------------
-- The read model. A view rather than a bare grant, matching public_reviews.
-- ---------------------------------------------------------------------------
-- NO `security_invoker`, AND IT JOINS `public_profiles` RATHER THAN `profiles`.
-- Both halves are the idiom 0003 established and neither is optional here:
--
--   * `profiles` is readable only by its owner and by an administrator
--     (`profiles_select_self` / `_admin`), so an invoker-run view joining it
--     would return a NAME for the reader's own reply and NULL for everybody
--     else's — a view that silently answers differently per caller.
--   * `public_profiles` is itself an owner-run view that projects away email,
--     role and coach_status by construction, so the name is the only thing that
--     can come out of it. Joining the base table and selecting one column would
--     work today and would leak on the day somebody adds a column to the select.
drop view if exists public.public_review_replies;
create view public.public_review_replies as
  select
    rr.id,
    rr.review_id,
    rr.coach_id,
    rr.body,
    rr.created_at,
    pp.full_name as coach_name
  from public.review_replies rr
  join public.public_profiles pp on pp.id = rr.coach_id;

comment on view public.public_review_replies is
  'Replies joined to the replying coach''s display name, through public_profiles so no other profile column can be reached. Owner-run like every other read model here, which is what lets it resolve a name past profiles_select_self. Exposes no is_demo.';

grant select on public.public_review_replies to anon, authenticated;

-- ---------------------------------------------------------------------------
-- `demo_data_summary` — the tenth table, and the revoke that has to follow it.
-- ---------------------------------------------------------------------------
-- `review_replies` carries `is_demo`, so it has to appear here or
-- `npm run check:demo-data` reports a clean database while fabricated replies
-- sit in it — the exact failure 0027 was written to fix for three other tables.
--
-- A view cannot be extended in place, so this is `drop` + `create`, WHICH
-- RE-GRANTS IT TO anon AND authenticated. 0027 did precisely this and reopened
-- the leak 0007 had closed; 0028 closed it again and wrote the rule down. The
-- revoke below is that rule being followed rather than rediscovered.
drop view if exists public.demo_data_summary;
create view public.demo_data_summary as
  select 'profiles'           as table_name, count(*) as rows from public.profiles           where is_demo
  union all
  select 'listings',           count(*) from public.listings           where is_demo
  union all
  select 'orders',             count(*) from public.orders             where is_demo
  union all
  select 'reviews',            count(*) from public.reviews            where is_demo
  union all
  select 'invites',            count(*) from public.invites            where is_demo
  union all
  select 'coach_applications', count(*) from public.coach_applications where is_demo
  union all
  select 'removed_reviews',    count(*) from public.removed_reviews    where is_demo
  union all
  select 'deliverables',       count(*) from public.deliverables       where is_demo
  union all
  select 'reports',            count(*) from public.reports            where is_demo
  union all
  select 'review_replies',     count(*) from public.review_replies     where is_demo;

revoke all on public.demo_data_summary from anon, authenticated;

comment on view public.demo_data_summary is
  'Counts of fabricated rows per table, across all ten tables that carry is_demo. REVOKED from anon and authenticated (0007, again in 0028 after 0027 recreated the view, and again in 0032 for the same reason) - readable only with direct database access, because it is a pre-launch check rather than something the app shows. `select * from public.demo_data_summary where rows > 0;`';

-- ---------------------------------------------------------------------------
-- Removal — administrator only, audited, no archive. See decision 3.
-- ---------------------------------------------------------------------------
create or replace function public.remove_review_reply(p_reply_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exists boolean;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can remove a reply.'
      using errcode = '42501';
  end if;

  select true into v_exists from public.review_replies where id = p_reply_id;
  if v_exists is null then
    raise exception 'That reply could not be found.'
      using errcode = 'P0002';
  end if;

  -- The fact first, then the row. If the delete fails the transaction takes the
  -- audit row with it; if the order were reversed a crash between them would
  -- leave a deletion nobody recorded.
  perform public.record_admin_action('remove_review_reply', p_reply_id, p_reason);
  delete from public.review_replies where id = p_reply_id;
end;
$$;

comment on function public.remove_review_reply(uuid, text) is
  'Deletes a coach reply and records the fact in admin_actions. Administrator only. No archive table, unlike remove_review(): a reply feeds no aggregate, so deleting one leaves nothing inconsistent to reconcile.';

-- The owner dance 0014 established: the function must run as a role that can
-- reach the table past RLS, and `javelin_privileged` needs CREATE on the schema
-- only for the moment of the ALTER.
grant create on schema public to javelin_privileged;
alter function public.remove_review_reply(uuid, text) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

-- THE REVOKE THAT ACTUALLY CLOSES IT. `revoke ... from public` alone is inert
-- on Supabase, whose bootstrap grants EXECUTE on every new function in `public`
-- to anon, authenticated and service_role. 0019 shipped that hole and 0024
-- closed it; 0031 found the same trap a second time in `grant_admin`. Naming
-- the roles is what makes the revoke real.
revoke all on function public.remove_review_reply(uuid, text) from public, anon, authenticated;
do $$
begin
  execute 'revoke all on function public.remove_review_reply(uuid, text) from service_role';
exception
  when undefined_object then null;
end
$$;
grant execute on function public.remove_review_reply(uuid, text) to authenticated;

commit;
