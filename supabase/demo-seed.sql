-- ===========================================================================
-- demo-seed.sql — enough fabricated data to SEE the product work.
-- ===========================================================================
--
-- NOT A MIGRATION, and deliberately not in `migrations/`. Migrations describe
-- the schema every environment must have; this is a pile of invented rows for
-- one project, run by hand:
--
--     npx supabase db query --linked -f supabase/demo-seed.sql
--
-- and removed by its sibling:
--
--     npx supabase db query --linked -f supabase/demo-teardown.sql
--
-- ---------------------------------------------------------------------------
-- WHY IT EXISTS
-- ---------------------------------------------------------------------------
-- The live project had five accounts and zero offers, so every page that
-- renders a list rendered an empty state. That made a whole class of change
-- unverifiable against the real backend: a paginated read with no rows returns
-- `[]` whether the keyset is right, wrong, or rejected by PostgREST as a
-- malformed filter. `verify:supabase` can prove a query PARSES; only data can
-- show that it ORDERS.
--
-- The sizes below are chosen to cross the boundaries the app has, not to look
-- plausible:
--
--   * 40 published offers, against a page size of 24 — so browse has a second
--     page and the pager renders at all.
--   * 26 of them owned by ONE coach, so `/coaches/[id]` pages its offer list
--     independently of its review list, which is the two-cursor case.
--   * 28 reviews on ONE offer, so `/offers/[id]` pages reviews.
--   * Prices from £15 to £120 across the range, so the price filters and both
--     price sorts have something to separate.
--   * Three withdrawn offers, one of them by an administrator, so the coach
--     dashboard and `/admin/coaches` both have a takedown to show.
--
-- ---------------------------------------------------------------------------
-- EVERY ROW IS FLAGGED
-- ---------------------------------------------------------------------------
-- `is_demo = true` on all nine tables that carry it (0006, extended by 0027).
-- `select * from public.demo_data_summary where rows > 0;` is the check, and
-- the teardown deletes on exactly that predicate. The seed does not depend on
-- anybody remembering what it inserted.
--
-- Accounts are `demo.*@javelinhub.dev` with the password below. THEY ARE PUBLIC
-- FIXTURE CREDENTIALS in a repository, so they must never be reused for
-- anything that matters, and the teardown removes the auth users too.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENT
-- ---------------------------------------------------------------------------
-- Every id is derived from a counter rather than generated, and every insert is
-- `on conflict do nothing`. Running it twice changes nothing.

begin;

-- ---------------------------------------------------------------------------
-- 1. Accounts.
--
-- Inserted straight into `auth.users`, which the `on_auth_user_created` trigger
-- turns into `public.profiles` rows. That is the only way in from here: GoTrue
-- validates the address domain on signup and rejects the reserved test TLDs, so
-- the API route the app uses cannot create a fixture account at all.
--
-- `email_confirmed_at` is set, because the project has email confirmation on and
-- an unconfirmed user cannot sign in. The password hash is bcrypt via pgcrypto,
-- which is what GoTrue itself writes.
-- ---------------------------------------------------------------------------

-- 5 coaches, 30 learners, 1 administrator.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000',
  spec.id,
  'authenticated',
  'authenticated',
  spec.email,
  extensions.crypt('demo-password-2026', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', spec.full_name),
  -- Staggered so `created_at desc` is a stable, meaningful order rather than 36
  -- rows sharing a timestamp — which is exactly the tie the keyset's second
  -- column exists for, and not something a fixture should be testing by
  -- accident.
  now() - (spec.rank || ' hours')::interval,
  now() - (spec.rank || ' hours')::interval,
  '', '', '', ''
from (
  select
    ('d0000000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid as id,
    'demo.coach' || n || '@javelinhub.dev'                       as email,
    (array['Rina Kovács','Tomas Lindqvist','Amara Okonkwo','Petr Novák','Sofia Marchetti'])[n] as full_name,
    n                                                            as rank
  from generate_series(1, 5) n
  union all
  select
    ('d0000000-0000-4000-8002-' || lpad(n::text, 12, '0'))::uuid,
    'demo.learner' || n || '@javelinhub.dev',
    (array[
      'Alex Turner','Bea Hoffmann','Caleb Ruiz','Dara Nolan','Elin Bäck','Farid Haddad',
      'Greta Simon','Hugo Almeida','Ines Varga','Jonas Weber','Kaia Lund','Liam Byrne',
      'Mira Sørensen','Noah Fischer','Olga Petrova','Pia Jansen','Quinn Doherty','Rui Costa',
      'Sanne de Vries','Tobias Krause','Ula Nowak','Viktor Ilic','Wren Ashby','Xenia Popa',
      'Yusuf Demir','Zara Malik','Anton Berg','Britta Roos','Cato Meijer','Dinah Kaplan'
    ])[n],
    5 + n
  from generate_series(1, 30) n
  union all
  select
    'd0000000-0000-4000-8003-000000000001'::uuid,
    'demo.admin@javelinhub.dev',
    'Demo Administrator',
    0
) spec
on conflict (id) do nothing;

-- The trigger made every one of them a learner with `coach_status = 'none'`.
-- Flag them all, then raise the five coaches.
--
-- A direct connection is a privileged writer as far as
-- `guard_profile_privilege_columns` is concerned (`session_user <>
-- 'authenticator'`), which is what lets these two statements touch `role` and
-- `coach_status` at all. Through PostgREST they would both be 42501.
update public.profiles set is_demo = true
 where id::text like 'd0000000-0000-4000-800%'
   and is_demo = false;

update public.profiles p
   set role                 = 'coach',
       coach_status         = 'approved',
       coach_headline       = c.headline,
       coach_bio            = c.bio,
       coach_years_coaching = c.years
  from (values
    ('d0000000-0000-4000-8001-000000000001'::uuid,
     'Run-up rhythm and block mechanics',
     'Twelve seasons on the runway and eight coaching. I work on the last five strides, because that is where most distance is lost and where almost nobody looks.',
     8),
    ('d0000000-0000-4000-8001-000000000002'::uuid,
     'Strength that transfers to the throw',
     'Former decathlete. I write lifting blocks for throwers who are strong in the gym and cannot find it on the runway.',
     6),
    ('d0000000-0000-4000-8001-000000000003'::uuid,
     'Shoulder health and throwing volume',
     'Physiotherapist and thrower. Most of my work is keeping people throwing through a season rather than rebuilding them after it.',
     11),
    ('d0000000-0000-4000-8001-000000000004'::uuid,
     'Video review, frame by frame',
     'I review one throw properly rather than twenty quickly. Expect a long document and two things to change.',
     4),
    ('d0000000-0000-4000-8001-000000000005'::uuid,
     'Competition head and season planning',
     'I coach the part nobody trains: what you do between the call room and the runway.',
     9)
  ) as c(id, headline, bio, years)
 where p.id = c.id;

-- The administrator. `grant_admin()` rather than an UPDATE, because that is the
-- audited path and it works from a direct connection by design — bootstrapping
-- the first administrator has no actor. It writes an `admin_actions` row with a
-- null actor, which is the honest record of exactly that.
select public.grant_admin('d0000000-0000-4000-8003-000000000001');

-- ---------------------------------------------------------------------------
-- 2. Offers.
--
-- 43 rows: 40 published and 3 withdrawn. The first 26 belong to one coach so
-- that their profile has more than a page of them.
-- ---------------------------------------------------------------------------
insert into public.listings (
  id, coach_id, title, description, price_cents, category, fulfilment,
  created_at, updated_at, deleted_at, deleted_by, is_demo
)
select
  ('d0000000-0000-4000-8010-' || lpad(n::text, 12, '0'))::uuid,
  -- 1..26 to coach 1; the rest spread over coaches 2-5.
  case when n <= 26
       then 'd0000000-0000-4000-8001-000000000001'::uuid
       else ('d0000000-0000-4000-8001-' || lpad((2 + (n % 4))::text, 12, '0'))::uuid
  end,
  (array[
    'Run-up audit','Block and delivery rebuild','Eight-week throwing block','Shoulder resilience plan',
    'Off-season strength cycle','Single-throw video review','Competition day plan','Return to throwing',
    'Crossover timing drills','Approach consistency work','In-season maintenance','Grip and release check'
  ])[1 + (n % 12)] || ' · ' || n,
  'A worked plan you can follow without me standing next to you. It says what to do, in what order, and what to stop doing — and it is written for one thrower rather than assembled from a template. Fabricated demo content: nobody bought this and nobody wrote a review of it.',
  -- £15 to £120, in a repeating spread rather than ascending, so a price sort
  -- has to actually reorder the list rather than agreeing with `created_at`.
  (array[1500, 8500, 3200, 12000, 4500, 9900, 2400, 6800, 11000, 3900, 7200, 5500])[1 + (n % 12)],
  (array[
    'training_plan','recovery_plan','mobility_plan','weightlifting_plan',
    'nutrition_plan','video_review','mental_training','other'
  ])[1 + (n % 8)]::public.listing_category,
  -- All personalised. `instant` would need a real object in the offer-assets
  -- bucket, and a claim against an instant offer with no file is refused by
  -- `claim_offer()` — a fixture that cannot be bought is worse than no fixture.
  'personalised'::public.fulfilment_mode,
  now() - (n || ' hours')::interval,
  now() - (n || ' hours')::interval,
  -- Three withdrawn, at the end so they do not disturb the published count.
  case when n in (41, 42, 43) then now() - '2 hours'::interval else null end,
  -- One of the three taken down BY THE ADMINISTRATOR, which is the state the
  -- coach cannot lift themselves — the case `/coach/offers` and
  -- `/admin/coaches` both have to render differently.
  case when n = 43 then 'd0000000-0000-4000-8003-000000000001'::uuid else null end,
  true
from generate_series(1, 43) n
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Purchases.
--
-- 28 against offer #1 so its review list needs a second page, plus a scattering
-- so other offers have a sales count and the coach dashboards are not empty.
--
-- Price and epoch are COPIED FROM THE LISTING rather than invented, because
-- that is what `claim_offer()` does and what `offer_stats` filters on: an order
-- at the wrong epoch is invisible to every rollup, which would look like a bug
-- in the rollup.
-- ---------------------------------------------------------------------------
insert into public.orders (
  id, learner_id, listing_id, coach_id, price_cents_at_purchase, price_epoch, created_at, is_demo
)
select
  ('d0000000-0000-4000-8020-' || lpad(spec.n::text, 12, '0'))::uuid,
  spec.learner_id,
  l.id,
  l.coach_id,
  l.price_cents,
  l.price_epoch,
  now() - (spec.n || ' minutes')::interval,
  true
from (
  -- 28 buyers on offer 1.
  select n as n,
         ('d0000000-0000-4000-8002-' || lpad(n::text, 12, '0'))::uuid as learner_id,
         ('d0000000-0000-4000-8010-' || lpad('1', 12, '0'))::uuid     as listing_id
  from generate_series(1, 28) n
  union all
  -- One buyer each on offers 2-20, from a rotating cast.
  select 100 + n,
         ('d0000000-0000-4000-8002-' || lpad((1 + (n % 30))::text, 12, '0'))::uuid,
         ('d0000000-0000-4000-8010-' || lpad((n + 1)::text, 12, '0'))::uuid
  from generate_series(1, 19) n
) spec
join public.listings l on l.id = spec.listing_id
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Reviews.
--
-- One per order, for 28 of the offer-1 orders and 12 of the scattered ones.
-- `price_epoch` is copied from the ORDER, which is how `public_listing_reviews`
-- decides a review is about the current version of an offer.
-- ---------------------------------------------------------------------------
insert into public.reviews (
  id, order_id, listing_id, author_id, rating, body, price_epoch, created_at, updated_at, is_demo
)
select
  ('d0000000-0000-4000-8030-' || lpad(row_number() over (order by o.created_at desc)::text, 12, '0'))::uuid,
  o.id,
  o.listing_id,
  o.learner_id,
  -- 3 to 5, weighted upward but not uniform — a wall of fives is the thing a
  -- reader stops believing, and an average of exactly 5.0 hides any bug in the
  -- rounding.
  (array[5, 4, 5, 5, 3, 4, 5, 4])[1 + (('x' || substr(md5(o.id::text), 1, 4))::bit(16)::int % 8)],
  (array[
    'Clear, specific, and it fixed the thing I had been guessing at for two seasons.',
    'Well written and honest about what it could not tell from a video. I would buy again.',
    'Useful, though I wanted more detail on the warm-up. The main block was excellent.',
    'Turned a vague feeling that my run-up was wrong into two things to change. Worth it.',
    'Good plan, delivered quickly. Fabricated demo review — nobody wrote this.'
  ])[1 + (('x' || substr(md5(o.id::text), 5, 4))::bit(16)::int % 5)],
  o.price_epoch,
  o.created_at + '1 day'::interval,
  o.created_at + '1 day'::interval,
  true
from public.orders o
where o.is_demo
  and (
    o.listing_id = ('d0000000-0000-4000-8010-' || lpad('1', 12, '0'))::uuid
    or (('x' || substr(md5(o.id::text), 1, 4))::bit(16)::int % 3) = 0
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. The administrator surfaces.
--
-- Small on purpose: one of each state is what makes a queue's branches visible,
-- and forty of them would only make the page slower to read.
-- ---------------------------------------------------------------------------

-- Applications: one of each status, so all three filter tabs have a row.
insert into public.coach_applications (id, user_id, bio, experience, sport, status, review_note, reviewed_by, reviewed_at, created_at, is_demo)
values
  ('d0000000-0000-4000-8040-000000000001',
   'd0000000-0000-4000-8002-000000000029',
   'I have thrown for eleven years and coached a school squad for four.',
   'Regional finalist 2019 and 2021. Level 2 coaching award.',
   'javelin', 'pending', null, null, null, now() - '3 hours'::interval, true),
  ('d0000000-0000-4000-8040-000000000002',
   'd0000000-0000-4000-8002-000000000030',
   'Sprint coach moving across to throws.',
   'Eight years of sprints, two of them with a thrower in the group.',
   'javelin', 'approved', 'Good background, clear about what they do not know yet.',
   'd0000000-0000-4000-8003-000000000001', now() - '2 hours'::interval, now() - '5 hours'::interval, true),
  ('d0000000-0000-4000-8040-000000000003',
   'd0000000-0000-4000-8002-000000000028',
   'I would like to coach.',
   'None yet.',
   'javelin', 'rejected', 'No coaching experience described. Happy to look again in a season.',
   'd0000000-0000-4000-8003-000000000001', now() - '1 hour'::interval, now() - '6 hours'::interval, true)
on conflict (id) do nothing;

-- Invites: active, redeemed, revoked and expired — the four states `statusOf()`
-- branches on, so the list renders all of them rather than one repeated.
insert into public.invites (code, created_by, note, expires_at, redeemed_by, redeemed_at, revoked_at, created_at, is_demo)
values
  ('DEMO-ACTIVE-0001', 'd0000000-0000-4000-8003-000000000001', 'Still redeemable.', null, null, null, null, now() - '4 hours'::interval, true),
  ('DEMO-REDEEMED-01', 'd0000000-0000-4000-8003-000000000001', 'Used by a coach.', null, 'd0000000-0000-4000-8001-000000000005', now() - '3 hours'::interval, null, now() - '5 hours'::interval, true),
  ('DEMO-REVOKED-001', 'd0000000-0000-4000-8003-000000000001', 'Sent to the wrong person.', null, null, null, now() - '2 hours'::interval, now() - '6 hours'::interval, true),
  ('DEMO-EXPIRED-001', 'd0000000-0000-4000-8003-000000000001', 'Ran out.', now() - '1 hour'::interval, null, null, null, now() - '7 hours'::interval, true)
on conflict (code) do nothing;

-- Reports: a review report and a coach report, both open, plus one already
-- upheld so the resolved tab is not empty and the resolution note renders.
insert into public.reports (id, subject_type, subject_review_id, subject_coach_id, reporter_id, reason, note, status, resolved_by, resolved_at, resolution_note, created_at, is_demo)
select
  'd0000000-0000-4000-8050-000000000001', 'review', r.id, null,
  'd0000000-0000-4000-8001-000000000001', 'not_a_real_purchase',
  'This reads like it is about a different offer entirely.', 'open', null, null, null,
  now() - '90 minutes'::interval, true
from public.reviews r
where r.listing_id = ('d0000000-0000-4000-8010-' || lpad('1', 12, '0'))::uuid
order by r.created_at desc
limit 1
on conflict (id) do nothing;

insert into public.reports (id, subject_type, subject_review_id, subject_coach_id, reporter_id, reason, note, status, resolved_by, resolved_at, resolution_note, created_at, is_demo)
values
  ('d0000000-0000-4000-8050-000000000002', 'coach', null, 'd0000000-0000-4000-8001-000000000002',
   'd0000000-0000-4000-8002-000000000003', 'scam',
   'Asked me to pay by bank transfer instead of through the site.', 'open', null, null, null,
   now() - '45 minutes'::interval, true),
  ('d0000000-0000-4000-8050-000000000003', 'coach', null, 'd0000000-0000-4000-8001-000000000004',
   'd0000000-0000-4000-8002-000000000007', 'off_topic',
   'The offer description is not about javelin at all.', 'dismissed',
   'd0000000-0000-4000-8003-000000000001', now() - '30 minutes'::interval,
   'Read the offer. It is about javelin. Nothing to do here.',
   now() - '60 minutes'::interval, true)
on conflict (id) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- What went in.
-- ---------------------------------------------------------------------------
select * from public.demo_data_summary where rows > 0;
