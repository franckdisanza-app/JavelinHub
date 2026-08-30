import type { Metadata } from 'next';
import Link from 'next/link';

import { NewListingForm } from '@/app/offers/new/new-listing-form';
import { Alert } from '@/components/ui/alert';
import { linkButtonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getDataClient } from '@/lib/data';
import type { CoachStatus } from '@/lib/data/types';
import { deliveryStorageAvailable } from '@/lib/storage/deliverables';
import { requireUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'New offer' };

/**
 * The offer composer, gated on the actor's stored `coach_status`.
 *
 * The route is `/offers/new`; `/listings/new` redirects here (next.config.ts).
 * The model keeps the name `listing`; only the copy says "offer".
 *
 * Note the gate is on `coach_status`, NOT on `role`. An admin who redeems an
 * invite code keeps `role: 'admin'` while gaining `coach_status: 'approved'`,
 * so gating on `role === 'coach'` would lock out exactly the people who
 * administer the marketplace.
 *
 * This gate is a courtesy, not the boundary: `createListing` re-checks the
 * stored status on every call and refuses regardless of what this page shows.
 */
export default async function NewListingPage() {
  const profile = await requireUser('/offers/new');

  if (profile.coach_status !== 'approved') {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="text-2xl font-bold tracking-tight text-ink">New offer</h1>
        <div className="mt-6">
          <NotApprovedYet status={profile.coach_status} />
        </div>
      </div>
    );
  }

  const categories = await getDataClient().listCategories();

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">New offer</h1>
        <p className="mt-1.5 text-sm text-muted">
          It appears on the offers page as soon as you publish. Payments are not part of this proof of
          concept.
        </p>
      </header>

      <Card tone="raised" className="mt-6">
        <CardHeader
          title="Offer details"
          description="Learners see the title, price, your name and the description before they open it."
        />
        <CardBody>
          {/*
            `deliveryStorageAvailable()` is a server-side read of the configured
            backend, so it is resolved here and handed down — a Client Component
            cannot ask which data backend the server is running.
          */}
          <NewListingForm categories={categories} storageAvailable={deliveryStorageAvailable()} />
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * Each non-approved state gets its own explanation and its own next step.
 * A single "you can't do that" would leave a rejected applicant and someone who
 * has never applied staring at the same dead end.
 */
function NotApprovedYet({ status }: { status: CoachStatus }) {
  if (status === 'pending_review') {
    return (
      <Alert tone="info" title="Your application is under review">
        <p>An administrator is looking at it. You can publish as soon as it is approved.</p>
        <p className="mt-3">
          <Link href="/coach/apply" className={linkButtonClass({ variant: 'secondary', size: 'sm' })}>
            View your application
          </Link>
        </p>
      </Alert>
    );
  }

  if (status === 'rejected') {
    return (
      <Alert tone="warn" title="Your application was not approved">
        <p>
          The reviewer left a note explaining why. You are welcome to apply again — a new application
          goes back into the same queue.
        </p>
        <p className="mt-3">
          <Link href="/coach/apply" className={linkButtonClass({ variant: 'secondary', size: 'sm' })}>
            Read the note and re-apply
          </Link>
        </p>
      </Alert>
    );
  }

  return (
    <Alert tone="warn" title="Only approved coaches can publish">
      <p>There are two ways to become one, and an invite code is the faster of them.</p>
      <p className="mt-3 flex flex-wrap gap-2">
        <Link href="/redeem" className={linkButtonClass({ size: 'sm' })}>
          Redeem an invite code
        </Link>
        <Link href="/coach/apply" className={linkButtonClass({ variant: 'secondary', size: 'sm' })}>
          Apply to coach
        </Link>
      </p>
    </Alert>
  );
}
