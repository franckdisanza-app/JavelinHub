'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { signUpAction } from '@/lib/auth/actions';
import { idleFormState } from '@/lib/forms';
import { LEGAL } from '@/lib/legal';

export function SignupForm() {
  const [state, formAction, pending] = useActionState(signUpAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  /*
   * THE FORM IS REPLACED ON SUCCESS, not annotated.
   *
   * A signup that needs confirmation ends here rather than at a redirect: there
   * is no session, so there is nowhere signed-in to send them. Leaving the
   * filled-in form on screen under a confirmation invites a second submission,
   * which GoTrue answers as "an account with that email already exists" — a
   * user following their instincts would be told their own successful signup
   * had failed.
   *
   * The other success — a session, because confirmation is off or the backend
   * is the mock — never reaches this branch: the action redirects instead.
   */
  if (state.status === 'success') {
    return (
      <Alert tone="success" title="Check your inbox.">
        <p>
          We have sent a confirmation link{state.values?.email ? <> to <strong>{state.values.email}</strong></> : null}.
          Open it and you will be signed in and taken to the offers.
        </p>
        <p className="mt-3">
          The link comes from Supabase and can take a minute. If nothing arrives, check the spam folder before
          signing up again — the account already exists, so a second attempt will say so.
        </p>
      </Alert>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field id="fullName" label="Full name" error={errors.fullName}>
        <Input
          id="fullName"
          name="fullName"
          type="text"
          autoComplete="name"
          required
          defaultValue={state.values?.fullName ?? ''}
          invalid={Boolean(errors.fullName)}
          aria-describedby={fieldDescribedBy('fullName', { error: errors.fullName })}
        />
      </Field>

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

      <Field
        id="password"
        label="Password"
        hint="At least 8 characters."
        error={errors.password}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          invalid={Boolean(errors.password)}
          aria-describedby={fieldDescribedBy('password', { hint: true, error: errors.password })}
        />
      </Field>

      {/*
        NOT A `Field`. `Field` puts the label above the control, which is right
        for every input on this form and wrong for a checkbox: the label of a
        checkbox is the sentence you are agreeing to, and it belongs beside the
        box. So the label wraps the input instead, which also makes the whole
        sentence a click target rather than the 16px square.

        NOT PRE-TICKED, and it never may be. Pre-ticked consent is not consent
        under UK/EU law, and it is also the one arrangement that would make the
        record this stamps meaningless.

        `required` is here for the browser's own prompt. It is not the check —
        `signUpAction` refuses the submission independently, because a Server
        Action is a public endpoint and a POST can simply omit the field.

        ONE CHECKBOX, TWO STATEMENTS, and only while the second has an answer.
        `LEGAL.minimumAge` is `null` until somebody decides it (see the field's
        comment in `src/lib/legal.ts`), and a sentence reading "I am at least
        MINIMUMAGE" would be worse than no sentence — the red marker the legal
        pages use says "unfinished document", which is true of a document and
        absurd in a consent statement somebody is being asked to tick. So the
        age half appears when the fact does, and not before.

        WHOEVER FILLS THAT FACT IN MUST ALSO BUMP `LEGAL_LAST_UPDATED`. It is
        what `signUpAction` records as `termsVersion`, so leaving it alone
        would file everyone who agreed to the new sentence under the version
        of the old one, which is the one thing a consent record must not do.
      */}
      <div className="flex flex-col gap-2">
        <label htmlFor="acceptTerms" className="flex min-h-11 items-start gap-3 py-1 text-body-15 text-ink">
          <input
            id="acceptTerms"
            name="acceptTerms"
            type="checkbox"
            required
            aria-describedby={fieldDescribedBy('acceptTerms', { error: errors.acceptTerms })}
            aria-invalid={errors.acceptTerms ? true : undefined}
            className="mt-1 h-5 w-5 shrink-0 border border-line-strong accent-brand"
          />
          <span>
            {LEGAL.minimumAge === null ? null : (
              <>
                I am at least {LEGAL.minimumAge}, and{' '}
              </>
            )}
            I agree to the{' '}
            <Link
              href="/legal/terms"
              target="_blank"
              className="underline decoration-line underline-offset-2 hover:decoration-ink"
            >
              terms
            </Link>{' '}
            and the{' '}
            <Link
              href="/legal/privacy"
              target="_blank"
              className="underline decoration-line underline-offset-2 hover:decoration-ink"
            >
              privacy notice
            </Link>
            .
          </span>
        </label>
        {errors.acceptTerms ? (
          <p id="acceptTerms-error" className="text-body-15 font-medium text-danger">
            {errors.acceptTerms}
          </p>
        ) : null}
      </div>

      <Button type="submit" fullWidth disabled={pending}>
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}
