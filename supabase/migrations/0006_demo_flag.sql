-- ===========================================================================
-- 0006_demo_flag.sql — mark fabricated rows as fabricated, in the database.
-- ===========================================================================
--
-- THE LIVE DATABASE HAS NO DEMO DATA IN IT TODAY. `seed.sql` has never been
-- run against it; every table is at zero rows. This migration exists so that
-- the day somebody does load fixtures — for a pilot, for a screenshot, to
-- reproduce a bug — those rows arrive already labelled, instead of being
-- labelled later from memory.
--
-- WHY THIS IS WORTH A MIGRATION. `seed.sql` fabricates purchases and reviews:
-- nobody bought anything and nobody wrote a word of it. Its own header says so,
-- and so does `README.md`. Those rows are indistinguishable from real ones once
-- they are in a table — same shape, same constraints, same aggregates. A
-- marketplace that ships with invented five-star reviews attached to named
-- coaches is a trust problem, not an untidiness problem, and "we will remember
-- to take them out" is not a mechanism.
--
-- WHAT IS DELIBERATELY *NOT* HERE:
--
--   * No grant to `anon` or `authenticated`. This is an operator's flag,
--     answerable from psql or the SQL editor, and it is not part of any public
--     read shape. `listings` in particular grants columns individually
--     (0002_rls.sql), and `is_demo` is deliberately left out of that grant, so
--     a browser holding the publishable key cannot select it and
--     `LISTING_COLUMNS` in `supabaseClient.ts` does not change.
--   * No behaviour. Nothing filters on it, nothing hides a demo row, no
--     aggregate excludes one. A flag that quietly changed what users see would
--     be a second, invisible visibility rule alongside `deleted_at`. This
--     column answers one question — "what in here is fabricated?" — and does
--     nothing else with the answer.
--   * No deletion. The instruction was explicitly to label and keep.

alter table public.profiles           add column if not exists is_demo boolean not null default false;
alter table public.listings           add column if not exists is_demo boolean not null default false;
alter table public.orders             add column if not exists is_demo boolean not null default false;
alter table public.reviews            add column if not exists is_demo boolean not null default false;
alter table public.invites            add column if not exists is_demo boolean not null default false;
alter table public.coach_applications add column if not exists is_demo boolean not null default false;

comment on column public.profiles.is_demo is
  'TRUE for a fabricated fixture row, not a real account. Set by seed.sql. Operator-facing only: not granted to anon/authenticated, not part of any public view, and nothing filters on it. Remove the rows before a public launch, or accept them knowingly.';
comment on column public.listings.is_demo is
  'TRUE for a fabricated fixture row. Deliberately OUTSIDE the column-level grant in 0002_rls.sql, so no client can select it.';
comment on column public.orders.is_demo is
  'TRUE for a fabricated purchase. Nobody paid for this. Feeds the public sales counts through offer_stats/coach_stats exactly as a real order would — which is precisely why it is worth being able to find.';
comment on column public.reviews.is_demo is
  'TRUE for a fabricated review. Nobody wrote this. Counts towards public ratings exactly as a real review would.';
comment on column public.invites.is_demo is
  'TRUE for a fixture invite code. These are PUBLISHED IN README.md and grant approved-coach status to whoever redeems one — revoke them before any real deployment.';
comment on column public.coach_applications.is_demo is
  'TRUE for a fabricated coach application.';

-- Partial indexes: the question asked of this column is always "show me the
-- demo rows", never "show me the real ones", and demo rows are the small side.
-- A full index would be almost entirely `false` and earn nothing.
create index if not exists profiles_is_demo_idx  on public.profiles (id)         where is_demo;
create index if not exists listings_is_demo_idx  on public.listings (id)         where is_demo;
create index if not exists orders_is_demo_idx    on public.orders (id)           where is_demo;
create index if not exists reviews_is_demo_idx   on public.reviews (id)          where is_demo;
create index if not exists invites_is_demo_idx   on public.invites (code)        where is_demo;

-- ---------------------------------------------------------------------------
-- One query that answers "is there fabricated data in here, and where?"
--
-- Ungranted on purpose: no `grant select` to anon or authenticated appears
-- below, so only a role with direct database access can read it. That is the
-- audience — this is a thing you check before a launch, not a thing the app
-- renders.
--
--     select * from public.demo_data_summary where rows > 0;
--
-- An empty result means the database holds no fabricated rows at all, which is
-- the state it is in as this migration lands.
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
  select 'coach_applications', count(*) from public.coach_applications where is_demo;

comment on view public.demo_data_summary is
  'Counts of fabricated rows per table. Ungranted: readable only with direct database access, because it is a pre-launch check rather than something the app shows. `select * from public.demo_data_summary where rows > 0;`';
