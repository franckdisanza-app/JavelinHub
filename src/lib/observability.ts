/**
 * =============================================================================
 * Error reporting — one seam, one line of JSON, no provider yet.
 * =============================================================================
 *
 * `docs/ROADMAP.md` §7: *"No error reporting, no structured logging. A
 * `DataError` that escapes to `error.tsx` in production will be reported by a
 * user, if at all."*
 *
 * That was true, and it stops being true the moment the app has users rather
 * than a developer watching a terminal. What it needs is not Sentry — that is a
 * decision with an account, a DSN and a bill attached — but the SEAM Sentry
 * would plug into, and something useful in the meantime.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS DOES
 * -----------------------------------------------------------------------------
 * Emits exactly one line of JSON per report to stderr. Vercel captures stderr
 * into its runtime logs, where a JSON line is searchable and a multi-line stack
 * dump is not — which is the entire practical difference between "we log
 * errors" and "we can find one".
 *
 * Adding a provider later is a change to `report()` and nowhere else. Every
 * call site already passes structured context rather than a formatted string,
 * so nothing has to be revisited when the destination changes.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT LOG
 * -----------------------------------------------------------------------------
 * **No request headers.** `onRequestError` hands them over in full, and they
 * carry the session cookie — on Supabase that is a live access token, and on the
 * mock it is a signed session that names a user. A log line containing one is a
 * credential in a place many people can read and nobody thinks of as sensitive.
 * The PATH is logged and the headers are not, ever.
 *
 * **No email addresses and no user ids.** An error log that pairs a person with
 * what they were doing is a behavioural record, and it accumulates silently.
 * When "which user hit this" genuinely matters, the right answer is a request
 * id correlated with a separate access log — not a user id sprayed through the
 * error stream.
 *
 * **No query strings.** They are part of `request.path` in Next's payload and
 * are stripped here, because `?next=` and `?q=` carry whatever a visitor typed.
 *
 * **No `DataError`.** See `isExpected()` — a refusal is not an incident.
 *
 * Safe to import anywhere on the server. Does nothing in the browser.
 */

import { isDataError } from '@/lib/data/types';

/** Where a report came from. Kept small and closed so the logs are groupable. */
export type ErrorSource =
  | 'request' // Next's onRequestError: a render, a route handler or an action
  | 'action' // a Server Action that caught something it could not handle
  | 'storage' // an object-storage call that failed in a way worth knowing about
  | 'background'; // anything not on a request path

export interface ErrorContext {
  source: ErrorSource;
  /** Route path — `/orders/[id]`, not `/orders/9f2…`. Never a query string. */
  route?: string;
  /** `render` | `route` | `action` | `proxy`, from Next. Free text otherwise. */
  kind?: string;
  /** Next's error digest, which is also what `error.tsx` shows the user. */
  digest?: string;
  /**
   * Anything else worth grouping on. **Values must be non-identifying** — a
   * listing id is fine, an email address is not. See the header.
   */
  extra?: Record<string, string | number | boolean | null>;
}

/**
 * True for the errors that are not incidents.
 *
 * A `DataError` is the application refusing something on purpose: a `forbidden`
 * means the policies worked. Reporting those would bury the real failures under
 * a stream of correct behaviour, which is how an error channel becomes one
 * nobody reads.
 *
 * `NEXT_REDIRECT` and `NEXT_NOT_FOUND` are the same in a different disguise:
 * `redirect()` and `notFound()` work by throwing, so every successful redirect
 * looks like an exception to a boundary that is not looking for it.
 */
function isExpected(error: unknown): boolean {
  if (isDataError(error)) return true;

  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === 'string') {
    if (digest.startsWith('NEXT_REDIRECT')) return true;
    if (digest === 'NEXT_NOT_FOUND') return true;
  }
  return false;
}

/** Strips a query string, so nothing a visitor typed reaches the log. */
function pathOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cut = value.indexOf('?');
  return cut === -1 ? value : value.slice(0, cut);
}

/**
 * The single line. One JSON object, one `console.error`, no interpolation.
 *
 * `console.error` rather than a logger dependency: Vercel captures stderr, and
 * a logging library for one call site is a dependency to keep current in
 * exchange for nothing.
 */
function emit(payload: Record<string, unknown>): void {
  try {
    console.error(JSON.stringify(payload));
  } catch {
    // A circular value in `extra` would throw inside the reporter, which must
    // never be what takes a request down. Fall back to the one field that is
    // always a string.
    console.error(JSON.stringify({ level: 'error', event: 'report_failed' }));
  }
}

/**
 * Reports an unexpected server error.
 *
 * Returns nothing and throws nothing — a reporter that can fail the request it
 * is reporting on is worse than no reporter. Expected errors are dropped
 * silently; see `isExpected`.
 */
export function reportError(error: unknown, context: ErrorContext): void {
  if (typeof window !== 'undefined') return;
  if (isExpected(error)) return;

  const isError = error instanceof Error;

  emit({
    level: 'error',
    event: 'server_error',
    at: new Date().toISOString(),
    source: context.source,
    route: pathOnly(context.route),
    kind: context.kind,
    // The constructor name is what makes a log groupable — `TypeError` and
    // `PostgrestError` are different incidents even when the message is
    // identical.
    name: isError ? error.name : typeof error,
    message: isError ? error.message : String(error),
    // The stack is the point of the whole exercise. It is a multi-line string
    // INSIDE a JSON field rather than raw output, so one report stays one
    // greppable line.
    stack: isError ? error.stack : undefined,
    // Next replaces the message with a generic string in production builds and
    // gives the user this instead, so it is the only handle connecting a
    // reported incident to the reference on somebody's screen.
    digest: context.digest,
    ...(context.extra ? { extra: context.extra } : {}),
  });
}
