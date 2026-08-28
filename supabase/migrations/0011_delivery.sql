-- ===========================================================================
-- 0011_delivery.sql — how a coach actually hands over what was claimed.
-- ===========================================================================
--
-- The gap this closes is the one `docs/ROADMAP.md` calls the gap that matters:
-- seven of the eight offer categories are a file or a document, and until now
-- there was no file anywhere in the product. A coach sold a video review and
-- had no way to return the video.
--
-- TWO DELIVERY SHAPES, chosen per offer, because the categories genuinely
-- divide:
--
--   instant        the coach attaches the file when publishing; claiming grants
--                  an immediate download. A ready-made training plan.
--   personalised   the coach uploads AFTER the claim, against that one order —
--                  and for a video review the LEARNER uploads first (their
--                  throw) and the coach returns an analysis.
--
-- They attach at different points, and that is why this is two mechanisms
-- rather than one with a flag: an instant file belongs to the LISTING and is
-- the same bytes for every buyer, while a personalised file belongs to the
-- ORDER and must never be visible to anyone else who bought the same offer.
--
-- BOTH BUCKETS ARE PRIVATE. Avatars (0008) are public because a directory is
-- browsed anonymously and the file has no secret to protect. A training plan
-- somebody claimed is the opposite: readable only by the people the order
-- names, through a signed URL. Do not copy the `public => true` line from 0008.

-- ---------------------------------------------------------------------------
-- 1. How an offer is delivered.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'fulfilment_mode') then
    create type public.fulfilment_mode as enum ('instant', 'personalised');
  end if;
end
$$;

-- `personalised` is the DEFAULT, and for existing rows it is also the only
-- honest answer: every offer published before this migration has no attached
-- file, so calling any of them an instant download would promise a download
-- that does not exist.
alter table public.listings
  add column if not exists fulfilment public.fulfilment_mode not null default 'personalised';

-- The instant download itself. A path into the private `offer-assets` bucket,
-- never a URL — the same rule as `profiles.avatar_path`, and here it matters
-- more, because the URL is signed and expires.
alter table public.listings add column if not exists asset_path text;

comment on column public.listings.fulfilment is
  'How this offer is delivered: instant (asset_path is downloaded on claim) or personalised (the coach uploads against each order). Immutable once the offer has been claimed - see guard_listing_update().';
comment on column public.listings.asset_path is
  'Object path in the PRIVATE offer-assets bucket, for instant offers only. Reachable through a signed URL by the coach and by anyone holding an order for this listing. NULL for personalised offers, enforced below.';

alter table public.listings drop constraint if exists listings_asset_path_shape;
alter table public.listings
  add constraint listings_asset_path_shape
  check (
    -- A personalised offer has nothing pre-attached: an asset there would be a
    -- file every buyer could fetch, which is the thing personalised delivery
    -- exists not to be.
    (fulfilment = 'personalised' and asset_path is null)
    -- An instant offer MAY be published before its file is attached; it simply
    -- cannot be claimed until it is (see claim_offer below). The path, when
    -- present, is pinned under the listing's own id exactly as an avatar is
    -- pinned under its owner's.
    or (fulfilment = 'instant' and (asset_path is null or asset_path like (id::text || '/%')))
  );

-- ---------------------------------------------------------------------------
-- 2. The guard, re-created with two additions. Everything else below is
--    0002's, extracted from that file rather than retyped so it cannot drift.
-- ---------------------------------------------------------------------------
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
  -- claimed a thing that was going to arrive in a particular way, and flipping
  -- an offer from personalised to instant afterwards retroactively changes what
  -- they were promised. Before the first claim there is nobody to mislead and
  -- the coach may change their mind freely.
  --
  -- Checked here rather than in a policy because it is a question about OTHER
  -- rows (does an order exist?), and because the answer must be the same for an
  -- administrator.
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


-- ---------------------------------------------------------------------------
-- 3. Personalised deliverables: files attached to ONE order.
--
-- `uploaded_by` carries the direction rather than a separate enum: compared
-- against the order's `learner_id` it is the buyer's input (their throw),
-- against `coach_id` it is the coach's delivery. Two ids already on the order
-- answer the question, so a third column would be one more thing to keep in
-- step.
--
-- No `status` column on `orders`. "Has this been delivered?" is answerable from
-- these rows — a coach-uploaded deliverable exists, or it does not — and a
-- denormalised flag beside it is one more thing that can disagree with the
-- truth. If a workflow later needs states this cannot express (accepted,
-- disputed, refunded), that is when it earns a column.
-- ---------------------------------------------------------------------------
create table if not exists public.deliverables (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id)   on delete cascade,
  -- Cascade, like reviews.author_id: a deleted account takes its uploads with
  -- it, and the storage object is cleaned up by the application.
  uploaded_by   uuid not null references public.profiles (id) on delete cascade,
  storage_path  text not null unique,
  file_name     text not null,
  content_type  text not null,
  size_bytes    bigint not null,
  created_at    timestamptz not null default now(),

  constraint deliverables_file_name_length check (char_length(file_name) between 1 and 260),
  constraint deliverables_size_positive    check (size_bytes > 0),
  -- Mirrors the bucket's own file_size_limit. Belt and braces: the bucket
  -- refuses the bytes, this refuses a row claiming a size the bucket would not
  -- have accepted.
  constraint deliverables_size_limit       check (size_bytes <= 52428800)
);

create index if not exists deliverables_order_created_idx
  on public.deliverables (order_id, created_at desc);

comment on table public.deliverables is
  'Files attached to one ORDER, for personalised offers. Direction is derived by comparing uploaded_by with the order learner_id (the buyer input) or coach_id (the coach delivery). Never visible to anyone but those two and an administrator.';

alter table public.deliverables enable row level security;

-- Both parties to the order, and nobody else. Note this is the ORDER's pair,
-- not "anyone who bought this offer": two learners who claimed the same
-- personalised offer cannot see each other's files.
drop policy if exists deliverables_select_party on public.deliverables;
create policy deliverables_select_party
  on public.deliverables for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.id = deliverables.order_id
         and (o.learner_id = auth.uid() or o.coach_id = auth.uid())
    )
  );

-- `uploaded_by = auth.uid()` pins authorship: a party to the order may add a
-- file, and only as themselves.
drop policy if exists deliverables_insert_party on public.deliverables;
create policy deliverables_insert_party
  on public.deliverables for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from public.orders o
       where o.id = deliverables.order_id
         and (o.learner_id = auth.uid() or o.coach_id = auth.uid())
    )
  );

-- Deleting your own upload is allowed — a learner who attached the wrong video
-- needs a way back. There is deliberately no UPDATE policy: a deliverable is a
-- record of what was handed over at a moment, and editing one in place would
-- rewrite that history the way an editable listing_revision would.
drop policy if exists deliverables_delete_own on public.deliverables;
create policy deliverables_delete_own
  on public.deliverables for delete to authenticated
  using (uploaded_by = auth.uid());

drop policy if exists deliverables_select_admin on public.deliverables;
create policy deliverables_select_admin
  on public.deliverables for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 4. Buckets. BOTH PRIVATE — see the header.
--
-- 50 MB and a deliberately wide type list: a training plan is a PDF, a video
-- review is an mp4 or a mov, and a coach may reasonably send a spreadsheet of
-- sessions. Anything not listed is refused by storage itself, so the form is
-- not the boundary.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('deliverables', 'deliverables', false, 52428800,
   array['application/pdf','image/png','image/jpeg','image/webp','video/mp4','video/quicktime',
         'text/plain','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  ('offer-assets', 'offer-assets', false, 52428800,
   array['application/pdf','image/png','image/jpeg','image/webp','video/mp4','video/quicktime',
         'text/plain','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 5. Storage policies.
--
-- The path IS the authorization, as it is for avatars — but the question is
-- harder here, because "may I read this?" depends on a row in `orders` rather
-- than on the object's own name.
--
--   deliverables   <order_id>/<uploader_id>/<file>
--                  segment 1 says which order, so the policy can look it up;
--                  segment 2 pins who wrote it.
--   offer-assets   <listing_id>/<file>
--                  segment 1 says which offer.
--
-- `storage.foldername(name)` is 1-indexed.
-- ---------------------------------------------------------------------------

drop policy if exists deliverables_read_party on storage.objects;
create policy deliverables_read_party
  on storage.objects for select to authenticated
  using (
    bucket_id = 'deliverables'
    and exists (
      select 1 from public.orders o
       where o.id::text = (storage.foldername(name))[1]
         and (o.learner_id = auth.uid() or o.coach_id = auth.uid())
    )
  );

drop policy if exists deliverables_write_party on storage.objects;
create policy deliverables_write_party
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'deliverables'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1 from public.orders o
       where o.id::text = (storage.foldername(name))[1]
         and (o.learner_id = auth.uid() or o.coach_id = auth.uid())
    )
  );

drop policy if exists deliverables_delete_own_object on storage.objects;
create policy deliverables_delete_own_object
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'deliverables'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- The instant asset. Written by the offer's coach; read by that coach and by
-- anyone holding an order for the listing — which is what makes it a download
-- somebody claimed rather than a public file.
drop policy if exists offer_assets_read_entitled on storage.objects;
create policy offer_assets_read_entitled
  on storage.objects for select to authenticated
  using (
    bucket_id = 'offer-assets'
    and exists (
      select 1 from public.listings l
       where l.id::text = (storage.foldername(name))[1]
         and (
           l.coach_id = auth.uid()
           or exists (
             select 1 from public.orders o
              where o.listing_id = l.id and o.learner_id = auth.uid()
           )
         )
    )
  );

drop policy if exists offer_assets_write_coach on storage.objects;
create policy offer_assets_write_coach
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'offer-assets'
    and exists (
      select 1 from public.listings l
       where l.id::text = (storage.foldername(name))[1] and l.coach_id = auth.uid()
    )
  );

drop policy if exists offer_assets_update_coach on storage.objects;
create policy offer_assets_update_coach
  on storage.objects for update to authenticated
  using (
    bucket_id = 'offer-assets'
    and exists (
      select 1 from public.listings l
       where l.id::text = (storage.foldername(name))[1] and l.coach_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'offer-assets'
    and exists (
      select 1 from public.listings l
       where l.id::text = (storage.foldername(name))[1] and l.coach_id = auth.uid()
    )
  );

drop policy if exists offer_assets_delete_coach on storage.objects;
create policy offer_assets_delete_coach
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'offer-assets'
    and exists (
      select 1 from public.listings l
       where l.id::text = (storage.foldername(name))[1] and l.coach_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 6. An instant offer with no file attached cannot be claimed.
--
-- Otherwise the one thing instant delivery promises — download it now — is a
-- promise the offer cannot keep, and the buyer only finds out after claiming.
-- Recreated in full because CREATE OR REPLACE FUNCTION cannot patch a body.
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

  if v_listing.deleted_at is not null then
    raise exception 'That offer is no longer available.' using errcode = '22023';
  end if;

  if v_listing.coach_id = v_user_id then
    raise exception 'You cannot claim your own offer.' using errcode = '42501';
  end if;

  -- ADDED IN 0011.
  if v_listing.fulfilment = 'instant' and v_listing.asset_path is null then
    raise exception 'This offer is not ready to be claimed yet.' using errcode = '22023';
  end if;

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

grant create on schema public to javelin_privileged;
alter function public.claim_offer(uuid) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.claim_offer(uuid) from public;
grant execute on function public.claim_offer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The public listing read gains ONE of the two new columns.
--
-- 0002 revokes table-level SELECT on `listings` and grants columns one by one,
-- so a new column is INVISIBLE to every client until it is named here — the
-- long note above that grant says exactly this, and it is why `deleted_by`
-- stays unreadable. `fulfilment` is public because a buyer should know how a
-- thing arrives before claiming it. `asset_path` is deliberately NOT granted:
-- the object is private, the path is the coach's business, and the download is
-- handed out as a signed URL by the application rather than discovered from a
-- column.
-- ---------------------------------------------------------------------------
grant select (fulfilment) on public.listings to anon, authenticated;
