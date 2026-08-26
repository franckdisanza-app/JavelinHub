import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Rating, Stat } from '@/components/ui/stat';
import { listingCategoryLabel, type ListingWithCoach, type OfferStats } from '@/lib/data/types';
import { formatPrice } from '@/lib/format';

/**
 * One listing in the browse grid.
 *
 * Renders the four things the marketplace promises a learner will see before
 * clicking — title, price, coach name and description — plus, when the caller
 * has read them, the offer's own rating and sales.
 *
 * `coach_name` comes joined on `ListingWithCoach`, so this never looks a coach
 * up separately — which also keeps it away from `Profile` and the email it
 * carries. Public surfaces only ever see a name.
 */
export function ListingCard({
  listing,
  href,
  stats,
  coachHref,
}: {
  listing: ListingWithCoach;
  href: string;
  /**
   * This offer's OWN rollup, at its current price epoch — deliberately not the
   * coach's account-level numbers, which cover every offer and every epoch and
   * are legitimately larger. See `docs/DATA-LAYER.md`; do not reconcile them.
   *
   * Optional, and `undefined` means "the caller did not read stats", which
   * renders no numbers at all. It must never be substituted with a zeros row:
   * zeros are the claim "nothing has sold", and a page that simply did not ask
   * is not entitled to make it.
   */
  stats?: OfferStats;
  /**
   * Where this offer's coach lives, when the coach has a public profile.
   *
   * Optional because not every caller should link. `getPublicCoach` returns
   * `null` for anyone who is not an approved coach, and that state is reachable
   * for a coach who still has published offers, so a caller that cannot
   * establish the coach is approved must leave this out rather than guess — an
   * unconditional link would 404. The coach's own profile page also omits it:
   * a link from a coach's page to that same coach's page is not a cross-link.
   */
  coachHref?: string;
}) {
  return (
    <Card tone="raised" className="relative flex h-full w-full min-w-0 flex-col transition-colors hover:border-brand/50">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <h2 className="min-w-0 text-base font-semibold break-words text-ink">
            {/*
              The whole card is a click target via this stretched link, so the
              accessible name stays the title rather than becoming "read more".
            */}
            <Link href={href} className="after:absolute after:inset-0">
              {listing.title}
            </Link>
          </h2>
          <span className="shrink-0 text-base font-semibold tabular-nums text-ink">
            {formatPrice(listing.price_cents)}
          </span>
        </div>

        <p className="text-sm break-words text-muted">
          by{' '}
          {coachHref ? (
            /*
              The one element that is deliberately NOT covered by the stretched
              link above. `position: relative` is what lifts it over that
              overlay: both are in the same stacking context at `z-index: auto`,
              and this paragraph comes later in the document, so the later
              positioned element paints on top. No z-index is involved, and
              adding one would be a claim about a stacking order that does not
              exist.

              It is `inline` and not a flex box on purpose, which costs it the
              44px tap height. WCAG 2.5.5 exempts a target that is "in a
              sentence or block of text", which this is — and the alternative is
              worse than the rule it would satisfy: an inline-flex link is an
              anonymous flex item, inherits `min-width: auto`, and therefore
              refuses to break a long unbroken token, which is exactly how a
              coach called `Aaaa…` (300 chars) would push a 375px page sideways.
              That failure is permanent, because nothing in this app can edit a
              stored name.

              Ink text with a Steel underline that darkens to Ink on hover. No
              accent colour: section 03 caps Sector Blue at one element per
              screen in the content area and twelve card links would spend it
              twelve times over.
            */
            <Link
              href={coachHref}
              className="relative font-medium text-ink underline decoration-muted underline-offset-2 hover:decoration-ink"
            >
              {listing.coach_name}
            </Link>
          ) : (
            <span className="font-medium text-ink">{listing.coach_name}</span>
          )}
        </p>

        <p className="line-clamp-3 text-sm break-words text-muted">{listing.description}</p>

        <div className="mt-auto pt-1">
          {/* The label, never the stored slug — nobody should read "video_review". */}
          <Badge tone="neutral" wrap>
            {listingCategoryLabel(listing.category)}
          </Badge>
        </div>

        {stats ? (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4 border-t border-line pt-4">
            {/*
              Ink numeral, Steel label, no glyphs and no accent — section 06's
              stat pattern. `Rating` is what branches on a `null` average, so a
              brand-new offer can never be published as "0.0".

              THE EMPTY LABEL IS DECIDED HERE BECAUSE THE FACTS ARE HERE.
              `Rating` is not given the sales count and must not guess. Two
              different states share "no rating":

                * nothing sold and nothing written  -> "New offer"
                * sold, and simply not written about yet -> "No reviews yet"

              The second is the state most likely to be collapsed into the
              first, and the seed has one (`…0105`, sold once, never reviewed).
              Calling that offer new would be false: somebody bought it.
            */}
            <Rating
              average={stats.rating_average}
              count={stats.review_count}
              emptyLabel={stats.sales_count === 0 ? 'New offer' : 'No reviews yet'}
            />
            {/*
              Omitted entirely at zero rather than rendered as "0 SALES". The
              locked empty-state table allows either "New offer" or dropping the
              line, and dropping it is the better half of that choice here:
              "New offer" is already carried by the rating slot above, and a
              card that printed both would say the same thing twice. A nonzero
              count IS a fact and renders as the number it is — the asymmetry
              with the rating is the whole reason `rating_average` is nullable
              and `sales_count` is not.
            */}
            {stats.sales_count > 0 ? (
              <Stat value={stats.sales_count} label={stats.sales_count === 1 ? 'Sale' : 'Sales'} />
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
