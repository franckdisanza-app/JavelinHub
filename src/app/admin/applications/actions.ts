'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { parseFilter } from '@/app/admin/applications/filters';
import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { isDataError } from '@/lib/data/types';
import { formError, type FormState } from '@/lib/forms';

const ADMIN_APPLICATIONS_PATH = '/admin/applications';

/**
 * Records one admin decision.
 *
 * Like every Server Action this is a plain HTTP endpoint and is reachable by a
 * direct POST, so it does not lean on the page's `requireAdmin()` having run.
 * `reviewCoachApplication` resolves the caller's role from the store and throws
 * on its own for all four failure modes this page can hit:
 *
 *   unauthorized  the session is gone           -> back to /login
 *   not_found     the id does not exist         -> rendered in the submitting row
 *   conflict      already reviewed (a double    -> rendered in the submitting row
 *                 submit, or two admins racing)
 *   forbidden     see below — depends on the submit path
 *
 * `forbidden` deserves the caveat. It arises two ways:
 *
 *   - Not an admin. What the caller sees depends on how they submitted, and
 *     both paths were measured rather than assumed:
 *       * With JavaScript (the normal path) the action result is returned on
 *         its own — HTTP 200, no re-render — so "Only an administrator can do
 *         that." DOES render in the row. This is the common case, and an
 *         earlier version of this comment denied it.
 *       * Without JavaScript, the document POST re-renders the page, where
 *         `requireAdmin()` calls `notFound()`, and the caller gets a 404
 *         instead — the message is never displayed.
 *   - Reviewing one's own application. The page deliberately renders no
 *     `ReviewForm` for that row, so there is no component to hold the state;
 *     unreachable through the UI. A hand-crafted POST lands the message on
 *     whichever form's action key was submitted — i.e. someone else's row.
 *
 * Neither is a security gap: the refusal itself is enforced in the data layer
 * and the store is never modified. `DataError.message` is written for end users
 * and is rendered verbatim wherever it does surface, and none of these reach
 * `error.tsx`.
 */
export async function reviewApplicationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const applicationId = String(formData.get('applicationId') ?? '').trim();
  const decision = String(formData.get('decision') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  const filter = parseFilter(String(formData.get('status') ?? ''));

  // Every failure path carries `note` back, or an admin who typed a long
  // rejection and tripped a validation error would lose it on re-render.
  if (applicationId === '') return formError('No application was submitted.', { note });
  if (decision !== 'approved' && decision !== 'rejected') {
    return formError('Choose either Approve or Reject.', { note });
  }

  const actor = await getActor();

  let needsLogin = false;
  try {
    await getDataClient().reviewCoachApplication(actor, applicationId, decision, note === '' ? undefined : note);
  } catch (error) {
    if (!isDataError(error)) throw error;
    // Deferred: `redirect()` throws and must not be thrown from inside a catch.
    if (error.code === 'unauthorized') needsLogin = true;
    else return formError(error.message, { note });
  }

  if (needsLogin) redirect(loginPath(ADMIN_APPLICATIONS_PATH));

  revalidatePath(ADMIN_APPLICATIONS_PATH);

  // The decided row leaves the pending queue, which unmounts the component
  // holding this action's state and would take a returned success message with
  // it. The outcome travels in the URL instead, and the page re-reads the
  // application from the store to say what actually happened — so pasting this
  // query string by hand cannot make the page claim a decision that was never
  // recorded.
  redirect(`${ADMIN_APPLICATIONS_PATH}?status=${filter}&reviewed=${encodeURIComponent(applicationId)}`);
}
