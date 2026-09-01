'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { CACHE_TAGS, invalidatePublicData } from '@/lib/data/cache-tags';
import { isDataError } from '@/lib/data/types';
import { formError, toFormState, type FormState } from '@/lib/forms';
import { notifyBuyerOfOrder } from '@/lib/email/notifications';
import { formatPrice } from '@/lib/format';
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
  let placed: { title: string; orderId: string; priceCents: number } | null = null;
  try {
    const db = getDataClient();
    const order = await db.createOrder(actor, listingId);
    /*
     * Read back for the confirmation email only. `createOrder` returns the
     * order, which carries `price_cents_at_purchase` and the listing id but not
     * the title — and the title is the one thing a person needs in order to
     * recognise what the message is about.
     */
    const listing = await db.getListing(listingId);
    placed = listing
      ? { title: listing.title, orderId: order.id, priceCents: order.price_cents_at_purchase }
      : null;
  } catch (error) {
    if (!isDataError(error)) throw error;
    // Deferred: `redirect()` throws and must not be thrown from inside a catch.
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error);
  }

  // An anonymous visitor is sent to sign in and returned to the offer, rather
  // than being told to sign in and left where they were.
  if (needsLogin) redirect(loginPath(`/offers/${listingId}`));

  /*
   * The buyer's own copy of what they claimed.
   *
   * THE ONLY ONE OF THE THREE NOTIFICATIONS THAT CAN BE SENT FROM AN ACTION,
   * and the reason is worth knowing before somebody adds the other two here:
   * `profiles` carries an email, so it is readable only by its owner and by an
   * administrator. The recipient here IS the actor, so this is a self-read. The
   * coach's "you have a new order" needs an address this session may not read,
   * and waits on an outbox — see `src/lib/email/notifications.ts`.
   *
   * After the write and before the redirect, and it cannot fail the claim:
   * `sendEmail` logs and skips while `RESEND_API_KEY` is unset, and never
   * throws. An order that succeeded must not be reported as failed because a
   * mail provider was down.
   */
  if (placed && actor) {
    const me = await getDataClient()
      .getProfile(actor, actor.userId)
      .catch(() => null);
    if (me) {
      await notifyBuyerOfOrder({
        buyerEmail: me.email,
        offerTitle: placed.title,
        orderId: placed.orderId,
        price: formatPrice(placed.priceCents),
      });
    }
  }

  // The sales count on this offer, on the coach's page and on every card that
  // shows it are all stale now.
  // A claim moves the offer's sale count and the coach's, both of which are
  // rendered on cards a stranger sees.
  await invalidatePublicData(CACHE_TAGS.stats);
  revalidatePath('/', 'layout');

  redirect('/purchases?claimed=1');
}
