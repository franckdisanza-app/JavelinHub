import { notFound, redirect } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { loginPath } from '@/lib/auth/session';
import { isDataError, type DataError } from '@/lib/data/types';

/**
 * =============================================================================
 * The shared `DataError` surface for **Server Components**.
 * =============================================================================
 *
 * Server Actions have their own path — `toFormState()` in `@/lib/forms`, which
 * turns a `DataError` into inline form state. This module is the other half:
 * what a page does when a *read* fails.
 *
 * The mapping, and why:
 *
 * | code           | what happens here                                       |
 * |----------------|---------------------------------------------------------|
 * | `unauthorized` | `redirect()` to `/login?next=…` — they can fix this      |
 * | `not_found`    | `notFound()` — renders `app/not-found.tsx`               |
 * | `forbidden`    | returned, so the page can render `<DataErrorNotice>`     |
 * | `invalid`      | returned — but this belongs inline on a form, not here   |
 * | `conflict`     | returned — likewise                                      |
 *
 * `forbidden` is deliberately *not* a redirect. Bouncing a signed-in user to a
 * login page they are already past is the single most confusing thing an app
 * can do; they need to be told plainly that this account cannot see this thing.
 *
 * Usage:
 *
 *     let invites;
 *     try {
 *       invites = await db.listInvites(actor);
 *     } catch (error) {
 *       const dataError = resolveDataError(error, { nextPath: '/admin/invites' });
 *       return <DataErrorNotice error={dataError} />;
 *     }
 *
 * Note that `resolveDataError` rethrows anything that is not a `DataError`, so
 * a real bug still reaches `app/error.tsx` and the server log instead of being
 * disguised as a permissions message.
 */
export function resolveDataError(error: unknown, options?: { nextPath?: string }): DataError {
  if (!isDataError(error)) throw error;

  if (error.code === 'unauthorized') redirect(loginPath(options?.nextPath));
  if (error.code === 'not_found') notFound();

  return error;
}

/**
 * Renders a `DataError` that the page has decided to show rather than navigate
 * away from. `error.message` is written for end users and carries no ids, paths
 * or SQL, so it is safe verbatim — see `docs/DATA-LAYER.md`.
 */
export function DataErrorNotice({ error, className }: { error: DataError; className?: string }) {
  const forbidden = error.code === 'forbidden';
  return (
    <Alert tone="error" title={forbidden ? "You don't have access to this" : 'That did not work'} className={className}>
      {error.message}
    </Alert>
  );
}
