'use client';

import { useActionState } from 'react';

import { restoreOfferAction, withdrawOfferAction } from '@/app/coach/offers/actions';
import { Button } from '@/components/ui/button';
import { idleFormState } from '@/lib/forms';

/**
 * The withdraw / restore controls.
 *
 * Both are POST forms rather than links, for the same reason logging out is: a
 * GET that changes state is followed by link prefetchers, browser scanners and
 * `<img src>` tags on other sites. `sameSite: 'lax'` on the session cookie means
 * a cross-site POST does not carry it, so the form is safe where a link is not.
 *
 * The offer title goes into the accessible name of every button here. A
 * dashboard is a list of near-identical controls, and "Withdraw" on its own is
 * indistinguishable from the eleven other Withdraw buttons to anyone navigating
 * by control rather than by row.
 */

export function WithdrawOfferForm({ id, title }: { id: string; title: string }) {
  const [state, formAction, pending] = useActionState(withdrawOfferAction, idleFormState);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1.5">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="danger" size="sm" disabled={pending}>
        {pending ? 'Withdrawing…' : 'Withdraw'}
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

export function RestoreOfferForm({ id, title }: { id: string; title: string }) {
  const [state, formAction, pending] = useActionState(restoreOfferAction, idleFormState);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1.5">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? 'Restoring…' : 'Put back on sale'}
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
