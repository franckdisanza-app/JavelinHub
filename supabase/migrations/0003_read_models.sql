-- ===========================================================================
-- 0003_read_models.sql — three read surfaces the DataClient contract needs
--                        and 0001/0002 do not provide.
-- ===========================================================================
--
-- These are not new features. Each one closes a case where a method already
-- specified in `src/lib/data/client.ts` and already implemented in
-- `mockClient.ts` CANNOT be implemented against the schema as authored,
-- because the fact it has to return is deliberately unreadable.
--
-- A NOTE ON THE `join public.public_profiles` IN THE TWO REVIEW VIEWS, because
-- it looks like a bug and is not: an INNER join there cannot drop a review.
-- `reviews.author_id` is `references public.profiles (id) ON DELETE CASCADE`
-- (0001_init.sql), so a review whose author is gone does not exist to be
-- dropped, and `public_profiles` filters nothing. Do not "fix" it to a LEFT
-- join with a `coalesce(..., 'Former member')`: the mock needs that fallback
-- because a hand-edited JSON store has no referential integrity, and Postgres
-- does. Adding it would make the coach-level list disagree with
-- `coach_stats.review_count` in exactly the case the comment on view 2 forbids.
--
-- All three follow the idiom 0002 established for `public_profiles`,
-- `public_coaches`, `offer_stats` and `coach_stats`: a view that runs as its
-- OWNER (no `security_invoker`), so it may read past RLS and past the
-- column-level revoke on `listings.deleted_by`, and that carries its own
-- restricting predicate INSIDE the view where no caller-supplied filter can
-- widen it. The rule this buys is the same one those views buy — publish the
-- derived answer, never the row it was derived from.
--
-- Consequence, inherited from those views and worth restating: enabling FORCE
-- RLS on `listings`, `reviews` or `profiles` breaks all three.

-- ---------------------------------------------------------------------------
-- 1. public.public_listing_reviews — the OFFER page's review list.
--
-- `listReviewsForListing` must return the current price epoch only, so that the
-- list can never disagree with the count in `offer_stats` (which filters the
-- same way): an offer reading "No reviews yet" must not render twelve of them
-- underneath. It must also return `[]` for a withdrawn offer.
--
-- `public.public_reviews` cannot do either. It deliberately does not project
-- `price_epoch` — publishing that integer would leak how many times a coach has
-- raised the price, which is the very thing `listing_revisions` is kept
-- owner-only to avoid — and it carries no `deleted_at` predicate. A client
-- therefore has nothing to filter on, and `listings_select_public` hides the
-- withdrawn parent row rather than the reviews attached to it.
--
-- So the epoch filter moves INTO a view. The client filters by `listing_id` and
-- nothing else; the epoch does the work and is never exposed.
-- ---------------------------------------------------------------------------
drop view if exists public.public_listing_reviews;
create view public.public_listing_reviews as
  select
    r.id,
    r.listing_id,
    r.rating,
    r.body,
    r.created_at,
    pp.full_name as author_name
  from public.reviews r
  join public.listings l         on l.id = r.listing_id
  join public.public_profiles pp on pp.id = r.author_id
 where l.deleted_at is null
   and r.price_epoch = l.price_epoch;

comment on view public.public_listing_reviews is
  'Offer-level public review list: the public_reviews projection, restricted to PUBLISHED offers at their CURRENT price_epoch. Both predicates live in the view so no caller-supplied filter can widen them, and price_epoch is filtered on without ever being projected — exposing it would publish a per-offer price history. Pairs with offer_stats, which filters identically; the two must always agree.';

grant select on public.public_listing_reviews to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. public.public_coach_reviews — the COACH PROFILE's review list.
--
-- `listReviewsForCoach` is the ACCOUNT-level read and is the pair to
-- `coach_stats`: every offer, every epoch, and every withdrawal state. Raising
-- a price or withdrawing an offer does not undo the coaching that was reviewed.
--
-- Two things stop a client assembling this from `public_reviews`:
--
--   * There is no `coach_id` on it, and the only way to reach one is to join
--     `public.listings` — where `listings_select_public` hides every withdrawn
--     offer from anon. A visitor would silently MISS the reviews of withdrawn
--     offers while `coach_stats` still counted them, so the list and the number
--     beside it would disagree. That is exactly the failure the comment on
--     `coach_stats` forbids.
--   * `listing_title` has the same problem, and would degrade to "Unknown
--     offer" for precisely those rows.
--
-- Hence: no `deleted_at` predicate and no epoch predicate here, deliberately.
-- NEITHER MAY EVER BE ADDED — see the comment above `public.coach_stats`, which
-- this view has to agree with row-for-row.
-- ---------------------------------------------------------------------------
drop view if exists public.public_coach_reviews;
create view public.public_coach_reviews as
  select
    r.id,
    r.listing_id,
    r.rating,
    r.body,
    r.created_at,
    pp.full_name as author_name,
    l.coach_id,
    l.title      as listing_title
  from public.reviews r
  join public.listings l         on l.id = r.listing_id
  join public.public_profiles pp on pp.id = r.author_id;

comment on view public.public_coach_reviews is
  'Coach-account-level public review list: the public_reviews projection plus coach_id and the offer title, across EVERY offer, EVERY price_epoch and EVERY withdrawal state. Must never gain a deleted_at or price_epoch filter — it is the list beside the coach_stats count and the two have to agree. Still exposes no order_id, author_id, price_epoch or updated_at.';

grant select on public.public_coach_reviews to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. public.owned_listings — a coach's own dashboard.
--
-- `listMyListings` returns `OwnedListing`, which is the public listing shape
-- plus `withdrawn_by_admin: boolean`. The dashboard needs it to decide whether
-- to render a Restore control at all: a coach may undo their own withdrawal,
-- but `guard_listing_update()` refuses to let them clear a `deleted_at` an
-- ADMIN set, so offering a button guaranteed to fail is worse than offering
-- none.
--
-- The flag derives from `listings.deleted_by`, and 0002 revokes SELECT on that
-- column from every client role — for a good reason that has not changed: after
-- a takedown it holds an administrator's user id, and PostgREST is reachable
-- from a browser with the anon key. So the id stays unreadable and this view
-- publishes the BOOLEAN instead. A coach learns that an administrator acted;
-- they never learn WHICH one. That is the same trade `PublicProfile` makes by
-- exposing `is_approved_coach` instead of `role`.
--
-- `where l.coach_id = auth.uid()` is the security boundary, and it is inside the
-- view for the same reason the approval predicate on `public_coaches` is: the
-- row's existence IS the ownership, and no `?coach_id=eq.` from a caller can
-- widen it. `deleted_at` is NOT filtered — the whole point of the dashboard is
-- that a coach can see and restore what they withdrew.
-- ---------------------------------------------------------------------------
drop view if exists public.owned_listings;
create view public.owned_listings as
  select
    l.id,
    l.coach_id,
    l.title,
    l.description,
    l.price_cents,
    l.category,
    l.price_epoch,
    l.deleted_at,
    l.created_at,
    l.updated_at,
    (
      l.deleted_at     is not null
      and l.deleted_by is not null
      and l.deleted_by <> l.coach_id
    ) as withdrawn_by_admin
  from public.listings l
 where l.coach_id = auth.uid();

comment on view public.owned_listings is
  'A coach OWN offers, withdrawn ones included, plus the derived withdrawn_by_admin boolean that replaces the unreadable listings.deleted_by. Scoped by auth.uid() inside the view, so it is empty for anon and can never be pointed at another coach. Publishes whether an administrator acted, never which administrator.';

grant select on public.owned_listings to authenticated;

-- ---------------------------------------------------------------------------
-- 4. public.public_coaches gains created_at — so the directory can be ORDERED.
--
-- `listCoaches` returns approved coaches newest-first. 0001_init.sql already
-- anticipated exactly that: `profiles_approved_coach_created_at_idx` is a
-- partial index on `(created_at desc) where coach_status = 'approved'`, which
-- exists for no other query. But the view it has to serve never projected
-- `created_at`, and PostgREST can only order by a column the view exposes — so
-- the ordering the index was built for could not be asked for.
--
-- `create or replace view` APPENDS the column; the five existing ones keep
-- their names, types and positions, so nothing that selects from this view
-- changes shape. `PublicCoach` in `types.ts` deliberately does NOT gain a
-- field: the client orders by `created_at` without selecting it, and the public
-- coach shape stays exactly the five columns it documents.
--
-- Publishing it at all is a considered trade, not an oversight: an account
-- creation date is "member since", which is ordinary for a coach directory and
-- carries none of the enumeration risk that keeps `role` and `coach_status` out
-- of this view. The alternative — ordering the directory alphabetically —
-- would have changed a product behaviour to work around a missing column.
-- ---------------------------------------------------------------------------
create or replace view public.public_coaches as
  select
    p.id,
    p.full_name,
    p.coach_headline,
    p.coach_bio,
    p.coach_years_coaching,
    p.created_at
  from public.profiles p
  where p.coach_status = 'approved';

comment on view public.public_coaches is
  'Public coach directory: id, full_name, the three coach-authored columns and created_at, for APPROVED coaches only. The where-clause lives in the view, so the row existing IS the approval and no caller-supplied predicate can widen it — there is deliberately no role, coach_status or is_approved_coach column to filter on. created_at is present so the directory can be ordered newest-first against profiles_approved_coach_created_at_idx; it is not part of the PublicCoach shape. Carries nothing from coach_applications. Runs as its owner and so bypasses profiles RLS; breaks if FORCE RLS is ever enabled on profiles.';

grant select on public.public_coaches to anon, authenticated;
