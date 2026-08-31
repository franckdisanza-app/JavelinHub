'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { isDataError, isReportReason } from '@/lib/data/types';
import { formError, type FormState } from '@/lib/forms';
import { consume, TOO_MANY_MESSAGE } from '@/lib/rate-limit';

/**
 * Filing a report, for both subjects.
 *
 * ONE FILE RATHER THAN TWO, and outside `app/` for the same reason
 * `lib/auth/actions.ts` is: these two actions are used from three routes — the
 * offer page, the coach profile, and any page that later renders a review — so
 * hanging them off one of those routes would make the other two import across
 * the app tree to reach it.
 *
 * The shape of both is identical because the difference between them is an
 * entitlement rather than a form: only the coach whose offer a review is about
 * may report the review, and anybody signed in may report a coach. Neither of
 * those rules is checked here — `reportReview` refuses through a JOIN it can
 * see and this action cannot, and `report_review()` in Postgres refuses a third
 * time. What is here is the parsing, the limiter and the message.
 */

/**
 * Per USER rather than per IP, which is the opposite of `redeemInviteAction`
 * and deliberate. Reporting requires an account, signup is already limited per
 * IP, and the database's partial unique index caps repeats against any one
 * subject at one open report — so the account is the scarce thing here, and an
 * IP key would instead punish everybody behind one office router.
 */
async function withinLimit(userId: string): Promise<boolean> {
  return consume('reportUser', userId);
}

export async function reportReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return file(formData, 'review');
}

export async function reportCoachAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return file(formData, 'coach');
}

async function file(formData: FormData, subject: 'review' | 'coach'): Promise<FormState> {
  const id = String(formData.get('id') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  const rawNote = String(formData.get('note') ?? '').trim();
  // Trimmed to null rather than sent as an empty string: the column is nullable
  // and "no note" is a different fact from "the note is blank".
  const note = rawNote === '' ? null : rawNote;

  if (id === '') {
    return formError(subject === 'review' ? 'That review could not be found.' : 'That coach could not be found.');
  }
  if (!isReportReason(reason)) {
    return { status: 'error', message: 'Choose a reason.', fieldErrors: { reason: 'Choose a reason.' }, values: { note: rawNote } };
  }
  if (rawNote.length > 2000) {
    return formError(`Keep the note to 2000 characters or fewer — ${rawNote.length} so far.`, { note: rawNote });
  }

  const actor = await getActor();
  // The path a signed-out visitor is sent back to. Computed before the limiter
  // so an anonymous caller cannot spend somebody else's budget.
  if (!actor) redirect(loginPath(subject === 'review' ? '/offers' : `/coaches/${id}`));

  if (!(await withinLimit(actor.userId))) {
    return formError(TOO_MANY_MESSAGE, { note: rawNote });
  }

  const db = getDataClient();
  let needsLogin = false;
  try {
    if (subject === 'review') await db.reportReview(actor, id, reason, note);
    else await db.reportCoach(actor, id, reason, note);
  } catch (error) {
    if (!isDataError(error)) throw error;
    // Deferred: `redirect()` throws, and throwing from inside a `catch` nested
    // in a wider `try` is easy to get wrong. Same shape as `redeemInviteAction`.
    if (error.code === 'unauthorized') needsLogin = true;
    else return formError(error.message, { note: rawNote });
  }

  if (needsLogin) redirect(loginPath(subject === 'review' ? '/offers' : `/coaches/${id}`));

  // Nothing a visitor sees has changed — a report is invisible until an
  // administrator acts on it — so this revalidates only the reporter's own
  // list, where the new row belongs.
  revalidatePath('/settings');

  return { status: 'success', message: 'Thank you. An administrator will look at this.' };
}
