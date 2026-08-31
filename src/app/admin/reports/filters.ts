/**
 * The `?status=` vocabulary for the report queue.
 *
 * A plain module, not a `'use server'` one, for the same reason
 * `admin/applications/filters.ts` is: a file carrying that directive may export
 * nothing but async functions, and both the page and the action need these.
 */

import type { ReportStatus } from '@/lib/data/types';

export const REPORT_FILTERS = ['open', 'upheld', 'dismissed', 'all'] as const;
export type ReportFilter = (typeof REPORT_FILTERS)[number];

/** `open` is the working queue, so it is what an admin gets by default. */
export const DEFAULT_REPORT_FILTER: ReportFilter = 'open';

export const ADMIN_REPORTS_PATH = '/admin/reports';

/** Anything unrecognised — a typo, a hand-edited URL — falls back to the queue. */
export function parseReportFilter(value: unknown): ReportFilter {
  return REPORT_FILTERS.includes(value as ReportFilter) ? (value as ReportFilter) : DEFAULT_REPORT_FILTER;
}

/** `undefined` means "no filter" to `listReports`. */
export function toReportStatus(filter: ReportFilter): ReportStatus | undefined {
  return filter === 'all' ? undefined : filter;
}

export const REPORT_FILTER_LABELS: Record<ReportFilter, string> = {
  open: 'Open',
  upheld: 'Upheld',
  dismissed: 'Dismissed',
  all: 'All',
};

/** The path a decision returns to, so resolving does not throw the admin back to the default tab. */
export function reportsPathFor(filter: ReportFilter): string {
  return filter === DEFAULT_REPORT_FILTER ? ADMIN_REPORTS_PATH : `${ADMIN_REPORTS_PATH}?status=${filter}`;
}
