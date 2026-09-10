import { ImageResponse } from 'next/og';

import { getDataClient } from '@/lib/data';
import { formatPrice } from '@/lib/format';
import { listingCategoryLabel } from '@/lib/data/types';

/**
 * =============================================================================
 * The card ONE OFFER renders as when its link is shared.
 * =============================================================================
 *
 * `src/app/opengraph-image.tsx` — the site-wide card — ends by saying exactly
 * what this file is: *"A per-offer card would be
 * `app/offers/[id]/opengraph-image.tsx`, a different file with a different
 * cost, and it should be added only once somebody wants the offer's own title
 * on it."* Somebody does, and the reason is in that file's own opening: the
 * distribution model for a marketplace this size is a coach sharing their own
 * offer. Until now every one of those shares rendered the identical site card,
 * so a coach posting their video-review offer and a coach posting their
 * nutrition plan produced the same picture.
 *
 * -----------------------------------------------------------------------------
 * THE DIFFERENT COST, STATED
 * -----------------------------------------------------------------------------
 * The site card is generated once during `next build` because it reads nothing.
 * This one reads the offer, so it is rendered per request. That is the whole of
 * the trade, and it is acceptable here: the audience is a crawler unfurling a
 * link, which happens once per share rather than once per view.
 *
 * IT USES THE PUBLIC READ, NOT THE VIEWER-AWARE ONE. `getListing` filters
 * `deleted_at is null`, so a withdrawn offer produces the fallback card below
 * rather than a picture of something nobody can buy — where
 * `getListingForViewer` would need an actor, and an actor here would mean the
 * card differed by who unfurled the link.
 *
 * IT NEVER THROWS. A failed read renders the fallback. An `ImageResponse` that
 * throws is a broken image in somebody else's timeline, and there is no useful
 * error to show a crawler.
 *
 * The type treatment, the palette and the reason there is no custom font are
 * all inherited from the site card — read that file's header before changing
 * anything visual here.
 */

export const alt = 'An offer on JavelinHub';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Brand guidelines section 03, mirrored from the site card for the same reason. */
const INK = '#0d1014';
const SHEET = '#f6f7f2';
const SECTOR = '#1b3ae0';
const STEEL = '#8f968f';

/**
 * Satori has no `text-overflow: ellipsis`, so a long title is cut here or it
 * overflows the card. Cut on a word boundary where there is one — a title
 * severed mid-word reads as a rendering fault rather than as an abbreviation.
 */
function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;

  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let title: string | null = null;
  let coachName: string | null = null;
  let price: string | null = null;
  let category: string | null = null;

  try {
    const listing = await getDataClient().getListing(id);
    if (listing !== null) {
      title = truncate(listing.title, 90);
      coachName = listing.coach_name;
      price = formatPrice(listing.price_cents);
      category = listingCategoryLabel(listing.category).toUpperCase();
    }
  } catch {
    // Falls through to the site-level card below. See the header.
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: INK,
          padding: '64px 80px',
        }}
      >
        {/* The one piece of Sector Blue this card is allowed, in the same place
            the site card puts it. */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', width: 220, height: 10, background: SECTOR }} />
          {category === null ? null : (
            <div style={{ display: 'flex', marginTop: 26 }}>
              <span style={{ fontSize: 26, color: STEEL, letterSpacing: '0.14em' }}>{category}</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {title === null ? (
            // The read failed or the offer is gone. Falls back to the product,
            // which is still true, rather than to an apology nobody can act on.
            <span style={{ fontSize: 96, color: SHEET, letterSpacing: '-0.02em' }}>JAVELINHUB</span>
          ) : (
            <span style={{ fontSize: 64, color: SHEET, lineHeight: 1.15 }}>{title}</span>
          )}

          {coachName === null ? (
            <div style={{ display: 'flex', marginTop: 18 }}>
              <span style={{ fontSize: 34, color: SHEET }}>
                Coaching and video review for throwers.
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', marginTop: 22, alignItems: 'baseline' }}>
              {/*
                ONE STRING, not two spans with the separator between them:
                Satori lays adjacent flex children out with a gap, which is the
                trap the site card's header documents at length. Here it would
                double the spaces around the middle dot.
              */}
              <span style={{ fontSize: 34, color: STEEL }}>{`${coachName} · ${price ?? ''}`}</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex' }}>
          <span style={{ fontSize: 26, color: STEEL, letterSpacing: '0.14em' }}>JAVELINHUB</span>
        </div>
      </div>
    ),
    size,
  );
}
