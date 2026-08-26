import type { ReactNode } from 'react';

import { cn } from '@/components/ui/cn';
import { Label } from '@/components/ui/label';

export interface FieldProps {
  /** The input's `id`. The label's `htmlFor`, the hint id and the error id are all derived from it. */
  id: string;
  label: string;
  /** Renders "(optional)" beside the label. */
  optional?: boolean;
  /** Persistent helper text, e.g. "At least 8 characters". */
  hint?: ReactNode;
  /** Error message for this field, or `undefined`/`null` when valid. */
  error?: string | null;
  className?: string;
  /**
   * The control. Receives nothing automatically — spread `describedBy(id, …)`
   * onto it yourself, or use the ids this component documents:
   * `${id}-hint` and `${id}-error`.
   */
  children: ReactNode;
}

/**
 * Label + control + hint + error, wired for screen readers.
 *
 * The control must carry `id={id}` and
 * `aria-describedby={fieldDescribedBy(id, { hint: …, error: … })}`, which is
 * how the hint and the error text get announced with the input rather than
 * being loose text on the page. `Field` cannot inject those props itself
 * without cloning the child, which breaks Server/Client component boundaries.
 *
 *     <Field id="email" label="Email" error={state.fieldErrors?.email}>
 *       <Input id="email" name="email" type="email"
 *              invalid={Boolean(state.fieldErrors?.email)}
 *              aria-describedby={fieldDescribedBy('email', { error: state.fieldErrors?.email })} />
 *     </Field>
 */
export function Field({ id, label, optional, hint, error, className, children }: FieldProps) {
  // 8px between label, control, hint and error — the in-component spacing step
  // from guidelines section 06.
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor={id} optional={optional}>
        {label}
      </Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-body-15 text-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-body-15 font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Builds the `aria-describedby` value for a `Field`'s control. */
export function fieldDescribedBy(
  id: string,
  parts: { hint?: unknown; error?: unknown },
): string | undefined {
  const ids: string[] = [];
  if (parts.hint) ids.push(`${id}-hint`);
  if (parts.error) ids.push(`${id}-error`);
  return ids.length > 0 ? ids.join(' ') : undefined;
}
