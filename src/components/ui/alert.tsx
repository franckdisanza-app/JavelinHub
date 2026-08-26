import type { ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

export type AlertTone = 'info' | 'success' | 'warn' | 'error';

/*
 * Same construction as a chip, one size up: a 1px border in the tone's colour
 * with the text in that colour, over the page's own ground. v1.1 dropped the
 * soft-tint family, so there is no wash to sit behind these any more.
 *
 * `info` is the exception and keeps a Chalk panel: it has no verdict to report,
 * and Chalk is the palette's panel fill. `warn` and `error` are both Foul Red —
 * the palette carries two verdicts, Turf for done and Foul for reported, and no
 * amber between them.
 */
const TONES: Record<AlertTone, string> = {
  info: 'border-line bg-surface-2 text-ink',
  success: 'border-success bg-transparent text-success',
  warn: 'border-warn bg-transparent text-warn',
  error: 'border-danger bg-transparent text-danger',
};

export interface AlertProps {
  tone?: AlertTone;
  /** Optional bold lead-in above the body. */
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * A flash / form-level message.
 *
 * `error` and `warn` get `role="alert"` + `aria-live="assertive"` so a screen
 * reader announces a failed submit immediately; the quieter tones are
 * `aria-live="polite"`. Render this only when there is something to say —
 * a permanently mounted empty alert region announces nothing and clutters the
 * accessibility tree.
 */
export function Alert({ tone = 'info', title, children, className }: AlertProps) {
  const assertive = tone === 'error' || tone === 'warn';
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      className={cn('border px-4 py-3 text-body-15', TONES[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(Boolean(title) && 'mt-1')}>{children}</div> : null}
    </div>
  );
}
