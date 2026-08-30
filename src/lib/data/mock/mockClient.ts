/**
 * `MockDataClient` — the JSON-file implementation of `DataClient`.
 *
 * ===========================================================================
 * This file is the code twin of `supabase/migrations/0002_rls.sql`.
 * ===========================================================================
 * There is no Postgres in this phase, so the RLS policy set cannot actually run
 * anywhere. Rather than leave authorization to the UI, every policy is
 * re-implemented here as an explicit check, and each check carries a comment
 * naming the policy or function it mirrors — so a reviewer can diff the two
 * files side by side and see nothing has been dropped.
 *
 * The rule that makes this trustworthy: an `Actor` is `{ userId } | null` and
 * nothing more. Role and coach_status are ALWAYS re-read from the store inside
 * this file. Nothing a caller passes in can grant a privilege, which is exactly
 * the guarantee RLS gives by trusting only `auth.uid()`.
 */

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
  SignUpInput,
  UpdateListingInput,
  UpdateMyCoachProfileInput,
} from '../client';
import type {
  Actor,
  Deliverable,
  CoachApplication,
  CoachApplicationWithUser,
  CoachStats,
  Invite,
  Listing,
  ListingCategory,
  ListingDetail,
  ListingRevision,
  ListingWithCoach,
  OfferStats,
  OwnedListing,
  Order,
  OrderWithListing,
  Profile,
  PublicCoach,
  PublicProfile,
  PublicReview,
  PublicReviewWithListing,
  Review,
  Role,
} from '../types';
import {
  COACH_BIO_MAX,
  COACH_HEADLINE_MAX,
  DataError,
  LISTING_CATEGORIES,
  isListingCategory,
} from '../types';
import {
  hashPassword,
  mutateDb,
  newId,
  normalizeEmail,
  nowIso,
  readDb,
  verifyPassword,
  type MockDb,
} from './store';
import {
  optionalActorId,
  optionalText,
  optionalYears,
  requireActorId,
  requireEmail,
  requireIsoTimestamp,
  requireListingCategory,
  requirePriceCents,
  requirePassword,
  requireRating,
  optionalAssetPath,
  optionalAvatarPath,
  optionalFulfilment,
  requireText,
} from '../validation';
import { generateInviteCode } from '../invite-code';

// ---------------------------------------------------------------------------
// Validation and actor unwrapping live in `../validation`, shared with
// `SupabaseDataClient` so that both backends reject the same input with the
// same words. See the header of that file for why the sharing is load-bearing.
// ---------------------------------------------------------------------------

function resolveProfile(db: MockDb, actor: Actor): Profile {
  const userId = requireActorId(actor);
  const profile = db.profiles.find((p) => p.id === userId);
  if (!profile) {
    // A session pointing at a user that no longer exists is not authenticated.
    throw new DataError('unauthorized', 'Your session is no longer valid. Please sign in again.');
  }
  return profile;
}

/** Mirrors the SECURITY DEFINER helper `public.is_admin()` (0002_rls.sql). */
function requireAdmin(db: MockDb, actor: Actor): Profile {
  const profile = resolveProfile(db, actor);
  if (profile.role !== 'admin') {
    throw new DataError('forbidden', 'Only an administrator can do that.');
  }
  return profile;
}

/** Mirrors the SECURITY DEFINER helper `public.is_approved_coach()` (0002_rls.sql). */
function requireApprovedCoach(db: MockDb, actor: Actor): Profile {
  const profile = resolveProfile(db, actor);
  if (profile.coach_status !== 'approved') {
    throw new DataError(
      'forbidden',
      'Only approved coaches can publish offers. Apply to coach or redeem an invite code first.',
    );
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Row copying + joins. Everything handed to a caller is a copy, so a caller
// mutating a returned object cannot corrupt the in-memory store.
// ---------------------------------------------------------------------------

const copy = <T>(row: T): T => ({ ...row });

/**
 * The single promotion rule, shared by invite redemption and application
 * approval: becoming a coach may only ever RAISE privilege.
 *
 * Mirrors the `case when p.role = 'learner' then 'coach' else p.role end`
 * expression in both `redeem_invite_code()` and `review_coach_application()`.
 *
 * The bug this exists to prevent: an unconditional `role = 'coach'` demoted an
 * administrator who redeemed an invite code (the seeded code is printed in the
 * README right next to the admin account) or who was approved as a coach. The
 * store could end up with zero admins, the idempotent seeder does not repair it
 * because the admin email already exists, and the only recovery was deleting
 * data/db.json.
 */
function promoteToCoachRole(current: Role): Role {
  return current === 'learner' ? 'coach' : current;
}

/**
 * Mirrors the `public.public_profiles` view, column for column.
 *
 * `role` and `coach_status` are deliberately absent — see the doc comment on
 * `PublicProfile`. Publishing `role` here would let any caller enumerate
 * administrators, which is strictly worse than the `is_admin(uuid)` probe that
 * was already removed from the SQL for the same reason.
 */
function toPublicProfile(profile: Profile): PublicProfile {
  return {
    id: profile.id,
    full_name: profile.full_name,
    is_approved_coach: profile.coach_status === 'approved',
    avatar_path: profile.avatar_path,
  };
}

/**
 * Mirrors: the `where p.coach_status = 'approved'` predicate on the
 * `public.public_coaches` view (0002_rls.sql).
 *
 * ONE function, used by BOTH coach-directory reads, so that "which reads are
 * scoped to approved coaches?" is answerable by grepping for this name rather
 * than by auditing two hand-written predicates — the same construction, and the
 * same reason, as `isWithdrawn()` below.
 *
 * There is deliberately no caller-facing way to invert or widen it. This is the
 * single predicate that keeps `listCoaches` from being an enumerator over
 * `coach_status`, and `PublicCoach` carries neither that column nor `role`, so
 * a row that escapes this filter would be a silent disclosure with nothing on
 * screen to show for it.
 *
 * Tested against `'approved'` and not against "not none", so a `coach_status`
 * value added later (or a hand-edited store holding rubbish) fails CLOSED.
 */
function isApprovedCoachProfile(profile: Profile): boolean {
  return profile.coach_status === 'approved';
}

/**
 * True when the coach has a public bio of their own already.
 *
 * Written against a non-empty STRING rather than `!= null` so that a store
 * predating these columns (where the field is `undefined`) reads as empty,
 * which is what a missing bio means — the same construction as `isWithdrawn()`.
 * Used by `reviewCoachApplication` to decide whether the one-time copy from the
 * application has anything to overwrite.
 */
function hasCoachBio(profile: Profile): boolean {
  return typeof profile.coach_bio === 'string' && profile.coach_bio.trim() !== '';
}

/**
 * Mirrors the `public.public_coaches` view, column for column.
 *
 * A field-by-field projection, NOT `{ ...profile }` minus a few keys. `email`,
 * `role` and `coach_status` are all on the row, and a spread would additionally
 * carry out every column a future migration adds to `profiles` — which is how
 * the next privilege-bearing column reaches an anonymous page. Same
 * construction, and the same reasoning, as `toPublicProfile()` and
 * `toPublicReview()`.
 *
 * `is_approved_coach` is absent because every row this builds is one: the
 * callers filter with `isApprovedCoachProfile()` first. See {@link PublicCoach}.
 */
function toPublicCoach(profile: Profile): PublicCoach {
  return {
    id: profile.id,
    full_name: profile.full_name,
    coach_headline: profile.coach_headline,
    coach_bio: profile.coach_bio,
    coach_years_coaching: profile.coach_years_coaching,
    avatar_path: profile.avatar_path,
  };
}

/**
 * Mirrors: the `deleted_at is null` predicate on every public listing read
 * (policy `listings_select_public` in 0002_rls.sql).
 *
 * ONE function, used by every read that must not republish a withdrawn offer,
 * so that "which reads filter?" is answerable by grepping for this name rather
 * than by auditing ten hand-written predicates. The list of call sites is on
 * `Listing.deleted_at`; the list of deliberate NON-callers — coachStats(),
 * listReviewsForCoach(), listingTitle(), createReview() — carries a comment
 * each saying why, because adding the filter there is the regression that
 * silently erases a coach's reputation.
 *
 * Written against a non-empty STRING rather than `!= null` so that a store
 * predating the column (where the field is `undefined`) reads as published,
 * which is what a missing withdrawal timestamp means.
 */
function isWithdrawn(listing: Listing): boolean {
  return typeof listing.deleted_at === 'string' && listing.deleted_at !== '';
}

function coachName(db: MockDb, coachId: string): string {
  return db.profiles.find((p) => p.id === coachId)?.full_name ?? 'Unknown coach';
}

/**
 * The ONE projection every listing read and write goes out through.
 *
 * A field-by-field projection, NOT `{ ...listing, coach_name }`. That is the
 * safety property, and it is the same one `toPublicReview()` relies on:
 * `deleted_by` is on the row and must never reach a caller (it is an
 * ADMINISTRATOR's id after a takedown — see `Listing.deleted_by`), and a spread
 * would additionally carry out every column a future migration adds to
 * `listings`.
 *
 * Belt and braces: `ListingWithCoach` is declared as `Omit<Listing,
 * 'deleted_by'>`, so re-introducing the spread does not merely leak — it fails
 * to compile.
 */
function withCoach(db: MockDb, listing: Listing): ListingWithCoach {
  return {
    id: listing.id,
    coach_id: listing.coach_id,
    title: listing.title,
    description: listing.description,
    price_cents: listing.price_cents,
    category: listing.category,
    price_epoch: listing.price_epoch,
    deleted_at: listing.deleted_at,
    // Public, unlike `asset_path` below it on the row: how an offer arrives is
    // something a buyer should know before claiming, which is why 0011 grants
    // SELECT on this column and withholds the other.
    fulfilment: listing.fulfilment,
    created_at: listing.created_at,
    updated_at: listing.updated_at,
    coach_name: coachName(db, listing.coach_id),
  };
}

/**
 * True when the withdrawal was a TAKEDOWN rather than the coach's own doing.
 *
 * Only the owner or an admin can withdraw an offer, so "withdrawn by someone
 * who is not the owner" is exactly "withdrawn by an admin" — which lets the
 * dashboard publish the FACT without publishing the administrator's id.
 */
function withdrawnByAdmin(listing: Listing): boolean {
  return (
    isWithdrawn(listing) && typeof listing.deleted_by === 'string' && listing.deleted_by !== listing.coach_id
  );
}

/**
 * The owner-facing shape: the projection above, plus the derived takedown flag,
 * plus the owner's own `asset_path`.
 *
 * Mirrors the `public.owned_listings` view, whose `where l.coach_id =
 * auth.uid()` is what makes both additions safe. The only caller is
 * `listMyListings`, which resolves the coach from the actor — so as in SQL,
 * the scoping is upstream of the projection and this function never decides who
 * is asking.
 */
function asOwned(db: MockDb, listing: Listing): OwnedListing {
  return {
    ...withCoach(db, listing),
    withdrawn_by_admin: withdrawnByAdmin(listing),
    asset_path: listing.asset_path,
  };
}

/**
 * NO `deleted_at` FILTER HERE, deliberately. This resolves the title for an
 * ORDER (a buyer's purchase list, a coach's sales list) and for a review on a
 * coach profile. Withdrawing an offer must not turn every purchase of it into
 * "Unknown offer" — the row survives precisely so the title still joins.
 */
function listingTitle(db: MockDb, listingId: string): string {
  return db.listings.find((l) => l.id === listingId)?.title ?? 'Unknown offer';
}

/**
 * Resolves an order into the shape both sides of it render from.
 *
 * `viewerId` is here for ONE field. `asset_path` is the instant download, and
 * the mock mirrors `public.entitled_offer_assets` (0012) rather than handing it
 * to whoever asked: the offer's coach, or a learner holding an order for that
 * offer, and nobody else. An ADMIN reading somebody else's order therefore gets
 * `null` — they can see the order exists, they cannot help themselves to the
 * file — which is the SQL view's behaviour too, since it is scoped by
 * `auth.uid()` with no admin arm.
 *
 * `listing_fulfilment` needs no such test: it is public.
 */
function withListing(db: MockDb, order: Order, viewerId: string | null): OrderWithListing {
  const listing = db.listings.find((l) => l.id === order.listing_id) ?? null;

  // A row whose listing has vanished is not a state any write path can produce
  // — `orders.listing_id` is ON DELETE RESTRICT and nothing hard-deletes a
  // listing — but `listingTitle()` already tolerates it, so this does too, and
  // it falls back to the column DEFAULT rather than to the mode with a file.
  const fulfilment = listing?.fulfilment ?? 'personalised';

  const entitled =
    listing !== null &&
    listing.fulfilment === 'instant' &&
    listing.asset_path !== null &&
    viewerId !== null &&
    (listing.coach_id === viewerId ||
      db.orders.some((o) => o.listing_id === listing.id && o.learner_id === viewerId));

  return {
    ...order,
    listing_title: listingTitle(db, order.listing_id),
    has_review: db.reviews.some((r) => r.order_id === order.id),
    listing_fulfilment: fulfilment,
    asset_path: entitled ? listing.asset_path : null,
  };
}

/**
 * Mirrors the `public.public_reviews` view: the public shape of a review.
 *
 * Reviews are the one public surface that reads from a private table, so what
 * this function LEAVES OUT is the point — see the doc comment on
 * `PublicReview` for why each omitted column is omitted.
 */
function toPublicReview(db: MockDb, review: Review): PublicReview {
  const profile = db.profiles.find((p) => p.id === review.author_id);
  // A field-by-field projection, NOT `{ ...review, author_name }`. That is the
  // safety property: `order_id`, `author_id` and `price_epoch` are on the row
  // and must not reach a public page, and a spread would additionally carry
  // every column a future migration adds to `reviews` straight out to anon.
  return {
    id: review.id,
    listing_id: review.listing_id,
    rating: review.rating,
    body: review.body,
    created_at: review.created_at,
    // From `toPublicProfile()`, never from the profile row: `Profile` carries
    // email, so widening the public profile projection is the only way to
    // widen this.
    author_name: profile ? toPublicProfile(profile).full_name : 'Former member',
  };
}

/**
 * `round(avg(rating)::numeric, 1)`, and `null` for an empty set — which is what
 * Postgres's `avg()` returns over no rows, and what the app needs: a rating of
 * `0` cannot happen (ratings are 1-5), so `null` unambiguously means "nobody
 * has reviewed this". Never coalesce it to zero. A new offer showing "0.0"
 * reads as a bad offer.
 *
 * Both sides round half-up on positive values, so the rendered number does not
 * change when the backend is swapped.
 */
function ratingAverage(reviews: readonly Review[]): number | null {
  if (reviews.length === 0) return null;
  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  return Math.round((total / reviews.length) * 10) / 10;
}

/**
 * OFFER-level rollup — mirrors the `public.offer_stats` view.
 *
 * Filtered to the listing's CURRENT `price_epoch`: raising a price archives
 * that offer's rating and sales so the offer reads as new. The rows are still
 * there, still attached to this listing, and still counted at account level —
 * see coachStats() below, and do not "fix" the difference between the two.
 */
function offerStats(db: MockDb, listing: Listing): OfferStats {
  const epoch = listing.price_epoch;
  const reviews = db.reviews.filter((r) => r.listing_id === listing.id && r.price_epoch === epoch);
  return {
    listing_id: listing.id,
    // The epoch is the FILTER, and deliberately not a published column: how
    // many times a coach has raised a price is not a visitor's business, and
    // nothing on an offer card renders it.
    rating_average: ratingAverage(reviews),
    review_count: reviews.length,
    sales_count: db.orders.filter((o) => o.listing_id === listing.id && o.price_epoch === epoch).length,
  };
}

/**
 * ACCOUNT-level rollup — mirrors the `public.coach_stats` view. Every offer,
 * every epoch.
 *
 * Two deliberate properties, both of which the next round depends on:
 *
 *   1. NO EPOCH FILTER. A coach who raises a price has not become a worse
 *      coach, so their standing is untouched by it.
 *   2. IT DOES NOT CONSULT THE PUBLIC LISTING READS. Sales are counted straight
 *      off `orders.coach_id`, which is denormalised onto the order precisely so
 *      that this count never depends on the listing still being *visible*;
 *      reviews are resolved through the RAW `db.listings` collection, i.e. the
 *      table, not `listListings()`. Offer withdrawal is now a soft delete, and
 *      hiding a listing from browse must NOT retroactively erase the coaching
 *      that was sold and reviewed — so the `deleted_at` filter the public read
 *      paths carry (`isWithdrawn()`) is deliberately absent here, and must
 *      never be added here or to the `coach_stats` view. `offer_stats` takes
 *      one; this must not.
 *
 * Property 2 is pinned by the withdrawal block in scripts/verify-authz.mts,
 * which withdraws a seeded offer through softDeleteListing() and asserts these
 * three numbers do not move — in the same block that asserts the offer really
 * did vanish from every public read.
 */
function coachStats(db: MockDb, coachId: string): CoachStats {
  // No isWithdrawn() filter, on purpose. See property 2 above.
  const listingIds = new Set(db.listings.filter((l) => l.coach_id === coachId).map((l) => l.id));
  const reviews = db.reviews.filter((r) => listingIds.has(r.listing_id));
  return {
    coach_id: coachId,
    rating_average: ratingAverage(reviews),
    review_count: reviews.length,
    sales_count: db.orders.filter((o) => o.coach_id === coachId).length,
  };
}

function withUser(db: MockDb, application: CoachApplication): CoachApplicationWithUser {
  const user = db.profiles.find((p) => p.id === application.user_id);
  return {
    ...application,
    user_name: user?.full_name ?? 'Unknown user',
    user_email: user?.email ?? '',
    user_coach_status: user?.coach_status ?? 'none',
  };
}

const byCreatedAtDesc = (a: { created_at: string }, b: { created_at: string }): number =>
  b.created_at.localeCompare(a.created_at);

// ---------------------------------------------------------------------------

export class MockDataClient implements DataClient {
  // =========================================================================
  // Auth-shaped
  // =========================================================================

  async signUp(input: SignUpInput): Promise<Profile> {
    const email = requireEmail(input?.email);
    const fullName = requireText(input?.fullName, 'Full name', 120, 2);
    // NOT requireText: a password is never trimmed — see requirePassword.
    const password = requirePassword(input?.password);

    return mutateDb((db) => {
      // Mirrors: Supabase auth's own duplicate-email rejection on
      // `auth.users.email`. Note this checks `auth_users`, NOT `profiles` —
      // `profiles.email` deliberately carries no unique constraint in SQL (see
      // 0001_init.sql), so this check must stand on the credential table alone,
      // exactly as it does in Postgres.
      if (db.auth_users.some((u) => u.email === email)) {
        throw new DataError('conflict', 'An account with that email already exists.');
      }

      const id = newId();
      const timestamp = nowIso();
      const { hash, salt } = hashPassword(password);

      db.auth_users.push({ id, email, password_hash: hash, password_salt: salt, created_at: timestamp });

      // Mirrors: policy `profiles_insert_self` — a new profile is pinned to
      // role 'learner' / coach_status 'none'. Signup can never mint a coach.
      const profile: Profile = {
        id,
        email,
        full_name: fullName,
        role: 'learner',
        coach_status: 'none',
        // Mirrors: the three nullable coach columns, which have no default.
        // Written explicitly rather than left off, for the same reason
        // createListing writes `deleted_at: null` — a row missing them would
        // still BEHAVE correctly (every read tests for a string) but would fail
        // the profile shape assertions, and "the column is absent" and "the
        // column is null" must not be two different rows in the store.
        coach_headline: null,
        coach_bio: null,
        coach_years_coaching: null,
        avatar_path: null,
        created_at: timestamp,
        updated_at: timestamp,
      };
      db.profiles.push(profile);
      return copy(profile);
    });
  }

  async signInWithPassword(input: SignInInput): Promise<Profile | null> {
    // Bad input is a failed sign-in, not a validation error to render — it must
    // be indistinguishable from a wrong password.
    if (typeof input?.email !== 'string' || typeof input?.password !== 'string') return null;
    const email = normalizeEmail(input.email);

    return readDb((db) => {
      const user = db.auth_users.find((u) => u.email === email);
      if (!user) return null;
      if (!verifyPassword(input.password, user.password_hash, user.password_salt)) return null;
      const profile = db.profiles.find((p) => p.id === user.id);
      return profile ? copy(profile) : null;
    });
  }

  async updateMyPassword(actor: Actor, newPassword: string): Promise<void> {
    // The same rule `signUp` applies, through the same helper, so a password
    // this method accepts is one the sign-up form would have accepted.
    const password = requirePassword(newPassword);

    return mutateDb((db) => {
      // The SUBJECT IS THE RESOLVED ACTOR and is never a parameter. There is no
      // shape of this call that rewrites somebody else's credentials — the same
      // construction as `updateMyCoachProfile` and `setMyAvatar`.
      const profile = resolveProfile(db, actor);

      const user = db.auth_users.find((u) => u.id === profile.id);
      if (!user) {
        // A profile with no credential row is a store that has been edited by
        // hand. Treat it as a broken session rather than creating credentials
        // for it, which would be this method minting an account.
        throw new DataError('unauthorized', 'Your session is no longer valid. Please sign in again.');
      }

      // A NEW SALT, not a re-hash against the old one. Reusing the salt would
      // make "did the password change?" answerable by comparing two hashes
      // taken from a leaked store.
      const { hash, salt } = hashPassword(password);
      user.password_hash = hash;
      user.password_salt = salt;

      // `auth_users` has no updated_at — it mirrors Supabase's `auth.users`,
      // which this project never reads columns from. The PROFILE's timestamp is
      // deliberately left alone too: nothing about the public profile changed,
      // and moving it would reorder the coach directory on a password change.
    });
  }

  async getProfile(actor: Actor, userId: string): Promise<Profile | null> {
    if (typeof userId !== 'string' || userId === '') return null;
    // Mirrors: policies `profiles_select_self` (using id = auth.uid()) and
    // `profiles_select_admin` (using public.is_admin()).
    //
    // `profiles` carries email, so it is NOT world-readable. An earlier
    // revision mirrored a `using (true)` policy here and handed every user's
    // email to anonymous callers. Public pages use getPublicProfile() instead.
    return readDb((db) => {
      const actorProfile = resolveProfile(db, actor);
      if (actorProfile.id !== userId && actorProfile.role !== 'admin') {
        throw new DataError('forbidden', 'You can only view your own profile.');
      }
      const profile = db.profiles.find((p) => p.id === userId);
      return profile ? copy(profile) : null;
    });
  }

  async getPublicProfile(userId: string): Promise<PublicProfile | null> {
    if (typeof userId !== 'string' || userId === '') return null;
    // Mirrors: the `public.public_profiles` view (0002_rls.sql), which is
    // granted to anon and authenticated and projects away email, role and
    // coach_status by construction. No actor required.
    return readDb((db) => {
      const profile = db.profiles.find((p) => p.id === userId);
      return profile ? toPublicProfile(profile) : null;
    });
  }

  // =========================================================================
  // The public coach directory
  //
  // Both reads below are filtered with isApprovedCoachProfile() HERE, in the
  // data layer, and there is no parameter on either that can widen it. That is
  // the whole security property of this section: `profiles` holds every learner
  // and every administrator, so a directory built as "read the profiles, filter
  // in the page" would be a role enumerator that looks identical on screen.
  // =========================================================================

  async listCoaches(filter?: CoachDirectoryFilter): Promise<PublicCoach[]> {
    const q = typeof filter?.q === 'string' ? filter.q.trim().toLowerCase() : '';

    // Mirrors: `select * from public.public_coaches where full_name ilike $1`,
    // granted to anon + authenticated. The view carries the approval predicate
    // itself, exactly as this does — there is no un-scoped variant on either
    // side, so neither backend can be pointed at a wider row set.
    return readDb((db) =>
      db.profiles
        .filter((p) => {
          // THE line of this method. Everything else here is presentation.
          if (!isApprovedCoachProfile(p)) return false;
          if (!q) return true;
          // full_name ONLY, matching the one column Postgres indexes for this
          // query (`profiles_full_name_trgm_idx` in 0001_init.sql). Matching the
          // headline or the bio as well would make the mock quietly the more
          // capable of the two backends — narrowed rather than widened, for the
          // same reason `listListings` searches title + description only.
          return p.full_name.toLowerCase().includes(q);
        })
        // Newest first, mirroring `order by created_at desc`. NOT alphabetical:
        // `order by full_name` is collation-dependent in Postgres and the mock
        // cannot reproduce that for non-ASCII names, so an alphabetical
        // directory would silently reorder at the backend swap.
        .sort(byCreatedAtDesc)
        .map(toPublicCoach),
    );
  }

  async getPublicCoach(coachId: string): Promise<PublicCoach | null> {
    if (typeof coachId !== 'string' || coachId === '') return null;
    // Mirrors: `select * from public.public_coaches where id = $1`.
    //
    // `null` — never a throw — for an unknown id AND for a real user who is not
    // an approved coach. Separating those two would turn this into a
    // `coach_status` oracle: a `forbidden` for a rejected applicant and a
    // `not_found` for a stranger is exactly the disclosure `PublicProfile`
    // drops the column to prevent.
    return readDb((db) => {
      const profile = db.profiles.find((p) => p.id === coachId);
      return profile && isApprovedCoachProfile(profile) ? toPublicCoach(profile) : null;
    });
  }

  async updateMyCoachProfile(actor: Actor, input: UpdateMyCoachProfileInput): Promise<Profile> {
    // Validated before the store is opened, as every other write does, so bad
    // input is `invalid` regardless of who sent it.
    const headline = optionalText(input?.coach_headline, 'Headline', COACH_HEADLINE_MAX);
    const bio = optionalText(input?.coach_bio, 'Bio', COACH_BIO_MAX);
    const years = optionalYears(input?.coach_years_coaching);

    return mutateDb((db) => {
      // Mirrors: policy `profiles_update_own` — using (id = auth.uid()) — plus
      // the `public.is_approved_coach()` requirement, which has no SQL
      // equivalent as a policy because the columns are only ever PUBLISHED for
      // an approved coach anyway (the `public_coaches` view filters), so a
      // non-coach writing them changes nothing anyone can see. Refused here all
      // the same: a write that has no effect should say so rather than succeed.
      //
      // NOT an admin. Same asymmetry as updateListing(), same reason — an
      // administrator rewriting a coach's bio publishes words under that
      // coach's byline that the coach never wrote.
      //
      // Written out rather than calling requireApprovedCoach(), whose message
      // is about publishing listings and would be a non-sequitur here. The
      // PREDICATE is the same one, and is the single fact `is_approved_coach()`
      // tests in SQL.
      const profile = resolveProfile(db, actor);
      if (!isApprovedCoachProfile(profile)) {
        throw new DataError('forbidden', 'Only approved coaches have a public coach profile to edit.');
      }

      // The subject is the RESOLVED actor and is never a parameter, so there is
      // no shape of this call that writes to another profile.
      profile.coach_headline = headline;
      profile.coach_bio = bio;
      profile.coach_years_coaching = years;
      // Deliberately NOT written here: role, coach_status, id, email,
      // full_name. This is the code twin of guard_profile_privilege_columns.
      profile.updated_at = nowIso();

      return copy(profile);
    });
  }

  // =========================================================================
  // Listings
  // =========================================================================

  async setMyAvatar(actor: Actor, path: string | null): Promise<Profile> {
    const next = optionalAvatarPath(path);

    return mutateDb((db) => {
      const profile = resolveProfile(db, actor);

      // Mirrors: the `profiles_avatar_path_shape` CHECK constraint, and the
      // `(storage.foldername(name))[1] = auth.uid()` rule on every avatars
      // storage policy. The first path segment IS the ownership claim, so a
      // path under somebody else's id is refused rather than stored.
      if (next !== null && !next.startsWith(`${profile.id}/`)) {
        throw new DataError('forbidden', 'An avatar has to be stored under your own account.');
      }

      profile.avatar_path = next;
      profile.updated_at = nowIso();
      return copy(profile);
    });
  }

  async listListings(filter?: ListingFilter): Promise<ListingWithCoach[]> {
    const q = typeof filter?.q === 'string' ? filter.q.trim().toLowerCase() : '';
    // A category outside the taxonomy matches NOTHING, and specifically is not
    // treated as "no filter". Two reasons. In SQL the comparison is against an
    // enum column, so `category = 'Track & Field'` is a cast error, not a wider
    // result set — silently widening here would make an unfiltered page appear
    // in response to a filtered URL. And a store seeded before the taxonomy may
    // still hold free text (see `listCategories` below); matching it would let a
    // hand-typed URL surface rows the filter control cannot offer.
    const rawCategory = typeof filter?.category === 'string' ? filter.category.trim() : '';
    const category: ListingCategory | null = isListingCategory(rawCategory) ? rawCategory : null;
    const impossibleCategory = rawCategory !== '' && category === null;
    if (impossibleCategory) return [];

    // Mirrors: policy `listings_select_public` — no actor, and the one
    // restriction: `using (deleted_at is null)`.
    return readDb((db) =>
      db.listings
        .filter((listing) => {
          // A withdrawn offer is not on sale. This is the browse half of the
          // rule; every other public listing read carries the same filter.
          if (isWithdrawn(listing)) return false;
          if (category && listing.category !== category) return false;
          if (!q) return true;
          // Title + description ONLY, matching the columns Postgres indexes for
          // this query (`listings_title_trgm_idx`, `listings_description_trgm_idx`,
          // `listings_search_tsv_idx` in 0001_init.sql). An earlier revision
          // also matched category and coach name, which the SQL side could not
          // reproduce without extra indexes and a join — the mock was quietly
          // the more capable of the two. Narrowed rather than widened so the
          // backend swap cannot change search results. Category has its own
          // exact-match filter above.
          return listing.title.toLowerCase().includes(q) || listing.description.toLowerCase().includes(q);
        })
        .sort(byCreatedAtDesc)
        .map((listing) => withCoach(db, listing)),
    );
  }

  async getListing(id: string): Promise<ListingWithCoach | null> {
    if (typeof id !== 'string' || id === '') return null;
    // Mirrors: policy `listings_select_public` — `using (deleted_at is null)`.
    // A withdrawn offer is a 404 here, for everyone, including its own coach:
    // this is the PUBLIC read. The entitled viewers get a tombstone from
    // getListingForViewer() instead, and the owner's dashboard uses
    // listMyListings().
    return readDb((db) => {
      const listing = db.listings.find((l) => l.id === id);
      return listing && !isWithdrawn(listing) ? withCoach(db, listing) : null;
    });
  }

  async getListingForViewer(actor: Actor, id: string): Promise<ListingDetail | null> {
    if (typeof id !== 'string' || id === '') return null;
    // Mirrors: `listings_select_public` for the published case, plus
    // `listings_select_own_coach`, `listings_select_purchaser` and
    // `listings_select_admin` for the withdrawn one — the three policies that
    // exist so a withdrawn offer stays reachable by the people who have a
    // reason to reach it.
    return readDb((db): ListingDetail | null => {
      const listing = db.listings.find((l) => l.id === id);
      if (!listing) return null;

      if (!isWithdrawn(listing)) return { state: 'published', listing: withCoach(db, listing) };

      // Withdrawn. `null` — a 404 — for anyone not entitled, rather than a
      // `forbidden` throw: a refusal would confirm that something once existed
      // at this id, which is the one fact withdrawal is meant to retract.
      const userId = optionalActorId(actor);
      if (userId === null) return null;
      // Privileges resolved from the STORE, never from the actor. A session
      // pointing at a deleted user is nobody.
      const profile = db.profiles.find((p) => p.id === userId);
      if (!profile) return null;

      const permitted =
        listing.coach_id === profile.id ||
        profile.role === 'admin' ||
        // The reason the tombstone exists at all: a buyer's purchase history
        // links here, and a dead end is worse than "no longer available".
        db.orders.some((o) => o.listing_id === listing.id && o.learner_id === profile.id);
      if (!permitted) return null;

      return {
        state: 'withdrawn',
        listing: withCoach(db, listing),
        // Restated non-nullable so a caller can render the date without a
        // null check it would be tempted to skip. isWithdrawn() has already
        // proved it is a non-empty string.
        withdrawn_at: listing.deleted_at as string,
      };
    });
  }

  async listCategories(): Promise<ListingCategory[]> {
    // Mirrors: `enum_range(null::public.listing_category)`, NOT a select over
    // `listings`. The taxonomy is fixed, so this is a property of the schema
    // rather than of the data — which is why a fresh store with zero listings
    // still offers a complete filter. The store is not read at all here.
    //
    // Corollary, and the reason this cannot be derived from the rows: a store
    // written before the taxonomy landed may still hold free-text categories.
    // Reads pass those through untouched (`listListings`, `getListing`) so the
    // page shows what is actually stored, but they never enter this list, and
    // `createListing` can no longer add another one.
    return [...LISTING_CATEGORIES];
  }

  async listListingsByCoach(actor: Actor, coachId: string): Promise<ListingWithCoach[]> {
    if (typeof coachId !== 'string' || coachId === '') return [];
    // Mirrors: policy `listings_select_public` — public data, and therefore
    // `deleted_at is null` like every other public listing read. `actor` is not
    // consulted: this is the PUBLIC coach profile's offer list, and it stays
    // public precisely so it can never be talked into returning somebody's
    // withdrawn offers. The owner's own view is listMyListings(), which derives
    // the coach id from the actor instead of taking it as a parameter.
    void actor;
    return readDb((db) =>
      db.listings
        .filter((l) => l.coach_id === coachId && !isWithdrawn(l))
        .sort(byCreatedAtDesc)
        .map((listing) => withCoach(db, listing)),
    );
  }

  async listMyListings(actor: Actor): Promise<OwnedListing[]> {
    // Mirrors: policy `listings_select_own_coach` — using (coach_id = auth.uid()),
    // which is what lets a coach see past the `deleted_at is null` predicate on
    // their OWN rows.
    //
    // The coach id comes from the resolved actor and is never a parameter, so
    // there is no shape of this call that reads somebody else's withdrawn
    // offers. Same construction as listMyOrders(), for the same reason.
    return readDb((db) => {
      const profile = resolveProfile(db, actor);
      return db.listings
        .filter((l) => l.coach_id === profile.id)
        .sort(byCreatedAtDesc)
        // asOwned(), not withCoach(): the dashboard is the one surface that
        // needs to know whether Restore will work, and it gets that as the
        // derived `withdrawn_by_admin` boolean rather than as an admin's id.
        .map((listing) => asOwned(db, listing));
    });
  }

  async createListing(actor: Actor, input: CreateListingInput): Promise<ListingWithCoach> {
    const title = requireText(input?.title, 'Title', 140, 3);
    const description = requireText(input?.description, 'Description', 4000, 10);
    const category = requireListingCategory(input?.category);
    const priceCents = requirePriceCents(input?.price_cents);
    // Mirrors: `fulfilment public.fulfilment_mode not null default 'personalised'`.
    // Omitted is not an error — it is the column default, and the default is the
    // only honest value for an offer that has nothing attached to it yet.
    const fulfilment = optionalFulfilment(input?.fulfilment) ?? 'personalised';

    return mutateDb((db) => {
      // Mirrors: policy `listings_insert_approved_coach` —
      //   with check (coach_id = auth.uid() and public.is_approved_coach(auth.uid()))
      // Anonymous -> unauthorized; signed in but not approved -> forbidden.
      const coach = requireApprovedCoach(db, actor);

      const timestamp = nowIso();
      const listing: Listing = {
        id: newId(),
        // coach_id comes from the resolved actor, never from `input` — this is
        // the `coach_id = auth.uid()` half of the policy.
        coach_id: coach.id,
        title,
        description,
        price_cents: priceCents,
        category,
        // Mirrors: `price_epoch integer not null default 1`. Every offer starts
        // at generation 1; the column only ever moves when a price goes UP, in
        // updateListing() below.
        price_epoch: 1,
        // Mirrors: `deleted_at timestamptz` with no default, i.e. NULL. Written
        // explicitly rather than left off so that every row handed out has the
        // column — a row missing it would still read as published (isWithdrawn
        // tests for a string) but would fail the listing shape assertions.
        deleted_at: null,
        // Mirrors: `deleted_by uuid` with no default. An audit column that
        // never reaches a caller — see Listing.deleted_by.
        deleted_by: null,
        fulfilment,
        // ALWAYS null on create, for both modes, and there is no input that can
        // change that. The `listings_asset_path_shape` CHECK pins an instant
        // offer's path under the listing's OWN id — which does not exist until
        // this row does — so attaching the file is necessarily a second call.
        // An instant offer therefore begins life published-but-unclaimable, a
        // state `claim_offer` refuses out loud rather than papering over.
        asset_path: null,
        created_at: timestamp,
        updated_at: timestamp,
      };
      db.listings.push(listing);
      return withCoach(db, listing);
    });
  }

  async updateListing(actor: Actor, listingId: string, input: UpdateListingInput): Promise<ListingWithCoach> {
    // Validated before the store is opened, exactly as createListing does, so
    // that bad input is `invalid` regardless of who sent it.
    const id = requireText(listingId, 'Offer', 200);
    const title = requireText(input?.title, 'Title', 140, 3);
    const description = requireText(input?.description, 'Description', 4000, 10);
    const category = requireListingCategory(input?.category);
    const priceCents = requirePriceCents(input?.price_cents);
    // NULL MEANS "UNCHANGED", not "default" — see UpdateListingInput.fulfilment.
    // A caller that does not offer the control must not be able to reset an
    // offer to personalised and orphan its file by staying silent.
    const nextFulfilment = optionalFulfilment(input?.fulfilment);

    return mutateDb((db) => {
      // Mirrors: policy `listings_update_own_coach` plus the content half of
      // the BEFORE UPDATE trigger `guard_listing_update()` — the owner may
      // write to their row, and only the owner may change the CONTENT columns.
      const profile = resolveProfile(db, actor);

      // The raw collection: a withdrawn offer is found here and refused below
      // with `conflict`, which is a truthful answer to its owner. Looking it up
      // through a filtered read would report `not_found` for a row the owner
      // can see in their own dashboard.
      const listing = db.listings.find((l) => l.id === id);
      if (!listing) throw new DataError('not_found', 'That offer could not be found.');

      // THE line of this method. OWNER ONLY — an admin is refused here like
      // anybody else, and this check is deliberately the FIRST permission test
      // so that an admin's own coach_status can never be what refuses them.
      // Note the asymmetry with softDeleteListing(), where an admin IS allowed:
      // a moderator takes an offer down, they do not rewrite it and publish the
      // result under the coach's byline.
      if (listing.coach_id !== profile.id) {
        throw new DataError('forbidden', 'Only the coach who published an offer can edit it.');
      }

      // Mirrors: `public.is_approved_coach()` inside guard_listing_update().
      // A coach whose approval was revoked keeps their rows readable and may
      // still WITHDRAW them; they may not edit them.
      if (profile.coach_status !== 'approved') {
        throw new DataError('forbidden', 'Only approved coaches can edit an offer.');
      }

      // EDITING A WITHDRAWN OFFER IS ALLOWED, deliberately, and an earlier
      // revision of this method refused it with `conflict`. Two reasons it had
      // to change. It would be a DEAD END: once an admin takedown can only be
      // lifted by an admin (see restoreListing), a coach told "restore it
      // first" can do neither — they cannot restore and they cannot fix the
      // thing that got it taken down, which is the one action that should be
      // open to them. And the SQL side permits it, so refusing here was a
      // silent behaviour difference between the two backends.
      //
      // Nothing leaks by allowing it: `deleted_at` is untouched, so the offer
      // stays invisible to every public read throughout, and the row goes back
      // through withCoach(), which carries no `deleted_by`.

      // Mirrors: the `new.fulfilment is distinct from old.fulfilment and exists
      // (select 1 from orders …)` arm of guard_listing_update(), added in 0011.
      //
      // A no-op resubmission of the SAME mode is not a change and is not
      // refused, which is what lets the editor keep the control on the form for
      // an offer that has already sold — `is distinct from` is the SQL test and
      // this is the same test.
      //
      // THE ANSWER IS THE SAME FOR AN ADMIN. This is not an ownership rule that
      // a moderator can override; it is a promise to whoever claimed the offer
      // that what they were told would arrive is what will arrive. The check is
      // in the trigger rather than in a policy for exactly that reason, and it
      // is here rather than in the caller for the same one.
      const changingFulfilment = nextFulfilment !== null && nextFulfilment !== listing.fulfilment;
      if (changingFulfilment && db.orders.some((o) => o.listing_id === listing.id)) {
        throw new DataError(
          'forbidden',
          'How this offer is delivered cannot change once somebody has claimed it.',
        );
      }

      const timestamp = nowIso();

      // Mirrors: the AFTER UPDATE trigger `record_listing_revision()`.
      //
      // Appended BEFORE anything is overwritten, and it snapshots the version
      // being SUPERSEDED — the live row is the current version, so the two
      // together are the whole history. This is what covers the case the epoch
      // rule deliberately does not: a coach who rewrites an offer end to end at
      // the same price keeps every review, so the record of what those reviews
      // were actually about has to survive somewhere.
      //
      // Written on EVERY edit, including one that changes nothing. "Somebody
      // saved this offer at this time" is a true and useful fact, and a
      // did-anything-change comparison is one more thing to get subtly wrong.
      const revision: ListingRevision = {
        id: newId(),
        listing_id: listing.id,
        title: listing.title,
        description: listing.description,
        price_cents: listing.price_cents,
        category: listing.category,
        // The moment this version was REPLACED, not the moment it was written.
        created_at: timestamp,
      };
      db.listing_revisions.push(revision);

      // ===================================================================
      // THE EPOCH RULE. Strictly greater, and nothing else.
      //
      //   price goes UP    -> bump: the offer's rating, review count and sales
      //                       are archived and it reads as new
      //   price unchanged  -> no bump
      //   price goes DOWN  -> no bump
      //   content-only     -> no bump
      //
      // A cut or a no-op that bumped would silently destroy an offer's social
      // proof in exchange for nothing. Computed from the row that is in the
      // store right now and applied in the SAME mutateDb() as the price write,
      // so there is no order of operations in which a caller gets the new price
      // without the archive — a confirmation dialog is a courtesy, not the
      // enforcement.
      // ===================================================================
      const priceIncreased = priceCents > listing.price_cents;

      listing.title = title;
      listing.description = description;
      listing.category = category;
      listing.price_cents = priceCents;
      if (priceIncreased) listing.price_epoch += 1;
      if (changingFulfilment) {
        listing.fulfilment = nextFulfilment;
        // Mirrors the `(fulfilment = 'personalised' and asset_path is null)` arm
        // of `listings_asset_path_shape`. Clearing the column is not a courtesy
        // — the constraint refuses the row otherwise — and the coach was told
        // this would happen before they saved. The OBJECT is deleted by the
        // caller, which is the half this layer does not own.
        if (nextFulfilment === 'personalised') listing.asset_path = null;
      }
      listing.updated_at = timestamp;

      return withCoach(db, listing);
    });
  }

  /**
   * Attaches or clears an instant offer's downloadable file.
   *
   * Separate from `updateListing` for the same reason `setMyAvatar` is separate
   * from `updateMyCoachProfile`: it is a different kind of write, and a failed
   * upload must not discard a description the coach just typed. It writes ONE
   * column and never touches the four content fields, the epoch or the
   * withdrawal state.
   *
   * NO REVISION IS WRITTEN, and that is deliberate rather than an oversight.
   * `listing_revisions` snapshots what an offer SAID — title, description,
   * price, category — so that a reader can tell which reviews predate a rewrite.
   * A file swap says nothing about any of that, and the mock must not write a
   * row the Postgres trigger would not: `record_listing_revision()` fires on
   * the same UPDATE, but the revision it writes carries none of these columns.
   *
   * Mirrors: policy `listings_update_own_coach` + the CONTENT half of
   * `guard_listing_update()` (0011 added `asset_path` to `v_content_changed`),
   * the `listings_asset_path_shape` CHECK, and `offer_assets_write_coach`.
   */
  async setListingAsset(actor: Actor, listingId: string, path: string | null): Promise<OwnedListing> {
    const id = requireText(listingId, 'Offer', 200);
    const next = optionalAssetPath(path);

    return mutateDb((db) => {
      const profile = resolveProfile(db, actor);

      const listing = db.listings.find((l) => l.id === id);
      if (!listing) throw new DataError('not_found', 'That offer could not be found.');

      // OWNER ONLY — an admin is refused here like anybody else, and the check
      // is first so that an admin's own coach_status can never be what refuses
      // them. Same asymmetry, same reason, as updateListing(): `asset_path` is
      // CONTENT, and a moderator does not swap the file a coach delivers.
      if (listing.coach_id !== profile.id) {
        throw new DataError('forbidden', 'Only the coach who published an offer can edit it.');
      }
      if (profile.coach_status !== 'approved') {
        throw new DataError('forbidden', 'Only approved coaches can edit an offer.');
      }

      // Mirrors: the `(fulfilment = 'personalised' and asset_path is null)` arm
      // of `listings_asset_path_shape`. A file on a personalised offer would be
      // one every buyer of it could fetch — the thing personalised delivery
      // exists not to be. Clearing is always allowed, whatever the mode, so a
      // mode switch can tidy up after itself.
      if (next !== null && listing.fulfilment !== 'instant') {
        throw new DataError(
          'invalid',
          'Only an instant-download offer can have a file attached. Switch this offer to instant delivery first.',
        );
      }

      // Mirrors: the `asset_path like (id::text || '/%')` arm of the same
      // constraint, and `(storage.foldername(name))[1]` in every offer-assets
      // storage policy. The first path segment IS the claim about which offer
      // this file belongs to, so a path under another offer's id is refused
      // rather than stored — exactly as setMyAvatar refuses a path under
      // another user's id.
      if (next !== null && !next.startsWith(`${listing.id}/`)) {
        throw new DataError('forbidden', "A file has to be stored under its own offer's folder.");
      }

      listing.asset_path = next;
      listing.updated_at = nowIso();

      // The OWNER's shape, because it is the only one that carries `asset_path`
      // back — a caller that just set a path and got a row without one would
      // have to re-read to find out whether it worked.
      return asOwned(db, listing);
    });
  }

  async softDeleteListing(actor: Actor, listingId: string): Promise<ListingWithCoach> {
    const id = requireText(listingId, 'Offer', 200);

    return mutateDb((db) => {
      // Mirrors: policies `listings_update_own_coach` + `listings_update_admin`,
      // whose only permitted effect for a non-owner is the `deleted_at` column
      // (enforced by guard_listing_update()). There is deliberately no DELETE
      // policy on `listings` for anybody: withdrawal is a soft delete and there
      // is no other kind.
      const profile = resolveProfile(db, actor);

      const listing = db.listings.find((l) => l.id === id);
      if (!listing) throw new DataError('not_found', 'That offer could not be found.');

      // Owner OR admin — the admin arm is the takedown, and it is the
      // deliberate asymmetry with updateListing().
      if (listing.coach_id !== profile.id && profile.role !== 'admin') {
        throw new DataError('forbidden', 'You can only withdraw your own offers.');
      }

      if (isWithdrawn(listing)) {
        throw new DataError('conflict', 'That offer is already withdrawn.');
      }

      const timestamp = nowIso();
      // A stamp, never a splice. `db.listings` never shrinks: the reviews and
      // orders pointing at this row keep resolving, and the coach's
      // account-level totals keep counting it.
      listing.deleted_at = timestamp;
      // WHO withdrew it, from the RESOLVED actor and never from input. This is
      // what lets restoreListing() tell a coach's own withdrawal apart from an
      // admin takedown; without it, a takedown is undone by one click on
      // Restore and is therefore not a takedown at all.
      listing.deleted_by = profile.id;
      listing.updated_at = timestamp;
      return withCoach(db, listing);
    });
  }

  async restoreListing(actor: Actor, listingId: string): Promise<ListingWithCoach> {
    const id = requireText(listingId, 'Offer', 200);

    return mutateDb((db) => {
      // Same policy pair, same guarded column, opposite direction. Nothing else
      // is touched — same id, same epoch, same reviews, same sales — because
      // withdrawal destroyed none of it.
      const profile = resolveProfile(db, actor);

      const listing = db.listings.find((l) => l.id === id);
      if (!listing) throw new DataError('not_found', 'That offer could not be found.');

      if (listing.coach_id !== profile.id && profile.role !== 'admin') {
        throw new DataError('forbidden', 'You can only restore your own offers.');
      }

      if (!isWithdrawn(listing)) {
        throw new DataError('conflict', 'That offer is not withdrawn.');
      }

      // ===================================================================
      // AN ADMIN TAKEDOWN MAY ONLY BE LIFTED BY AN ADMIN.
      //
      // Without this the moderation control does nothing: an admin withdraws
      // an offer, the coach presses Restore, it is back. `deleted_at` alone
      // cannot tell the two withdrawals apart, which is the entire reason
      // `deleted_by` exists.
      //
      // `forbidden`, not `conflict`: the row IS restorable — by an admin — so
      // this is about who is asking, not about the state of the row.
      //
      // A NULL `deleted_by` (a hand-edited store, or a row withdrawn before
      // this column existed) is treated as unattributed and the owner may
      // restore it. Failing open on an audit column is right here: it grants
      // nothing an owner did not already have, and failing closed would strand
      // an offer with nobody able to restore it.
      // ===================================================================
      const withdrawnByAnother =
        typeof listing.deleted_by === 'string' && listing.deleted_by !== profile.id;
      if (withdrawnByAnother && profile.role !== 'admin') {
        throw new DataError(
          'forbidden',
          'An administrator removed this offer. Only an administrator can restore it.',
        );
      }

      const timestamp = nowIso();
      listing.deleted_at = null;
      // Cleared with it: the pair is the withdrawal, and a published row that
      // still names who once withdrew it would let the next restore be judged
      // against a stale attribution.
      listing.deleted_by = null;
      listing.updated_at = timestamp;
      return withCoach(db, listing);
    });
  }

  async listListingRevisions(actor: Actor, listingId: string): Promise<ListingRevision[]> {
    const id = requireText(listingId, 'Offer', 200);

    // Mirrors: policies `listing_revisions_select_own_coach` +
    // `listing_revisions_select_admin`. There is no anon policy and no public
    // view: a published revision log is a published price history for every
    // offer on the site, which is strictly more than the `price_epoch` this
    // project already keeps out of the public rollups.
    return readDb((db) => {
      const profile = resolveProfile(db, actor);

      // The raw collection — an owner must still be able to read the history of
      // an offer they have withdrawn.
      const listing = db.listings.find((l) => l.id === id);
      if (!listing) throw new DataError('not_found', 'That offer could not be found.');

      if (listing.coach_id !== profile.id && profile.role !== 'admin') {
        throw new DataError('forbidden', 'You can only view the edit history of your own offers.');
      }

      return (
        db.listing_revisions
          .filter((r) => r.listing_id === listing.id)
          // `.reverse()` before a STABLE sort is the tie-break, and it is not
          // decoration: two edits saved inside the same millisecond carry the
          // same `created_at`, and Array.prototype.sort is stable, so without
          // this the pair would come back oldest-first inside an otherwise
          // newest-first list. Reversing first puts the later-appended row
          // ahead of the earlier one, and the sort then leaves that order
          // alone. In SQL the equivalent is `order by created_at desc, id desc`
          // — see the note in supabase/README.md.
          .reverse()
          .sort(byCreatedAtDesc)
          .map(copy)
      );
    });
  }

  // =========================================================================
  // Social proof
  //
  // The public/private line runs straight through this section and is the
  // easiest thing here to get wrong:
  //
  //   * the AGGREGATES (offer stats, coach stats, review lists) are public and
  //     take no actor — they publish counts and an average, never who;
  //   * the ORDERS behind them take an actor every time and are visible only to
  //     the buyer, the selling coach and an admin, because an order row says
  //     who bought what from whom.
  //
  // In SQL the same split is: `orders` has RLS with no anon policy at all,
  // while `offer_stats` / `coach_stats` are views that run as their OWNER and
  // therefore read `orders` past that RLS — publishing the aggregate without
  // publishing a single row. Same trick as `public_profiles`.
  // =========================================================================

  async getOfferStats(listingId: string): Promise<OfferStats | null> {
    if (typeof listingId !== 'string' || listingId === '') return null;
    // Mirrors: `select * from public.offer_stats where listing_id = $1`,
    // granted to anon + authenticated. The view selects
    // `from public.listings l where l.deleted_at is null`, so a withdrawn offer
    // has no stats row at all — indistinguishable from an unknown id, which is
    // what a public read of a withdrawn offer should look like.
    return readDb((db) => {
      const listing = db.listings.find((l) => l.id === listingId);
      return listing && !isWithdrawn(listing) ? offerStats(db, listing) : null;
    });
  }

  async listOfferStats(listingIds: readonly string[]): Promise<OfferStats[]> {
    if (!Array.isArray(listingIds) || listingIds.length === 0) return [];
    // Mirrors: `select * from public.offer_stats where listing_id = any($1)`.
    // Unknown ids are absent from the result because the view is a join against
    // `listings` and there is no row to join to. That is not a privacy measure
    // and must not be described as one: every returned row carries its
    // `listing_id`, so a caller does learn which ids exist — which discloses
    // nothing, because every listing is public through `getListing()` anyway.
    //
    // A withdrawn id is dropped here for the same reason an unknown one is: the
    // view it mirrors has no row for it. A browse grid therefore cannot be
    // handed stats for an offer it must not be showing in the first place.
    return readDb((db) =>
      listingIds
        .map((id) => db.listings.find((l) => l.id === id))
        .filter((listing): listing is Listing => listing !== undefined && !isWithdrawn(listing))
        .map((listing) => offerStats(db, listing)),
    );
  }

  async getCoachStats(coachId: string): Promise<CoachStats> {
    // Mirrors: `select * from public.coach_stats where coach_id = $1`. Always a
    // row: an unknown or brand-new coach is zeros with a NULL average, which is
    // the "New coach" empty state rather than an error, and reveals nothing
    // about whether the id exists.
    if (typeof coachId !== 'string' || coachId === '') {
      return { coach_id: '', rating_average: null, review_count: 0, sales_count: 0 };
    }
    return readDb((db) => coachStats(db, coachId));
  }

  async listCoachStats(coachIds: readonly string[]): Promise<CoachStats[]> {
    if (!Array.isArray(coachIds) || coachIds.length === 0) return [];
    // Mirrors: `select * from public.coach_stats where coach_id = any($1)`,
    // LEFT-joined back onto the requested ids so the batch cannot disagree with
    // getCoachStats().
    //
    // Unlike listOfferStats(), NOTHING IS DROPPED. `getCoachStats` always
    // returns a row — zeros with a NULL average for an unknown or brand-new
    // coach — and a batch that silently omitted an id would (a) break a
    // caller's zip of ids to rows, and (b) turn absence into an existence
    // oracle, which the single form deliberately is not.
    return readDb((db) =>
      coachIds.map((id) =>
        typeof id === 'string' && id !== ''
          ? coachStats(db, id)
          : { coach_id: '', rating_average: null, review_count: 0, sales_count: 0 },
      ),
    );
  }

  async listReviewsForListing(listingId: string): Promise<PublicReview[]> {
    if (typeof listingId !== 'string' || listingId === '') return [];
    // Mirrors: `select * from public.public_reviews where listing_id = $1`.
    // The `reviews` TABLE has no anon policy at all; the view is what anon
    // reads, and it is the view that drops order_id / author_id / price_epoch.
    //
    // Filtered to the listing's CURRENT epoch, so this list can never disagree
    // with the count in getOfferStats(): an offer that reads "No reviews yet"
    // must not then render twelve of them underneath.
    //
    // A withdrawn offer returns `[]` — this is the OFFER page's review list, and
    // there is no offer page. The same reviews stay readable on the coach
    // profile through listReviewsForCoach(), which has no such filter.
    return readDb((db) => {
      const listing = db.listings.find((l) => l.id === listingId);
      if (!listing || isWithdrawn(listing)) return [];
      return db.reviews
        .filter((r) => r.listing_id === listing.id && r.price_epoch === listing.price_epoch)
        .sort(byCreatedAtDesc)
        .map((review) => toPublicReview(db, review));
    });
  }

  async listReviewsForCoach(coachId: string): Promise<PublicReviewWithListing[]> {
    if (typeof coachId !== 'string' || coachId === '') return [];
    // Mirrors: `public.public_reviews`, joined to listings for the offer title.
    // Every epoch, and — like coachStats() — resolved through the raw listings
    // table, so a soft delete keeps the review readable here while its offer
    // disappears from browse. The title joins normally because the row
    // survives; no snapshot of it is needed anywhere.
    //
    // NO isWithdrawn() FILTER, deliberately, and this is the account-level pair
    // to coachStats(): adding one here would make a coach's public review list
    // disagree with their own review COUNT the moment they withdrew anything.
    return readDb((db) => {
      const listingIds = new Set(db.listings.filter((l) => l.coach_id === coachId).map((l) => l.id));
      return db.reviews
        .filter((r) => listingIds.has(r.listing_id))
        .sort(byCreatedAtDesc)
        .map((review) => ({
          ...toPublicReview(db, review),
          listing_title: listingTitle(db, review.listing_id),
        }));
    });
  }

  async getOrder(actor: Actor, orderId: string): Promise<OrderWithListing | null> {
    // Mirrors: policies `orders_select_own_learner`, `orders_select_own_coach`
    // and `orders_select_admin`. There is NO anon policy on `orders` — a public
    // order is a published purchase history.
    return readDb((db) => {
      const profile = resolveProfile(db, actor);
      if (typeof orderId !== 'string' || orderId === '') return null;

      const order = db.orders.find((o) => o.id === orderId);
      if (!order) return null;

      // Buyer, the coach who sold it, or an admin. Note the seller is taken
      // from the ORDER's coach_id, not from the listing's current owner: the
      // person entitled to see the sale is the person who made it.
      const permitted =
        order.learner_id === profile.id || order.coach_id === profile.id || profile.role === 'admin';
      if (!permitted) {
        throw new DataError('forbidden', 'You can only view your own orders.');
      }
      return withListing(db, order, profile.id);
    });
  }

  async listMyOrders(actor: Actor): Promise<OrderWithListing[]> {
    // Mirrors: policy `orders_select_own_learner` — using (learner_id = auth.uid()).
    // The buyer id comes from the resolved actor and is never a parameter, so
    // there is no shape of this call that reads somebody else's purchases.
    return readDb((db) => {
      const profile = resolveProfile(db, actor);
      return db.orders
        .filter((o) => o.learner_id === profile.id)
        .sort(byCreatedAtDesc)
        .map((order) => withListing(db, order, profile.id));
    });
  }

  async listOrdersForCoach(actor: Actor, coachId: string): Promise<OrderWithListing[]> {
    // Mirrors: policies `orders_select_own_coach` + `orders_select_admin`.
    //
    // This one takes an id rather than deriving it, so it needs the check: the
    // aggregate sales count is public (getCoachStats), but the SALES are not —
    // otherwise any visitor could list a competitor's customers by asking for
    // their coach id.
    return readDb((db) => {
      const profile = resolveProfile(db, actor);
      if (typeof coachId !== 'string' || coachId === '') return [];
      if (profile.id !== coachId && profile.role !== 'admin') {
        throw new DataError('forbidden', 'You can only view your own sales.');
      }
      return db.orders
        .filter((o) => o.coach_id === coachId)
        .sort(byCreatedAtDesc)
        .map((order) => withListing(db, order, profile.id));
    });
  }

  async createOrder(actor: Actor, listingId: string): Promise<Order> {
    const id = requireText(listingId, 'Offer', 200);

    return mutateDb((db) => {
      // Mirrors: public.claim_offer(uuid) in 0009_claim_offer.sql, rule for
      // rule and message for message.
      const profile = resolveProfile(db, actor);

      const listing = db.listings.find((l) => l.id === id);
      if (!listing) throw new DataError('not_found', 'That offer could not be found.');
      if (isWithdrawn(listing)) throw new DataError('invalid', 'That offer is no longer available.');
      if (listing.coach_id === profile.id) {
        throw new DataError('forbidden', 'You cannot claim your own offer.');
      }
      // Mirrors the check 0011_delivery.sql added to claim_offer, in the same
      // position and with the same sentence. The one thing instant delivery
      // promises is "download it now"; an offer that cannot keep that promise
      // must refuse the claim rather than let the buyer find out afterwards.
      if (listing.fulfilment === 'instant' && listing.asset_path === null) {
        throw new DataError('invalid', 'This offer is not ready to be claimed yet.');
      }
      if (db.orders.some((o) => o.learner_id === profile.id && o.listing_id === listing.id)) {
        throw new DataError('conflict', 'You have already claimed this offer.');
      }

      // Every field below is DERIVED. Nothing about the money or the epoch is
      // reachable from the caller — see the RPC for why that is the whole point.
      const order: Order = {
        id: newId(),
        learner_id: profile.id,
        listing_id: listing.id,
        coach_id: listing.coach_id,
        price_cents_at_purchase: listing.price_cents,
        price_epoch: listing.price_epoch,
        created_at: nowIso(),
      };
      db.orders.push(order);
      return copy(order);
    });
  }

  /** Mirrors: `deliverables_select_party` in 0011_delivery.sql. */
  async listDeliverables(actor: Actor, orderId: string): Promise<Deliverable[]> {
    const id = requireText(orderId, 'Order', 200);
    return readDb((db) => {
      const profile = resolveProfile(db, actor);
      const order = db.orders.find((o) => o.id === id);
      if (!order) throw new DataError('not_found', 'That order could not be found.');
      if (order.learner_id !== profile.id && order.coach_id !== profile.id) {
        throw new DataError('forbidden', 'You can only see files on your own orders.');
      }
      return db.deliverables
        .filter((d) => d.order_id === order.id)
        .sort(byCreatedAtDesc)
        .map(copy);
    });
  }

  /** Mirrors: `deliverables_insert_party`, including the `uploaded_by = auth.uid()` pin. */
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

    return mutateDb((db) => {
      const profile = resolveProfile(db, actor);
      const order = db.orders.find((o) => o.id === orderId);
      if (!order) throw new DataError('not_found', 'That order could not be found.');
      if (order.learner_id !== profile.id && order.coach_id !== profile.id) {
        throw new DataError('forbidden', 'You can only add files to your own orders.');
      }
      if (db.deliverables.some((d) => d.storage_path === storagePath)) {
        throw new DataError('conflict', 'That file has already been added.');
      }

      const deliverable: Deliverable = {
        id: newId(),
        order_id: order.id,
        // Never from input: attributing a file to the other party would let a
        // coach fabricate a buyer's submission, or the reverse.
        uploaded_by: profile.id,
        storage_path: storagePath,
        file_name: fileName,
        content_type: contentType,
        size_bytes: sizeBytes,
        created_at: nowIso(),
      };
      db.deliverables.push(deliverable);
      return copy(deliverable);
    });
  }

  /** Mirrors: `deliverables_delete_own` — own uploads only, never the other party's. */
  async removeDeliverable(actor: Actor, deliverableId: string): Promise<void> {
    const id = requireText(deliverableId, 'File', 200);
    return mutateDb((db) => {
      const profile = resolveProfile(db, actor);
      const index = db.deliverables.findIndex((d) => d.id === id);
      if (index === -1) throw new DataError('not_found', 'That file could not be found.');
      if (db.deliverables[index].uploaded_by !== profile.id) {
        throw new DataError('forbidden', 'You can only remove files you uploaded yourself.');
      }
      db.deliverables.splice(index, 1);
    });
  }

  async createReview(actor: Actor, input: CreateReviewInput): Promise<Review> {
    const orderId = requireText(input?.order_id, 'Order', 200);
    const rating = requireRating(input?.rating);
    const body = requireText(input?.body, 'Review', 2000, 3);

    return mutateDb((db) => {
      // Mirrors: policy `reviews_insert_own_purchase` —
      //   with check (
      //     author_id = auth.uid()
      //     and exists (select 1 from public.orders o
      //                  where o.id = order_id and o.learner_id = auth.uid()
      //                    and o.listing_id = listing_id)
      //     and not exists (select 1 from public.listings l
      //                      where l.id = listing_id and l.coach_id = auth.uid())
      //   )
      // plus the UNIQUE constraint on reviews.order_id.
      const profile = resolveProfile(db, actor);

      const order = db.orders.find((o) => o.id === orderId);
      if (!order) throw new DataError('not_found', 'That order could not be found.');

      // THE check. A review that does not have to prove a purchase is a
      // comment box, and this is the line that makes "Verified purchase"
      // truthful rather than decorative. `order.learner_id` is compared against
      // the RESOLVED actor — nothing the caller sent is involved.
      if (order.learner_id !== profile.id) {
        throw new DataError('forbidden', 'You can only review something you have bought.');
      }

      // NO isWithdrawn() FILTER HERE, and it matters in two ways. This lookup
      // exists to run the self-dealing check below, so filtering it would turn
      // "a coach may not review their own offer" into `not_found` on a
      // withdrawn one — weakening an authorization check to fix nothing. And it
      // matches the SQL: `reviews_insert_own_purchase` has no `deleted_at`
      // clause, so filtering here would make the mock refuse a write Postgres
      // accepts. A buyer of an offer that was later withdrawn keeps the right
      // to say what they thought of it; the review counts toward the coach's
      // ACCOUNT rating, where a withdrawn offer still counts, and appears on no
      // offer page, because there is no offer page.
      const listing = db.listings.find((l) => l.id === order.listing_id);
      if (!listing) throw new DataError('not_found', 'That offer could not be found.');

      // A coach reviewing their own offer is self-dealing even with a genuine
      // order behind it. Tested against the listing's CURRENT owner, which is
      // the authority on who profits from the review.
      if (listing.coach_id === profile.id) {
        throw new DataError('forbidden', 'You cannot review your own offer.');
      }

      // Mirrors: `reviews.order_id` UNIQUE. Enforced by the schema, not only
      // here — but checked here so the failure is a sentence rather than a
      // constraint violation. Safe under concurrency for the same reason
      // redemption is: one mutex, one draft, promoted atomically.
      if (db.reviews.some((r) => r.order_id === order.id)) {
        throw new DataError('conflict', 'You have already reviewed this purchase.');
      }

      const timestamp = nowIso();
      const review: Review = {
        id: newId(),
        order_id: order.id,
        // From the ORDER, never from input: accepting a listing_id would let a
        // caller hang a review off an offer they never bought.
        listing_id: order.listing_id,
        author_id: profile.id,
        rating,
        body,
        // From the ORDER, not from the listing's current value. A review is
        // feedback on the version that was actually bought; stamping today's
        // epoch would file a late review of an old purchase as praise (or
        // damage) for a version its author never saw, which is the leak the
        // archive exists to prevent, and it would disagree with the order row,
        // which already records the epoch it was bought at.
        //
        // ACCEPTED CONSEQUENCE, deliberate: a review of a purchase made before
        // a price rise is archived the moment it is written. It never appears
        // on the offer page — the offer really did get a fresh slate — but it
        // still counts toward the coach's account rating, where every epoch
        // counts, so the writing is never lost.
        price_epoch: order.price_epoch,
        created_at: timestamp,
        updated_at: timestamp,
      };
      db.reviews.push(review);
      return copy(review);
    });
  }

  // =========================================================================
  // Invites
  // =========================================================================

  async createInvite(actor: Actor, input: CreateInviteInput): Promise<Invite> {
    const note = optionalText(input?.note, 'Note', 200);
    const expiresAt = requireIsoTimestamp(input?.expiresAt, 'Expiry date');

    return mutateDb((db) => {
      // Mirrors: policy `invites_insert_admin` —
      //   with check (public.is_admin() and created_by = auth.uid())
      const admin = requireAdmin(db, actor);

      let code = generateInviteCode();
      while (db.invites.some((i) => i.code.toLowerCase() === code.toLowerCase())) {
        code = generateInviteCode();
      }

      const invite: Invite = {
        code,
        created_by: admin.id,
        note,
        expires_at: expiresAt,
        redeemed_by: null,
        redeemed_at: null,
        revoked_at: null,
        created_at: nowIso(),
      };
      db.invites.push(invite);
      return copy(invite);
    });
  }

  async listInvites(actor: Actor): Promise<Invite[]> {
    // Mirrors: policy `invites_select_admin` — using (public.is_admin()).
    // There is no non-admin select policy at all, so a learner cannot even
    // enumerate codes.
    return readDb((db) => {
      requireAdmin(db, actor);
      return db.invites.slice().sort(byCreatedAtDesc).map(copy);
    });
  }

  async revokeInvite(actor: Actor, code: string): Promise<Invite> {
    const needle = requireText(code, 'Invite code', 100).toLowerCase();

    return mutateDb((db) => {
      // Mirrors: policy `invites_update_admin`.
      requireAdmin(db, actor);

      const invite = db.invites.find((i) => i.code.toLowerCase() === needle);
      if (!invite) throw new DataError('not_found', 'That invite code does not exist.');
      if (invite.redeemed_by) throw new DataError('conflict', 'That invite code has already been redeemed.');
      if (invite.revoked_at) throw new DataError('conflict', 'That invite code is already revoked.');

      invite.revoked_at = nowIso();
      return copy(invite);
    });
  }

  async redeemInviteCode(actor: Actor, code: string): Promise<Profile> {
    const needle = typeof code === 'string' ? code.trim().toLowerCase() : '';

    return mutateDb((db) => {
      // Mirrors: SECURITY DEFINER function `public.redeem_invite_code(text)`.
      // A non-admin holds no privilege on `invites`; redemption is only
      // possible through this one operation, which does the whole promotion in
      // a single store mutation (the mutation is applied to a draft copy and
      // promoted atomically, so a failure part-way leaves nothing behind).
      const profile = resolveProfile(db, actor);

      if (needle === '') throw new DataError('invalid', 'Enter an invite code.');

      const invite = db.invites.find((i) => i.code.toLowerCase() === needle);

      // One undifferentiated message for unknown / revoked / expired /
      // already-redeemed, matching the SQL function: distinguishing them would
      // turn this into an oracle for guessing valid codes.
      const invalid = () => new DataError('invalid', 'That invite code is not valid.');
      if (!invite) throw invalid();
      if (invite.revoked_at) throw invalid();
      if (invite.redeemed_by) throw invalid();
      if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) throw invalid();

      const timestamp = nowIso();
      invite.redeemed_by = profile.id;
      invite.redeemed_at = timestamp;

      // The privileged half: this is why redemption lives behind a definer
      // function in SQL rather than a self-update policy on `profiles`.
      //
      // Promotion RAISES privilege, never lowers it — see promoteToCoachRole().
      // An unconditional `role = 'coach'` here demoted any admin who redeemed a
      // code, locking them out of every admin operation with no way back.
      profile.role = promoteToCoachRole(profile.role);
      profile.coach_status = 'approved';
      profile.updated_at = timestamp;

      return copy(profile);
    });
  }

  // =========================================================================
  // Coach applications
  // =========================================================================

  async createCoachApplication(actor: Actor, input: CreateCoachApplicationInput): Promise<CoachApplication> {
    const bio = requireText(input?.bio, 'Bio', 2000, 20);
    const experience = requireText(input?.experience, 'Experience', 2000, 20);
    const sport = optionalText(input?.sport, 'Sport', 80);

    return mutateDb((db) => {
      // Mirrors: SECURITY DEFINER function `public.apply_to_coach(...)`, which
      // wraps policy `coach_applications_insert_own`.
      //
      // Both halves — insert the application AND move the applicant's own
      // coach_status to 'pending_review' — happen in this one mutateDb, so
      // either both land or neither does. The SQL side has to be an RPC for
      // exactly the same reason: `coach_applications_insert_own` admits the
      // insert, but the profile write is refused by
      // guard_profile_privilege_columns, which would commit the application and
      // then leave the user wedged (the retry hits
      // coach_applications_one_pending_per_user_idx).
      const profile = resolveProfile(db, actor);

      // Mirrors: the `if v_status = 'approved'` guard inside apply_to_coach().
      if (profile.coach_status === 'approved') {
        throw new DataError('conflict', 'You are already an approved coach.');
      }

      // Mirrors: partial unique index
      // `coach_applications_one_pending_per_user_idx` (0001_init.sql).
      if (db.coach_applications.some((a) => a.user_id === profile.id && a.status === 'pending')) {
        throw new DataError('conflict', 'You already have an application awaiting review.');
      }

      const timestamp = nowIso();
      const application: CoachApplication = {
        id: newId(),
        // user_id from the resolved actor only — the `user_id = auth.uid()`
        // half of the policy.
        user_id: profile.id,
        bio,
        experience,
        sport,
        status: 'pending',
        review_note: null,
        reviewed_by: null,
        reviewed_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      };
      db.coach_applications.push(application);

      // The second half: applying moves the applicant's own profile into the
      // review state. In SQL this is the `update public.profiles set
      // coach_status = 'pending_review'` at the end of apply_to_coach(), which
      // is permitted because that function is owned by javelin_privileged.
      profile.coach_status = 'pending_review';
      profile.updated_at = timestamp;

      return copy(application);
    });
  }

  async getMyCoachApplication(actor: Actor): Promise<CoachApplication | null> {
    // Mirrors: policy `coach_applications_select_own` —
    //   using (user_id = auth.uid())
    return readDb((db) => {
      const profile = resolveProfile(db, actor);
      const application = db.coach_applications
        .filter((a) => a.user_id === profile.id)
        .sort(byCreatedAtDesc)[0];
      return application ? copy(application) : null;
    });
  }

  async listCoachApplications(actor: Actor, filter?: CoachApplicationFilter): Promise<CoachApplicationWithUser[]> {
    const status = filter?.status;

    // Mirrors: policy `coach_applications_select_admin` —
    //   using (public.is_admin())
    return readDb((db) => {
      requireAdmin(db, actor);
      return db.coach_applications
        .filter((a) => (status ? a.status === status : true))
        .sort(byCreatedAtDesc)
        .map((a) => withUser(db, a));
    });
  }

  async reviewCoachApplication(
    actor: Actor,
    applicationId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<CoachApplication> {
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new DataError('invalid', 'A review decision must be approve or reject.');
    }
    const reviewNote = optionalText(note, 'Review note', 1000);

    return mutateDb((db) => {
      // Mirrors: policy `coach_applications_update_admin` and the SECURITY
      // DEFINER function `public.review_coach_application(...)`. Only an admin
      // may write status / reviewed_by / reviewed_at; the applicant has no
      // UPDATE path to those columns at all.
      const admin = requireAdmin(db, actor);

      const application = db.coach_applications.find((a) => a.id === applicationId);
      if (!application) throw new DataError('not_found', 'That application could not be found.');

      // Mirrors: the `You cannot review your own application` guard in
      // review_coach_application(). Self-approval defeats the point of a review
      // queue, and it was also the route by which an admin could promote
      // themselves and — before the promoteToCoachRole() fix — get demoted out
      // of their own admin role.
      if (application.user_id === admin.id) {
        throw new DataError('forbidden', 'You cannot review your own application.');
      }

      // Mirrors: `and a.status = 'pending'` in the SQL update — a second
      // reviewer cannot overwrite the first decision.
      if (application.status !== 'pending') {
        throw new DataError('conflict', 'That application has already been reviewed.');
      }

      const timestamp = nowIso();
      application.status = decision;
      application.review_note = reviewNote;
      application.reviewed_by = admin.id;
      application.reviewed_at = timestamp;
      application.updated_at = timestamp;

      // The decision is mirrored onto the applicant's profile in the same
      // mutation, exactly as the SQL function does inside one transaction.
      const applicant = db.profiles.find((p) => p.id === application.user_id);
      if (applicant) {
        applicant.coach_status = decision === 'approved' ? 'approved' : 'rejected';
        // Promotion RAISES privilege only — see promoteToCoachRole(). Rejection
        // never touches role at all.
        if (decision === 'approved') applicant.role = promoteToCoachRole(applicant.role);
        // ===================================================================
        // THE ONE-TIME COPY. This is the only line in the codebase that moves
        // text out of `coach_applications` and into anything public.
        //
        // It is a COPY AT APPROVAL, not a live join, and the difference is the
        // whole design. `coach_applications.bio` is a review artifact readable
        // only by its author and by admins; a public coach profile that SELECTed
        // it would republish the applicant's private text on every edit, for
        // ever, with no moment at which anyone decided to publish anything. A
        // snapshot taken once, at the moment approval makes someone a public
        // seller, is a single decidable event — and from then on the coach owns
        // the column and can rewrite or clear it.
        //
        // ONLY WHEN THE TARGET IS EMPTY. A coach who was approved, wrote their
        // own bio, was later un-approved and re-approved must not have their own
        // words replaced by an old application. Empty is the only state where
        // there is nothing to lose.
        //
        // Only `bio` is copied. `experience` is prose written to a reviewer
        // ("UKA Level 2 since 2019") and is not a headline; `sport` is not a
        // dimension in this product at all; and no integer can be recovered from
        // free text, so `coach_years_coaching` stays NULL for the coach to fill
        // in. An approved coach with an empty headline is a real state the UI
        // renders — see Nils Berg in the seed.
        // ===================================================================
        if (decision === 'approved' && !hasCoachBio(applicant)) {
          applicant.coach_bio = application.bio;
        }
        applicant.updated_at = timestamp;
      }

      return copy(application);
    });
  }
}
