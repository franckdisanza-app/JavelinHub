import type { LabelHTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  /** Renders the "(optional)" hint. Inputs are assumed required unless marked. */
  optional?: boolean;
}

/**
 * A real `<label>`. Always pass `htmlFor` matching the input's `id` — a
 * placeholder is not a label, and neither is adjacent text.
 *
 * Set in Plex Mono, uppercase, 10px at +0.14em, in Steel — the field-label spec
 * from guidelines sections 04 and 06. 10px is the floor of the type system and
 * the doc pins labels to it deliberately: the label is small so the 16px value
 * beneath it is the thing you read. Steel is the lightest tone allowed to carry
 * words at all (5.9:1 on Sheet), so this still clears the 4.5:1 floor.
 */
export function Label({ optional = false, className, children, ...props }: LabelProps) {
  return (
    <label
      className={cn(
        'block font-mono text-mono-10 font-medium tracking-[0.14em] uppercase text-muted',
        className,
      )}
      {...props}
    >
      {children}
      {optional ? <span className="ml-1.5 font-normal">(optional)</span> : null}
    </label>
  );
}
