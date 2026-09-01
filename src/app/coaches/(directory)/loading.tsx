import { Skeleton, SkeletonCardGrid } from '@/components/ui/skeleton';

/**
 * The coach directory's loading state.
 *
 * **Read the header of `src/app/offers/(browse)/loading.tsx` before adding
 * another of these anywhere.** Two things it establishes, both load-bearing:
 * a `loading.tsx` commits a `200` the moment its fallback renders, so it is
 * only correct on a route that answers 200 to every visitor unconditionally;
 * and it covers its whole SUBTREE, not its own page.
 *
 * `(directory)` is the second half of that. `/coaches/[id]` calls `notFound()`
 * for anyone who is not an approved coach — which is how the directory keeps a
 * suspended coach's page from confirming it ever existed — and a boundary at
 * `src/app/coaches/` would have turned that 404 into a 200. The route group
 * adds nothing to the URL and confines the boundary to this page.
 *
 * Measured at **165ms cold, 13ms warm** — an order of magnitude cheaper than
 * `/offers`, because the directory reads one view and one batched stats call
 * rather than a filtered listing plus two batched joins. It gets a fallback
 * anyway: 165ms is above the ~100ms threshold at which a click stops feeling
 * connected to its result, and the cold path is what a first-time visitor gets.
 *
 * The card shape is the coach one, not the offer one: an avatar tile, a name,
 * a headline and a single stat, measured at 126px against `CoachCard`'s own
 * `offsetHeight`. Matching the real geometry is the point — a placeholder of the
 * wrong height replaces one layout shift with another, which is exactly what the
 * first draft of `skeleton.tsx` did.
 */
export default function LoadingCoaches() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14"
    >
      <span className="sr-only">Loading coaches</span>

      <header aria-hidden="true">
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Coaches</h1>
        <Skeleton className="mt-2.5 h-4 w-72 max-w-full" />
      </header>

      {/* One search field and its submit pair, which is the whole form here. */}
      <div aria-hidden="true" className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <Skeleton className="h-11 flex-1" />
        <Skeleton className="h-11 sm:w-40" />
      </div>

      <SkeletonCardGrid variant="coach" />
    </div>
  );
}
