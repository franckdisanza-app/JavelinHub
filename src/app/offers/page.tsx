import type { Metadata } from 'next';
import Link from 'next/link';

import { ListingCard } from '@/components/listing-card';
import { Pager } from '@/components/pager';
import { Alert } from '@/components/ui/alert';
import { Button, linkButtonClass } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getDataClient } from '@/lib/data';
import { emptyPage } from '@/lib/data/pagination';
import type { ListingWithCoach } from '@/lib/data/types';
import {
  LISTING_CATEGORY_LABELS,
  isListingCategory,
  type ListingCategory,
} from '@/lib/data/types';
import { isListingSort, type ListingSort } from '@/lib/data';
import { parsePriceToCents } from '@/lib/format';
import { firstValue } from '@/lib/search-params';

export const metadata: Metadata = { title: 'Browse offers' };

const ALL_CATEGORIES = '';

/**
 * Public offer browse + search. Works signed out — nothing here takes an actor.
 *
 * The route is `/offers`; `/browse` redirects here with `?q=` and `?category=`
 * intact (next.config.ts). The model is still called `listing` everywhere below
 * the copy — the type, the table and the RLS policy set keep that name on
 * purpose. Only what a visitor reads says "offer".
 *
 * Filter state lives entirely in the URL, via a plain GET form. That makes
 * every result set linkable and shareable, makes back/forward behave, and means
 * search keeps working with JavaScript disabled. There is no client component
 * on this page at all.
 */
export default async function OffersPage({
  searchParams,
}: {
  // A Promise in this version of Next — it must be awaited before use.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = firstValue(params.q).trim();

  // `?category=` is untrusted: anyone can hand-type it, and a stale bookmark can
  // hold a slug from before a taxonomy change. It is validated against the
  // taxonomy here and never passed through raw.
  //
  // An unknown value is treated as a filter that matches nothing, NOT as no
  // filter at all. Silently widening would answer a filtered URL with the full
  // catalogue and no explanation; matching nothing and saying so is the honest
  // reading of "show me a category that does not exist". The `<select>` below
  // falls back to "All categories", which is now the correct recovery — there
  // is no legitimate value it could be showing instead, so the old synthetic
  // `(no matches)` option has nothing left to represent and is gone.
  const rawCategory = firstValue(params.category).trim();
  const category: ListingCategory | null = isListingCategory(rawCategory) ? rawCategory : null;
  const unknownCategory = rawCategory !== '' && category === null;

  /*
   * The price bounds arrive as whatever somebody typed. `parsePriceToCents` is
   * the same parser the offer composer uses, so "12", "12.50" and "£12.50" all
   * mean the same thing in the filter as they do in the form — and anything it
   * cannot read becomes `null`, i.e. no bound, rather than zero. A filter that
   * silently read a typo as "£0.00 and under" would return nothing and give the
   * visitor no clue why.
   */
  const rawMin = firstValue(params.min).trim();
  const rawMax = firstValue(params.max).trim();
  const minPriceCents = rawMin === '' ? null : parsePriceToCents(rawMin);
  const maxPriceCents = rawMax === '' ? null : parsePriceToCents(rawMax);

  // Read once and narrowed once — calling `firstValue` twice would leave the
  // second call outside the guard's narrowing, which is what the compiler
  // objects to and is also a second parse of the same parameter.
  const rawSort = firstValue(params.sort).trim();
  const sort: ListingSort = isListingSort(rawSort) ? rawSort : 'newest';
  const cursor = firstValue(params.after).trim();

  const db = getDataClient();
  const [page, categories] = await Promise.all([
    // Short-circuited rather than queried: `listListings` would also return an
    // empty page for an out-of-taxonomy slug, but not asking is clearer than
    // relying on it.
    unknownCategory
      ? Promise.resolve(emptyPage<ListingWithCoach>())
      : db.listListings(
          {
            q: q || undefined,
            category: category ?? undefined,
            minPriceCents: minPriceCents ?? undefined,
            maxPriceCents: maxPriceCents ?? undefined,
            sort,
          },
          { cursor: cursor || undefined },
        ),
    db.listCategories(),
  ]);
  const listings = page.items;

  // ---------------------------------------------------------------------------
  // Two batched reads, never N per card.
  //
  // `listOfferStats` exists precisely so a grid costs one query: the Supabase
  // implementation serves it from a single grouped select against
  // `public.offer_stats`, and a `getOfferStats` per card would be a performance
  // cliff that only appears after the backend swap. `listCoaches` is the same
  // shape of trade for the coach links below — one read for the page instead of
  // a `getPublicCoach` per card.
  //
  // KEYED BY ID, NOT ZIPPED BY INDEX, and that is not defensive tidiness.
  // `listOfferStats` DROPS ids it has no row for (unknown ones, and withdrawn
  // ones), unlike `listCoachStats`, which keeps every id. A positional zip is
  // therefore wrong by construction here: one dropped row shifts every card
  // after it and prints one offer's rating under another offer's title. The
  // method's contract does promise the order it was given — E5 added the
  // assertion that was missing for it — but a caller that cannot be misaligned
  // at all is better than a caller that relies on a promise.
  // ---------------------------------------------------------------------------
  const [offerStats, coachProfiles] = await Promise.all([
    db.listOfferStats(listings.map((listing) => listing.id)),
    // BY THE IDS ON THIS PAGE, not the whole coach directory. The directory is
    // itself a page now, so asking it would answer "is this coach approved?"
    // with "they were not in the first 24", and a coach further down the list
    // would silently stop being a link.
    db.listPublicProfiles(listings.map((listing) => listing.coach_id)),
  ]);
  const statsById = new Map(offerStats.map((stats) => [stats.listing_id, stats]));
  // Which coach names may be links. `getPublicCoach` — and this directory read —
  // return nothing for a coach who is not APPROVED, and that state is reachable
  // while their offers stay published: a learner can file an application, redeem
  // an invite code (which approves them without closing the application),
  // publish offers, and then have the still-pending application rejected, which
  // sets `coach_status = 'rejected'` under them. Linking unconditionally would
  // 404. This is the same rule `/coaches/[id]` already applies to a review's
  // offer title: link only what a visitor can actually open.
  const approvedCoachIds = new Set(
    coachProfiles.filter((profile) => profile.is_approved_coach).map((profile) => profile.id),
  );

  const filtered = q !== '' || rawCategory !== '' || rawMin !== '' || rawMax !== '' || sort !== 'newest';
  // Everything the pager has to carry forward, so page two is still the same
  // search. Written from the VALIDATED values, so a bogus `?sort=` is dropped
  // rather than propagated.
  const pagerParams = {
    q: q || undefined,
    category: category ?? undefined,
    min: rawMin || undefined,
    max: rawMax || undefined,
    sort: sort === 'newest' ? undefined : sort,
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Browse offers</h1>
        <p className="mt-1.5 text-sm text-muted">
          Every offer published by an approved coach on JavelinHub.{' '}
          <Link href="/coaches" className="underline underline-offset-2 hover:text-ink">
            Browse coaches instead
          </Link>
          .
        </p>
      </header>

      {/*
        `method="get"` is what puts the filters in the URL. Each control is named
        after the search param it drives, so the browser builds the query string
        and no JavaScript is involved.
      */}
      <form method="get" className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <Field
          id="q"
          label="Search"
          hint="Matches offer titles and descriptions."
          className="flex-1"
        >
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="e.g. javelin, mobility, video"
            aria-describedby={fieldDescribedBy('q', { hint: true })}
          />
        </Field>

        <Field id="category" label="Category" className="sm:w-56">
          {/*
            `defaultValue` is the validated slug, never the raw param — an
            unrecognised one selects "All categories" rather than being written
            back into the DOM as an option value.
          */}
          <Select id="category" name="category" defaultValue={category ?? ALL_CATEGORIES}>
            <option value={ALL_CATEGORIES}>All categories</option>
            {/*
              All eight, always, in the taxonomy's own order with `other` last —
              `listCategories()` returns the enum, not the values in use, so a
              filter never shrinks to match current inventory. Slug is the value,
              label is what the visitor reads.
            */}
            {categories.map((slug) => (
              <option key={slug} value={slug}>
                {LISTING_CATEGORY_LABELS[slug]}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="min" label="Min price" hint="In pounds." className="sm:w-28">
          <Input
            id="min"
            name="min"
            inputMode="decimal"
            defaultValue={rawMin}
            placeholder="0"
            aria-describedby={fieldDescribedBy('min', { hint: true })}
          />
        </Field>

        <Field id="max" label="Max price" hint="In pounds." className="sm:w-28">
          <Input
            id="max"
            name="max"
            inputMode="decimal"
            defaultValue={rawMax}
            placeholder="Any"
            aria-describedby={fieldDescribedBy('max', { hint: true })}
          />
        </Field>

        <Field id="sort" label="Sort" className="sm:w-44">
          <Select id="sort" name="sort" defaultValue={sort}>
            <option value="newest">Newest first</option>
            <option value="price_asc">Cheapest first</option>
            <option value="price_desc">Dearest first</option>
          </Select>
        </Field>

        <div className="flex gap-2">
          <Button type="submit" className="w-full sm:w-auto">
            Search
          </Button>
          {filtered ? (
            <Link href="/offers" className={linkButtonClass({ variant: 'secondary' })}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {/*
        Said once, here, rather than beside each field: a bound that could not be
        read is treated as no bound, and the visitor is told rather than being
        shown a result set that quietly ignored half of what they asked for.
      */}
      {(rawMin !== '' && minPriceCents === null) || (rawMax !== '' && maxPriceCents === null) ? (
        <p className="mt-3 text-body-15 text-danger" role="alert">
          A price filter was not a number, so it was ignored. Use digits, like 12 or 12.50.
        </p>
      ) : null}

      {/*
        `break-words` is load-bearing: this line echoes the visitor's search
        term, and a pasted unbroken 300-character token would otherwise push the
        page to a 2040px scroll width at a 375px viewport.
      */}
      <p className="mt-6 text-sm break-words text-muted" aria-live="polite">
        {/*
          The unknown-category line does not echo the submitted value. `q` is
          echoed because a visitor typed it and needs to see what was searched;
          a bogus category slug was not typed into anything on this page, so
          repeating it would only put unvalidated text on screen for no benefit.
        */}
        {unknownCategory
          ? '0 offers. That category is not one of the ones on offer.'
          : describeResults(page.total ?? listings.length, q, category, sort)}
      </p>

      {listings.length > 0 ? (
        <>
        <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((listing) => (
            // min-w-0: a grid item's default `min-width: auto` refuses to shrink
            // below its longest unbroken token, which defeats `break-words`
            // inside the card and pushes the whole page wider than the viewport.
            <li key={listing.id} className="flex min-w-0">
              <ListingCard
                listing={listing}
                href={detailHref(listing.id, q, category)}
                stats={statsById.get(listing.id)}
                coachHref={
                  approvedCoachIds.has(listing.coach_id) ? `/coaches/${listing.coach_id}` : undefined
                }
              />
            </li>
          ))}
        </ul>

        {/*
          The demo-data note, attached to the block the fiction is actually in
          — the same pattern the disabled Buy button already uses, explaining
          itself immediately below itself, and the same one `/coaches` uses for
          its rating grid.

          Rendered ONLY when at least one card is really showing a fabricated
          number. A grid of nothing but brand-new offers has no fiction on it,
          and a disclaimer that fires unconditionally is one a reader learns to
          skip on the pages where it matters.

          There is deliberately NO JSON-LD `AggregateRating` anywhere on this
          page while the numbers are invented: structured data is the half that
          travels into search results, where no note travels with it.
        */}
        {offerStats.some((stats) => stats.rating_average !== null || stats.sales_count > 0) ? (
          <p className="mt-6 border-t border-line pt-4 text-body-15 text-muted">
            <strong className="font-semibold text-ink">
              The ratings and sales counts on this page are demo data.
            </strong>{' '}
            Nobody bought anything and nobody wrote any of the reviews behind these numbers.
          </p>
        ) : null}

        <Pager
          basePath="/offers"
          params={pagerParams}
          cursorParam="after"
          nextCursor={page.nextCursor}
          onFirstPage={cursor === ''}
          shown={listings.length}
          total={page.total}
          noun="offers"
          className="mt-6"
        />
        </>
      ) : (
        <div className="mt-4">
          {/*
            Three genuinely different situations. "Nothing matched your filters"
            is actionable — offer the way out. "No offers exist yet" is not the
            visitor's problem to solve, so it does not pretend to be. And a
            category that does not exist is neither: nothing the visitor types in
            the keyword box will ever help, so it says so outright.
          */}
          {unknownCategory ? (
            <Alert tone="info" title="No such category">
              <p>
                The category in this link is not one JavelinHub offers. Pick one from the list above,
                or clear the filters to see everything.
              </p>
              <p className="mt-3">
                <Link href="/offers" className={linkButtonClass({ variant: 'secondary', size: 'sm' })}>
                  Clear filters
                </Link>
              </p>
            </Alert>
          ) : filtered ? (
            <Alert tone="info" title="Nothing matched those filters">
              <p>Try a different keyword, or widen the category.</p>
              <p className="mt-3">
                <Link href="/offers" className={linkButtonClass({ variant: 'secondary', size: 'sm' })}>
                  Clear filters
                </Link>
              </p>
            </Alert>
          ) : (
            <Alert tone="info" title="No offers yet">
              No coach has published an offer so far. If you coach, an invite code or an approved
              application lets you be the first.
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Carries the current filters into the detail page so its back link can restore
 * them. Only the VALIDATED category travels — a back link should never rebuild a
 * filter that cannot exist.
 */
function detailHref(id: string, q: string, category: ListingCategory | null): string {
  const search = new URLSearchParams();
  if (q !== '') search.set('q', q);
  if (category !== null) search.set('category', category);
  // The cursor is deliberately NOT carried into the detail page's back link. It
  // would restore the right page of results, and it would also mean a link
  // shared from an offer carried a stranger's scroll position in it — and a
  // stale cursor outlives the row it names, so the "back" it restores can be a
  // page that no longer starts where it did.
  const query = search.toString();
  return query === '' ? `/offers/${id}` : `/offers/${id}?${query}`;
}

/** The label goes in the sentence, never the slug — "in Video review", not "in video_review". */
function describeResults(
  count: number,
  q: string,
  category: ListingCategory | null,
  sort: ListingSort,
): string {
  const noun = count === 1 ? 'offer' : 'offers';
  const bits: string[] = [];
  if (q !== '') bits.push(`matching “${q}”`);
  if (category !== null) bits.push(`in ${LISTING_CATEGORY_LABELS[category]}`);
  // The ordering is named because it is a choice the visitor can make and
  // therefore one they can forget having made. `count` is the TOTAL, not the
  // number of cards below it — the pager says how many of them are on screen.
  const order =
    sort === 'price_asc' ? 'Cheapest first.' : sort === 'price_desc' ? 'Dearest first.' : 'Newest first.';
  return bits.length === 0 ? `${count} ${noun}. ${order}` : `${count} ${noun} ${bits.join(' ')}. ${order}`;
}
