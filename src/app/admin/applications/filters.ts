/**
 * The `?status=` vocabulary for the review queue.
 *
 * A plain module, not a `'use server'` one: a file carrying that directive may
 * export nothing but async functions, so the constants and the parser both the
 * page and the action need have to live outside `actions.ts`. Same reason
 * `@/lib/forms` is separate from the actions that use it.
 */

import type { ApplicationStatus } from '@/lib/data/types';

export const APPLICATION_FILTERS = ['pending', 'approved', 'rejected', 'all'] as const;
export type ApplicationFilter = (typeof APPLICATION_FILTERS)[number];

/** `pending` is the working queue, so it is what an admin gets by default. */
export const DEFAULT_FILTER: ApplicationFilter = 'pending';

/** Anything unrecognised — a typo, a hand-edited URL — falls back to the queue. */
export function parseFilter(value: unknown): ApplicationFilter {
  return APPLICATION_FILTERS.includes(value as ApplicationFilter) ? (value as ApplicationFilter) : DEFAULT_FILTER;
}

/** `undefined` means "no filter" to `listCoachApplications`. */
export function toStatusFilter(filter: ApplicationFilter): ApplicationStatus | undefined {
  return filter === 'all' ? undefined : filter;
}

export const FILTER_LABELS: Record<ApplicationFilter, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  all: 'All',
};
