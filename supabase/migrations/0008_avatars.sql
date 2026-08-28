-- ===========================================================================
-- 0008_avatars.sql — the first file storage in the project.
-- ===========================================================================
--
-- Avatars are deliberately the FIRST thing stored, and not because they are the
-- most valuable: they are the only asset in the product that depends on nothing
-- else. Offer delivery — the reason storage exists at all — attaches a file to
-- an ORDER, and there is no checkout yet, so it has nothing to hang off. An
-- avatar hangs off a profile, which exists. That makes this the cheapest place
-- to find out whether buckets, storage RLS, upload and public URLs behave the
-- way the delivery build will need them to.
--
-- WHAT WAS CHECKED BEFORE WRITING THIS, because it is not obvious and it
-- decided the whole approach: `storage.objects` and `storage.buckets` are owned
-- by `supabase_storage_admin`, `postgres` is NOT a member of that role, and RLS
-- is on with zero policies. By the rules that broke 0002 and 0004 that should
-- mean a migration cannot manage storage at all. It can — Supabase grants
-- `postgres` policy rights on `storage.objects` specifically so that storage
-- can be configured from SQL. Verified by creating a probe policy against the
-- live project, reading it back out of `pg_policies`, and dropping it again.
-- So none of this needs the dashboard.

-- ---------------------------------------------------------------------------
-- Where the file lives on the profile.
--
-- The PATH, not a URL. A URL bakes in the storage host, and the whole point of
-- keeping metadata in Postgres is that the backing store stays swappable — the
-- roadmap already expects video to go to Cloudflare R2 rather than here. The
-- client builds the URL from the path plus its configured Supabase origin.
--
-- Nullable, and null is the normal state: every account starts without one, and
-- `InitialsAvatar` renders initials in that case. Removing an avatar sets this
-- back to NULL, which is why "no avatar" must stay expressible.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists avatar_path text;

comment on column public.profiles.avatar_path is
  'Object path inside the public `avatars` bucket, e.g. `<uuid>/avatar.webp`. NOT a URL: the host is the client''s to supply, so the backing store stays swappable. NULL means no avatar, which is the normal state and renders as initials.';

alter table public.profiles
  drop constraint if exists profiles_avatar_path_shape;

-- The path is built by the app, but a Server Action is a public endpoint and
-- `avatar_path` is written through `profiles_update_own` like any other
-- self-service column. Pinning the shape here means a crafted request cannot
-- point somebody's avatar at an arbitrary object in the bucket: the first path
-- segment must be the owner's own id, which is the same rule the storage
-- policies below enforce on the file itself.
alter table public.profiles
  add constraint profiles_avatar_path_shape
  check (
    avatar_path is null
    or avatar_path like (id::text || '/%')
  );

-- ---------------------------------------------------------------------------
-- The bucket.
--
-- PUBLIC, deliberately. An avatar is rendered in a directory that anonymous
-- visitors browse, so "who may see this" is already "everyone" — a private
-- bucket would mean minting a signed URL per card per page load, adding expiry
-- to something that has no secret to protect and defeating CDN caching.
--
-- DELIVERY WILL NOT BE PUBLIC. When the offer-delivery bucket lands it is
-- private with signed URLs, because a training plan somebody paid for is
-- exactly the thing that must not be world-readable. Do not copy this line
-- across; copy the policies instead.
--
-- The limits are enforced HERE rather than in the form. Storage checks
-- `file_size_limit` and `allowed_mime_types` itself, so an upload posted
-- directly at the API — bypassing any client-side check — is refused by the
-- same rule. 2 MB is generous for an avatar and small enough that a hostile
-- upload is not a storage bill.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Storage RLS.
--
-- `storage.objects` has RLS enabled and — until this migration — NOT ONE
-- POLICY, which means every bucket is closed to every client role. The public
-- read path serves a public bucket without consulting these, but an upload
-- always does, so without the INSERT policy below nothing can ever be stored.
--
-- THE OWNERSHIP RULE, and it is the whole security model here:
--
--     (storage.foldername(name))[1] = auth.uid()::text
--
-- Every object lives under a folder named for its owner's user id, so a caller
-- may only write within their own folder. `auth.uid()` is read from the JWT and
-- cannot be set by the client, exactly as in the table policies. This is why
-- the path convention is `<uuid>/<file>` and not something friendlier: the
-- first segment IS the authorization.
--
-- Scoped to `bucket_id = 'avatars'` in every policy. A later bucket gets its
-- own; none of these widen to cover it by accident.
-- ---------------------------------------------------------------------------

drop policy if exists avatars_read_public on storage.objects;
create policy avatars_read_public
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'avatars');

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE covers the upsert case: replacing an avatar reuses the same object
-- name, so the second save is an update rather than an insert. Both USING and
-- WITH CHECK are pinned, so a row cannot be moved out of its owner's folder by
-- updating its name.
drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Removing an avatar is a real operation, not a soft delete: unlike a listing,
-- nothing references the file and nobody's history depends on it.
drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- Publish the path on the two public projections.
--
-- This WIDENS `public_profiles` and `public_coaches`, which 0002 and 0003
-- describe as exact projections — so it is a deliberate contract change, not a
-- drive-by. What it publishes is the path of an object in a PUBLIC bucket:
-- anyone who can see the card can already fetch the file, and the path reveals
-- only the owner's id, which both views already carry as `id`.
--
-- `create or replace view` appends, so existing columns keep their names,
-- types and positions and nothing that selects from these views changes shape.
-- ---------------------------------------------------------------------------
create or replace view public.public_profiles as
  select
    p.id,
    p.full_name,
    (p.coach_status = 'approved') as is_approved_coach,
    p.avatar_path
  from public.profiles p;

comment on view public.public_profiles is
  'Public projection of profiles: id, full_name, a derived is_approved_coach flag, and avatar_path. Deliberately excludes email, role and coach_status — publishing role to anon would enumerate every administrator. avatar_path points into the PUBLIC avatars bucket, so it discloses nothing the card does not already show. Runs as its owner and so bypasses profiles RLS; breaks if FORCE RLS is ever enabled on profiles.';

grant select on public.public_profiles to anon, authenticated;

create or replace view public.public_coaches as
  select
    p.id,
    p.full_name,
    p.coach_headline,
    p.coach_bio,
    p.coach_years_coaching,
    p.created_at,
    p.avatar_path
  from public.profiles p
  where p.coach_status = 'approved';

comment on view public.public_coaches is
  'Public coach directory: id, full_name, the three coach-authored columns, created_at (for ordering only) and avatar_path, for APPROVED coaches only. The where-clause lives in the view, so the row existing IS the approval and no caller-supplied predicate can widen it. Runs as its owner and so bypasses profiles RLS; breaks if FORCE RLS is ever enabled on profiles.';

grant select on public.public_coaches to anon, authenticated;
