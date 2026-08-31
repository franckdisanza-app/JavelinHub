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

import { requestPasswordReset } from '@/lib/auth/password-reset';
import { createSession, destroySession, getActor, safeNextPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { guessAuthField, toFormState, type FormState } from '@/lib/forms';
import { clientIp } from '@/lib/client-ip';
import { consume, consumeBoth, TOO_MANY_MESSAGE } from '@/lib/rate-limit';

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

  /*
   * Per IP only. There is no address to key on that the caller did not choose
   * themselves — an attacker minting accounts varies the email by definition —
   * so the address axis would count one attempt per bucket forever and limit
   * nothing.
   *
   * Consumed AFTER validation, so a typo in the email field does not spend a
   * budget the person will need when they correct it.
   */
  if (!(await consume('signupIp', (await clientIp()) ?? 'no-ip'))) {
    return { status: 'error', message: TOO_MANY_MESSAGE, values };
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

  /*
   * Both axes. Per address is what makes guessing one account's password
   * expensive; per IP is what stops a caller working through a list of
   * addresses at one try each, which the address limit alone never sees.
   *
   * The refusal message is the SAME SHAPE as the credentials one and mentions
   * neither the address nor the limit — "too many attempts for that account"
   * would confirm the account exists, which is the oracle this form is built
   * not to be.
   */
  if (!(await consumeBoth({ name: 'loginEmail', email }, { name: 'loginIp', ip: await clientIp() }))) {
    return { status: 'error', message: TOO_MANY_MESSAGE, values };
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
 * Starts a password reset.
 *
 * **THE SAME ANSWER FOR EVERY ADDRESS**, and the whole point of the action is
 * to keep it that way. A known address, an unknown one, one belonging to
 * somebody else — all three return the identical success state, because any
 * difference makes this form an account-enumeration oracle. It is the same rule
 * `logInAction` follows with "Invalid email or password", applied to a form that
 * would otherwise be a much easier oracle: no password guess is even needed.
 *
 * `requestPasswordReset` returns `void` for the same reason. There is nothing
 * here to branch on and nothing to accidentally render.
 *
 * The only thing that IS rejected is an unusable input, and only for the
 * obvious reason: an empty box is a mistake, not a lookup.
 */
export async function requestPasswordResetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get('email') ?? '').trim();
  const values = { email };

  if (email === '') {
    return { status: 'error', message: 'Enter your email address.', fieldErrors: { email: 'Enter your email address.' }, values };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // A shape check, not an existence check. It says nothing about whether the
    // address is registered — only that what was typed cannot be an address.
    return { status: 'error', message: 'Enter a valid email address.', fieldErrors: { email: 'Enter a valid email address.' }, values };
  }

  /*
   * THE LIMIT THIS WHOLE MECHANISM WAS BUILT FOR. Both axes, and the IP one is
   * the load-bearing half: GoTrue's mail quota is project-wide and shared, so a
   * caller varying the address can deny password resets to every user without
   * the per-address limit ever firing.
   *
   * Consumed BEFORE the send and counted whether or not an account exists, so
   * the timing and the outcome are identical for a registered address and an
   * unregistered one — the enumeration property the rest of this function
   * exists to preserve would be undone by a limiter that only counted hits.
   */
  if (!(await consumeBoth({ name: 'resetEmail', email }, { name: 'resetIp', ip: await clientIp() }))) {
    // Deliberately NOT the success state. A caller being throttled should be
    // told to wait rather than told an email is coming that is not.
    return { status: 'error', message: TOO_MANY_MESSAGE, values };
  }

  try {
    await requestPasswordReset(email);
  } catch {
    /*
     * SWALLOWED, DELIBERATELY, and this is the one place in the app where that
     * is right. A mail transport that is down, rate-limited or misconfigured
     * fails differently for an address that exists than for one that does not —
     * so reporting the failure re-opens the oracle the rest of this function
     * closes. The user is told to check their inbox and to try again if nothing
     * arrives, which is the correct advice in both cases.
     */
  }

  return { status: 'success' };
}

/**
 * Sets a new password for whoever the current session names.
 *
 * THE SESSION IS THE AUTHORIZATION, and it is why the link that created it is
 * treated as a credential — single-use, one hour, hashed at rest. See
 * `src/lib/auth/password-reset.ts`.
 *
 * No current password is asked for, because the user reached this page by
 * proving control of their inbox precisely to say that they do not have one.
 * A change-password form for a user who DOES know it should ask, and should
 * still call `updateMyPassword` underneath.
 *
 * No redirect on success: the form renders its own confirmation and a way
 * onward. A redirect would land the user on a page with no acknowledgement that
 * the thing they came to do actually happened.
 */
export async function resetPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  // Never echo a password back into the rendered HTML — the same rule
  // `signUpAction` follows. There are no `values` here at all for that reason.

  const fieldErrors: Record<string, string> = {};
  if (password === '') fieldErrors.password = 'Choose a new password.';
  else if (password.length < 8) fieldErrors.password = 'Passwords must be at least 8 characters.';
  else if (confirm !== password) fieldErrors.confirm = 'The two passwords do not match.';

  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors };
  }

  const actor = await getActor();
  try {
    await getDataClient().updateMyPassword(actor, password);
  } catch (error) {
    return toFormState(error);
  }

  // The header renders from the signed-in profile; nothing about it changes
  // here, but the session cookies may have been rotated by GoTrue during the
  // update, and re-rendering the layout is how the new pair reaches the browser.
  revalidatePath('/', 'layout');
  return { status: 'success' };
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
