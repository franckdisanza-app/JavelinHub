# What is missing — a gap analysis

Written after the mock → Supabase swap landed and the schema was applied to a
live project. Everything below is grounded in the repo as it stands, not in
general advice about marketplaces: where something is claimed absent, the file
that documents the absence is cited.

Ordered by what blocks a launch, not by effort.

---

## 1. ~~The product cannot be delivered~~ — now: the money

**This was the gap that mattered, and delivery has closed it.** The section is
kept rather than deleted, because what it says about the categories is still the
reason the design is shaped the way it is. The eight offer categories in
`src/lib/data/types.ts` are:

| | |
|---|---|
| `training_plan` | `recovery_plan` |
| `mobility_plan` | `weightlifting_plan` |
| `nutrition_plan` | `video_review` |
| `mental_training` | `other` |

**Seven of the eight are a file or a document.** There is now a file: both
delivery modes ship, in both directions, and a coach who sells a video review
can return the video. What remains unbuilt in this section is everything to do
with money — §1.3 and §1.4 — and a lifecycle beyond "claimed, delivered,
reviewed".

In dependency order:

### 1.1 File storage and delivery
**Partly done.** Avatars ship (`0008_avatars.sql`, `src/lib/storage/avatars.ts`),
which was the point: they depend on nothing, so they were the cheapest way to
prove buckets, storage RLS, upload and public URLs before betting delivery on
them. Verified end to end against the live project — upload, render, replace,
remove, and refusal of a write outside the owner's own folder.

**Personalised delivery ships too** (0011, `src/lib/storage/deliverables.ts`,
`/orders/[id]`): private buckets, short-lived signed URLs, and a `deliverables`
table joining an order to what was handed over. Both parties upload against the
same order and the direction is derived from who is signed in. Verified end to
end — claim, buyer sends a video, coach returns a PDF, buyer reviews — and the
isolation that matters holds: a buyer who claimed the SAME OFFER cannot read the
other buyer's file.

**Instant delivery ships too.** The 0011 schema — `fulfilment`,
`listings.asset_path`, the `offer-assets` bucket and its five policies — is now
reachable end to end: a mode picker on publish, an attach/replace/remove control
on the editor, the download on `/orders/[id]`, and the mode on the public offer
page so a buyer knows how a thing arrives before claiming it.

The part that needed a decision was READING the path. `asset_path` is withheld
from the client column grant on purpose, and a grant is the wrong instrument to
relax it with — role-level, so granting it to `authenticated` publishes every
coach's paths through PostgREST. 0012 adds the two row-level reads instead:
`owned_listings` gains the column for the coach who owns the offer, and
`entitled_offer_assets` restates the `offer_assets_read_entitled` storage policy
for a learner holding an order. Both scope by `auth.uid()` inside the view. An
admin can read somebody else's order and is deliberately not handed its file.

Two states the product now has to render honestly, and does: an instant offer
published before its file attached is legal, visible and **unclaimable**
(`claim_offer` refuses it, the dashboard says *Needs a file*); and the delivery
mode is frozen at the first claim, so the editor locks the control rather than
offering one the database will refuse.

Storage is deliberately NOT part of `DataClient`: that interface abstracts rows
and has a mock twin for the authorization suite, while bytes have one
implementation and no mock analogue. The PATH is data — `setMyAvatar()`, both
backends — and the FILE is storage, Supabase only.

Storage split, decided earlier: Supabase Storage for avatars, PDFs and chat
images; **Cloudflare R2 for video**, because egress is what makes video
expensive and R2 charges none. Keep the metadata rows in Postgres either way so
the backing store stays swappable per asset type.

### 1.2 Checkout
**Done, minus the money.** `claim_offer(uuid)` (0009/0010) is the RPC
`docs/DATA-LAYER.md` always said a checkout would need: it derives learner from
the JWT and coach, price and epoch from the listing, so nothing about an order
is caller-supplied except which offer. There is still no client `INSERT` policy
on `orders` and there should never be one.

Claiming is FREE, which is a decision and not a stub — the pilot is proving that
an offer can be claimed, delivered and reviewed, not that a card can be charged.
When payment lands it goes IN FRONT of this call: the order is still created by
the same RPC, on the far side of a confirmed charge, and the row already carries
`price_cents_at_purchase` for the receipt.

Still missing: Stripe, and the confirmation step a paid claim needs (the free
one deliberately has none — the worst case is an unwanted free claim on an offer
that cannot be claimed twice).

### 1.3 Payments *and payouts*
No Stripe anywhere in `src/`. A marketplace needs both directions — charging
the learner and paying the coach. Payouts (Stripe Connect: onboarding, KYC,
transfers, 1099s) are usually the larger build and are routinely forgotten at
this stage.

### 1.4 An order lifecycle
An `Order` today is a receipt with no state. There is no "paid → coach notified
→ delivered → accepted", no delivery deadline, no dispute path, no refund. That
state machine is what makes the money movement safe to automate.

---

## 2. ~~Coaches cannot fill in their own profiles~~ — done, twice over

**Stale for several rounds and finally corrected.** This section claimed
`updateMyCoachProfile` "has no page" while §3 listed `/coach/profile` as done
and the page had existed all along. The two disagreed inside one document; §3
was right.

It is now done twice over, because the split it implied was missing a half.
`/coach/profile` edits the three columns published through `public_coaches` and
says of itself that it is *not* an account page. Nothing was the account page,
so three things had no home:

* **`full_name` had no write path at all**, for anybody. Taken from the signup
  form (or the local part of the email) and never editable again — and it is the
  name on every review its author has written.
* **the picture was coach-only in the UI**, though `setMyAvatar` has always been
  open to any signed-in user and its own doc comment said so: *"`profiles` is
  everyone's row, and the SQL agrees. Only the UI is coach-facing today."*
* **no way to change a password while signed in.** The only path was the reset
  flow, which asks for no current password on purpose — the wrong trade for
  somebody signed in on a borrowed laptop.

`/settings` closes all three, for everyone. The picture also renders in the
header now, so a learner's upload is visible somewhere rather than only in the
form that made it: reviews carry `author_name` and no avatar.

---

## 3. Eleven of 39 data-layer methods have no UI

The data layer is well ahead of the app. These are written, authorization-
checked, and exercised against Postgres — they need pages, not plumbing.

| Method | UI | |
|---|---|---|
| `updateMyCoachProfile` | `/coach/profile` | **done** |
| `listMyListings` | `/coach/offers`, incl. the `withdrawn_by_admin` flag | **done** |
| `updateListing` | `/coach/offers/[id]/edit` | **done** |
| `softDeleteListing` / `restoreListing` | withdraw / restore controls | **done** |
| `listListingRevisions` | edit history on the editor | **done** |
| `getListingForViewer` | `/offers/[id]`, the withdrawn tombstone | **done** |
| `listMyOrders` | `/purchases` | **done** |
| `listOrdersForCoach` | `/coach/sales` | **done** |
| `getOrder` | `/orders/[id]` | **done** |
| `createReview` | the review form on `/orders/[id]` | **done** |

**All ten now have a UI**, and `setListingAsset` — added with instant delivery —
shipped with its own controls on the editor and the composer.

The last one, `getListingForViewer`, turned out not to be a dormant gap at all.
`/offers/[id]` used `getListing`, which 404s a withdrawn offer for everybody —
while `/purchases` rendered an **unconditional** "View the offer" link under a
comment claiming it was "only rendered when there is somewhere to go". It was
not. A buyer whose coach withdrew an offer followed their own purchase history
into the not-found page, which is precisely the dead end the `ListingDetail`
union was written to prevent and never wired up to. `/offers/[id]` now asks the
viewer-aware read and renders the tombstone for the owner, an admin and anyone
holding an order; everyone else still gets the 404. The loop closes: a
coach publishes and manages offers in either delivery mode, a learner claims one
and either downloads it immediately or exchanges files against that order, and
the buyer reviews it. What is left in §1 is the money.

The nine methods added since — `reportReview`, `reportCoach`, `listMyReports`,
`listReports`, `resolveReport`, `setCoachStatus`, `listCoachesForAdmin`,
`listListingsForAdmin`, `listAdminActions` — each shipped in the same commit as
the page that calls it, which is the habit this section exists to enforce. The
one that had to be invented for the UI rather than the other way round is
`listListingsForAdmin`: without it a reinstated coach would be left with a shelf
of admin-withdrawn offers that nobody could put back, since a coach may not lift
an administrator's takedown.

---

## 4. Auth is half-built

* ~~**No password reset.**~~ **Done.** `/forgot-password`, `/reset-password`
  and the `/auth/callback` Route Handler that redeems the link, in both
  backends: GoTrue's recovery flow on Supabase, and an equivalent token
  mechanism in `src/lib/auth/reset-tokens.ts` on the mock, which prints the
  link to the server console because it has no mail transport and should not
  have one. The link is treated as a credential throughout — 32 random bytes,
  SHA-256 at rest, one hour, single use, superseded by any newer request — and
  the request form gives the same answer for every address, so it is not an
  account-enumeration oracle.

  ~~**Two things it is NOT.**~~ **Both closed.** Rate limiting landed with the
  limiter itself (§6), and the reset now **signs out every other session**.

  `destroyOtherSessions()` in `session.ts` is the same dispatching shape as
  `createSession` / `destroySession`, and it is called by BOTH password paths —
  the reset flow and `/settings` — because the two arguments point the same way:
  somebody resetting because they were compromised, and somebody changing a
  password on a borrowed laptop, are both handed the account back by a change
  that leaves the old sessions running. Both forms now say so in their success
  message, because otherwise the user's phone asking them to sign in again looks
  like a fault.

  **The divergence is narrower, not gone.** On Supabase it is
  `signOut({ scope: 'others' })`, which revokes every refresh token but cannot
  revoke an access token already issued — up to an hour, the same residual
  account deletion carries and documented in the same terms. On the mock it is a
  deliberate no-op: that cookie is stateless by design, so there is no revocation
  list to write to, and inventing one would mean a second implementation of
  session validity for a backend that cannot be deployed at all.

  **Deployment still needs three dashboard settings** that are not in this
  repo: `NEXT_PUBLIC_SITE_URL` on Vercel, the same origin added to Supabase's
  Redirect URLs, and Site URL moved off `http://127.0.0.1:3000`. Until then
  GoTrue refuses the redirect, which is the correct failure — the app builds
  the link from configuration and never from the request's `Host` header,
  precisely so that a crafted request cannot make us email a valid reset link
  pointing somewhere else.
* ~~**No email change and no account deletion.**~~ **Both done.** Name, picture,
  email, password and the way out all live at `/settings`, for everyone.

  **Deletion ANONYMISES rather than erases**, because the foreign-key graph
  leaves no honest alternative: `listings.coach_id` cascades while
  `orders.listing_id` is `ON DELETE RESTRICT`, so a coach who has ever sold
  could not be removed at all — and a learner who could would take their
  purchases and reviews with them, reducing some coach's sales count and rating.
  One person's departure must not rewrite another's history. The row survives
  with its personal data replaced; `verify:authz` asserts that a third party's
  numbers do not move.

  Three things fell out of it that were not obvious from the outside.
  `delete_my_account()` **cannot withdraw the user's offers** —
  `guard_listing_update()` calls `auth.uid()` and the privileged role owning the
  function cannot reach that schema — so it REFUSES while any is on sale, and
  the ordering becomes an invariant rather than a convention. It **cannot touch
  `auth.users`** either, so the GoTrue user is banned separately; deleting it
  would cascade `profiles` and undo the whole design. And an **administrator
  cannot delete themselves**, because `invites.created_by` is `ON DELETE
  RESTRICT` and an invite records who granted somebody coach status.

  The residual, stated rather than hidden: an access token already issued stays
  valid until it expires, so for up to an hour a deleted account's raw token
  would still satisfy RLS on a direct PostgREST call. The refresh token is
  revoked, and `resolveProfile` refuses the account in both backends, so every
  path through the application is closed immediately.

  The email change needed `0017` before it needed any UI. `profiles.email` is a
  copy of `auth.users.email` written ONCE by an `AFTER INSERT` trigger, and
  pinned against every client write by `guard_profile_privilege_columns` — so a
  successful GoTrue change would have left the copy holding the old address
  permanently, with no code path able to correct it. A trigger rather than an
  application write because the moment the change lands is not a moment the app
  is present for: with "Secure email change" on it needs BOTH addresses to
  confirm, hours apart, in whatever browser.

  That two-address confirmation is the security property worth having — a
  single-step change is exactly how somebody holding a borrowed session moves an
  account to their own inbox.

  Deletion is not optional under GDPR, and the foreign-key graph makes the naive
  version either impossible or destructive: `listings.coach_id` cascades while
  `orders.listing_id` is `ON DELETE RESTRICT`, so **a coach who has ever sold
  anything cannot be deleted at all**, and a learner who deletes silently reduces
  some coach's sales count and rating. `invites.created_by` is `ON DELETE
  RESTRICT` too, so an admin who has minted a code is undeletable — accepted, and
  administrators are removed by another administrator.

  The plan is to anonymise rather than erase, and to BAN the GoTrue user rather
  than delete it: deleting it cascades `profiles` and undoes the whole point.
* ~~**Email confirmation is off.**~~ **On, and supported.** The reason it was off
  — nothing implemented a callback — ended when `/auth/callback` shipped with
  password reset. `signUp` now points GoTrue at that route and returns a
  `confirm_email` result instead of throwing, so the form says "check your
  inbox" rather than showing a red failure over a signup that worked.

  It cost one thing: GoTrue validates the address domain too, so
  `verify:supabase`'s write tiers can no longer create fixtures against this
  project — no fake domain has an MX record. They skip with that reason. Running
  them again needs a second, test-only project, which is where the stuck-fixtures
  problem was already heading.
* **Still no transactional email of our own.** The reset flow rides on
  Supabase's built-in SMTP, which works and is heavily rate-limited — a handful
  of messages an hour, project-wide. That is enough for a pilot and not enough
  for launch, and it covers only the mails GoTrue itself sends. Nothing sends a
  receipt, "you have a new order", or "your review is ready".

  Note where the work actually is: wiring Resend is **configuration, not code**
  for the reset mail — custom SMTP in the Supabase dashboard, and the flow is
  unchanged. It is a code change only for the app's own mails, which is where
  the templates and a provider integration have to live.

---

## 5. Coach ↔ client chat

Entirely absent. Needs `conversations`, `messages` and `message_attachments`
with their own RLS, a Realtime subscription, unread counts, and attachment
handling.

**Build storage (1.1) first.** Chat attachments are the same problem, and doing
them twice is how the two diverge.

---

## 6. Scale and correctness

* ~~**No pagination anywhere.**~~ **Done.** Eighteen reads take a `PageRequest` and return a
  `Page<T>`; `MAX_PAGE_SIZE` caps every one of them, so no caller can ask for a
  table scan any more.

  Keyset rather than offset, because `OFFSET` is unstable under writes — a row
  inserted between two requests makes page 2 repeat one row and skip another,
  which on a moderation queue is a review nobody ever sees. The cost is that
  pages are only reachable in order, so the pager offers Next and Start again
  rather than page numbers.

  The interesting half was not the reads. Pagination turns "read the list and
  `.find()` in it" from wasteful into WRONG, silently: five pages were doing
  exactly that, and each now has a single-row read instead — see the table in
  `docs/DATA-LAYER.md`. The coach profile's link-or-not decision moved into the
  view (0026) for the same reason.

  Filters landed with it: price floor, price ceiling, and three sorts on the
  browse page. Each sort has its own keyset scope, so a cursor does not survive
  a change of ordering.

  **And then it was checked against a database with rows in it**, which is where
  the last bug was. `supabase/demo-seed.sql` fills the live project past every
  boundary the app has — 40 published offers against a page size of 24, 26 of
  them on one coach, 28 reviews on one offer — and the first coach profile with
  more than a page of offers rendered "2 offers" above a list of twenty-six.
  PostgREST's `count=exact` counts the query AS FILTERED, and the keyset is a
  filter; the mock counts before it seeks. Nothing could see the divergence while
  every table was empty, because `[]` and `0` are what both backends answer then.
  `runPaged` now asks for the count separately when there is a cursor, and both
  suites pin their half of it.
* ~~**The full-text index is dead weight.**~~ **Dropped** (0015). The choice was
  stated here as "implement `textSearch` or drop it", and dropping is the only
  option that keeps the two backends honest: full-text is not a faster substring
  search but a DIFFERENT one — it stems and drops stop words — and the mock has
  no tsvector, no stemmer and no dictionary, so the same query would return
  different offers on each backend. `supabaseClient.ts` already refused that
  trade once, about the `*` wildcard: *"Narrowed rather than widened so the
  backend swap cannot change search results."* The two trigram indexes that
  actually serve `ilike` stay.
* ~~**No rate limiting**~~ **Done** — signup, login, password reset and invite
  redemption all consume a budget before they do any work. `src/lib/rate-limit.ts`
  dispatches between a Postgres counter (`consume_rate_limit()`, 0013/0014) and
  a mock twin, the way `password-reset.ts` does; the budgets are one exported
  object so they read as a policy rather than as six scattered constants.

  Two properties worth knowing. **The bucket is an HMAC of the key**, because
  `anon` has to be able to consume a limit and a guessable bucket would let
  anybody burn a victim's password-reset budget and lock them out of their own
  recovery. And **it fails open**: a limiter that can take login down is a worse
  liability than the abuse it prevents, so it is a speed bump and nothing about
  authorization may ever depend on it. The per-IP half is a speed bump on a
  speed bump — proxy headers are attacker-controlled unless something in front
  overwrites them.

  ~~What it does NOT cover: any other Server Action~~ — **the signed-in surface
  is covered now too.** The six limits above all guard a form reachable without a
  session, which was the right place to start and left one gap nobody had written
  down: an account is the only thing in front of every write in the rest of the
  product, `signupIp` prices an account at five an hour, and one account then had
  an unmetered budget of fifty-megabyte uploads.

  Three more limits, all keyed per USER for the reason `reportUser` already gave:

  | | |
  |---|---|
  | `uploadUser` | 60/hour. Every path that moves bytes into a bucket — the avatar, an offer's instant-delivery file, and either party's file on an order. The delivery buckets take 50 MB per object, so an unbounded loop is unbounded storage. |
  | `claimUser` | 30/hour. Claiming is free, and `claim_offer()` only refuses a second claim of the SAME offer — nothing stopped one account claiming the whole catalogue and moving every public sales count. Gets tighter when payment lands, not looser. |
  | `writeUser` | 60/hour. Publishing, editing, withdrawing and restoring an offer; the coach profile; the display name. The cost is not CPU — an edit appends a `listing_revisions` row that no client role may delete, so an edit loop grows a table nothing can prune. |

  **Deliberately NOT applied where the schema already bounds the write**, which
  would be a limiter doing nothing: `reviews.order_id` is unique,
  `coach_applications_one_pending_per_user_idx` is a partial unique index, and a
  deliverable is only removable if it exists. The database is the bound in all
  three and it does not fail open.

  **Admin actions are deliberately still unlimited.** The population is the
  smallest and most trusted in the product, and a limiter that can refuse an
  administrator mid-incident is a worse trade than the row growth it prevents.

  Still not covered: the app's own transactional mail once that exists.

  **The invite-code half of this was overstated and is corrected here.** An
  earlier revision said brute-forcing a code is "currently free". Free, yes, and
  now throttled — but `generateInviteCode()` draws 12 characters from a
  30-character alphabet, which is 30¹² ≈ 2⁵⁹. That is not a guessing target, and
  leaving the claim in place dilutes the limits that were real.
* ~~**No caching.**~~ **Done.** Twelve public reads — browse, the coach
  directory, a coach's offers and reviews, an offer's reviews, and every
  aggregate — are cached with `unstable_cache`, tagged, and expired by every
  write that can make them stale. Measured under `next start`: `/offers` 712ms
  cold, 25ms warm; `/coaches` 165ms then 13ms.

  The prerequisite was a **cookie-free Supabase client**. A cached read must not
  touch `cookies()` anywhere in its call stack, and every read went through a
  client built from the request's cookies. `publicClient.ts` is one shared
  session-less client that reaches Postgres as `anon` — RLS still enforced, still
  no service-role client under `src/` — and only the public surface may use it,
  because a read that returns more to a signed-in user would come back EMPTY
  rather than refused.

  **Cache Components was built, measured and backed out.** `cacheComponents:
  true` with `<Suspense>` on all 23 pages works, and it commits the response
  status before the page runs — so `/settings` answered `200` with no `Location`
  and `NEXT_REDIRECT` in the body, `/admin/reports` answered `200` to a signed-out
  visitor, and an unknown offer answered `200` instead of `404`. Nearly every
  route here answers an authorization question with a status code, and the admin
  routes rely on 404-versus-200 to hide their own existence. Moving the gates
  into middleware would mean a second authorization implementation for a role
  this app deliberately keeps out of the session cookie; two root layouts would
  make every navigation between them a full page load. `docs/DATA-LAYER.md`
  carries the table and the reasoning.

  **The same trap has a second door, and it is now labelled.** A `loading.tsx`
  commits the response status the moment its fallback renders, for exactly the
  reason Cache Components did — Next's docs say it in as many words: *"Because
  the response headers have already been sent to the client, the status code of
  the response cannot be updated."* So a loading state is only correct on a route
  that answers 200 to every visitor unconditionally, and **two routes in this app
  qualify**: `/offers` and `/coaches`.

  Both now have one, and both sit inside a route group — `(browse)` and
  `(directory)` — because a `loading.tsx` covers its whole SUBTREE rather than
  its own page. Written without the groups first, and `verify:pages` failed three
  assertions immediately: *"a withdrawn offer is a 404 for the public — expected
  404, got 200"*, twice, plus the signed-in stranger. The groups add nothing to
  the URL and leave `[id]` and `new` where the boundary cannot reach them.

  ~~**No loading states.**~~ Those two, and deliberately no others. The
  placeholder geometry is measured against the real cards rather than estimated —
  296px against 302px, 120px against 126px — because the first draft was written
  by eye at 162px against 302px, which replaces a blank wait with a page that
  jumps eleven hundred pixels when it lands.
---

## 7. Trust, safety, operations

* ~~**No moderation UI.**~~ **Done for reviews** (0016, `/admin/reviews`) — the
  third instance of the same pattern this document keeps finding: policies
  written when the schema landed, and no code path in the two years of app built
  on top of them.

  Removal ARCHIVES then DELETES, rather than soft-deleting the way a listing
  does, and the inconsistency is deliberate. Nothing points at a review — it is a
  leaf — while a soft delete would have to be filtered out of `public_reviews`,
  `public_listing_reviews`, `public_coach_reviews`, `offer_stats` AND
  `coach_stats`, where forgetting one leaves a removed review still counting
  towards a rating, invisibly. Moving the row to `removed_reviews` makes all five
  correct with no filter at all.

  **Both of the old policies were dropped rather than wired up**, and that is the
  more interesting half. `reviews_update_admin` would let an administrator
  rewrite an opinion published under a named person's identity — the argument
  0002 already makes about a coach's listing copy, and stronger here.
  `reviews_delete_admin` would let one delete a review with no archive row, an
  unaudited route beside the audited one. `remove_review()` is now the only way a
  review can cease to exist.

  ~~Still missing: reviews cannot be REPORTED.~~ **Done** (0020,
  `/admin/reports`). A coach reports a review of their own offer; anybody signed
  in reports a coach. Both land in one queue, because they are the same job —
  somebody says something here is wrong, and one person decides — and two queues
  would mean two places to check and one of them going stale.

  The rule that runs through it: **deciding something was wrong is never the same
  act as doing something about it.** Upholding a review report does not delete
  the review, and upholding a coach report does not suspend the coach; each card
  links to the page where that second decision is made, with its own
  confirmation. A single button doing both would make the second one invisible.

  Neither subject column is a foreign key, and that is the load-bearing choice:
  removing a review DELETES it, so a cascade would take the report away at the
  exact moment somebody acted on it. The queue resolves a missing review from
  `removed_reviews` and says so instead.
* ~~**No way to suspend or demote a coach**~~ — **done** (0021/0022,
  `/admin/coaches`). Suspend, demote, reinstate, one call.

  `set_coach_status()` **refuses while any of their offers is on sale**, because
  it cannot withdraw them itself: it is SECURITY DEFINER owned by
  `javelin_privileged`, and `guard_listing_update()` calls `auth.uid()`, which
  that role can never reach — the dead end `0004` recorded, paying off a third
  time. So the app takes the offers down first, AS THE ADMINISTRATOR, which makes
  `deleted_by` the administrator and means the coach cannot put them straight
  back. A takedown a coach can undo in one click is not a takedown. And because
  the function refuses rather than fixing it up, "suspended but still selling" is
  a state that cannot be reached however a caller sequences its requests.

  Reinstating deliberately does not republish: nothing records which withdrawals
  belonged to which suspension, so restoring is one decision per offer.
* ~~**No audit log**~~ — **done** (0019, plus retrofits in 0020, 0022, 0023).
  `admin_actions` is append-only — no UPDATE or DELETE policy for any role — with
  five kinds: `grant_admin`, `review_application`, `remove_review`,
  `resolve_report`, `set_coach_status`. One writer, `record_admin_action()`, so
  "what gets logged" is one place to read rather than five. Rendered at the
  bottom of `/admin/reports`.

  **It shipped with a hole, and finding it is the reason this suite exists.**
  `0019` closed the writer with `revoke all ... from public` — correct on a stock
  Postgres, and inert on Supabase, whose bootstrap runs `alter default privileges
  in schema public grant all on functions to anon, authenticated, service_role`.
  Revoking from the PUBLIC pseudo-role does not touch an explicit grant to a
  named role, so for five migrations any anonymous caller could POST to
  `/rest/v1/rpc/record_admin_action` and append a forged line. `0024` is the
  revoke that actually closes it, `0025` deletes the two rows the probe wrote,
  and `scripts/probe-grants.mjs` sweeps every client-reachable function for the
  same trap. Nothing else was exposed: every other privileged function guards
  itself and refuses anon with its own sentence.
* **Observability: the seam exists, the provider does not.**
  `src/instrumentation.ts` binds Next's `onRequestError`, which fires for every
  server error — renders, route handlers, Server Actions, the proxy — and
  `src/lib/observability.ts` emits one line of structured JSON per incident.
  Vercel captures stderr, and a JSON line is searchable where a multi-line stack
  dump is not.

  Deliberately NOT logged: request headers (they carry the session cookie, which
  on Supabase is a live access token), user ids, email addresses, and query
  strings. Deliberately not REPORTED: `DataError`, `NEXT_REDIRECT` and
  `NEXT_NOT_FOUND` — a refusal is not an incident, and reporting them buries the
  real failures.

  What is left is the destination. Adding Sentry is a change to `report()` and
  nowhere else, because every call site already passes structured context rather
  than a formatted string. It needs an account and a DSN, which is a decision
  rather than a task.
* **No legal pages.** Terms, privacy policy, refund policy. Stripe will ask for
  these during onboarding, so they are on the critical path to payments rather
  than beside it.

---

## 8. Known-and-accepted, listed so they are not rediscovered as bugs

From `docs/DATA-LAYER.md`, "What is deliberately not here" — these are
decisions, not omissions:

* **No hard delete of a listing, by anyone.** Withdrawal is a soft delete and
  the only kind; there is no `DELETE` policy on `listings` for any role.
* **`listing_revisions` is append-only.** No client role holds `INSERT`; the
  trigger writes it as `javelin_privileged`, so a coach cannot rewrite the
  history of their own offer.
* **Review authors get no edit or delete path**, and since 0016 neither do
  administrators — an `UPDATE` grant would let an author rewrite `order_id` /
  `listing_id` / `price_epoch`, and would let an administrator rewrite somebody
  else's opinion under their name. Removal is admin-only, archives before it
  deletes, and is the only route: see §7.
* **`getOrder` answers `null` where the mock throws `forbidden`.** RLS renders
  "absent" and "not yours" identically and telling them apart needs a read that
  bypasses the policies. See the divergence table in `supabase/README.md`.

---

## Suggested order

1. ~~**Coach profile editor.**~~ Done.
2. ~~**Coach dashboard + edit / withdraw / restore.**~~ Done.
3. **Deploy to Vercel.** Cheap, and it surfaces environment problems while the
   surface is still small. Supabase's Site URL is also still
   `http://127.0.0.1:3000`, which has to be the real domain before any email
   flow is built on top of it.
4. ~~**Storage and delivery.**~~ Done — both modes, both buckets.
5. ~~**Password reset, and rate limiting in front of it.**~~ Both done — see §4
   and §6. Transactional email of our own is still open.
6. ~~**Bootstrap the live project.**~~ Done. An administrator exists, minted an
   invite code, and that code has been redeemed — so the approval path works
   end to end for the first time.

   With it, `npm run verify:supabase` runs every tier: **83 passed, 0 failed, 0
   skipped**, against the real database. That is the first time any of the RLS
   policies, guard triggers, storage rules or SECURITY DEFINER functions have
   been executed by a test rather than reasoned about.
7. **Checkout, then payouts.**
8. **Chat.**

Everything from 4 onwards needs new schema, a new integration, or money moving.
That is why 1 and 2 came first despite being the least exciting — they were the
only items needing none of the three.
