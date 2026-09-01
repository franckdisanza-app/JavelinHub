'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { CACHE_TAGS, invalidatePublicData } from '@/lib/data/cache-tags';
import { COACH_BIO_MAX, COACH_HEADLINE_MAX, COACH_YEARS_COACHING_MAX, isDataError } from '@/lib/data/types';
import { fieldError, formError, toFormState, type FormState } from '@/lib/forms';
import { consume, TOO_MANY_MESSAGE } from '@/lib/rate-limit';

const PROFILE_PATH = '/coach/profile';

/**
 * Saves the signed-in coach's own public profile.
 *
 * Three columns and no others: `coach_headline`, `coach_bio`,
 * `coach_years_coaching`. `updateMyCoachProfile` writes exactly those, always
 * for the resolved actor and never for a subject named in the request, and
 * `guard_profile_privilege_columns` in Postgres refuses any attempt to reach
 * `role`, `coach_status`, `id` or `email` from an API session. So there is
 * nothing to filter here — the shape of the call is the protection.
 *
 * A Server Action is a public HTTP endpoint, so this never assumes the page's
 * approval check ran. `updateMyCoachProfile` resolves the actor itself and
 * throws `forbidden` for anyone who is not an approved coach.
 */
export async function updateCoachProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const headline = String(formData.get('headline') ?? '').trim();
  const bio = String(formData.get('bio') ?? '').trim();
  const years = String(formData.get('years') ?? '').trim();
  const values = { headline, bio, years };

  const fieldErrors: Record<string, string> = {};

  if (headline.length > COACH_HEADLINE_MAX) {
    fieldErrors.headline = `Keep this to ${COACH_HEADLINE_MAX} characters or fewer — ${headline.length} so far.`;
  }
  if (bio.length > COACH_BIO_MAX) {
    fieldErrors.bio = `Keep this to ${COACH_BIO_MAX} characters or fewer — ${bio.length} so far.`;
  }

  const parsedYears = parseYears(years);
  if (parsedYears === 'invalid') {
    fieldErrors.years = 'Years coaching must be a whole number.';
  } else if (parsedYears !== null && (parsedYears < 0 || parsedYears > COACH_YEARS_COACHING_MAX)) {
    fieldErrors.years = `Years coaching must be between 0 and ${COACH_YEARS_COACHING_MAX}.`;
  }

  if (Object.keys(fieldErrors).length > 0) return fieldError(fieldErrors, values);

  const actor = await getActor();

  // Three columns published through `public_coaches` — the headline and bio on
  // every card in the directory. Same budget as an offer edit, and spent after
  // validation so a too-long bio does not cost the attempt that shortens it.
  if (actor && !(await consume('writeUser', actor.userId))) {
    return formError(TOO_MANY_MESSAGE, values);
  }

  let needsLogin = false;
  try {
    await getDataClient().updateMyCoachProfile(actor, {
      // Empty means "not stated", and the data layer stores NULL for it. This
      // is the ONLY way to clear a field, so trimming to '' has to reach the
      // call rather than being skipped as "no change" — otherwise a coach could
      // add a headline and never remove one.
      coach_headline: headline === '' ? null : headline,
      coach_bio: bio === '' ? null : bio,
      coach_years_coaching: parsedYears === 'invalid' ? null : parsedYears,
    });
  } catch (error) {
    if (!isDataError(error)) throw error;
    // Deferred: `redirect()` works by throwing, so it must not be called from
    // inside this `catch` — the same pattern as `coach/apply/actions.ts`.
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error, { values, fieldFor: guessCoachProfileField });
  }

  if (needsLogin) redirect(loginPath(PROFILE_PATH));

  // The three columns are published through `public_coaches`, so the directory
  // and this coach's public page are both stale now. `'/'`+`'layout'` covers
  // every route under the root layout, which is all of them.
  // The headline and bio are the coach's card in the directory and the top of
  // their public profile.
  await invalidatePublicData(CACHE_TAGS.coaches);
  revalidatePath('/', 'layout');

  // Redirect rather than returning a success state, for the reason given in
  // `coach/apply/actions.ts`: the outcome then lives in the URL, so it survives
  // a refresh and does not depend on `useActionState` holding a value across a
  // revalidation that re-renders the page underneath it.
  redirect(`${PROFILE_PATH}?saved=1`);
}

/**
 * `''` -> `null` ("not stated"), a whole number -> that number, anything else
 * -> `'invalid'`.
 *
 * NULL AND 0 ARE DIFFERENT ANSWERS and both are legal — `null` renders as
 * nothing, `0` renders as a first season coaching. `docs/DATA-LAYER.md` calls
 * this out under "Zero years is not the same as no years", and it is the reason
 * this is not written as a falsy check: `Number('') === 0` would silently
 * convert every coach who left the field blank into one who claims zero years.
 */
function parseYears(raw: string): number | null | 'invalid' {
  if (raw === '') return null;
  if (!/^\d+$/.test(raw)) return 'invalid';
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

/**
 * The data layer returns one human sentence rather than a field name, so
 * attaching it to an input is a caller-side heuristic — see the matching note
 * in `coach/apply/actions.ts`. Only `invalid` is ever field-attributable: a
 * `forbidden` ("Only approved coaches have a public coach profile to edit.") is
 * about the account and belongs at form level.
 */
function guessCoachProfileField(message: string, code: string): string | null {
  if (code !== 'invalid') return null;
  const text = message.toLowerCase();
  if (text.startsWith('headline')) return 'headline';
  if (text.startsWith('bio')) return 'bio';
  if (text.startsWith('years')) return 'years';
  return null;
}

