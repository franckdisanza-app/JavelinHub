# The data layer — a guide for everyone building on top of it

If you are building pages, forms, server actions or route handlers, this is the
only document you need in order to talk to persistence. You never touch the
filesystem, the JSON store, or `@supabase/supabase-js` directly.

## The 30-second version

```ts
import { getDataClient, isDataError } from '@/lib/data';

const db = getDataClient();

// public reads — no actor
const listings = await db.listListings({ q: 'javelin', category: 'training_plan' });

// mutations — actor first, always
try {
  await db.createListing({ userId: session.userId }, {
    title, description, price_cents, category,
  });
} catch (error) {
  if (isDataError(error)) return { error: error.message }; // safe to render
  throw error;
}
```

That is the whole contract. The rest of this document explains why it is shaped
that way, so you do not accidentally work around it.

## Six rules that are easy to break

1. **Never render a `Profile` on a public page.** `Profile` carries `email`.
   `getProfile(actor, userId)` returns it only to the owner or an admin and
   throws `forbidden` otherwise. For coach names and anything else a visitor
   may see, use `getPublicProfile(userId)` — or `listCoaches()` /
   `getPublicCoach(id)`, which return `PublicCoach`, for the coach directory.
   `getPublicProfile` returns a `PublicProfile` —
   exactly `id`, `full_name`, `is_approved_coach`, and nothing else. It carries
   no `email`, and deliberately no `role` or `coach_status`: publishing `role`
   to anonymous callers would enumerate every administrator, and `coach_status`
   would make every rejected application world-readable. For a verified-coach
   badge use `is_approved_coach` — the raw enum is intentionally unavailable on
   the public surface. This mirrors the `public.public_profiles` SQL view, which
   projects the same three columns.
2. **Becoming a coach only ever raises privilege.** An admin who redeems an
   invite code, or who is approved as a coach, stays an admin. Do not write UI
   that assumes `coach_status === 'approved'` implies `role === 'coach'`.
3. **The sales count is public; the orders behind it are not.** `getCoachStats`
   and `getOfferStats` take no actor and publish numbers. Every `Order` read
   takes an actor and is scoped to the buyer, the selling coach or an admin —
   a single order row says who bought what from whom.
4. **Never render a zero as a rating.** `rating_average` is `null`, never `0`,
   when nothing has been reviewed. Branch on it. `0.0` reads as *bad*, not
   *new*, and it is the first thing a coach with one listing will see. No write
   path can store a rating of 0 (they are integers 1-5, checked in
   `createReview` and by a SQL constraint) — but see "the mock store, for when
   something looks odd": a hand-edited `db.json` is not validated on load, so
   the guarantee is about the code paths, not about the file.
5. **A withdrawn offer is gone from every public read, and gone from none of
   the account-level ones.** `listListings`, `getListing`,
   `listListingsByCoach`, `getOfferStats`, `listOfferStats` and
   `listReviewsForListing` all filter `deleted_at is null`; `getCoachStats` and
   `listReviewsForCoach` deliberately do not. Do not "make them consistent" —
   see "Withdrawal" below. Both directions are asserted in
   `scripts/verify-authz.mts`.
6. **The coach directory filters to approved coaches server-side.** `listCoaches`
   and `getPublicCoach` carry the predicate themselves, in the data layer and in
   the `public.public_coaches` view, and no parameter widens either. Never
   rebuild it as a client-side filter over a wider read — that renders
   identically on screen and ships every learner's and every administrator's row
   to the browser. `PublicCoach` has no `role` and no `coach_status`, so the
   shape cannot leak them either: the row's *existence* is the approval.

## Files

| File | What it is |
|---|---|
| `src/lib/data/index.ts` | `getDataClient()` — **the only import calling code should use** |
| `src/lib/data/client.ts` | the `DataClient` interface: the swap surface, fully documented |
| `src/lib/data/types.ts` | domain types, `Actor`, `DataError`, `isDataError`, `dataErrorStatus` |
| `src/lib/data/mock/mockClient.ts` | the JSON-backed implementation + all authorization checks |
| `src/lib/data/mock/store.ts` | JSON load/save, seeding, password hashing, the mutex |
| `src/lib/data/supabase/supabaseClient.ts` | the Postgres implementation — authorization enforced by RLS, not by this file |
| `src/lib/data/supabase/serverClient.ts` | the request-scoped Supabase client; the only place a client is built |
| `src/lib/data/supabase/errors.ts` | SQLSTATE → `DataError`, and which database messages are safe to show |
| `src/lib/data/validation.ts` | input validation, **shared by both implementations** |
| `src/lib/data/invite-code.ts` | invite-code minting, shared for the same reason |
| `src/lib/env.ts` | every `process.env` read in the app |
| `scripts/verify-authz.mts` | the authorization regression suite — `npm run verify:authz` |
| `scripts/verify-pages.mts` | the rendered-page regression suite — `npm run verify:pages` |

`src/lib/data/supabase/` is that second implementation, and it has landed:
**no calling code changed for it.** That is the deal, and it only holds while you
go through `getDataClient()`.

Which one you are talking to is `DATA_BACKEND`, and from a page you should never
be able to tell. If you ever find yourself needing to know, something has leaked
through the interface — say so rather than branching on it.

## The actor rule

```ts
export type Actor = { userId: string } | null;   // null = anonymous
```

An actor carries a user id and **nothing else**. There is no `role` field, no
`coachStatus` field, and adding one would be a security regression. Every
mutating method takes the actor as its first argument and then looks the
privileges up from the store itself.

This mirrors Postgres row-level security, which is allowed to trust exactly one
thing — `auth.uid()` — and reads everything else from the database. If the data
layer accepted `{ userId, role: 'admin' }` from a caller, then any code path that
built an actor carelessly (a cookie parse, a query param, a stale session) would
be a privilege escalation. Instead, the worst a bad actor value can do is
impersonate a *user id*, which is the session layer's problem, not the data
layer's.

Practical consequences:

* **Do not gate mutations in the UI and skip the data layer's check.** The check
  is not yours to make. Hiding a button is presentation; refusing the write is
  authorization, and it happens inside `mockClient.ts` (and inside Postgres,
  later).
* **Do check first for rendering.** `getProfile(actor, actor.userId)` gives you
  the signed-in user's own `coach_status`; use it to decide whether to show the
  "Create a listing" button. Then call the method anyway and render whatever
  `DataError` comes back.
* **Never pass ownership ids in input.** `createListing` has no `coach_id` field
  and `createCoachApplication` has no `user_id` field, on purpose. They come
  from the resolved actor.

## Errors

Everything expected throws `DataError`, and only `DataError`:

| `code` | Meaning | HTTP |
|---|---|---|
| `unauthorized` | not signed in, but sign-in is required | 401 |
| `forbidden` | signed in, but not permitted | 403 |
| `not_found` | the target row does not exist | 404 |
| `invalid` | input failed validation | 400 |
| `conflict` | conflicts with current state (already reviewed, duplicate email, …) | 409 |

`error.message` is written for end users — no stack traces, no ids, no SQL, no
paths — so you can render it verbatim. `dataErrorStatus(code)` gives you the
status for a route handler. Use `isDataError(error)`, not `instanceof`; the
guard also matches across module-instance boundaries, which Next.js's bundler
can produce.

Reads that find nothing return `null` or `[]` rather than throwing. Only
operations targeting a specific row throw `not_found`.

In a server action, the idiom is:

```ts
'use server';
import { getDataClient, isDataError, isListingCategory } from '@/lib/data';

export async function createListingAction(formData: FormData) {
  const db = getDataClient();
  const category = String(formData.get('category') ?? '');
  // A form field is untrusted input; narrow it before it can be passed at all.
  if (!isListingCategory(category)) return { ok: false, message: 'Choose a category.' };
  try {
    await db.createListing(await currentActor(), {
      title: String(formData.get('title') ?? ''),
      description: String(formData.get('description') ?? ''),
      price_cents: Number(formData.get('price_cents') ?? NaN),
      category,
    });
  } catch (error) {
    if (isDataError(error)) return { ok: false, message: error.message };
    throw error;
  }
  return { ok: true };
}
```

Note `price_cents` is a **number of cents** and must be a non-negative safe
integer. Parse the currency in the form layer; the data layer will reject
`12.5`, `-1`, `NaN` and `"1000"` with `invalid`.

## Searching

`listListings({ q, category })` matches `q` case-insensitively against **title
and description only**, and `category` as an exact match. It deliberately does
*not* search coach names or category text: those are the columns Postgres
indexes for this query (`listings_title_trgm_idx`,
`listings_description_trgm_idx`, `listings_search_tsv_idx`), and search results
must not change when the backend is swapped. Neither the category slug nor its
label is searchable — categories are a filter, not a keyword.

## Categories

`category` is a **fixed taxonomy of eight**, not free text. The **slug is
stored, the label is rendered**, so rewording a category is a copy change rather
than a data migration and a `?category=` URL survives the rewording.

| slug | label |
|---|---|
| `training_plan` | Training plan |
| `recovery_plan` | Recovery plan |
| `mobility_plan` | Mobility plan |
| `weightlifting_plan` | Weightlifting plan |
| `nutrition_plan` | Nutrition plan |
| `video_review` | Video review |
| `mental_training` | Mental training |
| `other` | Other |

Everything you need is in `src/lib/data/types.ts`: the `ListingCategory` union,
`LISTING_CATEGORIES` (the fixed **display order** — `other` is pinned last and
is never sorted alphabetically into the middle), `LISTING_CATEGORY_LABELS`,
`StoredListingCategory` (see "reads are wider" below), `isListingCategory()` for
anything arriving from a form or a query string, and `listingCategoryLabel()`
for rendering.

Four things follow, and each one is load-bearing:

* **`listCategories()` returns all eight, in that order** — not the distinct
  values in use. It is a property of the schema (`enum_range(null::listing_category)`),
  not of the data, so a fresh install with no listings still shows a complete
  filter and the control never changes shape as inventory arrives. Three seeded
  categories — `recovery_plan`, `nutrition_plan` and `other` — are deliberately
  empty for exactly this reason, and `scripts/verify-authz.mts` asserts that it
  is those three.
* **Never render a raw slug.** Use `listingCategoryLabel(listing.category)`.
  `LISTING_CATEGORY_LABELS[listing.category]` **does not compile** — that is
  deliberate, see below.
* **A category outside the taxonomy matches nothing.** `listListings({ category })`
  with an unrecognised value returns `[]` — it is *not* treated as "no filter".
  In Postgres the comparison is against an enum column, where the value would be
  a cast error rather than a wider result set, and silently widening would answer
  a filtered URL with the whole catalogue. Validate `?category=` with
  `isListingCategory()` before you use it; `/browse` shows an explicit "no such
  category" state rather than falling back to everything.
* **`createListing` refuses anything else with `invalid`**, whatever the type
  says — a Server Action is a public HTTP endpoint and the union is erased at
  runtime. `scripts/verify-authz.mts` asserts the refusal for unknown slugs,
  labels-instead-of-slugs, the empty string and injection-shaped input.

### Writes are closed, reads are wider — and the types say so

A store written before this taxonomy existed can still hold free-text
categories, and `data/db.json` is gitignored and long-lived, so a real machine
may be holding `"Track & Field"` right now. **Reads pass such a value through
untouched** rather than laundering it into `other` — relabelling a coach's offer
would be a claim the data does not support.

That means the read type and the write type are deliberately different:

| | type | why |
|---|---|---|
| write — `CreateListingInput.category` | `ListingCategory` (the strict eight) | `createListing` refuses everything else with `invalid`, so nothing new can enter |
| read — `Listing.category`, `ListingWithCoach.category` | `StoredListingCategory` | it must admit the legacy value that is genuinely in the column |

`StoredListingCategory` is `ListingCategory | (string & {})`: the eight literals
stay visible to a reader and to autocomplete, but the type as a whole is **not a
valid key** of `LISTING_CATEGORY_LABELS`, so

```ts
LISTING_CATEGORY_LABELS[listing.category]   // ✗ TS7053 — does not compile
listingCategoryLabel(listing.category)      // ✓ total, handles the legacy case
```

`TS7053` specifically rests on `noImplicitAny` (on here via `"strict": true` in
`tsconfig.json`) — relax that flag and the indexing above compiles again,
silently. The guard does not rest on it *alone*, though: assigning a stored
category to `CreateListingInput.category`, to `ListingFilter.category`, or to a
bare `ListingCategory` fails with `TS2322`, and `LISTING_CATEGORIES.includes()`
on one fails with `TS2345`. Those are assignability errors and hold under any
compiler configuration.

Declaring the strict union on the row instead would be a lie the compiler then
enforces on you: it promises that indexing is total, and on a legacy row that
expression evaluates to `undefined` while TypeScript types it `string` — a blank
badge, no error anywhere. Narrow with `isListingCategory()` when you need the
strict union.

Legacy values never appear in `listCategories()`, no filter can reach them (the
control only offers the eight), and nothing can create another one.
`scripts/verify-authz.mts` pins all of this against a deliberately planted
pre-taxonomy row. Delete `data/db.json` to reseed clean.

## Reviews, sales, and the price epoch

Every review points at an **order**. That single constraint is what makes the
system non-spammable — you cannot review what you did not buy, and you cannot
review the same purchase twice (`reviews.order_id` is `UNIQUE` in SQL, not just
checked in code) — and it is also where "Verified purchase" comes from: it is a
fact about the schema, not a badge somebody decided to render.

All of the order and review data in this POC is **fabricated**. There is no
checkout, so `DataClient` has no `createOrder` and the SQL grants no client any
`INSERT` on `orders`. `createReview` is real, because a signed-in learner
holding a seeded unreviewed order can genuinely write one.

### The read shapes

| method | actor | returns |
|---|---|---|
| `getOfferStats(listingId)` | none — public | `OfferStats \| null` |
| `listOfferStats(ids)` | none — public | `OfferStats[]`, unknown ids dropped |
| `getCoachStats(coachId)` | none — public | `CoachStats`, always a row |
| `listReviewsForListing(id)` | none — public | `PublicReview[]`, current epoch |
| `listReviewsForCoach(id)` | none — public | `PublicReviewWithListing[]`, every epoch |
| `getOrder(actor, id)` | buyer / selling coach / admin | `OrderWithListing \| null` |
| `listMyOrders(actor)` | signed in | the actor's own purchases |
| `listOrdersForCoach(actor, id)` | that coach, or an admin | that coach's sales |
| `createReview(actor, input)` | owner of an unreviewed order | `Review` |

### `listOfferStats` — key the result by id, never zip it by index

It returns rows "in the order given", and that promise is asserted in
`scripts/verify-authz.mts` — against a fixture list that is deliberately
**neither its ascending nor its descending sort**, because a guard that
excludes one ordering excludes only that one. (Until E5 there was no order
assertion at all: `sort()` and `sort().reverse()` both survived the whole
suite, harmlessly, because nothing rendered offer stats yet.)

Do not rely on it anyway. **This method DROPS ids it has no row for** — an
unknown id, and a withdrawn offer — which `listCoachStats` never does. A
positional zip is therefore wrong by construction here: one dropped row shifts
every card after it and prints one offer's rating under another offer's title.
Build a `Map` keyed by `listing_id`, and render nothing for a card whose id is
missing. Never substitute a zeros row for it: zeros are the claim "nothing has
sold", and a page that simply did not get an answer is not entitled to make it.

Orders are **not public** — `listOrdersForCoach` is the one that takes an id
rather than deriving it, so it checks: publishing it would let any visitor list
a competitor's customers by asking for their coach id.

Reviews are **public read, through a projection**. `PublicReview` is not
`Review`: it is `{ id, listing_id, rating, body, created_at, author_name }` and
deliberately drops three columns the row has.

* `order_id` — a valid argument to `getOrder()`, which is scoped to the buyer,
  the selling coach and an admin. Publishing it on a public page would make the
  private surface half-reachable.
* `author_id` — the author is attributed by display name, which is what a
  review is for; the id only adds machine-linkability to an account.
* `price_epoch` — how many times a coach has raised a price is not a visitor's
  business. It still selects *which* reviews come back.

"Verified purchase" does not need `order_id` on the shape: a review cannot exist
without an order, so every row you get is one. In SQL the same split is
`public.public_reviews` (a view, granted to `anon`) over a `reviews` table that
has no anonymous policy at all — the `public_profiles` pattern exactly.

### Zero is not a rating

`OfferStats.rating_average` and `CoachStats.rating_average` are
`number | null`, and they are `null` exactly when `review_count === 0`.

```ts
const stats = await db.getOfferStats(listing.id);
if (stats && stats.rating_average !== null) renderRating(stats.rating_average);
else renderNoReviewsYet();               // never renderRating(0)
```

A rating of `0` cannot occur — ratings are integers 1-5, enforced in
`createReview` and by a check constraint — so `null` is unambiguous. The
alternative (`0` for "unrated") makes a brand-new offer look like a badly
reviewed one, and there is no way for the UI to recover the distinction once the
data layer has thrown it away.

`sales_count` and `review_count` are plain numbers and *are* `0` when there is
nothing. Zero sales is a real fact; zero rating is not.

### `price_epoch`, and why the two levels disagree on purpose

`listings.price_epoch` is an integer starting at 1, incremented **only when the
price goes up**. Orders and reviews carry a copy of the value that was current
when they were created.

| level | epoch | effect |
|---|---|---|
| **offer** — `getOfferStats`, `listReviewsForListing` | current only | a price rise archives that offer's rating, review count and sales; it reads as new |
| **coach account** — `getCoachStats`, `listReviewsForCoach` | all | a price rise changes nothing; neither does withdrawing an offer |

Nothing is ever deleted by this. The archived reviews still exist, still belong
to the same listing row, still render on the coach's profile, and still count
toward the coach's average. The offer-level number is "how is the thing you can
buy today being received", and the account-level number is "how is this coach".

A review is stamped with **the epoch of the order it reviews**, not with the
listing's current one. A review is feedback on the version that was actually
bought. The accepted consequence, and it is deliberate: if you buy, the coach
raises the price, and *then* you review, your review is archived the moment it
is written — it never appears on the offer page, because that offer genuinely
did get a fresh slate. It still counts toward the coach's account rating, where
every epoch counts, so the writing is never lost.

Seeded example, if you need to see it: offer `…0103` is at epoch 2 with two
epoch-1 sales and one epoch-2 sale. It reports **1 sale, 1 review**; its coach
reports **10 sales, 8 reviews** across everything.

## The offer lifecycle — edit, withdraw, restore

An offer has three verbs after creation, and the interesting thing about them is
that **they do not share an actor rule**:

| method | who | why that, and not something simpler |
|---|---|---|
| `updateListing(actor, id, input)` | the owner, **never an admin** | an admin who can silently rewrite a coach's copy publishes words under that coach's byline that the coach never wrote — worse than the problem it solves. A moderator takes an offer down; they do not edit it. |
| `softDeleteListing(actor, id)` | the owner, **or an admin** | the admin arm is the takedown. Removing something from sale is a moderation action in a way that rewriting it is not. |
| `restoreListing(actor, id)` | the owner **if they withdrew it**, or an admin | a takedown the coach undoes in one click is not a takedown. See below. |
| `listListingRevisions(actor, id)` | the owner, or an admin | **not public**: publishing it would publish the full price history of every offer on the site. |

The asymmetry between rows one and two is deliberate and is the thing most
likely to be "tidied up" by someone who reads only the signatures.

### Who may restore what — and why `deleted_by` never reaches you

Because *both* the owner and an admin may withdraw, `deleted_at` alone cannot
say which happened. `listings.deleted_by` records the actor, and
`restoreListing` uses it:

| withdrawn by | the coach may restore | an admin may restore |
|---|---|---|
| the coach themselves | **yes** | yes |
| an admin (a takedown) | **no — `forbidden`** | yes |

`forbidden`, not `conflict`: the row *is* restorable, just not by this actor.
A `null` `deleted_by` counts as unattributed and the owner may restore — failing
open on an audit column grants nothing an owner did not already have, whereas
failing closed would strand a row nobody could restore.

**`deleted_by` is never on any shape you receive.** After a takedown it holds an
*administrator's* id, and handing that to a visitor, to a buyer reading a
tombstone, or even to the coach who owns the offer is administrator enumeration
— the same disclosure `PublicProfile` drops `role` to prevent. So
`ListingWithCoach` is declared as `Omit<Listing, 'deleted_by'>` and *every*
listing-returning method returns that shape: re-adding the column does not
merely leak, it fails to compile.

Where the fact matters, the derived boolean is published instead.
`listMyListings` returns `OwnedListing`, which is the projection plus
`withdrawn_by_admin: boolean` — enough to decide whether to render a Restore
control, and never enough to learn which administrator acted. Same trade as
`is_approved_coach`.

### Editing a withdrawn offer is allowed

`updateListing` works on a withdrawn offer, and this is deliberate rather than an
oversight. Once an admin takedown can only be lifted by an admin, refusing edits
too would leave the coach unable to do the one thing that should be open to them
— fix whatever got the offer taken down. They could neither restore it nor
repair it.

The edit changes nothing about visibility: `deleted_at` is untouched, so the
offer stays invisible to every public read throughout, and a revision is
appended exactly as for any other edit. It also matches the SQL, which never
forbade it — so the two backends agree instead of silently diverging.

Editing additionally requires the owner's **stored** `coach_status` to still be
`'approved'`. Withdrawing does not: a coach whose approval was revoked and who
cannot take their own offers off sale is the worst of both worlds — the offers
stay published and only an admin can act.

**The id never changes on an edit.** That is what lets the offer's reviews and
orders keep pointing at the same row, and it is why the edit path exists at all
rather than delete-and-recreate.

### `price_epoch` moves only on an INCREASE

`updateListing` increments the epoch when — and only when — the new price is
**strictly greater** than the old one. An unchanged price does not bump it. A
price **cut** does not bump it. A content-only edit does not bump it.

This matters because the bump is destructive to an offer's social proof: after
it, `getOfferStats` reports zero sales, zero reviews and a `null` rating, and
`listReviewsForListing` returns nothing. Doing that for a discount, or for a
coach who hit Save twice, would silently throw away an offer's reputation in
exchange for nothing.

The increment happens **inside the data layer, in the same atomic step as the
price write**. There is no ordering in which a caller gets the new price without
the archive, so a confirmation dialog ("this will archive N reviews and M
sales") is a courtesy the UI adds, not the thing that enforces it — posting the
form directly cannot skip it. In SQL the same guarantee is a `BEFORE UPDATE`
trigger that derives the column, so a client that `PATCH`es `price_cents`
through PostgREST gets the archive whether it asked for one or not. A caller
cannot supply `price_epoch` on either side.

Nothing is deleted by any of this. The archived reviews still exist, still
belong to the same listing row, still render on the coach's profile, and still
count toward the coach's account rating.

### `listing_revisions` — what the epoch rule does not cover

A coach who rewrites an offer end to end **at the same price keeps every
review**. That is a stated, accepted limit, not an oversight — and it is the
reason revisions exist: if the text can change without the reviews changing,
then the superseded text has to survive, or a reader cannot tell which reviews
predate the rewrite.

`updateListing` appends one `ListingRevision` on **every** edit, including one
that changes nothing. Each row is the version that edit **superseded**, so:

```
listing_revisions (oldest → newest)  +  the live listings row  =  the whole history
```

`created_at` on a revision is the moment that version was **replaced**, not the
moment it was written. `listListingRevisions` returns newest first.

Withdrawing and restoring append nothing — they are not content edits.

### Withdrawal is a soft delete, and it is the only kind

`softDeleteListing` stamps `deleted_at`. **No code path removes a listing row**,
and there is no DELETE policy on `listings` in SQL for anybody. A hard delete
would either cascade and destroy the offer's reviews, or be refused outright by
`orders.listing_id`'s `ON DELETE RESTRICT` the moment the offer had sold — i.e.
a coach could never withdraw anything anyone had bought.

What withdrawal does, and what it deliberately does not:

| | withdrawn offer |
|---|---|
| `listListings` (incl. `q` / `category` filters) | **hidden** |
| `getListing` | **`null`** — a 404 for the public |
| `listListingsByCoach` (public coach profile) | **hidden**, and passing an actor does not widen it |
| `getOfferStats` / `listOfferStats` | **no row**, exactly like an unknown id |
| `listReviewsForListing` | **`[]`** |
| `getCoachStats` sales, reviews, rating | **unchanged** |
| `listReviewsForCoach` | **still there**, still joined to the offer title |
| `listMyOrders` / `listOrdersForCoach` | **still there**, still joined to the offer title |
| `listMyListings` (the owner) | **there**, with `deleted_at` set |
| `getListingForViewer` | a tombstone, for the entitled — see below |

The second half of that table is not an oversight to be cleaned up. The coaching
**was** sold and reviewed; withdrawing the offer does not undo that, and a coach
who lost their whole rating by taking one old offer off sale would never take
anything off sale. `getCoachStats` scans `orders.coach_id` directly and resolves
reviews through the raw listings collection, never through the public reads,
precisely so this holds by construction.

`restoreListing` clears the column. Nothing else changes — same id, same epoch,
same reviews, same sales — because nothing was destroyed.

### The tombstone: `getListingForViewer`

**If you are building an offer detail page, call this and not `getListing`.**

```ts
const detail = await db.getListingForViewer(actor, id);
if (!detail) notFound();
if (detail.state === 'withdrawn') return <NoLongerAvailable on={detail.withdrawn_at} />;
return <Offer listing={detail.listing} />;   // state === 'published'
```

It returns a discriminated union rather than a nullable flag so that the Buy
control can only be written under `state === 'published'`. The `withdrawn` arm
carries `withdrawn_at` as a **non-nullable** string — the same value as
`listing.deleted_at`, restated at a type you do not have to null-check.

| viewer | published | withdrawn |
|---|---|---|
| anonymous, or any stranger | `published` | **`null`** |
| anyone holding an order for it | `published` | `withdrawn` |
| the coach who owns it | `published` | `withdrawn` |
| an admin | `published` | `withdrawn` |

The buyer row is the reason the method exists: without it a purchase history
links into a dead end. A viewer with no entitlement gets `null` rather than a
`forbidden` throw, because a refusal would confirm that something once existed
at that id.

### The dashboard shape — what E6 should call

`listMyListings(actor)` returns the actor's own offers, newest first,
**including withdrawn ones**, as `ListingWithCoach[]`. Branch on `deleted_at`:

```ts
const mine = await db.listMyListings(actor);           // OwnedListing[]
const live = mine.filter((l) => l.deleted_at === null);
const withdrawn = mine.filter((l) => l.deleted_at !== null);

// Only offer Restore where it will actually work. A takedown is an admin's to lift.
withdrawn.map((l) => (l.withdrawn_by_admin ? <RemovedByAdmin /> : <RestoreButton id={l.id} />));
```

The coach id comes from the resolved actor and is **never a parameter**, so
there is no shape of this call that reads someone else's withdrawn offers —
the same construction as `listMyOrders`, for the same reason.
`listListingsByCoach` stays strictly public and strictly published-only; it is
deliberately not dual-mode.

Pair it with `listOfferStats(ids)` for the numbers, remembering that withdrawn
ids are absent from that result — a withdrawn row has no public stats, which is
the correct thing for a dashboard to show as "not on sale" rather than "0 sales".

### Empty states are fixtures, not accidents

The seed deliberately contains all of them, and `scripts/verify-authz.mts`
pins them so nobody "fixes" the data later:

* `…0106` — an offer with **zero sales and zero reviews**;
* `…0105` — an offer **sold once and never reviewed** (a third state: it has a
  sales count but no rating);
* Nils Berg (`…0004`) — an **approved coach with nothing at all**: no offers,
  no sales, no reviews, and no headline, bio or years coaching either;
* `recovery_plan`, `nutrition_plan`, `other` — still empty, from the taxonomy
  round.

## The public coach profile

Coaches have **their own public fields** — `coach_headline`, `coach_bio`,
`coach_years_coaching`, all on `profiles` and all nullable.

| method | actor | returns |
|---|---|---|
| `listCoaches({ q })` | none — public | `PublicCoach[]`, **approved coaches only**, newest first |
| `getPublicCoach(id)` | none — public | `PublicCoach \| null` |
| `listCoachStats(ids)` | none — public | `CoachStats[]`, one per id **in the order given** |
| `updateMyCoachProfile(actor, input)` | the actor themselves, **and only while approved** | the actor's own `Profile` |

`PublicCoach` is `{ id, full_name, coach_headline, coach_bio,
coach_years_coaching }`. Note what is missing, and do not add it back: `email`,
`role`, `coach_status`, and `is_approved_coach`. The last would be a column
whose value is the constant `true` — every row these methods return is an
approved coach, because the predicate lives in the data layer and in the SQL
view, so no caller-supplied filter widens it.

`getPublicCoach` returns `null` for an unknown id **and** for a real user who is
not an approved coach, deliberately indistinguishable. A learner, a pending
applicant, a rejected applicant, an administrator and a uuid belonging to nobody
all get exactly `null` — strictly less than the
`getPublicProfile(id).is_approved_coach` flag that is already public. Render it
as a 404.

**A published offer does not guarantee its coach has a public profile**, so a
`/coaches/<listing.coach_id>` link must be gated on `getPublicCoach` (or on
membership of `listCoaches()`) rather than written unconditionally. The state is
reachable, and was demonstrated end to end rather than assumed: a learner files
an application, redeems an invite code — which approves them **without closing
the pending application** — publishes an offer, and an admin then rejects that
still-pending application, which sets `coach_status = 'rejected'` under them.
The profile is left at `role: 'coach', coach_status: 'rejected'`; the offer stays
in `listListings` and `getListing` (neither filters on the coach's status),
while `getPublicCoach` returns `null` and the directory drops them. An
unconditional link would 404. Same rule, and same reason, as a coach profile
only linking a review's offer title when that offer is still published.

`q` matches `full_name` **only** — not the headline, not the bio. Same rule as
`listListings`, same reason: `profiles_full_name_trgm_idx` is the only index
Postgres can serve it from, so matching more here would change results at the
backend swap. The order is **newest first**, not alphabetical: `order by
full_name` is collation-dependent and the mock cannot reproduce it for
non-ASCII names.

`listCoachStats` differs from `listOfferStats` in one way that matters: it
**keeps unknown ids**, as zeros with a `null` average. `getCoachStats` always
returns a row, so a batch that dropped ids would disagree with the single form
and would misalign any caller zipping ids to rows.

### The bio is copied at approval. It is not a live join.

This is the most important thing about these fields.

`coach_applications.bio` is a **review artifact** — written for an
administrator, readable only by its author and by admins. Publishing it live
would put text on the public internet that the applicant wrote for an audience
of one, and would republish every later edit of it.

So `reviewCoachApplication` copies it **once**, at approval, into
`profiles.coach_bio`, and **only when that column is still empty** — a coach who
has since written their own words keeps them. From then on the column is the
coach's, editable through `updateMyCoachProfile`, and the application has
nothing further to do with it.

The distinction, stated as the test that pins it: approve an applicant, then
edit the application row afterwards, and the public bio **does not move**. A
live join passes every other assertion and fails that one.

Only `bio` is copied. `experience` is prose written to a reviewer, no integer
can be recovered from free text, and there is no public `sport` field anywhere
because there is one sport — so `coach_headline` and `coach_years_coaching` stay
`null` for the coach to fill in.

**A coach who arrived by invite code has no bio at all**, having filed no
application. "An approved coach with an empty profile" is a normal state, not an
edge case, and the UI must render it — Nils Berg (`…0004`) is seeded in exactly
it.

The apply form discloses this at the point of collection ("If you are approved,
this becomes the first draft of your public coach profile"). Do not remove that
hint without also removing the copy.

### Only an approved coach may write the three coach columns

`updateMyCoachProfile` throws `forbidden` for anyone whose stored
`coach_status` is not `'approved'` — a learner, an applicant awaiting review, a
rejected applicant, and an admin who is not also an approved coach. It is
**self only**: the subject is the resolved actor and is never a parameter, and
an admin editing somebody else's bio is refused for the same reason
`updateListing` refuses one.

The same rule is enforced in Postgres by
`guard_profile_privilege_columns()`, not only in the data layer. That matters
more than it looks: without it a learner could `PATCH` their own `coach_bio`
through PostgREST before applying, and because the approval copy only fires
when the column is empty, that pre-written bio would **suppress the copy** — so
the two backends would publish different text for the same user actions.

### Zero years is not the same as no years

`coach_years_coaching` is `number | null`. `null` is "not stated"; `0` is "first
season coaching". Two different answers, rendered differently — the same
distinction `rating_average` makes, for the same reason. Branch on `=== null`,
never on falsiness. The mock store's backfill does the same, so a stored `0`
survives a reload.

### What the profile page shows, and why two of its reads disagree

`/coaches/[id]` puts three reads side by side, and the disagreement is the
design rather than a bug:

| read | epoch | withdrawn offers |
|---|---|---|
| `getCoachStats` | all | **included** |
| `listReviewsForCoach` | all | **included** |
| `listListingsByCoach` | n/a | **excluded** — it is a public listing read |

So a coach profile can legitimately show "8 reviews" above four offers, and a
review can name an offer that is no longer for sale. **Do not make them
consistent.**

The consequence a page has to handle: a review's offer title should only be a
**link** when that offer is still published, or the link is a 404. Build the
published set from `listListingsByCoach` and check membership before linking.

## Instant delivery: one public column, one that is not

`listings` carries two delivery columns and they are governed differently on
purpose.

**`fulfilment` is public.** A buyer should know whether a thing downloads
immediately or is made for them *before* they claim it, so `0011_delivery.sql`
grants `select (fulfilment)` to `anon` and `authenticated`, and it is on
`ListingWithCoach` like any other public column.

**`asset_path` is not, and there is no grant that would make it so.** It is the
key of an object in the private `offer-assets` bucket. A column grant is
role-level, so granting it to `authenticated` would publish every coach's paths
to every signed-in visitor through PostgREST. So the column stays revoked and
the two people who legitimately need it reach it **row-wise, through a view**
(0012), each scoped by `auth.uid()` inside the view:

| view | who it serves | predicate |
|---|---|---|
| `owned_listings` | the coach who owns the offer | `coach_id = auth.uid()` |
| `entitled_offer_assets` | that coach, or a learner holding an order for it | mirrors the `offer_assets_read_entitled` storage policy |

This is the same instrument `owned_listings` already used for `deleted_by`, and
the opposite conclusion: `deleted_by` is published as the derived boolean
`withdrawn_by_admin` because the underlying value is somebody *else's* id, while
`asset_path` is published as the string because it is the owner's own file and
the editor needs the key.

Consequences worth knowing before writing a page:

* `OwnedListing` is the **only** listing shape carrying `asset_path`.
  `ListingWithCoach` is `Omit<Listing, 'deleted_by' | 'asset_path'>`, so a public
  read cannot leak it by being spread.
* `OrderWithListing.asset_path` is `null` for an **admin** reading somebody
  else's order. They can see the purchase happened; they are not handed the
  file. Neither view has an admin arm and that is deliberate.
* **A path is not a capability.** The bucket is private, so a leaked path buys
  nothing: reading still goes through `offer_assets_read_entitled`, evaluated
  against the reader's own session at the moment the URL is signed. The view
  predicates are defence in depth, written to match that policy so the two
  cannot drift into different answers.

Two rules the write path enforces in both backends and in Postgres:

1. **The mode is frozen at the first claim**, for an admin too. A buyer claimed
   a thing that was going to arrive a particular way; flipping the mode
   afterwards rewrites what they were promised. `guard_listing_update()` raises
   it, so it is a rule about the offer rather than about who is asking.
2. **A personalised offer may not hold a path** (`listings_asset_path_shape`), so
   switching to personalised clears `asset_path` in the same statement. The
   storage object is deleted by the caller *afterwards* — column first, bytes
   second, so a failure leaves an invisible orphan rather than a live offer
   pointing at nothing.

An instant offer with a `null` path is legal and publishable — the path is
pinned under the listing's own id, so the row has to exist before the file can
be stored under it. It simply **cannot be claimed**: `claim_offer` refuses it,
and the coach's dashboard flags it as *Needs a file*.

## Who may do what

| Operation | Requirement |
|---|---|
| `listListings`, `getListing`, `listCategories`, `listListingsByCoach`, `getPublicProfile` | none — public (published offers only) |
| `listCoaches`, `getPublicCoach`, `listCoachStats` | none — public (**approved coaches only**, filtered in the data layer) |
| `getListingForViewer` | none for a published offer; a withdrawn one needs the owner, an admin, or an order for it — everyone else gets `null` |
| `listMyListings` | any signed-in actor; returns only their own offers |
| `updateListing` | the offer's **owner**, whose stored `coach_status` is `'approved'` — **never an admin** |
| `setListingAsset` | the same, and the offer must be `instant` — the file is CONTENT, so it carries `updateListing`'s asymmetry exactly |
| `softDeleteListing` | the offer's owner (approval not required), **or an admin** |
| `restoreListing` | an admin; or the owner, but only if the owner is who withdrew it — an admin takedown is `forbidden` to the coach |
| `listListingRevisions` | the offer's owner, or an admin |
| `getOfferStats`, `listOfferStats`, `getCoachStats`, `listCoachStats`, `listReviewsForListing`, `listReviewsForCoach` | none — public (aggregates and reviews only) |
| `updateMyCoachProfile` | the actor themselves, whose stored `coach_status` is `'approved'` — **never an admin**, the same asymmetry `updateListing` carries |
| `updateMyProfile`, `setMyAvatar` | the actor themselves, ANY signed-in user. Name and picture belong to the account rather than to a role — `guard_profile_privilege_columns` leaves `full_name` alone precisely because it carries no privilege |
| `changeMyPassword` | the actor themselves, **and only with the current password**. Its sibling `updateMyPassword` takes none, because that caller is the reset flow where the user cannot supply one |
| `getProfile` | the actor is the subject, or is an admin |
| `getOrder` | the buyer, the coach who sold it, or an admin |
| `listOrdersForCoach` | that coach, or an admin |
| `createReview` | signed in, owns the order, has not reviewed it, is not the offer's coach |
| `signUp`, `signInWithPassword` | none |
| `updateMyPassword` | any signed-in actor, on their OWN password — there is no subject parameter to point elsewhere. Getting the session in the first place is where password reset does its work: see `src/lib/auth/password-reset.ts` |
| `listMyOrders`, `createCoachApplication`, `getMyCoachApplication`, `redeemInviteCode` | any signed-in actor |
| `getMyListing`, `getMyOrderForListing` | any signed-in actor, scoped to themselves — the subject is derived, not a parameter, so `null` covers both "no such row" and "not yours" |
| `countOrdersForListing` | the offer's coach, or an admin |
| `listPublicProfiles` | none — public, and carries no email |
| `getCoachApplication` | the actor's **stored** `role` is `'admin'` |
| `getMyListing`, `getMyOrderForListing` | any signed-in actor, scoped to themselves — the subject is derived, not a parameter, so `null` covers both "no such row" and "not yours" |
| `countOrdersForListing` | the offer's coach, or an admin |
| `listPublicProfiles` | none — public, and carries no email |
| `getCoachApplication` | the actor's **stored** `role` is `'admin'` |
| `createListing` | the actor's **stored** `coach_status` is `'approved'` |
| `createInvite`, `listInvites`, `revokeInvite`, `listCoachApplications`, `reviewCoachApplication` | the actor's **stored** `role` is `'admin'` |
| `reportReview` | signed in, **and the coach who owns the offer the review is about** — a join, not a column comparison. Everyone else, including the review's author and an admin, gets `not_found`, in the same words an unknown id gets |
| `reportCoach` | any signed-in actor, about any **approved** coach who is not themselves |
| `listMyReports` | any signed-in actor; scoped to the actor, with no subject parameter to point elsewhere |
| `listReports`, `resolveReport`, `setCoachStatus`, `listCoachesForAdmin`, `listListingsForAdmin`, `listAdminActions` | the actor's **stored** `role` is `'admin'` |

The two routes to `coach_status: 'approved'`:

1. **Invite** — an admin mints a code (`createInvite`), the user redeems it
   (`redeemInviteCode`), and they are immediately `role: 'coach'`,
   `coach_status: 'approved'`. Codes are matched case-insensitively and trimmed;
   unknown, revoked, expired and already-redeemed codes all fail identically
   with `invalid` so the form cannot be used to guess codes.
2. **Application** — the user files one (`createCoachApplication`), which moves
   their own `coach_status` to `'pending_review'`. An admin decides
   (`reviewCoachApplication`): `approved` sets `role: 'coach'` and
   `coach_status: 'approved'`; `rejected` sets `coach_status: 'rejected'` and
   leaves the role alone. Reviewing twice throws `conflict`.

A user may hold at most one `pending` application, and an already-approved coach
cannot apply again — both are `conflict`.

## Reports, standing, and the audit log

Three tables, one queue, and one rule that runs through all of it: **deciding
something was wrong is never the same act as doing something about it.**

### Who may report what

A **review** can be reported only by the coach whose offer it is about. That is
an entitlement expressed as a join through `listings`, which is why it is an RPC
(`report_review()`) rather than an INSERT with a `with check`: a policy could
express the rule, but then "no such review" and "not your offer" would both
surface as the same anonymous RLS violation, and the function can say the one
sentence that reveals neither. Both refusals are `not_found`, deliberately — a
review id is never published anywhere, and distinguishable errors would turn the
form into an oracle for which ids exist.

A **coach** can be reported by anybody signed in, about any approved coach who is
not themselves. Approved specifically: every lever this queue offers is about
selling, so a report about somebody who does not sell is one nobody could act on.

A partial unique index caps this at **one open report per reporter per subject**.
Partial, on `status = 'open'`, so a dismissed report does not block a later one —
and per reporter, so two people seeing the same problem is the normal case rather
than a duplicate.

### Neither subject column is a foreign key

`reports.subject_review_id` and `reports.subject_coach_id` point at rows without
referencing them, and that is the load-bearing decision in the schema. Removing a
review **deletes** it — see the moderation section — so a cascade would take the
report with it at the exact moment somebody acted on it, which is the one moment
the record matters. The `reports_subject_shape` CHECK keeps the discriminator and
the two columns consistent instead: exactly one is set, and it matches
`subject_type`.

The consequence a reader has to handle: the subject may be gone. `listReports`
resolves it from `reviews`, then from `removed_reviews`, and says
"This review has since been removed." when only the archive has it.

### Resolving is not the consequence

`resolveReport` marks a report `upheld` or `dismissed` and writes an audit line.
It does **not** remove the review or suspend the coach. Those are `removeReview`
and `setCoachStatus`, on other pages, each with its own confirmation. A single
button that did both would make the second decision invisible.

### Suspension is a database invariant

`set_coach_status()` **refuses while any of the coach's offers is still on sale**,
and refuses rather than withdrawing them itself. The reason is the one `0004`
recorded: it is SECURITY DEFINER owned by `javelin_privileged`, and
`guard_listing_update()` assigns `new.deleted_by := auth.uid()`, which that role
can never call.

So the application takes the offers down first, **as the administrator**, and
that turns out to be the right behaviour rather than a workaround:
`listings.deleted_by` then holds the administrator, so `restoreListing`'s table
says the coach may not put them back themselves. A takedown a coach can undo in
one click is not a takedown. And because the function refuses, "suspended but
still selling" is not a state that can be reached however a caller sequences its
requests.

| status | what it means | role |
|---|---|---|
| `suspended` | was approved, is stopped, may be reinstated | unchanged — still a coach |
| `none` | demoted; the coach chapter is closed | drops to `learner` |
| `approved` | reinstated | raised to `coach` |

An administrator's `role` is never touched by any of them: standing as a coach
and the admin role are independent axes.

`pending_review` and `rejected` are not reachable here — they belong to the
application flow, and hand-setting one would produce a `pending_review` with no
application behind it, which every read of that status assumes cannot happen.

**Reinstating does not republish.** Nothing records which withdrawals belonged to
which suspension, so restoring is one deliberate decision per offer, on
`/admin/coaches`. `listListingsForAdmin` is the read that makes that possible: the
public by-coach read hides withdrawn offers and `listMyListings` cannot be pointed
at somebody else, so without it a reinstated coach would be left with a shelf
nobody could put back.

**Demotion is one-way from that page.** `coach_status = 'none'` is
indistinguishable from a learner who never applied, so a demoted coach leaves the
admin list. They can apply again through the ordinary queue.

### The audit log

`admin_actions` is append-only: no UPDATE or DELETE policy for any role. Five
kinds — `grant_admin`, `review_application`, `remove_review`, `resolve_report`,
`set_coach_status` — written by exactly one function, `record_admin_action()`,
which is why "what gets logged" is one place to read rather than five.

`actor_id` is nullable and rendered as "a deleted account" rather than as an
invented name: the FK is ON DELETE SET NULL, and bootstrapping the first
administrator has no actor at all.

> **The trap that cost this schema five migrations.** `0019` closed
> `record_admin_action()` with `revoke all ... from public`, which is correct on a
> stock Postgres and does nothing on Supabase: the project bootstrap runs
> `alter default privileges in schema public grant all on functions to anon,
> authenticated, service_role`, and revoking from the PUBLIC pseudo-role does not
> touch an explicit grant to a named role. Anonymous callers could append forged
> lines to the audit log until `0024`. **A function no client should call must
> revoke from those three roles by name.** `scripts/probe-grants.mjs` sweeps every
> client-reachable function for this, and `verify:supabase` pins this one.

## Pagination

Every read that grows without bound returns a `Page<T>`, not an array:

```ts
const page = await db.listListings({ q: 'javelin' }, { cursor, limit: 24 });
page.items      // the rows
page.nextCursor // pass back as `cursor`; null means this was the last page
page.total      // rows matching the filter, IGNORING the cursor — or null
```

Eighteen reads take a `PageRequest`. The ones that do not are bounded by their
caller (`listOfferStats`, `listCoachStats`, `listPublicProfiles` — all take an id
array) or by the row they hang off (`listDeliverables`).

### Keyset, not offset

`LIMIT n OFFSET m` is one line and wrong twice. It is **unstable under writes**:
every list here is newest-first, so a row inserted between two requests shifts
everything down and page 2 repeats one row while skipping another — on a
moderation queue, that is a review nobody ever sees. And it gets slower the
deeper you go, because Postgres walks and discards the first `m` rows every time.

The keyset asks `where (key, id) < (last key, last id)`, which is an index range
scan at the same cost for every page. The price is that pages are only reachable
in order, which is why the UI offers **Next** and the browser's own Back rather
than page numbers.

**The tie-break is not optional.** Every keyset is `(key, id)`, never `key`
alone. Two rows sharing a `created_at` — or a price, under the browse sort — are
otherwise ordered arbitrarily, and an arbitrary order is one that can change
between two requests. `KEYSETS` in `pagination.ts` names the ordering column and
the tie-break for all twenty reads, and both backends import it, so they cannot
disagree about what page two starts with.

Two of those specs are not `created_at`, and getting either wrong fails silently
as a skipped row rather than loudly: `removed_reviews` is ordered by `removed_at`
(when it was taken down, not when it was written), and `invites` ties on `code`,
because that table has no `id` column at all.

### A cursor is a position, never a capability

The cursor carries an ordering value and a row id, base64url-encoded. It is
**opaque but not secret** — everything in it was just rendered to the person
holding it.

**Every scope, filter and entitlement is re-derived from the actor and the
arguments on every request.** A cursor taken from one person's `/purchases` and
pasted into another's changes which rows are *skipped* and cannot change which
rows *exist* to be skipped. Never put a coach id, a status filter or an actor in
one.

Anything malformed, truncated, or belonging to another list decodes to `null`,
and `null` means "start at the beginning" — a hand-edited URL shows page one, not
a 500. The `scope` field is what makes a cursor from the coach directory
meaningless on the offer browse, and what makes a newest-first cursor refused
after the reader switches to cheapest-first (position 24 is a different row in
each ordering).

### `total` is the whole list

`page.total` counts rows matching the filter with the cursor ignored — it is
"137 offers", not "113 left". Tab counts read it, and so does every "24 of 137"
line. It is `null` when the backend could not produce one, and a caller must
render that absence rather than printing `0`: "no offers" and "we did not count"
are different sentences.

**PostgREST does not do this for free, and the two backends disagreed about it
for a while.** `count=exact` counts the query *as filtered*, and the keyset is a
filter — so on page two Supabase reported "2" where the mock reported "26".
Nothing could see it while the live database was empty: an empty table answers
`[]` and `0` from both. It surfaced the first time a real coach profile held more
than a page of offers, as a heading reading "2 offers" above a list of
twenty-six.

`runPaged` in `supabaseClient.ts` is the fix: the filters are passed as a
closure and built twice — once with the keyset for the rows, once without it for
the count — and **the second request is only made when there is a cursor**,
because on page one the count beside the rows is already right. `verify:authz`
pins the contract on the mock; `verify:supabase` pins PostgREST's actual
behaviour, so the reason for the extra request cannot quietly stop being true.

### Five reads exist because a scan would now be wrong

Pagination turned a class of quiet inefficiency into a class of quiet bug: a page
that read a whole list and then `.find()` or `.some()` over it now reads twenty-
four rows and answers confidently about the rest. Each of these replaces one:

| Read | The scan it replaced | What the scan would get wrong |
|---|---|---|
| `getMyListing` | `listMyListings().find()` | the editor 404s on a coach's older offers |
| `getMyOrderForListing` | `listMyOrders().some()` | a Claim button on something already owned |
| `countOrdersForListing` | `listOrdersForCoach().some()` | unlocks a control the database refuses |
| `listPublicProfiles` | `listCoaches()` as a Set | a coach past page 1 stops being a link |
| `getCoachApplication` | the unfiltered queue read | no outcome banner after a decision |

`PublicReviewWithListing.listing_published` (migration 0026) is the same fix in
column form: the coach page used to intersect its review list with its offer
list to decide whether a title could be a link, and a review on page 1 can be
about an offer on page 3.

### `drainAll`, and when it is right

Two callers must act on **every** row, not a page: withdrawing all of a coach's
offers before deleting or suspending them. Both `delete_my_account()` and
`set_coach_status()` refuse while any offer is still on sale, so a first-page
sweep would half-empty somebody's shop and then fail. `drainAll` walks every page
at `MAX_PAGE_SIZE` and throws rather than returning a prefix.

**It is for writers that need the whole set, never for rendering.** Anywhere a
human is looking at the result, a page is the right answer.

## Pagination

Every read that grows without bound returns a `Page<T>`, not an array:

```ts
const page = await db.listListings({ q: 'javelin' }, { cursor, limit: 24 });
page.items      // the rows
page.nextCursor // pass back as `cursor`; null means this was the last page
page.total      // rows matching the filter, IGNORING the cursor — or null
```

Eighteen reads take a `PageRequest`. The ones that do not are bounded by their
caller (`listOfferStats`, `listCoachStats`, `listPublicProfiles` — all take an id
array) or by the row they hang off (`listDeliverables`).

### Keyset, not offset

`LIMIT n OFFSET m` is one line and wrong twice. It is **unstable under writes**:
every list here is newest-first, so a row inserted between two requests shifts
everything down and page 2 repeats one row while skipping another — on a
moderation queue, that is a review nobody ever sees. And it gets slower the
deeper you go, because Postgres walks and discards the first `m` rows every time.

The keyset asks `where (key, id) < (last key, last id)`, which is an index range
scan at the same cost for every page. The price is that pages are only reachable
in order, which is why the UI offers **Next** and the browser's own Back rather
than page numbers.

**The tie-break is not optional.** Every keyset is `(key, id)`, never `key`
alone. Two rows sharing a `created_at` — or a price, under the browse sort — are
otherwise ordered arbitrarily, and an arbitrary order is one that can change
between two requests. `KEYSETS` in `pagination.ts` names the ordering column and
the tie-break for all twenty reads, and both backends import it, so they cannot
disagree about what page two starts with.

Two of those specs are not `created_at`, and getting either wrong fails silently
as a skipped row rather than loudly: `removed_reviews` is ordered by `removed_at`
(when it was taken down, not when it was written), and `invites` ties on `code`,
because that table has no `id` column at all.

### A cursor is a position, never a capability

The cursor carries an ordering value and a row id, base64url-encoded. It is
**opaque but not secret** — everything in it was just rendered to the person
holding it.

**Every scope, filter and entitlement is re-derived from the actor and the
arguments on every request.** A cursor taken from one person's `/purchases` and
pasted into another's changes which rows are *skipped* and cannot change which
rows *exist* to be skipped. Never put a coach id, a status filter or an actor in
one.

Anything malformed, truncated, or belonging to another list decodes to `null`,
and `null` means "start at the beginning" — a hand-edited URL shows page one, not
a 500. The `scope` field is what makes a cursor from the coach directory
meaningless on the offer browse, and what makes a newest-first cursor refused
after the reader switches to cheapest-first (position 24 is a different row in
each ordering).

### `total` is the whole list

`page.total` counts rows matching the filter with the cursor ignored — it is
"137 offers", not "113 left". Tab counts read it, and so does every "24 of 137"
line. It is `null` when the backend could not produce one, and a caller must
render that absence rather than printing `0`: "no offers" and "we did not count"
are different sentences.

### Five reads exist because a scan would now be wrong

Pagination turned a class of quiet inefficiency into a class of quiet bug: a page
that read a whole list and then `.find()` or `.some()` over it now reads twenty-
four rows and answers confidently about the rest. Each of these replaces one:

| Read | The scan it replaced | What the scan would get wrong |
|---|---|---|
| `getMyListing` | `listMyListings().find()` | the editor 404s on a coach's older offers |
| `getMyOrderForListing` | `listMyOrders().some()` | a Claim button on something already owned |
| `countOrdersForListing` | `listOrdersForCoach().some()` | unlocks a control the database refuses |
| `listPublicProfiles` | `listCoaches()` as a Set | a coach past page 1 stops being a link |
| `getCoachApplication` | the unfiltered queue read | no outcome banner after a decision |

`PublicReviewWithListing.listing_published` (migration 0026) is the same fix in
column form: the coach page used to intersect its review list with its offer
list to decide whether a title could be a link, and a review on page 1 can be
about an offer on page 3.

### `drainAll`, and when it is right

Two callers must act on **every** row, not a page: withdrawing all of a coach's
offers before deleting or suspending them. Both `delete_my_account()` and
`set_coach_status()` refuse while any offer is still on sale, so a first-page
sweep would half-empty somebody's shop and then fail. `drainAll` walks every page
at `MAX_PAGE_SIZE` and throws rather than returning a prefix.

**It is for writers that need the whole set, never for rendering.** Anywhere a
human is looking at the result, a page is the right answer.

## Server-only

`src/lib/data/**` uses `node:fs` and `node:crypto`. Import it from server
components, server actions and route handlers only. `store.ts` throws on import
if `window` is defined, so a mistake surfaces immediately rather than as a
confusing bundler error.

If a client component needs data, fetch it in a server component and pass it
down as props, or call a server action.

## The mock store, for when something looks odd

* Lives at `MOCK_DB_PATH` (default `./data/db.json`, gitignored). Delete the file
  to reset; it reseeds on the next request.
* Seeded accounts and the two demo passwords are listed in the root `README.md`.
  The admin password comes from `SEED_ADMIN_PASSWORD` and has no default — the
  app throws a message telling you exactly what to add if it is missing.
* Seeding is idempotent, so an existing store picks up newly added fixtures
  without being wiped.
* All access is serialised through an in-process promise-chain mutex, and
  mutations are applied to a deep copy that is only promoted on success. That is
  what makes multi-step operations — claim an invite *and* promote the profile —
  atomic without a transaction manager.
* Writes go to a temp file and are then renamed, so an interrupted write cannot
  leave a truncated store.
* The cache is stashed on `globalThis` so Next.js dev hot-reload does not create
  a second, unsynchronised copy.

## Changing the data layer

There are TWO implementations now, and a change to one is usually a change to
both. `listMyListings` returning a field the Supabase client cannot produce is
not a compile error — it is a runtime difference between environments, and the
suites below only run the mock. When you add or change a method, check it against
the mapping table in `supabase/README.md` and write the SQL half at the same
time; migration `0003_read_models.sql` exists because four methods were specified
against a schema that could not serve them, and nothing caught it until somebody
sat down to write the queries.

Validation belongs in `src/lib/data/validation.ts`, not in either client. SQL
carries only the coarse constraints, and a `23514` reads
`violates check constraint "listings_price_cents_check"` — so every field-level
message the UI renders comes from application code in both backends. A second
copy of a rule means the wording of a form changes when `DATA_BACKEND` flips.

If you touch `mockClient.ts`, run `npm run verify:authz` before you hand off. It
builds a throwaway store in the OS temp directory (never `data/db.json`), needs
no `.env.local`, and asserts every authorization rule on this page — including
that a forged `role` on an `Actor` is ignored, that promotion never demotes an
admin, and that an admin cannot self-approve. It exits non-zero on any failure.

If you touch a **page**, run `npm run verify:pages` as well. It builds its own
throwaway store the same way, plants the states the seed deliberately lacks,
starts a server against it and asserts on the rendered markup. `verify:authz`
renders nothing, so it is structurally blind to an empty state collapsing, a
cross-link pointing at a 404 or a demo-data note going missing — five such
regressions once shipped green through `tsc`, `lint` and `verify:authz`
together.

## What is deliberately not here

* **No hard delete of a listing, anywhere, by anyone.** That is a feature, not a
  gap — see "Withdrawal is a soft delete" above. There is no DELETE policy on
  `listings` in SQL for any role.
* **No edit path for a `ListingRevision`.** The table is append-only; nothing in
  the data layer updates or removes a row in it, and no client role holds
  `INSERT` on it in SQL either — the trigger that writes it runs as
  `javelin_privileged`, so a coach cannot suppress or rewrite the history of
  their own offer.
* No pagination. `listListings` returns everything, newest first. Fine for a POC
  with six fixtures; add a cursor before it is not. `listReviewsForCoach` has
  the same property and will need it sooner.
* **No client `INSERT` on `orders`, and there should never be one.** A
  caller-supplied `price_cents_at_purchase` is not something that should ever be
  insertable. `createOrder` exists now and is the RPC this bullet predicted:
  `claim_offer(uuid)` derives the learner from the JWT and the coach, price and
  epoch from the listing, so nothing about an order is caller-supplied except
  which offer. Claiming is free; when payment lands it goes IN FRONT of that
  call, not instead of it.
* **No review EDIT path for anybody — author or administrator.** Authors get
  none for the same reason applicants get none on `coach_applications`: an
  `UPDATE` grant would let them rewrite `order_id`, `listing_id` or
  `price_epoch`, and pinning those for a self-update needs an OLD-vs-NEW
  comparison, i.e. another guard trigger.

  Administrators get none because a review is an opinion published under a named
  person's identity, and rewriting one would be fabricating an opinion and
  attributing it to a real reader. `0016` DROPS the `reviews_update_admin` policy
  that would have permitted it. What an administrator does have is
  `removeReview`, which archives the review to `removed_reviews` and then deletes
  it — the only path that removes one, since the admin `DELETE` policy was
  dropped in the same migration so that no unaudited route exists beside it.
* No session handling. Building an `Actor` from a cookie belongs to the auth
  layer, not here.
