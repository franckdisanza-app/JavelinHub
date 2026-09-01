/**
 * =============================================================================
 * `SupabaseDataClient` — the Postgres implementation of `DataClient`.
 * =============================================================================
 *
 * The sibling of `mock/mockClient.ts`. Same interface, same return shapes, same
 * `DataError` codes, same user-facing wording — see `docs/DATA-LAYER.md`, which
 * describes both, and `supabase/README.md`, which maps every authorization rule
 * to the policy that enforces it here.
 *
 * -----------------------------------------------------------------------------
 * The one structural difference from the mock, and it is the whole point
 * -----------------------------------------------------------------------------
 * The mock re-implements every RLS policy in TypeScript because there is no
 * database to enforce them. Here there is. Authorization is enforced by
 * Postgres — by the policies in `0002_rls.sql`, by `guard_listing_update()`,
 * and by the four `SECURITY DEFINER` RPCs — against `auth.uid()`, which comes
 * from the JWT in the request's cookies and cannot be set by a caller.
 *
 * So the checks written in this file are NOT the boundary. They exist for one
 * reason: **error copy**. An RLS refusal arrives as
 * `42501 new row violates row-level security policy for table "listings"`,
 * which `errors.ts` must replace with something generic before a user sees it.
 * A pre-check lets `createListing` say "Only approved coaches can publish
 * offers. Apply to coach or redeem an invite code first." — the same sentence
 * the mock produces — instead of "You do not have permission to do that."
 *
 * Two consequences worth being explicit about:
 *
 *   * Deleting any pre-check in this file degrades a message. It does not open
 *     a hole; Postgres still refuses the write.
 *   * A pre-check passing does NOT mean the write will succeed. Nothing here
 *     may assume it did — every mutation still reads the database's answer and
 *     translates its error.
 *
 * -----------------------------------------------------------------------------
 * `SELECT *` is a bug on `listings`
 * -----------------------------------------------------------------------------
 * `0002_rls.sql` revokes table-level SELECT on `public.listings` and grants the
 * columns individually, so that `deleted_by` — an administrator's id after a
 * takedown — is unreadable through PostgREST. A role holding only column
 * privileges gets `42501` on `select=*` rather than a row with the column
 * quietly missing. Every listings read here therefore names its columns through
 * {@link LISTING_COLUMNS}, and a new column on that table has to be added both
 * to the grant in SQL and to this constant.
 *
 * -----------------------------------------------------------------------------
 * Never cache the Supabase client on this instance
 * -----------------------------------------------------------------------------
 * `getDataClient()` caches the *client object* for the lifetime of the server
 * process, so this class must hold no per-request state. Every method opens its
 * own request-scoped Supabase client. A field holding one would serve the first
 * visitor's session to every later request — see `serverClient.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  CoachApplicationFilter,
  CoachDirectoryFilter,
  CreateCoachApplicationInput,
  CreateInviteInput,
  CreateListingInput,
  AddDeliverableInput,
  CreateReviewInput,
  DataClient,
  ListingFilter,
  SignInInput,
  EmailChangeResult,
  SignUpInput,
  SignUpResult,
  UpdateListingInput,
  UpdateMyCoachProfileInput,
  UpdateMyProfileInput,
} from '../client';
import { AUTH_CALLBACK_PATH } from '@/lib/auth/paths';
import { siteUrl } from '@/lib/env';
import { generateInviteCode } from '../invite-code';
import {
  COACH_BIO_MAX,
  COACH_HEADLINE_MAX,
  DataError,
  LISTING_CATEGORIES,
  REVIEW_REPLY_MAX,
  isListingCategory,
  isReportReason,
  type Actor,
  type CoachApplication,
  type CoachApplicationWithUser,
  type AdminAction,
  type AdminActionWithNames,
  type CoachStats,
  type CoachStatus,
  type Deliverable,
  type FulfilmentMode,
  type Invite,
  type ListingCategory,
  type ListingDetail,
  type ListingRevision,
  type ListingWithCoach,
  type ModeratableReview,
  type OfferStats,
  type Order,
  type OrderWithListing,
  type OwnedListing,
  type Profile,
  type PublicCoach,
  type PublicProfile,
  type PublicReview,
  type PublicReviewReply,
  type PublicReviewWithListing,
  type Report,
  type ReportReason,
  type ReportStatus,
  type ReportWithContext,
  type RemovedReview,
  type RemovedReviewWithNames,
  type Review,
} from '../types';
import { isListingSort } from '../client';
import {
  byCreatedAt,
  emptyPage,
  KEYSETS,
  normaliseLimit,
  decodeCursor,
  pageOf,
  supabaseAscending,
  supabaseKeysetFilter,
  tieBreakColumn,
  windowOf,
  type Keyset,
  type KeysetSpec,
  type Page,
  type PageRequest,
} from '../pagination';
import {
  optionalActorId,
  optionalAssetPath,
  optionalAvatarPath,
  optionalFulfilment,
  requirePassword,
  optionalText,
  optionalYears,
  requireActorId,
  requireEmail,
  requireIsoTimestamp,
  requireListingCategory,
  requirePriceCents,
  requireRating,
  requireText,
} from '../validation';
import { throwDataError } from './errors';
import { publicSupabase } from './publicClient';
import { createSupabaseServerClient, getSupabaseUserId } from './serverClient';

// ---------------------------------------------------------------------------
// Column lists.
// ---------------------------------------------------------------------------

/**
 * Every column of `public.listings` a client role may read. NOT `*` — see the
 * header. `deleted_by` is absent because SELECT on it is revoked in SQL.
 */
const LISTING_COLUMNS =
  'id, coach_id, title, description, price_cents, category, price_epoch, deleted_at, fulfilment, created_at, updated_at';

/**
 * The same projection from `public.owned_listings`, plus the two things only an
 * owner may see: the derived takedown flag, and their own `asset_path`.
 *
 * `asset_path` is NOT in {@link LISTING_COLUMNS} and must never be added to it.
 * The column is withheld from the client grant in `0011_delivery.sql`, so
 * naming it in a read of `public.listings` is a `42501`, not a wider row. It is
 * reachable here only because a view is owner-run and this one is scoped
 * `where l.coach_id = auth.uid()` — see 0012.
 */
const OWNED_LISTING_COLUMNS = `${LISTING_COLUMNS}, withdrawn_by_admin, asset_path`;

/** `public.entitled_offer_assets` (0012) — the buyer's and owner's read of an instant path. */
const ENTITLED_ASSET_COLUMNS = 'listing_id, asset_path';

/** `public.public_coaches` also carries `created_at`, which is for ordering only. */
const PUBLIC_COACH_COLUMNS = 'id, full_name, coach_headline, coach_bio, coach_years_coaching, avatar_path';

/** `public.public_reviews`-shaped projections. */
const PUBLIC_REVIEW_COLUMNS = 'id, listing_id, rating, body, created_at, author_name';

// ---------------------------------------------------------------------------
// Query-building helpers.
//
// THE FOUR BELOW ARE `export`ed FOR ONE REASON: so `scripts/verify-authz.mts`
// can assert on them directly. Nothing else imports them and nothing else
// should — they are internals of this file, not part of the data layer's
// surface.
//
// They are worth the export because of what they are. Three of them are the
// only thing standing between a caller-supplied search term and PostgREST's
// own filter grammar, and a mistake in any of them WIDENS a query rather than
// breaking it — `escapeLike` returning `''` for `'*'` turns a search into the
// whole catalogue, and a `quoteForOr` that can be broken out of turns one into
// a filter the caller wrote. Neither failure raises an error, appears in a log,
// or changes anything a page renders except the number of rows on it. They had
// no coverage at all: both mock suites hard-set `DATA_BACKEND=mock` and never
// load this class, so the 3,208 lines here are exercised by nothing.
//
// This does not close that gap — the methods still need a database. It closes
// the part of it that needs no database at all.
// ---------------------------------------------------------------------------

/**
 * Escapes a user's search term for use inside a `LIKE`/`ILIKE` pattern.
 *
 * The mock matches a plain substring, so `50%` must find offers containing the
 * literal text "50%". Passed through unescaped, `%` and `_` are LIKE wildcards
 * and `50%` would match essentially everything — a different result from the
 * same input on the other backend. `\` goes first, or it would escape the
 * escapes added after it.
 */
export function escapeLike(raw: string): string | null {
  // `*` IS ALSO A WILDCARD HERE, and it is the one with no escape. PostgREST
  // accepts `*` as an alias for `%` in `like`/`ilike` and rewrites it BEFORE
  // Postgres sees the pattern, so it never reaches the backslash escaping
  // below and there is no sequence that makes it literal.
  //
  // Returning `null` — "this term cannot be expressed" — is the only honest
  // answer, and every caller must then produce a NARROWER result, never a
  // wider one. Two wrong fixes, both tried:
  //
  //   * Leave it alone: `q = '*'` becomes `%%` and `listListings` returns the
  //     entire catalogue on Supabase while the mock returns nothing.
  //   * Strip it and carry on: `'*'` escapes to `''`, which `likePattern` then
  //     wraps into `'%%'` — the same catalogue, by a longer road. `'Ja*'` is
  //     subtler and worse: it silently widens into a `Ja` substring search.
  //
  // `mockClient.ts` states the rule this protects: narrowed rather than
  // widened, so the backend swap cannot change search results.
  if (raw.includes('*')) return null;

  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** `escapeLike`, wrapped so it matches anywhere in the value. `null` propagates. */
export function likePattern(raw: string): string | null {
  const escaped = escapeLike(raw);
  return escaped === null ? null : `%${escaped}%`;
}

/**
 * Wraps a value for PostgREST's `or=(...)` filter.
 *
 * `or` is a comma-separated list and `.` separates a filter's parts, so a
 * search for `a,b` or `a.b` would otherwise be parsed as filter SYNTAX and
 * either error or — worse — widen the query into one the caller did not ask
 * for. Double-quoting the value is PostgREST's documented escape hatch; inner
 * quotes and backslashes are escaped so the quoting cannot be broken out of.
 */
export function quoteForOr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * PostgREST returns `numeric` and `bigint` as JSON numbers, but both are
 * width-dependent and a driver upgrade returning `"4.5"` instead of `4.5` would
 * put a string into a field typed `number | null` — invisible until something
 * renders `"4.5"` or compares it. Coerced defensively, once, here.
 *
 * `null` stays `null` and is NOT turned into `0`: `rating_average === null`
 * means "no reviews" and is a different answer from a rating of zero, which no
 * write path can produce. See {@link OfferStats}.
 */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** As above, for counts, where absent genuinely does mean zero. */
function toCount(value: unknown): number {
  return toNumberOrNull(value) ?? 0;
}

/**
 * True for a canonical UUID.
 *
 * Used to pre-filter BATCH reads. A single malformed id inside a PostgREST
 * `.in(...)` list fails the cast for the whole filter, so one junk id would
 * take every valid id in the batch down with it — `listOfferStats` would return
 * `[]` instead of the stats it did have, and `listCoachStats` would zero every
 * coach on the page. The mock answers per id, so dropping the bad one here and
 * letting it fall through to "no row" is what keeps the two agreeing.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * SQLSTATE `invalid_text_representation` — the value is not a valid `uuid` (or
 * not a member of an enum).
 *
 * Every id in this schema is a `uuid`, and ids arrive from URL segments. A
 * request for `/offers/junk` reaches Postgres as `?id=eq.junk` and fails at the
 * CAST, before any row is considered. A cast failure there is not a validation
 * error a user can act on — it is simply "there is nothing at that address".
 *
 * The mock has no cast to fail: `db.listings.find(l => l.id === 'junk')` is
 * `undefined`, so `getListing` returns `null` and the page 404s. That behaviour
 * is depended on — `src/app/offers/[id]/page.tsx` says in as many words that a
 * hand-typed URL must land on the 404 page rather than the error boundary.
 * Letting `errors.ts` map 22P02 to `invalid` and throw turned every mistyped
 * offer or coach URL into a 500, on Supabase and only on Supabase.
 *
 * So the READ paths treat it as absence. WRITE paths still throw: there,
 * `invalid` is the right answer, because a malformed id in a submitted form is
 * bad input rather than a missing page.
 */
function isMalformedId(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: string }).code === '22P02';
}

/** The name shown when a coach row cannot be resolved. Mirrors `coachName()`. */
const UNKNOWN_COACH = 'Unknown coach';

/** The title shown when a listing row cannot be resolved. Mirrors `listingTitle()`. */
const UNKNOWN_LISTING = 'Unknown offer';

/** The zero rollup, for a coach id with no matching row. */
function emptyCoachStats(coachId: string): CoachStats {
  return { coach_id: coachId, rating_average: null, review_count: 0, sales_count: 0 };
}

// ---------------------------------------------------------------------------
// Row shapes as they come back from PostgREST.
// ---------------------------------------------------------------------------

interface ListingRow {
  id: string;
  coach_id: string;
  title: string;
  description: string;
  price_cents: number;
  category: string;
  price_epoch: number;
  deleted_at: string | null;
  fulfilment: FulfilmentMode;
  created_at: string;
  updated_at: string;
}

interface OwnedListingRow extends ListingRow {
  withdrawn_by_admin: boolean;
  asset_path: string | null;
}

// ---------------------------------------------------------------------------
// Request context.
//
// `Ctx` pairs a request-scoped client with the id Postgres will see in
// `auth.uid()`. Resolving that id ONCE per method and passing it around is what
// keeps a method from asking the auth server twice and, worse, from acting on
// two different answers.
// ---------------------------------------------------------------------------

interface Ctx {
  supabase: SupabaseClient;
  /** The AUTHENTICATED user id — from the JWT, never from the caller. */
  userId: string | null;
}

/**
 * The identity comes from `getSupabaseUserId()` rather than from a second
 * `supabase.auth.getUser()` on the client built here, and that is the whole
 * point: it is the SAME question, asked of the same cookies, and asking it
 * inline meant one HTTPS round trip to the auth server per data-layer method.
 * A page calling four methods paid for four. That helper is memoised per
 * request — see its comment for why the identity may be cached and the profile
 * may not — so the first caller in a render pays and the rest are free.
 *
 * The two are awaited together because they do not depend on each other:
 * building the client reads cookies and does no I/O, so the pair costs one
 * round trip rather than two sequential awaits.
 */
async function openContext(): Promise<Ctx> {
  const [supabase, userId] = await Promise.all([createSupabaseServerClient(), getSupabaseUserId()]);
  return { supabase, userId };
}

/**
 * A context with NO SESSION, for reads whose answer is the same for everybody.
 *
 * It still awaits, but for nothing that touches the request: no cookies to read
 * and no token to validate against the auth server. That is the whole
 * difference, and it is what lets these reads run inside a `use cache` scope —
 * see `publicClient.ts` for the rule about which reads may use it, why the list
 * is short, and why building the client is asynchronous at all.
 *
 * `userId: null` is not a placeholder, it is the truth: Postgres will evaluate
 * every policy for `anon`. It reaches `throwDataError(error, false)` below,
 * which maps a 42501 to `unauthorized` ("sign in") rather than `forbidden`
 * ("not yours") — the honest reading of a refusal aimed at a request that
 * carried no identity. None of these reads should ever produce one: every
 * relation they touch is granted to `anon` and carries its own predicate.
 */
async function openPublicContext(): Promise<Ctx> {
  return { supabase: await publicSupabase(), userId: null };
}

interface AuthedCtx extends Ctx {
  userId: string;
}

/**
 * Opens a context for a method that requires a signed-in actor, and reconciles
 * the `Actor` the caller passed with the session the cookies actually carry.
 *
 * The mock treats `actor.userId` as the identity. Here the identity is
 * `auth.uid()`, and the two are independent inputs that CAN disagree. They
 * never should — every caller gets its actor from `getActor()`, which reads the
 * same cookies — so a disagreement is a bug, and this refuses rather than
 * guessing which one to believe. Silently preferring the JWT would let a caller
 * that meant to act as one user act as another; silently preferring the actor
 * would be worse still, since Postgres would ignore it and apply the JWT's
 * privileges anyway, making the code and the database disagree about who is
 * acting.
 */
async function openAuthedContext(actor: Actor): Promise<AuthedCtx> {
  // Same message and code as the mock's `requireActorId` for a null actor.
  const claimed = requireActorId(actor);
  const ctx = await openContext();

  if (ctx.userId === null) {
    throw new DataError('unauthorized', 'Your session is no longer valid. Please sign in again.');
  }
  if (ctx.userId !== claimed) {
    throw new DataError('forbidden', 'You do not have permission to do that.');
  }
  return { supabase: ctx.supabase, userId: ctx.userId };
}

/**
 * The actor's own profile row — this file's `resolveProfile()`.
 *
 * Read through `profiles_select_self`, so it is the database's answer about who
 * the actor is, not a cached copy. `role` and `coach_status` are re-read on
 * every call for exactly the reason `session.ts` refuses to put them in the
 * cookie: a promotion or a revocation must take effect on the next request.
 */
async function resolveProfile(ctx: AuthedCtx): Promise<Profile> {
  const { data, error } = await ctx.supabase.from('profiles').select('*').eq('id', ctx.userId).maybeSingle();
  if (error) throwDataError(error, true);
  if (!data) {
    // Authenticated against GoTrue but with no profile row. `handle_new_user()`
    // makes this close to impossible, and it is not a state to paper over.
    throw new DataError('unauthorized', 'Your session is no longer valid. Please sign in again.');
  }
  const profile = data as Profile;
  /*
   * A DELETED ACCOUNT IS NOT AUTHENTICATED. One line, and it closes every
   * actor-taking method to it at once.
   *
   * It matters more here than in the mock. `delete_my_account()` cannot touch
   * `auth.users` — the privileged role holds no USAGE on that schema — so the
   * GoTrue user survives the RPC and is banned separately by
   * `src/lib/auth/account-deletion.ts`. A ban stops NEW tokens; it cannot
   * recall one already issued. This is what closes the application during that
   * window, and RLS on a direct PostgREST call is what remains open.
   *
   * The same sentence as a missing profile, so the two cannot be told apart by
   * whoever is holding the cookie.
   */
  if (profile.deleted_at !== null) {
    throw new DataError('unauthorized', 'Your session is no longer valid. Please sign in again.');
  }
  return profile;
}

/** Mirrors `requireAdmin()` in the mock, and `public.is_admin()` in SQL. */
async function requireAdminProfile(ctx: AuthedCtx): Promise<Profile> {
  const profile = await resolveProfile(ctx);
  if (profile.role !== 'admin') {
    throw new DataError('forbidden', 'Only an administrator can do that.');
  }
  return profile;
}

/** Mirrors `requireApprovedCoach()` in the mock, and `public.is_approved_coach()`. */
async function requireApprovedCoachProfile(ctx: AuthedCtx): Promise<Profile> {
  const profile = await resolveProfile(ctx);
  if (profile.coach_status !== 'approved') {
    throw new DataError(
      'forbidden',
      'Only approved coaches can publish offers. Apply to coach or redeem an invite code first.',
    );
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Joins.
//
// PostgREST resource embedding is deliberately NOT used to attach display
// names. Embedding `profiles` would apply that table's RLS, which has no anon
// policy at all, so every visitor would see "Unknown coach" on every card;
// embedding the `public_profiles` VIEW depends on PostgREST inferring a foreign
// key through a view, which is version-dependent behaviour to hang a public
// page on. Two explicit queries and a Map are boring, predictable, and read the
// same view the SQL mapping table says they should.
//
// `displayNamesFor` was `coachNamesFor` until the moderation reads needed it:
// it resolves ANY user id through `public_profiles`, and review authors are
// learners. The name was describing its first caller rather than its job, which
// is how a reader ends up assuming a coach-only scope that was never there.
// ---------------------------------------------------------------------------

async function displayNamesFor(ctx: Ctx, userIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)].filter((id) => typeof id === 'string' && id !== '');
  if (unique.length === 0) return new Map();

  const { data, error } = await ctx.supabase.from('public_profiles').select('id, full_name').in('id', unique);
  if (error) throwDataError(error, ctx.userId !== null);

  const names = new Map<string, string>();
  for (const row of (data ?? []) as { id: string; full_name: string }[]) {
    names.set(row.id, row.full_name);
  }
  return names;
}

function toListingWithCoach(row: ListingRow, names: Map<string, string>): ListingWithCoach {
  return {
    id: row.id,
    coach_id: row.coach_id,
    title: row.title,
    description: row.description,
    price_cents: row.price_cents,
    category: row.category,
    price_epoch: row.price_epoch,
    deleted_at: row.deleted_at,
    fulfilment: row.fulfilment,
    created_at: row.created_at,
    updated_at: row.updated_at,
    coach_name: names.get(row.coach_id) ?? UNKNOWN_COACH,
  };
}

async function withCoachNames(ctx: Ctx, rows: readonly ListingRow[]): Promise<ListingWithCoach[]> {
  const names = await displayNamesFor(ctx, rows.map((row) => row.coach_id));
  return rows.map((row) => toListingWithCoach(row, names));
}

async function withCoachName(ctx: Ctx, row: ListingRow): Promise<ListingWithCoach> {
  const [only] = await withCoachNames(ctx, [row]);
  return only;
}

/**
 * Resolves order rows into `OrderWithListing`.
 *
 * NO `deleted_at` FILTER on the title lookup, deliberately — the same rule as
 * `listingTitle()` in the mock. Withdrawing an offer must not turn every past
 * purchase of it into "Unknown offer"; the row survives precisely so the title
 * still joins, and the buyer's own `listings_select_purchaser` policy (or the
 * coach's, or an admin's) is what makes it readable.
 *
 * `has_review` is a separate read of `reviews`, which is reachable here because
 * whoever may see the order may also see its review: the buyer through
 * `reviews_select_own_author`, the selling coach through
 * `reviews_select_own_coach`, an admin through `reviews_select_admin`.
 *
 * `fulfilment` rides along on the title lookup because it is a granted column
 * on `listings`. `asset_path` is NOT, and cannot be made one — so the third
 * query reads `public.entitled_offer_assets`, whose `auth.uid()` predicate
 * decides entitlement inside the view. There is no filter here to get wrong:
 * the query asks for every listing id on the orders and the VIEW returns rows
 * only for the ones this caller may download. An admin reading somebody else's
 * order gets nothing back, which is deliberate — see `OrderWithListing.asset_path`.
 */
async function withListingTitles(ctx: Ctx, orders: readonly Order[]): Promise<OrderWithListing[]> {
  if (orders.length === 0) return [];

  const listingIds = [...new Set(orders.map((o) => o.listing_id))];
  const orderIds = orders.map((o) => o.id);
  const hasSession = ctx.userId !== null;

  const [titlesResult, reviewsResult, assetsResult] = await Promise.all([
    ctx.supabase.from('listings').select('id, title, fulfilment').in('id', listingIds),
    ctx.supabase.from('reviews').select('order_id').in('order_id', orderIds),
    ctx.supabase.from('entitled_offer_assets').select(ENTITLED_ASSET_COLUMNS).in('listing_id', listingIds),
  ]);

  if (titlesResult.error) throwDataError(titlesResult.error, hasSession);
  if (reviewsResult.error) throwDataError(reviewsResult.error, hasSession);
  if (assetsResult.error) throwDataError(assetsResult.error, hasSession);

  const titles = new Map<string, string>();
  const modes = new Map<string, FulfilmentMode>();
  for (const row of (titlesResult.data ?? []) as ListingTitleRow[]) {
    titles.set(row.id, row.title);
    modes.set(row.id, row.fulfilment);
  }
  const reviewed = new Set(
    ((reviewsResult.data ?? []) as { order_id: string }[]).map((row) => row.order_id),
  );
  const assets = new Map<string, string>();
  for (const row of (assetsResult.data ?? []) as { listing_id: string; asset_path: string }[]) {
    assets.set(row.listing_id, row.asset_path);
  }

  return orders.map((order) => ({
    ...order,
    listing_title: titles.get(order.listing_id) ?? UNKNOWN_LISTING,
    has_review: reviewed.has(order.id),
    // The column DEFAULT is the fallback, not the mode with a file: an order
    // whose listing did not come back must never be rendered as a download
    // waiting to be collected.
    listing_fulfilment: modes.get(order.listing_id) ?? 'personalised',
    asset_path: assets.get(order.listing_id) ?? null,
  }));
}

/**
 * Coach headlines by id, for the moderation queue's coach reports.
 *
 * Reads `public_coaches`, which projects the headline and no email — the same
 * rule every other name lookup here follows. A suspended coach is absent from
 * that view, so the caller falls back to "No headline."; that is correct rather
 * than unfortunate, since by then the queue is showing a coach who has already
 * been acted on.
 */
async function coachHeadlinesFor(ctx: Ctx, coachIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(coachIds)].filter((id) => typeof id === 'string' && id !== '');
  if (unique.length === 0) return new Map();

  const { data, error } = await ctx.supabase
    .from('public_coaches')
    .select('id, coach_headline')
    .in('id', unique);
  if (error) throwDataError(error, ctx.userId !== null);

  const headlines = new Map<string, string>();
  for (const row of (data ?? []) as { id: string; coach_headline: string | null }[]) {
    if (row.coach_headline) headlines.set(row.id, row.coach_headline);
  }
  return headlines;
}

/** Mirrors the closed `public.report_reason` enum, shared with the mock's copy. */
function requireReportReason(value: unknown): ReportReason {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!isReportReason(trimmed)) {
    throw new DataError('invalid', 'Choose a reason from the list.');
  }
  return trimmed;
}

/**
 * PostgREST returns a function's composite result either bare or wrapped in an
 * array depending on the shape; every RPC here that returns a row needs the same
 * two lines, so they live in one place.
 */
function oneRow<T>(data: unknown, whenMissing: string): T {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new DataError('invalid', whenMissing);
  return row as T;
}

/**
 * The three lines every paginated read ends with: seek past the cursor, order by
 * the keyset, take one row more than asked for.
 *
 * Structurally typed rather than importing PostgREST's builder types, because
 * every one of them is generic over the table and the projection and naming them
 * here would mean repeating that generic signature at each call site. What the
 * constraint actually says is the whole contract: this runs BEFORE the query is
 * awaited, and `or` must still be available — so it has to be called on a filter
 * builder, not on something already ordered.
 *
 * BOTH `.order()` CALLS MATTER. The tie-break column is ordered as well as
 * filtered, and in the same direction: without it Postgres is free to return
 * rows sharing a `created_at` in any order it likes, and the cursor — which
 * names an exact row — then points into a list that has reshuffled underneath
 * it. That is the bug that shows up as one duplicated row every few pages.
 */
interface SeekableQuery<Q> {
  or(filter: string): Q;
  order(column: string, options: { ascending: boolean }): Q;
  limit(count: number): Q;
}

/** What PostgREST hands back on failure. Structural, so no client type is imported. */
interface PostgrestErrorLike {
  code?: string;
  message: string;
}

function seek<Q extends SeekableQuery<Q>>(
  query: Q,
  spec: KeysetSpec,
  cursor: Keyset | null,
  limit: number,
): Q {
  const seeked = cursor ? query.or(supabaseKeysetFilter(spec, cursor)) : query;
  const ascending = supabaseAscending(spec);
  return seeked
    .order(spec.column, { ascending })
    .order(tieBreakColumn(spec), { ascending })
    .limit(limit + 1);
}

/**
 * The options every paginated `.select()` takes, so `runPaged` can build the
 * same query twice — once for rows, once for a count with no rows attached.
 */
type CountOptions = { count: 'exact'; head?: boolean };

/**
 * One page of rows, plus a count of the WHOLE list.
 *
 * =============================================================================
 * WHY THIS TAKES A BUILDER RATHER THAN A BUILT QUERY
 * =============================================================================
 * PostgREST's `count=exact` counts the query AS FILTERED, and the keyset is a
 * filter. So on page two `count` comes back as "rows after the cursor" — 2,
 * where the mock says 26 — while `Page.total` is documented as ignoring the
 * cursor, which is what the pager's "24 of 40" and every queue's tab count
 * depend on.
 *
 * THE TWO BACKENDS DISAGREED FOR EXACTLY AS LONG AS THE LIVE DATABASE WAS
 * EMPTY. An empty table answers `[]` and `0` from both, so no mock suite and no
 * assertion against an empty project could see it. It surfaced the first time a
 * real coach profile held more than a page of offers, as a heading reading
 * "2 offers" above a list of twenty-six.
 *
 * So the filters arrive as a CLOSURE and are built twice: once with the keyset
 * for the rows, once without it for the count.
 *
 * **The second request is only made when there IS a cursor.** On page one the
 * keyset adds no predicate, so the count that came back beside the rows is
 * already the whole-list count — the common case, and it costs nothing. Later
 * pages pay one extra round trip, as a `head` request: PostgREST answers with a
 * count in a header and no body at all.
 */
type PagedResult = { data: unknown; error: PostgrestErrorLike | null; count: number | null };

async function runPaged<Q extends SeekableQuery<Q>>(
  build: (options: CountOptions) => Q,
  spec: KeysetSpec,
  cursor: Keyset | null,
  limit: number,
): Promise<PagedResult> {
  const rows = (await seek(build({ count: 'exact' }), spec, cursor, limit)) as unknown as PagedResult;

  // Page one, or a failed read: the count beside the rows is already right, and
  // a second request would only produce a second error to swallow.
  if (cursor === null || rows.error) {
    return { data: rows.data, error: rows.error, count: rows.count ?? null };
  }

  const counted = (await build({ count: 'exact', head: true })) as unknown as PagedResult;
  return {
    data: rows.data,
    error: rows.error,
    // A failed COUNT is not a failed READ. `Page.total` is nullable exactly so
    // that "we could not count" has somewhere to go other than a wrong number.
    count: counted.error ? null : (counted.count ?? null),
  };
}

/**
 * `count: 'exact'` comes back as `number | null` — null when PostgREST did not
 * compute one. `Page.total` carries that null through rather than flattening it
 * to 0, because "no rows" and "not counted" are different sentences and a caller
 * rendering "0 offers" over a full page would be a bug nobody could see.
 */
function totalOf(count: number | null | undefined): number | null {
  return typeof count === 'number' ? count : null;
}

/** The narrow listing projection `withListingTitles` reads. Both columns are granted. */
interface ListingTitleRow {
  id: string;
  title: string;
  fulfilment: FulfilmentMode;
}

/**
 * Offer titles by id, for the moderation reads.
 *
 * NO `deleted_at` FILTER, the same rule `withListingTitles` follows and for the
 * same reason: a withdrawn offer's reviews still exist, and a moderator who
 * could not see one could not act on it. An admin reads past the public policy
 * through `listings_select_admin` anyway.
 */
async function listingTitlesFor(ctx: Ctx, listingIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(listingIds)].filter((id) => typeof id === 'string' && id !== '');
  if (unique.length === 0) return new Map();

  const { data, error } = await ctx.supabase.from('listings').select('id, title').in('id', unique);
  if (error) throwDataError(error, ctx.userId !== null);

  const titles = new Map<string, string>();
  for (const row of (data ?? []) as { id: string; title: string }[]) titles.set(row.id, row.title);
  return titles;
}

// ---------------------------------------------------------------------------
// Auth error translation.
//
// GoTrue errors are not Postgres errors and do not carry a SQLSTATE, so
// `errors.ts` cannot map them. They get their own small translation here.
// ---------------------------------------------------------------------------

interface AuthLikeError {
  code?: string;
  status?: number;
  message?: string;
}

/** True when GoTrue is telling us the address is already registered. */
function isAlreadyRegistered(error: AuthLikeError): boolean {
  const code = error.code ?? '';
  if (code === 'user_already_exists' || code === 'email_exists') return true;
  return /already\s+registered|already\s+exists/i.test(error.message ?? '');
}

/** True when the failure is simply "those credentials are wrong". */
function isInvalidCredentials(error: AuthLikeError): boolean {
  const code = error.code ?? '';
  if (code === 'invalid_credentials') return true;
  return /invalid\s+login\s+credentials/i.test(error.message ?? '');
}

/**
 * GoTrue's own messages ("Password should be at least 6 characters",
 * "Email rate limit exceeded") are written for end users and are worth keeping.
 * They are still length-capped and screened for anything that looks like
 * internals, on the same fail-safe principle as `errors.ts`.
 */
function authMessage(error: AuthLikeError, fallback: string): string {
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  if (message === '' || message.length > 200) return fallback;
  if (/database|sql|postgres|schema|relation|constraint|token|jwt/i.test(message)) return fallback;
  return message;
}

// ---------------------------------------------------------------------------

export class SupabaseDataClient implements DataClient {
  // -------------------------------------------------------------------------
  // Auth-shaped
  // -------------------------------------------------------------------------

  /**
   * Creates the account. The `public.profiles` row is NOT written here — the
   * `on_auth_user_created` trigger writes it from `raw_user_meta_data`, which is
   * why `full_name` goes into `options.data` under exactly that key.
   *
   * THIS PROJECT MUST HAVE EMAIL CONFIRMATION TURNED OFF. With it on, GoTrue
   * returns a user but no session, the account cannot be read back (no session
   * means `profiles_select_self` matches nothing), and `auth/actions.ts` would
   * redirect a still-anonymous visitor to `/offers`. That is detected below and
   * turned into a sentence the user can act on rather than a silent no-op — but
   * the supported configuration is confirmation off, because nothing in this
   * app implements a confirmation callback route. See `supabase/README.md`.
   */
  async signUp(input: SignUpInput): Promise<SignUpResult> {
    const email = requireEmail(input?.email);
    const fullName = requireText(input?.fullName, 'Full name', 120, 2);
    // NOT requireText: a password is never trimmed — see requirePassword.
    const password = requirePassword(input?.password);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        /*
         * WHERE THE CONFIRMATION LINK LANDS. Without this GoTrue uses the
         * project's Site URL — `https://javelin-hub.vercel.app/` — where
         * nothing exchanges the code, so the link would sign nobody in.
         *
         * Built from `siteUrl()`, never from the request: the same rule the
         * reset link follows, and for the same reason. A `Host` header must not
         * decide where a link we email points.
         *
         * `next` is explicit rather than relying on the callback's default,
         * which is `/reset-password` — the right fallback for the flow that
         * matters most, and the wrong destination for this one.
         */
        emailRedirectTo: `${siteUrl()}${AUTH_CALLBACK_PATH}?next=${encodeURIComponent('/offers?welcome=1')}`,
      },
    });

    if (error) {
      const authError = error as AuthLikeError;
      if (isAlreadyRegistered(authError)) {
        throw new DataError('conflict', 'An account with that email already exists.');
      }
      throw new DataError('invalid', authMessage(authError, 'That account could not be created.'));
    }

    // With Supabase's email-enumeration protection enabled — it is, by default —
    // signing up with an address that already exists does NOT error. GoTrue
    // returns a decoy user with an EMPTY `identities` array instead, so that an
    // attacker cannot use this endpoint to test which addresses are registered.
    // The mock reports a conflict here, and a real user retrying their own
    // address deserves to be told; `identities.length === 0` is the documented
    // way to tell the decoy apart from a genuine new account.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new DataError('conflict', 'An account with that email already exists.');
    }

    if (!data.user) {
      throw new DataError('invalid', 'That account could not be created.');
    }

    /*
     * NO SESSION IS A SUCCESS, not a failure, and this used to throw.
     *
     * With confirmation on, GoTrue creates the user, sends the mail and returns
     * no session — which is the whole point of confirmation. Reporting it as
     * `DataError('invalid')` rendered a red "something went wrong" over a
     * signup that had entirely worked, and left the user with no idea an email
     * was on its way.
     *
     * There is no profile to return either: the row exists (the
     * `handle_new_user` trigger wrote it) but reading it needs an authenticated
     * context, and there is deliberately no session yet.
     */
    if (!data.session) {
      return { status: 'confirm_email', email };
    }

    const profile = await this.getProfile({ userId: data.user.id }, data.user.id);
    if (!profile) {
      throw new DataError('invalid', 'That account could not be created.');
    }
    return { status: 'signed_in', profile };
  }

  /**
   * Returns `null` for BOTH "no such account" and "wrong password" — never a
   * throw that distinguishes them. `auth/actions.ts` renders one message for
   * both, because anything finer turns this form into an account-enumeration
   * oracle.
   *
   * An unconfirmed email lands here too, and is also `null`. Telling the user
   * "confirm your email first" would be friendlier and would leak exactly what
   * the paragraph above exists to prevent — that the address is registered. The
   * supported configuration has confirmation off (see `signUp`), so the case
   * should not arise; when it does, silence is the safer half of the trade.
   */
  async signInWithPassword(input: SignInInput): Promise<Profile | null> {
    if (typeof input?.email !== 'string' || typeof input?.password !== 'string') return null;
    const email = input.email.trim().toLowerCase();
    if (email === '') return null;

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: input.password });

    if (error) {
      const authError = error as AuthLikeError;
      if (isInvalidCredentials(authError) || authError.status === 400) return null;
      if (authError.code === 'email_not_confirmed') return null;
      throw new DataError('invalid', authMessage(authError, 'You could not be signed in.'));
    }

    if (!data.user) return null;

    const profile = await this.getProfile({ userId: data.user.id }, data.user.id);
    /*
     * A DELETED ACCOUNT CANNOT SIGN IN, belt to the ban's braces.
     *
     * `banAuthUser` is what normally stops this, and it is the real mechanism —
     * GoTrue refuses the credential before we ever see it. But that call can
     * fail: the service-role key is deliberately blank in the example
     * environment, so a deployment that never set it lands here with a live
     * credential and an anonymised profile.
     *
     * `null`, not a throw, and the caller renders "Invalid email or password" —
     * indistinguishable from a wrong password, so the form does not become an
     * oracle for which accounts have been deleted.
     */
    if (profile?.deleted_at) return null;
    return profile;
  }

  /** The batch form of `getPublicProfile`. One read for a whole grid. */
  async listPublicProfiles(userIds: readonly string[]): Promise<PublicProfile[]> {
    const unique = [...new Set(userIds)].filter((id) => typeof id === 'string' && id !== '');
    if (unique.length === 0) return [];

    const ctx = await openPublicContext();
    const { data, error } = await ctx.supabase
      .from('public_profiles')
      .select('id, full_name, is_approved_coach, avatar_path')
      .in('id', unique);
    if (error) {
      // One malformed id in the batch would fail the whole read. An empty
      // result is the honest answer: none of these ids resolved.
      if (isMalformedId(error)) return [];
      throwDataError(error, ctx.userId !== null);
    }
    return (data ?? []) as PublicProfile[];
  }

  /**
   * Replaces the signed-in user's password through GoTrue.
   *
   * `auth.updateUser` acts on WHOEVER THE REQUEST'S JWT NAMES and takes no user
   * id, which is the same property the mock gets by resolving the actor: there
   * is no shape of this call that rewrites somebody else's credentials. The
   * `actor` argument is therefore not passed on — it is checked, so that a
   * caller with no session gets `unauthorized` here rather than a GoTrue error
   * about a missing token.
   *
   * The length rule is applied through the shared validator BEFORE the call, so
   * that both backends refuse a short password with the same sentence. GoTrue
   * has its own minimum (a project setting, 6 by default) and may still refuse
   * something this accepts; `authMessage` passes that sentence through, since
   * it is written for end users.
   */
  async updateMyPassword(actor: Actor, newPassword: string): Promise<void> {
    const password = requirePassword(newPassword);
    const ctx = await openAuthedContext(actor);

    const { error } = await ctx.supabase.auth.updateUser({ password });
    if (error) {
      const authError = error as AuthLikeError;
      // GoTrue's "New password should be different from the old password."
      // arrives here, and it is worth showing rather than replacing.
      throw new DataError('invalid', authMessage(authError, 'Your password could not be changed.'));
    }
  }

  async getProfile(actor: Actor, userId: string): Promise<Profile | null> {
    if (typeof userId !== 'string' || userId === '') return null;
    const ctx = await openAuthedContext(actor);

    // Mirrors `profiles_select_self` + `profiles_select_admin`. Checked here as
    // well as in SQL because RLS expresses a refusal as ZERO ROWS, and the mock
    // throws `forbidden`. Without this, asking for somebody else's profile
    // would quietly return `null` — "no such user" — instead of "not yours".
    if (ctx.userId !== userId) {
      const actorProfile = await resolveProfile(ctx);
      if (actorProfile.role !== 'admin') {
        throw new DataError('forbidden', 'You can only view your own profile.');
      }
    }

    const { data, error } = await ctx.supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) {
      if (isMalformedId(error)) return null;
      throwDataError(error, true);
    }
    return (data as Profile | null) ?? null;
  }

  async getPublicProfile(userId: string): Promise<PublicProfile | null> {
    if (typeof userId !== 'string' || userId === '') return null;
    const ctx = await openPublicContext();

    const { data, error } = await ctx.supabase
      .from('public_profiles')
      .select('id, full_name, is_approved_coach, avatar_path')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      if (isMalformedId(error)) return null;
      throwDataError(error, ctx.userId !== null);
    }
    return (data as PublicProfile | null) ?? null;
  }

  // -------------------------------------------------------------------------
  // The public coach directory
  // -------------------------------------------------------------------------

  async listCoaches(filter?: CoachDirectoryFilter, page?: PageRequest): Promise<Page<PublicCoach>> {
    const q = typeof filter?.q === 'string' ? filter.q.trim() : '';
    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.coaches, page?.cursor);
    const ctx = await openPublicContext();

    // The approval predicate lives INSIDE public_coaches, so there is nothing
    // to filter on here and no way for a caller to widen the result.
    // Unrepresentable term (it contains `*`). Return NOTHING rather than
    // dropping the filter — an unexpressible search must not become a broader
    // one. See `escapeLike`.
    const namePattern = q === '' ? null : likePattern(q);
    if (q !== '' && namePattern === null) return emptyPage();

    const build = (opts: CountOptions) => {
      const query = ctx.supabase
        .from('public_coaches')
        .select(`${PUBLIC_COACH_COLUMNS}, created_at`, opts);
      return namePattern === null ? query : query.ilike('full_name', namePattern);
    };

    // `created_at` exists on the view for this ordering only (0003). It is now
    // SELECTED as well as ordered on, because the cursor is built from it — and
    // then dropped again below, so `PublicCoach` stays exactly its five columns.
    const { data, error, count } = await runPaged(build, KEYSETS.coaches, cursor, limit);
    if (error) throwDataError(error, ctx.userId !== null);

    const rows = (data ?? []) as (PublicCoach & { created_at: string })[];
    const window = windowOf(KEYSETS.coaches, rows, limit, byCreatedAt, totalOf(count));
    // `created_at` is selected for the keyset and dropped here, so `PublicCoach`
    // stays exactly the five columns `public_coaches` publishes.
    return pageOf(
      window,
      window.rows.map((row) => ({
        id: row.id,
        full_name: row.full_name,
        coach_headline: row.coach_headline,
        coach_bio: row.coach_bio,
        coach_years_coaching: row.coach_years_coaching,
        avatar_path: row.avatar_path,
      })),
    );
  }

  async getPublicCoach(coachId: string): Promise<PublicCoach | null> {
    if (typeof coachId !== 'string' || coachId === '') return null;
    const ctx = await openPublicContext();

    // A non-approved id simply matches no row here, which is deliberately
    // indistinguishable from an id that does not exist.
    const { data, error } = await ctx.supabase
      .from('public_coaches')
      .select(PUBLIC_COACH_COLUMNS)
      .eq('id', coachId)
      .maybeSingle();
    if (error) {
      if (isMalformedId(error)) return null;
      throwDataError(error, ctx.userId !== null);
    }
    return (data as PublicCoach | null) ?? null;
  }

  async updateMyCoachProfile(actor: Actor, input: UpdateMyCoachProfileInput): Promise<Profile> {
    const headline = optionalText(input?.coach_headline, 'Headline', COACH_HEADLINE_MAX);
    const bio = optionalText(input?.coach_bio, 'Bio', COACH_BIO_MAX);
    const years = optionalYears(input?.coach_years_coaching);

    const ctx = await openAuthedContext(actor);
    const profile = await resolveProfile(ctx);
    if (profile.coach_status !== 'approved') {
      throw new DataError('forbidden', 'Only approved coaches have a public coach profile to edit.');
    }

    // Writes ONLY the three coach columns. `role`, `coach_status`, `id`, `email`
    // and `full_name` are not in this object, and `guard_profile_privilege_columns`
    // would reject them if they were. The subject is `ctx.userId` — the resolved
    // actor — never a parameter, so this is not an admin edit path.
    const { data, error } = await ctx.supabase
      .from('profiles')
      .update({ coach_headline: headline, coach_bio: bio, coach_years_coaching: years })
      .eq('id', ctx.userId)
      .select('*')
      .maybeSingle();
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('not_found', 'Your profile could not be found.');
    return data as Profile;
  }

  // -------------------------------------------------------------------------
  // Listings
  // -------------------------------------------------------------------------

  /**
   * Renames the actor. `profiles_update_own` is the policy; there is no guard to
   * satisfy, because `guard_profile_privilege_columns` deliberately leaves
   * `full_name` alone as content rather than privilege.
   *
   * `.eq('id', ctx.userId)` and not an id from input: the policy would refuse
   * anything else, and writing it this way means the refusal is never reached.
   */
  async updateMyProfile(actor: Actor, input: UpdateMyProfileInput): Promise<Profile> {
    const fullName = requireText(input?.full_name, 'Full name', 120, 2);
    const ctx = await openAuthedContext(actor);

    const { data, error } = await ctx.supabase
      .from('profiles')
      .update({ full_name: fullName })
      .eq('id', ctx.userId)
      .select('*')
      .maybeSingle();
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('unauthorized', 'Your session is no longer valid. Please sign in again.');
    return data as Profile;
  }

  /**
   * Verifies the current password, then writes the new one.
   *
   * GOTRUE HAS NO "CHECK THIS PASSWORD" ENDPOINT, so the verification is a real
   * `signInWithPassword` for the same address. Two consequences worth knowing:
   * it rotates this session's tokens before `updateUser` rotates them again,
   * which is harmless because it is the same user; and it consumes GoTrue's own
   * auth rate limit, which is a second reason the caller limits this before it
   * gets here.
   *
   * The address comes from the RESOLVED PROFILE, never from input — otherwise
   * this method would be a password oracle for any address a caller cared to
   * name.
   */
  async changeMyPassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
    const next = requirePassword(newPassword);
    const ctx = await openAuthedContext(actor);
    const profile = await resolveProfile(ctx);

    if (typeof currentPassword !== 'string' || currentPassword === '') {
      throw new DataError('forbidden', 'That is not your current password.');
    }

    const { error: signInError } = await ctx.supabase.auth.signInWithPassword({
      email: profile.email,
      password: currentPassword,
    });
    if (signInError) {
      const authError = signInError as AuthLikeError;
      if (isInvalidCredentials(authError) || authError.status === 400) {
        throw new DataError('forbidden', 'That is not your current password.');
      }
      throw new DataError('invalid', authMessage(authError, 'Your password could not be changed.'));
    }

    const { error } = await ctx.supabase.auth.updateUser({ password: next });
    if (error) {
      // "New password should be different from the old password." arrives here
      // and is worth showing; the mock raises the same refusal in its own words.
      throw new DataError('invalid', authMessage(error as AuthLikeError, 'Your password could not be changed.'));
    }
  }

  /**
   * Asks GoTrue to start an email change. **Nothing has changed when this
   * returns**, which is why the result is a union and not a `Profile`.
   *
   * With "Secure email change" on — the default, and the configuration this
   * project runs — GoTrue mails BOTH the current address and the new one, and
   * applies the change only when both links are followed. That is the property
   * worth having: a single-step change is exactly how somebody holding a
   * borrowed session moves an account to their own inbox, and the old address
   * getting a say is what stops it.
   *
   * `emailRedirectTo` points both links at `/auth/callback`, for the same reason
   * `signUp` does: without it GoTrue uses the project Site URL, where nothing
   * exchanges the code and the link signs nobody in.
   *
   * **`profiles.email` is NOT written here, and must not be.**
   * `guard_profile_privilege_columns` refuses it from any API session; the
   * `0017` trigger copies it across when GoTrue eventually applies the change,
   * which is the only moment it is true. Writing it optimistically here would
   * name an address the account cannot yet sign in with.
   */
  async requestEmailChange(actor: Actor, newEmail: string): Promise<EmailChangeResult> {
    const email = requireEmail(newEmail);
    const ctx = await openAuthedContext(actor);
    const profile = await resolveProfile(ctx);

    if (profile.email === email) {
      throw new DataError('invalid', 'That is already your email address.');
    }

    const { error } = await ctx.supabase.auth.updateUser(
      { email },
      { emailRedirectTo: `${siteUrl()}${AUTH_CALLBACK_PATH}?next=${encodeURIComponent('/settings?email=changed')}` },
    );

    if (error) {
      const authError = error as AuthLikeError;
      if (isAlreadyRegistered(authError)) {
        throw new DataError('conflict', 'Another account already uses that email address.');
      }
      throw new DataError('invalid', authMessage(authError, 'That address could not be used.'));
    }

    /*
     * ALWAYS `confirm_email`, even though GoTrue may have quietly done nothing.
     *
     * With email-enumeration protection on, asking to move to an address that
     * already belongs to somebody else succeeds here and simply sends no mail —
     * so this method cannot tell "a link is on its way" from "that address is
     * taken" without becoming the oracle that protection exists to prevent. The
     * mock CAN tell, and does, because its check is local; the divergence is
     * recorded in `supabase/README.md`.
     *
     * The honest answer to the user is the same either way: check both inboxes.
     */
    return { status: 'confirm_email', email };
  }

  /**
   * Anonymises the caller's own profile through `public.delete_my_account()`.
   *
   * AN RPC AND NOT AN UPDATE, because the write it performs is one no client
   * role is allowed to make: it sets `role` and `coach_status`, which
   * `guard_profile_privilege_columns` refuses from any API session, and it
   * clears `email`, which that same guard pins. A SECURITY DEFINER function is
   * the only shape that can do it, and it takes no id — the subject is
   * `jwt_uid()` and cannot be forged.
   *
   * `resolveProfile` is deliberately NOT called first. It now refuses a deleted
   * account, so calling it here would make a retry fail rather than succeed
   * quietly, and the RPC is already idempotent.
   */
  async deleteMyAccount(actor: Actor): Promise<void> {
    const ctx = await openAuthedContext(actor);

    const { error } = await ctx.supabase.rpc('delete_my_account');
    if (error) {
      // Both refusals arrive here wearing their own sentences — "Take your
      // offers off sale before deleting your account." (22023) and "An
      // administrator account is removed by another administrator." (42501) —
      // and `errors.ts` passes them through because neither looks internal.
      throwDataError(error, true);
    }
  }

  async setMyAvatar(actor: Actor, path: string | null): Promise<Profile> {
    const next = optionalAvatarPath(path);

    const ctx = await openAuthedContext(actor);

    // Checked here for the message, pinned in SQL for the guarantee: the
    // `profiles_avatar_path_shape` CHECK would refuse this too, as 23514, which
    // `errors.ts` has to render as something generic.
    if (next !== null && !next.startsWith(`${ctx.userId}/`)) {
      throw new DataError('forbidden', 'An avatar has to be stored under your own account.');
    }

    const { data, error } = await ctx.supabase
      .from('profiles')
      .update({ avatar_path: next })
      .eq('id', ctx.userId)
      .select('*')
      .maybeSingle();
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('not_found', 'Your profile could not be found.');
    return data as Profile;
  }

  async listListings(filter?: ListingFilter, page?: PageRequest): Promise<Page<ListingWithCoach>> {
    const q = typeof filter?.q === 'string' ? filter.q.trim() : '';
    const rawCategory = typeof filter?.category === 'string' ? filter.category.trim() : '';
    const category: ListingCategory | null = isListingCategory(rawCategory) ? rawCategory : null;

    // An out-of-taxonomy category matches nothing. Returning early also avoids
    // sending it to Postgres, where comparing it against the enum would be a
    // cast error (22P02) rather than an empty result.
    if (rawCategory !== '' && category === null) return emptyPage();

    // The keyset follows the sort, and each sort has its own `scope` — so a
    // cursor minted while browsing newest-first is refused after switching to
    // cheapest-first and the reader starts from the top. Position 24 means a
    // different row in each ordering.
    const sort = isListingSort(filter?.sort) ? filter.sort : 'newest';
    const spec =
      sort === 'newest'
        ? KEYSETS.listings
        : sort === 'price_asc'
          ? KEYSETS.listingsPriceAsc
          : KEYSETS.listingsPriceDesc;
    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(spec, page?.cursor);

    const ctx = await openPublicContext();

    // Assembled once as a closure so `runPaged` can run the same filters twice —
    // with the keyset for the rows, without it for the count. See `runPaged`.
    const searchPattern = q === '' ? null : likePattern(q);
    // Unrepresentable term — see `escapeLike`. Narrow to nothing.
    if (q !== '' && searchPattern === null) return emptyPage();

    const build = (opts: CountOptions) => {
      let query = ctx.supabase.from('listings').select(LISTING_COLUMNS, opts).is('deleted_at', null);

      if (category) query = query.eq('category', category);
      // Inclusive bounds. An inverted pair matches nothing rather than being
      // silently swapped — somebody who typed them the wrong way round should
      // see that, not results for a question they did not ask.
      if (typeof filter?.minPriceCents === 'number' && Number.isFinite(filter.minPriceCents)) {
        query = query.gte('price_cents', Math.max(0, Math.floor(filter.minPriceCents)));
      }
      if (typeof filter?.maxPriceCents === 'number' && Number.isFinite(filter.maxPriceCents)) {
        query = query.lte('price_cents', Math.max(0, Math.floor(filter.maxPriceCents)));
      }
      if (searchPattern !== null) {
        // Title + description only, matching the trigram indexes in 0001 and
        // the mock. Never the coach name: that would make the offer search an
        // enumerator for people.
        const pattern = quoteForOr(searchPattern);
        query = query.or(`title.ilike.${pattern},description.ilike.${pattern}`);
      }

      return query;
    };

    const { data, error, count } = await runPaged(build, spec, cursor, limit);
    if (error) throwDataError(error, ctx.userId !== null);

    const window = windowOf(
      spec,
      (data ?? []) as ListingRow[],
      limit,
      sort === 'newest'
        ? byCreatedAt
        : (row) => ({ key: String(row.price_cents), id: row.id }),
      totalOf(count),
    );
    // Named AFTER the window, so the extra row fetched to detect a next page is
    // never given a coach name nobody will read.
    return pageOf(window, await withCoachNames(ctx, window.rows));
  }

  async getListing(id: string): Promise<ListingWithCoach | null> {
    if (typeof id !== 'string' || id === '') return null;
    const ctx = await openPublicContext();

    const { data, error } = await ctx.supabase
      .from('listings')
      .select(LISTING_COLUMNS)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      if (isMalformedId(error)) return null;
      throwDataError(error, ctx.userId !== null);
    }
    if (!data) return null;
    return withCoachName(ctx, data as ListingRow);
  }

  /**
   * Every listing of one coach, withdrawn included.
   *
   * `requireAdminProfile` runs first because `listings_select_admin` renders a
   * refusal as ZERO ROWS overlapping `listings_select_public` — without it, a
   * coach asking about a rival would get that rival's published offers back and
   * read the empty withdrawn set as "they have none". Same construction, same
   * reason, as `listReports`.
   */
  async listListingsForAdmin(
    actor: Actor,
    coachId: string,
    page?: PageRequest,
  ): Promise<Page<ListingWithCoach>> {
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);
    if (typeof coachId !== 'string' || coachId === '') return emptyPage();

    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.adminListings, page?.cursor);

    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase
        .from('listings')
        .select(LISTING_COLUMNS, opts)
        .eq('coach_id', coachId),
      KEYSETS.adminListings,
      cursor,
      limit,
    );
    if (error) {
      if (isMalformedId(error)) return emptyPage();
      throwDataError(error, true);
    }

    const window = windowOf(
      KEYSETS.adminListings,
      (data ?? []) as ListingRow[],
      limit,
      byCreatedAt,
      totalOf(count),
    );
    return pageOf(window, await withCoachNames(ctx, window.rows));
  }

  /**
   * The entitlement table in {@link ListingDetail} is enforced by RLS alone, and
   * this method is deliberately thin because of it: `listings_select_public`
   * returns the row to anyone while it is published, and
   * `listings_select_own_coach` / `listings_select_purchaser` /
   * `listings_select_admin` return it after withdrawal to exactly the coach, a
   * holder of an order for it, and an admin. So a visible row with a non-null
   * `deleted_at` IS the proof of entitlement, and no row means 404.
   *
   * A stranger gets `null`, never `forbidden` — a refusal would confirm that a
   * withdrawn offer once existed at that id.
   */
  async getListingForViewer(actor: Actor, id: string): Promise<ListingDetail | null> {
    if (typeof id !== 'string' || id === '') return null;

    // Anonymous is not an error here, so the actor is unwrapped rather than
    // required — and it is not otherwise used: `auth.uid()` in the policies is
    // the actual subject.
    void optionalActorId(actor);
    const ctx = await openContext();

    const { data, error } = await ctx.supabase
      .from('listings')
      .select(LISTING_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      if (isMalformedId(error)) return null;
      throwDataError(error, ctx.userId !== null);
    }
    if (!data) return null;

    const row = data as ListingRow;
    const listing = await withCoachName(ctx, row);
    if (row.deleted_at === null) return { state: 'published', listing };
    return { state: 'withdrawn', listing, withdrawn_at: row.deleted_at };
  }

  async listCategories(): Promise<ListingCategory[]> {
    // Reads no rows. The taxonomy is the `public.listing_category` enum, whose
    // declaration order in 0001 is the display order; `LISTING_CATEGORIES`
    // restates it so the order does not depend on a round trip.
    return [...LISTING_CATEGORIES];
  }

  async listListingsByCoach(
    actor: Actor,
    coachId: string,
    page?: PageRequest,
  ): Promise<Page<ListingWithCoach>> {
    if (typeof coachId !== 'string' || coachId === '') return emptyPage();

    // A public read. The actor is never consulted, so this cannot be widened
    // into an owner view — the explicit `deleted_at is null` below is what
    // guarantees it, since a coach's own RLS policy would otherwise show them
    // their withdrawn offers through this path too.
    void actor;
    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.coachListings, page?.cursor);
    const ctx = await openPublicContext();

    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase
        .from('listings')
        .select(LISTING_COLUMNS, opts)
        .eq('coach_id', coachId)
        .is('deleted_at', null),
      KEYSETS.coachListings,
      cursor,
      limit,
    );
    if (error) {
      if (isMalformedId(error)) return emptyPage();
      throwDataError(error, ctx.userId !== null);
    }

    const window = windowOf(
      KEYSETS.coachListings,
      (data ?? []) as ListingRow[],
      limit,
      byCreatedAt,
      totalOf(count),
    );
    return pageOf(window, await withCoachNames(ctx, window.rows));
  }

  async listMyListings(actor: Actor, page?: PageRequest): Promise<Page<OwnedListing>> {
    const ctx = await openAuthedContext(actor);
    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.myListings, page?.cursor);

    // `public.owned_listings` (0003) is scoped to `auth.uid()` inside the view
    // and carries the derived `withdrawn_by_admin`. WITHDRAWN OFFERS INCLUDED —
    // this is the dashboard, and restoring one is the point.
    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase.from('owned_listings').select(OWNED_LISTING_COLUMNS, opts),
      KEYSETS.myListings,
      cursor,
      limit,
    );
    if (error) throwDataError(error, true);

    const window = windowOf(
      KEYSETS.myListings,
      (data ?? []) as OwnedListingRow[],
      limit,
      byCreatedAt,
      totalOf(count),
    );
    const rows = window.rows;
    const names = await displayNamesFor(ctx, rows.map((row) => row.coach_id));
    return pageOf(
      window,
      rows.map((row) => ({
      ...toListingWithCoach(row, names),
      withdrawn_by_admin: row.withdrawn_by_admin === true,
      // The owner's own path, handed back as the string rather than as a derived
      // boolean — the opposite treatment to `withdrawn_by_admin` beside it, and
      // deliberately so: this is the coach's own file and the editor needs the
      // key to replace or remove it. See `OwnedListing.asset_path`.
        asset_path: row.asset_path ?? null,
      })),
    );
  }

  async createListing(actor: Actor, input: CreateListingInput): Promise<ListingWithCoach> {
    const title = requireText(input?.title, 'Title', 140, 3);
    const description = requireText(input?.description, 'Description', 4000, 10);
    const category = requireListingCategory(input?.category);
    const priceCents = requirePriceCents(input?.price_cents);
    const fulfilment = optionalFulfilment(input?.fulfilment) ?? 'personalised';

    const ctx = await openAuthedContext(actor);
    const coach = await requireApprovedCoachProfile(ctx);

    // `coach_id` comes from the resolved actor, never from input — and
    // `listings_insert_approved_coach` pins it to `auth.uid()` regardless.
    // `price_epoch` and `deleted_at` take their column defaults (1, null).
    //
    // `asset_path` is NOT sent and there is no input that could supply one: the
    // `listings_asset_path_shape` CHECK pins it under the listing's own id,
    // which does not exist until this insert returns. Attaching the file is
    // `setListingAsset`, a second call — see CreateListingInput.
    const { data, error } = await ctx.supabase
      .from('listings')
      .insert({
        coach_id: coach.id,
        title,
        description,
        price_cents: priceCents,
        category,
        fulfilment,
      })
      .select(LISTING_COLUMNS)
      .maybeSingle();
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('invalid', 'That offer could not be created.');
    return withCoachName(ctx, data as ListingRow);
  }

  /**
   * Edits an offer.
   *
   * Owner only, NEVER an admin — the same asymmetry as the mock, and the reason
   * `guard_listing_update()` confines a non-owner to the `deleted_at` column.
   * A withdrawn offer can still be edited: refusing would leave a coach unable
   * to fix whatever got their offer taken down.
   *
   * The revision snapshot and the `price_epoch` bump are NOT written here.
   * `record_listing_revision()` and `guard_listing_update()` do both inside the
   * same statement, which is what makes them unskippable — in the mock they are
   * in the same `mutateDb`, and for the same reason. Do not add them here: the
   * trigger DERIVES `price_epoch`, so a value sent from the client is
   * overwritten, and a revision written from here would be a duplicate.
   */
  async updateListing(actor: Actor, listingId: string, input: UpdateListingInput): Promise<ListingWithCoach> {
    const id = requireText(listingId, 'Offer', 200);
    const title = requireText(input?.title, 'Title', 140, 3);
    const description = requireText(input?.description, 'Description', 4000, 10);
    const category = requireListingCategory(input?.category);
    const priceCents = requirePriceCents(input?.price_cents);
    // NULL MEANS "UNCHANGED" — see UpdateListingInput.fulfilment. A column that
    // is not sent is not written, so a caller that does not know about delivery
    // modes cannot silently reset one.
    const nextFulfilment = optionalFulfilment(input?.fulfilment);

    const ctx = await openAuthedContext(actor);
    const profile = await resolveProfile(ctx);

    const existing = await this.readListingRow(ctx, id);
    if (!existing) throw new DataError('not_found', 'That offer could not be found.');
    if (existing.coach_id !== profile.id) {
      throw new DataError('forbidden', 'Only the coach who published an offer can edit it.');
    }
    if (profile.coach_status !== 'approved') {
      throw new DataError('forbidden', 'Only approved coaches can edit an offer.');
    }

    const changingFulfilment = nextFulfilment !== null && nextFulfilment !== existing.fulfilment;

    // Switching to personalised must clear the path in the SAME statement, or
    // `listings_asset_path_shape` refuses the row: a personalised offer may not
    // hold an asset. Two statements would also be a window in which the offer
    // is personalised AND still pointing at a file every buyer could fetch.
    //
    // The refusal for an offer that has already been claimed is NOT pre-checked
    // here. `guard_listing_update()` raises it with a 42501 and a sentence
    // already written as end-user copy — "How this offer is delivered cannot
    // change once somebody has claimed it." — which `errors.ts` passes through.
    // Duplicating the `exists (select 1 from orders …)` test here would need a
    // read of every order on the listing, and would be a second copy of a rule
    // that must never differ from the trigger's.
    const patch: Record<string, unknown> = { title, description, price_cents: priceCents, category };
    if (changingFulfilment) {
      patch.fulfilment = nextFulfilment;
      if (nextFulfilment === 'personalised') patch.asset_path = null;
    }

    const { data, error } = await ctx.supabase
      .from('listings')
      .update(patch)
      .eq('id', id)
      .select(LISTING_COLUMNS)
      .maybeSingle();
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('not_found', 'That offer could not be found.');
    return withCoachName(ctx, data as ListingRow);
  }

  /**
   * Attaches or clears an instant offer's downloadable file. Owner only.
   *
   * THE PATH IS DATA, THE FILE IS STORAGE — the same split as `setMyAvatar`,
   * and the reason `src/lib/storage/deliverables.ts` is not part of
   * `DataClient`. This method writes one column and moves no bytes.
   *
   * Three pre-checks and then the write. As everywhere in this file, the
   * pre-checks exist to produce a SENTENCE; the database is what refuses. Each
   * is backed by something in SQL that would stop the write anyway:
   * `listings_update_own_coach` plus the content half of
   * `guard_listing_update()` for the first two, and
   * `listings_asset_path_shape` for the last two — which is also enforced a
   * third time by `offer_assets_write_coach` on the object itself.
   *
   * The row is read back from `public.owned_listings` rather than from the
   * UPDATE's own RETURNING, because `asset_path` is not a grantable column on
   * `public.listings` and naming it in a read of that table is a 42501. The
   * view is the only place a client may see it, and it is scoped to the owner —
   * who, by the time this line runs, is the caller.
   */
  async setListingAsset(actor: Actor, listingId: string, path: string | null): Promise<OwnedListing> {
    const id = requireText(listingId, 'Offer', 200);
    const next = optionalAssetPath(path);

    const ctx = await openAuthedContext(actor);
    const profile = await resolveProfile(ctx);

    const existing = await this.readListingRow(ctx, id);
    if (!existing) throw new DataError('not_found', 'That offer could not be found.');
    // OWNER ONLY, never an admin — `asset_path` is CONTENT to
    // `guard_listing_update()`, so this is the `updateListing` asymmetry again.
    if (existing.coach_id !== profile.id) {
      throw new DataError('forbidden', 'Only the coach who published an offer can edit it.');
    }
    if (profile.coach_status !== 'approved') {
      throw new DataError('forbidden', 'Only approved coaches can edit an offer.');
    }
    if (next !== null && existing.fulfilment !== 'instant') {
      throw new DataError(
        'invalid',
        'Only an instant-download offer can have a file attached. Switch this offer to instant delivery first.',
      );
    }
    // Clearing is allowed in either mode, so a switch to personalised can tidy
    // up after itself; a path is only ever accepted under its own offer's id.
    if (next !== null && !next.startsWith(`${existing.id}/`)) {
      throw new DataError('forbidden', "A file has to be stored under its own offer's folder.");
    }

    const { error } = await ctx.supabase.from('listings').update({ asset_path: next }).eq('id', id);
    if (error) throwDataError(error, true);

    const { data, error: readError } = await ctx.supabase
      .from('owned_listings')
      .select(OWNED_LISTING_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (readError) throwDataError(readError, true);
    if (!data) throw new DataError('not_found', 'That offer could not be found.');

    const row = data as OwnedListingRow;
    const names = await displayNamesFor(ctx, [row.coach_id]);
    return {
      ...toListingWithCoach(row, names),
      withdrawn_by_admin: row.withdrawn_by_admin === true,
      asset_path: row.asset_path ?? null,
    };
  }

  async softDeleteListing(actor: Actor, listingId: string): Promise<ListingWithCoach> {
    const id = requireText(listingId, 'Offer', 200);
    const ctx = await openAuthedContext(actor);
    const profile = await resolveProfile(ctx);

    const existing = await this.readListingRow(ctx, id);
    if (!existing) throw new DataError('not_found', 'That offer could not be found.');
    if (existing.coach_id !== profile.id && profile.role !== 'admin') {
      throw new DataError('forbidden', 'You can only withdraw your own offers.');
    }
    if (existing.deleted_at !== null) {
      throw new DataError('conflict', 'That offer is already withdrawn.');
    }

    // `deleted_at` is the ONLY column sent. `deleted_by` is DERIVED by
    // `guard_listing_update()` from `auth.uid()` and must not be supplied — it
    // is what decides who may restore, so a client-supplied value would let a
    // coach forge an admin takedown or erase one.
    //
    // There is no row DELETE anywhere in this file, and no DELETE policy on
    // `listings` for any role. Withdrawal is a soft delete and it is the only
    // kind — see `docs/DATA-LAYER.md`.
    const { data, error } = await ctx.supabase
      .from('listings')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .select(LISTING_COLUMNS)
      .maybeSingle();
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('not_found', 'That offer could not be found.');
    return withCoachName(ctx, data as ListingRow);
  }

  /**
   * Restores a withdrawn offer.
   *
   * The "an admin took this down" refusal cannot be pre-checked from here:
   * `deleted_by` is unreadable by every client role, which is exactly why
   * `owned_listings` exists to publish the derived boolean. So this consults
   * that view for the actor's own offers to produce the right sentence, and
   * otherwise lets `guard_listing_update()` refuse — its own message is already
   * end-user copy and reaches the caller through `errors.ts`.
   */
  async restoreListing(actor: Actor, listingId: string): Promise<ListingWithCoach> {
    const id = requireText(listingId, 'Offer', 200);
    const ctx = await openAuthedContext(actor);
    const profile = await resolveProfile(ctx);

    const existing = await this.readListingRow(ctx, id);
    if (!existing) throw new DataError('not_found', 'That offer could not be found.');
    if (existing.coach_id !== profile.id && profile.role !== 'admin') {
      throw new DataError('forbidden', 'You can only restore your own offers.');
    }
    if (existing.deleted_at === null) {
      throw new DataError('conflict', 'That offer is not withdrawn.');
    }

    if (existing.coach_id === profile.id && profile.role !== 'admin') {
      const { data: owned, error: ownedError } = await ctx.supabase
        .from('owned_listings')
        .select('id, withdrawn_by_admin')
        .eq('id', id)
        .maybeSingle();
      if (ownedError) throwDataError(ownedError, true);
      if (owned && (owned as { withdrawn_by_admin: boolean }).withdrawn_by_admin) {
        throw new DataError(
          'forbidden',
          'An administrator removed this offer. Only an administrator can restore it.',
        );
      }
    }

    const { data, error } = await ctx.supabase
      .from('listings')
      .update({ deleted_at: null })
      .eq('id', id)
      .select(LISTING_COLUMNS)
      .maybeSingle();
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('not_found', 'That offer could not be found.');
    return withCoachName(ctx, data as ListingRow);
  }

  async listListingRevisions(
    actor: Actor,
    listingId: string,
    page?: PageRequest,
  ): Promise<Page<ListingRevision>> {
    const id = requireText(listingId, 'Offer', 200);
    const ctx = await openAuthedContext(actor);
    const profile = await resolveProfile(ctx);

    const existing = await this.readListingRow(ctx, id);
    if (!existing) throw new DataError('not_found', 'That offer could not be found.');
    if (existing.coach_id !== profile.id && profile.role !== 'admin') {
      // Not public, and not merely tidiness: the revision list is a price
      // history per offer.
      throw new DataError('forbidden', 'You can only view the edit history of your own offers.');
    }

    // `id desc` is NOT decoration — `supabase/README.md` lists it as a
    // requirement. Two edits inside the same millisecond share a `created_at`,
    // and Postgres has no insertion order to fall back on, so without a
    // tie-break the "newest first" contract is simply not met for that pair. It
    // is now `seek`'s second `.order()`, which is also the cursor's tie-break —
    // the two were always the same requirement.
    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.revisions, page?.cursor);

    const { data, error, count } = await runPaged(
      (opts: CountOptions) =>
        ctx.supabase
          .from('listing_revisions')
          .select('id, listing_id, title, description, price_cents, category, created_at', opts)
          .eq('listing_id', id),
      KEYSETS.revisions,
      cursor,
      limit,
    );
    if (error) throwDataError(error, true);

    const window = windowOf(
      KEYSETS.revisions,
      (data ?? []) as ListingRevision[],
      limit,
      byCreatedAt,
      totalOf(count),
    );
    return pageOf(window, window.rows);
  }

  /** Shared by the four methods that need to see an offer before writing to it. */
  private async readListingRow(ctx: AuthedCtx, id: string): Promise<ListingRow | null> {
    const { data, error } = await ctx.supabase
      .from('listings')
      .select(LISTING_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      // Absence, so the callers' own `not_found` message wins — the mock finds
      // no row for a malformed id either.
      if (isMalformedId(error)) return null;
      throwDataError(error, true);
    }
    return (data as ListingRow | null) ?? null;
  }

  // -------------------------------------------------------------------------
  // Social proof
  // -------------------------------------------------------------------------

  async getOfferStats(listingId: string): Promise<OfferStats | null> {
    if (typeof listingId !== 'string' || listingId === '') return null;
    const [only] = await this.listOfferStats([listingId]);
    return only ?? null;
  }

  /**
   * Unknown and withdrawn ids are simply LEFT OUT — `offer_stats` carries
   * `where l.deleted_at is null`, so a withdrawn offer has no row at all.
   * That is not a privacy measure; each result carries its own `listing_id`,
   * which is why `docs/DATA-LAYER.md` insists callers key the result by id
   * rather than zipping it by index.
   */
  async listOfferStats(listingIds: readonly string[]): Promise<OfferStats[]> {
    if (!Array.isArray(listingIds) || listingIds.length === 0) return [];
    // Shape-filtered, not just emptiness-filtered — see `isUuid`. A malformed
    // id simply has no row, which is what "unknown ids are skipped" means.
    const ids = listingIds.filter((id) => typeof id === 'string' && isUuid(id));
    if (ids.length === 0) return [];

    const ctx = await openPublicContext();
    const { data, error } = await ctx.supabase
      .from('offer_stats')
      .select('listing_id, rating_average, review_count, sales_count')
      .in('listing_id', ids);
    // A malformed id inside an `in` list fails the whole cast, taking the valid
    // ids down with it. The mock simply matches nothing for it, and the
    // contract here is that unknown ids are skipped — so a malformed one is
    // just another id with no row.
    if (error) {
      if (isMalformedId(error)) return [];
      throwDataError(error, ctx.userId !== null);
    }

    // `client.ts` specifies "one entry per listing id that exists, IN THE ORDER
    // GIVEN". PostgREST returns rows in whatever order the plan produced, so the
    // result has to be re-keyed and re-emitted against the input — returning
    // `data` directly made the order an accident of the query planner. Unknown
    // and withdrawn ids drop out here, which is the other half of the contract.
    const byId = new Map<string, OfferStats>();
    for (const row of data ?? []) {
      const stat = row as Record<string, unknown>;
      const id = String(stat.listing_id);
      byId.set(id, {
        listing_id: id,
        rating_average: toNumberOrNull(stat.rating_average),
        review_count: toCount(stat.review_count),
        sales_count: toCount(stat.sales_count),
      });
    }

    return ids
      .map((id) => byId.get(id))
      .filter((stat): stat is OfferStats => stat !== undefined);
  }

  async getCoachStats(coachId: string): Promise<CoachStats> {
    if (typeof coachId !== 'string' || coachId === '') return emptyCoachStats('');
    const [only] = await this.listCoachStats([coachId]);
    return only ?? emptyCoachStats(coachId);
  }

  /**
   * Returns one row per requested id, IN THE ORDER GIVEN, with unknown ids kept
   * as zeros — unlike `listOfferStats`, which drops them. The asymmetry is
   * deliberate: `getCoachStats` always returns a row, so the batch form must
   * not disagree with the single form.
   */
  async listCoachStats(coachIds: readonly string[]): Promise<CoachStats[]> {
    if (!Array.isArray(coachIds) || coachIds.length === 0) return [];

    // As above. The final map still runs over the ORIGINAL `coachIds`, so a
    // malformed id gets the zero row this method contracts to return rather
    // than being dropped.
    const ids = coachIds.filter((id) => typeof id === 'string' && isUuid(id));
    if (ids.length === 0) {
      return coachIds.map((id) => emptyCoachStats(typeof id === 'string' && id !== '' ? id : ''));
    }

    const ctx = await openPublicContext();
    const { data, error } = await ctx.supabase
      .from('coach_stats')
      .select('coach_id, rating_average, review_count, sales_count')
      .in('coach_id', ids);
    // As in `listOfferStats` — except the contract here is zeros rather than
    // omission, so the fallback below still returns one row per requested id.
    if (error) {
      if (isMalformedId(error)) return coachIds.map((id) => emptyCoachStats(typeof id === 'string' ? id : ''));
      throwDataError(error, ctx.userId !== null);
    }

    const byId = new Map<string, CoachStats>();
    for (const row of data ?? []) {
      const stat = row as Record<string, unknown>;
      const id = String(stat.coach_id);
      byId.set(id, {
        coach_id: id,
        rating_average: toNumberOrNull(stat.rating_average),
        review_count: toCount(stat.review_count),
        sales_count: toCount(stat.sales_count),
      });
    }

    return coachIds.map((id) =>
      typeof id === 'string' && id !== '' ? (byId.get(id) ?? emptyCoachStats(id)) : emptyCoachStats(''),
    );
  }

  /**
   * The OFFER page's review list. `public_listing_reviews` (0003) applies both
   * the published filter and the current-epoch filter inside the view, so this
   * agrees with `getOfferStats` by construction and a withdrawn offer yields
   * `[]` — those reviews stay readable on the coach profile below.
   */
  async listReviewsForListing(listingId: string, page?: PageRequest): Promise<Page<PublicReview>> {
    if (typeof listingId !== 'string' || listingId === '') return emptyPage();
    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.listingReviews, page?.cursor);
    const ctx = await openPublicContext();

    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase
        .from('public_listing_reviews')
        .select(PUBLIC_REVIEW_COLUMNS, opts)
        .eq('listing_id', listingId),
      KEYSETS.listingReviews,
      cursor,
      limit,
    );
    if (error) {
      if (isMalformedId(error)) return emptyPage();
      throwDataError(error, ctx.userId !== null);
    }

    const window = windowOf(
      KEYSETS.listingReviews,
      (data ?? []) as PublicReview[],
      limit,
      byCreatedAt,
      totalOf(count),
    );
    return pageOf(window, window.rows);
  }

  /** `owned_listings` is scoped to `auth.uid()` inside the view; this narrows it to one id. */
  async getMyListing(actor: Actor, listingId: string): Promise<OwnedListing | null> {
    const ctx = await openAuthedContext(actor);
    if (typeof listingId !== 'string' || listingId === '') return null;

    const { data, error } = await ctx.supabase
      .from('owned_listings')
      .select(OWNED_LISTING_COLUMNS)
      .eq('id', listingId)
      .maybeSingle();
    if (error) {
      if (isMalformedId(error)) return null;
      throwDataError(error, true);
    }
    if (!data) return null;

    const row = data as OwnedListingRow;
    const names = await displayNamesFor(ctx, [row.coach_id]);
    return {
      ...toListingWithCoach(row, names),
      withdrawn_by_admin: row.withdrawn_by_admin === true,
      asset_path: row.asset_path ?? null,
    };
  }

  /**
   * A HEAD request with `count: 'exact'` — the rows are never fetched, only
   * counted, which is the whole reason this is not `listOrdersForCoach(...).length`.
   */
  async countOrdersForListing(actor: Actor, listingId: string): Promise<number> {
    const ctx = await openAuthedContext(actor);
    if (typeof listingId !== 'string' || listingId === '') return 0;

    // The entitlement is checked here rather than left to RLS, because
    // `orders_select_own_coach` renders a refusal as ZERO ROWS — which is
    // indistinguishable from "nobody claimed it", and would silently unlock the
    // control this number gates. Same construction, same reason, as `listReports`.
    const listing = await this.readListingRow(ctx, listingId);
    if (!listing) return 0;
    const profile = await resolveProfile(ctx);
    if (listing.coach_id !== profile.id && profile.role !== 'admin') {
      throw new DataError('forbidden', 'You can only view your own sales.');
    }

    const { count, error } = await ctx.supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('listing_id', listingId);
    if (error) {
      if (isMalformedId(error)) return 0;
      throwDataError(error, true);
    }
    return typeof count === 'number' ? count : 0;
  }

  /** One indexed lookup, where the page used to scan a whole purchase history. */
  async getMyOrderForListing(actor: Actor, listingId: string): Promise<OrderWithListing | null> {
    const ctx = await openAuthedContext(actor);
    if (typeof listingId !== 'string' || listingId === '') return null;

    // `learner_id` is DERIVED from the session, never a parameter — the same
    // construction as `listMyOrders`, and the reason this is safe to expose.
    const { data, error } = await ctx.supabase
      .from('orders')
      .select('*')
      .eq('learner_id', ctx.userId)
      .eq('listing_id', listingId)
      .maybeSingle();
    if (error) {
      if (isMalformedId(error)) return null;
      throwDataError(error, true);
    }
    if (!data) return null;

    const [only] = await withListingTitles(ctx, [data as Order]);
    return only ?? null;
  }

  /**
   * The COACH ACCOUNT's review list — every offer, every epoch, every
   * withdrawal state, from `public_coach_reviews` (0003). It is the list beside
   * `coach_stats`' count and must not gain a filter the count does not have.
   */
  async listReviewsForCoach(
    coachId: string,
    page?: PageRequest,
  ): Promise<Page<PublicReviewWithListing>> {
    if (typeof coachId !== 'string' || coachId === '') return emptyPage();
    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.coachReviews, page?.cursor);
    const ctx = await openPublicContext();

    // `listing_published` is projected by the view (0026) rather than worked out
    // here by intersecting with the coach's offer list — that intersection is
    // wrong once both lists are pages. See the migration.
    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase
        .from('public_coach_reviews')
        .select(`${PUBLIC_REVIEW_COLUMNS}, listing_title, listing_published`, opts)
        .eq('coach_id', coachId),
      KEYSETS.coachReviews,
      cursor,
      limit,
    );
    if (error) {
      if (isMalformedId(error)) return emptyPage();
      throwDataError(error, ctx.userId !== null);
    }

    const window = windowOf(
      KEYSETS.coachReviews,
      (data ?? []) as PublicReviewWithListing[],
      limit,
      byCreatedAt,
      totalOf(count),
    );
    return pageOf(window, window.rows);
  }

  async getOrder(actor: Actor, orderId: string): Promise<OrderWithListing | null> {
    const ctx = await openAuthedContext(actor);
    if (typeof orderId !== 'string' || orderId === '') return null;

    // `orders_select_own_learner` / `_own_coach` / `_admin` are the boundary;
    // there is no anon policy on `orders` at all. An order the actor may not
    // see returns no row, and the mock throws `forbidden` for that case — so
    // absence is disambiguated below rather than reported as "no such order".
    const { data, error } = await ctx.supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();
    if (error) {
      if (isMalformedId(error)) return null;
      throwDataError(error, true);
    }
    if (!data) {
      // Either it does not exist, or it is not ours. Only an admin can tell
      // those apart, and an admin can see every order — so for anyone else a
      // missing row that DOES exist is a refusal. Distinguishing them would
      // require a privileged read this client deliberately cannot make, and
      // `null` is what a stranger should get regardless.
      return null;
    }

    const [only] = await withListingTitles(ctx, [data as Order]);
    return only ?? null;
  }

  async listMyOrders(actor: Actor, page?: PageRequest): Promise<Page<OrderWithListing>> {
    const ctx = await openAuthedContext(actor);
    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.myOrders, page?.cursor);

    // The learner id is DERIVED from the actor, never a parameter, so this
    // cannot be pointed at anyone else. The cursor does not change that: it
    // carries a position, never a scope.
    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase.from('orders').select('*', opts).eq('learner_id', ctx.userId),
      KEYSETS.myOrders,
      cursor,
      limit,
    );
    if (error) throwDataError(error, true);

    const window = windowOf(KEYSETS.myOrders, (data ?? []) as Order[], limit, byCreatedAt, totalOf(count));
    return pageOf(window, await withListingTitles(ctx, window.rows));
  }

  async listOrdersForCoach(
    actor: Actor,
    coachId: string,
    page?: PageRequest,
  ): Promise<Page<OrderWithListing>> {
    const ctx = await openAuthedContext(actor);
    if (typeof coachId !== 'string' || coachId === '') return emptyPage();

    const profile = await resolveProfile(ctx);
    if (profile.id !== coachId && profile.role !== 'admin') {
      throw new DataError('forbidden', 'You can only view your own sales.');
    }

    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.coachOrders, page?.cursor);

    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase.from('orders').select('*', opts).eq('coach_id', coachId),
      KEYSETS.coachOrders,
      cursor,
      limit,
    );
    // Only reachable for an admin: a non-admin whose id is not `coachId` was
    // already refused above, and their own id is a well-formed uuid.
    if (error) {
      if (isMalformedId(error)) return emptyPage();
      throwDataError(error, true);
    }

    const window = windowOf(KEYSETS.coachOrders, (data ?? []) as Order[], limit, byCreatedAt, totalOf(count));
    return pageOf(window, await withListingTitles(ctx, window.rows));
  }

  /**
   * `listing_id`, `author_id` and `price_epoch` are taken from the order and the
   * listing, NEVER from input — `reviews_insert_own_purchase` re-derives the
   * same facts in its `with check`, and the `UNIQUE` constraint on
   * `reviews.order_id` is what actually makes "one review per purchase" true.
   */
  /**
   * An RPC, not an insert, because no client role holds INSERT on `orders` and
   * none ever should: the price and the epoch have to be read off the listing
   * inside the database, where the caller cannot reach them.
   */
  async createOrder(actor: Actor, listingId: string): Promise<Order> {
    const id = requireText(listingId, 'Offer', 200);
    const ctx = await openAuthedContext(actor);

    const { data, error } = await ctx.supabase.rpc('claim_offer', { p_listing_id: id });
    if (error) {
      // A malformed id fails the uuid cast before the function body runs, and
      // "no such offer" is the honest reading of that — same rule as
      // `reviewCoachApplication`.
      if (isMalformedId(error)) throw new DataError('not_found', 'That offer could not be found.');
      throwDataError(error, true);
    }
    if (!data) throw new DataError('invalid', 'That offer could not be claimed.');
    return (Array.isArray(data) ? data[0] : data) as Order;
  }

  /**
   * `deliverables_select_party` is the boundary. An order the actor is not on
   * simply yields no rows — so absence is disambiguated by reading the order
   * first, exactly as `getOrder` does, rather than reported as "no files".
   */
  async listDeliverables(actor: Actor, orderId: string): Promise<Deliverable[]> {
    const id = requireText(orderId, 'Order', 200);
    const ctx = await openAuthedContext(actor);

    const { data: order, error: orderError } = await ctx.supabase
      .from('orders')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (orderError) {
      if (isMalformedId(orderError)) throw new DataError('not_found', 'That order could not be found.');
      throwDataError(orderError, true);
    }
    if (!order) throw new DataError('not_found', 'That order could not be found.');

    const { data, error } = await ctx.supabase
      .from('deliverables')
      .select('*')
      .eq('order_id', id)
      .order('created_at', { ascending: false });
    if (error) throwDataError(error, true);
    return (data ?? []) as Deliverable[];
  }

  async addDeliverable(actor: Actor, input: AddDeliverableInput): Promise<Deliverable> {
    const orderId = requireText(input?.order_id, 'Order', 200);
    const storagePath = requireText(input?.storage_path, 'File', 400);
    const fileName = requireText(input?.file_name, 'File name', 260);
    const contentType = requireText(input?.content_type, 'File type', 200);
    const sizeBytes = input?.size_bytes;
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new DataError('invalid', 'That file could not be read.');
    }
    if (sizeBytes > 52_428_800) throw new DataError('invalid', 'Files have to be 50 MB or smaller.');

    const ctx = await openAuthedContext(actor);

    const { data, error } = await ctx.supabase
      .from('deliverables')
      .insert({
        order_id: orderId,
        // Pinned to the actor here and again by the policy's
        // `uploaded_by = auth.uid()` with-check.
        uploaded_by: ctx.userId,
        storage_path: storagePath,
        file_name: fileName,
        content_type: contentType,
        size_bytes: sizeBytes,
      })
      .select('*')
      .maybeSingle();
    if (error) {
      if (isMalformedId(error)) throw new DataError('not_found', 'That order could not be found.');
      throwDataError(error, true);
    }
    if (!data) throw new DataError('invalid', 'That file could not be attached.');
    return data as Deliverable;
  }

  async removeDeliverable(actor: Actor, deliverableId: string): Promise<string> {
    const id = requireText(deliverableId, 'File', 200);
    const ctx = await openAuthedContext(actor);

    // `deliverables_delete_own` admits only the uploader, so somebody else's
    // file matches no row and deletes nothing. Read it back first to tell that
    // apart from a file that never existed — and, since the row is being read
    // anyway, to learn the object path the caller has to delete afterwards.
    const { data: existing, error: findError } = await ctx.supabase
      .from('deliverables')
      .select('id, uploaded_by, storage_path')
      .eq('id', id)
      .maybeSingle();
    if (findError) {
      if (isMalformedId(findError)) throw new DataError('not_found', 'That file could not be found.');
      throwDataError(findError, true);
    }
    if (!existing) throw new DataError('not_found', 'That file could not be found.');
    const row = existing as { uploaded_by: string; storage_path: string };
    if (row.uploaded_by !== ctx.userId) {
      throw new DataError('forbidden', 'You can only remove files you uploaded yourself.');
    }

    const { error } = await ctx.supabase.from('deliverables').delete().eq('id', id);
    if (error) throwDataError(error, true);

    return row.storage_path;
  }

  async createReview(actor: Actor, input: CreateReviewInput): Promise<Review> {
    const orderId = requireText(input?.order_id, 'Order', 200);
    const rating = requireRating(input?.rating);
    const body = requireText(input?.body, 'Review', 2000, 3);

    const ctx = await openAuthedContext(actor);

    const { data: orderRow, error: orderError } = await ctx.supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();
    if (orderError) {
      // Same rule as `readListingRow`: no such order, not "bad input".
      if (isMalformedId(orderError)) throw new DataError('not_found', 'That order could not be found.');
      throwDataError(orderError, true);
    }
    if (!orderRow) throw new DataError('not_found', 'That order could not be found.');

    const order = orderRow as Order;
    if (order.learner_id !== ctx.userId) {
      throw new DataError('forbidden', 'You can only review something you have bought.');
    }

    const listing = await this.readListingRow(ctx, order.listing_id);
    if (!listing) throw new DataError('not_found', 'That offer could not be found.');
    if (listing.coach_id === ctx.userId) {
      throw new DataError('forbidden', 'You cannot review your own offer.');
    }

    const { data: existing, error: existingError } = await ctx.supabase
      .from('reviews')
      .select('id')
      .eq('order_id', order.id)
      .maybeSingle();
    if (existingError) throwDataError(existingError, true);
    if (existing) throw new DataError('conflict', 'You have already reviewed this purchase.');

    const { data, error } = await ctx.supabase
      .from('reviews')
      .insert({
        order_id: order.id,
        listing_id: order.listing_id,
        author_id: ctx.userId,
        rating,
        body,
        price_epoch: order.price_epoch,
      })
      .select('*')
      .maybeSingle();
    if (error) {
      // The UNIQUE constraint is the real guard against a double submit; the
      // pre-check above only produces nicer copy and loses a race.
      throwDataError(error, true);
    }
    if (!data) throw new DataError('invalid', 'That review could not be saved.');
    return data as Review;
  }

  async listReviewReplies(reviewIds: readonly string[]): Promise<PublicReviewReply[]> {
    if (!Array.isArray(reviewIds) || reviewIds.length === 0) return [];
    // Shape-filtered like `listOfferStats`: a malformed id simply has no row,
    // which is what "unknown ids are skipped" means.
    const ids = reviewIds.filter((id) => typeof id === 'string' && isUuid(id));
    if (ids.length === 0) return [];

    // PUBLIC context. `public_review_replies` is an owner-run view granted to
    // anon, so this must not go through the request-scoped client — a cached
    // public read may not touch `cookies()` anywhere in its stack.
    const ctx = await openPublicContext();
    const { data, error } = await ctx.supabase
      .from('public_review_replies')
      .select('id, review_id, coach_id, body, created_at, coach_name')
      .in('review_id', ids);
    if (error) {
      // Same reasoning as `listOfferStats`: one malformed id inside an `in`
      // list fails the whole cast and would take the valid ids down with it.
      if (isMalformedId(error)) return [];
      throwDataError(error, ctx.userId !== null);
    }
    return (data ?? []) as PublicReviewReply[];
  }

  async createReviewReply(actor: Actor, reviewId: string, body: string): Promise<PublicReviewReply> {
    const id = requireText(reviewId, 'Review', 200);
    const text = requireText(body, 'Reply', REVIEW_REPLY_MAX, 3);

    const ctx = await openAuthedContext(actor);

    // The review, then the listing behind it. Read rather than trusted: the
    // entitlement is ownership of the offer, and the only authority on that is
    // the listing row. `review_replies_insert_coach` checks the same join in
    // Postgres, so this produces a sentence rather than being the boundary.
    const { data: reviewRow, error: reviewError } = await ctx.supabase
      .from('public_reviews')
      .select('id, listing_id')
      .eq('id', id)
      .maybeSingle();
    if (reviewError) {
      if (isMalformedId(reviewError)) throw new DataError('not_found', 'That review could not be found.');
      throwDataError(reviewError, true);
    }
    if (!reviewRow) throw new DataError('not_found', 'That review could not be found.');

    // NO `deleted_at` FILTER — `readListingRow` returns the row whatever its
    // withdrawal state, which is what lets a coach answer a review of an offer
    // they have since taken down. Matches the policy, which has no such clause.
    const listing = await this.readListingRow(ctx, (reviewRow as { listing_id: string }).listing_id);
    if (!listing) throw new DataError('not_found', 'That offer could not be found.');
    if (listing.coach_id !== ctx.userId) {
      throw new DataError('forbidden', 'You can only reply to a review of your own offer.');
    }

    const { data, error } = await ctx.supabase
      .from('review_replies')
      .insert({ review_id: id, coach_id: ctx.userId, body: text })
      // The INSERT grant covers three columns and the SELECT grant covers five,
      // so the returning projection names them rather than using `*`: `is_demo`
      // is granted to nobody and a bare star would be refused.
      .select('id, review_id, coach_id, body, created_at')
      .maybeSingle();
    if (error) {
      // 23505 on the UNIQUE constraint is the real guard against a double
      // submit; there is no pre-check here because there is nothing nicer to
      // say than what this maps to.
      if (error.code === '23505') {
        throw new DataError('conflict', 'You have already replied to this review.');
      }
      throwDataError(error, true);
    }
    if (!data) throw new DataError('invalid', 'That reply could not be saved.');

    // The view is what carries `coach_name`, and the insert cannot return it.
    // Read it from the actor's own profile rather than re-querying: the coach
    // IS the author here, so this is a self-read.
    const me = await this.getProfile(actor, ctx.userId);
    return { ...(data as Omit<PublicReviewReply, 'coach_name'>), coach_name: me?.full_name ?? '' };
  }

  // -------------------------------------------------------------------------
  // Moderation
  // -------------------------------------------------------------------------

  /**
   * Every review, for the moderation queue.
   *
   * `reviews_select_admin` is the boundary and it renders a refusal as ZERO
   * ROWS — so `requireAdminProfile` runs first, or a coach asking for this
   * would get an empty list ("there are no reviews") rather than a refusal
   * ("this is not yours to see"). Same construction, same reason, as
   * `listOrdersForCoach`.
   *
   * The author's name comes from `public_profiles` rather than `profiles`,
   * which carries email — the invariant the interface header states first.
   * Titles come from `listings` with NO `deleted_at` filter: a review of a
   * withdrawn offer is still a review, and one a moderator could not see is one
   * they could not take down.
   */
  async listReviewsForModeration(
    actor: Actor,
    page?: PageRequest,
  ): Promise<Page<ModeratableReview>> {
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.moderation, page?.cursor);

    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase.from('reviews').select('*', opts),
      KEYSETS.moderation,
      cursor,
      limit,
    );
    if (error) throwDataError(error, true);

    const window = windowOf(KEYSETS.moderation, (data ?? []) as Review[], limit, byCreatedAt, totalOf(count));
    const reviews = window.rows;
    if (reviews.length === 0) return pageOf(window, []);

    const [names, titles] = await Promise.all([
      displayNamesFor(ctx, reviews.map((r) => r.author_id)),
      listingTitlesFor(ctx, reviews.map((r) => r.listing_id)),
    ]);

    return pageOf(
      window,
      reviews.map((review) => ({
        ...review,
        author_name: names.get(review.author_id) ?? 'Unknown',
        listing_title: titles.get(review.listing_id) ?? UNKNOWN_LISTING,
      })),
    );
  }

  /**
   * Takes a review down through `public.remove_review()`.
   *
   * AN RPC AND NOT A DELETE, because there is no longer a DELETE policy to use:
   * `0016` drops `reviews_delete_admin` precisely so that no route exists which
   * removes a review without writing the archive row. The function does both in
   * one transaction, and it re-checks `is_admin()` itself — the pre-check here
   * exists only to produce the same sentence the mock produces for a non-admin,
   * before a round trip.
   */
  async removeReview(actor: Actor, reviewId: string, reason?: string | null): Promise<void> {
    const id = requireText(reviewId, 'Review', 200);
    const note = optionalText(reason, 'Reason', 1000);

    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const { error } = await ctx.supabase.rpc('remove_review', {
      p_review_id: id,
      p_reason: note,
    });
    if (error) {
      // A malformed id never reaches the function body — it fails at the uuid
      // cast — and the mock answers `not_found` for the same input.
      if (isMalformedId(error)) throw new DataError('not_found', 'That review could not be found.');
      throwDataError(error, true);
    }
  }

  /** The moderation log. `removed_reviews_select_admin` is the policy. */
  async listRemovedReviews(
    actor: Actor,
    page?: PageRequest,
  ): Promise<Page<RemovedReviewWithNames>> {
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.removedReviews, page?.cursor);

    // Ordered and keyed on `removed_at` — when it was TAKEN DOWN, not when the
    // review was written. `KEYSETS.removedReviews` names the same column.
    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase.from('removed_reviews').select('*', opts),
      KEYSETS.removedReviews,
      cursor,
      limit,
    );
    if (error) throwDataError(error, true);

    const window = windowOf(
      KEYSETS.removedReviews,
      (data ?? []) as RemovedReview[],
      limit,
      (row) => ({ key: row.removed_at, id: row.id }),
      totalOf(count),
    );
    const rows = window.rows;
    if (rows.length === 0) return pageOf(window, []);

    // Both id columns are ON DELETE SET NULL, so either can be absent. The
    // nulls are filtered before the lookup and reinstated after it.
    const people = [
      ...rows.map((r) => r.author_id),
      ...rows.map((r) => r.removed_by),
    ].filter((id): id is string => typeof id === 'string');

    const [names, titles] = await Promise.all([
      displayNamesFor(ctx, people),
      listingTitlesFor(ctx, rows.map((r) => r.listing_id)),
    ]);

    return pageOf(
      window,
      rows.map((row) => ({
        ...row,
        author_name: (row.author_id && names.get(row.author_id)) || 'Unknown',
        listing_title: titles.get(row.listing_id) ?? UNKNOWN_LISTING,
        // `null` rather than a placeholder: the account is gone, and saying so
        // is more useful to whoever reads the log than inventing an actor.
        removed_by_name: (row.removed_by && names.get(row.removed_by)) || null,
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Reports and coach standing
  // -------------------------------------------------------------------------

  /**
   * Files a report about a review, through `public.report_review()`.
   *
   * AN RPC RATHER THAN AN INSERT, and the reason is the entitlement: only the
   * coach whose offer the review is about may file one, which is a JOIN through
   * `listings` rather than a column comparison. A `with check` could express it,
   * but then "no such review" and "not your offer" would both surface as the
   * same anonymous RLS violation, and the function can say the one sentence that
   * reveals neither.
   */
  async reportReview(
    actor: Actor,
    reviewId: string,
    reason: ReportReason,
    note?: string | null,
  ): Promise<Report> {
    const id = requireText(reviewId, 'Review', 200);
    const why = requireReportReason(reason);
    const body = optionalText(note, 'Note', 2000);

    const ctx = await openAuthedContext(actor);
    const { data, error } = await ctx.supabase.rpc('report_review', {
      p_review_id: id,
      p_reason: why,
      p_note: body,
    });
    if (error) {
      if (isMalformedId(error)) throw new DataError('not_found', 'That review could not be found.');
      throwDataError(error, true);
    }
    return oneRow<Report>(data, 'That report could not be filed.');
  }

  /** Files a report about a coach, through `public.report_coach()`. */
  async reportCoach(
    actor: Actor,
    coachId: string,
    reason: ReportReason,
    note?: string | null,
  ): Promise<Report> {
    const id = requireText(coachId, 'Coach', 200);
    const why = requireReportReason(reason);
    const body = optionalText(note, 'Note', 2000);

    const ctx = await openAuthedContext(actor);
    const { data, error } = await ctx.supabase.rpc('report_coach', {
      p_coach_id: id,
      p_reason: why,
      p_note: body,
    });
    if (error) {
      if (isMalformedId(error)) throw new DataError('not_found', 'That coach could not be found.');
      throwDataError(error, true);
    }
    return oneRow<Report>(data, 'That report could not be filed.');
  }

  /** `reports_select_own` is the boundary; the filter here only orders. */
  async listMyReports(actor: Actor, page?: PageRequest): Promise<Page<Report>> {
    const ctx = await openAuthedContext(actor);
    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.myReports, page?.cursor);

    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase.from('reports').select('*', opts).eq('reporter_id', ctx.userId),
      KEYSETS.myReports,
      cursor,
      limit,
    );
    if (error) throwDataError(error, true);

    const window = windowOf(KEYSETS.myReports, (data ?? []) as Report[], limit, byCreatedAt, totalOf(count));
    return pageOf(window, window.rows);
  }

  /**
   * The queue.
   *
   * `reports_select_admin` renders a refusal as ZERO ROWS, so
   * `requireAdminProfile` runs first — otherwise a coach asking for this would
   * get "there are no reports" rather than "this is not yours to see". Same
   * construction, same reason, as `listReviewsForModeration`.
   *
   * The context is assembled here rather than in a view because the subject may
   * be GONE: upholding a review report deletes the review, and the report has to
   * outlive it. Three reads, none of which can be a join for that reason.
   */
  async listReports(
    actor: Actor,
    status?: ReportStatus,
    page?: PageRequest,
  ): Promise<Page<ReportWithContext>> {
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.reports, page?.cursor);

    const build = (opts: CountOptions) => {
      const query = ctx.supabase.from('reports').select('*', opts);
      return status ? query.eq('status', status) : query;
    };

    // `count` is of THIS STATUS, which is what a queue's tab count is.
    const { data, error, count } = await runPaged(build, KEYSETS.reports, cursor, limit);
    if (error) throwDataError(error, true);

    const window = windowOf(KEYSETS.reports, (data ?? []) as Report[], limit, byCreatedAt, totalOf(count));
    const reports = window.rows;
    if (reports.length === 0) return pageOf(window, []);

    const reviewIds = reports
      .map((r) => r.subject_review_id)
      .filter((id): id is string => typeof id === 'string');

    const [reviewsResult, archivedResult] = await Promise.all([
      reviewIds.length
        ? ctx.supabase.from('reviews').select('id, listing_id, author_id, body').in('id', reviewIds)
        : Promise.resolve({ data: [], error: null }),
      reviewIds.length
        ? ctx.supabase
            .from('removed_reviews')
            .select('review_id, listing_id, author_id, body')
            .in('review_id', reviewIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (reviewsResult.error) throwDataError(reviewsResult.error, true);
    if (archivedResult.error) throwDataError(archivedResult.error, true);

    type SubjectRow = { listing_id: string; author_id: string | null; body: string };
    const live = new Map<string, SubjectRow>();
    for (const row of (reviewsResult.data ?? []) as ({ id: string } & SubjectRow)[]) {
      live.set(row.id, row);
    }
    const archived = new Map<string, SubjectRow>();
    for (const row of (archivedResult.data ?? []) as ({ review_id: string } & SubjectRow)[]) {
      archived.set(row.review_id, row);
    }

    const people = [
      ...reports.map((r) => r.reporter_id),
      ...reports.map((r) => r.resolved_by),
      ...reports.map((r) => r.subject_coach_id),
      ...[...live.values(), ...archived.values()].map((r) => r.author_id),
    ].filter((id): id is string => typeof id === 'string');

    const listingIds = [...live.values(), ...archived.values()].map((r) => r.listing_id);

    const [names, titles, headlines] = await Promise.all([
      displayNamesFor(ctx, people),
      listingTitlesFor(ctx, listingIds),
      coachHeadlinesFor(
        ctx,
        reports.map((r) => r.subject_coach_id).filter((id): id is string => typeof id === 'string'),
      ),
    ]);

    return pageOf(
      window,
      reports.map((report) => {
      if (report.subject_type === 'review' && report.subject_review_id) {
        const row = live.get(report.subject_review_id);
        const gone = row ? null : archived.get(report.subject_review_id);
        const source = row ?? gone ?? null;
        return {
          ...report,
          reporter_name: names.get(report.reporter_id) ?? 'Unknown',
          subject_name: (source?.author_id && names.get(source.author_id)) || 'Unknown',
          subject_summary: row
            ? row.body
            : gone
              ? 'This review has since been removed.'
              : 'This review no longer exists.',
          listing_title: source ? (titles.get(source.listing_id) ?? UNKNOWN_LISTING) : null,
          resolved_by_name: (report.resolved_by && names.get(report.resolved_by)) || null,
        };
      }

      return {
        ...report,
        reporter_name: names.get(report.reporter_id) ?? 'Unknown',
        subject_name: (report.subject_coach_id && names.get(report.subject_coach_id)) || 'Unknown',
        subject_summary:
          (report.subject_coach_id && headlines.get(report.subject_coach_id)) || 'No headline.',
        // A coach report is not about an offer. `null` rather than an empty
        // string, so a renderer branches rather than printing a blank line.
        listing_title: null,
        resolved_by_name: (report.resolved_by && names.get(report.resolved_by)) || null,
      };
      }),
    );
  }

  /** Marks a report handled, through `public.resolve_report()`. */
  async resolveReport(
    actor: Actor,
    reportId: string,
    status: ReportStatus,
    note?: string | null,
  ): Promise<Report> {
    const id = requireText(reportId, 'Report', 200);
    const body = optionalText(note, 'Note', 2000);
    if (status !== 'upheld' && status !== 'dismissed') {
      throw new DataError('invalid', 'A report is resolved as upheld or dismissed.');
    }

    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const { data, error } = await ctx.supabase.rpc('resolve_report', {
      p_report_id: id,
      p_status: status,
      p_note: body,
    });
    if (error) {
      if (isMalformedId(error)) throw new DataError('not_found', 'That report could not be found.');
      throwDataError(error, true);
    }
    return oneRow<Report>(data, 'That report could not be resolved.');
  }

  /** Suspends, reinstates or demotes, through `public.set_coach_status()`. */
  async setCoachStatus(
    actor: Actor,
    userId: string,
    status: CoachStatus,
    reason?: string | null,
  ): Promise<Profile> {
    const id = requireText(userId, 'Account', 200);
    const why = optionalText(reason, 'Reason', 1000);
    if (status !== 'approved' && status !== 'suspended' && status !== 'none') {
      throw new DataError('invalid', 'A coach can be reinstated, suspended, or removed as a coach.');
    }

    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const { data, error } = await ctx.supabase.rpc('set_coach_status', {
      p_user_id: id,
      p_status: status,
      p_reason: why,
    });
    if (error) {
      if (isMalformedId(error)) throw new DataError('not_found', 'That account could not be found.');
      throwDataError(error, true);
    }
    return oneRow<Profile>(data, 'That account could not be updated.');
  }

  /**
   * Every coach an administrator might act on.
   *
   * Reads `profiles` rather than `public_coaches`, and that is the point: the
   * view filters to `approved`, so a suspended coach disappears from it exactly
   * when somebody needs to find them. `profiles_select_admin` is what admits
   * this read.
   */
  async listCoachesForAdmin(actor: Actor, page?: PageRequest): Promise<Page<Profile>> {
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.adminCoaches, page?.cursor);

    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase
        .from('profiles')
        .select('*', opts)
        .neq('coach_status', 'none')
        .is('deleted_at', null),
      KEYSETS.adminCoaches,
      cursor,
      limit,
    );
    if (error) throwDataError(error, true);

    const window = windowOf(KEYSETS.adminCoaches, (data ?? []) as Profile[], limit, byCreatedAt, totalOf(count));
    return pageOf(window, window.rows);
  }

  /** The audit log. `admin_actions_select_admin` is the policy. */
  async listAdminActions(actor: Actor, page?: PageRequest): Promise<Page<AdminActionWithNames>> {
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.adminActions, page?.cursor);

    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase.from('admin_actions').select('*', opts),
      KEYSETS.adminActions,
      cursor,
      limit,
    );
    if (error) throwDataError(error, true);

    const window = windowOf(KEYSETS.adminActions, (data ?? []) as AdminAction[], limit, byCreatedAt, totalOf(count));
    const rows = window.rows;
    if (rows.length === 0) return pageOf(window, []);

    const names = await displayNamesFor(
      ctx,
      rows.map((r) => r.actor_id).filter((id): id is string => typeof id === 'string'),
    );
    return pageOf(
      window,
      rows.map((row) => ({
      ...row,
      // `null`, never a placeholder: the column is nullable because the FK is
      // ON DELETE SET NULL, and because bootstrapping the first administrator
      // has no actor at all.
        actor_name: (row.actor_id && names.get(row.actor_id)) || null,
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------

  async createInvite(actor: Actor, input: CreateInviteInput): Promise<Invite> {
    const note = optionalText(input?.note, 'Note', 200);
    const expiresAt = requireIsoTimestamp(input?.expiresAt, 'Expiry date');

    const ctx = await openAuthedContext(actor);
    const admin = await requireAdminProfile(ctx);

    // Retry on a code collision rather than pre-reading the table: the mock
    // loops against its in-memory list, and here the equivalent authority is
    // the unique constraint. A 23505 means the generator produced a code that
    // already exists, which is worth one more roll of the dice.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data, error } = await ctx.supabase
        .from('invites')
        .insert({ code: generateInviteCode(), created_by: admin.id, note, expires_at: expiresAt })
        .select('*')
        .maybeSingle();

      if (!error && data) return data as Invite;
      // Anything that is NOT a duplicate code is a real refusal — an
      // `invites_insert_admin` failure, say — and retrying it five times would
      // turn one clear error into five identical ones and a wrong message.
      if (error && (error as { code?: string }).code !== '23505') throwDataError(error, true);
      // No error and no row. The insert may well have COMMITTED and only the
      // representation come back empty, so looping would mint a second invite
      // for one request. Stop instead.
      if (!error) break;
    }
    throw new DataError('conflict', 'That invite code could not be created. Please try again.');
  }

  async listInvites(actor: Actor, page?: PageRequest): Promise<Page<Invite>> {
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.invites, page?.cursor);

    // The tie-break is `code`, not `id` — `public.invites` has no `id` column.
    // `KEYSETS.invites` carries that, and `seek` orders by whatever it names.
    const { data, error, count } = await runPaged(
      (opts: CountOptions) => ctx.supabase.from('invites').select('*', opts),
      KEYSETS.invites,
      cursor,
      limit,
    );
    if (error) throwDataError(error, true);

    const window = windowOf(
      KEYSETS.invites,
      (data ?? []) as Invite[],
      limit,
      (invite) => ({ key: invite.created_at, id: invite.code }),
      totalOf(count),
    );
    return pageOf(window, window.rows);
  }

  async revokeInvite(actor: Actor, code: string): Promise<Invite> {
    const needle = requireText(code, 'Invite code', 100);
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    // Case-insensitive, to match `redeem_invite_code()` and the mock. The
    // pattern is escaped so a code containing `%` cannot revoke a different one.
    // A code containing `*` cannot be matched literally, and must not be
    // allowed to become a wildcard scan of the invites table. No minted code
    // can contain one — `invite-code.ts` draws from an alphanumeric alphabet —
    // so this is simply "no such code".
    const exact = escapeLike(needle);
    if (exact === null) throw new DataError('not_found', 'That invite code does not exist.');

    const { data: found, error: findError } = await ctx.supabase
      .from('invites')
      .select('*')
      .ilike('code', exact)
      .maybeSingle();
    if (findError) throwDataError(findError, true);
    if (!found) throw new DataError('not_found', 'That invite code does not exist.');

    const invite = found as Invite;
    if (invite.redeemed_by) throw new DataError('conflict', 'That invite code has already been redeemed.');
    if (invite.revoked_at) throw new DataError('conflict', 'That invite code is already revoked.');

    const { data, error } = await ctx.supabase
      .from('invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('code', invite.code)
      .select('*')
      .maybeSingle();
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('not_found', 'That invite code does not exist.');
    return data as Invite;
  }

  /**
   * An RPC, not a table write, because it has to touch `profiles.role` — which
   * `guard_profile_privilege_columns` refuses from any API session.
   *
   * `redeem_invite_code()` claims the code and promotes the caller in ONE
   * conditional UPDATE, so two simultaneous redemptions of the same code cannot
   * both win. Its refusals ("That invite code is not valid.") are already
   * end-user copy and reach the caller through `errors.ts`, including the
   * deliberate choice to give revoked, expired and already-redeemed codes one
   * undifferentiated message.
   */
  async redeemInviteCode(actor: Actor, code: string): Promise<Profile> {
    // Deliberately NOT `requireText`. The mock authenticates FIRST, then emits
    // 'Enter an invite code.' for an empty value and one undifferentiated
    // 'That invite code is not valid.' for everything else — no length cap.
    // Capping the length here would have added a signal the mock does not have:
    // a 150-character guess would be told it was too long, while a 12-character
    // one was told nothing, which is exactly the oracle that `client.ts` and
    // `redeem_invite_code()` both go out of their way to avoid.
    const trimmed = typeof code === 'string' ? code.trim() : '';
    const ctx = await openAuthedContext(actor);
    if (trimmed === '') throw new DataError('invalid', 'Enter an invite code.');

    const { data, error } = await ctx.supabase.rpc('redeem_invite_code', { p_code: trimmed });
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('not_found', 'Your profile could not be found.');
    return (Array.isArray(data) ? data[0] : data) as Profile;
  }

  // -------------------------------------------------------------------------
  // Coach applications
  // -------------------------------------------------------------------------

  /** The single form of the queue read. Same policy, same joined shape. */
  async getCoachApplication(
    actor: Actor,
    applicationId: string,
  ): Promise<CoachApplicationWithUser | null> {
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);
    if (typeof applicationId !== 'string' || applicationId === '') return null;

    const { data, error } = await ctx.supabase
      .from('coach_applications')
      .select('*')
      .eq('id', applicationId)
      .maybeSingle();
    if (error) {
      if (isMalformedId(error)) return null;
      throwDataError(error, true);
    }
    if (!data) return null;

    const application = data as CoachApplication;
    // An admin reads `profiles` through `profiles_select_admin`, so the email is
    // available — and this is an admin-only shape, which is why
    // `CoachApplicationWithUser` may carry one at all.
    const { data: profile, error: profileError } = await ctx.supabase
      .from('profiles')
      .select('full_name, email, coach_status')
      .eq('id', application.user_id)
      .maybeSingle();
    if (profileError) throwDataError(profileError, true);

    const user = profile as
      | { full_name: string; email: string; coach_status: Profile['coach_status'] }
      | null;
    return {
      ...application,
      user_name: user?.full_name ?? 'Unknown user',
      user_email: user?.email ?? '',
      user_coach_status: user?.coach_status ?? 'none',
    };
  }

  /**
   * An RPC: it inserts the application AND sets the applicant's `coach_status`
   * to `pending_review`, and the second half is a privilege column.
   */
  async createCoachApplication(
    actor: Actor,
    input: CreateCoachApplicationInput,
  ): Promise<CoachApplication> {
    const bio = requireText(input?.bio, 'Bio', 2000, 20);
    const experience = requireText(input?.experience, 'Experience', 2000, 20);
    const sport = optionalText(input?.sport, 'Sport', 80);

    const ctx = await openAuthedContext(actor);

    const { data, error } = await ctx.supabase.rpc('apply_to_coach', {
      p_bio: bio,
      p_experience: experience,
      p_sport: sport,
    });
    if (error) throwDataError(error, true);
    if (!data) throw new DataError('invalid', 'That application could not be filed.');
    return (Array.isArray(data) ? data[0] : data) as CoachApplication;
  }

  async getMyCoachApplication(actor: Actor): Promise<CoachApplication | null> {
    const ctx = await openAuthedContext(actor);

    // `coach_applications_select_own` scopes this to the actor; the filter is
    // restated so the intent is visible, and the id comes from the session.
    // NEWEST first and take one: a re-applicant holds several, and the current
    // one is what a status page must show.
    const { data, error } = await ctx.supabase
      .from('coach_applications')
      .select('*')
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throwDataError(error, true);

    const rows = (data ?? []) as CoachApplication[];
    return rows[0] ?? null;
  }

  async listCoachApplications(
    actor: Actor,
    filter?: CoachApplicationFilter,
    page?: PageRequest,
  ): Promise<Page<CoachApplicationWithUser>> {
    const ctx = await openAuthedContext(actor);
    await requireAdminProfile(ctx);

    const limit = normaliseLimit(page?.limit);
    const cursor = decodeCursor(KEYSETS.applications, page?.cursor);

    const build = (opts: CountOptions) => {
      const query = ctx.supabase.from('coach_applications').select('*', opts);
      return filter?.status ? query.eq('status', filter.status) : query;
    };

    const { data, error, count } = await runPaged(build, KEYSETS.applications, cursor, limit);
    if (error) throwDataError(error, true);

    const window = windowOf(
      KEYSETS.applications,
      (data ?? []) as CoachApplication[],
      limit,
      byCreatedAt,
      totalOf(count),
    );
    const applications = window.rows;
    if (applications.length === 0) return pageOf(window, []);

    // An admin reads `profiles` through `profiles_select_admin`, so the email
    // is available here — and this is an admin-only shape, which is why
    // `CoachApplicationWithUser` may carry one at all.
    const userIds = [...new Set(applications.map((a) => a.user_id))];
    const { data: profiles, error: profilesError } = await ctx.supabase
      .from('profiles')
      .select('id, full_name, email, coach_status')
      .in('id', userIds);
    if (profilesError) throwDataError(profilesError, true);

    const byId = new Map<string, { full_name: string; email: string; coach_status: Profile['coach_status'] }>();
    for (const row of (profiles ?? []) as {
      id: string;
      full_name: string;
      email: string;
      coach_status: Profile['coach_status'];
    }[]) {
      byId.set(row.id, { full_name: row.full_name, email: row.email, coach_status: row.coach_status });
    }

    return pageOf(
      window,
      applications.map((application) => {
        const user = byId.get(application.user_id);
        return {
          ...application,
          user_name: user?.full_name ?? 'Unknown user',
          user_email: user?.email ?? '',
          user_coach_status: user?.coach_status ?? 'none',
        };
      }),
    );
  }

  /**
   * An RPC, for the same reason as the other two: it writes the review columns
   * AND the applicant's `role` / `coach_status`.
   *
   * `review_coach_application()` re-checks `is_admin()`, refuses a self-review,
   * pins `and a.status = 'pending'` inside the UPDATE so a second reviewer
   * cannot overwrite a decision, and only ever RAISES the applicant's role.
   */
  async reviewCoachApplication(
    actor: Actor,
    applicationId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<CoachApplication> {
    // Validated EXACTLY as the mock does, down to the label and the cap: the
    // note field is `maxLength={1000}` in `admin/applications/review-form.tsx`,
    // and a 1500-character note must fail identically on both backends. The
    // application id is deliberately NOT run through `requireText` — the mock
    // does not either, so a bad id has to come back as `not_found` rather than
    // as `invalid`. `p_application_id` is declared `uuid`, so an empty or
    // malformed value fails the CAST before the function body runs; that 22P02
    // is translated below rather than here.
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new DataError('invalid', 'A review decision must be approve or reject.');
    }
    const reviewNote = optionalText(note, 'Review note', 1000);
    const id = typeof applicationId === 'string' ? applicationId.trim() : '';

    const ctx = await openAuthedContext(actor);

    const { data, error } = await ctx.supabase.rpc('review_coach_application', {
      p_application_id: id,
      p_decision: decision,
      p_note: reviewNote,
    });
    if (error) {
      // The cast failed: there is no application at that id. Same wording as
      // the mock, which reports a miss on its own lookup.
      if (isMalformedId(error)) {
        throw new DataError('not_found', 'That application could not be found.');
      }
      throwDataError(error, true);
    }
    if (!data) throw new DataError('not_found', 'That application could not be found.');
    return (Array.isArray(data) ? data[0] : data) as CoachApplication;
  }
}
