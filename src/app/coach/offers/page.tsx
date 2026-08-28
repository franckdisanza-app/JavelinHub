import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';

import { RestoreOfferForm, WithdrawOfferForm } from '@/app/coach/offers/offer-actions';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { linkButtonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getActor, requireUser } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import { LISTING_CATEGORY_LABELS, type OwnedListing } from '@/lib/data/types';
import { formatDate, formatPrice } from '@/lib/format';

export const metadata: Metadata = { title: 'Your offers' };

const DASHBOARD_PATH = '/coach/offers';

/**
 * The coach's own offers — the only place withdrawn ones are visible.
 *
 * `listMyListings` is the one listing read that does NOT filter `deleted_at`,
 * and it returns `OwnedListing`, which carries the derived
 * `withdrawn_by_admin` boolean. That flag is the whole reason this page can be
 * honest about the Restore control: a coach may undo their own withdrawal, but
 * `guard_listing_update()` refuses to let them clear a `deleted_at` an
 * administrator set. Rendering a button that is guaranteed to fail is worse
 * than rendering none, so a takedown gets an explanation instead.
 *
 * The flag is a BOOLEAN and never the administrator's id — see
 * `supabase/migrations/0003_read_models.sql`, which publishes the derived
 * answer precisely so `listings.deleted_by` can stay unreadable.
 */
export default async function CoachOffersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const profile = await requireUser(DASHBOARD_PATH);
  const params = await searchParams;

  if (profile.coach_status !== 'approved') {
    return (
      <Shell>
        <NotACoachPanel />
      </Shell>
    );
  }

  let offers: OwnedListing[];
  try {
    offers = await getDataClient().listMyListings(await getActor());
  } catch (error) {
    return (
      <Shell>
        <DataErrorNotice error={resolveDataError(error, { nextPath: DASHBOARD_PATH })} />
      </Shell>
    );
  }

  // The flag names an offer that is actually ours, so it cannot be used to
  // probe for one that is not: an id we do not own is simply not in this list.
  const savedId = typeof params.saved === 'string' ? params.saved : null;
  const savedOffer = savedId ? (offers.find((offer) => offer.id === savedId) ?? null) : null;

  const live = offers.filter((offer) => offer.deleted_at === null);
  const withdrawn = offers.filter((offer) => offer.deleted_at !== null);

  return (
    <Shell>
      {savedOffer ? (
        <Alert tone="success" title="Offer saved.">
          {savedOffer.title} is up to date.
        </Alert>
      ) : null}

      {offers.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <Section
            title="On sale"
            count={live.length}
            empty="Nothing is on sale right now. Anything you withdraw is below and can be put back."
          >
            {live.map((offer) => (
              <OfferRow key={offer.id} offer={offer} />
            ))}
          </Section>

          {withdrawn.length > 0 ? (
            <Section title="Withdrawn" count={withdrawn.length} empty="">
              {withdrawn.map((offer) => (
                <OfferRow key={offer.id} offer={offer} />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:py-14">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Your offers</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Everything you have published, including what you have taken off sale.
          </p>
        </div>
        <Link href="/offers/new" className={linkButtonClass({ size: 'sm' })}>
          New offer
        </Link>
      </div>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-xs font-semibold tracking-wide text-faint uppercase">
        {title} ({count})
      </h2>
      {count === 0 ? (
        <p className="mt-2 text-sm leading-relaxed text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3">{children}</ul>
      )}
    </section>
  );
}

function OfferRow({ offer }: { offer: OwnedListing }) {
  const status = statusOf(offer);
  const withdrawn = offer.deleted_at !== null;

  return (
    <li>
      <Card>
        <CardHeader
          title={offer.title}
          description={`${formatPrice(offer.price_cents)} · ${categoryLabel(offer.category)} · Updated ${formatDate(offer.updated_at)}`}
          actions={<Badge tone={status.tone}>{status.label}</Badge>}
        />
        <CardBody className="flex flex-col gap-3">
          {/*
            The price epoch, explained where it has consequences rather than in
            a help page. Raising a price archives that offer's rating and sales
            — they still count on the coach's account, and the offer reads as
            new. A coach about to raise a price should know that before they do,
            not after their rating disappears.
          */}
          {offer.price_epoch > 1 ? (
            <p className="text-xs leading-relaxed text-faint">
              This offer has been re-priced upwards {offer.price_epoch - 1}{' '}
              {offer.price_epoch === 2 ? 'time' : 'times'}. Reviews and sales from before the last increase still
              count towards your coach profile, but this offer shows only what has happened since.
            </p>
          ) : null}

          {withdrawn && offer.withdrawn_by_admin ? (
            <Alert tone="warn" title="An administrator removed this offer.">
              Only an administrator can put it back on sale. You can still edit it — if it was taken down over
              something you can fix, fixing it is the right first step.
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-start gap-2">
            <Link
              href={`${DASHBOARD_PATH}/${offer.id}/edit`}
              className={linkButtonClass({ variant: 'secondary', size: 'sm' })}
            >
              Edit<span className="sr-only"> {offer.title}</span>
            </Link>

            {/*
              A withdrawn offer has no public page, so the link is only rendered
              while there is somewhere for it to go. The owner can still reach
              the offer through Edit.
            */}
            {!withdrawn ? (
              <Link href={`/offers/${offer.id}`} className={linkButtonClass({ variant: 'secondary', size: 'sm' })}>
                View<span className="sr-only"> {offer.title} as a learner sees it</span>
              </Link>
            ) : null}

            {withdrawn ? (
              offer.withdrawn_by_admin ? null : (
                <RestoreOfferForm id={offer.id} title={offer.title} />
              )
            ) : (
              <WithdrawOfferForm id={offer.id} title={offer.title} />
            )}
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
        title="You have not published anything yet"
        description="An offer is one thing you will do for a learner, at one price."
      />
      <CardBody>
        <Link href="/offers/new" className={linkButtonClass({})}>
          Create your first offer
        </Link>
      </CardBody>
    </Card>
  );
}

function NotACoachPanel() {
  return (
    <Card>
      <CardHeader
        title="You are not an approved coach yet"
        description="Only approved coaches can publish offers, so there is nothing here to manage."
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

function statusOf(offer: OwnedListing): { label: string; tone: BadgeTone } {
  if (offer.deleted_at === null) return { label: 'On sale', tone: 'success' };
  if (offer.withdrawn_by_admin) return { label: 'Removed', tone: 'warn' };
  return { label: 'Withdrawn', tone: 'neutral' };
}

/**
 * `category` is `StoredListingCategory` — the fixed taxonomy WIDENED with
 * `string`, because a row written before a slug was retired still holds it. An
 * unrecognised slug therefore has to render as something rather than as
 * `undefined`.
 */
function categoryLabel(category: string): string {
  return LISTING_CATEGORY_LABELS[category as keyof typeof LISTING_CATEGORY_LABELS] ?? 'Other';
}
