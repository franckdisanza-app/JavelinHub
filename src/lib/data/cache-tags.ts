/**
 * =============================================================================
 * The four cache tags, and the one function that clears them.
 * =============================================================================
 *
 * `src/lib/data/cached.ts` tags every cached public read with one of these;
 * every Server Action that changes what those reads return calls
 * {@link invalidatePublicData} afterwards.
 *
 * -----------------------------------------------------------------------------
 * WHY FOUR TAGS AND NOT FORTY
 * -----------------------------------------------------------------------------
 * The precise version of this is per-entity: `listing:<id>`, `coach:<id>`, and
 * a write invalidates exactly the pages that showed that row. It is tempting,
 * and it is the wrong trade here.
 *
 * A stale page is a correctness bug that nobody reports, because it looks like a
 * page. Per-entity tags multiply the number of places a write has to remember
 * which ids it touched — and the writes in this app touch more than they look
 * like they do: withdrawing ONE offer changes the browse grid, the coach's
 * profile, that coach's card in the directory, the cross-sell grid on four other
 * offers, and every aggregate on all of them. Getting that list right at each of
 * a dozen call sites, for ever, is not a thing to rely on.
 *
 * So the tags are coarse and the invalidation is one call with no arguments to
 * get wrong. The cost is real and bounded: one coach editing one offer drops the
 * cached browse page for everybody, and the next visitor pays for one query that
 * was going to be re-run within the minute anyway — see
 * `PUBLIC_REVALIDATE_SECONDS` in `cached.ts`. That is a much better failure mode
 * than a coach withdrawing an offer and watching it stay on sale.
 *
 * The tags are separate rather than one because they expire independently in the
 * common case: a new review changes `reviews` and `stats` and nothing else, and
 * there is no reason for it to drop the coach directory too.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT TAGGED
 * -----------------------------------------------------------------------------
 * Everything personalised. Purchases, sales, the coach dashboard, every admin
 * queue, `getListingForViewer` — none of it is cached at all, because none of it
 * is the same for two people. See `publicClient.ts` for the boundary, which is
 * the same boundary: a read that needs to know who is asking is a read that
 * cannot be shared.
 */

/** The public reads, grouped by what a write can make stale. */
export const CACHE_TAGS = {
  /** Offer rows: browse, an offer's own page, a coach's offer list. */
  listings: 'public:listings',
  /** Coach rows: the directory and a coach's public profile. */
  coaches: 'public:coaches',
  /** Published review text, wherever it is shown. */
  reviews: 'public:reviews',
  /** The aggregates — ratings and sale counts — for offers and for coaches. */
  stats: 'public:stats',
} as const;

export type CacheTag = (typeof CACHE_TAGS)[keyof typeof CACHE_TAGS];

/**
 * Drops the cached public reads a write has just made stale.
 *
 * **Call this from a Server Action, after the write succeeds and before any
 * redirect.** `revalidateTag` expires the entries rather than refreshing them in
 * the background, so the coach who just pressed Publish sees their offer in the
 * list — a stale-while-revalidate hand-back would show them the list WITHOUT it,
 * which reads as the button not having worked.
 *
 * Takes the tags explicitly rather than always clearing all four, because the
 * common writes genuinely touch one or two — but each caller passes a GROUP, not
 * an id, so there is no per-row bookkeeping to get wrong.
 *
 * The dynamic import is the same accommodation `serverClient.ts` makes: these
 * action modules sit in a graph that `verify:authz` loads under plain Node,
 * where `next/cache` does not resolve.
 */
export async function invalidatePublicData(...tags: readonly CacheTag[]): Promise<void> {
  const { revalidateTag } = await import('next/cache');
  // `{ expire: 0 }`, not the recommended `'max'`. That profile is
  // stale-while-revalidate: it serves the OLD entry once more while a fresh one
  // is built behind it, which is right for a background refresh and wrong here —
  // the caller is a coach who just pressed Publish, and the page they land on
  // must contain what they published. Expiring at zero makes the next read pay
  // for one query and be correct.
  //
  // The single-argument form is deprecated in Next 16 and errors under the
  // current types.
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
}

/**
 * Everything. For the writes whose blast radius genuinely is everything —
 * suspending a coach takes their offers off sale, which changes the browse grid,
 * the directory, every aggregate, and the review lists that named those offers.
 */
export async function invalidateAllPublicData(): Promise<void> {
  await invalidatePublicData(
    CACHE_TAGS.listings,
    CACHE_TAGS.coaches,
    CACHE_TAGS.reviews,
    CACHE_TAGS.stats,
  );
}
