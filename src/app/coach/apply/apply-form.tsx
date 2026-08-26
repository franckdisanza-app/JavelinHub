'use client';

import { useActionState } from 'react';

import { applyToCoachAction } from '@/app/coach/apply/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';

/**
 * The application form itself.
 *
 * `submitLabel` differs for a first application and a re-application after a
 * rejection, but nothing else does — the data layer treats them identically,
 * so there is no second code path to get wrong.
 */
export function ApplyForm({ submitLabel = 'Submit application' }: { submitLabel?: string }) {
  const [state, formAction, pending] = useActionState(applyToCoachAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      {/*
        The hint says what happens to this text, at the point where it is
        collected. If this application is approved, `reviewCoachApplication`
        copies the bio ONCE into `profiles.coach_bio`, which is published on the
        coach's public profile — so an applicant who would rather not publish
        what they are writing here has to be told BEFORE they write it. That
        disclosure is the thing that makes the copy-at-approval design honest
        rather than merely legal.
      */}
      <Field
        id="bio"
        label="About you"
        hint="At least 20 characters. Who you are and who you coach. If you are approved, this becomes the first draft of your public coach profile — you can edit it afterwards."
        error={errors.bio}
      >
        <Textarea
          id="bio"
          name="bio"
          rows={5}
          maxLength={2000}
          required
          placeholder="e.g. Former county-level thrower, now coaching club athletes in the East Midlands."
          defaultValue={state.values?.bio ?? ''}
          invalid={Boolean(errors.bio)}
          aria-describedby={fieldDescribedBy('bio', { hint: true, error: errors.bio })}
        />
      </Field>

      <Field
        id="experience"
        label="Coaching experience"
        hint="At least 20 characters. Qualifications, years coaching, results you are proud of."
        error={errors.experience}
      >
        <Textarea
          id="experience"
          name="experience"
          rows={5}
          maxLength={2000}
          required
          placeholder="e.g. UKA Level 2 since 2019. Six seasons with Loughborough throws squad."
          defaultValue={state.values?.experience ?? ''}
          invalid={Boolean(errors.experience)}
          aria-describedby={fieldDescribedBy('experience', { hint: true, error: errors.experience })}
        />
      </Field>

      {/*
        THERE IS NO SPORT FIELD, and its absence is the decision. JavelinHub has
        exactly one sport, so asking is a question with one answer — noise on the
        form and, worse, an invitation to type something the product cannot act
        on. `coach_applications.sport` keeps its nullable column (schema churn
        for zero gain, and old rows still hold values), but nothing writes it any
        more and nothing public has ever read it.
      */}

      <div>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Submitting…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
