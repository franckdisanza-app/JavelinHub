-- ===========================================================================
-- 0027_demo_flag_for_newer_tables.sql — keeping 0006's promise.
-- ===========================================================================
--
-- `0006` added `is_demo` to the six tables that existed then, and gave a reason
-- that is not about tidiness: fabricated rows are indistinguishable from real
-- ones once they are in a table, "a marketplace that ships with invented
-- five-star reviews attached to named coaches is a trust problem", and "we will
-- remember to take them out" is not a mechanism.
--
-- Three tables have landed since and none of them carries the flag:
-- `removed_reviews` (0016), `deliverables` (0011) and `reports` (0020). Two of
-- those are about to hold fabricated rows — the demo seed files a review report
-- and a coach report so the moderation queue has something in it — and
-- `demo_data_summary` would answer "no fabricated data" while both sat there.
-- A flag that is right about six tables and silent about three is worse than no
-- flag, because the summary reads as complete.
--
-- `admin_actions` (0019) is deliberately NOT given one. It is append-only with
-- no UPDATE or DELETE policy for any role, and the rows in it are written by
-- `record_admin_action()` from inside five privileged functions — there is no
-- INSERT path that could set a flag, and adding one would mean widening the
-- writer to take an argument that exists only for fixtures. A demo audit line
-- is identifiable by its actor, which is a demo profile, and that is enough.
--
-- Everything else follows 0006 exactly: no grant to any client role, no
-- behaviour, nothing filters on it, nothing hides a demo row.

alter table public.removed_reviews add column if not exists is_demo boolean not null default false;
alter table public.deliverables    add column if not exists is_demo boolean not null default false;
alter table public.reports         add column if not exists is_demo boolean not null default false;

comment on column public.removed_reviews.is_demo is
  'TRUE for fabricated fixture rows. Operator-facing only; nothing filters on it. See 0006.';
comment on column public.deliverables.is_demo is
  'TRUE for fabricated fixture rows. Operator-facing only; nothing filters on it. See 0006.';
comment on column public.reports.is_demo is
  'TRUE for fabricated fixture rows. Operator-facing only; nothing filters on it. See 0006.';

-- Partial, like 0006's: the flag is false for almost every row, so an index over
-- all of them would be paid for on every write and read on almost none.
create index if not exists removed_reviews_is_demo_idx on public.removed_reviews (id) where is_demo;
create index if not exists deliverables_is_demo_idx    on public.deliverables (id)    where is_demo;
create index if not exists reports_is_demo_idx         on public.reports (id)         where is_demo;

-- ---------------------------------------------------------------------------
-- The summary regains its completeness.
-- ---------------------------------------------------------------------------
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
  select 'reports',            count(*) from public.reports            where is_demo;

comment on view public.demo_data_summary is
  'Counts of fabricated rows per table, across all nine tables that carry is_demo. Ungranted: readable only with direct database access, because it is a pre-launch check rather than something the app shows. `select * from public.demo_data_summary where rows > 0;`';
