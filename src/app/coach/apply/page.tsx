import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';

import { ApplyForm } from '@/app/coach/apply/apply-form';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { linkButtonClass } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { getActor, requireUser } from '@/lib/auth/session';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import { getDataClient } from '@/lib/data';
import type { CoachApplication } from '@/lib/data/types';
import { formatDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Apply to coach' };

const APPLY_PATH = '/coach/apply';

/**
 * The public route to coach status.
 *
 * Everything on this page is decided by the applicant's **stored**
 * `coach_status` — never by the `?submitted=1` flag on its own, which anyone
 * can type. The flag only ever refines a state the store already confirms.
 *
 * The four states, and why each one renders what it does:
 *
 *   none           the form
 *   pending_review what they submitted, and no second form — `createCoachApplication`
 *                  throws `conflict` on a duplicate pending application
 *   approved       done; point them at listing creation
 *   rejected       the outcome, the reviewer's note, and the form again —
 *                  re-application IS permitted (see below)
 *
 * On re-application after a rejection: `createCoachApplication` refuses only
 * two things — an already-`approved` coach, and an existing **pending** row. A
 * rejected applicant is neither, so a fresh application is accepted and moves
 * them back to `pending_review`. The copy below promises exactly that and
 * nothing more.
 */
export default async function CoachApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Anonymous visitors land on /login?next=/coach/apply and come straight back.
  // Convenience only: the action refuses an anonymous actor by itself.
  const profile = await requireUser(APPLY_PATH);
  const params = await searchParams;
  const actor = await getActor();

  let application: CoachApplication | null;
  try {
    application = await getDataClient().getMyCoachApplication(actor);
  } catch (error) {
    return (
      <Shell>
        <DataErrorNotice error={resolveDataError(error, { nextPath: APPLY_PATH })} />
      </Shell>
    );
  }

  const status = profile.coach_status;
  const justSubmitted = status === 'pending_review' && params.submitted === '1';

  return (
    <Shell>
      {status === 'approved' ? (
        <ApprovedPanel viaApplication={application?.status === 'approved'} application={application} />
      ) : status === 'pending_review' ? (
        <PendingPanel application={application} justSubmitted={justSubmitted} />
      ) : status === 'rejected' ? (
        <RejectedPanel application={application} />
      ) : (
        <NewApplicationPanel />
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Apply to coach</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        Tell us about your background and what you would coach. An administrator reviews every application.
      </p>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}

/** The "you don't have to wait for us" note. Shown in every state that is still waiting on something. */
function InviteShortcut({ className }: { className?: string }) {
  return (
    <p className={className}>
      Been given an invite code? That is the faster route — redeeming one approves you immediately, with no review.{' '}
      <Link href="/redeem" className="font-medium text-brand underline underline-offset-2">
        Redeem an invite code
      </Link>
      .
    </p>
  );
}

function NewApplicationPanel() {
  return (
    <Card tone="raised">
      <CardHeader
        title="Your application"
        description="An administrator reads this in full. There is no word limit worth padding to."
      />
      <CardBody>
        <ApplyForm />
      </CardBody>
      <CardFooter>
        <InviteShortcut />
      </CardFooter>
    </Card>
  );
}

function PendingPanel({ application, justSubmitted }: { application: CoachApplication | null; justSubmitted: boolean }) {
  return (
    <>
      <Alert tone={justSubmitted ? 'success' : 'info'} title={justSubmitted ? 'Application submitted.' : 'Your application is under review.'}>
        {justSubmitted
          ? 'An administrator will review it and decide. You do not need to do anything else, and sending a second application is not possible while this one is open.'
          : 'An administrator has it and has not decided yet. There is nothing further for you to do — you cannot submit a second application while this one is open.'}
      </Alert>

      {application ? (
        <SubmissionCard application={application} title="What you submitted" />
      ) : (
        <Alert tone="info">
          Your account is marked as awaiting review, but the application itself could not be loaded. An administrator can
          still see your account.
        </Alert>
      )}

      <InviteShortcut className="text-sm text-muted" />
    </>
  );
}

function RejectedPanel({ application }: { application: CoachApplication | null }) {
  const note = application?.review_note ?? null;

  return (
    <>
      <Alert tone="warn" title="Your application was not approved.">
        {note
          ? 'The administrator left a note explaining why — it is below, with what you submitted.'
          : 'The administrator did not leave a note. You can apply again with a fuller account of your coaching background.'}
      </Alert>

      {note ? (
        <Card>
          <CardHeader title="The reviewer's note" description="Written by the administrator who reviewed you." />
          <CardBody>
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">{note}</p>
          </CardBody>
        </Card>
      ) : null}

      {application ? <SubmissionCard application={application} title="What you submitted" /> : null}

      {/* Re-application is genuinely permitted — see the note on the page
          component. This button therefore does not throw. */}
      <Card tone="raised">
        <CardHeader
          title="Apply again"
          description="A new application replaces nothing, and goes back into the same queue."
        />
        <CardBody>
          <ApplyForm submitLabel="Submit a new application" />
        </CardBody>
        <CardFooter>
          <InviteShortcut />
        </CardFooter>
      </Card>
    </>
  );
}

function ApprovedPanel({
  viaApplication,
  application,
}: {
  viaApplication: boolean;
  application: CoachApplication | null;
}) {
  return (
    <>
      <Alert tone="success" title="You are an approved coach.">
        {viaApplication
          ? 'Your application was approved. You can publish offers on the marketplace right now — there is nothing left to apply for.'
          : 'Your account is already approved, so there is nothing to apply for. You can publish offers right now.'}
      </Alert>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Link href="/offers/new" className={linkButtonClass({})}>
          Create an offer
        </Link>
        <Link href="/offers" className={linkButtonClass({ variant: 'secondary' })}>
          Browse offers
        </Link>
      </div>

      {viaApplication && application ? <SubmissionCard application={application} title="Your application" /> : null}
    </>
  );
}

/** What the applicant sent, read back to them. Their own data — no privacy question here. */
function SubmissionCard({ application, title }: { application: CoachApplication; title: string }) {
  const status = statusOf(application);

  return (
    <Card>
      <CardHeader
        title={title}
        description={`Submitted ${formatDate(application.created_at)}${
          application.reviewed_at ? ` · Reviewed ${formatDate(application.reviewed_at)}` : ''
        }`}
        actions={<Badge tone={status.tone}>{status.label}</Badge>}
      />
      <CardBody className="flex flex-col gap-4">
        {/*
          Rendered ONLY when the row actually has one. The apply form no longer
          asks — there is one sport — so every new application is NULL here, and
          a permanent "Sport: Not specified" row would be noise on every page.
          Old rows that DO hold a value still read back truthfully, which is why
          this is a conditional rather than a deletion.
        */}
        {application.sport ? <Detail label="Sport">{application.sport}</Detail> : null}
        <Detail label="About you">{application.bio}</Detail>
        <Detail label="Coaching experience">{application.experience}</Detail>
      </CardBody>
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold tracking-wide text-faint uppercase">{label}</h3>
      {/* See the matching note in admin/applications/page.tsx — an unbroken
          token here would break the applicant's own page the same way. */}
      <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">{children}</p>
    </div>
  );
}

function statusOf(application: CoachApplication): { label: string; tone: BadgeTone } {
  if (application.status === 'approved') return { label: 'Approved', tone: 'success' };
  if (application.status === 'rejected') return { label: 'Not approved', tone: 'warn' };
  return { label: 'Awaiting review', tone: 'brand' };
}
