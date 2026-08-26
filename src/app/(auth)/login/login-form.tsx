'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { logInAction } from '@/lib/auth/actions';
import { idleFormState } from '@/lib/forms';

export function LoginForm({ next }: { next: string | null }) {
  const [state, formAction, pending] = useActionState(logInAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {/* Carried through the POST rather than read from the URL inside the
          action: a Server Action has no notion of "the page it was submitted
          from". It is re-validated as a same-site path server-side. */}
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {/* Only the generic message ever appears here — see logInAction. */}
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field id="email" label="Email" error={errors.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.values?.email ?? ''}
          invalid={Boolean(errors.email)}
          aria-describedby={fieldDescribedBy('email', { error: errors.email })}
        />
      </Field>

      <Field id="password" label="Password" error={errors.password}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          invalid={Boolean(errors.password)}
          aria-describedby={fieldDescribedBy('password', { error: errors.password })}
        />
      </Field>

      <Button type="submit" fullWidth disabled={pending}>
        {pending ? 'Signing in…' : 'Log in'}
      </Button>
    </form>
  );
}
