'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { isDataError } from '@/lib/data/types';
import type { FormState } from '@/lib/forms';

const ADMIN_INVITES_PATH = '/admin/invites';

/**
 * Both actions are reachable by a direct POST — a Server Action is an HTTP
 * endpoint, not a UI affordance — so neither of them relies on the page's
 * `requireAdmin()` guard having run. `createInvite` / `revokeInvite` resolve
 * the actor's role from the store themselves and throw `forbidden` for anyone
 * else; that is the actual authorization, and these functions just render
 * whatever it decides.
 */

export async function createInviteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const note = String(formData.get('note') ?? '').trim();
  const expiresOn = String(formData.get('expiresOn') ?? '').trim();
  const values = { note, expiresOn };

  let expiresAt: string | null = null;
  if (expiresOn !== '') {
    // `<input type="date">` yields YYYY-MM-DD. Expire at the end of that day in
    // UTC so that "expires 1 Sept" means the code still works all day on the
    // 1st, rather than dying at midnight as it would with a bare date parse.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
      return {
        status: 'error',
        message: 'Please correct the highlighted fields.',
        fieldErrors: { expiresOn: 'Enter a date in the form YYYY-MM-DD.' },
        values,
      };
    }
    const parsed = new Date(`${expiresOn}T23:59:59.999Z`);
    if (Number.isNaN(parsed.getTime())) {
      return {
        status: 'error',
        message: 'Please correct the highlighted fields.',
        fieldErrors: { expiresOn: 'That is not a real date.' },
        values,
      };
    }
    if (parsed.getTime() <= Date.now()) {
      // The data layer accepts a past expiry; it would simply mint a code that
      // is dead on arrival, which is never what an admin means.
      return {
        status: 'error',
        message: 'Please correct the highlighted fields.',
        fieldErrors: { expiresOn: 'Pick a date in the future.' },
        values,
      };
    }
    expiresAt = parsed.toISOString();
  }

  const actor = await getActor();

  let needsLogin = false;
  let code: string | null = null;
  try {
    const invite = await getDataClient().createInvite(actor, {
      note: note === '' ? undefined : note,
      expiresAt,
    });
    code = invite.code;
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') needsLogin = true;
    else return { status: 'error', message: error.message, values };
  }

  if (needsLogin) redirect(loginPath(ADMIN_INVITES_PATH));

  revalidatePath(ADMIN_INVITES_PATH);
  return { status: 'success', message: `New invite code ${code} is ready to share.` };
}

export async function revokeInviteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const code = String(formData.get('code') ?? '').trim();
  if (code === '') return { status: 'error', message: 'No invite code was submitted.' };

  const actor = await getActor();

  let needsLogin = false;
  try {
    await getDataClient().revokeInvite(actor, code);
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') needsLogin = true;
    else return { status: 'error', message: error.message };
  }

  if (needsLogin) redirect(loginPath(ADMIN_INVITES_PATH));

  revalidatePath(ADMIN_INVITES_PATH);
  return { status: 'success', message: `Code ${code} is revoked and can no longer be redeemed.` };
}
