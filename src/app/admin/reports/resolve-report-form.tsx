'use client';

import { useActionState } from 'react';

import { resolveReportAction } from '@/app/admin/reports/actions';
import type { ReportFilter } from '@/app/admin/reports/filters';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';

export interface ResolveReportFormProps {
  reportId: string;
  /** Named in the buttons' screen-reader text, so a queue of them stays distinguishable. */
  subjectName: string;
  /** The tab to return to, so a decision does not throw the admin back to the default one. */
  filter: ReportFilter;
}

/**
 * Uphold / dismiss, with one shared note — the same two-buttons-one-textarea
 * shape as the application review form, and for the same reason: the note
 * belongs to the decision rather than to either outcome, and two textareas
 * would be two things to keep in sync.
 *
 * NO CONFIRMATION STEP, unlike `RemoveReviewForm`. Resolving is not
 * destructive: the report keeps its text, gains who decided and when, and the
 * consequence — removing the review, suspending the coach — is a separate
 * deliberate action on another page. There is nothing here to misclick away.
 *
 * A POST, never a link: this writes, and a GET that resolved a report would be
 * followed by every prefetcher on the internet.
 */
export function ResolveReportForm({ reportId, subjectName, filter }: ResolveReportFormProps) {
  const [state, formAction, pending] = useActionState(resolveReportAction, idleFormState);
  const noteId = `resolution-${reportId}`;
  const failed = state.status === 'error' && Boolean(state.message);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="reportId" value={reportId} />
      <input type="hidden" name="status" value={filter} />

      <Field
        id={noteId}
        label="Resolution note"
        optional
        hint="For the record. The reporter is not notified — nothing in this app sends email."
      >
        <Textarea
          id={noteId}
          name="note"
          rows={2}
          maxLength={2000}
          placeholder="What did you find, and what did you do about it?"
          defaultValue={state.values?.note ?? ''}
          aria-describedby={fieldDescribedBy(noteId, { hint: true })}
        />
      </Field>

      {/* Form-level: "That report has already been resolved" is about the
          report, not about this textarea, so the field describes only its hint
          and `role="alert"` carries the failure. Same split as the application
          review form. */}
      {failed ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" name="decision" value="upheld" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Saving…' : 'Uphold'}
          <span className="sr-only"> the report about {subjectName}</span>
        </Button>
        <Button
          type="submit"
          name="decision"
          value="dismissed"
          variant="secondary"
          disabled={pending}
          className="w-full sm:w-auto"
        >
          {pending ? 'Saving…' : 'Dismiss'}
          <span className="sr-only"> the report about {subjectName}</span>
        </Button>
      </div>
    </form>
  );
}
