-- ===========================================================================
-- demo-teardown.sql — remove everything demo-seed.sql put in.
-- ===========================================================================
--
--     npx supabase db query --linked -f supabase/demo-teardown.sql
--
-- DELETES ON THE FLAG, not on a list of ids. `is_demo` (0006, extended by 0027)
-- is the whole mechanism: the seed labels every row it writes, and this removes
-- exactly what carries the label. Neither file has to remember what the other
-- did, and a row added to the seed later is covered here for free.
--
-- THE ORDER IS THE FOREIGN KEYS. Reports first, because a report names a review
-- without referencing it — deliberately, so that upholding one and deleting the
-- review does not take the report with it — which also means nothing would clean
-- them up on its own. Then reviews, then orders, then listings, then the
-- accounts. `auth.users` last, and it cascades to `profiles`.
--
-- WHAT IT DOES NOT TOUCH: anything with `is_demo = false`. The four leftover
-- `@javelinhub-verify.test` accounts from earlier write-tier runs are NOT
-- flagged and are not removed here — they predate this mechanism, and guessing
-- at them by email pattern is exactly the "we will remember" that the flag
-- exists to replace. Delete them by hand if you want them gone.

begin;

delete from public.reports          where is_demo;
delete from public.removed_reviews  where is_demo;
delete from public.deliverables     where is_demo;
-- Before the reviews they hang off. `review_replies.review_id` is
-- `on delete cascade`, so the next statement would take them anyway — this is
-- here because every other table in this file is deleted on the flag
-- explicitly, and a reader should not have to know the cascade to believe the
-- list is complete. Added in 0032, which is also when the table joined
-- `demo_data_summary`.
delete from public.review_replies   where is_demo;
delete from public.reviews          where is_demo;
delete from public.orders           where is_demo;
delete from public.listings         where is_demo;
delete from public.coach_applications where is_demo;
delete from public.invites          where is_demo;

-- The audit rows the seed caused. `admin_actions` has no `is_demo` — 0027 says
-- why — so this deletes the lines whose ACTOR or SUBJECT was a demo account,
-- which is the same set. The `grant_admin` line from bootstrapping the demo
-- administrator has a null actor and a demo subject, so the second predicate is
-- what catches it.
delete from public.admin_actions
 where actor_id   in (select id from public.profiles where is_demo)
    or subject_id in (select id from public.profiles where is_demo);

-- Cascades to `public.profiles`, which is `references auth.users(id) on delete
-- cascade`. Deleting the profile first would leave an orphan able to sign in.
delete from auth.users
 where id in (select id from public.profiles where is_demo);

commit;

-- Should come back empty.
select * from public.demo_data_summary where rows > 0;
