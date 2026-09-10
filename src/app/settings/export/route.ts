import { redirect } from 'next/navigation';

import { getActor } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { MAX_PAGE_SIZE, type Page, type PageRequest } from '@/lib/data/pagination';
import { consume } from '@/lib/rate-limit';
import { LEGAL_LAST_UPDATED } from '@/lib/legal';

/**
 * =============================================================================
 * "Download your data" — UK GDPR Article 20, and the honest version of it.
 * =============================================================================
 *
 * Deletion was built and portability was not, which is the more common half of
 * that pair to skip and the one a user is more likely to ask for first. Until
 * this route existed the only answer to "send me my data" was an administrator
 * running queries by hand — a manual process with a statutory deadline attached
 * to it.
 *
 * -----------------------------------------------------------------------------
 * A ROUTE HANDLER, NOT A SERVER ACTION
 * -----------------------------------------------------------------------------
 * A Server Action returns a value to a React tree; it cannot set
 * `Content-Disposition` and hand the browser a file. This is a `GET` that
 * answers with the attachment directly, which also makes it something a person
 * can bookmark, curl, or hand to a subject-access request.
 *
 * -----------------------------------------------------------------------------
 * IT GOES THROUGH THE DATA LAYER, WITH THE USER'S OWN ACTOR
 * -----------------------------------------------------------------------------
 * Every read below is a self-scoped method that already exists, called with the
 * requester's actor — so on Supabase the same RLS policies that guard the pages
 * guard the export, and there is no privileged client anywhere near it. That is
 * the property that makes this safe to have at all: an export endpoint built on
 * a service-role key is one query-parameter bug away from being an export of
 * somebody else's account.
 *
 * WHAT IS DELIBERATELY NOT IN IT:
 *
 *   * **Other people's writing.** Reviews OF a coach are the reviewer's words,
 *     not the coach's data, and they are already public. A coach exporting
 *     "their" data does not get to take away what was said about them.
 *   * **The files themselves.** Deliverables and the avatar are named by path
 *     and not embedded: bytes belong in a download of their own, and a
 *     base64'd video inside a JSON document is a denial of service against the
 *     person who asked for it.
 *   * **`asset_path` and anything else the column grants withhold.** Nothing
 *     here reaches past the shapes the data layer already returns.
 */

export const dynamic = 'force-dynamic';

/**
 * Walks every page of a self-scoped read.
 *
 * Bounded twice over: `MAX_PAGE_SIZE` per request, and a hard page ceiling so a
 * pathological account cannot turn one HTTP request into an unbounded loop.
 * Truncation is REPORTED in the payload rather than passed off as completeness
 * — an export that silently stops is worse than one that says where it stopped.
 */
const MAX_PAGES = 40;

async function collect<T>(
  fetchPage: (page: PageRequest) => Promise<Page<T>>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | null = null;

  for (let visited = 0; visited < MAX_PAGES; visited += 1) {
    const page: Page<T> = await fetchPage({ cursor, limit: MAX_PAGE_SIZE });
    items.push(...page.items);
    if (!page.nextCursor) return { items, truncated: false };
    cursor = page.nextCursor;
  }

  return { items, truncated: true };
}

export async function GET() {
  const actor = await getActor();
  // Not a 401: this is reached by clicking a link on a page, so the useful
  // answer is the sign-in form and a way back, exactly as the pages do it.
  if (!actor) redirect('/login?next=/settings');

  if (!(await consume('exportUser', actor.userId))) {
    return new Response(
      'You have asked for an export several times in the last hour. Please try again later.\n',
      { status: 429, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }

  const db = getDataClient();

  /*
   * `getProfile` with the requester's own id: the one read here that returns an
   * email address, and it returns it because the person asking is its subject.
   */
  const profile = await db.getProfile(actor, actor.userId);
  if (!profile) redirect('/login?next=/settings');

  const [orders, reviews, reports, listings, application] = await Promise.all([
    collect((page) => db.listMyOrders(actor, page)),
    collect((page) => db.listMyReviews(actor, page)),
    collect((page) => db.listMyReports(actor, page)),
    collect((page) => db.listMyListings(actor, page)),
    db.getMyCoachApplication(actor),
  ]);

  const truncated = [
    orders.truncated ? 'orders' : null,
    reviews.truncated ? 'reviews' : null,
    reports.truncated ? 'reports' : null,
    listings.truncated ? 'offers' : null,
  ].filter((name): name is string => name !== null);

  const payload = {
    /*
     * A header that says what this file is, so that a copy of it found in a
     * downloads folder in two years is still self-describing. `format` is a
     * number this route owns: if the shape ever changes, something reading an
     * old export can tell.
     */
    export: {
      format: 1,
      generated_at: new Date().toISOString(),
      service: 'JavelinHub',
      subject_user_id: actor.userId,
      documents_version: LEGAL_LAST_UPDATED,
      contains:
        'Your account, the offers you have published, the offers you have claimed, the reviews you have written, and the reports you have filed.',
      excludes:
        'Reviews other people wrote about you, which are their words and are already public; and the files themselves, which are named by path here and downloaded from the pages that hold them.',
      ...(truncated.length === 0
        ? {}
        : {
            truncated,
            truncated_note: `Some lists were longer than this export walks (${MAX_PAGES} pages). Ask us for the rest.`,
          }),
    },
    account: profile,
    coach_application: application,
    offers_published: listings.items,
    offers_claimed: orders.items,
    reviews_written: reviews.items,
    reports_filed: reports.items,
  };

  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The filename is fixed text plus a date. Nothing user-supplied goes into
      // a header — a name with a quote or a newline in it is header injection.
      'content-disposition': `attachment; filename="javelinhub-export-${stamp}.json"`,
      // Personal data. It must not sit in a shared cache, and `no-store` is the
      // only directive that says so without qualification.
      'cache-control': 'no-store, private',
    },
  });
}
