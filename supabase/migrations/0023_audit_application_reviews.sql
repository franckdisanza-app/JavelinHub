-- ===========================================================================
-- 0023_audit_application_reviews.sql - the audit line 0019 reserved a name for.
-- ===========================================================================
--
-- `0019` created `admin_action_kind` with five members, and `review_application`
-- was one of them - but `review_coach_application()` predates that migration and
-- was never retrofitted, so the value existed and nothing ever wrote it.
--
-- That is not cosmetic. `/admin/reports` renders the log under the words "every
-- action any administrator has taken", and approving somebody as a coach is the
-- most consequential thing an administrator does here: it lets a stranger take
-- money from buyers. A log that silently omits it is worse than no log, because
-- the omission is invisible.
--
-- THE FUNCTION IS OTHERWISE BYTE-FOR-BYTE `0005`'s. Everything below except the
-- `perform` near the end is copied from `0005_privileged_uid.sql` unchanged -
-- deliberately, so a reader diffing the two sees one addition rather than having
-- to re-audit a re-typed body. `0005` is the live definition (it replaced
-- `0002`'s to swap `auth.uid()` for `public.jwt_uid()`; see `0004` for why that
-- role can never reach the `auth` schema).

create or replace function public.review_coach_application(
  p_application_id uuid,
  p_decision       public.application_status,
  p_note           text default null
)
returns public.coach_applications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id uuid := public.jwt_uid();
  v_app      public.coach_applications;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can review coach applications.'
      using errcode = '42501';
  end if;

  -- `is null` first: `null not in (...)` evaluates to NULL, so the IF would not
  -- fire and the UPDATE below would try to write a null status.
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'A review decision must be approved or rejected.'
      using errcode = '22023';
  end if;

  -- An admin must not review their own application: self-approval is the whole
  -- reason the review queue exists, and combined with promotion it is how an
  -- admin used to accidentally demote themselves.
  if exists (
    select 1 from public.coach_applications a
    where a.id = p_application_id and a.user_id = v_admin_id
  ) then
    raise exception 'You cannot review your own application.' using errcode = '42501';
  end if;

  -- `and status = 'pending'` makes double-review impossible under concurrency.
  update public.coach_applications a
     set status      = p_decision,
         review_note = p_note,
         reviewed_by = v_admin_id,
         reviewed_at = now()
   where a.id = p_application_id
     and a.status = 'pending'
  returning a.* into v_app;

  if v_app.id is null then
    if exists (select 1 from public.coach_applications a where a.id = p_application_id) then
      raise exception 'That application has already been reviewed.' using errcode = '23505';
    end if;
    raise exception 'Application not found.' using errcode = 'P0002';
  end if;

  -- Promotion raises privilege only; rejection never touches role at all.
  --
  -- The `coach_bio` assignment is THE ONE-TIME COPY, and it is the only place in
  -- this schema where text leaves `coach_applications` for anything public. It
  -- is a copy at approval and NOT a live join, because the application bio is a
  -- review artifact written for an administrator: a public profile that SELECTed
  -- it would republish the applicant's private text on every later edit, with no
  -- moment at which anybody decided to publish anything.
  --
  -- `coalesce(nullif(btrim(p.coach_bio), ''), v_app.bio)` is the "only when
  -- empty" rule: a coach who has since written their own bio (or been approved
  -- before) keeps it. `btrim` so a whitespace-only bio counts as empty, matching
  -- hasCoachBio() in mockClient.ts.
  --
  -- Only `bio` is copied. `experience` is prose written to a reviewer, `sport`
  -- is not a dimension in this product, and no integer can be recovered from
  -- free text — so coach_headline and coach_years_coaching stay NULL for the
  -- coach to fill in through policy profiles_update_own.
  update public.profiles p
     set coach_status = (case when p_decision = 'approved' then 'approved' else 'rejected' end)::public.coach_status,
         role = (case
                   when p_decision = 'approved' and p.role = 'learner' then 'coach'::public.user_role
                   else p.role
                 end),
         coach_bio = (case
                        when p_decision = 'approved'
                          then coalesce(nullif(btrim(p.coach_bio), ''), v_app.bio)
                        else p.coach_bio
                      end)
   where p.id = v_app.user_id;

  -- THE LINE THIS MIGRATION EXISTS FOR. Last, after every write, so the log
  -- never records a decision that then failed and rolled back. (It is one
  -- transaction either way, so this is about reading the function, not about
  -- correctness.)
  --
  -- The outcome first, then the reviewer's note when there is one — the same
  -- shape `resolve_report()` writes, so one column reads the same way for every
  -- kind of action.
  perform public.record_admin_action(
    'review_application',
    v_app.user_id,
    v_app.status::text || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), '')
  );

  return v_app;
end;
$$;

-- ---------------------------------------------------------------------------
-- Re-assert ownership. `create or replace` keeps the existing owner, so this is
-- belt and braces - but the INCOMING owner needs CREATE on the schema for the
-- duration of a transfer, and gets it back afterwards. See the note in `0002`.
-- ---------------------------------------------------------------------------
grant create on schema public to javelin_privileged;
alter function public.review_coach_application(uuid, public.application_status, text)
  owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.review_coach_application(uuid, public.application_status, text) from public;
grant execute on function public.review_coach_application(uuid, public.application_status, text) to authenticated;

comment on function public.review_coach_application(uuid, public.application_status, text) is
  'Approves or rejects a coach application and mirrors the decision onto the applicant profile, in one transaction. Writes an admin_actions row (0023). Refuses self-review and a second decision on an already-reviewed application.';
