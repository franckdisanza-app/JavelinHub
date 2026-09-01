/**
 * =============================================================================
 * The three messages this product actually needs to send.
 * =============================================================================
 *
 * `docs/ROADMAP.md` §4 names the gap: *"Nothing sends a receipt, 'you have a
 * new order', or 'your review is ready'."* These are the first two, plus the
 * one that closes the loop in the other direction.
 *
 *   `notifyCoachOfOrder`     a coach learns somebody claimed their offer. Until
 *                            now the only way to find out was to open
 *                            `/coach/sales` and look, which is a dashboard
 *                            rather than a marketplace.
 *   `notifyBuyerOfDelivery`  a buyer learns their coach has sent something back.
 *                            Personalised delivery is asynchronous by nature —
 *                            the buyer has no reason to be on the site at the
 *                            moment it happens.
 *   `notifyBuyerOfOrder`     the buyer's own record of what they claimed. It is
 *                            deliberately NOT called a receipt: nothing has been
 *                            charged, and the message says so.
 *
 * -----------------------------------------------------------------------------
 * WHY THE TEXT LIVES HERE AND NOT AT THE CALL SITE
 * -----------------------------------------------------------------------------
 * These are the only strings this product sends to somebody's inbox rather than
 * to a screen they are already looking at, and a message you cannot take back
 * deserves to be reviewable in one place. Keeping them together also makes the
 * standing rules visible as rules rather than as coincidence:
 *
 *   * **No personal data about the other party.** A coach is told an offer was
 *     claimed; they are not told who by. `OrderWithListing` deliberately carries
 *     no buyer name for the same reason, and an email is a far worse place to
 *     leak one than a page behind a session.
 *   * **No file names and no content.** "A file is ready" and not "Rina sent
 *     block-technique-final.mp4" — a mail subject line is visible on a lock
 *     screen.
 *   * **Every link is absolute and built from configuration**, through
 *     {@link emailLink}, never from a request header.
 *   * **A link is an invitation to sign in, never a credential.** Nothing here
 *     carries a token. The one email in this product that does is the password
 *     reset, and GoTrue owns that end to end.
 *
 * -----------------------------------------------------------------------------
 * ONLY ONE OF THE THREE CAN BE SENT FROM A REQUEST, AND THAT IS NOT A BUG
 * -----------------------------------------------------------------------------
 * This was discovered by trying to wire them, and it is the most useful thing
 * in this file. **Neither party to an order can read the other's email
 * address.** `profiles` carries email, so it is readable only by its owner and
 * by an administrator — `profiles_select_self` and `profiles_select_admin` in
 * `0002_rls.sql`, mirrored by `getProfile()` in the mock, which throws
 * `forbidden` for anybody else. That is correct and deliberate: `getProfile`'s
 * own comment records that an earlier revision mirrored a `using (true)` policy
 * and handed every user's email to anonymous callers.
 *
 * So:
 *
 *   `notifyBuyerOfOrder`     WIRED. The actor claiming the offer IS the
 *                            recipient, so reading their own address is a
 *                            self-read and needs no privilege at all.
 *   `notifyCoachOfOrder`     NOT WIRED. Sending it from `claimOfferAction`
 *                            would require the buyer's session to read the
 *                            coach's address.
 *   `notifyBuyerOfDelivery`  NOT WIRED. Same constraint in the other direction:
 *                            the coach's session cannot read the buyer's.
 *
 * **The fix is an outbox, not a privileged client.** Building a service-role
 * client to read the address would defeat the whole RLS model for the
 * convenience of a notification — `README.md` is explicit that the key is
 * `BYPASSRLS` and that never constructing a client from it is what keeps the
 * danger out of the data path. What is wanted instead is a `notifications`
 * table that the action writes a row into (naming a USER ID, not an address),
 * drained by something that legitimately holds privilege. Two open questions
 * before that can be built, and both are the operator's rather than mine:
 * where the drain runs (pg_cron, a Supabase Edge Function, a Vercel cron
 * route), and whether a coach may opt out of it.
 *
 * The two unwired functions stay here, written and reviewable, because they are
 * the part the outbox will call and they are not the part that is undecided.
 *
 * -----------------------------------------------------------------------------
 * NONE OF THEM SEND YET
 * -----------------------------------------------------------------------------
 * `sendEmail()` logs and skips while `RESEND_API_KEY` is unset — see its header.
 * The last hop is one environment variable and the marked GAP in `send.ts`.
 */

import { emailLink, sendEmail, type EmailResult } from '@/lib/email/send';

/**
 * Fire-and-forget wrapper.
 *
 * A notification is not the transaction. The order was placed and the file was
 * delivered whatever this returns, so a caller must never fail its own action
 * on the result — see `send.ts`. This exists so a call site reads as one line
 * and cannot accidentally `await` its way into coupling the two.
 */
async function notify(result: Promise<EmailResult>): Promise<void> {
  try {
    await result;
  } catch {
    // `sendEmail` does not throw. This is belt and braces for the day somebody
    // adds something above it that does.
  }
}

/** Somebody claimed a coach's offer. Names the offer, never the buyer. */
export async function notifyCoachOfOrder(input: {
  coachEmail: string;
  offerTitle: string;
  orderId: string;
}): Promise<void> {
  const link = emailLink(`/orders/${input.orderId}`);

  await notify(
    sendEmail({
      to: input.coachEmail,
      subject: `New order: ${input.offerTitle}`,
      text: [
        `Someone has claimed "${input.offerTitle}".`,
        '',
        // The two delivery modes need different actions and this message does
        // not know which one this offer is. Rather than send a mode-specific
        // instruction that is wrong half the time, it sends them to the order,
        // which states it plainly and is where the work happens either way.
        'Open the order to see what to do next:',
        link,
        '',
        'If the offer is an instant download, nothing is needed from you — the buyer already has the file.',
        '',
        '— JavelinHub',
      ].join('\n'),
    }),
  );
}

/** A coach has uploaded something against an order. Names no file. */
export async function notifyBuyerOfDelivery(input: {
  buyerEmail: string;
  offerTitle: string;
  orderId: string;
}): Promise<void> {
  const link = emailLink(`/orders/${input.orderId}`);

  await notify(
    sendEmail({
      to: input.buyerEmail,
      subject: `Your coach has sent something: ${input.offerTitle}`,
      text: [
        `Your coach has delivered against your order for "${input.offerTitle}".`,
        '',
        'Open the order to download it:',
        link,
        '',
        // Download links on the order page are signed and expire in minutes, so
        // the email cannot carry one — and saying so pre-empts "the link in the
        // email stopped working", which would otherwise be the support question.
        'Download links are generated when you open the page and expire after a few minutes, so open the order rather than saving a link.',
        '',
        'Once you have had a look, you can leave a review from the same page.',
        '',
        '— JavelinHub',
      ].join('\n'),
    }),
  );
}

/**
 * The buyer's own copy of what they claimed.
 *
 * **NOT A RECEIPT, and the wording is careful about it.** Nothing has been
 * charged — `claim_offer()` creates the order and no money moves — so calling
 * this a receipt would be a false statement about a payment in writing. When
 * payment lands this becomes the receipt and gains an amount, a payment
 * reference and a link to the refund policy.
 */
export async function notifyBuyerOfOrder(input: {
  buyerEmail: string;
  offerTitle: string;
  orderId: string;
  /** Rendered, e.g. "£45.00" — formatted by the caller, not here. */
  price: string;
}): Promise<void> {
  const link = emailLink(`/orders/${input.orderId}`);

  await notify(
    sendEmail({
      to: input.buyerEmail,
      subject: `You claimed: ${input.offerTitle}`,
      text: [
        `You have claimed "${input.offerTitle}".`,
        '',
        `Listed price: ${input.price}. Nothing has been charged — JavelinHub is in pilot and claiming is free.`,
        '',
        'Your order:',
        link,
        '',
        '— JavelinHub',
      ].join('\n'),
    }),
  );
}
