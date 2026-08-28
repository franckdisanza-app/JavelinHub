create or replace function public.guard_listing_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_content_changed boolean;
  v_deleted_changed boolean;
begin
  if new.coach_id is distinct from old.coach_id then
    raise exception 'An offer cannot change owner.' using errcode = '42501';
  end if;

  v_content_changed :=
       new.title       is distinct from old.title
    or new.description is distinct from old.description
    or new.price_cents is distinct from old.price_cents
    or new.category    is distinct from old.category
    -- Added in 0011. Both are content: changing how an offer is delivered, or
    -- swapping the file it delivers, is an edit and must face the same
    -- owner-and-approved checks as retitling it.
    or new.fulfilment  is distinct from old.fulfilment
    or new.asset_path  is distinct from old.asset_path;

  v_deleted_changed := new.deleted_at is distinct from old.deleted_at;

  if v_content_changed and v_deleted_changed then
    raise exception 'Withdraw or restore an offer as its own action, not as part of an edit.'
      using errcode = '42501';
  end if;

  -- Rule 5. AN ADMIN TAKEDOWN MAY ONLY BE LIFTED BY AN ADMIN.
  --
  -- Both the owner and an admin may withdraw, so deleted_at alone cannot tell a
  -- coach's own withdrawal apart from a moderation action — and a takedown the
  -- coach reverses in one click is not a takedown. Checked here rather than in a
  -- policy because it is an OLD-row question: it is old.deleted_by that decides.
  --
  -- A NULL old.deleted_by is treated as unattributed and the owner may restore.
  -- Failing open on an audit column grants nothing an owner did not already
  -- have; failing closed would strand a row nobody could restore.
  if old.deleted_at is not null
     and new.deleted_at is null
     and old.deleted_by is not null
     and old.deleted_by <> auth.uid()
     and not public.is_admin()
     and session_user = 'authenticator'
  then
    raise exception 'An administrator removed this offer. Only an administrator can restore it.'
      using errcode = '42501';
  end if;

  -- ADDED IN 0011. The fulfilment mode is immutable once the offer has been
  -- claimed, by anybody.
  --
  -- Same reasoning as the price epoch archiving rather than rewriting: a buyer
  -- claimed a thing that was going to be delivered in a particular way, and
  -- flipping an offer from "personalised" to "instant download" afterwards
  -- retroactively changes what they were promised. Before the first claim
  -- there is nobody to mislead and the coach may change their mind freely.
  --
  -- Checked here rather than in a policy because it is a question about OTHER
  -- rows (does an order exist?), and because the answer has to be the same for
  -- an administrator.
  if new.fulfilment is distinct from old.fulfilment
     and exists (select 1 from public.orders o where o.listing_id = old.id) then
    raise exception 'How this offer is delivered cannot change once somebody has claimed it.'
      using errcode = '42501';
  end if;

  -- Rule 6. deleted_by is DERIVED, never client-supplied — same treatment as
  -- price_epoch below, and for the same reason: a column that decides an
  -- authorization outcome must not be writable by the party it constrains.
  -- Withdrawing stamps the actor; restoring clears it, so a published row never
  -- carries a stale attribution for the next restore to be judged against.
  if v_deleted_changed then
    if new.deleted_at is null then
      new.deleted_by := null;
    else
      new.deleted_by := auth.uid();
    end if;
  else
    new.deleted_by := old.deleted_by;
  end if;

  -- Rule 2. Skipped for a direct database connection (psql, the SQL editor, a
  -- migration), which is not what this guard is protecting against.
  if v_content_changed and session_user = 'authenticator' then
    if old.coach_id <> auth.uid() then
      raise exception 'Only the coach who published an offer can edit it.'
        using errcode = '42501';
    end if;
    if not public.is_approved_coach() then
      raise exception 'Only approved coaches can edit an offer.'
        using errcode = '42501';
    end if;
  end if;

  -- Rule 3. Unconditional: whatever the client sent in price_epoch is
  -- discarded and the value is recomputed from the price movement.
  new.price_epoch := old.price_epoch
    + (case when new.price_cents > old.price_cents then 1 else 0 end);

  return new;
end;
$$;
