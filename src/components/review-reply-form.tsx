'use client';

import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { REVIEW_REPLY_MAX } from '@/lib/data/types';
import { idleFormState } from '@/lib/forms';
import { replyToReviewAction } from '@/lib/reviews/actions';

/**
 * The coach's reply box, under a review of their own offer.
 *
 * COLLAPSED BY DEFAULT, exactly like `ReportForm` beside it and for the same
 * reason: these sit under a stranger's words on a page whose job is to be read,
 * and two always-open forms per review would bury the reviews themselves. The
 * button is the whole affordance until somebody wants it.
 *
 * -----------------------------------------------------------------------------
 * THE WARNING IS THE MOST IMPORTANT ELEMENT HERE
 * -----------------------------------------------------------------------------
 * A published reply cannot be edited or deleted by its author — 0032 grants no
 * UPDATE policy to any role and no DELETE to any client role, which is the same
 * rule `reviews` has followed since 0016. That is an unusual and unforgiving
 * property, and a coach who discovers it *after* publishing something they
 * regret has been badly served by this form.
 *
 * So it is stated before the box rather than after it, in the body face at
 * full size rather than as a hint — and the submit button says
 * &ldquo;Publish reply&rdquo; rather than &ldquo;Save&rdquo;, because saving
 * sounds reversible and this is not.
 *
 * NOTHING HERE IS A SECURITY BOUNDARY. The caller decides whether to render
 * this at all; `createReviewReply` refuses anyone who does not own the offer,
 * and `review_replies_insert_coach` refuses a third time in Postgres.
 */
export function ReviewReplyForm({ reviewId, authorName }: { reviewId: string; authorName: string }) {
  const [state, formAction, pending] = useActionState(replyToReviewAction, idleFormState);
  const [open, setOpen] = useState(false);

  const bodyId = `reply-body-${reviewId}`;
  const bodyError = state.fieldErrors?.body;

  /*
   * Success is terminal and the form does not come back. The UNIQUE constraint
   * means a second reply is refused anyway, and the page revalidation renders
   * the real reply above this — so leaving an empty box open would invite a
   * submission that can only fail.
   */
  if (state.status === 'success') {
    return <p className="text-body-15 text-success">{state.message ?? 'Your reply is published.'}</p>;
  }

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Reply
          <span className="sr-only"> to the review by {authorName}</span>
        </Button>
        {/* A failure survives the panel closing, so nobody is left believing a
            refused reply was published. */}
        {state.status === 'error' && state.message ? (
          <p role="alert" className="text-xs font-medium text-danger">
            {state.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex w-full flex-col gap-4 border border-rule p-3">
      <input type="hidden" name="reviewId" value={reviewId} />

      <p className="text-body-15 leading-relaxed text-muted">
        Your reply is published under your name, underneath this review, for anyone who reads the offer.{' '}
        <strong className="text-ink">
          It cannot be edited or deleted afterwards, by you or by anybody else.
        </strong>{' '}
        Only an administrator can take one down.
      </p>

      <Field
        id={bodyId}
        label="Your reply"
        hint={`Up to ${REVIEW_REPLY_MAX} characters.`}
        error={bodyError}
      >
        <Textarea
          id={bodyId}
          name="body"
          rows={4}
          maxLength={REVIEW_REPLY_MAX}
          defaultValue={state.values?.body ?? ''}
          invalid={Boolean(bodyError)}
          aria-describedby={fieldDescribedBy(bodyId, { hint: true, error: bodyError })}
        />
      </Field>

      {state.status === 'error' && state.message && !bodyError ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {/* Not "Save". See the header — the word has to carry the finality. */}
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Publishing…' : 'Publish reply'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
