# `supabase/` — schema, RLS, and the mock → Postgres swap path

**The Supabase project exists; the schema has NOT been applied to it yet.**
Project ref `trocsdetpwyqcgyfclir`. Its `public` schema is empty as of this
writing — every table answers PostgREST `PGRST205 Could not find the table` —
so `supabase db push` below is a real, outstanding step and not a formality.

`SupabaseDataClient` is implemented (`src/lib/data/supabase/`), so flipping
`DATA_BACKEND=supabase` is now a config change. Doing it BEFORE the push gives a
site where every page 500s.

Until the push happens, the rules below are still verified the way they always
were: by *static review* plus a code twin — the mock data layer at
`src/lib/data/mock/mockClient.ts` re-implements every rule in TypeScript and is
exercised by `npm run verify:authz` (758 assertions) and `npm run verify:pages`
(134).

| File | Contents |
|---|---|
| `migrations/0001_init.sql` | extensions (`pgcrypto`, `pg_trgm`), enums, tables, indexes, `updated_at` triggers |
| `migrations/0002_rls.sql` | the `javelin_privileged` role, `enable row level security`, all policies, the `SECURITY DEFINER` helpers, the `public_profiles` / `public_coaches` / `public_reviews` / `offer_stats` / `coach_stats` views, and the four privileged RPCs |
| `migrations/0003_read_models.sql` | four read surfaces the `DataClient` contract needs and 0001/0002 could not serve — see below |
| `seed.sql` | demo fixtures — the SQL mirror of `seedDatabase()` in `src/lib/data/mock/store.ts` |

### Why 0003 exists

Implementing `SupabaseDataClient` against 0001+0002 surfaced four methods that
**could not be written**, because the fact each one has to return is deliberately
unreadable through PostgREST. None of them is a new feature; each closes a gap
between the interface and the schema.

| Method | What it needs | Why 0001/0002 cannot serve it | 0003 adds |
|---|---|---|---|
| `listMyListings` | `withdrawn_by_admin: boolean` | derives from `listings.deleted_by`, whose SELECT is revoked from every client role | `public.owned_listings` — self-scoped by `auth.uid()`, publishes the BOOLEAN, never the admin's id |
| `listReviewsForListing` | reviews at the offer's CURRENT epoch only | `public_reviews` deliberately omits `price_epoch`, so a client has nothing to filter on | `public.public_listing_reviews` — epoch + published filters inside the view, epoch still never projected |
| `listReviewsForCoach` | every review, including those on WITHDRAWN offers | reaching `coach_id`/`listing_title` means joining `listings`, where `listings_select_public` hides withdrawn rows from anon — the list would silently disagree with `coach_stats` | `public.public_coach_reviews` — carries `coach_id` and the title, with no `deleted_at` and no epoch predicate |
| `listCoaches` | newest-first ordering | `public_coaches` never projected `created_at`, and PostgREST cannot order by a column a view does not expose — despite `profiles_approved_coach_created_at_idx` existing in 0001 for exactly this query | `created_at` appended to `public_coaches` (`PublicCoach` is unchanged: the client orders by it without selecting it) |

## Swap path: mock → Supabase

The whole point of `DataClient` (`src/lib/data/client.ts`) is that **no calling
code moves**. Steps 2 and 3 are DONE; 1 and 4 are outstanding and both need
credentials only the project owner has.

1. **Apply the schema.** ⟵ OUTSTANDING
   ```bash
   npx supabase login              # interactive: opens a browser
   npm run db:link                 # prompts for the database password
   npm run db:push                 # applies 0001, 0002, 0003 in order
   ```
   The CLI is a **dev dependency**, not a global install — Supabase dropped
   support for `npm i -g supabase`, so it is `npx supabase` (or the `db:*`
   scripts in `package.json`). `supabase login` is the only interactive step
   and cannot be scripted; it opens a browser and asks for a verification code.

   The migration filenames are `0001_`/`0002_`/`0003_` rather than the CLI's
   usual 14-digit timestamps. That is fine — it matches on `^([0-9]+)_(.+)$`
   and orders by that numeric prefix — and renaming them would invalidate the
   dozens of references to them in code comments and in this file.

   `supabase init` has already been run: `config.toml` is committed, and its
   `[auth.email] enable_confirmations` is `false`, which is what this app
   needs. **That file configures a LOCAL `supabase start` stack, not the remote
   project** — it changes nothing about `trocsdetpwyqcgyfclir` unless you run
   `supabase config push`, which you should not do yet: `site_url` still points
   at `http://127.0.0.1:3000` and pushing it would set that as the production
   site URL. Turn confirmation off in the dashboard instead (below).
   `0002_rls.sql` installs an `after insert on auth.users` trigger, so profiles
   are created automatically from then on. Run `seed.sql` for the demo fixtures
   (see its header — the `auth.users` rows must exist first), then bootstrap an
   admin as described below.

   **Turn OFF email confirmation** (Authentication → Providers → Email →
   "Confirm email") before using the app. Nothing here implements a confirmation
   callback route, so with it on, `signUp` creates the account, GoTrue returns no
   session, and the new user lands back on the site anonymous.
   `SupabaseDataClient.signUp` detects that case and says so rather than failing
   silently, but the supported configuration is off.

2. ~~**Implement `SupabaseDataClient`.**~~ **Done** — `src/lib/data/supabase/`:
   * `supabaseClient.ts` — all 39 methods.
   * `serverClient.ts` — the request-scoped client. The `Actor` becomes "which
     Supabase client do I build": one built per request from that request's
     cookies, so `auth.uid()` inside Postgres is the actor. It is never cached
     and never built from the secret key.
   * `errors.ts` — the SQLSTATE → `DataError` mapping below, plus the part the
     mapping alone does not cover: deciding whether a message came from one of
     our own `raise exception`s (show it) or from Postgres (replace it).
   * `validation.ts` and `invite-code.ts` (one level up) were extracted from
     `mockClient.ts` and are now shared, so both backends reject the same input
     with the same words and mint codes in the same format.

   Also adapted, because the swap does not stop at the data layer:
   * `src/lib/auth/session.ts` — dispatches on `DATA_BACKEND`. On Supabase the
     session IS the JWT: `createSession` is a no-op (the tokens were already
     written by `auth.signInWithPassword`), `destroySession` calls
     `auth.signOut()`, and `getSessionUserId` validates through `auth.getUser()`.
     Nothing above this file knows which mechanism is running.
   * `src/proxy.ts` — refreshes the token pair. Required by `@supabase/ssr`, and
     named `proxy` rather than `middleware` because Next.js 16 renamed the
     convention. It authorizes nothing.

3. ~~**Register it**~~ **Done** — `src/lib/data/index.ts` now constructs
   `SupabaseDataClient` for `backend === 'supabase'`.

4. **Flip the config.** ⟵ OUTSTANDING (do it after step 1, not before)
   ```
   DATA_BACKEND=supabase
   NEXT_PUBLIC_SUPABASE_URL=https://trocsdetpwyqcgyfclir.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
   ```
   Any value other than `mock` or `supabase` throws at startup rather than
   silently falling back to the mock.

   On Vercel these are Project Settings → Environment Variables. `DATA_BACKEND`
   **must** be `supabase` there: the mock writes to `data/db.json`, and a
   serverless filesystem is read-only and not shared between invocations, so the
   mock backend cannot work in production even as a stopgap.

## Authorization mapping — mock check ↔ RLS policy

This is the diff table. Every row is enforced **twice**: once in TypeScript
(today) and once in Postgres (when the migrations are applied). Each code check
carries a comment naming the object in the right-hand column.

| `DataClient` method | Check in `mockClient.ts` | Postgres object in `0002_rls.sql` |
|---|---|---|
| `listListings`, `getListing` | none — public read, and both filter `!isWithdrawn(l)`; keyword match on **title + description only**; `category` is an exact match against the fixed taxonomy and an unrecognised value matches nothing | `listings_select_public` (`to anon, authenticated using (deleted_at is null)`); the trigram / tsvector indexes in `0001_init.sql` cover exactly those two columns, and `category` is a `public.listing_category` enum column, so an out-of-taxonomy comparison is a cast error rather than a wider result set |
| `listCategories` | none — reads no rows at all; returns the eight `LISTING_CATEGORIES` in fixed display order, `other` last | the `public.listing_category` enum in `0001_init.sql` (`enum_range(null::public.listing_category)`); declaration order is sort order, so no policy and no `order by` CASE is involved |
| `listListingsByCoach` | none — public read, `!isWithdrawn(l)`; `actor` is never consulted, so it cannot be widened into an owner view | `listings_select_public` |
| `getListingForViewer` | published → anyone; withdrawn → owner, admin, or a holder of an order for it, else `null` (a 404, never `forbidden`) | `listings_select_public` for the first, plus `listings_select_own_coach` / `listings_select_purchaser` / `listings_select_admin` for the second |
| `listMyListings` | `resolveProfile()`; filtered to `coach_id === actor`, **withdrawn included**. The coach id is derived, never a parameter | `listings_select_own_coach` — `using (coach_id = auth.uid())`, which is what sees past the public policy's `deleted_at is null` |
| `createListing` | `requireApprovedCoach()`; `coach_id` taken from the resolved actor, never from input; `price_epoch` 1 and `deleted_at` null | `listings_insert_approved_coach` — `with check (coach_id = auth.uid() and public.is_approved_coach())` |
| `updateListing` | `resolveProfile()`; **owner only, never admin** (`forbidden`), then stored `coach_status === 'approved'` (`forbidden`). A WITHDRAWN offer can still be edited — refusing would leave a coach unable to fix what got their offer taken down, and the SQL permits it too. Appends a `listing_revisions` snapshot of the SUPERSEDED row and bumps `price_epoch` **iff the new price is strictly greater** — both inside the same `mutateDb`, so a direct post cannot skip either | `listings_update_own_coach` admits the statement; the `BEFORE UPDATE` trigger `guard_listing_update()` does the rest — pins `coach_id`, confines a non-owner to `deleted_at`, requires `is_approved_coach()` to touch content, forbids edit-and-withdraw in one statement, and **derives** `price_epoch` so a raw `PATCH` cannot skip the archive. The revision is written by the `AFTER UPDATE` trigger `record_listing_revision()` |
| `softDeleteListing`, `restoreListing` | `resolveProfile()`; owner **or** admin (approval NOT required, so a revoked coach can still take their offers off sale); `conflict` on a no-op. Stamps/clears `deleted_at` **and `deleted_by`** — never a row delete. `restoreListing` additionally throws `forbidden` when `deleted_by` is somebody else and the actor is not an admin, so an admin takedown cannot be undone by the coach | `listings_update_own_coach` + `listings_update_admin`, with `guard_listing_update()` limiting a non-owner to exactly that column. **There is no DELETE policy on `listings` for any role** — both earlier ones are dropped |
| `listListingRevisions` | `resolveProfile()`; owner or admin, `forbidden` otherwise. Not public: it would publish a price history per offer | `listing_revisions_select_own_coach` + `listing_revisions_select_admin`. No anon policy, no public view, and **no INSERT/UPDATE/DELETE policy for any client role** — only `record_listing_revision()` writes, as `javelin_privileged` |
| `getOfferStats`, `listOfferStats` | `offerStats()` — **withdrawn offers get no row at all**, then counts orders and reviews at the listing's CURRENT `price_epoch`, which filters but is **not** returned; `rating_average` is `null`, never `0`, for an empty set. `listOfferStats` leaves unknown ids out because there is no row to join to — not as a privacy measure, since each result carries its `listing_id` | the `public.offer_stats` view, granted to `anon, authenticated`. Not `security_invoker`, so it runs as its owner and counts `orders` rows past that table's RLS — publishing the aggregate without publishing a row |
| `getCoachStats` | `coachStats()` — **no** epoch filter and **no `isWithdrawn` filter**; sales scan `orders.coach_id`, reviews join the RAW listings collection, never the public listing reads | the `public.coach_stats` view. Same owner-bypass. Must never gain an epoch filter or a `deleted_at` predicate |
| `listReviewsForListing` | `toPublicReview()` — `[]` for a withdrawn offer, otherwise the current epoch only, so the list agrees with the count | `select … from public.public_listing_reviews where listing_id = $1` (0003). Both the published filter and the current-epoch filter live INSIDE that view — `public_reviews` never projected `price_epoch`, so the client had nothing to filter on. The `reviews` **table** has no anon policy |
| `listReviewsForCoach` | every epoch **and every withdrawal state**, joined to the offer title through the raw listings collection | `select … from public.public_coach_reviews where coach_id = $1` (0003), which carries `coach_id` and the offer title and NO `deleted_at` or epoch predicate, deliberately: it is the ACCOUNT-level source and has to agree with `coach_stats`. Joining `public_reviews` to `public.listings` from the client cannot work — `listings_select_public` hides withdrawn offers from anon, so a visitor would lose exactly the reviews the count still includes |
| *(the public review shape)* | `toPublicReview()` — a field-by-field projection, never a spread: drops `order_id`, `author_id`, `price_epoch`, `updated_at`, and takes the author name from `toPublicProfile()` | the `public.public_reviews` view, which projects exactly those columns and joins `public.public_profiles` for the name |
| *(reading a review row)* | not exposed by any method | `reviews_select_own_author`, `reviews_select_own_coach`, `reviews_select_admin` — an author needs to know they have already reviewed a purchase, a coach needs it for the reviewed flag on their sales list, an admin moderates |
| `getOrder`, `listMyOrders`, `listOrdersForCoach` | `resolveProfile()`, then buyer / selling coach / admin. `listOrdersForCoach` takes an id and therefore checks it; `listMyOrders` derives the id from the actor and cannot be pointed at anyone else | `orders_select_own_learner`, `orders_select_own_coach`, `orders_select_admin`. **There is no `to anon` policy on `orders` at all** — the public sales count comes from the views above, never from a policy here |
| `createReview` | `resolveProfile()`; order must exist (`not_found`) and be the actor's (`forbidden`); the listing's coach may not review it (`forbidden`); one review per order (`conflict`); rating is an integer 1-5 and body 3-2000 chars (`invalid`). `listing_id`/`author_id`/`price_epoch` come from the order and listing, never from input | `reviews_insert_own_purchase` — `with check (author_id = auth.uid() and exists (…orders o where o.id = order_id and o.learner_id = auth.uid() and o.listing_id = listing_id) and not exists (…listings l where l.id = listing_id and l.coach_id = auth.uid()))`, plus the `UNIQUE` constraint on `reviews.order_id` |
| *(order creation)* | none — there is no `createOrder`; every order is fabricated seed data | **no INSERT policy for any client role**, deliberately. A checkout gets its own RPC |
| *(review edit/delete — not in the interface)* | — | `reviews_update_admin`, `reviews_delete_admin`. Authors have no update path at all |
| `getPublicProfile` | `toPublicProfile()` — projects away `email`, `role` and `coach_status`, exposing only the derived `is_approved_coach` | the `public.public_profiles` view (`id`, `full_name`, `(coach_status = 'approved') as is_approved_coach`), granted to `anon, authenticated` |
| `listCoaches` | `isApprovedCoachProfile()` — ONE predicate, used by both directory reads, filtering `coach_status === 'approved'`; then `full_name` only for the keyword, then newest-first | `select … from public.public_coaches where full_name ilike $1`, granted to `anon, authenticated`. **The approval predicate is inside the view**, so no caller-supplied filter can widen it |
| `getPublicCoach` | same predicate; `null` for an unknown id AND for a real user who is not an approved coach — deliberately indistinguishable | `select … from public.public_coaches where id = $1`. A non-approved id simply matches no row |
| `listCoachStats` | `coachStats()` per id, **in the order given, with unknown ids kept as zeros** — unlike `listOfferStats`, which drops them, because `getCoachStats` always returns a row and the batch must not disagree with the single form | `select … from public.coach_stats where coach_id = any($1)`, LEFT-joined back onto the requested ids and coalesced |
| `updateMyCoachProfile` | `resolveProfile()` + `isApprovedCoachProfile()`; writes ONLY `coach_headline` / `coach_bio` / `coach_years_coaching`, never `role` / `coach_status` / `id` / `email` / `full_name`. Subject is the resolved actor, never a parameter — **not an admin** | policy `profiles_update_own` (`id = auth.uid()`), with `guard_profile_privilege_columns` pinning the privilege columns. The three coach columns are **not** exempt from that trigger: changing any of them while `is_approved_coach()` is false raises `Only approved coaches can edit a public coach profile.` (0002_rls.sql). What they are outside of is the *privilege*-column pin — a coach may edit their own bio, an unapproved user may not. See "The three coach columns are writable only by an approved coach" below |
| *(the public coach shape)* | `toPublicCoach()` — a field-by-field projection, never a spread: drops `email`, `role`, `coach_status`, and carries **nothing from `coach_applications`**. No `is_approved_coach` either: every row it builds is one, so the column would be a constant | the `public.public_coaches` view, which projects exactly those five columns |
| `getProfile` | `resolveProfile()`, then self-or-admin; `forbidden` otherwise | `profiles_select_self` + `profiles_select_admin`. There is **no** public select policy on `profiles` |
| `signUp` | new profile pinned to `role='learner'`, `coach_status='none'` | `handle_new_user()` (`after insert on auth.users`) inserts the same pinned values; `profiles_insert_self` constrains any client-side bootstrap identically |
| *(profile self-edit)* | — | `profiles_update_own` + the `profiles_guard_privilege_columns` trigger, which rejects self-service changes to `role`/`coach_status`/`id`/`email` |
| `createInvite` | `requireAdmin()`; `created_by` from the actor | `invites_insert_admin` — `with check (public.is_admin() and created_by = auth.uid())` |
| `listInvites` | `requireAdmin()` | `invites_select_admin` (no non-admin select policy exists at all) |
| `revokeInvite` | `requireAdmin()`, then `not_found` / `conflict` on state | `invites_update_admin` |
| `redeemInviteCode` | `resolveProfile()` (any signed-in user); claim + promote in one `mutateDb`; `promoteToCoachRole()` | `public.redeem_invite_code(text)` — `SECURITY DEFINER`, owned by `javelin_privileged`, `grant execute to authenticated`; conditional `UPDATE ... where redeemed_by is null and revoked_at is null and (expires_at is null or expires_at > now())`; `role = case when p.role = 'learner' then 'coach' else p.role end` |
| `createCoachApplication` | `resolveProfile()`; `user_id` from the actor; `conflict` on already-approved and on an existing pending row; **sets the actor's `coach_status` to `pending_review` in the same mutation** | `public.apply_to_coach(text, text, text)` — `SECURITY DEFINER`, owned by `javelin_privileged`. Does the insert *and* the `coach_status = 'pending_review'` update. `coach_applications_insert_own` + `coach_applications_one_pending_per_user_idx` remain as backstops |
| `getMyCoachApplication` | `resolveProfile()`, filtered to `user_id === actor` | `coach_applications_select_own` — `using (user_id = auth.uid())` |
| `listCoachApplications` | `requireAdmin()` | `coach_applications_select_admin` — `using (public.is_admin())` |
| `reviewCoachApplication` | `requireAdmin()`; `forbidden` on self-review; `conflict` unless `status === 'pending'`; writes the review columns **and** the applicant's profile via `promoteToCoachRole()` | `coach_applications_update_admin` + `public.review_coach_application(...)`, which re-checks `is_admin()`, refuses `a.user_id = v_admin_id`, pins `and a.status = 'pending'` in the `UPDATE`, and raises role only |
| *(all methods)* | `Actor` is `{ userId }` or `null`; role/`coach_status` re-read from the store every call | policies may reference only `auth.uid()` |

## Bootstrapping (and repairing) an administrator

There is exactly one supported path, and it needs direct database access:

```sql
-- From psql or the Supabase SQL editor, where auth.uid() is NULL:
select public.grant_admin('00000000-0000-4000-8000-000000000001');
```

Why a function is necessary: `guard_profile_privilege_columns` refuses any
`update profiles set role = 'admin'` that arrives from an API session, and from
psql `auth.uid()` is NULL so `is_admin()` is false too. `seed.sql` only works
because INSERT is unguarded — no help once the row already exists.
`grant_admin()` is `SECURITY DEFINER` and authorises on
`public.is_admin() or session_user <> 'authenticator'`; every PostgREST request
arrives as `authenticator`, so the second clause means "you already have direct
database access". It is deliberately **not** granted to `authenticated`.

In the mock there is no equivalent method: the seeded admin comes from
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` on first run, and
`scripts/verify-authz.mts` promotes its second test admin by writing to the
store directly, which is the test standing in for `grant_admin()`.

## Design notes worth knowing before you review the SQL

**`public.is_admin()` is `SECURITY DEFINER` on purpose.** A policy on `profiles`
that asks "is the caller an admin?" must read `profiles`, and that read is
itself policy-checked — Postgres raises
`infinite recursion detected in policy for relation "profiles"` (42P17). Running
the lookup as the function owner, for whom RLS is not enforced, breaks the
cycle. `public.is_approved_coach()` follows the same pattern. Both pin
`search_path` to `public, pg_temp`, which is mandatory hardening for any
`SECURITY DEFINER` function. Both take **no parameter**: an earlier revision
exposed `is_admin(uuid)` to `anon`, which let any visitor probe whether a given
uuid was an administrator. The parameterised overloads are dropped rather than
merely revoked, so they cannot be granted back by accident.

**Role escalation is blocked by a trigger, not a `with check`.** The requirement
is "a user may update their own profile but must not change their own `role` or
`coach_status`" — an inherently OLD-vs-NEW comparison, and a `with check`
expression can only see NEW. So `profiles_guard_privilege_columns` (a
`BEFORE UPDATE` trigger) is the authoritative guard; it fires for every writer
regardless of which policy admitted the statement.

**The guard's identity test is a role, not a GUC.** An earlier revision gated
the guard on a `javelin.privileged_profile_write` setting, which any client can
`SET` — the sole gate on the privilege guard was a value the attacker controls.
It now tests `current_user = 'javelin_privileged'`, a `NOLOGIN` role created by
the migration that owns the four promotion functions. Inside a `SECURITY
DEFINER` function `current_user` is the function owner, so the test is true
exactly inside those functions and nowhere else; the role is never granted to
`anon`, `authenticated` or `service_role`, and there is no statement a client
can issue to become it.

Two consequences worth noting:

* The guard trigger is deliberately **`SECURITY INVOKER`** (no `security
  definer` on it). Its entire job is to observe who is writing; as a definer
  function `current_user` would collapse to its own owner for every caller and
  the test would authorise everyone.
* `javelin_privileged` does **not** bypass RLS — it is not a table owner and
  `BYPASSRLS` needs superuser, which Supabase's migration user does not have.
  It gets explicit table grants plus the `*_privileged` policies instead. That
  keeps the whole migration runnable as an ordinary `CREATEROLE` user. If your
  environment forbids `CREATE ROLE` entirely, the fallback is to leave the
  functions owned by the table owner and test `current_user` against that owner
  instead — **do not** fall back to the GUC.

**The aggregate is public; the rows it counts are not.** `orders` has RLS with
three SELECT policies — your own purchases, your own sales, admin — and no
`anon` policy whatsoever. The "12 sales" a visitor sees does not come from a
policy on that table; it comes from `public.offer_stats` / `public.coach_stats`,
views that are not `security_invoker` and therefore read as their owner, past
that RLS. Exactly the `public_profiles` mechanism, and with exactly the same
caveat: `alter table public.orders force row level security` would subject the
owner to RLS too, the views would collapse to rows the caller can already see,
and every public sales figure would silently become zero. If FORCE is ever
enabled, give the aggregate its own policy — never widen the table.

Check what the views project before granting anything else on them: counts, a
rounded average, and ids that are already public. No `learner_id`, no price
paid, no per-order timestamp that could be correlated back to a buyer.

**`coach_stats` must never learn about epochs or deletion.** It is the one
aggregate that answers "how is this coach", and both of the offer-lifecycle
mechanisms are things that must not silently erase a reputation: raising a price
archives an *offer's* social proof, and withdrawing an offer hides it from
browse. Neither undoes coaching that was sold and reviewed. The sales half is
immune by construction (it scans `orders.coach_id` and never touches
`listings`); the review half joins `listings` only to find out whose offer it
was, and that join has to stay unfiltered. The mock's `coachStats()` mirrors
this by reading the raw listings collection rather than the public listing
reads.

**Two rules on `listings` are triggers, not policies, and for the same reason
the profile guard is.** `guard_listing_update()` has to answer "did this column
change?" and "how did the price move?", both of which need OLD as well as NEW —
which a `with check` cannot see. So the policies admit an UPDATE broadly (the
owner, or an admin) and the trigger confines it:

* a **non-owner, including an admin, may change only `deleted_at`**. That is the
  takedown, and it is deliberately not an edit permission: an admin who could
  rewrite a coach's copy would be publishing words under that coach's byline.
  The mock mirrors it by having no admin arm in `updateListing` at all;
* **`price_epoch` is derived, never supplied** — `old.price_epoch + 1` when the
  new price is *strictly* greater, unchanged otherwise. Putting it here rather
  than in an RPC is what makes it unskippable: a client that `PATCH`es
  `price_cents` straight through PostgREST gets the archive whether it asked for
  one or not, which is the SQL half of "posting the form directly must not skip
  the archive";
* the approval requirement moved here too. `listings_update_own_approved_coach`
  is **replaced** by `listings_update_own_coach` — approval gates *editing*, but
  it must not gate *withdrawing*, or a coach whose approval lapses is left with
  offers stuck on sale that only an admin can remove.

Two further rules live in the same trigger, both added with `deleted_by`:
**only an admin may clear a `deleted_at` somebody else set** (a takedown the
coach reverses in one click is not a takedown — and it is `old.deleted_by` that
decides, which is precisely why a `with check` cannot express it), and
**`deleted_by` is derived, never supplied**: `auth.uid()` on withdrawal, `NULL`
on restore. A column that decides an authorization outcome must not be writable
by the party it constrains, exactly as for `price_epoch`.

`deleted_by` is `on delete set null` for the same reason as
`coach_applications.reviewed_by`: an admin who is later deleted must not make
every offer they ever took down undeletable. **The accepted consequence, stated
so it is a recorded trade rather than a surprise:** deleting an administrator
nulls the column on every offer they took down, which converts those takedowns
into ordinary coach-restorable withdrawals. That is the right way round —
failing closed instead would strand rows that nobody, coach or admin, could
restore, including every row withdrawn before this column existed.

**`deleted_by` never reaches a caller, and that is enforced twice** — once per
backend, because neither mechanism covers the other:

* in the mock, by projection: `ListingWithCoach` is
  `Omit<Listing, 'deleted_by'>` and `withCoach()` is field-by-field, so
  re-adding the column does not compile;
* in Postgres, by a **column-level grant**. RLS is row-level, so
  `listings_select_own_coach`, `_purchaser` and `_admin` each hand over the
  whole row — `GET /rest/v1/listings?select=*` would return `deleted_by` to any
  coach or buyer holding a JWT, and PostgREST is reachable from a browser with
  the anon key. A data-layer projection is a convention there, not a boundary.
  So `0002_rls.sql` re-issues the grant column-wise: `revoke select on
  public.listings from anon, authenticated`, followed by a `grant select (…)`
  naming every column except this one.

  **Two things about that mechanism that are easy to get wrong.** A bare
  `revoke select (deleted_by) on public.listings from …` does **not** work: in
  PostgreSQL a column-level revoke does not subtract from a table-level grant,
  and Supabase grants table-level `SELECT` to `anon`/`authenticated` by default,
  so the revoke would be a silent no-op. The table privilege has to be revoked
  and the columns granted individually, which is what the migration does. And
  because `SELECT *` expands to *every* column, a client holding only
  column-level privileges gets a **permission error (42501) on `select=*`**, not
  a row with the column quietly missing. `SupabaseDataClient` must therefore
  enumerate columns rather than call `.select('*')` on `listings` — which is what
  it should do anyway, since the projection is the point. Add any new
  `listings` column to that grant or it becomes unreadable.

After a takedown this is an administrator's id, so publishing it is
administrator enumeration — exactly what `public_profiles` drops `role` to
prevent. The derived `withdrawn_by_admin` boolean on `listMyListings` is what a
dashboard gets instead, and it answers "will Restore work?" without naming
anyone.

`record_listing_revision()` is `SECURITY DEFINER` owned by `javelin_privileged`
for a specific reason: no client role holds `INSERT` on `listing_revisions`. Run
as the invoker it would need one, and that grant is exactly what would let a
coach suppress or rewrite the history of their own offer.

**`price_cents_at_purchase` is a snapshot, and `orders.listing_id` is
`ON DELETE RESTRICT`.** An order is a record of money changing hands: editing an
offer's price must not rewrite what somebody paid, and deleting an offer must
not erase its sales history. The restrict is deliberate and has a cost — an
offer that has sold cannot be hard-deleted — which is precisely why withdrawal
**is** a soft delete: `listings.deleted_at`, with no DELETE policy on the table
for anybody, so the RESTRICT is never the thing a coach runs into.

**`coach_stats` and `public_reviews` must never learn about `deleted_at`.** This
is the same warning as the epoch one above and it now has a live column behind
it. `listings_select_public` and `offer_stats` both carry `deleted_at is null`;
copying that predicate into `coach_stats` would delete a coach's entire
reputation the moment they withdrew one old offer, and copying it into
`public_reviews` would make their public review list disagree with their own
review count. `scripts/verify-authz.mts` withdraws a seeded offer through the
real method and pins both numbers across it, in the same block that pins the
offer's disappearance from every public read — so the tripwire fires in both
directions.

**Redemption is an RPC, not a table write.** Non-admins hold no privilege on
`invites` whatsoever — not even `select`, so a learner cannot enumerate codes to
guess at them. `redeem_invite_code()` runs as `javelin_privileged` and does the
claim with a conditional `UPDATE` whose predicate is also the validity check,
which makes it the concurrency lock: two simultaneous redemptions of the same
code cannot both match `redeemed_by is null`. Every failure mode (unknown,
revoked, expired, already redeemed) returns the same message, so the endpoint is
not a code oracle. The mock does exactly the same, for the same reason.

**Applying is an RPC for a subtler reason.** Filing an application has two
halves — insert the row, and move the applicant's own `coach_status` to
`pending_review`. `coach_applications_insert_own` admits the first; the guard
trigger refuses the second. A client that did them separately would commit the
application, get 42501 on the profile update, and be permanently wedged: the
retry hits `coach_applications_one_pending_per_user_idx` and fails with 23505.
`apply_to_coach()` does both in one transaction, mirroring the single
`mutateDb()` in `mockClient.createCoachApplication()`.

**Promotion only ever raises privilege.** Both `redeem_invite_code()` and
`review_coach_application()` set `role = case when p.role = 'learner' then
'coach' else p.role end`, and `promoteToCoachRole()` is the same rule in the
mock. An unconditional `role = 'coach'` demoted any admin who redeemed a code —
and since the seeded code is printed in `README.md` right beside the admin
account, and an admin could file *and self-approve* an application, the store
could end up with zero admins and no supported recovery. Admins are additionally
barred from reviewing their own application.

**Applicants have no `UPDATE` path on `coach_applications` at all.** Granting
one would let them set `status`/`reviewed_by`/`reviewed_at`, and pinning those
columns for a self-update would need yet another guard trigger. Applicants who
want to change their pitch withdraw and re-apply.

**Email never reaches a public surface.** `profiles` carries email and is
selectable only by its owner (`profiles_select_self`) and by admins
(`profiles_select_admin`). Everything public reads the `public_profiles` view,
which projects `id`, `full_name` and a derived `is_approved_coach` boolean, and
nothing else. `role` and `coach_status` are deliberately excluded: publishing
`role` to `anon` would let anyone enumerate the full administrator roster with
only the anon key, and `coach_status` would make every user's `pending_review` /
`rejected` state world-readable. The view is intentionally not
`security_invoker`, so it reads as its owner. The mock mirrors this exactly:
`getPublicProfile()` returns a `PublicProfile` of `{ id, full_name,
is_approved_coach }`, and `getProfile()` throws `forbidden` for a non-owner
non-admin.

### The public coach bio is COPIED at approval. It is not a join.

`coach_applications.bio` is a **review artifact**: written for an administrator,
readable only by its author and by admins. A public coach profile that
`SELECT`ed it would publish text the applicant never intended to publish — and
would keep republishing every later edit, with no moment at which anyone decided
to publish anything.

So `public.review_coach_application()` copies it **once**, at approval, into
`profiles.coach_bio`, and only when that column is still empty
(`coalesce(nullif(btrim(p.coach_bio), ''), v_app.bio)`). From then on the column
is the coach's own, editable through `profiles_update_own`, and the application
is irrelevant to it. `mockClient.reviewCoachApplication()` mirrors this with
`hasCoachBio()`.

Three consequences, all deliberate:

* **Only `bio` is copied.** `experience` is prose written to a reviewer and is
  not a headline; `sport` is not a dimension in this product at all; and no
  integer can be recovered from free text, so `coach_headline` and
  `coach_years_coaching` stay NULL for the coach to fill in.
* **An invite-redeemed coach has no bio**, because they filed no application.
  "An approved coach with an empty profile" is a normal state, not an edge case
  — Nils Berg (`…0004`) is seeded in it so the UI's empty states have a fixture.
* **A rejected application copies nothing**, and there is no `public_coaches`
  row to read it from either.

The apply form discloses this at the point of collection ("If you are approved,
this becomes the first draft of your public coach profile"). That disclosure is
what makes the design honest rather than merely lawful, and it should not be
removed without removing the copy.

`scripts/verify-authz.mts` pins the copy/join distinction directly: it approves
an applicant, then **edits the application row afterwards** and asserts the
public bio does not move. A live join passes every other assertion and fails
that one.

### The three coach columns are writable only by an approved coach — in BOTH backends

This was a real mock/SQL divergence and it is closed in SQL rather than
documented, because it changed **what gets published**.

`updateMyCoachProfile()` refuses a non-approved actor. `profiles_update_own` on
its own carries no such predicate, so through PostgREST a plain learner could
`PATCH` their own `coach_bio` before ever applying to coach. That is not a
harmless unused column: `review_coach_application()` copies the application bio
with `coalesce(nullif(btrim(p.coach_bio), ''), v_app.bio)`, so **a pre-written
bio suppresses the one-time copy at approval**. The same user actions would then
publish self-written text on Supabase and the application bio on the mock.

`guard_profile_privilege_columns()` now rejects a change to
`coach_headline` / `coach_bio` / `coach_years_coaching` unless
`public.is_approved_coach()` holds for the writer. The privileged arms
(`javelin_privileged`, a direct connection, an admin) return before it, so the
approval copy inside `review_coach_application()` — which runs as
`javelin_privileged` — is unaffected.

`is distinct from` rather than `<>`, because NULL is the normal value for all
three and `NULL <> NULL` is NULL, which would not fire the guard.

### The coach directory cannot be widened

`public.public_coaches` carries `where p.coach_status = 'approved'` **in the
view**, and `PublicCoach` has no `role`, no `coach_status` and no
`is_approved_coach` column. There is therefore nothing for a caller to put in a
predicate, and no wider relation they hold any privilege on — `profiles` itself
is readable only by its owner and by admins.

Selecting a coach who is not there returns the same nothing for a learner, a
pending applicant, a rejected applicant, an administrator and a uuid belonging
to nobody. That is strictly less than `public_profiles.is_approved_coach`, which
is already public.

An administrator who redeemed an invite code **is** an approved coach and
legitimately appears in the directory. Their row is byte-shape-identical to
every other coach's, which is asserted, so the directory is not an admin oracle.

## Known mock ⇄ SQL divergences

These are the places where the two implementations are not literally
interchangeable. None is a privilege difference; they are all about *which
error you get*, or about capabilities that exist on only one side.

| Divergence | Detail |
|---|---|
| `revokeInvite` error granularity | The mock distinguishes `not_found` / "already redeemed" / "already revoked". RLS cannot produce three different outcomes for one `UPDATE` — Postgres just reports 0 rows affected. The `SupabaseDataClient` must re-`select` the invite to reproduce the distinction, or accept a single `not_found`. |
| `grant_admin()` | SQL-only. The mock seeds its admin from `SEED_ADMIN_EMAIL`; there is no `DataClient` method, by design. |
| Validation messages | The mock validates lengths (title ≤ 140, bio ≥ 20 chars, …) before touching the store; SQL only has `price_cents >= 0` and NOT NULL. Field-level messages therefore come from application code in both backends — the `SupabaseDataClient` must keep the same validation helpers or the UI copy changes on swap. |
| `invites.created_by` is `ON DELETE RESTRICT` | Deliberate: an invite is the audit record of who granted somebody coach status, and an author that has silently become NULL is worth little. The documented cost is that an admin who has minted invites cannot be hard-deleted until those invites are reassigned or removed. `redeemed_by` and `reviewed_by` are `ON DELETE SET NULL`, so they never block a deletion. The mock does not model deletion at all. |
| Password storage | The mock uses `scrypt` in `store.ts`; Supabase uses its own `auth.users`. `signUp`/`signInWithPassword` are the only methods whose internals differ completely. |
| `createReview` error granularity | The mock distinguishes `not_found` (no such order) from `forbidden` (somebody else's order). In Postgres both are one failed `with check` → 42501, so the `SupabaseDataClient` must re-`select` the order to reproduce the distinction, or accept a single `forbidden`. Same shape as the `revokeInvite` row above. The distinction is not an enumeration oracle: order ids are random v4 UUIDs, so "does this id exist" cannot be asked usefully. |
| `getCoachStats` for an unknown id | The mock returns zeros with a `null` average — the same answer a brand-new coach gets — and never checks whether the id is a real profile. Deliberate: an error would make the endpoint an existence probe. **The view does not do this by itself.** `coach_stats` selects `from public.profiles`, so an id that is not a profile matches **no row**, and returning that straight through would yield `null`/`undefined` and break the interface's "always returns a row" guarantee. `SupabaseDataClient` must coalesce a missing row to `{ coach_id, rating_average: null, review_count: 0, sales_count: 0 }`. A brand-new coach who *does* have a profile row needs no fallback — the aggregate subqueries already return 0 and NULL over their empty sets. |
| `getOrder` error granularity | The mock throws `forbidden` for somebody else's order and returns `null` for one that does not exist. RLS expresses both as ZERO ROWS, and telling them apart needs a read that bypasses `orders_select_*` — which this client deliberately cannot make. **`SupabaseDataClient.getOrder` therefore returns `null` for both.** `listOrdersForCoach` still throws `forbidden`, and that is not an inconsistency: it takes a coach id and can compare it with the actor's own id without asking the database anything. The UI treats `null` as a 404, which is the right answer for a stranger either way. |
| Refusals on a WITHDRAWN offer a stranger cannot see | `updateListing`, `softDeleteListing`, `restoreListing`, `listListingRevisions` and `createReview` read the listing first to produce a specific message. For a withdrawn offer, RLS hides the row from anyone who is not its coach, a purchaser or an admin — so on Supabase those methods say *"That offer could not be found."* where the mock says *"You can only withdraw your own offers."* The refusal is identical; only its wording is less specific, and only for a listing the caller was never allowed to know existed. |
| Malformed (non-UUID) ids | Every id column is `uuid`, so `?id=eq.junk` fails at the CAST with `22P02` instead of matching no row. The READ paths (`getListing`, `getPublicCoach`, `getProfile`, `getOrder`, `listReviewsFor*`, …) catch it and return `null`/`[]`, because `src/app/offers/[id]/page.tsx` requires a hand-typed URL to reach the 404 page rather than the error boundary. WRITE paths let it throw as `invalid`. The mock needs none of this: a string comparison against a JSON array simply misses. |
| `*` in a search term | PostgREST rewrites `*` to `%` in `like`/`ilike` before Postgres sees the pattern, and offers no escape sequence that makes it literal. `escapeLike()` in `supabaseClient.ts` therefore returns `null` for any term containing one, and `listListings` / `listCoaches` return `[]` while `revokeInvite` reports `not_found`. The mock would match rows containing a literal asterisk, so Supabase is NARROWER here — deliberately. Both alternatives widen: leaving `*` alone makes `q = '*'` the pattern `%%`, and merely stripping it makes `'*'` collapse to `''` which `likePattern` wraps back into `%%`. Either way one backend returns the entire catalogue for a one-character query, and `'Ja*'` silently becomes a `Ja` substring search. Narrowing is the only safe direction. |
| Refusal wording that comes from SQL rather than TypeScript | Where a refusal originates in a `raise exception`, the user sees the SQL's sentence, not the mock's. `reviewCoachApplication` on a well-formed but nonexistent id is the live example: `review_coach_application()` raises `'Application not found.'` (P0002) where the mock says `'That application could not be found.'`. Same `DataError` code, different sentence. This is the deliberate half of `errors.ts` — the RPCs are the only place that knows *why* an operation was refused, and their messages were written as end-user copy, so they are preserved rather than replaced. Keep the two in step when editing either. |
| Revision ordering under a same-millisecond tie | The mock sorts revisions by `created_at desc` after a `.reverse()`, so two edits saved inside the same millisecond come back later-first. Postgres has no insertion order to fall back on, so `SupabaseDataClient` must issue `order by created_at desc, id desc` to be deterministic at all. The tie is only reachable by two edits in the same millisecond, which the mock's own file write makes unlikely, but the ordering contract is "newest first" and it should not depend on that. |
| Rating rounding | The mock rounds half-up in JS (`Math.round(x * 10) / 10`); the views use `round(avg(rating)::numeric, 1)`. Ratings are positive, where the two agree. Change one and the rendered number changes on swap. |

## Follow-ups for the real deployment

* `orders` has no INSERT path at all. A checkout needs its own RPC — never a
  policy that lets a client name its own `price_cents_at_purchase`.
* No pagination anywhere — `listListings` returns every row, and so do the
  review lists.
* `handle_new_user()` derives `full_name` from signup metadata, falling back to
  the local part of the email. Make the signup form send `full_name` metadata so
  the fallback is never hit.
* Consider `alter table ... force row level security` once nothing depends on
  the owner bypass, and re-test `is_admin()` for recursion if you do.
