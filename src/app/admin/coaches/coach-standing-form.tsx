'use client';

import { useActionState, useState } from 'react';

import { restoreCoachListingAction, setCoachStandingAction } from '@/app/admin/coaches/actions';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';
import type { CoachStatus } from '@/lib/data/types';

export interface CoachStandingFormProps {
  coachId: string;
  coachName: string;
  status: CoachStatus;
  /** How many of their offers are on sale right now — named in the confirmation. */
  onSale: number;
}

/**
 * Suspend, demote, reinstate.
 *
 * TWO STEPS, like `RemoveReviewForm` and unlike `ResolveReportForm`. Suspending
 * takes every offer the coach has on sale down, and an administrator's takedown
 * is one the coach cannot lift themselves — so a single click here empties
 * somebody's shop and hands the only key to whoever clicked. The panel says how
 * many offers that is, by number, before the confirm.
 *
 * The reason is OPTIONAL for the reason the removal form gives: the point of the
 * second step is the pause, not the paperwork, and a mandatory field only
 * teaches people to type "spam".
 *
 * Reinstating is the one path with no confirmation. It takes nothing away —
 * their offers stay down until an administrator puts each one back — so there is
 * nothing here to misclick into.
 */
export function CoachStandingForm({ coachId, coachName, status, onSale }: CoachStandingFormProps) {
  const [state, formAction, pending] = useActionState(setCoachStandingAction, idleFormState);
  const [confirming, setConfirming] = useState<'suspended' | 'none' | null>(null);
  const reasonId = `standing-reason-${coachId}`;

  const suspended = status === 'suspended';

  if (state.status === 'success') {
    return (
      <p role="status" className="text-body-15 leading-relaxed text-success">
        {state.message}
      </p>
    );
  }

  if (confirming === null) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {suspended ? (
            // A plain single-step form: reinstating is not destructive.
            <form action={formAction}>
              <input type="hidden" name="coachId" value={coachId} />
              <input type="hidden" name="status" value="approved" />
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? 'Saving…' : 'Reinstate'}
                <span className="sr-only"> {coachName}</span>
              </Button>
            </form>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirming('suspended')}>
              Suspend<span className="sr-only"> {coachName}</span>
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setConfirming('none')}>
            Remove as coach<span className="sr-only">: {coachName}</span>
          </Button>
        </div>

        {state.status === 'error' && state.message ? (
          <p role="alert" className="text-xs font-medium text-danger">
            {state.message}
          </p>
        ) : null}
      </div>
    );
  }

  const demoting = confirming === 'none';

  return (
    <form action={formAction} className="flex w-full flex-col gap-3 border border-danger p-3">
      <input type="hidden" name="coachId" value={coachId} />
      <input type="hidden" name="status" value={confirming} />

      <p className="text-sm leading-relaxed text-ink">
        <strong className="font-semibold">
          {demoting
            ? `${coachName} stops being a coach.`
            : `${coachName} stops selling.`}
        </strong>{' '}
        {onSale > 0
          ? `${onSale === 1 ? 'Their 1 offer on sale is' : `All ${onSale} of their offers on sale are`} taken down first — by you, so they cannot put ${onSale === 1 ? 'it' : 'them'} back themselves.`
          : 'They have nothing on sale, so nothing is taken down.'}{' '}
        {demoting
          ? 'Their reviews, sales and delivered work all stay, and they can apply to coach again.'
          : 'They keep their account, their sales and any work they still owe a buyer, and you can reinstate them here.'}
      </p>

      <Field
        id={reasonId}
        label="Reason"
        optional
        hint="Recorded in the administrator log. They are not notified — nothing in this app sends email."
      >
        <Textarea
          id={reasonId}
          name="reason"
          rows={2}
          maxLength={1000}
          placeholder="e.g. Three upheld reports of taking payment off-site."
          defaultValue={state.values?.reason ?? ''}
          aria-describedby={fieldDescribedBy(reasonId, { hint: true })}
        />
      </Field>

      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" size="sm" disabled={pending}>
          {pending ? 'Saving…' : demoting ? 'Remove as coach' : 'Suspend them'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setConfirming(null)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Puts one withdrawn offer back on sale.
 *
 * One button per offer, deliberately, rather than a "restore everything" beside
 * Reinstate. Nothing records which withdrawals belonged to which suspension, so
 * a bulk restore would also lift takedowns made for unrelated reasons — see
 * `setCoachStandingAction`.
 */
export function RestoreListingForm({ listingId, title }: { listingId: string; title: string }) {
  const [state, formAction, pending] = useActionState(restoreCoachListingAction, idleFormState);

  if (state.status === 'success') {
    return (
      <span role="status" className="text-body-15 text-success">
        {state.message}
      </span>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="listingId" value={listingId} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? 'Restoring…' : 'Restore'}
        <span className="sr-only"> {title}</span>
      </Button>
      {state.status === 'error' && state.message ? (
        <span role="alert" className="text-xs font-medium text-danger">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
