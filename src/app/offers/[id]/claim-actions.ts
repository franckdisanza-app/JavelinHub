'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { CACHE_TAGS, invalidatePublicData } from '@/lib/data/cache-tags';
import { isDataError } from '@/lib/data/types';
import { formError, toFormState, type FormState } from '@/lib/forms';
import { consume, TOO_MANY_MESSAGE } from '@/lib/rate-limit';

/**
 * Claims an offer.
 *
 * A Server Action is a public HTTP endpoint, so this never assumes the page
 * rendered a button: `createOrder` resolves the actor itself, refuses the
 * coach's own offer, a withdrawn one, and a second claim, and derives every
 * field of the order from the listing. Nothing here is trusted except which
 * offer was meant.
 *
 * The claim is FREE while the pilot is. When payment lands it goes in front of
 * this call — the order is still created by the same RPC, on the far side of a
 * confirmed charge.
 */
export async function claimOfferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const listingId = String(formData.get('listingId') ?? '').trim();
  if (listingId === '') return formError('That offer could not be found.');

  const actor = await getActor();

  /*
   * Keyed on the account, and only spent once there IS one — an anonymous
   * caller is sent to sign in below without touching a budget, the same
   * ordering `reportReviewAction` uses so that a signed-out request cannot
   * consume somebody else's.
   *
   * `claim_offer()` already refuses a second claim of the SAME offer, so this
   * is not about that; it is about one account claiming the whole catalogue,
   * which costs nothing while the pilot is free and moves every sales count on
   * the site. Not a boundary: ownership and the one-claim rule are enforced in
   * Postgres and would hold with this file deleted.
   */
  if (actor && !(await consume('claimUser', actor.userId))) {
    return formError(TOO_MANY_MESSAGE);
  }

  let needsLogin = false;
  try {
    await getDataClient().createOrder(actor, listingId);
  } catch (error) {
    if (!isDataError(error)) throw error;
    // Deferred: `redirect()` throws and must not be thrown from inside a catch.
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error);
  }

  // An anonymous visitor is sent to sign in and returned to the offer, rather
  // than being told to sign in and left where they were.
  if (needsLogin) redirect(loginPath(`/offers/${listingId}`));

  // The sales count on this offer, on the coach's page and on every card that
  // shows it are all stale now.
  // A claim moves the offer's sale count and the coach's, both of which are
  // rendered on cards a stranger sees.
  await invalidatePublicData(CACHE_TAGS.stats);
  revalidatePath('/', 'layout');

  redirect('/purchases?claimed=1');
}
