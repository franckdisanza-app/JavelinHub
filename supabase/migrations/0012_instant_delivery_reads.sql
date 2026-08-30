-- ===========================================================================
-- 0012_instant_delivery_reads.sql — the two reads instant delivery needs.
-- ===========================================================================
--
-- 0011 built the whole instant-delivery mechanism except the ability to LOOK
-- at it. Section 7 of that file grants `select (fulfilment)` and deliberately
-- withholds `asset_path`:
--
--     `asset_path` is deliberately NOT granted: the object is private, the
--     path is the coach's business, and the download is handed out as a signed
--     URL by the application rather than discovered from a column.
--
-- That is still the rule and this migration does not weaken it — there is no
-- new column grant on `public.listings` anywhere below. But a signed URL is
-- minted FROM a path, so the two people entitled to one have to be able to
-- reach it somehow, and a column grant is the wrong instrument: it is role-
-- level, so granting `asset_path` to `authenticated` would publish every
-- coach's paths to every signed-in visitor through PostgREST.
--
-- A VIEW is row-level. Both views below are owner-run (no `security_invoker`),
-- so they read past the column grants, and each carries its own `auth.uid()`
-- predicate INSIDE the view — which is the security boundary, not a
-- convenience. No `?listing_id=eq.` from a caller can widen a predicate that
-- is already in the FROM clause. This is exactly the trade `owned_listings`
-- already makes for `deleted_by`, and it is why that view exists at all.
--
-- WHAT A PATH IS AND IS NOT. A path is not a capability. `offer-assets` is a
-- private bucket, so holding the string buys nothing: reading the object still
-- goes through `offer_assets_read_entitled`, evaluated against the reader's own
-- `auth.uid()` at the moment the URL is signed. The predicates below are
-- therefore defence in depth rather than the lock itself — but they are
-- written to MATCH that storage policy exactly, so that "can I see this path?"
-- and "can I read these bytes?" cannot drift into two different answers.

-- ---------------------------------------------------------------------------
-- 1. public.owned_listings gains `fulfilment` and `asset_path`.
--
-- The coach's own dashboard and editor are the write side of instant delivery:
-- to render "this offer delivers a file, and here is the file", they need both
-- columns for their OWN rows. The view is already scoped `where l.coach_id =
-- auth.uid()`, so appending `asset_path` here exposes it to exactly one person
-- — the coach who put it there.
--
-- `drop` + `create` rather than `create or replace`, because a replace can only
-- APPEND columns and this file would otherwise be unable to say what the view
-- projects in one readable list. Nothing depends on this view in SQL (it is
-- read by `listMyListings` and by `restoreListing`'s pre-check, both through
-- PostgREST), so dropping it breaks nothing at migration time.
--
-- The rest of the projection is 0003's, restated verbatim. Note what is STILL
-- absent: `deleted_by`. It stays unreadable and `withdrawn_by_admin` continues
-- to be the boolean that replaces it.
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
    ) as withdrawn_by_admin,
    l.fulfilment,
    l.asset_path
  from public.listings l
 where l.coach_id = auth.uid();

comment on view public.owned_listings is
  'A coach OWN offers, withdrawn ones included, plus the derived withdrawn_by_admin boolean that replaces the unreadable listings.deleted_by, plus fulfilment and asset_path so the owner can manage an instant download. Scoped by auth.uid() inside the view, so it is empty for anon and can never be pointed at another coach. Publishes whether an administrator acted, never which administrator.';

grant select on public.owned_listings to authenticated;

-- ---------------------------------------------------------------------------
-- 2. public.entitled_offer_assets — the BUYER's half.
--
-- One row per instant offer whose file the caller is entitled to download, and
-- no rows at all for anybody else. The predicate is `offer_assets_read_entitled`
-- from 0011 restated against the listing rather than against an object name:
--
--     the coach who owns the offer, OR anyone holding an order for it
--
-- and it is kept in that order so the two read as the same sentence. If one is
-- ever changed the other must change with it; a coach who can write a file the
-- policy will not serve, or a buyer who can see a path the policy refuses, is
-- the drift this comment exists to prevent.
--
-- Two further predicates narrow it, and both are honesty rather than security:
--
--   fulfilment = 'instant'      a personalised offer cannot have an asset at
--                               all (`listings_asset_path_shape`), so this only
--                               restates the constraint — but it means the view
--                               can never hand back a path for an offer whose
--                               files live on the ORDER instead.
--   asset_path is not null      an instant offer may be published before its
--                               file is attached. No row is the truthful answer
--                               for "the download for this offer", not a row
--                               holding NULL.
--
-- WITHDRAWAL IS NOT FILTERED, deliberately, and it is the same rule the order
-- tombstone follows: withdrawing an offer takes it off sale, it does not
-- repossess what somebody already claimed. A buyer whose coach withdrew an
-- offer after they claimed it keeps their download.
-- ---------------------------------------------------------------------------
drop view if exists public.entitled_offer_assets;
create view public.entitled_offer_assets as
  select
    l.id as listing_id,
    l.asset_path
  from public.listings l
 where l.fulfilment = 'instant'
   and l.asset_path is not null
   and (
     l.coach_id = auth.uid()
     or exists (
       select 1 from public.orders o
        where o.listing_id = l.id and o.learner_id = auth.uid()
     )
   );

comment on view public.entitled_offer_assets is
  'The instant-download path for offers the caller may actually download: the coach who owns the offer, or a learner holding an order for it. Mirrors the offer_assets_read_entitled storage policy row for row. Scoped by auth.uid() inside the view, so it is empty for anon. The path is not a capability - the bucket is private and reading still goes through that policy.';

grant select on public.entitled_offer_assets to authenticated;

-- Neither view is revoked from `anon`, and 0007 already worked through why for
-- `owned_listings`: the `auth.uid()` predicate is INSIDE the view, so an
-- anonymous caller matches no row and gets an empty set rather than a refusal.
-- The same holds here — `auth.uid()` is NULL for anon, so both arms of the
-- entitlement test are false. Adding a revoke would be belt and braces, and
-- would split one security property across two mechanisms; it is left where the
-- comment says it is.
