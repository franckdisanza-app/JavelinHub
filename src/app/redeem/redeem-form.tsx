'use client';

import { useActionState } from 'react';

import { redeemInviteAction } from '@/app/redeem/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';

/**
 * Failure states only. A successful redemption redirects to
 * `/redeem?redeemed=1`, where the page renders the confirmation — see
 * `actions.ts` for why the success message cannot live in this component.
 */
export function RedeemForm() {
  const [state, formAction, pending] = useActionState(redeemInviteAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field
        id="code"
        label="Invite code"
        hint="Case does not matter, and surrounding spaces are ignored."
        error={errors.code}
      >
        <Input
          id="code"
          name="code"
          type="text"
          required
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ABCD-EFGH-JKMN"
          defaultValue={state.values?.code ?? ''}
          invalid={Boolean(errors.code)}
          aria-describedby={fieldDescribedBy('code', { hint: true, error: errors.code })}
          className="font-mono tracking-[0.15em] uppercase"
        />
      </Field>

      <Button type="submit" fullWidth disabled={pending}>
        {pending ? 'Checking code…' : 'Redeem code'}
      </Button>
    </form>
  );
}
