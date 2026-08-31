/**
 * =============================================================================
 * `DataClient` — the swap surface.
 * =============================================================================
 *
 * This interface is the ONLY thing the rest of the app is allowed to know about
 * persistence. Pages, server actions and route handlers call
 * `getDataClient()` (from `@/lib/data`) and talk to this interface. Today the
 * concrete implementation is a JSON-file mock; a later phase adds
 * `SupabaseDataClient` implementing the same methods against
 * `@supabase/supabase-js`. **No calling code changes when that happens** — only
 * `DATA_BACKEND` in `.env.local` flips.
 *
 * -----------------------------------------------------------------------------
 * The actor rule (read this before writing any calling code)
 * -----------------------------------------------------------------------------
 * Every mutating method takes an `Actor` as its FIRST argument:
 *
 *     export type Actor = { userId: string } | null;   // null = anonymous
 *
 * An `Actor` carries a user id and nothing else. It deliberately cannot carry a
 * role or a coach status. The data layer resolves those from the store on every
 * single call and never trusts anything the caller says about them. This
 * mirrors Postgres RLS, where policies may trust `auth.uid()` and nothing else.
 *
 * Concretely, this is wrong and will not compile:
 *
 *     // ✗ there is no such thing as passing a role in
 *     await db.createListing({ userId, role: 'coach' }, input);
 *
 * and this is wrong even though it compiles:
 *
 *     // ✗ do not gate on the session cookie and skip the data layer's check —
 *     //   the check below is not yours to make, and duplicating it in the UI
 *     //   does not replace it
 *     if (session.role === 'coach') await db.createListing(actor, input);
 *
 * Just call the method. If the actor is not permitted, it throws a `DataError`
 * with a user-safe message; render that. The UI may *additionally* hide
 * controls the user cannot use — that is presentation, not authorization.
 *
 * -----------------------------------------------------------------------------
 * Error handling
 * -----------------------------------------------------------------------------
 * Every method throws `DataError` and only `DataError` for expected failures:
 *
 *     import { getDataClient } from '@/lib/data';
 *     import { isDataError } from '@/lib/data/types';
 *
 *     try {
 *       await db.createListing(actor, input);
 *     } catch (error) {
 *       if (isDataError(error)) {
 *         // error.code: 'unauthorized' | 'forbidden' | 'not_found' | 'invalid' | 'conflict'
 *         // error.message is safe to show the user verbatim.
 *         return { error: error.message };
 *       }
 *       throw error;
 *     }
 *
 * `dataErrorStatus(code)` maps a code onto an HTTP status for route handlers.
 *
 * Read methods that "find nothing" return `null` or `[]` rather than throwing;
 * only `not_found` on an operation that targets a specific row throws.
 *
 * -----------------------------------------------------------------------------
 * Authorization summary (enforced in code AND by RLS)
 * -----------------------------------------------------------------------------
 *   listListings / getListing / listCategories   public, no actor
 *                                                (published offers only)
 *   listListingsByCoach / getPublicProfile       public (no email exposed)
 *   listCoaches / getPublicCoach                 public — APPROVED COACHES
 *                                                ONLY, filtered in the data
 *                                                layer, never by the caller
 *   updateMyCoachProfile                         the actor's own row, and only
 *                                                while approved — never admin
 *   getListingForViewer                          public for a published offer;
 *                                                a withdrawn one is visible to
 *                                                the owner, an admin and any
 *                                                holder of an order for it,
 *                                                and 404 to everyone else
 *   listMyListings                               the actor's own offers,
 *                                                withdrawn ones included
 *   updateListing                                the owner, NEVER an admin
 *   softDeleteListing                            the owner, OR an admin
 *   restoreListing                               an admin; or the owner, but
 *                                                only if the owner is who
 *                                                withdrew it — a coach lifting
 *                                                an ADMIN takedown is forbidden
 *   listListingRevisions                         the owner, or an admin
 *   getOfferStats / listOfferStats / getCoachStats / listCoachStats
 *                                                public — AGGREGATES only
 *   listReviewsForListing / listReviewsForCoach  public — a PROJECTION
 *                                                (`PublicReview`: no order_id,
 *                                                no author_id, no epoch)
 *   getOrder                                     buyer, selling coach, or admin
 *   listMyOrders                                 the actor's own purchases
 *   listOrdersForCoach                           that coach, or an admin
 *   createReview                                 owner of an unreviewed order
 *   listReviewsForModeration / removeReview / listRemovedReviews
 *                                                stored role === 'admin'. Removal
 *                                                DELETES the row after archiving
 *                                                it, and there is deliberately no
 *                                                method that EDITS a review
 *   getProfile                                   self, or an admin actor
 *   createListing                                stored coach_status === 'approved'
 *   createInvite / listInvites / revokeInvite    stored role === 'admin'
 *   listCoachApplications / reviewCoachApplication
 *                                                stored role === 'admin'
 *   createCoachApplication / getMyCoachApplication / redeemInviteCode
 *                                                any signed-in actor
 *
 * Six invariants that are easy to violate and expensive to get wrong:
 *   1. NEVER render a `Profile` on a public page — it carries `email`. Use
 *      `getPublicProfile()` / `PublicProfile`, or `getPublicCoach()` /
 *      `listCoaches()` / `PublicCoach` for the coach directory. All three
 *      mirror SQL views and none has an email column at all. Review authors
 *      arrive pre-projected as `author_name` for the same reason.
 *   2. Becoming a coach only ever RAISES privilege. An admin who redeems an
 *      invite code or is approved as a coach stays an admin.
 *   3. The sales COUNT is public; the ORDERS behind it are not. Every `Order`
 *      read takes an actor and is scoped to buyer / selling coach / admin.
 *      There is deliberately no method that lists orders for the public — and
 *      no public shape carries an `order_id`, which would be a valid argument
 *      to one of those scoped reads.
 *   4. EVERY PUBLIC LISTING READ FILTERS `deleted_at is null`, and the
 *      ACCOUNT-LEVEL aggregates deliberately do NOT. Missing a filter
 *      republishes a withdrawn offer; adding one to `getCoachStats` /
 *      `listReviewsForCoach` erases a coach's reputation the moment they
 *      withdraw anything. Both directions are asserted in
 *      `scripts/verify-authz.mts`.
 *   5. NO WRITE PATH CAN STORE A RATING OF `0`, and `rating_average` is `null`
 *      rather than `0` when there are no reviews — so "unrated" can never be
 *      rendered as "0.0". Stated as a property of the write paths on purpose:
 *      the mock store is an unvalidated JSON file (see `docs/DATA-LAYER.md`),
 *      so a hand-edited `db.json` holding `rating: 0` would average to 0, the
 *      same way a hand-edited `price_cents: "free"` would render as written.
 *   6. THE COACH DIRECTORY FILTERS TO APPROVED COACHES SERVER-SIDE, and there
 *      is no caller-supplied predicate that widens it. Never rebuild it as a
 *      client-side filter over a wider read: that would ship every learner's
 *      row to the browser while looking identical on screen. `PublicCoach`
 *      carries no `role` and no `coach_status`, so the shape cannot leak them
 *      either — the row's mere existence is the approval.
 *
 * See `docs/DATA-LAYER.md` for the long-form guide and `supabase/README.md` for
 * the check-to-policy mapping table.
 *
 * -----------------------------------------------------------------------------
 * Server only
 * -----------------------------------------------------------------------------
 * This module tree touches the filesystem and `node:crypto`. Import it from
 * server components, server actions and route handlers only. The mock store
 * throws at runtime if it is ever evaluated in a browser.
 */

import type {
  Actor,
  AdminActionWithNames,
  ApplicationStatus,
  CoachApplication,
  CoachApplicationWithUser,
  CoachStats,
  CoachStatus,
  FulfilmentMode,
  Invite,
  ListingCategory,
  ListingDetail,
  ListingRevision,
  ListingWithCoach,
  ModeratableReview,
  OfferStats,
  OwnedListing,
  Deliverable,
  Order,
  OrderWithListing,
  Profile,
  PublicCoach,
  PublicProfile,
  PublicReview,
  PublicReviewWithListing,
  RemovedReviewWithNames,
  Report,
  ReportReason,
  ReportStatus,
  ReportWithContext,
  Review,
} from './types';
import type { Page, PageRequest } from './pagination';

/** Input to {@link DataClient.signUp}. */
export interface SignUpInput {
  email: string;
  password: string;
  fullName: string;
}

/**
 * What {@link DataClient.signUp} produced.
 *
 * A DISCRIMINATED UNION rather than a nullable profile, for the same reason
 * {@link ListingDetail} is one: the caller cannot forget the second case. With
 * email confirmation ON — which is the supported configuration now that
 * `/auth/callback` exists — a successful signup returns NO SESSION, and code
 * that assumed a `Profile` would try to sign the user in with nothing.
 *
 * `confirm_email` is a SUCCESS. It was previously reported by throwing
 * `DataError('invalid', 'Your account was created…')`, which rendered a red
 * failure alert over a form whose submission had worked — the account existed,
 * the mail was sent, and the screen said something went wrong.
 */
export type SignUpResult =
  /** A session exists. The caller signs them in and redirects. */
  | { status: 'signed_in'; profile: Profile }
  /**
   * The account exists and GoTrue has emailed a confirmation link. There is no
   * session and no profile to hand back — the row exists, but reading it needs
   * an authenticated context this caller does not have.
   */
  | { status: 'confirm_email'; email: string };

/**
 * What {@link DataClient.requestEmailChange} produced.
 *
 * A union for the same reason {@link SignUpResult} is one, and the two arms are
 * a genuine difference in what happened rather than a difference in wording:
 *
 *   `confirm_email`  nothing has changed yet. GoTrue has sent a link — to BOTH
 *                    addresses, with "Secure email change" on — and the change
 *                    lands only when they are confirmed. This is the Supabase
 *                    answer, always.
 *   `changed`        the address is already different. This is the mock, which
 *                    has no mail and therefore nothing to confirm.
 *
 * A caller that assumed one shape would either tell a Supabase user their
 * address had changed when it had not, or send a mock user to check an inbox
 * that will stay empty.
 */
export type EmailChangeResult =
  | { status: 'confirm_email'; email: string }
  | { status: 'changed'; profile: Profile };

/** Input to {@link DataClient.signInWithPassword}. */
export interface SignInInput {
  email: string;
  password: string;
}

/** Filter for {@link DataClient.listListings}. */
export interface ListingFilter {
  /** Free-text keyword, matched case-insensitively against title + description. */
  q?: string;
  /**
   * Exact category match, by SLUG. A value outside the taxonomy matches nothing
   * — it is not free text, so there is nothing for it to match.
   */
  category?: ListingCategory;
  /**
   * Inclusive price floor, in cents. Omitted means no floor.
   *
   * Cents, like every other price in this codebase, and the reason is the one
   * `Listing.price_cents` gives: a filter in pounds would have to divide, and a
   * divide is where a rounding rule gets invented that disagrees with the one
   * used to display the price.
   */
  minPriceCents?: number;
  /** Inclusive price ceiling, in cents. Omitted means no ceiling. */
  maxPriceCents?: number;
  /**
   * How to order the results. Omitted means `'newest'`.
   *
   * Each value has its own keyset — see `KEYSETS` — so a cursor minted under one
   * sort is refused under another and the reader falls back to page one. That is
   * the correct behaviour: the positions mean different things.
   */
  sort?: ListingSort;
}

/**
 * The browse orderings.
 *
 * Deliberately three, and deliberately not "highest rated": a rating lives in
 * `offer_stats`, which is a separate aggregate keyed by listing, so sorting by
 * it means either a join this read does not have or an in-memory sort of the
 * whole table — and the second is exactly what pagination exists to prevent.
 */
export type ListingSort = 'newest' | 'price_asc' | 'price_desc';

export const LISTING_SORTS: readonly ListingSort[] = ['newest', 'price_asc', 'price_desc'];

export function isListingSort(value: unknown): value is ListingSort {
  return typeof value === 'string' && (LISTING_SORTS as readonly string[]).includes(value);
}

/** Input to {@link DataClient.createListing}. `coach_id` is NOT accepted — it always comes from the actor. */
export interface CreateListingInput {
  title: string;
  description: string;
  price_cents: number;
  /** One of the eight taxonomy slugs. Anything else is `invalid`. */
  category: ListingCategory;
  /**
   * How the offer will be delivered. Omitted means `'personalised'`, which is
   * the column default in SQL and the only honest value for an offer with
   * nothing attached yet.
   *
   * `asset_path` is NOT here and must not be added: the path is pinned under
   * the listing's own id, and that id does not exist until this call returns.
   * Attaching the file is a second step — {@link DataClient.setListingAsset}.
   */
  fulfilment?: FulfilmentMode;
}

/**
 * Input to {@link DataClient.updateListing}.
 *
 * Exactly the four editable columns. Note what is NOT here, and do not add it:
 * `id` (the row keeps its identity, which is what lets its reviews and orders
 * keep pointing at it), `coach_id` (ownership is not transferable through an
 * edit) and `price_epoch` (derived — see {@link DataClient.updateListing}).
 */
export interface UpdateListingInput {
  title: string;
  description: string;
  price_cents: number;
  /** One of the eight taxonomy slugs. Anything else is `invalid`. */
  category: ListingCategory;
  /**
   * The delivery mode, or omitted to leave it as it is.
   *
   * OPTIONAL ON PURPOSE, unlike the four columns above. A caller that predates
   * instant delivery — or simply does not offer the control — must not silently
   * reset an offer to `personalised` and orphan its file, so "not sent" means
   * "unchanged" rather than "default".
   *
   * Switching to `personalised` CLEARS `asset_path`, because
   * `listings_asset_path_shape` forbids a personalised offer from holding one.
   * Switching in either direction is refused once the offer has been claimed —
   * see {@link Listing.fulfilment}.
   */
  fulfilment?: FulfilmentMode;
}

/**
 * Input to {@link DataClient.updateMyProfile}.
 *
 * ONE COLUMN, and the shape is the point: `full_name` is the only thing on
 * `profiles` that its owner may edit and that is not either a privilege or an
 * identity. `role` and `coach_status` are privileges, `id` and `email` are
 * identity, and `guard_profile_privilege_columns` refuses all four from an API
 * session. The three coach columns are content too, but they belong to
 * {@link DataClient.updateMyCoachProfile} because only an approved coach may
 * write them.
 *
 * A named input rather than a bare string so the shape has somewhere to grow —
 * a pronoun field, a locale — without another method.
 */
export interface UpdateMyProfileInput {
  full_name: string;
}

/** Input to {@link DataClient.createInvite}. */
export interface CreateInviteInput {
  note?: string;
  /** ISO-8601 timestamp, or null/omitted for a code that never expires. */
  expiresAt?: string | null;
}

/** Input to {@link DataClient.createCoachApplication}. `user_id` is NOT accepted — it always comes from the actor. */
export interface CreateCoachApplicationInput {
  bio: string;
  experience: string;
  sport?: string;
}

/** Filter for {@link DataClient.listCoachApplications}. */
export interface CoachApplicationFilter {
  status?: ApplicationStatus;
}

/**
 * Filter for {@link DataClient.listCoaches}.
 *
 * A NAME KEYWORD AND NOTHING ELSE, on purpose. There is deliberately no
 * `status`, `role` or `is_approved_coach` parameter: the read is hard-filtered
 * to approved coaches and the only way to keep it from becoming a privilege
 * enumerator is for the caller to have no say in that predicate at all. See
 * {@link PublicCoach}.
 *
 * There is no `sport` either — there is exactly one sport.
 */
export interface CoachDirectoryFilter {
  /** Free-text keyword, matched case-insensitively against `full_name` only. */
  q?: string;
}

/**
 * Input to {@link DataClient.updateMyCoachProfile}.
 *
 * All three fields are required to be PRESENT and are all nullable: this is a
 * whole-record write, so omitting one is not "leave it alone", it is a type
 * error. A partial-update shape would make "clear my headline" and "do not
 * touch my headline" the same request.
 *
 * Note what is NOT here, and do not add it: `id` / `user_id` (the subject is
 * always the resolved actor), `full_name`, `email`, `role` and `coach_status`.
 * The last two are the privilege pair `guard_profile_privilege_columns` exists
 * to pin, and this method must never become the way around it.
 */
export interface UpdateMyCoachProfileInput {
  /** One line under the name; `null` or `''` clears it. */
  coach_headline: string | null;
  /** The public bio; `null` or `''` clears it. */
  coach_bio: string | null;
  /** Whole years 0–80, or `null` for "not stated". `0` is a real answer, not an absence. */
  coach_years_coaching: number | null;
}

/**
 * Input to {@link DataClient.createReview}.
 *
 * Note what is NOT accepted, and do not add it: `author_id`, `listing_id` and
 * `price_epoch`. All three are resolved server-side from the order the actor
 * proves they own — accepting a `listing_id` would let a caller attach a review
 * to a different offer than the one they bought, which is the same class of bug
 * as accepting a `coach_id` on `createListing`.
 */
export interface AddDeliverableInput {
  order_id: string;
  /** Object path in the private `deliverables` bucket. */
  storage_path: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
}

export interface CreateReviewInput {
  /** The purchase being reviewed. The actor must own it, and it must be unreviewed. */
  order_id: string;
  /** An integer from 1 to 5. `4.5`, `0`, `6` and `'5'` are all `invalid`. */
  rating: number;
  body: string;
}

export interface DataClient {
  // ---------------------------------------------------------------------------
  // Auth-shaped. The Supabase implementation delegates these to `supabase.auth.*`;
  // the mock implements them over a local `auth_users` collection that mirrors
  // Supabase's `auth.users` table.
  // ---------------------------------------------------------------------------

  /**
   * Creates an auth user and its `profiles` row (`role: 'learner'`,
   * `coach_status: 'none'`) and returns the profile.
   * @throws DataError `invalid` on bad input, `conflict` if the email is taken.
   */
  /**
   * Creates an account.
   *
   * Returns a {@link SignUpResult}, NOT a `Profile`: with email confirmation on
   * there is no session at the end of a successful signup, and the two outcomes
   * are both successes. See that type.
   *
   * The two backends differ completely here, as they do for
   * `signInWithPassword` and `updateMyPassword` — the mock has no mail and
   * therefore always returns `signed_in`.
   */
  signUp(input: SignUpInput): Promise<SignUpResult>;

  /**
   * Verifies a password. Returns the profile on success and `null` on bad
   * credentials — it does NOT throw, so callers cannot accidentally distinguish
   * "no such email" from "wrong password" in an error message.
   */
  signInWithPassword(input: SignInInput): Promise<Profile | null>;

  /**
   * Replaces the SIGNED-IN actor's password. Never takes a user id.
   *
   * The third member of the family whose internals differ completely between
   * the backends — `signUp` and `signInWithPassword` are the other two, and
   * `supabase/README.md` already records the split: the mock keeps scrypt
   * hashes in `auth_users`, Supabase owns `auth.users` and we never see them.
   *
   * NO CURRENT PASSWORD, and that is a scope decision rather than an oversight.
   * The one caller is the reset flow, where the user has just proved control of
   * their inbox precisely because they do NOT know the old password. A
   * change-password-while-signed-in form would want the old one and should ask
   * for it there — this method would still be what it calls.
   *
   * The session is therefore the whole authorization, which puts weight on how
   * a session gets created: see `src/lib/auth/password-reset.ts`, where a reset
   * link is single-use, short-lived, and stored as a hash.
   *
   * WHAT IT CANNOT DO, in either backend: sign out this user's OTHER sessions.
   * The mock session is a self-contained signed cookie with no revocation list,
   * so a stolen one survives a password change — recorded as a known divergence
   * in `supabase/README.md` rather than papered over.
   */
  updateMyPassword(actor: Actor, newPassword: string): Promise<void>;

  /**
   * The FULL profile row, including email. Readable only by its owner and by
   * admins — anyone else gets `forbidden`.
   * @throws DataError `unauthorized` when anonymous, `forbidden` when `userId`
   * is neither the actor nor readable by an admin actor.
   */
  getProfile(actor: Actor, userId: string): Promise<Profile | null>;

  /**
   * The public projection: exactly `id`, `full_name`, `is_approved_coach`.
   * No `email`, and deliberately no `role` or `coach_status`: publishing
   * `role` to anonymous callers would enumerate every administrator, and
   * `coach_status` would make every rejected application world-readable. Use
   * `is_approved_coach` for a verified-coach badge. This is what public pages
   * must render. No actor required.
   */
  getPublicProfile(userId: string): Promise<PublicProfile | null>;

  // ---------------------------------------------------------------------------
  // The public coach directory
  //
  // Both reads are hard-filtered to `coach_status = 'approved'` INSIDE the data
  // layer. There is no parameter, no filter and no actor that widens either of
  // them, which is what stops the directory becoming an enumerator for `role`
  // or `coach_status` — see `PublicCoach`.
  //
  // Never filter these client-side over a wider read. "Fetch every profile and
  // keep the coaches" would ship every learner's row to the browser, and it is
  // the shape of bug that is invisible in the rendered page.
  // ---------------------------------------------------------------------------

  /**
   * Several public profiles at once, by id — the batch form of
   * {@link getPublicProfile}, and the same shape of trade as
   * {@link listOfferStats}: one read for a grid instead of one per card.
   *
   * NOT PAGINATED, and it is the only unbounded-looking read that is not. The
   * caller supplies the ids, so the result is bounded by the page that asked for
   * it — pagination here would mean a caller could ask about 24 coaches and be
   * told about 12, which is a worse contract than the one it replaced.
   *
   * IDS IT CANNOT RESOLVE ARE DROPPED, so match by id and never by position. A
   * deleted account has no `public_profiles` row.
   *
   * WHY A BROWSE GRID NEEDS THIS. A coach name is a link only when the coach is
   * approved, because `/coaches/[id]` is a 404 otherwise — and an offer can
   * outlive its author's approval (redeem an invite, publish, then have a still
   * open application rejected). The grid used to learn that from the whole coach
   * directory; once that directory is a page, a coach on page 3 would silently
   * stop being a link. `is_approved_coach` per id is the fact the grid actually
   * needs.
   */
  listPublicProfiles(userIds: readonly string[]): Promise<PublicProfile[]>;

  /**
   * The coach directory: every APPROVED coach, newest first, optionally
   * narrowed by a name keyword. Public — no actor.
   *
   * Returns {@link PublicCoach}, which carries no `email`, no `role`, no
   * `coach_status` and nothing from `coach_applications`.
   *
   * `q` matches `full_name` case-insensitively and NOTHING ELSE — not the
   * headline, not the bio. That is the same narrowing rule `listListings`
   * follows: `profiles_full_name_trgm_idx` is the only index Postgres has for
   * this query, so matching more here would make the mock quietly the more
   * capable of the two backends and change results at the swap.
   *
   * Newest first, matching `order by created_at desc`, rather than
   * alphabetically: `full_name` ordering depends on the database's collation,
   * which the mock cannot reproduce for non-ASCII names, and a directory whose
   * order changes at the backend swap is worse than one that is not
   * alphabetical.
   */
  listCoaches(filter?: CoachDirectoryFilter, page?: PageRequest): Promise<Page<PublicCoach>>;

  /**
   * One public coach profile. Public — no actor.
   *
   * `null` when the id is unknown **or the subject is not an approved coach**.
   * The two are deliberately indistinguishable, and a `null` rather than a
   * throw: a refusal would separate "no such person" from "that person is not a
   * coach", and the second is a fact about someone's `coach_status`.
   *
   * It discloses no more than `getPublicProfile(id).is_approved_coach` already
   * does, and strictly less than the raw enum: a learner, a pending applicant,
   * a rejected applicant and an admin all return exactly `null`.
   */
  getPublicCoach(coachId: string): Promise<PublicCoach | null>;

  /**
   * The coach's own public copy — headline, public bio, years coaching.
   *
   * SELF ONLY, AND AN APPROVED COACH ONLY. Not an admin, and this is the same
   * asymmetry {@link updateListing} carries and for the same reason: an
   * administrator silently rewriting a coach's bio publishes words under that
   * coach's byline that the coach never wrote. A moderator can withdraw an
   * offer; they do not author one.
   *
   * The subject is the RESOLVED actor and is never a parameter, so there is no
   * shape of this call that writes to somebody else's profile — the same
   * construction as `listMyListings` / `listMyOrders`.
   *
   * It writes exactly the three coach columns. `role`, `coach_status`, `id`,
   * `email` and `full_name` are untouched, which is the code-side mirror of
   * `guard_profile_privilege_columns`.
   *
   * Returns the actor's full {@link Profile} — their own row, which they may
   * already read. It is NOT a public shape: do not render it on a public page.
   *
   * @throws DataError `unauthorized` when anonymous, `forbidden` unless the
   * actor's STORED `coach_status` is `'approved'`, `invalid` on bad input.
   */
  updateMyCoachProfile(actor: Actor, input: UpdateMyCoachProfileInput): Promise<Profile>;

  /**
   * Points the actor's profile at an avatar, or clears it with `null`.
   *
   * **A PATH CROSSES THIS BOUNDARY, NEVER A FILE.** Storing bytes is a
   * different subsystem with a different backing store — see
   * `src/lib/storage/avatars.ts` — and only Supabase implements it. This method
   * is an ordinary column write that both backends do identically, which is
   * what keeps the split honest: the mock has no file storage, and it does not
   * pretend to.
   *
   * The path is pinned to `<the actor's own id>/…` here, again in the
   * `profiles_avatar_path_shape` CHECK constraint, and a third time by the
   * storage policies that govern the object itself. A Server Action is a public
   * endpoint and this column is written through `profiles_update_own` like any
   * other self-service field, so none of those three is redundant.
   *
   * Available to ANY signed-in user, not only approved coaches: `profiles` is
   * everyone's row, and the SQL agrees. Only the UI is coach-facing today.
   */
  setMyAvatar(actor: Actor, path: string | null): Promise<Profile>;

  /**
   * Renames the signed-in actor. Available to EVERYONE, coach or not.
   *
   * `full_name` had no write path at all before this: it was taken from the
   * signup form (or from the local part of the email) and never editable again,
   * for any role. It is also the name attached to every review that person has
   * written, and to their card in the coach directory if they have one, so
   * "never editable" was not a small gap.
   *
   * Deliberately NOT guarded in SQL, and `guard_profile_privilege_columns` says
   * so in as many words: it is "profile CONTENT with no privilege attached",
   * bounded by the column constraints rather than by the guard. That is what
   * makes this an ordinary column write — and it is also why the LENGTH rules
   * live here in application code, shared by both backends, since
   * `profiles.full_name` carries no CHECK of its own.
   *
   * The subject is the resolved actor and is never a parameter, so there is no
   * shape of this call that renames somebody else.
   */
  updateMyProfile(actor: Actor, input: UpdateMyProfileInput): Promise<Profile>;

  /**
   * Changes the signed-in actor's password, having first proved they know the
   * current one.
   *
   * THE SIBLING OF {@link updateMyPassword}, and the difference is the whole
   * reason both exist. That one takes no current password because its caller is
   * the reset flow, where the user has just proved control of their inbox
   * precisely to say that they do not have one. This one is for a person who IS
   * signed in, where a session alone is a weaker claim: a borrowed laptop or a
   * stolen cookie should not be enough to lock the owner out of their own
   * account.
   *
   * Refuses when the new password equals the current one — GoTrue refuses it
   * too, and the mock must not be the more permissive of the two.
   *
   * Rate-limited by the caller rather than here: verifying the current password
   * costs a scrypt hash on the mock and a full sign-in round trip on Supabase,
   * so a wrong-password loop is expensive on both.
   */
  changeMyPassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void>;

  /**
   * Starts a change of the address the actor signs in with.
   *
   * **THE ADDRESS IS ON `auth.users`, and `profiles.email` is a copy of it.**
   * That copy is written once at signup and pinned against every client write
   * by `guard_profile_privilege_columns` — so nothing in this interface writes
   * it, and nothing should. `0017` adds the `AFTER UPDATE OF email` trigger
   * that keeps the two in step, which is the only writer after signup.
   *
   * On Supabase this returns `confirm_email` and NOTHING HAS CHANGED YET: with
   * "Secure email change" on, GoTrue mails both the old and the new address and
   * applies the change only when both confirm. That is deliberate — an attacker
   * holding a borrowed session should not be able to move an account to their
   * own inbox in one click, which is exactly what a single-step change is.
   *
   * The mock has no mail and returns `changed`.
   *
   * Refuses an address that is already registered, on the mock. Supabase's
   * answer for that case is GoTrue's, which with email-enumeration protection
   * on may report success and simply send nothing — see the note in the
   * implementation. Neither backend confirms to a caller that some other
   * account holds an address.
   */
  requestEmailChange(actor: Actor, newEmail: string): Promise<EmailChangeResult>;

  /**
   * Deletes the actor's own account, by ANONYMISING it rather than erasing it.
   *
   * The foreign-key graph makes erasure either impossible or destructive:
   * `listings.coach_id` cascades while `orders.listing_id` is `ON DELETE
   * RESTRICT`, so a coach who has ever sold cannot be removed at all — and a
   * learner who could would take their purchases and reviews with them,
   * reducing some coach's sales count and rating. Deleting one person's data
   * must not rewrite another's history. `0018_delete_my_account.sql` works
   * through the whole graph.
   *
   * So: the row survives with its personal data replaced. Name, email, picture
   * and the three coach columns go; role and coach status drop to
   * learner/none, which removes a departed coach from the directory with no
   * extra predicate anywhere; `deleted_at` is stamped.
   *
   * **REFUSES WHILE ANY OF THEIR OFFERS IS STILL ON SALE.** The caller withdraws
   * them first. That is not politeness — the SQL function physically cannot
   * withdraw them, because `guard_listing_update()` calls `auth.uid()` and the
   * privileged role that owns the function cannot reach the `auth` schema. The
   * refusal turns the ordering into an invariant the database enforces rather
   * than a convention the caller remembers.
   *
   * **AN ADMINISTRATOR CANNOT DELETE THEMSELVES**, and that is the accepted
   * answer: `invites.created_by` is `ON DELETE RESTRICT` because an invite is
   * the record of who granted somebody coach status, and weakening that to
   * enable a rare flow is the wrong trade. One administrator removes another.
   *
   * Idempotent. A second call on an already-deleted account succeeds silently,
   * so a retry after a partial failure is safe.
   *
   * **This does NOT kill the credential.** Neither backend can: on Supabase the
   * GoTrue user lives in a schema the privileged role cannot reach, and on the
   * mock the session is a cookie this app signs. `src/lib/auth/account-deletion.ts`
   * bans the one, and `resolveProfile` refusing a deleted profile closes both.
   */
  deleteMyAccount(actor: Actor): Promise<void>;


  // ---------------------------------------------------------------------------
  // Listings
  // ---------------------------------------------------------------------------

  /**
   * Public browse/search. Newest first.
   *
   * WITHDRAWN OFFERS ARE NOT INCLUDED. Every public read of a listing filters
   * `deleted_at is null`; missing one of them silently republishes a withdrawn
   * offer. See {@link Listing.deleted_at} for the full list.
   */
  listListings(filter?: ListingFilter, page?: PageRequest): Promise<Page<ListingWithCoach>>;

  /**
   * Public listing detail. `null` when the id is unknown **or the offer has
   * been withdrawn** — a withdrawn offer is a 404 for the public.
   *
   * If you are rendering an offer page, use {@link getListingForViewer}
   * instead: it returns the same thing for a published offer and a tombstone,
   * rather than a 404, for the people entitled to one (the owner, an admin and
   * anyone holding an order for it).
   */
  getListing(id: string): Promise<ListingWithCoach | null>;

  /**
   * One offer as a PARTICULAR VIEWER may see it — the read an offer detail page
   * should use.
   *
   * Returns `{ state: 'published', listing }` to anyone, including anonymous
   * callers, for an offer that is on sale. For a withdrawn offer it returns
   * `{ state: 'withdrawn', listing, withdrawn_at }` to the coach who owns it,
   * to an admin, and to anyone holding an order for it, so a buyer's purchase
   * history does not link into a dead end — and `null` to everyone else.
   *
   * `null`, never a throw, for an unknown id and for a viewer who may not see a
   * withdrawn offer: a refusal would confirm that something once existed there.
   * See {@link ListingDetail} for the full table.
   */
  getListingForViewer(actor: Actor, id: string): Promise<ListingDetail | null>;

  /**
   * The WHOLE taxonomy — all eight slugs, in the fixed display order of
   * `LISTING_CATEGORIES`, with `other` last.
   *
   * This deliberately does NOT return "the distinct values currently in use".
   * The category set is fixed, so a filter built from what happens to be
   * published would hide half the taxonomy on a fresh install and grow options
   * as listings appear — a browse page whose controls change shape depending on
   * inventory. Callers render `LISTING_CATEGORY_LABELS[slug]`, never the slug.
   *
   * It stays on the interface (rather than becoming a UI constant) so the
   * Supabase implementation can serve it from `enum_range(null::listing_category)`
   * and remain the single source of truth when the backend flips.
   */
  listCategories(): Promise<ListingCategory[]>;

  /**
   * Every PUBLISHED listing owned by one coach — the public coach profile's
   * offer list. Withdrawn offers are excluded. Public data; `actor` is accepted
   * for interface symmetry.
   *
   * This is deliberately NOT dual-mode. A coach's own dashboard, which must see
   * withdrawn offers in order to restore them, calls {@link listMyListings},
   * which derives the coach id from the actor and cannot be pointed at anyone
   * else.
   */
  listListingsByCoach(actor: Actor, coachId: string, page?: PageRequest): Promise<Page<ListingWithCoach>>;

  /**
   * Every listing owned by one coach, **withdrawn ones included** — the read
   * `/admin/coaches` renders, and the third listing-by-coach shape in this
   * interface. The other two exist for different callers and neither can serve
   * this one: {@link listListingsByCoach} is public and hides withdrawn offers,
   * and {@link listMyListings} derives the coach id from the actor so it cannot
   * be pointed at somebody else.
   *
   * WHY AN ADMIN NEEDS THE WITHDRAWN ONES. Suspending a coach takes every offer
   * they have on sale down, and an ADMIN takedown is one the coach may not lift
   * themselves (see {@link restoreListing}'s table). So without this read, a
   * reinstated coach would be left with a shelf of offers nobody could put back
   * — the suspension would be reversible in name only.
   *
   * `deleted_at` is what to branch on. No `withdrawn_by_admin` here: an admin
   * may restore either way, so the flag would answer a question this caller
   * never asks.
   *
   * @throws DataError `unauthorized` when anonymous, `forbidden` for anyone who
   * is not an admin.
   */
  listListingsForAdmin(actor: Actor, coachId: string, page?: PageRequest): Promise<Page<ListingWithCoach>>;

  /**
   * The actor's OWN offers, newest first, **including withdrawn ones** — the
   * read a coach dashboard renders from. Branch on `deleted_at !== null` to
   * show a withdrawn row with a Restore control.
   *
   * The coach id comes from the resolved actor and is never a parameter, so
   * there is no shape of this call that reads somebody else's withdrawn
   * offers. (Same construction as {@link listMyOrders}, for the same reason.)
   *
   * @throws DataError `unauthorized` when anonymous.
   */
  listMyListings(actor: Actor, page?: PageRequest): Promise<Page<OwnedListing>>;

  /**
   * Creates a listing owned by the actor.
   * @throws DataError `unauthorized` when anonymous, `forbidden` unless the
   * actor's STORED `coach_status` is `'approved'`, `invalid` on bad input.
   */
  createListing(actor: Actor, input: CreateListingInput): Promise<ListingWithCoach>;

  /**
   * Edits an offer in place: title, description, category and price.
   *
   * OWNER ONLY, AND NEVER AN ADMIN. Note the asymmetry with
   * {@link softDeleteListing}, which an admin may perform as a takedown: an
   * admin who can silently rewrite a coach's copy publishes words under that
   * coach's byline that the coach never wrote, which is worse than the problem
   * it solves. A moderator takes an offer down; they do not edit it.
   *
   * The id never changes, so the offer's reviews and orders keep pointing at
   * the same row.
   *
   * TWO THINGS HAPPEN ATOMICALLY WITH THE WRITE, in the data layer, so that
   * posting the form directly cannot skip either:
   *
   *  1. **The price epoch is incremented if — and only if — the price goes
   *     UP.** Strictly greater. An unchanged price does not bump it, and
   *     neither does a price CUT, nor any content-only edit. The bump archives
   *     the offer's rating, review count and sales (see {@link OfferStats});
   *     doing it on a cut or on a no-op would silently destroy an offer's
   *     social proof for nothing. The coach's ACCOUNT-level standing is
   *     untouched either way.
   *  2. **A {@link ListingRevision} snapshot of the SUPERSEDED version is
   *     appended.** That is what covers the case the epoch rule does not: a
   *     coach who rewrites an offer's entire content at the same price keeps
   *     every review, so the record of what it used to say has to survive.
   *
   * A confirmation dialog warning that N reviews and M sales are about to be
   * archived is a courtesy for the UI to add; it is not what enforces this.
   *
   * A WITHDRAWN OFFER CAN STILL BE EDITED, and that is deliberate rather than
   * an oversight. Once an admin takedown can only be lifted by an admin (see
   * {@link restoreListing}), refusing edits too would leave the coach unable to
   * do the one thing that should be open to them — fix whatever got the offer
   * removed. They could neither restore it nor repair it. The edit changes
   * nothing about visibility: `deleted_at` is untouched, so the offer stays
   * invisible to every public read throughout, and a revision is appended
   * exactly as for any other edit. The SQL side permits it too, so the two
   * backends agree rather than silently diverging.
   *
   * @throws DataError `unauthorized` when anonymous; `invalid` on bad input;
   * `not_found` when no such offer exists; `forbidden` when the actor is not
   * the offer's coach (an admin included), or when their STORED `coach_status`
   * is no longer `'approved'`.
   */
  updateListing(actor: Actor, listingId: string, input: UpdateListingInput): Promise<ListingWithCoach>;

  /**
   * Attaches the instant download to one of the actor's own offers, or clears
   * it with `null`. Returns the offer in the OWNER's shape, which is the only
   * one carrying `asset_path` back.
   *
   * **A PATH CROSSES THIS BOUNDARY, NEVER A FILE** — the same split, and the
   * same reason, as {@link setMyAvatar}: bytes live in
   * `src/lib/storage/deliverables.ts` and only Supabase implements them, while
   * this is an ordinary column write both backends do identically.
   *
   * Four rules, all of them enforced here AND in Postgres:
   *
   *   1. **Owner only, never an admin.** `guard_listing_update()` counts
   *      `asset_path` as CONTENT, so this is the `updateListing` asymmetry
   *      again: a moderator takes an offer down, they do not swap the file it
   *      delivers.
   *   2. **Approved coaches only**, for the same reason editing is.
   *   3. **Instant offers only.** A path on a personalised offer would be a
   *      file every buyer could fetch, which is the thing personalised delivery
   *      exists not to be — `listings_asset_path_shape` refuses it.
   *   4. **Pinned under the listing's own id**: the path must start
   *      `<listingId>/`. Same construction as the avatar prefix, and checked in
   *      the CHECK constraint and in `offer_assets_write_coach` as well.
   *
   * Withdrawn offers are editable here, exactly as they are through
   * `updateListing`: a coach whose offer was taken down over its file must be
   * able to replace it.
   */
  setListingAsset(actor: Actor, listingId: string, path: string | null): Promise<OwnedListing>;

  /**
   * Withdraws an offer by stamping `deleted_at`. **Never a row delete** — see
   * {@link Listing.deleted_at} for what survives and why it has to.
   *
   * The offer's coach may do this, and SO MAY AN ADMIN, as a takedown. That is
   * the deliberate asymmetry with {@link updateListing}, which is owner-only:
   * removing something from sale is a moderation action, rewriting it is not.
   *
   * An owner whose coach approval has been revoked may still withdraw (they
   * cannot edit) — the alternative is offers stuck on sale with no way for
   * their author to take them down.
   *
   * @throws DataError `unauthorized` when anonymous, `not_found` for an unknown
   * id, `forbidden` for anyone who is neither the offer's coach nor an admin,
   * `conflict` when it is already withdrawn.
   */
  softDeleteListing(actor: Actor, listingId: string): Promise<ListingWithCoach>;

  /**
   * Puts a withdrawn offer back on sale by clearing `deleted_at`. Nothing else
   * changes — same id, same epoch, same reviews, same sales — because nothing
   * was ever destroyed.
   *
   * NOT simply the inverse of {@link softDeleteListing}'s actor rule, and this
   * is the most consequential thing on this method. Both a coach and an admin
   * may withdraw, so `deleted_at` alone cannot say which happened —
   * `listings.deleted_by` records the actor, and this read uses it:
   *
   * | withdrawn by | the coach may restore | an admin may restore |
   * |---|---|---|
   * | the coach themselves | **yes** | yes |
   * | an admin (a takedown) | **no — `forbidden`** | yes |
   *
   * A takedown a coach can undo in one click is not a takedown, it is a speed
   * bump. A `null` `deleted_by` counts as unattributed and the owner may
   * restore: failing open on an audit column grants an owner nothing they did
   * not already have, whereas failing closed would strand a row nobody could
   * restore.
   *
   * `deleted_by` itself is never returned — see {@link Listing.deleted_by}. A
   * dashboard that needs to know whether this call will succeed reads
   * {@link OwnedListing.withdrawn_by_admin} instead.
   *
   * @throws DataError `unauthorized` when anonymous, `not_found` for an unknown
   * id, `forbidden` for anyone who is neither the offer's coach nor an admin,
   * `forbidden` when a coach tries to lift an ADMIN takedown, `conflict` when
   * it is not withdrawn.
   */
  restoreListing(actor: Actor, listingId: string): Promise<ListingWithCoach>;

  /**
   * The append-only edit history of one offer, newest first — every superseded
   * version, as it was immediately before the edit that replaced it.
   *
   * NOT PUBLIC. Publishing this would publish the full price history of every
   * offer on the site, which is strictly more than the `price_epoch` this
   * project already treats as the coach's own business. Readable by the offer's
   * coach and by an admin, and by nobody else. A withdrawn offer's history is
   * still readable by them.
   *
   * @throws DataError `unauthorized` when anonymous, `not_found` for an unknown
   * id, `forbidden` for anyone who is neither the offer's coach nor an admin.
   */
  listListingRevisions(actor: Actor, listingId: string, page?: PageRequest): Promise<Page<ListingRevision>>;

  // ---------------------------------------------------------------------------
  // Social proof — aggregates (PUBLIC) and the rows behind them (NOT public)
  //
  // Read the asymmetry before using any of it:
  //
  //   * OFFER-level numbers cover the offer's CURRENT price epoch only. After a
  //     price increase the offer reads as new.
  //   * COACH-level numbers cover every offer and every epoch, and are not
  //     affected by a price increase.
  //   * `rating_average` is `null`, never `0`, when there are no reviews.
  //   * The counts are public; the orders they are computed from are not.
  // ---------------------------------------------------------------------------

  /**
   * Rating average, review count and sales count for one offer, at its current
   * `price_epoch` — which is used as the filter but is NOT part of the result.
   * Public — no actor.
   *
   * `null` when the listing id is unknown. A listing that exists but has no
   * activity returns zeros with `rating_average: null`, which is a different
   * thing and must render differently ("New offer", not "0.0").
   */
  getOfferStats(listingId: string): Promise<OfferStats | null>;

  /**
   * The batch form, for a grid of cards: one entry per listing id that exists,
   * in the order given. Unknown ids are skipped rather than returned as zeros,
   * so a caller cannot use this to probe which ids exist.
   *
   * It is on the interface (rather than left to N `getOfferStats` calls)
   * because the Supabase implementation serves it from a single grouped query
   * against `public.offer_stats`; N round trips per browse page would be a
   * performance cliff that only appears after the backend swap.
   */
  listOfferStats(listingIds: readonly string[]): Promise<OfferStats[]>;

  /**
   * Account-level rating average, review count and sales count for a coach,
   * across every offer and every epoch. Public — no actor.
   *
   * Always returns a row, never `null`: a coach with nothing sold is zeros and
   * `rating_average: null`, which is exactly the "New coach" empty state. An
   * unknown id returns the same zeros rather than throwing, so this cannot be
   * used to probe which ids exist.
   *
   * NOTE FOR THE SUPABASE IMPLEMENTATION — this is not what the view does on
   * its own. `public.coach_stats` selects `from public.profiles`, so an id that
   * is not a profile matches NO ROW and the query returns nothing at all, not a
   * zeros row. Returning that result directly would hand back
   * `null`/`undefined` and break the guarantee above. Coalesce it:
   *
   *     return data ?? { coach_id: coachId, rating_average: null, review_count: 0, sales_count: 0 };
   *
   * (A brand-new coach with a real profile row DOES come back as zeros from the
   * view, because the aggregate subqueries return 0 and NULL over empty sets.
   * It is only the unknown-id case that needs the fallback.)
   */
  getCoachStats(coachId: string): Promise<CoachStats>;

  /**
   * The batch form of {@link getCoachStats}, for the coach directory: one entry
   * per coach id, **in the order given**. Public — no actor.
   *
   * It exists for exactly the reason {@link listOfferStats} does: the Supabase
   * implementation serves it from one grouped query against
   * `public.coach_stats`, and a directory that made N round trips would be a
   * performance cliff that only appears after the backend swap.
   *
   * NOTE THE ONE DIFFERENCE FROM `listOfferStats`, which drops unknown ids:
   * this returns a row for every id given, because {@link getCoachStats} always
   * returns a row and the batch form must not disagree with the single form.
   * An id with no activity — and an id that is not a profile at all — comes
   * back as zeros with `rating_average: null`, so this cannot be used to probe
   * which ids exist either.
   */
  listCoachStats(coachIds: readonly string[]): Promise<CoachStats[]>;

  /**
   * Reviews shown ON an offer page: the offer's CURRENT epoch only, newest
   * first, so the list can never disagree with the count from
   * {@link getOfferStats}. Public — no actor.
   *
   * Returns {@link PublicReview}, a projection rather than the row: no
   * `order_id`, no `author_id`, no `price_epoch`. See that type for why each is
   * absent.
   */
  listReviewsForListing(listingId: string, page?: PageRequest): Promise<Page<PublicReview>>;

  /**
   * Every review of every offer this coach has ever published, all epochs,
   * newest first, each joined to the title of the offer it is about. Public.
   *
   * This is the account-level list that pairs with {@link getCoachStats}, and
   * it is deliberately not filtered by epoch.
   */
  listReviewsForCoach(coachId: string, page?: PageRequest): Promise<Page<PublicReviewWithListing>>;

  /**
   * One order. NOT public: readable by the buyer, by the coach who sold it, and
   * by an admin.
   * @throws DataError `unauthorized` when anonymous, `forbidden` for anyone
   * else. `null` when the id is unknown.
   */
  getOrder(actor: Actor, orderId: string): Promise<OrderWithListing | null>;

  /**
   * One of the actor's OWN offers, by id — the single form of
   * {@link listMyListings}, with the same shape and the same scope.
   *
   * The coach id is derived from the actor and is not a parameter, so this
   * cannot read somebody else's offer: an id they do not own returns `null`, in
   * the same breath as an id that does not exist. `null` rather than a throw,
   * for the reason {@link getListingForViewer} gives — a refusal would confirm
   * that something exists there.
   *
   * WHY THE EDITOR CANNOT USE {@link listMyListings}. It used to: read every
   * offer the coach owns, then `.find()` the one being edited. Once that read is
   * a page, the offer being edited is simply absent from it for any coach with
   * more than a page of offers, and the editor 404s on their older work.
   *
   * WITHDRAWN OFFERS INCLUDED, deliberately. A coach whose offer was taken down
   * over its contents must be able to open the editor and fix it.
   *
   * @throws DataError `unauthorized` when anonymous.
   */
  getMyListing(actor: Actor, listingId: string): Promise<OwnedListing | null>;

  /**
   * How many orders exist against one offer, across EVERY price epoch.
   *
   * Owner-or-admin, exactly like {@link listOrdersForCoach} — a claim count is
   * commercial information, and the public aggregate is
   * {@link getOfferStats}.`sales_count`.
   *
   * NOT THE SAME NUMBER as that one, and the difference is the point of having
   * this at all: `offer_stats` counts sales at the offer's CURRENT price epoch,
   * so an offer whose price has risen since it sold reports zero. The editor
   * uses this to decide whether the delivery mode is still changeable —
   * `guard_listing_update()` freezes it at the first claim, at any epoch — and
   * the epoch-filtered number would unlock a control the database then refuses.
   *
   * @throws DataError `unauthorized` when anonymous, `forbidden` for anyone who
   * is neither the offer's coach nor an admin. `0` for an unknown offer, which
   * is what "nobody has claimed it" means for something that does not exist.
   */
  countOrdersForListing(actor: Actor, listingId: string): Promise<number>;

  /**
   * The actor's own order for one offer, or `null` if they have not claimed it.
   *
   * WHY THIS EXISTS RATHER THAN A SCAN OF {@link listMyOrders}. An offer page
   * has to know whether to show a Claim button, and it used to answer that by
   * reading the buyer's entire purchase history and looking for a match. That
   * was merely wasteful while the history was unbounded; once it is a page it is
   * WRONG — a buyer with more than a page of purchases would be shown a Claim
   * button for an offer they already own, and told "you have already claimed
   * this offer" only after pressing it.
   *
   * Scoped by the actor exactly as `listMyOrders` is: the learner id is derived
   * and is not a parameter, so this cannot be pointed at somebody else's
   * purchase. `null` for an unknown or malformed listing id, never a throw —
   * this answers a question about the CALLER, and refusing would confirm the
   * existence of an offer they cannot see.
   *
   * @throws DataError `unauthorized` when anonymous.
   */
  getMyOrderForListing(actor: Actor, listingId: string): Promise<OrderWithListing | null>;

  /** The actor's own purchases, newest first. @throws DataError `unauthorized` when anonymous. */
  listMyOrders(actor: Actor, page?: PageRequest): Promise<Page<OrderWithListing>>;

  /**
   * A coach's sales, newest first. Every epoch — a price change does not hide
   * what was already sold.
   * @throws DataError `unauthorized` when anonymous, `forbidden` unless the
   * actor IS that coach or is an admin. (The sales *count* is public via
   * {@link getCoachStats}; the rows are not.)
   */
  listOrdersForCoach(actor: Actor, coachId: string, page?: PageRequest): Promise<Page<OrderWithListing>>;

  /**
   * Writes a review for an order the actor owns.
   *
   * `listing_id`, `author_id` AND `price_epoch` are all resolved server-side
   * from the order the actor proves they own. The only thing a caller supplies
   * is which purchase, a rating and a body.
   *
   * The epoch comes from the ORDER, not from the listing's current value: a
   * review is feedback on the version that was actually bought. The accepted
   * consequence is that a review written after the offer's price has risen is
   * archived the moment it is written — it never appears on the offer page,
   * though it still counts toward the coach's account rating.
   *
   * @throws DataError `unauthorized` when anonymous; `not_found` when no such
   * order exists; `forbidden` when the order belongs to someone else, or when
   * the actor is the coach who owns the listing (you cannot review your own
   * offer); `conflict` when that order has already been reviewed; `invalid`
   * when the rating is not an integer 1-5 or the body is empty/too long.
   */
  /**
   * Claims an offer, creating the order that everything downstream hangs off.
   *
   * **The only argument is which offer.** `learner_id` comes from the actor,
   * and `coach_id`, `price_cents_at_purchase` and `price_epoch` all come from
   * the listing — a caller-supplied price is the thing `docs/DATA-LAYER.md`
   * refused to make insertable, and the epoch decides which of an offer's
   * price generations the resulting review counts towards.
   *
   * FREE, for now. The pilot is proving that an offer can be claimed,
   * delivered and reviewed; when payment lands it gates this call rather than
   * replacing it, and the row already carries the price column a receipt needs.
   *
   * Throws `unauthorized` when anonymous, `not_found` for an unknown offer,
   * `invalid` for a withdrawn one, `forbidden` for the coach's own offer, and
   * `conflict` for a second claim of the same offer by the same learner.
   */
  createOrder(actor: Actor, listingId: string): Promise<Order>;

  /**
   * The files attached to one order, newest first.
   *
   * Both parties to the order see the SAME list — the buyer's uploads and the
   * coach's — because a delivery is a conversation about one thing and hiding
   * half of it from either side would make it unusable. What is scoped is WHICH
   * order: `deliverables_select_party` admits the order's learner and coach and
   * nobody else, so two learners who claimed the same offer never see each
   * other's files.
   *
   * Throws `forbidden` for anyone who is not on the order.
   */
  listDeliverables(actor: Actor, orderId: string): Promise<Deliverable[]>;

  /**
   * Records a file against an order.
   *
   * **The bytes are not this method's business.** They go to object storage
   * through `src/lib/storage/deliverables.ts`, and only the resulting path
   * arrives here — the same split as `setMyAvatar`, and for the same reason:
   * rows have two backends, files have one.
   *
   * `uploaded_by` is the resolved actor and is never taken from input, so a
   * party to an order cannot attribute a file to the other one.
   */
  addDeliverable(actor: Actor, input: AddDeliverableInput): Promise<Deliverable>;

  /**
   * Removes one of the actor's OWN uploads.
   *
   * A learner who attached the wrong video needs a way back. Deleting somebody
   * else's is refused even for the other party to the order — and there is no
   * edit path at all, because a deliverable is a record of what was handed over
   * at a moment, the same reasoning that makes `listing_revisions` append-only.
   */
  removeDeliverable(actor: Actor, deliverableId: string): Promise<void>;

  createReview(actor: Actor, input: CreateReviewInput): Promise<Review>;

  // ---------------------------------------------------------------------------
  // Moderation — administrators only, all three
  // ---------------------------------------------------------------------------

  /**
   * Every review on the site, newest first, with the author's name and the
   * offer's title attached.
   *
   * ADMIN ONLY, and this is the read `PublicReview` exists to prevent for
   * everyone else — {@link ModeratableReview} keeps `author_id`, `order_id` and
   * `price_epoch`, which a visitor must never see. Mirrors
   * `reviews_select_admin`, the only policy that admits reading the raw table.
   *
   * Not paginated, like every other list on this interface. `docs/ROADMAP.md`
   * §6 has the standing note about that, and it applies here sooner than most:
   * a moderation queue grows monotonically.
   */
  listReviewsForModeration(actor: Actor, page?: PageRequest): Promise<Page<ModeratableReview>>;

  /**
   * Takes a review down: copies it to `removed_reviews`, then deletes it.
   *
   * ADMIN ONLY. **The only path that removes a review** — `0016` drops the
   * admin `DELETE` policy on `reviews` precisely so an unaudited route does not
   * exist beside this one. Both halves happen in one transaction, so there is no
   * interleaving in which the review is gone and the archive row is not.
   *
   * DELETES, NEVER EDITS, and there is deliberately no method to edit one. A
   * review is an opinion published under a named person's identity; an
   * administrator who could rewrite it would be fabricating an opinion and
   * attributing it to a real reader. `0002_rls.sql` makes the same argument
   * about a coach's listing copy, and it is stronger here.
   *
   * `reason` is free text for the archive and is optional: a reason nobody can
   * be bothered to write becomes a copy-pasted one, which is worse than blank.
   *
   * The offer's rating and the coach's rating both move as a result, because the
   * row is genuinely gone rather than flagged — no aggregate has a filter to
   * forget. See {@link RemovedReview}.
   */
  removeReview(actor: Actor, reviewId: string, reason?: string | null): Promise<void>;

  /**
   * The moderation log: what has been taken down, by whom, and why.
   *
   * ADMIN ONLY. Newest first. `removed_by_name` and `author_name` are `null`-safe
   * — both underlying columns are `ON DELETE SET NULL`, so a log entry outlives
   * the accounts it names.
   */
  listRemovedReviews(actor: Actor, page?: PageRequest): Promise<Page<RemovedReviewWithNames>>;

  // ---------------------------------------------------------------------------
  // Reports — the queue `/admin/reviews` was pretending to be
  // ---------------------------------------------------------------------------

  /**
   * Reports a review. **The coach whose offer it is about, and nobody else.**
   *
   * Not the buyer who wrote it — an author reporting their own review is not a
   * thing — and not a passing visitor, which would turn the queue into a voting
   * mechanism on other people's opinions.
   *
   * "No such review" and "not your offer" are ONE message. Telling them apart
   * would let somebody probe which review ids exist, and a review id is
   * otherwise never published: `PublicReview` carries none.
   *
   * One OPEN report per coach per review, not one ever — a coach whose first
   * report was dismissed must be able to say so again if the behaviour escalates.
   */
  reportReview(actor: Actor, reviewId: string, reason: ReportReason, note?: string | null): Promise<Report>;

  /**
   * Reports a coach. **Anybody signed in**, and the asymmetry with the above is
   * the point: a review report is about a specific piece of text on a specific
   * offer, so its owner is the natural reporter, while a coach report is about
   * conduct and the person who experiences that is whoever it was done to.
   *
   * Without this, the only reportable thing on the site would be criticism OF a
   * coach — a moderation system that protects sellers only.
   *
   * Signed in rather than anonymous: a report with no accountable author costs
   * nothing to file and the rate limiter has nothing to key on.
   */
  reportCoach(actor: Actor, coachId: string, reason: ReportReason, note?: string | null): Promise<Report>;

  /** The actor's own reports, newest first, so "did anything happen?" is answerable. */
  listMyReports(actor: Actor, page?: PageRequest): Promise<Page<Report>>;

  /**
   * The queue. ADMIN ONLY, newest first, open ones by default.
   *
   * `subject_summary` is resolved at read time rather than stored, and that is
   * what the subject columns not being foreign keys buys: upholding a review
   * report deletes the review, so by the time anybody reads the report the text
   * may be gone — and the row says so rather than vanishing with it.
   */
  listReports(actor: Actor, status?: ReportStatus, page?: PageRequest): Promise<Page<ReportWithContext>>;

  /**
   * Marks a report upheld or dismissed. ADMIN ONLY.
   *
   * **It does not perform the consequence.** Removing the review is
   * `removeReview`; suspending the coach is `setCoachStatus`. An administrator
   * upholding a report has decided the report was RIGHT, which is not the same
   * decision as what to do about it — and keeping them apart means the audit log
   * records each independently, rather than one implying the other.
   */
  resolveReport(actor: Actor, reportId: string, status: ReportStatus, note?: string | null): Promise<Report>;

  // ---------------------------------------------------------------------------
  // Coach standing — admin only
  // ---------------------------------------------------------------------------

  /**
   * Suspends, reinstates or demotes a coach. ADMIN ONLY.
   *
   * Only `approved`, `suspended` and `none` are reachable. `pending_review` and
   * `rejected` belong to the application flow and are written by
   * `reviewCoachApplication`; hand-setting them would produce a
   * `pending_review` with no application behind it, which every read of that
   * status assumes cannot happen.
   *
   * **REFUSES WHILE ANY OF THEIR OFFERS IS STILL ON SALE**, for stopping
   * statuses. The caller withdraws them first, as the administrator — the SQL
   * function cannot, because `guard_listing_update()` calls `auth.uid()` and the
   * privileged role that owns it cannot reach that schema. Same invariant, same
   * reason, as `deleteMyAccount`.
   *
   * A useful side effect of the caller doing it: `deleted_by` ends up being the
   * administrator, which is the state `withdrawn_by_admin` reports — so a
   * reinstated coach cannot quietly put them back on sale themselves.
   */
  setCoachStatus(actor: Actor, userId: string, status: CoachStatus, reason?: string | null): Promise<Profile>;

  /**
   * Every coach an administrator might act on — approved and suspended alike.
   * ADMIN ONLY.
   *
   * `listCoaches` cannot serve this: it is the public directory and filters to
   * `approved`, so a suspended coach disappears from it the moment they are
   * suspended — which is correct for visitors and useless for the administrator
   * who has to reinstate them.
   */
  listCoachesForAdmin(actor: Actor, page?: PageRequest): Promise<Page<Profile>>;

  /** The audit log, newest first. ADMIN ONLY. */
  listAdminActions(actor: Actor, page?: PageRequest): Promise<Page<AdminActionWithNames>>;

  // ---------------------------------------------------------------------------
  // Invites (admin-minted, one-shot coach fast-track codes)
  // ---------------------------------------------------------------------------

  /** @throws DataError `unauthorized` / `forbidden` unless the actor's stored role is `'admin'`. */
  createInvite(actor: Actor, input: CreateInviteInput): Promise<Invite>;

  /** @throws DataError `unauthorized` / `forbidden` unless the actor's stored role is `'admin'`. */
  listInvites(actor: Actor, page?: PageRequest): Promise<Page<Invite>>;

  /** @throws DataError `unauthorized` / `forbidden` (non-admin), `not_found`, `conflict` (already revoked/redeemed). */
  revokeInvite(actor: Actor, code: string): Promise<Invite>;

  /**
   * Redeems a code for the signed-in actor: marks the invite spent and promotes
   * the actor to `role: 'coach'`, `coach_status: 'approved'`, atomically.
   * Matching is case-insensitive and whitespace-trimmed.
   * @throws DataError `unauthorized` when anonymous; `invalid` for an unknown,
   * revoked, expired or already-redeemed code (one message for all four, so the
   * endpoint is not a code oracle).
   */
  redeemInviteCode(actor: Actor, code: string): Promise<Profile>;

  // ---------------------------------------------------------------------------
  // Coach applications (the slow path to coach status)
  // ---------------------------------------------------------------------------

  /**
   * Files an application for the actor and sets their own `coach_status` to
   * `'pending_review'`.
   * @throws DataError `unauthorized` when anonymous, `invalid` on bad input,
   * `conflict` if the actor already has a pending application or is already an
   * approved coach.
   */
  createCoachApplication(actor: Actor, input: CreateCoachApplicationInput): Promise<CoachApplication>;

  /** The actor's most recent application, or `null`. @throws DataError `unauthorized` when anonymous. */
  getMyCoachApplication(actor: Actor): Promise<CoachApplication | null>;

  /**
   * One application by id, as an administrator sees it — the single form of
   * {@link listCoachApplications}, joined to the applicant the same way.
   *
   * WHY THE QUEUE PAGE NEEDS IT. After a decision, `/admin/applications`
   * redirects back with `?reviewed=<id>` and renders a banner naming the
   * outcome. It used to find that row in the unfiltered list it had already
   * read for the tab counts — and that list is gone twice over: the counts are
   * counts now, and the row is usually not in the visible page anyway, because
   * approving an application removes it from the `pending` tab the admin is
   * looking at.
   *
   * `null` for an unknown id, so a hand-typed `?reviewed=` renders no banner
   * rather than an error.
   *
   * @throws DataError `unauthorized` when anonymous, `forbidden` for anyone who
   * is not an admin — the same rule as the list, because this is the same data.
   */
  getCoachApplication(actor: Actor, applicationId: string): Promise<CoachApplicationWithUser | null>;

  /** Admin review queue, newest first. @throws DataError `unauthorized` / `forbidden` unless stored role is `'admin'`. */
  listCoachApplications(
    actor: Actor,
    filter?: CoachApplicationFilter,
    page?: PageRequest,
  ): Promise<Page<CoachApplicationWithUser>>;

  /**
   * Records an admin decision and mirrors it onto the applicant's profile:
   * `approved` -> `role: 'coach'`, `coach_status: 'approved'`;
   * `rejected` -> `coach_status: 'rejected'` (role untouched).
   * @throws DataError `unauthorized` / `forbidden` (non-admin), `not_found`,
   * `conflict` when the application has already been reviewed.
   */
  reviewCoachApplication(
    actor: Actor,
    applicationId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<CoachApplication>;
}
