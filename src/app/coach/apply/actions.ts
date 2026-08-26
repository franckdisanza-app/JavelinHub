'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { isDataError } from '@/lib/data/types';
import { fieldError, toFormState, type FormState } from '@/lib/forms';

const APPLY_PATH = '/coach/apply';

/**
 * Mirrors the data layer's own limits (`requireText(bio, 'Bio', 2000, 20)` and
 * friends in `mockClient.ts`) so the user gets a sentence that names the actual
 * problem. The data layer's message for a too-short bio is "Bio is required.",
 * which is accurate but unhelpful when they typed nineteen characters.
 *
 * These checks are a *presentation* nicety, not the validation: the call below
 * happens regardless and its `invalid` is rendered verbatim if it disagrees.
 */
const MIN_TEXT = 20;
const MAX_TEXT = 2000;

/**
 * Files the signed-in actor's coach application.
 *
 * A Server Action is an HTTP endpoint, so this never assumes the page's
 * `requireUser()` ran: `createCoachApplication` resolves the actor itself and
 * throws `unauthorized` for an anonymous caller, `conflict` when they already
 * have a pending application or are already approved. The profile move to
 * `coach_status: 'pending_review'` happens *inside* that call, atomically with
 * the insert — there is deliberately no profile write here.
 */
export async function applyToCoachAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const bio = String(formData.get('bio') ?? '').trim();
  const experience = String(formData.get('experience') ?? '').trim();
  // `sport` is deliberately not read. The field is gone from the form (one
  // sport, one answer), and a Server Action is a public endpoint — so ignoring
  // the key outright is what stops a crafted POST writing a value the product
  // no longer has any way to display or correct.
  const values = { bio, experience };

  const fieldErrors: Record<string, string> = {};
  addTextError(fieldErrors, 'bio', bio, 'A short bio');
  addTextError(fieldErrors, 'experience', experience, 'Your coaching experience');
  if (Object.keys(fieldErrors).length > 0) return fieldError(fieldErrors, values);

  const actor = await getActor();

  let needsLogin = false;
  try {
    // `sport` is omitted, not sent as ''. `createCoachApplication` still
    // accepts the field — the column exists and the data layer is not this
    // round's to reshape — and stores NULL when it is absent.
    await getDataClient().createCoachApplication(actor, { bio, experience });
  } catch (error) {
    if (!isDataError(error)) throw error;
    // Deferred: `redirect()` throws, and it must not be thrown from inside this
    // `catch` — see the same pattern in `app/redeem/actions.ts`.
    if (error.code === 'unauthorized') needsLogin = true;
    else return toFormState(error, { values, fieldFor: guessApplicationField });
  }

  if (needsLogin) redirect(loginPath(APPLY_PATH));

  // `coach_status` is now `pending_review`, which changes the nav: "Become a
  // coach" is no longer the right link for this user.
  revalidatePath('/', 'layout');

  // Redirect rather than return a success state, for the reason spelled out in
  // `app/redeem/actions.ts`: the revalidation re-renders this page, which now
  // sees a pending applicant and swaps the form out — taking any message held
  // in `useActionState` with it. The URL carries the outcome instead, so it
  // also survives a refresh.
  redirect(`${APPLY_PATH}?submitted=1`);
}

function addTextError(into: Record<string, string>, field: string, value: string, label: string): void {
  if (value === '') {
    into[field] = `${label} is required.`;
  } else if (value.length < MIN_TEXT) {
    into[field] = `Please write at least ${MIN_TEXT} characters — ${value.length} so far.`;
  } else if (value.length > MAX_TEXT) {
    into[field] = `Keep this to ${MAX_TEXT} characters or fewer — ${value.length} so far.`;
  }
}

/**
 * The data layer returns one human sentence rather than a machine-readable
 * field name, so attaching it to an input is a caller-side heuristic. Only
 * `invalid` is ever field-attributable: a `conflict` ("You already have an
 * application awaiting review.") is about the account, not about an input, and
 * belongs at form level where it is not hidden under a textarea.
 */
function guessApplicationField(message: string, code: string): string | null {
  if (code !== 'invalid') return null;
  const text = message.toLowerCase();
  if (text.startsWith('bio')) return 'bio';
  if (text.startsWith('experience')) return 'experience';
  return null;
}
