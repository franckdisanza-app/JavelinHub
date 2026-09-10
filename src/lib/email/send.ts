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
 * IT SENDS NOTHING UNTIL IT IS CONFIGURED, AND SAYS SO LOUDLY
 * -----------------------------------------------------------------------------
 * With `RESEND_API_KEY` unset, {@link sendEmail} logs the message it would have
 * sent and returns `skipped`. That is the supported local and CI state rather
 * than an unfinished one:
 *
 *   * every call site can be written, reviewed and merged without an account
 *     existing;
 *   * a developer running the app locally never sends mail to a real person by
 *     accident, which is the classic way a staging environment emails a
 *     customer;
 *   * turning it on is one environment variable, and the failure mode until
 *     then is a log line rather than a crash.
 *
 * **The provider call is now written.** It was deliberately left out while the
 * field names were a recollection rather than a reading — an integration that is
 * subtly wrong fails by silently not sending. They have since been read from
 * Resend's current API reference, and the two that bite are recorded at the call
 * site: `reply_to` is snake_case in the REST API (the Node SDK spells it
 * `replyTo`, and an unknown field is ignored rather than rejected), and the
 * documented success body is `{ id }`.
 *
 * TWO THINGS STILL HAVE TO HAPPEN OUTSIDE THIS FILE before a real message
 * arrives anywhere, and neither is code:
 *
 *   1. the sending domain has to be verified in Resend, or every message is
 *      rejected or filed as spam and the failure looks like this module;
 *   2. `EMAIL_FROM` has to name a sender on that domain. `assertRuntimeConfig()`
 *      refuses to start a production server that has a key set beside the
 *      `.invalid` placeholder, which is the one arrangement that looks
 *      configured and cannot deliver.
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
    /*
     * One POST, no SDK — the `resend` package wraps this single endpoint and
     * would be one more dependency to keep current.
     *
     * The field names are Resend's REST names, which are NOT the SDK's:
     * `reply_to` is snake_case here and `replyTo` in the Node client. Reading
     * the wrong one is silent — an unknown field is ignored, so a mistyped
     * `replyTo` sends the message with no reply address and reports success.
     *
     * `to` is sent as a one-element ARRAY even though the API accepts a bare
     * string, because the array form is the one that cannot be misread as a
     * comma-separated list if an address ever contains one.
     */
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
      }),
      /*
       * A notification is not the transaction, and this call sits inside a
       * Server Action that has already written to the database. Without a
       * deadline a provider that accepts the connection and never answers holds
       * the user's request open until the platform's own timeout kills it —
       * turning "the receipt did not send" into "the purchase appears to have
       * failed". Ten seconds is far longer than a healthy send and far shorter
       * than any request budget.
       */
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { status: 'failed', reason: await describeFailure(response) };
    }

    /*
     * Documented success shape is `{ "id": "<uuid>" }`. Read it defensively
     * anyway: the id is for answering a support question later, and a message
     * that was accepted but whose id could not be parsed has still been sent —
     * reporting that as a failure would be a lie in the more alarming direction.
     */
    const id = await readMessageId(response);
    return { status: 'sent', id };
  } catch (error) {
    /*
     * `AbortSignal.timeout` rejects with a `TimeoutError` DOMException, whose
     * message ("The operation was aborted due to timeout") does not say what
     * timed out. Named here so a log line is answerable.
     */
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { status: 'failed', reason: `Resend did not answer within ${SEND_TIMEOUT_MS}ms.` };
    }
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

/**
 * Turns a non-2xx into one line worth logging.
 *
 * **Resend does not document the error body's shape**, only its status codes
 * and error names — so nothing here assumes a field exists. It looks for the
 * two names that appear in practice, and falls back to the status line and a
 * truncated body, which is always better than "request failed".
 *
 * The body is truncated because it is provider output going into our log, and
 * an unbounded one is a way to make a log line unreadable.
 */
async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      const parts = [record.name, record.message].filter((part): part is string => typeof part === 'string');
      detail = parts.join(': ');
    }
  } catch {
    // Not JSON, or no body at all. The status line below is then all there is.
  }

  const suffix = detail === '' ? '' : ` — ${detail.slice(0, 300)}`;
  return `Resend answered ${response.status} ${response.statusText}${suffix}`;
}

/** The provider's message id, or `null` when the body was not what we expected. */
async function readMessageId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === 'object') {
      const id = (body as Record<string, unknown>).id;
      if (typeof id === 'string' && id !== '') return id;
    }
  } catch {
    // Accepted with an unreadable body. Still sent.
  }
  return null;
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
