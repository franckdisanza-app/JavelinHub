import type { HTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * =============================================================================
 * The placeholder blocks a `loading.tsx` is built out of.
 * =============================================================================
 *
 * `PROGRESS.md` measured `/offers` at 712ms cold and `/coaches` at 165ms, and
 * until now every one of those milliseconds was spent on a page that had not
 * changed yet: without a Suspense boundary a navigation blocks entirely, so the
 * previous screen sits there looking like a dead link. This is what fills the
 * gap.
 *
 * **Only two routes may use these** — see the header of
 * `src/app/offers/(browse)/loading.tsx` for why, and read it before adding a
 * third.
 *
 * -----------------------------------------------------------------------------
 * IT IS CHALK ON SHEET, NOT GREY ON GREY
 * -----------------------------------------------------------------------------
 * `bg-surface-2` is the Chalk panel ground from section 03 — the same fill a
 * real panel uses. That is the whole styling: no radius, because section 06 says
 * there is no radius token; no blur, because there are no shadows; no gradient
 * sweep, because a moving highlight is a fourth kind of motion in a product that
 * has none.
 *
 * The only animation is opacity, and it is behind `motion-safe`, so a visitor
 * who has asked their system for reduced motion gets a static block rather than
 * a pulsing one. That is the right default for a placeholder that can be on
 * screen for the better part of a second.
 *
 * -----------------------------------------------------------------------------
 * IT IS HIDDEN FROM ASSISTIVE TECHNOLOGY
 * -----------------------------------------------------------------------------
 * `aria-hidden` on every block, with the announcement made once by the container
 * in `loading.tsx` instead. A screen reader that read this markup would announce
 * a dozen empty boxes and then announce the real page a moment later — the same
 * content twice, the first time as noise. The same reasoning `InitialsAvatar`
 * uses for hiding a tile whose name is printed beside it.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('motion-safe:animate-pulse bg-surface-2', className)}
      {...props}
    />
  );
}

/**
 * =============================================================================
 * THE HEIGHTS BELOW ARE MEASURED, NOT ESTIMATED
 * =============================================================================
 *
 * A placeholder of the wrong height does not prevent a layout shift, it causes
 * one — the whole page jumps the moment the real content lands, which is worse
 * than the blank wait it replaced. The first version of this file was written
 * by eye and produced a **162px** card against a real one of **302px**: 140px
 * per row, over eight rows of a full 24-offer page, is roughly eleven hundred
 * pixels of jump.
 *
 * So both shapes below mirror the real card's box model rather than
 * approximating it, and the result was checked in a browser against
 * `offsetHeight` on the live grids:
 *
 *                     real    this file
 *   offer card        302px   296px   `ListingCard` — title/price row, coach
 *                                     line, a three-line clamped description, a
 *                                     category chip, then the two-stat footer
 *                                     with its 42px numerals.
 *   coach card        126px   120px   `CoachCard` unrated, which is the common
 *                                     case.
 *
 * Six pixels each, which is under 2% and below the threshold at which a shift
 * is perceptible. Closing the last few would mean pinning heights that the real
 * cards derive from their type, so the next font-size change would silently
 * reopen the gap by more than it closed.
 *
 * ONE RESIDUAL THAT CANNOT BE REMOVED: a coach WITH a rating is 173px and
 * stretches its whole grid row to match. A placeholder cannot know which cards
 * are rated, so the unrated height is the honest choice and rows containing a
 * rated coach will still grow.
 *
 * **If either card's layout changes, re-measure rather than adjusting by eye.**
 * `[...document.querySelector('ul[class*=grid]').children].map(c => c.offsetHeight)`
 * on the live grid is how these numbers were taken.
 */

/** One `ListingCard`-shaped placeholder. Mirrors `p-5` / `gap-3` exactly. */
export function SkeletonOfferCard() {
  return (
    <div className="flex h-full w-full min-w-0 flex-col border border-line bg-surface">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-5">
        {/* Title and price share a row, and the price is the narrow one. */}
        <div className="flex items-start justify-between gap-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-6 w-16 shrink-0" />
        </div>

        {/* "by <coach name>" */}
        <Skeleton className="h-5 w-32 max-w-full" />

        {/* Three lines, clamped. The last is short, the way a wrapped paragraph
            ends — a stack of equal full-width bars reads as a table, not prose. */}
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>

        {/* The category chip, pushed down by `mt-auto` exactly as the real one is. */}
        <div className="mt-auto pt-1">
          <Skeleton className="h-6 w-28" />
        </div>

        {/* The two-stat footer: a 42px numeral over a 10px label, twice. */}
        <div className="flex items-end gap-x-8 border-t border-line pt-4">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-10 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-10 w-12" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One `CoachCard`-shaped placeholder: avatar tile, name, headline, one stat. */
export function SkeletonCoachCard() {
  return (
    <div className="flex h-full w-full min-w-0 flex-col border border-line bg-surface">
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-5">
        <div className="flex min-w-0 items-start gap-3">
          {/* The avatar tile is `h-11 w-11` — 44px, the touch-target floor the
              `Button` primitive is also built around. */}
          <Skeleton className="h-11 w-11 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-6 w-40 max-w-full" />
            <Skeleton className="h-5 w-full" />
          </div>
        </div>
        {/* The unrated state is a single label line, which is what makes the
            common coach card 126px rather than 173px. */}
        <Skeleton className="mt-auto h-3 w-24" />
      </div>
    </div>
  );
}

/**
 * The grid both public browse pages render into, at the same three breakpoints.
 *
 * SIX, and deliberately not the 24 that fill a page. A placeholder is a promise
 * about shape rather than about count, and the two directions are not
 * symmetrical: drawing fewer cards than arrive makes the page GROW downwards,
 * which is invisible below the fold, while drawing more makes it COLLAPSE, which
 * is not. Six is two full rows on desktop and more than a screen on mobile, and
 * the coach directory currently holds six coaches in total.
 */
export function SkeletonCardGrid({
  count = 6,
  variant = 'offer',
}: {
  count?: number;
  variant?: 'offer' | 'coach';
}) {
  const Card = variant === 'coach' ? SkeletonCoachCard : SkeletonOfferCard;

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} />
      ))}
    </div>
  );
}
