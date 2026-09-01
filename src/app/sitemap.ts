import type { MetadataRoute } from 'next';

import { cachedCoaches, cachedListings } from '@/lib/data/cached';
import { MAX_PAGE_SIZE, type Page, type PageRequest } from '@/lib/data/pagination';
import { siteUrl } from '@/lib/env';

/**
 * =============================================================================
 * The sitemap.
 * =============================================================================
 *
 * Two dynamic route families are the product's public surface — `/offers/[id]`
 * and `/coaches/[id]` — and neither is linked from anywhere a crawler can
 * exhaustively walk: browse is keyset-paginated, so the only way past page one
 * is a cursor in a URL nothing links to. Without this file everything past the
 * first twenty-four offers is unreachable to a crawler.
 *
 * READS THE CACHED PUBLIC LISTS, deliberately. `cachedListings` and
 * `cachedCoaches` are the same reads the browse pages use, go through the
 * cookie-free client, and are already tagged and invalidated by every write
 * that changes them — so a crawl costs at most one query per tag window rather
 * than a full table walk each time. They also carry the `deleted_at is null`
 * predicate and the approved-coach predicate inside the view, which is what
 * keeps a withdrawn offer and a suspended coach out of here without this file
 * having to remember to filter.
 *
 * BOUNDED, and not by politeness. `drainAll` exists for writers that must cover
 * a whole set and THROWS when it runs past its page limit, which is right when
 * the caller's contract is "I saw everything" and wrong here: a sitemap that
 * 500s once the catalogue is large is worse than one that is missing its tail.
 * So this walks its own pages and stops, and the cap is stated rather than
 * implied.
 *
 * `force-dynamic` for the same reason as `robots.ts`: `siteUrl()` throws in
 * production when `NEXT_PUBLIC_SITE_URL` is unset, and a build must not be the
 * thing that asks.
 */
export const dynamic = 'force-dynamic';

/**
 * Search engines cap a single sitemap at 50,000 URLs. This is far below that
 * and is about read cost, not the protocol: past this the answer wants to be a
 * sitemap index with one file per family, which is a different shape and should
 * be written when it is actually needed rather than guessed at now.
 */
const MAX_URLS_PER_FAMILY = 5_000;

/** Walks a paginated read, newest first, and stops at `limit` rows. */
async function collect<T>(
  fetchPage: (page: PageRequest) => Promise<Page<T>>,
  limit: number,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;

  while (items.length < limit) {
    const page: Page<T> = await fetchPage({ cursor, limit: MAX_PAGE_SIZE });
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return items.slice(0, limit);
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteUrl();

  const [offers, coaches] = await Promise.all([
    collect((page) => cachedListings(undefined, page), MAX_URLS_PER_FAMILY),
    collect((page) => cachedCoaches(undefined, page), MAX_URLS_PER_FAMILY),
  ]);

  return [
    // The static pages, highest first. `/` and the two browse roots are the
    // only ones worth a priority hint; everything else is left at the default,
    // because inventing a gradient across five hundred offers says nothing.
    { url: `${origin}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/offers`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${origin}/coaches`, changeFrequency: 'daily', priority: 0.9 },

    // `updated_at` is the honest `lastModified`: it is stamped by the
    // `listings_set_updated_at` trigger on every edit, so it moves when the
    // page's content does.
    ...offers.map((offer) => ({
      url: `${origin}/offers/${offer.id}`,
      lastModified: new Date(offer.updated_at),
      changeFrequency: 'weekly' as const,
    })),

    // No `lastModified` for a coach. `PublicCoach` deliberately projects no
    // timestamp — `public_coaches` carries `created_at` for ORDERING only and
    // the type does not expose it — and inventing `new Date()` here would tell
    // every crawler that every coach changed on every crawl.
    ...coaches.map((coach) => ({
      url: `${origin}/coaches/${coach.id}`,
      changeFrequency: 'weekly' as const,
    })),
  ];
}
