'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { isDataError } from '@/lib/data/types';
import { formError, toFormState, type FormState } from '@/lib/forms';

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
  revalidatePath('/', 'layout');

  redirect('/purchases?claimed=1');
}
