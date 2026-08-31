-- ===========================================================================
-- 0020_reports.sql — the queue `/admin/reviews` was pretending to be.
-- ===========================================================================
--
-- `0016` shipped review moderation and its own note recorded what was missing:
-- *"reviews cannot be REPORTED, so the queue is every review on the site rather
-- than a queue."* An administrator scrolling the whole corpus looking for
-- something wrong is not moderation, it is reading.
--
-- TWO SUBJECTS IN ONE TABLE, because there is one queue:
--
--   review   reported by the COACH whose offer it is about. They are the person
--            who reads it first and the person it damages.
--   coach    reported by anybody signed in — a buyer who was scammed, or who was
--            asked to pay outside the product. The counterpart to the above:
--            without it the only reportable thing on the site is criticism OF a
--            coach, which is a moderation system that only protects sellers.
--
-- One table rather than two, because the alternative is two queues, two status
-- machines and two resolve paths that will drift. A discriminator plus a CHECK
-- keeps the shape honest.
--
-- NEITHER SUBJECT COLUMN IS A FOREIGN KEY, and that is deliberate for the same
-- reason `removed_reviews.review_id` is not: upholding a review report DELETES
-- the review, and a report that a cascade removes at the moment it is acted on
-- is a report nobody can audit. The CHECK below is what keeps the pair
-- consistent instead.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'report_subject') then
    create type public.report_subject as enum ('review', 'coach');
  end if;

  if not exists (select 1 from pg_type where typname = 'report_status') then
    create type public.report_status as enum ('open', 'upheld', 'dismissed');
  end if;

  if not exists (select 1 from pg_type where typname = 'report_reason') then
    -- A CLOSED LIST, for the same reason the offer taxonomy is one: free text
    -- cannot be filtered, counted, or triaged, and two spellings of "spam" are
    -- two categories. `other` carries the note.
    create type public.report_reason as enum (
      'spam',
      'abusive',
      'off_topic',
      'not_a_real_purchase',
      'scam',
      'impersonation',
      'other'
    );
  end if;
end
$$;

create table if not exists public.reports (
  id                uuid primary key default gen_random_uuid(),
  subject_type      public.report_subject not null,
  -- Not foreign keys. See the header.
  subject_review_id uuid,
  subject_coach_id  uuid,

  reporter_id       uuid not null references public.profiles (id) on delete cascade,
  reason            public.report_reason not null,
  note              text,

  status            public.report_status not null default 'open',
  resolved_by       uuid references public.profiles (id) on delete set null,
  resolved_at       timestamptz,
  resolution_note   text,
  created_at        timestamptz not null default now(),

  constraint reports_note_length check (note is null or char_length(note) <= 2000),
  constraint reports_resolution_length check (resolution_note is null or char_length(resolution_note) <= 2000),

  -- EXACTLY ONE SUBJECT, matching the discriminator. Without this a row could
  -- name a review and a coach at once, or neither, and every reader would need
  -- to handle a shape the product has no meaning for.
  constraint reports_subject_shape check (
    (subject_type = 'review' and subject_review_id is not null and subject_coach_id is null)
    or (subject_type = 'coach' and subject_coach_id is not null and subject_review_id is null)
  ),

  -- A resolution is all-or-nothing: resolved rows name who and when, open rows
  -- name neither. The alternative is a row that is `upheld` by nobody at no
  -- time, which reads as an accident and cannot be audited.
  constraint reports_resolution_shape check (
    (status = 'open' and resolved_at is null and resolved_by is null)
    or (status <> 'open' and resolved_at is not null)
  )
);

create index if not exists reports_open_idx on public.reports (created_at desc) where status = 'open';
create index if not exists reports_subject_review_idx on public.reports (subject_review_id);
create index if not exists reports_subject_coach_idx on public.reports (subject_coach_id);
create index if not exists reports_reporter_idx on public.reports (reporter_id);

-- ONE OPEN REPORT PER PERSON PER SUBJECT, not one ever.
--
-- The difference matters in both directions. Capping it at one ever would mean a
-- coach who reported a review, saw it dismissed, and then watched the same
-- reviewer escalate has no way to say so. Not capping it at all makes the queue
-- trivially floodable by one person with one grievance.
--
-- Partial on `status = 'open'`, so a resolved report never blocks a new one.
create unique index if not exists reports_one_open_per_review
  on public.reports (reporter_id, subject_review_id) where status = 'open' and subject_review_id is not null;
create unique index if not exists reports_one_open_per_coach
  on public.reports (reporter_id, subject_coach_id) where status = 'open' and subject_coach_id is not null;

comment on table public.reports is
  'Moderation queue. Two subjects, one queue: a coach reports a review on their own offer, anybody reports a coach. Neither subject column is a foreign key - upholding a review report deletes the review, and a report a cascade removes at the moment it is acted on cannot be audited.';

alter table public.reports enable row level security;

-- A reporter reads their own, so "did anything happen about that?" is
-- answerable without asking an administrator.
drop policy if exists reports_select_own on public.reports;
create policy reports_select_own
  on public.reports for select to authenticated
  using (reporter_id = auth.uid());

drop policy if exists reports_select_admin on public.reports;
create policy reports_select_admin
  on public.reports for select to authenticated
  using (public.is_admin());

-- NO INSERT OR UPDATE POLICY FOR ANY CLIENT ROLE. Filing goes through
-- `report_review()` / `report_coach()`, which check that the reporter is
-- entitled to file about THAT subject; resolving goes through
-- `resolve_report()`, which writes the audit row. A direct INSERT would let
-- anybody file a report as somebody else, or file a review report about an offer
-- that is not theirs.
drop policy if exists reports_privileged on public.reports;
create policy reports_privileged
  on public.reports for all to javelin_privileged
  using (true) with check (true);

revoke all on public.reports from anon;
grant select on public.reports to authenticated;
grant select, insert, update on public.reports to javelin_privileged;

-- ---------------------------------------------------------------------------
-- report_review(review_id, reason, note)
--
-- THE COACH WHOSE OFFER IT IS ABOUT, and nobody else. Not the buyer who wrote
-- it — an author reporting their own review is not a thing — and not a passing
-- visitor, which would make the queue a voting mechanism on other people's
-- opinions.
-- ---------------------------------------------------------------------------
create or replace function public.report_review(
  p_review_id uuid,
  p_reason public.report_reason,
  p_note text default null
)
returns public.reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := public.jwt_uid();
  v_report  public.reports;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to report a review.' using errcode = '42501';
  end if;

  -- The entitlement, and it is a join rather than a column: a coach may report a
  -- review only about an offer they own. Checked against `listings.coach_id`
  -- rather than against the review, because the review carries no coach id.
  if not exists (
    select 1
      from public.reviews r
      join public.listings l on l.id = r.listing_id
     where r.id = p_review_id and l.coach_id = v_user_id
  ) then
    -- ONE MESSAGE for "no such review" and "not your offer". Telling them apart
    -- would let somebody probe which review ids exist, and a review id is
    -- otherwise never published — `PublicReview` carries no order_id and the id
    -- is not rendered anywhere a stranger reads.
    raise exception 'That review could not be found.' using errcode = 'P0002';
  end if;

  insert into public.reports (subject_type, subject_review_id, reporter_id, reason, note)
  values ('review', p_review_id, v_user_id, p_reason, nullif(btrim(coalesce(p_note, '')), ''))
  returning * into v_report;

  return v_report;
exception
  when unique_violation then
    -- The partial unique index. A second open report from the same coach about
    -- the same review is not an error worth a stack trace.
    raise exception 'You have already reported this review.' using errcode = '23505';
end;
$$;

-- ---------------------------------------------------------------------------
-- report_coach(coach_id, reason, note)
--
-- ANYBODY SIGNED IN, and that asymmetry with the above is deliberate. A review
-- report is about a specific piece of text on a specific offer, so the owner is
-- the natural reporter. A coach report is about conduct — being asked to pay
-- outside the product, being sold something that never arrived — and the person
-- who experiences that is whoever they did it to.
--
-- Signed in, though, not anonymous: a report with no accountable author is a
-- report that costs nothing to file, and the rate limiter cannot key on anybody.
-- ---------------------------------------------------------------------------
create or replace function public.report_coach(
  p_coach_id uuid,
  p_reason public.report_reason,
  p_note text default null
)
returns public.reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := public.jwt_uid();
  v_report  public.reports;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to report a coach.' using errcode = '42501';
  end if;

  if p_coach_id = v_user_id then
    raise exception 'You cannot report yourself.' using errcode = '42501';
  end if;

  -- The subject must be a real coach. `coach_status = 'approved'` rather than
  -- merely existing: reporting a learner is not a thing this queue can act on,
  -- since every action an administrator can take here is about selling.
  if not exists (
    select 1 from public.profiles p
     where p.id = p_coach_id and p.coach_status = 'approved' and p.deleted_at is null
  ) then
    raise exception 'That coach could not be found.' using errcode = 'P0002';
  end if;

  insert into public.reports (subject_type, subject_coach_id, reporter_id, reason, note)
  values ('coach', p_coach_id, v_user_id, p_reason, nullif(btrim(coalesce(p_note, '')), ''))
  returning * into v_report;

  return v_report;
exception
  when unique_violation then
    raise exception 'You have already reported this coach.' using errcode = '23505';
end;
$$;

-- ---------------------------------------------------------------------------
-- resolve_report(report_id, status, note)
--
-- Marks a report handled. It does NOT perform the action — removing the review
-- is `remove_review()`, suspending the coach is `set_coach_status()` — because
-- an administrator upholding a report has decided the report was right, which is
-- not the same decision as what to do about it. Keeping them separate means a
-- report can be upheld and acted on twice, or upheld and left, and the log
-- records each independently.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_report(
  p_report_id uuid,
  p_status public.report_status,
  p_note text default null
)
returns public.reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report public.reports;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can resolve a report.' using errcode = '42501';
  end if;

  if p_status is null or p_status = 'open' then
    raise exception 'A report is resolved as upheld or dismissed.' using errcode = '22023';
  end if;

  -- `and status = 'open'` makes double-resolution impossible under concurrency,
  -- the same construction `review_coach_application` uses.
  update public.reports r
     set status          = p_status,
         resolved_by     = public.jwt_uid(),
         resolved_at     = now(),
         resolution_note = nullif(btrim(coalesce(p_note, '')), '')
   where r.id = p_report_id
     and r.status = 'open'
  returning r.* into v_report;

  if v_report.id is null then
    if exists (select 1 from public.reports r where r.id = p_report_id) then
      raise exception 'That report has already been resolved.' using errcode = '23505';
    end if;
    raise exception 'That report could not be found.' using errcode = 'P0002';
  end if;

  perform public.record_admin_action('resolve_report', v_report.id, p_status::text);

  return v_report;
end;
$$;

comment on function public.resolve_report(uuid, public.report_status, text) is
  'Marks a report upheld or dismissed and writes an admin_actions row. Does NOT perform the consequence - removing a review and suspending a coach are separate calls, because deciding a report was right is not the same decision as what to do about it.';

grant create on schema public to javelin_privileged;
alter function public.report_review(uuid, public.report_reason, text)              owner to javelin_privileged;
alter function public.report_coach(uuid, public.report_reason, text)               owner to javelin_privileged;
alter function public.resolve_report(uuid, public.report_status, text)             owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.report_review(uuid, public.report_reason, text) from public;
revoke all on function public.report_coach(uuid, public.report_reason, text) from public;
revoke all on function public.resolve_report(uuid, public.report_status, text) from public;

grant execute on function public.report_review(uuid, public.report_reason, text) to authenticated;
grant execute on function public.report_coach(uuid, public.report_reason, text) to authenticated;
grant execute on function public.resolve_report(uuid, public.report_status, text) to authenticated;

-- ---------------------------------------------------------------------------
-- And `remove_review()` gains its audit line, recreated in full because
-- CREATE OR REPLACE cannot patch a body.
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

  -- ADDED IN 0020. `removed_reviews` keeps the CONTENT; this keeps the FACT, in
  -- the same place as every other administrator action, so one query answers
  -- "what has this administrator done" across all of them.
  perform public.record_admin_action('remove_review', v_review.id, p_reason);
end;
$$;

grant create on schema public to javelin_privileged;
alter function public.remove_review(uuid, text) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;
revoke all on function public.remove_review(uuid, text) from public;
grant execute on function public.remove_review(uuid, text) to authenticated;
