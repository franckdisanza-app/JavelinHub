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

## 2. Coaches cannot fill in their own profiles

`updateMyCoachProfile` exists in the data layer, is enforced by
`profiles_update_own` plus `guard_profile_privilege_columns`, was verified
against Postgres — **and has no page.**

So `coach_headline`, `coach_bio` and `coach_years_coaching` are `null` for every
coach who did not arrive through an approved application (approval copies the
application bio across once; an invite-code coach gets nothing). The public
directory renders name-only cards by construction.

Cheapest high-impact item on this list.

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
| `getListingForViewer` | the owner's view of a withdrawn offer | still none |
| `listMyOrders` | `/purchases` | **done** |
| `listOrdersForCoach` | `/coach/sales` | **done** |
| `getOrder` | `/orders/[id]` | **done** |
| `createReview` | the review form on `/orders/[id]` | **done** |

**Nine of the ten have a UI**, and `setListingAsset` — added with instant
delivery — shipped with its own controls on the editor and the composer. The
tenth, `getListingForViewer`, is still the only method in the whole interface
that nothing in `src/app` calls. Its `ListingDetail` union exists so that a
withdrawn offer renders as a TOMBSTONE for the owner, an admin and anyone
holding an order for it, instead of a 404 — and today `/offers/[id]` uses
`getListing`, which 404s for everybody. Nothing currently LINKS a buyer to a
withdrawn offer's page, so the gap is invisible rather than broken; it becomes
visible the moment anything does. The loop closes: a
coach publishes and manages offers in either delivery mode, a learner claims one
and either downloads it immediately or exchanges files against that order, and
the buyer reviews it. What is left in §1 is the money.

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

  **Two things it is NOT.** It does not sign out the user's other sessions:
  the mock cookie has no revocation list, and neither does the Supabase side
  without `signOut({ scope: 'others' })` — recorded as a known divergence
  rather than faked on one side. And it is **not rate limited**, which §6
  already flags for signup and login and which matters more here: this is the
  app's only public form that sends mail.

  **Deployment still needs three dashboard settings** that are not in this
  repo: `NEXT_PUBLIC_SITE_URL` on Vercel, the same origin added to Supabase's
  Redirect URLs, and Site URL moved off `http://127.0.0.1:3000`. Until then
  GoTrue refuses the redirect, which is the correct failure — the app builds
  the link from configuration and never from the request's `Host` header,
  precisely so that a crafted request cannot make us email a valid reset link
  pointing somewhere else.
* **No email change and no account deletion.** Deletion is not optional under
  GDPR, and `invites.created_by` is `ON DELETE RESTRICT`, so deleting an admin
  who has ever minted an invite fails until those rows are dealt with —
  documented in `supabase/README.md`, and a real obstacle to writing the
  feature.
* **Email confirmation is off.** Correct for now — nothing implements a
  confirmation callback — but it means addresses are unverified, which stops
  being acceptable once receipts are being emailed.
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

* **No pagination anywhere.** `docs/DATA-LAYER.md` flags it: `listListings`
  returns *everything*, newest first. `listReviewsForCoach` has the same
  property and will hit it sooner. Add cursors before launch, not after.
* **The full-text index is dead weight.** `0001_init.sql` creates
  `listings_search_tsv_idx`, but the client issues `ilike '%q%'`, which the
  trigram GIN indexes serve instead. Either implement `textSearch` against the
  tsvector or drop the index — right now it costs write throughput and buys
  nothing.
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

  What it does NOT cover: any other Server Action, and the app's own transactional
  mail once that exists.

  **The invite-code half of this was overstated and is corrected here.** An
  earlier revision said brute-forcing a code is "currently free". Free, yes, and
  now throttled — but `generateInviteCode()` draws 12 characters from a
  30-character alphabet, which is 30¹² ≈ 2⁵⁹. That is not a guessing target, and
  leaving the claim in place dilutes the limits that were real.
* **No caching.** Every route renders dynamically (`ƒ` in the build output).
  `/offers` and `/coaches` are public reads and should not be.

---

## 7. Trust, safety, operations

* **No moderation UI.** `0002_rls.sql` carries `reviews_update_admin` and
  `reviews_delete_admin` for exactly this, and no page calls either. Admin can
  approve coaches and mint invites; that is the whole admin surface.
* **No way to suspend or demote a coach** through the app. `coach_status` can go
  to `rejected` only through application review.
* **No audit log.** `grant_admin()` and application decisions leave nothing
  behind but the mutated row.
* **No observability.** No error reporting, no structured logging. A `DataError`
  that escapes to `error.tsx` in production will be reported by a user, if at
  all.
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
* **Review authors get no edit or delete path.** An `UPDATE` grant would let
  them rewrite `order_id` / `listing_id` / `price_epoch`; pinning those needs
  another guard trigger, and moderation is admin-only by design.
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
6. **Bootstrap the live project.** It has the schema and nothing else: no
   profiles, no administrator, and therefore no way to approve a coach. Cheap,
   and it blocks every hands-on check of everything above. See
   `supabase/README.md`, "Swap path" step 1.

   It also gates the second half of `npm run verify:supabase`. That suite's
   read-only tier runs today and covers the column revokes, the self-scoped
   views, the anon INSERT refusals and the enum parity — 43 assertions the mock
   suites structurally cannot make. Its write tiers need an unredeemed invite
   code, which needs an administrator, which needs this.
7. **Checkout, then payouts.**
8. **Chat.**

Everything from 4 onwards needs new schema, a new integration, or money moving.
That is why 1 and 2 came first despite being the least exciting — they were the
only items needing none of the three.
