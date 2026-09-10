import { ImageResponse } from 'next/og';

import { getDataClient } from '@/lib/data';

/**
 * The card ONE COACH renders as when their profile link is shared.
 *
 * The sibling under `offers/[id]` carries the full reasoning — why a per-entity
 * card exists at all, why it is rendered per request where the site-wide one is
 * built once, and why it never throws. This one is the same shape with a
 * different subject, and it exists for the more direct reason: a coach sharing
 * their own profile is the single most likely link anybody posts, and it was
 * producing the generic site card.
 *
 * `getPublicCoach` is the right read and not merely a convenient one: it
 * carries the approved-coach predicate itself, so a coach who has been
 * suspended stops having a card the moment they stop having a page, with
 * nothing here to keep in step.
 *
 * DELIBERATELY NO RATING ON THE CARD. It would have to be fetched separately,
 * it goes stale in every cache that has ever held the image, and a number that
 * disagrees with the page it links to is worse than no number.
 */

export const alt = 'A coach on JavelinHub';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Brand guidelines section 03, mirrored from the site card for the same reason. */
const INK = '#0d1014';
const SHEET = '#f6f7f2';
const SECTOR = '#1b3ae0';
const STEEL = '#8f968f';

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;

  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let name: string | null = null;
  let headline: string | null = null;
  let years: number | null = null;

  try {
    const coach = await getDataClient().getPublicCoach(id);
    if (coach !== null) {
      name = truncate(coach.full_name, 40);
      headline = coach.coach_headline === null ? null : truncate(coach.coach_headline, 110);
      years = coach.coach_years_coaching;
    }
  } catch {
    // Falls through to the site-level card. See the sibling file's header.
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
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', width: 220, height: 10, background: SECTOR }} />
          <div style={{ display: 'flex', marginTop: 26 }}>
            <span style={{ fontSize: 26, color: STEEL, letterSpacing: '0.14em' }}>COACH</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {name === null ? (
            <span style={{ fontSize: 96, color: SHEET, letterSpacing: '-0.02em' }}>JAVELINHUB</span>
          ) : (
            <span style={{ fontSize: 76, color: SHEET, lineHeight: 1.1 }}>{name}</span>
          )}

          <div style={{ display: 'flex', marginTop: 20 }}>
            <span style={{ fontSize: 34, color: STEEL, lineHeight: 1.3 }}>
              {headline ??
                (name === null
                  ? 'Coaching and video review for throwers.'
                  : /*
                     * `coach_years_coaching` is `null` for "not stated" and is
                     * never `0` — the type says so — so this reads as a fact or
                     * not at all, and never as "0 years coaching".
                     */
                    years === null
                    ? 'Coaching on JavelinHub.'
                    : `${years} ${years === 1 ? 'year' : 'years'} coaching.`)}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex' }}>
          <span style={{ fontSize: 26, color: STEEL, letterSpacing: '0.14em' }}>JAVELINHUB</span>
        </div>
      </div>
    ),
    size,
  );
}
