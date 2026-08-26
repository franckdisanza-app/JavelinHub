/**
 * =============================================================================
 * The request-scoped Supabase client.
 * =============================================================================
 *
 * `supabase/README.md` puts the rule this file exists to enforce in one line:
 *
 *   > The `Actor` argument becomes "which Supabase client do I build" — a
 *   > request-scoped client carrying the user's JWT, so that `auth.uid()`
 *   > inside Postgres is the actor. **Do not** use the service-role key for
 *   > user operations; that bypasses RLS and throws away the entire model.
 *
 * So there is exactly one client factory for application traffic, it reads the
 * anon/publishable key, and it takes its session from the request's cookies.
 * There is no service-role client anywhere in `src/` — see the note at the
 * bottom of this file.
 *
 * -----------------------------------------------------------------------------
 * Never share a client between requests
 * -----------------------------------------------------------------------------
 * `@supabase/ssr` is explicit that a server client must be built per render.
 * A cached client would hold the first visitor's tokens and hand them to every
 * later request — one user's session serving another user's page. That is why
 * this is a function and why `SupabaseDataClient` calls it inside each method
 * rather than holding one in a field.
 *
 * `cookies()` is itself request-scoped in Next.js, so the *client factory*
 * being reachable from a module singleton is fine; what must not be reused is
 * the client it returns.
 *
 * SERVER ONLY.
 */

import { createServerClient } from '@supabase/ssr';

import { requireSupabaseConfig } from '@/lib/env';

if (typeof window !== 'undefined') {
  throw new Error(
    'The Supabase server client is server-only and was imported into browser code. ' +
      'Call it from a server component, server action or route handler instead.',
  );
}

/**
 * Builds a Supabase client bound to the current request's cookies.
 *
 * -----------------------------------------------------------------------------
 * Why `setAll` is wrapped in try/catch
 * -----------------------------------------------------------------------------
 * Next.js allows a cookie write only from a Server Action or a Route Handler.
 * A Server Component that renders while the access token happens to be expired
 * will make `supabase-js` refresh it and try to persist the new pair — and
 * `cookieStore.set()` throws there. That throw is not a failure worth
 * propagating: the refreshed token still works for the current render, and
 * `src/proxy.ts` refreshes the cookie pair on the way in on the *next* request
 * anyway. Swallowing it here and refreshing there is the documented
 * `@supabase/ssr` arrangement — omitting the proxy half is what turns it into
 * the random-logout bug the library warns about.
 */
export async function createSupabaseServerClient() {
  const { url, anonKey } = requireSupabaseConfig();

  // `next/headers` is imported HERE, not at module scope, and the reason is not
  // stylistic. `src/lib/data/index.ts` imports `SupabaseDataClient`
  // unconditionally so that `getDataClient()` can stay synchronous — which
  // means this module is in the graph even when `DATA_BACKEND=mock`.
  //
  // `scripts/verify-authz.mts` runs the mock through plain Node, outside the
  // Next.js bundler, where `next/headers` does not resolve. A module-scope
  // import of it therefore broke the entire authorization suite the moment the
  // Supabase client was registered — 758 assertions failing on a module the
  // mock never uses. Deferring it to call time keeps the graph loadable
  // everywhere and costs one cached dynamic import on a code path that is
  // already async.
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component render — see the note above.
        }
      },
    },
  });
}

/**
 * The authenticated user's id, or `null`.
 *
 * Uses `auth.getUser()`, **not** `auth.getSession()`, and the difference is a
 * security boundary rather than a preference. `getSession()` decodes whatever
 * JWT is sitting in the cookie and believes it; the cookie is attacker-supplied
 * data on every request. `getUser()` validates it against the auth server, so
 * a hand-crafted or expired token resolves to nobody.
 *
 * Never throws. A malformed or expired cookie makes the request anonymous — the
 * same contract `decodeSessionCookie()` has on the mock side, and for the same
 * reason: a stale cookie must not be able to 500 the site.
 */
export async function getSupabaseUserId(): Promise<string | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// On the service-role key, which this file deliberately does not use.
//
// `SUPABASE_SERVICE_ROLE_KEY` is still read by `src/lib/env.ts` because two
// operations genuinely need it and neither is a request:
//
//   * `public.grant_admin(uuid)` — bootstrapping the first administrator, which
//     `supabase/README.md` documents as an SQL-editor/psql operation precisely
//     so that no code path in the app can promote anyone.
//   * applying migrations and seeds.
//
// Both are operator tasks, run from a terminal. Nothing under `src/` should
// ever build a client from that key: it sets `role = service_role`, which is
// `BYPASSRLS`, so every policy in `0002_rls.sql` stops being consulted and the
// authorization model documented in `docs/DATA-LAYER.md` silently evaporates —
// with no error and no visible change in the rendered page.
// ---------------------------------------------------------------------------
