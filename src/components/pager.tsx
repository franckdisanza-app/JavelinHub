import Link from 'next/link';

import { cn } from '@/components/ui/cn';

export interface PagerProps {
  /** The path this list lives on, without a query string. */
  basePath: string;
  /** Everything else in the URL that must survive the click — filters, tabs, the other list's cursor. */
  params?: Record<string, string | undefined>;
  /** The query parameter this list reads its cursor from. Two lists on one page need two names. */
  cursorParam: string;
  /** From the page just rendered. `null` means this is the last one. */
  nextCursor: string | null;
  /** Whether the reader is already past page one — i.e. whether "Start again" means anything. */
  onFirstPage: boolean;
  /** How many rows are on screen, and how many there are in total. */
  shown: number;
  total: number | null;
  /** The plural noun, for the count line: "offers", "reviews", "sales". */
  noun: string;
  className?: string;
}

/**
 * "Next", and where you are.
 *
 * =============================================================================
 * WHY THERE IS NO "PREVIOUS", AND NO PAGE NUMBERS
 * =============================================================================
 * Keyset pagination can only walk forwards: a cursor names the last row of the
 * page you are on, and there is no arithmetic that turns it into the first row
 * of the page before. Offset pagination could number pages, and this codebase
 * deliberately does not use it — see `src/lib/data/pagination.ts` for the two
 * reasons, of which the one that matters here is that page 2 of an offset list
 * silently repeats and skips rows whenever anybody publishes something.
 *
 * So backwards is the browser's Back button, which works perfectly: every page
 * is its own URL and its own history entry. What this component adds is the one
 * thing Back cannot do — **"Start again"**, for somebody eleven pages deep who
 * wants the top of the list without eleven clicks.
 *
 * =============================================================================
 * THE COUNT IS NOT DECORATION
 * =============================================================================
 * "24 of 137 offers" is the only thing on the page that says how much there is.
 * Without it a reader cannot tell a full page followed by one more row from a
 * full page followed by four hundred, and "Next" alone gives no sense of depth.
 *
 * `total` is `null` when the backend could not count, and that renders as no
 * count at all rather than as zero — "0 offers" over a screen of offers is worse
 * than saying nothing.
 */
export function Pager({
  basePath,
  params,
  cursorParam,
  nextCursor,
  onFirstPage,
  shown,
  total,
  noun,
  className,
}: PagerProps) {
  // Nothing to say: one page, from the start, and the count is already obvious
  // from the list itself.
  if (nextCursor === null && onFirstPage) return null;

  return (
    <nav
      aria-label={`More ${noun}`}
      className={cn('flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4', className)}
    >
      <p className="text-body-15 text-muted">
        {total === null
          ? `${shown} ${noun} on this page`
          : `${shown} of ${total} ${total === 1 ? noun.replace(/s$/, '') : noun}`}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/*
          `Start again` and not `First page`: with no page numbers anywhere,
          "first" invites the reader to look for a "second" that does not exist.
        */}
        {!onFirstPage ? (
          <Link href={hrefFor(basePath, params, cursorParam, null)} className={pagerLinkClass}>
            Start again
          </Link>
        ) : null}

        {nextCursor !== null ? (
          <Link href={hrefFor(basePath, params, cursorParam, nextCursor)} className={pagerLinkClass}>
            Next<span className="sr-only"> {noun}</span>
          </Link>
        ) : (
          // Rendered as text rather than omitted, so the row does not change
          // width on the last page and the "Start again" link does not jump
          // across to where "Next" used to be.
          <span className="inline-flex min-h-11 items-center px-3.5 text-sm font-medium text-faint">
            End of the list
          </span>
        )}
      </div>
    </nav>
  );
}

// Square, like every other control. Section 06: there is no radius token.
const pagerLinkClass =
  'inline-flex min-h-11 items-center border border-line-strong bg-surface px-3.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink';

/**
 * The next URL, carrying every other parameter forward.
 *
 * That carrying is the whole job. A pager that dropped `?q=` would silently
 * change what the reader is browsing on the second page — which is the same
 * class of bug as an unstable sort, and just as invisible.
 *
 * Empty values are omitted rather than written as `?q=`, so a URL that has been
 * paged and un-paged comes back byte-identical to the one that was bookmarked.
 */
function hrefFor(
  basePath: string,
  params: Record<string, string | undefined> | undefined,
  cursorParam: string,
  cursor: string | null,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' && value !== '' && key !== cursorParam) search.set(key, value);
  }
  if (cursor !== null) search.set(cursorParam, cursor);

  const query = search.toString();
  return query === '' ? basePath : `${basePath}?${query}`;
}
