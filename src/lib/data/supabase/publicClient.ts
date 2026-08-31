/**
 * =============================================================================
 * The cookie-free Supabase client, for reads that are the same for everybody.
 * =============================================================================
 *
 * `serverClient.ts` builds a client from the request's cookies, so Postgres sees
 * the visitor's JWT and `auth.uid()` is the actor. That is the right client for
 * almost everything here, and it has one property that rules it out of the
 * thing this file exists for:
 *
 *     **it reads `cookies()`, and a `use cache` scope may not.**
 *
 * The restriction follows the call stack — a helper the cached function calls
 * that touches `cookies()` fails the same way, with `next-request-in-use-cache`
 * — so a cached browse page cannot reach the data layer at all while every read
 * goes through the cookie client. Worse, on a dynamically rendered route the
 * failure only appears when the route runs, so it passes `next build` and
 * breaks under `next start`.
 *
 * This client takes no session, reads no cookies, and can therefore be called
 * from inside `use cache`.
 *
 * -----------------------------------------------------------------------------
 * WHAT MAY USE IT, AND WHY THE LIST IS SHORT
 * -----------------------------------------------------------------------------
 * Requests through this client arrive at Postgres as `anon`. Every RLS policy is
 * still enforced — this is the publishable key, not the service role, and there
 * is still no service-role client anywhere under `src/` — but the policies are
 * evaluated for a caller with no identity.
 *
 * So this is ONLY for reads whose answer is identical for an anonymous visitor
 * and for every signed-in user. In practice that is the public surface, and each
 * one is public for a reason that is written into the schema rather than into a
 * comment:
 *
 *   * `listings`, read with an explicit `deleted_at is null` — the same
 *     predicate `listings_select_public` applies, so a coach's own withdrawn
 *     offers were never in this result even when the read carried their JWT.
 *   * `public_coaches`, `public_profiles`, `public_listing_reviews`,
 *     `public_coach_reviews`, `offer_stats`, `coach_stats` — views granted to
 *     `anon` and `authenticated` alike, each carrying its own predicate INSIDE
 *     the view so that no caller can widen it.
 *
 * **Do not reach for this client to make something else cacheable.** A read that
 * returns more to a signed-in user than to a stranger — `owned_listings`,
 * `orders`, `reports`, anything behind `profiles_select_admin` — would come back
 * empty here rather than refused, and an empty list is what "you have nothing"
 * looks like. That failure mode is silent, which is exactly why the boundary is
 * a separate module with this comment on it instead of a flag on the old one.
 *
 * -----------------------------------------------------------------------------
 * WHY A MODULE SINGLETON IS SAFE HERE AND FORBIDDEN THERE
 * -----------------------------------------------------------------------------
 * `serverClient.ts` says a server client must never be shared between requests,
 * because it holds the first visitor's tokens and would hand them to everybody
 * afterwards. That reasoning is entirely about the session — and this client has
 * none: `persistSession` and `autoRefreshToken` are off, there is no cookie
 * adapter, and nothing about a request can attach to it. Sharing one instance is
 * therefore not merely allowed but preferable, since building a client per call
 * inside a cached function would be work done on every cache miss for no reason.
 *
 * SERVER ONLY, like its sibling — not because it holds a secret (the
 * publishable key is in the browser bundle already) but because the data layer
 * around it is.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { requireSupabaseConfig } from '@/lib/env';

if (typeof window !== 'undefined') {
  throw new Error(
    'The public Supabase client is server-only and was imported into browser code. ' +
      'Call it from a server component, server action or route handler instead.',
  );
}

let client: SupabaseClient | null = null;

/**
 * The shared anonymous client.
 *
 * -----------------------------------------------------------------------------
 * WHY `createClient` IS IMPORTED HERE AND NOT AT MODULE SCOPE
 * -----------------------------------------------------------------------------
 * The same reason `serverClient.ts` defers `next/headers`, and it fails in the
 * same place. `src/lib/data/index.ts` imports `SupabaseDataClient`
 * unconditionally so that `getDataClient()` can stay synchronous, which puts
 * this module in the graph even when `DATA_BACKEND=mock` — and
 * `scripts/verify-authz.mts` loads that graph through plain Node, where
 * `@supabase/supabase-js` pulls in an `.mjs` under `node_modules` that Node's
 * type stripper refuses to touch (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
 * A module-scope import therefore takes down the whole authorization suite on a
 * module the mock never uses.
 *
 * The type import above stays: it is erased before Node ever sees it.
 *
 * Async is a consequence of that, not a requirement of the client — there are
 * still no cookies to read. The dynamic import is cached by the module system,
 * so the cost is one already-resolved promise per call.
 */
export async function publicSupabase(): Promise<SupabaseClient> {
  if (client) return client;

  const { createClient } = await import('@supabase/supabase-js');
  const { url, anonKey } = requireSupabaseConfig();
  client = createClient(url, anonKey, {
    auth: {
      // All three off, and each one for the same reason: this client must never
      // acquire a session. `persistSession` would look for a storage adapter,
      // `autoRefreshToken` would start a timer in a server process, and
      // `detectSessionInUrl` is a browser concern that has no meaning here.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return client;
}
