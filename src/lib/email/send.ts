/**
 * =============================================================================
 * Transactional email — the seam, and a provider that is not wired up yet.
 * =============================================================================
 *
 * `docs/ROADMAP.md` §4 states the gap this closes the shape of:
 *
 *   > **Still no transactional email of our own.** … Nothing sends a receipt,
 *   > "you have a new order", or "your review is ready".
 *
 * and it is careful to separate two jobs that get confused:
 *
 *   1. **GoTrue's own mail** — password reset, signup confirmation, email
 *      change. That rides on Supabase's built-in SMTP, which is rate limited to
 *      a handful of messages an hour project-wide. Moving it to Resend is
 *      **configuration in the Supabase dashboard and no code at all.** Nothing
 *      in this file touches it, and nothing should.
 *   2. **The app's own mail** — everything below. That needs a provider
 *      integration, templates and call sites, and this is it.
 *
 * -----------------------------------------------------------------------------
 * IT DOES NOT SEND ANYTHING YET, AND SAYS SO LOUDLY
 * -----------------------------------------------------------------------------
 * `RESEND_API_KEY` is unset, so {@link sendEmail} logs the message it would
 * have sent and returns `skipped`. That is deliberate rather than unfinished:
 *
 *   * every call site can be written, reviewed and merged now, against a real
 *     signature, without an account existing;
 *   * a developer running the app locally never sends mail to a real person by
 *     accident, which is the classic way a staging environment emails a
 *     customer;
 *   * turning it on is one environment variable, and the failure mode until
 *     then is a log line rather than a crash.
 *
 * **The HTTP call itself is deliberately NOT written.** Resend's API is one
 * `POST https://api.resend.com/emails` with a JSON body, and guessing at the
 * exact field names and error shape from memory is how you ship an integration
 * that fails silently on the first real send. The single place it goes is
 * marked below. Everything around it — the guard, the address policy, the
 * result type, the logging, the templates — is real.
 *
 * -----------------------------------------------------------------------------
 * WHY IT NEVER THROWS
 * -----------------------------------------------------------------------------
 * Same posture as `rate-limit.ts` and `observability.ts`: a notification is not
 * the transaction. If mail fails, the order was still placed and the file was
 * still delivered, and failing the Server Action would tell the user their
 * purchase did not happen. So this returns a result, and callers are expected
 * to ignore it or log it — never to branch a user-visible outcome on it.
 *
 * SERVER ONLY.
 */

import { emailConfig, isProduction, siteUrl } from '@/lib/env';

if (typeof window !== 'undefined') {
  throw new Error(
    'The email layer is server-only and was imported into browser code. ' +
      'Call it from a server action, route handler or background job instead.',
  );
}

export interface EmailMessage {
  /** A single recipient. See {@link sendEmail} on why there is no bcc list. */
  to: string;
  subject: string;
  /**
   * The plain-text body. **Required**, and not optional beside an HTML one.
   *
   * A transactional message that exists only as HTML is unreadable in a client
   * that strips it, scores worse with spam filters, and cannot be diffed in a
   * review. HTML is the optional half here, which is the opposite of how most
   * mail code is written and the right way round.
   */
  text: string;
  /** Optional HTML alternative. When absent the message is text-only, which is fine. */
  html?: string;
  /** Overrides the default reply-to. Used for nothing yet. */
  replyTo?: string;
}

export type EmailResult =
  /** Handed to the provider, which accepted it. */
  | { status: 'sent'; id: string | null }
  /** No provider configured. The message was logged and discarded. */
  | { status: 'skipped'; reason: string }
  /** The provider was configured and refused, or the request failed. */
  | { status: 'failed'; reason: string };

/**
 * Sends one message to one person.
 *
 * ONE RECIPIENT, ALWAYS, and there is no `cc` or `bcc` in the type. Every mail
 * this product sends is about one person's order, one person's offer or one
 * person's account, and a multi-recipient signature is how the wrong buyer ends
 * up on a thread about somebody else's video. If a broadcast is ever needed it
 * is a different function with a different name and its own review.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const config = emailConfig();

  if (config.apiKey === null) {
    /*
     * The local and CI path. `subject` and `to` are logged and the BODY IS NOT:
     * a delivery notification names an offer somebody bought, which is the same
     * class of fact `observability.ts` refuses to put in a log line.
     *
     * Silenced in production, where this branch means a misconfiguration rather
     * than a developer running without an account — and where a log line per
     * unsent mail would be noise on top of a problem the operator already has.
     */
    if (!isProduction()) {
      console.log(`[email:skipped] to=${message.to} subject=${JSON.stringify(message.subject)}`);
    }
    return { status: 'skipped', reason: 'RESEND_API_KEY is not set' };
  }

  try {
    // -----------------------------------------------------------------------
    // GAP — the only unwritten line in this module.
    // -----------------------------------------------------------------------
    // Resend is one POST to https://api.resend.com/emails with a bearer token
    // and a JSON body of { from, to, subject, text, html, reply_to }. It is not
    // written here because the exact response and error shape should be read
    // from Resend's current documentation rather than recalled, and an
    // integration that is subtly wrong fails by silently not sending.
    //
    // When writing it:
    //   * `config.from` is already validated to be a real address below;
    //   * return `{ status: 'sent', id }` with Resend's message id, which is
    //     what makes a support question answerable;
    //   * return `{ status: 'failed', reason }` for a non-2xx, and DO NOT
    //     THROW — see the header;
    //   * do not add the `resend` SDK for one endpoint. `fetch` is enough and
    //     is one fewer dependency to keep current.
    //   * verify the sending domain in Resend first, or every message lands in
    //     spam and the failure looks like this code.
    // -----------------------------------------------------------------------
    return {
      status: 'failed',
      reason:
        'RESEND_API_KEY is set but the provider call is not implemented. See the GAP note in src/lib/email/send.ts.',
    };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * An absolute link into the app, for use in a message body.
 *
 * Built from `siteUrl()` and never from a request, for exactly the reason that
 * function's own header gives at length: a `Host` header is attacker-controlled,
 * and a link we email is a link somebody trusts because we sent it.
 */
export function emailLink(path: string): string {
  return `${siteUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}
