'use client';

import { useActionState } from 'react';

import { reviewApplicationAction } from '@/app/admin/applications/actions';
import type { ApplicationFilter } from '@/app/admin/applications/filters';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';

export interface ReviewFormProps {
  applicationId: string;
  applicantName: string;
  /** The queue filter to return to, so a decision does not throw the admin back to the default tab. */
  filter: ApplicationFilter;
}

/**
 * Approve / reject, with one shared note.
 *
 * Both buttons submit the same form and carry the decision as their own
 * `name`/`value`, which is how one note field serves both without duplicating
 * the textarea or synchronising two copies of it.
 *
 * A POST, never a link: this changes state, and a GET that promotes someone to
 * coach would be followed by every link prefetcher on the internet.
 *
 * Success is not rendered here. The action redirects, because an approved or
 * rejected row leaves the pending queue and unmounts this component — the
 * outcome banner lives on the page instead.
 */
export function ReviewForm({ applicationId, applicantName, filter }: ReviewFormProps) {
  const [state, formAction, pending] = useActionState(reviewApplicationAction, idleFormState);
  const noteId = `note-${applicationId}`;
  const failed = state.status === 'error' && Boolean(state.message);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="status" value={filter} />

      <Field
        id={noteId}
        label="Reviewer note"
        optional
        hint="Optional when approving. Please write one when rejecting — it is the only explanation the applicant ever sees."
      >
        {/*
          The field is described by its hint only. These messages ("That
          application has already been reviewed") are about the application,
          not about this textarea, so they belong to the form-level
          role="alert" below — pointing the field at them while never setting
          aria-invalid was inconsistent either way.
        */}
        <Textarea
          id={noteId}
          name="note"
          rows={3}
          maxLength={1000}
          placeholder={`Why is ${applicantName} approved or turned down?`}
          defaultValue={state.values?.note ?? ''}
          aria-describedby={fieldDescribedBy(noteId, { hint: true })}
        />
      </Field>

      {/* Form-level, deliberately: these messages are about the application,
          not about the note field, so the textarea's `aria-describedby` points
          only at its hint and `role="alert"` carries the failure on its own.
          The id stays for a stable anchor; nothing references it. */}
      {failed ? (
        <p id={`${noteId}-error`} role="alert" className="text-sm font-medium text-danger">
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" name="decision" value="approved" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Saving…' : 'Approve'}
          <span className="sr-only"> {applicantName} as a coach</span>
        </Button>
        <Button
          type="submit"
          name="decision"
          value="rejected"
          variant="danger"
          disabled={pending}
          className="w-full sm:w-auto"
        >
          {pending ? 'Saving…' : 'Reject'}
          <span className="sr-only"> {applicantName}&apos;s application</span>
        </Button>
      </div>
    </form>
  );
}
