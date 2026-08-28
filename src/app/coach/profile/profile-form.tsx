'use client';

import { useActionState } from 'react';

import { updateCoachProfileAction } from '@/app/coach/profile/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { COACH_BIO_MAX, COACH_HEADLINE_MAX, COACH_YEARS_COACHING_MAX } from '@/lib/data/types';
import { idleFormState } from '@/lib/forms';

export interface CoachProfileFormProps {
  /** The stored values. `null` in any field means "not stated". */
  headline: string | null;
  bio: string | null;
  years: number | null;
}

/**
 * The coach's own public-profile editor.
 *
 * Every field is OPTIONAL and clearing one is a real edit, not a no-op — an
 * empty control saves NULL. So none of these carry `required`, and the submit
 * button is never disabled on emptiness: "I would rather not say" has to be
 * expressible, or a coach can add a bio and then never take it down.
 */
export function CoachProfileForm({ headline, bio, years }: CoachProfileFormProps) {
  const [state, formAction, pending] = useActionState(updateCoachProfileAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  // After a failed submit the user's own text wins, so nothing they typed is
  // lost. Otherwise fall back to what is stored.
  const headlineValue = state.values?.headline ?? headline ?? '';
  const bioValue = state.values?.bio ?? bio ?? '';
  // `years ?? ''` and NOT `String(years ?? '')` around a `||` — 0 is a legal,
  // meaningful value here and any falsy test would blank it on the way to the
  // input. See `parseYears` in this route's actions.
  const yearsValue = state.values?.years ?? (years === null ? '' : String(years));

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field
        id="headline"
        label="Headline"
        hint={`One line under your name in the directory. Up to ${COACH_HEADLINE_MAX} characters. Leave empty for none.`}
        error={errors.headline}
      >
        <Input
          id="headline"
          name="headline"
          type="text"
          maxLength={COACH_HEADLINE_MAX}
          placeholder="e.g. Javelin technique and throws conditioning"
          defaultValue={headlineValue}
          invalid={Boolean(errors.headline)}
          aria-describedby={fieldDescribedBy('headline', { hint: true, error: errors.headline })}
        />
      </Field>

      <Field
        id="bio"
        label="About you"
        hint={`Shown on your public coach page. Up to ${COACH_BIO_MAX} characters. Leave empty for none.`}
        error={errors.bio}
      >
        <Textarea
          id="bio"
          name="bio"
          rows={8}
          maxLength={COACH_BIO_MAX}
          placeholder="Who you coach, how you work, what a learner should expect."
          defaultValue={bioValue}
          invalid={Boolean(errors.bio)}
          aria-describedby={fieldDescribedBy('bio', { hint: true, error: errors.bio })}
        />
      </Field>

      {/*
        `inputMode="numeric"` with a text input rather than `type="number"`: a
        number input reports an empty string for anything it considers invalid,
        which would turn a typo into "not stated" instead of an error the coach
        can see and correct. Leaving it a text field means the server decides,
        and the server distinguishes the three outcomes properly.
      */}
      <Field
        id="years"
        label="Years coaching"
        hint="Whole years. Leave empty if you would rather not say — that is different from entering 0, which reads as your first season."
        error={errors.years}
      >
        <Input
          id="years"
          name="years"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={String(COACH_YEARS_COACHING_MAX).length}
          placeholder="e.g. 6"
          defaultValue={yearsValue}
          invalid={Boolean(errors.years)}
          aria-describedby={fieldDescribedBy('years', { hint: true, error: errors.years })}
        />
      </Field>

      <div>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}
