import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` for the one main action, `secondary` for the rest, `danger` for destructive. Default `primary`. */
  variant?: ButtonVariant;
  /** Default `md`. `lg` is for landing-page calls to action. */
  size?: ButtonSize;
  /** Stretches to the container's width — the sensible default inside a form on mobile. */
  fullWidth?: boolean;
}

/*
 * Brand guidelines section 06. Primary is Sector Blue and darkens to Ink on
 * hover — not to a deeper blue; the doc's own button does exactly this.
 * Secondary is the doc's "ghost": a transparent box with an Ink hairline that
 * inverts to Ink-on-Sheet on hover. `danger` is the same construction in Foul
 * Red, filling on hover rather than sitting on a tint — v1.1 removed the
 * soft-tint family from the palette, so there is no tint to sit on.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-ink hover:bg-brand-strong border border-transparent',
  secondary: 'bg-transparent text-ink border border-ink hover:bg-ink hover:text-bg',
  ghost: 'bg-transparent text-muted border border-transparent hover:bg-surface-2 hover:text-ink',
  danger: 'bg-transparent text-danger border border-danger hover:bg-danger hover:text-bg',
};

// min-h-11 is 44px — the WCAG 2.5.5 / iOS touch-target floor. It lives here in
// the primitive rather than at each call site so every consumer inherits it;
// padding alone put 'md' at 41.6px, two pixels short everywhere it was used.
//
// The sizes are three adjacent steps of section 04's mono scale, which reads
// 16 / 13 / 12 / 11 / 10. `md` sits on 12px — the step the doc's own `.btn` and
// `.card .price` specimens are set at, and the one an earlier draft's summary
// line omitted before the v1.1 correction restored it. Buttons carry no body
// type at all: they are instruments, so they are set in Plex Mono at small
// sizes with wide tracking, and the height comes from `min-h`, never from the
// type size.
const SIZES: Record<ButtonSize, string> = {
  sm: 'text-mono-11 px-3 py-1.5 gap-1.5 min-h-11',
  md: 'text-mono-12 px-4 py-2.5 gap-2 min-h-11',
  lg: 'text-mono-13 px-5 py-3 gap-2 min-h-12',
};

// Every button shares this. Square corners and the absence of any blur are not
// defaults left alone — section 06 states there is no radius token because
// there is no radius, and that depth is a rule line plus a change of ground.
const BASE =
  'inline-flex items-center justify-center font-mono font-medium uppercase tracking-[0.1em] transition-colors';

/**
 * The app's only `<button>`. Anything that navigates should be a `<Link>` with
 * `linkButtonClass()` instead, so that middle-click and "open in new tab" keep
 * working.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        BASE,
        'disabled:cursor-not-allowed disabled:opacity-55',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The same visual treatment, as a class string, for `<Link>` and `<a>`.
 *
 *     <Link href="/offers" className={linkButtonClass({ variant: 'secondary' })}>Offers</Link>
 */
export function linkButtonClass(
  options: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {},
): string {
  const { variant = 'primary', size = 'md', fullWidth = false, className } = options;
  return cn(
    BASE,
    'no-underline',
    VARIANTS[variant],
    SIZES[size],
    fullWidth && 'w-full',
    className,
  );
}
