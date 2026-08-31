'use server';

import { revalidatePath } from 'next/cache';

import { parseReportFilter, reportsPathFor } from '@/app/admin/reports/filters';
import { getActor } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { isDataError } from '@/lib/data/types';
import { formError, toFormState, type FormState } from '@/lib/forms';

/**
 * Upholds or dismisses one report.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: the consequence. Upholding a review
 * report does not remove the review, and upholding a coach report does not
 * suspend the coach — those are `/admin/reviews` and `/admin/coaches`, each
 * with its own confirmation. "This report was right" and "here is what I am
 * doing about it" are two decisions, and a single button that made both would
 * make the second one invisible.
 *
 * `resolve_report()` in Postgres re-checks `is_admin()` and re-checks that the
 * report is still open, so two administrators clicking at once cannot both
 * resolve it. A Server Action is a public HTTP endpoint; the page's
 * `requireAdmin()` is a courtesy 404, not the boundary.
 */
export async function resolveReportAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get('reportId') ?? '').trim();
  if (id === '') return formError('That report could not be found.');

  const decision = String(formData.get('decision') ?? '');
  if (decision !== 'upheld' && decision !== 'dismissed') {
    return formError('A report is resolved as upheld or dismissed.');
  }

  const rawNote = String(formData.get('note') ?? '').trim();
  if (rawNote.length > 2000) {
    return formError(`Keep the note to 2000 characters or fewer — ${rawNote.length} so far.`, { note: rawNote });
  }
  // Trimmed to null: the column is nullable and "no note" is a different fact
  // from "the note is blank".
  const note = rawNote === '' ? null : rawNote;

  try {
    await getDataClient().resolveReport(await getActor(), id, decision, note);
  } catch (error) {
    if (!isDataError(error)) throw error;
    return toFormState(error, { values: { note: rawNote } });
  }

  // The row leaves the open tab and appears in the resolved one, and the audit
  // log at the bottom of the page gained an entry. Only this page changed:
  // nothing a visitor sees depends on a report's status.
  revalidatePath(reportsPathFor(parseReportFilter(formData.get('status'))));

  return { status: 'success' };
}
