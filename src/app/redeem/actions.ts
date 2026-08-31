'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { CACHE_TAGS, invalidatePublicData } from '@/lib/data/cache-tags';
import { isDataError } from '@/lib/data/types';
import type { FormState } from '@/lib/forms';
import { clientIp } from '@/lib/client-ip';
import { consume, TOO_MANY_MESSAGE } from '@/lib/rate-limit';

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

  /*
   * Per IP. NOT because a code is guessable — `generateInviteCode()` draws 12
   * characters from a 30-character alphabet, about 2⁵⁹, and arithmetic is what
   * makes guessing hopeless. This is here so that trying is not free, and
   * because an endpoint that promotes its caller to approved coach is a
   * convenient thing to hammer whatever the odds.
   *
   * Keyed on IP rather than on the actor: a signed-in user id would let one
   * account be the whole budget while an attacker cycles accounts, and the
   * codes are not account-specific anyway.
   */
  if (!(await consume('redeemIp', (await clientIp()) ?? 'no-ip'))) {
    return {
      status: 'error',
      message: TOO_MANY_MESSAGE,
      fieldErrors: { code: TOO_MANY_MESSAGE },
      values: { code },
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
  // They are an approved coach as of this call, which means a new row in the
  // public directory.
  await invalidatePublicData(CACHE_TAGS.coaches);
  revalidatePath('/', 'layout');

  // Redirect rather than return a success state. That revalidation re-renders
  // this page as a Server Component, which now sees an approved coach and
  // swaps the form out — taking any success message held in `useActionState`
  // with it. Carrying the outcome in the URL instead means the page itself
  // decides what to say, and the message survives a refresh.
  redirect('/redeem?redeemed=1');
}
