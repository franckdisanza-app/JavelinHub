import { listingCategoryLabel } from '@/lib/data/types';
import type { Listing, OfferStats, PublicCoach } from '@/lib/data/types';
import { dataIsFabricated } from '@/lib/demo-data';
import { siteUrl } from '@/lib/env';
import { PRICE_CURRENCY, priceAmount } from '@/lib/format';
import { avatarPublicUrl } from '@/lib/storage/avatars';

/**
 * =============================================================================
 * schema.org payloads for the two pages a search engine cares about.
 * =============================================================================
 *
 * An offer and a coach are the only two pages here with content worth
 * describing to a crawler, and organic search is the cheapest channel a
 * marketplace of this size has. The blocks are built here rather than inline so
 * that the rules below hold in both places at once.
 *
 * FOUR RULES, EACH LEARNED FROM A WAY THIS GOES WRONG:
 *
 * 1. **Only ever describe what the page shows a stranger.** Google's own
 *    guidance treats structured data that is absent from the visible page as
 *    spam, and beyond the ranking question it is how a viewer-scoped fact ends
 *    up published to everybody. Every field below has a rendered counterpart.
 *
 * 2. **`aggregateRating` is omitted when there is nothing to average**, never
 *    emitted as zero. `rating_average` is `null` until something is reviewed —
 *    the fourth rule in `docs/DATA-LAYER.md` — and a `ratingValue: 0` reads as
 *    *bad* rather than *new* to a crawler exactly as it does to a person.
 *    Google also rejects an `aggregateRating` whose `reviewCount` is 0.
 *
 *    **And it is omitted entirely on a fabricated store.** `PROGRESS.md` states
 *    the rule as *"No JSON-LD `Review` / `AggregateRating` markup while the data
 *    is fake"*, and four pages carry a visible note saying so. Structured data
 *    is the half that travels into search results, where no note travels with
 *    it. The check lives HERE rather than at the call sites, so that adding a
 *    third page cannot quietly reintroduce it — the one thing a per-call-site
 *    flag is guaranteed to get wrong eventually.
 *
 * 3. **The price is the listed price**, formatted as a bare decimal. Claiming
 *    is free while the pilot runs, and the price on the page is still the
 *    number this will cost — so the two agree, which is the consistency Google
 *    requires. Publishing `0` here would say the product is free forever.
 *
 * 4. **Absolute URLs, built from `siteUrl()`.** Never from a request header:
 *    the reasoning is in `src/lib/env.ts`, and a crawler is exactly the
 *    audience a poisoned `Host` would be aimed at.
 */

/**
 * The five fields of a listing this payload describes.
 *
 * Named structurally rather than as `Listing`, because the offer page holds a
 * `ListingWithCoach` — a narrower row that carries no `deleted_by` and no
 * `asset_path` — and a function that demanded the wider type would force a
 * cast at the one call site that matters. Asking for exactly what is used also
 * means `asset_path`, which is withheld from the client column grant on
 * purpose, cannot arrive here by accident.
 */
type StructuredListing = Pick<Listing, 'id' | 'title' | 'description' | 'price_cents' | 'category'>;

/** `schema.org/Product`, with the coach as the seller of the `Offer`. */
export function offerStructuredData(input: {
  listing: StructuredListing;
  coach: PublicCoach | null;
  stats: OfferStats | null;
}): Record<string, unknown> {
  const { listing, coach, stats } = input;
  const origin = siteUrl();
  const url = `${origin}/offers/${listing.id}`;

  const seller =
    coach === null
      ? undefined
      : {
          '@type': 'Person',
          name: coach.full_name,
          url: `${origin}/coaches/${coach.id}`,
        };

  /*
   * `image` is the coach's avatar, and it is the seller's picture rather than
   * the product's — which is honest, because an offer has no image of its own
   * and inventing one would be rule 1 broken. Omitted entirely when there is no
   * avatar: a missing `image` costs a rich result, and a broken one costs
   * trust.
   */
  const image = avatarPublicUrl(coach?.avatar_path ?? null);

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: listing.title,
    description: listing.description,
    category: listingCategoryLabel(listing.category),
    url,
    ...(image === null ? {} : { image }),
    ...(seller === undefined ? {} : { brand: seller }),
    offers: {
      '@type': 'Offer',
      url,
      price: priceAmount(listing.price_cents),
      priceCurrency: PRICE_CURRENCY,
      /*
       * An offer that is published and not withdrawn can be claimed, and this
       * function is only ever called for one that is — the withdrawn tombstone
       * returns before it. `InStock` rather than a made-up availability window,
       * because there is no stock count and digital delivery has no lead time.
       */
      availability: 'https://schema.org/InStock',
      ...(seller === undefined ? {} : { seller }),
    },
    ...(!dataIsFabricated() && stats !== null && stats.rating_average !== null && stats.review_count > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: stats.rating_average,
            reviewCount: stats.review_count,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
  };
}

/**
 * `schema.org/ProfilePage` wrapping a `Person`.
 *
 * DELIBERATELY NO `aggregateRating`, even though the page renders one and
 * `CoachStats` has it. `aggregateRating` is not a property of `Person` in
 * schema.org — it belongs to things that are offered, like a `Product` or a
 * `Service` — and emitting an invalid property to win a rich result is how a
 * whole page's structured data gets ignored. The ratings are published where
 * they are valid: on each of that coach's offers.
 */
export function coachStructuredData(coach: PublicCoach): Record<string, unknown> {
  const origin = siteUrl();
  const image = avatarPublicUrl(coach.avatar_path);

  /*
   * The headline first, because it is what the page leads with; the bio only
   * when there is no headline. Not both concatenated — `description` is one
   * sentence to a crawler, and gluing two together produces a snippet that
   * reads as neither.
   */
  const description = coach.coach_headline ?? coach.coach_bio;

  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person',
      name: coach.full_name,
      url: `${origin}/coaches/${coach.id}`,
      jobTitle: 'Coach',
      ...(description === null ? {} : { description }),
      ...(image === null ? {} : { image }),
      worksFor: {
        '@type': 'Organization',
        name: 'JavelinHub',
        url: origin,
      },
    },
  };
}
