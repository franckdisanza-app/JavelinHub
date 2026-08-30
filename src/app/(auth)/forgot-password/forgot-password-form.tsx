'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { requestPasswordResetAction } from '@/lib/auth/actions';
import { idleFormState } from '@/lib/forms';

/**
 * Ask for a reset link.
 *
 * ON SUCCESS THE FORM IS REPLACED, not merely annotated. Leaving the email box
 * on screen under a confirmation invites a second submission, and the second
 * request would invalidate the link the first one just sent — a user following
 * their instincts would break their own reset.
 *
 * The confirmation is phrased so it is TRUE FOR AN ADDRESS WITH NO ACCOUNT.
 * "If that address has an account" is not hedging, it is the whole security
 * property of the flow: `requestPasswordResetAction` returns the same state
 * whatever it found, so this component genuinely does not know, and must not
 * write a sentence implying it does.
 */
export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(requestPasswordResetAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  if (state.status === 'success') {
    return (
      <Alert tone="success" title="Check your inbox.">
        <p>
          If that address has an account, a link to set a new password is on its way. It works once and
          expires in an hour.
        </p>
        <p className="mt-3">
          Nothing arrived? Check the spam folder, then ask again — the newest link is the only one that
          works.
        </p>
      </Alert>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field
        id="email"
        label="Email"
        hint="The address you signed up with."
        error={errors.email}
      >
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.values?.email ?? ''}
          invalid={Boolean(errors.email)}
          aria-describedby={fieldDescribedBy('email', { hint: true, error: errors.email })}
        />
      </Field>

      <Button type="submit" fullWidth disabled={pending}>
        {pending ? 'Sending…' : 'Email me a link'}
      </Button>
    </form>
  );
}
