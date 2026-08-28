-- ===========================================================================
-- 0007_demo_summary_revoke.sql — actually make demo_data_summary private.
-- ===========================================================================
--
-- 0006 created `public.demo_data_summary` and its comment claimed it was
-- "ungranted: readable only with direct database access". That was WRONG, and
-- checking it against the live project with the publishable key is what caught
-- it: the view returned its rows to `anon` quite happily.
--
-- The reason is the trap 0002_rls.sql already documents for `listings`, in the
-- long note above its column grant: **Supabase grants privileges on objects in
-- `public` to anon and authenticated by default.** Creating an object and
-- simply not writing `grant select` does not make it private — the default
-- privileges have already done it for you. Privacy in this schema is something
-- you REVOKE, never something you decline to grant.
--
-- What leaked was small — six table names and six counts, all zero at the time
-- — but the gap between what a comment claimed and what the database did is not
-- small, and it is exactly the kind of thing the rest of this schema is careful
-- about. Fixed forward rather than by editing 0006, which is already applied.

revoke all on public.demo_data_summary from anon, authenticated;

comment on view public.demo_data_summary is
  'Counts of fabricated rows per table. REVOKED from anon and authenticated (see 0007) — readable only with direct database access, because it is a pre-launch check rather than something the app shows. `select * from public.demo_data_summary where rows > 0;`';

-- The same default-grant reasoning applied to the other views this project
-- added, with a different conclusion in each case — stated here so the next
-- person does not have to re-derive it:
--
--   public_listing_reviews   PUBLIC BY DESIGN. It is the offer page's review
--   public_coach_reviews     list. The default grant is what 0003 wanted, and
--                            0003 also states it explicitly.
--
--   owned_listings           Safe WITHOUT a grant change, and not by accident:
--                            its `where l.coach_id = auth.uid()` is inside the
--                            view, so an anonymous caller matches no row and
--                            gets an empty set rather than a refusal. The
--                            predicate is the boundary, exactly as 0003 says.
--                            Revoking from `anon` as well would be belt and
--                            braces; it is left alone so that the security
--                            property stays where the comment says it is,
--                            rather than being split across two mechanisms.
