import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ListingCard } from '@/components/listing-card';
import { InitialsAvatar } from '@/components/initials-avatar';
import { avatarPublicUrl } from '@/lib/storage/avatars';
import { Pager } from '@/components/pager';
import { ReportForm } from '@/components/report-form';
import { ReviewItem } from '@/components/review-item';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { Rating, Stat, StatEmpty } from '@/components/ui/stat';
import { getActor } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import type { PublicReviewWithListing } from '@/lib/data/types';
import { firstValue } from '@/lib/search-params';

export async function generateMetadata({ params }: PageProps<'/coaches/[id]'>): Promise<Metadata> {
  const { id } = await params;
  const coach = await getDataClient().getPublicCoach(id);
  // A missing coach renders `not-found`, so the title must not assert one exists.
  return { title: coach ? coach.full_name : 'Coach not found' };
}

/**
 * A public coach profile.
 *
 * -----------------------------------------------------------------------------
 * What is read, and what is deliberately not
 * -----------------------------------------------------------------------------
 * `getPublicCoach` returns `null` for an unknown id AND for a real user who is
 * not an approved coach, so both land on the app's 404. That is the whole
 * disclosure: a learner, a pending applicant, a rejected applicant, an
 * administrator and a nonexistent uuid are indistinguishable from here. Nothing
 * on this page reads `Profile` (which carries `email`) or
 * `coach_applications` (whose bio is an owner-and-admin-only review artifact).
 *
 * -----------------------------------------------------------------------------
 * The asymmetry between the three blocks, which is deliberate
 * -----------------------------------------------------------------------------
 * The numbers and the reviews on this page are ACCOUNT-level and the offer list
 * is not, and they are supposed to disagree:
 *
 *   * `getCoachStats` and `listReviewsForCoach` cover **every offer and every
 *     price epoch, withdrawn offers included**. Raising a price archives an
 *     OFFER's rating; it does not make somebody a worse coach, and withdrawing
 *     an offer does not undo coaching that was sold and reviewed.
 *   * `listListingsByCoach` is the PUBLIC offer list and excludes withdrawn
 *     offers, like every other public listing read.
 *
 * So this page can legitimately show "8 reviews" above four offers, including a
 * review of an offer that is no longer for sale. Do not "make them consistent":
 * `docs/DATA-LAYER.md` has the table, and `scripts/verify-authz.mts` asserts
 * both directions.
 *
 * The consequence handled below: a review can name an offer that the public can
 * no longer open, so a review's offer title is only a LINK when that offer is
 * still published. See `publishedOfferIds`.
 */
export default async function CoachProfilePage({ params, searchParams }: PageProps<'/coaches/[id]'>) {
  const { id } = await params;
  const db = getDataClient();

  const coach = await db.getPublicCoach(id);
  if (!coach) notFound();

  /*
   * TWO PAGED LISTS ON ONE PAGE, so two cursor parameters. They must not share
   * one: a single `?after=` would move both lists at once, and the cursor from
   * either would be refused by the other's keyset (different `scope`) — so one
   * of the two would silently reset to the top every time the reader advanced
   * the other.
   */
  const search = await searchParams;
  const offerCursor = firstValue(search.offers).trim();
  const reviewCursor = firstValue(search.reviews).trim();

  const [stats, offerPage, reviewPage] = await Promise.all([
    db.getCoachStats(coach.id),
    // Public, published-only. `actor` is accepted for interface symmetry and is
    // not consulted — this read is deliberately not dual-mode, so it can never
    // be talked into returning somebody's withdrawn offers.
    db.listListingsByCoach(null, coach.id, { cursor: offerCursor || undefined }),
    db.listReviewsForCoach(coach.id, { cursor: reviewCursor || undefined }),
  ]);
  const offers = offerPage.items;
  const reviews = reviewPage.items;

  // One batched read for the whole offer list, for the reason `listOfferStats`
  // exists at all. Keyed by id rather than zipped by index: this method DROPS
  // ids it has no row for, so a positional zip would misalign the moment one
  // went missing and print one offer's rating under another offer's title.
  //
  // These are OFFER-level numbers — current epoch, this offer only — sitting on
  // the same page as the coach's ACCOUNT-level numbers above, which cover every
  // epoch and every withdrawn offer. They are supposed to disagree, and the
  // cards showing their own smaller numbers is what makes that visible rather
  // than mysterious. Do not reconcile them.
  const offerStats = await db.listOfferStats(offers.map((offer) => offer.id));
  const offerStatsById = new Map(offerStats.map((stats) => [stats.listing_id, stats]));

  const backHref = buildBackHref(firstValue(search.q).trim());
  // What each pager must carry so that advancing one list does not reset the
  // other, and neither loses the visitor's search term on the way back.
  const q = firstValue(search.q).trim();
  const pagerParams = {
    q: q || undefined,
    offers: offerCursor || undefined,
    reviews: reviewCursor || undefined,
  };

  // Only for deciding whether to offer the report control. Deliberately NOT
  // passed to any of the reads above: this page is the same page for everybody,
  // and a viewer-dependent read here is how a public profile quietly becomes a
  // private one.
  const viewer = await getActor();
  const canReport = viewer !== null && viewer.userId !== coach.id;

  // Nothing sold and nothing written: the one state that reads "New coach".
  // A coach who HAS sold and simply has no reviews yet is a different fact and
  // must not be called new — see the empty-state table in PROGRESS.md.
  const brandNew = stats.sales_count === 0 && stats.review_count === 0;
  const offerTotal = offerPage.total ?? offers.length;
  const reviewTotal = reviewPage.total ?? reviews.length;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <p className="text-sm">
        <Link
          href={backHref}
          className="inline-flex min-h-11 items-center text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          ← Back to coaches
        </Link>
      </p>

      <header className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        <InitialsAvatar name={coach.full_name} src={avatarPublicUrl(coach.avatar_path)} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <h1 className="min-w-0 text-2xl font-bold tracking-tight break-words text-ink sm:text-3xl">
              {coach.full_name}
            </h1>
            {/*
              Turf Green, and this is section 06's own chip specimen — the doc
              draws `<span class="chip">Verified coach</span>` in exactly this
              colour. Turf "never initiates anything, it only confirms", and
              this confirms: an administrator approved this person before they
              could publish. Unconditional, because `getPublicCoach` returns
              nothing else — and unlike the directory grid, a visitor arriving
              from a shared link has nothing else on the page telling them.
            */}
            <Badge tone="success">Verified coach</Badge>
          </div>

          {coach.coach_headline ? (
            <p className="mt-2 text-body-17 break-words text-muted">{coach.coach_headline}</p>
          ) : null}

          {/*
            `null` is "not stated" and `0` is "first season coaching" — two
            different answers, so this branches on `null` explicitly rather than
            on falsiness. A coach who said 0 gets to have said it.
          */}
          {coach.coach_years_coaching !== null ? (
            <p className="mt-2 font-mono text-mono-12 tracking-[0.06em] uppercase text-muted">
              {coach.coach_years_coaching === 1
                ? '1 year coaching'
                : `${coach.coach_years_coaching} years coaching`}
            </p>
          ) : null}
        </div>
      </header>

      {/* ------------------------------------------------- Account-level stats */}
      <Card className="mt-6">
        <CardBody>
          {brandNew ? (
            <StatEmpty>New coach — nothing sold yet</StatEmpty>
          ) : (
            <div className="flex flex-wrap gap-x-10 gap-y-6">
              {/*
                Ink numeral, Steel label, no accent colour and no glyphs — see
                the note on `Stat`. `rating_average` is `null` and never `0`
                when nothing is reviewed, and `Rating` is what branches on it.
              */}
              <Rating
                average={stats.rating_average}
                count={stats.review_count}
                emptyLabel="No reviews yet"
              />
              {/*
                Zero sales is a real fact and renders as `0`; zero rating is not
                a fact and never renders as `0.0`. That asymmetry is the whole
                reason `rating_average` is nullable.
              */}
              <Stat value={stats.sales_count} label={stats.sales_count === 1 ? 'Sale' : 'Sales'} />
            </div>
          )}
        </CardBody>
      </Card>

      {/* ---------------------------------------------------------------- Bio */}
      {coach.coach_bio ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-ink">About {coach.full_name}</h2>
          {/*
            `whitespace-pre-line` keeps the coach's own paragraph breaks without
            rendering their text as HTML.
          */}
          <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-line text-muted">
            {coach.coach_bio}
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------------- Offers */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-ink">
          {/* The TOTAL. The pager underneath says how many are on screen. */}
          {offerTotal === 1 ? '1 offer' : `${offerTotal} offers`}
        </h2>

        {offers.length > 0 ? (
          <ul className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {offers.map((offer) => (
              <li key={offer.id} className="flex min-w-0">
                {/*
                  No `coachHref`: every card here belongs to the coach whose
                  page this is, and a link from a page to itself is not a
                  cross-link. The "by <name>" line stays plain text.
                */}
                <ListingCard
                  listing={offer}
                  href={`/offers/${offer.id}`}
                  stats={offerStatsById.get(offer.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3">
            <Alert tone="info">{coach.full_name} hasn&rsquo;t published any offers yet.</Alert>
          </div>
        )}

        <Pager
          basePath={`/coaches/${coach.id}`}
          params={pagerParams}
          cursorParam="offers"
          nextCursor={offerPage.nextCursor}
          onFirstPage={offerCursor === ''}
          shown={offers.length}
          total={offerPage.total}
          noun="offers"
          className="mt-4"
        />
      </section>

      {/* ------------------------------------------------------------ Reviews */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-ink">
          {reviewTotal === 1 ? '1 review' : `${reviewTotal} reviews`}
        </h2>

        {reviews.length > 0 ? (
          <>
            <p className="mt-1 text-sm text-muted">
              Every review of every offer this coach has published, newest first.
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              {reviews.map((review) => (
                <li key={review.id}>
                  <ReviewItem
                    review={review}
                    context={
                      // FROM THE ROW (0026), not from an intersection with the
                      // offer list above. Both lists are pages now, so a review
                      // here can be about an offer three pages down — and the
                      // intersection would have said "withdrawn" about an offer
                      // that is on sale, silently and only for some readers.
                      <ReviewedOffer review={review} linkable={review.listing_published} />
                    }
                  />
                </li>
              ))}
            </ul>

            <Pager
              basePath={`/coaches/${coach.id}`}
              params={pagerParams}
              cursorParam="reviews"
              nextCursor={reviewPage.nextCursor}
              onFirstPage={reviewCursor === ''}
              shown={reviews.length}
              total={reviewPage.total}
              noun="reviews"
              className="mt-4"
            />
          </>
        ) : (
          <div className="mt-3">
            <Alert tone="info">
              {brandNew
                ? `${coach.full_name} is new here — nobody has bought or reviewed anything yet.`
                : `Nobody has written a review of ${coach.full_name}'s offers yet.`}
            </Alert>
          </div>
        )}

        {/*
          Rendered ONLY when there is fabricated content on the page to disclaim.
          A brand-new coach has no reviews and no sales, so "the reviews and
          numbers on this page are demo data" would be a note about nothing —
          and a disclaimer that fires unconditionally is one a reader learns to
          skip on the pages where it matters.

          The demo-data note, attached to the block the fiction is actually in —
          the same pattern the disabled Buy button already uses, which explains
          itself immediately below itself.

          This is not the same kind of stub as an inert button: the reviews above
          are fabricated opinions attributed to named people, and the numbers at
          the top of the page are computed from purchases nobody made. There is
          deliberately NO JSON-LD `Review` or `AggregateRating` markup anywhere
          on this page while that is true — publishing structured data would put
          the fiction into search results, where no note travels with it.
        */}
        {reviews.length > 0 || stats.sales_count > 0 ? (
          <p className="mt-6 border-t border-line pt-4 text-body-15 text-muted">
            <strong className="font-semibold text-ink">
              The reviews and numbers on this page are demo data.
            </strong>{' '}
            Nobody bought anything and nobody wrote any of this. Payments are not part of this proof
            of concept.
          </p>
        ) : null}
        {/*
          THE LAST THING ON THE PAGE, under the reviews and the demo-data note,
          and that placement is the whole design: a report control near the top
          would read as an accusation the page is making, and this one is a
          remedy that a visitor goes looking for rather than trips over.

          Signed in only, and never about yourself. Anonymous visitors get a
          sentence instead of a form — filing needs an account, because a report
          with no reporter is one nobody can weigh or come back to.
        */}
        {canReport ? (
          <div className="mt-8 border-t border-line pt-5">
            <h3 className="text-xs font-semibold tracking-wide text-faint uppercase">
              Something wrong?
            </h3>
            <p className="mt-1.5 mb-3 max-w-2xl text-body-15 leading-relaxed text-muted">
              If {coach.full_name} took payment outside JavelinHub, is pretending to be somebody
              else, or has been abusive, tell an administrator.
            </p>
            <ReportForm subject="coach" id={coach.id} subjectName={coach.full_name} />
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * The offer a review is about, as the trailing meta on that review's byline.
 *
 * Account-level reviews include offers that have since been withdrawn, and a
 * withdrawn offer is a 404 for the public. The title is therefore only a link
 * when the offer is still on sale — otherwise it is plain text with the reason
 * next to it, which is better than a link that 404s and better than dropping
 * the review.
 */
function ReviewedOffer({ review, linkable }: { review: PublicReviewWithListing; linkable: boolean }) {
  if (!linkable) {
    return (
      <span>
        {review.listing_title} <span className="text-faint">(no longer on sale)</span>
      </span>
    );
  }
  return (
    <Link href={`/offers/${review.listing_id}`} className="underline underline-offset-2 hover:text-ink">
      {review.listing_title}
    </Link>
  );
}

/**
 * Rebuilds the `/coaches` URL the visitor arrived from, keeping their search.
 *
 * Re-encoded through `URLSearchParams` rather than pasted through: an arbitrary
 * query string out of the address bar is untrusted input, and this value
 * becomes an `href`.
 */
function buildBackHref(q: string): string {
  if (q === '') return '/coaches';
  const search = new URLSearchParams();
  search.set('q', q);
  return `/coaches?${search.toString()}`;
}
