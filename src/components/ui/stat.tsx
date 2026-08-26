import type { ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * =============================================================================
 * `Stat` — a measured number and what it measures. Brand guidelines section 06.
 * =============================================================================
 *
 * This is the doc's own `.card .pb` / `.pb-l` construction, which the specimen
 * sets as `78.24m` over `PERSONAL BEST · 2023`: a large IBM Plex Mono numeral
 * in **Ink**, and a 10px uppercase **Steel** label under it at +0.14em.
 *
 * -----------------------------------------------------------------------------
 * WHY A RATING CARRIES NO ACCENT COLOUR, AND NO STARS
 * -----------------------------------------------------------------------------
 * Both halves of that are decisions, not defaults, and both were checked
 * against the palette rather than assumed:
 *
 *   * **Sector Blue is not available.** Section 03 reserves it for "the mark,
 *     and the action you want the thrower to take next", capped at ONE element
 *     per screen in the content area. A directory of twelve coach cards, each
 *     with a blue rating, violates that twelve times over and leaves the actual
 *     primary action competing with a number.
 *   * **Turf Green is not available either.** "Turf Green never initiates
 *     anything — it only confirms." A rating is a measurement, not a
 *     confirmation. (Turf *is* right for a "Verified purchase" chip, which is
 *     genuinely a confirmation — see `Badge tone="success"`.)
 *   * **Gold is not in the palette at all**, so the usual review-star treatment
 *     is off the table before taste enters into it.
 *
 * That leaves Ink and Steel, which is what the doc's stat pattern already uses
 * — and it is the better answer on its own merits: the number is more compact
 * than five glyphs, it is legible at 375px, it is already text for a screen
 * reader with no `aria-label` to keep in sync, and "we speak in numbers" is
 * section 01's first stated trait.
 *
 * If glyph stars are ever wanted anyway: Ink filled, Rule `#CFD4C8` empty.
 * Never gold.
 *
 * -----------------------------------------------------------------------------
 * NEVER RENDER A ZERO AS A RATING
 * -----------------------------------------------------------------------------
 * `Stat` does not know about ratings and cannot enforce that. {@link Rating}
 * below is the component that does, and rating call sites must use it: it takes
 * `average: number | null` and renders an **empty state instead of a numeral**
 * when the average is `null`. `0.0` reads as *badly rated*, not as *new*, and
 * once it is on screen the visitor has no way to recover the difference.
 */
export function Stat({
  value,
  label,
  className,
}: {
  /** The numeral. Pre-formatted by the caller — this component does no rounding. */
  value: ReactNode;
  /** What it measures. Rendered uppercase; write it in sentence case. */
  label: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      {/*
        `.card .pb`: mono 42 in Ink at line-height 1. `tabular-nums` so a column
        of these does not jitter — Plex Mono is already fixed-pitch, but the
        utility survives a future face change.
        `font-medium` (500) is one of the three mono weights loaded in
        layout.tsx; an unloaded weight is a synthesised one.
      */}
      <p className="font-mono text-mono-42 leading-none font-medium tabular-nums text-ink">{value}</p>
      {/*
        `.pb-l`: mono 10 — the floor of the whole type system — uppercase Steel
        at +0.14em, which is section 04's tracking for a label as distinct from
        the +0.1em of a button or chip.
      */}
      <p className="mt-1.5 font-mono text-mono-10 tracking-[0.14em] uppercase text-muted">{label}</p>
    </div>
  );
}

/**
 * The empty half of a stat: no numeral at all, just the reason there isn't one.
 *
 * Set at the label's own size and colour rather than as a grey `—` in the
 * numeral slot, because a dash in a number's place still reads as a value. The
 * whole point is that there is no value yet.
 */
export function StatEmpty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'font-mono text-mono-11 tracking-[0.14em] uppercase text-muted',
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * A rating average, or the reason there is not one — **the only supported way
 * to render `rating_average`**.
 *
 * `OfferStats.rating_average` and `CoachStats.rating_average` are
 * `number | null`, and they are `null` exactly when `review_count === 0`. No
 * write path can store a rating of 0 (they are integers 1–5, checked in
 * `createReview` and by a SQL constraint), so `null` is unambiguous — and this
 * component branches on it rather than formatting it, which is what stops a
 * brand-new coach or a brand-new offer being published as "0.0".
 *
 * Three states, not two. The middle one is easy to collapse into the first and
 * must not be: something can be **sold and still unrated** (the seed has one —
 * offer `…0105`), and "nobody has bought this" and "a buyer bought it and wrote
 * nothing" are different facts.
 *
 * That is why `emptyLabel` is a required prop rather than a `context` enum with
 * a default. `PROGRESS.md`'s locked table gives different wording per surface —
 * an unrated *offer* reads "No reviews yet", a coach who has sold and reviewed
 * NOTHING reads "New coach" — and which of those is true depends on the sales
 * count, which this component is not given. Forcing the caller to say it keeps
 * the decision where the facts are, while the `null` branch that stops "0.0"
 * ever reaching a screen stays here, where it cannot be forgotten.
 */
export function Rating({
  average,
  count,
  emptyLabel,
  className,
}: {
  /** `null` when nothing has been reviewed. Never pass `0` for "unrated". */
  average: number | null;
  /** The number of reviews behind the average. */
  count: number;
  /** Shown INSTEAD of a numeral when `average` is `null`. e.g. "New coach", "No reviews yet". */
  emptyLabel: string;
  className?: string;
}) {
  if (average === null) {
    return <StatEmpty className={className}>{emptyLabel}</StatEmpty>;
  }

  return (
    <Stat
      className={className}
      // One decimal place, matching `round(avg(rating)::numeric, 1)` in the
      // `public.offer_stats` / `public.coach_stats` views — so the rendered
      // number does not change when the backend is swapped. `toFixed` is what
      // keeps "5" rendering as "5.0" beside a "4.4".
      value={average.toFixed(1)}
      label={`${count} ${count === 1 ? 'review' : 'reviews'}`}
    />
  );
}
