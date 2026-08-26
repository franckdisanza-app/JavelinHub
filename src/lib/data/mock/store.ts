/**
 * JSON-file store backing the mock `DataClient`.
 *
 * Responsibilities, and nothing else:
 *   * load/save a single JSON document at `MOCK_DB_PATH`
 *   * seed it, idempotently, on first creation
 *   * serialise every read-modify-write through an in-process mutex
 *   * hash and verify passwords with `node:crypto` (no external dependencies)
 *
 * It contains NO authorization logic. Authorization lives entirely in
 * `mockClient.ts`, which is the analogue of the RLS policy set — keeping the
 * two apart means the "database" is as dumb about permissions as Postgres is
 * without policies, and there is exactly one place to audit.
 *
 * SERVER ONLY. Importing this from a client component is a bug; the guard below
 * turns it into a loud one.
 */

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { mockDbPath, seedAdminEmail, seedAdminPassword } from '@/lib/env';
import type {
  CoachApplication,
  Invite,
  Listing,
  ListingCategory,
  ListingRevision,
  Order,
  Profile,
  Review,
} from '../types';

// ---------------------------------------------------------------------------
// Server-only guard
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  throw new Error(
    'The mock data store is server-only and was imported into browser code. ' +
      'Call it from a server component, server action or route handler instead.',
  );
}

// ---------------------------------------------------------------------------
// Shape of the JSON document
// ---------------------------------------------------------------------------

/**
 * Mirrors Supabase's `auth.users`. Kept in a separate collection from
 * `profiles` for the same reason Supabase does: the credential material must
 * never be reachable from anything that reads profile data.
 */
export interface AuthUser {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  created_at: string;
}

export interface MockDb {
  /** Bumped when the on-disk shape changes; a mismatch triggers a reseed. */
  version: number;
  auth_users: AuthUser[];
  profiles: Profile[];
  coach_applications: CoachApplication[];
  invites: Invite[];
  listings: Listing[];
  /** Append-only. Nothing in the data layer updates or removes a row here. */
  listing_revisions: ListingRevision[];
  orders: Order[];
  reviews: Review[];
}

const DB_VERSION = 1;

function emptyDb(): MockDb {
  return {
    version: DB_VERSION,
    auth_users: [],
    profiles: [],
    coach_applications: [],
    invites: [],
    listings: [],
    listing_revisions: [],
    orders: [],
    reviews: [],
  };
}

// ---------------------------------------------------------------------------
// Small helpers shared with mockClient
// ---------------------------------------------------------------------------

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Passwords — scrypt with a per-user random salt, constant-time comparison.
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(hash, 'hex');
    actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which would itself leak a bit
  // of information; hash both sides to a fixed width first so the comparison is
  // always over equal-length buffers.
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(actual).digest();
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Seed fixtures
//
// Ids are fixed (not random) so that supabase/seed.sql can mirror this file
// row-for-row. Demo passwords for the non-admin accounts are literals and are
// documented as public fixtures in README.md; the admin password comes from
// SEED_ADMIN_PASSWORD and has no default.
// ---------------------------------------------------------------------------

export const SEED_IDS = {
  admin: '00000000-0000-4000-8000-000000000001',
  coach: '00000000-0000-4000-8000-000000000002',
  learner: '00000000-0000-4000-8000-000000000003',
  /**
   * A second approved coach who has published NOTHING: no offers, no sales, no
   * reviews. Deliberate, and asserted in verify-authz.mts — every "new coach"
   * empty state in the UI needs a real coach to render for, and inventing one
   * at render time is how empty states end up untested.
   */
  emptyCoach: '00000000-0000-4000-8000-000000000004',
} as const;

export const SEED_DEMO_ACCOUNTS = [
  { id: SEED_IDS.coach, email: 'coach@javelin.test', password: 'coach1234', fullName: 'Cory Vaughn' },
  { id: SEED_IDS.learner, email: 'learner@javelin.test', password: 'learner1234', fullName: 'Lena Park' },
  { id: SEED_IDS.emptyCoach, email: 'newcoach@javelin.test', password: 'coach1234', fullName: 'Nils Berg' },
] as const;

/**
 * Extra learner accounts, so the fabricated reviews are written by plausibly
 * different people rather than one account four times over.
 *
 * They share the public demo password documented in README.md; none of them is
 * privileged in any way. Ids are fixed so supabase/seed.sql mirrors them.
 */
export const SEED_REVIEW_AUTHORS = [
  { id: '00000000-0000-4000-8000-000000000011', email: 'marcus@javelin.test', fullName: 'Marcus Feld' },
  { id: '00000000-0000-4000-8000-000000000012', email: 'priya@javelin.test', fullName: 'Priya Raman' },
  { id: '00000000-0000-4000-8000-000000000013', email: 'tomas@javelin.test', fullName: 'Tomas Lindqvist' },
  { id: '00000000-0000-4000-8000-000000000014', email: 'aisha@javelin.test', fullName: 'Aisha Bello' },
] as const;

const SEED_AUTHOR_PASSWORD = 'learner1234';

/**
 * Categories are taxonomy SLUGS (`ListingCategory`), mirrored verbatim in
 * supabase/seed.sql. Three of the eight — `recovery_plan`, `nutrition_plan` and
 * `other` — are deliberately left with no listing: the browse filter offers all
 * eight regardless of inventory, so an empty one is what exercises that empty
 * state. Do not "fix" it by inventing a fixture; verify-authz.mts asserts
 * exactly which three are empty.
 *
 * `category` is pinned to the strict `ListingCategory` rather than inherited
 * from `Listing`, whose read type is deliberately wider to admit pre-taxonomy
 * free text. Seeds are writes, so a typo here must still be a compile error.
 */
const SEED_LISTINGS: ReadonlyArray<
  Pick<Listing, 'id' | 'title' | 'description' | 'price_cents' | 'price_epoch'> & { category: ListingCategory }
> = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    title: 'Javelin Throw Fundamentals',
    description:
      'A four-session introduction to the javelin: grip, carry, withdrawal and a safe, repeatable delivery. Built for athletes in their first or second season.',
    price_cents: 4500,
    category: 'training_plan',
    price_epoch: 1,
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    title: 'Approach Run & Crossover Clinic',
    description:
      'We rebuild your run-up from the check mark forward. Rhythm, crossover mechanics and hitting the block without losing speed.',
    price_cents: 7500,
    category: 'training_plan',
    price_epoch: 1,
  },
  {
    id: '00000000-0000-4000-8000-000000000103',
    title: 'Strength Programming for Throwers',
    description:
      'A twelve-week block periodised programme balancing heavy pulls, med-ball throws and elastic work, written around your competition calendar.',
    price_cents: 9900,
    category: 'weightlifting_plan',
    // The one seeded offer whose price has already gone up (8500 -> 9900). Its
    // epoch-1 sales and reviews are seeded too, so the OFFER reads as almost
    // new while the coach's ACCOUNT-level totals still carry the whole history.
    // That asymmetry is otherwise impossible to see in the UI or to assert on.
    price_epoch: 2,
  },
  {
    id: '00000000-0000-4000-8000-000000000104',
    title: 'Video Analysis: Send Me Your Throw',
    description:
      'Upload three throws from any angle and receive a frame-by-frame breakdown with two concrete cues to work on before your next session.',
    price_cents: 3500,
    category: 'video_review',
    price_epoch: 1,
  },
  {
    id: '00000000-0000-4000-8000-000000000105',
    title: 'Shoulder Care & Mobility for Throwers',
    description:
      'Thoracic rotation, cuff resilience and elbow-sparing warmups. The routine I give every athlete who arrives with a sore throwing arm.',
    price_cents: 2900,
    category: 'mobility_plan',
    price_epoch: 1,
  },
  {
    id: '00000000-0000-4000-8000-000000000106',
    title: 'Competition Day Mental Prep',
    description:
      'Six attempts, one shot at a personal best. Routine building, arousal control and what to do after a foul.',
    price_cents: 5500,
    category: 'mental_training',
    price_epoch: 1,
  },
];

const SEED_INVITES: ReadonlyArray<{ code: string; note: string }> = [
  { code: 'JAVELIN-COACH-2026', note: 'Founding coach cohort' },
  { code: 'THROWERS-WELCOME', note: 'Conference outreach' },
];

// ---------------------------------------------------------------------------
// Fabricated purchases and reviews.
//
// EVERY ROW BELOW IS INVENTED. Nobody bought anything and nobody wrote any of
// this. The app discloses that where the numbers are rendered; this comment is
// the same statement at the source. Do not let these leak into anything that
// implies real transactions.
//
// The shape of the fixture set is chosen to give the UI real states to build
// against, including the empty ones — which is why some rows are conspicuously
// missing:
//
//   …0101  3 sales, 3 reviews (5,4,5)          -> a well-reviewed offer
//   …0102  2 sales, 1 review  (4)              -> one buyer has NOT reviewed,
//                                                 so createReview is reachable
//                                                 from a seeded demo login
//   …0103  3 sales, 3 reviews across TWO epochs-> epoch asymmetry, see below
//   …0104  1 sale,  1 review  (5)
//   …0105  1 sale,  0 reviews                  -> sold, but unrated
//   …0106  0 sales, 0 reviews                  -> completely new offer
//   Nils Berg (…0004) has none of any of it    -> completely new coach
//
// `days_ago` is relative to seed time, and every timestamp is clamped so a
// purchase never predates its offer and a review never predates its purchase
// (see stampAfter). Ordering, not the absolute dates, is what matters.
// ---------------------------------------------------------------------------

const SEED_ORDERS: ReadonlyArray<{
  id: string;
  listing_id: string;
  learner_id: string;
  price_cents_at_purchase: number;
  price_epoch: number;
  days_ago: number;
}> = [
  // …0101 — Javelin Throw Fundamentals (4500, epoch 1)
  { id: '00000000-0000-4000-8000-000000000201', listing_id: '00000000-0000-4000-8000-000000000101', learner_id: SEED_IDS.learner,            price_cents_at_purchase: 4500, price_epoch: 1, days_ago: 38 },
  { id: '00000000-0000-4000-8000-000000000202', listing_id: '00000000-0000-4000-8000-000000000101', learner_id: SEED_REVIEW_AUTHORS[0].id,   price_cents_at_purchase: 4500, price_epoch: 1, days_ago: 30 },
  { id: '00000000-0000-4000-8000-000000000203', listing_id: '00000000-0000-4000-8000-000000000101', learner_id: SEED_REVIEW_AUTHORS[1].id,   price_cents_at_purchase: 4500, price_epoch: 1, days_ago: 12 },
  // …0102 — Approach Run & Crossover Clinic (7500, epoch 1)
  { id: '00000000-0000-4000-8000-000000000204', listing_id: '00000000-0000-4000-8000-000000000102', learner_id: SEED_REVIEW_AUTHORS[2].id,   price_cents_at_purchase: 7500, price_epoch: 1, days_ago: 26 },
  { id: '00000000-0000-4000-8000-000000000205', listing_id: '00000000-0000-4000-8000-000000000102', learner_id: SEED_REVIEW_AUTHORS[3].id,   price_cents_at_purchase: 7500, price_epoch: 1, days_ago: 9 },
  // …0103 — Strength Programming. Two sales at the OLD price (8500, epoch 1),
  // one at the current price (9900, epoch 2). price_cents_at_purchase is a
  // snapshot: raising the price never rewrites what the first two buyers paid.
  { id: '00000000-0000-4000-8000-000000000206', listing_id: '00000000-0000-4000-8000-000000000103', learner_id: SEED_IDS.learner,            price_cents_at_purchase: 8500, price_epoch: 1, days_ago: 24 },
  { id: '00000000-0000-4000-8000-000000000207', listing_id: '00000000-0000-4000-8000-000000000103', learner_id: SEED_REVIEW_AUTHORS[0].id,   price_cents_at_purchase: 8500, price_epoch: 1, days_ago: 20 },
  { id: '00000000-0000-4000-8000-000000000208', listing_id: '00000000-0000-4000-8000-000000000103', learner_id: SEED_REVIEW_AUTHORS[1].id,   price_cents_at_purchase: 9900, price_epoch: 2, days_ago: 5 },
  // …0104 — Video Analysis (3500, epoch 1)
  { id: '00000000-0000-4000-8000-000000000209', listing_id: '00000000-0000-4000-8000-000000000104', learner_id: SEED_REVIEW_AUTHORS[2].id,   price_cents_at_purchase: 3500, price_epoch: 1, days_ago: 15 },
  // …0105 — Shoulder Care (2900, epoch 1). Sold once, never reviewed.
  { id: '00000000-0000-4000-8000-000000000210', listing_id: '00000000-0000-4000-8000-000000000105', learner_id: SEED_REVIEW_AUTHORS[3].id,   price_cents_at_purchase: 2900, price_epoch: 1, days_ago: 8 },
];

const SEED_REVIEWS: ReadonlyArray<{
  id: string;
  order_id: string;
  rating: number;
  body: string;
  days_ago: number;
}> = [
  {
    id: '00000000-0000-4000-8000-000000000301',
    order_id: '00000000-0000-4000-8000-000000000201',
    rating: 5,
    body: 'I had never held a javelin before this. Four sessions in I was throwing without pain in my elbow, which is the only thing I actually wanted.',
    days_ago: 35,
  },
  {
    id: '00000000-0000-4000-8000-000000000302',
    order_id: '00000000-0000-4000-8000-000000000202',
    rating: 4,
    body: 'Clear and well sequenced. I would have liked more on the carry, but the delivery cues alone were worth it.',
    days_ago: 27,
  },
  {
    id: '00000000-0000-4000-8000-000000000303',
    order_id: '00000000-0000-4000-8000-000000000203',
    rating: 5,
    body: 'Exactly the right amount of detail for a first season. Nothing is assumed and nothing is padded.',
    days_ago: 10,
  },
  {
    id: '00000000-0000-4000-8000-000000000304',
    order_id: '00000000-0000-4000-8000-000000000204',
    rating: 4,
    body: 'My run-up was two steps too long for three years and nobody told me. It took him one session.',
    days_ago: 22,
  },
  {
    id: '00000000-0000-4000-8000-000000000305',
    order_id: '00000000-0000-4000-8000-000000000206',
    rating: 5,
    body: 'Written around my competition calendar rather than a generic twelve weeks. The med-ball work carried straight over.',
    days_ago: 21,
  },
  {
    id: '00000000-0000-4000-8000-000000000306',
    order_id: '00000000-0000-4000-8000-000000000207',
    rating: 3,
    body: 'Solid programming, but heavier on the lifting than I expected and I had to ask twice about substitutions.',
    days_ago: 17,
  },
  {
    id: '00000000-0000-4000-8000-000000000307',
    order_id: '00000000-0000-4000-8000-000000000208',
    rating: 4,
    body: 'Bought the current version. The elastic work is new and it is the part I have felt the most.',
    days_ago: 3,
  },
  {
    id: '00000000-0000-4000-8000-000000000308',
    order_id: '00000000-0000-4000-8000-000000000209',
    rating: 5,
    body: 'Frame-by-frame notes came back in two days with two cues. I stopped trying to fix five things at once.',
    days_ago: 12,
  },
];

/**
 * The public coach copy for the ONE seeded coach who has published anything.
 *
 * Deliberately not given to Nils Berg (`…0004`), who is the seeded "approved
 * coach with nothing at all": no offers, no sales, no reviews AND no headline,
 * bio or years. Every empty state on the coach profile needs a real coach to
 * render for, and inventing one at render time is how empty states ship
 * untested. Do not "finish" his profile.
 *
 * Nor to the admin or to any learner: these columns are `null` for everyone who
 * is not an approved coach, and the `public_coaches` view never returns them
 * anyway.
 */
const SEED_COACH_PROFILE: Pick<Profile, 'coach_headline' | 'coach_bio' | 'coach_years_coaching'> = {
  coach_headline: 'Javelin technique and throws programming',
  coach_bio:
    'I threw for eleven seasons before I coached anybody, and most of what I know came from getting the run-up wrong in public. I work with club and county throwers on the three things that decide a throw: a repeatable approach, a shoulder that survives the season, and a block you can actually hit.\n\nSessions are written around your competition calendar, not around a generic twelve weeks. If something in a plan is not working, say so and we change it.',
  coach_years_coaching: 12,
};

const EMPTY_COACH_PROFILE: Pick<Profile, 'coach_headline' | 'coach_bio' | 'coach_years_coaching'> = {
  coach_headline: null,
  coach_bio: null,
  coach_years_coaching: null,
};

function upsertUser(
  db: MockDb,
  spec: {
    id: string;
    email: string;
    password: string;
    fullName: string;
    profile: Pick<Profile, 'role' | 'coach_status'> &
      Partial<Pick<Profile, 'coach_headline' | 'coach_bio' | 'coach_years_coaching'>>;
  },
): void {
  const email = normalizeEmail(spec.email);
  if (db.auth_users.some((u) => u.email === email)) return;

  const created_at = nowIso();
  const { hash, salt } = hashPassword(spec.password);
  db.auth_users.push({
    id: spec.id,
    email,
    password_hash: hash,
    password_salt: salt,
    created_at,
  });
  db.profiles.push({
    id: spec.id,
    email,
    full_name: spec.fullName,
    role: spec.profile.role,
    coach_status: spec.profile.coach_status,
    // Explicit `?? null`, not `...spec.profile`: the column must be PRESENT on
    // every seeded row, so that a store written by the seed and a store written
    // by signUp() are the same shape.
    coach_headline: spec.profile.coach_headline ?? null,
    coach_bio: spec.profile.coach_bio ?? null,
    coach_years_coaching: spec.profile.coach_years_coaching ?? null,
    created_at,
    updated_at: created_at,
  });
}

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

/**
 * A timestamp `daysAgo` before `base`, but never earlier than `floorIso` and
 * never later than `base`.
 *
 * Seeding is idempotent and runs against stores of any age, so the fixed
 * `days_ago` offsets cannot be trusted on their own: in a store whose listings
 * were created ten minutes ago, "38 days ago" would place a purchase five weeks
 * before the offer it bought. Clamping keeps the causal order — offer, then
 * purchase, then review — true in every store, and gives the nicely spread
 * timeline in a fresh one.
 */
function stampAfter(base: number, daysAgo: number, floorIso: string): string {
  const floor = new Date(floorIso).getTime();
  const target = base - daysAgo * DAY;
  return new Date(Math.min(base, Math.max(target, floor + 60_000))).toISOString();
}

/**
 * Inserts the fabricated orders and reviews, skipping any that already exist.
 *
 * Every row is keyed to a seeded listing / order, so a fixture whose anchor is
 * missing (a developer deleted the listing by hand) is skipped rather than
 * inserted with a dangling reference — the SQL side has real foreign keys and
 * the mock must not hold data Postgres would refuse.
 */
function seedOrdersAndReviews(db: MockDb, base: number): void {
  for (const order of SEED_ORDERS) {
    if (db.orders.some((o) => o.id === order.id)) continue;
    const listing = db.listings.find((l) => l.id === order.listing_id);
    if (!listing) continue;
    db.orders.push({
      id: order.id,
      learner_id: order.learner_id,
      listing_id: order.listing_id,
      // Denormalised from the listing, exactly as a real checkout would record
      // the seller at the time of sale.
      coach_id: listing.coach_id,
      price_cents_at_purchase: order.price_cents_at_purchase,
      price_epoch: order.price_epoch,
      created_at: stampAfter(base, order.days_ago, listing.created_at),
    });
  }

  for (const review of SEED_REVIEWS) {
    if (db.reviews.some((r) => r.id === review.id)) continue;
    const order = db.orders.find((o) => o.id === review.order_id);
    if (!order) continue;
    // One review per order is a UNIQUE constraint in SQL; respect it here too,
    // so a hand-written review cannot be silently duplicated by a reseed.
    if (db.reviews.some((r) => r.order_id === order.id)) continue;
    const created = stampAfter(base, review.days_ago, order.created_at);
    db.reviews.push({
      id: review.id,
      order_id: order.id,
      listing_id: order.listing_id,
      author_id: order.learner_id,
      rating: review.rating,
      body: review.body,
      // The epoch of the ORDER being reviewed — a review is feedback on the
      // version that was bought, not on whatever is on sale today. Exactly what
      // `createReview` stamps, so a seeded review and a written one are the
      // same kind of row.
      //
      // The three reviews of …0103 make this visible: two are epoch 1 and are
      // archived (the price has since risen), one is epoch 2 and is what the
      // offer page shows. All three still count toward the coach's account.
      price_epoch: order.price_epoch,
      created_at: created,
      updated_at: created,
    });
  }
}

/**
 * Brings `db` up to the seeded baseline. Safe to run against an existing store:
 * every insert is keyed on a natural identifier and skipped when present, so
 * nothing a developer created by hand is overwritten or duplicated.
 */
export function seedDatabase(db: MockDb): void {
  upsertUser(db, {
    id: SEED_IDS.admin,
    email: seedAdminEmail(),
    password: seedAdminPassword(),
    fullName: 'Ada Administrator',
    profile: { role: 'admin', coach_status: 'none' },
  });

  upsertUser(db, {
    id: SEED_DEMO_ACCOUNTS[0].id,
    email: SEED_DEMO_ACCOUNTS[0].email,
    password: SEED_DEMO_ACCOUNTS[0].password,
    fullName: SEED_DEMO_ACCOUNTS[0].fullName,
    profile: { role: 'coach', coach_status: 'approved', ...SEED_COACH_PROFILE },
  });

  upsertUser(db, {
    id: SEED_DEMO_ACCOUNTS[1].id,
    email: SEED_DEMO_ACCOUNTS[1].email,
    password: SEED_DEMO_ACCOUNTS[1].password,
    fullName: SEED_DEMO_ACCOUNTS[1].fullName,
    profile: { role: 'learner', coach_status: 'none' },
  });

  // The empty coach. Approved, and deliberately given nothing to sell AND
  // nothing to say — no headline, no bio, no years. See EMPTY_COACH_PROFILE.
  upsertUser(db, {
    id: SEED_DEMO_ACCOUNTS[2].id,
    email: SEED_DEMO_ACCOUNTS[2].email,
    password: SEED_DEMO_ACCOUNTS[2].password,
    fullName: SEED_DEMO_ACCOUNTS[2].fullName,
    profile: { role: 'coach', coach_status: 'approved', ...EMPTY_COACH_PROFILE },
  });

  for (const author of SEED_REVIEW_AUTHORS) {
    upsertUser(db, {
      id: author.id,
      email: author.email,
      password: SEED_AUTHOR_PASSWORD,
      fullName: author.fullName,
      profile: { role: 'learner', coach_status: 'none' },
    });
  }

  const base = Date.now();
  SEED_LISTINGS.forEach((listing, index) => {
    if (db.listings.some((l) => l.id === listing.id)) return;
    // Stagger a week apart so "newest first" has a stable order AND so the
    // fabricated purchases and reviews below have somewhere plausible to sit
    // between an offer's publication and today.
    const created = new Date(base - (SEED_LISTINGS.length - index) * WEEK).toISOString();
    db.listings.push({
      ...listing,
      coach_id: SEED_IDS.coach,
      // No seeded offer is withdrawn. A withdrawn fixture would change the
      // seeded listing count and every offer-level total the suite pins, for a
      // state the suite already builds at runtime through softDeleteListing().
      deleted_at: null,
      deleted_by: null,
      created_at: created,
      updated_at: created,
    });
  });

  // `price_epoch` arrived after the first stores were written. A row that
  // predates the column is at epoch 1 by definition — that is what the column
  // default means — so backfill rather than bumping DB_VERSION, which would
  // throw the developer's whole store away to add one integer.
  //
  // `deleted_at` is backfilled the same way, for the same reason: a row written
  // before soft delete existed was never withdrawn. Normalising a missing or
  // non-string value to `null` (rather than only `undefined`) also means the
  // column is present on EVERY row handed out, which the shape assertions in
  // scripts/verify-authz.mts depend on.
  for (const listing of db.listings) {
    if (!Number.isSafeInteger(listing.price_epoch) || listing.price_epoch < 1) listing.price_epoch = 1;
    if (typeof listing.deleted_at !== 'string' || listing.deleted_at === '') listing.deleted_at = null;
    // Same backfill for the audit column. It is only meaningful alongside a
    // withdrawal, and a row that predates soft delete has none — so NULL is
    // both the honest value and the one restoreListing() treats as
    // "unattributed, the owner may restore".
    if (typeof listing.deleted_by !== 'string' || listing.deleted_by === '') listing.deleted_by = null;
  }

  // The three coach columns arrived after the first stores were written, so a
  // real `data/db.json` is holding profile rows with no such keys at all.
  // Backfilled to NULL rather than bumping DB_VERSION, for the same reason
  // `price_epoch` and `deleted_at` were: throwing a developer's whole store away
  // to add three nullable columns is a worse trade than repairing them on load.
  //
  // NULL is the honest value: a row written before the columns existed carries
  // no headline, no bio and no stated years, which is precisely "not stated".
  // And, as with `deleted_at`, normalising a MISSING key to `null` (rather than
  // leaving it `undefined`) is what keeps the column present on every row handed
  // out — the profile shape assertions in scripts/verify-authz.mts depend on it,
  // and `undefined` and `null` serialise differently through JSON.
  //
  // `coach_years_coaching` is normalised on `Number.isInteger`, NOT on falsiness:
  // `0` is a legitimate stated value ("first season") and must survive.
  for (const profile of db.profiles) {
    if (typeof profile.coach_headline !== 'string' || profile.coach_headline === '') {
      profile.coach_headline = null;
    }
    if (typeof profile.coach_bio !== 'string' || profile.coach_bio === '') {
      profile.coach_bio = null;
    }
    if (!Number.isInteger(profile.coach_years_coaching)) {
      profile.coach_years_coaching = null;
    }
  }

  seedOrdersAndReviews(db, base);

  const adminId = db.profiles.find((p) => p.role === 'admin')?.id ?? SEED_IDS.admin;
  for (const invite of SEED_INVITES) {
    if (db.invites.some((i) => i.code.toLowerCase() === invite.code.toLowerCase())) continue;
    db.invites.push({
      code: invite.code,
      created_by: adminId,
      note: invite.note,
      expires_at: null,
      redeemed_by: null,
      redeemed_at: null,
      revoked_at: null,
      created_at: nowIso(),
    });
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function dbFilePath(): string {
  const configured = mockDbPath();
  // `turbopackIgnore` silences a build-time warning, and the warning has real
  // consequences now that there is a production backend. `MOCK_DB_PATH` is
  // configurable, so static analysis cannot bound this path and conservatively
  // traces THE WHOLE PROJECT — every source file and all of `public/` — into
  // the serverless bundle. With `DATA_BACKEND=supabase` that is pure dead
  // weight: the mock store is never opened, but the tracer cannot know that,
  // and the docs warn it "can slow down deployments or lead to failures when
  // size limits are exceeded".
  //
  // Suppressing the trace is safe precisely BECAUSE the path is configurable:
  // there is no fixed file for Turbopack to bundle, and the mock reads it at
  // runtime from the filesystem it is actually running on. On Vercel that
  // filesystem is read-only, which is why `README.md` says the mock backend
  // cannot be used in production at all.
  return isAbsolute(configured) ? configured : resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

async function loadFromDisk(): Promise<MockDb> {
  const file = dbFilePath();

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<MockDb>;
      if (parsed && parsed.version === DB_VERSION && Array.isArray(parsed.profiles)) {
        const db: MockDb = { ...emptyDb(), ...parsed, version: DB_VERSION } as MockDb;
        // Re-run the seed so a store created before a fixture was added catches
        // up, and so deleting the file is never required during development.
        const before = JSON.stringify(db);
        seedDatabase(db);
        if (JSON.stringify(db) !== before) await persist(db);
        return db;
      }
    } catch {
      // Corrupt or stale-schema file: fall through and rebuild it. The mock
      // store holds only fixtures, so throwing the file away is the right call.
    }
  }

  const db = emptyDb();
  seedDatabase(db);
  await persist(db);
  return db;
}

/** Writes to a sibling temp file then renames, so a crash mid-write cannot leave a truncated store. */
async function persist(db: MockDb): Promise<void> {
  const file = dbFilePath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Module-level singleton + async mutex
//
// Stashed on globalThis because Next.js re-evaluates modules on every hot
// reload in dev; a plain module-level `let` would produce a fresh, unserialised
// cache per reload and lose writes.
// ---------------------------------------------------------------------------

interface StoreState {
  db: MockDb | null;
  /** Tail of the promise chain that serialises all access. */
  queue: Promise<unknown>;
}

type GlobalWithStore = typeof globalThis & { __javelinMockStore?: StoreState };

function state(): StoreState {
  const g = globalThis as GlobalWithStore;
  if (!g.__javelinMockStore) {
    g.__javelinMockStore = { db: null, queue: Promise.resolve() };
  }
  return g.__javelinMockStore;
}

/**
 * Runs `task` with exclusive access to the store. Every public entry point goes
 * through here, so two concurrent server actions can never interleave a
 * read-modify-write and lose one of the two updates.
 */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const s = state();
  const result = s.queue.then(task, task);
  // Keep the chain alive regardless of whether `task` rejected.
  s.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function ensureLoaded(): Promise<MockDb> {
  const s = state();
  if (!s.db) s.db = await loadFromDisk();
  return s.db;
}

/**
 * Read-only access. `fn` receives the live document — treat it as immutable and
 * return copies of anything you hand out.
 */
export function readDb<T>(fn: (db: MockDb) => T): Promise<T> {
  return exclusive(async () => fn(await ensureLoaded()));
}

/**
 * Read-modify-write access.
 *
 * `fn` mutates a deep COPY of the document. Only if it returns without throwing
 * is the copy promoted to the live cache and written to disk. A partially
 * applied mutation therefore can never be observed — which is how
 * `redeemInviteCode` gets "claim the invite and promote the profile" as one
 * atomic step without a transaction manager.
 */
export function mutateDb<T>(fn: (db: MockDb) => T): Promise<T> {
  return exclusive(async () => {
    const current = await ensureLoaded();
    const draft = structuredClone(current);
    const result = fn(draft);
    state().db = draft;
    await persist(draft);
    return result;
  });
}

/** Test-only: drops the in-process cache so the next call re-reads from disk. */
export function __resetStoreCache(): void {
  const g = globalThis as GlobalWithStore;
  if (g.__javelinMockStore) g.__javelinMockStore.db = null;
}
