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
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { dataBackend, requireSupabaseConfig } from '@/lib/env';

export async function proxy(request: NextRequest) {
  // The mock backend has no tokens to refresh; its cookie is verified in
  // `session.ts` and never rotates.
  if (dataBackend() !== 'supabase') return NextResponse.next({ request });

  const { url, anonKey } = requireSupabaseConfig();

  let response = NextResponse.next({ request });

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
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
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
