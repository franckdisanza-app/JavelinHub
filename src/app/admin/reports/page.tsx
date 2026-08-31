import type { Metadata } from 'next';
import Link from 'next/link';

import {
  parseReportFilter,
  REPORT_FILTER_LABELS,
  REPORT_FILTERS,
  reportsPathFor,
  toReportStatus,
  type ReportFilter,
} from '@/app/admin/reports/filters';
import { ResolveReportForm } from '@/app/admin/reports/resolve-report-form';
import { AdminNav } from '@/components/admin-nav';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { getActor, getCurrentProfile, requireAdmin } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import {
  COACH_REPORT_LABELS,
  REVIEW_REPORT_LABELS,
  type AdminActionWithNames,
  type ReportReason,
  type ReportSubject,
  type ReportWithContext,
} from '@/lib/data/types';
import { formatDate } from '@/lib/format';
import { firstValue } from '@/lib/search-params';

/**
 * The same reasoning as `/admin/invites` and `/admin/reviews`:
 * `generateMetadata` runs independently of the page body, so a static
 * `metadata` export would put "Reports" in the tab title on the 404 a non-admin
 * gets — confirming the page exists to exactly the person `requireAdmin()`
 * declined to confirm it to.
 */
export async function generateMetadata(): Promise<Metadata> {
  const profile = await getCurrentProfile();
  return { title: profile?.role === 'admin' ? 'Reports' : 'Not found' };
}

/**
 * The moderation queue.
 *
 * TWO KINDS OF REPORT IN ONE LIST, and that is the design rather than an
 * accident of implementation. A coach reporting a review and a buyer reporting
 * a coach are the same job — somebody says something on this site is wrong, and
 * one person decides — and splitting them into two queues would mean two places
 * to check and one of them going stale.
 *
 * RESOLVING IS NOT THE CONSEQUENCE. Upholding a review report does not delete
 * the review; upholding a coach report does not suspend the coach. Each card
 * links to the page where that second decision is made, with its own
 * confirmation. See `resolveReportAction` for why they are separate.
 *
 * THE SUBJECT MAY BE GONE by the time anybody reads a report — removing a
 * review deletes the row — which is why neither subject column is a foreign
 * key, and why a card can say the review has since been removed instead of
 * vanishing along with the thing it was about.
 */
export default async function AdminReportsPage({ searchParams }: PageProps<'/admin/reports'>) {
  // Anonymous -> /login?next=/admin/reports. Signed in but not an admin -> 404,
  // so the page's existence is not confirmed to somebody poking at URLs. Every
  // read below would refuse them regardless.
  await requireAdmin('/admin/reports');

  const params = await searchParams;
  const filter = parseReportFilter(firstValue(params.status));

  const actor = await getActor();
  const db = getDataClient();

  let reports: ReportWithContext[];
  let counts: Counts;
  let actions: AdminActionWithNames[];
  try {
    // Unfiltered once, for the tab counts; then filtered here rather than by a
    // second round trip. `/admin/applications` reads twice because its filter
    // is pushed into the query; this one is a four-way count over the same
    // rows, so a second read would fetch what is already in hand.
    const all = await db.listReports(actor);
    counts = countBy(all);

    const status = toReportStatus(filter);
    reports = status ? all.filter((report) => report.status === status) : all;

    actions = await db.listAdminActions(actor);
  } catch (error) {
    return (
      <Shell filter={filter} counts={emptyCounts()}>
        <DataErrorNotice error={resolveDataError(error, { nextPath: '/admin/reports' })} />
      </Shell>
    );
  }

  return (
    <Shell filter={filter} counts={counts}>
      <section>
        <h2 className="text-xs font-semibold tracking-wide text-faint uppercase">
          {REPORT_FILTER_LABELS[filter]} ({reports.length})
        </h2>

        {reports.length === 0 ? (
          <p className="mt-2 text-sm leading-relaxed text-muted">{emptyMessage(filter)}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {reports.map((report) => (
              <li key={report.id}>
                <ReportCard report={report} filter={filter} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --------------------------------------------------------------- Log */}
      <section>
        <h2 className="text-xs font-semibold tracking-wide text-faint uppercase">
          Administrator actions ({actions.length})
        </h2>
        <p className="mt-1.5 max-w-2xl text-body-15 leading-relaxed text-muted">
          Every action any administrator has taken — not only report decisions. It lives on this page
          because this is where the question of who did what, and when, comes up.
        </p>

        {actions.length === 0 ? (
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Nothing recorded yet. Approving an application, removing a review, resolving a report and
            changing a coach&rsquo;s standing each write one line here.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {actions.map((action) => (
              <li key={action.id} className="border border-line bg-surface px-3 py-2.5">
                <p className="flex flex-wrap items-baseline gap-x-2 text-body-15 text-ink">
                  <span className="font-mono text-mono-12 tracking-[0.1em] text-muted uppercase">
                    {ACTION_LABELS[action.action] ?? action.action}
                  </span>
                  <span className="text-muted">
                    {/*
                      `actor_name` is null when that administrator's account is
                      gone — ON DELETE SET NULL — and when the very first admin
                      was bootstrapped with no actor at all. Saying so beats
                      inventing one.
                    */}
                    {action.actor_name ?? 'a deleted account'}
                    <span aria-hidden="true"> · </span>
                    {formatDate(action.created_at)}
                  </span>
                </p>
                {action.reason ? (
                  <p className="mt-1 text-sm break-words whitespace-pre-line text-muted">
                    {action.reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function ReportCard({ report, filter }: { report: ReportWithContext; filter: ReportFilter }) {
  const open = report.status === 'open';
  const aboutReview = report.subject_type === 'review';

  return (
    <Card>
      <CardHeader
        title={aboutReview ? `Review by ${report.subject_name}` : `Coach: ${report.subject_name}`}
        description={`Reported by ${report.reporter_name} · ${formatDate(report.created_at)}${
          report.listing_title ? ` · ${report.listing_title}` : ''
        }`}
      />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Two chips, and the tones are the palette's two verdicts: Foul for a
            report still to answer for and one that was upheld, neutral once it
            is dismissed. The label always carries the meaning on its own — see
            `Badge`, which says why colour is never the only signal.
          */}
          <Badge tone={open ? 'warn' : report.status === 'upheld' ? 'danger' : 'neutral'}>
            {report.status}
          </Badge>
          <Badge wrap>{reasonLabel(report.subject_type, report.reason)}</Badge>
        </div>

        {/*
          The subject's own words, or a sentence saying they are gone. Rendered
          with `whitespace-pre-line` and never as HTML — this is the text being
          judged, so it has to appear exactly as it did on the page it came from.
        */}
        <blockquote className="border-l-2 border-rule pl-3 text-sm leading-relaxed break-words whitespace-pre-line text-ink">
          {report.subject_summary}
        </blockquote>

        {report.note ? (
          <p className="text-sm leading-relaxed break-words whitespace-pre-line text-muted">
            <span className="font-medium text-ink">What they said:</span> {report.note}
          </p>
        ) : (
          <p className="text-body-15 text-faint">No note was written.</p>
        )}

        {open ? (
          <>
            <p className="text-body-15 leading-relaxed text-muted">
              Upholding this records the decision. It does not{' '}
              {aboutReview ? 'remove the review' : 'suspend the coach'} — do that on{' '}
              <Link
                href={aboutReview ? '/admin/reviews' : '/admin/coaches'}
                className="font-medium text-brand underline underline-offset-2"
              >
                {aboutReview ? 'Reviews' : 'Coaches'}
              </Link>
              , where it asks you to confirm.
            </p>
            <ResolveReportForm
              reportId={report.id}
              subjectName={report.subject_name}
              filter={filter}
            />
          </>
        ) : (
          <p className="text-body-15 leading-relaxed text-muted">
            {report.status === 'upheld' ? 'Upheld' : 'Dismissed'} by{' '}
            {report.resolved_by_name ?? 'a deleted account'}
            {report.resolved_at ? ` on ${formatDate(report.resolved_at)}` : ''}.
            {report.resolution_note ? ` ${report.resolution_note}` : ''}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function Shell({
  filter,
  counts,
  children,
}: {
  filter: ReportFilter;
  counts: Counts;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-12">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Reports</h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
        Coaches report reviews of their own offers; anybody signed in can report a coach. Both land
        here. Deciding a report was right is recorded — acting on it is a separate, deliberate step.
      </p>

      <AdminNav current="reports" />

      <Alert tone="info" className="mt-6" title="Nobody is notified.">
        Nothing in this app sends email yet, so a decision is silent — the reporter never learns what
        you concluded, and the person reported never learns they were. If somebody needs to hear about
        it, that is a conversation to have outside the product.
      </Alert>

      <FilterTabs current={filter} counts={counts} />

      <div className="mt-8 flex flex-col gap-10">{children}</div>
    </div>
  );
}

/**
 * Links, not buttons — each tab is a distinct URL, so back/forward, bookmarking
 * and open-in-new-tab all behave. `min-h-11` keeps the tap target at the 44px
 * floor `Button` guarantees elsewhere. Same construction as the applications
 * queue, deliberately: two queues that look different are two things to learn.
 */
function FilterTabs({ current, counts }: { current: ReportFilter; counts: Counts }) {
  return (
    <nav aria-label="Filter reports by status" className="mt-6 flex flex-wrap gap-2">
      {REPORT_FILTERS.map((option) => {
        const active = option === current;
        return (
          <Link
            key={option}
            href={reportsPathFor(option)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 items-center gap-2 border px-3.5 text-sm font-medium transition-colors',
              active
                ? 'border-transparent bg-brand-soft text-brand-soft-ink'
                : 'border-line-strong bg-surface text-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            {REPORT_FILTER_LABELS[option]}
            <span className={cn('text-xs font-semibold', active ? 'opacity-80' : 'text-faint')}>
              {counts[option]}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------

interface Counts {
  open: number;
  upheld: number;
  dismissed: number;
  all: number;
}

function countBy(reports: readonly ReportWithContext[]): Counts {
  return {
    open: reports.filter((r) => r.status === 'open').length,
    upheld: reports.filter((r) => r.status === 'upheld').length,
    dismissed: reports.filter((r) => r.status === 'dismissed').length,
    all: reports.length,
  };
}

/** Zeroes for the error shell, where the counts are unknown rather than nil. */
function emptyCounts(): Counts {
  return { open: 0, upheld: 0, dismissed: 0, all: 0 };
}

/**
 * The audit table stores `admin_action_kind` values, which are written for a
 * schema rather than for a reader. Keyed by `string` rather than the enum on
 * purpose: a row written by a migration this build does not know about should
 * render its raw value, not crash the queue.
 */
const ACTION_LABELS: Record<string, string> = {
  grant_admin: 'Admin granted',
  review_application: 'Application',
  remove_review: 'Review removed',
  resolve_report: 'Report resolved',
  set_coach_status: 'Standing changed',
};

/**
 * The reason, in words.
 *
 * The two label maps are `Partial` because the same enum member means different
 * things about a review and about a coach, and neither list covers the whole
 * enum. A value outside the map is not impossible — the database accepts any
 * member for either subject — so this falls back to the raw value with its
 * underscores opened up rather than rendering an empty chip.
 */
function reasonLabel(subject: ReportSubject, reason: ReportReason): string {
  const labels = subject === 'review' ? REVIEW_REPORT_LABELS : COACH_REPORT_LABELS;
  return labels[reason] ?? reason.replace(/_/g, ' ');
}

function emptyMessage(filter: ReportFilter): string {
  switch (filter) {
    case 'open':
      return 'Nothing to decide. Reports appear here the moment somebody files one.';
    case 'upheld':
      return 'No report has been upheld yet.';
    case 'dismissed':
      return 'No report has been dismissed yet.';
    case 'all':
      return 'Nobody has reported anything. Coaches can report reviews of their own offers, and anybody signed in can report a coach.';
  }
}
