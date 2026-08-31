-- ===========================================================================
-- 0021_coach_status_suspended.sql — one value, and nothing else in this file.
-- ===========================================================================
--
-- `docs/ROADMAP.md` §7: *"No way to suspend or demote a coach through the app.
-- `coach_status` can go to `rejected` only through application review."* So an
-- approved coach who then misbehaves cannot be stopped: the listing takedown
-- exists, the account-level equivalent does not.
--
-- THIS MIGRATION ADDS THE ENUM VALUE AND USES NONE OF IT, and that is not
-- fastidiousness — it is the constraint:
--
--     ALTER TYPE ... ADD VALUE cannot be used in the same transaction that
--     added it.
--
-- `supabase db push` runs each migration file in a transaction, so a single file
-- that added `'suspended'` and then wrote a function mentioning it would fail on
-- the function. `0022` is that function.
--
-- It is the same shape as the 0013/0014 lesson — a migration that needed a
-- follow-up — except this time the split is planned rather than discovered, and
-- the follow-up is a feature rather than a fix.
--
-- WHY A NEW VALUE RATHER THAN REUSING `rejected`. `rejected` means "an
-- administrator read your application and said no", and it is what
-- `/coach/apply` renders a re-application prompt for. Suspension is the opposite
-- situation — somebody who WAS approved and is now stopped — and collapsing the
-- two would tell a suspended coach their application was rejected and invite
-- them to file another.

alter type public.coach_status add value if not exists 'suspended';

comment on type public.coach_status is
  'none | pending_review | approved | rejected | suspended. `rejected` is an application decision; `suspended` is an administrator stopping somebody who was already approved. Only `approved` satisfies is_approved_coach(), so a suspended coach cannot publish or edit.';
