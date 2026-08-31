'use client';

import { useActionState, useState } from 'react';

import { removeReviewAction } from '@/app/admin/reviews/actions';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';

/**
 * Takes one review down.
 *
 * TWO STEPS ON PURPOSE, and it is the only destructive control in this app that
 * has them. Withdrawing an offer is reversible and a review removal is not: the
 * row is deleted, the author is not told, and the only thing left is an archive
 * entry that visitors never see. A single-click Remove beside a wall of text is
 * a misclick waiting to happen, and the misclick is unrecoverable through the
 * product.
 *
 * So the button reveals a panel, the panel asks for a reason, and the reason
 * field is where the moderator's attention lands before the confirm. That is
 * also why the reason is OPTIONAL rather than required — the point is the pause,
 * not the paperwork, and a mandatory field just teaches people to type "spam".
 *
 * The confirmation lives here rather than in the action because a Server Action
 * has no way to ask a question. The action is what actually authorises.
 */
export function RemoveReviewForm({ reviewId, authorName }: { reviewId: string; authorName: string }) {
  const [state, formAction, pending] = useActionState(removeReviewAction, idleFormState);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
          Remove<span className="sr-only"> the review by {authorName}</span>
        </Button>
        {/*
          A failure from a previous attempt survives the panel closing, so the
          moderator is not left thinking a refused removal succeeded.
        */}
        {state.status === 'error' && state.message ? (
          <p role="alert" className="text-xs font-medium text-danger">
            {state.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex w-full flex-col gap-3 border border-danger p-3">
      <input type="hidden" name="id" value={reviewId} />

      <p className="text-sm leading-relaxed text-ink">
        <strong className="font-semibold">This deletes the review.</strong> It stops counting towards the
        offer&rsquo;s rating and the coach&rsquo;s, disappears from every page, and cannot be put back. A copy
        is kept in the removal log below.
      </p>

      <Field
        id={`reason-${reviewId}`}
        label="Reason"
        optional
        hint="For the log, not for the author — they are not notified. Up to 1000 characters."
      >
        <Textarea
          id={`reason-${reviewId}`}
          name="reason"
          rows={2}
          maxLength={1000}
          placeholder="e.g. Names a third party and repeats a private phone number."
          aria-describedby={fieldDescribedBy(`reason-${reviewId}`, { hint: true })}
        />
      </Field>

      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" size="sm" disabled={pending}>
          {pending ? 'Removing…' : 'Remove it'}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
