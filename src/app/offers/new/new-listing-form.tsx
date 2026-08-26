'use client';

import { useActionState } from 'react';

import { createListingAction } from '@/app/offers/new/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LISTING_CATEGORY_LABELS, type ListingCategory } from '@/lib/data/types';
import { idleFormState } from '@/lib/forms';

/**
 * The offer composer (the model is still called `listing` — see the route).
 *
 * `categories` is the whole fixed taxonomy, handed down by the page from
 * `listCategories()` — not the categories already in use. There is no
 * "add your own" field: a marketplace whose category list is whatever coaches
 * typed cannot be filtered, and two spellings of the same thing split an
 * audience in half. The value posted is the SLUG; the option text is the label.
 */
export function NewListingForm({ categories }: { categories: readonly ListingCategory[] }) {
  const [state, formAction, pending] = useActionState(createListingAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field id="title" label="Title" hint="What a learner sees first." error={errors.title}>
        <Input
          id="title"
          name="title"
          type="text"
          maxLength={120}
          required
          placeholder="e.g. Javelin Throw Fundamentals"
          defaultValue={state.values?.title ?? ''}
          invalid={Boolean(errors.title)}
          aria-describedby={fieldDescribedBy('title', { hint: true, error: errors.title })}
        />
      </Field>

      <Field
        id="description"
        label="Description"
        hint="At least 20 characters. What the session covers, who it suits, what they need to bring."
        error={errors.description}
      >
        <Textarea
          id="description"
          name="description"
          rows={6}
          maxLength={4000}
          required
          placeholder="e.g. A 90-minute session on grip, carry and the crossover, for athletes new to the event."
          defaultValue={state.values?.description ?? ''}
          invalid={Boolean(errors.description)}
          aria-describedby={fieldDescribedBy('description', { hint: true, error: errors.description })}
        />
      </Field>

      <Field
        id="price"
        label="Price"
        hint="In pounds, per session — e.g. 45 or 45.00."
        error={errors.price}
      >
        <Input
          id="price"
          name="price"
          type="text"
          // `inputMode` gets the numeric keypad on a phone without `type="number"`,
          // whose spinners and locale-dependent parsing cause more trouble than they solve.
          inputMode="decimal"
          required
          placeholder="45.00"
          defaultValue={state.values?.price ?? ''}
          invalid={Boolean(errors.price)}
          aria-describedby={fieldDescribedBy('price', { hint: true, error: errors.price })}
        />
      </Field>

      <Field
        id="category"
        label="Category"
        hint="How learners will find this on browse. Pick the closest fit."
        error={errors.category}
      >
        <Select
          id="category"
          name="category"
          defaultValue={state.values?.category ?? ''}
          invalid={Boolean(errors.category)}
          aria-describedby={fieldDescribedBy('category', { hint: true, error: errors.category })}
        >
          <option value="">Choose a category…</option>
          {categories.map((slug) => (
            <option key={slug} value={slug}>
              {LISTING_CATEGORY_LABELS[slug]}
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Publishing…' : 'Publish offer'}
        </Button>
      </div>
    </form>
  );
}
