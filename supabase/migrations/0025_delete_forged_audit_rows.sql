-- ===========================================================================
-- 0025_delete_forged_audit_rows.sql — removing what the hole let in.
-- ===========================================================================
--
-- Two rows in `admin_actions` were written by an anonymous caller through the
-- gap `0024` closed. Both were written deliberately, by the probe that found it
-- (`scripts/probe-grants.mjs` and the assertion in `verify:supabase`), and both
-- are junk: `actor_id` is null, so `/admin/reports` renders them as
-- "Admin granted · a deleted account".
--
-- THE FIRST DELETE THIS SCHEMA HAS EVER PERFORMED ON AN AUDIT ROW, and it is
-- worth being uncomfortable about. `admin_actions` has no UPDATE or DELETE
-- policy for any role, on purpose — a log somebody can rewrite is not a log —
-- so this can only be done by a migration, which is exactly the property that
-- makes it acceptable: the deletion is itself in the record, with its reasoning,
-- reviewable in the same place as everything else.
--
-- The predicate is deliberately narrow: only the two rows the probe wrote, named
-- by every column that identifies them. A `where actor_id is null` on its own
-- would also match a genuine line whose administrator has since been deleted —
-- the FK is ON DELETE SET NULL — and destroying that is the precise failure this
-- table exists to prevent.

delete from public.admin_actions
 where actor_id is null
   and action = 'grant_admin'
   and subject_id = '00000000-0000-4000-8000-0000000000ff'
   and reason in ('probe', 'forged');
