'use server';

import { revalidatePath } from 'next/cache';

import { getActor } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { CACHE_TAGS, invalidatePublicData } from '@/lib/data/cache-tags';
import { isDataError } from '@/lib/data/types';
import { formError, toFormState, type FormState } from '@/lib/forms';

/**
 * Takes a review down.
 *
 * A Server Action is a public HTTP endpoint, so this does not rely on the
 * page's `requireAdmin()` having run. `removeReview` resolves the actor and
 * refuses anyone who is not an admin, and behind it `remove_review()` in
 * Postgres re-checks `is_admin()` a third time. The gate on the page exists so
 * a non-admin sees a 404 rather than a form they cannot submit.
 *
 * NO CONFIRMATION STEP HERE, and that is a deliberate split rather than an
 * omission: the confirmation is in the browser, in `RemoveReviewForm`, because
 * this is destructive and unrecoverable through the product. The dialog is a
 * courtesy; the archive is what makes the action survivable, and it is written
 * by the database in the same transaction as the delete.
 */
export async function removeReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get('id') ?? '').trim();
  if (id === '') return formError('That review could not be found.');

  // Trimmed to null rather than sent as an empty string: the column is nullable
  // and "no reason given" is a different fact from "the reason is blank".
  const rawReason = String(formData.get('reason') ?? '').trim();
  const reason = rawReason === '' ? null : rawReason;

  if (rawReason.length > 1000) {
    return formError(`Keep the reason to 1000 characters or fewer — ${rawReason.length} so far.`);
  }

  try {
    await getDataClient().removeReview(await getActor(), id, reason);
  } catch (error) {
    if (!isDataError(error)) throw error;
    // No `fieldFor`: the form has one textarea and a hidden id, so every
    // message belongs at form level beside the button that failed.
    return toFormState(error);
  }

  /*
   * The review is gone from the offer's rating, the coach's rating, the offer
   * page, the coach profile and the browse cards — all of it, because the row
   * was deleted rather than flagged. So this is not confined to the admin page,
   * and `'/'` + `'layout'` is the blunt instrument that covers every surface
   * that was counting it.
   */
  // The row is DELETED, so every aggregate over it changes too — the same
  // reasoning the `revalidatePath('/', 'layout')` below already carried.
  await invalidatePublicData(CACHE_TAGS.reviews, CACHE_TAGS.stats);
  revalidatePath('/', 'layout');

  // No redirect: the queue is the current page and the revalidation re-renders
  // it with one fewer row. A redirect would lose the scroll position on a list
  // that is long by nature.
  return { status: 'success' };
}
