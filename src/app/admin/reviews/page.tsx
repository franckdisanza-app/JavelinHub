import type { Metadata } from 'next';
import Link from 'next/link';

import { RemoveReviewForm } from '@/app/admin/reviews/remove-review-form';
import { AdminNav } from '@/components/admin-nav';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getActor, getCurrentProfile, requireAdmin } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import { DataErrorNotice, resolveDataError } from '@/lib/data-error';
import type { ModeratableReview, RemovedReviewWithNames } from '@/lib/data/types';
import { formatDate } from '@/lib/format';

/**
 * The same reasoning as `/admin/invites`: `generateMetadata` runs independently
 * of the page body, so a static `metadata` export would put "Reviews" in the tab
 * title on the 404 a non-admin gets — confirming the page exists to exactly the
 * person `requireAdmin()` declined to confirm it to.
 */
export async function generateMetadata(): Promise<Metadata> {
  const profile = await getCurrentProfile();
  return { title: profile?.role === 'admin' ? 'Reviews' : 'Not found' };
}

/**
 * Review moderation.
 *
 * The one place a published review can be taken down. `docs/DATA-LAYER.md`
 * records that authors have no edit or delete path of their own — deliberately,
 * because an editable review could have its `order_id` rewritten — so this page
 * is the other half of that decision. Without it, the only remedy was the SQL
 * editor.
 *
 * WHAT IT DELIBERATELY DOES NOT OFFER: an edit control. A review is an opinion
 * published under a named person's identity, and an administrator who could
 * rewrite one would be fabricating an opinion and attributing it to a real
 * reader. `0002_rls.sql` makes the same argument about a coach's listing copy;
 * `0016` drops the `reviews_update_admin` policy that would have allowed it.
 */
export default async function AdminReviewsPage() {
  // Anonymous -> /login?next=/admin/reviews. Signed in but not an admin -> 404,
  // so the page's existence is not confirmed to someone poking at URLs. Both
  // reads below would refuse them regardless.
  await requireAdmin('/admin/reviews');

  const actor = await getActor();
  const db = getDataClient();

  let reviews: ModeratableReview[];
  let removed: RemovedReviewWithNames[];
  try {
    // Sequential rather than `Promise.all`: if the queue read fails there is
    // nothing to moderate, and running the log read anyway would only produce a
    // second error to swallow.
    reviews = await db.listReviewsForModeration(actor);
    removed = await db.listRemovedReviews(actor);
  } catch (error) {
    return (
      <Shell>
        <DataErrorNotice error={resolveDataError(error, { nextPath: '/admin/reviews' })} />
      </Shell>
    );
  }

  return (
    <Shell>
      <section>
        <h2 className="text-xs font-semibold tracking-wide text-faint uppercase">
          Published ({reviews.length})
        </h2>

        {reviews.length === 0 ? (
          <p className="mt-2 text-sm leading-relaxed text-muted">
            No reviews yet. They appear here the moment a buyer writes one — every review on the site,
            not only the reported ones, because a review can be wrong without anybody having said so.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {reviews.map((review) => (
              <li key={review.id}>
                <Card>
                  <CardHeader
                    title={`${review.rating} out of 5 · ${review.listing_title}`}
                    description={`${review.author_name} · ${formatDate(review.created_at)}`}
                  />
                  <CardBody className="flex flex-col gap-4">
                    {/*
                      `whitespace-pre-line` keeps the author's paragraph breaks
                      without rendering their text as HTML — the same treatment
                      an offer description gets, and it matters more here: this
                      is the text a moderator is judging, so it must be shown
                      exactly as a visitor sees it.
                    */}
                    <p className="text-sm leading-relaxed break-words whitespace-pre-line text-ink">
                      {review.body}
                    </p>
                    <RemoveReviewForm reviewId={review.id} authorName={review.author_name} />
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------- Log */}
      <section>
        <h2 className="text-xs font-semibold tracking-wide text-faint uppercase">
          Removed ({removed.length})
        </h2>

        {removed.length === 0 ? (
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Nothing has been removed. Anything taken down is copied here first, with who did it and why.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {removed.map((row) => (
              <li key={row.id}>
                <Card>
                  <CardHeader
                    title={`${row.rating} out of 5 · ${row.listing_title}`}
                    description={
                      // `removed_by_name` is null when that administrator's
                      // account is gone — ON DELETE SET NULL — and saying so is
                      // more useful than inventing an actor.
                      `${row.author_name} · written ${formatDate(row.review_created_at)} · removed ${formatDate(
                        row.removed_at,
                      )} by ${row.removed_by_name ?? 'a deleted account'}`
                    }
                  />
                  <CardBody className="flex flex-col gap-3">
                    <p className="text-sm leading-relaxed break-words whitespace-pre-line text-muted">
                      {row.body}
                    </p>
                    <p className="text-body-15 text-faint">
                      {row.reason ? (
                        <>
                          <span className="font-medium text-muted">Reason:</span> {row.reason}
                        </>
                      ) : (
                        'No reason recorded.'
                      )}
                    </p>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-12">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Reviews</h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
        Every review on the site. Removing one deletes it — from the offer&rsquo;s rating, the coach&rsquo;s
        rating and every page — and keeps a copy in the log below. There is no way to edit a review, on
        purpose: it is somebody&rsquo;s opinion published under their name.
      </p>

      <AdminNav current="reviews" />

      <Alert tone="info" className="mt-6" title="The author is not notified.">
        Nothing in this app sends email yet, so a removal is silent. If somebody needs to hear about it,
        that is a conversation to have outside the product. A review somebody has{' '}
        <Link href="/admin/reports" className="font-medium text-brand underline underline-offset-2">
          reported
        </Link>{' '}
        is removed here, in a second deliberate step — upholding a report does not delete anything.
      </Alert>

      <div className="mt-8 flex flex-col gap-10">{children}</div>
    </div>
  );
}
