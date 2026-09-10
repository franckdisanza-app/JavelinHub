/**
 * The two routes that arrive in an email, and the one function that decides
 * where a redirect may point.
 *
 * WHAT THEY HAVE IN COMMON is the constraint below rather than the subject
 * matter: all three are needed by code that runs OUTSIDE the Next runtime, and
 * this file is the only place in `src/lib/auth/` that can be read from there.
 * `safeNextPath` moved here from `session.ts` for exactly that reason — it is
 * the most security-sensitive pure function in the app and it was the one
 * function no unit test could import, because `session.ts` pulls in
 * `next/headers`. `session.ts` re-exports it, so no call site changed, and
 * `tests/unit/safe-next-path.test.mts` now covers it.
 *
 * **Its own module because of what it must NOT import.** Both of these strings
 * are needed by `SupabaseDataClient` — `signUp` builds the confirmation link's
 * `emailRedirectTo` from one — and the data layer is exercised by
 * `scripts/verify-authz.mts`, a plain Node script. Their natural home,
 * `password-reset.ts`, imports the session layer and through it `next/headers`,
 * which does not resolve outside the Next runtime at all.
 *
 * The same split, for the same reason, as `reset-tokens.ts` and `client-ip.ts`.
 * This file imports nothing and never should.
 *
 * A LINK IN AN EMAIL CANNOT BE CHANGED once it is sent, so both paths are
 * effectively permanent: they are registered in Supabase's Redirect URLs
 * allow-list, and a link already in somebody's inbox points at whatever they
 * said when it was minted. Renaming either means honouring the old path for as
 * long as an unexpired link might exist.
 */

/** Where every emailed link lands. Registered in Supabase → Redirect URLs. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * The callback's default destination.
 *
 * It is the RECOVERY page rather than the marketing one on purpose: of the
 * flows that land here, password reset is the one where arriving at the wrong
 * place strands somebody who cannot sign in by any other route. Signup
 * confirmation passes an explicit `?next=`, and if that were ever dropped in
 * transit a confirming user lands here already signed in — an odd screen, but a
 * recoverable one.
 */
export const RESET_PASSWORD_PATH = '/reset-password';

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
