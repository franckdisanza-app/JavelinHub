import type { ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger';

/*
 * Brand guidelines section 06: a chip is a transparent box with a 1px coloured
 * border and matching coloured text. There is no filled or tinted variant —
 * v1.1 removed the soft-tint family from the palette entirely, so a tone is
 * carried by the border and the letterforms, not by a wash behind them.
 *
 * `warn` and `danger` are both Foul Red. The palette has exactly two verdict
 * colours: Turf confirms, Foul reports. There is no amber, and inventing one
 * would be the only off-brand colour in the product.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: 'border-muted text-muted',
  brand: 'border-brand text-brand',
  success: 'border-success text-success',
  warn: 'border-warn text-warn',
  danger: 'border-danger text-danger',
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  /**
   * Allow the label to wrap and break long words. Off by default — a status
   * chip should stay on one line — but required when the text is user-supplied,
   * such as a listing category, where one unbroken token would otherwise push
   * the page wider than the viewport.
   */
  wrap?: boolean;
}

/**
 * A small square chip — invite status, "Verified coach", a role label.
 *
 * Colour is never the only signal: the label itself always carries the meaning,
 * because roughly one man in twelve cannot separate the success and danger
 * tones by hue. That matters more here than it did with filled pills, since a
 * bordered chip commits even less area to the hue.
 *
 * Set at the 10px mono step with +0.1em tracking. Both come from section 04:
 * 10px is the floor of the whole type system under the "mono floor is 10px"
 * amendment — nothing in the product is set smaller — and +0.1em is the value
 * the "mono tracking is per role" amendment assigns to buttons and chips, as
 * distinct from the +0.14em that labels, eyebrows and captions carry.
 */
export function Badge({ tone = 'neutral', children, className, wrap = false }: BadgeProps) {
  return (
    <span
      className={cn(
        'border bg-transparent px-2.5 py-1 font-mono text-mono-10 font-medium tracking-[0.1em] uppercase',
        // `inline-flex` makes the label an anonymous flex item, which inherits
        // `min-width: auto` and so refuses to break a long unbroken token no
        // matter what `overflow-wrap` says. The wrapping variant is therefore
        // `inline-block`, where normal text wrapping applies.
        //
        // The wrapping variant carries NO overflow-wrap utility on purpose, so
        // that it inherits `anywhere` from the base rule in `globals.css`. Do
        // not add `break-words` back: it computes to `overflow-wrap: break-word`
        // and, having real specificity, silently overrides that base rule with a
        // strictly weaker value. `break-word` leaves intrinsic min-content at
        // the longest token, so the chip stops shrinking below it — measured at
        // 1422px inside a 375px grid cell, versus 375px with `anywhere`. That is
        // the same failure that defeated two earlier attempts at this bug.
        wrap
          ? 'inline-block max-w-full'
          : 'inline-flex items-center whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
