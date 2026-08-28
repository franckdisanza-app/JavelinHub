-- ---------------------------------------------------------------------------
-- seed.sql — demo fixtures for JavelinHub.
--
-- !! NOT APPLIED TO A LIVE DATABASE IN THIS PHASE !!
-- No Postgres/Supabase project runs in this POC. This file exists so that when
-- the backend is switched on, the hosted database can be brought to the same
-- state the mock JSON store seeds itself into. It is the SQL mirror of
-- seedDatabase() in src/lib/data/mock/store.ts — ids, emails, listings and
-- invite codes are identical on both sides. Keep them in sync.
--
-- PREREQUISITE: rows in `auth.users` must exist FIRST.
-- public.profiles.id is `references auth.users(id)`, so these inserts fail with
-- a foreign-key violation on a database where the users have not been created.
-- Create them with the Admin API / Supabase CLI before running this file, e.g.
--
--   supabase auth admin create-user --email coach@javelin.test --password coach1234 \
--     --user-id 00000000-0000-4000-8000-000000000002
--
-- and set the admin's password from the SEED_ADMIN_PASSWORD environment
-- variable — never inline a real credential in this file.
--
-- NOTE the admin INSERT below works only because INSERT is not covered by the
-- profiles privilege guard. To promote an EXISTING profile to admin — the
-- bootstrap/repair path — call `select public.grant_admin('<uuid>');` instead;
-- a plain `update profiles set role = 'admin'` is refused. See
-- supabase/README.md, "Bootstrapping (and repairing) an administrator".
--
-- The non-admin passwords referenced in comments below (coach1234 /
-- learner1234) are PUBLIC DEMO FIXTURES, documented as such in README.md. They
-- must never be reused for anything that matters.
--
-- The orders and reviews at the bottom of this file are FABRICATED, every one of
-- them. Nobody bought anything and nobody wrote a word of it. They exist so the
-- social-proof surfaces have something real to read; the UI discloses it.
-- ---------------------------------------------------------------------------

begin;

-- Profiles -------------------------------------------------------------------
-- Admin email is a placeholder matching the SEED_ADMIN_EMAIL default; change it
-- to match your environment before running.

-- Nils Berg is an approved coach with NOTHING: no offers, no sales, no reviews,
-- and NO coach_headline / coach_bio / coach_years_coaching either. He is the
-- fixture for every "new coach" empty state on /coaches and /coaches/[id], not
-- an oversight — do not fill his profile in.
-- The four learners after him are the authors of the fabricated reviews below.
--
-- The three coach columns are NULL for everyone who is not an approved coach.
-- They are never null-by-accident: public.public_coaches returns no row at all
-- for a learner, an applicant or an admin, so their values are unreachable.

insert into public.profiles (id, email, full_name, role, coach_status, coach_headline, coach_bio, coach_years_coaching)
values
  ('00000000-0000-4000-8000-000000000001', 'admin@javelin.test',   'Ada Administrator', 'admin',   'none',     null, null, null),
  ('00000000-0000-4000-8000-000000000002', 'coach@javelin.test',   'Cory Vaughn',       'coach',   'approved',
   'Javelin technique and throws programming',
   E'I threw for eleven seasons before I coached anybody, and most of what I know came from getting the run-up wrong in public. I work with club and county throwers on the three things that decide a throw: a repeatable approach, a shoulder that survives the season, and a block you can actually hit.\n\nSessions are written around your competition calendar, not around a generic twelve weeks. If something in a plan is not working, say so and we change it.',
   12),
  ('00000000-0000-4000-8000-000000000003', 'learner@javelin.test', 'Lena Park',         'learner', 'none',     null, null, null),
  ('00000000-0000-4000-8000-000000000004', 'newcoach@javelin.test','Nils Berg',         'coach',   'approved', null, null, null),
  ('00000000-0000-4000-8000-000000000011', 'marcus@javelin.test',  'Marcus Feld',       'learner', 'none',     null, null, null),
  ('00000000-0000-4000-8000-000000000012', 'priya@javelin.test',   'Priya Raman',       'learner', 'none',     null, null, null),
  ('00000000-0000-4000-8000-000000000013', 'tomas@javelin.test',   'Tomas Lindqvist',   'learner', 'none',     null, null, null),
  ('00000000-0000-4000-8000-000000000014', 'aisha@javelin.test',   'Aisha Bello',       'learner', 'none',     null, null, null)
on conflict (id) do nothing;

-- Listings -------------------------------------------------------------------
-- Six listings, all owned by the approved coach. `category` is a
-- public.listing_category SLUG, not a label — mirroring SEED_LISTINGS in
-- src/lib/data/mock/store.ts row for row.
--
-- Three of the eight categories (`recovery_plan`, `nutrition_plan`, `other`)
-- deliberately have no listing. The browse filter offers all eight regardless of
-- what is published, so an empty category is what exercises that empty state.
-- Do not add fixtures to fill them in.
--
-- No seeded offer is WITHDRAWN: `deleted_at` and `deleted_by` are left to their
-- NULL defaults on every row, mirroring SEED_LISTINGS. A withdrawn fixture
-- would change the seeded listing count and every offer-level total that
-- scripts/verify-authz.mts pins, for a state the suite already builds at runtime
-- by calling softDeleteListing(). `listing_revisions` is seeded empty for the
-- same reason: nothing has been edited yet.
--
-- …0103 is seeded at price_epoch 2 — it is the offer whose price has already
-- gone up (8500 -> 9900). Its epoch-1 orders and reviews are seeded below, so
-- the offer reads as nearly new while the coach's account-level totals still
-- carry the whole history. That asymmetry is the point of the column.

insert into public.listings (id, coach_id, title, description, price_cents, category, price_epoch, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002',
   'Javelin Throw Fundamentals',
   'A four-session introduction to the javelin: grip, carry, withdrawal and a safe, repeatable delivery. Built for athletes in their first or second season.',
   4500, 'training_plan', 1, now() - interval '42 days', now() - interval '42 days'),

  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002',
   'Approach Run & Crossover Clinic',
   'We rebuild your run-up from the check mark forward. Rhythm, crossover mechanics and hitting the block without losing speed.',
   7500, 'training_plan', 1, now() - interval '35 days', now() - interval '35 days'),

  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000002',
   'Strength Programming for Throwers',
   'A twelve-week block periodised programme balancing heavy pulls, med-ball throws and elastic work, written around your competition calendar.',
   9900, 'weightlifting_plan', 2, now() - interval '28 days', now() - interval '28 days'),

  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000002',
   'Video Analysis: Send Me Your Throw',
   'Upload three throws from any angle and receive a frame-by-frame breakdown with two concrete cues to work on before your next session.',
   3500, 'video_review', 1, now() - interval '21 days', now() - interval '21 days'),

  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000002',
   'Shoulder Care & Mobility for Throwers',
   'Thoracic rotation, cuff resilience and elbow-sparing warmups. The routine I give every athlete who arrives with a sore throwing arm.',
   2900, 'mobility_plan', 1, now() - interval '14 days', now() - interval '14 days'),

  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000002',
   'Competition Day Mental Prep',
   'Six attempts, one shot at a personal best. Routine building, arousal control and what to do after a foul.',
   5500, 'mental_training', 1, now() - interval '7 days', now() - interval '7 days')
on conflict (id) do nothing;

-- Invites --------------------------------------------------------------------
-- Two unredeemed, never-expiring codes minted by the admin.

insert into public.invites (code, created_by, note, expires_at)
values
  ('JAVELIN-COACH-2026', '00000000-0000-4000-8000-000000000001', 'Founding coach cohort', null),
  ('THROWERS-WELCOME',   '00000000-0000-4000-8000-000000000001', 'Conference outreach',   null)
on conflict (code) do nothing;

-- Orders ---------------------------------------------------------------------
--
-- EVERY ROW BELOW IS FABRICATED. Nobody bought anything. There is no checkout in
-- this POC and no INSERT policy on this table for any client role — these exist
-- so that reviews have a purchase to point at and so a sales count counts
-- something. The app discloses the fiction where the numbers are rendered.
--
-- Mirrors SEED_ORDERS in src/lib/data/mock/store.ts row for row. Timestamps are
-- relative so a freshly seeded database has a plausible spread; each is after
-- its listing's created_at above.
--
-- Note …0206/…0207 at 8500 and …0208 at 9900: price_cents_at_purchase is a
-- SNAPSHOT. Raising the offer's price to 9900 did not rewrite what the first two
-- buyers paid, and their epoch-1 rows stop counting toward the OFFER's stats
-- while still counting toward the COACH's.

insert into public.orders (id, learner_id, listing_id, coach_id, price_cents_at_purchase, price_epoch, created_at)
values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002', 4500, 1, now() - interval '38 days'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002', 4500, 1, now() - interval '30 days'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002', 4500, 1, now() - interval '12 days'),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', 7500, 1, now() - interval '26 days'),
  -- …0205 is deliberately left UNREVIEWED: it is the seeded purchase a demo
  -- login can actually write a review against.
  ('00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', 7500, 1, now() - interval '9 days'),
  ('00000000-0000-4000-8000-000000000206', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000002', 8500, 1, now() - interval '24 days'),
  ('00000000-0000-4000-8000-000000000207', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000002', 8500, 1, now() - interval '20 days'),
  ('00000000-0000-4000-8000-000000000208', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000002', 9900, 2, now() - interval '5 days'),
  ('00000000-0000-4000-8000-000000000209', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000002', 3500, 1, now() - interval '15 days'),
  -- …0210 sold but was never reviewed, so …0105 has sales and no rating.
  ('00000000-0000-4000-8000-000000000210', '00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000002', 2900, 1, now() - interval '8 days')
on conflict (id) do nothing;

-- Reviews --------------------------------------------------------------------
--
-- ALSO ENTIRELY FABRICATED — nobody wrote any of this. Mirrors SEED_REVIEWS in
-- src/lib/data/mock/store.ts.
--
-- `author_id` equals the order's `learner_id` and `listing_id` equals the
-- order's `listing_id` in every row, which is what reviews_insert_own_purchase
-- would enforce if these arrived through the API instead of through this file.
--
-- Offer …0106 has no order and no review at all: it is the "brand new offer"
-- empty state and must stay empty.

insert into public.reviews (id, order_id, listing_id, author_id, rating, body, price_epoch, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000003', 5,
   'I had never held a javelin before this. Four sessions in I was throwing without pain in my elbow, which is the only thing I actually wanted.',
   1, now() - interval '35 days', now() - interval '35 days'),

  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000011', 4,
   'Clear and well sequenced. I would have liked more on the carry, but the delivery cues alone were worth it.',
   1, now() - interval '27 days', now() - interval '27 days'),

  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000012', 5,
   'Exactly the right amount of detail for a first season. Nothing is assumed and nothing is padded.',
   1, now() - interval '10 days', now() - interval '10 days'),

  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000013', 4,
   'My run-up was two steps too long for three years and nobody told me. It took him one session.',
   1, now() - interval '22 days', now() - interval '22 days'),

  ('00000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-000000000206', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000003', 5,
   'Written around my competition calendar rather than a generic twelve weeks. The med-ball work carried straight over.',
   1, now() - interval '21 days', now() - interval '21 days'),

  ('00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000207', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000011', 3,
   'Solid programming, but heavier on the lifting than I expected and I had to ask twice about substitutions.',
   1, now() - interval '17 days', now() - interval '17 days'),

  -- The only epoch-2 review: the only one the OFFER page shows for …0103.
  ('00000000-0000-4000-8000-000000000307', '00000000-0000-4000-8000-000000000208', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000012', 4,
   'Bought the current version. The elastic work is new and it is the part I have felt the most.',
   2, now() - interval '3 days', now() - interval '3 days'),

  ('00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-000000000209', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000013', 5,
   'Frame-by-frame notes came back in two days with two cues. I stopped trying to fix five things at once.',
   1, now() - interval '12 days', now() - interval '12 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- LABEL EVERYTHING THIS FILE JUST INSERTED AS FABRICATED.
--
-- Inside the same transaction as the inserts, so there is no window in which
-- these rows exist unlabelled, and it is impossible to load the fixtures
-- without the flag.
--
-- Matched on the id prefix rather than restated as a column on each INSERT
-- above, and that is the point: every id in this file is a hand-written
-- `00000000-0000-4000-8000-…` (32 of them, no exceptions), so this cannot drift
-- out of step with the inserts the way a repeated literal would. A real signup
-- gets a random v4 uuid from GoTrue and can never collide with the prefix —
-- v4 pins the version nibble to 4 and the variant bits to 8-b, which the
-- prefix satisfies, but the remaining 120 bits being all-but-zero is not
-- something a generator produces.
--
-- `invites` is keyed by `code`, not by a uuid, so it is matched on
-- `created_by` — the seeded admin — instead.
--
-- See supabase/migrations/0006_demo_flag.sql for why the flag exists, and
-- `select * from public.demo_data_summary where rows > 0;` to find the result.
-- ---------------------------------------------------------------------------
update public.profiles           set is_demo = true where id::text         like '00000000-0000-4000-8000-%';
update public.listings           set is_demo = true where id::text         like '00000000-0000-4000-8000-%';
update public.orders             set is_demo = true where id::text         like '00000000-0000-4000-8000-%';
update public.reviews            set is_demo = true where id::text         like '00000000-0000-4000-8000-%';
update public.coach_applications set is_demo = true where id::text         like '00000000-0000-4000-8000-%';
update public.invites            set is_demo = true where created_by::text like '00000000-0000-4000-8000-%';

commit;
