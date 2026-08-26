import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * `raised` lifts the card off the page by changing its ground to White — use
   * it for the one focal card on a page. Nothing is blurred behind it; see the
   * note on the component below.
   */
  tone?: 'flat' | 'raised';
}

/**
 * A bordered surface. Compose with `CardHeader` / `CardBody` / `CardFooter`.
 *
 * Elevation in this brand is a ground change, not a blur: section 06 is
 * explicit that there are no shadows and that "White on Sheet reads as raised".
 * So `flat` sits on the page's own Sheet ground and is defined purely by its
 * 1px rule, while `raised` swaps to White. The prop keeps its old name and
 * meaning; only the mechanism changed, so existing `tone="raised"` call sites
 * need no edit.
 */
export function Card({ tone = 'flat', className, ...props }: CardProps) {
  return (
    <div
      className={cn('border border-line', tone === 'raised' ? 'bg-surface' : 'bg-bg', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls; wraps below the title on narrow screens. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b border-line px-6 py-4 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        {/* Card titles are display type — section 04 assigns Big Shoulders to
            headlines, card titles and nav, and only ever at heavy weights.
            22px is the bottom step of the display scale; the description below
            it stays in the body face, because that is what gets read. */}
        <h2 className="font-display text-display-22 leading-[0.9] font-bold tracking-[0.005em] uppercase text-ink">
          {title}
        </h2>
        {description ? <p className="mt-2 text-body-15 text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}

// Padding steps in multiples of 8 (section 06): 24px sides, 16/24px ends.
export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-6 py-6', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('border-t border-line bg-surface-2 px-6 py-4 text-body-15 text-muted', className)}
      {...props}
    />
  );
}
