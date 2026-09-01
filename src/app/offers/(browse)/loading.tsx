import { Skeleton, SkeletonCardGrid } from '@/components/ui/skeleton';

/**
 * =============================================================================
 * THE ONE THING TO READ BEFORE ADDING A SECOND OF THESE
 * =============================================================================
 *
 * A `loading.tsx` wraps its segment in `<Suspense>`, and **the response status
 * is committed the moment that fallback renders.** Next's own documentation is
 * unambiguous: *"When streaming, a `200` status code will be returned… Because
 * the response headers have already been sent to the client, the status code of
 * the response cannot be updated."*
 *
 * THIS APP HAS ALREADY PAID FOR THAT LESSON ONCE. `docs/ROADMAP.md` §6 records
 * Cache Components being built, measured and backed out for exactly this
 * property — `<Suspense>` on all 23 pages made `/settings` answer `200` with
 * `NEXT_REDIRECT` in the body, `/admin/reports` answer `200` to a signed-out
 * visitor, and an unknown offer answer `200` instead of `404`. The conclusion
 * there applies here word for word: *"Nearly every route here answers an
 * authorization question with a status code, and the admin routes rely on
 * 404-versus-200 to hide their own existence."*
 *
 * So a `loading.tsx` is only correct on a route that answers **200 to every
 * visitor, always**. Two routes in this application qualify, and this is one of
 * them: `/offers` has no `requireUser()`, no `requireAdmin()`, no `notFound()`
 * and no `redirect()` — an unrecognised `?category=` renders an empty state
 * rather than a 404, deliberately. `/coaches` is the other and is the same
 * shape. **Every other page in `src/app/` must not get one**, and the fix for
 * their perceived latency is a narrower `<Suspense>` *below* the status
 * decision, not a boundary above it.
 *
 * -----------------------------------------------------------------------------
 * WHICH IS WHY `(browse)` EXISTS, AND IT IS NOT COSMETIC GROUPING
 * -----------------------------------------------------------------------------
 * A `loading.tsx` does not wrap its own page. It wraps its **segment and
 * everything nested below it** — so this file sitting at `src/app/offers/`
 * would have put a Suspense boundary over `/offers/[id]` and `/offers/new` as
 * well, and both of those decide a status: the offer page calls `notFound()`
 * for an offer the viewer may not see, and the composer calls `requireUser()`.
 *
 * That is not a hypothetical. It was written that way first, and
 * `npm run verify:pages` failed three assertions immediately — *"a withdrawn
 * offer is a 404 for the public — expected 404, got 200"* twice over, plus the
 * signed-in stranger. The route group is what confines the boundary to this one
 * page: `(browse)` adds nothing to the URL, contains nothing but this file and
 * `page.tsx`, and leaves `[id]` and `new` as siblings the boundary cannot
 * reach.
 *
 * **So do not move this file up one level, and do not add a `page.tsx` beside
 * it.** The suite is what would catch it, and only because those three
 * assertions happen to exist.
 *
 * -----------------------------------------------------------------------------
 * WHY IT IS WORTH HAVING ON PRECISELY THIS PAGE
 * -----------------------------------------------------------------------------
 * `PROGRESS.md` measured this route at **712ms cold** under `next start`, and
 * it is the busiest public surface in the product. Until now every one of those
 * milliseconds was spent with the previous screen still on display and nothing
 * to say a click had registered.
 *
 * The header and the filter row are drawn as real markup rather than as
 * placeholders, because they are static: they do not depend on the read that is
 * being waited for, so showing their shapes is honest and showing grey bars in
 * their place would not be.
 */
export default function LoadingOffers() {
  return (
    <div
      // ONE announcement for the whole screen, rather than a dozen from the
      // blocks inside it — every `Skeleton` is `aria-hidden` for that reason.
      // `polite` because this interrupts nothing; the user asked for it.
      role="status"
      aria-live="polite"
      className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14"
    >
      <span className="sr-only">Loading offers</span>

      {/* The real heading, not a placeholder: it is the same on every render of
          this route, and a page whose own title flickers in reads as broken. */}
      <header aria-hidden="true">
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Browse offers</h1>
        <Skeleton className="mt-2.5 h-4 w-80 max-w-full" />
      </header>

      {/* The filter row: five controls at `sm:items-end`, matching the real
          form's heights so the row does not resize when it arrives. */}
      <div aria-hidden="true" className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <Skeleton className="h-11 flex-1" />
        <Skeleton className="h-11 sm:w-56" />
        <Skeleton className="h-11 sm:w-28" />
        <Skeleton className="h-11 sm:w-28" />
        <Skeleton className="h-11 sm:w-40" />
      </div>

      <Skeleton className="mt-4 h-3 w-64 max-w-full" />

      <SkeletonCardGrid />
    </div>
  );
}
