-- ---------------------------------------------------------------------------
-- 0001_init.sql — JavelinHub: extensions, enums, tables,
-- indexes and updated_at triggers.
--
-- !! NOT APPLIED TO A LIVE DATABASE IN THIS PHASE !!
-- There is no running Postgres / Supabase project for this POC. This file is
-- authored to be applied verbatim later (`supabase db push` or psql) and is
-- verified in this phase by *static review* only. The authorization rules it
-- encodes are independently re-implemented in code by the mock data layer at
-- src/lib/data/mock/mockClient.ts — see supabase/README.md for the
-- policy <-> code mapping table.
-- ---------------------------------------------------------------------------

-- Extensions ----------------------------------------------------------------

-- gen_random_uuid()
create extension if not exists "pgcrypto";
-- trigram operator classes, used by the listing and coach keyword-search
-- indexes below.
create extension if not exists "pg_trgm";

-- Enums ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('learner', 'coach', 'admin');
  end if;

  if not exists (select 1 from pg_type where typname = 'coach_status') then
    create type public.coach_status as enum ('none', 'pending_review', 'approved', 'rejected');
  end if;

  if not exists (select 1 from pg_type where typname = 'application_status') then
    create type public.application_status as enum ('pending', 'approved', 'rejected');
  end if;

  -- The offer taxonomy. Slug stored, label rendered in the app — rewording
  -- "Video review" must never become an ALTER TYPE.
  --
  -- Declaration order IS sort order for a Postgres enum, so this list is written
  -- in DISPLAY order and `order by category` already produces the filter's own
  -- ordering, with 'other' last. Do not re-sort it alphabetically: 'other' is
  -- the fallback and must not land between 'nutrition_plan' and 'recovery_plan'.
  -- Keep in sync with LISTING_CATEGORIES in src/lib/data/types.ts.
  --
  -- New members go BEFORE 'other' (`alter type ... add value 'x' before 'other'`),
  -- which also keeps the display order correct for free.
  if not exists (select 1 from pg_type where typname = 'listing_category') then
    create type public.listing_category as enum (
      'training_plan',
      'recovery_plan',
      'mobility_plan',
      'weightlifting_plan',
      'nutrition_plan',
      'video_review',
      'mental_training',
      'other'
    );
  end if;
end
$$;

-- Shared updated_at trigger --------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with now() on every row update.';

-- profiles -------------------------------------------------------------------
-- One row per auth.users row. `role` and `coach_status` are privilege-bearing
-- columns: 0002_rls.sql prevents a user from escalating them on their own row.

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  -- NOT unique, deliberately. Email uniqueness belongs to `auth.users`, which
  -- GoTrue already enforces; this column is a denormalised copy for display and
  -- admin search. A second unique constraint here bought nothing and created a
  -- real failure mode: handle_new_user() could hit it while creating the
  -- profile for a brand-new signup, and any ON CONFLICT broad enough to swallow
  -- it would leave that user authenticated with NO profile row — matching no
  -- `id = auth.uid()` policy and failing every RPC with P0002, silently. With
  -- the constraint gone, handle_new_user() can target the primary key alone, so
  -- the only conflict it ignores is "this profile already exists", which is the
  -- benign idempotent case.
  email        text not null,
  full_name    text not null,
  role         public.user_role not null default 'learner',
  coach_status public.coach_status not null default 'none',
  -- The coach's OWN PUBLIC COPY. Three nullable columns, published to anon
  -- through public.public_coaches (0002_rls.sql) and only for a coach whose
  -- coach_status is 'approved'.
  --
  -- THEY ARE NOT A VIEW ONTO coach_applications, and that is the point.
  -- `coach_applications.bio` is a review artifact: written for an
  -- administrator, readable only by its author and by admins. Joining it live
  -- onto a public profile would publish text an applicant never intended to
  -- publish, and would re-publish every later edit of it. Instead
  -- public.review_coach_application() copies the bio ONCE, at approval, into
  -- coach_bio, and only when coach_bio is still empty — after that the column
  -- is the coach's to edit and the application is irrelevant to it.
  --
  -- Nullable, and null is the normal state for: every learner, every applicant
  -- awaiting review, every rejected applicant, and an approved coach who
  -- arrived by INVITE CODE and therefore never filed an application.
  --
  -- NOT privilege-bearing: guard_profile_privilege_columns (0002_rls.sql) pins
  -- role / coach_status / id / email against a self-update and deliberately
  -- leaves these three alone, because a coach editing their own bio through
  -- policy profiles_update_own is the intended path.
  --
  -- There is deliberately NO `sport` column here. There is exactly one sport,
  -- so it is never a dimension — see PROGRESS.md, "No sport axis".
  coach_headline       text,
  coach_bio            text,
  -- Whole years. NULL means "not stated" and 0 means "first season coaching":
  -- two different answers, and the UI renders them differently, so this is
  -- nullable rather than `not null default 0`.
  coach_years_coaching integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Bounds mirrored by optionalText()/optionalYears() in mockClient.ts. A
  -- length cap on free text a stranger can read is not cosmetic: without it one
  -- row can make every card in the directory unreadable.
  constraint profiles_coach_headline_length check (coach_headline is null or char_length(coach_headline) <= 120),
  constraint profiles_coach_bio_length      check (coach_bio is null or char_length(coach_bio) <= 2000),
  constraint profiles_coach_years_range     check (coach_years_coaching is null or coach_years_coaching between 0 and 80)
);

create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_coach_status_idx on public.profiles (coach_status);
-- Non-unique: supports admin lookup by email. See the column comment above for
-- why uniqueness is not enforced here.
create index if not exists profiles_email_idx on public.profiles (lower(email));

-- The coach directory's name search. `listCoaches({ q })` matches full_name and
-- NOTHING ELSE — not the headline, not the bio — and this index is the reason:
-- it is the only column Postgres can serve that query from, so widening the
-- match in the mock would make the two backends disagree the moment the swap
-- happens. Same rule, and same trade, as the listings trigram indexes below.
create index if not exists profiles_full_name_trgm_idx
  on public.profiles using gin (full_name gin_trgm_ops);

-- Serves the unfiltered directory: the approval predicate plus the newest-first
-- order in one partial index. Partial rather than plain because
-- public.public_coaches never returns a non-approved row, so indexing them
-- would be dead weight on a table that is mostly learners.
create index if not exists profiles_approved_coach_created_at_idx
  on public.profiles (created_at desc)
  where coach_status = 'approved';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- coach_applications ---------------------------------------------------------

create table if not exists public.coach_applications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  bio         text not null,
  experience  text not null,
  sport       text,
  status      public.application_status not null default 'pending',
  review_note text,
  -- `on delete set null`: profiles cascade from auth.users, so a reviewer who
  -- is later deleted must not make every application they touched
  -- undeletable (23503). The decision itself is preserved; only the reviewer
  -- attribution is released.
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists coach_applications_user_id_idx on public.coach_applications (user_id);
create index if not exists coach_applications_status_created_at_idx
  on public.coach_applications (status, created_at desc);

-- A user may hold at most ONE application in the 'pending' state at a time.
-- Partial unique index (rather than a plain unique constraint) so that a user
-- whose earlier applications were approved/rejected can apply again.
create unique index if not exists coach_applications_one_pending_per_user_idx
  on public.coach_applications (user_id)
  where status = 'pending';

drop trigger if exists coach_applications_set_updated_at on public.coach_applications;
create trigger coach_applications_set_updated_at
  before update on public.coach_applications
  for each row execute function public.set_updated_at();

-- invites --------------------------------------------------------------------
-- Admin-minted one-shot codes. Redeeming one promotes the redeemer straight to
-- an approved coach, bypassing the application queue.

-- Referential-action policy for the two profile references, since profiles
-- themselves cascade away when the auth.users row is deleted:
--
--   created_by  -> ON DELETE RESTRICT, deliberately. An invite is the audit
--                  record of who granted somebody coach status, and a record
--                  whose author has silently become NULL is worth very little.
--                  The cost is explicit and documented: an admin who has minted
--                  invites cannot be hard-deleted until those invites are
--                  reassigned or removed. Left as NOT NULL for the same reason.
--                  (Change to ON DELETE SET NULL + a nullable column if user
--                  erasure must never be blocked; that is the real trade-off.)
--   redeemed_by -> ON DELETE SET NULL. Already nullable, and a deleted
--                  redeemer must not make the invite row undeletable.
create table if not exists public.invites (
  code        text primary key,
  created_by  uuid not null references public.profiles (id) on delete restrict,
  note        text,
  expires_at  timestamptz,
  redeemed_by uuid references public.profiles (id) on delete set null,
  redeemed_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists invites_created_by_idx on public.invites (created_by);
create index if not exists invites_redeemed_by_idx on public.invites (redeemed_by);

-- Codes are matched case-insensitively by redeem_invite_code(), so guarantee
-- two codes cannot collide only by case.
create unique index if not exists invites_code_lower_idx on public.invites (lower(code));

-- listings -------------------------------------------------------------------

create table if not exists public.listings (
  id           uuid primary key default gen_random_uuid(),
  coach_id     uuid not null references public.profiles (id) on delete cascade,
  title        text not null,
  description  text not null,
  price_cents  integer not null check (price_cents >= 0),
  -- Enum, not text: free-text categories are what made the filter unusable, and
  -- the type is the enforcement. Postgres rejects anything outside the eight at
  -- the cast, which is the SQL half of the check `requireListingCategory()`
  -- makes in mockClient.ts. Edited in place rather than stacked as a later
  -- migration because this file has never been applied anywhere — see the
  -- header.
  category     public.listing_category not null,
  -- The offer's PRICING GENERATION. Starts at 1; incremented only when the
  -- price goes UP. Orders and reviews copy the value that was current when they
  -- were created, and public.offer_stats groups on it — so a price rise archives
  -- this offer's rating and sales and the offer reads as new, while
  -- public.coach_stats ignores the column entirely and the coach's standing is
  -- untouched. Nothing is deleted by a price change; the reviews stay on the row.
  --
  -- The increment is NOT left to application code: it is derived by the
  -- BEFORE UPDATE trigger `guard_listing_update()` in 0002_rls.sql, which sets
  -- price_epoch = old.price_epoch + 1 when and only when new.price_cents is
  -- strictly greater than old.price_cents, and pins it to the old value
  -- otherwise. A client can therefore neither skip the archive by PATCHing the
  -- price directly nor forge an epoch, and a price CUT cannot bump it.
  price_epoch  integer not null default 1 check (price_epoch >= 1),
  -- WITHDRAWAL. Deletion of a listing is ALWAYS soft: there is no DELETE policy
  -- on this table for any client role (see 0002_rls.sql), because a hard delete
  -- either cascades and destroys the offer's reviews or is blocked outright by
  -- `orders.listing_id`'s ON DELETE RESTRICT the moment the offer has sold —
  -- i.e. a coach could never withdraw anything anybody bought.
  --
  -- NULL = on sale. Non-NULL = withdrawn, and:
  --   * `listings_select_public` filters it out, so it disappears from browse,
  --     search, the public coach profile, `offer_stats` and `public_reviews`
  --     for that offer;
  --   * `coach_stats` does NOT filter it — the coaching was sold and reviewed,
  --     and withdrawing the offer does not undo that;
  --   * the owner, an admin and anyone holding an order for it can still SELECT
  --     the row (three separate policies), which is what makes a tombstone
  --     possible instead of a dead link from a purchase history;
  --   * clearing it again restores the offer, unchanged, because nothing was
  --     destroyed.
  deleted_at   timestamptz,
  -- WHO withdrew it. An audit column on the same pattern as
  -- coach_applications.reviewed_by, and `on delete set null` for the same
  -- reason: an admin who is later deleted must not make every offer they ever
  -- took down undeletable (23503). The attribution is released; the withdrawal
  -- itself survives in deleted_at.
  --
  -- It exists because both the owner and an admin may withdraw an offer, and
  -- restore has to tell them apart: a coach may freely undo THEIR OWN
  -- withdrawal, but an admin takedown a coach can reverse in one click is not a
  -- takedown. Derived by guard_listing_update(), never client-supplied.
  --
  -- NEVER PROJECTED TO A CALLER. After a takedown this holds an ADMINISTRATOR's
  -- id, and publishing it — even to the coach who owns the offer — is
  -- administrator enumeration, which is exactly what public_profiles drops
  -- `role` to prevent. The mock's ListingWithCoach omits it by construction.
  deleted_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists listings_coach_id_idx on public.listings (coach_id);
create index if not exists listings_category_idx on public.listings (category);
create index if not exists listings_created_at_idx on public.listings (created_at desc);
-- Partial, on the predicate every public read carries: browse is
-- `where deleted_at is null order by created_at desc`, so the index covers the
-- filter and the sort together and never grows with withdrawn rows.
create index if not exists listings_published_created_at_idx
  on public.listings (created_at desc)
  where deleted_at is null;

-- Keyword search. The app does a case-insensitive substring match over title +
-- description (`ilike '%q%'`), which a trigram GIN index can serve; the
-- tsvector index is there for the full-text variant of the same query.
create index if not exists listings_title_trgm_idx
  on public.listings using gin (title gin_trgm_ops);
create index if not exists listings_description_trgm_idx
  on public.listings using gin (description gin_trgm_ops);
create index if not exists listings_search_tsv_idx
  on public.listings using gin (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  );

drop trigger if exists listings_set_updated_at on public.listings;
create trigger listings_set_updated_at
  before update on public.listings
  for each row execute function public.set_updated_at();

-- listing_revisions ----------------------------------------------------------
-- APPEND-ONLY. One row per edit of an offer, holding the version that edit
-- SUPERSEDED — so the live `listings` row is the current version and every row
-- here is a previous one. Written by the `record_listing_revision()` trigger in
-- 0002_rls.sql, never by a client: there is no INSERT, UPDATE or DELETE policy
-- for any client role.
--
-- WHY IT EXISTS, given that price_epoch already archives social proof: the two
-- cover different halves of the same problem, on purpose.
--
--   * raising the PRICE archives the offer's rating, reviews and sales, because
--     the thing on sale is no longer the thing that was reviewed;
--   * rewriting the CONTENT at the same price archives nothing — that is the
--     accepted limit of the epoch rule — so the only way a reader can tell
--     which reviews predate a rewrite is for the superseded text to survive.
--
-- NOT PUBLIC (see the policies in 0002_rls.sql). Publishing this would publish
-- the full price history of every offer on the site, which is strictly more
-- than the price_epoch that is already kept out of `offer_stats`.
--
-- `listing_id` is ON DELETE CASCADE and not RESTRICT, unlike orders': a
-- revision is an editorial record of a row, not a record of money changing
-- hands, and it should not be the thing that blocks a deletion.
create table if not exists public.listing_revisions (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.listings (id) on delete cascade,
  title       text not null,
  description text not null,
  price_cents integer not null check (price_cents >= 0),
  category    public.listing_category not null,
  -- The moment this version was REPLACED, not the moment it was written. There
  -- is deliberately no updated_at: the table is append-only, so a row can never
  -- have one that differs.
  created_at  timestamptz not null default now()
);

create index if not exists listing_revisions_listing_created_at_idx
  on public.listing_revisions (listing_id, created_at desc);

-- orders ---------------------------------------------------------------------
-- A purchase. In this POC every row is FABRICATED demo data — there is no
-- checkout, no payment processor and no insert path for a client (see the
-- policy set in 0002_rls.sql, which grants nobody INSERT). The table is modelled
-- properly anyway, because reviews hang off it and because "12 sales" has to
-- count something.
--
-- Referential actions, and why they differ from listings':
--
--   listing_id -> ON DELETE RESTRICT, deliberately. An order is a record of
--                 money changing hands; a CASCADE would let deleting an offer
--                 silently erase its sales history, and that history is exactly
--                 what the coach's account-level totals are made of. The cost is
--                 explicit and intended: an offer that has sold cannot be hard
--                 deleted. Withdrawal is meant to be a soft delete
--                 (`deleted_at`) precisely so this constraint is never the thing
--                 a coach runs into.
--   learner_id / coach_id -> ON DELETE CASCADE, matching listings.coach_id:
--                 profiles cascade from auth.users, and a user erasure must not
--                 be blocked by their purchase history.
create table if not exists public.orders (
  id                      uuid primary key default gen_random_uuid(),
  learner_id              uuid not null references public.profiles (id) on delete cascade,
  listing_id              uuid not null references public.listings (id) on delete restrict,
  -- The seller AT THE TIME OF SALE, denormalised from the listing. This is what
  -- makes a coach's sales count a single-column scan that never depends on the
  -- listing being visible (or, later, on it not being soft-deleted).
  coach_id                uuid not null references public.profiles (id) on delete cascade,
  -- A snapshot, not a join. Editing an offer's price must never rewrite what
  -- somebody already paid.
  price_cents_at_purchase integer not null check (price_cents_at_purchase >= 0),
  -- The listing's price_epoch at the moment of purchase.
  price_epoch             integer not null default 1 check (price_epoch >= 1),
  created_at              timestamptz not null default now()
);

create index if not exists orders_learner_id_idx on public.orders (learner_id);
create index if not exists orders_coach_id_idx on public.orders (coach_id);
-- Composite, in this order: the offer-level sales count filters listing_id AND
-- the current epoch together, which is the hot query on every offer card.
create index if not exists orders_listing_epoch_idx on public.orders (listing_id, price_epoch);

-- reviews --------------------------------------------------------------------
-- Anchored to an order, which is the whole anti-spam design: no purchase, no
-- review; one purchase, one review; and "Verified purchase" is then a fact about
-- the schema rather than a badge somebody decided to render.
create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  -- UNIQUE is the constraint that makes "one review per order" a property of the
  -- database rather than a race in application code. Two concurrent submits for
  -- the same order cannot both land: the loser gets 23505.
  order_id    uuid not null unique references public.orders (id) on delete cascade,
  -- Denormalised from the order so the offer-level aggregate never has to join
  -- through orders. It is pinned to the order's listing on write (see the
  -- reviews_insert_own_purchase policy in 0002_rls.sql), so it cannot drift.
  listing_id  uuid not null references public.listings (id) on delete restrict,
  author_id   uuid not null references public.profiles (id) on delete cascade,
  -- 1-5. There is no rating of 0: zero is the ABSENCE of a rating, and the read
  -- shape (a NULL average) is what carries that. Allowing 0 here would make
  -- "unrated" and "rated terribly" the same number.
  rating      smallint not null check (rating between 1 and 5),
  body        text not null check (btrim(body) <> ''),
  -- The listing's price_epoch when the review was written.
  price_epoch integer not null default 1 check (price_epoch >= 1),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists reviews_author_id_idx on public.reviews (author_id);
create index if not exists reviews_listing_epoch_idx on public.reviews (listing_id, price_epoch);
create index if not exists reviews_created_at_idx on public.reviews (created_at desc);

drop trigger if exists reviews_set_updated_at on public.reviews;
create trigger reviews_set_updated_at
  before update on public.reviews
  for each row execute function public.set_updated_at();
