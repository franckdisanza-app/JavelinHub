import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EditOfferForm } from '@/app/coach/offers/[id]/edit/edit-offer-form';
import { OfferAssetForm } from '@/app/coach/offers/[id]/edit/offer-asset-form';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getActor, requireUser } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import { LISTING_CATEGORY_LABELS, isDataError, type ListingRevision, type OwnedListing } from '@/lib/data/types';
import { firstValue } from '@/lib/search-params';
import { deliveryStorageAvailable, signedOfferAssetUrl } from '@/lib/storage/deliverables';
import { formatDate, formatPrice } from '@/lib/format';

export const metadata: Metadata = { title: 'Edit offer' };

const DASHBOARD_PATH = '/coach/offers';

/**
 * Edit one of the actor's own offers.
 *
 * The offer is loaded from `listMyListings` rather than `getListing`, and that
 * is deliberate: this page has to work for a WITHDRAWN offer — editing one is
 * explicitly permitted, because refusing would leave a coach unable to fix
 * whatever got their offer taken down — and every public listing read filters
 * `deleted_at`. `listMyListings` is the only read that does not, and it is
 * already scoped to the actor, so an id belonging to somebody else simply is
 * not in the list and falls through to `notFound()`.
 *
 * That 404 is also the right answer for a stranger poking at ids: it says
 * nothing about whether the offer exists.
 */
export default async function EditOfferPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const editPath = `${DASHBOARD_PATH}/${id}/edit`;

  const profile = await requireUser(editPath);
  if (profile.coach_status !== 'approved') notFound();

  const actor = await getActor();
  const db = getDataClient();

  /*
   * ONE OFFER, by id. This used to read the coach's whole dashboard and
   * `.find()` the row — which was merely wasteful while that read was unbounded
   * and is WRONG now that it is a page: a coach with more than a page of offers
   * would get a 404 on the editor for any of their older ones.
   *
   * `null` covers "no such offer" and "not yours" alike, which is why the answer
   * is `notFound()` either way.
   */
  let offer: OwnedListing | null;
  try {
    offer = await db.getMyListing(actor, id);
  } catch (error) {
    return (
      <Shell id={id}>
        <DataErrorNotice error={resolveDataError(error, { nextPath: editPath })} />
      </Shell>
    );
  }

  if (!offer) notFound();

  // Owner-or-admin, and we are the owner by construction — but a failure here
  // must not take the editor down with it. The history is context; the form is
  // the job.
  let revisions: ListingRevision[] = [];
  let revisionsFailed = false;
  try {
    // The first page only. The history is context beside the form, not a list to
    // walk — a coach who wants the whole thing has the page they are on, and
    // paging it would put a second cursor in this URL for a panel nobody
    // navigates. `total` below says how many there are in full.
    revisions = (await db.listListingRevisions(actor, offer.id)).items;
  } catch (error) {
    if (!isDataError(error)) throw error;
    revisionsFailed = true;
  }

  const categories = await db.listCategories();

  /*
   * Has anybody claimed this offer? It decides one thing: whether the delivery
   * mode is still changeable, because `guard_listing_update()` freezes it at the
   * first claim.
   *
   * Read from the coach's own sales rather than from `getOfferStats`, which
   * looks like the cheaper answer and is the wrong one: that rollup counts sales
   * AT THE CURRENT PRICE EPOCH, so an offer whose price has gone up since it
   * sold reports zero — and would unlock a control the database will refuse.
   * A failure here falls back to LOCKED, so the worst case is a control that is
   * missing rather than one that is guaranteed to fail.
   */
  let claimed = true;
  try {
    // ONE COUNT, not a scan of every sale the coach has ever made — which is a
    // page now, so the scan would answer "not claimed" for a busy coach and
    // unlock a control the database refuses. `countOrdersForListing` counts
    // every epoch, which is exactly what `guard_listing_update()` freezes on.
    claimed = (await db.countOrdersForListing(actor, offer.id)) > 0;
  } catch (error) {
    if (!isDataError(error)) throw error;
  }

  const storageAvailable = deliveryStorageAvailable();
  // Minted per render and good for five minutes, so the coach can check what a
  // buyer actually receives. Never stored.
  const assetUrl = offer.asset_path ? await signedOfferAssetUrl(offer.asset_path) : null;
  const attachFailed = firstValue((await searchParams).attach) === 'failed';

  return (
    <Shell id={id} title={offer.title}>
      {/*
        Set by `createListingAction` when the offer was published but its file
        did not attach — a window that cannot be closed, because the path is
        pinned under an id the insert is what produces. The offer exists, is on
        sale, and cannot be claimed until the upload below succeeds.
      */}
      {attachFailed ? (
        <Alert tone="warn" title="The offer was published, but the file did not attach.">
          Everything else saved. Attach the file below and the offer becomes claimable — until then every
          attempt to claim it is refused.
        </Alert>
      ) : null}

      {offer.deleted_at !== null ? (
        <Alert
          tone={offer.withdrawn_by_admin ? 'warn' : 'info'}
          title={offer.withdrawn_by_admin ? 'An administrator removed this offer.' : 'This offer is withdrawn.'}
        >
          {offer.withdrawn_by_admin
            ? 'You can still edit it, and you should if it was taken down over something you can fix — but only an administrator can put it back on sale.'
            : 'Editing a withdrawn offer is fine. It stays off sale until you put it back from your offers page.'}
        </Alert>
      ) : null}

      <Card tone="raised">
        <CardHeader title="Edit this offer" description="Changes are live as soon as you save." />
        <CardBody>
          <EditOfferForm
            id={offer.id}
            categories={categories}
            title={offer.title}
            description={offer.description}
            // The input speaks pounds; the row stores integer cents.
            price={(offer.price_cents / 100).toFixed(2)}
            category={offer.category}
            fulfilment={offer.fulfilment}
            assetPath={offer.asset_path}
            claimed={claimed}
            storageAvailable={storageAvailable}
          />
        </CardBody>
      </Card>

      {/*
        Only for an instant offer. A personalised one attaches its files to each
        ORDER instead, on the order page, where both parties can see them —
        there is nothing to attach here.
      */}
      {offer.fulfilment === 'instant' ? (
        <Card tone="raised">
          <CardHeader
            title="The file buyers download"
            description="One file, the same for everyone, handed over the moment somebody claims this offer."
          />
          <CardBody>
            <OfferAssetForm
              listingId={offer.id}
              currentPath={offer.asset_path}
              currentName={assetFileName(offer.asset_path)}
              currentUrl={assetUrl}
              available={storageAvailable}
            />
          </CardBody>
        </Card>
      ) : null}

      <RevisionHistory revisions={revisions} failed={revisionsFailed} current={offer} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function Shell({ id, title, children }: { id: string; title?: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <Link href={DASHBOARD_PATH} className="text-sm font-medium text-brand underline underline-offset-2">
        ← Your offers
      </Link>
      <h1 className="mt-3 text-2xl font-bold tracking-tight break-words text-ink">{title ?? 'Edit offer'}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        {title ? 'Editing your own offer.' : `Offer ${id}`}
      </p>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}

/**
 * What this offer used to say.
 *
 * A revision is a snapshot of the SUPERSEDED row, written by a trigger at the
 * moment of an edit — so the newest entry is what the offer said immediately
 * before the most recent save, and the current values are not in the list.
 * That is why the current state is rendered above them rather than left
 * implicit: a history whose first row is "what it says now" would read as one
 * edit too many.
 *
 * Owner-and-admin only, never public. A per-offer price history is exactly the
 * thing `listing_revisions` has no anon policy for.
 */
function RevisionHistory({
  revisions,
  failed,
  current,
}: {
  revisions: ListingRevision[];
  failed: boolean;
  current: OwnedListing;
}) {
  return (
    <Card>
      <CardHeader
        title="Edit history"
        description="Only you and an administrator can see this. It is never shown to learners."
      />
      <CardBody>
        {failed ? (
          <p className="text-sm leading-relaxed text-muted">The edit history could not be loaded just now.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            <li className="border-l-2 border-brand pl-3">
              <p className="text-xs font-semibold tracking-wide text-brand uppercase">Now</p>
              <p className="mt-0.5 text-sm break-words text-ink">{current.title}</p>
              <p className="text-xs text-faint">
                {formatPrice(current.price_cents)} · {categoryLabel(current.category)}
              </p>
            </li>

            {revisions.length === 0 ? (
              <li className="border-l-2 border-line pl-3">
                <p className="text-sm leading-relaxed text-muted">
                  Never edited. The first time you save a change, what it says today is recorded here.
                </p>
              </li>
            ) : (
              revisions.map((revision) => (
                <li key={revision.id} className="border-l-2 border-line pl-3">
                  <p className="text-xs font-semibold tracking-wide text-faint uppercase">
                    Until {formatDate(revision.created_at)}
                  </p>
                  <p className="mt-0.5 text-sm break-words text-ink">{revision.title}</p>
                  <p className="text-xs text-faint">
                    {formatPrice(revision.price_cents)} · {categoryLabel(revision.category)}
                  </p>
                </li>
              ))
            )}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The display name of the attached file, recovered from its object key.
 *
 * The key is `<listing_id>/<random>-<name>`, built by `uploadOfferAsset` from a
 * name `safeFileName()` has already stripped — so this is a reversal of a shape
 * this app produced, not a parse of anything a browser sent. The random prefix
 * is dropped; a key that does not match the shape is shown as-is rather than
 * being replaced with a guess.
 *
 * Unlike a deliverable, there is no `file_name` column to read: the instant
 * asset is one column on `listings`, not a row of its own. That is the cost of
 * the simpler schema, and it is paid here.
 */
function assetFileName(path: string | null): string | null {
  if (!path) return null;
  const last = path.split('/').pop() ?? path;
  const dash = last.indexOf('-');
  return dash > 0 ? last.slice(dash + 1) : last;
}

/** See the matching note on the dashboard: `category` is widened with `string`. */
function categoryLabel(category: string): string {
  return LISTING_CATEGORY_LABELS[category as keyof typeof LISTING_CATEGORY_LABELS] ?? 'Other';
}
