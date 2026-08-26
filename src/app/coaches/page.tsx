import type { Metadata } from 'next';
import Link from 'next/link';

import { CoachCard } from '@/components/coach-card';
import { Alert } from '@/components/ui/alert';
import { Button, linkButtonClass } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { getDataClient } from '@/lib/data';
import { firstValue } from '@/lib/search-params';

export const metadata: Metadata = { title: 'Coaches' };

/**
 * The public coach directory.
 *
 * -----------------------------------------------------------------------------
 * The filtering is NOT here, and that is the point
 * -----------------------------------------------------------------------------
 * `listCoaches()` returns approved coaches and nothing else, filtered inside
 * the data layer and inside the `public.public_coaches` view. This page has no
 * `.filter()` over a wider read, and must never grow one: "fetch every profile
 * and keep the coaches" renders identically and ships every learner's and every
 * administrator's row to the client. The read also carries no `role` or
 * `coach_status` column at all, so there is nothing here that could be
 * coerced into enumerating either — see `PublicCoach` in `types.ts`.
 *
 * There is no sport filter, because there is one sport.
 *
 * -----------------------------------------------------------------------------
 * Two calls, not N+1
 * -----------------------------------------------------------------------------
 * The stats come from one batched `listCoachStats(ids)` rather than a
 * `getCoachStats` per card, for the reason `listOfferStats` exists: the
 * Supabase implementation serves the batch from a single grouped query, and a
 * per-card call would be a performance cliff that only appears after the
 * backend swap.
 *
 * Filter state lives entirely in the URL via a plain GET form, exactly as
 * `/offers` does — every result set is linkable, back/forward behaves, and
 * search works with JavaScript off. There is no client component on this page.
 */
export default async function CoachesPage({ searchParams }: PageProps<'/coaches'>) {
  const params = await searchParams;
  const q = firstValue(params.q).trim();

  const db = getDataClient();
  const coaches = await db.listCoaches({ q: q || undefined });
  // One row per id, in the order given — `listCoachStats` never drops one, so
  // the zip below cannot slip.
  const stats = await db.listCoachStats(coaches.map((coach) => coach.id));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Coaches</h1>
        {/*
          The approval fact is stated once, here, rather than as a chip on every
          card: `listCoaches` returns nothing else, so a per-card badge would be
          true of all of them and would therefore tell a visitor nothing. See
          the note in `coach-card.tsx`.
        */}
        <p className="mt-1.5 text-sm text-muted">
          Everyone here has been approved by an administrator before they could publish anything.{' '}
          <Link href="/offers" className="underline underline-offset-2 hover:text-ink">
            Browse offers instead
          </Link>
          .
        </p>
      </header>

      <form method="get" className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <Field id="q" label="Search" hint="Matches coach names." className="flex-1">
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="e.g. Vaughn"
            aria-describedby={fieldDescribedBy('q', { hint: true })}
          />
        </Field>

        <div className="flex gap-2">
          <Button type="submit" className="w-full sm:w-auto">
            Search
          </Button>
          {q !== '' ? (
            <Link href="/coaches" className={linkButtonClass({ variant: 'secondary' })}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {/*
        `break-words` is load-bearing: this line echoes the visitor's search
        term, and a pasted unbroken 300-character token would otherwise push the
        page past the viewport width at 375px.
      */}
      <p className="mt-6 text-sm break-words text-muted" aria-live="polite">
        {describeResults(coaches.length, q)}
      </p>

      {coaches.length > 0 ? (
        <>
          <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {coaches.map((coach, index) => (
              // min-w-0: a grid item's default `min-width: auto` refuses to
              // shrink below its longest unbroken token, which defeats
              // `break-words` inside the card and widens the whole page.
              <li key={coach.id} className="flex min-w-0">
                <CoachCard
                  coach={coach}
                  stats={stats[index]!}
                  href={coachHref(coach.id, q)}
                />
              </li>
            ))}
          </ul>

          {/*
            Rendered ONLY when at least one card is actually showing a rating.
            A directory of nothing but brand-new coaches has no fabricated
            number on it, and a note about numbers that are not there teaches a
            reader to skip the note on the pages where it matters.

            The demo-data note, attached to the block where the fiction actually
            is — the same pattern as the disabled Buy button explaining itself
            immediately below itself. Every rating above is computed from
            fabricated purchases and fabricated reviews written by nobody, and a
            number attributed to named people is not the same kind of stub as an
            inert button. There is deliberately no JSON-LD `AggregateRating`
            anywhere on this page while that is true.
          */}
          {stats.some((s) => s.rating_average !== null) ? (
            <p className="mt-6 border-t border-line pt-4 text-body-15 text-muted">
              <strong className="font-semibold text-ink">The ratings on this page are demo data.</strong>{' '}
              Nobody has bought anything and nobody wrote any of the reviews behind these numbers.
            </p>
          ) : null}
        </>
      ) : (
        <div className="mt-4">
          {/*
            Two genuinely different situations. "Nothing matched" is actionable,
            so it offers the way out. "No coaches yet" is not the visitor's
            problem to solve, so it does not pretend to be.
          */}
          {q !== '' ? (
            <Alert tone="info" title="No coach by that name">
              <p>Try part of a name, or clear the search to see everyone.</p>
              <p className="mt-3">
                <Link href="/coaches" className={linkButtonClass({ variant: 'secondary', size: 'sm' })}>
                  Clear search
                </Link>
              </p>
            </Alert>
          ) : (
            <Alert tone="info" title="No coaches yet">
              Nobody has been approved to coach so far. If you coach, an invite code or an approved
              application is how you get here.
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Carries the current search into the profile page so its back link can restore
 * it — the same trick `/offers` plays with `?q=` and `?category=`.
 *
 * Built with `URLSearchParams` rather than string concatenation: `q` is
 * whatever the visitor typed, and this value becomes an `href`.
 */
function coachHref(id: string, q: string): string {
  const search = new URLSearchParams();
  if (q !== '') search.set('q', q);
  const query = search.toString();
  return query === '' ? `/coaches/${id}` : `/coaches/${id}?${query}`;
}

function describeResults(count: number, q: string): string {
  const noun = count === 1 ? 'coach' : 'coaches';
  return q === ''
    ? `${count} ${noun}. Newest first.`
    : `${count} ${noun} matching “${q}”. Newest first.`;
}
