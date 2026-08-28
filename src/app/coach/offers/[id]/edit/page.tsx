import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EditOfferForm } from '@/app/coach/offers/[id]/edit/edit-offer-form';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getActor, requireUser } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import { LISTING_CATEGORY_LABELS, isDataError, type ListingRevision, type OwnedListing } from '@/lib/data/types';
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
export default async function EditOfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const editPath = `${DASHBOARD_PATH}/${id}/edit`;

  const profile = await requireUser(editPath);
  if (profile.coach_status !== 'approved') notFound();

  const actor = await getActor();
  const db = getDataClient();

  let offers: OwnedListing[];
  try {
    offers = await db.listMyListings(actor);
  } catch (error) {
    return (
      <Shell id={id}>
        <DataErrorNotice error={resolveDataError(error, { nextPath: editPath })} />
      </Shell>
    );
  }

  const offer = offers.find((candidate) => candidate.id === id);
  if (!offer) notFound();

  // Owner-or-admin, and we are the owner by construction — but a failure here
  // must not take the editor down with it. The history is context; the form is
  // the job.
  let revisions: ListingRevision[] = [];
  let revisionsFailed = false;
  try {
    revisions = await db.listListingRevisions(actor, offer.id);
  } catch (error) {
    if (!isDataError(error)) throw error;
    revisionsFailed = true;
  }

  const categories = await db.listCategories();

  return (
    <Shell id={id} title={offer.title}>
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
          />
        </CardBody>
      </Card>

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

/** See the matching note on the dashboard: `category` is widened with `string`. */
function categoryLabel(category: string): string {
  return LISTING_CATEGORY_LABELS[category as keyof typeof LISTING_CATEGORY_LABELS] ?? 'Other';
}
