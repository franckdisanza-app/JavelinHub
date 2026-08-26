'use client';

import { useActionState, useEffect, useState } from 'react';

import { revokeInviteAction } from '@/app/admin/invites/actions';
import { Button } from '@/components/ui/button';
import { idleFormState } from '@/lib/forms';

/**
 * Copies a code to the clipboard.
 *
 * `navigator.clipboard` needs a secure context, which `http://localhost`
 * counts as — but not `http://<lan-ip>:3000`, so the failure path shows the
 * user the code is still selectable rather than silently doing nothing.
 */
export function CopyCodeButton({ code }: { code: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setState('copied');
        } catch {
          setState('failed');
        }
      }}
    >
      <span aria-hidden="true">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it' : 'Copy'}</span>
      <span className="sr-only">
        {state === 'copied'
          ? `Copied invite code ${code}`
          : state === 'failed'
            ? `Could not copy automatically — select the code ${code} manually`
            : `Copy invite code ${code}`}
      </span>
    </Button>
  );
}

/** Revokes one code. A POST form, never a link — it changes state. */
export function RevokeInviteForm({ code }: { code: string }) {
  const [state, formAction, pending] = useActionState(revokeInviteAction, idleFormState);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1.5 sm:items-end">
      <input type="hidden" name="code" value={code} />
      <Button type="submit" variant="danger" size="sm" disabled={pending}>
        {pending ? 'Revoking…' : 'Revoke'}
        <span className="sr-only"> invite code {code}</span>
      </Button>
      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
