/**
 * =============================================================================
 * Postgres / PostgREST errors → `DataError`.
 * =============================================================================
 *
 * `supabase/README.md` specifies the code mapping:
 *
 *     42501 → forbidden (or unauthorized when there is no session)
 *     23505 → conflict
 *     23503 / P0002 → not_found
 *     22023 / 23514 → invalid
 *
 * Translating the *code* is the easy half. The half that matters is deciding
 * what MESSAGE the user sees, because two very different things arrive wearing
 * the same code.
 *
 * -----------------------------------------------------------------------------
 * Two sources, one code
 * -----------------------------------------------------------------------------
 * 1. **Deliberate messages from our own SQL.** Every `raise exception` in
 *    `0002_rls.sql` was written as end-user copy and given an explicit
 *    `errcode`: "You cannot review your own application." (42501), "That invite
 *    code is not valid." (22023), "You already have an application awaiting
 *    review." (23505). Throwing these away and rendering something generic
 *    would lose the most precise error text in the system — the RPCs are the
 *    only place that knows *why* an operation was refused.
 *
 * 2. **Native Postgres/PostgREST failures, on the same codes.** An RLS refusal
 *    is `42501 new row violates row-level security policy for table "listings"`.
 *    A check constraint is `23514 new row for relation "listings" violates check
 *    constraint "listings_price_cents_check"`. A missing column grant is
 *    `42501 permission denied for table listings`. None of that may reach a
 *    user: it is unreadable, it names internal objects, and it tells an
 *    attacker which policy stopped them.
 *
 * So: map the code, then decide the message by asking whether the text is one
 * of ours. {@link looksInternal} is a denylist of Postgres's own phrasings, and
 * it FAILS SAFE — anything it is unsure about is treated as internal and
 * replaced. A user seeing a slightly vaguer sentence is a cosmetic loss; a user
 * seeing `permission denied for table listings` is an information leak, so the
 * asymmetry is deliberate and this list should stay generous.
 *
 * `docs/DATA-LAYER.md` promises that a `DataError.message` is always safe to
 * render. This file is where that promise is kept for the Supabase backend.
 */

import { DataError, type DataErrorCode } from '../types';

/** The subset of `PostgrestError` this module needs. */
interface PostgresLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * Fragments that only ever appear in Postgres's, PostgREST's or GoTrue's own
 * error text. Matched case-insensitively against the whole message.
 *
 * Every entry names something a user must never be shown: an internal object
 * name, a policy, a constraint, or a driver-level parse failure.
 */
const INTERNAL_MESSAGE_MARKERS: readonly string[] = [
  'row-level security',
  'violates',
  'constraint',
  'permission denied',
  'does not exist',
  'duplicate key',
  'null value in column',
  'invalid input syntax',
  'invalid input value',
  'insert or update on table',
  'relation "',
  'column "',
  'schema "',
  'function "',
  'operator does not exist',
  // NOT a bare 'could not': Postgres says "could not serialize access", but so
  // does our own `raise exception 'Your profile could not be found.'`
  // (0002_rls.sql). A bare match replaced that authored sentence with the
  // generic one — a fail-safe list still has to be able to tell the two apart.
  'could not serialize',
  'could not connect',
  'could not open',
  'could not obtain',
  'jwt',
  'pgrst',
  'searchpath',
  'search_path',
  'stack depth',
  'canceling statement',
  'deadlock',
  'connection',
  'timeout',
];

/**
 * True when a message looks like it came from the database rather than from our
 * own `raise exception`.
 *
 * Fails safe: a message that is empty, absent, not a string, suspiciously long,
 * or contains a double quote (Postgres quotes object names that way, and none
 * of our authored sentences contain one) is treated as internal.
 */
function looksInternal(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return true;
  const trimmed = message.trim();
  if (trimmed === '') return true;
  // Our authored sentences are short. Nothing we wrote runs past this.
  if (trimmed.length > 200) return true;
  if (trimmed.includes('"')) return true;
  const lowered = trimmed.toLowerCase();
  return INTERNAL_MESSAGE_MARKERS.some((marker) => lowered.includes(marker));
}

/** What the user is told when the real message is not showable. */
const GENERIC_MESSAGE: Record<DataErrorCode, string> = {
  unauthorized: 'You need to be signed in to do that.',
  forbidden: 'You do not have permission to do that.',
  not_found: 'That item could not be found.',
  invalid: 'Some of the details you entered are not valid.',
  conflict: 'That conflicts with something that already exists.',
};

/**
 * Maps a SQLSTATE to a `DataErrorCode`.
 *
 * `hasSession` splits 42501 the way the README requires: the same
 * "insufficient privilege" code means "sign in" to an anonymous caller and
 * "you may not do this" to a signed-in one, and the UI branches on which
 * (`unauthorized` sends the user to the login page).
 */
function codeFor(sqlState: string, hasSession: boolean): DataErrorCode | null {
  switch (sqlState) {
    case '42501':
      return hasSession ? 'forbidden' : 'unauthorized';
    case '23505':
      return 'conflict';
    case '23503':
    case 'P0002':
      return 'not_found';
    case '22023':
    case '23514':
    case '22001': // string_data_right_truncation — a value past a length cap
    case '22P02': // invalid_text_representation — e.g. a bad enum or uuid
      return 'invalid';
    // PostgREST: `.single()` matched no row. Every call site that uses it
    // treats "no row" as absence, so this is a 404, not a crash.
    case 'PGRST116':
      return 'not_found';
    // PostgREST: the JWT is expired or unusable.
    case 'PGRST301':
      return 'unauthorized';
    default:
      return null;
  }
}

/**
 * Converts a PostgREST error into a `DataError`, or returns `null` when the
 * error is not one this module recognises.
 *
 * Returning `null` rather than inventing a `DataError` is deliberate: an
 * unmapped failure is a bug or an outage, and `docs/DATA-LAYER.md` says a
 * non-`DataError` must propagate so it reaches the error boundary and the logs
 * instead of being rendered as friendly form copy.
 */
export function toDataError(error: unknown, hasSession: boolean): DataError | null {
  if (error === null || typeof error !== 'object') return null;

  const { code, message } = error as PostgresLikeError;
  if (typeof code !== 'string') return null;

  const mapped = codeFor(code, hasSession);
  if (mapped === null) return null;

  return new DataError(mapped, looksInternal(message) ? GENERIC_MESSAGE[mapped] : (message as string).trim());
}

/**
 * Throws the translated error, or rethrows the original when it is not a
 * recognised database failure.
 *
 * Call this on every non-null `error` from a PostgREST call. Silently ignoring
 * one and returning `null` would turn "the database refused this" into "there
 * is nothing here", which is how an authorization failure becomes an empty
 * page instead of a message.
 */
export function throwDataError(error: unknown, hasSession: boolean): never {
  const mapped = toDataError(error, hasSession);
  if (mapped) throw mapped;

  // Unmapped. This is a bug or an outage — a missing relation (`PGRST205`,
  // which is what an unpushed schema answers for every table), a dead
  // connection, a policy that does not exist. It must propagate so it reaches
  // the error boundary and the logs rather than being dressed up as form copy.
  //
  // But a `PostgrestError` is a plain object literal, not an `Error`, and
  // throwing one gives a stackless report that says almost nothing about where
  // it came from. Wrap it, keeping the original as `cause`.
  if (error instanceof Error) throw error;
  const detail =
    error !== null && typeof error === 'object'
      ? JSON.stringify(error)
      : String(error);
  throw new Error(`Unhandled database error: ${detail}`, { cause: error });
}
