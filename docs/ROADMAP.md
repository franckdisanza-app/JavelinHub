# What is missing — a gap analysis

Written after the mock → Supabase swap landed and the schema was applied to a
live project. Everything below is grounded in the repo as it stands, not in
general advice about marketplaces: where something is claimed absent, the file
that documents the absence is cited.

Ordered by what blocks a launch, not by effort.

---

## 1. The product cannot be delivered

**This is the gap that matters.** The eight offer categories in
`src/lib/data/types.ts` are:

| | |
|---|---|
| `training_plan` | `recovery_plan` |
| `mobility_plan` | `weightlifting_plan` |
| `nutrition_plan` | `video_review` |
| `mental_training` | `other` |

**Seven of the eight are a file or a document**, and there is no file anywhere
in the system. A coach sells a video review and then has no way to return the
video. The transaction has no product at the end of it.

In dependency order:

### 1.1 File storage and delivery
Nothing exists. `src/components/initials-avatar.tsx` states the position
plainly — *"NO UPLOADS AND NO STORAGE, deliberately"* — which was right for a
POC and is now the thing standing between the app and a working product.

Needs: buckets with their own RLS, an upload surface for coaches, signed URLs
for delivery, and a `deliverables` table joining an order to what was delivered
so the buyer's "my purchases" page has something to link to.

Storage split, decided earlier: Supabase Storage for avatars, PDFs and chat
images; **Cloudflare R2 for video**, because egress is what makes video
expensive and R2 charges none. Keep the metadata rows in Postgres either way so
the backing store stays swappable per asset type.

### 1.2 Checkout
`createOrder` does not exist on `DataClient`, no client role holds `INSERT` on
`orders`, and the Buy button is inert and says so
(`src/app/offers/[id]/page.tsx`). `docs/DATA-LAYER.md` records the reason: a
client-supplied `price_cents_at_purchase` is not something that should ever be
insertable. A real checkout gets its own `SECURITY DEFINER` RPC that derives the
price server-side, the same shape as `redeem_invite_code`.

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
| `listMyOrders` | "my purchases" | still none |
| `listOrdersForCoach` | "my sales" | still none |
| `getOrder` | order detail | still none |
| `createReview` | write a review | still none |

The coach's own loop is now closed: publish, edit, withdraw, restore, and a
public profile to be found by. **The five that remain are all purchase-side**,
and none can be finished without §1 — there is no way to buy anything, so there
are no orders to list and nothing to review. They are not separate work from
checkout; they are its UI.

---

## 4. Auth is half-built

* **No password reset.** No route, no callback handler. Users will lock
  themselves out in week one and the only recovery is the SQL editor.
* **No email change and no account deletion.** Deletion is not optional under
  GDPR, and `invites.created_by` is `ON DELETE RESTRICT`, so deleting an admin
  who has ever minted an invite fails until those rows are dealt with —
  documented in `supabase/README.md`, and a real obstacle to writing the
  feature.
* **Email confirmation is off.** Correct for now — nothing implements a
  confirmation callback — but it means addresses are unverified, which stops
  being acceptable once receipts are being emailed.
* **No transactional email at all.** No provider, no templates. Needed for:
  password reset, receipt, "you have a new order", "your review is ready".
  Supabase's built-in SMTP is not production-grade; Resend fits this stack.

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
* **No rate limiting** on signup, login, or invite redemption. An invite code
  is a bearer credential that promotes its holder to approved coach; brute
  forcing one is currently free.
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
4. **Storage and delivery.** This is the product.
5. **Checkout, then payouts.**
6. **Password reset and transactional email.**
7. **Chat.**

Everything from 4 onwards needs new schema, a new integration, or money moving.
That is why 1 and 2 came first despite being the least exciting — they were the
only items needing none of the three.
