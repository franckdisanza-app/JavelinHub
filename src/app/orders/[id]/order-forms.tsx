'use client';

import { useActionState } from 'react';

import {
  addDeliverableAction,
  createReviewAction,
  removeDeliverableAction,
} from '@/app/orders/[id]/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { idleFormState } from '@/lib/forms';

/**
 * Send a file against this order.
 *
 * Deliberately the SAME control for both parties. A learner attaching their
 * throw and a coach returning the analysis are the same operation on the same
 * order, and the direction is derived from who is signed in — so there is one
 * form, one action and one set of rules rather than two that could drift.
 * `label` and `hint` differ only to make the page read sensibly.
 */
export function SendFileForm({
  orderId,
  label,
  hint,
  disabled,
}: {
  orderId: string;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(addDeliverableAction, idleFormState);

  if (disabled) return null;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}
      <Field id={`file-${orderId}`} label={label} hint={hint}>
        <Input
          id={`file-${orderId}`}
          name="file"
          type="file"
          required
          accept=".pdf,.png,.jpg,.jpeg,.webp,.mp4,.mov,.txt,.csv,.xlsx"
          aria-describedby={fieldDescribedBy(`file-${orderId}`, { hint: true })}
        />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send file'}
        </Button>
      </div>
    </form>
  );
}

/** Removes one of your own files. A POST, never a link — it deletes. */
export function RemoveFileForm({
  orderId,
  deliverableId,
  path,
  fileName,
}: {
  orderId: string;
  deliverableId: string;
  path: string;
  fileName: string;
}) {
  const [state, formAction, pending] = useActionState(removeDeliverableAction, idleFormState);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="deliverableId" value={deliverableId} />
      <input type="hidden" name="path" value={path} />
      <Button type="submit" variant="danger" size="sm" disabled={pending}>
        {pending ? 'Removing…' : 'Remove'}
        <span className="sr-only"> {fileName}</span>
      </Button>
      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The buyer's review.
 *
 * Rendered only for the buyer, and only once — `createReview` refuses a second
 * review of the same purchase, and the page stops offering the form after the
 * first. A rating is 1-5 and there is no zero: `rating_average === null` is how
 * "no reviews" is told apart from a bad score, so a zero must be unreachable.
 */
export function ReviewForm({ orderId, offerTitle }: { orderId: string; offerTitle: string }) {
  const [state, formAction, pending] = useActionState(createReviewAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="orderId" value={orderId} />
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field id="rating" label="Rating" hint="1 is poor, 5 is excellent." error={errors.rating}>
        <Select
          id="rating"
          name="rating"
          defaultValue={state.values?.rating ?? ''}
          invalid={Boolean(errors.rating)}
          aria-describedby={fieldDescribedBy('rating', { hint: true, error: errors.rating })}
        >
          <option value="">Choose a rating…</option>
          <option value="5">5 — excellent</option>
          <option value="4">4 — good</option>
          <option value="3">3 — fine</option>
          <option value="2">2 — poor</option>
          <option value="1">1 — bad</option>
        </Select>
      </Field>

      <Field
        id="body"
        label="Your review"
        hint="What you got, and whether it helped. Other throwers read this."
        error={errors.body}
      >
        <Textarea
          id="body"
          name="body"
          rows={5}
          maxLength={2000}
          defaultValue={state.values?.body ?? ''}
          invalid={Boolean(errors.body)}
          placeholder={`How did "${offerTitle}" go?`}
          aria-describedby={fieldDescribedBy('body', { hint: true, error: errors.body })}
        />
      </Field>

      <div>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Publishing…' : 'Publish review'}
        </Button>
      </div>
    </form>
  );
}
