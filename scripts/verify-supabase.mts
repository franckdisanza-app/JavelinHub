/**
 * =============================================================================
 * Postgres-side verification — the half the other two suites cannot reach.
 * =============================================================================
 *
 *   npm run verify:supabase              read-only
 *   VERIFY_SUPABASE_WRITES=1 npm run verify:supabase    the full flow
 *
 * `verify:authz` (930 assertions) and `verify:pages` (261) both hard-set
 * `DATA_BACKEND=mock`. That is deliberate and it is also the gap: **neither of
 * them executes a single line of `SupabaseDataClient`, and none of the RLS
 * policies, column grants, guard triggers or storage rules in
 * `supabase/migrations/` runs anywhere in them.** The mock is a code twin
 * written to mirror those rules; a twin is evidence about intent, not about
 * what Postgres actually does.
 *
 * This suite asks the database directly, over PostgREST and GoTrue, with the
 * same anon key a browser gets. It is the executable version of the smoke
 * table at the top of `supabase/README.md`.
 *
 * -----------------------------------------------------------------------------
 * IT RUNS AGAINST A REAL PROJECT, so it is read-only by default
 * -----------------------------------------------------------------------------
 * There is no throwaway Postgres to point it at the way `verify:authz` gets a
 * throwaway JSON file. Whatever `NEXT_PUBLIC_SUPABASE_URL` names is what gets
 * asked, and for this project that is the live one.
 *
 * So the default tier makes NO WRITES AT ALL — every assertion below the
 * "anonymous" heading is a GET. That tier is safe to run against production on
 * a schedule, and it covers the failure this project is most exposed to: a
 * migration, a reset script or a dashboard click silently restoring a
 * table-level grant and un-hiding a column. `0002_rls.sql` says so in as many
 * words: *"THIS REVOKE IS UNDONE BY ANY LATER BLANKET GRANT, SILENTLY."*
 *
 * The write tier is behind `VERIFY_SUPABASE_WRITES=1` because it creates real
 * accounts, listings and orders that **cannot be fully cleaned up** — there is
 * no hard delete of a listing for any role, and no delete path for an order at
 * all, both by design. It withdraws what it publishes and leaves the rest,
 * labelled. Point it at a project you are willing to leave fixtures in.
 *
 * **AND IT NO LONGER RUNS AGAINST THIS PROJECT.** Email confirmation was turned
 * on — correctly, since it now serves real users — and with it GoTrue validates
 * the address domain. Both halves defeat the write tier: `@javelinhub-verify.test`
 * and even `@example.com` are refused for having no MX record, and a signup that
 * did succeed would return no session for the suite to act with. The tier skips
 * with that reason rather than failing, and running it needs a second,
 * test-only project with confirmation off.
 *
 * -----------------------------------------------------------------------------
 * The write tier needs ONE thing it cannot create: an approved coach
 * -----------------------------------------------------------------------------
 * Publishing a listing requires `is_approved_coach()`, and the only two routes
 * to that are redeeming an invite code or having an application approved —
 * both of which need an administrator to already exist. Making the FIRST admin
 * requires a direct database connection (`grant_admin()` refuses anything
 * arriving as `authenticator`, which is every PostgREST request including a
 * service-role one), so no key in this repo can do it.
 *
 * Give the suite an unredeemed invite code and it provisions everything else
 * itself:
 *
 *   VERIFY_SUPABASE_WRITES=1 VERIFY_SUPABASE_INVITE=XXXX-XXXX-XXXX npm run verify:supabase
 *
 * Without one, the tiers that need a coach report SKIP with the reason, rather
 * than passing vacuously. A skipped assertion is not a passing assertion and
 * the summary counts them separately.
 *
 * Exits 0 when every assertion that RAN passed, 1 otherwise.
 */
// `@next/env` is CommonJS, so it has no named exports through the ESM loader —
// the default import is the whole module object.
import nextEnv from '@next/env';

import { FULFILMENT_MODES, LISTING_CATEGORIES } from '@/lib/data/types';

// `.env.local` is not loaded for a bare Node script the way it is for `next`.
// Same loader Next uses, so this reads exactly the file the app would — and it
// respects the same precedence, so a variable already in the environment wins.
nextEnv.loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });

const URL_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
const ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();
const WRITES = process.env.VERIFY_SUPABASE_WRITES === '1';
const INVITE = (process.env.VERIFY_SUPABASE_INVITE ?? '').trim();

if (URL_BASE === '' || ANON_KEY === '') {
  console.error(
    'verify:supabase needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.\n' +
      'Both live in .env.local and both are safe to expose — that is the premise of the RLS model.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Assertion harness — the shape `verify:authz` uses, plus SKIP.
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;

function section(name: string): void {
  console.log(`\n${name}`);
}

function note(text: string): void {
  console.log(`        ${text}`);
}

function ok(label: string, detail = ''): void {
  passed += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  console.log(`  FAIL  ${label} — ${detail}`);
}

/**
 * A skipped assertion is NOT a passing one, and the summary keeps them apart.
 * The alternative — quietly not running a check — is how a suite comes to
 * certify nothing while printing all green.
 */
function skip(label: string, why: string): void {
  skipped += 1;
  console.log(`  SKIP  ${label} — ${why}`);
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(label, a);
  else fail(label, `expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------
// PostgREST / GoTrue plumbing
// ---------------------------------------------------------------------------

interface Result {
  status: number;
  /** PostgreSQL SQLSTATE, when the response carried one. */
  code: string | null;
  message: string;
  body: unknown;
}

/**
 * One REST call as a given identity.
 *
 * `token` is an access token when signed in and the ANON KEY otherwise —
 * PostgREST wants the anon key in `Authorization` too, and passing it is what
 * makes `auth.uid()` NULL rather than making the request unauthenticated at the
 * HTTP layer. That distinction is the whole point of several assertions below:
 * an anonymous caller is admitted and then matches no rows, rather than being
 * refused at the door.
 */
async function rest(
  path: string,
  { token = ANON_KEY, method = 'GET', body, prefer }: {
    token?: string;
    method?: string;
    body?: unknown;
    prefer?: string;
  } = {},
): Promise<Result> {
  const headers: Record<string, string> = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  const asError = parsed as { code?: string; message?: string } | null;
  return {
    status: res.status,
    code: typeof asError?.code === 'string' ? asError.code : null,
    message: typeof asError?.message === 'string' ? asError.message : '',
    body: parsed,
  };
}

/** Rows from a successful select, or `[]`. Never throws on an error response. */
function rows(result: Result): unknown[] {
  return Array.isArray(result.body) ? result.body : [];
}

/** Asserts a request is refused with a particular SQLSTATE. */
function expectSqlState(label: string, result: Result, expected: string): void {
  if (result.code === expected) ok(label, `${expected}: ${truncate(result.message)}`);
  else fail(label, `expected SQLSTATE ${expected}, got ${result.code ?? `HTTP ${result.status}`} ${truncate(result.message)}`);
}

function truncate(text: string, max = 90): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Calls a Postgres function through PostgREST. */
function rpc(name: string, args: Record<string, unknown>, token = ANON_KEY): Promise<Result> {
  return rest(`rpc/${name}`, { method: 'POST', body: args, token });
}

interface Account {
  id: string;
  email: string;
  token: string;
}

/**
 * Creates a throwaway account through GoTrue and returns its access token.
 *
 * The password is generated here and never leaves this process. The address is
 * namespaced so that anything this suite leaves behind is identifiable in the
 * dashboard afterwards — see the header on what cannot be cleaned up.
 */
async function signUp(label: string): Promise<Account | null> {
  const stamp = Date.now().toString(36);
  const email = `verify-${label}-${stamp}-${Math.random().toString(36).slice(2, 8)}@javelinhub-verify.test`;
  const password = `vs-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

  const res = await fetch(`${URL_BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, data: { full_name: `Verify ${label}` } }),
  });
  const parsed = (await res.json().catch(() => null)) as
    | {
        access_token?: string;
        user?: { id?: string };
        msg?: string;
        error_description?: string;
        error_code?: string;
      }
    | null;

  const token = parsed?.access_token;
  const id = parsed?.user?.id;
  if (!res.ok || typeof token !== 'string' || typeof id !== 'string') {
    note(
      `could not create the "${label}" account: ${truncate(
        parsed?.msg ?? parsed?.error_description ?? `HTTP ${res.status}`,
      )}`,
    );
    /*
     * TWO CAUSES, and both are now expected rather than faults — the write
     * tiers were built when this project accepted throwaway addresses and
     * returned a session immediately, and neither is true any more.
     *
     * `email_address_invalid`: GoTrue validates the domain, so an address at a
     * domain with no MX record is refused. `@javelinhub-verify.test` and even
     * `@example.com` are both rejected. There is no fake domain that works.
     *
     * A 200 with no `access_token`: email confirmation is on, so a successful
     * signup yields no session — which is correct behaviour and the reason
     * `SignUpResult` has two arms. It also means this suite cannot ACT as the
     * account it just created.
     *
     * Either way the write tiers cannot provision fixtures against a project
     * configured for real users, which is what this one now is. Running them
     * needs a separate project with confirmation off — see the note the summary
     * prints.
     */
    if (res.ok) note('a signup with no session means email confirmation is ON — expected on this project');
    else if (typeof parsed?.error_code === 'string' && parsed.error_code.includes('email_address_invalid')) {
      note('GoTrue rejects addresses at domains with no MX record, so no throwaway domain will work here');
    }
    return null;
  }
  return { id, email, token };
}

// ---------------------------------------------------------------------------
console.log(`\nverify:supabase → ${URL_BASE}`);
note(WRITES ? 'WRITE TIER ENABLED — this will create real rows' : 'read-only (set VERIFY_SUPABASE_WRITES=1 for the full flow)');

// ===========================================================================
section('Column grants — the revokes that fail SILENTLY when undone');
// ===========================================================================
// `0002_rls.sql` revokes table-level SELECT on `listings` and grants the
// columns one by one, so `deleted_by` — an ADMINISTRATOR's id after a takedown
// — is unreadable. `0011_delivery.sql` does the same for `asset_path`, the key
// of a private storage object.
//
// Both are undone by any later blanket grant, with no error raised anywhere,
// and NOTHING IN THE APP WOULD NOTICE: the client names its columns explicitly,
// so it keeps working while the browser-reachable API quietly serves more. This
// section is the only automated check that they still hold.

expectSqlState('`select=*` on listings is refused', await rest('listings?select=*&limit=1'), '42501');
expectSqlState('...and so is deleted_by by name', await rest('listings?select=deleted_by&limit=1'), '42501');
expectSqlState('...and so is asset_path', await rest('listings?select=asset_path&limit=1'), '42501');
expectSqlState(
  '...and so is is_demo, which 0006 keeps outside the grant',
  await rest('listings?select=is_demo&limit=1'),
  '42501',
);

// The control. Every refusal above would also be produced by a table nobody can
// read at all, so the granted projection has to succeed — and it is the exact
// list `LISTING_COLUMNS` in `supabaseClient.ts` sends.
const granted = await rest(
  'listings?select=id,coach_id,title,description,price_cents,category,price_epoch,deleted_at,fulfilment,created_at,updated_at&limit=1',
);
expectEqual('the granted listing projection is readable', granted.status, 200);

// `fulfilment` is public on purpose and `asset_path` is not: a buyer should know
// HOW a thing arrives before claiming it, and never WHAT FILE it arrives as.
expectEqual('fulfilment alone is readable', (await rest('listings?select=fulfilment&limit=1')).status, 200);

// `profiles` carries email, so it is not world-readable. RLS expresses that as
// zero rows rather than a refusal — the distinction matters, because a REFUSAL
// here would mean the table grant had been changed rather than the policy.
const anonProfiles = await rest('profiles?select=id,email&limit=5');
expectEqual('profiles is admitted but empty for anon', [anonProfiles.status, rows(anonProfiles).length], [200, 0]);
const anonOrders = await rest('orders?select=id&limit=5');
expectEqual('orders is empty for anon — there is no anon policy at all', [anonOrders.status, rows(anonOrders).length], [200, 0]);
const anonRevisions = await rest('listing_revisions?select=id&limit=5');
expectEqual('listing_revisions is empty for anon', [anonRevisions.status, rows(anonRevisions).length], [200, 0]);
expectSqlState(
  'demo_data_summary stays revoked from anon (0007)',
  await rest('demo_data_summary?select=*'),
  '42501',
);

// ===========================================================================
section('Views — the auth.uid() predicate is INSIDE, so anon matches nothing');
// ===========================================================================
// Every self-scoped view in this schema puts its predicate in the FROM clause
// rather than relying on a caller-supplied filter, which is what makes it
// impossible to widen with a query string. For an anonymous caller `auth.uid()`
// is NULL, so the correct answer is ADMITTED AND EMPTY.
//
// 0007 worked through why they are not additionally revoked from `anon`:
// splitting one security property across two mechanisms makes it harder to
// audit, not easier. These assertions are what keeps that decision honest.

for (const view of ['owned_listings', 'entitled_offer_assets']) {
  const result = await rest(`${view}?select=*&limit=5`);
  expectEqual(`${view} is admitted for anon`, result.status, 200);
  expectEqual(`...and returns nothing`, rows(result).length, 0);
}

// A caller-supplied filter cannot widen a predicate that is already in the
// view. Asserted with a well-formed uuid so the request reaches the view rather
// than failing at the cast.
const probed = await rest('owned_listings?select=id&coach_id=eq.00000000-0000-4000-8000-000000000002');
expectEqual('pointing owned_listings at a named coach still returns nothing', rows(probed).length, 0);

// The public views ARE public, and the projection is the boundary: they exist
// so `profiles.email` and `profiles.role` never reach a page.
expectEqual('public_profiles is readable', (await rest('public_profiles?select=id,full_name&limit=1')).status, 200);
expectEqual('public_coaches is readable', (await rest('public_coaches?select=id,full_name&limit=1')).status, 200);
const leakedEmail = await rest('public_profiles?select=email&limit=1');
expectEqual(
  'public_profiles does NOT carry email',
  leakedEmail.status === 200 ? 'READABLE — the projection has changed' : 'absent',
  'absent',
);
const leakedRole = await rest('public_profiles?select=role&limit=1');
expectEqual(
  '...and does NOT carry role',
  leakedRole.status === 200 ? 'READABLE — the projection has changed' : 'absent',
  'absent',
);

// ===========================================================================
section('Writes are refused for anon, by the policies rather than by the app');
// ===========================================================================
// The app never issues these. A browser holding the anon key can, which is the
// premise the whole RLS model rests on.

for (const table of ['profiles', 'listings', 'orders', 'reviews', 'invites', 'deliverables']) {
  const result = await rest(table, { method: 'POST', body: {}, prefer: 'return=minimal' });
  // 42501 is the RLS refusal. A missing NOT NULL (23502) would mean the row was
  // admitted far enough to be validated, which is a different and worse answer,
  // so the code is asserted rather than merely "it failed".
  expectSqlState(`anon INSERT into ${table} is refused`, result, '42501');
}

// ===========================================================================
section('The privileged RPCs answer with THEIR OWN sentences');
// ===========================================================================
// `errors.ts` deliberately preserves the message when it came from one of our
// `raise exception`s and replaces it when it came from Postgres. That contract
// is only meaningful if the RPCs really do raise their own copy, which nothing
// in the mock suites can check.

const claimAnon = await rpc('claim_offer', { p_listing_id: '00000000-0000-4000-8000-000000000101' });
expectSqlState('claim_offer refuses an anonymous caller', claimAnon, '42501');
expectEqual(
  '...with the sentence 0009 wrote, not a Postgres one',
  claimAnon.message.includes('signed in'),
  true,
);

const grantAnon = await rpc('grant_admin', { p_user_id: '00000000-0000-4000-8000-000000000001' });
// Not granted to `authenticated` at all, so this is a function-level refusal
// rather than one from inside the body. Either way it must not succeed.
expectEqual('grant_admin is not callable through the API', grantAnon.status >= 400, true);
note(`grant_admin → ${grantAnon.code ?? grantAnon.status}: ${truncate(grantAnon.message)}`);

const redeemAnon = await rpc('redeem_invite_code', { p_code: 'AAAA-AAAA-AAAA' });
expectEqual('redeem_invite_code refuses an anonymous caller', redeemAnon.status >= 400, true);

// ===========================================================================
section('Enum parity — the TypeScript unions against the real types');
// ===========================================================================
// `LISTING_CATEGORIES` and `FULFILMENT_MODES` are hand-written in TypeScript and
// mirror two Postgres enums. Nothing has ever compared them, and a drift is
// invisible until a write fails in production with a cast error.
//
// Read by asking PostgREST to accept a value that is NOT in the enum: Postgres
// answers 22P02 and NAMES the type. That is a weaker check than reading
// `enum_range()` — which needs a function this schema does not expose — but it
// proves the type exists under the name the client assumes.

const badCategory = await rest('listings?select=id&category=eq.__not_a_category__');
expectEqual(
  'listing_category is an enum, so an unknown value is a cast error not a wider result',
  badCategory.code === '22P02' || badCategory.status >= 400,
  true,
);
const badMode = await rest('listings?select=id&fulfilment=eq.__not_a_mode__');
expectEqual(
  'fulfilment_mode likewise',
  badMode.code === '22P02' || badMode.status >= 400,
  true,
);
// And every value the client CAN send is accepted by the cast. This is the half
// that catches a member added in TypeScript and never added to the enum.
for (const category of LISTING_CATEGORIES) {
  const result = await rest(`listings?select=id&category=eq.${category}&limit=1`);
  if (result.status === 200) ok(`category "${category}" is a real enum member`);
  else fail(`category "${category}" is a real enum member`, `${result.code ?? result.status} ${truncate(result.message)}`);
}
for (const mode of FULFILMENT_MODES) {
  const result = await rest(`listings?select=id&fulfilment=eq.${mode}&limit=1`);
  if (result.status === 200) ok(`fulfilment "${mode}" is a real enum member`);
  else fail(`fulfilment "${mode}" is a real enum member`, `${result.code ?? result.status} ${truncate(result.message)}`);
}

// ===========================================================================
section('Storage — the private buckets refuse an anonymous reader');
// ===========================================================================
// 0008 makes `avatars` public and 0011 makes `deliverables` and `offer-assets`
// private, and the difference is the whole design. A bucket that silently
// became public would serve every delivered file to anyone with the URL.

for (const bucket of ['deliverables', 'offer-assets']) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 1 }),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  const listed = Array.isArray(body) ? body.length : -1;
  // Either a refusal or an empty listing is correct — the policies key off rows
  // an anonymous caller matches none of. What must never happen is a NAME
  // coming back.
  expectEqual(`${bucket} lists nothing for anon`, listed <= 0, true);
}

// ===========================================================================
section('Rate limiting — callable by anon, unreadable by anyone');
// ===========================================================================
// 0013. The counter has to be reachable without a session, because every form
// it protects is — and the table behind it has to be reachable by nothing at
// all, because a bucket is derived from an email address and a readable table
// would be an "has this person asked for a password reset" oracle.
//
// These are writes in the sense that they increment a counter, but they create
// no user-visible rows and are keyed on a bucket nothing else will ever use, so
// they run in the read-only tier. The sweep in the function clears them within
// a day.

expectSqlState(
  'the rate_limits table is unreadable, with no policy to review',
  await rest('rate_limits?select=*&limit=1'),
  '42501',
);
expectSqlState(
  '...and unwritable',
  await rest('rate_limits', { method: 'POST', body: { bucket: 'x', count: 0 }, prefer: 'return=minimal' }),
  '42501',
);

// The function IS callable by anon. A limiter that only applied to signed-in
// callers would protect none of the forms it exists for.
const probeBucket = `verify-supabase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const first = await rpc('consume_rate_limit', { p_bucket: probeBucket, p_limit: 2, p_window_seconds: 60 });
expectEqual('anon may consume a rate limit', first.status, 200);
expectEqual('...and the first attempt is admitted', first.body, true);
expectEqual(
  '...the second, at a limit of 2, still is',
  (await rpc('consume_rate_limit', { p_bucket: probeBucket, p_limit: 2, p_window_seconds: 60 })).body,
  true,
);
expectEqual(
  '...and the third is refused',
  (await rpc('consume_rate_limit', { p_bucket: probeBucket, p_limit: 2, p_window_seconds: 60 })).body,
  false,
);
// Counted even when refused, so hammering an exhausted bucket keeps it
// exhausted rather than letting a caller wait out a window they keep filling.
await rpc('consume_rate_limit', { p_bucket: probeBucket, p_limit: 2, p_window_seconds: 60 });
expectEqual(
  '...and stays refused while it is hammered',
  (await rpc('consume_rate_limit', { p_bucket: probeBucket, p_limit: 2, p_window_seconds: 60 })).body,
  false,
);
// The control: a different bucket has its own budget, so the refusals above are
// about this bucket rather than about the function refusing everything.
expectEqual(
  'a different bucket has its own budget',
  (await rpc('consume_rate_limit', { p_bucket: `${probeBucket}-other`, p_limit: 2, p_window_seconds: 60 })).body,
  true,
);
// Degenerate arguments fail CLOSED inside the function. They cannot arrive from
// the app — the budgets are constants — so the only caller who can send one is
// somebody probing, and a zero window would otherwise make every row instantly
// stale and the limiter a no-op that still looks installed.
for (const [shape, args] of [
  ['a zero limit', { p_bucket: probeBucket, p_limit: 0, p_window_seconds: 60 }],
  ['a negative limit', { p_bucket: probeBucket, p_limit: -1, p_window_seconds: 60 }],
  ['a zero window', { p_bucket: probeBucket, p_limit: 5, p_window_seconds: 0 }],
] as Array<[string, Record<string, unknown>]>) {
  expectEqual(`${shape} is refused rather than ignored`, (await rpc('consume_rate_limit', args)).body, false);
}

// ===========================================================================
section('Moderation — the archive, and the routes that were closed');
// ===========================================================================
// 0016 adds `removed_reviews` and `remove_review()`, and DROPS two policies
// that 0002 had carried unused since the schema landed. Both drops are the
// interesting half: each was a way around the audited path.
//
//   reviews_update_admin  would let an administrator rewrite a review in place
//   reviews_delete_admin  would let one delete a review with no archive row
//
// A dropped policy cannot be asserted directly — there is no "this policy is
// absent" endpoint — so what is asserted is the CONSEQUENCE: an anonymous
// caller is refused, which was already true, and the write paths below refuse
// everyone. The signed-in admin case needs an admin session, which this suite
// cannot mint; it is covered in `verify:authz` against the mock instead.

// REFUSED OUTRIGHT, not admitted-and-empty — and the difference from
// `owned_listings` above is deliberate. That is a VIEW whose `auth.uid()`
// predicate is the boundary, so 0007 reasoned that leaving anon's default grant
// alone kept the security property in one place. This is a TABLE, anon has no
// business reaching it under any predicate, and 0016 revokes the grant. A 42501
// here is the stronger answer.
expectSqlState(
  'removed_reviews is refused outright for anon',
  await rest('removed_reviews?select=id&limit=1'),
  '42501',
);
expectSqlState(
  'anon cannot INSERT into removed_reviews — the archive is written by the RPC alone',
  await rest('removed_reviews', { method: 'POST', body: {}, prefer: 'return=minimal' }),
  '42501',
);
// No UPDATE policy for any role at all, so an archived row cannot be edited
// after the fact — a log somebody can rewrite is not a log.
expectSqlState(
  'anon cannot UPDATE removed_reviews either',
  await rest('removed_reviews?id=eq.00000000-0000-4000-8000-0000000000ff', {
    method: 'PATCH',
    body: { reason: 'rewritten' },
    prefer: 'return=minimal',
  }),
  '42501',
);

const removeAnon = await rpc('remove_review', {
  p_review_id: '00000000-0000-4000-8000-0000000000ff',
  p_reason: null,
});
expectSqlState('remove_review refuses an anonymous caller', removeAnon, '42501');
expectEqual(
  '...with the sentence 0016 wrote, not a Postgres one',
  removeAnon.message.includes('Only an administrator'),
  true,
);

// ===========================================================================
section('The email sync trigger (0017)');
// ===========================================================================
// `profiles.email` is a copy of `auth.users.email` written ONCE, by an
// AFTER INSERT trigger, and pinned against every client write by
// `guard_profile_privilege_columns`. Without 0017 a successful GoTrue email
// change would leave the copy holding the old address permanently, with no code
// path able to correct it.
//
// The trigger itself cannot be fired from here — it needs a real email change,
// which needs two confirmed links — so what is asserted is the boundary that
// makes the trigger the ONLY writer: no client role can move the column.

/*
 * ADMITTED AND MATCHING NOTHING, not refused — the same distinction
 * `owned_listings` makes above, and worth getting right rather than asserting
 * the more dramatic answer. `profiles_update_own` is `using (id = auth.uid())`,
 * and `auth.uid()` is NULL for anon, so the statement is allowed to run and
 * reaches no row. PostgREST reports that as 204, or as an empty array when
 * asked for the rows it changed.
 *
 * `return=representation` is what makes this an assertion rather than a shrug:
 * a 204 alone cannot tell "changed nothing" from "changed something quietly".
 */
const emailWrite = await rest('profiles?id=eq.00000000-0000-4000-8000-000000000002&select=id', {
  method: 'PATCH',
  body: { email: 'moved@example.com' },
  prefer: 'return=representation',
});
expectEqual('anon is admitted to the statement', emailWrite.status, 200);
expectEqual('...and changes no row at all', rows(emailWrite).length, 0);

// The guard behind it, reached only by somebody whose row the policy DOES
// admit. That path needs a session, so it is asserted in `verify:authz`
// against the mock twin — recorded here so the gap is deliberate rather than
// forgotten.

// ===========================================================================
section('The signed-in tier');
// ===========================================================================

if (!WRITES) {
  skip('every signed-in assertion', 'read-only run; set VERIFY_SUPABASE_WRITES=1 to include them');
} else {
  const learner = await signUp('learner');
  if (!learner) {
    skip('every signed-in assertion', 'could not create a throwaway account — see the note above');
  } else {
    ok('a throwaway learner account was created', learner.email);

    // The profile trigger. `0002_rls.sql` installs an `after insert on
    // auth.users` trigger, so a profile exists without the app writing one —
    // and it must arrive as a LEARNER. Signup that could mint a coach would be
    // the whole authorization model gone.
    const own = await rest(`profiles?select=id,role,coach_status&id=eq.${learner.id}`, { token: learner.token });
    const ownRow = rows(own)[0] as { role?: string; coach_status?: string } | undefined;
    expectEqual('the signup trigger created a profile', Boolean(ownRow), true);
    expectEqual('...as a learner', ownRow?.role, 'learner');
    expectEqual('...with no coach status', ownRow?.coach_status, 'none');

    // Self only. RLS renders somebody else's row as absent rather than refused.
    const others = await rest('profiles?select=id,email', { token: learner.token });
    expectEqual('a learner sees only their own profile row', rows(others).length, 1);

    // The privilege columns are guarded by a TRIGGER, not only by a policy —
    // `profiles_update_own` on its own would let this through.
    const selfPromote = await rest(`profiles?id=eq.${learner.id}`, {
      token: learner.token,
      method: 'PATCH',
      body: { role: 'admin' },
      prefer: 'return=minimal',
    });
    expectSqlState('a learner cannot promote themselves', selfPromote, '42501');
    const selfApprove = await rest(`profiles?id=eq.${learner.id}`, {
      token: learner.token,
      method: 'PATCH',
      body: { coach_status: 'approved' },
      prefer: 'return=minimal',
    });
    expectSqlState('...nor approve themselves as a coach', selfApprove, '42501');

    // Publishing needs `is_approved_coach()`, which this account is not.
    const publish = await rest('listings', {
      token: learner.token,
      method: 'POST',
      body: {
        coach_id: learner.id,
        title: 'verify:supabase should never publish this',
        description: 'If this row exists, listings_insert_approved_coach is not doing its job.',
        price_cents: 1000,
        category: 'training_plan',
      },
      prefer: 'return=minimal',
    });
    expectSqlState('a learner cannot publish an offer', publish, '42501');

    // `owned_listings` is self-scoped, so it is empty for somebody who owns
    // nothing — the same answer anon got, reached by a different route.
    const ownedEmpty = await rest('owned_listings?select=id', { token: learner.token });
    expectEqual('owned_listings is empty for a learner', rows(ownedEmpty).length, 0);
    const entitledEmpty = await rest('entitled_offer_assets?select=listing_id', { token: learner.token });
    expectEqual('entitled_offer_assets is empty for a learner', rows(entitledEmpty).length, 0);

    // ---------------------------------------------------------------------
    // The coach tier, which needs the one thing this suite cannot create.
    // ---------------------------------------------------------------------
    if (INVITE === '') {
      skip(
        'the approved-coach assertions',
        'no VERIFY_SUPABASE_INVITE — an invite code is the only route to an approved coach that does not need direct database access',
      );
      note('mint one as an admin, then re-run with VERIFY_SUPABASE_INVITE=XXXX-XXXX-XXXX');
    } else {
      const coach = await signUp('coach');
      if (!coach) {
        skip('the approved-coach assertions', 'could not create the coach account');
      } else {
        const redeemed = await rpc('redeem_invite_code', { p_code: INVITE }, coach.token);
        if (redeemed.status >= 400) {
          skip('the approved-coach assertions', `the invite code was refused: ${truncate(redeemed.message)}`);
        } else {
          ok('an invite code promotes its redeemer to an approved coach');

          // --- publish, as the coach --------------------------------------
          const created = await rest('listings?select=id,fulfilment', {
            token: coach.token,
            method: 'POST',
            prefer: 'return=representation',
            body: {
              coach_id: coach.id,
              title: 'verify:supabase fixture — instant delivery',
              description: 'Published by the Postgres verification suite. Withdrawn again at the end of the run.',
              price_cents: 1500,
              category: 'training_plan',
              fulfilment: 'instant',
            },
          });
          const listing = rows(created)[0] as { id?: string; fulfilment?: string } | undefined;
          expectEqual('an approved coach can publish', Boolean(listing?.id), true);
          expectEqual('...in the mode they asked for', listing?.fulfilment, 'instant');

          if (listing?.id) {
            const listingId = listing.id;

            // --- the claim refusal 0011 added ---------------------------
            // An instant offer with no file cannot be claimed. This is the
            // rule that makes "download it now" a promise the offer can keep,
            // and it lives in `claim_offer` where no client can skip it.
            const earlyClaim = await rpc('claim_offer', { p_listing_id: listingId }, learner.token);
            expectSqlState('an instant offer with no file cannot be claimed', earlyClaim, '22023');
            expectEqual(
              '...with the sentence 0011 wrote',
              earlyClaim.message.includes('not ready'),
              true,
            );

            // --- asset_path, written but never read back ----------------
            const attach = await rest(`listings?id=eq.${listingId}`, {
              token: coach.token,
              method: 'PATCH',
              body: { asset_path: `${listingId}/verify-suite-fixture.pdf` },
              prefer: 'return=minimal',
            });
            expectEqual('the owner can write asset_path', attach.status < 300, true);

            // The CHECK constraint pins the path under the listing's own id.
            const wrongFolder = await rest(`listings?id=eq.${listingId}`, {
              token: coach.token,
              method: 'PATCH',
              body: { asset_path: 'somebody-elses-folder/plan.pdf' },
              prefer: 'return=minimal',
            });
            expectSqlState('a path outside the offer’s own folder is refused', wrongFolder, '23514');

            // The owner reads it back through the VIEW, never through the table.
            const ownedRow = rows(
              await rest(`owned_listings?select=id,fulfilment,asset_path&id=eq.${listingId}`, { token: coach.token }),
            )[0] as { asset_path?: string } | undefined;
            expectEqual('the owner sees their own asset_path through owned_listings', Boolean(ownedRow?.asset_path), true);
            expectSqlState(
              '...and still cannot read the column off the table',
              await rest(`listings?select=asset_path&id=eq.${listingId}`, { token: coach.token }),
              '42501',
            );

            // --- claiming, now that a file is attached ------------------
            const claim = await rpc('claim_offer', { p_listing_id: listingId }, learner.token);
            expectEqual('the offer can be claimed once a file is attached', claim.status < 300, true);

            // --- entitlement, from both sides ---------------------------
            const buyerAsset = rows(
              await rest(`entitled_offer_assets?select=listing_id,asset_path&listing_id=eq.${listingId}`, {
                token: learner.token,
              }),
            );
            expectEqual('the BUYER can now see the download path', buyerAsset.length, 1);

            const stranger = await signUp('stranger');
            if (!stranger) {
              skip('the isolation assertion', 'could not create the stranger account');
            } else {
              // THE ASSERTION THIS WHOLE TIER EXISTS FOR. Somebody with an
              // account but no order for this listing must see nothing —
              // `entitled_offer_assets` scopes on an order, not on being
              // signed in.
              const strangerAsset = rows(
                await rest(`entitled_offer_assets?select=listing_id&listing_id=eq.${listingId}`, {
                  token: stranger.token,
                }),
              );
              expectEqual('a signed-in stranger sees NO download path', strangerAsset.length, 0);

              const strangerOrders = rows(await rest('orders?select=id', { token: stranger.token }));
              expectEqual('...and no orders at all', strangerOrders.length, 0);
            }

            // --- the fulfilment freeze ----------------------------------
            // Immutable once anything has been claimed, for an admin too. The
            // trigger is the only thing enforcing it; no policy can, because
            // it is a question about rows in another table.
            const flip = await rest(`listings?id=eq.${listingId}`, {
              token: coach.token,
              method: 'PATCH',
              body: { fulfilment: 'personalised' },
              prefer: 'return=minimal',
            });
            expectSqlState('the delivery mode is frozen once claimed', flip, '42501');
            expectEqual(
              '...with the sentence 0011 wrote',
              flip.message.includes('cannot change once'),
              true,
            );

            // --- ownership cannot be transferred ------------------------
            const steal = await rest(`listings?id=eq.${listingId}`, {
              token: learner.token,
              method: 'PATCH',
              body: { title: 'Rewritten by somebody who does not own it' },
              prefer: 'return=minimal',
            });
            // RLS renders this as zero rows updated rather than a refusal:
            // `listings_update_own_coach` never admits the statement, so the
            // trigger is not even reached.
            expectEqual('a non-owner cannot edit an offer', steal.status < 300 ? 'admitted' : 'refused', 'admitted');
            const afterSteal = rows(
              await rest(`listings?select=title&id=eq.${listingId}`),
            )[0] as { title?: string } | undefined;
            expectEqual(
              '...and the title is untouched, because it matched no row',
              afterSteal?.title?.startsWith('verify:supabase fixture'),
              true,
            );

            // --- price epoch is DERIVED ---------------------------------
            // The client cannot set it: whatever is sent is overwritten by the
            // trigger from the price movement.
            await rest(`listings?id=eq.${listingId}`, {
              token: coach.token,
              method: 'PATCH',
              body: { price_cents: 9900, price_epoch: 99 },
              prefer: 'return=minimal',
            });
            const epochRow = rows(
              await rest(`listings?select=price_epoch&id=eq.${listingId}`),
            )[0] as { price_epoch?: number } | undefined;
            expectEqual('a client-supplied price_epoch is discarded', epochRow?.price_epoch, 2);

            // --- clean up what can be cleaned up ------------------------
            // There is no hard delete of a listing for any role, by design, so
            // withdrawing is the most this can do. The order and the accounts
            // stay — see the header.
            const withdraw = await rest(`listings?id=eq.${listingId}`, {
              token: coach.token,
              method: 'PATCH',
              body: { deleted_at: new Date().toISOString() },
              prefer: 'return=minimal',
            });
            expectEqual('the fixture offer is withdrawn again', withdraw.status < 300, true);
            note('the order, the accounts and the withdrawn listing remain — there is no delete path for them');
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
if (skipped > 0) {
  console.log('A skipped assertion is not a passing one. See the SKIP lines above for what each needs.');
}
process.exit(failed === 0 ? 0 : 1);
