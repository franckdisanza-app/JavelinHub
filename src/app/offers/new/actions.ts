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

const NEW_OFFER_PATH = '/offers/new';

const MAX_TITLE = 120;
const MIN_TITLE = 3;
const MAX_DESCRIPTION = 4000;
const MIN_DESCRIPTION = 20;

/**
 * Publishes a listing owned by the signed-in actor.
 *
 * A Server Action is a public HTTP endpoint, so this never assumes the page's
 * own approval gate ran. `createListing` resolves the actor's *stored*
 * `coach_status` itself and throws `forbidden` unless it is `'approved'` — that
 * is the check that actually protects the marketplace. The gate on the page is
 * there so a learner sees an explanation instead of a form they cannot submit.
 *
 * `coach_id` is never sent: the data layer takes it from the actor, so a
 * crafted request cannot publish a listing under someone else's name.
 */
export async function createListingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const title = String(formData.get('title') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const price = String(formData.get('price') ?? '').trim();
  // The category is a fixed taxonomy slug. A Server Action is a public HTTP
  // endpoint, so the `<select>`'s option list is not a constraint — the value is
  // validated here and again, independently, inside `createListing`.
  const category = String(formData.get('category') ?? '').trim();
  const categorySlug = isListingCategory(category) ? category : null;
  // Same treatment as the category, and for the same reason: the radio group's
  // two values are not a constraint on what a direct POST can send. An absent
  // or unrecognised mode falls back to `personalised`, which is the column
  // default and the mode that promises nothing.
  const rawFulfilment = String(formData.get('fulfilment') ?? '').trim();
  const fulfilment = isFulfilmentMode(rawFulfilment) ? rawFulfilment : 'personalised';

  const values = { title, description, price, category, fulfilment };

  const fieldErrors: Record<string, string> = {};

  if (title === '') fieldErrors.title = 'A title is required.';
  else if (title.length < MIN_TITLE) {
    // The data layer enforces this too, but its message is "Title is required.",
    // which reads as a lie next to a field containing "ab".
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
  else if (categorySlug === null) {
    // Only reachable by posting to this action directly. The message does not
    // echo the submitted value: it is unvalidated input, and repeating it in the
    // UI serves nobody who arrived here legitimately.
    fieldErrors.category = 'Choose one of the categories in the list.';
  }

  // Parsed here rather than in the data layer, which only speaks integer cents
  // and would reject "45.00" as `invalid` with a message about cents.
  const priceCents = parsePriceToCents(price);
  if (price === '') fieldErrors.price = 'A price is required.';
  else if (priceCents === null) {
    fieldErrors.price = 'Enter a price like 45 or 45.00, using at most two decimal places.';
  }

  /*
   * The file, for an instant offer only.
   *
   * REQUIRED AT PUBLISH TIME, which is stricter than the schema: `listings`
   * happily holds an instant offer with a NULL `asset_path`, and it has to —
   * the path is pinned under the listing's own id, so the row must exist before
   * the file can be stored under it. But an instant offer with no file cannot be
   * claimed (`claim_offer` refuses it), so publishing one is publishing a dead
   * listing. The two-step write below is invisible to the coach; the
   * requirement is what makes it honest.
   */
  let assetFile: File | null = null;
  if (fulfilment === 'instant') {
    if (!deliveryStorageAvailable()) {
      // Reachable only by posting directly: the form renders the option inert.
      return formError(
        'Instant downloads need the Supabase backend. This app is running on the local JSON store, which has no file storage.',
        values,
      );
    }
    const file = formData.get('asset');
    if (!(file instanceof File) || file.size === 0) {
      fieldErrors.asset = 'Choose the file buyers will download.';
    } else {
      const check = checkDeliveryFile(file);
      if (!check.ok) fieldErrors.asset = check.message ?? 'That file could not be used.';
      else assetFile = file;
    }
  }

  // Narrows `priceCents` and `categorySlug` for the call below without an
  // assertion — both are already covered by an entry in `fieldErrors`.
  if (Object.keys(fieldErrors).length > 0 || priceCents === null || categorySlug === null) {
    return fieldError(fieldErrors, values);
  }

  const actor = await getActor();

  let needsLogin = false;
  let createdId: string | null = null;
  let attachFailed = false;
  try {
    const db = getDataClient();
    const listing = await db.createListing(actor, {
      title,
      description,
      price_cents: priceCents,
      category: categorySlug,
      fulfilment,
    });
    createdId = listing.id;

    if (assetFile) {
      /*
       * THE OFFER NOW EXISTS AND ITS FILE DOES NOT, and that window cannot be
       * closed — the path has to start with an id the insert is what produces.
       * So the failure is handled rather than prevented.
       *
       * ROW FIRST, THEN COLUMN, then rollback of the object: upload the bytes,
       * point the column at them, and if the column write fails delete the
       * object again — the same order, and the same reasoning, as
       * `addDeliverableAction`. An object with no column pointing at it is
       * litter nobody can subsequently remove.
       *
       * If either half fails, the coach lands on the editor with an explanation
       * instead of on a published offer that silently cannot be claimed. The
       * offer is NOT withdrawn on their behalf: it is theirs, it is fixable in
       * one upload, and taking it down would be a second surprise.
       */
      const { path } = await uploadOfferAsset(listing.id, assetFile);
      try {
        await db.setListingAsset(actor, listing.id, path);
      } catch (assetError) {
        await deleteOfferAsset(path);
        throw assetError;
      }
    }
  } catch (error) {
    if (!isDataError(error)) throw error;
    // Deferred: `redirect()` works by throwing, so it must not be called from
    // inside this catch — same pattern as the other actions in this app.
    if (error.code === 'unauthorized') needsLogin = true;
    else if (createdId !== null) attachFailed = true;
    else return toFormState(error, { values, fieldFor: guessListingField });
  }

  if (needsLogin) redirect(loginPath(NEW_OFFER_PATH));

  // The offers page is a different route and now has one more offer on it.
  // A new offer belongs in the browse grid and on its coach's profile
  // immediately — the coach is redirected to it and would otherwise land on a
  // page that does not list what they just published.
  await invalidatePublicData(CACHE_TAGS.listings);
  revalidatePath('/offers');

  if (attachFailed) redirect(`/coach/offers/${createdId}/edit?attach=failed`);

  redirect(`/offers/${createdId}?published=1`);
}

/**
 * The data layer returns one human sentence, not a field name, so attaching it
 * to an input is a caller-side heuristic. Only `invalid` is field-attributable:
 * a `forbidden` ("Only approved coaches can publish offers…") is about the
 * account, not an input, and belongs at form level where it is not hidden
 * underneath a textarea.
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
