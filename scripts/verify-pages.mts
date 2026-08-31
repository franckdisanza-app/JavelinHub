/**
 * Rendered-page regression suite.
 *
 *   npm run verify:pages
 *
 * -----------------------------------------------------------------------------
 * Why this exists ALONGSIDE verify:authz
 * -----------------------------------------------------------------------------
 * `verify-authz.mts` never renders anything, so it is structurally incapable of
 * seeing a rendering decision — and most of what Phase E promised the user IS a
 * rendering decision. Every empty state, every cross-link, the "never render a
 * zero as a rating" branch and the demo-data disclosure live in a page.
 *
 * That gap was measured, not assumed. Five real regressions shipped green
 * through `tsc`, `lint` AND `verify:authz` at 758/0:
 *
 *   1. `/offers` linking EVERY coach unconditionally — an href to a 404.
 *   2. A coach profile linking a WITHDRAWN offer's title — an href to a 404,
 *      and the honest "(no longer on sale)" text gone.
 *   3. The demo-data note narrowed so an offer page renders three fabricated
 *      ratings with no disclosure at all.
 *   4. "Sold but unreviewed" collapsed into "New coach" at account level.
 *   5. The same collapse on an offer card.
 *
 * -----------------------------------------------------------------------------
 * IT PLANTS ITS OWN FIXTURES, AND THAT IS THE POINT
 * -----------------------------------------------------------------------------
 * The first version of this file asserted against the pristine seed and caught
 * only the fifth of those. The other four guards exist for states the seed does
 * not contain — and TWO OF THEM CANNOT BE PRODUCED THROUGH ANY UI PATH:
 *
 *   * a coach who is no longer approved but still has a published offer;
 *   * an offer that is withdrawn but still carries a review;
 *   * a coach who has SOLD and has never been reviewed.
 *
 * A guard whose state never occurs in the fixture is a guard nothing is
 * checking, however green the run looks. So this suite builds those states
 * itself, against a THROWAWAY store in the OS temp directory, exactly as
 * `verify-authz.mts` does — it never touches `data/db.json` — starts a server
 * pointed at that store, asserts, and tears both down.
 *
 * EVERY NEGATIVE ASSERTION BELOW HAS A POSITIVE CONTROL BESIDE IT. "No link to
 * the de-approved coach" is satisfied by a page that renders no coach links at
 * all, i.e. by the feature being entirely broken; the control is that the
 * APPROVED coach's link is present on that same page. Four of the five
 * regressions above reached the tree because an absence was asserted without
 * one.
 *
 * -----------------------------------------------------------------------------
 * How the assertions read the page
 * -----------------------------------------------------------------------------
 * Extraction is scoped to the MARKUP the brand pattern actually emits — a
 * `text-mono-42` numeral followed by a `text-mono-10` label — rather than to a
 * text search, so an assertion is about the element that renders and not about
 * a substring that happens to appear somewhere on the page. Three traps are
 * closed by construction, each of which produced a false green during
 * development:
 *
 *   * `strippedHtml()` removes `<script>` bodies. Next inlines the RSC payload,
 *     which repeats every string on the page — counting "Verified purchase" on
 *     the raw HTML reported 6 for a page showing 3.
 *   * `cardsByOffer()` / `cardsByCoach()` key each card by what it links to.
 *     "Some card shows 4.0 over 1 review" is not an assertion about the
 *     re-priced offer: a different offer legitimately shows exactly that, so
 *     the check passed whether or not the epoch filter worked.
 *   * `reviewItems()` scopes the review list. The offers grid on the same page
 *     links the same offers, so "a review's title is a link" is satisfied by a
 *     card elsewhere on the page.
 *
 * There is deliberately no `BASE` override pointing this at a server somebody
 * else started: that server reads a store nobody planted, so every fixture
 * assertion below would be measuring the wrong thing. The suite owns its store
 * and its server or it does not run.
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Actor } from '@/lib/data/types';

const scratch = mkdtempSync(join(tmpdir(), 'javelin-pages-'));
const storePath = join(scratch, 'db.json');

// Must be set before the store module is evaluated, and inherited by the server
// child below. Throwaway values, so the suite runs without a `.env.local`.
//
// A variable already present in `process.env` is NOT overridden by `.env.local`
// — `@next/env`'s `processEnv()` only assigns a parsed key when the ORIGINAL
// environment had no value for it. That is what lets the child server read this
// throwaway store while the developer's own `.env.local` names another one.
process.env.DATA_BACKEND = 'mock';
process.env.MOCK_DB_PATH = storePath;
process.env.SEED_ADMIN_EMAIL = 'admin@javelin.test';
process.env.SEED_ADMIN_PASSWORD = 'verify-pages-throwaway-password';
process.env.SESSION_SECRET = 'verify-pages-throwaway-session-secret';

const { getDataClient } = await import('@/lib/data');
const { mutateDb } = await import('@/lib/data/mock/store');
// Mock-only token mechanics. Imported so the reset LINK can be planted before
// the server boots — the store is cached in the server process, so a token
// minted after boot would be invisible to it.
const { issueResetToken } = await import('@/lib/auth/reset-tokens');

// ---------------------------------------------------------------------------
// Seeded ids, mirrored from store.ts. Hand-written rather than imported: an
// expectation read out of the code under test cannot fail.
// ---------------------------------------------------------------------------
const OFFER = {
  fundamentals: '00000000-0000-4000-8000-000000000101', // 3 sales, 3 reviews, 4.7
  clinic: '00000000-0000-4000-8000-000000000102', // 2 sales, 1 review, 4.0
  strength: '00000000-0000-4000-8000-000000000103', // epoch 2: 1 sale / 1 review current
  video: '00000000-0000-4000-8000-000000000104', // 1 sale, 1 review — WITHDRAWN below
  shoulder: '00000000-0000-4000-8000-000000000105', // 1 sale, NO reviews
  mentalPrep: '00000000-0000-4000-8000-000000000106', // nothing at all
};
const COACH = '00000000-0000-4000-8000-000000000002'; // Cory Vaughn
const EMPTY_COACH = '00000000-0000-4000-8000-000000000004'; // Nils Berg
const LEARNER = '00000000-0000-4000-8000-000000000003'; // Lena Park, never applied
/** `MORE_OFFERS_SHOWN` in `offers/[id]/page.tsx` — the cap on the cross-link grid. */
const MORE_OFFERS_SHOWN = 4;

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------
let passed = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${label} — expected ${e}, got ${a}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds the three states the seed deliberately does not contain.
 *
 * Planted BEFORE the server starts, on purpose: the store is cached in the
 * server process's `globalThis`, so a write made after boot would not be seen
 * (E1 lost an afternoon to exactly that). Plant, then boot, then read.
 */
async function plantFixtures(): Promise<{
  deapprovedCoachId: string;
  deapprovedOfferId: string;
  soldUnreviewedCoachId: string;
  soldUnreviewedOfferId: string;
  adminTakenDownOfferId: string;
  instantCoachId: string;
  instantOfferId: string;
  instantUnreadyOfferId: string;
  instantBuyerId: string;
  resetUserId: string;
  resetToken: string;
  adminId: string;
}> {
  const db = getDataClient();

  const adminProfile = await db.signInWithPassword({
    email: process.env.SEED_ADMIN_EMAIL!,
    password: process.env.SEED_ADMIN_PASSWORD!,
  });
  if (!adminProfile) throw new Error('fixture: could not sign in as the seeded admin');
  const ADMIN: Actor = { userId: adminProfile.id };

  const coryProfile = await db.signInWithPassword({
    email: 'coach@javelin.test',
    password: 'coach1234',
  });
  if (!coryProfile) throw new Error('fixture: could not sign in as the seeded coach');
  const CORY: Actor = { userId: coryProfile.id };

  // --- F1 -------------------------------------------------------------------
  // A coach who is NO LONGER APPROVED but still has a published offer.
  //
  // Reachable, and this is the sequence: redeeming an invite code approves the
  // actor WITHOUT closing a pending application, so an admin can afterwards
  // reject that application and set `coach_status = 'rejected'` under someone
  // who is already `role: 'coach'` and already selling. `listListings` and
  // `getListing` carry no coach-status predicate, so the offer stays public
  // while `getPublicCoach` returns null — which is why an unconditional
  // `/coaches/<listing.coach_id>` link would emit an href to a 404.
  const dana = await db.signUp({
    email: 'dana@verify-pages.test',
    password: 'learner1234',
    fullName: 'Dana Okoro',
  });
  const DANA: Actor = { userId: dana.id };
  const danaApplication = await db.createCoachApplication(DANA, {
    bio: 'I coach javelin throwers at club level and would like to publish plans here.',
    experience: 'Eight seasons coaching throws at a regional athletics club.',
  });
  await db.redeemInviteCode(DANA, 'JAVELIN-COACH-2026');
  const danaOffer = await db.createListing(DANA, {
    title: 'Winter Block for Club Throwers',
    description:
      'A twelve-week winter block for club throwers, written around indoor availability and a spring opener.',
    price_cents: 3900,
    category: 'training_plan',
  });
  await db.reviewCoachApplication(ADMIN, danaApplication.id, 'rejected');

  // --- F4 -------------------------------------------------------------------
  // A coach who has SOLD and has never been reviewed — the account-level twin
  // of offer `…0105`, and a state no seeded coach is in.
  const rune = await db.signUp({
    email: 'rune@verify-pages.test',
    password: 'learner1234',
    fullName: 'Rune Haugen',
  });
  const RUNE: Actor = { userId: rune.id };
  await db.redeemInviteCode(RUNE, 'THROWERS-WELCOME');
  const runeOffer = await db.createListing(RUNE, {
    title: 'Standing Throw Rebuild',
    description:
      'Four sessions on the standing throw alone: block, chest position and a delivery you can repeat.',
    price_cents: 2500,
    category: 'training_plan',
  });

  // There is no `createOrder` on `DataClient` — orders are fabricated data with
  // no write path anywhere in the product (see `Order` in types.ts), so this is
  // planted the same way `store.ts` plants the seeded ones. `coach_id` is
  // denormalised off the listing exactly as `seedOrdersAndReviews` does it.
  // ZERO YEARS, which the seed has no example of: Cory is 12 and Nils is null,
  // so without this the "0 is not the same as null" rule on /coach/profile
  // could only be asserted in one direction. Rune is the first-season coach.
  await db.updateMyCoachProfile(RUNE, {
    coach_headline: 'Standing throw specialist',
    coach_bio: null,
    coach_years_coaching: 0,
  });

  await mutateDb((store) => {
    store.orders.push({
      id: '00000000-0000-4000-8000-00000000f001',
      learner_id: dana.id,
      listing_id: runeOffer.id,
      coach_id: rune.id,
      price_cents_at_purchase: runeOffer.price_cents,
      price_epoch: runeOffer.price_epoch,
      created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
  });

  // --- F2 -------------------------------------------------------------------
  // A WITHDRAWN offer that still carries a review. `…0104` has one sale and one
  // review, so after the withdrawal the coach profile must still list that
  // review (account-level aggregates ignore `deleted_at`) while its title stops
  // being a link, because the offer is now a 404 for the public.
  await db.softDeleteListing(CORY, OFFER.video);

  // An ADMIN TAKEDOWN, which the seed has no example of and which
  // /coach/offers renders differently from a coach's own withdrawal: no Restore
  // control, because guard_listing_update() would refuse it.
  //
  // Created fresh and withdrawn immediately, rather than taking down one of the
  // seeded offers, so that it is invisible to every public read from the moment
  // it exists — the browse grid, the coach page and their card counts are all
  // unchanged by it. It also carries no orders or reviews, so neither rollup
  // moves.
  const takenDown = await db.createListing(CORY, {
    title: 'Taken Down By An Administrator',
    description:
      'A fixture offer that an administrator removed, so the dashboard has a takedown to render.',
    price_cents: 1500,
    category: 'other',
  });

  // Edited ONCE before the takedown, which is the only way to get a real
  // `listing_revisions` row: the seed creates none at all — it writes
  // `price_epoch: 2` on the re-priced offer directly — so without this the edit
  // history could only ever be asserted empty. Going 1500 -> 2000 is an
  // INCREASE, so the trigger both archives the superseded row and advances the
  // epoch, and the assertions can tell those two apart.
  await db.updateListing(CORY, takenDown.id, {
    title: 'Taken Down By An Administrator',
    description:
      'A fixture offer that an administrator removed, so the dashboard has a takedown to render.',
    price_cents: 2000,
    category: 'other',
  });

  await db.softDeleteListing(ADMIN, takenDown.id);

  // --- F6 -------------------------------------------------------------------
  // INSTANT DELIVERY, both of its states, on a coach of their own.
  //
  // A coach of their own rather than Cory, because these two offers are
  // PUBLISHED — unlike the takedown above, which is invisible from the moment it
  // exists — so hanging them off Cory would move every count on his profile and
  // in the cross-link grid. On Iris they move exactly two numbers, the browse
  // grid's card count and the coach directory's, and both are asserted.
  //
  // A fresh invite is MINTED rather than reusing a seeded code: the two seeded
  // codes are single-use and Dana and Rune have already spent them.
  //
  // A buyer of their own too, for the same reason. `/purchases` is newest-first
  // and the order-page assertions scrape the FIRST link on it, so giving this
  // claim to Lena or Dana would silently retarget an existing section at a
  // different order.
  const invite = await db.createInvite(ADMIN, { note: 'verify-pages instant delivery fixture' });
  const iris = await db.signUp({
    email: 'iris@verify-pages.test',
    password: 'learner1234',
    fullName: 'Iris Vale',
  });
  const IRIS: Actor = { userId: iris.id };
  await db.redeemInviteCode(IRIS, invite.code);

  const instantOffer = await db.createListing(IRIS, {
    title: 'Instant Plan For Winter Throws',
    description:
      'A ready-made twelve-week winter plan, downloadable the moment you claim it. The same file for everybody.',
    price_cents: 1900,
    category: 'training_plan',
    fulfilment: 'instant',
  });
  // The PATH only. The mock has no storage at all, so there are no bytes behind
  // it — which is exactly what the order page's "not available right now" branch
  // is for, and asserting that branch is asserting that the page does not fall
  // apart when a signed URL cannot be minted.
  await db.setListingAsset(IRIS, instantOffer.id, `${instantOffer.id}/abcd1234-winter-plan.pdf`);

  // The other state, and the one the coach dashboard exists to flag: an instant
  // offer that is published, visible and IMPOSSIBLE TO CLAIM because nothing is
  // attached. Legal by construction — the path is pinned under the listing's own
  // id, so a row must exist before a file can be stored under it.
  const instantUnready = await db.createListing(IRIS, {
    title: 'Instant Offer Awaiting Its File',
    description:
      'Published as an instant download with nothing attached yet, which is a state the dashboard has to flag.',
    price_cents: 2100,
    category: 'training_plan',
    fulfilment: 'instant',
  });

  const otto = await db.signUp({
    email: 'otto@verify-pages.test',
    password: 'learner1234',
    fullName: 'Otto Brandt',
  });
  const OTTO: Actor = { userId: otto.id };
  await db.createOrder(OTTO, instantOffer.id);

  // --- F7 -------------------------------------------------------------------
  // A live password-reset link. Minted here rather than requested through the
  // form, because the form is a Server Action and this suite speaks only GET —
  // and because the link is what the assertions are about, not the sending.
  //
  // Its own account, since redeeming it creates a session and burning it is the
  // point of one of the assertions. Doing that to a seeded actor would leave
  // whatever came before it in a state the next reader cannot predict.
  const reset = await db.signUp({
    email: 'locked-out@verify-pages.test',
    password: 'learner1234',
    fullName: 'Lockie Out',
  });
  const resetToken = await issueResetToken('locked-out@verify-pages.test');
  if (!resetToken) throw new Error('fixture: could not mint a password-reset token');

  return {
    deapprovedCoachId: dana.id,
    deapprovedOfferId: danaOffer.id,
    soldUnreviewedCoachId: rune.id,
    soldUnreviewedOfferId: runeOffer.id,
    adminTakenDownOfferId: takenDown.id,
    instantCoachId: iris.id,
    instantOfferId: instantOffer.id,
    instantUnreadyOfferId: instantUnready.id,
    instantBuyerId: otto.id,
    resetUserId: reset.id,
    resetToken,
    adminId: adminProfile.id,
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/** An OS-assigned free port, so this never collides with a dev server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not obtain a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** Server output, surfaced only when the server fails to come up. */
const serverLog: string[] = [];

/**
 * `next dev`, not `next start`, and the difference matters for a verification
 * script: `next start` serves whatever `.next` happens to hold, so a page edited
 * since the last build would be certified green from a stale artifact. Dev
 * compiles the current source. The cost is a slower first request per route,
 * which the readiness poll and the per-route warm-up below absorb.
 *
 * Spawned as `node <next-bin>` rather than through the `npm`/`.cmd` shim so the
 * child is a real Node process this script can kill by pid — a shell shim leaves
 * an orphaned server behind, which this project has been bitten by.
 */
function startServer(port: number): ChildProcess {
  const bin = join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // A process group on POSIX so the whole tree can be signalled. Never on
    // Windows, where `detached` opens a console window instead.
    detached: process.platform !== 'win32',
  });
  child.stdout?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
  return child;
}

function stopServer(child: ChildProcess | null): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // `next dev` forks workers; killing only the parent leaves them listening.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function waitForServer(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the server exited early (code ${child.exitCode}):\n${serverLog.join('')}`);
    }
    try {
      const res = await fetch(`${base}/offers`);
      if (res.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `the server did not become ready within 180s.\n` +
      `If another \`next dev\` is running in this directory, stop it and retry.\n` +
      serverLog.join(''),
  );
}

// ---------------------------------------------------------------------------
// Page readers
// ---------------------------------------------------------------------------

/**
 * Markup with `<script>` / `<style>` bodies removed.
 *
 * Load-bearing, not hygiene: Next inlines the RSC payload into the document, so
 * every string on the page appears twice. Counting "Verified purchase" on the
 * raw HTML reported 6 on a page rendering 3.
 */
function strippedHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

function toText(html: string): string {
  return strippedHtml(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `[value, label]` for every `Stat` — the 42px Ink numeral over its Steel label. */
function statPairs(html: string): Array<[string, string]> {
  const re =
    /<p class="font-mono text-mono-42[^"]*">([^<]*)<\/p><p class="[^"]*text-mono-10[^"]*">([^<]*)<\/p>/g;
  return [...strippedHtml(html).matchAll(re)].map((m): [string, string] => [m[1].trim(), m[2].trim()]);
}

/** Every `StatEmpty` label — the "there is deliberately no number here" slot. */
function emptyStats(html: string): string[] {
  const re = /<p class="font-mono text-mono-11 tracking-\[0\.14em\][^"]*">([^<]*)<\/p>/g;
  return [...strippedHtml(html).matchAll(re)].map((m) => m[1].trim());
}

/**
 * Every PER-REVIEW rating numeral — the 16px `n out of 5` in `ReviewItem`.
 *
 * `statPairs()` reads only the 42px aggregate slot, so until this existed the
 * per-review numeral was read by nothing: replacing `{review.rating}` with a
 * literal `{5}` made every review on every page say "5 out of 5" and the suite
 * still reported 115/0. A review IS a rating, and this is the only place a
 * single one appears on screen — including the `0 out of 5` that a hand-edited
 * store can produce (the accepted E1-F3 store-boundary residual).
 *
 * Read the numeral out of the `<p>` and stop at the `<span> out of 5`, rather
 * than taking the whole text node, so the label can be reworded without
 * silently emptying this extractor.
 */
function reviewRatings(html: string): string[] {
  const re = /<p class="font-mono text-mono-16[^"]*">([^<]*)<span/g;
  return [...strippedHtml(html).matchAll(re)].map((m) => m[1].trim());
}

type CardStats = { pairs: Array<[string, string]>; empty: string[] };

/**
 * The page's `<li>` elements, one chunk each.
 *
 * Split on `/<li[ >]/` and NOT on the string `'<li '`. A review item renders as
 * a bare `<li>` with no attributes, so splitting on the string with a trailing
 * space silently merged every review into the last CARD's chunk — which made
 * `reviewItems()` report one giant item whose "offer link" was really the
 * neighbouring card's. The negative assertion caught it; its positive control
 * had been passing for that wrong reason.
 */
function liChunks(html: string): string[] {
  return strippedHtml(html).split(/<li[ >]/).slice(1);
}

/**
 * Everything before the first `<li>` — a detail page's own stats block, as
 * distinct from the cards and reviews that follow it.
 */
function beforeFirstItem(html: string): string {
  return strippedHtml(html).split(/<li[ >]/)[0];
}

/**
 * A card, as opposed to a review: `ListingCard` and `CoachCard` both make the
 * whole card one click target with a stretched link, and nothing else in the
 * product carries that class. Keying on it rather than on "has an offer href"
 * is what keeps a review whose title IS a link from being counted as a card.
 */
function isCard(chunk: string): boolean {
  return chunk.includes('after:absolute');
}

/** Per-card stats, keyed by the offer each card links to. See the header note. */
function cardsByOffer(html: string): Map<string, CardStats> {
  const out = new Map<string, CardStats>();
  for (const chunk of liChunks(html)) {
    if (!isCard(chunk)) continue;
    // The query string is optional, and leaving it out was a silent blind spot:
    // `/offers` builds each card's href with `detailHref(id, q, category)`, so
    // on any FILTERED grid the href is `/offers/<id>?category=…`. A pattern that
    // demanded a closing quote straight after the id matched nothing there, and
    // `cardsByOffer()` returned an EMPTY MAP rather than failing — so any
    // assertion about a filtered grid's cards would have passed vacuously.
    // Nothing depended on it while every card assertion read an unfiltered page;
    // the first one that did not would have been certified by nothing.
    const href = /href="\/offers\/([0-9a-f-]+)(?:\?[^"]*)?"/.exec(chunk);
    if (!href) continue;
    out.set(href[1], { pairs: statPairs(chunk), empty: emptyStats(chunk) });
  }
  return out;
}

/** The same, for the coach directory, keyed by the coach each card links to. */
function cardsByCoach(html: string): Map<string, CardStats> {
  const out = new Map<string, CardStats>();
  for (const chunk of liChunks(html)) {
    if (!isCard(chunk)) continue;
    const href = /href="\/coaches\/([0-9a-f-]+)"/.exec(chunk);
    if (!href) continue;
    out.set(href[1], { pairs: statPairs(chunk), empty: emptyStats(chunk) });
  }
  return out;
}

/**
 * The review list, scoped away from the rest of the page.
 *
 * A coach profile renders the SAME offers twice — once as cards, once as the
 * titles under its reviews — so "a review's offer title is a link" is satisfied
 * by the card grid and proves nothing about the review list. A review item is
 * an `<li>` carrying a "Verified purchase" chip and no stretched link.
 */
function reviewItems(html: string): Array<{ offerHref: string | null; text: string }> {
  return liChunks(html)
    .filter((chunk) => chunk.includes('Verified purchase') && !isCard(chunk))
    .map((chunk) => {
      const href = /href="\/offers\/([0-9a-f-]+)"/.exec(chunk);
      return { offerHref: href ? href[1] : null, text: toText(chunk) };
    });
}

/** Every distinct `/coaches/<id>` href on a page. */
function coachLinks(html: string): string[] {
  return [
    ...new Set([...strippedHtml(html).matchAll(/href="\/coaches\/([^"]*)"/g)].map((m) => m[1])),
  ].sort();
}

/** Every distinct `/offers/<id>` href on a page. */
function offerLinks(html: string): string[] {
  return [
    ...new Set([...strippedHtml(html).matchAll(/href="\/offers\/([0-9a-f-]+)"/g)].map((m) => m[1])),
  ].sort();
}

type Page = {
  status: number;
  html: string;
  text: string;
  pairs: Array<[string, string]>;
  empty: string[];
  cards: Map<string, CardStats>;
  coachCards: Map<string, CardStats>;
  reviews: Array<{ offerHref: string | null; text: string }>;
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let server: ChildProcess | null = null;

try {
  const fixtures = await plantFixtures();
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  server = startServer(port);
  await waitForServer(BASE, server);

  const cache = new Map<string, Page>();
  async function get(path: string): Promise<Page> {
    const hit = cache.get(path);
    if (hit) return hit;
    const res = await fetch(`${BASE}${path}`);
    const html = await res.text();
    const page: Page = {
      status: res.status,
      html,
      text: toText(html),
      pairs: statPairs(html),
      empty: emptyStats(html),
      cards: cardsByOffer(html),
      coachCards: cardsByCoach(html),
      reviews: reviewItems(html),
    };
    cache.set(path, page);
    return page;
  }
  /** Status only — for "does this href actually resolve?" sweeps. */
  async function status(path: string): Promise<number> {
    const res = await fetch(`${BASE}${path}`);
    // Drain, or Node keeps the socket open and the process will not exit.
    await res.text();
    return res.status;
  }

  /**
   * A valid session cookie for a given user id.
   *
   * Mints it with the SAME scheme `src/lib/auth/session.ts` verifies —
   * `base64url(payload).base64url(HMAC-SHA256(payload))` — using the throwaway
   * `SESSION_SECRET` this suite sets at the top of the file. That is why this
   * is possible at all, and why it is not a hole: the secret is per-run and the
   * signature is what stops a *user* editing the id inside it. The suite is not
   * a user; it is the thing that issued the secret.
   *
   * Without this, every signed-in page in the app is unreachable from here, and
   * `/coach/profile` in particular renders four materially different states
   * depending on `coach_status` — none of which an anonymous fetch can see.
   */
  function sessionCookie(userId: string): string {
    const body = Buffer.from(
      JSON.stringify({ uid: userId, iat: Math.floor(Date.now() / 1000) }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', process.env.SESSION_SECRET as string)
      .update(body)
      .digest('base64url');
    return `javelin_session=${body}.${signature}`;
  }

  /** Fetches a page AS a given user. Not cached — the same path differs per viewer. */
  async function getAs(path: string, userId: string): Promise<Page> {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie: sessionCookie(userId) } });
    const html = await res.text();
    return {
      status: res.status,
      html,
      text: toText(html),
      pairs: statPairs(html),
      empty: emptyStats(html),
      cards: cardsByOffer(html),
      coachCards: cardsByCoach(html),
      reviews: reviewItems(html),
    };
  }

  /** Where an unauthenticated request to `path` is sent. `null` when it is not a redirect. */
  async function redirectTarget(path: string): Promise<string | null> {
    const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
    await res.text();
    return res.headers.get('location');
  }

  const offers = await get('/offers');
  const coaches = await get('/coaches');
  const f = await get(`/offers/${OFFER.fundamentals}`);
  const s = await get(`/offers/${OFFER.strength}`);
  const sh = await get(`/offers/${OFFER.shoulder}`);
  const m = await get(`/offers/${OFFER.mentalPrep}`);
  const coachPage = await get(`/coaches/${COACH}`);
  const emptyCoachPage = await get(`/coaches/${EMPTY_COACH}`);
  const deapprovedOfferPage = await get(`/offers/${fixtures.deapprovedOfferId}`);
  const soldUnreviewedCoachPage = await get(`/coaches/${fixtures.soldUnreviewedCoachId}`);

  const allPages: Array<[string, Page]> = [
    ['/offers', offers],
    ['/coaches', coaches],
    [`/offers/${OFFER.fundamentals}`, f],
    [`/offers/${OFFER.strength}`, s],
    [`/offers/${OFFER.shoulder}`, sh],
    [`/offers/${OFFER.mentalPrep}`, m],
    [`/coaches/${COACH}`, coachPage],
    [`/coaches/${EMPTY_COACH}`, emptyCoachPage],
    ['/offers/<de-approved coach’s offer>', deapprovedOfferPage],
    ['/coaches/<sold-but-unreviewed coach>', soldUnreviewedCoachPage],
  ];

  // A page's OWN stat block: the markup before its first list item, i.e. before
  // any card or review. Scoping matters — a coach who has sold and is unreviewed
  // renders "No reviews yet" twice, once at account level and once on his
  // offer's card, and a page-wide read cannot tell which one it is looking at.
  const ownStats = (page: Page) => statPairs(beforeFirstItem(page.html));
  const ownEmpty = (page: Page) => emptyStats(beforeFirstItem(page.html));
  const verifiedChips = (page: Page) =>
    (strippedHtml(page.html).match(/Verified purchase/g) ?? []).length;
  const PAGE_NOTE = /(?:ratings|reviews) and (?:numbers|sales counts) on this page are demo data/i;

  // =========================================================================
  section('Every page renders at all');
  // =========================================================================
  for (const [path, page] of allPages) check(`${path} responds 200`, page.status, 200);
  // The fixture's own precondition: a withdrawn offer is a 404 for the public.
  // Without this, the F2 block below could be passing because the whole route
  // broke rather than because the link was correctly withheld.
  check(
    'a withdrawn offer is a 404 for the public',
    await status(`/offers/${OFFER.video}`),
    404,
  );

  // =========================================================================
  section('Absolute constraints, on every page');
  // =========================================================================
  for (const [path, page] of allPages) {
    const ratings = page.pairs.filter(([, label]) => /review/i.test(label)).map(([v]) => v);
    check(`${path}: no rating numeral is 0.0`, ratings.filter((v) => Number(v) === 0), []);
    // The line above reads only the 42px AGGREGATE slot. The per-review numeral
    // is a different element, and until this pair existed nothing read it:
    // replacing `{review.rating}` with a literal `{5}` made every review on
    // every page say "5 out of 5" at 115/0. A review is a rating, so criterion
    // 1 applies to it — `0 out of 5` is reachable through the accepted
    // E1-F3 store-boundary residual, and would be exactly the "0 reads as bad,
    // not new" failure in its most personal form: attributed to a named person.
    const perReview = reviewRatings(page.html);
    check(
      `${path}: every per-review rating is an integer 1-5`,
      perReview.filter((v) => !/^[1-5]$/.test(v)),
      [],
    );
    // Range alone is NOT enough, and finding that out cost a mutant: replacing
    // `{review.rating}` with a literal `{5}` makes every review say "5 out of 5",
    // which is inside 1-5, so a range check passes it. The numerals have to be
    // tied to something they cannot trivially satisfy — so tie them to the
    // aggregate rendered on the SAME page. Their mean, rounded the way `Rating`
    // rounds, must equal the 42px numeral beside them. Under `{5}` the mean is
    // 5.0 against a displayed 4.4 or 4.7, and it fails.
    //
    // Only pages whose review list is complete can do this: a coach profile
    // shows every review behind its average, and an offer page shows every
    // current-epoch review behind its own. `/offers` shows aggregates with no
    // review list at all, so it is skipped rather than asserted vacuously.
    if (perReview.length > 0 && ratings.length > 0) {
      const mean = perReview.reduce((sum, v) => sum + Number(v), 0) / perReview.length;
      check(
        `${path}: the per-review numerals agree with the aggregate above them`,
        Math.round(mean * 10) / 10,
        Number(ratings[0]),
      );
    }
    check(`${path}: no star glyphs`, /[★☆⭐⚝]|&#9733|&#9734/.test(page.text), false);
    check(
      `${path}: no JSON-LD Review / AggregateRating`,
      /ld\+json|AggregateRating|"@type"\s*:\s*"Review"|itemprop=/i.test(page.html),
      false,
    );
  }

  // The control for the per-review sweep above. `filter(...) === []` is true of
  // an empty list, so if `reviewRatings()` ever stops matching — a class rename,
  // a markup change, a reworded label — every one of those assertions would go
  // green while reading nothing at all. That is the failure this whole round was
  // about, so the extractor has to prove it still sees something.
  check(
    'control: the review-rating extractor is not blind — the coach profile has 8',
    reviewRatings(coachPage.html).length,
    8,
  );
  check(
    'control: ...and the well-reviewed offer page has 3',
    reviewRatings((await get(`/offers/${OFFER.fundamentals}`)).html).length,
    3,
  );

  // =========================================================================
  section('/offers — stats on cards');
  // =========================================================================
  // Five published seeded offers (…0104 is withdrawn above), the two planted
  // coaches' offers, and Iris's two instant ones — which are published on
  // purpose, because "visible but unclaimable" is a state that only exists on a
  // published offer. Asserting the exact count is what stops a card that
  // silently stopped rendering from hiding behind its siblings.
  //
  // The takedown fixture is NOT in this number and never should be: it is
  // withdrawn from the moment it exists.
  check('the grid renders one card per published offer', offers.cards.size, 9);
  check('the withdrawn offer has no card', offers.cards.has(OFFER.video), false);
  check(
    'the well-reviewed offer shows 4.7 over "3 reviews", and 3 sales',
    offers.cards.get(OFFER.fundamentals)?.pairs,
    [['4.7', '3 reviews'], ['3', 'Sales']],
  );
  // The epoch asymmetry, on the card. Asserted on THIS card because …0102 also
  // reads 4.0 over 1 review and would satisfy a page-wide search either way.
  check(
    'the re-priced offer shows its CURRENT-epoch numbers, not its all-time ones',
    offers.cards.get(OFFER.strength)?.pairs,
    [['4.0', '1 review'], ['1', 'Sale']],
  );
  check(
    'the brand-new offer reads "New offer" and shows NO numeral at all',
    [offers.cards.get(OFFER.mentalPrep)?.empty, offers.cards.get(OFFER.mentalPrep)?.pairs],
    [['New offer'], []],
  );
  // THE FIFTH EMPTY STATE, on a card: "No reviews yet" AND the sale it made. It
  // is only distinguishable from a brand-new offer if both halves are there.
  check(
    'the sold-but-unreviewed offer reads "No reviews yet" and still shows its sale',
    [offers.cards.get(OFFER.shoulder)?.empty, offers.cards.get(OFFER.shoulder)?.pairs],
    [['No reviews yet'], [['1', 'Sale']]],
  );
  check('no stat prints a bare 0', offers.pairs.filter(([v]) => v === '0'), []);
  check(
    'the demo-data note is present',
    offers.text.includes('The ratings and sales counts on this page are demo data.'),
    true,
  );

  // =========================================================================
  section('F1 — a coach link is only rendered when the coach has a public page');
  // =========================================================================
  // Positive control FIRST: the fixture is genuinely on the page. Without it,
  // every assertion below is satisfied by the de-approved coach's offer simply
  // not being listed.
  check(
    'F1 control: the de-approved coach’s offer IS listed on /offers',
    offers.cards.has(fixtures.deapprovedOfferId),
    true,
  );
  check(
    'F1 control: ...and his name is on the page',
    offers.text.includes('Dana Okoro'),
    true,
  );
  // Positive control for the FEATURE: an approved coach's name IS a link on the
  // same page, so "no link to Dana" cannot pass by coach links being gone.
  check(
    'F1 control: an approved coach’s name IS a link on that same page',
    offers.html.includes(`href="/coaches/${COACH}"`),
    true,
  );
  check(
    'F1: the de-approved coach’s name is NOT a link',
    offers.html.includes(`href="/coaches/${fixtures.deapprovedCoachId}"`),
    false,
  );
  // The end-to-end form of the same guard, which does not care HOW the link is
  // withheld: every coach href on the grid must resolve.
  const gridCoachHrefs = coachLinks(offers.html);
  check('F1: the grid emits at least one coach link', gridCoachHrefs.length > 0, true);
  const brokenCoachLinks: string[] = [];
  for (const id of gridCoachHrefs) {
    if ((await status(`/coaches/${id}`)) !== 200) brokenCoachLinks.push(id);
  }
  check('F1: every coach link on /offers resolves 200, none 404s', brokenCoachLinks, []);
  check(
    'F1: the de-approved coach is absent from the directory',
    coaches.html.includes(`href="/coaches/${fixtures.deapprovedCoachId}"`),
    false,
  );
  // His own offer page takes the same branch, and takes it twice: the byline
  // and the cross-link sentence both go through `getPublicCoach`.
  check(
    'F1: on his own offer page, the byline is plain text',
    deapprovedOfferPage.text.includes('by Dana Okoro'),
    true,
  );
  check('F1: ...and the page emits no coach link at all', coachLinks(deapprovedOfferPage.html), []);

  // =========================================================================
  section('F2 — a review’s offer title is a link only while the offer is on sale');
  // =========================================================================
  const withdrawnReview = coachPage.reviews.find((r) =>
    r.text.includes('Frame-by-frame notes came back in two days'),
  );
  const publishedReview = coachPage.reviews.find((r) =>
    r.text.includes('I had never held a javelin before this'),
  );
  // Positive control: the withdrawn offer's review is STILL on the profile.
  // Account-level reads ignore `deleted_at`, and if that ever changed the
  // negative assertion below would pass for the wrong reason.
  check(
    'F2 control: the withdrawn offer’s review is still listed on the coach profile',
    withdrawnReview !== undefined,
    true,
  );
  // Positive control for the FEATURE: a still-published offer's title IS a link
  // IN THE REVIEW LIST — not merely somewhere on the page, where the offer grid
  // links the same ids.
  check(
    'F2 control: a still-published offer’s title IS a link in that same list',
    publishedReview?.offerHref,
    OFFER.fundamentals,
  );
  check('F2: the withdrawn offer’s title is NOT a link', withdrawnReview?.offerHref, null);
  check(
    'F2: ...and it says why, rather than dropping the review',
    withdrawnReview?.text.includes('(no longer on sale)'),
    true,
  );
  // The end-to-end form: nothing the coach profile links to may 404.
  const brokenOfferLinks: string[] = [];
  for (const id of offerLinks(coachPage.html)) {
    if ((await status(`/offers/${id}`)) !== 200) brokenOfferLinks.push(id);
  }
  check('F2: every offer link on the coach profile resolves 200, none 404s', brokenOfferLinks, []);
  check(
    'F2: the withdrawn offer has no card in the profile’s offer grid',
    coachPage.cards.has(OFFER.video),
    false,
  );
  // The inverse half of the archive rule: withdrawing must not move the
  // account-level numbers. If it did, F2's fixture would be changing the very
  // thing the rest of this file measures.
  check(
    'F2: withdrawing an offer does not move the coach’s account totals',
    [
      coachPage.pairs.some(([v, l]) => v === '4.4' && l === '8 reviews'),
      coachPage.pairs.some(([v, l]) => v === '10' && l === 'Sales'),
    ],
    [true, true],
  );

  // =========================================================================
  section('F3 — the demo note covers every fabricated number on the page');
  // =========================================================================
  // Positive control: this page's ONLY fabricated numbers are on the
  // cross-linked cards. The offer itself has no sales and no reviews, so a note
  // conditioned on the offer alone would not fire.
  check('F3 control: the brand-new offer’s cross-link grid is populated', m.cards.size, MORE_OFFERS_SHOWN);
  check(
    'F3 control: ...and those cards really do carry fabricated numbers',
    [...m.cards.values()].some((card) => card.pairs.length > 0),
    true,
  );
  check(
    'F3 control: ...while the offer itself has none of its own',
    [ownEmpty(m), ownStats(m)],
    [['New offer — nothing sold yet'], []],
  );
  check('F3: the page-level demo note IS present', PAGE_NOTE.test(m.text), true);
  // The other direction, and the reason the note is conditional at all: a page
  // with nothing fabricated on it must NOT carry one, or a reader learns to
  // skip it where it matters. The de-approved coach's offer has no sales, no
  // reviews, and no sibling offers to cross-link.
  check(
    'F3 control: an offer page with no fabricated numbers anywhere',
    [ownStats(deapprovedOfferPage), deapprovedOfferPage.cards.size],
    [[], 0],
  );
  check('F3: ...carries NO note', PAGE_NOTE.test(deapprovedOfferPage.text), false);
  check(
    'F3: an empty coach profile carries no note either',
    PAGE_NOTE.test(emptyCoachPage.text),
    false,
  );

  // The presence twins of the two absences above. Both were missing, and both
  // absences passed for the wrong reason without them: deleting the coach
  // profile's note entirely left this suite at 115/0 while Cory's page carried
  // ELEVEN fabricated numerals and EIGHT invented testimonials attributed to
  // named people, undisclosed. The disclosure is the one requirement the user
  // confirmed personally, so it gets a pair like everything else.
  //
  // Do not delete either half. An absence assertion alone cannot tell "the note
  // is correctly withheld" from "the note no longer exists".
  check(
    'F3 control: the coach profile WITH fabricated content DOES carry the note',
    PAGE_NOTE.test(coachPage.text),
    true,
  );
  check(
    'F3 control: ...and it really has fabricated numbers to disclaim',
    coachPage.pairs.length > 0,
    true,
  );

  // The `/offers` grid's own pair. Its presence is asserted earlier; this is the
  // absence, which nothing covered — rendering the note unconditionally survived
  // at 115/0. `mental_training` matches exactly one offer and that offer has
  // never sold or been reviewed, so the grid carries no fabricated number at
  // all, and a disclaimer there would be a claim about numbers that are not on
  // the page. The numeral count beside it is the control: if the filter ever
  // starts matching a sold offer, this fails rather than passing vacuously.
  const brandNewGrid = await get('/offers?category=mental_training');
  check('F3: a grid whose every match is brand-new carries NO note', PAGE_NOTE.test(brandNewGrid.text), false);
  check(
    'F3 control: ...because that grid really has no fabricated numbers',
    // `cards.size` is load-bearing, not decoration. Without it the assertion
    // above is satisfied by a grid with NO MATCHES AT ALL — an empty grid and
    // the "no such category" page are both 200 with zero numerals and no note,
    // so the fixture could cease to exist and this would still pass. Swapping
    // the category to `nutrition_plan` (deliberately empty since E1) or to a
    // junk string both left the suite at 134/0 before this line existed.
    // Pinning the match count is what makes "brand-new grid" mean a grid that
    // has something in it.
    [brandNewGrid.status, brandNewGrid.pairs.length, brandNewGrid.cards.size],
    [200, 0, 1],
  );

  // =========================================================================
  section('F4 — "sold but unreviewed" is not "new", at account level either');
  // =========================================================================
  const rune = soldUnreviewedCoachPage;
  // Positive control: the coach really has a sale, or "not new" is trivially
  // wrong rather than tested.
  check(
    'F4 control: the fixture coach really has sold something',
    rune.pairs.some(([v, l]) => v === '1' && l === 'Sale'),
    true,
  );
  check('F4 control: ...and really has no reviews', verifiedChips(rune), 0);
  check(
    'F4: his ACCOUNT rating slot reads "No reviews yet", with no numeral',
    [ownEmpty(rune), ownStats(rune)],
    [['No reviews yet'], [['1', 'Sale']]],
  );
  check(
    'F4: ...and he is NOT called a new coach',
    ownEmpty(rune).some((l) => l.includes('New coach')),
    false,
  );
  check(
    'F4: ...nor told that nobody has bought anything',
    rune.text.includes('nobody has bought or reviewed anything yet'),
    false,
  );
  check(
    'F4: ...the reviews block says what it says instead',
    rune.text.includes("Nobody has written a review of Rune Haugen's offers yet."),
    true,
  );
  // And on his own offer's card, the same distinction one level down: an offer
  // that has sold once and been reviewed by nobody.
  check(
    'F4: ...while his offer card carries the offer-level version of the same state',
    [
      rune.cards.get(fixtures.soldUnreviewedOfferId)?.empty,
      rune.cards.get(fixtures.soldUnreviewedOfferId)?.pairs,
    ],
    [['No reviews yet'], [['1', 'Sale']]],
  );
  // The contrast, in the same run: the coach who really HAS sold nothing still
  // reads "New coach". Without this pair, "never say New coach" would pass.
  check(
    'F4 contrast: the coach with nothing at all still reads "New coach"',
    emptyCoachPage.empty.some((l) => l.includes('New coach')),
    true,
  );
  // And the same discrimination on the directory card, which is a different
  // component (`coach-card.tsx`) taking the same decision.
  check(
    'F4: on /coaches, the sold-but-unreviewed coach’s card reads "No reviews yet"',
    coaches.coachCards.get(fixtures.soldUnreviewedCoachId)?.empty,
    ['No reviews yet'],
  );
  check(
    'F4 contrast: ...while the coach with nothing reads "New coach" on that same page',
    coaches.coachCards.get(EMPTY_COACH)?.empty,
    ['New coach'],
  );
  check(
    'F4 contrast: ...and the established coach shows a numeral rather than either',
    coaches.coachCards.get(COACH)?.pairs,
    [['4.4', '8 reviews']],
  );

  // =========================================================================
  section('/offers/[id] — the well-reviewed offer');
  // =========================================================================
  check(
    'its own stats card reads 4.7 over "3 reviews", and 3 sales',
    ownStats(f),
    [['4.7', '3 reviews'], ['3', 'Sales']],
  );
  check('all three reviews are rendered', verifiedChips(f), 3);
  check(
    'a real review body is on the page',
    f.text.includes('I had never held a javelin before this'),
    true,
  );
  check('the review byline names its author', f.text.includes('Lena Park'), true);
  check('the demo-data note is present', PAGE_NOTE.test(f.text), true);
  // Every coach link, not "one exists": the byline and the cross-link sentence
  // are two separate links, so finding the right href somewhere cannot tell
  // that the other one is wrong.
  check('every coach link on the page points at THIS offer’s coach', coachLinks(f.html), [COACH]);
  check('"More offers from this coach" is present', f.text.includes('More offers from Cory Vaughn'), true);
  check('its cross-link grid is populated', f.cards.size, MORE_OFFERS_SHOWN);
  // Aimed at …0106 as well as here: the grid shows the four NEWEST siblings, so
  // an assertion on the OLDEST offer would pass with the self-exclusion filter
  // deleted entirely. See the …0106 block above.
  check('...and never contains the offer being read', f.cards.has(OFFER.fundamentals), false);
  check('...and never contains a withdrawn sibling', f.cards.has(OFFER.video), false);
  check('no order id reaches the page', /00000000-0000-4000-8000-0000000002[0-9][0-9]/.test(f.html), false);

  // =========================================================================
  section('/offers/[id] — the re-priced offer: the archive rule on screen');
  // =========================================================================
  check('its own stats card shows the CURRENT epoch only', ownStats(s), [['4.0', '1 review'], ['1', 'Sale']]);
  check('exactly one review is listed', verifiedChips(s), 1);
  check('...and it is the one written against the current version',
    s.text.includes('Bought the current version'), true);
  check('the ARCHIVED review is not on the offer page',
    s.text.includes('Written around my competition calendar'), false);
  check('...while the coach profile still carries it',
    coachPage.text.includes('Written around my competition calendar'), true);
  check('the price epoch itself is never rendered', /epoch/i.test(s.text), false);

  // =========================================================================
  section('/offers/[id] — sold once, never reviewed');
  // =========================================================================
  check(
    'its own stats card reads "No reviews yet" with no numeral, beside its one sale',
    [ownEmpty(sh), ownStats(sh)],
    [['No reviews yet'], [['1', 'Sale']]],
  );
  check('it says what it says, rather than borrowing the new-offer wording',
    sh.text.includes('This offer has sold once, and the buyer has not written about it.'), true);
  check('it is NOT called a new offer', sh.empty.includes('New offer — nothing sold yet'), false);
  check('...and the sales fact is not claimed to be absent',
    sh.text.includes('Nobody has bought this offer yet'), false);
  check('its coach links are this offer’s coach too', coachLinks(sh.html), [COACH]);
  check('the demo note still fires — a sale is fabricated content', PAGE_NOTE.test(sh.text), true);

  // =========================================================================
  section('/offers/[id] — the brand-new offer');
  // =========================================================================
  check('...and the reason is stated',
    m.text.includes('Nobody has bought this offer yet, so there is nothing to review.'), true);
  check('...and never contains the offer being read', m.cards.has(OFFER.mentalPrep), false);
  check('it does not claim a sale', m.text.includes('This offer has sold once'), false);

  // =========================================================================
  section('/coaches/[id] — account level against offer level');
  // =========================================================================
  // The asymmetry, on one page: the account total must EXCEED the sum of the
  // offer-level ones, or the epoch archive is not happening.
  const offerLevelSales = coachPage.pairs
    .filter(([, l]) => l === 'Sale' || l === 'Sales')
    .map(([v]) => Number(v))
    .sort((a, b) => b - a);
  check(
    'the account sales total is larger than the offer-level ones put together',
    offerLevelSales[0] === 10 && offerLevelSales.slice(1).reduce((x, y) => x + y, 0) < 10,
    true,
  );
  check('an offer card carries its OWN rating, not the account one',
    coachPage.cards.get(OFFER.fundamentals)?.pairs, [['4.7', '3 reviews'], ['3', 'Sales']]);
  check('...and the re-priced offer card shows its current epoch',
    coachPage.cards.get(OFFER.strength)?.pairs, [['4.0', '1 review'], ['1', 'Sale']]);
  check('a card does NOT link back to this same coach page',
    (coachPage.html.match(new RegExp(`href="/coaches/${COACH}"`, 'g')) ?? []).length, 0);
  check('empty coach: says he has published nothing',
    emptyCoachPage.text.includes('Nils Berg hasn’t published any offers yet'), true);
  check('empty coach: no rating numeral anywhere', emptyCoachPage.pairs, []);

  // -------------------------------------------------------------------------
  section('/coach/profile — the coach’s own editor');

  /** The `value="..."` of a named input, or `null` when the input is absent. */
  function inputValue(html: string, name: string): string | null {
    const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html);
    if (!tag) return null;
    const value = /value="([^"]*)"/.exec(tag[0]);
    return value ? value[1] : '';
  }
  const hasEditor = (page: Page) => inputValue(page.html, 'headline') !== null;

  check(
    'anonymous is sent to log in and back again',
    await redirectTarget('/coach/profile'),
    '/login?next=%2Fcoach%2Fprofile',
  );

  /*
   * THE AVATAR CARD, on the MOCK backend.
   *
   * These suites run with DATA_BACKEND=mock, which has no file storage at all —
   * so this is the degraded path, and asserting it is the point. The page must
   * still render, still edit the three text columns, and say plainly why the
   * uploader is missing rather than showing a control that cannot work.
   * `avatarStorageAvailable()` is what decides, and it is false here.
   */
  const coachAvatarPage = await getAs('/coach/profile', COACH);
  check('the picture card renders', coachAvatarPage.text.includes('Your picture'), true);
  check('...with no uploader, because the mock has no storage',
    coachAvatarPage.html.includes('type="file"'), false);
  check('...and says so instead of failing silently',
    coachAvatarPage.text.includes('Picture uploads are not available here'), true);
  check('...while still describing initials as the normal state, not a fallback',
    coachAvatarPage.text.includes('No picture yet'), true);
  check('no avatar image is rendered anywhere without a stored path',
    /<img[^>]*avatars/.test(coachAvatarPage.html), false);
  check('the text editor is unaffected by any of that',
    inputValue(coachAvatarPage.html, 'headline'), 'Javelin technique and throws programming');

  const learnerProfilePage = await getAs('/coach/profile', LEARNER);
  check('a learner is told why there is nothing to edit',
    learnerProfilePage.text.includes('You are not an approved coach yet'), true);
  check('...and is NOT handed the editor', hasEditor(learnerProfilePage), false);
  check('...and gets BOTH routes to approval, not just the slow one',
    learnerProfilePage.html.includes('href="/coach/apply"') &&
      learnerProfilePage.html.includes('href="/redeem"'), true);

  // A rejected applicant is not a coach, but telling them to "apply" as though
  // they never had would be wrong — they have a decision to react to.
  const rejectedProfilePage = await getAs('/coach/profile', fixtures.deapprovedCoachId);
  check('a rejected applicant is told their application failed, not that they never applied',
    rejectedProfilePage.text.includes('was not approved'), true);
  check('...and still gets no editor', hasEditor(rejectedProfilePage), false);

  const coryProfilePage = await getAs('/coach/profile', COACH);
  check('an approved coach gets the editor', hasEditor(coryProfilePage), true);
  check('...prefilled with the stored headline',
    inputValue(coryProfilePage.html, 'headline'), 'Javelin technique and throws programming');
  check('...and the stored years', inputValue(coryProfilePage.html, 'years'), '12');
  check('...and the preview reads them back', coryProfilePage.text.includes('12 years coaching'), true);
  check('the editor never offers the privilege columns',
    /name="(role|coach_status|email|full_name|id)"/.test(coryProfilePage.html), false);

  /*
   * THE ONE THAT IS EASY TO GET WRONG, in both directions.
   *
   * `coach_years_coaching` is `number | null` and 0 is a legal value meaning "my
   * first season". Any falsy test — `years ? … : …`, `Number(raw) || null`,
   * `String(years ?? '')` around a `||` — collapses the two into one answer, and
   * the page then tells a first-season coach that they declined to say. The
   * three checks below pin both directions and the prefill between them.
   */
  const runeProfilePage = await getAs('/coach/profile', fixtures.soldUnreviewedCoachId);
  check('ZERO years reads as a first season, not as nothing',
    runeProfilePage.text.includes('First season coaching'), true);
  check('...and 0 survives the round trip into the input',
    inputValue(runeProfilePage.html, 'years'), '0');

  const nilsProfilePage = await getAs('/coach/profile', EMPTY_COACH);
  check('NULL years renders no years line at all',
    /first season coaching|\d+ years? coaching/i.test(nilsProfilePage.text), false);
  check('...and leaves the input empty rather than showing a 0',
    inputValue(nilsProfilePage.html, 'years'), '');
  check('a coach with no headline is told so rather than shown a blank',
    nilsProfilePage.text.includes('No headline yet'), true);


  // -------------------------------------------------------------------------
  section('/coach/offers — the coach dashboard');

  /** The chunk of the dashboard belonging to one offer, by its Edit link. */
  function offerRow(html: string, id: string): string | null {
    for (const chunk of liChunks(html)) {
      if (chunk.includes(`/coach/offers/${id}/edit`)) return chunk;
    }
    return null;
  }

  check(
    'anonymous is sent to log in and back again',
    await redirectTarget('/coach/offers'),
    '/login?next=%2Fcoach%2Foffers',
  );

  const learnerDash = await getAs('/coach/offers', LEARNER);
  check('a learner is told there is nothing to manage',
    learnerDash.text.includes('You are not an approved coach yet'), true);
  check('...and sees no offer rows', offerRow(learnerDash.html, OFFER.fundamentals), null);

  const coachDash = await getAs('/coach/offers', COACH);
  check('a coach sees a published offer', offerRow(coachDash.html, OFFER.fundamentals) !== null, true);

  /*
   * THE POINT OF THE PAGE: withdrawn offers are visible HERE and nowhere else.
   * Every public listing read filters `deleted_at`, so if this list filtered it
   * too there would be no route back for a coach who withdrew something.
   */
  check('...AND the one they withdrew themselves, which no public read shows',
    offerRow(coachDash.html, OFFER.video) !== null, true);
  check('...and the one an administrator took down',
    offerRow(coachDash.html, fixtures.adminTakenDownOfferId) !== null, true);

  const liveRow = offerRow(coachDash.html, OFFER.fundamentals) ?? '';
  const selfWithdrawnRow = offerRow(coachDash.html, OFFER.video) ?? '';
  const takenDownRow = offerRow(coachDash.html, fixtures.adminTakenDownOfferId) ?? '';

  check('a live offer offers Withdraw, not Restore',
    [liveRow.includes('Withdraw'), liveRow.includes('Put back on sale')], [true, false]);
  check('...and links to its public page', liveRow.includes(`href="/offers/${OFFER.fundamentals}"`), true);

  check('an offer the coach withdrew offers Restore',
    selfWithdrawnRow.includes('Put back on sale'), true);
  check('...and does NOT link to a public page it no longer has',
    selfWithdrawnRow.includes(`href="/offers/${OFFER.video}"`), false);

  /*
   * THE ASYMMETRY THAT `owned_listings.withdrawn_by_admin` EXISTS FOR.
   * `guard_listing_update()` refuses to let a coach clear a `deleted_at` an
   * administrator set, so offering the control would be offering a button that
   * is guaranteed to fail. The refusal still stands if the form is posted
   * directly — this only removes the invitation.
   */
  check('an ADMIN takedown offers no Restore control at all',
    takenDownRow.includes('Put back on sale'), false);
  check('...and says who can undo it',
    takenDownRow.includes('An administrator removed this offer'), true);
  check('...while a self-withdrawal says no such thing',
    selfWithdrawnRow.includes('An administrator removed this offer'), false);
  check('...and every withdrawn offer is still editable',
    [selfWithdrawnRow.includes(`/coach/offers/${OFFER.video}/edit`),
     takenDownRow.includes(`/coach/offers/${fixtures.adminTakenDownOfferId}/edit`)], [true, true]);

  // -------------------------------------------------------------------------
  section('/coach/offers/[id]/edit — the editor and its history');

  check('anonymous is sent to log in and back again',
    await redirectTarget(`/coach/offers/${OFFER.fundamentals}/edit`),
    `/login?next=%2Fcoach%2Foffers%2F${OFFER.fundamentals}%2Fedit`);

  // Not "forbidden": an id that is not ours is simply not in listMyListings, so
  // the page 404s and says nothing about whether the offer exists.
  check('a coach editing SOMEBODY ELSE’S offer gets a 404',
    (await getAs(`/coach/offers/${fixtures.soldUnreviewedOfferId}/edit`, COACH)).status, 404);
  check('a learner gets a 404 too, not a form',
    (await getAs(`/coach/offers/${OFFER.fundamentals}/edit`, LEARNER)).status, 404);

  const editPage = await getAs(`/coach/offers/${OFFER.fundamentals}/edit`, COACH);
  check('the owner gets the editor', editPage.status, 200);
  check('...prefilled with the current price in pounds',
    inputValue(editPage.html, 'price'), '45.00');
  check('...and carries the id the action needs', inputValue(editPage.html, 'id'), OFFER.fundamentals);

  /*
   * The re-priced seeded offer has a revision, and the CURRENT values are not
   * in `listing_revisions` — a revision is a snapshot of the SUPERSEDED row.
   * So the history must show the old price and the page must show the new one.
   */
  const editedOffer = await getAs(`/coach/offers/${fixtures.adminTakenDownOfferId}/edit`, COACH);
  check('a withdrawn offer is still editable by its owner', editedOffer.status, 200);
  check('the history shows the SUPERSEDED price, not the current one',
    editedOffer.text.includes('£15.00'), true);
  check('...and the form shows the current one', inputValue(editedOffer.html, 'price'), '20.00');

  // The seed writes no listing_revisions rows at all, so every seeded offer is
  // genuinely unedited — including the one carrying price_epoch 2.
  const neverEdited = await getAs(`/coach/offers/${OFFER.fundamentals}/edit`, COACH);
  check('an offer that was never edited says so rather than showing an empty list',
    neverEdited.text.includes('Never edited'), true);


  // -------------------------------------------------------------------------
  section('/purchases and /coach/sales — the claim path');

  check('anonymous purchases -> log in and back',
    await redirectTarget('/purchases'), '/login?next=%2Fpurchases');
  check('anonymous sales -> log in and back',
    await redirectTarget('/coach/sales'), '/login?next=%2Fcoach%2Fsales');

  // Lena bought the seeded fundamentals offer; the fixtures give her one order.
  const learnerPurchases = await getAs('/purchases', LEARNER);
  check('a buyer sees what they claimed',
    learnerPurchases.text.includes('Javelin Throw Fundamentals'), true);
  check('...and whether they have reviewed it',
    /Reviewed|Not reviewed/.test(learnerPurchases.text), true);
  check('...and can open it', /href="\/orders\/[0-9a-f-]+"/.test(learnerPurchases.html), true);

  // Rune has exactly one sale and no review on it — the "sold but unreviewed"
  // fixture the rest of the suite already leans on.
  const runeSales = await getAs('/coach/sales', fixtures.soldUnreviewedCoachId);
  check('a coach sees a claim on their offer',
    runeSales.text.includes('Standing Throw Rebuild'), true);
  check('...marked as not reviewed', runeSales.text.includes('Not reviewed'), true);

  /*
   * THE BUYER IS NOT NAMED. `OrderWithListing` carries `learner_id` and nothing
   * else about them, because `docs/DATA-LAYER.md` keeps `Profile` off every
   * surface but its owner's and an admin's. Rune's buyer is Dana; her name
   * appearing on this page would mean a coach can enumerate their customers.
   */
  check('a sale does NOT name the buyer', runeSales.text.includes('Dana Okoro'), false);
  check('...nor leak an email', /@verify-pages\.test|@javelin\.test/.test(runeSales.text), false);

  // -------------------------------------------------------------------------
  section('/orders/[id] — the shared order page');

  // Scraped rather than planted: the link on /purchases is the route a buyer
  // actually takes, so following it also proves the two pages agree.
  const orderHref = /href="(\/orders\/[0-9a-f-]+)"/.exec(learnerPurchases.html)?.[1] ?? '';
  check('the purchases page links to a real order', orderHref !== '', true);

  check('anonymous -> log in and back',
    (await redirectTarget(orderHref))?.startsWith('/login?next=%2Forders%2F'), true);

  const buyerOrder = await getAs(orderHref, LEARNER);
  check('the buyer can open their own order', buyerOrder.status, 200);
  // Newest first, so Lena's most recent claim is the re-priced strength offer.
  check('...and sees the offer it was for',
    buyerOrder.text.includes('Strength Programming for Throwers'), true);
  check('...and the files section', buyerOrder.text.includes('Nothing has been sent yet'), true);
  check('...with the mock backend saying why uploads are unavailable',
    buyerOrder.text.includes('File delivery is not available here'), true);
  check('...and no upload control it cannot honour',
    buyerOrder.html.includes('type="file"'), false);

  /*
   * THE BOUNDARY. `getOrder` admits the buyer, the selling coach and an admin,
   * and returns null to everyone else — so a stranger gets a 404 rather than a
   * refusal, which would confirm the order exists.
   */
  check('a STRANGER gets 404, not a refusal',
    (await getAs(orderHref, fixtures.soldUnreviewedCoachId)).status, 404);

  // Lena has already reviewed the fundamentals offer in the seed, so the form
  // is gone and the acknowledgement is there instead.
  check('a buyer who already reviewed is not offered the form again',
    buyerOrder.html.includes('name="rating"'), false);

  // Rune's sale is unreviewed; his buyer Dana still gets the form.
  const danaOrderHref =
    /href="(\/orders\/[0-9a-f-]+)"/.exec((await getAs('/purchases', fixtures.deapprovedCoachId)).html)?.[1] ?? '';
  const danaOrder = await getAs(danaOrderHref, fixtures.deapprovedCoachId);
  check('an unreviewed buyer IS offered the review form',
    danaOrder.html.includes('name="rating"'), true);
  check('...and the rating select offers no zero',
    danaOrder.html.includes('value="0"'), false);

  // The coach on that order sees the same page and no review form: reviewing
  // your own sale is not a thing.
  const coachOrder = await getAs(danaOrderHref, fixtures.soldUnreviewedCoachId);
  check('the selling coach can open the same order', coachOrder.status, 200);
  check('...and is NOT offered a review form', coachOrder.html.includes('name="rating"'), false);
  check('...and is prompted to send their work',
    coachOrder.text.includes('Send them what you promised'), true);

  const learnerSales = await getAs('/coach/sales', LEARNER);
  check('a learner has no sales page to speak of',
    learnerSales.text.includes('You are not an approved coach yet'), true);

  // -------------------------------------------------------------------------
  section('Instant delivery — the mode on screen, and the two states of a file');

  /*
   * THE PUBLIC OFFER PAGE tells a buyer how a thing arrives BEFORE they claim
   * it. Both halves are checked, on the two offers, because a page that printed
   * one label unconditionally would satisfy either assertion alone.
   */
  const instantPage = await get(`/offers/${fixtures.instantOfferId}`);
  check('an instant offer says so', instantPage.text.includes('Instant download'), true);
  check('...and explains what that means before the claim',
    instantPage.text.includes('the file is yours to download straight away'), true);
  check('...and does NOT claim to be made for each buyer',
    instantPage.text.includes('Made for each buyer'), false);

  const personalisedPage = await get(`/offers/${OFFER.fundamentals}`);
  check('a personalised offer says THAT', personalisedPage.text.includes('Made for each buyer'), true);
  check('...and does not offer an instant download',
    personalisedPage.text.includes('Instant download'), false);

  /*
   * AND NEITHER PAGE PUBLISHES THE PATH. `asset_path` is revoked from every
   * client role in SQL and projected off `ListingWithCoach` in TypeScript; this
   * is the assertion that would catch a page reaching past both.
   */
  check('the public page never prints the object path',
    instantPage.html.includes('abcd1234-winter-plan.pdf'), false);
  check('...not even to an anonymous reader of the raw HTML',
    /offer-assets|asset_path/.test(instantPage.html), false);

  // The unready offer is PUBLISHED and unclaimable, and the public page says
  // nothing about that — deliberately, because `asset_path` is not public. What
  // a buyer sees is an ordinary instant offer; the refusal lives in claim_offer.
  const unreadyPublic = await get(`/offers/${fixtures.instantUnreadyOfferId}`);
  check('an instant offer with no file still renders publicly', unreadyPublic.status, 200);
  check('...and gives away nothing about the missing file',
    unreadyPublic.text.includes('Needs a file'), false);

  /*
   * THE COACH DASHBOARD is where that state is visible, and only to its owner.
   */
  const irisDash = await getAs('/coach/offers', fixtures.instantCoachId);
  check('the owner is warned that the fileless offer cannot be claimed',
    irisDash.text.includes('Needs a file'), true);
  check('...with the consequence spelled out',
    irisDash.text.includes('Nobody can claim this until you attach a file'), true);
  // The control: the offer that DOES have a file is on the same page and must
  // not be flagged, or the warning is unconditional and means nothing.
  check('...and only ONE of the two offers is flagged',
    (irisDash.text.match(/Needs a file/g) ?? []).length, 1);

  /*
   * THE EDITOR carries the attach control, and only for an instant offer.
   */
  const instantEditor = await getAs(
    `/coach/offers/${fixtures.instantOfferId}/edit`, fixtures.instantCoachId);
  check('the editor offers the delivery-mode choice',
    instantEditor.html.includes('name="fulfilment"'), true);
  check('...and, for an instant offer, the file section',
    instantEditor.text.includes('The file buyers download'), true);
  check('...naming the attached file', instantEditor.text.includes('winter-plan.pdf'), true);

  const personalisedEditor = await getAs(
    `/coach/offers/${OFFER.fundamentals}/edit`, COACH);
  check('a personalised offer gets no file section',
    personalisedEditor.text.includes('The file buyers download'), false);

  /*
   * THE ORDER PAGE is the other side of it: a download, and NOT the file
   * exchange that a personalised order gets. Rendering both would be worse than
   * rendering the wrong one.
   */
  const ottoPurchases = await getAs('/purchases', fixtures.instantBuyerId);
  const instantOrderHref = /href="(\/orders\/[0-9a-f-]+)"/.exec(ottoPurchases.html)?.[1] ?? '';
  check('the instant buyer has an order to open', instantOrderHref !== '', true);

  const instantOrder = await getAs(instantOrderHref, fixtures.instantBuyerId);
  check('the buyer of an instant offer gets a download section', instantOrder.status, 200);
  check('...headed as their download', instantOrder.text.includes('Your download'), true);
  check('...and is NOT asked to send their coach a file',
    instantOrder.text.includes('Send something to your coach'), false);
  check('...nor told that nothing has been sent yet',
    instantOrder.text.includes('Nothing has been sent yet'), false);
  // Delivered the moment it was claimed, so there is no waiting state to be in.
  check('...and it is not "Awaiting delivery"',
    instantOrder.text.includes('Awaiting delivery'), false);
  /*
   * On the mock backend no URL can be signed, so the graceful branch is what
   * renders — and asserting it is asserting that a page whose link cannot be
   * minted still shows the order rather than falling over.
   */
  check('...with the unavailable-link branch instead of a broken link',
    instantOrder.text.includes('This download is not available right now'), true);
  check('...and still no object path in the HTML',
    instantOrder.html.includes('abcd1234-winter-plan.pdf'), false);

  // The control on the opposite side: a personalised order is unchanged by all
  // of this and still gets the exchange, which `buyerOrder` above already
  // asserted has "Nothing has been sent yet".
  check('a personalised order still has no download section',
    buyerOrder.text.includes('Your download'), false);

  // -------------------------------------------------------------------------
  section('/admin/reviews — moderation, and who is told it exists');

  /*
   * THE GATE IS A 404, NOT A 403, and that is the same rule every admin page
   * follows: telling a signed-in learner "you are not allowed here" confirms
   * there is a `here`. `requireAdmin()` calls `notFound()` for exactly that.
   */
  check('anonymous -> log in and back',
    await redirectTarget('/admin/reviews'), '/login?next=%2Fadmin%2Freviews');
  check('a learner gets 404, not a refusal',
    (await getAs('/admin/reviews', LEARNER)).status, 404);
  check('...and so does an approved coach', (await getAs('/admin/reviews', COACH)).status, 404);

  const moderation = await getAs('/admin/reviews', fixtures.adminId);
  check('an admin gets the page', moderation.status, 200);
  // The seed writes eight reviews across the fixture offers, so the queue is
  // not empty — which is what makes the assertions below mean anything.
  check('...listing the reviews on the site',
    moderation.text.includes('Javelin Throw Fundamentals'), true);
  // Precise on purpose: the string "Remove" also appears in the "Removed (0)"
  // heading below, so matching it alone would pass with no control rendered at
  // all. The button carries a screen-reader suffix naming the author.
  check('...with a removal control per review',
    moderation.text.includes('the review by'), true);
  check('...and an empty removal log to start',
    moderation.text.includes('Nothing has been removed'), true);

  /*
   * THE TITLE IS THE GATE TOO. `generateMetadata` runs independently of the
   * page body, so a static `metadata` export would put "Reviews" in the tab
   * title of the 404 — quietly confirming the page to the person the 404 just
   * declined to confirm it to.
   */
  check('the 404 a learner gets does NOT leak the page title in <title>',
    /<title>[^<]*Reviews/i.test((await getAs('/admin/reviews', LEARNER)).html), false);
  check('...while the admin’s page does carry it',
    /<title>[^<]*Reviews/i.test(moderation.html), true);

  /*
   * NO EDIT CONTROL, ANYWHERE. `0016` drops the `reviews_update_admin` policy
   * and the interface has no method for it, so this asserts the third layer:
   * the page offers nothing that would call one. A textarea named `reason`
   * belongs to the removal form; one named `body` would be an edit.
   */
  check('the page offers no way to EDIT a review',
    moderation.html.includes('name="body"'), false);
  /*
   * The CONTROL for that negative, and it needs one: a page rendering nothing
   * at all would also contain no `name="body"`. The removal form is the thing
   * that must be there, and its reason textarea is NOT in the served markup —
   * `RemoveReviewForm` reveals it only after the first click, which is the
   * two-step confirmation that exists because this delete is unrecoverable. So
   * the control is the queue heading and the per-review button above.
   */
  check('control: the queue heading is rendered', /Published\s*\(\s*\d+\s*\)/.test(moderation.text), true);
  check('control: and the log heading', /Removed\s*\(\s*\d+\s*\)/.test(moderation.text), true);

  // The admin nav names it, or nobody finds it.
  check('the admin nav links to it', moderation.html.includes('href="/admin/reviews"'), true);
  check('...and a learner’s nav does not',
    (await getAs('/offers', LEARNER)).html.includes('href="/admin/reviews"'), false);

  // -------------------------------------------------------------------------
  section('Password reset — the link, end to end over HTTP');

  /*
   * The one flow whose whole job is to work for somebody who cannot sign in, so
   * every assertion here is about an ANONYMOUS request. The form itself is a
   * Server Action and out of this suite's reach; what is reachable — and what
   * carries the security properties — is the link.
   */
  const forgot = await get('/forgot-password');
  check('the request page is public', forgot.status, 200);
  check('...and asks for an address', forgot.html.includes('name="email"'), true);
  check('...and says the link is single-use and short-lived',
    /works once|expire/i.test(forgot.text), true);

  const login = await get('/login');
  check('the login page offers a way out of a forgotten password',
    login.html.includes('href="/forgot-password"'), true);

  /*
   * THE DEAD END THIS FEATURE EXISTS TO REMOVE. `/reset-password` is a
   * signed-in page, but an anonymous visitor must NOT be bounced to
   * `/login?next=/reset-password` — sending somebody who cannot log in to the
   * login form is the loop the whole flow is built to break.
   */
  check('an anonymous visitor to /reset-password is NOT redirected to login',
    await redirectTarget('/reset-password'), null);
  const resetAnon = await get('/reset-password');
  check('...they get an explanation instead', resetAnon.status, 200);
  check('...naming what they need', resetAnon.text.includes('This page needs a valid reset link'), true);
  check('...and a way to get another', resetAnon.html.includes('href="/forgot-password"'), true);

  /*
   * REDEEMING THE LINK. A GET that mutates, deliberately — an email can only
   * offer a link — so the properties that make it safe are on the token, and
   * two of them are asserted here over real HTTP.
   */
  const badLink = await fetch(`${BASE}/auth/callback?token=not-a-real-token`, { redirect: 'manual' });
  await badLink.text();
  check('a token that was never issued is turned away',
    badLink.headers.get('location'), '/forgot-password?link=expired');
  check('...and no session is handed out with it',
    (badLink.headers.get('set-cookie') ?? '').includes('javelin_session='), false);

  const noToken = await fetch(`${BASE}/auth/callback`, { redirect: 'manual' });
  await noToken.text();
  check('a link with no token at all gets the same answer',
    noToken.headers.get('location'), '/forgot-password?link=expired');

  const goodLink = await fetch(
    `${BASE}/auth/callback?token=${encodeURIComponent(fixtures.resetToken)}`,
    { redirect: 'manual' },
  );
  await goodLink.text();
  check('a real link lands on the form', goodLink.headers.get('location'), '/reset-password');
  const issuedCookie = (goodLink.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  check('...and issues a session', issuedCookie.startsWith('javelin_session='), true);

  // The session it issued is a REAL one for the right account — asserted by
  // using it, not by decoding it, since the page is what a user would see.
  const resetPage = await fetch(`${BASE}/reset-password`, { headers: { cookie: issuedCookie } });
  const resetHtml = toText(await resetPage.text());
  check('the session it issued opens the form', resetPage.status, 200);
  check('...for the account the link was minted for',
    resetHtml.includes('locked-out@verify-pages.test'), true);

  /*
   * SINGLE USE, over HTTP. The same link a moment later is dead — and this is
   * the assertion that would fail if `redeemResetToken` ever validated a token
   * without spending it in the same write.
   */
  const replay = await fetch(
    `${BASE}/auth/callback?token=${encodeURIComponent(fixtures.resetToken)}`,
    { redirect: 'manual' },
  );
  await replay.text();
  check('the same link cannot be used twice',
    replay.headers.get('location'), '/forgot-password?link=expired');
  check('...and the second attempt issues no session',
    (replay.headers.get('set-cookie') ?? '').includes('javelin_session='), false);

  // And the failure page tells the user what to do about it, rather than
  // leaving them on a bare redirect.
  const expiredNotice = await get('/forgot-password?link=expired');
  check('the failure lands on an explanation',
    expiredNotice.text.includes('That link no longer works'), true);

} finally {
  stopServer(server);
  rmSync(scratch, { recursive: true, force: true });
}

for (const failure of failures) console.log(`  FAIL  ${failure}`);
console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
if (failures.length > 0) process.exitCode = 1;
