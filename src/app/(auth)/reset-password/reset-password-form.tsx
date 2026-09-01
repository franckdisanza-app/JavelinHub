'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Button, linkButtonClass } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { resetPasswordAction } from '@/lib/auth/actions';
import { idleFormState } from '@/lib/forms';

/**
 * Set the new password.
 *
 * NOTHING IS ECHOED BACK. `resetPasswordAction` returns no `values` at all, so
 * there is nothing to re-seed the inputs from and a failed submission clears
 * both boxes. That is the intended trade: a password rendered into HTML lands
 * in the browser's cache, in a bfcache snapshot, and in any proxy that sees the
 * response.
 *
 * The confirm field is compared on the SERVER, not here. A mismatch caught in
 * the browser is a convenience; a mismatch caught nowhere is a user locked out
 * of the account they just changed.
 */
export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState(resetPasswordAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  if (state.status === 'success') {
    return (
      <div className="flex flex-col gap-4">
        {/* The second sentence is a security fact the user needs and cannot see
            for themselves: `resetPasswordAction` calls `destroyOtherSessions()`,
            so anyone still holding a session on another device — which is a
            plausible reason for being locked out in the first place — has just
            lost it. Saying so is also what tells an innocent user why their
            phone is asking them to sign in again. */}
        <Alert tone="success" title="Your password is set.">
          You are signed in on this device already. Every other device has been signed out, so use the new
          password there.
        </Alert>
        <div>
          <Link href="/offers" className={linkButtonClass()}>
            Browse offers
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field
        id="password"
        label="New password"
        hint="At least 8 characters."
        error={errors.password}
      >
        <Input
          id="password"
          name="password"
          type="password"
          // `new-password`, not `current-password`: it tells a password manager
          // to offer to generate and then to SAVE the result, which is the
          // difference between a manager that helps here and one that autofills
          // the password the user has just been unable to remember.
          autoComplete="new-password"
          required
          invalid={Boolean(errors.password)}
          aria-describedby={fieldDescribedBy('password', { hint: true, error: errors.password })}
        />
      </Field>

      <Field id="confirm" label="Confirm new password" error={errors.confirm}>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          invalid={Boolean(errors.confirm)}
          aria-describedby={fieldDescribedBy('confirm', { error: errors.confirm })}
        />
      </Field>

      <Button type="submit" fullWidth disabled={pending}>
        {pending ? 'Saving…' : 'Set new password'}
      </Button>
    </form>
  );
}
