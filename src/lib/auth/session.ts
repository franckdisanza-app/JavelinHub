/**
 * =============================================================================
 * Session layer — the only thing that turns a request into an `Actor`.
 * =============================================================================
 *
 * -----------------------------------------------------------------------------
 * TWO SESSION MECHANISMS, chosen by `DATA_BACKEND`
 * -----------------------------------------------------------------------------
 * `mock`     — the signed cookie described below, verified in this file.
 * `supabase` — Supabase's own auth cookies, verified by GoTrue.
 *
 * The three functions that touch the mechanism (`createSession`,
 * `destroySession`, `getSessionUserId`) dispatch on the backend; NOTHING ELSE IN
 * THE APP DOES. `getActor()`, `getCurrentProfile()`, `requireUser()` and
 * `requireAdmin()` are identical either way, so pages and server actions never
 * learn which one is running — the same promise `DataClient` makes about
 * persistence, extended to identity.
 *
 * The two mechanisms cannot be mixed and must not be: on Supabase the session
 * IS the JWT, because `auth.uid()` inside every RLS policy is read from it. A
 * locally signed cookie would name a user Postgres has never heard of, and
 * every policy would then evaluate against `null` — the app would look signed
 * in and the database would treat it as anonymous. That is why `createSession`
 * is a deliberate no-op on Supabase rather than an attempt to mirror the id.
 *
 * -----------------------------------------------------------------------------
 * The mock cookie
 * -----------------------------------------------------------------------------
 * The cookie carries a **user id and an issued-at timestamp, and nothing else.**
 *
 * That is a deliberate, load-bearing constraint. It is tempting to cache `role`
 * and `coach_status` in the cookie to save a store read per request, and it is
 * an authorization bug the moment you do: redeeming an invite code promotes a
 * learner to an approved coach *immediately*, and an admin can revoke or review
 * at any time. A copy of those fields taken at sign-in goes stale in the middle
 * of a session, and stale authorization data is indistinguishable from forged
 * authorization data. So the cookie says who you claim to be; the data layer
 * says what you may do, resolved fresh on every single call. This mirrors
 * Postgres RLS, which trusts `auth.uid()` and reads everything else from the
 * database — see `docs/DATA-LAYER.md`, "The actor rule".
 *
 * The cookie is signed (HMAC-SHA256 over the encoded payload) with
 * `SESSION_SECRET`, so a user cannot edit the id inside it and become someone
 * else. Signing is not encryption: the id is readable by anyone holding the
 * cookie. That is fine — a user id is not a secret, and the signature is what
 * stops it being *changed*.
 *
 * Verification never throws. A tampered, truncated, expired or otherwise
 * malformed cookie makes the request anonymous; it does not produce a 500.
 * Anything else would let a stale cookie left over from a deleted `db.json`
 * take the whole site down.
 *
 * SERVER ONLY. Uses `node:crypto` and `next/headers`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { getDataClient } from '@/lib/data';
import { createSupabaseServerClient, getSupabaseUserId } from '@/lib/data/supabase/serverClient';
import { isDataError, type Actor, type Profile } from '@/lib/data/types';
import { dataBackend, isProduction, sessionSecret } from '@/lib/env';

if (typeof window !== 'undefined') {
  throw new Error(
    'The session layer is server-only and was imported into browser code. ' +
      'Call it from a server component, server action or route handler instead.',
  );
}

/** Name of the session cookie. */
export const SESSION_COOKIE = 'javelin_session';

/** How long a session stays valid, in seconds. Enforced twice: as the cookie's
 *  own `Max-Age`, and again against the signed `iat` so that a cookie replayed
 *  after its expiry (the browser is not the authority here) is still rejected. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Tolerance for a clock that has drifted slightly backwards, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

interface SessionPayload {
  /** The signed-in user's id. The ONLY identity fact in the cookie. */
  uid: string;
  /** Issued-at, seconds since the epoch. */
  iat: number;
}

// ---------------------------------------------------------------------------
// Encoding / signing
// ---------------------------------------------------------------------------

function sign(body: string): Buffer {
  return createHmac('sha256', sessionSecret()).update(body).digest();
}

function encodeSessionCookie(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body).toString('base64url')}`;
}

/**
 * Returns the user id carried by a cookie value, or `null` for anything that is
 * not a currently valid, correctly signed session. Never throws on bad input.
 */
function decodeSessionCookie(raw: string): string | null {
  try {
    const separator = raw.lastIndexOf('.');
    if (separator <= 0 || separator === raw.length - 1) return null;

    const body = raw.slice(0, separator);
    const provided = Buffer.from(raw.slice(separator + 1), 'base64url');
    const expected = sign(body);

    // `timingSafeEqual` throws on a length mismatch, so the length check has to
    // come first. It leaks only the signature *length*, which is a constant.
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;

    // Only now is the payload trustworthy enough to parse.
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { uid, iat } = parsed as Partial<SessionPayload>;
    if (typeof uid !== 'string' || uid.trim() === '') return null;
    if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (iat > now + CLOCK_SKEW_SECONDS) return null; // issued in the future
    if (now - iat > SESSION_MAX_AGE_SECONDS) return null; // past its life

    return uid;
  } catch {
    // Malformed base64, malformed JSON, a missing SESSION_SECRET at an
    // unexpected moment — all of it means "not signed in", never a 500.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Signs the given user in.
 *
 * Call this from a Server Action or Route Handler only — Next.js does not allow
 * a Server Component to write cookies, and will throw if you try.
 *
 * ON SUPABASE THIS DOES NOTHING, deliberately. `supabase.auth.signUp()` and
 * `signInWithPassword()` — called inside `SupabaseDataClient` moments earlier,
 * from this same server action — have already written the access and refresh
 * token cookies through the `setAll` handler in `serverClient.ts`. The session
 * exists before this function is reached, and issuing a second, locally signed
 * cookie beside it would create a competing identity that Postgres cannot see.
 *
 * `auth/actions.ts` still calls it unconditionally, and should: the call site
 * stays backend-agnostic, and the mock genuinely needs it.
 */
export async function createSession(userId: string): Promise<void> {
  if (dataBackend() === 'supabase') return;

  const store = await cookies();
  store.set(SESSION_COOKIE, encodeSessionCookie({ uid: userId, iat: Math.floor(Date.now() / 1000) }), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Only in production: a `Secure` cookie is dropped over plain http, which
    // is exactly how this POC is run.
    secure: isProduction(),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Signs the current user out. Server Actions / Route Handlers only.
 *
 * On Supabase this is `auth.signOut()`, which revokes the refresh token server
 * side and clears the cookie pair. Clearing the cookies alone would log the
 * browser out while leaving the refresh token valid for anyone who had already
 * copied it.
 */
export async function destroySession(): Promise<void> {
  if (dataBackend() === 'supabase') {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
    return;
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProduction(),
    maxAge: 0,
  });
}

/**
 * Ends every OTHER session this user has, and leaves the caller's own intact.
 *
 * Called after a password changes — from the reset flow and from `/settings`.
 * A password change that leaves the old sessions running is not a password
 * change: the two people who most need this are somebody whose laptop was
 * stolen and somebody who is resetting *because* they were compromised, and for
 * both of them the attacker's session is the entire threat. Until this existed
 * that session survived the reset, and `docs/ROADMAP.md` §4 recorded it as a
 * known divergence rather than pretending otherwise.
 *
 * -----------------------------------------------------------------------------
 * THE TWO BACKENDS STILL DIVERGE, AND THE DIVERGENCE IS NARROWER NOW
 * -----------------------------------------------------------------------------
 * `supabase` — `signOut({ scope: 'others' })` revokes every refresh token for
 * the user except the one this request holds. **What it cannot revoke is an
 * access token that has already been issued**, which stays valid until it
 * expires — at most an hour. That is the same residual account deletion carries
 * and is documented there for the same reason: every path through the
 * application is closed at once, and a raw token held by somebody who already
 * had one keeps satisfying RLS on a direct PostgREST call until it lapses.
 *
 * `mock` — a NO-OP, and it has to be. The mock cookie is stateless by design:
 * it carries a user id and an issued-at, signed, and nothing reads a store to
 * validate it. There is no revocation list to add a row to, and inventing one
 * would mean a store shape, a migration in `db.json`, and a second
 * implementation of session validity — for a backend that `README.md` says
 * cannot be deployed at all. Recorded rather than faked, which is this file's
 * standing rule for anything the two mechanisms genuinely do not share.
 *
 * NEVER THROWS. This runs immediately after a password has already been
 * written, so the change has happened whatever this returns. Failing the action
 * here would tell the user their new password did not take when it did, and
 * would send them back to a form that now needs the new one.
 *
 * Server Actions / Route Handlers only: the Supabase branch writes cookies.
 */
export async function destroyOtherSessions(): Promise<void> {
  if (dataBackend() !== 'supabase') return;

  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut({ scope: 'others' });
  } catch {
    // See above. A revocation that could not be delivered is worth nothing to
    // the caller and must not undo a password change that succeeded.
  }
}

/**
 * The signed-in user's id, or `null` when anonymous / the session is not valid.
 *
 * Both branches have the same contract, and it is the important one: a
 * tampered, expired or otherwise unusable session makes the request ANONYMOUS
 * and never throws. `getSupabaseUserId()` validates the JWT against the auth
 * server rather than decoding it locally — see `serverClient.ts` for why that
 * distinction is a security boundary and not a preference.
 */
export async function getSessionUserId(): Promise<string | null> {
  if (dataBackend() === 'supabase') return getSupabaseUserId();

  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return decodeSessionCookie(raw);
}

/**
 * The `Actor` to hand to every data-layer call.
 *
 * Note what this does NOT do: it does not look the user up, and it does not
 * attach a role. The data layer resolves privileges itself, from the store, on
 * every call — see `src/lib/data/client.ts`.
 */
export async function getActor(): Promise<Actor> {
  const userId = await getSessionUserId();
  return userId ? { userId } : null;
}

/**
 * The full profile of the signed-in user, or `null`.
 *
 * Returns `null` rather than throwing when the cookie names a user who no
 * longer exists — which happens routinely in this POC, because deleting
 * `data/db.json` resets the store while the browser keeps its cookie.
 *
 * This is a `Profile` and therefore carries an email: it is safe for the
 * owner's own chrome (the header, their own pages) and must never be handed to
 * a public page. Use `getPublicProfile()` there.
 */
export async function getCurrentProfile(): Promise<Profile | null> {
  const actor = await getActor();
  if (!actor) return null;
  try {
    return await getDataClient().getProfile(actor, actor.userId);
  } catch (error) {
    if (isDataError(error)) return null;
    throw error;
  }
}

/**
 * Builds a login URL that returns the user to where they were headed.
 *
 * `nextPath` is only honoured when it is a same-site path — see
 * {@link safeNextPath} for how that is decided.
 */
export function loginPath(nextPath?: string | null): string {
  const safe = safeNextPath(nextPath);
  return safe ? `/login?next=${encodeURIComponent(safe)}` : '/login';
}

/**
 * Origin used to resolve a candidate `?next=` value. `.invalid` is reserved by
 * RFC 6761 and can never be a real host, so nothing can collide with it.
 */
const NEXT_PATH_BASE = 'http://x.invalid';

/** Longer than any route this app will ever have; a cheap ceiling on silly input. */
const NEXT_PATH_MAX_LENGTH = 2048;

/**
 * Normalises a `?next=` value to a safe same-site path, or `null`.
 *
 * -----------------------------------------------------------------------------
 * Why this parses instead of pattern-matching
 * -----------------------------------------------------------------------------
 * An earlier version of this function rejected `//` and `/\` by prefix and
 * banned backslashes. That is a denylist, and it lost:
 *
 *     next = "/\t/evil.example"
 *
 * starts with exactly one slash, contains no backslash, and sailed through. The
 * WHATWG URL parser then *strips* the tab — browsers remove tab, CR and LF from
 * URLs — leaving `//evil.example`, a protocol-relative URL pointing off-site.
 * `new URL('/\t/evil.example', location.href).href` really does resolve to
 * `http://evil.example/`. The same input with a newline instead of a tab was
 * worse: it reached Node's header writer verbatim and threw
 * `ERR_INVALID_CHAR ["Location"]`, turning one crafted link into an
 * unauthenticated 500.
 *
 * Adding tab and newline to the denylist would have been the wrong fix — the
 * denylist itself was the defect. So:
 *
 *   1. Resolve the candidate against a throwaway origin with the *same* parser
 *      the browser uses. Anything that escapes the origin — `//host`,
 *      `/\host`, `/<tab>/host`, an absolute URL, a `javascript:` scheme — lands
 *      somewhere other than `NEXT_PATH_BASE` and is rejected by comparison
 *      rather than by pattern.
 *   2. Rebuild the return value from the parsed components. This is the
 *      load-bearing half: whatever we hand to `redirect()` is then normalised
 *      output from the URL serialiser and cannot carry a stray control
 *      character into a `Location` header, no matter what came in.
 *
 * Round-trips a real path with its query and fragment intact
 * (`/offers?q=x#y`), because losing those would silently break the "send me
 * back where I was" promise.
 */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const candidate = value.trim();
  if (candidate === '' || candidate.length > NEXT_PATH_MAX_LENGTH) return null;

  // Must be a path reference, not a scheme or an authority. This is a fast
  // reject, not the security boundary — the origin check below is.
  if (!candidate.startsWith('/')) return null;

  let url: URL;
  try {
    url = new URL(candidate, NEXT_PATH_BASE);
  } catch {
    // e.g. a bare `//` with no host.
    return null;
  }

  if (url.origin !== NEXT_PATH_BASE) return null;

  // Rebuilt from parsed parts — never the raw input.
  const rebuilt = `${url.pathname}${url.search}${url.hash}`;
  return rebuilt.startsWith('/') ? rebuilt : null;
}

/**
 * Requires a signed-in user; redirects to `/login?next=…` otherwise.
 *
 * `nextPath` is passed explicitly by the caller rather than sniffed from a
 * header, because there is no stable, documented way to read the current
 * pathname inside a Server Component and guessing at an internal header is how
 * you get a redirect loop after an upgrade.
 *
 * This is a *convenience*, not the authorization boundary. The data layer
 * refuses the operation regardless of what this returns.
 */
export async function requireUser(nextPath?: string): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect(loginPath(nextPath));
  return profile;
}

/**
 * Requires a signed-in **admin**.
 *
 * Anonymous callers are sent to the login page. A signed-in non-admin gets a
 * 404 rather than a 403: an admin area whose existence is confirmed to every
 * learner who pokes at the URL is an invitation. Either behaviour satisfies the
 * requirement; neither is a substitute for the data layer's own check, which
 * refuses `listInvites` / `createInvite` / `revokeInvite` for non-admins even
 * if this function were removed entirely.
 *
 * The role is read from the **store**, never from the cookie, so an admin who
 * was demoted mid-session loses access on their next request.
 */
export async function requireAdmin(nextPath?: string): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect(loginPath(nextPath));
  if (profile.role !== 'admin') notFound();
  return profile;
}
