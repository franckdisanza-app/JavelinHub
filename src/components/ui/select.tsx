import type { SelectHTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Draws the error border, mirroring `Input`. */
  invalid?: boolean;
}

/**
 * A native `<select>`, styled to match `Input`.
 *
 * Native on purpose: a custom listbox would have to reimplement keyboard
 * support, and on a phone the platform picker is better than anything worth
 * building for a proof of concept. `text-field` is the same 16px carve-out
 * `Input` uses — iOS Safari zooms the page in on a focused control below that,
 * which wrecks a 375px layout. `min-h-11` is the 44px WCAG 2.5.5 touch floor.
 *
 * Square corners and the 1px rule border come from guidelines section 06; the
 * mono face matches `Input`, since what a select shows is a chosen value.
 */
export function Select({ invalid = false, className, ...props }: SelectProps) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cn(
        'block w-full min-h-11 border bg-surface px-3 py-2.5 font-mono text-field text-ink',
        'transition-colors disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted',
        invalid ? 'border-danger' : 'border-line hover:border-ink',
        className,
      )}
      {...props}
    />
  );
}
