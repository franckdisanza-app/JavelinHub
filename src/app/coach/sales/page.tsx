import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { linkButtonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getActor, requireUser } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import type { OrderWithListing } from '@/lib/data/types';
import { formatDate, formatPrice } from '@/lib/format';

export const metadata: Metadata = { title: 'Your sales' };

const SALES_PATH = '/coach/sales';

/**
 * What the signed-in coach has sold.
 *
 * Unlike `listMyOrders`, `listOrdersForCoach` TAKES a coach id — so it checks
 * one, and refuses anybody who is neither that coach nor an admin. The id
 * passed here is always the actor's own, which makes the check a formality on
 * this page and the reason the method is safe to expose at all.
 *
 * WHAT THIS PAGE DOES NOT SHOW: who bought. `OrderWithListing` carries
 * `learner_id` and nothing else about the buyer — no name, no email — because
 * `docs/DATA-LAYER.md` keeps `Profile` off every surface but its owner's and an
 * admin's. A coach needs to know that something sold and what it was; putting a
 * learner's identity here would publish it to every coach who ever sold
 * anything. Sending them their files happens on `/orders/[id]`, which needs no
 * name — the order is the introduction.
 */
export default async function CoachSalesPage() {
  const profile = await requireUser(SALES_PATH);

  if (profile.coach_status !== 'approved') {
    return (
      <Shell>
        <NotACoachPanel />
      </Shell>
    );
  }

  let orders: OrderWithListing[];
  try {
    orders = await getDataClient().listOrdersForCoach(await getActor(), profile.id);
  } catch (error) {
    return (
      <Shell>
        <DataErrorNotice error={resolveDataError(error, { nextPath: SALES_PATH })} />
      </Shell>
    );
  }

  return (
    <Shell>
      {orders.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <p className="text-sm text-muted">
            {orders.length} {orders.length === 1 ? 'claim' : 'claims'} across your offers.
          </p>
          <ul className="flex flex-col gap-3">
            {orders.map((order) => (
              <SaleRow key={order.id} order={order} />
            ))}
          </ul>
        </>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Your sales</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        Every claim on your offers, newest first. Open one to send the buyer their files. Claiming is free
        during the pilot, so nothing has been paid out.
      </p>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}

function SaleRow({ order }: { order: OrderWithListing }) {
  return (
    <li>
      <Card>
        <CardHeader
          title={order.listing_title}
          description={`Claimed ${formatDate(order.created_at)} · ${formatPrice(order.price_cents_at_purchase)} at the time`}
          actions={
            order.has_review ? <Badge tone="success">Reviewed</Badge> : <Badge tone="neutral">Not reviewed</Badge>
          }
        />
        <CardBody>
          <div className="flex flex-wrap gap-2">
            <Link href={`/orders/${order.id}`} className={linkButtonClass({ size: 'sm' })}>
              Open<span className="sr-only"> {order.listing_title}</span>
            </Link>
            {/*
              Safe for a coach whatever state the offer is in: they own it, so
              `getListingForViewer` gives them the published page or the
              tombstone, never a 404. Before that method was wired up this link
              could not have been rendered here at all.
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
        title="Nothing claimed yet"
        description="When somebody claims one of your offers it appears here."
      />
      <CardBody>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link href="/coach/offers" className={linkButtonClass({ variant: 'secondary' })}>
            Your offers
          </Link>
          <Link href="/offers/new" className={linkButtonClass({})}>
            New offer
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

function NotACoachPanel() {
  return (
    <Card>
      <CardHeader
        title="You are not an approved coach yet"
        description="Only approved coaches can publish offers, so there is nothing to have sold."
      />
      <CardBody>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link href="/coach/apply" className={linkButtonClass({})}>
            Apply to coach
          </Link>
          <Link href="/redeem" className={linkButtonClass({ variant: 'secondary' })}>
            Redeem an invite code
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
