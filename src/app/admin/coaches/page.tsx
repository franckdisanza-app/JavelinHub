import type { Metadata } from 'next';
import Link from 'next/link';

import { CoachStandingForm, RestoreListingForm } from '@/app/admin/coaches/coach-standing-form';
import { AdminNav } from '@/components/admin-nav';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getActor, getCurrentProfile, requireAdmin } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import type { CoachStatus, ListingWithCoach, Profile } from '@/lib/data/types';
import { formatDate } from '@/lib/format';

/**
 * Same reasoning as every other admin page: `generateMetadata` runs
 * independently of the body, so a static export would put "Coaches" in the tab
 * title on the 404 a non-admin gets.
 */
export async function generateMetadata(): Promise<Metadata> {
  const profile = await getCurrentProfile();
  return { title: profile?.role === 'admin' ? 'Coach standing' : 'Not found' };
}

/**
 * Suspending, demoting and reinstating.
 *
 * READS `profiles`, NOT `public_coaches`, through `listCoachesForAdmin` — and
 * that is the point of having a separate method rather than reusing
 * `listCoaches`. The public view filters to `approved`, so a suspended coach
 * disappears from it exactly when somebody needs to find them again.
 *
 * WHAT A SUSPENSION IS, precisely, because the page has to tell the truth about
 * it: their offers come down and they cannot publish or restore. They keep their
 * account, their sales, their reviews, and the ability to deliver work a buyer
 * has already paid for — stopping that would punish the buyer.
 *
 * ONE THING THIS PAGE CANNOT UNDO: removing somebody as a coach sets
 * `coach_status = 'none'`, which is indistinguishable from a learner who never
 * applied, so they leave this list. They can apply again through the ordinary
 * queue, and their withdrawn offers stay withdrawn until then. The confirmation
 * panel says so before the click, rather than after.
 */
export default async function AdminCoachesPage() {
  await requireAdmin('/admin/coaches');

  const actor = await getActor();
  const db = getDataClient();

  let coaches: Profile[];
  let listingsByCoach: Map<string, ListingWithCoach[]>;
  try {
    coaches = await db.listCoachesForAdmin(actor);

    /*
     * One read per coach. Genuinely N+1, and deliberately so: this is an
     * admin-only page over a list that is small by construction, and the
     * alternative is a bulk-by-coach-ids read that no other caller in the app
     * wants. If this list ever grows past a page, the fix is pagination, not a
     * wider read.
     */
    const lists = await Promise.all(coaches.map((coach) => db.listListingsForAdmin(actor, coach.id)));
    listingsByCoach = new Map(coaches.map((coach, index) => [coach.id, lists[index]]));
  } catch (error) {
    return (
      <Shell>
        <DataErrorNotice error={resolveDataError(error, { nextPath: '/admin/coaches' })} />
      </Shell>
    );
  }

  if (coaches.length === 0) {
    return (
      <Shell>
        <p className="text-sm leading-relaxed text-muted">
          Nobody has been approved as a coach yet. Approve an application or hand out an invite code, and
          they appear here.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ul className="flex flex-col gap-3">
        {coaches.map((coach) => {
          const listings = listingsByCoach.get(coach.id) ?? [];
          const onSale = listings.filter((listing) => listing.deleted_at === null);
          const withdrawn = listings.filter((listing) => listing.deleted_at !== null);

          return (
            <li key={coach.id}>
              <Card>
                <CardHeader
                  title={coach.full_name}
                  description={`Joined ${formatDate(coach.created_at)}${
                    coach.coach_headline ? ` · ${coach.coach_headline}` : ''
                  }`}
                />
                <CardBody className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {/*
                      The status chip carries the meaning in its label, never in
                      its colour alone — see `Badge`. `pending_review` and
                      `rejected` can appear here: somebody who was approved,
                      demoted and then applied again passes through both.
                    */}
                    <Badge tone={STATUS_TONES[coach.coach_status]}>{STATUS_LABELS[coach.coach_status]}</Badge>
                    {coach.role === 'admin' ? <Badge tone="brand">Administrator</Badge> : null}
                    <span className="text-body-15 text-muted">
                      {onSale.length} on sale · {withdrawn.length} withdrawn
                    </span>
                    <Link
                      href={`/coaches/${coach.id}`}
                      className="text-body-15 font-medium text-brand underline underline-offset-2"
                    >
                      Public profile
                    </Link>
                  </div>

                  <CoachStandingForm
                    coachId={coach.id}
                    coachName={coach.full_name}
                    status={coach.coach_status}
                    onSale={onSale.length}
                  />

                  {withdrawn.length > 0 ? (
                    <div className="border-t border-line pt-3">
                      <h3 className="text-xs font-semibold tracking-wide text-faint uppercase">
                        Withdrawn offers ({withdrawn.length})
                      </h3>
                      <p className="mt-1.5 text-body-15 leading-relaxed text-muted">
                        Anything an administrator took down can only be put back by an administrator.
                        Restoring is one offer at a time on purpose — a takedown from six months ago is
                        not part of today&rsquo;s decision.
                      </p>
                      <ul className="mt-2 flex flex-col gap-2">
                        {withdrawn.map((listing) => (
                          <li
                            key={listing.id}
                            className="flex flex-wrap items-center justify-between gap-2 border border-line bg-surface px-3 py-2"
                          >
                            <span className="text-sm break-words text-ink">{listing.title}</span>
                            <RestoreListingForm listingId={listing.id} title={listing.title} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<CoachStatus, string> = {
  none: 'Not a coach',
  pending_review: 'Applied',
  approved: 'Approved',
  rejected: 'Rejected',
  suspended: 'Suspended',
};

const STATUS_TONES: Record<CoachStatus, 'neutral' | 'brand' | 'success' | 'warn' | 'danger'> = {
  none: 'neutral',
  pending_review: 'neutral',
  approved: 'success',
  rejected: 'neutral',
  suspended: 'danger',
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-12">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Coach standing</h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
        Everybody who has been approved to sell. Suspending takes their offers down and stops them
        publishing; it does not touch their account, their sales, or work they still owe a buyer.
      </p>

      <AdminNav current="coaches" />

      <Alert tone="info" className="mt-6" title="Nobody is notified.">
        Nothing in this app sends email yet, so a suspension is silent — the coach finds out when they
        next open their profile, where the page says what happened. Removing somebody as a coach also
        takes them off this list, because at that point their account looks exactly like any other
        learner&rsquo;s.
      </Alert>

      <div className="mt-8">{children}</div>
    </div>
  );
}
