'use client';

import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { reportCoachAction, reportReviewAction } from '@/lib/reports/actions';
import { COACH_REPORT_LABELS, REVIEW_REPORT_LABELS } from '@/lib/data/types';
import { idleFormState } from '@/lib/forms';

export interface ReportFormProps {
  /** Which action to call, and which reason list to offer. */
  subject: 'review' | 'coach';
  /** The review id or the coach's user id. */
  id: string;
  /** Named in the button's screen-reader text, so a list of them stays distinguishable. */
  subjectName: string;
}

/**
 * Reporting a review or a coach.
 *
 * COLLAPSED BY DEFAULT, like `RemoveReviewForm` and for a related reason: this
 * one is not destructive, but it sits under a stranger's words on a page whose
 * job is to be read, and an always-open form with a reason dropdown competes
 * with the thing it is about. The button is the whole affordance until somebody
 * wants it.
 *
 * The two subjects share one component because they are the same form — a
 * reason, an optional note, one button. What differs is the reason list and the
 * entitlement, and the entitlement is not this component's business: the caller
 * decides whether to render it at all, `reportReview`/`reportCoach` refuse
 * anyone who should not have had it, and Postgres refuses a third time. Nothing
 * here is a security boundary.
 *
 * The reason list is a `<Select>` over the closed `report_reason` enum, so a
 * report always arrives as one of a handful of values an administrator can
 * filter and count. The free-text note is where the specifics go, and it is
 * optional on purpose: a required field only teaches people to type "bad".
 */
export function ReportForm({ subject, id, subjectName }: ReportFormProps) {
  const action = subject === 'review' ? reportReviewAction : reportCoachAction;
  const [state, formAction, pending] = useActionState(action, idleFormState);
  const [open, setOpen] = useState(false);

  const labels = subject === 'review' ? REVIEW_REPORT_LABELS : COACH_REPORT_LABELS;
  const reasonId = `report-reason-${subject}-${id}`;
  const noteId = `report-note-${subject}-${id}`;
  const reasonError = state.fieldErrors?.reason;

  // Success is terminal: the form is replaced rather than reset, because a
  // second report of the same subject is refused by the database anyway and
  // leaving the fields open invites one.
  if (state.status === 'success') {
    return (
      <p className="text-body-15 text-success">
        {state.message ?? 'Thank you. An administrator will look at this.'}
      </p>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Report{subject === 'coach' ? ' this coach' : ''}
          <span className="sr-only">
            {subject === 'review' ? ` the review by ${subjectName}` : `: ${subjectName}`}
          </span>
        </Button>
        {/* A failure survives the panel closing, so nobody is left thinking a
            refused report was filed. */}
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
      <input type="hidden" name="id" value={id} />

      <p className="text-body-15 leading-relaxed text-muted">
        {subject === 'review'
          ? 'This goes to an administrator, who decides whether the review stays. The author is not told you reported it, and nothing changes until somebody has read it.'
          : 'This goes to an administrator. Reporting is not a refund — if an order went wrong, say so on the order page too.'}
      </p>

      <Field id={reasonId} label="Reason" error={reasonError}>
        <Select
          id={reasonId}
          name="reason"
          defaultValue=""
          invalid={Boolean(reasonError)}
          aria-describedby={fieldDescribedBy(reasonId, { error: reasonError })}
        >
          <option value="">Choose a reason…</option>
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>

      <Field id={noteId} label="What happened" optional hint="Up to 2000 characters. Only administrators see this.">
        <Textarea
          id={noteId}
          name="note"
          rows={3}
          maxLength={2000}
          defaultValue={state.values?.note ?? ''}
          aria-describedby={fieldDescribedBy(noteId, { hint: true })}
        />
      </Field>

      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Sending…' : 'Send report'}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
