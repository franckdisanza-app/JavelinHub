import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { linkButtonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getActor, requireUser } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import type { OrderWithListing } from '@/lib/data/types';
import { formatDate, formatPrice } from '@/lib/format';

export const metadata: Metadata = { title: 'Your purchases' };

const PURCHASES_PATH = '/purchases';

/**
 * What the signed-in learner has claimed.
 *
 * `listMyOrders` derives the learner id from the actor and takes no parameter,
 * so this page cannot be pointed at anyone else — there is no id in the URL to
 * change. That is why it is `/purchases` and not `/purchases/[userId]`.
 *
 * This is a LIST, not the order itself. Everything that happens to a purchase —
 * sending your coach a video, downloading what comes back, reviewing it —
 * happens on `/orders/[id]`, which both parties share. Duplicating any of it
 * here would be two screens to keep in step.
 */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireUser(PURCHASES_PATH);
  const params = await searchParams;

  let orders: OrderWithListing[];
  try {
    orders = await getDataClient().listMyOrders(await getActor());
  } catch (error) {
    return (
      <Shell>
        <DataErrorNotice error={resolveDataError(error, { nextPath: PURCHASES_PATH })} />
      </Shell>
    );
  }

  const justClaimed = params.claimed === '1';

  return (
    <Shell>
      {justClaimed ? (
        <Alert tone="success" title="Claimed.">
          The coach can see it on their sales. Nothing was charged.
        </Alert>
      ) : null}

      {orders.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => (
            <PurchaseRow key={order.id} order={order} />
          ))}
        </ul>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Your purchases</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        Everything you have claimed. Open one to send your coach a file, download what they send back, or
        leave a review.
      </p>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}

function PurchaseRow({ order }: { order: OrderWithListing }) {
  return (
    <li>
      <Card>
        <CardHeader
          title={order.listing_title}
          description={`Claimed ${formatDate(order.created_at)} · ${formatPrice(order.price_cents_at_purchase)}`}
          actions={
            order.has_review ? <Badge tone="success">Reviewed</Badge> : <Badge tone="neutral">Not reviewed</Badge>
          }
        />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Link href={`/orders/${order.id}`} className={linkButtonClass({ size: 'sm' })}>
              Open<span className="sr-only"> {order.listing_title}</span>
            </Link>
            {/*
              The offer page, not the coach page: the buyer is most likely
              looking for what they claimed.
              
              THIS LINK USED TO 404. The comment here claimed it was "only
              rendered when there is somewhere to go", and it was not — it is
              unconditional, and a withdrawn offer had no page at all, so a buyer
              whose coach took an offer down followed this straight into the
              not-found page. That was the dead end `getListingForViewer` was
              written for and never wired up to.
              
              It now lands on a tombstone, because `/offers/[id]` asks
              `getListingForViewer` rather than `getListing`: published for
              everyone, and withdrawn-with-a-date for the coach, an admin, and
              anyone holding an order — which the reader of this page is, by
              construction. The ORDER survives a withdrawal, which is also why
              `listing_title` is resolved without a `deleted_at` filter.
            */}
            <Link
              href={`/offers/${order.listing_id}`}
              className={linkButtonClass({ variant: 'secondary', size: 'sm' })}
            >
              View the offer<span className="sr-only"> {order.listing_title}</span>
            </Link>
          </div>
        </CardBody>
      </Card>
    </li>
  );
}

function EmptyState() {
  return (
    <Card tone="raised">
      <CardHeader
        title="You have not claimed anything yet"
        description="Browse the offers and claim one — it is free during the pilot."
      />
      <CardBody>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link href="/offers" className={linkButtonClass({})}>
            Browse offers
          </Link>
          <Link href="/coaches" className={linkButtonClass({ variant: 'secondary' })}>
            Browse coaches
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
