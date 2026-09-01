'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getActor, loginPath } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { CACHE_TAGS, invalidatePublicData } from '@/lib/data/cache-tags';
import { REVIEW_REPLY_MAX, isDataError } from '@/lib/data/types';
import { formError, toFormState, type FormState } from '@/lib/forms';
import { consume, TOO_MANY_MESSAGE } from '@/lib/rate-limit';

/**
 * Publishing a coach's answer to a review.
 *
 * OUTSIDE `app/`, for the reason `lib/reports/actions.ts` gives about itself:
 * the form that calls this renders on two surfaces — an offer's own page and,
 * when it lands, the coach's profile — so hanging the action off one of those
 * routes would make the other import across the app tree to reach it.
 *
 * NOTHING HERE IS THE AUTHORIZATION. A Server Action is a public HTTP endpoint,
 * so this never assumes the page decided whether to render the form:
 * `createReviewReply` resolves the actor itself, reads the review, reads the
 * listing behind it and refuses anybody who does not own that offer — and
 * `review_replies_insert_coach` refuses a third time in Postgres. What is here
 * is the parsing, the budget and the message.
 */
export async function replyToReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const reviewId = String(formData.get('reviewId') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  const values = { body };

  if (reviewId === '') return formError('That review could not be found.');

  // Cheap and field-level first, so the message lands beside the box. The data
  // layer checks the same bounds, and `review_replies_body_length` in 0032
  // checks them a third time — this exists to say "3 so far" rather than
  // "Reply is required."
  if (body === '') {
    return { status: 'error', message: 'Write a reply first.', fieldErrors: { body: 'Write a reply first.' }, values };
  }
  if (body.length < 3) {
    return { status: 'error', message: 'Please write at least 3 characters.', fieldErrors: { body: 'Please write at least 3 characters.' }, values };
  }
  if (body.length > REVIEW_REPLY_MAX) {
    return {
      status: 'error',
      message: `Keep this to ${REVIEW_REPLY_MAX} characters or fewer — ${body.length} so far.`,
      fieldErrors: { body: `Keep this to ${REVIEW_REPLY_MAX} characters or fewer — ${body.length} so far.` },
      values,
    };
  }

  const actor = await getActor();
  if (!actor) redirect(loginPath('/offers'));

  /*
   * `writeUser`, the same budget an offer edit spends, and for the same reason:
   * this publishes text onto a page a stranger reads. It is not `reportUser` —
   * that budget is for a queue an administrator has to work through, and the
   * two should not be able to exhaust each other.
   *
   * The UNIQUE constraint already caps replies at one per review, so this is
   * not what stops a flood against a single review; it is what stops one
   * account answering every review on the site in a loop.
   */
  if (!(await consume('writeUser', actor.userId))) {
    return formError(TOO_MANY_MESSAGE, values);
  }

  try {
    await getDataClient().createReviewReply(actor, reviewId, body);
  } catch (error) {
    if (!isDataError(error)) throw error;
    // `unauthorized` cannot reach here — the actor was resolved above — so
    // there is no deferred redirect to arrange, unlike `reportReviewAction`.
    return toFormState(error, { values });
  }

  /*
   * A reply renders under a review on the offer page and on the coach profile,
   * both of which are cached public reads. `CACHE_TAGS.reviews` is the tag both
   * review lists carry; a reply is part of what those lists render, so it is
   * the right tag even though no row in `reviews` changed.
   *
   * NOT `CACHE_TAGS.stats`: a reply feeds no aggregate. It is not in
   * `offer_stats`, not in `coach_stats`, and it moves no rating — expiring the
   * stats tag here would throw away a cache entry nothing invalidated.
   */
  await invalidatePublicData(CACHE_TAGS.reviews);
  revalidatePath('/', 'layout');

  return { status: 'success', message: 'Your reply is published.' };
}
