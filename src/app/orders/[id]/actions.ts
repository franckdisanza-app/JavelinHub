'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { CACHE_TAGS, invalidatePublicData } from '@/lib/data/cache-tags';
import { isDataError } from '@/lib/data/types';
import { formError, toFormState, type FormState } from '@/lib/forms';
import { checkDeliveryFile, deleteDeliveryFile, uploadDeliveryFile } from '@/lib/storage/deliverables';

/**
 * Attaches a file to an order.
 *
 * Either party may: a learner sends their throw, a coach sends the analysis.
 * Which of the two this is gets DERIVED later by comparing `uploaded_by` with
 * the order — nothing here declares a direction, so nothing here can lie about
 * one.
 *
 * OBJECT FIRST, THEN ROW. If the upload fails there is no row pointing at
 * nothing; if the row insert fails the object is deleted again, because an
 * object with no row is unreachable litter that nobody can subsequently remove
 * (see `supabase/README.md`, "Storage objects are not cleaned up by cascades").
 */
export async function addDeliverableAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const orderId = String(formData.get('orderId') ?? '').trim();
  if (orderId === '') return formError('That order could not be found.');

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return formError('Choose a file to send.');

  const check = checkDeliveryFile(file);
  if (!check.ok) return formError(check.message ?? 'That file could not be used.');

  const actor = await getActor();

  let needsLogin = false;
  try {
    const db = getDataClient();

    // The order is read BEFORE the upload, for two reasons: it refuses a
    // stranger before any bytes move, and the uploader id has to be the
    // resolved actor rather than whatever the session shape claims.
    const order = await db.getOrder(actor, orderId);
    if (!order) return formError('That order could not be found.');

    const me = await db.getProfile(actor, actor?.userId ?? '');
    if (!me) return formError('Your profile could not be found.');

    const { path, fileName } = await uploadDeliveryFile(order.id, me.id, file);

    try {
      await db.addDeliverable(actor, {
        order_id: order.id,
        storage_path: path,
        file_name: fileName,
        content_type: file.type,
        size_bytes: file.size,
      });
    } catch (rowError) {
      // Roll the object back. Best-effort — but this is the one moment at which
      // deleting it is still possible, so it is worth attempting.
      await deleteDeliveryFile(path);
      throw rowError;
    }
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error);
  }

  if (needsLogin) redirect(loginPath(`/orders/${orderId}`));

  revalidatePath(`/orders/${orderId}`);
  return { status: 'success' };
}

/**
 * Removes one of the actor's OWN files.
 *
 * ROW FIRST, THEN OBJECT — the opposite order to adding, and for the same
 * reason in reverse. `removeDeliverable` is the authorization check; once it
 * has passed, the file is gone as far as the product is concerned and deleting
 * the bytes is housekeeping that must not be able to fail the operation.
 */
export async function removeDeliverableAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const orderId = String(formData.get('orderId') ?? '').trim();
  const deliverableId = String(formData.get('deliverableId') ?? '').trim();
  const path = String(formData.get('path') ?? '').trim();
  if (deliverableId === '') return formError('That file could not be found.');

  const actor = await getActor();

  let needsLogin = false;
  try {
    await getDataClient().removeDeliverable(actor, deliverableId);
    if (path !== '') await deleteDeliveryFile(path);
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error);
  }

  if (needsLogin) redirect(loginPath(`/orders/${orderId}`));

  revalidatePath(`/orders/${orderId}`);
  return { status: 'success' };
}

/**
 * Writes the buyer's review.
 *
 * `createReview` derives `listing_id`, `author_id` and `price_epoch` from the
 * order — the epoch in particular, so the review counts towards the price
 * generation that was actually bought rather than whatever the offer costs
 * today. It refuses a coach reviewing their own offer and a second review of
 * the same purchase.
 */
export async function createReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const orderId = String(formData.get('orderId') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  const ratingRaw = String(formData.get('rating') ?? '').trim();
  const values = { body, rating: ratingRaw };

  const rating = /^[1-5]$/.test(ratingRaw) ? Number(ratingRaw) : null;

  const fieldErrors: Record<string, string> = {};
  if (rating === null) fieldErrors.rating = 'Choose a rating from 1 to 5 stars.';
  if (body === '') fieldErrors.body = 'Say a little about how it went.';
  else if (body.length < 3) fieldErrors.body = 'Please write a few more words.';
  else if (body.length > 2000) {
    fieldErrors.body = `Keep this to 2000 characters or fewer — ${body.length} so far.`;
  }
  if (Object.keys(fieldErrors).length > 0 || rating === null) {
    return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors, values };
  }

  const actor = await getActor();

  let needsLogin = false;
  try {
    await getDataClient().createReview(actor, { order_id: orderId, rating, body });
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error, { values });
  }

  if (needsLogin) redirect(loginPath(`/orders/${orderId}`));

  // The review changes the offer's public rating and the coach's account
  // rating, so this is not confined to the order page.
  // A review changes the text on two pages and the rating on every card that
  // names the offer or the coach.
  await invalidatePublicData(CACHE_TAGS.reviews, CACHE_TAGS.stats);
  revalidatePath('/', 'layout');
  redirect(`/orders/${orderId}?reviewed=1`);
}
