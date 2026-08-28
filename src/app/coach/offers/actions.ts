'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { isDataError, isListingCategory } from '@/lib/data/types';
import { fieldError, formError, toFormState, type FormState } from '@/lib/forms';
import { parsePriceToCents } from '@/lib/format';

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

  const values = { title, description, price, category };

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

  let needsLogin = false;
  try {
    await getDataClient().updateListing(actor, id, {
      title,
      description,
      price_cents: priceCents,
      category: categorySlug,
    });
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
  revalidatePath('/', 'layout');

  redirect(`${DASHBOARD_PATH}?saved=${encodeURIComponent(id)}`);
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
