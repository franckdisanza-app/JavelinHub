'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { CACHE_TAGS, invalidatePublicData } from '@/lib/data/cache-tags';
import { isDataError, isFulfilmentMode, isListingCategory } from '@/lib/data/types';
import {
  checkDeliveryFile,
  deleteOfferAsset,
  deliveryStorageAvailable,
  uploadOfferAsset,
} from '@/lib/storage/deliverables';
import { fieldError, formError, toFormState, type FormState } from '@/lib/forms';
import { parsePriceToCents } from '@/lib/format';
import { consume, TOO_MANY_MESSAGE } from '@/lib/rate-limit';

const DASHBOARD_PATH = '/coach/offers';

const MAX_TITLE = 120;
const MIN_TITLE = 3;
const MAX_DESCRIPTION = 4000;
const MIN_DESCRIPTION = 20;

/**
 * All three actions here are reachable by a direct POST — a Server Action is an
 * HTTP endpoint, not a UI affordance — so none of them relies on the page's own
 * gate having run, and none of them takes a coach id. `updateListing`,
 * `softDeleteListing` and `restoreListing` resolve the actor themselves and
 * decide ownership from the stored row; that is the authorization, and these
 * functions render whatever it decides.
 *
 * Note the asymmetry the data layer enforces and these inherit: **editing is
 * owner-only, never admin**, while withdrawing and restoring admit an admin too.
 * A takedown an admin performed cannot then be undone by the coach — see the
 * `restore` note below.
 */

/**
 * Edits one offer.
 *
 * What this deliberately does NOT do: touch `price_epoch`, or write a
 * `listing_revisions` row. Both are DERIVED — by `guard_listing_update()` and
 * `record_listing_revision()` in Postgres, and inside the same `mutateDb` in the
 * mock. Sending an epoch would be overwritten; writing a revision here would
 * duplicate the one the trigger already wrote. The archive rule (a price
 * INCREASE advances the epoch and resets the offer's public rating; a decrease
 * does not) is therefore not this file's to implement or to bypass.
 */
export async function updateOfferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get('id') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const price = String(formData.get('price') ?? '').trim();
  const category = String(formData.get('category') ?? '').trim();
  const categorySlug = isListingCategory(category) ? category : null;
  // Unrecognised or absent means UNCHANGED here, not "personalised" — the
  // opposite of the composer, where there is no existing value to preserve.
  // `updateListing` leaves the column alone when it is not sent, which is what
  // keeps a direct POST from resetting an offer's delivery mode by omission.
  const rawFulfilment = String(formData.get('fulfilment') ?? '').trim();
  const fulfilment = isFulfilmentMode(rawFulfilment) ? rawFulfilment : undefined;

  const values = { title, description, price, category, fulfilment: fulfilment ?? '' };

  if (id === '') return formError('That offer could not be found.', values);

  const fieldErrors: Record<string, string> = {};

  if (title === '') fieldErrors.title = 'A title is required.';
  else if (title.length < MIN_TITLE) {
    fieldErrors.title = `Please use at least ${MIN_TITLE} characters — ${title.length} so far.`;
  } else if (title.length > MAX_TITLE) {
    fieldErrors.title = `Keep the title to ${MAX_TITLE} characters or fewer — ${title.length} so far.`;
  }

  if (description === '') fieldErrors.description = 'A description is required.';
  else if (description.length < MIN_DESCRIPTION) {
    fieldErrors.description = `Please write at least ${MIN_DESCRIPTION} characters — ${description.length} so far.`;
  } else if (description.length > MAX_DESCRIPTION) {
    fieldErrors.description = `Keep this to ${MAX_DESCRIPTION} characters or fewer — ${description.length} so far.`;
  }

  if (category === '') fieldErrors.category = 'Choose a category.';
  else if (categorySlug === null) fieldErrors.category = 'Choose one of the categories in the list.';

  const priceCents = parsePriceToCents(price);
  if (price === '') fieldErrors.price = 'A price is required.';
  else if (priceCents === null) {
    fieldErrors.price = 'Enter a price like 45 or 45.00, using at most two decimal places.';
  }

  if (Object.keys(fieldErrors).length > 0 || priceCents === null || categorySlug === null) {
    return fieldError(fieldErrors, values);
  }

  const actor = await getActor();

  /*
   * Every edit appends a `listing_revisions` row, written by
   * `record_listing_revision()` rather than by this file — and no client role
   * holds DELETE on that table, deliberately, so a coach cannot rewrite the
   * history of their own offer. The other side of that guarantee is that an
   * edit loop grows a table nothing can prune, so the loop is what gets bounded.
   *
   * After validation, so a mistyped price does not spend the budget needed to
   * correct it.
   */
  if (actor && !(await consume('writeUser', actor.userId))) {
    return formError(TOO_MANY_MESSAGE, values);
  }

  let needsLogin = false;
  try {
    const db = getDataClient();

    /*
     * Read BEFORE the update, because the update is what erases the answer:
     * switching to personalised clears `asset_path` in the same statement, so
     * afterwards there is nothing left to say which object to tidy up. This
     * replaces a hidden `currentAsset` input — see `setOfferAssetAction` for
     * why a client-chosen delete target was worth removing even though the
     * storage policy already bounded it.
     */
    const previousAsset =
      fulfilment === 'personalised' ? ((await db.getMyListing(actor, id))?.asset_path ?? '') : '';

    await db.updateListing(actor, id, {
      title,
      description,
      price_cents: priceCents,
      category: categorySlug,
      fulfilment,
    });

    /*
     * Switching to personalised cleared `asset_path` in the same statement —
     * `listings_asset_path_shape` refuses the row otherwise. The OBJECT is this
     * layer's to tidy up, and only once the column has moved: an orphan in the
     * bucket is invisible, while bytes deleted before the column would leave a
     * live offer pointing at a download that fails.
     *
     * `previousAsset` was read off the offer above, before the update cleared
     * the column. Best-effort, like every other object delete in this app.
     */
    if (previousAsset !== '') await deleteOfferAsset(previousAsset);
  } catch (error) {
    if (!isDataError(error)) throw error;
    // Deferred: `redirect()` throws, and must not be thrown from inside a catch.
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error, { values, fieldFor: guessListingField });
  }

  if (needsLogin) redirect(loginPath(`${DASHBOARD_PATH}/${id}/edit`));

  // The offer's own page, the browse grid and the coach's public page all show
  // this row. `'/'`+`'layout'` is the blunt instrument that covers all of them
  // plus the dashboard itself.
  await invalidatePublicData(CACHE_TAGS.listings);
  revalidatePath('/', 'layout');

  redirect(`${DASHBOARD_PATH}?saved=${encodeURIComponent(id)}`);
}

/**
 * Attaches, replaces or removes an instant offer's downloadable file.
 *
 * ITS OWN ACTION, separate from the edit above, for the same reason
 * `updateAvatarAction` is separate from the profile save: it is a different kind
 * of write. The four content columns are text a coach typed; this is bytes going
 * to object storage. Keeping them apart means a failed upload cannot discard a
 * description, and removing a file does not require re-submitting the price.
 *
 * ORDER MATTERS IN BOTH DIRECTIONS, and it is chosen so that a failure never
 * leaves a claimable offer pointing at nothing:
 *
 *   setting   upload FIRST, then write the column, then delete the file being
 *             replaced. A failed upload leaves the old file live and the offer
 *             claimable; a failed column write rolls the new object back, since
 *             an object nothing points at is litter nobody can later remove.
 *   clearing  write the column FIRST, then delete the object. A failed delete
 *             leaves an orphan that is invisible to everyone.
 *
 * Clearing makes the offer UNCLAIMABLE — `claim_offer` refuses an instant offer
 * with no file — which is a real and sometimes wanted state (a coach fixing a
 * bad upload), so it is offered plainly and the dashboard says so afterwards.
 */
export async function setOfferAssetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get('id') ?? '').trim();
  if (id === '') return formError('That offer could not be found.');

  const intent = String(formData.get('intent') ?? 'set');

  if (intent !== 'clear' && !deliveryStorageAvailable()) {
    return formError(
      'File uploads need the Supabase backend. This app is running on the local JSON store, which has no file storage.',
    );
  }

  const actor = await getActor();

  /*
   * The upload budget, not the write one. This is the single cheapest way for
   * one account to move bytes repeatedly: `set` uploads a NEW key every time
   * rather than overwriting (so a buyer's signed URL to the old file keeps
   * working until it expires), which means a replace loop leaves every previous
   * object behind until its own delete lands. `clear` spends it too — it is the
   * same control, and exempting one intent would just name the loop to use.
   */
  if (actor && !(await consume('uploadUser', actor.userId))) {
    return formError(TOO_MANY_MESSAGE);
  }

  let needsLogin = false;
  try {
    const db = getDataClient();

    /*
     * The path being REPLACED comes off the offer, not off the form. It used to
     * be a hidden `current` input, i.e. a client-chosen object to delete;
     * `offer_assets_delete_coach` confined that to offers the caller owns, so
     * the worst case was a coach erasing the file of another of THEIR OWN
     * offers and leaving that offer pointing at nothing. `owned_listings` is
     * scoped by `auth.uid()` inside the view, so this read is both the correct
     * source and an ownership check.
     */
    const owned = await db.getMyListing(actor, id);
    const previous = owned?.asset_path ?? '';

    if (intent === 'clear') {
      await db.setListingAsset(actor, id, null);
      if (previous !== '') await deleteOfferAsset(previous);
    } else {
      const file = formData.get('asset');
      if (!(file instanceof File) || file.size === 0) return formError('Choose a file to attach.');

      const check = checkDeliveryFile(file);
      if (!check.ok) return formError(check.message ?? 'That file could not be used.');

      const { path } = await uploadOfferAsset(id, file);
      try {
        await db.setListingAsset(actor, id, path);
      } catch (rowError) {
        await deleteOfferAsset(path);
        throw rowError;
      }
      // Only now is the old file unreachable through the product. Note this is
      // a NEW key rather than an overwrite, so a buyer holding a signed URL to
      // the old bytes keeps a working link until it expires — see
      // `uploadOfferAsset`.
      if (previous !== '' && previous !== path) await deleteOfferAsset(previous);
    }
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error);
  }

  if (needsLogin) redirect(loginPath(`${DASHBOARD_PATH}/${id}/edit`));

  // Whether an instant offer is claimable at all turns on this file, and that
  // shows on the offer page as well as on the dashboard.
  await invalidatePublicData(CACHE_TAGS.listings);
  revalidatePath('/', 'layout');

  // No redirect: the editor is already the current page, and the revalidation
  // re-renders it with the new file in place.
  return { status: 'success' };
}

/** Takes an offer off sale. A POST, never a link — it changes state. */
export async function withdrawOfferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return setWithdrawn(formData, 'withdraw');
}

/**
 * Puts a withdrawn offer back on sale.
 *
 * A coach may undo their OWN withdrawal. They may not undo an administrator's
 * takedown — `restoreListing` throws `forbidden` with a sentence explaining
 * that, and the dashboard does not render the button in that case. Both halves
 * matter: hiding the control is the courtesy, the refusal is the rule.
 */
export async function restoreOfferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return setWithdrawn(formData, 'restore');
}

async function setWithdrawn(formData: FormData, mode: 'withdraw' | 'restore'): Promise<FormState> {
  const id = String(formData.get('id') ?? '').trim();
  if (id === '') return formError('That offer could not be found.');

  const actor = await getActor();
  const db = getDataClient();

  /*
   * Withdraw and restore share the budget with edits because they are the same
   * cost: both take an offer in and out of every public read and expire the
   * listings cache tag, and a flip-flop between them is the cheapest way to do
   * that repeatedly.
   */
  if (actor && !(await consume('writeUser', actor.userId))) {
    return formError(TOO_MANY_MESSAGE);
  }

  let needsLogin = false;
  try {
    if (mode === 'withdraw') await db.softDeleteListing(actor, id);
    else await db.restoreListing(actor, id);
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') needsLogin = true;
    // No `fieldFor`: these forms have one hidden input and no field to blame,
    // so every message belongs at form level beside the button that failed.
    else return toFormState(error);
  }

  if (needsLogin) redirect(loginPath(DASHBOARD_PATH));

  // Withdrawal removes the offer from every public read and restoration puts it
  // back, so this is not confined to the dashboard.
  await invalidatePublicData(CACHE_TAGS.listings);
  revalidatePath('/', 'layout');

  // No redirect: the dashboard is already the current page and the revalidation
  // above re-renders it in place. Returning a success state keeps the user's
  // scroll position on a list that may be long, which a redirect would lose.
  return { status: 'success' };
}

/**
 * The data layer returns one human sentence, not a field name, so attaching it
 * to an input is a caller-side heuristic — the same one `offers/new` uses.
 * Only `invalid` is field-attributable: a `forbidden` ("Only the coach who
 * published an offer can edit it.") is about the account and belongs at form
 * level.
 */
function guessListingField(message: string, code: string): string | null {
  if (code !== 'invalid') return null;
  const text = message.toLowerCase();
  if (text.startsWith('title')) return 'title';
  if (text.startsWith('description')) return 'description';
  if (text.startsWith('category')) return 'category';
  if (text.startsWith('price')) return 'price';
  return null;
}
