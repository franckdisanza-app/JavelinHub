import { ImageResponse } from 'next/og';

/**
 * =============================================================================
 * The card a shared link renders as.
 * =============================================================================
 *
 * There was no image at all, so every link to this site posted anywhere —
 * a message, a forum, a social card — rendered as bare text. For a marketplace
 * whose whole distribution model is a coach sharing their own offer, that is
 * the first impression the product never got to make.
 *
 * GENERATED AT BUILD TIME, not per request. `opengraph-image` is a static file
 * convention: nothing here reads a request, a cookie or `siteUrl()`, so Next
 * renders it once during `next build` and serves it as an immutable asset. That
 * is deliberate — it is also why this file must never grow a data read. A
 * per-offer card would be `app/offers/[id]/opengraph-image.tsx`, a different
 * file with a different cost, and it should be added only once somebody wants
 * the offer's own title on it.
 *
 * NO CUSTOM FONT, AND THE LOCKUP IS ADAPTED RATHER THAN FAKED. The real mark is
 * Barlow Condensed at 100 for JAVELIN against 900 for HUB — the run-up against
 * the release — and `ImageResponse` cannot use `next/font`: it needs the font
 * BYTES, which means committing a woff2 or fetching from Google during `next
 * build`. The fetch adds a network dependency that fails closed in CI for a
 * decorative asset, which is a bad trade.
 *
 * So the default face is used, and getting there took two wrong drafts that are
 * worth recording, because both LOOKED right in the source:
 *
 *   1. `fontWeight: 300` on JAVELIN and `900` on HUB. Renders identically —
 *      Satori's fallback has one weight — so there was no contrast at all.
 *   2. The same two spans coloured differently instead. That works, but it
 *      revealed the real problem: **Satori lays out adjacent flex children with
 *      a gap**, so the mark came out as "JAVELIN HUB" with a word space. Not a
 *      JSX whitespace artifact and not `gap` — confirmed by rendering the two
 *      halves as ONE string, where N and H sit at their normal sidebearings and
 *      the space disappears.
 *
 * A word space is not a small thing here: `layout.tsx` states the rule as "The
 * product name is one word, two weights, and never spaced", and "JAVELIN HUB"
 * is a different name from the one on every other surface. Keeping it one word
 * means keeping it one text run, and one text run cannot carry two colours.
 *
 * So the wordmark is rendered uniformly and Sector Blue goes back on the rule
 * above it — one blue element, which is what section 03 allows. That is a
 * faithful degradation rather than a faked lockup: the name is right, the
 * palette is right, and the weight contrast is simply absent until the font is.
 *
 * To restore the real mark, commit the Barlow Condensed woff2 and pass `fonts:`
 * here; the two spans can then differ by weight, which needs no second colour
 * and no second element.
 *
 * The palette is the only place in the app outside `globals.css` that names a
 * hex, and it has to be: this renders through Satori rather than through the
 * stylesheet, so no CSS variable is in scope.
 */

export const alt = 'JavelinHub — coaching and video review for throwers';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Brand guidelines section 03. Mirrors the tokens in `src/app/globals.css`. */
const INK = '#0d1014';
const SHEET = '#f6f7f2';
const SECTOR = '#1b3ae0';
const STEEL = '#8f968f';

export default async function Image() {
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
          padding: '72px 80px',
        }}
      >
        {/* The card's one piece of Sector Blue. Section 03 allows exactly one,
            and with the wordmark uniform (see the header) the rule is where it
            goes. */}
        <div style={{ display: 'flex', width: 220, height: 10, background: SECTOR }} />

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/*
            ONE SPAN, ONE STRING, and it has to stay that way: splitting the
            wordmark across two flex children puts a space between N and H — see
            the header. `JavelinHub` is one word on every other surface.
          */}
          <span style={{ fontSize: 128, color: SHEET, letterSpacing: '-0.02em' }}>JAVELINHUB</span>
          <div style={{ display: 'flex', marginTop: 18 }}>
            <span style={{ fontSize: 38, color: SHEET, lineHeight: 1.3 }}>
              Coaching and video review for throwers.
            </span>
          </div>
        </div>

        {/* No exclamation marks and no "unlock your potential" — section 07
            says the description states what the product does and stops. */}
        <div style={{ display: 'flex' }}>
          <span style={{ fontSize: 28, color: STEEL, letterSpacing: '0.14em' }}>
            BROWSE COACHES · BROWSE OFFERS · APPLY TO COACH
          </span>
        </div>
      </div>
    ),
    size,
  );
}
