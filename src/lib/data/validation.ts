/**
 * =============================================================================
 * Input validation — shared by EVERY `DataClient` implementation.
 * =============================================================================
 *
 * These helpers were extracted verbatim from `mock/mockClient.ts` when
 * `SupabaseDataClient` was added, and the extraction is the point.
 *
 * `supabase/README.md` names this as the one thing that silently breaks on the
 * backend swap: SQL carries only `price_cents >= 0`, the rating check and the
 * length constraints, and PostgREST reports a violated constraint as
 * `23514 new row for relation "listings" violates check constraint …` — which
 * is not a sentence you show a user. Every field-level message the UI renders
 * therefore comes from application code, in BOTH backends. Two copies of these
 * functions would mean the wording of half the forms in the app changes the day
 * `DATA_BACKEND` flips, with nothing failing to compile and no test noticing.
 *
 * So: one copy, imported by both clients. Each function documents the SQL
 * constraint it mirrors — keep the two in step, and never let this file get
 * looser than the database, or the mock accepts writes Postgres rejects.
 *
 * Every message here is written to be rendered directly to an end user, and
 * none of them echo back the value that failed.
 */

import {
  COACH_YEARS_COACHING_MAX,
  DataError,
  isFulfilmentMode,
  isListingCategory,
  type Actor,
  type FulfilmentMode,
  type ListingCategory,
} from './types';

export function requireText(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== 'string') throw new DataError('invalid', `${label} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new DataError('invalid', `${label} is required.`);
  if (trimmed.length > max) throw new DataError('invalid', `${label} must be ${max} characters or fewer.`);
  return trimmed;
}

/**
 * A password, on its way to being hashed.
 *
 * **NOT `requireText`, and the difference is a lockout bug.** `requireText`
 * returns `value.trim()`, which is right for a title and wrong for a
 * credential: `signUp` stored the TRIMMED string while `signInWithPassword`
 * verifies the RAW one, so an account created with a trailing space — a phone
 * keyboard adds one after a word completion, a paste from a document carries
 * one — could never be signed into again. This function returns the value
 * exactly as it arrived, so what is hashed is what was typed.
 *
 * Length is measured on the RAW value too. Trimming before counting would let
 * `"       a"` fail as one character while `"        "` passed as eight.
 *
 * All-whitespace is still refused, and that is the one judgement here: eight
 * spaces is not a password somebody chose, it is a field a browser filled or a
 * key held down, and the person who "set" it could not reproduce it. Everything
 * else — leading, trailing and interior spaces — is preserved.
 *
 * The MAXIMUM is not politeness. `scryptSync` runs over whatever it is given,
 * so an unbounded password is a CPU-exhaustion request that costs the sender
 * nothing.
 *
 * Mirrors nothing in SQL: on Supabase, GoTrue owns the rule and applies its own
 * minimum (a project setting) on top of this one.
 */
export function requirePassword(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DataError('invalid', 'Password is required.');
  }
  if (value.length < 8) {
    throw new DataError('invalid', 'Passwords must be at least 8 characters.');
  }
  if (value.length > 200) {
    throw new DataError('invalid', 'Password must be 200 characters or fewer.');
  }
  return value;
}

export function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new DataError('invalid', `${label} is not valid.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) throw new DataError('invalid', `${label} must be ${max} characters or fewer.`);
  return trimmed;
}

/**
 * Mirrors: the `category public.listing_category not null` column in
 * 0001_init.sql. Postgres rejects a value outside the enum at the cast, before
 * the row is ever considered for insertion — so free text must fail here too,
 * or the mock would accept writes the real backend refuses.
 *
 * The message names no valid slugs on purpose: the form already lists them, and
 * echoing the submitted value back would put attacker-chosen text into an error
 * banner for no gain.
 */
export function requireListingCategory(value: unknown): ListingCategory {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!isListingCategory(trimmed)) {
    throw new DataError('invalid', 'Category must be one of the available categories.');
  }
  return trimmed;
}

/**
 * Mirrors: the `public.fulfilment_mode` enum (0011_delivery.sql), and the
 * `not null default 'personalised'` on `listings.fulfilment`.
 *
 * Closed like `requireListingCategory`, and for the same reason: this is an
 * enum column in Postgres, so an unrecognised value is a cast error rather than
 * a row, and the mock must not be the more permissive of the two.
 *
 * `undefined` and `null` are NOT errors — they mean "the caller did not say",
 * which on a create is the column default and on an update is "leave it alone".
 * Both callers distinguish those two by testing for `null` themselves; this
 * function only decides whether a value that WAS supplied is a legal one.
 */
export function optionalFulfilment(value: unknown): FulfilmentMode | null {
  if (value === undefined || value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!isFulfilmentMode(trimmed)) {
    throw new DataError('invalid', 'Choose how this offer is delivered.');
  }
  return trimmed;
}

/**
 * The object path of an offer's instant download, or `null` to clear it.
 *
 * The same shape rules as {@link optionalAvatarPath} — no traversal, no
 * absolute path, no backslashes, a sane length — because it is the same kind of
 * value used the same way: a storage object key, written into a column.
 *
 * What it deliberately does NOT check is the `<listing_id>/` prefix that
 * `listings_asset_path_shape` and `offer_assets_write_coach` both require. That
 * is not a property of the string, it is a relationship between the string and
 * a row, so each backend checks it where it has the row — exactly as
 * `setMyAvatar` checks the avatar prefix against the resolved actor rather than
 * here.
 */
export function optionalAssetPath(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new DataError('invalid', 'That file is not valid.');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 300) throw new DataError('invalid', 'That file is not valid.');
  if (trimmed.includes('..') || trimmed.startsWith('/') || trimmed.includes('\\')) {
    throw new DataError('invalid', 'That file is not valid.');
  }
  return trimmed;
}

export function requirePriceCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DataError('invalid', 'Price must be a whole number of cents.');
  }
  // Mirrors: check constraint `listings.price_cents >= 0` (0001_init.sql).
  if (value < 0) throw new DataError('invalid', 'Price cannot be negative.');
  if (value > 100_000_000) throw new DataError('invalid', 'Price is too large.');
  return value;
}

/**
 * Mirrors: check constraint `reviews.rating between 1 and 5` on a `smallint`
 * column (0001_init.sql).
 *
 * Postgres would refuse `4.5` at the cast to smallint and `0` / `6` at the
 * check, so both have to fail here or the mock accepts writes the real backend
 * rejects. `0` is not a low rating, it is the absence of one — and the read
 * shape depends on that being impossible, since `rating_average === null` is
 * how "no reviews" is told apart from a bad score.
 */
export function requireRating(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DataError('invalid', 'Choose a rating from 1 to 5 stars.');
  }
  if (value < 1 || value > 5) {
    throw new DataError('invalid', 'Choose a rating from 1 to 5 stars.');
  }
  return value;
}

/**
 * Mirrors: `check (coach_years_coaching is null or (coach_years_coaching
 * between 0 and 80))` on an `integer` column (0001_init.sql).
 *
 * `null` and `0` are DIFFERENT ANSWERS and both are legal. `null` is "not
 * stated" and renders as nothing; `0` is "this is my first season", and a
 * coach who says so must not be silently converted into someone who said
 * nothing. That is the same distinction `rating_average` makes — see
 * {@link OfferStats} — and it is the reason this is not written as a falsy
 * check.
 */
export function optionalYears(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DataError('invalid', 'Years coaching must be a whole number.');
  }
  if (value < 0 || value > COACH_YEARS_COACHING_MAX) {
    throw new DataError('invalid', `Years coaching must be between 0 and ${COACH_YEARS_COACHING_MAX}.`);
  }
  return value;
}

export function requireEmail(value: unknown): string {
  const email = requireText(value, 'Email', 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DataError('invalid', 'Enter a valid email address.');
  }
  return email;
}

export function requireIsoTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new DataError('invalid', `${label} is not a valid date.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new DataError('invalid', `${label} is not a valid date.`);
  return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Actor unwrapping.
//
// These two turn an `Actor` into an id, and stop there. Turning that id into a
// set of PRIVILEGES is each backend's own job and deliberately not shared:
// `mockClient.resolveProfile()` reads the JSON store, and Postgres reads
// `auth.uid()` inside a policy. Neither may trust anything else on the actor —
// which is why `Actor` has no other field to trust.
// ---------------------------------------------------------------------------

export function requireActorId(actor: Actor): string {
  // Read `actor.userId` EXACTLY ONCE and validate the snapshot. `Actor` is a
  // plain object by contract, but nothing stops a caller passing one whose
  // `userId` is a getter; reading it once per check would let the value seen by
  // the validation differ from the value used for the lookup (TOCTOU). One
  // read, one local, no window.
  const userId: unknown = actor?.userId;
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new DataError('unauthorized', 'You need to be signed in to do that.');
  }
  return userId;
}

/**
 * The non-throwing form of `requireActorId`, for the ONE read where being
 * anonymous is not an error: `getListingForViewer`, where a viewer with no
 * entitlement gets a 404 rather than a 401 (a refusal would confirm that a
 * withdrawn offer once existed at that id).
 *
 * Reads `actor.userId` EXACTLY ONCE, for the same TOCTOU reason as
 * `requireActorId` — see the comment there.
 */
export function optionalActorId(actor: Actor): string | null {
  const userId: unknown = actor?.userId;
  if (typeof userId !== 'string' || userId.trim() === '') return null;
  return userId;
}

/**
 * Normalises an avatar object path, or `null` for "no avatar".
 *
 * This does NOT check ownership — that needs the resolved actor and belongs to
 * each client, which pins the path to `<own id>/…` exactly as the
 * `profiles_avatar_path_shape` CHECK constraint and the storage policies do.
 * What it does is settle the three ways "no avatar" can arrive (absent, null,
 * empty string) on a single `null`, so clearing one is expressible and cannot
 * be mistaken for "leave it alone".
 *
 * The length cap is not arbitrary: the path is a uuid, a slash and a filename,
 * so anything approaching this is not a path this app produced.
 */
export function optionalAvatarPath(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new DataError('invalid', 'That avatar is not valid.');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 300) throw new DataError('invalid', 'That avatar is not valid.');
  // No traversal, no absolute paths, no backslashes: the path is used as a
  // storage object key and is written into a column the public views publish.
  if (trimmed.includes('..') || trimmed.startsWith('/') || trimmed.includes('\\')) {
    throw new DataError('invalid', 'That avatar is not valid.');
  }
  return trimmed;
}
