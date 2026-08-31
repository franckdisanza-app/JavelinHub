/**
 * Authorization regression suite for the mock data layer.
 *
 *   npm run verify:authz
 *
 * The mock `DataClient` is the only thing enforcing authorization in this phase
 * — there is no Postgres, so the RLS policies in `supabase/migrations/` cannot
 * run anywhere. This suite is therefore the executable half of that guarantee,
 * and `PROGRESS.md`'s resumption protocol expects a future session to be able
 * to re-run it and re-verify every claim from scratch.
 *
 * It runs against a THROWAWAY store in the OS temp directory, created fresh and
 * deleted afterwards. It never touches `data/db.json`, and it sets its own env
 * so it works without a `.env.local`.
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 *
 * (`.mts`, not `.ts`, so Node treats it as ESM without the project having to
 * declare `"type": "module"` — which would change how Next.js resolves its own
 * config files.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Actor, CoachApplication, ListingCategory, Profile } from '@/lib/data/types';
import { COACH_STATUSES, LISTING_CATEGORIES, ROLES, listingCategoryLabel } from '@/lib/data/types';
import { initialsOf } from '@/lib/initials';

const scratch = mkdtempSync(join(tmpdir(), 'javelin-authz-'));
const storePath = join(scratch, 'db.json');

// Must be set before the store module is evaluated. Throwaway values.
process.env.DATA_BACKEND = 'mock';
process.env.MOCK_DB_PATH = storePath;
process.env.SEED_ADMIN_EMAIL = 'admin@javelin.test';
process.env.SEED_ADMIN_PASSWORD = 'verify-authz-throwaway-password';
process.env.SESSION_SECRET = 'verify-authz-throwaway-session-secret';

const { getDataClient } = await import('@/lib/data');
const { DataError, isDataError } = await import('@/lib/data/types');
const { __resetStoreCache, mutateDb } = await import('@/lib/data/mock/store');
// Mock-only, and deliberately free of any framework import so it can be called
// from here — see the header of that file. Its sibling `password-reset.ts`
// writes cookies and therefore cannot be.
const { hashToken, issueResetToken, redeemResetToken } = await import('@/lib/auth/reset-tokens');
// Free of `next/headers` for the same reason — `clientIp()` lives in its own
// module precisely so this one can be called from a plain Node script.
const { LIMITS, consume } = await import('@/lib/rate-limit');

const db = getDataClient();

/**
 * `signUp` returns a {@link SignUpResult} union, because on Supabase a
 * successful signup with email confirmation on yields no session. **The mock
 * has no mail and must therefore always sign the user in**, and this helper
 * asserts that invariant on every call rather than trusting it: a mock that
 * started returning `confirm_email` would strand every fixture below with no
 * actor, and the failure would look like an authorization bug.
 */
async function signUpProfile(input: { email: string; password: string; fullName: string }): Promise<Profile> {
  const result = await db.signUp(input);
  if (result.status !== 'signed_in') {
    throw new Error(`the mock signUp returned "${result.status}" — it has no mail and must always sign in`);
  }
  return result.profile;
}


// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function ok(label: string, detail = ''): void {
  passed += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  console.log(`  FAIL  ${label} — ${detail}`);
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function note(text: string): void {
  console.log(`        ${text}`);
}

/** Asserts the call is refused with the expected DataError code. */
async function refuses(label: string, expected: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    fail(label, `expected DataError('${expected}') but the call SUCCEEDED`);
  } catch (error) {
    if (!isDataError(error)) {
      fail(label, `threw a non-DataError: ${String(error)}`);
      return;
    }
    if (error.code !== expected) {
      fail(label, `expected code '${expected}', got '${error.code}' ("${error.message}")`);
      return;
    }
    ok(label, `${error.code}: "${error.message}"`);
  }
}

/** Asserts the call succeeds, returning its value (or null on failure). */
async function allows<T>(label: string, fn: () => Promise<T>, describe: (value: T) => string): Promise<T | null> {
  try {
    const value = await fn();
    ok(label, describe(value));
    return value;
  } catch (error) {
    fail(label, `expected success, threw: ${isDataError(error) ? `${error.code} "${error.message}"` : String(error)}`);
    return null;
  }
}

/**
 * The summary line, and the throwaway store's removal, on EVERY exit path.
 *
 * `refuses()` and `allows()` catch, but a bare `await` inside an argument —
 * `expectEqual('...', await db.thing(), 1)` — rejects before the assertion
 * function is ever entered, which used to abort the process with no
 * `=== N passed, M failed ===` line at all. Every such run was loudly red in its
 * output, so this was never a correctness hole, but a run that ends without a
 * summary is one an automated reader can misparse as a pass. An unexpected
 * throw now costs exactly one failed assertion and still prints the summary.
 *
 * The cleanup moved here from the tail for the same reason: it used to sit
 * AFTER the summary, so any throwing run leaked its temp directory. Registered
 * on `exit`, which runs on every path, and `rmSync` is synchronous as that
 * handler requires.
 */
let summarised = false;
function summarise(): void {
  if (summarised) return;
  summarised = true;
  console.log(`
=== ${passed} passed, ${failed} failed ===`);
}

function abort(error: unknown): void {
  fail('the run aborted with an unexpected error', String(error));
  process.exitCode = 1;
}

process.on('uncaughtException', abort);
process.on('unhandledRejection', abort);
process.on('exit', () => {
  summarise();
  rmSync(scratch, { recursive: true, force: true });
});

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) ok(label, String(actual));
  else fail(label, `expected ${String(expected)}, got ${String(actual)}`);
}

/**
 * Asserts the EXACT column set of a row handed out by a read.
 *
 * Every projection in the data layer is built at a call site, and more than one
 * call site can build the same shape — `toPublicReview()` is re-wrapped by
 * `listReviewsForCoach` to add a title, `withListing()` is used by three
 * different order reads. A key-set assertion on one of them says nothing about
 * the others, so this exists to make "assert it at EVERY site" cheap enough
 * that there is no excuse for checking one and not its neighbour.
 *
 * `undefined` fails rather than silently passing: a method that returns nothing
 * must never look like a method that returns a well-shaped row.
 */
function expectShape(label: string, row: unknown, columns: readonly string[]): void {
  if (row === null || typeof row !== 'object') {
    fail(label, `expected a row with ${columns.length} column(s), got ${String(row)}`);
    return;
  }
  expectEqual(label, Object.keys(row).sort().join(','), [...columns].sort().join(','));
}

/**
 * A listing row, exactly as `public.listings` defines it.
 *
 * Hand-written rather than derived from the code under test, like every other
 * constant here. `deleted_at` is in the list on purpose: a store row that is
 * missing the column would still READ as published (`isWithdrawn()` tests for a
 * string), so its absence is invisible to every behavioural assertion in this
 * file and would only surface as a withdrawal that silently does nothing.
 */
const LISTING_ROW_COLUMNS = [
  'id',
  'coach_id',
  'title',
  'description',
  'price_cents',
  'category',
  'price_epoch',
  'deleted_at',
  'deleted_by',
  'fulfilment',
  'asset_path',
  'created_at',
  'updated_at',
] as const;
/**
 * What EVERY method that returns a listing actually returns — reads and writes
 * alike. It is the row MINUS `deleted_by` and `asset_path`, PLUS the joined
 * coach name.
 *
 * The omissions are the load-bearing part, and they are two different
 * disclosures. After a takedown `deleted_by` holds an ADMINISTRATOR's id, and
 * handing that to a visitor, to a buyer reading a tombstone, or even to the
 * coach who owns the offer is administrator enumeration — the disclosure
 * `PublicProfile` drops `role` to prevent. `asset_path` is the key of a private
 * object in `offer-assets`; SELECT on it is revoked from every client role in
 * `0011_delivery.sql`, so a listing read that carried it would be a shape
 * Postgres cannot produce. Both are asserted at every call site, not
 * spot-checked at one.
 *
 * `fulfilment` deliberately survives: how an offer arrives is public.
 */
const LISTING_WITH_COACH_COLUMNS = [
  ...LISTING_ROW_COLUMNS.filter((c) => c !== 'deleted_by' && c !== 'asset_path'),
  'coach_name',
] as const;
/**
 * The owner's dashboard shape: the projection, plus the derived takedown flag,
 * plus the owner's own `asset_path` added back.
 *
 * Note the two additions are opposite treatments of the same problem. The
 * takedown is published as a BOOLEAN because the underlying value is an
 * administrator's id; the asset is published as the STRING because it is the
 * coach's own file and the editor needs the key. Both are safe for the same
 * reason and only that reason: `public.owned_listings` is scoped
 * `where coach_id = auth.uid()`.
 */
const OWNED_LISTING_COLUMNS = [
  ...LISTING_WITH_COACH_COLUMNS,
  'withdrawn_by_admin',
  'asset_path',
] as const;
/** A superseded version of an offer. No `updated_at`: the table is append-only. */
const LISTING_REVISION_COLUMNS = [
  'id',
  'listing_id',
  'title',
  'description',
  'price_cents',
  'category',
  'created_at',
] as const;
/** The public shape of a review. Anything else on it has leaked. */
const PUBLIC_REVIEW_COLUMNS = ['id', 'listing_id', 'rating', 'body', 'created_at', 'author_name'] as const;
/** Plus the offer title, on the coach-profile list. Still nothing more. */
const PUBLIC_REVIEW_WITH_LISTING_COLUMNS = [...PUBLIC_REVIEW_COLUMNS, 'listing_title'] as const;
/**
 * A review row in FULL, as only an administrator sees it — the deliberate
 * opposite of `PUBLIC_REVIEW_COLUMNS`.
 *
 * `author_id`, `order_id` and `price_epoch` are all present, and each is one of
 * the omissions the public shape exists to make. Asserting the two side by side
 * is what makes the difference a property of the code rather than a convention:
 * if `listReviewsForModeration` ever fed a public page, this list is what would
 * be leaking.
 */
const MODERATABLE_REVIEW_COLUMNS = [
  'id',
  'order_id',
  'listing_id',
  'author_id',
  'rating',
  'body',
  'price_epoch',
  'created_at',
  'updated_at',
  'author_name',
  'listing_title',
] as const;
/** The archive row, plus the three names a log has to read without them. */
const REMOVED_REVIEW_COLUMNS = [
  'id',
  'review_id',
  'listing_id',
  'author_id',
  'order_id',
  'rating',
  'body',
  'price_epoch',
  'review_created_at',
  'removed_by',
  'removed_at',
  'reason',
  'author_name',
  'listing_title',
  'removed_by_name',
] as const;
/** An order as its buyer, its seller or an admin sees it. No buyer NAME, ever. */
const ORDER_COLUMNS = [
  'id',
  'learner_id',
  'listing_id',
  'coach_id',
  'price_cents_at_purchase',
  'price_epoch',
  'created_at',
  'listing_title',
  'has_review',
  // Joined from the LIVE listing, which is safe only because the mode is
  // immutable once anything has been claimed.
  'listing_fulfilment',
  // The instant download, or null. Scoped by `public.entitled_offer_assets` in
  // SQL and by the same predicate in the mock: the offer's coach, or a learner
  // holding an order for it. An admin reading somebody else's order gets null.
  'asset_path',
] as const;
/** The public offer rollup: counts, an average, and no epoch. */
const OFFER_STATS_COLUMNS = ['listing_id', 'rating_average', 'review_count', 'sales_count'] as const;
/** The public account rollup. */
const COACH_STATS_COLUMNS = ['coach_id', 'rating_average', 'review_count', 'sales_count'] as const;

/**
 * A profile row, exactly as `public.profiles` defines it.
 *
 * Hand-written and NOT derived from the `Profile` type, like every other
 * constant here — an expectation read out of the code under test cannot fail.
 *
 * The three coach columns are in the list on purpose. A store row that is
 * missing them still READS correctly everywhere (every consumer tests for a
 * string or for `null`), so their absence is invisible to every behavioural
 * assertion in this file — it would only surface as `undefined years coaching`
 * on a rendered page, or as a JSON round-trip that silently drops a key.
 */
const PROFILE_COLUMNS = [
  'id',
  'email',
  'full_name',
  'role',
  'coach_status',
  'coach_headline',
  'coach_bio',
  'coach_years_coaching',
  'avatar_path',
  // Added with account deletion. IN THE LIST for the same reason `deleted_at`
  // is on a listing row: a stored profile missing it would still READ as active
  // everywhere (every consumer tests for `null`), so its absence is invisible
  // to every behavioural assertion here — and `resolveProfile` refuses on
  // `!== null`, where `undefined !== null` is TRUE. An unrepaired row would
  // lock its owner out of all forty methods at once, silently.
  'deleted_at',
  'created_at',
  'updated_at',
] as const;

/**
 * The public shape of a coach. Anything else on it has leaked.
 *
 * Note what is NOT here and must never be added: `email`, `role`,
 * `coach_status`, and `is_approved_coach`. The first three are the disclosure
 * `public_profiles` exists to prevent; the fourth would be a constant-`true`
 * column, because `listCoaches` / `getPublicCoach` return approved coaches and
 * nothing else. Nothing from `coach_applications` belongs here either.
 *
 * `avatar_path` IS here, and it is the only column ever added to this list. It
 * names an object in a PUBLIC bucket — anyone who can see the card can already
 * fetch the file — and it discloses nothing but the owner id, which this shape
 * carries as `id` regardless. That reasoning is what makes it admissible; a
 * column without it does not become admissible by being useful.
 */
const PUBLIC_COACH_COLUMNS = [
  'id',
  'full_name',
  'coach_headline',
  'coach_bio',
  'coach_years_coaching',
  'avatar_path',
] as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADMIN: Actor = { userId: '00000000-0000-4000-8000-000000000001' };
const COACH: Actor = { userId: '00000000-0000-4000-8000-000000000002' };
const LEARNER: Actor = { userId: '00000000-0000-4000-8000-000000000003' };
const ANON: Actor = null;

const LISTING = {
  title: 'Test Listing',
  description: 'A description long enough to pass validation checks.',
  price_cents: 1000,
  category: 'training_plan' as ListingCategory,
};
const APPLICATION = {
  bio: 'Twelve years throwing javelin at national level.',
  experience: 'Coached three athletes to state finals since 2019.',
  sport: 'Javelin',
};

// Seeded social-proof fixtures. Ids are fixed in store.ts and mirrored in
// supabase/seed.sql, so naming them here is safe and makes the intent of each
// assertion readable.
const EMPTY_COACH = '00000000-0000-4000-8000-000000000004'; // Nils Berg: zero of everything
const MARCUS: Actor = { userId: '00000000-0000-4000-8000-000000000011' };
const AISHA: Actor = { userId: '00000000-0000-4000-8000-000000000014' };
/**
 * Nils Berg as an ACTOR — an approved coach who owns nothing.
 *
 * He is the right target for every "another coach may not touch this offer"
 * assertion in the lifecycle section: his coach_status is `approved`, so the
 * approval check cannot be what refuses him, and he owns no listing, so
 * ownership is the ONLY reason left. Aiming those at a learner instead would
 * pass whether the ownership check existed or not.
 */
const NILS: Actor = { userId: EMPTY_COACH };

const OFFER = {
  fundamentals: '00000000-0000-4000-8000-000000000101', // 3 sales, 3 reviews
  clinic: '00000000-0000-4000-8000-000000000102', // 2 sales, 1 review
  strength: '00000000-0000-4000-8000-000000000103', // epoch 2: 3 sales / 3 reviews across two epochs
  video: '00000000-0000-4000-8000-000000000104', // 1 sale, 1 review
  shoulder: '00000000-0000-4000-8000-000000000105', // 1 sale, NO reviews
  mentalPrep: '00000000-0000-4000-8000-000000000106', // nothing at all
} as const;

const ORDER = {
  lenaOnFundamentals: '00000000-0000-4000-8000-000000000201', // reviewed
  marcusOnFundamentals: '00000000-0000-4000-8000-000000000202', // reviewed, NOT Lena's
  aishaOnClinic: '00000000-0000-4000-8000-000000000205', // seeded, never reviewed
  aishaOnShoulder: '00000000-0000-4000-8000-000000000210', // seeded, never reviewed, and
  // untouched by every other assertion in this file — which is what makes it
  // usable as the target of the crafted-payload test below. Aiming that test at
  // an order that HAS a review means the duplicate check answers first and the
  // injected columns are never reached, so the assertion passes without
  // exercising anything. That mistake is easy to make twice; see the comment on
  // the forgery test for the first place it bites.
} as const;

/**
 * Test-only out-of-band admin promotion, standing in for the
 * `public.grant_admin(uuid)` RPC in 0002_rls.sql. The mock has no client method
 * for this by design (the seeded admin comes from SEED_ADMIN_EMAIL), but the
 * D2 regressions need a SECOND admin so that one admin can review another's
 * application. This writes straight to the store, exactly as a DBA would.
 */
async function grantAdmin(userId: string): Promise<void> {
  await mutateDb((store) => {
    const profile = store.profiles.find((p) => p.id === userId);
    if (!profile) throw new Error(`grantAdmin: no profile ${userId}`);
    profile.role = 'admin';
  });
}

async function roleOf(userId: string): Promise<string | undefined> {
  return (await db.getProfile(ADMIN, userId))?.role;
}

async function coachStatusOf(userId: string): Promise<string | undefined> {
  return (await db.getProfile(ADMIN, userId))?.coach_status;
}

console.log('=== JavelinHub mock DataClient — authorization regression suite ===');
console.log(`throwaway store: ${storePath}`);

// ---------------------------------------------------------------------------
section('Seed sanity');
// ---------------------------------------------------------------------------
const seedListings = await db.listListings();
expectEqual('seeded listing count', seedListings.length, 6);
// listCategories() returns the TAXONOMY, not the values in use. Three of the
// eight have no seeded listing, so a filter derived from the rows would be short
// by three — which is exactly the fresh-install bug this assertion guards.
const categories = await db.listCategories();
expectEqual('listCategories returns all eight, not the values in use', categories.length, 8);
expectEqual(
  'listCategories is in the fixed display order',
  categories.join(','),
  LISTING_CATEGORIES.join(','),
);
expectEqual('`other` is pinned last, never sorted into the middle', categories.at(-1), 'other');
// Empty on purpose, and asserted so nobody "fixes" it by inventing fixtures:
// these three are what exercise the browse empty state.
expectEqual(
  'the taxonomy is complete even though three categories have no seeded listing',
  LISTING_CATEGORIES.filter((c) => !seedListings.some((l) => l.category === c)).join(','),
  'recovery_plan,nutrition_plan,other',
);
note(`categories: ${categories.join(', ')}`);
expectEqual('seeded coach is approved', await coachStatusOf(COACH!.userId), 'approved');
expectEqual('seeded learner is not a coach', await coachStatusOf(LEARNER!.userId), 'none');
expectEqual('seeded admin role', await roleOf(ADMIN!.userId), 'admin');

// ---------------------------------------------------------------------------
section('Social proof — the seeded shape, including the empty states');
// ---------------------------------------------------------------------------
// Asserted BEFORE anything in this file writes a review, so these are the seed's
// numbers and not a side effect of an earlier section.
//
// The empty states are fixtures, not accidents: E5 has to build "No reviews
// yet", "New offer" and "New coach" against something real, and an empty state
// that exists only in a designer's head is the one that ships broken.
const seedCoachStats = await db.getCoachStats(COACH!.userId);
expectEqual('seeded sales for the coach', seedCoachStats.sales_count, 10);
expectEqual('seeded reviews for the coach', seedCoachStats.review_count, 8);
expectEqual('seeded coach rating average', seedCoachStats.rating_average, 4.4);

const fundamentals = await db.getOfferStats(OFFER.fundamentals);
expectEqual('offer stats: sales', fundamentals?.sales_count, 3);
expectEqual('offer stats: reviews', fundamentals?.review_count, 3);
expectEqual('offer stats: rating average', fundamentals?.rating_average, 4.7);

// NEVER RENDER A ZERO AS A RATING. An unrated offer must be distinguishable
// from a badly rated one in the DATA, or the UI cannot get it right: `null` +
// count 0, and `0` is not merely absent, it is impossible (ratings are 1-5).
const brandNew = await db.getOfferStats(OFFER.mentalPrep);
expectEqual('an offer with nothing: sales', brandNew?.sales_count, 0);
expectEqual('an offer with nothing: reviews', brandNew?.review_count, 0);
expectEqual('an offer with nothing: rating is NULL, not 0.0', brandNew?.rating_average, null);
expectEqual('...and it is not the number zero', brandNew?.rating_average === 0, false);

// Sold but never rated — a third state, and the one most likely to be collapsed
// into one of the other two by mistake.
const soldUnrated = await db.getOfferStats(OFFER.shoulder);
expectEqual('an offer sold but never reviewed: sales', soldUnrated?.sales_count, 1);
expectEqual('an offer sold but never reviewed: reviews', soldUnrated?.review_count, 0);
expectEqual('an offer sold but never reviewed: rating is NULL', soldUnrated?.rating_average, null);

const emptyCoachStats = await db.getCoachStats(EMPTY_COACH);
expectEqual('an approved coach with nothing: offers', (await db.listListingsByCoach(ANON, EMPTY_COACH)).length, 0);
expectEqual('an approved coach with nothing: sales', emptyCoachStats.sales_count, 0);
expectEqual('an approved coach with nothing: reviews', emptyCoachStats.review_count, 0);
expectEqual('an approved coach with nothing: rating is NULL, not 0.0', emptyCoachStats.rating_average, null);
expectEqual(
  'the empty coach really is an approved coach (so the empty state is reachable)',
  (await db.getPublicProfile(EMPTY_COACH))?.is_approved_coach,
  true,
);

// A stats read for an id that does not exist must not become an existence
// oracle: coaches answer with zeros, offers answer with null, neither throws.
const unknownCoach = await db.getCoachStats('00000000-0000-4000-8000-0000000dead0');
expectEqual('unknown coach id: zeros, not an error', `${unknownCoach.sales_count}/${unknownCoach.review_count}`, '0/0');
expectEqual('unknown coach id: rating is NULL', unknownCoach.rating_average, null);
expectEqual('unknown listing id: no stats row', await db.getOfferStats('00000000-0000-4000-8000-0000000dead1'), null);
// Absent, not zeroed: the batch is a join against `listings`, so an id with no
// row produces no row. Note this is NOT a privacy property — each result
// carries its listing_id, so a caller does learn which ids exist, which
// discloses nothing that `getListing()` does not already publish.
expectEqual(
  'listOfferStats leaves unknown ids out rather than returning zero rows for them',
  (await db.listOfferStats([OFFER.fundamentals, '00000000-0000-4000-8000-0000000dead1', OFFER.clinic])).length,
  2,
);

// --- E4 pickup: "in the order given" had no assertion at all ---------------
// `listOfferStats`'s contract says "one entry per listing id that exists, in
// the order given", and until E5 nothing checked it: both `[...ids].sort()` and
// `[...ids].sort().reverse()` inside the method survived the whole suite at
// 751/0. It was harmless while nothing zipped the result positionally. E5 is
// the first round to render offer stats, so it is the first round that can be
// hurt by a reordered batch — an offer card showing another offer's rating.
//
// TWO ORDERINGS HAVE TO BE EXCLUDED, NOT ONE. That is the rule E4-F3 cost two
// rejections to learn: a fixture guard that excludes one ordering excludes only
// that ordering. `[fundamentals, clinic, mentalPrep]` would not be its ascending
// sort, so an ascending guard would pass — but it IS its descending sort, and
// this codebase orders `desc` almost everywhere (`byCreatedAtDesc`,
// `order by created_at desc, id desc`), so a Supabase `listOfferStats` served
// from `order by listing_id desc` is the likeliest accidental implementation.
// Swapping the FIRST TWO of the ascending list is what makes it genuinely
// unordered; keep it that way.
//
// AND THE DIFFERENCE FROM `listCoachStats`: this method DROPS ids it has no row
// for, so an unknown id cannot carry any of the discrimination — it is not in
// the answer to be out of place. Every id below that the order assertion rests
// on is one that comes back. The unknown id is spliced into the middle purely
// to pin that dropping a row preserves the relative order of the survivors,
// which is the shape a real grid depends on.
//
// `mentalPrep` (…0106) is in the list on purpose as well: it exists but has
// zero sales and zero reviews, so it also pins that "no activity" is NOT the
// same as "no row" — only unknown and withdrawn ids are dropped.
const orderedOfferIds = [OFFER.clinic, OFFER.fundamentals, OFFER.mentalPrep];
expectEqual(
  'E5 fixture: the id list is NOT in ascending order, or the order assertion cannot discriminate',
  orderedOfferIds.join(',') === [...orderedOfferIds].sort().join(','),
  false,
);
expectEqual(
  'E5 fixture: the id list is NOT in descending order either — the case E4-F3 slipped through on',
  orderedOfferIds.join(',') === [...orderedOfferIds].sort().reverse().join(','),
  false,
);
const orderedOfferStats = await db.listOfferStats([
  OFFER.clinic,
  OFFER.fundamentals,
  '00000000-0000-4000-8000-0000000dead1',
  OFFER.mentalPrep,
]);
expectEqual('one row per id that exists, the unknown one dropped', orderedOfferStats.length, 3);
expectEqual(
  'E5: ...in the order given, not sorted and not reversed',
  orderedOfferStats.map((s) => s.listing_id).join(','),
  orderedOfferIds.join(','),
);
// The join above already fails on any reordering, including a single adjacent
// swap. These two say what a reordering COSTS, in the terms the UI renders:
// under an ascending sort index 0 would hold `fundamentals` and its 3 reviews,
// so a card headed "Approach Run & Crossover Clinic" would carry 4.7 / 3
// reviews instead of 4.0 / 1. Asserting the numbers as well as the ids means a
// mutant cannot pass by returning the right ids with the wrong rows attached.
expectEqual(
  'E5: ...the first row is the FIRST id requested, which sorting would move second',
  `${orderedOfferStats[0]?.listing_id}/${orderedOfferStats[0]?.review_count}`,
  `${OFFER.clinic}/1`,
);
expectEqual(
  'E5: ...and the second row carries ITS offer’s numbers, not the first row’s',
  `${orderedOfferStats[1]?.listing_id}/${orderedOfferStats[1]?.review_count}`,
  `${OFFER.fundamentals}/3`,
);
expectEqual(
  'E5: ...an existing offer with no activity is kept, unlike an unknown id',
  `${orderedOfferStats[2]?.listing_id}/${orderedOfferStats[2]?.sales_count}/${orderedOfferStats[2]?.rating_average}`,
  `${OFFER.mentalPrep}/0/null`,
);

// The aggregate must publish counts and NOTHING that identifies a buyer.
expectShape('OfferStats exposes exactly the four public numbers', fundamentals, OFFER_STATS_COLUMNS);
// The batch form builds its rows through the same helper, but from a different
// call site — assert it there too rather than assuming.
expectShape(
  'the BATCH offer stats expose the same four and no more',
  (await db.listOfferStats([OFFER.fundamentals]))[0],
  OFFER_STATS_COLUMNS,
);
// The epoch is the filter, not a published number: how many times a coach has
// raised a price is not part of the public rollup.
expectEqual('OfferStats does not publish the price epoch', 'price_epoch' in (fundamentals ?? {}), false);
expectShape('CoachStats exposes exactly the four public numbers', seedCoachStats, COACH_STATS_COLUMNS);

// ---------------------------------------------------------------------------
section('The epoch asymmetry — offer-level archives, account-level does not');
// ---------------------------------------------------------------------------
// …0103 has had a price increase: three sales and three reviews in total, but
// only one of each at the CURRENT epoch. The offer therefore reads as almost
// new while the coach's standing is untouched — which is the entire point of
// the column, and is invisible unless both halves are asserted together.
const strength = await db.getOfferStats(OFFER.strength);
// Read from the listing, since the stats deliberately no longer publish it.
expectEqual('the re-priced offer is at epoch 2', (await db.getListing(OFFER.strength))?.price_epoch, 2);
expectEqual('offer-level sales count the CURRENT epoch only', strength?.sales_count, 1);
expectEqual('offer-level reviews count the CURRENT epoch only', strength?.review_count, 1);
expectEqual('offer-level rating is the current epoch alone', strength?.rating_average, 4);

const perOfferStats = await db.listOfferStats(Object.values(OFFER));
const offerSales = perOfferStats.reduce((sum, s) => sum + s.sales_count, 0);
const offerReviews = perOfferStats.reduce((sum, s) => sum + s.review_count, 0);
expectEqual('sum of offer-level sales across every offer', offerSales, 8);
expectEqual('sum of offer-level reviews across every offer', offerReviews, 6);
// The inequality IS the asymmetry: an account-level total that merely summed the
// offer-level ones could not be larger than they are.
expectEqual('coach-level sales exceed the sum of offer-level sales', seedCoachStats.sales_count > offerSales, true);
expectEqual('coach-level reviews exceed the sum of offer-level reviews', seedCoachStats.review_count > offerReviews, true);
expectEqual('the archived rows are exactly the epoch-1 ones', seedCoachStats.sales_count - offerSales, 2);

// The review LISTS have to agree with the counts, or an offer says "1 review"
// and then renders three.
const strengthReviews = await db.listReviewsForListing(OFFER.strength);
expectEqual('the offer page shows only current-epoch reviews', strengthReviews.length, 1);
// Identified by its body rather than by an epoch column, because the public
// shape does not publish the epoch. The two archived reviews of this offer say
// something else entirely.
expectEqual(
  '...and it is the one written against the current version',
  strengthReviews[0]?.body.startsWith('Bought the current version'),
  true,
);

const coachReviews = await db.listReviewsForCoach(COACH!.userId);
expectEqual('the coach profile shows every review, every epoch', coachReviews.length, 8);
expectEqual(
  'the archived reviews are still readable on the coach profile',
  coachReviews.filter((r) => r.listing_id === OFFER.strength).length,
  3,
);
expectEqual(
  'each coach-profile review carries the offer title it is about',
  coachReviews.every((r) => typeof r.listing_title === 'string' && r.listing_title !== ''),
  true,
);
// The SECOND public review call site, and it builds its own object literal to
// add the title — so the projection has to be asserted here as well as on
// listReviewsForListing. A spread of the row into that literal would republish
// order_id, author_id and price_epoch on an anonymous, actor-less read, and the
// coach profile is the only page that calls this.
expectShape('a coach-profile review exposes exactly its rendered columns', coachReviews[0], PUBLIC_REVIEW_WITH_LISTING_COLUMNS);
expectEqual(
  'no coach-profile review hands out an order id, an author id or an epoch',
  coachReviews.some((r) => ['order_id', 'author_id', 'price_epoch', 'updated_at'].some((k) => k in r)),
  false,
);
expectEqual(
  'reviews are newest first',
  coachReviews.every((r, i) => i === 0 || coachReviews[i - 1]!.created_at >= r.created_at),
  true,
);
expectEqual('the empty coach has no reviews to show', (await db.listReviewsForCoach(EMPTY_COACH)).length, 0);

// A public review is a PROJECTION, not the row. Three of the columns it drops
// are load-bearing: `order_id` would be a valid argument to the buyer-scoped
// order reads below, `author_id` links a display name to an account, and
// `price_epoch` publishes how often a coach has raised a price.
const sample = (await db.listReviewsForListing(OFFER.fundamentals))[0]!;
expectShape('a public review exposes exactly the columns it renders', sample, PUBLIC_REVIEW_COLUMNS);
expectEqual(
  'a public review carries no author identity beyond the display name',
  ['email', 'role', 'coach_status', 'author_id', 'author_email', 'author'].some((k) => k in sample),
  false,
);
expectEqual('a public review does not hand out an order id', 'order_id' in sample, false);
expectEqual('a public review does not publish the price epoch', 'price_epoch' in sample, false);
expectEqual('the author name is joined', typeof sample.author_name === 'string' && sample.author_name !== '', true);
note(`sample review: ${sample.rating}★ by ${sample.author_name}`);

// ---------------------------------------------------------------------------
section('Orders are NOT public — the aggregate is');
// ---------------------------------------------------------------------------
// The sales COUNT above needed no actor at all. A single order row names a
// buyer, a seller and a price, so every read of one takes an actor and is
// scoped to buyer / selling coach / admin. Getting this wrong publishes a
// purchase history per person and a customer list per coach.
await refuses('anon getOrder', 'unauthorized', () => db.getOrder(ANON, ORDER.lenaOnFundamentals));
await refuses('anon listMyOrders', 'unauthorized', () => db.listMyOrders(ANON));
await refuses('anon listOrdersForCoach', 'unauthorized', () => db.listOrdersForCoach(ANON, COACH!.userId));

// The rule is "readable ONLY by its buyer, the selling coach and an admin", and
// it has two halves. The refusals below cover ONLY; these three cover READABLE,
// and they have to assert the row that came back — a getOrder that returned null
// to everyone after passing the permission check would satisfy `allows()`, print
// "undefined", and leave the whole feature broken with a green suite.
const buyerRead = await allows(
  'the BUYER may read their own order',
  () => db.getOrder(LEARNER, ORDER.lenaOnFundamentals),
  (r) => `${r?.listing_title} — ${r?.price_cents_at_purchase}c at epoch ${r?.price_epoch}`,
);
expectEqual('...and got the order back, not nothing', buyerRead?.id, ORDER.lenaOnFundamentals);
expectEqual('...joined to the offer it bought', buyerRead?.listing_title, 'Javelin Throw Fundamentals');
expectShape('...with exactly the order columns and no buyer name', buyerRead, ORDER_COLUMNS);

const sellerRead = await allows(
  'the SELLING COACH may read it',
  () => db.getOrder(COACH, ORDER.lenaOnFundamentals),
  (r) => `has_review=${r?.has_review}`,
);
expectEqual('...and got the same order back', sellerRead?.id, ORDER.lenaOnFundamentals);
expectEqual('...with the reviewed flag the sales list needs', sellerRead?.has_review, true);

const adminOrderRead = await allows(
  'an ADMIN may read it',
  () => db.getOrder(ADMIN, ORDER.lenaOnFundamentals),
  (r) => `${r?.id ? 'read' : 'null'}`,
);
expectEqual('...and got the same order back', adminOrderRead?.id, ORDER.lenaOnFundamentals);

await refuses("a STRANGER may not read someone else's order", 'forbidden', () =>
  db.getOrder(MARCUS, ORDER.lenaOnFundamentals),
);
expectEqual('an unknown order id is null, not an error', await db.getOrder(ADMIN, '00000000-0000-4000-8000-0000000dead2'), null);
// An order is located by its OWN id. Nothing else on the row is a lookup key —
// a widened predicate would answer the wrong row while every permission check
// still passed, since the checks run on whatever row was found.
expectEqual('an order is not findable by its buyer id', await db.getOrder(ADMIN, LEARNER!.userId), null);
expectEqual('an order is not findable by its listing id', await db.getOrder(ADMIN, OFFER.fundamentals), null);
expectEqual('an order is not findable by its seller id', await db.getOrder(ADMIN, COACH!.userId), null);

const lenaOrders = await db.listMyOrders(LEARNER);
expectEqual('listMyOrders returns only the actor’s own purchases', lenaOrders.length, 2);
expectEqual(
  '...and every row really is theirs',
  lenaOrders.every((o) => o.learner_id === LEARNER!.userId),
  true,
);
// `.length > 0 &&` is not decoration: `[].every()` is true, so without it this
// assertion is equally satisfied by a listMyOrders that returns nothing to
// anyone — which is the exact shape of the bug a scoping check is supposed to
// have. Found by auditing every `.every()` in this file for that property.
const marcusOrders = await db.listMyOrders(MARCUS);
expectEqual(
  'a different learner sees a different set',
  marcusOrders.length > 0 && marcusOrders.every((o) => o.learner_id === MARCUS!.userId),
  true,
);
expectEqual('...and that set is not the same one', marcusOrders.length !== lenaOrders.length || marcusOrders[0]?.id !== lenaOrders[0]?.id, true);
// The buyer id comes from the resolved actor. An actor carrying a learner_id is
// not a thing, and must not become one: this is the same forged-shape family as
// the createListing tests, aimed at the one read whose whole scoping is "the
// actor's own rows".
const forgedOwnerActors: Array<[string, Actor]> = [
  ['learner_id claim', { userId: MARCUS!.userId, learner_id: LEARNER!.userId } as unknown as Actor],
  ['nested claims object', { userId: MARCUS!.userId, claims: { learner_id: LEARNER!.userId } } as unknown as Actor],
  ['role on the PROTOTYPE chain', Object.assign(Object.create({ role: 'admin' }), { userId: MARCUS!.userId }) as Actor],
];
for (const [shape, actor] of forgedOwnerActors) {
  const rows = await db.listMyOrders(actor);
  expectEqual(
    `listMyOrders ignores a forged ${shape} and returns only the actor's rows`,
    rows.length > 0 && rows.every((o) => o.learner_id === MARCUS!.userId),
    true,
  );
}
expectEqual(
  'the seeded unreviewed purchase is flagged as unreviewed',
  (await db.listMyOrders(AISHA)).find((o) => o.id === ORDER.aishaOnClinic)?.has_review,
  false,
);
expectEqual(
  'a reviewed purchase is flagged as reviewed',
  lenaOrders.find((o) => o.id === ORDER.lenaOnFundamentals)?.has_review,
  true,
);
expectShape('an order row carries the offer title but NO buyer name or email', lenaOrders[0], ORDER_COLUMNS);

// Same two halves. `[]` is what a broken read returns AND what a refusal would
// look like if it stopped throwing, so the count is the assertion.
const ownSales = await allows(
  'a coach may list their OWN sales',
  () => db.listOrdersForCoach(COACH, COACH!.userId),
  (r) => `${r.length} sale(s)`,
);
expectEqual('...and every seeded sale is in it', ownSales?.length, 10);
// SINGLE-FIXTURE HAZARD, closed by the fixture planted just above this section:
// every seeded order is a sale by Cory, so "all of them theirs" would hold for a
// listOrdersForCoach that did no filtering at all. A second coach's sale has to
// exist in the store for this to assert anything — same defect class as the
// revision-log leak, found by auditing every `.every()` in this file.
expectEqual('...all of them theirs', (ownSales ?? []).every((o) => o.coach_id === COACH!.userId), true);
expectShape('...each row carrying exactly the order columns', ownSales?.[0], ORDER_COLUMNS);
const adminSales = await allows(
  'an admin may list any coach’s sales',
  () => db.listOrdersForCoach(ADMIN, COACH!.userId),
  (r) => `${r.length} sale(s)`,
);
expectEqual('...and an admin sees the same ten', adminSales?.length, 10);
expectEqual(
  'the empty coach really has no sales (not an empty answer to everyone)',
  (await db.listOrdersForCoach(ADMIN, EMPTY_COACH)).length,
  0,
);

// ---------------------------------------------------------------------------
// A SECOND COACH'S SALE, so that "all of them theirs" asserts something.
//
// Every seeded order is a sale by Cory, which makes
// `ownSales.every((o) => o.coach_id === COACH)` vacuously true — a
// listOrdersForCoach that did no filtering at all would satisfy it. Found by
// auditing every `.every()` in this file for rows that can only come from one
// source, which is the same defect class as the revision-log leak.
//
// Planted here rather than earlier because every empty-coach assertion above
// depends on Nils having nothing; from this point on he has exactly one sale.
const rivalOrderId = '00000000-0000-4000-8000-0000000000c9';
await mutateDb((store) => {
  const listing = store.listings.find((l) => l.id === OFFER.fundamentals)!;
  store.orders.push({
    id: rivalOrderId,
    learner_id: MARCUS!.userId,
    listing_id: listing.id,
    // The seller is recorded on the ORDER, so a sale can name a coach who does
    // not own the listing today — which is exactly the row a coach_id filter
    // has to get right.
    coach_id: EMPTY_COACH,
    price_cents_at_purchase: 1234,
    price_epoch: listing.price_epoch,
    created_at: new Date().toISOString(),
  });
});
const corySalesNow = await db.listOrdersForCoach(COACH, COACH!.userId);
expectEqual('a second coach’s sale now exists in the store', (await db.listOrdersForCoach(ADMIN, EMPTY_COACH)).length, 1);
expectEqual('...and it is NOT in the first coach’s sales list', corySalesNow.some((sale) => sale.id === rivalOrderId), false);
expectEqual('...whose count is unchanged by it', corySalesNow.length, 10);
expectEqual(
  '...and every row there is still the first coach’s',
  corySalesNow.every((sale) => sale.coach_id === COACH!.userId),
  true,
);
const rivalSales = await db.listOrdersForCoach(NILS, EMPTY_COACH);
expectEqual('the second coach sees his own sale', rivalSales.length, 1);
expectEqual('...and only his', rivalSales.every((sale) => sale.coach_id === EMPTY_COACH), true);
// Removed again so every later assertion describes the seeded shape.
await mutateDb((store) => {
  store.orders = store.orders.filter((order) => order.id !== rivalOrderId);
});
expectEqual('second-coach sale fixture removed', (await db.listOrdersForCoach(ADMIN, EMPTY_COACH)).length, 0);
// The one that matters: the count is public, the rows are not.
await refuses('a learner may NOT list a coach’s sales', 'forbidden', () =>
  db.listOrdersForCoach(MARCUS, COACH!.userId),
);
await refuses('a coach may not list ANOTHER coach’s sales', 'forbidden', () =>
  db.listOrdersForCoach(COACH, EMPTY_COACH),
);
await refuses('a forged admin role does not unlock a coach’s sales', 'forbidden', () =>
  db.listOrdersForCoach({ userId: MARCUS!.userId, role: 'admin' } as unknown as Actor, COACH!.userId),
);
expectEqual(
  'the sales COUNT is still public with no actor at all',
  (await db.getCoachStats(COACH!.userId)).sales_count,
  10,
);

// ---------------------------------------------------------------------------
section('Anonymous actor is refused every mutation');
// ---------------------------------------------------------------------------
await refuses('anon createListing', 'unauthorized', () => db.createListing(ANON, LISTING));
await refuses('anon createInvite', 'unauthorized', () => db.createInvite(ANON, {}));
await refuses('anon listInvites', 'unauthorized', () => db.listInvites(ANON));
await refuses('anon revokeInvite', 'unauthorized', () => db.revokeInvite(ANON, 'JAVELIN-COACH-2026'));
await refuses('anon redeemInviteCode', 'unauthorized', () => db.redeemInviteCode(ANON, 'JAVELIN-COACH-2026'));
await refuses('anon createCoachApplication', 'unauthorized', () => db.createCoachApplication(ANON, APPLICATION));
await refuses('anon getMyCoachApplication', 'unauthorized', () => db.getMyCoachApplication(ANON));
await refuses('anon listCoachApplications', 'unauthorized', () => db.listCoachApplications(ANON));
await refuses('anon reviewCoachApplication', 'unauthorized', () =>
  db.reviewCoachApplication(ANON, 'any-id', 'approved'),
);
// A valid payload on purpose: the refusal has to come from the actor check, not
// from validation happening to fire first.
await refuses('anon createReview', 'unauthorized', () =>
  db.createReview(ANON, { order_id: ORDER.aishaOnClinic, rating: 5, body: 'Anonymous review attempt.' }),
);

// ---------------------------------------------------------------------------
section('Public reads need no actor; profiles do NOT leak email');
// ---------------------------------------------------------------------------
// These are positive controls, so they assert CONTENT, not merely that the call
// returned. `allows()` on its own only proves the method did not throw — a read
// that started returning `null` or `[]` to everyone would sail through it, and
// that is exactly the shape of the bug a permission check is supposed to have.
const anonSearch = await allows('anon listListings', () => db.listListings({ q: 'javelin' }), (r) => `${r.length} result(s)`);
expectEqual('...and it actually returned the matching listing', anonSearch?.length, 1);
const anonListing = await allows(
  'anon getListing',
  () => db.getListing(seedListings[0]!.id),
  (r) => `"${r?.title}" by ${r?.coach_name}`,
);
expectEqual('...and it is the listing that was asked for', anonListing?.id, seedListings[0]!.id);
expectEqual('...joined to its coach name', anonListing?.coach_name, 'Cory Vaughn');
// `withCoach()` is built at four call sites and they are all public reads, so
// the shape is asserted at every one of them rather than at the first.
// A missing `deleted_at` here is invisible to every behavioural assertion in
// this file — a listing without the column reads as published — so this is the
// only thing that catches it.
expectShape('getListing hands out exactly the listing columns', anonListing, LISTING_WITH_COACH_COLUMNS);
expectShape('listListings hands out the same columns', anonSearch?.[0], LISTING_WITH_COACH_COLUMNS);
expectShape(
  'listListingsByCoach hands out the same columns',
  (await db.listListingsByCoach(ANON, COACH!.userId))[0],
  LISTING_WITH_COACH_COLUMNS,
);
expectEqual('a published listing carries a NULL deleted_at, not a missing one', anonListing?.deleted_at, null);

const publicCoach = await allows(
  'anon getPublicProfile',
  () => db.getPublicProfile(COACH!.userId),
  (r) => JSON.stringify(r),
);

// The public projection must not become an oracle. `role` would let anyone
// enumerate administrators; `coach_status` would publish every user's
// pending_review / rejected state.
expectEqual(
  'getPublicProfile exposes exactly id, full_name, is_approved_coach, avatar_path',
  publicCoach === null ? 'null' : Object.keys(publicCoach).sort().join(','),
  'avatar_path,full_name,id,is_approved_coach',
);
expectEqual('getPublicProfile omits email', publicCoach !== null && !('email' in publicCoach), true);
expectEqual('getPublicProfile omits role', publicCoach !== null && !('role' in publicCoach), true);
expectEqual('getPublicProfile omits coach_status', publicCoach !== null && !('coach_status' in publicCoach), true);
expectEqual('getPublicProfile does expose the verified-coach flag', publicCoach?.is_approved_coach, true);

// The load-bearing one: an admin must be indistinguishable from anyone else.
const publicAdmin = await db.getPublicProfile(ADMIN!.userId);
const publicLearner = await db.getPublicProfile(LEARNER!.userId);
// A substring scan of the payload would be unsound: the seeded admin's
// full_name is "Ada Administrator", and a display name is chosen by the user,
// not a privilege disclosure. Assert structurally instead — no privilege-bearing
// key, and no value that is a role/status enum member.
const PRIVILEGE_KEYS = ['role', 'coach_status', 'email', 'is_admin'];
// Derived from the exported enums rather than hardcoded, so a new role or
// coach_status can never silently fall outside this check.
const ENUM_VALUES: string[] = [...ROLES, ...COACH_STATUSES];
expectEqual(
  'getPublicProfile(adminId) exposes no privilege-bearing key',
  PRIVILEGE_KEYS.some((k) => k in (publicAdmin ?? {})),
  false,
);
expectEqual(
  'no value in the admin public row leaks a role/status enum member',
  Object.entries(publicAdmin ?? {}).some(
    ([k, v]) => k !== 'full_name' && typeof v === 'string' && ENUM_VALUES.includes(v.toLowerCase()),
  ),
  false,
);
expectEqual(
  'admin and learner public rows have an identical shape',
  Object.keys(publicAdmin ?? {}).sort().join(',') === Object.keys(publicLearner ?? {}).sort().join(','),
  true,
);
note(`admin as seen by anon: ${JSON.stringify(publicAdmin)}`);
await refuses('anon getProfile (full row with email)', 'unauthorized', () => db.getProfile(ANON, COACH!.userId));
await refuses("learner getProfile of someone else's row", 'forbidden', () => db.getProfile(LEARNER, COACH!.userId));
const ownRow = await allows(
  'learner getProfile of own row',
  () => db.getProfile(LEARNER, LEARNER!.userId),
  (r) => `${r?.email}`,
);
expectEqual('...and the row really is theirs', ownRow?.id, LEARNER!.userId);
const adminRead = await allows('admin getProfile of any row', () => db.getProfile(ADMIN, COACH!.userId), (r) => `${r?.email}`);
expectEqual('...and an admin really does get the requested row', adminRead?.id, COACH!.userId);

// Search must match only the columns Postgres indexes (title + description).
// Neither the stored slug nor the rendered label is a searchable column.
expectEqual(
  'search does NOT match on the category slug (SQL parity)',
  (await db.listListings({ q: 'mobility_plan' })).length,
  0,
);
expectEqual(
  'search does NOT match on the category label (SQL parity)',
  (await db.listListings({ q: 'Mobility plan' })).length,
  0,
);
expectEqual('search does NOT match on coach name (SQL parity)', (await db.listListings({ q: 'Cory' })).length, 0);
expectEqual('search matches on title', (await db.listListings({ q: 'crossover' })).length, 1);
expectEqual('search matches on description', (await db.listListings({ q: 'check mark' })).length, 1);

// ---------------------------------------------------------------------------
section('createListing is gated on STORED coach_status');
// ---------------------------------------------------------------------------
await refuses('learner (coach_status=none) createListing', 'forbidden', () => db.createListing(LEARNER, LISTING));

// An Actor carries a user id and nothing else; smuggling a role changes nothing
// because the data layer re-reads the profile from the store on every call.
// Several shapes, because "we ignore an extra property" and "we ignore an
// inherited property" are different claims.
const forgedShapes: Array<[string, Actor]> = [
  ['extra role/coach_status properties', { userId: LEARNER!.userId, role: 'admin', coach_status: 'approved' } as unknown as Actor],
  ['role on the PROTOTYPE chain', Object.assign(Object.create({ role: 'admin', coach_status: 'approved' }), { userId: LEARNER!.userId }) as Actor],
  ['role as a getter', Object.defineProperty({ userId: LEARNER!.userId }, 'role', { get: () => 'admin', enumerable: true }) as Actor],
  ['nested claims object', { userId: LEARNER!.userId, claims: { role: 'admin' }, app_metadata: { role: 'admin' } } as unknown as Actor],
];
for (const [shape, actor] of forgedShapes) {
  await refuses(`forged actor (${shape}) cannot createListing`, 'forbidden', () => db.createListing(actor, LISTING));
  await refuses(`forged actor (${shape}) cannot listInvites`, 'forbidden', () => db.listInvites(actor));
}

// Malformed actors must fail closed, never be treated as a valid session.
const malformed: Array<[string, Actor]> = [
  ['empty userId', { userId: '' } as Actor],
  ['whitespace userId', { userId: '   ' } as Actor],
  ['numeric userId', { userId: 12345 } as unknown as Actor],
  ['object userId with toString', { userId: { toString: () => LEARNER!.userId } } as unknown as Actor],
  ['undefined userId', {} as unknown as Actor],
];
for (const [shape, actor] of malformed) {
  await refuses(`malformed actor (${shape}) is refused`, 'unauthorized', () => db.createListing(actor, LISTING));
}

// TOCTOU: an actor whose userId is a getter returning a DIFFERENT value on each
// read. If the data layer read it once to authorise and again to write, the
// listing could be authorised as the approved coach but written as the learner.
let reads = 0;
const toctouActor = Object.defineProperty({}, 'userId', {
  get: () => {
    reads += 1;
    return reads === 1 ? COACH!.userId : LEARNER!.userId;
  },
  enumerable: true,
}) as Actor;
try {
  const sneaked = await db.createListing(toctouActor, { ...LISTING, title: 'TOCTOU probe' });
  // Permitted outcome: it resolved ONE identity and used it consistently.
  expectEqual('TOCTOU getter actor: listing owner matches the authorised identity', sneaked.coach_id, COACH!.userId);
} catch (error) {
  // Equally acceptable: it failed closed.
  ok('TOCTOU getter actor: refused outright', isDataError(error) ? `${error.code}` : String(error));
}
note(`userId getter was read ${reads} time(s)`);

const created = await allows(
  'approved coach createListing',
  () => db.createListing(COACH, LISTING),
  (r) => `owned by ${r.coach_id}`,
);
// A new offer starts at pricing generation 1, never 0. The epoch is what the
// offer-level aggregates filter on, so a listing stamped 0 while its orders and
// reviews are stamped 1 would silently report every offer as having no sales and
// no reviews — an empty state that looks exactly like a genuine one.
expectEqual('a new listing starts at price_epoch 1', created?.price_epoch, 1);
expectShape('createListing returns exactly the projected listing columns', created, LISTING_WITH_COACH_COLUMNS);
// A new offer is on sale. Written explicitly rather than left off the row, so
// that every listing handed out has the column.
expectEqual('a new listing is published, not withdrawn', created?.deleted_at, null);
expectEqual(
  'every seeded listing is at a valid epoch',
  seedListings.every((l) => Number.isSafeInteger(l.price_epoch) && l.price_epoch >= 1),
  true,
);

// Input injection: coach_id and the server-controlled columns must all be
// ignored, not merely absent from the type.
const injected = await db.createListing(COACH, {
  ...LISTING,
  title: 'Injection probe',
  coach_id: LEARNER!.userId,
  id: '00000000-0000-4000-8000-0000000000ff',
  created_at: '1999-01-01T00:00:00.000Z',
  updated_at: '1999-01-01T00:00:00.000Z',
} as unknown as typeof LISTING);
expectEqual('injected coach_id is IGNORED (owner is the actor)', injected.coach_id, COACH!.userId);
expectEqual('injected id is IGNORED', injected.id === '00000000-0000-4000-8000-0000000000ff', false);
expectEqual('injected created_at is IGNORED', injected.created_at.startsWith('1999'), false);
expectEqual(
  'the injected coach_id did NOT gain a listing',
  (await db.listListingsByCoach(LEARNER, LEARNER!.userId)).length,
  0,
);

// Returned objects are copies: mutating one must not reach into the store.
if (created) {
  const before = (await db.getListing(created.id))!.title;
  created.title = 'MUTATED VIA RETURNED OBJECT';
  created.price_cents = 999999;
  expectEqual('mutating a returned listing does not alter the store', (await db.getListing(created.id))!.title, before);
}
const ownProfile = await db.getProfile(LEARNER, LEARNER!.userId);
if (ownProfile) {
  ownProfile.role = 'admin';
  ownProfile.coach_status = 'approved';
  expectEqual(
    'mutating a returned profile does not alter the store',
    (await db.getProfile(LEARNER, LEARNER!.userId))?.role,
    'learner',
  );
  await refuses('...and the mutated copy grants nothing', 'forbidden', () => db.listInvites(LEARNER));
}

// ---------------------------------------------------------------------------
section('Non-admin is refused admin-only operations');
// ---------------------------------------------------------------------------
await refuses('coach listInvites', 'forbidden', () => db.listInvites(COACH));
await refuses('coach createInvite', 'forbidden', () => db.createInvite(COACH, { note: 'nope' }));
await refuses('coach revokeInvite', 'forbidden', () => db.revokeInvite(COACH, 'JAVELIN-COACH-2026'));
await refuses('learner listInvites', 'forbidden', () => db.listInvites(LEARNER));
await refuses('learner createInvite', 'forbidden', () => db.createInvite(LEARNER, {}));
await refuses('learner listCoachApplications', 'forbidden', () => db.listCoachApplications(LEARNER));
await refuses('coach reviewCoachApplication', 'forbidden', () => db.reviewCoachApplication(COACH, 'x', 'approved'));
const adminInvites = await allows('admin listInvites', () => db.listInvites(ADMIN), (r) => `${r.length} invite(s)`);
expectEqual('...and the two seeded codes are actually there', adminInvites?.length, 2);
const minted = await allows('admin createInvite', () => db.createInvite(ADMIN, { note: 'from test' }), (r) => `minted ${r.code}`);
expectEqual('...and it minted a real code owned by the admin', minted?.created_by, ADMIN!.userId);
expectEqual('...with a code to redeem', typeof minted?.code === 'string' && minted.code.length > 0, true);

// ---------------------------------------------------------------------------
section('D1 regression — applying reaches coach_status=pending_review');
// ---------------------------------------------------------------------------
// Both halves of "apply" must land together: the application row AND the
// applicant's coach_status. In SQL this is public.apply_to_coach(); a client
// that inserted the row directly would be refused the profile write by
// guard_profile_privilege_columns and end up permanently wedged.
const filed = await allows(
  'learner createCoachApplication',
  () => db.createCoachApplication(LEARNER, APPLICATION),
  (r) => `application status=${r.status}`,
);
expectEqual('D1: half one — application row exists', (await db.getMyCoachApplication(LEARNER))?.id, filed?.id);
expectEqual('D1: half two — applicant coach_status is pending_review', await coachStatusOf(LEARNER!.userId), 'pending_review');

await refuses('pending_review actor createListing', 'forbidden', () => db.createListing(LEARNER, LISTING));
await refuses('duplicate pending application', 'conflict', () => db.createCoachApplication(LEARNER, APPLICATION));

const queue = await db.listCoachApplications(ADMIN, { status: 'pending' });
expectEqual('admin sees 1 pending application', queue.length, 1);
note(`queue row: ${queue[0]?.user_name} <${queue[0]?.user_email}> status=${queue[0]?.user_coach_status}`);

await allows(
  'admin reviewCoachApplication(approved)',
  () => db.reviewCoachApplication(ADMIN, queue[0]!.id, 'approved', 'Strong record.'),
  (r) => `status=${r.status} reviewed_by=${r.reviewed_by ? 'set' : 'null'} reviewed_at=${r.reviewed_at ? 'set' : 'null'}`,
);
expectEqual('applicant coach_status after approval', await coachStatusOf(LEARNER!.userId), 'approved');
expectEqual('applicant role after approval', await roleOf(LEARNER!.userId), 'coach');
await refuses('re-reviewing an already reviewed application', 'conflict', () =>
  db.reviewCoachApplication(ADMIN, queue[0]!.id, 'rejected'),
);
const afterApproval = await allows(
  'newly approved coach can now createListing',
  () => db.createListing(LEARNER, { ...LISTING, title: 'Freshly approved listing' }),
  (r) => `created "${r.title}"`,
);
expectEqual('...and it is owned by them', afterApproval?.coach_id, LEARNER!.userId);
expectEqual('...and readable back out of the store', (await db.getListing(afterApproval!.id))?.title, 'Freshly approved listing');

// ---------------------------------------------------------------------------
section('D2 regression — promotion raises privilege, never lowers it');
// ---------------------------------------------------------------------------
// An admin who redeems an invite code must still be an admin afterwards.
// Previously `role = 'coach'` was assigned unconditionally, which locked the
// only admin out of every admin operation with no supported way back.
const adminBefore = await roleOf(ADMIN!.userId);
await allows(
  'D2: admin redeems an invite code',
  () => db.redeemInviteCode(ADMIN, 'THROWERS-WELCOME'),
  (r) => `role=${r.role} coach_status=${r.coach_status}`,
);
expectEqual('D2: admin role BEFORE redeeming', adminBefore, 'admin');
expectEqual('D2: admin is STILL an admin after redeeming', await roleOf(ADMIN!.userId), 'admin');
expectEqual('D2: admin did gain approved coach status', await coachStatusOf(ADMIN!.userId), 'approved');
const invitesAfterRedeem = await allows(
  'D2: admin still has admin powers after redeeming',
  () => db.listInvites(ADMIN),
  (r) => `${r.length} invite(s) still visible`,
);
expectEqual('D2: ...and the invite list is not silently empty', (invitesAfterRedeem ?? []).length >= 2, true);

// An admin must not review their own application.
const selfApprover = await signUpProfile({
  email: 'selfapprover@javelin.test',
  password: 'password123',
  fullName: 'Sam Selfapprover',
});
await grantAdmin(selfApprover.id);
const SELF: Actor = { userId: selfApprover.id };
expectEqual('D2: second admin created (test setup, mirrors grant_admin())', await roleOf(selfApprover.id), 'admin');

const ownApplication = (await db.createCoachApplication(SELF, APPLICATION)) as CoachApplication;
await refuses('D2: admin cannot approve their OWN application', 'forbidden', () =>
  db.reviewCoachApplication(SELF, ownApplication.id, 'approved'),
);
await refuses('D2: admin cannot reject their OWN application either', 'forbidden', () =>
  db.reviewCoachApplication(SELF, ownApplication.id, 'rejected'),
);

// A different admin may review it — and approving an admin must not demote them.
await allows(
  'D2: a DIFFERENT admin may review it',
  () => db.reviewCoachApplication(ADMIN, ownApplication.id, 'approved', 'Fine.'),
  (r) => `status=${r.status}`,
);
expectEqual('D2: approved admin is STILL an admin', await roleOf(selfApprover.id), 'admin');
expectEqual('D2: approved admin gained coach status', await coachStatusOf(selfApprover.id), 'approved');

// ---------------------------------------------------------------------------
section('Application flow: rejection');
// ---------------------------------------------------------------------------
const rejectMe: Profile = await signUpProfile({
  email: 'reject@javelin.test',
  password: 'password123',
  fullName: 'Rhea Jekt',
});
const REJECT: Actor = { userId: rejectMe.id };
expectEqual('signUp always creates a learner', rejectMe.role, 'learner');
expectEqual('signUp always creates coach_status=none', rejectMe.coach_status, 'none');
await db.createCoachApplication(REJECT, APPLICATION);
const pendingRejected = (await db.listCoachApplications(ADMIN, { status: 'pending' }))[0]!;
await allows(
  'admin reviewCoachApplication(rejected)',
  () => db.reviewCoachApplication(ADMIN, pendingRejected.id, 'rejected', 'Not enough experience yet.'),
  (r) => `status=${r.status}`,
);
expectEqual('rejected applicant coach_status', await coachStatusOf(REJECT.userId), 'rejected');
expectEqual('rejection leaves role untouched', await roleOf(REJECT.userId), 'learner');
await refuses('rejected applicant createListing', 'forbidden', () => db.createListing(REJECT, LISTING));

// ---------------------------------------------------------------------------
section('Invite redemption');
// ---------------------------------------------------------------------------
const redeemer = await signUpProfile({ email: 'invitee@javelin.test', password: 'password123', fullName: 'Ivan Vitee' });
const INVITEE: Actor = { userId: redeemer.id };
expectEqual('invitee starts as learner', redeemer.coach_status, 'none');
await refuses('invitee createListing before redeeming', 'forbidden', () => db.createListing(INVITEE, LISTING));

await allows(
  'redeem valid code (case-insensitive + whitespace-trimmed)',
  () => db.redeemInviteCode(INVITEE, '  javelin-coach-2026  '),
  (r) => `role=${r.role} coach_status=${r.coach_status}`,
);
expectEqual('redeemer coach_status is approved', await coachStatusOf(INVITEE.userId), 'approved');
expectEqual('redeemer role is coach', await roleOf(INVITEE.userId), 'coach');
const afterRedeem = await allows(
  'redeemer can now createListing',
  () => db.createListing(INVITEE, { ...LISTING, title: 'Listing after invite' }),
  (r) => `created "${r.title}"`,
);
expectEqual('...and it is owned by the redeemer', afterRedeem?.coach_id, INVITEE.userId);

const second = await signUpProfile({ email: 'second@javelin.test', password: 'password123', fullName: 'Sara Cond' });
await refuses('redeeming the SAME code a second time', 'invalid', () =>
  db.redeemInviteCode({ userId: second.id }, 'JAVELIN-COACH-2026'),
);
await refuses('redeeming an unknown code', 'invalid', () => db.redeemInviteCode({ userId: second.id }, 'NOPE-NOPE'));
expectEqual('failed redemption did not promote', await coachStatusOf(second.id), 'none');

const expired = await db.createInvite(ADMIN, { note: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' });
await refuses('redeeming an expired code', 'invalid', () => db.redeemInviteCode({ userId: second.id }, expired.code));
const revoked = await db.createInvite(ADMIN, { note: 'revoked' });
await db.revokeInvite(ADMIN, revoked.code);
await refuses('redeeming a revoked code', 'invalid', () => db.redeemInviteCode({ userId: second.id }, revoked.code));

// Concurrent redemption of a FRESH code: exactly one winner, exactly one
// promotion. Racing an already-spent code (as an earlier revision of this file
// did) asserts nothing — zero winners is also what code with no concurrency
// control at all would produce.
const contested = await db.createInvite(ADMIN, { note: 'contested' });
const racerA = await signUpProfile({ email: 'racer-a@javelin.test', password: 'password123', fullName: 'Ana Race' });
const racerB = await signUpProfile({ email: 'racer-b@javelin.test', password: 'password123', fullName: 'Bo Race' });
const racerC = await signUpProfile({ email: 'racer-c@javelin.test', password: 'password123', fullName: 'Cal Race' });

const racers = await Promise.allSettled([
  db.redeemInviteCode({ userId: racerA.id }, contested.code),
  db.redeemInviteCode({ userId: racerB.id }, contested.code),
  db.redeemInviteCode({ userId: racerC.id }, contested.code),
]);
const winners = racers.filter((r) => r.status === 'fulfilled');
expectEqual('3-way race on a FRESH code: exactly one winner', winners.length, 1);
expectEqual(
  'the two losers all failed with invalid',
  racers
    .filter((r) => r.status === 'rejected')
    .every((r) => isDataError(r.reason) && r.reason.code === 'invalid'),
  true,
);
const promotedRacers = (
  await Promise.all([racerA.id, racerB.id, racerC.id].map(async (id) => await coachStatusOf(id)))
).filter((status) => status === 'approved');
expectEqual('exactly one racer was promoted', promotedRacers.length, 1);
const claimedBy = (await db.listInvites(ADMIN)).find((i) => i.code === contested.code)?.redeemed_by;
expectEqual(
  'the invite records exactly the winning redeemer',
  claimedBy !== null && claimedBy !== undefined && [racerA.id, racerB.id, racerC.id].includes(claimedBy),
  true,
);

// ---------------------------------------------------------------------------
section('Input validation');
// ---------------------------------------------------------------------------
await refuses('createListing with empty title', 'invalid', () => db.createListing(COACH, { ...LISTING, title: '  ' }));
await refuses('createListing with negative price', 'invalid', () =>
  db.createListing(COACH, { ...LISTING, price_cents: -1 }),
);
await refuses('createListing with fractional price', 'invalid', () =>
  db.createListing(COACH, { ...LISTING, price_cents: 12.5 }),
);

// ---------------------------------------------------------------------------
// The category taxonomy is closed. `CreateListingInput.category` is typed to the
// union, but a Server Action is a public HTTP endpoint and the type is erased at
// runtime — so the refusal has to be enforced, not merely declared. Every case
// below is cast past the type on purpose, standing in for a crafted POST.
const badCategories: Array<[string, unknown]> = [
  ['an unknown slug', 'strength_and_conditioning'],
  ['a slug that no longer exists', 'track_and_field'],
  ['the LABEL instead of the slug', 'Training plan'],
  ['a label with the old free-text spelling', 'Track & Field'],
  ['the empty string', ''],
  ['whitespace only', '   '],
  ['a SQL-injection-shaped string', "training_plan'); drop table public.listings; --"],
  ['an HTML-injection-shaped string', '<script>alert(1)</script>'],
  ['a slug with a trailing payload', 'training_plan other'],
  // Built with fromCharCode rather than a literal control byte, so this file
  // stays plain text and greppable.
  ['a NUL-truncation attempt', `training_plan${String.fromCharCode(0)}; drop table public.listings`],
  ['a case variant', 'TRAINING_PLAN'],
  ['a number', 7],
  ['null', null],
  ['an object with a toString', { toString: () => 'training_plan' }],
  ['an array containing a valid slug', ['training_plan']],
];
for (const [shape, category] of badCategories) {
  await refuses(`createListing rejects ${shape}`, 'invalid', () =>
    db.createListing(COACH, { ...LISTING, category } as unknown as typeof LISTING),
  );
}
expectEqual(
  'no rejected category reached the store',
  (await db.listListings()).every((l) => (LISTING_CATEGORIES as readonly string[]).includes(l.category)),
  true,
);
// A filter value outside the taxonomy must match nothing, and specifically must
// not be treated as "no filter" — that would answer a filtered URL with the
// whole catalogue.
expectEqual(
  'listListings with an out-of-taxonomy category matches nothing, not everything',
  (await db.listListings({ category: 'Track & Field' as unknown as ListingCategory })).length,
  0,
);
const taxonomyProbes = await allows(
  'createListing accepts every slug in the taxonomy',
  async () =>
    await Promise.all(
      LISTING_CATEGORIES.map((category) =>
        db.createListing(COACH, { ...LISTING, title: `Taxonomy probe ${category}`, category }),
      ),
    ),
  (r) => `${r.length} accepted`,
);
expectEqual(
  '...and each one was stored under the slug it was given',
  (taxonomyProbes ?? []).every((l, i) => l.category === LISTING_CATEGORIES[i]),
  true,
);
await refuses('signUp with a duplicate email', 'conflict', () =>
  signUpProfile({ email: 'coach@javelin.test', password: 'password123', fullName: 'Impostor' }),
);
expectEqual(
  'signInWithPassword with a wrong password returns null',
  await db.signInWithPassword({ email: 'coach@javelin.test', password: 'wrong' }),
  null,
);
expectEqual(
  'signInWithPassword with the right password returns the profile',
  (await db.signInWithPassword({ email: 'coach@javelin.test', password: 'coach1234' }))?.email,
  'coach@javelin.test',
);

// ---------------------------------------------------------------------------
section('Legacy free-text category on a READ path (pre-taxonomy store)');
// ---------------------------------------------------------------------------
// `category` was free text before the taxonomy landed, and `data/db.json` is a
// long-lived gitignored file — so a real machine can be holding "Track & Field"
// right now. No client method can produce such a row any more, so it is written
// straight to the store, exactly as a pre-E1 build would have left it.
//
// What is pinned here is the DECISION: reads pass the value through untouched
// rather than laundering it into `other`, and rendering still yields readable
// text rather than `undefined`. `Listing.category` is typed
// `StoredListingCategory` for precisely this row; indexing
// LISTING_CATEGORY_LABELS with it does not compile, which is what forces every
// caller through listingCategoryLabel().
const LEGACY_CATEGORY = 'Track & Field';
const legacyId = '00000000-0000-4000-8000-00000000beef';
await mutateDb((store) => {
  const stamp = new Date().toISOString();
  store.listings.push({
    id: legacyId,
    coach_id: COACH!.userId,
    title: 'Pre-taxonomy legacy row',
    description: 'Written directly to the store, as a build from before the taxonomy would have left it.',
    price_cents: 1234,
    // Cast past the write type on purpose — this is the shape of old DATA, and
    // the point of the assertions below is that reads survive it.
    category: LEGACY_CATEGORY as unknown as ListingCategory,
    price_epoch: 1,
    deleted_at: null,
    deleted_by: null,
    // The two delivery columns at their backfilled values. A row written before
    // 0011 has neither; `seedDatabase()` repairs it to exactly this on load, and
    // writing it out here keeps the fixture a legacy CATEGORY row rather than
    // also a legacy delivery row, which is a different test.
    fulfilment: 'personalised',
    asset_path: null,
    created_at: stamp,
    updated_at: stamp,
  });
});

const legacyRead = await db.getListing(legacyId);
expectEqual('getListing passes a legacy category through UNCHANGED', legacyRead?.category, LEGACY_CATEGORY);
expectEqual(
  'getListing does NOT launder a legacy category into `other`',
  legacyRead?.category === 'other',
  false,
);
expectEqual(
  'listListings passes a legacy category through UNCHANGED',
  (await db.listListings()).find((l) => l.id === legacyId)?.category,
  LEGACY_CATEGORY,
);
// The blank-badge bug the read type exists to prevent: a caller indexing the
// label map directly would get `undefined` here (and TypeScript would type that
// expression as `string`). listingCategoryLabel() is total by construction.
expectEqual(
  'listingCategoryLabel renders legacy text rather than undefined or a blank',
  listingCategoryLabel(legacyRead!.category),
  LEGACY_CATEGORY,
);
expectEqual(
  'a legacy value never enters listCategories()',
  (await db.listCategories() as string[]).includes(LEGACY_CATEGORY),
  false,
);
// The documented, accepted consequence of passing through rather than laundering:
// the row is visible unfiltered but no filter can reach it, because the filter
// control only ever offers the eight.
expectEqual(
  'a legacy row is unreachable by its own category as a filter',
  (await db.listListings({ category: LEGACY_CATEGORY as unknown as ListingCategory })).length,
  0,
);
expectEqual(
  'a legacy row is still visible with no category filter',
  (await db.listListings()).some((l) => l.id === legacyId),
  true,
);
expectEqual(
  'createListing STILL refuses that same value as a write',
  await db
    .createListing(COACH, { ...LISTING, category: LEGACY_CATEGORY as unknown as ListingCategory })
    .then(() => 'accepted')
    .catch((e) => (isDataError(e) ? e.code : 'non-DataError')),
  'invalid',
);

// Remove it again so it cannot perturb the store-invariant checks below.
await mutateDb((store) => {
  store.listings = store.listings.filter((l) => l.id !== legacyId);
});
expectEqual('legacy fixture removed', (await db.getListing(legacyId)) === null, true);

// ---------------------------------------------------------------------------
section('createReview — a review cannot be forged for an order you do not own');
// ---------------------------------------------------------------------------
// This is the criterion the round exists to satisfy. Everything a review claims
// rests on the purchase behind it: no order, no review; somebody else's order,
// no review; the same order twice, no review. Break any one of these and
// "Verified purchase" becomes decoration.

// The load-bearing one, and it is aimed at an order with NO review yet: if the
// ownership check were removed, this call would SUCCEED. Against an
// already-reviewed order the duplicate check would catch it instead, and the
// assertion would pass for a reason that has nothing to do with ownership.
await refuses('a learner cannot review another learner’s UNREVIEWED order', 'forbidden', () =>
  db.createReview(LEARNER, {
    order_id: ORDER.aishaOnClinic,
    rating: 5,
    body: 'Forged against a purchase that has not been reviewed yet.',
  }),
);
expectEqual(
  'the forged review did not land',
  (await db.listMyOrders(AISHA)).find((o) => o.id === ORDER.aishaOnClinic)?.has_review,
  false,
);

// The same forgery against an order that HAS been reviewed. Kept as well as the
// one above, not instead of it: both shapes are what an attacker replays.
await refuses('a learner cannot review ANOTHER learner’s order', 'forbidden', () =>
  db.createReview(LEARNER, { order_id: ORDER.marcusOnFundamentals, rating: 5, body: 'Forged from another buyer.' }),
);
// Same forgery with a smuggled role/ownership claim on the actor. The data
// layer re-reads the order from the store, so none of it changes anything.
for (const [shape, actor] of [
  ['extra role property', { userId: LEARNER!.userId, role: 'admin' } as unknown as Actor],
  ['a forged learner_id claim', { userId: LEARNER!.userId, learner_id: MARCUS!.userId } as unknown as Actor],
  ['role on the PROTOTYPE chain', Object.assign(Object.create({ role: 'admin' }), { userId: LEARNER!.userId }) as Actor],
] as Array<[string, Actor]>) {
  await refuses(`forged actor (${shape}) still cannot review someone else’s order`, 'forbidden', () =>
    db.createReview(actor, { order_id: ORDER.marcusOnFundamentals, rating: 5, body: 'Forged with a crafted actor.' }),
  );
}
// Even an admin has no purchase, and admin is not a licence to write in
// somebody else's name.
await refuses('an admin cannot review an order they did not place', 'forbidden', () =>
  db.createReview(ADMIN, { order_id: ORDER.marcusOnFundamentals, rating: 5, body: 'Administrative opinion.' }),
);
await refuses('reviewing an order that does not exist', 'not_found', () =>
  db.createReview(LEARNER, { order_id: '00000000-0000-4000-8000-0000000dead3', rating: 5, body: 'No such purchase.' }),
);

// -----------------------------------------------------------------------
// E2-F4, closed here. An order is located by its OWN id and by nothing else.
// The mirror of these three already existed for `getOrder`'s lookup (see the
// "an order is not findable by its …" assertions above); `createReview`'s
// lookup had none, so all three widened predicates survived the suite green.
//
// The ownership check downstream still gates every path, so this was never a
// privilege issue — the residual bug is reviewing ONE OF YOUR OWN orders
// selected by the wrong predicate. Each target is chosen so that the widened
// predicate would find an order AISHA owns and has NOT reviewed, i.e. the
// mutant SUCCEEDS rather than merely failing differently:
//
//   learner_id  -> …0205 and …0210 are both hers and both unreviewed here
//   listing_id  -> …0105's only order is …0210, hers, unreviewed
//   coach_id    -> Cory sold every seeded order; the first match is Lena's,
//                  which answers `forbidden`, still not `not_found`
//
// Placed BEFORE the positive control below, which reviews …0205 and …0210 —
// after it, a widened predicate would hit the duplicate check and answer
// `conflict`, which is the E2-F1 trap all over again.
// -----------------------------------------------------------------------
const createReviewLookupProbes: Array<[string, string]> = [
  ['its buyer id', AISHA!.userId],
  ['its listing id', OFFER.shoulder],
  ['its seller id', COACH!.userId],
];
for (const [shape, orderId] of createReviewLookupProbes) {
  await refuses(`createReview cannot find an order by ${shape}`, 'not_found', () =>
    db.createReview(AISHA, { order_id: orderId, rating: 5, body: 'Aimed at a non-id column of a real order.' }),
  );
}
expectEqual(
  '...and none of those probes wrote a review',
  (await db.listReviewsForCoach(COACH!.userId)).length,
  8,
);
for (const [shape, actor] of [
  ['empty userId', { userId: '' } as Actor],
  ['undefined userId', {} as unknown as Actor],
] as Array<[string, Actor]>) {
  await refuses(`malformed actor (${shape}) cannot review`, 'unauthorized', () =>
    db.createReview(actor, { order_id: ORDER.aishaOnClinic, rating: 5, body: 'Malformed actor attempt.' }),
  );
}
expectEqual(
  'no forged attempt reached the store',
  (await db.listReviewsForCoach(COACH!.userId)).length,
  8,
);

// The control. Without a call that SUCCEEDS through the same path, every
// refusal above could be a method that refuses everything.
const written = await allows(
  'the buyer of an unreviewed order CAN review it',
  () =>
    db.createReview(AISHA, {
      order_id: ORDER.aishaOnClinic,
      rating: 3,
      body: 'Useful, though I wanted more on the crossover itself.',
    }),
  (r) => `${r.rating}★ on epoch ${r.price_epoch}`,
);
expectEqual('the review is attributed to the actor', written?.author_id, AISHA!.userId);
expectEqual('the offer is taken from the ORDER', written?.listing_id, OFFER.clinic);
expectEqual('the epoch is taken from the ORDER', written?.price_epoch, 1);

// -----------------------------------------------------------------------
// Server-resolved columns must be IGNORED when supplied, not merely absent
// from the type — a Server Action is a public endpoint and the type is erased.
//
// This call is aimed at …0210, which has NO review, precisely so the write
// actually happens: pointed at a reviewed order, the duplicate check answers
// first and every injected column below is unreachable, so the assertions would
// pass against a `createReview` that spreads `...input` straight into the row.
// Each column is then asserted individually — checking only that `author_id`
// equals the actor proves the column is populated, not that input was ignored,
// unless the input carried a DIFFERENT author_id, which this one does.
// -----------------------------------------------------------------------
const injectedReview = await allows(
  'a crafted payload on an UNREVIEWED order is accepted but sanitised',
  () =>
    db.createReview(AISHA, {
      order_id: ORDER.aishaOnShoulder,
      rating: 4,
      body: 'Written with every server-controlled column supplied in the payload.',
      id: '00000000-0000-4000-8000-0000000000fe',
      author_id: LEARNER!.userId,
      listing_id: OFFER.mentalPrep,
      price_epoch: 99,
      created_at: '1999-01-01T00:00:00.000Z',
      updated_at: '1999-01-01T00:00:00.000Z',
    } as unknown as { order_id: string; rating: number; body: string }),
  (r) => `stored as author ${r.author_id.slice(-4)} on offer ${r.listing_id.slice(-4)}`,
);
expectEqual('injected author_id is IGNORED (author is the actor)', injectedReview?.author_id, AISHA!.userId);
expectEqual('injected listing_id is IGNORED (offer comes from the order)', injectedReview?.listing_id, OFFER.shoulder);
expectEqual('injected price_epoch is IGNORED (epoch comes from the order)', injectedReview?.price_epoch, 1);
expectEqual('injected id is IGNORED', injectedReview?.id === '00000000-0000-4000-8000-0000000000fe', false);
expectEqual('injected created_at is IGNORED', injectedReview?.created_at.startsWith('1999'), false);
// And the consequences, from the outside: the offer named in the payload gained
// nothing, and the offer the order actually bought gained the review.
const injectedTarget = await db.getOfferStats(OFFER.mentalPrep);
expectEqual('the offer named in the payload gained no review', injectedTarget?.review_count, 0);
expectEqual('...and is still unrated', injectedTarget?.rating_average, null);
expectEqual('the offer the ORDER bought gained it', (await db.getOfferStats(OFFER.shoulder))?.review_count, 1);
expectEqual(
  'the learner named in the payload is not credited with it',
  (await db.listReviewsForListing(OFFER.shoulder)).every((r) => r.author_name === 'Aisha Bello'),
  true,
);

await refuses('a crafted payload on an already-reviewed order is still a conflict', 'conflict', () =>
  db.createReview(MARCUS, {
    order_id: ORDER.marcusOnFundamentals,
    rating: 4,
    body: 'Second thoughts, written with a crafted payload.',
    author_id: LEARNER!.userId,
    listing_id: OFFER.mentalPrep,
  } as unknown as { order_id: string; rating: number; body: string }),
);
await refuses('reviewing the SAME order twice', 'conflict', () =>
  db.createReview(AISHA, { order_id: ORDER.aishaOnClinic, rating: 5, body: 'Trying to review it again.' }),
);
await refuses('reviewing an order the seed already reviewed', 'conflict', () =>
  db.createReview(LEARNER, { order_id: ORDER.lenaOnFundamentals, rating: 1, body: 'Changed my mind about this one.' }),
);

// -----------------------------------------------------------------------
// The epoch comes from the ORDER, and the two can differ.
//
// Every seeded epoch-1 order on the re-priced offer is already reviewed, so the
// case is built: an unreviewed purchase made BEFORE the price rose. Reviewing it
// must stamp epoch 1 — the version actually bought — which means the review is
// archived on arrival: invisible on the offer page, counted on the account.
// This is the assertion that separates order-stamping from listing-stamping;
// with the listing's epoch it would stamp 2 and surface on the offer page.
// -----------------------------------------------------------------------
const preRiseOrderId = '00000000-0000-4000-8000-0000000000cb';
await mutateDb((store) => {
  const listing = store.listings.find((l) => l.id === OFFER.strength)!;
  store.orders.push({
    id: preRiseOrderId,
    learner_id: MARCUS!.userId,
    listing_id: listing.id,
    coach_id: listing.coach_id,
    price_cents_at_purchase: 8500,
    price_epoch: 1, // bought before the increase
    created_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
  });
});
const offerBefore = await db.getOfferStats(OFFER.strength);
const accountBefore = await db.getCoachStats(COACH!.userId);
const lateReview = await allows(
  'a buyer may review a purchase made before the price rose',
  () =>
    db.createReview(MARCUS, {
      order_id: preRiseOrderId,
      rating: 1,
      body: 'Reviewing the old version, long after the price went up.',
    }),
  (r) => `stamped epoch ${r.price_epoch}`,
);
expectEqual('the late review is stamped at the ORDER’s epoch, not the listing’s', lateReview?.price_epoch, 1);
const offerAfter = await db.getOfferStats(OFFER.strength);
expectEqual('it does not appear in the offer’s review count', offerAfter?.review_count, offerBefore?.review_count);
expectEqual('it does not move the offer rating', offerAfter?.rating_average, offerBefore?.rating_average);
expectEqual(
  'it does not appear on the offer page',
  (await db.listReviewsForListing(OFFER.strength)).some((r) => r.rating === 1),
  false,
);
// ...but the writing is not lost: it counts where every epoch counts.
const accountAfter = await db.getCoachStats(COACH!.userId);
expectEqual('it DOES count toward the coach account', accountAfter.review_count, accountBefore.review_count + 1);
expectEqual(
  'and it is readable on the coach profile',
  (await db.listReviewsForCoach(COACH!.userId)).some((r) => r.rating === 1),
  true,
);
// Remove it again so the totals below describe the seeded shape plus the two
// deliberate writes, and nothing else.
await mutateDb((store) => {
  store.reviews = store.reviews.filter((r) => r.order_id !== preRiseOrderId);
  store.orders = store.orders.filter((o) => o.id !== preRiseOrderId);
});
expectEqual('pre-increase fixture removed', (await db.getOrder(ADMIN, preRiseOrderId)) === null, true);

// A coach must not review their own offer, even holding a genuine order for it.
// The order is written straight to the store because there is no purchase path
// in the client — this is the only way the case can exist at all.
const selfOrderId = '00000000-0000-4000-8000-0000000000cc';
await mutateDb((store) => {
  const listing = store.listings.find((l) => l.id === OFFER.fundamentals)!;
  store.orders.push({
    id: selfOrderId,
    learner_id: COACH!.userId,
    listing_id: listing.id,
    coach_id: listing.coach_id,
    price_cents_at_purchase: listing.price_cents,
    price_epoch: listing.price_epoch,
    created_at: new Date().toISOString(),
  });
});
await refuses('a coach cannot review their own offer, even owning the order', 'forbidden', () =>
  db.createReview(COACH, { order_id: selfOrderId, rating: 5, body: 'A glowing review of my own offer.' }),
);
await mutateDb((store) => {
  store.orders = store.orders.filter((o) => o.id !== selfOrderId);
});
expectEqual('self-purchase fixture removed', (await db.getOrder(ADMIN, selfOrderId)) === null, true);

// Ratings. `0` is refused in particular: it is not a low score, it is the
// absence of one, and the whole "never render a zero" guarantee rests on it
// being unrepresentable.
const badRatings: Array<[string, unknown]> = [
  ['zero', 0],
  ['six', 6],
  ['negative', -1],
  ['a fraction', 4.5],
  ['a numeric string', '5'],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['null', null],
  ['a boolean', true],
  ['an array', [5]],
  ['an object with valueOf', { valueOf: () => 5 }],
];
// NOTE these two loops aim at orders that are ALREADY reviewed, which the rule
// three sections up forbids for a test of a stored outcome. It is safe here, and
// only here, for one reason: `createReview` validates its input BEFORE it opens
// the store, so `invalid` is decided before `conflict` can be.
//
// Move that validation inside `mutateDb`, after the duplicate check, and these
// loops do NOT start passing for the wrong reason — they start FAILING, loudly:
// 15 assertions report `expected code 'invalid', got 'conflict'`. `refuses()`
// compares the exact DataError code, so a conflict can never wear an `invalid`
// label. Verified by building that refactor and running it. A red suite is the
// safe outcome, and it is what you will actually see.
//
// The real limitation is narrower, and is the reason to re-aim these if you are
// ever changing this area: because the target orders are already reviewed, these
// 15 assertions prove only the error CODE. They do not prove that a bad rating
// fails to LAND IN THE STORE. Point them at an unreviewed order to get that too.
for (const [shape, rating] of badRatings) {
  await refuses(`createReview rejects a rating that is ${shape}`, 'invalid', () =>
    db.createReview(MARCUS, {
      order_id: ORDER.marcusOnFundamentals,
      rating,
      body: 'A body long enough to pass validation.',
    } as unknown as { order_id: string; rating: number; body: string }),
  );
}
const badBodies: Array<[string, unknown]> = [
  ['empty', ''],
  ['whitespace only', '   '],
  ['not a string', 42],
  ['too long', 'x'.repeat(2001)],
];
for (const [shape, body] of badBodies) {
  await refuses(`createReview rejects a body that is ${shape}`, 'invalid', () =>
    db.createReview(AISHA, { order_id: ORDER.aishaOnClinic, rating: 5, body } as unknown as {
      order_id: string;
      rating: number;
      body: string;
    }),
  );
}

// The aggregates are live, not a snapshot: the one accepted review moved both
// levels, and moved them differently.
const clinicAfter = await db.getOfferStats(OFFER.clinic);
expectEqual('the new review is counted at offer level', clinicAfter?.review_count, 2);
expectEqual('...and changed the offer rating', clinicAfter?.rating_average, 3.5);
// The offer that was sold-but-unrated in the seed now has exactly one rating —
// the sanitised crafted payload landed here, where its order pointed.
const shoulderAfter = await db.getOfferStats(OFFER.shoulder);
expectEqual('the sold-but-unrated offer now has its first review', shoulderAfter?.review_count, 1);
expectEqual('...and therefore a rating where it had none', shoulderAfter?.rating_average, 4);
const coachAfter = await db.getCoachStats(COACH!.userId);
expectEqual('both new reviews are counted at account level', coachAfter.review_count, 10);
expectEqual('...and changed the account rating', coachAfter.rating_average, 4.2);
expectEqual('a review never changes a sales count', coachAfter.sales_count, 10);
const clinicReviews = await db.listReviewsForListing(OFFER.clinic);
expectEqual('the new review renders on the offer', clinicReviews.length, 2);
expectEqual(
  'the new review is attributed by public name only',
  clinicReviews.some((r) => r.author_name === 'Aisha Bello' && !('email' in r)),
  true,
);

// ---------------------------------------------------------------------------
section('Soft delete — hidden everywhere public, counted everywhere account-level');
// ---------------------------------------------------------------------------
// The E2 round left this block as a TRIPWIRE: it planted a `deleted_at` field
// by hand, because no code wrote one, and pinned the coach's account totals
// across it. It passed trivially, by its own admission.
//
// It is now driven by the real `softDeleteListing()`, and it pins BOTH halves of
// the asymmetry in one place, which is the only way either half is meaningful:
//
//   * the offer really does vanish from every public read — miss one filter and
//     a withdrawn offer is silently back on sale;
//   * and the coach's account-level numbers do not move — add a `deleted_at`
//     filter to `coachStats()` or `listReviewsForCoach()` and a coach loses
//     their entire reputation the moment they withdraw anything.
//
// …0104 is the target because it has real seeded history (1 sale, 1 review). An
// offer with nothing attached would satisfy the account-level half whether the
// filter were there or not.
const withdrawnTitle = (await db.getListing(OFFER.video))!.title;
const listingRowsBefore = await mutateDb((store) => store.listings.length);
const beforeWithdrawal = await db.getCoachStats(COACH!.userId);
expectEqual('the tripwire offer has history to lose: sales', (await db.getOfferStats(OFFER.video))?.sales_count, 1);
expectEqual('...and reviews', (await db.getOfferStats(OFFER.video))?.review_count, 1);

const withdrawn = await allows(
  'the owning coach may withdraw an offer',
  () => db.softDeleteListing(COACH, OFFER.video),
  (r) => `deleted_at=${r.deleted_at}`,
);
expectEqual('...and it really is the offer that was asked for', withdrawn?.id, OFFER.video);
expectEqual(
  '...stamped with a timestamp, not merely flagged',
  typeof withdrawn?.deleted_at === 'string' && !Number.isNaN(Date.parse(withdrawn.deleted_at)),
  true,
);
expectShape('...and the returned row is exactly the projected listing', withdrawn, LISTING_WITH_COACH_COLUMNS);
// NEVER A ROW DELETE. The whole design rests on the row surviving.
expectEqual('no row was removed from the store', await mutateDb((store) => store.listings.length), listingRowsBefore);

// --- every public read path filters `deleted_at is null` --------------------
// Enumerated one by one rather than spot-checked: missing exactly one of these
// is the failure mode, and a single "it is gone from browse" assertion would not
// have caught it.
expectEqual('withdrawn: absent from listListings', (await db.listListings()).some((l) => l.id === OFFER.video), false);
expectEqual(
  'withdrawn: absent from a CATEGORY-filtered listListings',
  (await db.listListings({ category: 'video_review' })).some((l) => l.id === OFFER.video),
  false,
);
expectEqual(
  'withdrawn: absent from a KEYWORD-filtered listListings',
  (await db.listListings({ q: 'frame-by-frame' })).some((l) => l.id === OFFER.video),
  false,
);
expectEqual('withdrawn: getListing is null (a 404 for the public)', await db.getListing(OFFER.video), null);
expectEqual(
  'withdrawn: absent from the PUBLIC coach offer list',
  (await db.listListingsByCoach(ANON, COACH!.userId)).some((l) => l.id === OFFER.video),
  false,
);
expectEqual(
  'withdrawn: passing an actor does NOT widen listListingsByCoach, not even for its owner',
  (await db.listListingsByCoach(COACH, COACH!.userId)).some((l) => l.id === OFFER.video),
  false,
);
expectEqual('withdrawn: no offer-level stats row', await db.getOfferStats(OFFER.video), null);
expectEqual(
  'withdrawn: dropped from the BATCH offer stats, like an unknown id',
  (await db.listOfferStats([OFFER.video, OFFER.fundamentals])).map((s) => s.listing_id).join(','),
  OFFER.fundamentals,
);
expectEqual('withdrawn: its offer-page review list is empty', (await db.listReviewsForListing(OFFER.video)).length, 0);

// --- and the inverse: the account level must NOT have noticed ---------------
const afterWithdrawal = await db.getCoachStats(COACH!.userId);
expectEqual('a withdrawn offer still counts toward account sales', afterWithdrawal.sales_count, beforeWithdrawal.sales_count);
expectEqual('a withdrawn offer still counts toward account reviews', afterWithdrawal.review_count, beforeWithdrawal.review_count);
expectEqual('a withdrawn offer does not move the account rating', afterWithdrawal.rating_average, beforeWithdrawal.rating_average);
expectEqual(
  'its reviews are still readable on the coach profile',
  (await db.listReviewsForCoach(COACH!.userId)).some((r) => r.listing_id === OFFER.video),
  true,
);
expectEqual(
  '...still joined to the offer title, not to "Unknown offer"',
  (await db.listReviewsForCoach(COACH!.userId)).find((r) => r.listing_id === OFFER.video)?.listing_title,
  withdrawnTitle,
);
// A buyer's purchase list must not degrade either — `listingTitle()` is the one
// join that deliberately carries no filter.
expectEqual(
  'a buyer of a withdrawn offer still sees what they bought',
  (await db.listMyOrders({ userId: '00000000-0000-4000-8000-000000000013' })).find(
    (o) => o.listing_id === OFFER.video,
  )?.listing_title,
  withdrawnTitle,
);
expectEqual(
  'the selling coach still sees the sale',
  (await db.listOrdersForCoach(COACH, COACH!.userId)).some((o) => o.listing_id === OFFER.video),
  true,
);

// --- the owner's own dashboard read ----------------------------------------
const myListings = await allows(
  'the owner lists their own offers, withdrawn ones included',
  () => db.listMyListings(COACH),
  (r) => `${r.length} offer(s)`,
);
expectEqual(
  'listMyListings shows the withdrawn offer (this is how it gets restored)',
  myListings?.some((l) => l.id === OFFER.video),
  true,
);
expectEqual(
  '...carrying the withdrawal timestamp so a dashboard can label it',
  myListings?.find((l) => l.id === OFFER.video)?.deleted_at,
  withdrawn?.deleted_at,
);
expectEqual('...and every row really is the actor’s own', (myListings ?? []).every((l) => l.coach_id === COACH!.userId), true);
expectShape('listMyListings hands out the projection plus the takedown flag', myListings?.[0], OWNED_LISTING_COLUMNS);
await refuses('anon listMyListings', 'unauthorized', () => db.listMyListings(ANON));
// The coach id is derived from the actor, never taken as a parameter — so there
// is no shape of this call that reads someone else's withdrawn offers. Nils is
// an approved coach who owns nothing, which is what makes the emptiness here a
// real result rather than a broken read.
expectEqual('a coach with no offers gets an empty list, not somebody else’s', (await db.listMyListings(NILS)).length, 0);
for (const [shape, actor] of [
  ['coach_id claim', { userId: NILS!.userId, coach_id: COACH!.userId } as unknown as Actor],
  ['nested claims object', { userId: NILS!.userId, claims: { coach_id: COACH!.userId } } as unknown as Actor],
  ['role on the PROTOTYPE chain', Object.assign(Object.create({ role: 'admin' }), { userId: NILS!.userId }) as Actor],
] as Array<[string, Actor]>) {
  expectEqual(
    `listMyListings ignores a forged ${shape}`,
    (await db.listMyListings(actor)).length,
    0,
  );
}

// --- the tombstone ----------------------------------------------------------
// A withdrawn offer is a 404 for the public, and a tombstone for the three
// parties with a reason to see one. Without the last of those, a buyer's
// purchase history links into a dead end.
expectEqual('tombstone: anonymous gets nothing', await db.getListingForViewer(ANON, OFFER.video), null);
expectEqual(
  'tombstone: a signed-in stranger with no order gets nothing (a 404, not a refusal)',
  await db.getListingForViewer(NILS, OFFER.video),
  null,
);
for (const [shape, actor] of [
  ['a forged admin role', { userId: NILS!.userId, role: 'admin' } as unknown as Actor],
  ['a role on the PROTOTYPE chain', Object.assign(Object.create({ role: 'admin' }), { userId: NILS!.userId }) as Actor],
  ['a forged order claim', { userId: NILS!.userId, orders: [OFFER.video] } as unknown as Actor],
  ['a whitespace userId', { userId: '   ' } as Actor],
  ['an unknown userId (a session for a deleted account)', { userId: '00000000-0000-4000-8000-0000000dead9' } as Actor],
] as Array<[string, Actor]>) {
  expectEqual(`tombstone: ${shape} unlocks nothing`, await db.getListingForViewer(actor, OFFER.video), null);
}
// Tomas (…0013) bought …0104. This is the assertion the tombstone exists for.
const BUYER: Actor = { userId: '00000000-0000-4000-8000-000000000013' };
const buyerTombstone = await allows(
  'tombstone: the BUYER of a withdrawn offer still sees it',
  () => db.getListingForViewer(BUYER, OFFER.video),
  (r) => `${r?.state}`,
);
expectEqual('...as a tombstone, not as a live offer', buyerTombstone?.state, 'withdrawn');
expectEqual('...naming the offer they actually bought', buyerTombstone?.listing.title, withdrawnTitle);
expectEqual(
  '...with a non-null withdrawal date the caller does not have to dig for',
  buyerTombstone?.state === 'withdrawn' ? buyerTombstone.withdrawn_at : null,
  withdrawn?.deleted_at,
);
expectShape('...wrapping exactly a listing row', buyerTombstone?.listing, LISTING_WITH_COACH_COLUMNS);
expectEqual(
  'tombstone: the owning coach sees it',
  (await db.getListingForViewer(COACH, OFFER.video))?.state,
  'withdrawn',
);
expectEqual(
  'tombstone: an admin sees it',
  (await db.getListingForViewer(ADMIN, OFFER.video))?.state,
  'withdrawn',
);
// The positive control for the whole method: a read that returned `null` to
// everyone would satisfy every refusal above.
const publishedView = await allows(
  'getListingForViewer serves a PUBLISHED offer to anyone, including anon',
  () => db.getListingForViewer(ANON, OFFER.fundamentals),
  (r) => `${r?.state}: ${r?.listing.title}`,
);
expectEqual('...as published', publishedView?.state, 'published');
expectEqual('...and it is the offer that was asked for', publishedView?.listing.id, OFFER.fundamentals);
expectShape('...with exactly the listing columns', publishedView?.listing, LISTING_WITH_COACH_COLUMNS);
expectEqual(
  'getListingForViewer on an unknown id is null for everyone',
  await db.getListingForViewer(ADMIN, '00000000-0000-4000-8000-0000000dead4'),
  null,
);

// --- who may withdraw, and who may not --------------------------------------
await refuses('anon softDeleteListing', 'unauthorized', () => db.softDeleteListing(ANON, OFFER.fundamentals));
await refuses('a learner may not withdraw a coach’s offer', 'forbidden', () =>
  db.softDeleteListing(MARCUS, OFFER.fundamentals),
);
// Nils is an APPROVED coach. The only thing he is not is the owner.
await refuses('another approved coach may not withdraw it either', 'forbidden', () =>
  db.softDeleteListing(NILS, OFFER.fundamentals),
);
await refuses('a forged admin role does not unlock a withdrawal', 'forbidden', () =>
  db.softDeleteListing({ userId: MARCUS!.userId, role: 'admin' } as unknown as Actor, OFFER.fundamentals),
);
await refuses('withdrawing an unknown offer', 'not_found', () =>
  db.softDeleteListing(COACH, '00000000-0000-4000-8000-0000000dead5'),
);
await refuses('withdrawing an already-withdrawn offer', 'conflict', () => db.softDeleteListing(COACH, OFFER.video));
expectEqual(
  'none of those refusals withdrew anything',
  (await db.listListings()).some((l) => l.id === OFFER.fundamentals),
  true,
);

// The ADMIN TAKEDOWN — the deliberate asymmetry with updateListing, and it needs
// a positive control of its own or "admin is refused everywhere" would look the
// same. …0106 has nothing attached, so this touches no other assertion.
expectEqual('the admin actor really is an admin', await roleOf(ADMIN!.userId), 'admin');
const takenDown = await allows(
  'an ADMIN may withdraw a coach’s offer, as a takedown',
  () => db.softDeleteListing(ADMIN, OFFER.mentalPrep),
  (r) => `deleted_at=${r.deleted_at ? 'set' : 'null'}`,
);
expectEqual('...and it really is withdrawn', typeof takenDown?.deleted_at, 'string');
expectEqual('...gone from browse', (await db.listListings()).some((l) => l.id === OFFER.mentalPrep), false);

// --- restore ----------------------------------------------------------------
await refuses('anon restoreListing', 'unauthorized', () => db.restoreListing(ANON, OFFER.video));
await refuses('a learner may not restore a coach’s offer', 'forbidden', () => db.restoreListing(MARCUS, OFFER.video));
await refuses('another approved coach may not restore it', 'forbidden', () => db.restoreListing(NILS, OFFER.video));
await refuses('restoring an unknown offer', 'not_found', () =>
  db.restoreListing(COACH, '00000000-0000-4000-8000-0000000dead6'),
);
await refuses('restoring an offer that is not withdrawn', 'conflict', () =>
  db.restoreListing(COACH, OFFER.fundamentals),
);
const restored = await allows(
  'the owning coach may restore a withdrawn offer',
  () => db.restoreListing(COACH, OFFER.video),
  (r) => `deleted_at=${r.deleted_at}`,
);
expectEqual('...clearing the withdrawal', restored?.deleted_at, null);
expectEqual('...back in browse', (await db.listListings()).some((l) => l.id === OFFER.video), true);
expectEqual('...back on the public coach profile', (await db.listListingsByCoach(ANON, COACH!.userId)).some((l) => l.id === OFFER.video), true);
// NOTHING WAS DESTROYED, which is the whole justification for a soft delete.
expectEqual('...with its sales intact', (await db.getOfferStats(OFFER.video))?.sales_count, 1);
expectEqual('...with its reviews intact', (await db.getOfferStats(OFFER.video))?.review_count, 1);
expectEqual('...at the same pricing generation', (await db.getListing(OFFER.video))?.price_epoch, 1);
expectEqual('...and its offer page renders its reviews again', (await db.listReviewsForListing(OFFER.video)).length, 1);
expectEqual('...and it is a published detail read again', (await db.getListingForViewer(ANON, OFFER.video))?.state, 'published');
expectEqual('still no row was ever removed', await mutateDb((store) => store.listings.length), listingRowsBefore);
// ---------------------------------------------------------------------------
// A TAKEDOWN THE COACH CAN UNDO IN ONE CLICK IS NOT A TAKEDOWN.
//
// Both the owner and an admin may withdraw, so `deleted_at` alone cannot tell
// the two apart — which is the whole reason `deleted_by` exists. …0106 is
// currently withdrawn BY THE ADMIN, from the takedown block above.
// ---------------------------------------------------------------------------
await refuses('a coach may NOT restore an offer an admin took down', 'forbidden', () =>
  db.restoreListing(COACH, OFFER.mentalPrep),
);
expectEqual(
  '...and it stayed down',
  (await db.listListings()).some((l) => l.id === OFFER.mentalPrep),
  false,
);
await refuses('...nor with a forged admin role', 'forbidden', () =>
  db.restoreListing({ userId: COACH!.userId, role: 'admin' } as unknown as Actor, OFFER.mentalPrep),
);
// The takedown flag reaches the dashboard as a BOOLEAN — never as the admin's
// id, which is what makes it publishable to the coach at all.
const ownedDuringTakedown = (await db.listMyListings(COACH)).find((l) => l.id === OFFER.mentalPrep);
expectEqual('the dashboard can tell it was a takedown', ownedDuringTakedown?.withdrawn_by_admin, true);
expectEqual(
  '...and the flag is a boolean, not an administrator id',
  typeof ownedDuringTakedown?.withdrawn_by_admin,
  'boolean',
);
// THE leak check. `deleted_by` holds an ADMINISTRATOR's id here, and no shape
// reachable by anyone — coach, buyer, or the public — may carry it.
expectEqual('the owner dashboard hands out no deleted_by', 'deleted_by' in (ownedDuringTakedown ?? {}), false);
expectEqual(
  'no row in the owner dashboard carries deleted_by',
  (await db.listMyListings(COACH)).some((l) => 'deleted_by' in l),
  false,
);
const takedownTombstone = await db.getListingForViewer(COACH, OFFER.mentalPrep);
expectEqual('the tombstone hands out no deleted_by', 'deleted_by' in (takedownTombstone?.listing ?? {}), false);
expectShape('...and is exactly the projection', takedownTombstone?.listing, LISTING_WITH_COACH_COLUMNS);
expectEqual(
  'the ADMIN tombstone hands out no deleted_by either',
  'deleted_by' in ((await db.getListingForViewer(ADMIN, OFFER.mentalPrep))?.listing ?? {}),
  false,
);
// Sweep every listing-shaped thing the data layer hands out, so a future
// projection cannot regress one of them unnoticed.
expectEqual(
  'NO listing-shaped read anywhere hands out deleted_by',
  [
    ...(await db.listListings()),
    ...(await db.listListingsByCoach(ANON, COACH!.userId)),
    ...(await db.listMyListings(COACH)),
    (await db.getListing(OFFER.fundamentals))!,
    (await db.getListingForViewer(ANON, OFFER.fundamentals))!.listing,
  ].some((l) => 'deleted_by' in l),
  false,
);

// An admin may lift a takedown as well as apply one — the same actor set as
// softDeleteListing, so an admin is never left unable to undo their own action.
await allows('an ADMIN may restore what they took down', () => db.restoreListing(ADMIN, OFFER.mentalPrep), (r) => `${r.id.slice(-4)} restored`);
expectEqual('...and it is back in browse', (await db.listListings()).some((l) => l.id === OFFER.mentalPrep), true);
expectEqual(
  '...and it no longer reads as an admin takedown',
  (await db.listMyListings(COACH)).find((l) => l.id === OFFER.mentalPrep)?.withdrawn_by_admin,
  false,
);

// THE POSITIVE CONTROL for the whole rule. Without it, "restore refuses" is
// equally satisfied by a method that refuses everyone: a coach must still be
// able to undo their OWN withdrawal freely.
await db.softDeleteListing(COACH, OFFER.mentalPrep);
const ownWithdrawal = (await db.listMyListings(COACH)).find((l) => l.id === OFFER.mentalPrep);
expectEqual('a coach’s own withdrawal is not flagged as a takedown', ownWithdrawal?.withdrawn_by_admin, false);
const selfRestored = await allows(
  'a coach MAY restore an offer they withdrew themselves',
  () => db.restoreListing(COACH, OFFER.mentalPrep),
  (r) => `deleted_at=${r.deleted_at}`,
);
expectEqual('...and it is genuinely back', selfRestored?.deleted_at, null);
expectEqual('...and back in browse', (await db.listListings()).some((l) => l.id === OFFER.mentalPrep), true);
// Restoring clears the ATTRIBUTION as well as the timestamp. `deleted_by` is
// projected out of every read, so the store is the only place this is
// observable — and it is worth observing: `deleted_at` and `deleted_by` are one
// fact recorded in two columns, and a published row still naming a withdrawer
// is a half-written state that the next reader has to reason about.
expectEqual(
  'restoring clears the attribution, not just the timestamp',
  await mutateDb((store) => store.listings.find((l) => l.id === OFFER.mentalPrep)?.deleted_by),
  null,
);
expectEqual(
  'and NO published listing anywhere carries a withdrawal attribution',
  await mutateDb((store) => store.listings.filter((l) => l.deleted_at === null && l.deleted_by !== null).length),
  0,
);
// An admin may also lift a COACH's withdrawal — the actor set is the same in
// both directions, and this is the fourth corner of the matrix.
await db.softDeleteListing(COACH, OFFER.mentalPrep);
await allows(
  'an ADMIN may restore an offer the COACH withdrew',
  () => db.restoreListing(ADMIN, OFFER.mentalPrep),
  (r) => `deleted_at=${r.deleted_at}`,
);
expectEqual('...leaving it published', (await db.listListings()).some((l) => l.id === OFFER.mentalPrep), true);
// Restoring clears the attribution with the timestamp, so the NEXT withdrawal is
// judged on its own and not against a stale one.
await db.softDeleteListing(COACH, OFFER.mentalPrep);
expectEqual(
  'after an admin restore, the coach’s next withdrawal is their own again',
  (await db.listMyListings(COACH)).find((l) => l.id === OFFER.mentalPrep)?.withdrawn_by_admin,
  false,
);
await allows(
  '...and they can restore it without an admin',
  () => db.restoreListing(COACH, OFFER.mentalPrep),
  (r) => `deleted_at=${r.deleted_at}`,
);

// ---------------------------------------------------------------------------
// THE UNATTRIBUTED WITHDRAWAL — where restoreListing's OWNERSHIP check is the
// only thing standing.
//
// This block exists because a mutation test found the hole. With `deleted_by`
// populated, the takedown rule happens to refuse a stranger too (the row was
// withdrawn by someone who is not them), so deleting the ownership check
// entirely left the suite green. It is NOT redundant: a row withdrawn before
// this column existed, or by a hand-edited store, has `deleted_by === null`,
// the takedown rule correctly stands down as "unattributed" — and then
// ownership is the ONLY check left between a stranger and somebody else's
// offer.
// ---------------------------------------------------------------------------
await db.softDeleteListing(COACH, OFFER.mentalPrep);
await mutateDb((store) => {
  // The shape of an old row: withdrawn, with nobody recorded as having done it.
  store.listings.find((l) => l.id === OFFER.mentalPrep)!.deleted_by = null;
});
await refuses('an unattributed withdrawal is still not a stranger’s to restore', 'forbidden', () =>
  db.restoreListing(NILS, OFFER.mentalPrep),
);
await refuses('...nor a learner’s', 'forbidden', () => db.restoreListing(MARCUS, OFFER.mentalPrep));
expectEqual(
  '...and it stayed withdrawn',
  (await db.listListings()).some((l) => l.id === OFFER.mentalPrep),
  false,
);
// ...but the OWNER may restore it. The takedown rule fails OPEN on a null
// attribution deliberately: it grants an owner nothing they did not already
// have, and failing closed would strand a row nobody could restore.
await allows(
  'the owner MAY restore an unattributed withdrawal',
  () => db.restoreListing(COACH, OFFER.mentalPrep),
  (r) => `deleted_at=${r.deleted_at}`,
);
expectEqual('...and it is back', (await db.listListings()).some((l) => l.id === OFFER.mentalPrep), true);
const coachAfterRestore = await db.getCoachStats(COACH!.userId);
expectEqual('a full withdraw/restore cycle left the account totals identical', coachAfterRestore.sales_count, beforeWithdrawal.sales_count);
expectEqual('...including the review count', coachAfterRestore.review_count, beforeWithdrawal.review_count);
expectEqual('...including the rating', coachAfterRestore.rating_average, beforeWithdrawal.rating_average);

// ---------------------------------------------------------------------------
section('updateListing — owner only, NEVER an admin');
// ---------------------------------------------------------------------------
const lifecycle = (await db.createListing(COACH, {
  title: 'Lifecycle offer',
  description: 'A purpose-built offer for the edit, epoch and revision assertions below.',
  price_cents: 5000,
  category: 'training_plan',
}))!;
const EDIT = {
  title: 'Lifecycle offer',
  description: 'A purpose-built offer for the edit, epoch and revision assertions below.',
  price_cents: 5000,
  category: 'training_plan' as ListingCategory,
};

await refuses('anon updateListing', 'unauthorized', () => db.updateListing(ANON, lifecycle.id, EDIT));
await refuses('updating an offer that does not exist', 'not_found', () =>
  db.updateListing(COACH, '00000000-0000-4000-8000-0000000dead7', EDIT),
);

// THE assertion of this section. The admin is an approved coach by this point
// (D2 had them redeem an invite code), so the approved-coach clause cannot be
// what refuses them, the offer is published so the withdrawn clause cannot be,
// and the payload is valid so validation cannot be. Ownership is the only
// possible reason left — which is what makes this test worth anything.
expectEqual('the admin actor’s stored role', await roleOf(ADMIN!.userId), 'admin');
expectEqual('the admin actor is ALSO an approved coach, so approval cannot be what refuses', await coachStatusOf(ADMIN!.userId), 'approved');
await refuses('an ADMIN may NOT edit a coach’s offer', 'forbidden', () =>
  db.updateListing(ADMIN, lifecycle.id, { ...EDIT, title: 'Rewritten by an administrator' }),
);
expectEqual(
  '...and the coach’s copy is untouched',
  (await db.getListing(lifecycle.id))?.title,
  'Lifecycle offer',
);
// Nils: an approved coach who is simply not the owner.
await refuses('another approved coach may not edit it', 'forbidden', () =>
  db.updateListing(NILS, lifecycle.id, { ...EDIT, title: 'Rewritten by a rival coach' }),
);
await refuses('a learner may not edit it', 'forbidden', () => db.updateListing(MARCUS, lifecycle.id, EDIT));
for (const [shape, actor] of [
  ['extra role/coach_status properties', { userId: NILS!.userId, role: 'admin', coach_status: 'approved' } as unknown as Actor],
  ['a forged coach_id claim', { userId: NILS!.userId, coach_id: COACH!.userId } as unknown as Actor],
  ['role on the PROTOTYPE chain', Object.assign(Object.create({ role: 'admin' }), { userId: NILS!.userId }) as Actor],
] as Array<[string, Actor]>) {
  await refuses(`forged actor (${shape}) cannot edit someone else’s offer`, 'forbidden', () =>
    db.updateListing(actor, lifecycle.id, { ...EDIT, title: 'Rewritten with a crafted actor' }),
  );
}
expectEqual(
  'no refused edit reached the store',
  (await db.getListing(lifecycle.id))?.title,
  'Lifecycle offer',
);

// Input validation, and it fires for the owner too.
for (const [shape, patch] of [
  ['an empty title', { title: '  ' }],
  ['a negative price', { price_cents: -1 }],
  ['a fractional price', { price_cents: 12.5 }],
  ['an out-of-taxonomy category', { category: 'Track & Field' }],
  ['the category LABEL instead of the slug', { category: 'Training plan' }],
  ['a too-short description', { description: 'short' }],
] as Array<[string, Record<string, unknown>]>) {
  await refuses(`updateListing rejects ${shape}`, 'invalid', () =>
    db.updateListing(COACH, lifecycle.id, { ...EDIT, ...patch } as unknown as typeof EDIT),
  );
}

// The control. Every refusal above would hold for a method that refuses
// everything, so the owner has to get through the same path and the change has
// to be readable back out of the store.
const editedOnce = await allows(
  'the OWNER may edit their own offer',
  () =>
    db.updateListing(COACH, lifecycle.id, {
      title: 'Lifecycle offer, rewritten',
      description: 'Rewritten end to end, at exactly the same price, which is the case the epoch rule does not cover.',
      price_cents: 5000,
      category: 'mobility_plan',
    }),
  (r) => `"${r.title}" at ${r.price_cents}c, epoch ${r.price_epoch}`,
);
expectShape('...returning exactly the projected listing columns', editedOnce, LISTING_WITH_COACH_COLUMNS);
expectEqual('...the title really changed', editedOnce?.title, 'Lifecycle offer, rewritten');
expectEqual('...the category really changed', editedOnce?.category, 'mobility_plan');
expectEqual('...and the change is readable back out of the store', (await db.getListing(lifecycle.id))?.title, 'Lifecycle offer, rewritten');
// The id is what reviews and orders point at. It must survive an edit.
expectEqual('...the id never changes on an edit', editedOnce?.id, lifecycle.id);
expectEqual('...and neither does the owner', editedOnce?.coach_id, COACH!.userId);
// A coach whose approval is revoked loses the ability to EDIT.
await mutateDb((store) => {
  store.profiles.find((p) => p.id === COACH!.userId)!.coach_status = 'rejected';
});
await refuses('an owner whose coach approval was revoked may not edit', 'forbidden', () =>
  db.updateListing(COACH, lifecycle.id, { ...EDIT, title: 'Edited after losing approval' }),
);
// ...but must still be able to take their own offers off sale, or the offers are
// stuck published with only an admin able to act.
await allows(
  'an owner whose approval was revoked may still WITHDRAW',
  () => db.softDeleteListing(COACH, lifecycle.id),
  (r) => `deleted_at=${r.deleted_at ? 'set' : 'null'}`,
);
await allows('...and restore', () => db.restoreListing(COACH, lifecycle.id), (r) => `deleted_at=${r.deleted_at}`);
await mutateDb((store) => {
  store.profiles.find((p) => p.id === COACH!.userId)!.coach_status = 'approved';
});
expectEqual('coach approval restored for the rest of the suite', await coachStatusOf(COACH!.userId), 'approved');

// ---------------------------------------------------------------------------
section('The price epoch moves ONLY on an increase');
// ---------------------------------------------------------------------------
// This is the single most likely thing in the round to be subtly wrong, and the
// damage is silent: a cut or a no-op that bumped would archive an offer's rating,
// reviews and sales for nothing.
//
// So it is asserted twice over. First the counter itself, case by case. Then the
// CONSEQUENCE — real social proof planted on the offer, and the assertion that a
// cut leaves it alone while an increase archives it. A `>=` typo passes the
// first set of assertions on some inputs and fails the second on every one.
const epochOf = async (id: string): Promise<number | undefined> => (await db.getListing(id))?.price_epoch;
expectEqual('the offer under test starts at epoch 1', await epochOf(lifecycle.id), 1);

const epochCases: Array<[string, number, number]> = [
  // label, new price, expected epoch afterwards
  ['a content-only edit at the SAME price', 5000, 1],
  ['a price CUT', 4000, 1],
  ['a re-save at an UNCHANGED price', 4000, 1],
  ['a price INCREASE', 4500, 2],
  ['an increase of ONE CENT', 4501, 3],
  ['a deep cut after two increases', 100, 3],
  ['an increase back over the previous high', 9999, 4],
];
for (const [label, price, expected] of epochCases) {
  await db.updateListing(COACH, lifecycle.id, { ...EDIT, title: `Epoch probe: ${label}`, price_cents: price });
  expectEqual(`${label} -> epoch ${expected}`, await epochOf(lifecycle.id), expected);
}
// A caller cannot supply the epoch: it is derived from the price movement.
await db.updateListing(COACH, lifecycle.id, {
  ...EDIT,
  title: 'Epoch injection probe',
  price_cents: 9999,
  price_epoch: 99,
  id: '00000000-0000-4000-8000-0000000000fd',
  coach_id: MARCUS!.userId,
  deleted_at: new Date().toISOString(),
  created_at: '1999-01-01T00:00:00.000Z',
} as unknown as typeof EDIT);
const afterInjection = (await db.getListing(lifecycle.id))!;
expectEqual('an injected price_epoch is IGNORED (it derives from the price)', afterInjection.price_epoch, 4);
expectEqual('an injected coach_id is IGNORED (ownership is not transferable by an edit)', afterInjection.coach_id, COACH!.userId);
expectEqual('an injected id is IGNORED', afterInjection.id, lifecycle.id);
expectEqual('an injected deleted_at is IGNORED (an edit cannot withdraw an offer)', afterInjection.deleted_at, null);
expectEqual('an injected created_at is IGNORED', afterInjection.created_at.startsWith('1999'), false);

// --- the consequence, which is the part that actually matters ---------------
// Plant a purchase at the offer's CURRENT epoch and review it through the real
// path, so the offer has social proof there is something to destroy.
const epochOrderId = '00000000-0000-4000-8000-0000000000ca';
await mutateDb((store) => {
  const listing = store.listings.find((l) => l.id === lifecycle.id)!;
  store.orders.push({
    id: epochOrderId,
    learner_id: MARCUS!.userId,
    listing_id: listing.id,
    coach_id: listing.coach_id,
    price_cents_at_purchase: listing.price_cents,
    price_epoch: listing.price_epoch,
    created_at: new Date().toISOString(),
  });
});
await allows(
  'a planted buyer reviews the offer under test',
  () => db.createReview(MARCUS, { order_id: epochOrderId, rating: 5, body: 'Social proof, planted so there is something an epoch bump could destroy.' }),
  (r) => `${r.rating}★ at epoch ${r.price_epoch}`,
);
const provenBefore = await db.getOfferStats(lifecycle.id);
expectEqual('the offer now has a sale', provenBefore?.sales_count, 1);
expectEqual('...and a review', provenBefore?.review_count, 1);
expectEqual('...and a rating', provenBefore?.rating_average, 5);
const accountBeforeRepricing = await db.getCoachStats(COACH!.userId);

// A CUT. If the epoch moved here, the offer's rating, review and sale would all
// vanish — the exact silent destruction this rule exists to prevent.
await db.updateListing(COACH, lifecycle.id, { ...EDIT, title: 'Now cheaper', price_cents: 500 });
const afterCut = await db.getOfferStats(lifecycle.id);
expectEqual('a price CUT does not archive the sale', afterCut?.sales_count, 1);
expectEqual('a price CUT does not archive the review', afterCut?.review_count, 1);
expectEqual('a price CUT does not archive the rating', afterCut?.rating_average, 5);
expectEqual('...and the reviews still render on the offer page', (await db.listReviewsForListing(lifecycle.id)).length, 1);

// A CONTENT-ONLY rewrite. The documented, accepted limit: it keeps every review.
await db.updateListing(COACH, lifecycle.id, {
  ...EDIT,
  title: 'Completely different offer, same price',
  description: 'Every word of this is new. The price is not. This is the case listing_revisions exists for.',
  price_cents: 500,
});
const afterRewrite = await db.getOfferStats(lifecycle.id);
expectEqual('a content-only rewrite keeps the review (the accepted limit)', afterRewrite?.review_count, 1);
expectEqual('...and the rating', afterRewrite?.rating_average, 5);

// An UNCHANGED price. Equality must not bump either.
await db.updateListing(COACH, lifecycle.id, { ...EDIT, title: 'Saved again at the same price', price_cents: 500 });
expectEqual('an unchanged price keeps the review', (await db.getOfferStats(lifecycle.id))?.review_count, 1);

// An INCREASE. Now, and only now, the archive.
await db.updateListing(COACH, lifecycle.id, { ...EDIT, title: 'Now dearer', price_cents: 501 });
const afterRise = await db.getOfferStats(lifecycle.id);
expectEqual('a price INCREASE archives the sale', afterRise?.sales_count, 0);
expectEqual('a price INCREASE archives the review', afterRise?.review_count, 0);
expectEqual('...and the offer reads as unrated, not as rated zero', afterRise?.rating_average, null);
expectEqual('...and it is not the number zero', afterRise?.rating_average === 0, false);
expectEqual('...the offer page shows no reviews', (await db.listReviewsForListing(lifecycle.id)).length, 0);
// NOTHING WAS DELETED. The account level is the proof.
const accountAfterRepricing = await db.getCoachStats(COACH!.userId);
expectEqual('the archived sale still counts toward the coach account', accountAfterRepricing.sales_count, accountBeforeRepricing.sales_count);
expectEqual('the archived review still counts toward the coach account', accountAfterRepricing.review_count, accountBeforeRepricing.review_count);
expectEqual('...and the account rating is untouched by the price rise', accountAfterRepricing.rating_average, accountBeforeRepricing.rating_average);
expectEqual(
  '...and the archived review is still readable on the coach profile',
  (await db.listReviewsForCoach(COACH!.userId)).some((r) => r.listing_id === lifecycle.id),
  true,
);

// ---------------------------------------------------------------------------
section('listing_revisions — the append-only record of what an offer used to say');
// ---------------------------------------------------------------------------
// A SECOND COACH WITH A SECOND EDITED OFFER, and it has to exist before the
// assertions below or they prove nothing.
//
// This fixture is the fix for a defect a mutation test found: `lifecycle.id`
// was the only listing ever successfully updated anywhere in this file, so
// `listing_revisions` only ever held rows for ONE listing_id — and
// `.every((r) => r.listing_id === lifecycle.id)` was therefore vacuously true
// whether or not the method filtered at all. Deleting the filter entirely left
// the suite green while `listListingRevisions` handed every coach a rival's
// titles and superseded prices.
//
// Nils is an approved coach who owns nothing else, so his offer is
// unambiguously not Cory's, and its revision is unambiguously one that must not
// appear in Cory's result.
const rivalListing = await db.createListing(NILS, {
  title: 'A rival coach’s offer',
  description: 'Owned by a different coach entirely, and edited, so the revision log holds more than one listing_id.',
  price_cents: 8800,
  category: 'nutrition_plan',
});
await db.updateListing(NILS, rivalListing.id, {
  title: 'A rival coach’s offer, repriced',
  description: 'The superseded version of this is what must never appear in another coach’s revision list.',
  price_cents: 9900,
  category: 'nutrition_plan',
});
// Proof the fixture is real: the rival's revision EXISTS in the store. Without
// this, "absent from Cory's result" would also hold if the row were never
// written.
const rivalRevisions = await db.listListingRevisions(NILS, rivalListing.id);
expectEqual('the rival coach’s offer really does have a revision', rivalRevisions.length, 1);
expectEqual(
  '...holding the title it used to have',
  rivalRevisions[0]?.title,
  'A rival coach’s offer',
);
expectEqual(
  '...and the whole store now holds revisions for more than one listing',
  await mutateDb((store) => new Set(store.listing_revisions.map((r) => r.listing_id)).size > 1),
  true,
);

const revisions = await allows(
  'the OWNER may read their offer’s edit history',
  () => db.listListingRevisions(COACH, lifecycle.id),
  (r) => `${r.length} revision(s)`,
);
expectEqual('...and it is not empty (every edit above appended one)', (revisions?.length ?? 0) > 0, true);
expectShape('...each one exactly a revision row', revisions?.[0], LISTING_REVISION_COLUMNS);
expectEqual(
  '...newest first',
  (revisions ?? []).every((r, i) => i === 0 || revisions![i - 1]!.created_at >= r.created_at),
  true,
);
// Both halves, and the second is the one that bites. "All rows are Cory's" is
// satisfied by a method that filters correctly AND by one that does not filter
// at all, in a store that only ever held Cory's rows — which is exactly how the
// leak shipped green. Naming the rival row that must be absent is what makes
// this an assertion rather than a tautology.
expectEqual('...all for the offer that was asked for', (revisions ?? []).every((r) => r.listing_id === lifecycle.id), true);
expectEqual(
  '...and the RIVAL coach’s revision is not in it',
  (revisions ?? []).some((r) => r.listing_id === rivalListing.id),
  false,
);
expectEqual(
  '...not by title either',
  (revisions ?? []).some((r) => r.title.includes('rival')),
  false,
);
expectEqual(
  '...and the rival’s superseded PRICE did not leak',
  (revisions ?? []).some((r) => r.price_cents === 8800),
  false,
);
// The reverse direction: Nils must not see Cory's history either.
expectEqual(
  'and the rival cannot see the other coach’s revisions',
  rivalRevisions.every((r) => r.listing_id === rivalListing.id),
  true,
);
expectEqual(
  '...his list is exactly his own one revision, not the whole table',
  rivalRevisions.length,
  1,
);
// The newest revision holds the version the LAST edit superseded — "Saved again
// at the same price" at 500c, not the current "Now dearer" at 501c. That
// direction is the whole point: the live row is the current version, and the log
// is what it used to be.
expectEqual('the newest revision is the version the last edit REPLACED', revisions?.[0]?.title, 'Saved again at the same price');
expectEqual('...at the price it had then, not the price it has now', revisions?.[0]?.price_cents, 500);
expectEqual('...and the live row moved on', (await db.getListing(lifecycle.id))?.price_cents, 501);
// The case revisions exist for: a rewrite at an unchanged price keeps every
// review, so the superseded text has to be recoverable.
expectEqual(
  'the text a content-only rewrite replaced is still recoverable',
  (revisions ?? []).some((r) => r.title === 'Now cheaper'),
  true,
);
expectEqual(
  'the ORIGINAL title, from before the first edit, is in the log',
  (revisions ?? []).some((r) => r.title === 'Lifecycle offer'),
  true,
);
// Append-only: the log must grow, and nothing in it may change.
const revisionCountBefore = revisions?.length ?? 0;
const oldestBefore = revisions?.[revisionCountBefore - 1]?.title;
await db.updateListing(COACH, lifecycle.id, { ...EDIT, title: 'One more edit', price_cents: 501 });
const revisionsAfter = await db.listListingRevisions(COACH, lifecycle.id);
expectEqual('another edit appends exactly one revision', revisionsAfter.length, revisionCountBefore + 1);
expectEqual('...and rewrites none of the existing ones', revisionsAfter[revisionsAfter.length - 1]?.title, oldestBefore);

// A NO-OP EDIT STILL APPENDS. "Written on EVERY edit, including one that
// changes nothing" is a documented property of updateListing, and until this
// assertion existed it was only half-covered: every other edit in this file
// changes the title, so wrapping the push in a did-anything-change comparison
// survived green. "Somebody saved this offer at this time" is a true and useful
// fact, and the alternative is a subtle comparison that is one more thing to
// get wrong.
const beforeNoop = await db.listListingRevisions(COACH, lifecycle.id);
const currentRow = (await db.getListing(lifecycle.id))!;
await allows(
  'an edit that changes NOTHING is still accepted',
  () =>
    db.updateListing(COACH, lifecycle.id, {
      title: currentRow.title,
      description: currentRow.description,
      price_cents: currentRow.price_cents,
      category: currentRow.category as ListingCategory,
    }),
  (r) => `"${r.title}" unchanged`,
);
const afterNoop = await db.listListingRevisions(COACH, lifecycle.id);
expectEqual('...and it still appends a revision', afterNoop.length, beforeNoop.length + 1);
expectEqual(
  '...holding the same values, since nothing changed',
  afterNoop[0]?.title === currentRow.title && afterNoop[0]?.price_cents === currentRow.price_cents,
  true,
);
expectEqual('...and the no-op did not move the epoch', (await db.getListing(lifecycle.id))?.price_epoch, currentRow.price_epoch);

// Everything below counts from HERE, not from an earlier snapshot: re-baselined
// on purpose so that inserting another edit above cannot silently make the
// assertions that follow describe the wrong number.
const revisionBaseline = afterNoop.length;

await refuses('anon listListingRevisions', 'unauthorized', () => db.listListingRevisions(ANON, lifecycle.id));
await refuses('a learner may not read an offer’s edit history', 'forbidden', () =>
  db.listListingRevisions(MARCUS, lifecycle.id),
);
// Nils is an approved coach: the only thing he is not is the owner of this offer.
await refuses('another approved coach may not read it', 'forbidden', () =>
  db.listListingRevisions(NILS, lifecycle.id),
);
await refuses('a forged admin role does not unlock it', 'forbidden', () =>
  db.listListingRevisions({ userId: MARCUS!.userId, role: 'admin' } as unknown as Actor, lifecycle.id),
);
await refuses('reading the history of an offer that does not exist', 'not_found', () =>
  db.listListingRevisions(COACH, '00000000-0000-4000-8000-0000000dead8'),
);
const adminRevisions = await allows(
  'an ADMIN may read it (moderation)',
  () => db.listListingRevisions(ADMIN, lifecycle.id),
  (r) => `${r.length} revision(s)`,
);
expectEqual('...and sees the same history, not an empty list', adminRevisions?.length, revisionBaseline);
// A withdrawn offer's history stays readable by its owner — otherwise the one
// state in which you most want to know what an offer said is the one state in
// which you cannot find out.
await db.softDeleteListing(COACH, lifecycle.id);
expectEqual(
  'a withdrawn offer’s history is still readable by its owner',
  (await db.listListingRevisions(COACH, lifecycle.id)).length,
  revisionBaseline,
);
// EDITING A WITHDRAWN OFFER IS ALLOWED, and an earlier revision of this round
// refused it with `conflict`. It had to change once an admin takedown became
// un-restorable by the coach: "restore it first" is a DEAD END for exactly the
// coach who most needs to act, since they can neither restore nor fix the thing
// that got the offer taken down. It also matches the SQL, which never forbade
// it — so the two backends now agree instead of silently diverging.
const editedWhileWithdrawn = await allows(
  'a withdrawn offer can still be EDITED (the remediation flow)',
  () => db.updateListing(COACH, lifecycle.id, { ...EDIT, title: 'Edited while withdrawn', price_cents: 501 }),
  (r) => `"${r.title}"`,
);
expectEqual('...and the edit really landed', editedWhileWithdrawn?.title, 'Edited while withdrawn');
expectEqual(
  '...it appended a revision like any other edit',
  (await db.listListingRevisions(COACH, lifecycle.id)).length,
  revisionBaseline + 1,
);
// The load-bearing part: editing must not quietly republish it.
expectEqual('...the offer is STILL withdrawn', editedWhileWithdrawn?.deleted_at !== null, true);
expectEqual('...still absent from browse', (await db.listListings()).some((l) => l.id === lifecycle.id), false);
expectEqual('...still a 404 for the public', await db.getListing(lifecycle.id), null);
expectShape('...and the returned row still carries no deleted_by', editedWhileWithdrawn, LISTING_WITH_COACH_COLUMNS);
await db.restoreListing(COACH, lifecycle.id);
expectEqual(
  'withdrawing and restoring appends no revision at all',
  (await db.listListingRevisions(COACH, lifecycle.id)).length,
  revisionBaseline + 1,
);

// Fixtures planted for the epoch assertions, removed so the store is left as it
// would be after ordinary use.
await mutateDb((store) => {
  store.reviews = store.reviews.filter((r) => r.order_id !== epochOrderId);
  store.orders = store.orders.filter((o) => o.id !== epochOrderId);
});
expectEqual('planted purchase removed', (await db.getOrder(ADMIN, epochOrderId)) === null, true);

// ---------------------------------------------------------------------------
section('A buyer may still review an offer that was later WITHDRAWN');
// ---------------------------------------------------------------------------
// `createReview`'s listing lookup is the ONE listing read in the data layer that
// deliberately carries no `deleted_at` filter, and until now that decision was
// defended by a nine-line comment and zero assertions: adding the filter
// survived the suite green. Nothing reached the case, because the only withdrawn
// seeded offer's single order was already reviewed, so the duplicate check
// answered first.
//
// Both consequences the comment claims are pinned below:
//   * the write SUCCEEDS — the buyer paid for coaching that happened, and the
//     offer being off sale does not retract their right to say so. Filtering
//     would make the mock refuse a write `reviews_insert_own_purchase` accepts,
//     which is a silent backend divergence;
//   * and it lands where a withdrawn offer's social proof belongs: on the
//     COACH's account, on no offer-level read.
const withdrawnReviewOrderId = '00000000-0000-4000-8000-0000000000cd';
await mutateDb((store) => {
  const listing = store.listings.find((l) => l.id === OFFER.shoulder)!;
  store.orders.push({
    id: withdrawnReviewOrderId,
    learner_id: MARCUS!.userId,
    listing_id: listing.id,
    coach_id: listing.coach_id,
    price_cents_at_purchase: listing.price_cents,
    price_epoch: listing.price_epoch,
    created_at: new Date().toISOString(),
  });
});
await db.softDeleteListing(COACH, OFFER.shoulder);
expectEqual('the offer under test is withdrawn', await db.getListing(OFFER.shoulder), null);
const accountBeforeWithdrawnReview = await db.getCoachStats(COACH!.userId);

const withdrawnReview = await allows(
  'the buyer of a WITHDRAWN offer may still review it',
  () =>
    db.createReview(MARCUS, {
      order_id: withdrawnReviewOrderId,
      rating: 2,
      body: 'Reviewing an offer that has since been taken off sale. The coaching still happened.',
    }),
  (r) => `${r.rating}★ on epoch ${r.price_epoch}`,
);
expectEqual('...attributed to the actor', withdrawnReview?.author_id, MARCUS!.userId);
expectEqual('...against the offer the ORDER bought', withdrawnReview?.listing_id, OFFER.shoulder);
// It counts where a withdrawn offer's history counts: the account.
const accountAfterWithdrawnReview = await db.getCoachStats(COACH!.userId);
expectEqual(
  '...and it counts toward the coach account',
  accountAfterWithdrawnReview.review_count,
  accountBeforeWithdrawnReview.review_count + 1,
);
expectEqual(
  '...and is readable on the coach profile',
  (await db.listReviewsForCoach(COACH!.userId)).some((r) => r.rating === 2 && r.listing_id === OFFER.shoulder),
  true,
);
// ...and nowhere offer-level, because there is no offer page.
expectEqual('...but there is no offer-level stats row to move', await db.getOfferStats(OFFER.shoulder), null);
expectEqual('...and no offer-page review list', (await db.listReviewsForListing(OFFER.shoulder)).length, 0);
// The self-dealing check must still be the thing that refuses a coach — NOT a
// not_found from a filtered lookup. This is the other half of what the missing
// filter protects: filtering would turn `forbidden` into `not_found` here.
const selfWithdrawnOrderId = '00000000-0000-4000-8000-0000000000ce';
await mutateDb((store) => {
  const listing = store.listings.find((l) => l.id === OFFER.shoulder)!;
  store.orders.push({
    id: selfWithdrawnOrderId,
    learner_id: COACH!.userId,
    listing_id: listing.id,
    coach_id: listing.coach_id,
    price_cents_at_purchase: listing.price_cents,
    price_epoch: listing.price_epoch,
    created_at: new Date().toISOString(),
  });
});
await refuses('a coach still cannot review their OWN withdrawn offer', 'forbidden', () =>
  db.createReview(COACH, { order_id: selfWithdrawnOrderId, rating: 5, body: 'A glowing review of my own withdrawn offer.' }),
);
await db.restoreListing(COACH, OFFER.shoulder);
await mutateDb((store) => {
  store.reviews = store.reviews.filter((r) => r.order_id !== withdrawnReviewOrderId);
  store.orders = store.orders.filter(
    (order) => order.id !== withdrawnReviewOrderId && order.id !== selfWithdrawnOrderId,
  );
});
expectEqual('withdrawn-review fixtures removed', (await db.getOrder(ADMIN, withdrawnReviewOrderId)) === null, true);
expectEqual('...and the offer is back on sale', (await db.listListings()).some((l) => l.id === OFFER.shoulder), true);

// ---------------------------------------------------------------------------
section('A pre-soft-delete store upgrades to a NULL deleted_at, not to undefined');
// ---------------------------------------------------------------------------
// `data/db.json` is gitignored and long-lived, so a real machine is holding
// listing rows written before `deleted_at` existed — rows with no such key at
// all. `seedDatabase()` backfills them on load, and this is the only thing that
// exercises that backfill: every row the seed and `createListing` write already
// carries the column, so the repair path is invisible to every other assertion
// in this file.
//
// WHY IT IS NOT COSMETIC, and it is worth being precise because "the value is
// missing instead of null" sounds harmless:
//
//   * reads are FINE either way — `isWithdrawn()` tests for a string, so a
//     missing column correctly means "published";
//   * but a DASHBOARD branches on `deleted_at !== null`, and
//     `undefined !== null` is TRUE. Without the backfill, every offer written
//     before this round renders as WITHDRAWN in the coach's dashboard while
//     still being on sale in browse — two surfaces disagreeing about the same
//     row, with nothing throwing anywhere.
//
// The row is written straight to the store and the cache is then dropped, so
// the next read genuinely reloads from disk and re-runs the seed, which is the
// code path a developer's stale store actually takes.
const preSoftDeleteId = '00000000-0000-4000-8000-00000000cafe';
await mutateDb((store) => {
  const stamp = new Date().toISOString();
  store.listings.push({
    id: preSoftDeleteId,
    coach_id: COACH!.userId,
    title: 'Pre-soft-delete legacy row',
    description: 'Written with no deleted_at key at all, as a build from before withdrawal existed would have left it.',
    price_cents: 4321,
    category: 'training_plan',
    price_epoch: 1,
    created_at: stamp,
    updated_at: stamp,
    // The column is deliberately ABSENT, which is the whole point of the
    // fixture. Cast past the row type to express that.
  } as unknown as Parameters<typeof store.listings.push>[0]);
});
__resetStoreCache();

const upgraded = await db.getListing(preSoftDeleteId);
expectShape('a pre-soft-delete row gains the column on load', upgraded, LISTING_WITH_COACH_COLUMNS);
expectEqual('...backfilled to NULL', upgraded?.deleted_at, null);
// `deleted_by` is projected out of every read, so the only place to observe its
// backfill is the store itself. Asserted rather than assumed, because a row
// holding `undefined` there would make restoreListing()'s
// `typeof deleted_by === 'string'` test read a missing column as unattributed —
// which happens to be the right answer, but by accident rather than by the
// backfill doing its job.
expectEqual(
  '...and so is the audit column, in the store where it lives',
  await mutateDb((store) => store.listings.find((l) => l.id === preSoftDeleteId)?.deleted_by),
  null,
);
// The assertion that names the actual bug: `undefined !== null` is true, so an
// un-backfilled row would read as withdrawn to a dashboard.
expectEqual('...and specifically NOT undefined, which a dashboard reads as withdrawn', upgraded?.deleted_at === undefined, false);
expectEqual(
  '...so a dashboard branching on `deleted_at !== null` sees it as PUBLISHED',
  (await db.listMyListings(COACH)).find((l) => l.id === preSoftDeleteId)?.deleted_at !== null,
  false,
);
expectEqual(
  '...and it really is on sale in browse, so the two surfaces agree',
  (await db.listListings()).some((l) => l.id === preSoftDeleteId),
  true,
);
// It still withdraws normally once upgraded — the backfill is a repair, not a
// quarantine.
await allows('a pre-soft-delete row can still be withdrawn', () => db.softDeleteListing(COACH, preSoftDeleteId), (r) => `deleted_at=${r.deleted_at ? 'set' : 'null'}`);
expectEqual('...and it leaves browse', (await db.listListings()).some((l) => l.id === preSoftDeleteId), false);
await mutateDb((store) => {
  store.listings = store.listings.filter((l) => l.id !== preSoftDeleteId);
});
expectEqual('pre-soft-delete fixture removed', await db.getListing(preSoftDeleteId), null);

// ---------------------------------------------------------------------------
section('Profile row shape — the three coach columns are on every row');
// ---------------------------------------------------------------------------
// Hand-written, like every other column constant in this file, and NOT derived
// from `Profile`. A shape assertion that reads its expectation out of the code
// under test cannot fail.
const coryRow = await allows(
  'admin getProfile(Cory) for the shape check',
  () => db.getProfile(ADMIN, COACH!.userId),
  (r) => `${r?.full_name}`,
);
expectShape('a profile row carries exactly the profile columns', coryRow, PROFILE_COLUMNS);
expectEqual('the seeded coach has a headline', coryRow?.coach_headline, 'Javelin technique and throws programming');
expectEqual('the seeded coach has years coaching', coryRow?.coach_years_coaching, 12);
expectEqual(
  'the seeded EMPTY coach has none of the three — the fixture every empty state needs',
  JSON.stringify([
    (await db.getProfile(ADMIN, EMPTY_COACH))?.coach_headline,
    (await db.getProfile(ADMIN, EMPTY_COACH))?.coach_bio,
    (await db.getProfile(ADMIN, EMPTY_COACH))?.coach_years_coaching,
  ]),
  '[null,null,null]',
);

// ---------------------------------------------------------------------------
section('Coach directory — APPROVED ONLY, and it cannot be widened');
// ---------------------------------------------------------------------------
// `profiles` holds every learner, every applicant and every administrator, and
// `listCoaches` is the one public read over it. The whole security property is
// the `coach_status = 'approved'` predicate INSIDE the data layer, so this
// block is built to catch it being widened as well as being emptied.
//
// THE FIXTURES ARE THE TEST. By this point in the run the store holds a
// non-approved profile in EVERY non-approved state, which is what makes the
// absence assertions below able to discriminate: an assertion over a store
// containing only approved coaches would pass whether the filter existed or not.
const pendingApplicant = await signUpProfile({
  email: 'pending-directory@javelin.test',
  password: 'password123',
  fullName: 'Pia Pending',
});
await db.createCoachApplication({ userId: pendingApplicant.id }, APPLICATION);
expectEqual('fixture: a pending_review profile exists', await coachStatusOf(pendingApplicant.id), 'pending_review');
expectEqual('fixture: a rejected profile exists', await coachStatusOf(REJECT.userId), 'rejected');
expectEqual('fixture: a coach_status=none profile exists', await coachStatusOf(second.id), 'none');
expectEqual('fixture: an ADMIN profile exists', await roleOf(ADMIN!.userId), 'admin');

// =========================================================================
// F2 — THE FIXTURE THE `coach_status` STATES ABOVE CANNOT SUPPLY.
// =========================================================================
// The four states above discriminate on the coach_status axis and NOTHING
// else. On the ROLE axis this store is degenerate at this point: every admin
// in it is also `approved` (the D2 section had the seeded admin redeem an
// invite code), and there is no approved coach who is not a coach by role. The
// two sets COINCIDE — so widening the predicate to
// `|| profile.role === 'admin'` changes no result, and every assertion below,
// including the set-equality one, holds anyway.
//
// That widening is not hypothetical: it publishes the SHIPPED seed's Ada
// Administrator (`role=admin, coach_status=none`) into the anonymous
// directory, and subtracting the already-public
// `getPublicProfile(id).is_approved_coach === false` then enumerates
// administrators exactly — the named threat in this round's criterion.
//
// So this fixture is an admin who is deliberately NOT an approved coach, which
// is the only shape that separates the two axes.
const shadowAdmin = await signUpProfile({
  email: 'shadow-admin@javelin.test',
  password: 'password123',
  fullName: 'Sam Shadow',
});
await grantAdmin(shadowAdmin.id);
expectEqual('F2 fixture: an admin who is NOT an approved coach — role', await roleOf(shadowAdmin.id), 'admin');
expectEqual('F2 fixture: ...and coach_status', await coachStatusOf(shadowAdmin.id), 'none');

const directory = await allows('anon listCoaches', () => db.listCoaches(), (r) => `${r.length} coach(es)`);
const directoryIds = (directory ?? []).map((c) => c.id);
// Non-emptiness first: every `.every()` below is vacuously true over `[]`, so a
// method that returned nothing would otherwise sail through the whole block.
expectEqual('...and it is not silently empty', directoryIds.length > 0, true);
expectEqual('...it contains the seeded coach', directoryIds.includes(COACH!.userId), true);
expectEqual('...and the seeded EMPTY coach, who has published nothing', directoryIds.includes(EMPTY_COACH), true);

// The four absences. Each names a DIFFERENT non-approved state, so widening the
// predicate to `() => true` trips four assertions rather than one, and a partial
// widening (say, admitting 'pending_review') still trips one.
expectEqual('...and NOT a learner with coach_status none', directoryIds.includes(second.id), false);
expectEqual('...and NOT an applicant awaiting review', directoryIds.includes(pendingApplicant.id), false);
expectEqual('...and NOT a REJECTED applicant', directoryIds.includes(REJECT.userId), false);
expectEqual('...and NOT a learner who never applied at all', directoryIds.includes(MARCUS!.userId), false);
// F2: the role-axis absence. This is the one the four above cannot express —
// an ADMINISTRATOR who is not an approved coach must not be published, and a
// predicate widened by role rather than by coach_status trips only this.
expectEqual('F2: ...and NOT an ADMIN who is not an approved coach', directoryIds.includes(shadowAdmin.id), false);
expectEqual('F2: ...and getPublicCoach refuses them too', await db.getPublicCoach(shadowAdmin.id), null);
// Non-vacuous, and the assertion that names the disclosure: their public
// profile really is reachable and really does say they are not a coach, so a
// directory that listed them would be subtractable against this.
expectEqual(
  'F2: ...while their PUBLIC PROFILE is readable and says is_approved_coach=false',
  (await db.getPublicProfile(shadowAdmin.id))?.is_approved_coach,
  false,
);

// The set-equality assertion, computed from an INDEPENDENT predicate written
// here rather than read out of the method. This is what catches a widening the
// four named absences happen to miss — a profile state added later, or a
// half-widened predicate.
const approvedInStore = await mutateDb((store) =>
  store.profiles.filter((p) => p.coach_status === 'approved').map((p) => p.id).sort(),
);
expectEqual(
  '...the directory is EXACTLY the approved profiles in the store, no more and no fewer',
  [...directoryIds].sort().join(','),
  approvedInStore.join(','),
);
note(`${approvedInStore.length} approved coach(es) in the store`);

// The shape. `PublicCoach` has no `role` and no `coach_status`, so even a row
// that escaped the filter could not say which. Asserted at BOTH call sites that
// build it, because one projection built at two sites is two chances to leak.
// Newest first, which the page renders as the words "Newest first." — so it is
// a claim the product makes and not merely an implementation detail. Compared
// against an ORDER computed here from `created_at`, not against a hardcoded
// list, so it survives the store gaining coaches; and `sort` is stable on both
// sides, so seeded rows sharing a millisecond compare equal rather than flaky.
const directoryCreatedAt = await mutateDb((store) =>
  (directory ?? []).map((c) => store.profiles.find((p) => p.id === c.id)?.created_at ?? ''),
);
expectEqual(
  '...ordered newest first, which is what the page says it is',
  directoryCreatedAt.join(','),
  [...directoryCreatedAt].sort((x, y) => y.localeCompare(x)).join(','),
);
// Non-vacuous: if every timestamp were identical the assertion above would hold
// under any ordering at all.
expectEqual(
  '...and the timestamps are not all identical, so that ordering assertion can fail',
  new Set(directoryCreatedAt).size > 1,
  true,
);
expectShape('listCoaches hands out exactly the public coach columns', directory?.[0], PUBLIC_COACH_COLUMNS);
expectEqual(
  'no row in the directory carries a privilege-bearing key',
  (directory ?? []).some((row) => PRIVILEGE_KEYS.some((k) => k in row)),
  false,
);
expectEqual(
  'no VALUE in the directory is a role/coach_status enum member',
  (directory ?? []).some((row) =>
    Object.entries(row).some(
      ([k, v]) => k !== 'full_name' && typeof v === 'string' && ENUM_VALUES.includes(v.toLowerCase()),
    ),
  ),
  false,
);
// The load-bearing one, and the reason `is_approved_coach` is absent rather
// than hardcoded to true: an administrator who redeemed an invite code IS an
// approved coach and legitimately appears here — so their row must be
// indistinguishable from anyone else's.
const adminInDirectory = (directory ?? []).find((c) => c.id === ADMIN!.userId);
expectEqual('an admin who is also an approved coach does appear', adminInDirectory !== undefined, true);
expectEqual(
  '...with a shape identical to a non-admin coach, so the directory is not an admin oracle',
  Object.keys(adminInDirectory ?? {}).sort().join(','),
  Object.keys((directory ?? []).find((c) => c.id === COACH!.userId) ?? {}).sort().join(','),
);

// ---------------------------------------------------------------------------
section('Coach directory — the name search matches full_name and nothing else');
// ---------------------------------------------------------------------------
const byName = await db.listCoaches({ q: 'vaughn' });
expectEqual('search is case-insensitive on full_name', byName.length, 1);
expectEqual('...and returns the coach it named', byName[0]?.id, COACH!.userId);
expectEqual('a keyword matching nobody returns []', (await db.listCoaches({ q: 'zzzznobody' })).length, 0);
// SQL parity: `profiles_full_name_trgm_idx` is the only index Postgres can
// serve this from, so matching the headline or the bio here would make the mock
// the more capable of the two backends and change results at the swap. Both
// probes are strings that ARE present in the seeded coach's copy.
expectEqual(
  'search does NOT match the headline (SQL parity)',
  (await db.listCoaches({ q: 'technique' })).length,
  0,
);
expectEqual(
  'search does NOT match the bio (SQL parity)',
  (await db.listCoaches({ q: 'eleven seasons' })).length,
  0,
);
// The approval predicate applies WITH a query too, not only without one. A
// filter implemented as an early return before the status test would pass every
// assertion above and fail this one.
expectEqual(
  'a query cannot reach a REJECTED applicant by name',
  (await db.listCoaches({ q: 'Rhea' })).length,
  0,
);
expectEqual(
  'a query cannot reach a PENDING applicant by name',
  (await db.listCoaches({ q: 'Pia Pending' })).length,
  0,
);

// ---------------------------------------------------------------------------
section('getPublicCoach — null for everyone who is not an approved coach');
// ---------------------------------------------------------------------------
const publicCory = await allows(
  'anon getPublicCoach(an approved coach)',
  () => db.getPublicCoach(COACH!.userId),
  (r) => `${r?.full_name}`,
);
expectEqual('...and it really is the coach that was asked for', publicCory?.id, COACH!.userId);
expectEqual('...carrying their public headline', publicCory?.coach_headline, 'Javelin technique and throws programming');
expectShape('getPublicCoach hands out the same columns as the directory', publicCory, PUBLIC_COACH_COLUMNS);

// Four states, one answer. A `forbidden` for one of these and a `not_found` for
// another would be a coach_status oracle; they must be identical.
expectEqual('getPublicCoach(a learner) is null', await db.getPublicCoach(second.id), null);
expectEqual('getPublicCoach(a pending applicant) is null', await db.getPublicCoach(pendingApplicant.id), null);
expectEqual('getPublicCoach(a rejected applicant) is null', await db.getPublicCoach(REJECT.userId), null);
expectEqual('getPublicCoach(an unknown id) is null', await db.getPublicCoach('00000000-0000-4000-8000-0000000dead0'), null);
expectEqual('getPublicCoach(empty string) is null', await db.getPublicCoach(''), null);
expectEqual(
  'the empty coach IS reachable — an approved coach with nothing published is not a 404',
  (await db.getPublicCoach(EMPTY_COACH))?.full_name,
  'Nils Berg',
);
expectEqual('...and his three columns are null, not zeros or empty strings',
  JSON.stringify([
    (await db.getPublicCoach(EMPTY_COACH))?.coach_headline,
    (await db.getPublicCoach(EMPTY_COACH))?.coach_bio,
    (await db.getPublicCoach(EMPTY_COACH))?.coach_years_coaching,
  ]),
  '[null,null,null]',
);

// ---------------------------------------------------------------------------
section('listCoachStats — the batch cannot disagree with the single form');
// ---------------------------------------------------------------------------
// DELIBERATELY NOT IN SORTED ORDER, and that is the whole point of this
// fixture. The first version of this list was `[…0002, …0004, …dead0]`, which
// is already ascending — so "in the order given" and "in sorted order" produced
// the same string and the assertion could not tell them apart. Sorting the
// input inside `listCoachStats` survived it.
//
// It is not a cosmetic bug. `src/app/coaches/page.tsx` zips `coaches[i]` to
// `stats[i]` positionally, so a reordered batch renders one coach's rating
// under another coach's name — on the current seed, Nils Berg would show Cory
// Vaughn's 4.4 / 8 reviews and Cory would read "New coach".
//
// The order below is neither ascending nor descending, and BOTH have to be
// excluded. An earlier version of this fixture was `[unknown, empty, seeded]`,
// which is not its ascending sort — so the guard below passed — but IS exactly
// its descending sort, so `sort().reverse()` and a `localeCompare` descending
// comparator both survived undetected. Descending is the likeliest accidental
// ordering in this codebase, which orders `desc` almost everywhere
// (`byCreatedAtDesc`, `order by created_at desc, id desc`), and a Supabase
// `listCoachStats` served from `order by coach_id desc` is a plausible
// implementation. Swapping the first two entries is what makes the list
// genuinely unordered; keep it that way.
//
// The unknown id no longer sits first, and does not need to: a mutant that
// drops unknown ids still fails the length assertion below, and shifts the
// remaining rows so the order assertion fails too.
const statIds = [EMPTY_COACH, '00000000-0000-4000-8000-0000000dead0', COACH!.userId];
expectEqual(
  'F3 fixture: the id list is NOT in ascending order, or the order assertion cannot discriminate',
  statIds.join(',') === [...statIds].sort().join(','),
  false,
);
expectEqual(
  'F3 fixture: the id list is NOT in descending order either — the case that once slipped through',
  statIds.join(',') === [...statIds].sort().reverse().join(','),
  false,
);
const batched = await db.listCoachStats(statIds);
// Length AND order. `listOfferStats` drops unknown ids; this one must not, or a
// caller zipping ids to rows silently misaligns and a directory renders one
// coach's rating under another coach's name.
expectEqual('one row per id given, unknown ids included', batched.length, statIds.length);
expectEqual('...in the order given', batched.map((s) => s.coach_id).join(','), statIds.join(','));
// Indices follow statIds: [0] the empty coach, [1] unknown, [2] the seeded one.
// Spelled out because the list is deliberately unsorted and a reader would
// otherwise assume ascending.
expectShape('...with the coach-stats columns', batched[2], COACH_STATS_COLUMNS);
expectShape('...including the row for an id that is not a profile at all', batched[1], COACH_STATS_COLUMNS);
const singleCory = await db.getCoachStats(COACH!.userId);
expectEqual(
  '...and every row equals what getCoachStats returns for the same id',
  JSON.stringify(batched[2]),
  JSON.stringify(singleCory),
);
// THE assertion the unsorted fixture buys: the seeded coach's numbers must land
// at the position his id occupies, not at the position sorting would give him.
// This is what stops a directory rendering one coach's rating under another's
// name — coaches/page.tsx zips these positionally.
expectEqual('F3: ...and the seeded coach is at HIS index, not at a sorted one', batched[2]?.coach_id, COACH!.userId);
expectEqual('...the seeded coach is not silently zeroed', (batched[2]?.review_count ?? 0) > 0, true);
expectEqual('F3: ...while the row at index 1 is the unknown id, which sorting would move', batched[1]?.coach_id, '00000000-0000-4000-8000-0000000dead0');
expectEqual('the empty coach is zeros with a NULL average', batched[0]?.rating_average, null);
expectEqual('...and zero counts', `${batched[0]?.review_count}/${batched[0]?.sales_count}`, '0/0');
expectEqual('an unknown id is zeros with a NULL average, never dropped', batched[1]?.rating_average, null);
expectEqual('...at HIS index too', batched[0]?.coach_id, EMPTY_COACH);
expectEqual('an empty id list returns []', (await db.listCoachStats([])).length, 0);

// ---------------------------------------------------------------------------
section('The coach PROFILE page reads — withdrawal, epochs, and deleted_by');
// ---------------------------------------------------------------------------
// /coaches/[id] renders three reads side by side, and TWO OF THEM DISAGREE WITH
// THE THIRD ON PURPOSE:
//
//   getCoachStats          every offer, every epoch, withdrawn INCLUDED
//   listReviewsForCoach    every offer, every epoch, withdrawn INCLUDED
//   listListingsByCoach    the PUBLIC offer list — withdrawn EXCLUDED
//
// The asymmetry is asserted at the data layer elsewhere; what is asserted here
// is the state the PAGE has to handle because of it — a review that names an
// offer the public can no longer open. The page turns the title into a link
// only when `listListingsByCoach` still contains that listing_id, so this block
// pins the fixture that logic exists for. Without it, "every review's offer is
// linkable" would be vacuously true and the withdrawn branch would be dead code
// nobody noticed had stopped being reachable.
const profileStatsBefore = await db.getCoachStats(COACH!.userId);
const profileReviewsBefore = await db.listReviewsForCoach(COACH!.userId);
const profileOffersBefore = await db.listListingsByCoach(ANON, COACH!.userId);
// A positive control first: with nothing withdrawn, every reviewed offer IS in
// the public list, so the assertion after the withdrawal is a real change.
const publishedBefore = new Set(profileOffersBefore.map((l) => l.id));
expectEqual('before: the coach has offers and reviews to work with', profileOffersBefore.length > 0 && profileReviewsBefore.length > 0, true);
expectEqual(
  'before: every review on the profile names an offer the public can still open',
  profileReviewsBefore.every((r) => publishedBefore.has(r.listing_id)),
  true,
);
// …0104 has exactly one sale and one review, so withdrawing it makes the
// divergence observable rather than theoretical.
const reviewsOfVideo = profileReviewsBefore.filter((r) => r.listing_id === OFFER.video).length;
expectEqual('fixture: the offer about to be withdrawn really does carry a review', reviewsOfVideo > 0, true);

await allows('withdraw one of the coach\'s reviewed offers', () => db.softDeleteListing(COACH, OFFER.video), (r) => `deleted_at=${r.deleted_at ? 'set' : 'null'}`);

const profileStatsAfter = await db.getCoachStats(COACH!.userId);
const profileReviewsAfter = await db.listReviewsForCoach(COACH!.userId);
const profileOffersAfter = await db.listListingsByCoach(ANON, COACH!.userId);

// The offer list — the only one of the three that moves.
expectEqual('the withdrawn offer leaves the profile offer list', profileOffersAfter.some((l) => l.id === OFFER.video), false);
expectEqual('...and it is one fewer, not zero', profileOffersAfter.length, profileOffersBefore.length - 1);

// The account-level pair — byte-identical, or a coach loses their standing the
// moment they take one old offer off sale.
expectEqual(
  'account-level stats are UNCHANGED by withdrawal',
  JSON.stringify(profileStatsAfter),
  JSON.stringify(profileStatsBefore),
);
expectEqual('...and the review list is unchanged too', profileReviewsAfter.length, profileReviewsBefore.length);
expectEqual('...including the review of the offer that was just withdrawn', profileReviewsAfter.some((r) => r.listing_id === OFFER.video), true);
expectEqual(
  '...still joined to that offer\'s title, because the row survived a soft delete',
  profileReviewsAfter.find((r) => r.listing_id === OFFER.video)?.listing_title,
  'Video Analysis: Send Me Your Throw',
);

// THE state the page branches on. This is the assertion the linkable/not-linkable
// split exists for, and before the withdrawal above it was false.
const publishedAfter = new Set(profileOffersAfter.map((l) => l.id));
expectEqual(
  'a review now names an offer the public CANNOT open — the un-linkable case is reachable',
  profileReviewsAfter.some((r) => !publishedAfter.has(r.listing_id)),
  true,
);
// …and the public really cannot open it, so rendering that title as a link
// would be a dead end rather than a cosmetic issue.
expectEqual('...and that offer is a 404 for the public', await db.getListing(OFFER.video), null);

// The OFFER-level pair, for contrast: they DO vanish.
expectEqual('offer-level stats for a withdrawn offer are gone entirely', await db.getOfferStats(OFFER.video), null);
expectEqual('...and its offer-page review list is empty', (await db.listReviewsForListing(OFFER.video)).length, 0);

// `deleted_by` holds an id, and after a takedown an ADMINISTRATOR's. None of the
// three coach-profile reads may carry it. Asserted at each of them by name
// rather than relying on the shared shape constants alone, because this is the
// one column whose leak is invisible on a rendered page.
expectEqual(
  'no offer on the coach profile carries deleted_by',
  profileOffersAfter.some((l) => 'deleted_by' in l),
  false,
);
expectShape('...and the offers are exactly the public listing shape', profileOffersAfter[0], LISTING_WITH_COACH_COLUMNS);
expectShape('...the reviews are exactly the public review shape', profileReviewsAfter[0], PUBLIC_REVIEW_WITH_LISTING_COLUMNS);
expectEqual(
  'no public coach row carries deleted_by either',
  (await db.listCoaches()).some((c) => 'deleted_by' in c),
  false,
);

await allows('restore the offer for the rest of the suite', () => db.restoreListing(COACH, OFFER.video), (r) => `deleted_at=${r.deleted_at}`);
expectEqual('...and the profile offer list is whole again', (await db.listListingsByCoach(ANON, COACH!.userId)).length, profileOffersBefore.length);
expectEqual(
  '...with account-level stats still untouched by the whole cycle',
  JSON.stringify(await db.getCoachStats(COACH!.userId)),
  JSON.stringify(profileStatsBefore),
);

// ---------------------------------------------------------------------------
section('updateMyCoachProfile — self only, approved only, never an admin');
// ---------------------------------------------------------------------------
const COACH_EDIT = {
  coach_headline: 'Run-up rhythm and block mechanics',
  coach_bio: 'Rewritten by the coach, not copied from anything.',
  coach_years_coaching: 7,
};
await refuses('anon updateMyCoachProfile', 'unauthorized', () => db.updateMyCoachProfile(ANON, COACH_EDIT));
await refuses('a learner updateMyCoachProfile', 'forbidden', () =>
  db.updateMyCoachProfile({ userId: second.id }, COACH_EDIT),
);
await refuses('a REJECTED applicant updateMyCoachProfile', 'forbidden', () =>
  db.updateMyCoachProfile(REJECT, COACH_EDIT),
);
await refuses('a PENDING applicant updateMyCoachProfile', 'forbidden', () =>
  db.updateMyCoachProfile({ userId: pendingApplicant.id }, COACH_EDIT),
);

// A refusal proves nothing without a matching success through the same path.
const nilsHeadlineBefore = (await db.getPublicCoach(EMPTY_COACH))?.coach_headline;
const coryHeadlineBefore = (await db.getPublicCoach(COACH!.userId))?.coach_headline;
await allows('an approved coach edits their OWN public profile', () => db.updateMyCoachProfile(NILS, COACH_EDIT), (r) => `${r.coach_headline}`);
expectEqual('...and it is readable back through the PUBLIC read', (await db.getPublicCoach(EMPTY_COACH))?.coach_headline, COACH_EDIT.coach_headline);
expectEqual('...the bio too', (await db.getPublicCoach(EMPTY_COACH))?.coach_bio, COACH_EDIT.coach_bio);
expectEqual('...and the years', (await db.getPublicCoach(EMPTY_COACH))?.coach_years_coaching, 7);
expectEqual('...it really changed something', nilsHeadlineBefore, null);
// The scope assertion. There is no parameter naming a subject, so the only way
// this writes to the wrong row is by resolving the wrong profile — which this
// catches and the assertions above do not.
expectEqual(
  "...and it did NOT touch another coach's profile",
  (await db.getPublicCoach(COACH!.userId))?.coach_headline,
  coryHeadlineBefore,
);
// The privilege columns are outside this write. Asserted rather than assumed:
// this method is the one path a coach has into their own profile row, so it is
// the obvious place for a role escalation to be introduced by accident.
//
// NOTE WHICH OF THESE FOUR CAN ACTUALLY DISCRIMINATE, because two of them
// cannot and it took a HIGH finding to notice. Nils's `role` ALREADY is
// 'coach', and the method's own gate guarantees every actor that reaches the
// write is ALREADY `coach_status === 'approved'` — so inserting
// `profile.role = 'coach'; profile.coach_status = 'approved';` into the write
// block leaves both of the first two assertions true. They are kept as cheap
// regression cover for a write of some OTHER value, and the block below is what
// actually pins the pair.
const nilsAfter = await db.getProfile(ADMIN, EMPTY_COACH);
expectEqual('...role untouched (weak: Nils is already a coach — see the block below)', nilsAfter?.role, 'coach');
expectEqual('...coach_status untouched (weak: the gate guarantees approved — see below)', nilsAfter?.coach_status, 'approved');
expectEqual('...email untouched', nilsAfter?.email, 'newcoach@javelin.test');
expectEqual('...full_name untouched', nilsAfter?.full_name, 'Nils Berg');

// =========================================================================
// F1 — THE SUBJECT FOR WHOM A ROLE WRITE IS OBSERVABLE AT ALL.
// =========================================================================
// An ADMIN WHO IS ALSO AN APPROVED COACH is the only actor that can show it.
// `role='admin'` and `coach_status='approved'` is a real, reachable state —
// it is exactly what an administrator who redeems an invite code becomes, and
// the D2 section above put this admin in it — and it passes
// `isApprovedCoachProfile()`, so the write proceeds.
//
// Against Nils, `profile.role = 'coach'` is a no-op. Against this actor it is a
// DEMOTION out of the admin role, performed by the admin's own bio edit: the
// precise bug `promoteToCoachRole()` exists to prevent, and rule 2 of
// docs/DATA-LAYER.md ("becoming a coach only ever RAISES privilege").
//
// The two `expectEqual`s below are therefore not a reworded version of the two
// above. They are the only assertions in this file that fail when the write
// block gains a privilege-column write.
expectEqual('F1 fixture: the admin is ALSO an approved coach', await coachStatusOf(ADMIN!.userId), 'approved');
expectEqual('F1 fixture: ...and is still an admin going in', await roleOf(ADMIN!.userId), 'admin');
await allows(
  'F1: an admin who is also an approved coach edits their own public profile',
  () =>
    db.updateMyCoachProfile(ADMIN, {
      coach_headline: 'Administrator who also coaches',
      coach_bio: 'Written by an admin whose role must survive this write.',
      coach_years_coaching: 3,
    }),
  (r) => `role=${r.role} coach_status=${r.coach_status}`,
);
const adminAfterOwnEdit = await db.getProfile(ADMIN, ADMIN!.userId);
expectEqual('F1: ...and they are STILL an admin afterwards', adminAfterOwnEdit?.role, 'admin');
expectEqual('F1: ...with coach_status untouched', adminAfterOwnEdit?.coach_status, 'approved');
// Non-vacuous: the edit really did land, so the two assertions above are about
// a write that happened rather than about a call that quietly did nothing.
expectEqual('F1: ...and the edit really landed', adminAfterOwnEdit?.coach_headline, 'Administrator who also coaches');
// And the privilege survived in a way that is observable through behaviour, not
// only through a column read — an admin who was silently demoted would lose
// every admin operation, which is what made the original bug so expensive.
await allows(
  'F1: ...and they still hold admin powers after editing their own profile',
  () => db.listInvites(ADMIN),
  (r) => `${r.length} invite(s) still visible`,
);
// Crafted extra keys, cast past the type: a Server Action is a public endpoint
// and the input type is erased at runtime.
await allows(
  'a crafted payload carrying role/coach_status/id/email is accepted but ignored',
  () =>
    db.updateMyCoachProfile(NILS, {
      ...COACH_EDIT,
      coach_headline: 'After the crafted payload',
      role: 'admin',
      coach_status: 'approved',
      id: COACH!.userId,
      email: 'attacker@javelin.test',
      full_name: 'Not Nils',
    } as unknown as typeof COACH_EDIT),
  (r) => `role=${r.role}`,
);
const nilsAfterInjection = await db.getProfile(ADMIN, EMPTY_COACH);
expectEqual('...the injected role was not honoured', nilsAfterInjection?.role, 'coach');
expectEqual('...nor the injected email', nilsAfterInjection?.email, 'newcoach@javelin.test');
expectEqual('...nor the injected full_name', nilsAfterInjection?.full_name, 'Nils Berg');
expectEqual('...nor the injected id', nilsAfterInjection?.id, EMPTY_COACH);
expectEqual('...while the legitimate column DID change', nilsAfterInjection?.coach_headline, 'After the crafted payload');
expectEqual("...and the id in the payload did not redirect the write", (await db.getPublicCoach(COACH!.userId))?.coach_headline, coryHeadlineBefore);

// Validation. `0` is the one that matters: it is a real answer and must not be
// laundered into "not stated".
await refuses('years coaching above the cap', 'invalid', () =>
  db.updateMyCoachProfile(NILS, { ...COACH_EDIT, coach_years_coaching: 81 }),
);
await refuses('negative years coaching', 'invalid', () =>
  db.updateMyCoachProfile(NILS, { ...COACH_EDIT, coach_years_coaching: -1 }),
);
await refuses('fractional years coaching', 'invalid', () =>
  db.updateMyCoachProfile(NILS, { ...COACH_EDIT, coach_years_coaching: 4.5 }),
);
await refuses('years coaching as a string', 'invalid', () =>
  db.updateMyCoachProfile(NILS, { ...COACH_EDIT, coach_years_coaching: '7' } as unknown as typeof COACH_EDIT),
);
await refuses('an over-length headline', 'invalid', () =>
  db.updateMyCoachProfile(NILS, { ...COACH_EDIT, coach_headline: 'x'.repeat(121) }),
);
await refuses('an over-length bio', 'invalid', () =>
  db.updateMyCoachProfile(NILS, { ...COACH_EDIT, coach_bio: 'x'.repeat(2001) }),
);
await allows('zero years coaching is a legal, STORED answer', () => db.updateMyCoachProfile(NILS, { ...COACH_EDIT, coach_years_coaching: 0 }), (r) => `${r.coach_years_coaching}`);
expectEqual('...and it comes back as 0, not as null', (await db.getPublicCoach(EMPTY_COACH))?.coach_years_coaching, 0);
// AND IT SURVIVES A RELOAD. The read above is served from the in-process cache,
// so it cannot see the backfill in `seedDatabase()`, which re-runs on every load
// from disk. A falsy repair there (`if (!profile.coach_years_coaching)`) would
// launder a stored 0 into NULL on the next process start — the coach's "first
// season" silently becoming "not stated" — and every in-memory assertion in
// this file would still pass. Dropping the cache is the only thing that reaches
// that code path.
__resetStoreCache();
expectEqual(
  '...and it is still 0 after the store is reloaded from disk and reseeded',
  (await db.getPublicCoach(EMPTY_COACH))?.coach_years_coaching,
  0,
);
expectEqual(
  '...specifically not laundered into null by the backfill',
  (await db.getPublicCoach(EMPTY_COACH))?.coach_years_coaching === null,
  false,
);
await allows('clearing the three columns', () => db.updateMyCoachProfile(NILS, { coach_headline: '', coach_bio: null, coach_years_coaching: null }), (r) => `${r.coach_headline}`);
expectEqual('...an empty-string headline stores as NULL', (await db.getPublicCoach(EMPTY_COACH))?.coach_headline, null);
expectEqual('...and the bio too', (await db.getPublicCoach(EMPTY_COACH))?.coach_bio, null);
expectEqual('...and the years', (await db.getPublicCoach(EMPTY_COACH))?.coach_years_coaching, null);
note('Nils Berg is back to a completely empty coach profile for the rest of the suite');

// ---------------------------------------------------------------------------
section('The public bio is COPIED at approval, and is not a live join');
// ---------------------------------------------------------------------------
// `coach_applications.bio` is readable only by its author and by admins. The
// only sanctioned way it becomes public is this one-time copy — so the two
// things worth pinning are that the copy HAPPENS, and that it is a copy.
const APPLICANT_BIO = 'COPY-AT-APPROVAL marker bio, written for an administrator to read, twenty-plus characters long.';
const copyApplicant = await signUpProfile({ email: 'copy-me@javelin.test', password: 'password123', fullName: 'Cara Copy' });
const COPY: Actor = { userId: copyApplicant.id };
await db.createCoachApplication(COPY, { ...APPLICATION, bio: APPLICANT_BIO });
expectEqual('before approval the applicant is not in the directory at all', await db.getPublicCoach(copyApplicant.id), null);
const copyApp = (await db.listCoachApplications(ADMIN, { status: 'pending' })).find((a) => a.user_id === copyApplicant.id)!;
await allows('admin approves them', () => db.reviewCoachApplication(ADMIN, copyApp.id, 'approved'), (r) => `status=${r.status}`);
const copiedCoach = await db.getPublicCoach(copyApplicant.id);
expectEqual('the application bio is now their PUBLIC bio', copiedCoach?.coach_bio, APPLICANT_BIO);
// The other two are deliberately NOT derived from anything: no integer can be
// recovered from free text, and `experience` is prose written to a reviewer.
expectEqual('...but no headline was invented for them', copiedCoach?.coach_headline, null);
expectEqual('...and no years coaching was invented either', copiedCoach?.coach_years_coaching, null);

// THE assertion that separates a copy from a join. Editing the application row
// afterwards must change nothing public. A live join passes every assertion
// above and fails this one.
await mutateDb((store) => {
  store.coach_applications.find((a) => a.id === copyApp.id)!.bio = 'EDITED IN THE APPLICATION AFTER APPROVAL';
});
expectEqual(
  'editing the application afterwards does NOT change the public bio — it is a copy, not a join',
  (await db.getPublicCoach(copyApplicant.id))?.coach_bio,
  APPLICANT_BIO,
);
expectEqual(
  '...and the application really did change, so the assertion above is not vacuous',
  (await db.getMyCoachApplication(COPY))?.bio,
  'EDITED IN THE APPLICATION AFTER APPROVAL',
);

// The copy is ONLY-WHEN-EMPTY. A coach who already has words of their own must
// not have them replaced by an old application.
const keepBioUser = await signUpProfile({ email: 'keep-bio@javelin.test', password: 'password123', fullName: 'Kai Keep' });
await db.createCoachApplication({ userId: keepBioUser.id }, { ...APPLICATION, bio: 'APPLICATION BIO that must NOT win, twenty-plus characters long.' });
await mutateDb((store) => {
  store.profiles.find((p) => p.id === keepBioUser.id)!.coach_bio = 'THE COACH OWN WORDS';
});
const keepApp = (await db.listCoachApplications(ADMIN, { status: 'pending' })).find((a) => a.user_id === keepBioUser.id)!;
await db.reviewCoachApplication(ADMIN, keepApp.id, 'approved');
expectEqual(
  'approval does not overwrite a bio the coach already has',
  (await db.getPublicCoach(keepBioUser.id))?.coach_bio,
  'THE COACH OWN WORDS',
);

// Rejection copies nothing — and there is nowhere for it to go anyway, since a
// rejected applicant has no public coach row.
const rejectedCopyUser = await signUpProfile({ email: 'reject-copy@javelin.test', password: 'password123', fullName: 'Rob Rejected' });
await db.createCoachApplication({ userId: rejectedCopyUser.id }, { ...APPLICATION, bio: 'REJECTED BIO that must never be published anywhere.' });
const rejApp = (await db.listCoachApplications(ADMIN, { status: 'pending' })).find((a) => a.user_id === rejectedCopyUser.id)!;
await db.reviewCoachApplication(ADMIN, rejApp.id, 'rejected', 'Not yet.');
expectEqual('a REJECTED application copies nothing into the profile', (await db.getProfile(ADMIN, rejectedCopyUser.id))?.coach_bio, null);
expectEqual('...and there is no public coach row to read it from', await db.getPublicCoach(rejectedCopyUser.id), null);

// A coach who arrived by INVITE CODE filed no application, so there is nothing
// to copy and their public bio is null. That is the state the UI must render,
// not an edge case.
expectEqual(
  'an invite-redeemed coach has no public bio — there was no application to copy',
  (await db.getPublicCoach(INVITEE.userId))?.coach_bio,
  null,
);
expectEqual('...but they ARE in the directory', (await db.listCoaches()).some((c) => c.id === INVITEE.userId), true);

// ---------------------------------------------------------------------------
section('E3-F10 pickup — getMyCoachApplication is scoped to the actor');
// ---------------------------------------------------------------------------
// The defect this closes: widening `.filter(a => a.user_id === profile.id)` to
// `() => true` left the suite at 561/0. The method sorts newest-first and takes
// [0], so the widened version serves WHOEVER FILED MOST RECENTLY to everybody —
// and `coach_applications.bio` is an owner-and-admin-only artifact.
//
// It went undetected because at the only two places it was asserted, the actor
// was the ONLY user who had ever filed. A fixture that can only come from one
// source cannot discriminate, however the assertion is spelled.
const FIRST_BIO = 'FIRST-FILER private bio, unique to this applicant and to nobody else in the store.';
const SECOND_BIO = 'SECOND-FILER private bio, unique to this applicant and to nobody else in the store.';
const firstFiler = await signUpProfile({ email: 'first-filer@javelin.test', password: 'password123', fullName: 'Fay First' });
const secondFiler = await signUpProfile({ email: 'second-filer@javelin.test', password: 'password123', fullName: 'Sid Second' });
const FIRST: Actor = { userId: firstFiler.id };
const SECOND_ACTOR: Actor = { userId: secondFiler.id };
await db.createCoachApplication(FIRST, { ...APPLICATION, bio: FIRST_BIO });
// Filed AFTERWARDS, which is the half that makes the widening mutant bite: the
// newest row is now somebody else's.
await db.createCoachApplication(SECOND_ACTOR, { ...APPLICATION, bio: SECOND_BIO });

const firstOwn = await allows('the first filer reads their own application', () => db.getMyCoachApplication(FIRST), (r) => `user_id=${r?.user_id}`);
expectEqual('F10: ...and it is THEIR row, by user_id', firstOwn?.user_id, firstFiler.id);
expectEqual('F10: ...and by a bio that exists nowhere else in the store', firstOwn?.bio, FIRST_BIO);
// BOTH directions, deliberately. `created_at` is millisecond-resolution and two
// signups can land inside the same millisecond, in which case the sort is
// stable and [0] is whichever was inserted first — so a widened filter would
// serve the FIRST filer's row to everybody instead. Asserting both means one of
// these two fails whichever way the tie breaks.
const secondOwn = await allows('the second filer reads their own application', () => db.getMyCoachApplication(SECOND_ACTOR), (r) => `user_id=${r?.user_id}`);
expectEqual('F10: ...and it is THEIR row, by user_id', secondOwn?.user_id, secondFiler.id);
expectEqual('F10: ...and by their own unique bio', secondOwn?.bio, SECOND_BIO);
expectEqual('F10: the two filers did NOT receive the same row', firstOwn?.id === secondOwn?.id, false);
// Emptying the predicate to `() => false` returns null, which the four
// assertions above already catch — but state it, because a null that is only
// caught by an optional-chain comparison is easy to weaken later.
expectEqual('F10: neither read is null', firstOwn !== null && secondOwn !== null, true);
// A third user who has never applied must get null, not somebody else's row.
const neverApplied = await signUpProfile({ email: 'never-applied@javelin.test', password: 'password123', fullName: 'Nev Never' });
expectEqual('F10: a user who never applied gets null, not the newest row', await db.getMyCoachApplication({ userId: neverApplied.id }), null);
await refuses('anon getMyCoachApplication', 'unauthorized', () => db.getMyCoachApplication(ANON));

// ---------------------------------------------------------------------------
section('E3-F11 pickup — listCoachApplications honours its status filter');
// ---------------------------------------------------------------------------
// Admin-only and a convenience rather than an authorization predicate, but it
// was ignored-undetected: the fixtures only ever held one status at a time.
// By this point the store holds all three, which is what lets these bite.
const allApps = await db.listCoachApplications(ADMIN);
const pendingApps = await db.listCoachApplications(ADMIN, { status: 'pending' });
const approvedApps = await db.listCoachApplications(ADMIN, { status: 'approved' });
const rejectedApps = await db.listCoachApplications(ADMIN, { status: 'rejected' });
// Non-emptiness on all three, or `.every()` below is vacuous and a filter that
// returned nothing would pass.
expectEqual('F11: there is at least one application in each of the three statuses', `${pendingApps.length > 0}/${approvedApps.length > 0}/${rejectedApps.length > 0}`, 'true/true/true');
expectEqual('F11: status=pending returns only pending', pendingApps.every((a) => a.status === 'pending'), true);
expectEqual('F11: status=approved returns only approved', approvedApps.every((a) => a.status === 'approved'), true);
expectEqual('F11: status=rejected returns only rejected', rejectedApps.every((a) => a.status === 'rejected'), true);
// The counting assertion. A filter that is ignored returns the FULL list every
// time, so each filtered call would equal `allApps.length` — which the
// `.every()` checks above would also catch, but only because the three statuses
// are all populated. This states the arithmetic directly.
expectEqual('F11: the three filtered lists partition the unfiltered one', pendingApps.length + approvedApps.length + rejectedApps.length, allApps.length);
expectEqual('F11: and each filtered list is strictly smaller than the whole', pendingApps.length < allApps.length && approvedApps.length < allApps.length && rejectedApps.length < allApps.length, true);
note(`${allApps.length} applications: ${pendingApps.length} pending, ${approvedApps.length} approved, ${rejectedApps.length} rejected`);
await refuses('a learner listCoachApplications', 'forbidden', () => db.listCoachApplications({ userId: second.id }, { status: 'pending' }));

// ---------------------------------------------------------------------------
section('A pre-coach-columns store upgrades to NULL, not to undefined');
// ---------------------------------------------------------------------------
// `data/db.json` is gitignored and long-lived, so a real machine is holding
// profile rows written before these three columns existed — rows with no such
// keys at all. `seedDatabase()` backfills them on load, and this is the only
// thing that exercises that path: every row the seed and signUp() write already
// carries the columns.
//
// It is not cosmetic. `undefined` and `null` serialise differently through
// JSON, a profile-shape assertion fails on the missing key, and a UI branching
// on `coach_years_coaching !== null` renders "undefined years coaching".
const legacyProfileId = '00000000-0000-4000-8000-00000000beef';
await mutateDb((store) => {
  const stamp = new Date().toISOString();
  store.profiles.push({
    id: legacyProfileId,
    email: 'legacy@javelin.test',
    full_name: 'Lex Legacy',
    role: 'coach',
    coach_status: 'approved',
    created_at: stamp,
    updated_at: stamp,
    // The three columns are deliberately ABSENT — the whole point of the
    // fixture. Cast past the row type to express that.
  } as unknown as Parameters<typeof store.profiles.push>[0]);
});
__resetStoreCache();

const legacyPublic = await db.getPublicCoach(legacyProfileId);
expectShape('a pre-coach-columns row gains the columns on load', legacyPublic, PUBLIC_COACH_COLUMNS);
expectEqual('...headline backfilled to NULL', legacyPublic?.coach_headline, null);
expectEqual('...and specifically NOT undefined', legacyPublic?.coach_headline === undefined, false);
expectEqual('...bio backfilled to NULL', legacyPublic?.coach_bio, null);
expectEqual('...years backfilled to NULL', legacyPublic?.coach_years_coaching, null);
expectShape(
  '...and the full profile row is whole again',
  await db.getProfile(ADMIN, legacyProfileId),
  PROFILE_COLUMNS,
);
await mutateDb((store) => {
  store.profiles = store.profiles.filter((p) => p.id !== legacyProfileId);
});
expectEqual('pre-coach-columns fixture removed', await db.getPublicCoach(legacyProfileId), null);

// ---------------------------------------------------------------------------
section('E4 rework — F8/F9/F10/F11/F13/F14');
// ---------------------------------------------------------------------------

// --- F9: initialsOf, the avatar's whole logic, was exported "so it can be
// asserted directly" and was asserted nowhere. Its own doc names four hazards;
// each gets the case that fails without the corresponding line.
expectEqual('F9: two words -> first + last initial', initialsOf('Cory Vaughn'), 'CV');
expectEqual('F9: one word -> ONE letter, not a doubled one', initialsOf('Prince'), 'P');
expectEqual('F9: three or more words -> first and LAST, never the middle', initialsOf('Tomas Van Der Berg'), 'TB');
expectEqual('F9: an empty name -> empty string, not a throw', initialsOf(''), '');
expectEqual('F9: a whitespace-only name -> empty string', initialsOf('  \t  '), '');
expectEqual('F9: collapses runs of whitespace rather than emitting a blank word', initialsOf('  Ada    Lovelace  '), 'AL');
// The astral case: `name[0]` would return half a surrogate pair, which renders
// as U+FFFD. Array.from iterates code points.
expectEqual('F9: an astral first character survives whole', initialsOf('\u{1D4A5}ane \u{1D49F}oe'), '\u{1D4A5}\u{1D49F}');
expectEqual('F9: ...and is not a lone surrogate', Array.from(initialsOf('\u{1D4A5}ane \u{1D49F}oe')).length, 2);
expectEqual('F9: an emoji name does not produce a replacement character', initialsOf('\u{1F3AF} Thrower').includes('�'), false);
expectEqual('F9: lowercase is uppercased', initialsOf('ada lovelace'), 'AL');
// Non-string input reaches this from a store that is not validated on load.
expectEqual('F9: a non-string name does not throw', initialsOf(null as unknown as string), '');

// --- F10: getPublicCoach's lookup must match on ID and nothing else.
// Widening it to also match `full_name` turns /coaches/<name> into an oracle
// that answers "is this person an approved coach?" for a guessed NAME rather
// than for a uuid — and names are guessable in a way uuids are not.
expectEqual('F10: getPublicCoach does not match on full_name', await db.getPublicCoach('Cory Vaughn'), null);
expectEqual('F10: ...nor on a lowercased name', await db.getPublicCoach('cory vaughn'), null);
expectEqual('F10: ...nor on an email', await db.getPublicCoach('coach@javelin.test'), null);
// The matching positive control, so the three refusals above are not vacuous.
expectEqual('F10: ...while the id still works', (await db.getPublicCoach(COACH!.userId))?.full_name, 'Cory Vaughn');

// --- F11: getPublicProfile.is_approved_coach is the ONE derived privilege bit
// this product publishes, and it has to mean exactly `coach_status ===
// 'approved'`. Widened to `!== 'none'` it starts reporting true for people who
// are merely awaiting review or have been REJECTED — publishing the existence
// of a rejected coaching application, which is the disclosure the raw column
// was dropped to prevent.
expectEqual(
  'F11: is_approved_coach is FALSE for an applicant awaiting review',
  (await db.getPublicProfile(pendingApplicant.id))?.is_approved_coach,
  false,
);
expectEqual(
  'F11: ...and FALSE for a REJECTED applicant',
  (await db.getPublicProfile(REJECT.userId))?.is_approved_coach,
  false,
);
expectEqual(
  'F11: ...and FALSE for a learner who never applied',
  (await db.getPublicProfile(second.id))?.is_approved_coach,
  false,
);
expectEqual(
  'F11: ...while TRUE for a real approved coach, so the three above discriminate',
  (await db.getPublicProfile(COACH!.userId))?.is_approved_coach,
  true,
);

// --- F8: getMyCoachApplication returns the actor's MOST RECENT application.
// The method sorts newest-first and takes [0]; reversing that comparator
// survived every existing assertion, because no actor in this file had ever
// held two applications. A rejected applicant may re-apply, so two is a real
// state — and it is the state in which the wrong row shows a STALE decision as
// the current one.
const REAPPLY_OLD = 'F8 FIRST application, the one that was rejected and must NOT be served.';
const REAPPLY_NEW = 'F8 SECOND application, filed after the rejection, and the current one.';
const reapplier = await signUpProfile({ email: 'reapply@javelin.test', password: 'password123', fullName: 'Ria Reapply' });
const REAPPLY: Actor = { userId: reapplier.id };
const firstApp = await db.createCoachApplication(REAPPLY, { ...APPLICATION, bio: REAPPLY_OLD });
await db.reviewCoachApplication(ADMIN, firstApp.id, 'rejected', 'Not yet.');
const secondApp = await db.createCoachApplication(REAPPLY, { ...APPLICATION, bio: REAPPLY_NEW });
// Timestamps are forced apart rather than hoped apart: `nowIso()` is
// millisecond-resolution and two calls this close can land in the same one, in
// which case a stable sort returns insertion order and the mutant would not
// bite. Writing them makes the assertion deterministic on any machine.
await mutateDb((store) => {
  store.coach_applications.find((a) => a.id === firstApp.id)!.created_at = '2026-01-01T00:00:00.000Z';
  store.coach_applications.find((a) => a.id === secondApp.id)!.created_at = '2026-06-01T00:00:00.000Z';
});
expectEqual(
  'F8 fixture: the re-applicant holds TWO applications',
  await mutateDb((store) => store.coach_applications.filter((a) => a.user_id === reapplier.id).length),
  2,
);
const servedApp = await db.getMyCoachApplication(REAPPLY);
expectEqual('F8: the NEWEST application is served, by id', servedApp?.id, secondApp.id);
expectEqual('F8: ...and by a bio unique to it', servedApp?.bio, REAPPLY_NEW);
expectEqual('F8: ...and it is NOT the older, rejected one', servedApp?.id === firstApp.id, false);
expectEqual('F8: ...whose status would have been shown as the current decision', servedApp?.status, 'pending');

// --- F13: the approval copy must take the bio of THE APPLICATION BEING
// REVIEWED, not of "an application belonging to that user". The re-applicant
// above is the fixture: their rejected first application and their approved
// second one hold different bios, so a lookup by user_id rather than by the
// reviewed row publishes the wrong text — a bio the reviewer never read.
await allows(
  'F13: approve the SECOND application',
  () => db.reviewCoachApplication(ADMIN, secondApp.id, 'approved'),
  (r) => `status=${r.status}`,
);
expectEqual('F13: the published bio is the APPROVED application’s', (await db.getPublicCoach(reapplier.id))?.coach_bio, REAPPLY_NEW);
expectEqual('F13: ...and specifically NOT the rejected one’s', (await db.getPublicCoach(reapplier.id))?.coach_bio === REAPPLY_OLD, false);

// --- F14: hasCoachBio() trims, so a bio of nothing but whitespace counts as
// EMPTY and the one-time copy still fires. Without the trim, a profile holding
// "   " would suppress the copy for ever and the coach would be published with
// a blank bio and nothing to explain why.
const WHITESPACE_APP_BIO = 'F14 application bio, which must win over a whitespace-only profile bio.';
const blankBioUser = await signUpProfile({ email: 'blank-bio@javelin.test', password: 'password123', fullName: 'Wes Whitespace' });
await db.createCoachApplication({ userId: blankBioUser.id }, { ...APPLICATION, bio: WHITESPACE_APP_BIO });
await mutateDb((store) => {
  store.profiles.find((p) => p.id === blankBioUser.id)!.coach_bio = '   \n\t  ';
});
const blankApp = (await db.listCoachApplications(ADMIN, { status: 'pending' })).find((a) => a.user_id === blankBioUser.id)!;
await db.reviewCoachApplication(ADMIN, blankApp.id, 'approved');
expectEqual(
  'F14: a whitespace-only profile bio counts as empty, so the copy still fires',
  (await db.getPublicCoach(blankBioUser.id))?.coach_bio,
  WHITESPACE_APP_BIO,
);

// ---------------------------------------------------------------------------
section('Instant delivery — the mode, the file, and who may see the path');
// ---------------------------------------------------------------------------
// Everything here is built at RUNTIME rather than seeded, for the same reason
// withdrawal is: the seed mirrors supabase/seed.sql row for row, every seeded
// offer is `personalised` there, and an instant fixture would have to point at a
// file the mock has no storage for.
//
// Two rules carry the weight and they protect different people:
//
//   `asset_path` is not public          — the key of a private object, revoked
//                                         from every client role in SQL, so a
//                                         listing shape carrying it is a shape
//                                         Postgres cannot produce.
//   the mode is frozen at first claim   — a promise to the buyer, which is why
//                                         it binds an ADMIN too.

const instantOffer = await allows(
  'a coach may publish an INSTANT offer',
  () =>
    db.createListing(COACH, {
      title: 'Instant delivery fixture',
      description: 'Published as an instant download, to exercise the attach-a-file path end to end.',
      price_cents: 2500,
      category: 'training_plan',
      fulfilment: 'instant',
    }),
  (r) => `${r.id} fulfilment=${r.fulfilment}`,
);
expectEqual('...and it really is instant', instantOffer?.fulfilment, 'instant');
// THE disclosure assertion. `asset_path` must be absent from the shape, not
// merely null in it — a public listing read that names the column is a 42501
// against the real database.
expectShape(
  '...and the returned shape carries NO asset_path',
  instantOffer,
  LISTING_WITH_COACH_COLUMNS,
);

const defaultedOffer = await allows(
  'omitting the mode falls back to the column DEFAULT, not to instant',
  () =>
    db.createListing(COACH, {
      title: 'Unspecified delivery fixture',
      description: 'Created with no fulfilment at all, mirroring a caller that predates the column.',
      price_cents: 2600,
      category: 'training_plan',
    }),
  (r) => `fulfilment=${r.fulfilment}`,
);
expectEqual('...which is personalised', defaultedOffer?.fulfilment, 'personalised');

for (const bogus of ['Instant', 'INSTANT', 'immediate', '', ' ', 'personalized']) {
  await refuses(`createListing rejects fulfilment=${JSON.stringify(bogus)}`, 'invalid', () =>
    db.createListing(COACH, {
      title: 'Rejected mode fixture',
      description: 'Should never reach the store, because the mode is closed like the category is.',
      price_cents: 2700,
      category: 'training_plan',
      fulfilment: bogus as unknown as 'instant',
    }),
  );
}
// THE CONTROL for that loop, which would otherwise pass for a method that
// refuses everything — and it pins the one transformation the validator does
// make. Surrounding whitespace is trimmed and the value accepted; nothing else
// is. Both backends have to agree here, and they do because they share
// `optionalFulfilment`: the Supabase client sends Postgres the TRIMMED string,
// so the enum column never sees the space that would make it a cast error.
const trimmedMode = await allows(
  'a mode with surrounding whitespace is trimmed, not rejected',
  () =>
    db.createListing(COACH, {
      title: 'Trimmed mode fixture',
      description: 'The one transformation the mode validator makes, pinned so it cannot quietly widen.',
      price_cents: 2700,
      category: 'training_plan',
      fulfilment: ' instant ' as unknown as 'instant',
    }),
  (r) => `fulfilment=${r.fulfilment}`,
);
expectEqual('...and it lands as the exact enum value', trimmedMode?.fulfilment, 'instant');

// --- setListingAsset: who may attach ---------------------------------------
const ASSET = `${instantOffer!.id}/abcd1234-plan.pdf`;

await refuses('another approved coach may not attach a file', 'forbidden', () =>
  db.setListingAsset(NILS, instantOffer!.id, ASSET),
);
// The same asymmetry as updateListing, and it is the point of the method: a
// moderator takes an offer down, they do not swap the file it delivers.
expectEqual('the admin actor is an approved coach, so approval cannot be what refuses', await coachStatusOf(ADMIN!.userId), 'approved');
await refuses('an ADMIN may not attach a file either', 'forbidden', () =>
  db.setListingAsset(ADMIN, instantOffer!.id, ASSET),
);
await refuses('a learner may not attach a file', 'forbidden', () =>
  db.setListingAsset(MARCUS, instantOffer!.id, ASSET),
);
await refuses('an anonymous caller may not attach a file', 'unauthorized', () =>
  db.setListingAsset(null, instantOffer!.id, ASSET),
);

// --- setListingAsset: what may be attached ---------------------------------
await refuses("a path under ANOTHER offer's folder is refused", 'forbidden', () =>
  db.setListingAsset(COACH, instantOffer!.id, `${defaultedOffer!.id}/stolen.pdf`),
);
await refuses('a bare filename with no folder is refused', 'forbidden', () =>
  db.setListingAsset(COACH, instantOffer!.id, 'plan.pdf'),
);
for (const [shape, path] of [
  ['traversal', `${instantOffer!.id}/../${defaultedOffer!.id}/plan.pdf`],
  ['an absolute path', `/${instantOffer!.id}/plan.pdf`],
  ['a backslash', `${instantOffer!.id}\\plan.pdf`],
] as Array<[string, string]>) {
  await refuses(`setListingAsset rejects ${shape}`, 'invalid', () =>
    db.setListingAsset(COACH, instantOffer!.id, path),
  );
}
// A file on a personalised offer is the one thing personalised delivery exists
// not to be: bytes every buyer of the offer could fetch.
await refuses('a PERSONALISED offer cannot hold a file', 'invalid', () =>
  db.setListingAsset(COACH, defaultedOffer!.id, `${defaultedOffer!.id}/plan.pdf`),
);

// --- the control -----------------------------------------------------------
const attached = await allows(
  'the OWNER may attach a file to their own instant offer',
  () => db.setListingAsset(COACH, instantOffer!.id, ASSET),
  (r) => `asset_path=${r.asset_path}`,
);
expectShape('...returning the OWNER shape, which is the only one with a path', attached, OWNED_LISTING_COLUMNS);
expectEqual('...and the path is the one that was sent', attached?.asset_path, ASSET);

// The disclosure boundary, from both sides of the same row.
const publicView = await db.getListing(instantOffer!.id);
expectShape('the PUBLIC read of that same offer still has no asset_path', publicView, LISTING_WITH_COACH_COLUMNS);
expectEqual('...while still publishing the mode, which IS public', publicView?.fulfilment, 'instant');
const ownRows = await db.listMyListings(COACH);
expectEqual(
  'the owner’s own dashboard row carries the path',
  ownRows.find((row) => row.id === instantOffer!.id)?.asset_path,
  ASSET,
);

// --- claiming --------------------------------------------------------------
// An instant offer with no file cannot be claimed. Asserted on a THIRD offer,
// because the one above now has a file and could not fail this way.
const unreadyOffer = await allows(
  'a coach may publish an instant offer before attaching its file',
  () =>
    db.createListing(COACH, {
      title: 'Instant offer with nothing attached',
      description: 'Legal to publish and impossible to claim, which is the state the dashboard flags.',
      price_cents: 2800,
      category: 'training_plan',
      fulfilment: 'instant',
    }),
  (r) => r.id,
);
await refuses('...but nobody can claim it while it has no file', 'invalid', () =>
  db.createOrder(AISHA, unreadyOffer!.id),
);

const instantOrder = await allows(
  'a learner may claim an instant offer that HAS a file',
  () => db.createOrder(LEARNER, instantOffer!.id),
  (r) => r.id,
);

const buyerOrder = await db.getOrder(LEARNER, instantOrder!.id);
expectShape('the order shape carries the mode and the path', buyerOrder, ORDER_COLUMNS);
expectEqual('...the mode is joined from the live listing', buyerOrder?.listing_fulfilment, 'instant');
expectEqual('...and the BUYER gets the download path', buyerOrder?.asset_path, ASSET);
const sellerOrder = await db.getOrder(COACH, instantOrder!.id);
expectEqual('...so does the selling coach', sellerOrder?.asset_path, ASSET);
// THE asymmetry worth having. An admin may read the order — they can see that a
// purchase happened — and is deliberately not handed the file, because
// `entitled_offer_assets` is scoped by auth.uid() with no admin arm.
const adminOrder = await db.getOrder(ADMIN, instantOrder!.id);
expectEqual('an ADMIN can still read the order itself', adminOrder?.id, instantOrder!.id);
expectEqual('...and is NOT handed the download path', adminOrder?.asset_path, null);
// The control for that null: a personalised order reports null too, so the
// assertion above needs something that distinguishes "withheld" from "always
// null". The buyer's row two assertions up is that control.
const personalOrder = await allows(
  'a learner may claim a personalised offer',
  () => db.createOrder(MARCUS, defaultedOffer!.id),
  (r) => r.id,
);
const personalRead = await db.getOrder(MARCUS, personalOrder!.id);
expectEqual('a personalised order reports its mode', personalRead?.listing_fulfilment, 'personalised');
expectEqual('...and has no asset path, because there is no asset', personalRead?.asset_path, null);

// --- the mode is frozen once anything has been claimed ---------------------
const FROZEN_EDIT = {
  title: 'Instant delivery fixture',
  description: 'Published as an instant download, to exercise the attach-a-file path end to end.',
  price_cents: 2500,
  category: 'training_plan',
} as const;

await refuses('the mode cannot change once the offer has been claimed', 'forbidden', () =>
  db.updateListing(COACH, instantOffer!.id, { ...FROZEN_EDIT, fulfilment: 'personalised' }),
);
expectEqual(
  '...and the refused edit reached nothing',
  (await db.getListing(instantOffer!.id))?.fulfilment,
  'instant',
);
// Re-submitting the SAME mode is not a change, which is what lets the editor
// keep the control on the form for an offer that has already sold.
await allows(
  're-submitting the same mode is a no-op, not a refusal',
  () => db.updateListing(COACH, instantOffer!.id, { ...FROZEN_EDIT, fulfilment: 'instant' }),
  (r) => `fulfilment=${r.fulfilment}`,
);
// Omitting it entirely must also be a no-op — a caller that does not offer the
// control must not be able to reset the mode by staying silent.
await allows(
  'omitting the mode on an edit leaves it alone',
  () => db.updateListing(COACH, instantOffer!.id, FROZEN_EDIT),
  (r) => `fulfilment=${r.fulfilment}`,
);
expectEqual(
  '...and the offer is still instant after both',
  (await db.getListing(instantOffer!.id))?.fulfilment,
  'instant',
);

// --- switching BEFORE a claim, which clears the file ------------------------
const switchable = await allows(
  'a fresh instant offer with a file, nobody has claimed',
  async () => {
    const created = await db.createListing(COACH, {
      title: 'Switchable delivery fixture',
      description: 'Attached, then switched to personalised, to prove the file goes with the mode.',
      price_cents: 2900,
      category: 'training_plan',
      fulfilment: 'instant',
    });
    return db.setListingAsset(COACH, created.id, `${created.id}/switchme.pdf`);
  },
  (r) => `asset_path=${r.asset_path}`,
);
await allows(
  'switching it to personalised is allowed while unclaimed',
  () =>
    db.updateListing(COACH, switchable!.id, {
      title: 'Switchable delivery fixture',
      description: 'Attached, then switched to personalised, to prove the file goes with the mode.',
      price_cents: 2900,
      category: 'training_plan',
      fulfilment: 'personalised',
    }),
  (r) => `fulfilment=${r.fulfilment}`,
);
const switched = (await db.listMyListings(COACH)).find((row) => row.id === switchable!.id);
expectEqual('...the mode really changed', switched?.fulfilment, 'personalised');
// The half a CHECK constraint enforces in SQL: a personalised offer may not
// hold a path, so the switch has to clear it in the same write.
expectEqual('...and the path went with it', switched?.asset_path, null);

// --- clearing a file re-blocks claiming ------------------------------------
await allows(
  'the owner may clear the file from an instant offer',
  () => db.setListingAsset(COACH, unreadyOffer!.id, `${unreadyOffer!.id}/temporary.pdf`),
  (r) => `asset_path=${r.asset_path}`,
);
await allows(
  '...and claiming it now works',
  () => db.createOrder(AISHA, unreadyOffer!.id),
  (r) => r.id,
);
const cleared = await allows(
  'clearing it again is allowed',
  () => db.setListingAsset(COACH, unreadyOffer!.id, null),
  (r) => `asset_path=${String(r.asset_path)}`,
);
expectEqual('...the path is null', cleared?.asset_path, null);
await refuses('...and a DIFFERENT learner can no longer claim it', 'invalid', () =>
  db.createOrder(MARCUS, unreadyOffer!.id),
);
// The buyer who claimed it while the file was there keeps their order. A
// withdrawn file is not a repossession.
const keptOrder = (await db.listMyOrders(AISHA)).find((o) => o.listing_id === unreadyOffer!.id);
expectEqual('the earlier buyer still holds their order', typeof keptOrder?.id, 'string');

// ---------------------------------------------------------------------------
section('Password reset — the link is a credential');
// ---------------------------------------------------------------------------
// The one flow that runs for a user who cannot prove who they are, so the token
// carries the whole weight. Four properties are asserted, and each of them is
// the difference between a reset flow and an account-takeover endpoint:
// single use, expiry, supersession, and hashed at rest.
//
// A DEDICATED ACCOUNT. Every assertion below either changes a password or burns
// a token, so doing it to a seeded actor would leave every earlier section's
// credentials in a state later readers cannot predict.

const RESET_EMAIL = 'reset@javelin.test';
const RESET_FIRST_PASSWORD = 'reset-first-password';
const resetUser = await allows(
  'a fixture account for the reset flow',
  () => signUpProfile({ email: RESET_EMAIL, password: RESET_FIRST_PASSWORD, fullName: 'Rosa Setter' }),
  (p) => p.id,
);
const RESET_ACTOR: Actor = { userId: resetUser!.id };

// --- issuing ---------------------------------------------------------------
const firstToken = await issueResetToken(RESET_EMAIL);
expectEqual('a token is issued for a real address', typeof firstToken, 'string');
expectEqual('...and is long enough not to be guessable', (firstToken ?? '').length >= 32, true);

// THE ENUMERATION PROPERTY, at the layer that knows the answer. `null` and a
// token are distinguishable HERE on purpose — the caller is what must not
// distinguish them, and `requestPasswordReset` returns void so that it cannot.
expectEqual('an unknown address mints nothing', await issueResetToken('nobody@javelin.test'), null);
expectEqual('...and neither does an empty one', await issueResetToken(''), null);
expectEqual('...and neither does a non-string', await issueResetToken(undefined as unknown as string), null);
// Addresses are normalised the same way sign-in normalises them, or a user who
// capitalises their own address is told there is no account.
const casedToken = await issueResetToken('  RESET@Javelin.TEST  ');
expectEqual('a differently-cased, padded address still finds the account', typeof casedToken, 'string');

// --- hashed at rest --------------------------------------------------------
// The row must not contain anything that could be replayed as a link. Asserted
// against the STORE rather than against the return value, because that is what
// a leaked `db.json` would hand over.
const storedRows = await mutateDb((store) => store.password_resets.map((r) => ({ ...r })));
expectEqual(
  'no stored row holds a token in the clear',
  storedRows.some((r) => r.token_hash === casedToken || r.token_hash === firstToken),
  false,
);
expectEqual(
  '...and the stored hash is the SHA-256 of the live token',
  storedRows.some((r) => r.token_hash === hashToken(casedToken!)),
  true,
);

// --- supersession ----------------------------------------------------------
// `casedToken` was minted after `firstToken` for the same account, so the first
// one is already dead. A forwarded first email must not stay live for its full
// hour after the user asks again.
expectEqual('minting a new token kills the older one', await redeemResetToken(firstToken!), null);

// --- single use ------------------------------------------------------------
expectEqual('the newest token redeems to its user', await redeemResetToken(casedToken!), resetUser!.id);
expectEqual('...and is dead immediately afterwards', await redeemResetToken(casedToken!), null);

// --- everything else is one answer ----------------------------------------
for (const [shape, value] of [
  ['a token that was never issued', 'not-a-real-token'],
  ['an empty token', ''],
  ['the stored HASH replayed as a token', hashToken(casedToken!)],
] as Array<[string, string]>) {
  expectEqual(`${shape} redeems to null`, await redeemResetToken(value), null);
}

// --- expiry ----------------------------------------------------------------
// Aged by moving `expires_at` into the past rather than by waiting an hour.
// The check reads the STORED expiry, so this is the same code path a genuinely
// old token takes.
const staleToken = await issueResetToken(RESET_EMAIL);
await mutateDb((store) => {
  const row = store.password_resets.find((r) => r.token_hash === hashToken(staleToken!));
  if (row) row.expires_at = new Date(Date.now() - 1000).toISOString();
});
expectEqual('an expired token is refused', await redeemResetToken(staleToken!), null);
// The control: without the ageing above, that same token would have worked.
const freshToken = await issueResetToken(RESET_EMAIL);
expectEqual('...while a fresh one issued the same way is accepted', await redeemResetToken(freshToken!), resetUser!.id);

// --- updateMyPassword ------------------------------------------------------
// The other half: once a session exists, the password write is an ordinary
// actor-scoped row write and belongs to `DataClient`.
await refuses('an anonymous caller cannot change a password', 'unauthorized', () =>
  db.updateMyPassword(null, 'a-perfectly-good-password'),
);
for (const [shape, value] of [
  ['a short password', 'short'],
  ['an empty password', ''],
  ['whitespace only', '        '],
  ['a password longer than the scrypt cap', 'x'.repeat(201)],
] as Array<[string, string]>) {
  await refuses(`updateMyPassword rejects ${shape}`, 'invalid', () =>
    db.updateMyPassword(RESET_ACTOR, value),
  );
}

/*
 * A PASSWORD IS NEVER TRIMMED, and this is a regression test for a lockout.
 *
 * `requireText` returns the trimmed string, so using it here — as `signUp` used
 * to — stored `"  spaced out  "` as `"spaced out"` while `signInWithPassword`
 * verifies the raw input. The account would have been unreachable with the
 * password its owner typed, and reachable with one they never chose.
 *
 * Both halves are asserted, because storing the raw value is only half the fix:
 * the trimmed form must NOT work either, or the trimming has just moved.
 */
const PADDED_PASSWORD = '  spaced out  ';
await allows(
  'a password with surrounding spaces is accepted verbatim',
  () => db.updateMyPassword(RESET_ACTOR, PADDED_PASSWORD),
  () => 'set',
);
expectEqual(
  '...and signs in exactly as typed',
  (await db.signInWithPassword({ email: RESET_EMAIL, password: PADDED_PASSWORD }))?.id,
  resetUser!.id,
);
expectEqual(
  '...while its trimmed form does NOT',
  await db.signInWithPassword({ email: RESET_EMAIL, password: PADDED_PASSWORD.trim() }),
  null,
);
// The same rule on the way IN, so an account cannot be created in the broken
// state that this method can no longer produce.
const paddedSignUp = await allows(
  'signUp keeps a padded password verbatim too',
  () => signUpProfile({ email: 'padded@javelin.test', password: PADDED_PASSWORD, fullName: 'Pat Padded' }),
  (p) => p.id,
);
expectEqual(
  '...and that account signs in as typed',
  (await db.signInWithPassword({ email: 'padded@javelin.test', password: PADDED_PASSWORD }))?.id,
  paddedSignUp!.id,
);
expectEqual(
  '...and not with the trimmed form',
  await db.signInWithPassword({ email: 'padded@javelin.test', password: PADDED_PASSWORD.trim() }),
  null,
);
// Put the fixture back on a known password for the assertions below.
await db.updateMyPassword(RESET_ACTOR, RESET_FIRST_PASSWORD);
// A forged actor cannot name somebody else: there is no subject parameter to
// forge, which is the point of the shape. Asserted anyway, because "there is no
// parameter" is a claim about the signature that a future edit could break.
const RESET_NEW_PASSWORD = 'reset-second-password';
await allows(
  'the actor may change their OWN password',
  () => db.updateMyPassword(RESET_ACTOR, RESET_NEW_PASSWORD),
  () => 'changed',
);
expectEqual(
  'the new password signs in',
  (await db.signInWithPassword({ email: RESET_EMAIL, password: RESET_NEW_PASSWORD }))?.id,
  resetUser!.id,
);
expectEqual(
  '...and the old one no longer does',
  await db.signInWithPassword({ email: RESET_EMAIL, password: RESET_FIRST_PASSWORD }),
  null,
);
// Nobody else's credentials moved. The seeded coach is the control: if
// `updateMyPassword` were resolving the wrong subject, this is what would break.
expectEqual(
  'no other account’s password was touched',
  (await db.signInWithPassword({ email: 'coach@javelin.test', password: 'coach1234' }))?.id,
  COACH!.userId,
);
// A new salt every time, so two identical passwords do not produce one hash —
// and so "did it change?" is not answerable by comparing two leaked rows.
const credentials = await mutateDb((store) => {
  const row = store.auth_users.find((u) => u.email === RESET_EMAIL);
  return row ? { hash: row.password_hash, salt: row.password_salt } : null;
});
await db.updateMyPassword(RESET_ACTOR, RESET_NEW_PASSWORD);
const recredentials = await mutateDb((store) => {
  const row = store.auth_users.find((u) => u.email === RESET_EMAIL);
  return row ? { hash: row.password_hash, salt: row.password_salt } : null;
});
expectEqual('re-setting the SAME password re-salts', credentials?.salt === recredentials?.salt, false);
expectEqual('...and therefore produces a different hash', credentials?.hash === recredentials?.hash, false);
expectEqual(
  '...and the password still works afterwards',
  (await db.signInWithPassword({ email: RESET_EMAIL, password: RESET_NEW_PASSWORD }))?.id,
  resetUser!.id,
);

// ---------------------------------------------------------------------------
section('Account settings — everyone owns their own row and only their own');
// ---------------------------------------------------------------------------
// `updateMyProfile` and `changeMyPassword` take no subject id, which is the
// property that makes `/settings` a plain `requireUser()` page rather than a
// role check. Asserted here rather than assumed: "there is no parameter" is a
// claim about a signature that a later edit could break.

const settingsUser = await allows(
  'a fixture account for the settings section',
  () => signUpProfile({ email: 'settings@javelin.test', password: 'settings-first-password', fullName: 'Sam Setting' }),
  (p) => p.full_name,
);
const SETTINGS_ACTOR: Actor = { userId: settingsUser!.id };

// --- renaming --------------------------------------------------------------
await refuses('an anonymous caller cannot rename anybody', 'unauthorized', () =>
  db.updateMyProfile(null, { full_name: 'Anonymous Rename' }),
);
for (const [shape, value] of [
  ['an empty name', '   '],
  ['a one-character name', 'A'],
  ['a name past the cap', 'x'.repeat(121)],
] as Array<[string, string]>) {
  await refuses(`updateMyProfile rejects ${shape}`, 'invalid', () =>
    db.updateMyProfile(SETTINGS_ACTOR, { full_name: value }),
  );
}
const renamed = await allows(
  'the actor may rename THEMSELVES',
  () => db.updateMyProfile(SETTINGS_ACTOR, { full_name: '  Samantha Setting  ' }),
  (p) => p.full_name,
);
expectEqual('...and the name is trimmed', renamed?.full_name, 'Samantha Setting');
expectShape('...returning the full profile row', renamed, PROFILE_COLUMNS);
// A LEARNER, not a coach. Renaming must not be a privilege path — the guard in
// SQL leaves `full_name` alone precisely because it carries none, so the
// method itself must not carry one either.
expectEqual('...still a learner', renamed?.role, 'learner');
expectEqual('...with no coach status', renamed?.coach_status, 'none');
// THE CONTROL. If the subject were a parameter rather than the resolved actor,
// this is what would have changed.
expectEqual(
  'nobody else was renamed',
  (await db.getProfile(ADMIN, COACH!.userId))?.full_name,
  'Cory Vaughn',
);
// The name is published on every review its author has written, so a rename is
// a content change and must reach them.
const renamedReviews = await db.listReviewsForCoach(COACH!.userId);
expectEqual(
  'a rename is not retroactively stamped onto other people’s reviews',
  renamedReviews.some((r) => r.author_name === 'Samantha Setting'),
  false,
);

// --- changing a password ---------------------------------------------------
await refuses('an anonymous caller cannot change a password', 'unauthorized', () =>
  db.changeMyPassword(null, 'settings-first-password', 'settings-second-password'),
);
await refuses('a WRONG current password is refused', 'forbidden', () =>
  db.changeMyPassword(SETTINGS_ACTOR, 'not-the-password', 'settings-second-password'),
);
// `forbidden`, deliberately not `unauthorized`: the session is fine, the claim
// about the old password is not, and `unauthorized` would send somebody who is
// already signed in to the login page.
await refuses('an EMPTY current password is refused the same way', 'forbidden', () =>
  db.changeMyPassword(SETTINGS_ACTOR, '', 'settings-second-password'),
);
await refuses('a short NEW password is invalid', 'invalid', () =>
  db.changeMyPassword(SETTINGS_ACTOR, 'settings-first-password', 'short'),
);
// GoTrue refuses this too, so the mock must not be the more permissive of the
// two backends.
await refuses('reusing the current password is refused', 'invalid', () =>
  db.changeMyPassword(SETTINGS_ACTOR, 'settings-first-password', 'settings-first-password'),
);
expectEqual(
  'no refused attempt changed anything',
  (await db.signInWithPassword({ email: 'settings@javelin.test', password: 'settings-first-password' }))?.id,
  settingsUser!.id,
);

await allows(
  'the actor may change their OWN password',
  () => db.changeMyPassword(SETTINGS_ACTOR, 'settings-first-password', 'settings-second-password'),
  () => 'changed',
);
expectEqual(
  'the new password signs in',
  (await db.signInWithPassword({ email: 'settings@javelin.test', password: 'settings-second-password' }))?.id,
  settingsUser!.id,
);
expectEqual(
  '...and the old one no longer does',
  await db.signInWithPassword({ email: 'settings@javelin.test', password: 'settings-first-password' }),
  null,
);
// The control that matters most: a method with no subject parameter cannot
// have touched anybody else's credentials.
expectEqual(
  'no other account’s password moved',
  (await db.signInWithPassword({ email: 'coach@javelin.test', password: 'coach1234' }))?.id,
  COACH!.userId,
);

// --- changing the sign-in address -----------------------------------------
// The mock changes it immediately (no mail to confirm), so what is asserted is
// the pair of writes: the CREDENTIAL row that signInWithPassword matches on,
// and the profile COPY. In Postgres those are two statements in two places —
// GoTrue writes one, the 0017 trigger writes the other — and writing only one
// leaves either an account that cannot sign in or a profile naming an address
// nobody can reach.

await refuses('an anonymous caller cannot change an address', 'unauthorized', () =>
  db.requestEmailChange(null, 'nobody@javelin.test'),
);
for (const [shape, value] of [
  ['an empty address', '   '],
  ['a string with no @', 'not-an-address'],
] as Array<[string, string]>) {
  await refuses(`requestEmailChange rejects ${shape}`, 'invalid', () =>
    db.requestEmailChange(SETTINGS_ACTOR, value),
  );
}
await refuses('...and the address it already has', 'invalid', () =>
  db.requestEmailChange(SETTINGS_ACTOR, 'settings@javelin.test'),
);
// Mirrors the unique constraint on `auth.users.email`, checked against the
// CREDENTIAL table — `profiles.email` deliberately carries no unique
// constraint, the same reasoning `signUp` uses.
await refuses('...and one another account already holds', 'conflict', () =>
  db.requestEmailChange(SETTINGS_ACTOR, 'coach@javelin.test'),
);

const changedEmail = await allows(
  'the actor may change their OWN address',
  () => db.requestEmailChange(SETTINGS_ACTOR, '  Settings.New@Javelin.TEST  '),
  (r) => r.status,
);
expectEqual('...reporting the mock arm, because there is no mail to confirm', changedEmail?.status, 'changed');
// Normalised the way every other address in this app is: `requireEmail` trims
// and lowercases, so a user who capitalises their own address is not locked out
// by it.
expectEqual(
  '...with the address normalised',
  changedEmail?.status === 'changed' ? changedEmail.profile.email : null,
  'settings.new@javelin.test',
);

// BOTH WRITES, asserted separately. The profile copy:
expectEqual(
  'the profile copy moved',
  (await db.getProfile(SETTINGS_ACTOR, settingsUser!.id))?.email,
  'settings.new@javelin.test',
);
// And the credential, which is the one that decides whether they can get back in:
expectEqual(
  'the new address signs in',
  (await db.signInWithPassword({ email: 'settings.new@javelin.test', password: 'settings-second-password' }))?.id,
  settingsUser!.id,
);
expectEqual(
  '...and the old one no longer does',
  await db.signInWithPassword({ email: 'settings@javelin.test', password: 'settings-second-password' }),
  null,
);
// The control: nobody else's address moved, which is what a subject parameter
// would have made possible.
expectEqual(
  'no other account’s address moved',
  (await db.getProfile(ADMIN, COACH!.userId))?.email,
  'coach@javelin.test',
);

// --- the avatar is EVERYONE's, which is why it moved to /settings ----------
// `setMyAvatar` was always open to any signed-in user and only the UI was
// coach-facing. Asserted for a plain learner, since that is the case the old
// placement made unreachable.
const learnerAvatar = await allows(
  'a LEARNER may set a picture, not only a coach',
  () => db.setMyAvatar(SETTINGS_ACTOR, `${settingsUser!.id}/portrait.png`),
  (p) => String(p.avatar_path),
);
expectEqual('...stored under their own id', learnerAvatar?.avatar_path, `${settingsUser!.id}/portrait.png`);
await refuses("...but never under somebody else's", 'forbidden', () =>
  db.setMyAvatar(SETTINGS_ACTOR, `${COACH!.userId}/portrait.png`),
);

// ---------------------------------------------------------------------------
section('Deleting an account — anonymise, and close every door');
// ---------------------------------------------------------------------------
// The row SURVIVES, anonymised, because orders and reviews point at it: erasing
// it would reduce some coach's sales count and rating as a side effect of
// somebody else leaving. What is asserted is that the personal data goes, that
// the account can no longer act, and that nobody else's numbers moved.

// A coach with a published offer, so the "withdraw first" invariant has
// something to bite on.
const doomedCoach = await allows(
  'a fixture coach for the deletion section',
  () => signUpProfile({ email: 'doomed@javelin.test', password: 'doomed-password-1', fullName: 'Dara Doomed' }),
  (p) => p.id,
);
const DOOMED: Actor = { userId: doomedCoach!.id };
// A FRESH code, minted here: the two seeded ones are single-use and earlier
// sections have already spent them.
const doomedInvite = await allows(
  '...given a freshly minted invite code',
  () => db.createInvite(ADMIN, { note: 'deletion fixture' }),
  (i) => i.code,
);
await allows(
  '...which promotes them',
  () => db.redeemInviteCode(DOOMED, doomedInvite!.code),
  (p) => p.coach_status,
);
const doomedOffer = await allows(
  '...who publishes an offer',
  () =>
    db.createListing(DOOMED, {
      title: 'Offer that outlives its coach',
      description: 'Published so the withdraw-before-delete invariant has something to refuse over.',
      price_cents: 4100,
      category: 'training_plan',
    }),
  (r) => r.id,
);

// --- the invariant ---------------------------------------------------------
// THE RULE THE SQL FUNCTION ENFORCES BECAUSE IT CANNOT DO THE WORK ITSELF:
// `guard_listing_update()` calls `auth.uid()`, which the privileged role owning
// `delete_my_account()` cannot reach. So the refusal is what makes "deleted the
// account, left the offers selling" unreachable however a caller sequences
// their requests — and the mock refuses identically rather than helpfully
// withdrawing, because a rule enforced differently is a rule that will diverge.
await refuses('an account with an offer still on sale cannot be deleted', 'invalid', () =>
  db.deleteMyAccount(DOOMED),
);
expectEqual(
  '...and nothing was anonymised by the attempt',
  (await db.getProfile(DOOMED, doomedCoach!.id))?.full_name,
  'Dara Doomed',
);

await allows('withdrawing the offer first', () => db.softDeleteListing(DOOMED, doomedOffer!.id), (r) => r.title);

// --- administrators cannot ------------------------------------------------
// `invites.created_by` is ON DELETE RESTRICT because an invite records who
// granted somebody coach status, and that record outlives its author. Checked
// on the ROLE rather than on holding invites, so the rule is predictable.
await refuses('an administrator cannot delete themselves', 'forbidden', () =>
  db.deleteMyAccount(ADMIN),
);
expectEqual(
  '...and is still an administrator afterwards',
  (await db.getProfile(ADMIN, ADMIN!.userId))?.role,
  'admin',
);

// --- the deletion ----------------------------------------------------------
const coachStatsBefore = await db.getCoachStats(COACH!.userId);
await allows('the account deletes itself', () => db.deleteMyAccount(DOOMED), () => 'deleted');

// EVERY ACTOR-TAKING METHOD IS NOW CLOSED, through one line in resolveProfile.
// Three different shapes of call, so this is about the resolver rather than
// about one method remembering.
await refuses('a deleted account cannot read its own profile', 'unauthorized', () =>
  db.getProfile(DOOMED, doomedCoach!.id),
);
await refuses('...nor publish', 'unauthorized', () =>
  db.createListing(DOOMED, {
    title: 'Published from beyond',
    description: 'Should never reach the store, because the actor no longer resolves.',
    price_cents: 1000,
    category: 'other',
  }),
);
await refuses('...nor rename itself back', 'unauthorized', () =>
  db.updateMyProfile(DOOMED, { full_name: 'Dara Doomed' }),
);
// And the credential is dead on the mock too — not because anything touched
// `auth_users`, but because a session for a deleted profile resolves to nobody.
/*
 * THE CREDENTIAL IS DEAD TOO, and this assertion is why it is: it failed first.
 *
 * `deleteMyAccount` anonymises `profiles.email` and deliberately leaves
 * `auth_users.email` alone — mirroring Supabase, where the RPC cannot reach
 * `auth.users` at all. So the OLD address and the OLD password still MATCH, and
 * without an explicit refusal the login succeeded: a session was issued, and
 * every call after it was refused by `resolveProfile`. A login that works
 * followed by an app that does not.
 *
 * `null`, indistinguishable from a wrong password, so the form does not become
 * an oracle for which accounts have been deleted.
 */
expectEqual(
  'the old password still matches, and buys nothing',
  await db.signInWithPassword({ email: 'doomed@javelin.test', password: 'doomed-password-1' }),
  null,
);
// The control: the same call for a LIVE account still works, so the refusal
// above is about deletion rather than about sign-in being broken.
expectEqual(
  'control: a live account still signs in',
  (await db.signInWithPassword({ email: 'coach@javelin.test', password: 'coach1234' }))?.id,
  COACH!.userId,
);

// --- what the row looks like afterwards ------------------------------------
const anonymised = await mutateDb((store) => {
  const row = store.profiles.find((p) => p.id === doomedCoach!.id);
  return row ? { ...row } : null;
});
expectEqual('the name is gone', anonymised?.full_name, 'Deleted account');
// `.invalid` is reserved by RFC 2606 and can never route anywhere.
expectEqual('the address is an unroutable tombstone', anonymised?.email, `deleted+${doomedCoach!.id}@javelinhub.invalid`);
expectEqual('...and is unique per account, so signUp can still check duplicates',
  anonymised?.email.includes(doomedCoach!.id), true);
expectEqual('the picture is cleared', anonymised?.avatar_path, null);
expectEqual('the coach columns are cleared', anonymised?.coach_bio, null);
// A departed coach stops being one, which is what removes them from the
// directory: every coach read filters on `approved`, so no extra predicate is
// needed anywhere.
expectEqual('they are no longer an approved coach', anonymised?.coach_status, 'none');
expectEqual('...nor a coach at all', anonymised?.role, 'learner');
expectEqual('and the row is marked deleted', typeof anonymised?.deleted_at, 'string');
expectEqual(
  'the departed coach is out of the directory',
  (await db.listCoaches()).some((c) => c.id === doomedCoach!.id),
  false,
);

// --- nobody else moved -----------------------------------------------------
// THE ASSERTION THE WHOLE DESIGN EXISTS FOR. Erasing the row would have taken
// this person's orders and reviews with it, changing a coach's public numbers
// because somebody else left.
const coachStatsAfter = await db.getCoachStats(COACH!.userId);
expectEqual('another coach’s sales are untouched', coachStatsAfter.sales_count, coachStatsBefore.sales_count);
expectEqual('...and their review count', coachStatsAfter.review_count, coachStatsBefore.review_count);
expectEqual('...and their rating', coachStatsAfter.rating_average, coachStatsBefore.rating_average);

// --- idempotent ------------------------------------------------------------
// A retry after the ban step failed must not look like a new failure to
// somebody who is trying to leave. It cannot go through `deleteMyAccount`'s own
// actor resolution either, which is why that method deliberately does not call
// `resolveProfile`.
await allows('deleting twice is a no-op, not an error', () => db.deleteMyAccount(DOOMED), () => 'no-op');

// ---------------------------------------------------------------------------
section('Review moderation — admin only, and the row really goes');
// ---------------------------------------------------------------------------
// A purpose-built fixture rather than a seeded review, so the aggregates are
// known exactly: ONE offer, ONE sale, ONE review, at price epoch 1. Removing a
// seeded review would work, but the offer rollup filters on the current epoch
// and several seeded reviews sit at an older one — so a delta of zero would be
// correct and would prove nothing.

const modOffer = await allows(
  'a fixture offer for the moderation section',
  () =>
    db.createListing(COACH, {
      title: 'Moderation fixture offer',
      description: 'Published so a review can be written about it and then taken down again.',
      price_cents: 3300,
      category: 'training_plan',
    }),
  (r) => r.id,
);
await allows('...claimed by a learner', () => db.createOrder(AISHA, modOffer!.id), (o) => o.id);
const modOrder = (await db.listMyOrders(AISHA)).find((o) => o.listing_id === modOffer!.id);
const modReview = await allows(
  '...and reviewed',
  () => db.createReview(AISHA, { order_id: modOrder!.id, rating: 2, body: 'A review written to be removed.' }),
  (r) => `${r.rating}★ ${r.id}`,
);

// --- who may look ----------------------------------------------------------
for (const [who, actor] of [
  ['an anonymous caller', null],
  ['a learner', MARCUS],
  ['an approved coach', COACH],
  ['another coach', NILS],
] as Array<[string, Actor]>) {
  await refuses(`${who} cannot read the moderation queue`, actor === null ? 'unauthorized' : 'forbidden', () =>
    db.listReviewsForModeration(actor),
  );
  await refuses(`${who} cannot read the removal log`, actor === null ? 'unauthorized' : 'forbidden', () =>
    db.listRemovedReviews(actor),
  );
  await refuses(`${who} cannot remove a review`, actor === null ? 'unauthorized' : 'forbidden', () =>
    db.removeReview(actor, modReview!.id),
  );
}
// THE CONTROL for all of that: the coach who was refused above owns the offer
// this review is about, and is still refused. Moderation is not an owner power.
expectEqual('...and the refused coach really does own the offer', modOffer?.coach_id, COACH!.userId);
expectEqual(
  'no refused removal reached the store',
  (await db.listReviewsForListing(modOffer!.id)).length,
  1,
);

// --- the admin's view ------------------------------------------------------
const modQueue = await allows(
  'an ADMIN can read the queue',
  () => db.listReviewsForModeration(ADMIN),
  (rows) => `${rows.length} review(s)`,
);
const queued = modQueue?.find((row) => row.id === modReview!.id);
expectEqual('...and the new review is in it', Boolean(queued), true);
// The opposite projection to PublicReview, which is the point of the shape:
// a moderator needs the author and the purchase, a visitor must have neither.
expectShape('...with the full row plus the two joined names', queued, MODERATABLE_REVIEW_COLUMNS);
expectEqual('...naming the author', queued?.author_name, 'Aisha Bello');
expectEqual('...and the offer', queued?.listing_title, 'Moderation fixture offer');

// --- the numbers before ----------------------------------------------------
const statsBefore = await db.getOfferStats(modOffer!.id);
expectEqual('the offer counts the review before removal', statsBefore?.review_count, 1);
expectEqual('...at the rating that was written', statsBefore?.rating_average, 2);
expectEqual('...and counts the sale', statsBefore?.sales_count, 1);
const modCoachBefore = await db.getCoachStats(COACH!.userId);

// --- removal ---------------------------------------------------------------
await allows(
  'an ADMIN removes it',
  () => db.removeReview(ADMIN, modReview!.id, '  Fixture removal, with a reason.  '),
  () => 'removed',
);

// THE ASSERTION THIS DESIGN EXISTS FOR. The row is deleted rather than flagged,
// so every aggregate is correct with no filter anywhere. A soft delete would
// need one in five separate views, and the failure mode of forgetting one is a
// removed review still counting towards a rating, invisibly.
const statsAfter = await db.getOfferStats(modOffer!.id);
expectEqual('the offer no longer counts it', statsAfter?.review_count, 0);
// `null`, not 0 — "unrated" and "rated zero" must never be confusable.
expectEqual('...and reads as unrated rather than as zero', statsAfter?.rating_average, null);
// THE SALE SURVIVES. Removing a review must not un-sell anything: the order is
// a separate row and the money (one day) was real.
expectEqual('...while the sale is untouched', statsAfter?.sales_count, 1);
const modCoachAfter = await db.getCoachStats(COACH!.userId);
expectEqual(
  'the coach account rating drops the review too',
  modCoachBefore.review_count - modCoachAfter.review_count,
  1,
);
expectEqual('...and keeps the sale', modCoachAfter.sales_count, modCoachBefore.sales_count);

// Gone from every public read, not merely from the rollup.
expectEqual('the review is gone from the offer page read', (await db.listReviewsForListing(modOffer!.id)).length, 0);
expectEqual(
  '...and from the coach profile read',
  (await db.listReviewsForCoach(COACH!.userId)).some((r) => r.body === 'A review written to be removed.'),
  false,
);
expectEqual(
  '...and from the moderation queue itself',
  (await db.listReviewsForModeration(ADMIN)).some((r) => r.id === modReview!.id),
  false,
);

// --- the archive -----------------------------------------------------------
const log = await allows(
  'the removal is in the log',
  () => db.listRemovedReviews(ADMIN),
  (rows) => `${rows.length} entr(y|ies)`,
);
const logged = log?.find((row) => row.review_id === modReview!.id);
expectEqual('...as an entry naming the deleted review', Boolean(logged), true);
expectShape('...with the archived shape', logged, REMOVED_REVIEW_COLUMNS);
// The evidence: the whole review, verbatim, so somebody can be shown what was
// taken down.
expectEqual('...carrying the body verbatim', logged?.body, 'A review written to be removed.');
expectEqual('...and the rating', logged?.rating, 2);
expectEqual('...and who removed it', logged?.removed_by, ADMIN!.userId);
// Trimmed, and `null` when blank — "no reason given" is a different fact from
// "the reason is an empty string".
expectEqual('...and the reason, trimmed', logged?.reason, 'Fixture removal, with a reason.');
expectEqual('...and when the review was WRITTEN, not when it went', logged?.review_created_at, modReview?.created_at);

// --- removing it again -----------------------------------------------------
await refuses('the same review cannot be removed twice', 'not_found', () =>
  db.removeReview(ADMIN, modReview!.id),
);
await refuses('an unknown id is not_found', 'not_found', () =>
  db.removeReview(ADMIN, '00000000-0000-4000-8000-0000000000ff'),
);
expectEqual('...and neither attempt added a second log entry', log?.length, (await db.listRemovedReviews(ADMIN)).length);

// A removal with no reason records null rather than an empty string.
const secondOrder = await allows(
  'a second reviewable purchase',
  async () => {
    await db.createOrder(MARCUS, modOffer!.id);
    const order = (await db.listMyOrders(MARCUS)).find((o) => o.listing_id === modOffer!.id);
    return db.createReview(MARCUS, { order_id: order!.id, rating: 5, body: 'Removed with no reason given.' });
  },
  (r) => r.id,
);
await allows('...removed with a blank reason', () => db.removeReview(ADMIN, secondOrder!.id, '   '), () => 'removed');
const blank = (await db.listRemovedReviews(ADMIN)).find((row) => row.review_id === secondOrder!.id);
expectEqual('a whitespace-only reason is stored as null', blank?.reason, null);

// ---------------------------------------------------------------------------
section('Rate limiting — a speed bump that has to count correctly');
// ---------------------------------------------------------------------------
// The mock twin of `consume_rate_limit()` (0013). What is asserted is the
// arithmetic, because that is what both implementations have to agree on: the
// Nth call is the last one admitted, the (N+1)th is not, an exhausted bucket
// STAYS exhausted while it is being hammered, an expired window restarts, and
// two keys never share a budget.
//
// What is NOT asserted here is the fail-open behaviour, which is deliberate and
// documented rather than tested: forcing the store to error would mean breaking
// it, and the branch is two lines around a `catch`.

// Distinct keys per assertion, since `consume` is stateful by construction and
// a shared key would make every assertion depend on the order of the ones above.
const RL_KEY = (name: string) => `verify-authz-${name}-${Math.random().toString(36).slice(2)}`;

// --- the boundary ----------------------------------------------------------
// `signupIp` is 5 an hour. The fifth call is admitted and the sixth is not —
// asserted at BOTH ends, because a limiter that is off by one in the permissive
// direction looks identical to a correct one until it matters.
const boundaryKey = RL_KEY('boundary');
const signupLimit = LIMITS.signupIp.limit;
let lastAdmitted = true;
for (let attempt = 1; attempt <= signupLimit; attempt += 1) {
  lastAdmitted = await consume('signupIp', boundaryKey);
}
expectEqual(`the ${signupLimit}th attempt is still admitted`, lastAdmitted, true);
expectEqual('...and the next one is refused', await consume('signupIp', boundaryKey), false);

// --- hammering keeps it exhausted ------------------------------------------
// The attempt is counted whether or not it was admitted, so a caller who keeps
// going does not wait out a window they are still filling.
for (let attempt = 0; attempt < 20; attempt += 1) await consume('signupIp', boundaryKey);
expectEqual('an exhausted bucket stays exhausted while it is hammered', await consume('signupIp', boundaryKey), false);

// --- keys are independent --------------------------------------------------
// The control for every assertion above: if buckets collided, exhausting one
// would exhaust all of them and the whole section would still pass.
expectEqual('a DIFFERENT key has its own budget', await consume('signupIp', RL_KEY('other')), true);
// And so does a different LIMIT with the same key — the bucket is derived from
// both, so `resetIp:x` and `signupIp:x` are not one counter.
expectEqual('...and so does a different limit with the same key', await consume('resetIp', boundaryKey), true);

// --- the window restarts ---------------------------------------------------
// Aged by moving `window_started_at` into the past rather than by waiting an
// hour. The check reads the stored timestamp, so this is the same code path a
// genuinely old row takes.
const windowKey = RL_KEY('window');
for (let attempt = 0; attempt < signupLimit + 3; attempt += 1) await consume('signupIp', windowKey);
expectEqual('the aged bucket is exhausted to begin with', await consume('signupIp', windowKey), false);
// EVERY row is aged, not the one this key owns. The bucket is an HMAC and
// cannot be recomputed here without reaching into the secret — which is the
// property the section below asserts, so working around it would be
// self-defeating. Ageing all of them is unambiguous, and nothing asserted after
// this point depends on an un-aged row: the control below is built fresh.
const agedRows = await mutateDb((store) => {
  const stale = new Date(Date.now() - (LIMITS.signupIp.windowSeconds + 60) * 1000).toISOString();
  for (const row of store.rate_limits) row.window_started_at = stale;
  return store.rate_limits.length;
});
expectEqual('the fixture aged every row', agedRows > 0, true);
expectEqual('...and an expired window admits again', await consume('signupIp', windowKey), true);
// RESTARTED, not trimmed: the fresh window starts at 1, so the full budget is
// available again rather than one slot.
expectEqual('...with a full budget, not a single slot', await consume('signupIp', windowKey), true);
// THE CONTROL, and it is what stops the two assertions above passing for a
// limiter that simply forgot everything: a bucket exhausted AFTER the ageing is
// still refused, so it is the elapsed window doing the work rather than the
// mutation.
const controlKey = RL_KEY('control');
for (let attempt = 0; attempt <= signupLimit; attempt += 1) await consume('signupIp', controlKey);
expectEqual('a bucket exhausted after the ageing is still refused', await consume('signupIp', controlKey), false);

// --- the stored bucket is not the key --------------------------------------
// The property the SQL side needs: `anon` can call `consume_rate_limit()` with
// any bucket, so a guessable one would let anybody burn a victim's password
// reset budget. Asserted against the STORE, which is what a leak would expose.
const plainKey = RL_KEY('plaintext');
await consume('resetEmail', plainKey);
const storedBuckets = await mutateDb((store) => store.rate_limits.map((r) => r.bucket));
expectEqual(
  'no stored bucket contains the key in the clear',
  storedBuckets.some((b) => b.includes(plainKey)),
  false,
);
expectEqual(
  '...and they are all fixed-width hex, as an HMAC is',
  storedBuckets.every((b) => /^[0-9a-f]{64}$/.test(b)),
  true,
);

// ---------------------------------------------------------------------------
section('signUp reports TWO successes, not a success and a failure');
// ---------------------------------------------------------------------------
// The union exists because Supabase with email confirmation on returns no
// session from a successful signup. The mock has no mail and must therefore
// always sign the user in — asserted here explicitly as well as on all 21
// fixture calls through `signUpProfile`, because "it has never returned
// anything else" is a property of the fixtures rather than of the method.

const signUpShape = await allows(
  'the mock signs a new account in immediately',
  () => db.signUp({ email: 'union-probe@javelin.test', password: 'union-probe-password', fullName: 'Uma Union' }),
  (r) => r.status,
);
expectEqual('...reporting the signed_in arm', signUpShape?.status, 'signed_in');
expectShape('...which carries exactly a status and a profile', signUpShape, ['status', 'profile']);
expectEqual(
  '...whose profile is the new learner',
  signUpShape?.status === 'signed_in' ? signUpShape.profile.full_name : null,
  'Uma Union',
);
// The discriminator is load-bearing: a caller that reads `.profile` without
// checking `.status` is the bug this union exists to make impossible, and it
// would not compile.
expectEqual(
  '...and a learner, never a coach — signup cannot mint privilege',
  signUpShape?.status === 'signed_in' ? signUpShape.profile.role : null,
  'learner',
);
// A duplicate is still a conflict, and still a THROW rather than a third arm:
// it is a failure, not an outcome.
await refuses('a duplicate address is still a conflict', 'conflict', () =>
  db.signUp({ email: 'union-probe@javelin.test', password: 'another-password', fullName: 'Ursula Union' }),
);

// ---------------------------------------------------------------------------
section('Error reporting — one line, and nothing sensitive in it');
// ---------------------------------------------------------------------------
// `reportError` is the seam a provider plugs into later. What is asserted here
// is the contract every call site depends on: one JSON line per report, the
// expected errors dropped, and no credential or address in the payload.
//
// WHAT IS NOT ASSERTED, stated rather than left to be assumed: the binding in
// `src/instrumentation.ts`. `onRequestError` is called by the Next runtime,
// which is not running here, so its wiring is covered by the type signature and
// the build and by nothing else.

const { reportError } = await import('@/lib/observability');

/** Captures whatever `reportError` writes, without letting it reach the run's output. */
function captureReport(fn: () => void): string[] {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const reported = captureReport(() => {
  reportError(new TypeError('a genuine bug'), {
    source: 'request',
    route: '/orders/[id]',
    kind: 'render',
    digest: '1234567890',
  });
});
expectEqual('an unexpected error produces exactly one line', reported.length, 1);
const payload = JSON.parse(reported[0] ?? '{}') as Record<string, unknown>;
expectEqual('...which is valid JSON', typeof payload, 'object');
expectEqual('...naming the error CLASS, which is what groups incidents', payload.name, 'TypeError');
expectEqual('...and the message', payload.message, 'a genuine bug');
expectEqual('...and the route FILE, not one visitor’s URL', payload.route, '/orders/[id]');
expectEqual('...and the digest the user is shown', payload.digest, '1234567890');
expectEqual('...with a stack, which is the point of the exercise', typeof payload.stack, 'string');

// THE FILTER. A `DataError` is the app refusing something on purpose — a
// `forbidden` means the policies worked — and reporting those would bury real
// failures under a stream of correct behaviour.
for (const [shape, value] of [
  ['a DataError', new DataError('forbidden', 'You cannot do that.')],
  ['a redirect', Object.assign(new Error('x'), { digest: 'NEXT_REDIRECT;replace;/login;307;' })],
  ['a not-found', Object.assign(new Error('x'), { digest: 'NEXT_NOT_FOUND' })],
] as Array<[string, unknown]>) {
  expectEqual(
    `${shape} is not reported at all`,
    captureReport(() => reportError(value, { source: 'request' })).length,
    0,
  );
}

// THE REDACTION. The query string is where `?next=` and `?q=` live, which is
// whatever a visitor typed.
const stripped = captureReport(() => {
  reportError(new Error('boom'), { source: 'request', route: '/login?next=%2Fsecret&q=alice%40example.com' });
});
const strippedPayload = JSON.parse(stripped[0] ?? '{}') as Record<string, unknown>;
expectEqual('a query string is stripped from the route', strippedPayload.route, '/login');
expectEqual(
  '...so nothing a visitor typed reaches the log',
  stripped[0]?.includes('alice%40example.com'),
  false,
);

// A circular value in `extra` must not throw inside the reporter — a reporter
// that can fail the request it is reporting on is worse than no reporter.
const circular: Record<string, unknown> = {};
circular.self = circular;
const survived = captureReport(() => {
  reportError(new Error('boom'), {
    source: 'background',
    extra: circular as unknown as Record<string, string>,
  });
});
expectEqual('an unserialisable payload still produces one line', survived.length, 1);
expectEqual('...and does not throw', true, true);

// ---------------------------------------------------------------------------
section('Store invariants');
// ---------------------------------------------------------------------------
const admins = await mutateDb((store) => store.profiles.filter((p) => p.role === 'admin').length);
expectEqual('the store still has at least one admin', admins >= 1, true);
note(`${admins} admin(s) remain`);

// ---------------------------------------------------------------------------
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
rmSync(scratch, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
