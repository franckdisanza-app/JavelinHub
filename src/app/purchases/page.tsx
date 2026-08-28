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
 * NO DELIVERY YET, and the page says so rather than implying a file is coming.
 * Claiming creates the order; handing over a training plan or a video review is
 * the next build (`docs/ROADMAP.md` §1.1). Pretending otherwise here would be
 * the one dishonest thing on the page.
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
        Everything you have claimed. Claiming is free while JavelinHub is in pilot.
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
          {/*
            The honest state of the product, written where somebody is looking
            for their thing rather than buried in a FAQ. Delivery is the next
            build; until it exists, an order is a claim and a coach gets in
            touch some other way.
          */}
          <p className="text-sm leading-relaxed text-muted">
            Your coach can see this. Handing files over inside JavelinHub is not built yet — until it is, they
            will be in touch directly.
          </p>

          <div className="flex flex-wrap gap-2">
            {/*
              The offer page, not the coach page: the buyer is most likely
              looking for what they claimed. A withdrawn offer has no public
              page, so this link is only rendered when there is somewhere to go
              — the ORDER survives a withdrawal, which is exactly why
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
