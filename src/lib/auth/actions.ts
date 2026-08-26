'use server';

/**
 * Auth Server Actions.
 *
 * A file with the `'use server'` directive may only export async functions, so
 * the shared `FormState` shape lives in `@/lib/forms`.
 *
 * Two things every action here does, and every future one should copy:
 *
 *  1. `revalidatePath('/', 'layout')` after anything that changes who the user
 *     is or what they may do. The root layout renders the header from the
 *     signed-in profile, so without this the nav keeps showing "Log in" to a
 *     user who just signed up.
 *  2. `redirect()` is called *outside* any `try`. `redirect()` works by
 *     throwing a control-flow signal, and a bare `catch` swallows it — the
 *     navigation silently never happens and the form appears to hang.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createSession, destroySession, safeNextPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { guessAuthField, toFormState, type FormState } from '@/lib/forms';

/** Where a user lands after signing in or signing up, unless `?next=` says otherwise. */
const DEFAULT_LANDING = '/offers';

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const fullName = String(formData.get('fullName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  // Never echo a password back into the rendered HTML.
  const values = { fullName, email };

  // Cheap, friendly, field-level checks first. The data layer validates all of
  // this again — these exist to produce a message next to the right input, not
  // to be the validation.
  const fieldErrors: Record<string, string> = {};
  if (fullName === '') fieldErrors.fullName = 'Enter your full name.';
  if (email === '') fieldErrors.email = 'Enter your email address.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fieldErrors.email = 'Enter a valid email address.';
  if (password === '') fieldErrors.password = 'Choose a password.';
  else if (password.length < 8) fieldErrors.password = 'Passwords must be at least 8 characters.';

  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors, values };
  }

  let userId: string;
  try {
    const profile = await getDataClient().signUp({ email, password, fullName });
    userId = profile.id;
  } catch (error) {
    return toFormState(error, { values, fieldFor: guessAuthField });
  }

  await createSession(userId);
  revalidatePath('/', 'layout');
  redirect(DEFAULT_LANDING);
}

export async function logInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = safeNextPath(formData.get('next'));
  const values = { email };

  const fieldErrors: Record<string, string> = {};
  if (email === '') fieldErrors.email = 'Enter your email address.';
  if (password === '') fieldErrors.password = 'Enter your password.';
  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors, values };
  }

  let userId: string;
  try {
    const profile = await getDataClient().signInWithPassword({ email, password });
    if (!profile) {
      // ONE message for "no such account" and "wrong password". Anything that
      // distinguishes them turns the login form into an account-enumeration
      // oracle: an attacker learns which addresses are registered here without
      // ever guessing a password. The data layer returns `null` for both cases
      // rather than throwing, precisely so this is the easy thing to write.
      return { status: 'error', message: 'Invalid email or password.', values };
    }
    userId = profile.id;
  } catch (error) {
    return toFormState(error, { values, fieldFor: guessAuthField });
  }

  await createSession(userId);
  revalidatePath('/', 'layout');
  redirect(next ?? DEFAULT_LANDING);
}

/**
 * Logs out. Invoked by a `<form action={logoutAction}>`, i.e. a POST.
 *
 * Not a link: a GET that mutates state is fetched by link prefetchers, browser
 * scanners and `<img src>` tags on other sites, and would sign the user out
 * from anywhere on the web. `sameSite: 'lax'` on the session cookie means a
 * cross-site POST does not carry it, so the form is safe.
 */
export async function logoutAction(): Promise<void> {
  await destroySession();
  revalidatePath('/', 'layout');
  redirect('/');
}
