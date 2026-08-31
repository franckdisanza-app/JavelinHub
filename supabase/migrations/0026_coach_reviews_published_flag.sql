-- ===========================================================================
-- 0026_coach_reviews_published_flag.sql — one derived boolean, so a paginated
-- page does not have to guess.
-- ===========================================================================
--
-- `/coaches/[id]` renders a review's offer title as a LINK only when that offer
-- is still on sale, because a withdrawn offer is a 404 for the public. Until
-- now it worked that out by intersecting the review list with the coach's offer
-- list, both read in full on the same request.
--
-- **Pagination breaks that intersection by construction.** Once each list is a
-- page, a review on page 1 can be about an offer on page 3 — the offer is on
-- sale, the intersection does not contain it, and the title silently stops
-- being a link. No error, no failing assertion, just a page that quietly gets
-- worse as a coach publishes more.
--
-- So the fact moves onto the row that needs it. The view ALREADY joins
-- `listings` — that is where `listing_title` comes from — so this is one
-- expression over a join that was being paid for anyway.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS IS NOT
-- -----------------------------------------------------------------------------
-- It is NOT a `where` clause, and it must never become one. The comment above
-- this view in `0003` is emphatic and still binding: `public_coach_reviews` has
-- no `deleted_at` predicate and no epoch predicate, because it is the list that
-- sits beside the `coach_stats` count and the two have to agree row for row.
-- Filtering withdrawn offers out here would make a coach's public review list
-- disagree with their own review count the moment they withdrew anything.
--
-- A projected boolean says the same thing to a reader without removing a row
-- from anybody's count. `deleted_at` itself stays unprojected: it is an exact
-- withdrawal timestamp for an offer the public can no longer see, and the
-- question a review list actually has is yes-or-no.

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
    l.title      as listing_title,
    (l.deleted_at is null) as listing_published
  from public.reviews r
  join public.listings l         on l.id = r.listing_id
  join public.public_profiles pp on pp.id = r.author_id;

comment on view public.public_coach_reviews is
  'Coach-account-level public review list: the public_reviews projection plus coach_id, the offer title and whether that offer is still on sale, across EVERY offer, EVERY price_epoch and EVERY withdrawal state. Must never gain a deleted_at or price_epoch filter - it is the list beside the coach_stats count and the two have to agree; listing_published (0026) reports the withdrawal without removing the row. Still exposes no order_id, author_id, price_epoch, updated_at or deleted_at.';

grant select on public.public_coach_reviews to anon, authenticated;
