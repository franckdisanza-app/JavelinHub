'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { isDataError } from '@/lib/data/types';
import type { FormState } from '@/lib/forms';

/**
 * Redeems an invite code for the signed-in user.
 *
 * The data layer returns **one** message — "That invite code is not valid." —
 * for unknown, revoked, expired and already-redeemed codes alike, so that this
 * form cannot be used as an oracle to discover which codes exist. That property
 * is only preserved if the UI renders the message it is given instead of trying
 * to be more helpful, so this action deliberately does no classification of its
 * own: whatever `DataError.message` says is what the user sees.
 */
export async function redeemInviteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const code = String(formData.get('code') ?? '').trim();

  if (code === '') {
    return {
      status: 'error',
      message: 'Please correct the highlighted fields.',
      fieldErrors: { code: 'Enter your invite code.' },
    };
  }

  // The actor carries a user id only. `redeemInviteCode` resolves the profile
  // and does the promotion itself, atomically — we never write a role here.
  const actor = await getActor();

  let needsLogin = false;
  try {
    await getDataClient().redeemInviteCode(actor, code);
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') {
      // Deferred: `redirect()` throws, and throwing from inside a `catch`
      // that is itself inside the `try` of a wider block is easy to get wrong.
      needsLogin = true;
    } else {
      return {
        status: 'error',
        message: error.message,
        fieldErrors: { code: error.message },
        values: { code },
      };
    }
  }

  if (needsLogin) redirect(loginPath('/redeem'));

  // The user's role and coach_status just changed. The header is rendered from
  // the profile in the root layout, so without this the nav would keep showing
  // "Become a coach" to someone who is now a coach.
  revalidatePath('/', 'layout');

  // Redirect rather than return a success state. That revalidation re-renders
  // this page as a Server Component, which now sees an approved coach and
  // swaps the form out — taking any success message held in `useActionState`
  // with it. Carrying the outcome in the URL instead means the page itself
  // decides what to say, and the message survives a refresh.
  redirect('/redeem?redeemed=1');
}
