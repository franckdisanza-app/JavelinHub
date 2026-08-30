import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RemoveFileForm, ReviewForm, SendFileForm } from '@/app/orders/[id]/order-forms';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { linkButtonClass } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { getActor, requireUser } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import { isDataError, type Deliverable, type OrderWithListing } from '@/lib/data/types';
import { formatDate, formatPrice } from '@/lib/format';
import {
  deliveryStorageAvailable,
  signedDeliveryUrl,
  signedOfferAssetUrl,
} from '@/lib/storage/deliverables';

export const metadata: Metadata = { title: 'Order' };

/**
 * ONE page for both sides of an order.
 *
 * The buyer and the coach are looking at the same thing — what was claimed, and
 * the files going back and forth about it — so two pages would be two copies of
 * one screen, kept in step by hand. What differs is small and derived from
 * which of the order's two ids matches the viewer: who the counterpart is, what
 * the upload prompt says, and whether a review form appears.
 *
 * `getOrder` is the boundary: it admits the buyer, the selling coach and an
 * admin, and returns `null` to everyone else. A stranger therefore gets a 404
 * rather than a refusal, which says nothing about whether the order exists.
 */
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const orderPath = `/orders/${id}`;
  const profile = await requireUser(orderPath);
  const search = await searchParams;

  const db = getDataClient();
  const actor = await getActor();

  let order: OrderWithListing | null;
  try {
    order = await db.getOrder(actor, id);
  } catch (error) {
    /*
     * `forbidden` IS A 404 HERE, and normalising it is not cosmetic.
     *
     * The two backends disagree about a stranger, and `supabase/README.md`
     * records it: the mock throws `forbidden` while RLS makes the row simply
     * invisible, so `SupabaseDataClient.getOrder` returns `null`. Left alone
     * this page would 404 in production and render a "not permitted" notice on
     * the mock — the same visitor, two different answers, and the louder one
     * confirms that an order exists at that id.
     *
     * The doc comment above promises a 404 for anyone not on the order. This is
     * where that promise is kept for both backends.
     */
    if (isDataError(error) && error.code === 'forbidden') notFound();
    return (
      <Shell>
        <DataErrorNotice error={resolveDataError(error, { nextPath: orderPath })} />
      </Shell>
    );
  }
  if (!order) notFound();

  const isBuyer = order.learner_id === profile.id;
  const isCoach = order.coach_id === profile.id;

  /*
   * WHICH OF TWO PAGES THIS IS.
   *
   * An instant order is finished the moment it exists: the file was attached
   * before the offer went on sale, and claiming was the delivery. A personalised
   * one is the start of an exchange — the buyer sends their throw, the coach
   * returns an analysis — so it needs an upload control and a list that grows.
   *
   * Rendering both would be worse than rendering the wrong one. An "awaiting
   * delivery" badge over a file that is already downloadable is a false status,
   * and a "send your coach a file" box on an order with no coach step invites an
   * upload nobody will read.
   */
  const isInstant = order.listing_fulfilment === 'instant';

  // A signed URL for the instant download, minted now and good for five minutes.
  // `order.asset_path` is `null` unless the viewer is entitled to it — see
  // `OrderWithListing.asset_path` — and the storage policy is checked again when
  // this is signed, so neither of the two is doing the job alone.
  const instantUrl = isInstant && order.asset_path ? await signedOfferAssetUrl(order.asset_path) : null;

  let files: Deliverable[] = [];
  let filesFailed = false;
  if (!isInstant) {
    try {
      files = await db.listDeliverables(actor, order.id);
    } catch {
      // The files are the point of the page, but a failure to list them must not
      // take the order summary and the review form down with it.
      filesFailed = true;
    }
  }

  // A signed URL per file, minted now and good for five minutes. Never stored,
  // never shared: `deliverables_read_party` is evaluated for THIS viewer, so a
  // link only exists because they were entitled to it at render time.
  const links = await Promise.all(
    files.map(async (file) => ({
      file,
      url: await signedDeliveryUrl(file.storage_path, file.file_name),
      mine: file.uploaded_by === profile.id,
      fromCoach: file.uploaded_by === order.coach_id,
    })),
  );

  // An instant order was delivered at the moment it was claimed, so there is no
  // waiting state for it to be in.
  const coachHasDelivered = isInstant || files.some((file) => file.uploaded_by === order.coach_id);
  const justReviewed = search.reviewed === '1';

  return (
    <Shell>
      <Link
        href={isCoach && !isBuyer ? '/coach/sales' : '/purchases'}
        className="text-sm font-medium text-brand underline underline-offset-2"
      >
        ← {isCoach && !isBuyer ? 'Your sales' : 'Your purchases'}
      </Link>

      <Card>
        <CardHeader
          title={order.listing_title}
          description={`Claimed ${formatDate(order.created_at)} · ${formatPrice(order.price_cents_at_purchase)}`}
          actions={
            coachHasDelivered ? <Badge tone="success">Delivered</Badge> : <Badge tone="brand">Awaiting delivery</Badge>
          }
        />
        <CardBody>
          <p className="text-sm leading-relaxed text-muted">
            {isInstant
              ? isCoach
                ? 'This is an instant download. They received the attached file when they claimed it.'
                : 'This is an instant download. It is below, and it stays here — come back for it whenever you need it.'
              : isCoach
                ? coachHasDelivered
                  ? 'You have sent something for this order. You can send more if you need to.'
                  : 'Somebody claimed this. Send them what you promised.'
                : coachHasDelivered
                  ? 'Your coach has sent something. It is below.'
                  : 'Your coach can see this order. Anything they send appears below.'}
          </p>
        </CardBody>
        <CardFooter>
          <p>Nothing was charged — claiming is free while JavelinHub is in pilot.</p>
        </CardFooter>
      </Card>

      {/* -------------------------------------------- Instant download */}
      {isInstant ? (
        <Card tone="raised">
          <CardHeader
            title="Your download"
            description="Only you and the coach can open this. The link below is good for a few minutes; reload the page for a fresh one."
          />
          <CardBody>
            {instantUrl ? (
              /*
                A short-lived signed URL, so an ordinary link rather than a route
                of ours — and no `download` attribute, for the reason `FileRow`
                gives: the signed URL carries the filename as a
                content-disposition, which a `download` attribute would not
                survive the redirect to apply.
              */
              <a
                href={instantUrl}
                rel="noopener noreferrer"
                className={linkButtonClass({ variant: 'secondary' })}
              >
                Download {order.listing_title}
              </a>
            ) : (
              /*
                Three different things land here and none of them is the buyer's
                fault: the coach removed the file after this was claimed, the
                signing failed, or the viewer is an admin — who can see that an
                order exists and is deliberately not handed its file. One
                sentence for all three, because distinguishing them would tell an
                admin they were refused rather than simply not served.
              */
              <p className="text-sm leading-relaxed text-muted">
                This download is not available right now. If it does not come back, ask the coach — the
                order is unaffected and nothing about it has changed.
              </p>
            )}
          </CardBody>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------ Files */}
      {isInstant ? null : (
      <Card tone="raised">
        <CardHeader
          title="Files"
          description="Only you and the other person on this order can see or download these."
        />
        <CardBody className="flex flex-col gap-5">
          {filesFailed ? (
            <p className="text-sm leading-relaxed text-muted">The files could not be loaded just now.</p>
          ) : links.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted">Nothing has been sent yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {links.map(({ file, url, mine, fromCoach }) => (
                <FileRow
                  key={file.id}
                  orderId={order.id}
                  file={file}
                  url={url}
                  mine={mine}
                  fromCoach={fromCoach}
                />
              ))}
            </ul>
          )}

          {deliveryStorageAvailable() ? (
            <SendFileForm
              orderId={order.id}
              label={isCoach ? 'Send your work' : 'Send something to your coach'}
              hint={
                isCoach
                  ? 'PDF, image, video, text, CSV or spreadsheet, up to 50 MB.'
                  : 'A video of your throw, or anything else your coach asked for. Up to 50 MB.'
              }
            />
          ) : (
            <Alert tone="info" title="File delivery is not available here.">
              This app is running on the local JSON store, which has no file storage.
            </Alert>
          )}
        </CardBody>
      </Card>
      )}

      {/* ----------------------------------------------------------- Review */}
      {isBuyer ? (
        justReviewed || order.has_review ? (
          <Alert tone="success" title="Thanks for the review.">
            It is on the offer and counts towards this coach&rsquo;s rating.
          </Alert>
        ) : (
          <Card tone="raised">
            <CardHeader
              title="Review this"
              description="Once published it is public, and you cannot edit or remove it."
            />
            <CardBody>
              <ReviewForm orderId={order.id} offerTitle={order.listing_title} />
            </CardBody>
          </Card>
        )
      ) : null}
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  );
}

function FileRow({
  orderId,
  file,
  url,
  mine,
  fromCoach,
}: {
  orderId: string;
  file: Deliverable;
  url: string | null;
  mine: boolean;
  fromCoach: boolean;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium break-words text-ink">{file.file_name}</p>
        <p className="mt-0.5 text-xs text-faint">
          {fromCoach ? 'From your coach' : 'From the buyer'} · {formatDate(file.created_at)} ·{' '}
          {formatBytes(file.size_bytes)}
        </p>
      </div>
      <div className="flex shrink-0 items-start gap-2">
        {url ? (
          /*
            A short-lived signed URL, so this is an ordinary link rather than a
            route of ours. `rel="noopener"` because it leaves the app, and no
            `download` attribute — the signed URL already carries the filename
            as a content-disposition, which survives the redirect that a
            `download` attribute would not.
          */
          <a
            href={url}
            rel="noopener noreferrer"
            className={linkButtonClass({ variant: 'secondary', size: 'sm' })}
          >
            Download<span className="sr-only"> {file.file_name}</span>
          </a>
        ) : (
          <span className="text-xs text-faint">Link unavailable</span>
        )}
        {mine ? (
          <RemoveFileForm
            orderId={orderId}
            deliverableId={file.id}
            path={file.storage_path}
            fileName={file.file_name}
          />
        ) : null}
      </div>
    </li>
  );
}

/** Human file size. Binary units, because that is what an OS reports. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
