import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';

import {
  APPLICATION_FILTERS,
  DEFAULT_FILTER,
  FILTER_LABELS,
  parseFilter,
  toStatusFilter,
  type ApplicationFilter,
} from '@/app/admin/applications/filters';
import { ReviewForm } from '@/app/admin/applications/review-form';
import { AdminNav } from '@/components/admin-nav';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { getActor, getCurrentProfile, requireAdmin } from '@/lib/auth/session';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import { getDataClient } from '@/lib/data';
import type { CoachApplicationWithUser, CoachStatus } from '@/lib/data/types';
import { formatDate } from '@/lib/format';

const ADMIN_APPLICATIONS_PATH = '/admin/applications';

/**
 * `generateMetadata` runs independently of the page body, so a static
 * `metadata` export would put "Coach applications" in the tab title even on the
 * 404 a non-admin gets — quietly confirming the page exists to exactly the
 * person `requireAdmin()` declined to confirm it to. Same reasoning, same
 * shape, as `/admin/invites`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const profile = await getCurrentProfile();
  return { title: profile?.role === 'admin' ? 'Coach applications' : 'Not found' };
}

export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Anonymous -> /login?next=/admin/applications. Signed in but not an admin ->
  // 404, so the page's existence is not confirmed to someone poking at URLs.
  // Either way `listCoachApplications` below refuses them on its own: there is
  // no non-admin select policy on the whole application queue.
  const admin = await requireAdmin(ADMIN_APPLICATIONS_PATH);

  const params = await searchParams;
  const filter = parseFilter(typeof params.status === 'string' ? params.status : undefined);
  const reviewedId = typeof params.reviewed === 'string' ? params.reviewed : null;

  const actor = await getActor();
  const db = getDataClient();

  let all: CoachApplicationWithUser[];
  let applications: CoachApplicationWithUser[];
  try {
    // Unfiltered once, for the tab counts; then the filtered read the tab
    // actually shows. `listCoachApplications` does the status filtering, rather
    // than the page slicing a list it was not supposed to have.
    all = await db.listCoachApplications(actor);
    const status = toStatusFilter(filter);
    applications = status ? await db.listCoachApplications(actor, { status }) : all;
  } catch (error) {
    return (
      <Shell filter={filter} counts={emptyCounts()}>
        <DataErrorNotice error={resolveDataError(error, { nextPath: ADMIN_APPLICATIONS_PATH })} />
      </Shell>
    );
  }

  const counts = countBy(all);

  // The outcome banner is rebuilt from the store, not from the query string:
  // `?reviewed=<id>` only selects which row to report on, and a row that is
  // still pending reports nothing. Pasting the URL by hand therefore cannot
  // make this page claim a decision that was never recorded.
  const reviewed = reviewedId ? (all.find((a) => a.id === reviewedId) ?? null) : null;
  const outcome = reviewed && reviewed.status !== 'pending' ? reviewed : null;

  return (
    <Shell filter={filter} counts={counts}>
      {outcome ? <OutcomeBanner application={outcome} /> : null}

      <Card>
        <CardHeader
          title={`${FILTER_LABELS[filter]} applications`}
          description={describe(filter, applications.length, counts.pending)}
        />
        <CardBody className="py-0">
          {applications.length === 0 ? (
            <p className="py-6 text-sm text-muted">{emptyMessage(filter)}</p>
          ) : (
            <ul className="divide-y divide-line">
              {applications.map((application) => (
                <ApplicationRow
                  key={application.id}
                  application={application}
                  filter={filter}
                  isOwnApplication={application.user_id === admin.id}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

type Counts = Record<ApplicationFilter, number>;

function Shell({
  filter,
  counts,
  children,
}: {
  filter: ApplicationFilter;
  counts: Counts;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-12">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Coach applications</h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
        Approving an application makes that person an approved coach immediately, lets them publish offers and lists
        them in the public coach directory.
        Rejecting one tells them so — and your note is the only explanation they ever see. You cannot review your own
        application.
      </p>
      <p className="mt-2 text-sm text-muted">
        Need to fast-track someone instead?{' '}
        <Link href="/admin/invites" className="font-medium text-brand underline underline-offset-2">
          Issue an invite code
        </Link>
        .
      </p>

      <AdminNav current="applications" />

      <FilterTabs current={filter} counts={counts} />

      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}

/**
 * Links, not buttons — each tab is a distinct URL, so back/forward, bookmarking
 * and "open in new tab" all behave. `min-h-11` keeps the tap target at the
 * 44px floor the `Button` primitive already guarantees elsewhere.
 */
function FilterTabs({ current, counts }: { current: ApplicationFilter; counts: Counts }) {
  return (
    <nav aria-label="Filter applications by status" className="mt-6 flex flex-wrap gap-2">
      {APPLICATION_FILTERS.map((option) => {
        const active = option === current;
        return (
          <Link
            key={option}
            href={option === DEFAULT_FILTER ? ADMIN_APPLICATIONS_PATH : `${ADMIN_APPLICATIONS_PATH}?status=${option}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // Square. Section 06: "Every corner in the product is square — buttons,
              // cards, inputs, chips, avatars, video frames, the focus indicator. There
              // is no radius token because there is no radius." These filter tabs and
              // the reviewer-note panel below were the last two call sites in the app
              // that carried one, and they put an 8px corner into a freshly built
              // stylesheet.
              'inline-flex min-h-11 items-center gap-2 border px-3.5 text-sm font-medium transition-colors',
              active
                ? 'border-transparent bg-brand-soft text-brand-soft-ink'
                : 'border-line-strong bg-surface text-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            {FILTER_LABELS[option]}
            <span className={cn('text-xs font-semibold', active ? 'opacity-80' : 'text-faint')}>{counts[option]}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function OutcomeBanner({ application }: { application: CoachApplicationWithUser }) {
  const approved = application.status === 'approved';
  return (
    <Alert
      tone={approved ? 'success' : 'info'}
      title={
        approved
          ? `${application.user_name} is now an approved coach.`
          : `${application.user_name}'s application was rejected.`
      }
    >
      <p>
        Their account status is now <StatusText status={application.user_coach_status} />
        {approved ? ' — they can publish offers straight away.' : ' — they can apply again with a new application.'}
      </p>
      {application.review_note ? (
        <p className="mt-1">
          Your note: <span className="italic break-words">{application.review_note}</span>
        </p>
      ) : approved ? null : (
        <p className="mt-1">You did not leave a note, so they were told only that they were not approved.</p>
      )}
    </Alert>
  );
}

function ApplicationRow({
  application,
  filter,
  isOwnApplication,
}: {
  application: CoachApplicationWithUser;
  filter: ApplicationFilter;
  isOwnApplication: boolean;
}) {
  const status = statusOf(application);
  const pending = application.status === 'pending';

  return (
    <li className="flex flex-col gap-4 py-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{application.user_name}</h3>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          {/*
            `user_email` is on `CoachApplicationWithUser` and this is an
            admin-only surface, so showing it is correct and intended: an
            administrator deciding whether to let someone sell coaching needs
            to know which account they are approving. It must never appear on
            a page a non-admin can reach — `getPublicProfile` is what those use.
          */}
          <p className="mt-0.5 text-sm break-words text-muted">{application.user_email}</p>
        </div>
        <p className="shrink-0 text-xs text-muted sm:text-right">
          Submitted {formatDate(application.created_at)}
          {application.reviewed_at ? (
            <>
              <span className="hidden sm:inline"><br /></span>
              <span className="sm:hidden"> · </span>
              Reviewed {formatDate(application.reviewed_at)}
            </>
          ) : null}
        </p>
      </div>

      <dl className="flex flex-col gap-3">
        {/*
          Rendered ONLY when the row actually has one. The apply form no longer
          asks — there is one sport — so every new application is NULL here, and
          a permanent "Sport: Not specified" row would be noise on every page.
          Old rows that DO hold a value still read back truthfully, which is why
          this is a conditional rather than a deletion.
        */}
        {application.sport ? <Detail label="Sport">{application.sport}</Detail> : null}
        <Detail label="About them">{application.bio}</Detail>
        <Detail label="Coaching experience">{application.experience}</Detail>
        <Detail label="Account status">
          <StatusText status={application.user_coach_status} />
        </Detail>
      </dl>

      {application.review_note ? (
        <div className="border border-line bg-surface-2 px-4 py-3">
          <p className="text-xs font-semibold tracking-wide text-faint uppercase">Reviewer note</p>
          <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">
            {application.review_note}
          </p>
        </div>
      ) : null}

      {pending ? (
        isOwnApplication ? (
          // The data layer throws `forbidden` here — see the self-review guard
          // in `reviewCoachApplication`. Offering buttons that are certain to
          // fail would be a lie, so they are not rendered. The action still
          // handles the error if this row is POSTed to directly.
          <Alert tone="warn" title="This is your own application.">
            Another administrator has to decide it. Self-approval would defeat the point of a review queue.
          </Alert>
        ) : (
          <ReviewForm applicationId={application.id} applicantName={application.user_name} filter={filter} />
        )
      ) : (
        <p className="text-sm text-muted">
          Already {application.status === 'approved' ? 'approved' : 'rejected'} — a decision cannot be changed from
          here.
        </p>
      )}
    </li>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold tracking-wide text-faint uppercase">{label}</dt>
      {/*
        `break-words` alongside `whitespace-pre-wrap`: the latter honours the
        applicant's own line breaks but wraps only at whitespace, so a single
        unbroken token in a bio would push this queue past 2300px at a 375px
        viewport — and there is no application delete to clear it.
      */}
      <dd className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">{children}</dd>
    </div>
  );
}

/**
 * The applicant's stored `coach_status`, spelled out. This is admin-only
 * chrome: the raw enum is deliberately absent from `PublicProfile`, so it must
 * not be echoed onto any page a visitor can reach.
 */
function StatusText({ status }: { status: CoachStatus }) {
  const label: Record<CoachStatus, string> = {
    none: 'not a coach',
    pending_review: 'awaiting review',
    approved: 'approved coach',
    rejected: 'rejected',
    // An administrator stopped them. NOT the same as `rejected`, which is an
    // application decision — see `CoachStatus`.
    suspended: 'suspended',
  };
  return (
    <span className="font-medium text-ink">
      {label[status]} <span className="font-normal text-faint">({status})</span>
    </span>
  );
}

function statusOf(application: CoachApplicationWithUser): { label: string; tone: BadgeTone } {
  if (application.status === 'approved') return { label: 'Approved', tone: 'success' };
  if (application.status === 'rejected') return { label: 'Rejected', tone: 'danger' };
  return { label: 'Pending', tone: 'brand' };
}

function countBy(all: CoachApplicationWithUser[]): Counts {
  return {
    pending: all.filter((a) => a.status === 'pending').length,
    approved: all.filter((a) => a.status === 'approved').length,
    rejected: all.filter((a) => a.status === 'rejected').length,
    all: all.length,
  };
}

function emptyCounts(): Counts {
  return { pending: 0, approved: 0, rejected: 0, all: 0 };
}

function describe(filter: ApplicationFilter, shown: number, pending: number): string {
  if (shown === 0) return 'Nothing here.';
  const noun = shown === 1 ? 'application' : 'applications';
  if (filter === 'all') return `${shown} ${noun}, ${pending} awaiting a decision. Newest first.`;
  return `${shown} ${noun}. Newest first.`;
}

function emptyMessage(filter: ApplicationFilter): string {
  switch (filter) {
    case 'pending':
      return 'The queue is empty — nothing is waiting on you.';
    case 'approved':
      return 'No application has been approved yet.';
    case 'rejected':
      return 'No application has been rejected.';
    case 'all':
      return 'Nobody has applied to coach yet.';
  }
}
