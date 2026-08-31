/**
 * =============================================================================
 * The cached public reads.
 * =============================================================================
 *
 * Every function here wraps one `DataClient` method in `unstable_cache`. They are
 * the only cached reads in the app, and the list is closed on purpose — see
 * `cache-tags.ts` for what is deliberately absent, and `publicClient.ts` for the
 * rule that decides.
 *
 * -----------------------------------------------------------------------------
 * WHY `unstable_cache` AND NOT `use cache`
 * -----------------------------------------------------------------------------
 * Next 16's Cache Components (`cacheComponents: true`, `use cache`, `cacheLife`,
 * `cacheTag`) is the direction the framework is going, and this app was built
 * against it, measured, and then backed out. The reason is worth writing down,
 * because it is not a matter of taste and the next person will otherwise try it
 * again.
 *
 * **Cache Components requires every route to produce a static shell**, which
 * means the response's first bytes — and therefore its STATUS — are committed
 * before the page runs. Nearly every route here answers an authorization
 * question with a status code:
 *
 *   * `requireUser()` → 307 to `/login?next=…`
 *   * `requireAdmin()` and `notFound()` → 404, so that a page's existence is
 *     never confirmed to somebody who may not see it.
 *
 * With a `<Suspense>` boundary above them — and one is unavoidable, because the
 * site header reads the session and the root layout renders it on every route —
 * those become a 200 whose body carries `NEXT_REDIRECT`. Measured under
 * `next start`: `/settings` answered `200` with no `Location` header, and
 * `/admin/reports` answered `200` for a signed-out visitor. The redirect is then
 * one only a JavaScript client follows, and the 404-versus-200 distinction that
 * the admin routes rely on to hide their own existence is gone.
 *
 * The two ways out were both worse:
 *
 *   * **Move the gates into `proxy.ts`.** Middleware runs before rendering and
 *     can set a real status — but the admin gate needs a ROLE, which this app
 *     deliberately keeps out of the session cookie so that a promotion or a
 *     revocation takes effect on the next request. That means a second
 *     authorization implementation, in a second place, for a codebase whose
 *     stated rule is that `requireAdmin()` plus the data layer's own check are
 *     the enforcement.
 *   * **Two root layouts**, one with the boundary and one without, via route
 *     groups. Navigating between two root layouts is a full page load, so every
 *     click from `/offers` to `/settings` would reload the document.
 *
 * So: the caching, without the rendering model. `unstable_cache` caches the same
 * reads, keyed the same way, invalidated by the same tags — and the routes keep
 * answering with the status they mean. If the gates ever move to middleware for
 * other reasons, revisit this; the tag names and the call sites would not change.
 *
 * -----------------------------------------------------------------------------
 * WHY A SEPARATE MODULE INSTEAD OF CACHING INSIDE THE DATA LAYER
 * -----------------------------------------------------------------------------
 * 1. **The mock and Supabase must stay the same shape.** `DataClient` is one
 *    interface with two implementations and three suites asserting they agree.
 *    Caching inside either one would be a behaviour the other does not have, and
 *    `verify:authz` — which calls the mock a thousand times and asserts on what
 *    comes back — would be asserting against a cache.
 * 2. **Caching is a rendering decision, not a data decision.** Whether a read may
 *    be shared between two visitors depends on who is asking, which the data
 *    layer deliberately does not know. This module is the one place that answer
 *    is given, and it is one file to audit.
 * 3. The data layer runs under plain Node in two of the three suites, where
 *    `next/cache` does not resolve.
 *
 * -----------------------------------------------------------------------------
 * WHAT MAKES A READ ELIGIBLE
 * -----------------------------------------------------------------------------
 * Its answer must be the same for everybody. Every method below is one of the
 * reads `supabaseClient.ts` routes through `openPublicContext()` — the
 * cookie-free client — so there is no session in the call stack that could vary
 * the result and quietly get cached against the wrong person.
 * `getListingForViewer` is absent for exactly that reason: its answer depends on
 * who is looking.
 *
 * -----------------------------------------------------------------------------
 * CACHE KEYS
 * -----------------------------------------------------------------------------
 * `unstable_cache` keys on the function's arguments plus the key parts given
 * here, so `cachedListings({ q: 'javelin' }, { cursor })` and
 * `cachedListings({ q: 'javelin' })` are different entries. Everything passed in
 * is a plain serialisable object — a class instance or an actor would either
 * fail to serialise or widen the key space until the hit rate reached zero.
 *
 * SERVER ONLY.
 */

import { unstable_cache } from 'next/cache';

import { CACHE_TAGS } from './cache-tags';
import type { CoachDirectoryFilter, ListingFilter } from './client';
import { getDataClient } from './index';
import type { PageRequest } from './pagination';

/*
 * Sixty seconds, and it is a deliberate floor rather than a default.
 *
 * Every write path calls `invalidatePublicData`, so this window is NOT how a
 * change reaches a reader — it is the backstop for the one case tags cannot
 * cover: a row changed by something outside the app, which for this project
 * means the SQL editor and the demo seed.
 *
 * An hour would cache better and would make a missed invalidation last an hour.
 * This product sells things, and an offer that stays on sale after its coach
 * withdrew it is worse than a cache miss.
 */
const PUBLIC_REVALIDATE_SECONDS = 60;

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export const cachedListings = unstable_cache(
  async (filter?: ListingFilter, page?: PageRequest) => getDataClient().listListings(filter, page),
  ['public-listings'],
  {
    revalidate: PUBLIC_REVALIDATE_SECONDS,
    // Tagged with `stats` as well, and this is the subtle one: a browse card
    // carries the offer's rating and sale count, so a new review makes THIS
    // entry stale even though no listing row changed.
    tags: [CACHE_TAGS.listings, CACHE_TAGS.stats],
  },
);

export const cachedListingsByCoach = unstable_cache(
  // `null` actor, matching the method's own contract: this read is public and
  // never consults one. Passing an actor would put it in the cache key and make
  // a per-visitor entry of a shared page, which is the opposite of the point.
  async (coachId: string, page?: PageRequest) =>
    getDataClient().listListingsByCoach(null, coachId, page),
  ['public-listings-by-coach'],
  { revalidate: PUBLIC_REVALIDATE_SECONDS, tags: [CACHE_TAGS.listings, CACHE_TAGS.stats] },
);

export const cachedCategories = unstable_cache(
  async () => getDataClient().listCategories(),
  ['listing-categories'],
  // The one thing here that genuinely never changes: `listCategories` returns
  // the `listing_category` enum from a constant, without a round trip. No
  // `revalidate` and no tags — it is cached until the deploy that changes it.
  {},
);

// ---------------------------------------------------------------------------
// Coaches
// ---------------------------------------------------------------------------

export const cachedCoaches = unstable_cache(
  async (filter?: CoachDirectoryFilter, page?: PageRequest) =>
    getDataClient().listCoaches(filter, page),
  ['public-coaches'],
  { revalidate: PUBLIC_REVALIDATE_SECONDS, tags: [CACHE_TAGS.coaches] },
);

export const cachedPublicCoach = unstable_cache(
  async (coachId: string) => getDataClient().getPublicCoach(coachId),
  ['public-coach'],
  { revalidate: PUBLIC_REVALIDATE_SECONDS, tags: [CACHE_TAGS.coaches] },
);

export const cachedPublicProfiles = unstable_cache(
  async (userIds: readonly string[]) => getDataClient().listPublicProfiles(userIds),
  ['public-profiles'],
  {
    revalidate: PUBLIC_REVALIDATE_SECONDS,
    // `coaches`, because the only thing a caller reads off these rows is
    // `is_approved_coach` — whether a name may be a link — and that is exactly
    // what an approval or a suspension changes.
    tags: [CACHE_TAGS.coaches],
  },
);

// ---------------------------------------------------------------------------
// Reviews, and the numbers computed from them
// ---------------------------------------------------------------------------

export const cachedReviewsForListing = unstable_cache(
  async (listingId: string, page?: PageRequest) =>
    getDataClient().listReviewsForListing(listingId, page),
  ['public-listing-reviews'],
  { revalidate: PUBLIC_REVALIDATE_SECONDS, tags: [CACHE_TAGS.reviews] },
);

export const cachedReviewsForCoach = unstable_cache(
  async (coachId: string, page?: PageRequest) => getDataClient().listReviewsForCoach(coachId, page),
  ['public-coach-reviews'],
  { revalidate: PUBLIC_REVALIDATE_SECONDS, tags: [CACHE_TAGS.reviews] },
);

export const cachedOfferStats = unstable_cache(
  async (listingId: string) => getDataClient().getOfferStats(listingId),
  ['offer-stats'],
  { revalidate: PUBLIC_REVALIDATE_SECONDS, tags: [CACHE_TAGS.stats] },
);

export const cachedOfferStatsFor = unstable_cache(
  async (listingIds: readonly string[]) => getDataClient().listOfferStats(listingIds),
  ['offer-stats-batch'],
  { revalidate: PUBLIC_REVALIDATE_SECONDS, tags: [CACHE_TAGS.stats] },
);

export const cachedCoachStats = unstable_cache(
  async (coachId: string) => getDataClient().getCoachStats(coachId),
  ['coach-stats'],
  { revalidate: PUBLIC_REVALIDATE_SECONDS, tags: [CACHE_TAGS.stats] },
);

export const cachedCoachStatsFor = unstable_cache(
  async (coachIds: readonly string[]) => getDataClient().listCoachStats(coachIds),
  ['coach-stats-batch'],
  { revalidate: PUBLIC_REVALIDATE_SECONDS, tags: [CACHE_TAGS.stats] },
);
