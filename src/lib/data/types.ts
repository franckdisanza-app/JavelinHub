/**
 * Domain types for the JavelinHub data layer.
 *
 * These shapes are deliberately the *row* shapes of the Postgres tables in
 * `supabase/migrations/0001_init.sql` — snake_case columns and all — so that a
 * future `SupabaseDataClient` can return `supabase.from('listings').select()`
 * results with no mapping layer, and no calling code changes.
 */

export type Role = 'learner' | 'coach' | 'admin';
export type CoachStatus = 'none' | 'pending_review' | 'approved' | 'rejected';
export type ApplicationStatus = 'pending' | 'approved' | 'rejected';

export const ROLES: readonly Role[] = ['learner', 'coach', 'admin'];
export const COACH_STATUSES: readonly CoachStatus[] = ['none', 'pending_review', 'approved', 'rejected'];
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
 * It is `Omit<Listing, 'deleted_by'>`, not `extends Listing`, and that omission
 * is a safety property rather than tidiness: see {@link Listing.deleted_by}.
 * Because the audit column is absent from the TYPE, `withCoach()` cannot
 * accidentally spread it back in — the projection is checked by the compiler at
 * every one of its call sites, rather than resting on each of them remembering.
 *
 * Same construction, and the same reasoning, as {@link PublicReview} dropping
 * `order_id`.
 */
export interface ListingWithCoach extends Omit<Listing, 'deleted_by'> {
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
}

/**
 * `public.reviews` — a rating and a body, anchored to an order.
 *
 * `order_id` is what makes this non-spammable: you cannot review an offer you
 * did not buy, you cannot review the same purchase twice (the column is
 * UNIQUE), and "Verified purchase" is free — every review that exists has a
 * purchase behind it by construction.
 */
/** How an offer is handed over. Mirrors `public.fulfilment_mode`. */
export type FulfilmentMode = 'instant' | 'personalised';

export const FULFILMENT_MODES: readonly FulfilmentMode[] = ['personalised', 'instant'];

export const FULFILMENT_LABELS: Record<FulfilmentMode, string> = {
  personalised: 'Made for each buyer',
  instant: 'Instant download',
};

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
 * A public review joined to the offer it is about, for a coach's profile —
 * where reviews of several different offers appear in one list.
 */
export interface PublicReviewWithListing extends PublicReview {
  listing_title: string;
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
