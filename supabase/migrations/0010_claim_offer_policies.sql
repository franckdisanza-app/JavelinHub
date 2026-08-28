-- ===========================================================================
-- 0010_claim_offer_policies.sql — let claim_offer() actually see its inputs.
-- ===========================================================================
--
-- 0009 granted `select, insert on public.orders to javelin_privileged` and
-- stopped there. That is only half of what this schema requires, and the other
-- half is the half that matters: **a GRANT is table privilege, RLS is a
-- separate gate, and `javelin_privileged` is not the owner of these tables so
-- RLS applies to it too.**
--
-- The symptom was total and uniform, which is what made it worth writing down:
-- every call to `claim_offer` returned `That offer could not be found.` — the
-- coach's own offer, a real offer, an unknown id, all identical. The function
-- was not refusing anything. Its very first statement,
--
--     select * into v_listing from public.listings where id = p_listing_id;
--
-- matched no row, because no policy on `public.listings` names
-- `javelin_privileged` and RLS therefore returned the empty set. A read that
-- returns nothing looks exactly like a read that found nothing, so the
-- migration applied cleanly, the RPC ran cleanly, and the answer was wrong.
--
-- 0002 already established the idiom this needs — `profiles_privileged`,
-- `invites_privileged`, `coach_applications_privileged`,
-- `listing_revisions_privileged_*` — and `listings` and `orders` were simply
-- never in it, because until 0009 no privileged function touched them.
--
-- THE GENERAL RULE, for the next function that runs as this role: granting the
-- privilege is necessary and never sufficient. Check `pg_policies` too.

-- ---------------------------------------------------------------------------
-- listings: SELECT only.
--
-- Deliberately NOT `for all`. The privileged role has no business writing to
-- `listings` — `guard_listing_update()` is SECURITY INVOKER precisely so that
-- `current_user` identifies the real writer, and an ALL policy here would hand
-- this role a way past the owner checks that trigger enforces. `claim_offer`
-- needs to read a price and an epoch; that is all this grants.
--
-- No `deleted_at` predicate: the function checks withdrawal itself, and needs
-- to see a withdrawn row in order to say "no longer available" rather than
-- "not found". Those are different sentences and a buyer holding yesterday's
-- link deserves the accurate one.
-- ---------------------------------------------------------------------------
drop policy if exists listings_privileged_select on public.listings;
create policy listings_privileged_select
  on public.listings for select to javelin_privileged
  using (true);

-- ---------------------------------------------------------------------------
-- orders: SELECT and INSERT.
--
-- SELECT for the one-claim-per-learner check, INSERT for the row itself. Not
-- `for all`: nothing in the product updates or deletes an order, and an order
-- is the record that a review is allowed to exist — so the absence of an UPDATE
-- policy here is the same kind of guarantee as the absence of a DELETE policy
-- on `listings`.
--
-- There is still NO policy on `orders` for `anon` or `authenticated` INSERT,
-- and there must never be one: a client-supplied `price_cents_at_purchase` is
-- exactly what `docs/DATA-LAYER.md` refuses to make insertable, and
-- `claim_offer` derives it from the listing instead.
-- ---------------------------------------------------------------------------
drop policy if exists orders_privileged_select on public.orders;
create policy orders_privileged_select
  on public.orders for select to javelin_privileged
  using (true);

drop policy if exists orders_privileged_insert on public.orders;
create policy orders_privileged_insert
  on public.orders for insert to javelin_privileged
  with check (true);
