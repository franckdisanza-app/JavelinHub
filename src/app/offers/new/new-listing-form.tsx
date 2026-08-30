'use client';

import { useActionState, useState } from 'react';

import { createListingAction } from '@/app/offers/new/actions';
import { DeliveryModeChoice, toModeOrDefault } from '@/components/delivery-mode-choice';
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
export function NewListingForm({
  categories,
  storageAvailable,
}: {
  categories: readonly ListingCategory[];
  /** False on the mock backend, which has no file storage for an instant offer. */
  storageAvailable: boolean;
}) {
  const [state, formAction, pending] = useActionState(createListingAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  // Held in state because the file input below exists for only one of the two
  // modes. Re-seeded from `state.values` after a failed submission, so a coach
  // who mistyped a price does not also lose their delivery choice.
  const [mode, setMode] = useState(() => toModeOrDefault(state.values?.fulfilment, 'personalised'));

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

      <DeliveryModeChoice
        value={mode}
        onChange={setMode}
        storageAvailable={storageAvailable}
        error={errors.fulfilment}
      />

      {/*
        Only for an instant offer, and REQUIRED there. The schema permits an
        instant offer with no file — it has to, because the file is stored under
        the listing's own id and that id does not exist until the row does — but
        such an offer cannot be claimed, so publishing one would be publishing a
        dead listing. The action enforces this; `required` here just says so
        before the round trip.

        `accept` mirrors the bucket's own `allowed_mime_types`. It is a file
        picker filter, not a check: the action re-tests the type and size, and
        the bucket refuses anything else regardless.
      */}
      {mode === 'instant' ? (
        <Field
          id="asset"
          label="The file buyers download"
          hint="PDF, image, video, text, CSV or spreadsheet, up to 50 MB. You can replace it later from your offers page."
          error={errors.asset}
        >
          <Input
            id="asset"
            name="asset"
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp,video/mp4,video/quicktime,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            invalid={Boolean(errors.asset)}
            aria-describedby={fieldDescribedBy('asset', { hint: true, error: errors.asset })}
          />
        </Field>
      ) : null}

      <div>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Publishing…' : 'Publish offer'}
        </Button>
      </div>
    </form>
  );
}
