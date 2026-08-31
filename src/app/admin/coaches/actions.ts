'use server';

import { revalidatePath } from 'next/cache';

import { getActor } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { isDataError } from '@/lib/data/types';
import { formError, formSuccess, toFormState, type FormState } from '@/lib/forms';

/**
 * Suspending, demoting and reinstating a coach.
 *
 * -----------------------------------------------------------------------------
 * THE ORDERING IS THE WHOLE ACTION
 * -----------------------------------------------------------------------------
 * `set_coach_status()` REFUSES while any of the coach's offers is still on sale,
 * and it refuses rather than withdrawing them itself for the reason `0022`
 * records: it is `SECURITY DEFINER` owned by `javelin_privileged`, and
 * `guard_listing_update()` assigns `new.deleted_by := auth.uid()`, which that
 * role can never call. So the takedown has to happen out here, as the
 * administrator, through the ordinary path.
 *
 * That constraint turns out to be the right product behaviour anyway. Because
 * the withdrawal is made BY the administrator, `listings.deleted_by` records
 * them, and `restoreListing`'s table then says the coach may not put those
 * offers back themselves — which is what makes a suspension a suspension rather
 * than a speed bump. See `docs/DATA-LAYER.md`.
 *
 * -----------------------------------------------------------------------------
 * WHY REINSTATING DOES NOT PUT THE OFFERS BACK
 * -----------------------------------------------------------------------------
 * Nothing records which withdrawals belonged to which suspension, and inventing
 * that link would mean restoring offers an administrator took down for an
 * unrelated reason months earlier. The page lists the coach's withdrawn offers
 * with a Restore button on each instead: one deliberate decision per offer,
 * which is the same split as "upholding a report is not removing the review".
 */
export async function setCoachStandingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const coachId = String(formData.get('coachId') ?? '').trim();
  if (coachId === '') return formError('That account could not be found.');

  const status = String(formData.get('status') ?? '');
  if (status !== 'approved' && status !== 'suspended' && status !== 'none') {
    return formError('A coach can be reinstated, suspended, or removed as a coach.');
  }

  const rawReason = String(formData.get('reason') ?? '').trim();
  if (rawReason.length > 1000) {
    return formError(`Keep the reason to 1000 characters or fewer — ${rawReason.length} so far.`, {
      reason: rawReason,
    });
  }
  // Trimmed to null: the column is nullable and "no reason given" is a
  // different fact from "the reason is blank".
  const reason = rawReason === '' ? null : rawReason;

  const actor = await getActor();
  const db = getDataClient();

  let withdrawn = 0;
  try {
    if (status === 'suspended' || status === 'none') {
      // Read first, then withdraw one at a time. Sequential rather than
      // `Promise.all`: each of these is a write against the same coach's rows,
      // and a partial failure halfway through a parallel batch would leave a
      // state nobody could describe in the message below.
      const listings = await db.listListingsForAdmin(actor, coachId);
      for (const listing of listings) {
        if (listing.deleted_at !== null) continue;
        await db.softDeleteListing(actor, listing.id);
        withdrawn += 1;
      }
    }

    await db.setCoachStatus(actor, coachId, status, reason);
  } catch (error) {
    if (!isDataError(error)) throw error;
    /*
     * A failure AFTER some offers came down is possible — these are separate
     * transactions, and nothing here is atomic across them. The message says so
     * rather than pretending nothing happened, because the alternative is an
     * administrator retrying against a coach whose shop is already half shut.
     */
    if (withdrawn === 0) return toFormState(error, { values: { reason: rawReason } });
    return formError(
      `${error.message} ${withdrawn === 1 ? '1 offer was' : `${withdrawn} offers were`} already taken down — reload before trying again.`,
      { reason: rawReason },
    );
  }

  // Their offers vanished from browse, from search, from the coach profile and
  // from the cross-sell grids. `'/'` + `'layout'` is the blunt instrument that
  // covers every surface that was showing them — the same reasoning as
  // `removeReviewAction`.
  revalidatePath('/', 'layout');

  return formSuccess(describe(status, withdrawn));
}

/**
 * Puts one offer back on sale.
 *
 * An administrator can lift their own takedown; the coach cannot. That
 * asymmetry is `restoreListing`'s, not this action's — all this does is name
 * the offer and revalidate.
 */
export async function restoreCoachListingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const listingId = String(formData.get('listingId') ?? '').trim();
  if (listingId === '') return formError('That offer could not be found.');

  try {
    await getDataClient().restoreListing(await getActor(), listingId);
  } catch (error) {
    if (!isDataError(error)) throw error;
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  return formSuccess('Back on sale.');
}

// ---------------------------------------------------------------------------

function describe(status: string, withdrawn: number): string {
  const offers =
    withdrawn === 0
      ? 'They had nothing on sale.'
      : withdrawn === 1
        ? '1 offer was taken down.'
        : `${withdrawn} offers were taken down.`;

  switch (status) {
    case 'suspended':
      return `Suspended. ${offers} They can still sign in, see their sales and deliver work they already owe.`;
    case 'none':
      return `No longer a coach. ${offers} Their reviews and sales stay, and they can apply again.`;
    default:
      return 'Reinstated. Their withdrawn offers stay down until you put them back, one at a time.';
  }
}
