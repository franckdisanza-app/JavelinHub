-- ===========================================================================
-- 0029_input_bounds.sql — the database enforcing the bounds the app claims.
-- ===========================================================================
--
-- !! NOT APPLIED. Push it, then re-run `npm run verify:supabase`. !!
--
-- ---------------------------------------------------------------------------
-- WHAT IS WRONG WITHOUT THIS
-- ---------------------------------------------------------------------------
-- `src/lib/data/validation.ts` opens by stating the rule this file closes:
--
--   > "Each function documents the SQL constraint it mirrors — keep the two in
--   >  step, and never let this file get looser than the database."
--
-- For six columns there was no database side to be in step WITH. `0001_init.sql`
-- caps `coach_headline` (120) and `coach_bio` (2000) and explains exactly why —
-- "a length cap on free text a stranger can read is not cosmetic: without it one
-- row can make every card in the directory unreadable" — and then that argument
-- was not carried to the other six columns of free text a stranger can read.
--
-- The application caps all of them. The application is not the boundary, and
-- this codebase says so at every other turn: `createListingAction` opens with
-- "A Server Action is a public HTTP endpoint", and the whole RLS design exists
-- because PostgREST is reachable from a browser holding the publishable key. So
-- an approved coach could `POST /rest/v1/listings` with a fifty-megabyte
-- `description` and every policy would admit it — it is their own listing, in
-- their own name. One such row is then rendered into the browse grid, both
-- cached public reads, the sitemap and every cross-sell block that names it.
--
-- `profiles.full_name` is the same shape with a shorter route: it is written by
-- `handle_new_user()` from `raw_user_meta_data ->> 'full_name'`, which is
-- whatever the caller posted to `/auth/v1/signup`, and it is published to
-- anonymous visitors through `public_profiles` on every review byline.
--
-- ---------------------------------------------------------------------------
-- THE NUMBERS ARE NOT NEW ONES
-- ---------------------------------------------------------------------------
-- Every bound below is the one BOTH `DataClient` implementations already
-- enforce, read out of the code rather than chosen here — so this cannot make
-- the database stricter than the app and turn a friendly field-level message
-- into a `23514` nobody can act on:
--
--   profiles.full_name              requireText(…, 'Full name',   120)
--   listings.title                  requireText(…, 'Title',       140)
--   listings.description            requireText(…, 'Description', 4000)
--   reviews.body                    requireText(…, 'Review',      2000)
--   coach_applications.bio          requireText(…, 'Bio',         2000)
--   coach_applications.experience   requireText(…, 'Experience',  2000)
--
-- NOTE THE MINIMA ARE **NOT** MIRRORED, deliberately. The app also requires a
-- title of 3 characters, a description of 10 and an application of 20 — those
-- are editorial rules about what makes a good listing, they change with the
-- copy, and enforcing them here would mean a migration every time somebody
-- softens a form. What IS enforced is non-emptiness, which is an integrity
-- rule and matches the `check (btrim(body) <> '')` already on `reviews.body`.
--
-- `full_name` gets a minimum of ONE rather than the app's two, and the reason
-- is `handle_new_user()`: when a signup carries no `full_name` it falls back to
-- `split_part(new.email, '@', 1)`, and `a@example.com` is a legal address. A
-- minimum of two would refuse that signup at the trigger, which aborts the
-- `auth.users` insert — a stricter constraint here failing CLOSED on a real
-- account is exactly the trap this header warns about in the other direction.
--
-- ---------------------------------------------------------------------------
-- IT CANNOT FAIL ON EXISTING DATA — MEASURED, NOT ASSUMED
-- ---------------------------------------------------------------------------
-- `ALTER TABLE … ADD CONSTRAINT … CHECK` validates every existing row and
-- aborts the transaction if one fails. Measured against the live project
-- (ref `trocsdetpwyqcgyfclir`) before this file was written, longest value per
-- column:
--
--   listings.title                  31 of 140      coach_applications.bio  67 of 2000
--   listings.description           271 of 4000     …    .experience        64 of 2000
--   reviews.body                    85 of 2000     profiles.full_name      18 of 120
--
-- Re-measure before pushing if the seed has been re-run since.
--
-- ---------------------------------------------------------------------------
-- AND THE THIRD STORAGE PATH, which was the odd one out
-- ---------------------------------------------------------------------------
-- `profiles.avatar_path` is pinned to `<owner id>/%` (0008) and
-- `listings.asset_path` to `<listing id>/%` (0011), each with a comment saying
-- a Server Action is a public endpoint. `deliverables.storage_path` — the third
-- column of the same kind, written by the same kind of action — was left as
-- bare `text not null unique`. The storage policies still bound what a forged
-- value can reach, so this is defence in depth rather than an open door; it is
-- here because the inconsistency is the sort that reads as deliberate to the
-- next person, and is not.
--
-- Measured: 0 rows in `deliverables`, so this one cannot fail either.

begin;

-- profiles.full_name --------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_full_name_length;
alter table public.profiles
  add constraint profiles_full_name_length
  check (char_length(full_name) between 1 and 120);

comment on constraint profiles_full_name_length on public.profiles is
  'Mirrors requireText(…, ''Full name'', 120) in src/lib/data/validation.ts. Minimum is 1, not the app''s 2, because handle_new_user() may fall back to split_part(email, ''@'', 1).';

-- listings.title / .description ---------------------------------------------
alter table public.listings drop constraint if exists listings_title_length;
alter table public.listings
  add constraint listings_title_length
  check (btrim(title) <> '' and char_length(title) <= 140);

alter table public.listings drop constraint if exists listings_description_length;
alter table public.listings
  add constraint listings_description_length
  check (btrim(description) <> '' and char_length(description) <= 4000);

comment on constraint listings_title_length on public.listings is
  'Mirrors requireText(…, ''Title'', 140). The app''s 3-character minimum is editorial and deliberately not enforced here; non-emptiness is.';

-- reviews.body --------------------------------------------------------------
-- The `btrim(body) <> ''` half already exists from 0001_init.sql; this is the
-- cap that was missing beside it.
alter table public.reviews drop constraint if exists reviews_body_length;
alter table public.reviews
  add constraint reviews_body_length
  check (char_length(body) <= 2000);

-- coach_applications --------------------------------------------------------
-- Read only by their author and by administrators, so this is not the
-- "unreadable directory card" argument — it is the plainer one: an unbounded
-- column an unauthenticated-to-authenticated caller can write is a storage bill.
alter table public.coach_applications drop constraint if exists coach_applications_bio_length;
alter table public.coach_applications
  add constraint coach_applications_bio_length
  check (btrim(bio) <> '' and char_length(bio) <= 2000);

alter table public.coach_applications drop constraint if exists coach_applications_experience_length;
alter table public.coach_applications
  add constraint coach_applications_experience_length
  check (btrim(experience) <> '' and char_length(experience) <= 2000);

-- deliverables.storage_path -------------------------------------------------
-- `<order_id>/<uploader_id>/<file>` — segment 1 is what
-- `deliverables_read_party` looks the order up by, segment 2 is what
-- `deliverables_write_party` pins the writer to. Both uuids render as hex and
-- dashes, so neither can contribute a LIKE metacharacter to the pattern.
alter table public.deliverables drop constraint if exists deliverables_storage_path_shape;
alter table public.deliverables
  add constraint deliverables_storage_path_shape
  check (storage_path like (order_id::text || '/' || uploaded_by::text || '/%'));

comment on constraint deliverables_storage_path_shape on public.deliverables is
  'The path is derived by uploadDeliveryFile() and is what the storage policies authorise against. Pinned here for the same reason profiles_avatar_path_shape and listings_asset_path_shape are: a Server Action is a public endpoint.';

commit;

-- ---------------------------------------------------------------------------
-- AFTER PUSHING, assert it rather than assuming it. Each of these is a write
-- the app itself would never make, so they belong in the signed-in tier of
-- `scripts/verify-supabase.mts` (VERIFY_SUPABASE_WRITES=1):
--
--   * an approved coach PATCHing `listings.title` to 200 characters -> 23514,
--     and to 140 -> 204. Both ends, because a constraint that refuses
--     everything looks identical to a correct one until somebody hits the
--     boundary legitimately.
--   * a buyer POSTing a 3,000-character `reviews.body` -> 23514.
--   * a party to an order POSTing a `deliverables` row whose `storage_path`
--     does not start with `<order_id>/<own id>/` -> 23514.
--
-- ROLLBACK, if one of these turns out to refuse something real:
--
--   alter table public.profiles           drop constraint profiles_full_name_length;
--   alter table public.listings           drop constraint listings_title_length;
--   alter table public.listings           drop constraint listings_description_length;
--   alter table public.reviews            drop constraint reviews_body_length;
--   alter table public.coach_applications drop constraint coach_applications_bio_length;
--   alter table public.coach_applications drop constraint coach_applications_experience_length;
--   alter table public.deliverables       drop constraint deliverables_storage_path_shape;
-- ---------------------------------------------------------------------------
