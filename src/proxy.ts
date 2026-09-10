/**
 * =============================================================================
 * Proxy — Supabase session refresh.
 * =============================================================================
 *
 * NOTE THE FILENAME. In Next.js 16 the `middleware` convention was renamed to
 * `proxy`, and the exported function with it: `middleware.ts` still works but is
 * deprecated, and every `@supabase/ssr` guide you will find online still writes
 * `middleware.ts` / `export function middleware`. This file is the Next 16
 * spelling of exactly that pattern. See
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`.
 *
 * -----------------------------------------------------------------------------
 * What this is for
 * -----------------------------------------------------------------------------
 * A Supabase access token is short-lived. Refreshing it produces a NEW cookie
 * pair that has to be written to the response — and Next.js permits a cookie
 * write only from a Server Action, a Route Handler, or here. A Server Component
 * cannot do it, which is why `serverClient.ts` swallows the failure when it
 * tries.
 *
 * So this is the other half of that arrangement, and it is not optional:
 * without it the refreshed token is computed during a render, discarded, and
 * recomputed on the next request until the refresh token itself expires — at
 * which point the user is signed out mid-session for no visible reason.
 * `@supabase/ssr` calls this out as the cause of "random logouts, early session
 * termination, JSON parsing errors, increased refresh token requests".
 *
 * `supabase.auth.getUser()` is the call that performs the refresh. It looks
 * like a read and is not: it validates the access token against the auth server
 * and, when it has expired, exchanges the refresh token and hands the new pair
 * to `setAll` below. Removing the call because "nothing uses the result" breaks
 * refresh entirely.
 *
 * -----------------------------------------------------------------------------
 * This proxy authorizes NOTHING
 * -----------------------------------------------------------------------------
 * It refreshes a session and gets out of the way. Every access decision is made
 * by Postgres — the RLS policies in `supabase/migrations/0002_rls.sql` — and,
 * for the mock backend, by `mockClient.ts`.
 *
 * That is deliberate, and the Next.js docs make the case in the Execution-order
 * section of the page cited above: Server Functions are POSTs to the route they
 * are declared in, not routes of their own, so a matcher that stops covering a
 * path silently stops covering every server action on it. An authorization
 * check that can be switched off by editing a regex is not an authorization
 * check. Nothing here is load-bearing for security, and nothing here should
 * become load-bearing for it.
 *
 * The one thing here that IS load-bearing — for a different property — is the
 * Content-Security-Policy below, which needs a per-request nonce and therefore
 * cannot live in `next.config.ts`. See {@link contentSecurityPolicy}.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { dataBackend, requireSupabaseConfig, supabaseUrl } from '@/lib/env';

export async function proxy(request: NextRequest) {
  /*
   * 128 bits, fresh per request. `crypto` and `btoa` are both in the Edge
   * runtime's global scope, so this needs no import and no `Buffer` polyfill.
   *
   * The value has to satisfy Next's own nonce regex —
   * `/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/` in
   * `next/dist/server/app-render/get-script-nonce-from-header.js` — which
   * standard base64 does.
   */
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const csp = contentSecurityPolicy(nonce);

  /**
   * A `NextResponse.next()` carrying the policy on the REQUEST as well as the
   * response, which is what makes the nonce reach the framework's own scripts.
   *
   * Next reads the CSP off the *incoming request headers* during render and
   * attaches the nonce it finds to every script it emits. Setting the header
   * only on the response would ship a policy that forbids inline scripts to a
   * page whose inline scripts carry no nonce — a blank page, every time.
   *
   * Rebuilt rather than mutated in place because `request.headers` is not
   * writable here, and rebuilt LATE — after any `request.cookies.set()` — for a
   * reason that is easy to miss: `RequestCookies.set()` writes the whole jar
   * back into the request's `cookie` header (see the `_headers.set('cookie',
   * ...)` line in `@edge-runtime/cookies`), so a `Headers` copy taken before the
   * refresh would pin the STALE token and undo the cookie half of this proxy.
   */
  const nextWithPolicy = (): NextResponse => {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('content-security-policy', csp);

    const next = NextResponse.next({ request: { headers: requestHeaders } });
    next.headers.set('content-security-policy', csp);
    return next;
  };

  // The mock backend has no tokens to refresh; its cookie is verified in
  // `session.ts` and never rotates. It still gets the policy — the visual suite
  // runs against this backend, so a policy applied only on Supabase would be a
  // policy nothing ever exercises in a browser.
  if (dataBackend() !== 'supabase') return nextWithPolicy();

  const { url, anonKey } = requireSupabaseConfig();

  let response = nextWithPolicy();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Both halves are needed and they are not redundant.
        //
        // Writing to `request.cookies` makes the refreshed token visible to the
        // render that happens AFTER this proxy returns — otherwise the page
        // would run against the stale token this request arrived with, and
        // `auth.uid()` would be null in Postgres for one request after every
        // refresh, logging the user out at random.
        //
        // Rebuilding the response from the mutated request and then writing to
        // `response.cookies` is what sends the new pair to the BROWSER, so the
        // next request already carries it.
        //
        // Rebuilt through `nextWithPolicy` rather than `NextResponse.next` so
        // the rebuild does not silently discard the CSP — a plain
        // `NextResponse.next({ request })` here would drop both the response
        // header and the request header the nonce is read from, and it would do
        // it only on the requests where a token happened to be refreshed. That
        // is a policy that works until it intermittently does not.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = nextWithPolicy();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Performs the refresh. Not a read — see the header.
  await supabase.auth.getUser();

  return response;
}

/**
 * =============================================================================
 * The Content-Security-Policy, and why it lives here rather than in the config.
 * =============================================================================
 *
 * `next.config.ts` carried four directives — `frame-ancestors`, `base-uri`,
 * `form-action`, `object-src` — and a long note saying the `script-src` half
 * needed a per-request nonce, which a static `headers()` entry cannot mint. It
 * also wrote down the order the rollout had to go in, and step 1 was "move these
 * headers into `src/proxy.ts`". This is that move, for the CSP only: the other
 * five headers stay in the config, because they are static and because
 * `headers()` covers paths this proxy's matcher deliberately excludes.
 *
 * WHY THE REPORT-ONLY STEP WAS SKIPPED. The old note is right that Next reads
 * the enforcing header first and only falls back to the report-only one, so a
 * report-only `script-src` sitting beside an enforcing policy that has none
 * would report every framework script as a violation — noise, not a
 * measurement. The way out of that ordering is not to measure first but to
 * enforce a policy the framework is *participating* in: once `script-src`
 * carries a nonce, Next attaches that nonce to every script it emits, and the
 * only scripts left to break are ones this app does not have. It has no
 * executable inline script, no `next/script` and no third-party tag; the one
 * `dangerouslySetInnerHTML` in `src/` is the JSON-LD data block in
 * `components/json-ld.tsx`, which is not executed, is escaped at the point it
 * is written, and carries the nonce anyway. Verified by grep, and then verified
 * again in a real browser.
 *
 * -----------------------------------------------------------------------------
 * The directives, and the two that carry a trap
 * -----------------------------------------------------------------------------
 *   default-src 'self'      the backstop. Everything not named below — media,
 *                           workers, manifests, frames — resolves to this.
 *
 *   script-src              'self' plus the nonce plus `'strict-dynamic'`.
 *                           `'strict-dynamic'` is what lets the nonce'd
 *                           bootstrap load the chunk graph: a script trusted by
 *                           nonce may load further scripts, and host-based
 *                           allowances are then ignored. It is the shape the
 *                           Next CSP guide recommends and the reason a
 *                           chunk-by-chunk allow-list is not needed.
 *
 *   style-src               'self' AND `'unsafe-inline'`, deliberately, and NOT
 *                           a nonce. `next/font` emits an inline `<style>` and
 *                           React writes inline `style` attributes; a nonce in
 *                           this directive would make browsers IGNORE
 *                           `'unsafe-inline'` — the trap is that adding the
 *                           stronger-looking source is what breaks the page.
 *                           What it still buys: no stylesheet from another
 *                           origin can be injected.
 *
 *   img-src                 'self', `data:`, `blob:` and the Supabase project
 *                           origin, which is where avatars are served from.
 *                           Omitting the last one blanks every card in the
 *                           directory — the exact failure `next.config.ts`
 *                           predicted when it declined to write an `img-src`.
 *
 *   font-src 'self'         `next/font` self-hosts every face out of
 *                           `_next/static`. Nothing is fetched from Google at
 *                           runtime, so this needs no host.
 *
 *   connect-src             'self', plus websockets in development for HMR.
 *                           There is no browser Supabase client in `src/` — the
 *                           data layer is server-side only — so the browser
 *                           never calls the API directly.
 *
 * TWO TRAPS FOR WHOEVER ADDS CHECKOUT, both of which this file is choosing to
 * accept rather than pre-empt with a guess:
 *
 *   1. `frame-src` is not named, so it now falls back to `default-src 'self'`.
 *      Stripe's checkout and 3-D Secure are iframes on Stripe's origins and will
 *      be blocked until it is named. This is the trade the old comment worried
 *      about, taken the other way round: the failure is a blank iframe on the
 *      first test of a payment flow, which is loud, immediate and traceable to
 *      this line — where a missing `default-src` is a class of injection nobody
 *      notices at all.
 *   2. `script-src` will need `https://js.stripe.com`, which under
 *      `'strict-dynamic'` means loading it FROM a nonce'd script rather than
 *      adding the host.
 *
 * DELIBERATELY ABSENT: `upgrade-insecure-requests`. It would rewrite every
 * `http://` subresource to `https://`, which is right in production and breaks
 * `http://localhost:3000` — and HSTS, already sent from `next.config.ts`,
 * covers the production case without a development cost.
 */
function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV === 'development';

  /*
   * The storage origin, derived from the configured project URL rather than
   * written down: two of them would drift, and the one that drifts silently is
   * the copy. `null` when unset — which is the mock backend, where there is no
   * storage and no avatar to load.
   */
  let storageOrigin = '';
  const configured = supabaseUrl();
  if (configured !== null) {
    try {
      storageOrigin = ` ${new URL(configured).origin}`;
    } catch {
      // A malformed URL is `requireSupabaseConfig()`'s problem to report, not
      // this function's. An img-src one host short is better than a 500 here.
    }
  }

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${storageOrigin}`,
    "font-src 'self'",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const config = {
  matcher: [
    /*
     * Everything except the paths that cannot carry a session and would only
     * pay the cost of this proxy:
     *   - _next/static, _next/image  framework assets
     *   - favicon / image / manifest files in public/
     *
     * Must stay a literal: the docs require matcher values to be statically
     * analysable at build time, and a computed one is silently ignored — which
     * would quietly apply this to every static asset instead of failing.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest)$).*)',
  ],
};
