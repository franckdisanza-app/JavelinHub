/**
 * Domain types for the JavelinHub data layer.
 *
 * These shapes are deliberately the *row* shapes of the Postgres tables in
 * `supabase/migrations/0001_init.sql` — snake_case columns and all — so that a
 * future `SupabaseDataClient` can return `supabase.from('listings').select()`
 * results with no mapping layer, and no calling code changes.
 */

export type Role = 'learner' | 'coach' | 'admin';
/**
 * `public.coach_status`.
 *
 * `rejected` and `suspended` are NOT the same state and must not be collapsed.
 * `rejected` is an application decision — an administrator read the application
 * and said no — and `/coach/apply` renders a re-application prompt for it.
 * `suspended` is somebody who WAS approved and has been stopped; telling them
 * their application was rejected and inviting them to file another would be
 * both wrong and an invitation to work around the suspension.
 *
 * Only `approved` satisfies `is_approved_coach()`, so a suspended coach cannot
 * publish or edit — the gate needed no change to cover them.
 */
export type CoachStatus = 'none' | 'pending_review' | 'approved' | 'rejected' | 'suspended';
export type ApplicationStatus = 'pending' | 'approved' | 'rejected';

export const ROLES: readonly Role[] = ['learner', 'coach', 'admin'];
export const COACH_STATUSES: readonly CoachStatus[] = [
  'none',
  'pending_review',
  'approved',
  'rejected',
  'suspended',
];
export const APPLICATION_STATUSES: readonly ApplicationStatus[] = ['pending', 'approved', 'rejected'];

/**
 * `public.listing_category` — the fixed offer taxonomy.
 *
 * The SLUG is stored; the LABEL is rendered. That split is the whole point:
 * rewording "Video review" is a copy change, not a data migration, and a
 * `?category=video_review` URL stays clean and stable across the rewording.
 * Never render a raw slug — go through {@link listingCategoryLabel}.
 *
 * Free-text categories are gone. Anything the data layer writes is one of these
 * eight, and `createListing` refuses everything else with `invalid`.
 */
export type ListingCategory =
  | 'training_plan'
  | 'recovery_plan'
  | 'mobility_plan'
  | 'weightlifting_plan'
  | 'nutrition_plan'
  | 'video_review'
  | 'mental_training'
  | 'other';

/**
 * The taxonomy in **display order**, which is also the declaration order of the
 * `public.listing_category` enum — so Postgres's own enum sort agrees with this
 * array and neither side needs an `order by` clause with a CASE in it.
 *
 * `other` is pinned LAST and is never sorted alphabetically into the middle. It
 * is the fallback, and a filter that reads "…, Other, Recovery plan, …" invites
 * a coach to pick it as if it were a peer of the rest.
 */
export const LISTING_CATEGORIES: readonly ListingCategory[] = [
  'training_plan',
  'recovery_plan',
  'mobility_plan',
  'weightlifting_plan',
  'nutrition_plan',
  'video_review',
  'mental_training',
  'other',
];

/** Slug -> the words a human sees. Sentence case, matching the rest of the UI. */
export const LISTING_CATEGORY_LABELS: Record<ListingCategory, string> = {
  training_plan: 'Training plan',
  recovery_plan: 'Recovery plan',
  mobility_plan: 'Mobility plan',
  weightlifting_plan: 'Weightlifting plan',
  nutrition_plan: 'Nutrition plan',
  video_review: 'Video review',
  mental_training: 'Mental training',
  other: 'Other',
};

/**
 * What a category column may actually CONTAIN, as opposed to what may be written
 * to it. Read this before using it — the asymmetry is deliberate.
 *
 * Writes are closed: `CreateListingInput.category` is the strict eight-member
 * `ListingCategory`, and `createListing` refuses anything else with `invalid`.
 * Reads are not, because `category` was free text before this taxonomy existed
 * and the mock store is a long-lived, gitignored JSON file. Any machine whose
 * `data/db.json` predates the taxonomy is holding "Track & Field" right now.
 *
 * Reads pass such a value through UNTOUCHED rather than laundering it into
 * `other` — relabelling a coach's offer would be a claim the data does not
 * support — so `Listing.category` has to be a type that admits it. Declaring the
 * strict union there instead would be a lie the compiler then enforces on
 * callers: it promises `LISTING_CATEGORY_LABELS[listing.category]` is total, and
 * that expression silently yields `undefined` (typed `string`) on a legacy row,
 * which renders as an empty badge with no error anywhere.
 *
 * The `(string & {})` arm is what makes this type do its job. It keeps the eight
 * literals visible to a reader and to editor autocomplete, while making the type
 * as a whole not a valid key of `LISTING_CATEGORY_LABELS` — so indexing that map
 * directly with a stored value **does not compile** (TS7053 under `strict`). The
 * only way through is {@link listingCategoryLabel}, which handles the legacy case.
 */
export type StoredListingCategory = ListingCategory | (string & {});

/**
 * Type guard for anything arriving from outside the type system — a form field,
 * a `?category=` query param, a row read back out of the store. This is also how
 * a `StoredListingCategory` is narrowed to a `ListingCategory`.
 */
export function isListingCategory(value: unknown): value is ListingCategory {
  return typeof value === 'string' && (LISTING_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The label for a stored category value — the ONLY supported way to render one.
 *
 * Takes a `StoredListingCategory`, not a `ListingCategory`, on purpose: see the
 * note on that type. A recognised slug becomes its label; a legacy free-text
 * value is shown as-is, which is honest — relabelling someone's "Track & Field"
 * offer as "Other" would be a claim the data does not support, and returning
 * `undefined` would blank the badge.
 */
export function listingCategoryLabel(value: StoredListingCategory): string {
  return isListingCategory(value) ? LISTING_CATEGORY_LABELS[value] : value;
}

/**
 * Bounds on the coach's own public copy. Exported so the form layer can attach
 * a sentence naming the actual limit instead of rendering the data layer's
 * generic "… is required."
 */
export const COACH_HEADLINE_MAX = 120;
export const COACH_BIO_MAX = 2000;
export const COACH_YEARS_COACHING_MAX = 80;

/** `public.profiles` */
export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  coach_status: CoachStatus;
  /**
   * ==========================================================================
   * The three coach columns below are the coach's OWN PUBLIC COPY.
   * ==========================================================================
   * They are not a view onto `coach_applications`, and the difference is the
   * whole point.
   *
   * `coach_applications.bio` is a REVIEW ARTIFACT: it is written for an
   * administrator, and it is readable only by its author and by admins (policy
   * `coach_applications_select_own` / `_select_admin`). Joining it live onto a
   * public coach profile would publish, to the whole internet, text the
   * applicant wrote for an audience of one — and would keep republishing it
   * every time they edited it for the reviewer.
   *
   * So the application is copied ONCE, explicitly, at APPROVAL TIME
   * (`reviewCoachApplication`), into these columns, and from that moment they
   * are the coach's to edit through {@link DataClient.updateMyCoachProfile}.
   * Editing the application afterwards changes nothing public; editing these
   * changes nothing about the application. See the seeding rules on
   * `reviewCoachApplication`.
   *
   * All three are nullable and all three start out `null` for everyone who is
   * not an approved coach — and for an approved coach who arrived by INVITE
   * CODE, who never filed an application and therefore has nothing to copy.
   * "An approved coach with an empty profile" is a real, reachable state, not
   * an edge case: Nils Berg (`…0004`) is seeded in exactly it.
   *
   * NOT privilege-bearing. `guard_profile_privilege_columns` pins `role`,
   * `coach_status`, `id` and `email` against a self-update; these three are
   * deliberately outside that guard, because a coach editing their own bio is
   * the intended use.
   *
   * They are published to anonymous callers through {@link PublicCoach}, which
   * exists only for approved coaches — so a learner's (always-null) columns are
   * never reachable at all.
   */
  /** One line under the name. `null` until the coach writes one. */
  coach_headline: string | null;
  /**
   * The public bio. Seeded from `coach_applications.bio` at approval, then the
   * coach's own. NEVER read live from the application — see above.
   */
  coach_bio: string | null;
  /**
   * Whole years, 0–{@link COACH_YEARS_COACHING_MAX}, or `null` for "not
   * stated". `0` is a legitimate value ("first season coaching") and is NOT the
   * same as `null` — the same distinction `rating_average` makes, for the same
   * reason: a coach who has not filled this in must not render as "0 years".
   */
  coach_years_coaching: number | null;
  created_at: string;
  updated_at: string;
  /**
   * Object path inside the PUBLIC `avatars` bucket, e.g. `<uuid>/avatar.webp`.
   * NOT a URL — the storage host belongs to the caller, so the backing store
   * stays swappable. `null` is the normal state and renders as initials.
   *
   * Published on {@link PublicProfile} and {@link PublicCoach}, unlike every
   * other column on this type: the file it names is world-readable by design,
   * and the path discloses only the owner id those shapes already carry.
   */
  avatar_path: string | null;
  /**
   * When the owner deleted their account, or `null`.
   *
   * THE ROW SURVIVES A DELETION and is ANONYMISED — `full_name` becomes
   * "Deleted account", the address becomes an unroutable `.invalid` tombstone,
   * the picture and the three coach columns are cleared, and role/coach status
   * drop to learner/none. Erasing the row instead would cascade into listings,
   * orders and reviews, which is one person's departure rewriting another
   * person's sales count and rating. `0018_delete_my_account.sql` works through
   * the foreign keys that force this.
   *
   * IT IS AN AUTHORIZATION FACT, not merely a flag: `resolveProfile` in BOTH
   * backends refuses a deleted profile with `unauthorized`, so every method on
   * this interface is closed to the account from the moment it is set. On
   * Supabase the GoTrue user is banned separately — the privileged role cannot
   * reach the `auth` schema — and until an already-issued access token expires,
   * that token still satisfies RLS on a direct PostgREST call. See
   * `src/lib/auth/account-deletion.ts`.
   */
  deleted_at: string | null;
}

/**
 * `public.public_profiles` — the projection anonymous and cross-user reads get.
 *
 * `profiles` itself carries email and is readable only by its owner and by
 * admins, so anything rendered on a public page must be a `PublicProfile`,
 * never a `Profile`.
 *
 * Note what is NOT here, and do not add it back:
 *   * `role` — publishing it publicly turns any listing of these rows into an
 *     administrator enumerator ("give me everyone where role = 'admin'").
 *   * `coach_status` — the raw enum would make each user's `pending_review` /
 *     `rejected` state world-readable, i.e. a rejected coaching application
 *     becomes public.
 *
 * `is_approved_coach` is the one derived fact a browse page legitimately needs
 * (a verified-coach badge). It says only "this person may sell coaching", which
 * their listings already imply.
 */
export interface PublicProfile {
  id: string;
  full_name: string;
  is_approved_coach: boolean;
  /** See {@link Profile.avatar_path}. Public because the bucket it names is. */
  avatar_path: string | null;
}

/**
 * `public.public_coaches` — one row of the public coach DIRECTORY.
 *
 * A PROJECTION, and deliberately not `PublicProfile & {…}`. Read the three
 * design decisions in it before extending it, because each is load-bearing.
 *
 * -----------------------------------------------------------------------------
 * 1. The row's EXISTENCE is the approval, so there is no status column
 * -----------------------------------------------------------------------------
 * `listCoaches` and `getPublicCoach` are filtered to `coach_status =
 * 'approved'` **in the data layer and in the SQL view**, never by the caller.
 * Every row that exists here is therefore an approved coach by construction,
 * which is why `is_approved_coach` is absent: it would be a column whose value
 * is the constant `true`, and a constant is not information.
 *
 * The consequence is the important half. There is no shape of either call that
 * returns a learner, an applicant awaiting review, a rejected applicant or an
 * administrator — so this surface **cannot be coerced into enumerating `role`
 * or `coach_status`**, which is the exact disclosure {@link PublicProfile}
 * drops those two columns to prevent. Adding either of them back here, or
 * adding a `status` filter parameter, re-opens it.
 *
 * `getPublicCoach(id)` returning `null` for a non-approved id discloses
 * nothing new: it is the same bit as `getPublicProfile(id).is_approved_coach`,
 * which is already public and is exactly what a verified-coach badge renders.
 * It does NOT distinguish "learner" from "pending" from "rejected" from "no
 * such user" — all four are `null`.
 *
 * -----------------------------------------------------------------------------
 * 2. No `email`, and no coach APPLICATION anywhere near it
 * -----------------------------------------------------------------------------
 * The three coach columns are the profile's own — see {@link Profile}. Nothing
 * on this shape is joined from `coach_applications`, whose `bio` and
 * `experience` are owner-and-admin-only.
 *
 * -----------------------------------------------------------------------------
 * 3. No sport
 * -----------------------------------------------------------------------------
 * There is exactly one sport. A field with one possible value is noise on a
 * profile and a filter with one option is worse, so the axis does not exist —
 * see `PROGRESS.md`, "No sport axis". `coach_applications.sport` keeps its
 * nullable column and is not published here or anywhere else public.
 */
export interface PublicCoach {
  id: string;
  full_name: string;
  /** @see Profile.coach_headline */
  coach_headline: string | null;
  /** @see Profile.coach_bio */
  coach_bio: string | null;
  /** Whole years, or `null` for "not stated" — which is NOT `0`. @see Profile.coach_years_coaching */
  coach_years_coaching: number | null;
  /** See {@link Profile.avatar_path}. Public because the bucket it names is. */
  avatar_path: string | null;
}

/**
 * How an offer is handed over. Mirrors `public.fulfilment_mode`.
 *
 * The two modes attach a file at different POINTS, which is why they are two
 * mechanisms rather than one column with a flag:
 *
 *   `instant`       the file belongs to the LISTING. Same bytes for every
 *                   buyer, attached when the offer is published, downloadable
 *                   the moment it is claimed. A ready-made training plan.
 *   `personalised`  the file belongs to the ORDER. Uploaded after the claim,
 *                   readable only by the two people that order names — and for
 *                   a video review the LEARNER uploads first. See
 *                   {@link Deliverable}.
 *
 * `personalised` is the column default and the only honest value for an offer
 * with nothing attached, which is why it leads {@link FULFILMENT_MODES}.
 */
export type FulfilmentMode = 'instant' | 'personalised';

/**
 * The write vocabulary, in the order a picker should offer it. Exported so the
 * authorization suite derives its enum expectations from here rather than
 * hardcoding a list that can drift — the same treatment `ROLES` and
 * `COACH_STATUSES` get.
 */
export const FULFILMENT_MODES: readonly FulfilmentMode[] = ['personalised', 'instant'];

export const FULFILMENT_LABELS: Record<FulfilmentMode, string> = {
  personalised: 'Made for each buyer',
  instant: 'Instant download',
};

/**
 * Narrows unknown input to a {@link FulfilmentMode}.
 *
 * Same job, and the same reason, as {@link isListingCategory}: a Server Action
 * is a public HTTP endpoint, so the radio group's two values are not a
 * constraint on what arrives.
 */
export function isFulfilmentMode(value: unknown): value is FulfilmentMode {
  return value === 'instant' || value === 'personalised';
}

/** `public.listings` */
export interface Listing {
  id: string;
  coach_id: string;
  title: string;
  description: string;
  price_cents: number;
  /**
   * READ type, deliberately wider than the write type — a row written before
   * this taxonomy existed can hold free text. Render with
   * `listingCategoryLabel()`; narrow with `isListingCategory()`. Indexing
   * `LISTING_CATEGORY_LABELS` with this does not compile, which is the point.
   */
  category: StoredListingCategory;
  /**
   * Which *pricing generation* of this offer the current row represents.
   * Starts at 1 and is incremented ONLY when the price goes up.
   *
   * Orders and reviews carry a copy of the value that was current when they
   * were created, and the OFFER-level aggregates filter on it — so raising a
   * price archives that offer's rating and sales, and the offer reads as new
   * again. Nothing is deleted: the reviewer's writing survives, still attached
   * to the same listing row, and the coach's ACCOUNT-level aggregates ignore
   * the epoch entirely, so a price rise never costs a coach their reputation.
   *
   * Written by `createListing` (always 1) and incremented by `updateListing`,
   * atomically with the price write, when and only when the new price is
   * strictly GREATER than the old one. A price cut and a content-only edit
   * leave it alone.
   */
  price_epoch: number;
  /**
   * Withdrawal timestamp, or `null` while the offer is published.
   *
   * DELETION IS ALWAYS SOFT. No code path removes a listing row: a hard delete
   * would either cascade and destroy the reviews and sales attached to it, or
   * be blocked by `orders.listing_id`'s `ON DELETE RESTRICT` so that a coach
   * could never withdraw anything they had sold. Setting this column is the
   * whole of "delete".
   *
   * What it does, and just as importantly what it does NOT do:
   *
   *   * hidden from `listListings`, `getListing`, `listListingsByCoach`,
   *     `listReviewsForListing` and the OFFER-level aggregates — every public
   *     read path filters `deleted_at is null`;
   *   * STILL COUNTED in the coach's ACCOUNT-level sales, review count and
   *     rating, and its reviews still render on the coach profile. The
   *     coaching was sold and reviewed; withdrawing the offer does not undo
   *     that. `getCoachStats` / `listReviewsForCoach` must never learn about
   *     this column — see the note on {@link CoachStats};
   *   * its own detail read is a 404 for the public, but a TOMBSTONE for the
   *     owner, an admin, and anyone holding an order for it — otherwise a
   *     buyer's purchase history links into a dead end. See
   *     {@link ListingDetail}.
   *
   * Restorable: withdrawal is not destruction — but see {@link deleted_by} for
   * who may restore what.
   */
  deleted_at: string | null;
  /**
   * WHO withdrew it, or `null` while published. An audit column, on the same
   * pattern as `coach_applications.reviewed_by`.
   *
   * It exists because a takedown the coach can undo in one click is not a
   * takedown. Both the owner and an admin may withdraw an offer, so
   * `deleted_at` alone cannot tell the two apart, and `restoreListing` needs to:
   * a coach may freely undo THEIR OWN withdrawal, and only an admin can lift an
   * admin takedown.
   *
   * ============================================================================
   * THIS COLUMN NEVER REACHES A CALLER. Do not "fix" that.
   * ============================================================================
   * It holds a raw user id, and for a takedown that id is an ADMINISTRATOR's.
   * Publishing it — to a visitor, to a buyer reading a tombstone, or even to the
   * coach who owns the offer — is administrator enumeration, which is the exact
   * disclosure {@link PublicProfile} drops `role` to prevent.
   *
   * So it is projected away by construction rather than merely left unread:
   * {@link ListingWithCoach} is `Omit<Listing, 'deleted_by'>`, and every method
   * that hands a listing back returns that shape.
   *
   * A PROJECTION IS NOT ENOUGH ON ITS OWN, and the SQL side does not rely on
   * one. RLS is row-level, so the three `listings_select_*` policies each hand
   * over the whole row and `GET /rest/v1/listings?select=*` would return this
   * column to any coach or buyer with a JWT — PostgREST is reachable from a
   * browser. `0002_rls.sql` therefore re-issues the client grant column-wise,
   * omitting this one, so the guarantee above holds in Postgres as well as
   * here. If you add a column to `listings`, add it to that grant too. Where the FACT matters —
   * a dashboard needing to know whether Restore will work — the derived boolean
   * {@link OwnedListing.withdrawn_by_admin} is published instead, which is the
   * same "derived flag, never the raw privileged value" trade as
   * `is_approved_coach`.
   */
  deleted_by: string | null;
  /**
   * How this offer is handed over. @see FulfilmentMode
   *
   * PUBLIC, and the one new column of the pair that is: a buyer should know
   * whether a thing downloads immediately or is made for them before they claim
   * it, so `0011_delivery.sql` grants `select (fulfilment)` to `anon` and
   * `authenticated` alongside the other public listing columns.
   *
   * IMMUTABLE ONCE THE OFFER HAS BEEN CLAIMED, by anybody, including an
   * administrator. `guard_listing_update()` refuses the change, and the mock's
   * `updateListing` refuses it in the same terms: a buyer claimed a thing that
   * was going to arrive in a particular way, and flipping the mode afterwards
   * retroactively rewrites what they were promised. Before the first claim the
   * coach may change their mind freely.
   */
  fulfilment: FulfilmentMode;
  /**
   * The instant download's object path in the PRIVATE `offer-assets` bucket, or
   * `null`. Never a URL — the URL is signed, expires, and is minted per reader.
   *
   * `null` for every personalised offer, which is a CHECK constraint
   * (`listings_asset_path_shape`) and not merely a convention; and `null` is
   * also legal for an instant offer that has been published but not yet had its
   * file attached. That second state is real and the product has to render it:
   * `claim_offer` refuses such an offer with "This offer is not ready to be
   * claimed yet", so the coach's dashboard flags it rather than letting a buyer
   * discover it.
   *
   * ============================================================================
   * THIS COLUMN NEVER REACHES A PUBLIC CALLER, on the same terms as
   * {@link deleted_by} — but for a different reason and with a narrow exception.
   * ============================================================================
   * `0011_delivery.sql` withholds it from the client column grant, so it is
   * unreadable through PostgREST exactly as `deleted_by` is. {@link
   * ListingWithCoach} therefore projects it away, and every public listing read
   * returns that shape.
   *
   * The exception is the two parties who need to mint a download link, and it is
   * granted ROW-wise through a view rather than column-wise through a grant —
   * `owned_listings` for the coach who owns the offer, `entitled_offer_assets`
   * for a learner holding an order for it (0012). Both carry their `auth.uid()`
   * predicate inside the view, so neither can be pointed at anyone else.
   *
   * A path is not a capability in either case: the bucket is private, and
   * reading the bytes still goes through `offer_assets_read_entitled` evaluated
   * against the reader's own session when the URL is signed.
   */
  asset_path: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `public.listing_revisions` — an append-only snapshot of a SUPERSEDED version
 * of an offer, written by `updateListing` on every edit.
 *
 * This is the half of the lifecycle that `price_epoch` does not cover, and the
 * two are deliberately different mechanisms for deliberately different cases:
 *
 *   * a price INCREASE archives the offer's social proof, because the thing on
 *     sale is materially different from the thing that was reviewed;
 *   * a content rewrite at the same price keeps every review — that is the
 *     accepted limit — so the record of what the offer USED TO SAY has to
 *     survive somewhere, or a reader cannot tell which reviews predate it.
 *
 * `created_at` is the moment this version was REPLACED, not the moment it was
 * written. Combined with the live `listings` row it gives the full history:
 * every superseded version here, the current one there.
 *
 * NOT public. A published revision log is a published price history for every
 * offer on the site, which is strictly more than the `price_epoch` the project
 * already treats as the coach's own business. `listListingRevisions` is scoped
 * to the owner and to admins.
 */
export interface ListingRevision {
  id: string;
  listing_id: string;
  title: string;
  description: string;
  price_cents: number;
  /** Read type, wide for the same reason {@link Listing.category} is. */
  category: StoredListingCategory;
  /** When this version was SUPERSEDED — i.e. the timestamp of the edit that replaced it. */
  created_at: string;
}

/**
 * A listing joined to its coach's display name — **and the shape EVERY method
 * that returns a listing actually returns**, reads and writes alike.
 *
 * It is `Omit<Listing, 'deleted_by' | 'asset_path'>`, not `extends Listing`, and
 * both omissions are safety properties rather than tidiness: see
 * {@link Listing.deleted_by} and {@link Listing.asset_path}. Because neither
 * column is on the TYPE, `withCoach()` cannot accidentally spread one back in —
 * the projection is checked by the compiler at every one of its call sites,
 * rather than resting on each of them remembering.
 *
 * `fulfilment` IS here, and the asymmetry is the whole point of the pair: how an
 * offer arrives is public, what file it arrives as is not.
 *
 * Same construction, and the same reasoning, as {@link PublicReview} dropping
 * `order_id`.
 */
export interface ListingWithCoach extends Omit<Listing, 'deleted_by' | 'asset_path'> {
  coach_name: string;
}

/**
 * One of the actor's OWN offers, for a coach dashboard — the return of
 * `listMyListings`, and the only listing shape that says anything at all about
 * who withdrew something.
 *
 * `withdrawn_by_admin` is the derived flag that replaces the raw
 * {@link Listing.deleted_by} id. A dashboard needs it to know whether a Restore
 * control will work: a coach may undo their own withdrawal, but an admin
 * takedown can only be lifted by an admin, and offering a button that is
 * guaranteed to fail is worse than not offering one.
 *
 * It is a BOOLEAN and never the id, so it answers "can I restore this?" without
 * telling a coach which administrator acted — exactly the trade
 * `PublicProfile.is_approved_coach` makes against publishing `role`.
 *
 *   * `deleted_at === null`                       -> on sale
 *   * `deleted_at !== null && !withdrawn_by_admin` -> the coach withdrew it; Restore works
 *   * `deleted_at !== null && withdrawn_by_admin`  -> a takedown; Restore is `forbidden`
 */
export interface OwnedListing extends ListingWithCoach {
  withdrawn_by_admin: boolean;
  /**
   * The owner's own view of {@link Listing.asset_path}, added back onto the
   * projection that drops it — this is the ONE listing shape that carries it,
   * exactly as it is the one that carries `withdrawn_by_admin`.
   *
   * Both come from `public.owned_listings`, whose `where l.coach_id =
   * auth.uid()` is what makes handing them over safe. Note the two are opposite
   * treatments of the same problem and both are deliberate: `deleted_by` holds
   * somebody ELSE's id so only a derived boolean is published, while
   * `asset_path` is the owner's own file and the string itself is what the
   * editor needs to replace or remove it.
   *
   * `null` unless {@link Listing.fulfilment} is `'instant'` and a file has
   * actually been attached — an instant offer with `null` here is published but
   * NOT claimable, which is the state the dashboard exists to flag.
   */
  asset_path: string | null;
}

/**
 * What ONE viewer is allowed to see of ONE offer — the return of
 * `getListingForViewer`, and the shape an offer detail page renders from.
 *
 * A discriminated union rather than a nullable flag, so a caller cannot render
 * a withdrawn offer as if it were on sale by forgetting to check: the Buy
 * control belongs under `state === 'published'` and nowhere else. The
 * `withdrawn` arm carries `withdrawn_at` as a NON-nullable string — the same
 * value as `listing.deleted_at`, restated at a type the caller does not have to
 * null-check — so "No longer available, withdrawn on <date>" needs no guessing
 * and no second call.
 *
 * Who gets which answer (`null` means 404, and `null` is what the public gets):
 *
 * | viewer | published offer | withdrawn offer |
 * |---|---|---|
 * | anonymous / any stranger | `published` | **`null`** |
 * | holder of an order for it | `published` | `withdrawn` |
 * | the coach who owns it | `published` | `withdrawn` |
 * | an admin | `published` | `withdrawn` |
 *
 * A stranger gets `null` rather than a `forbidden` throw on purpose: a refusal
 * would confirm that a withdrawn offer once existed at that id, and a 404 is
 * what "the public cannot see this" should look like.
 */
export type ListingDetail =
  | { state: 'published'; listing: ListingWithCoach }
  | { state: 'withdrawn'; listing: ListingWithCoach; withdrawn_at: string };

/**
 * `public.orders` — one fabricated purchase.
 *
 * There is no checkout in this POC (the Buy button is inert and says so), so
 * nothing in `DataClient` creates one of these; they exist because a review has
 * to point at a purchase, and because "12 sales" has to be a count of something
 * real rather than a number in a template.
 *
 * ORDERS ARE NOT PUBLIC. An individual row says who bought what from whom and
 * for how much, so it is readable only by its buyer, by the coach who sold it,
 * and by an admin. The *aggregate* sales count derived from these rows IS
 * public — see {@link OfferStats}. Keeping those two apart is the whole design:
 * a public order list would publish a purchase history per person.
 *
 * The one thing that does escape, unavoidably, is the fact a reviewer chose to
 * publish themselves: a public review says "this named person's opinion of this
 * offer", which implies they bought it. That is what a verified-purchase review
 * IS. What stays private is everything else about the row — the price paid, the
 * purchase date, the order's id, and the existence of every purchase that was
 * never reviewed. {@link PublicReview} carries no `order_id` and no
 * `author_id`, so a review is never a handle onto the order behind it.
 *
 * `price_cents_at_purchase` is a snapshot, not a join: editing an offer's price
 * must never rewrite what somebody paid.
 */
export interface Order {
  id: string;
  learner_id: string;
  listing_id: string;
  /**
   * The seller at the time of purchase. Denormalised from the listing on
   * purpose — a coach's account-level sales count is a scan of this column and
   * therefore never depends on the listing still being *visible*.
   */
  coach_id: string;
  price_cents_at_purchase: number;
  /** The listing's `price_epoch` when the purchase happened. */
  price_epoch: number;
  created_at: string;
}

/**
 * An order joined to the offer it bought, for a buyer's purchase list and a
 * coach's sales list.
 *
 * Deliberately carries NO buyer name or email. The seller already knows the
 * order exists; putting the purchaser's identity into the row would make an
 * accidental render on a public surface a personal-data leak, and nothing in
 * the UI needs it.
 */
export interface OrderWithListing extends Order {
  listing_title: string;
  /**
   * True when a review already points at this order. One review per order is a
   * schema constraint (`reviews.order_id` is unique), so this is the flag a
   * "Write a review" control keys off — it is not an authorization check.
   */
  has_review: boolean;
  /**
   * How the offer this order bought is delivered, joined from the listing the
   * same way `listing_title` is. It decides which of two different screens the
   * order page renders — a download, or a file exchange — so it is on the shape
   * rather than fetched separately by the one caller that needs it.
   *
   * Read from the LIVE listing, not snapshotted onto the order, and that is
   * safe precisely because the mode is immutable once anything has been claimed:
   * see {@link Listing.fulfilment}. There is no version of this column that can
   * disagree with what the buyer was promised.
   */
  listing_fulfilment: FulfilmentMode;
  /**
   * The instant download's path, or `null` — which is what a personalised order
   * always gets, and what an instant one gets if the coach has not attached the
   * file yet or the caller is not entitled to it.
   *
   * Comes from `public.entitled_offer_assets` (0012), whose predicate is the
   * `offer_assets_read_entitled` storage policy restated: the coach who owns the
   * offer, or a learner holding an order for it. Since `getOrder` already admits
   * only those two and an admin, the practical effect is that an ADMIN reading
   * somebody else's order sees `null` here — they can see that an order exists,
   * they cannot help themselves to the file. That is the intended asymmetry.
   *
   * Still not a capability: {@link Listing.asset_path} explains why a path on
   * its own buys nothing.
   */
  asset_path: string | null;
}

/**
 * One file attached to ONE order — the personalised delivery path.
 *
 * WHO UPLOADED IT IS THE DIRECTION. Compared against the order's `learner_id`
 * this is the buyer's input (their throw, for a video review); against
 * `coach_id` it is the coach's delivery. Two ids already on the order answer
 * the question, so there is deliberately no third column that could disagree
 * with them.
 *
 * `storage_path` points into the PRIVATE `deliverables` bucket and is useless
 * on its own — reading needs a signed URL, which is only issued to the two
 * people the order names. See `supabase/migrations/0011_delivery.sql`.
 */
export interface Deliverable {
  id: string;
  order_id: string;
  uploaded_by: string;
  storage_path: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

/**
 * `public.reviews` — a rating and a body, anchored to an order.
 *
 * `order_id` is what makes this non-spammable: you cannot review an offer you
 * did not buy, you cannot review the same purchase twice (the column is
 * UNIQUE), and "Verified purchase" is free — every review that exists has a
 * purchase behind it by construction.
 */
export interface Review {
  id: string;
  /** The purchase being reviewed. Unique across the table: one review per order. */
  order_id: string;
  listing_id: string;
  author_id: string;
  /**
   * An integer 1-5. No code path can write a 0: zero is not a low score, it is
   * the absence of a score, and the read shapes carry that as a NULL average.
   * (Stated as a property of the WRITE paths, not of the column — the mock
   * store is an unvalidated JSON file, so a hand-edited `db.json` can hold
   * anything, exactly as it can for `title` or `price_cents`.)
   */
  rating: number;
  body: string;
  /** The listing's `price_epoch` when the review was written. */
  price_epoch: number;
  created_at: string;
  updated_at: string;
}

/**
 * `public.public_reviews` — what a review looks like on a public page.
 *
 * A PROJECTION, not the row: it deliberately does NOT extend {@link Review}.
 * Compare the two and note what is missing, because each omission is the answer
 * to a question a visitor should not be able to ask:
 *
 *   * `order_id` — an opaque id whose only use to a stranger is as an argument
 *     to `getOrder()`. Publishing it would hand out valid inputs to a read that
 *     is otherwise scoped to the buyer, the selling coach and an admin, which
 *     is precisely the private surface `Order` describes.
 *   * `author_id` — the author is already attributed by display name, which is
 *     what a review is. The id adds machine-linkability between a name and an
 *     account and renders nothing.
 *   * `price_epoch` — the number of times an offer's price has been raised is
 *     the coach's business, not the visitor's, and nothing on a review renders
 *     it. The epoch still decides WHICH reviews are returned; it is just not
 *     published alongside them.
 *   * `updated_at` — authors have no edit path at all, so it would only ever
 *     equal `created_at`.
 *
 * `author_name` comes from the `public.public_profiles` projection, NOT from
 * `profiles` — `Profile` carries `email` and must never reach a public page.
 * Only the name is joined: `is_approved_coach` is a coach badge with nothing to
 * say on a learner's byline.
 *
 * "Verified purchase" is still free, and does not need `order_id` on this
 * shape: a review can only exist if an order exists, so every row here is one.
 */
export interface PublicReview {
  id: string;
  listing_id: string;
  /** An integer 1-5. */
  rating: number;
  body: string;
  created_at: string;
  author_name: string;
}

/**
 * `public.public_review_replies` — a coach's answer to a review of their offer.
 *
 * A PROJECTION for the same reasons {@link PublicReview} is one, and with the
 * same omission that matters most: `is_demo` is not on it and is not granted to
 * any client role. The coach is attributed by display name, joined through
 * `public_profiles` so a `Profile` and its email cannot be reached from here.
 *
 * THERE IS NO `updated_at`, and unlike on a review that is not merely because
 * nothing edits it — 0032 grants no UPDATE policy to any role at all, so a
 * published reply is immutable for everybody including its author. The same
 * rule `reviews` follows since 0016, applied to the answer as well as to the
 * question.
 *
 * One per review, as a UNIQUE constraint on `review_id`. A thread is a
 * different feature with different moderation problems.
 */
export interface PublicReviewReply {
  id: string;
  review_id: string;
  coach_id: string;
  body: string;
  created_at: string;
  coach_name: string;
}

/** Bounds mirrored from `review_replies_body_length` in 0032. */
export const REVIEW_REPLY_MAX = 2000;

/**
 * A public review joined to the offer it is about, for a coach's profile —
 * where reviews of several different offers appear in one list.
 */
export interface PublicReviewWithListing extends PublicReview {
  listing_title: string;
  /**
   * Whether that offer is still on sale — i.e. whether linking its title from
   * this review leads anywhere. A withdrawn offer is a 404 for the public.
   *
   * ON THE ROW rather than derived by the caller, and that is a correctness fix
   * rather than a convenience. The coach profile used to intersect this list
   * with the coach's offer list to decide; once both are paginated, that
   * intersection is wrong by construction — a review on page 1 can be about an
   * offer on page 3, and the title would silently stop being a link.
   */
  listing_published: boolean;
}

/**
 * A review as an ADMINISTRATOR sees it, for the moderation queue.
 *
 * The near-opposite of {@link PublicReview}, and deliberately so: that shape
 * exists to drop `author_id`, `order_id` and `price_epoch` before a review
 * reaches a visitor, while this one keeps the whole row. A moderator deciding
 * whether to take something down needs to know who wrote it and what they
 * bought; a visitor needs neither and `PublicReview` is what makes that true by
 * construction.
 *
 * So this must never be rendered on a public page. `listReviewsForModeration`
 * refuses anyone who is not an admin, in both backends and in RLS
 * (`reviews_select_admin`).
 */
export interface ModeratableReview extends Review {
  /** The reviewer's display name, joined from `public_profiles`. */
  author_name: string;
  /** The offer it is about. Present even when that offer has been withdrawn. */
  listing_title: string;
}

/**
 * `public.removed_reviews` — a review an administrator took down, copied
 * verbatim before the row was deleted.
 *
 * THE REVIEW ITSELF IS GONE, not flagged. `0016_review_moderation.sql` explains
 * the choice at length; the short version is that a soft delete would have to be
 * filtered out of five separate views and forgetting one leaves a removed review
 * still counting towards somebody's rating, invisibly. Moving the row here makes
 * all five correct with no filter at all.
 *
 * `removed_by` and `author_id` are both nullable because both are `ON DELETE SET
 * NULL`: an audit column that blocks account deletion is one somebody will
 * delete instead — the lesson `invites.created_by` taught the hard way, recorded
 * in `supabase/README.md`.
 *
 * Administrator-readable and administrator-DELETABLE. That second half is the
 * erasure path: a review is sometimes removed precisely because it contains
 * something that must not persist, and an archive nobody can purge would keep
 * the very text the removal existed to take down.
 */
export interface RemovedReview {
  id: string;
  /** The deleted review's id. Not a foreign key — the row it names is gone. */
  review_id: string;
  listing_id: string;
  author_id: string | null;
  order_id: string;
  rating: number;
  body: string;
  price_epoch: number;
  /** When the review was WRITTEN, not when it was removed. */
  review_created_at: string;
  removed_by: string | null;
  removed_at: string;
  /** Free text from the administrator, or `null`. Optional on purpose. */
  reason: string | null;
}

/** A removed review joined to the names a moderation log needs to read. */
export interface RemovedReviewWithNames extends RemovedReview {
  author_name: string;
  listing_title: string;
  /** The administrator who acted, or `null` if that account is gone. */
  removed_by_name: string | null;
}

/**
 * Rating and sales rollup for ONE offer, at its CURRENT `price_epoch`.
 *
 * `rating_average` is `null` — never `0` — when `review_count` is 0. That is
 * the single most important thing about this type. An unrated offer rendered as
 * "0.0" reads as *badly rated* rather than *new*, so the read shape has to make
 * "no reviews" and "rated zero" impossible to confuse; and no write path can
 * store a rating of 0, because ratings are 1-5. Callers branch on
 * `rating_average === null` (equivalently `review_count === 0`) and show "No
 * reviews yet".
 *
 * Rounded to one decimal place, matching `round(avg(rating)::numeric, 1)` in
 * the `public.offer_stats` view, so the number does not change when the backend
 * is swapped.
 *
 * NOT published here: the epoch itself. These numbers describe the offer's
 * current pricing generation, but how many times a coach has raised a price is
 * not a visitor's business and nothing renders it.
 */
export interface OfferStats {
  listing_id: string;
  /** `null` when `review_count === 0`. Never `0` from any write path. */
  rating_average: number | null;
  review_count: number;
  sales_count: number;
}

/**
 * Rating and sales rollup for a COACH ACCOUNT, across every offer and every
 * epoch.
 *
 * The asymmetry with {@link OfferStats} is the point, not an oversight. Raising
 * an offer's price archives that OFFER's numbers; it must not touch the coach's
 * standing, because the coach did not become a worse coach by changing a price.
 * The same reasoning covers an offer that is later withdrawn: the coaching
 * happened and the buyers still paid, so it keeps counting here.
 *
 * `rating_average` is `null` when `review_count === 0`, exactly as above.
 */
export interface CoachStats {
  coach_id: string;
  /** `null` when `review_count === 0`. Never `0` from any write path. */
  rating_average: number | null;
  review_count: number;
  sales_count: number;
}

/** `public.invites` */
export interface Invite {
  code: string;
  created_by: string;
  note: string | null;
  expires_at: string | null;
  redeemed_by: string | null;
  redeemed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** `public.coach_applications` */
export interface CoachApplication {
  id: string;
  user_id: string;
  bio: string;
  experience: string;
  sport: string | null;
  status: ApplicationStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** An application joined to the applicant, for the admin review queue. */
export interface CoachApplicationWithUser extends CoachApplication {
  user_name: string;
  user_email: string;
  user_coach_status: CoachStatus;
}

/**
 * Who is performing an operation.
 *
 * `null` means anonymous. Note that this carries a **user id only** — never a
 * role or a coach_status. The data layer looks those up from the store on every
 * call, exactly as Postgres RLS trusts nothing but `auth.uid()`. If a caller
 * could hand us `{ role: 'admin' }` the entire authorization model would be
 * client-controlled.
 */
export type Actor = { userId: string } | null;

/** Machine-readable failure classes, mappable onto HTTP status codes. */
export type DataErrorCode =
  /** 401 — no signed-in user, but one is required. */
  | 'unauthorized'
  /** 403 — signed in, but this user is not allowed to do this. */
  | 'forbidden'
  /** 404 — the target row does not exist (or is not visible to this actor). */
  | 'not_found'
  /** 400 — the input failed validation. */
  | 'invalid'
  /** 409 — the request conflicts with current state (already reviewed, etc). */
  | 'conflict';

/**
 * The only error type the data layer throws.
 *
 * `message` is written to be shown directly to an end user: it never contains
 * stack traces, ids, SQL, file paths or any other internal detail. Anything a
 * developer needs goes in the log, not in the message.
 */
export class DataError extends Error {
  readonly code: DataErrorCode;

  constructor(code: DataErrorCode, message: string) {
    super(message);
    this.name = 'DataError';
    this.code = code;
    // Restores the prototype chain when compiled down to ES5-era targets.
    Object.setPrototypeOf(this, DataError.prototype);
  }
}

/** Type guard — use this rather than `instanceof` across module boundaries. */
export function isDataError(error: unknown): error is DataError {
  return (
    error instanceof DataError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'DataError' &&
      typeof (error as { code?: unknown }).code === 'string')
  );
}

/** Maps a `DataError` onto the HTTP status a route handler should return. */
export function dataErrorStatus(code: DataErrorCode): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'invalid':
      return 400;
    case 'conflict':
      return 409;
  }
}

/**
 * `public.report_subject` — what a report is about.
 *
 * TWO SUBJECTS, ONE QUEUE. A review is reported by the coach whose offer it is
 * about; a coach is reported by anybody signed in. The asymmetry is deliberate:
 * a review report is about a specific piece of text on a specific offer, so its
 * owner is the natural reporter, while a coach report is about conduct and the
 * person who experiences that is whoever it was done to.
 *
 * Without the second, the only reportable thing on the site would be criticism
 * OF a coach — a moderation system that protects sellers only.
 */
export type ReportSubject = 'review' | 'coach';

/** `public.report_status`. `open` is the queue; the other two are resolved. */
export type ReportStatus = 'open' | 'upheld' | 'dismissed';

/**
 * `public.report_reason` — a CLOSED list, for the same reason the offer taxonomy
 * is one: free text cannot be filtered, counted or triaged, and two spellings of
 * "spam" are two categories. `other` carries the note.
 */
export type ReportReason =
  | 'spam'
  | 'abusive'
  | 'off_topic'
  | 'not_a_real_purchase'
  | 'scam'
  | 'impersonation'
  | 'other';

export const REPORT_REASONS: readonly ReportReason[] = [
  'spam',
  'abusive',
  'off_topic',
  'not_a_real_purchase',
  'scam',
  'impersonation',
  'other',
];

/**
 * Labels, split by subject: the same enum member means a different thing about a
 * review than about a coach, and one label list would have to be vague enough to
 * cover both.
 */
export const REVIEW_REPORT_LABELS: Partial<Record<ReportReason, string>> = {
  spam: 'Spam or advertising',
  abusive: 'Abusive or harassing',
  off_topic: 'Not about this offer',
  not_a_real_purchase: 'Not a real purchase',
  other: 'Something else',
};

export const COACH_REPORT_LABELS: Partial<Record<ReportReason, string>> = {
  scam: 'Scam or fraud',
  not_a_real_purchase: 'Took payment outside JavelinHub',
  impersonation: 'Pretending to be someone else',
  abusive: 'Abusive or harassing',
  other: 'Something else',
};

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}

/**
 * `public.reports` — one row in the moderation queue.
 *
 * NEITHER SUBJECT COLUMN IS A FOREIGN KEY, and that is deliberate: upholding a
 * review report DELETES the review, and a report that a cascade removes at the
 * moment it is acted on is a report nobody can audit. The CHECK constraint
 * `reports_subject_shape` is what keeps the discriminator and the two columns
 * consistent instead — exactly one is set, and it matches `subject_type`.
 */
export interface Report {
  id: string;
  subject_type: ReportSubject;
  /** Set iff `subject_type === 'review'`. Not a foreign key — see above. */
  subject_review_id: string | null;
  /** Set iff `subject_type === 'coach'`. */
  subject_coach_id: string | null;
  reporter_id: string;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

/**
 * A report with the names and text a queue has to render.
 *
 * `subject_summary` is resolved at read time rather than stored: for a review it
 * is the review's own body, which may have been REMOVED by the time anybody
 * reads the report — in which case it says so rather than rendering nothing.
 * That is the whole reason the subject is not a foreign key.
 */
export interface ReportWithContext extends Report {
  reporter_name: string;
  /** The reported coach's name, or the author of the reported review. */
  subject_name: string;
  /** The reported review's body, the coach's headline, or a note that it is gone. */
  subject_summary: string;
  /** The offer a reported review is about. `null` for a coach report. */
  listing_title: string | null;
  resolved_by_name: string | null;
}

/**
 * `public.admin_actions` — who did what, to whom, when and why.
 *
 * FACTS, NEVER CONTENT. `removed_reviews` keeps the text of a removed review so
 * somebody can be shown what was taken down, and it has its own erasure path
 * because that text is sometimes exactly what must not persist. This table has
 * neither, and no client role may write it at all — an audit row an
 * administrator can edit is not an audit row.
 */
export type AdminActionKind =
  | 'grant_admin'
  | 'review_application'
  | 'remove_review'
  | 'resolve_report'
  | 'set_coach_status';

export interface AdminAction {
  id: string;
  /** `null` when that administrator's account is gone, or for a bootstrap. */
  actor_id: string | null;
  action: AdminActionKind;
  subject_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface AdminActionWithNames extends AdminAction {
  actor_name: string | null;
}
