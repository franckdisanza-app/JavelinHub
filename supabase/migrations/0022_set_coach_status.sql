-- ===========================================================================
-- 0022_set_coach_status.sql — suspending and demoting, using 0021's value.
-- ===========================================================================
--
-- Separate from `0021` because `ALTER TYPE ... ADD VALUE` cannot be used in the
-- transaction that added it, and `supabase db push` wraps each file in one. The
-- split is the constraint, not a preference.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS FUNCTION DOES NOT DO, AND WHY IT REFUSES INSTEAD
-- -----------------------------------------------------------------------------
-- **It does not withdraw the suspended coach's offers**, for exactly the reason
-- `delete_my_account()` does not: `guard_listing_update()` is SECURITY INVOKER
-- and assigns `new.deleted_by := auth.uid()` on any change to `deleted_at`, and
-- inside a function owned by `javelin_privileged` that call is the dead end
-- `0004` records — no USAGE on the `auth` schema, ever.
--
-- So the application takes them down first, AS THE ADMINISTRATOR, through the
-- ordinary admin path where `auth.uid()` resolves. That has a useful side
-- effect: `deleted_by` ends up being the administrator, which is precisely the
-- state `owned_listings.withdrawn_by_admin` reports and `guard_listing_update()`
-- rule 5 protects — so a reinstated coach cannot quietly put them back on sale
-- themselves, and an administrator has to do it deliberately.
--
-- And this function REFUSES to suspend while any offer is still published, so
-- "suspended but still selling" is not a state that can exist however the caller
-- sequences their requests. Same invariant, same reasoning, as deletion.
--
-- -----------------------------------------------------------------------------
-- SUSPEND AND DEMOTE ARE ONE CALL
-- -----------------------------------------------------------------------------
-- They differ only in the target value, and both are "an administrator changed
-- somebody's standing":
--
--   suspended   was approved, is stopped, may be reinstated
--   none        demoted to an ordinary learner; the coach chapter is closed
--   approved    reinstated
--
-- `pending_review` and `rejected` are NOT reachable here: they belong to the
-- application flow and are written by `review_coach_application()`. Letting an
-- administrator hand-set them would produce a `pending_review` with no
-- application behind it, which every read of that status assumes cannot happen.

create or replace function public.set_coach_status(
  p_user_id uuid,
  p_status public.coach_status,
  p_reason text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id uuid := public.jwt_uid();
  v_profile  public.profiles;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change a coach''s standing.'
      using errcode = '42501';
  end if;

  if p_status is null or p_status not in ('approved', 'suspended', 'none') then
    raise exception 'A coach can be reinstated, suspended, or removed as a coach.'
      using errcode = '22023';
  end if;

  -- An administrator suspending themselves would lock the marketplace's own
  -- operator out of selling with no way back except another administrator. The
  -- same self-action rule `review_coach_application()` applies to its own queue.
  if p_user_id = v_admin_id then
    raise exception 'You cannot change your own standing.' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'That account could not be found.' using errcode = 'P0002';
  end if;

  if v_profile.deleted_at is not null then
    raise exception 'That account has been deleted.' using errcode = '22023';
  end if;

  -- THE INVARIANT. See the header: this function cannot withdraw offers itself,
  -- so it refuses to leave a stopped coach selling. Only for the two statuses
  -- that stop somebody — reinstating obviously does not need it.
  if p_status in ('suspended', 'none') and exists (
    select 1 from public.listings l where l.coach_id = p_user_id and l.deleted_at is null
  ) then
    raise exception 'Take their offers off sale first.' using errcode = '22023';
  end if;

  update public.profiles
     set coach_status = p_status,
         -- DEMOTION DROPS THE ROLE TOO, suspension does not. A suspended coach
         -- is still a coach whose selling is paused; `none` means the chapter is
         -- closed, and leaving `role = 'coach'` behind would be a title with
         -- nothing under it.
         --
         -- An ADMINISTRATOR's role is never touched — this function changes
         -- standing as a coach, and the two axes are independent. See
         -- `docs/DATA-LAYER.md`, "Becoming a coach only ever raises privilege".
         role = case
                  when v_profile.role = 'admin' then v_profile.role
                  when p_status = 'none' then 'learner'
                  when p_status = 'approved' then 'coach'
                  else v_profile.role
                end
   where id = p_user_id
  returning * into v_profile;

  perform public.record_admin_action(
    'set_coach_status',
    p_user_id,
    coalesce(nullif(btrim(coalesce(p_reason, '')), '') || ' — ', '') || p_status::text
  );

  return v_profile;
end;
$$;

comment on function public.set_coach_status(uuid, public.coach_status, text) is
  'Suspends, reinstates or demotes a coach, and writes an admin_actions row. Refuses while any of their offers is still on sale, because it cannot withdraw them itself - guard_listing_update() calls auth.uid(), unreachable to the role that owns this. Cannot set pending_review or rejected: those belong to the application flow.';

grant create on schema public to javelin_privileged;
alter function public.set_coach_status(uuid, public.coach_status, text) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.set_coach_status(uuid, public.coach_status, text) from public;
grant execute on function public.set_coach_status(uuid, public.coach_status, text) to authenticated;
