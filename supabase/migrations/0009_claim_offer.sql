-- ===========================================================================
-- 0009_claim_offer.sql — the first way an order can come into existence.
-- ===========================================================================
--
-- Until now `orders` had rows only from `seed.sql`, and `docs/DATA-LAYER.md`
-- said so plainly: "No purchase path. There is no `createOrder`, and the SQL
-- grants no client INSERT on `orders` — a client-supplied
-- `price_cents_at_purchase` is not something that should ever be insertable.
-- A real checkout gets its own RPC." This is that RPC.
--
-- IT IS FREE, AND THAT IS A DECISION RATHER THAN A STUB. The next milestone is
-- an invite-only pilot with a handful of real coaches, so the thing worth
-- proving is that an offer can be claimed, delivered and reviewed — not that a
-- card can be charged. Stripe, payouts, refunds and the legal pages they
-- require are a separate and much larger build, and none of them changes the
-- shape of this function: when money arrives it gates the INSERT, it does not
-- move it.
--
-- WHAT IS DELIBERATELY NOT HERE YET, so its absence is not mistaken for an
-- oversight:
--
--   * No `fulfilment` column on listings, and no `status` on orders. The
--     product decision is "instant download OR personalised, chosen per offer",
--     and both of those are about DELIVERING A FILE — which does not exist yet.
--     A mode column that changes no behaviour, and an order state machine with
--     one state, would be schema written against a guess. They land with the
--     delivery bucket, where they have consequences.
--   * No price. `price_cents_at_purchase` is still recorded, still copied from
--     the listing, and still never supplied by the caller — so the day claiming
--     costs money, the row already has the column the receipt needs.

-- The privileged role owns the RPC below and therefore needs to reach the
-- table. SELECT as well as INSERT: the duplicate check reads `orders` before
-- writing to it. There is still NO client INSERT policy on `orders`, and none
-- should ever be added — this function is the only way in.
grant select, insert on public.orders to javelin_privileged;

-- ---------------------------------------------------------------------------
-- public.claim_offer(uuid)
--
-- Everything that matters about an order is DERIVED here and nothing is
-- accepted from the caller except which offer they mean:
--
--   learner_id               public.jwt_uid()  — the caller, from the JWT
--   coach_id                 the listing's, so a claim cannot be attributed
--                            to the wrong coach
--   price_cents_at_purchase  the listing's CURRENT price
--   price_epoch              the listing's CURRENT epoch, so the review this
--                            order later permits lands in the right epoch and
--                            the offer's public rating stays honest
--
-- `public.jwt_uid()` and NOT `auth.uid()`. This function is owned by
-- `javelin_privileged`, and a SECURITY DEFINER function resolves names as its
-- owner — which has no privileges in the `auth` schema and cannot be granted
-- any, as 0004 and 0005 established the hard way. Using `auth.uid()` here would
-- compile, deploy, and then fail on its first line with
-- `42501 permission denied for schema auth`.
-- ---------------------------------------------------------------------------
create or replace function public.claim_offer(p_listing_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := public.jwt_uid();
  v_listing public.listings;
  v_order   public.orders;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to claim an offer.' using errcode = '42501';
  end if;

  if p_listing_id is null then
    raise exception 'That offer could not be found.' using errcode = 'P0002';
  end if;

  select * into v_listing from public.listings where id = p_listing_id;
  if not found then
    raise exception 'That offer could not be found.' using errcode = 'P0002';
  end if;

  -- A withdrawn offer is not claimable, and the message says "no longer"
  -- rather than "not found" because a buyer may well be holding a link that
  -- worked yesterday. This is not an information leak: the offer was public
  -- until it was withdrawn.
  if v_listing.deleted_at is not null then
    raise exception 'That offer is no longer available.' using errcode = '22023';
  end if;

  -- A coach claiming their own offer would give them a review they are then
  -- forbidden to write (reviews_insert_own_purchase refuses the listing's own
  -- coach) and a sale on their own stats. Refused at the source.
  if v_listing.coach_id = v_user_id then
    raise exception 'You cannot claim your own offer.' using errcode = '42501';
  end if;

  -- ONE CLAIM PER LEARNER PER OFFER, while claiming is free. Nothing stops a
  -- second one being meaningful once it costs money — a repeat purchase is a
  -- real thing — so this is enforced HERE rather than as a unique index, and
  -- relaxing it later is an edit to this function instead of a constraint drop
  -- against a live table. It is still a database-level guarantee: no client
  -- role holds INSERT on `orders`, so this function is the only way a row
  -- appears.
  if exists (
    select 1 from public.orders o
     where o.learner_id = v_user_id
       and o.listing_id = v_listing.id
  ) then
    raise exception 'You have already claimed this offer.' using errcode = '23505';
  end if;

  insert into public.orders (learner_id, listing_id, coach_id, price_cents_at_purchase, price_epoch)
  values (v_user_id, v_listing.id, v_listing.coach_id, v_listing.price_cents, v_listing.price_epoch)
  returning * into v_order;

  return v_order;
end;
$$;

comment on function public.claim_offer(uuid) is
  'The only way an order is created. Derives learner from the JWT and coach, price and epoch from the listing, so nothing about the order is caller-supplied except which offer. Refuses a withdrawn offer, the coach''s own offer, and a second claim of the same offer by the same learner. Free while the pilot is free; when money lands it gates this INSERT rather than moving it.';

-- Ownership transfer needs CREATE on the schema for its duration — see the
-- note in 0002. Granted and handed straight back.
grant create on schema public to javelin_privileged;
alter function public.claim_offer(uuid) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.claim_offer(uuid) from public;
grant execute on function public.claim_offer(uuid) to authenticated;
