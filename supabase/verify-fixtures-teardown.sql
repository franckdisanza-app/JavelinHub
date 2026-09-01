-- ===========================================================================
-- verify-fixtures-teardown.sql — the accounts `demo-teardown.sql` cannot reach.
-- ===========================================================================
--
--     npx supabase db query --linked -f supabase/verify-fixtures-teardown.sql
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE EXISTS BESIDE THE OTHER ONE
-- ---------------------------------------------------------------------------
-- `demo-teardown.sql` deletes on `is_demo`, which is the right instrument and
-- covers everything `seed.sql` and `demo-seed.sql` create. It cannot cover
-- these: the four `@javelinhub-verify.test` accounts were created by the WRITE
-- TIERS of `npm run verify:supabase`, through the ordinary signup path, before
-- `is_demo` existed — and the ordinary signup path has no way to set a flag
-- that no client role may write. They carry `is_demo = false`, honestly.
--
-- `supabase/README.md` has warned about them for several rounds ("the four
-- @javelinhub-verify.test accounts predate the flag, carry is_demo = false, and
-- are not removed by it") and nothing removed them. One of them, **Verify
-- coach**, was a visible row in the public coach directory on the live site.
--
-- IT IS RE-RUNNABLE, and it needs to be: the write tiers mint fresh accounts on
-- every run, with a new random suffix each time. It deletes on the domain, not
-- on a list of ids.
--
-- ---------------------------------------------------------------------------
-- THE ORDER IS THE WHOLE POINT — DO NOT SIMPLIFY IT TO ONE DELETE
-- ---------------------------------------------------------------------------
-- `delete from auth.users` cascades `profiles`, and from there the graph forks
-- in two directions that disagree:
--
--     listings.coach_id     CASCADE      delete the coach, delete their offers
--     orders.listing_id     RESTRICT     …but an offer with a sale cannot go
--
-- The verify coach has one listing and one sale against it, so a single
-- cascading delete asks Postgres to remove a listing and an order in the same
-- statement, and whether it succeeds depends on which referential action it
-- processes first. That is not a thing to leave to chance against a production
-- database.
--
-- So the rows come out in dependency order, explicitly, and only then the
-- users. This is the same ordering constraint `delete_my_account()` runs into
-- from the other side — it REFUSES while a coach still has an offer on sale,
-- because it cannot withdraw one itself.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT DO: STORAGE
-- ---------------------------------------------------------------------------
-- Objects in `avatars`, `deliverables` and `offer-assets` are not reached by
-- any cascade — `supabase/README.md` records that as a standing property. If a
-- write tier ever uploaded one it survives this script as an orphan. Check the
-- three buckets for folders named after the ids printed at the end, and remove
-- them by hand.
-- ===========================================================================

begin;

-- The set, resolved once. Every statement below reads it.
create temporary table verify_fixture_ids on commit drop as
  select id from public.profiles where email like '%@javelinhub-verify.test';

-- Leaves first: nothing points at these.
delete from public.review_replies
 where coach_id in (select id from verify_fixture_ids);

delete from public.reports
 where reporter_id in (select id from verify_fixture_ids);

delete from public.reviews
 where author_id in (select id from verify_fixture_ids)
    or listing_id in (select id from public.listings
                       where coach_id in (select id from verify_fixture_ids));

-- `removed_reviews.listing_id` is RESTRICT, so an archived review of one of
-- these offers would block the listing delete below just as an order does.
delete from public.removed_reviews
 where listing_id in (select id from public.listings
                       where coach_id in (select id from verify_fixture_ids));

delete from public.deliverables
 where uploaded_by in (select id from verify_fixture_ids)
    or order_id in (select id from public.orders
                     where learner_id in (select id from verify_fixture_ids)
                        or coach_id   in (select id from verify_fixture_ids));

-- THE STATEMENT THAT UNBLOCKS THE NEXT ONE. `orders.listing_id` is RESTRICT;
-- until the orders are gone the listings cannot be.
delete from public.orders
 where learner_id in (select id from verify_fixture_ids)
    or coach_id   in (select id from verify_fixture_ids);

-- `listing_revisions.listing_id` is CASCADE, so this takes the history with it.
delete from public.listings
 where coach_id in (select id from verify_fixture_ids);

delete from public.coach_applications
 where user_id in (select id from verify_fixture_ids);

-- `invites.redeemed_by` is SET NULL and would resolve itself; done explicitly so
-- the redemption is cleared rather than half-cleared by a cascade nobody read.
-- `invites.created_by` is RESTRICT — if one of these accounts had ever minted a
-- code, the user delete below would fail loudly, which is the correct outcome:
-- an invite records who granted somebody coach status and must not lose that.
update public.invites
   set redeemed_by = null, redeemed_at = null
 where redeemed_by in (select id from verify_fixture_ids);

-- `admin_actions.actor_id` is SET NULL, so the audit log keeps the fact and
-- loses the name. `subject_id` is deliberately not a foreign key at all, so a
-- row naming one of these ids simply survives — which is right: an audit log
-- that forgets what it recorded is not an audit log.
delete from public.admin_actions
 where subject_id in (select id from verify_fixture_ids);

-- Last. Cascades `profiles`, which is what makes the account gone rather than
-- anonymised — these are fixtures, not people, so the argument for anonymising
-- (one person's departure must not rewrite another's history) does not apply.
delete from auth.users
 where id in (select id from verify_fixture_ids);

commit;

-- Should return zero rows.
select id, email, full_name
  from public.profiles
 where email like '%@javelinhub-verify.test';
