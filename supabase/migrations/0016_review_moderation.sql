-- ===========================================================================
-- 0016_review_moderation.sql — the one thing on this site written by one
-- person about another.
-- ===========================================================================
--
-- `docs/ROADMAP.md` §7: *"No moderation UI. `0002_rls.sql` carries
-- `reviews_update_admin` and `reviews_delete_admin` for exactly this, and no
-- page calls either."* Those two policies have existed since the schema landed
-- and nothing has ever used them, so a published review has been unremovable
-- through the application — the only remedy was the SQL editor, which is
-- exactly where password reset was before it was built.
--
-- It matters now rather than eventually because the approval path only just
-- opened: coaches can be approved, offers published and orders claimed, so
-- reviews are possible for the first time. A review is public, attributed by
-- name, permanent, and `docs/DATA-LAYER.md` records that its author gets no
-- edit or delete path by design — which is defensible only if SOMEBODY has one.
--
-- -----------------------------------------------------------------------------
-- THREE DECISIONS, and each rules out an obvious alternative
-- -----------------------------------------------------------------------------
--
-- 1. **REMOVAL IS A DELETE, NEVER AN EDIT**, and `reviews_update_admin` is
--    dropped below rather than wired up.
--
--    `0002_rls.sql` already made this argument about listings: *"An admin who
--    could rewrite a coach's copy would be publishing words under that coach's
--    byline, which is worse than the problem moderation is solving."* A review
--    is the same shape and more so — it is published under a named person's
--    identity and is an opinion, so an edited one is a fabricated opinion
--    attributed to a real reader. Redaction sounds like a gentler option and is
--    not: it is still the site putting words where somebody else's were.
--
-- 2. **ARCHIVE-AND-DELETE, NOT A SOFT DELETE**, which is the opposite of what
--    listings do, and the difference is worth stating because the inconsistency
--    is deliberate.
--
--    `listings.deleted_at` works because a withdrawn offer must stay joinable:
--    orders point at it, `orders.listing_id` is ON DELETE RESTRICT, and its
--    reviews must survive. NOTHING POINTS AT A REVIEW. It is a leaf.
--
--    And a soft-deleted review would have to be filtered out of `public_reviews`,
--    `public_listing_reviews`, `public_coach_reviews`, `offer_stats` AND
--    `coach_stats` — five places, where forgetting one leaves a removed review
--    still counting towards a rating, invisibly. `Listing.deleted_at` documents
--    that exact hazard as the cost of the soft-delete approach. Moving the row
--    to `removed_reviews` makes every one of those views correct with no change
--    at all, because the row is simply not there any more.
--
--    The evidence is not lost: the whole review is copied first, in the same
--    transaction.
--
-- 3. **EVERY REMOVAL GOES THROUGH THE RPC**, so `reviews_delete_admin` is
--    dropped too.
--
--    Left in place it would let an administrator `DELETE` a review straight
--    through PostgREST and leave no archive row — an audited path beside an
--    unaudited one, where the unaudited one is a single HTTP request. An audit
--    trail that can be stepped around is not an audit trail. `remove_review()`
--    below is now the only way a review can cease to exist, and it writes the
--    archive and performs the delete in one function body, which is one
--    transaction.

-- ---------------------------------------------------------------------------
-- 1. The archive.
--
-- A full copy of the review as it stood, plus who removed it and why. Not a
-- general audit log — §7 wants one of those too and it is a bigger design — but
-- the specific record that makes THIS action reversible in the sense that
-- matters: somebody can be shown what was taken down.
-- ---------------------------------------------------------------------------
create table if not exists public.removed_reviews (
  id                 uuid primary key default gen_random_uuid(),

  -- NOT a foreign key, on purpose: the row it names has been deleted by the
  -- time this one is committed. Kept so an operator can correlate with anything
  -- that recorded the review's id before it went.
  review_id          uuid not null,

  -- These two ARE foreign keys, because both still exist. `listings` has no
  -- delete path for any role, so `restrict` costs nothing and is honest.
  listing_id         uuid not null references public.listings (id) on delete restrict,
  -- `set null`, and this is the lesson `invites.created_by` taught: an audit
  -- column with ON DELETE RESTRICT blocks account deletion, and
  -- `supabase/README.md` records that as "a real obstacle to writing the
  -- feature". An archive row that prevents a GDPR erasure is an archive row
  -- somebody will delete instead.
  author_id          uuid references public.profiles (id) on delete set null,
  order_id           uuid not null,

  -- The review itself, verbatim.
  rating             smallint not null,
  body               text not null,
  price_epoch        integer not null,
  review_created_at  timestamptz not null,

  -- Who acted. `set null` for the same reason as `author_id`.
  removed_by         uuid references public.profiles (id) on delete set null,
  removed_at         timestamptz not null default now(),
  -- Free text, written by the administrator. Optional: a reason nobody can be
  -- bothered to write becomes a copy-pasted one, which is worse than blank.
  reason             text,

  constraint removed_reviews_rating_range check (rating between 1 and 5),
  constraint removed_reviews_reason_length check (reason is null or char_length(reason) <= 1000)
);

create index if not exists removed_reviews_removed_at_idx
  on public.removed_reviews (removed_at desc);
create index if not exists removed_reviews_listing_idx
  on public.removed_reviews (listing_id);

comment on table public.removed_reviews is
  'Reviews an administrator has taken down, copied verbatim before deletion. The review row itself is DELETED rather than flagged, so every aggregate and public view is correct with no filter to forget. Readable only by administrators; writable only by remove_review().';

alter table public.removed_reviews enable row level security;

-- Administrators can read the archive, and delete from it.
--
-- The DELETE arm is not an oversight and not a way to cover tracks: it is the
-- ERASURE path. A review is sometimes removed precisely because it contains
-- something that should not persist — somebody's phone number, somebody's
-- medical detail — and an archive that cannot be purged would keep exactly the
-- text the removal existed to take down. So the copy is the default and
-- destroying it is a second, deliberate action.
drop policy if exists removed_reviews_select_admin on public.removed_reviews;
create policy removed_reviews_select_admin
  on public.removed_reviews for select to authenticated
  using (public.is_admin());

drop policy if exists removed_reviews_delete_admin on public.removed_reviews;
create policy removed_reviews_delete_admin
  on public.removed_reviews for delete to authenticated
  using (public.is_admin());

-- NO INSERT AND NO UPDATE POLICY FOR ANY CLIENT ROLE. The archive is written by
-- `remove_review()` alone, so a row in it always corresponds to a review that
-- actually existed and was actually removed. A client INSERT would let anybody
-- with an admin session fabricate a takedown that never happened.
drop policy if exists removed_reviews_privileged on public.removed_reviews;
create policy removed_reviews_privileged
  on public.removed_reviews for all to javelin_privileged
  using (true) with check (true);

revoke all on public.removed_reviews from anon;
grant select, delete on public.removed_reviews to authenticated;
grant select, insert on public.removed_reviews to javelin_privileged;

-- ---------------------------------------------------------------------------
-- 2. The two policies that are being retired, and why they go rather than stay.
--
-- Both were written in 0002 for a moderation feature that did not exist yet.
-- Now that it does, each of them is a way AROUND it:
--
--   reviews_update_admin  would let an administrator rewrite a review in place.
--                         See decision 1 in the header.
--   reviews_delete_admin  would let one delete a review with no archive row.
--                         See decision 3.
--
-- Dropping a permissive policy only ever narrows what is possible, so this
-- cannot break a caller that was relying on it — and nothing was: no
-- `DataClient` method has ever referenced either.
-- ---------------------------------------------------------------------------
drop policy if exists reviews_update_admin on public.reviews;
drop policy if exists reviews_delete_admin on public.reviews;

-- The privileged role now needs what the admin just gave up, since
-- `remove_review()` runs as `javelin_privileged` and has to read the row and
-- then delete it. 0002 grants this role table privileges one table at a time
-- and never covered `reviews`; both halves — the grant AND the policy — are
-- required, which is the lesson 0013/0014 paid for.
grant select, delete on public.reviews to javelin_privileged;

drop policy if exists reviews_privileged on public.reviews;
create policy reviews_privileged
  on public.reviews for all to javelin_privileged
  using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 3. remove_review(review_id, reason) — the only way a review can cease to be.
--
-- Copy, then delete, in one function body and therefore one transaction. There
-- is no interleaving in which the review is gone and the archive row is not.
--
-- SECURITY DEFINER so it can touch a table administrators hold no INSERT on.
-- `public.is_admin()` is itself SECURITY DEFINER owned by the migration role,
-- so it resolves `auth.uid()` correctly even when called from a function
-- running as `javelin_privileged` — the arrangement 0004 and 0005 exist to
-- explain. The actor id comes from `public.jwt_uid()` for the same reason.
-- ---------------------------------------------------------------------------
create or replace function public.remove_review(p_review_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id uuid := public.jwt_uid();
  v_review   public.reviews;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can remove a review.' using errcode = '42501';
  end if;

  if p_review_id is null then
    raise exception 'That review could not be found.' using errcode = 'P0002';
  end if;

  if p_reason is not null and char_length(p_reason) > 1000 then
    raise exception 'A removal reason must be 1000 characters or fewer.' using errcode = '22023';
  end if;

  -- `for update` so two administrators acting at once cannot both archive it.
  -- The second finds no row and gets the not-found message, which is true by
  -- then.
  select * into v_review from public.reviews r where r.id = p_review_id for update;
  if not found then
    raise exception 'That review could not be found.' using errcode = 'P0002';
  end if;

  insert into public.removed_reviews (
    review_id, listing_id, author_id, order_id,
    rating, body, price_epoch, review_created_at,
    removed_by, reason
  )
  values (
    v_review.id, v_review.listing_id, v_review.author_id, v_review.order_id,
    v_review.rating, v_review.body, v_review.price_epoch, v_review.created_at,
    v_admin_id, nullif(btrim(coalesce(p_reason, '')), '')
  );

  delete from public.reviews where id = p_review_id;
end;
$$;

comment on function public.remove_review(uuid, text) is
  'Archives a review into removed_reviews and deletes it, in one transaction. Administrators only. The ONLY path that removes a review: the admin DELETE policy on reviews was dropped in 0016 so that no unaudited route exists.';

-- Ownership and grants, the same dance 0002 and 0013 do: CREATE on the schema
-- for the transfer, taken straight back so a SECURITY DEFINER function running
-- as this role cannot add objects to `public`.
grant create on schema public to javelin_privileged;
alter function public.remove_review(uuid, text) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.remove_review(uuid, text) from public;
-- `authenticated` only — never `anon`. The function checks `is_admin()` itself,
-- so this grant is not the boundary, but there is no reason to let an
-- anonymous caller reach a function that can only ever refuse them.
grant execute on function public.remove_review(uuid, text) to authenticated;
