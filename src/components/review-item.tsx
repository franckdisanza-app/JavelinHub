import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import type { PublicReview } from '@/lib/data/types';
import { formatDate } from '@/lib/format';

/**
 * One review, as a stranger sees it — the single rendering of a review in the
 * product, shared by the offer page and the coach profile.
 *
 * -----------------------------------------------------------------------------
 * The shape it takes is the safety property
 * -----------------------------------------------------------------------------
 * {@link PublicReview} is a projection and not the row: no `order_id` (which
 * would be a valid argument to the buyer-and-seller-scoped `getOrder()`), no
 * `author_id`, no `price_epoch`. The author arrives already reduced to a
 * display name, so this component has no way to reach a `Profile` or an email
 * even by mistake. `PublicReviewWithListing` extends it, so a caller that has
 * the offer title may pass its own row unchanged and render the title through
 * `context` below.
 *
 * Keeping the two surfaces on one component is deliberate. The alternative —
 * an offer-page copy and a coach-page copy — is two places for a future column
 * to be printed and only one of them to be noticed.
 *
 * -----------------------------------------------------------------------------
 * The date is not decoration
 * -----------------------------------------------------------------------------
 * A coach may rewrite an offer's whole description without touching its price,
 * which keeps every review attached to it (the price epoch only moves on an
 * increase). The review date is what lets a reader see which opinions predate a
 * rewrite, so it is rendered on every review on every surface.
 */
export function ReviewItem({
  review,
  context,
}: {
  review: PublicReview;
  /**
   * Optional trailing meta, appended to the byline after a separator — the
   * coach profile puts the reviewed offer's title here, because that list mixes
   * several offers. An offer's own page passes nothing: naming the offer under
   * every review of the offer you are already reading is noise.
   */
  context?: ReactNode;
}) {
  return (
    <Card tone="raised">
      <CardBody className="flex flex-col gap-2 py-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/*
            The rating, in Ink mono — the small sibling of `Stat`, at the mono
            scale's 16px step. `out of 5` is real text and not a visually hidden
            label: "4" alone is ambiguous on any scale, and a sighted reader
            needs the denominator as much as a screen reader does.
          */}
          <p className="font-mono text-mono-16 font-medium tabular-nums text-ink">
            {review.rating}
            <span className="text-mono-11 text-muted"> out of 5</span>
          </p>
          {/*
            Turf Green confirms, and this genuinely does: `reviews.order_id` is
            a NOT NULL unique foreign key, so a review cannot exist without a
            purchase behind it. The chip is a fact about the schema rather than
            a badge somebody decided to render.
          */}
          <Badge tone="success">Verified purchase</Badge>
        </div>

        <p className="text-sm break-words whitespace-pre-line text-ink">{review.body}</p>

        <p className="text-sm break-words text-muted">
          <span className="font-medium text-ink">{review.author_name}</span>
          <span aria-hidden="true"> · </span>
          <span>{formatDate(review.created_at)}</span>
          {context ? (
            <>
              <span aria-hidden="true"> · </span>
              {context}
            </>
          ) : null}
        </p>
      </CardBody>
    </Card>
  );
}
