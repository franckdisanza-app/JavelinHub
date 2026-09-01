import { Card, CardBody } from '@/components/ui/card';
import type { PublicReviewReply } from '@/lib/data/types';
import { formatDate } from '@/lib/format';

/**
 * A coach's answer, rendered under the review it answers.
 *
 * -----------------------------------------------------------------------------
 * IT IS INDENTED AND IT IS QUIETER, AND BOTH CARRY MEANING
 * -----------------------------------------------------------------------------
 * The review is the primary text on this part of the page — it is what a
 * stranger came to read, and it is written by somebody with no stake in the
 * sale. The reply is a response to it, published by the person being reviewed.
 * A reply set at the same weight, on the same ground, in the same box would
 * read as a second opinion of equal standing, which it is not.
 *
 * So: a Chalk panel rather than a raised White one, inset from the left on
 * anything wider than a phone, and led by a label that names the relationship
 * (&ldquo;Reply from the coach&rdquo;) before the words start. At 375px the
 * indent is dropped rather than shrunk — 16px of inset on a 343px card is a
 * ragged edge, not a hierarchy.
 *
 * NO RATING, NO BADGE, NO CONTROLS. A reply is not a review: it has no score,
 * it is not a verified purchase, and it does not feed `offer_stats`,
 * `coach_stats` or any rating. Rendering any of that furniture would make it
 * look like one.
 *
 * -----------------------------------------------------------------------------
 * WHY THERE IS NO EDIT OR DELETE CONTROL, EVEN FOR ITS AUTHOR
 * -----------------------------------------------------------------------------
 * `0032` grants no UPDATE policy on `review_replies` to any role, and no DELETE
 * to any client role — removal is an administrator's, through
 * `remove_review_reply()`. That is the same rule `reviews` has followed since
 * `0016`, applied to the answer as well as to the question: a reply is
 * published under a coach's name beside a named person's words, and somebody
 * who read it should be reading what is still there.
 *
 * So this component renders no affordance, because there is no operation behind
 * one. The date is what lets a reader place it relative to the review above.
 */
export function ReviewReply({ reply }: { reply: PublicReviewReply }) {
  return (
    <Card className="sm:ml-8">
      <CardBody className="flex flex-col gap-2 py-4">
        <p className="font-mono text-mono-10 tracking-[0.14em] uppercase text-muted">Reply from the coach</p>

        <p className="text-sm break-words whitespace-pre-line text-ink">{reply.body}</p>

        <p className="text-sm break-words text-muted">
          <span className="font-medium text-ink">{reply.coach_name}</span>
          <span aria-hidden="true"> · </span>
          <span>{formatDate(reply.created_at)}</span>
        </p>
      </CardBody>
    </Card>
  );
}
