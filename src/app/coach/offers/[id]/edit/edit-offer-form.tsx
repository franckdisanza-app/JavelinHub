'use client';

import { useActionState, useState } from 'react';

import { updateOfferAction } from '@/app/coach/offers/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LISTING_CATEGORY_LABELS, type ListingCategory } from '@/lib/data/types';
import { idleFormState } from '@/lib/forms';

export interface EditOfferFormProps {
  id: string;
  categories: readonly ListingCategory[];
  title: string;
  description: string;
  /** The current price, already formatted for the input — e.g. `45.00`. */
  price: string;
  category: string;
}

/**
 * The offer editor.
 *
 * Nearly the composer, with two differences that matter:
 *
 *   1. `id` travels in a hidden input. It is not trusted — `updateListing`
 *      checks that the actor owns that row and refuses otherwise — but it has
 *      to be *sent*, because a Server Action has no route params.
 *   2. A price INCREASE is called out before submitting, not after. Raising a
 *      price advances `price_epoch`, which archives this offer's public rating
 *      and sales count; that is the intended design and it is also a surprise
 *      if nobody says so. The warning is computed on the client purely as a
 *      courtesy — Postgres derives the epoch either way.
 */
export function EditOfferForm({ id, categories, title, description, price, category }: EditOfferFormProps) {
  const [state, formAction, pending] = useActionState(updateOfferAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  const [priceValue, setPriceValue] = useState(state.values?.price ?? price);
  const raising = isIncrease(price, priceValue);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="id" value={id} />

      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field id="title" label="Title" hint="What a learner sees first." error={errors.title}>
        <Input
          id="title"
          name="title"
          type="text"
          maxLength={120}
          required
          defaultValue={state.values?.title ?? title}
          invalid={Boolean(errors.title)}
          aria-describedby={fieldDescribedBy('title', { hint: true, error: errors.title })}
        />
      </Field>

      <Field
        id="description"
        label="Description"
        hint="What the learner gets, and what you need from them."
        error={errors.description}
      >
        <Textarea
          id="description"
          name="description"
          rows={8}
          maxLength={4000}
          required
          defaultValue={state.values?.description ?? description}
          invalid={Boolean(errors.description)}
          aria-describedby={fieldDescribedBy('description', { hint: true, error: errors.description })}
        />
      </Field>

      <Field id="price" label="Price" hint="In pounds — e.g. 45 or 45.00." error={errors.price}>
        <Input
          id="price"
          name="price"
          type="text"
          inputMode="decimal"
          required
          value={priceValue}
          onChange={(event) => setPriceValue(event.target.value)}
          invalid={Boolean(errors.price)}
          aria-describedby={fieldDescribedBy('price', { hint: true, error: errors.price })}
        />
      </Field>

      {raising ? (
        <Alert tone="warn" title="This is a price increase.">
          Saving will archive this offer&rsquo;s rating and sales count, and it will read as a new offer to
          learners. Your coach profile keeps every review and sale — those are not affected. Lowering a price,
          or changing anything else, does not do this.
        </Alert>
      ) : null}

      <Field
        id="category"
        label="Category"
        hint="How learners will find this on browse. Pick the closest fit."
        error={errors.category}
      >
        <Select
          id="category"
          name="category"
          defaultValue={state.values?.category ?? category}
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
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

/**
 * True when `next` is a strictly larger price than `current`.
 *
 * Compares in pence via the same two-decimal shape the input accepts, so
 * `45` and `45.00` are equal rather than one being "an increase". Anything
 * unparseable returns false: a warning about a value the user is midway
 * through typing is noise, and the server decides regardless.
 */
function isIncrease(current: string, next: string): boolean {
  const a = toPence(current);
  const b = toPence(next);
  return a !== null && b !== null && b > a;
}

function toPence(value: string): number | null {
  const match = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(value);
  if (!match) return null;
  const pounds = Number(match[1]);
  const pence = Number((match[2] ?? '0').padEnd(2, '0'));
  return Number.isFinite(pounds) && Number.isFinite(pence) ? pounds * 100 + pence : null;
}
