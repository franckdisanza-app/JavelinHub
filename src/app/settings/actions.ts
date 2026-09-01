'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { banAuthUser } from '@/lib/auth/account-deletion';
import { destroyOtherSessions, destroySession, getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { CACHE_TAGS, invalidatePublicData } from '@/lib/data/cache-tags';
import { drainAll } from '@/lib/data/pagination';
import { isDataError } from '@/lib/data/types';
import { fieldError, formError, toFormState, type FormState } from '@/lib/forms';
import { consume, TOO_MANY_MESSAGE } from '@/lib/rate-limit';
import { checkAvatarFile, deleteAvatar, uploadAvatar } from '@/lib/storage/avatars';

const SETTINGS_PATH = '/settings';

/**
 * Account settings, for EVERYONE — coach, athlete or administrator.
 *
 * The counterpart to `coach/profile/actions.ts`, which edits the three columns
 * published through `public_coaches` and says of itself: "WHAT THIS PAGE IS NOT:
 * an account page. `full_name` and `email` live on `auth.users` / the
 * privilege-guarded part of `profiles`, and changing either is a different job."
 * This is that job.
 *
 * Every action here is gated by the data layer on the RESOLVED actor and takes
 * no subject id, so none of them can be pointed at another account — which is
 * the property that lets the page itself be a plain `requireUser()` rather than
 * a role check.
 */

/**
 * Renames the signed-in user.
 *
 * The name is published: it is on their card in the coach directory if they
 * have one, and on every review they have ever written. So this is a content
 * change and it revalidates the whole layout — the header renders it too.
 */
export async function updateNameAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const fullName = String(formData.get('fullName') ?? '').trim();
  const values = { fullName };

  // Cheap, friendly, field-level first. The data layer checks all of it again
  // with the same bounds — these exist to put a message beside the right input.
  if (fullName === '') return fieldError({ fullName: 'Enter your name.' }, values);
  if (fullName.length < 2) return fieldError({ fullName: 'Names are at least 2 characters.' }, values);
  if (fullName.length > 120) {
    return fieldError({ fullName: `Keep this to 120 characters or fewer — ${fullName.length} so far.` }, values);
  }

  const actor = await getActor();

  // The name is on every review byline and on the coach directory card, so a
  // rename is a public write like any other. Same budget as an offer edit.
  if (actor && !(await consume('writeUser', actor.userId))) {
    return formError(TOO_MANY_MESSAGE, values);
  }

  let needsLogin = false;
  try {
    await getDataClient().updateMyProfile(actor, { full_name: fullName });
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error, { values });
  }

  if (needsLogin) redirect(loginPath(SETTINGS_PATH));

  // Not confined to this page: the header, the coach directory card and every
  // review this person has written all render the name.
  // The display name and picture are on the coach directory card, the public
  // profile, and every review byline.
  await invalidatePublicData(CACHE_TAGS.coaches, CACHE_TAGS.reviews);
  revalidatePath('/', 'layout');
  return { status: 'success', values };
}

/**
 * Sets or clears the profile picture.
 *
 * MOVED HERE FROM `/coach/profile`, where it was reachable only by approved
 * coaches — although `setMyAvatar` has always been open to any signed-in user,
 * and its own doc comment said so: "`profiles` is everyone's row, and the SQL
 * agrees. Only the UI is coach-facing today." This is that sentence being
 * fixed.
 *
 * ORDER MATTERS IN BOTH DIRECTIONS, unchanged from the version this replaces:
 *
 *   setting   upload FIRST, then write the column. A failed upload leaves the
 *             column untouched and the old picture still rendering.
 *   clearing  write the column FIRST, then delete the object. A failed delete
 *             leaves an orphan that is invisible, which is why `deleteAvatar`
 *             does not throw.
 */
export async function updateAvatarAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const intent = String(formData.get('intent') ?? 'set');
  const actor = await getActor();

  /*
   * The upload budget, shared with the two delivery buckets. An avatar is the
   * smallest of the three at 2 MB — and the only one that is PUBLIC and served
   * from a CDN, so a replace loop is bytes stored, bytes served and a cache
   * entry per version. `clear` spends it too: it is the same control, and
   * exempting one intent only names the loop to use.
   */
  if (actor && !(await consume('uploadUser', actor.userId))) {
    return formError(TOO_MANY_MESSAGE);
  }

  let needsLogin = false;
  try {
    const db = getDataClient();

    /*
     * `getActor()` is a claim; the id the file is stored under must be the
     * RESOLVED one, because the first path segment is the ownership assertion
     * that every avatars storage policy checks.
     *
     * Read for BOTH branches now, not just the upload, because the row is also
     * where the OLD path comes from. It used to arrive as a hidden `current`
     * input — a client-chosen value naming an object to delete. The storage
     * policy pinned that to the caller's own folder so nobody could erase
     * somebody else's picture, but within their own folder a forged value
     * still deleted the wrong bytes. The profile knows which object it points
     * at; asking it costs one read and removes the question.
     */
    const me = await db.getProfile(actor, actor?.userId ?? '');
    if (!me) return formError('Your profile could not be found.');
    const previous = me.avatar_path ?? '';

    if (intent === 'clear') {
      await db.setMyAvatar(actor, null);
      if (previous !== '') await deleteAvatar(previous);
    } else {
      const file = formData.get('avatar');
      if (!(file instanceof File) || file.size === 0) return formError('Choose a picture to upload.');

      const check = checkAvatarFile(file);
      if (!check.ok) return formError(check.message ?? 'That picture could not be used.');

      const path = await uploadAvatar(me.id, file);
      await db.setMyAvatar(actor, path);
      // Only now is the old object unreachable through the product. The paths
      // are equal whenever the file type has not changed, since the object name
      // is derived from it — deleting then would remove what was just written.
      if (previous !== '' && previous !== path) await deleteAvatar(previous);
    }
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error);
  }

  if (needsLogin) redirect(loginPath(SETTINGS_PATH));

  // The picture is on the coach directory card and the coach profile page, so
  // this is not confined to settings either.
  // The display name and picture are on the coach directory card, the public
  // profile, and every review byline.
  await invalidatePublicData(CACHE_TAGS.coaches, CACHE_TAGS.reviews);
  revalidatePath('/', 'layout');
  return { status: 'success' };
}

/**
 * Starts a change of the sign-in address.
 *
 * NOTHING HAS CHANGED WHEN THIS RETURNS on Supabase, and the copy has to say so:
 * GoTrue mails the current address and the new one, and applies the change only
 * when both are confirmed. Telling somebody their address is updated when it is
 * not would send them to sign in with an address that does not work yet.
 *
 * The mock has no mail and changes it immediately, so the two arms of
 * `EmailChangeResult` get two different messages rather than one hedged one.
 *
 * RATE-LIMITED ON THE ACCOUNT, and this is the form where it matters most: each
 * attempt asks GoTrue to send TWO emails, against a project-wide quota that is
 * measured in a handful an hour. A loop here does not merely spam one person, it
 * takes password reset down for every user — the exact denial of service
 * `rate-limit.ts` was built for.
 */
export async function changeEmailAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get('email') ?? '').trim();
  const values = { email };

  if (email === '') return fieldError({ email: 'Enter the new email address.' }, values);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fieldError({ email: 'Enter a valid email address.' }, values);
  }

  const actor = await getActor();
  if (!actor) redirect(loginPath(SETTINGS_PATH));

  if (!(await consume('resetEmail', `change-email:${actor.userId}`))) {
    return { status: 'error', message: TOO_MANY_MESSAGE, values };
  }

  let sent = false;
  try {
    const result = await getDataClient().requestEmailChange(actor, email);
    sent = result.status === 'confirm_email';
  } catch (error) {
    if (!isDataError(error)) throw error;
    // `conflict` is "another account has that address", which belongs beside
    // the field rather than at form level.
    if (error.code === 'conflict' || error.code === 'invalid') {
      return { status: 'error', message: error.message, fieldErrors: { email: error.message }, values };
    }
    return toFormState(error, { values });
  }

  // The address is rendered in the header on neither backend, but `profiles`
  // is read by the layout and a mock change lands immediately.
  // The display name and picture are on the coach directory card, the public
  // profile, and every review byline.
  await invalidatePublicData(CACHE_TAGS.coaches, CACHE_TAGS.reviews);
  revalidatePath('/', 'layout');

  // The two arms carry different truths, so the form is told which one happened
  // rather than being left to guess from the backend.
  return { status: 'success', values: { email, pending: sent ? 'yes' : 'no' } };
}

/**
 * Changes the password of somebody who is signed in and knows the old one.
 *
 * NOT the reset flow. `resetPasswordAction` asks for no current password
 * because its user has just proved control of their inbox precisely to say that
 * they do not have one. Here a session alone is a weaker claim — a borrowed
 * laptop should not be enough to lock the owner out — so the old password is
 * the second factor.
 *
 * RATE-LIMITED ON THE ACCOUNT, not the IP. Verifying the current password costs
 * a scrypt derivation on the mock and a full sign-in round trip on Supabase, so
 * a wrong-password loop is expensive for us; and on Supabase it also consumes
 * GoTrue's own auth limit, which would eventually lock the account out of
 * ordinary sign-in as a side effect of guessing at this form.
 */
export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const current = String(formData.get('current') ?? '');
  const next = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  // No `values`: never echo a password back into rendered HTML.

  const fieldErrors: Record<string, string> = {};
  if (current === '') fieldErrors.current = 'Enter your current password.';
  if (next === '') fieldErrors.password = 'Choose a new password.';
  else if (next.length < 8) fieldErrors.password = 'Passwords must be at least 8 characters.';
  else if (confirm !== next) fieldErrors.confirm = 'The two passwords do not match.';

  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors };
  }

  const actor = await getActor();
  if (!actor) redirect(loginPath(SETTINGS_PATH));

  /*
   * Keyed on the user id rather than the address: this form belongs to a
   * session, so the account is the thing being attacked and the thing worth
   * protecting. It is not an enumeration risk either — the caller already knows
   * whose account they are signed in to.
   */
  if (!(await consume('loginEmail', `change-password:${actor.userId}`))) {
    return { status: 'error', message: TOO_MANY_MESSAGE };
  }

  try {
    await getDataClient().changeMyPassword(actor, current, next);
  } catch (error) {
    if (!isDataError(error)) throw error;
    // `forbidden` here means "that is not your current password", which belongs
    // beside that field rather than at form level.
    if (error.code === 'forbidden') {
      return { status: 'error', message: error.message, fieldErrors: { current: error.message } };
    }
    return toFormState(error);
  }

  /*
   * EVERY OTHER SESSION GOES. This form's own doc comment above already names
   * the case: "a borrowed laptop should not be enough to lock the owner out",
   * which is why the current password is required here. The mirror of that
   * argument is this line — someone who changes their password on the strength
   * of knowing it is very often doing so precisely because a session exists
   * somewhere they no longer control, and leaving those running makes the
   * change cosmetic.
   *
   * After the write, and it cannot fail this action — see
   * `destroyOtherSessions`.
   */
  await destroyOtherSessions();

  // GoTrue rotates the session's tokens as part of the change, and the layout
  // re-render is how the new pair reaches the browser.
  // The display name and picture are on the coach directory card, the public
  // profile, and every review byline.
  await invalidatePublicData(CACHE_TAGS.coaches, CACHE_TAGS.reviews);
  revalidatePath('/', 'layout');
  return { status: 'success' };
}

/**
 * Deletes the signed-in user's account.
 *
 * FIVE STEPS, IN THIS ORDER, and the order is the design:
 *
 *   1. **Withdraw their offers.** `delete_my_account()` refuses while any is
 *      still on sale, and it refuses because it physically cannot withdraw them
 *      itself: `guard_listing_update()` calls `auth.uid()`, which the privileged
 *      role owning that function cannot reach. So the withdrawal happens here,
 *      through the ordinary owner path where `auth.uid()` resolves — and the
 *      database enforces the ordering rather than trusting this comment.
 *   2. **Anonymise the profile**, through the RPC. From this moment
 *      `resolveProfile` refuses the account in both backends, so every method
 *      in the interface is closed to it.
 *   3. **Delete the avatar OBJECT.** See below — this step did not exist, and
 *      its absence left a photograph of a named person world-readable for ever.
 *   4. **Ban the GoTrue user**, which is the only thing that kills the
 *      credential — and which neither backend can do, because `auth.users`
 *      lives in a schema the privileged role holds no USAGE on.
 *   5. **Drop the session**, so the browser is not left holding a cookie for an
 *      account that no longer answers.
 *
 * -----------------------------------------------------------------------------
 * WHY STEP 3 EXISTS, AND WHY IT HAS TO BE EXACTLY HERE
 * -----------------------------------------------------------------------------
 * `delete_my_account()` sets `avatar_path` to NULL. It cannot do more: it is a
 * SQL function and the file lives in object storage. Nothing else deleted it
 * either — so the bytes stayed in the **public** `avatars` bucket at
 * `<uuid>/avatar.<ext>`, a path anyone who had ever loaded the person's card
 * already knew, readable by the whole internet after an explicit deletion
 * request. And the user could not clean it up afterwards even in principle:
 * `avatars_delete_own` requires `auth.uid()` to match the folder, and step 4
 * has just killed their credential. The only remaining route was an operator
 * with direct storage access.
 *
 * AFTER the RPC, not before. If it ran first and the RPC then refused — an
 * offer still on sale, an administrator account — the account would survive
 * with `avatar_path` pointing at bytes that are gone, which is a broken image
 * on a live profile. Running it after means the column is already NULL, so a
 * failed delete leaves an orphan that is invisible rather than a live row
 * pointing at nothing. That is the same ordering rule `updateAvatarAction`
 * states for clearing a picture, applied to the one flow that had missed it.
 *
 * BEFORE the ban, so the storage policy still admits the caller on the session
 * that is about to end.
 *
 * WHAT THIS DOES NOT REMOVE, stated rather than implied: files the user
 * uploaded against an ORDER. Those live in the private `deliverables` bucket,
 * are readable only by the two parties the order names, and are half of a
 * record of work that was delivered and paid attention to — deleting one side
 * of an exchange the other party still holds is a different decision, and it
 * belongs with the order lifecycle rather than here.
 *
 * STEP 4 IS NOT ALLOWED TO FAIL THE FLOW. By the time it runs the profile is
 * already anonymised and there is no going back; refusing to finish would leave
 * somebody with an account that has lost its name and its picture and still
 * lets them in. `banAuthUser` reports its own failure and returns false.
 *
 * THE CONFIRMATION IS THE WORD "DELETE", typed. Not a checkbox: this is the one
 * irreversible action in the product, and the deliberate friction is the point.
 */
export async function deleteAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const typed = String(formData.get('confirm') ?? '').trim();
  if (typed.toLowerCase() !== 'delete') {
    return {
      status: 'error',
      message: 'Type DELETE to confirm.',
      fieldErrors: { confirm: 'Type DELETE to confirm.' },
    };
  }

  const actor = await getActor();
  if (!actor) redirect(loginPath(SETTINGS_PATH));

  const db = getDataClient();

  /*
   * Read the object path BEFORE anything else touches the profile, because
   * step 2 is what erases it: `delete_my_account()` sets `avatar_path` to NULL,
   * and after that there is nothing left to tell us which object to delete.
   *
   * A failure to read it is not a reason to refuse the deletion — the account
   * still goes, and the worst outcome is the orphan this step exists to
   * prevent. So it is best-effort, exactly like the delete it feeds.
   */
  let avatarPath: string | null = null;
  try {
    avatarPath = (await db.getProfile(actor, actor.userId))?.avatar_path ?? null;
  } catch (error) {
    if (!isDataError(error)) throw error;
  }

  try {
    /*
     * Step 1. Sequential rather than `Promise.all`: each withdrawal fires the
     * revision trigger and the guard, and a burst of concurrent updates to one
     * coach's rows is a lock-ordering problem for no gain — there are never
     * many.
     *
     * Only the ones still on sale. `listMyListings` is the read that does not
     * filter `deleted_at`, so it sees the already-withdrawn ones too, and
     * `softDeleteListing` would answer `conflict` for those.
     */
    // EVERY page, not the first. `delete_my_account()` refuses while any offer
    // is still on sale, so a partial sweep would empty most of the shop and
    // then fail — see `drainAll`.
    const mine = await drainAll((page) => db.listMyListings(actor, page));
    for (const listing of mine) {
      if (listing.deleted_at === null) await db.softDeleteListing(actor, listing.id);
    }

    // Step 2.
    await db.deleteMyAccount(actor);
  } catch (error) {
    if (!isDataError(error)) throw error;
    if (error.code === 'unauthorized') redirect(loginPath(SETTINGS_PATH));
    // `forbidden` is the administrator refusal; `invalid` is an offer still on
    // sale, which step 1 should have prevented and which is worth surfacing
    // verbatim if it somehow did not.
    return toFormState(error);
  }

  /*
   * Step 3. The column is already NULL, so the picture is gone as far as the
   * product is concerned; this is what makes it gone as far as the internet is
   * concerned. `deleteAvatar` never throws and is a no-op on the mock backend,
   * which has no object storage at all.
   *
   * It runs while the session is still alive, because `avatars_delete_own`
   * authorises on `auth.uid()` matching the folder — after step 4 the caller
   * has no credential to present.
   */
  if (avatarPath !== null && avatarPath !== '') await deleteAvatar(avatarPath);

  // Step 4. Deliberately outside the try: a failure here is reported inside
  // `banAuthUser` and must not undo or block what has already happened.
  await banAuthUser(actor.userId);

  // Step 5.
  await destroySession();
  // The display name and picture are on the coach directory card, the public
  // profile, and every review byline.
  await invalidatePublicData(CACHE_TAGS.coaches, CACHE_TAGS.reviews);
  revalidatePath('/', 'layout');
  redirect('/?deleted=1');
}
