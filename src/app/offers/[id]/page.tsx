import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ListingCard } from '@/components/listing-card';
import { ReviewItem } from '@/components/review-item';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardFooter } from '@/components/ui/card';
import { Rating, Stat, StatEmpty } from '@/components/ui/stat';
import { ClaimForm } from '@/app/offers/[id]/claim-form';
import { getActor } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import {
  FULFILMENT_LABELS,
  isListingCategory,
  listingCategoryLabel,
  type ListingWithCoach,
  type PublicCoach,
} from '@/lib/data/types';
import { firstValue } from '@/lib/search-params';
import { formatDate, formatPrice } from '@/lib/format';

type PageProps = {
  // Both are Promises in this version of Next.
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * How many of the coach's other offers the cross-link block shows before it
 * stops and points at the coach's profile instead. Four fills the two-column
 * grid twice and keeps a prolific coach's page from turning into a second
 * browse page underneath the offer somebody actually opened.
 */
const MORE_OFFERS_SHOWN = 4;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  /*
   * VIEWER-AWARE, like the page body. `getListing` filters withdrawn offers, so
   * using it here would put "Offer not found" in the tab title of a page that is
   * rendering a tombstone perfectly well — and would do it only for the three
   * people entitled to see one, which is a confusing way to treat exactly the
   * users this route was extended for.
   *
   * It leaks nothing extra: the same read decides what the body renders, and a
   * stranger still gets `null` and the not-found title.
   */
  const detail = await getDataClient().getListingForViewer(await getActor(), id);
  return { title: detail ? detail.listing.title : 'Offer not found' };
}

/**
 * Public offer detail.
 *
 * The route is `/offers/[id]`; `/listings/[id]` redirects here, query intact
 * (next.config.ts). The model keeps the name `listing`; only the copy says
 * "offer".
 *
 * `getListing` returns `null` for an unknown *or malformed* id rather than
 * throwing, so a hand-typed URL lands on the app's 404 page instead of the
 * error boundary.
 *
 * -----------------------------------------------------------------------------
 * The numbers on this page are the OFFER's, not the coach's
 * -----------------------------------------------------------------------------
 * `getOfferStats` and `listReviewsForListing` cover this offer at its CURRENT
 * price epoch and nothing else. The coach profile this page links to covers
 * every offer, every epoch and every withdrawn offer, so it can legitimately
 * show larger numbers. That disagreement is the archive rule the user
 * specified, not a bug — `docs/DATA-LAYER.md` has the table. Do not reconcile
 * them, and do not render the epoch itself: how many times a price has been
 * raised is the coach's business, which is why `OfferStats` does not carry it.
 *
 * -----------------------------------------------------------------------------
 * Sector Blue budget
 * -----------------------------------------------------------------------------
 * Section 03 caps Sector Blue at ONE element in the content area, and this page
 * already spends it on the (disabled) Buy button, which is `variant="primary"`.
 * Every link added below is therefore an ordinary underlined link in Ink or
 * Steel — no second primary button, no accent-coloured rating.
 */
export default async function OfferDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const db = getDataClient();

  /*
   * Who is looking is decided FIRST now, because it decides what this page is.
   *
   * `getListingForViewer` replaces `getListing` here, and the difference is the
   * whole point of that method: a withdrawn offer is a 404 for the public and a
   * TOMBSTONE for its owner, an admin, and anyone holding an order for it. It
   * was the last method in the interface with no caller, and the gap it left was
   * invisible only because nothing linked a buyer to a withdrawn offer — which
   * `/purchases` and `/orders/[id]` now do.
   *
   * `null` is still a 404 and still says nothing about whether anything ever
   * existed at this id.
   */
  const viewer = await getActor();
  const detail = await db.getListingForViewer(viewer, id);
  if (!detail) notFound();
  const listing = detail.listing;

  const search = await searchParams;
  const backHref = buildBackHref(search);

  /*
   * THE TOMBSTONE, returned early rather than threaded through the 300 lines
   * below as conditionals. Everything under here — the claim control, the
   * rating, the reviews, the cross-sell grid — is about an offer somebody can
   * still buy, and none of it applies.
   *
   * The reads are skipped too, not just the markup: `getOfferStats` and
   * `listReviewsForListing` both filter `deleted_at is null`, so they would
   * return empty for a withdrawn offer anyway. Fetching them to render nothing
   * is two round trips to prove a thing the type already says.
   */
  if (detail.state === 'withdrawn') {
    return (
      <WithdrawnOffer
        listing={listing}
        withdrawnAt={detail.withdrawn_at}
        backHref={backHref}
        coach={await db.getPublicCoach(listing.coach_id)}
      />
    );
  }

  const [stats, reviews, coach, coachOffers] = await Promise.all([
    db.getOfferStats(listing.id),
    db.listReviewsForListing(listing.id),
    // `null` for an unknown id AND for anyone who is not an approved coach —
    // the two are deliberately indistinguishable. It gates the cross-links
    // below rather than being rendered: a coach can be de-approved while their
    // offers stay published (file an application, redeem an invite code, which
    // approves without closing the application, then have that application
    // rejected), and an unconditional link to `/coaches/<id>` would 404.
    db.getPublicCoach(listing.coach_id),
    // Public and published-only, like every other public listing read. The
    // actor argument exists for interface symmetry and does not widen it.
    db.listListingsByCoach(null, listing.coach_id),
  ]);

  const otherOffers = coachOffers.filter((offer) => offer.id !== listing.id);
  const shownOffers = otherOffers.slice(0, MORE_OFFERS_SHOWN);
  // Batched, and keyed by id rather than zipped by index: `listOfferStats`
  // drops ids it has no row for, so a positional zip would misalign and print
  // one offer's rating under another offer's title.
  const shownOfferStats = await db.listOfferStats(shownOffers.map((offer) => offer.id));
  const shownStatsById = new Map(shownOfferStats.map((row) => [row.listing_id, row]));

  // Have they already claimed this? It decides the claim control and widens
  // nothing: `listMyOrders` is scoped to the actor by the data layer and
  // returns [] for an anonymous viewer.
  const myOrders = viewer ? await db.listMyOrders(viewer) : [];
  const alreadyClaimed = myOrders.some((order) => order.listing_id === listing.id);
  const isOwnOffer = viewer?.userId === listing.coach_id;

  // Set by createListingAction's redirect. Trusted only to show a message —
  // it grants nothing, and the listing above it is the real confirmation.
  const justPublished = firstValue(search.published) === '1';

  const salesCount = stats?.sales_count ?? 0;
  // Nothing sold and nothing written at this epoch: the one state that reads
  // "New offer". An offer that HAS sold and simply has no reviews yet is a
  // different fact and must not be called new — the seed has one (`…0105`).
  const brandNew = stats !== null && stats.sales_count === 0 && stats.review_count === 0;
  // Is there any fabricated content ON THE PAGE to disclaim? Both blocks count:
  // this offer's own reviews and sales, AND the ratings on the cross-linked
  // cards below, which are invented in exactly the same way. A brand-new offer
  // by a coach with nothing else on sale has none of it, and a disclaimer that
  // fires unconditionally is one a reader learns to skip where it matters.
  const hasDemoContent =
    reviews.length > 0 ||
    salesCount > 0 ||
    shownOfferStats.some((row) => row.rating_average !== null || row.sales_count > 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <p className="text-sm">
        <Link
          href={backHref}
          className="inline-flex min-h-11 items-center text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          ← Back to offers
        </Link>
      </p>

      {justPublished ? (
        <div className="mt-4">
          <Alert tone="success" title="Offer published">
            It is live on the offers page now. Payments are not part of this proof of concept, so nobody
            will be charged.
          </Alert>
        </div>
      ) : null}

      <header className="mt-4">
        {/*
          The label, never the stored slug — nobody should read "video_review".
          The delivery mode sits beside it in the same neutral tone: it is a fact
          about the offer, not a status, and this page's one accent element is
          already spent on the claim button (see the note on the component).
        */}
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" wrap>
            {listingCategoryLabel(listing.category)}
          </Badge>
          <Badge tone="neutral" wrap>
            {FULFILMENT_LABELS[listing.fulfilment]}
          </Badge>
        </span>
        <h1 className="mt-3 text-2xl font-bold tracking-tight break-words text-ink sm:text-3xl">
          {listing.title}
        </h1>
        <p className="mt-2 text-sm break-words text-muted">
          by{' '}
          {coach ? (
            /*
              The cross-link out of the offer and into the coach. Ink text with
              a Steel underline that darkens to Ink on hover — no accent colour,
              because the blue on this page is already spent (see the note on
              the component above).

              Rendered as a plain inline link, not a flex box: WCAG 2.5.5
              exempts a target "in a sentence or block of text", and an
              inline-flex link is an anonymous flex item whose `min-width: auto`
              refuses to break a long unbroken token — which is how a
              300-character coach name would push a 375px page sideways.
            */
            <Link
              href={`/coaches/${coach.id}`}
              className="font-medium text-ink underline decoration-muted underline-offset-2 hover:decoration-ink"
            >
              {listing.coach_name}
            </Link>
          ) : (
            <span className="font-medium text-ink">{listing.coach_name}</span>
          )}
          <span aria-hidden="true"> · </span>
          <span>published {formatDate(listing.created_at)}</span>
        </p>
      </header>

      <Card tone="raised" className="mt-6">
        <CardBody className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">About this session</h2>
            {/*
              `whitespace-pre-line` keeps the coach's own paragraph breaks without
              rendering their text as HTML.
            */}
            <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-line text-muted">
              {listing.description}
            </p>

            {/*
              HOW IT ARRIVES, stated before the claim rather than discovered
              after it. The two modes are genuinely different purchases — one
              ends at the download, the other starts a back-and-forth — and the
              badge above names the mode without saying what it means.

              Nothing here says whether a file is actually attached: `asset_path`
              is not public and deliberately never will be. An instant offer with
              no file cannot be claimed at all, which is what `claim_offer`
              refuses and what the coach's own dashboard flags.
            */}
            <h2 className="mt-5 text-sm font-semibold text-ink">How you get it</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {listing.fulfilment === 'instant'
                ? 'Claim it and the file is yours to download straight away, from your purchases. The same file for every buyer.'
                : 'Your coach puts this together for you after you claim it. You will both be able to send files on the order page — a video of your throw, for instance — and it appears in your purchases.'}
            </p>
          </div>

          <div className="shrink-0 sm:w-48 sm:text-right">
            <p className="text-2xl font-bold tabular-nums text-ink">{formatPrice(listing.price_cents)}</p>
            <div className="mt-3">
              {/*
                No longer inert. Claiming is FREE for the pilot, so the control
                creates a real order and nothing is charged — which the footer
                says plainly rather than leaving the reader to infer it from a
                price they were never asked to pay.

                Disabled for the two cases the data layer would refuse anyway,
                so the reason is visible before the click rather than after it:
                a coach cannot claim their own offer, and nobody can claim the
                same one twice.
              */}
              <ClaimForm
                listingId={listing.id}
                title={listing.title}
                disabled={isOwnOffer || alreadyClaimed}
                disabledReason={
                  isOwnOffer
                    ? 'This is your own offer.'
                    : alreadyClaimed
                      ? 'You have already claimed this. It is in your purchases.'
                      : undefined
                }
              />
            </div>
          </div>
        </CardBody>

        <CardFooter>
          <p>
            <strong className="font-semibold text-ink">Claiming is free while JavelinHub is in pilot.</strong>{' '}
            No checkout, no card details, nothing is charged — the price above is what this will cost once
            payments are switched on. Claiming puts the offer in your purchases and tells the coach.
          </p>
        </CardFooter>
      </Card>

      {/* --------------------------------------------- Reviews and sales */}
      <section className="mt-10">
        <h2 className="text-sm font-semibold text-ink">Reviews and sales</h2>

        {stats ? (
          <Card className="mt-3">
            <CardBody>
              {brandNew ? (
                /*
                  Nothing sold and nothing written. One line instead of two
                  stats: the locked table allows "New offer" OR omitting the
                  sales line, and printing "0 SALES" beside it would say the
                  same thing twice in a worse voice.
                */
                <StatEmpty>New offer — nothing sold yet</StatEmpty>
              ) : (
                <div className="flex flex-wrap gap-x-10 gap-y-6">
                  {/*
                    Ink numeral, Steel label, no glyphs and no accent — section
                    06's stat pattern. `rating_average` is `null` and never `0`
                    when nothing is reviewed, and `Rating` is the component that
                    branches on it, which is what stops a brand-new offer being
                    published as "0.0".

                    Scope that claim carefully: the guarantee belongs to the
                    WRITE path, not to this component. `createReview` refuses a
                    rating outside 1-5 and the SQL has the same check, so no code
                    path can store a 0 — but the mock store does not validate
                    rows on load, so a hand-edited `db.json` carrying
                    `rating: 0` does render "0.0" here, on the card, and on the
                    coach profile. That is the accepted E1-F3 residual, not a
                    hole in this branch.
                  */}
                  <Rating
                    average={stats.rating_average}
                    count={stats.review_count}
                    emptyLabel="No reviews yet"
                  />
                  {/*
                    Zero sales is a real fact; zero rating is not. This branch
                    only runs when something has sold, so the number is always
                    genuine here — the zero case is the `brandNew` line above.
                  */}
                  <Stat value={stats.sales_count} label={stats.sales_count === 1 ? 'Sale' : 'Sales'} />
                </div>
              )}
            </CardBody>
          </Card>
        ) : null}

        {reviews.length > 0 ? (
          <>
            <p className="mt-4 text-sm text-muted">
              {reviews.length === 1 ? '1 review' : `${reviews.length} reviews`} of this offer, newest
              first.
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              {reviews.map((review) => (
                <li key={review.id}>
                  {/*
                    No `context`: naming the offer under every review of the
                    offer you are already reading is noise. The coach profile,
                    which mixes several offers, passes the title.
                  */}
                  <ReviewItem review={review} />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="mt-4">
            {/*
              THREE STATES SHARE "no reviews", and the middle one is the one
              that gets collapsed. An offer that has SOLD and simply has not
              been written about is not a new offer — somebody bought it — so it
              says what it says rather than borrowing the new-offer wording.
              The seed has one on purpose (`…0105`, sold once, never reviewed).
            */}
            <Alert tone="info" title="No reviews yet">
              {salesCount === 0
                ? 'Nobody has bought this offer yet, so there is nothing to review.'
                : salesCount === 1
                  ? 'This offer has sold once, and the buyer has not written about it.'
                  : `This offer has sold ${salesCount} times, and none of the buyers has written about it.`}
            </Alert>
          </div>
        )}

      </section>

      {/* ------------------------------------- More offers from this coach */}
      {shownOffers.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-ink">More offers from {listing.coach_name}</h2>
          <p className="mt-1 text-sm break-words text-muted">
            {/*
              The other half of the cross-link, and it is worth more than a
              convenience: this offer's numbers cover its current price epoch
              alone, while the coach's profile carries their whole record —
              every review of every offer they have published. A visitor reading
              "New offer" here can find out whether the coach is new too.
            */}
            {coach ? (
              <>
                <Link
                  href={`/coaches/${coach.id}`}
                  className="underline underline-offset-2 hover:text-ink"
                >
                  {coach.full_name}&rsquo;s coach profile
                </Link>{' '}
                has their full record — every review of every offer they have published.
              </>
            ) : (
              'Also on sale from the same coach.'
            )}
          </p>

          <ul className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {shownOffers.map((offer) => (
              // min-w-0: a grid item's default `min-width: auto` refuses to
              // shrink below its longest unbroken token, which defeats
              // `break-words` inside the card and widens the whole page.
              <li key={offer.id} className="flex min-w-0">
                {/*
                  No `coachHref`: every card here is by the coach already named
                  in the heading above, and the link to that coach is in the
                  sentence under it. Repeating it per card would put four
                  identical links in one block.
                */}
                <ListingCard
                  listing={offer}
                  href={`/offers/${offer.id}`}
                  stats={shownStatsById.get(offer.id)}
                />
              </li>
            ))}
          </ul>

          {otherOffers.length > shownOffers.length && coach ? (
            <p className="mt-4 text-sm break-words text-muted">
              <Link href={`/coaches/${coach.id}`} className="underline underline-offset-2 hover:text-ink">
                See all {otherOffers.length + 1} offers from {coach.full_name}
              </Link>
            </p>
          ) : null}
        </section>
      ) : null}

      {/*
        The demo-data note, attached to the fabricated content rather than
        floated somewhere general — the same pattern the disabled Buy button
        above uses, explaining itself immediately below itself, and the same
        construction `/coaches/[id]` ships.

        This is not the same kind of stub as an inert button: the reviews are
        fabricated opinions attributed to named people, and every count on the
        page is computed from purchases nobody made. There is deliberately NO
        JSON-LD `Review` or `AggregateRating` markup anywhere while that is
        true — structured data is the half that travels into search results,
        where no note travels with it, and it is also the version a search
        engine penalises when the reviews are not real.

        IT SITS AFTER BOTH BLOCKS, and that placement is the fix to a gap the
        first draft had. The note was inside the reviews-and-sales section and
        said "in this section" — but the offer cards BELOW it carry fabricated
        ratings of their own, so an offer with no sales of its own rendered a
        grid of invented numbers with no disclosure at all. Splitting it into
        two notes was the alternative and is worse: a disclaimer a reader meets
        twice on one page is one they learn to skip on the pages where it
        matters.

        Rendered ONLY when something on this page really is fabricated. A
        brand-new offer by a coach with nothing else on sale has no fiction to
        disclaim, and a note about numbers that are not there is the same
        mistake in the other direction.
      */}
      {hasDemoContent ? (
        <p className="mt-8 border-t border-line pt-4 text-body-15 text-muted">
          <strong className="font-semibold text-ink">
            The reviews and numbers on this page are demo data.
          </strong>{' '}
          Nobody bought anything and nobody wrote any of these reviews. Payments are not part of this
          proof of concept.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Rebuilds the `/offers` URL the visitor arrived from.
 *
 * Only the two known filter keys are copied, and they are re-encoded by
 * `URLSearchParams` rather than pasted through — an arbitrary query string from
 * the address bar is untrusted input, and this value becomes an `href`.
 *
 * `category` gets a second check on top of that: it must be a real taxonomy
 * slug or it is dropped, so the back link always lands on a filter the offers
 * page can actually apply rather than reconstructing a dead one.
 */
/**
 * A withdrawn offer, for the three people entitled to see one: its coach, an
 * administrator, and anyone holding an order for it. Everyone else got a 404
 * several lines above.
 *
 * WHAT IT DELIBERATELY OMITS is most of the page. No claim control — the offer
 * is off sale and `claim_offer` would refuse it. No rating, no sales count, no
 * reviews: every one of those reads filters `deleted_at is null`, so they would
 * be empty by construction, and rendering "No reviews yet" over an offer that
 * has been reviewed would be a lie told by an empty query. No cross-sell grid
 * either — a page somebody reached from their purchase history is not a place
 * to sell them something else.
 *
 * WHAT IT KEEPS is what a buyer came for: what they bought, from whom, what it
 * said, and what happened to it. The description is the coach's own copy at the
 * moment of withdrawal, which is the version the buyer's purchase was about.
 *
 * It carries no `deleted_by`, and cannot: `ListingWithCoach` omits the column
 * by construction, which is why the tombstone can name the fact of withdrawal
 * without ever naming the administrator who performed one.
 */
function WithdrawnOffer({
  listing,
  withdrawnAt,
  backHref,
  coach,
}: {
  listing: ListingWithCoach;
  withdrawnAt: string;
  backHref: string;
  coach: PublicCoach | null;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <p className="text-sm">
        <Link
          href={backHref}
          className="inline-flex min-h-11 items-center text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          ← Back to offers
        </Link>
      </p>

      <header className="mt-4">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" wrap>
            {listingCategoryLabel(listing.category)}
          </Badge>
          <Badge tone="warn" wrap>
            No longer available
          </Badge>
        </span>
        <h1 className="mt-3 text-2xl font-bold tracking-tight break-words text-ink sm:text-3xl">
          {listing.title}
        </h1>
        <p className="mt-2 text-sm break-words text-muted">
          by{' '}
          {coach ? (
            <Link
              href={`/coaches/${coach.id}`}
              className="font-medium text-ink underline decoration-muted underline-offset-2 hover:decoration-ink"
            >
              {listing.coach_name}
            </Link>
          ) : (
            <span className="font-medium text-ink">{listing.coach_name}</span>
          )}
        </p>
      </header>

      <div className="mt-6">
        <Alert tone="warn" title={`Withdrawn on ${formatDate(withdrawnAt)}`}>
          {/*
            Said without blame and without detail. A coach may have withdrawn
            this themselves or an administrator may have taken it down, and
            `ListingWithCoach` carries no `deleted_by` to tell them apart — which
            is the point: publishing which administrator acted is the disclosure
            `owned_listings` exists to avoid.
          */}
          The coach has taken this offer off sale, so it cannot be claimed any more. If you already claimed
          it, nothing has changed — it is still in your purchases, and anything delivered against it is
          still there.
        </Alert>
      </div>

      <Card tone="raised" className="mt-6">
        <CardBody className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">What this was</h2>
            <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-line text-muted">
              {listing.description}
            </p>
          </div>
          <div className="shrink-0 sm:w-48 sm:text-right">
            {/*
              The price it was withdrawn AT, which is not necessarily the price
              anyone paid — an order carries `price_cents_at_purchase` for that,
              and the order page is where a buyer sees what they were charged.
            */}
            <p className="text-2xl font-bold tabular-nums text-ink">{formatPrice(listing.price_cents)}</p>
            <p className="mt-1 text-xs text-faint">Last listed price</p>
          </div>
        </CardBody>
        <CardFooter>
          <p>
            <Link href="/purchases" className="font-medium text-brand underline underline-offset-2">
              Your purchases
            </Link>{' '}
            has everything you have claimed, including this if you did.
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}

function buildBackHref(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const key of ['q', 'category'] as const) {
    const raw = params[key];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
    if (value === '') continue;
    if (key === 'category' && !isListingCategory(value)) continue;
    search.set(key, value);
  }
  const query = search.toString();
  return query === '' ? '/offers' : `/offers?${query}`;
}
