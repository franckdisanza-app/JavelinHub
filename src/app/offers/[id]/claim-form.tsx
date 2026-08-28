'use client';

import { useActionState } from 'react';

import { claimOfferAction } from '@/app/offers/[id]/claim-actions';
import { Button } from '@/components/ui/button';
import { idleFormState } from '@/lib/forms';

/**
 * The claim control.
 *
 * A POST form, never a link: it creates a row. `sameSite: 'lax'` on the session
 * cookie means a cross-site POST does not carry it, which a GET would not give
 * us.
 *
 * There is no confirmation step, and that is right while claiming is free and
 * one-per-learner — the worst outcome is an order the learner did not want, on
 * an offer they cannot claim twice anyway. **When this costs money it needs
 * one**, and the button needs to say the amount.
 */
export function ClaimForm({
  listingId,
  title,
  disabled,
  disabledReason,
}: {
  listingId: string;
  title: string;
  /** True when the viewer cannot claim — their own offer, or already claimed. */
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, formAction, pending] = useActionState(claimOfferAction, idleFormState);

  if (disabled) {
    return (
      <div>
        <Button type="button" disabled className="w-full" aria-describedby="claim-disabled-note">
          Claim
        </Button>
        {disabledReason ? (
          <p id="claim-disabled-note" className="mt-2 text-xs leading-relaxed text-faint">
            {disabledReason}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="listingId" value={listingId} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Claiming…' : 'Claim'}
        <span className="sr-only"> {title}</span>
      </Button>
      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
