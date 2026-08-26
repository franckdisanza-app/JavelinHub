'use client';

import { useActionState } from 'react';

import { createInviteAction } from '@/app/admin/invites/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';

export function CreateInviteForm() {
  const [state, formAction, pending] = useActionState(createInviteAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.status === 'success' && state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="note"
          label="Note"
          optional
          hint="Who is this for? Only administrators ever see it."
          error={errors.note}
        >
          <Input
            id="note"
            name="note"
            type="text"
            maxLength={200}
            placeholder="e.g. Priya — javelin, Loughborough"
            defaultValue={state.values?.note ?? ''}
            invalid={Boolean(errors.note)}
            aria-describedby={fieldDescribedBy('note', { hint: true, error: errors.note })}
          />
        </Field>

        <Field
          id="expiresOn"
          label="Expires"
          optional
          hint="Leave empty for a code that never expires."
          error={errors.expiresOn}
        >
          <Input
            id="expiresOn"
            name="expiresOn"
            type="date"
            defaultValue={state.values?.expiresOn ?? ''}
            invalid={Boolean(errors.expiresOn)}
            aria-describedby={fieldDescribedBy('expiresOn', { hint: true, error: errors.expiresOn })}
          />
        </Field>
      </div>

      <div>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Generating…' : 'Generate invite code'}
        </Button>
      </div>
    </form>
  );
}
