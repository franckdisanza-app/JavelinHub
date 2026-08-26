import path from "node:path";

import type { NextConfig } from "next";

/**
 * The route move, and the one thing about it that is not obvious.
 *
 * `/browse` -> `/offers`, `/listings/[id]` -> `/offers/[id]`,
 * `/listings/new` -> `/offers/new`. The internal model is still called
 * `listing` — the type, the table, the RLS policies and a 561-assertion suite
 * are security-critical, and renaming them buys nothing a user sees. Only the
 * URLs and the copy say "offer".
 *
 * WHY `redirects()` AND NOT A PAGE THAT CALLS `redirect()`:
 * a `redirects()` entry is matched BEFORE the filesystem and, crucially,
 * "any query values provided in the request will be passed through to the
 * redirect destination" — so `?q=` and `?category=` survive for free and
 * cannot be forgotten at one of the three call sites. A hand-written
 * `redirect()` page would have to re-encode the query string itself, which is
 * untrusted input being turned back into a Location header; not doing that by
 * hand is the whole point.
 *
 * WHY `permanent: false` (307) AND NOT 308:
 * the move IS permanent in intent, and 308 is the honest status for a renamed
 * canonical URL — but a 308 is cached by the browser indefinitely, and nothing
 * here is deployed or indexed yet. Two costs that matter more today than SEO
 * does: a cached 308 makes the redirect unobservable on a second page load, so
 * a reviewer cannot re-verify it without clearing browser state, and it would
 * strand any developer who later serves something else at these paths. Flip
 * this to `true` in the commit that first deploys the app publicly.
 */
const nextConfig: NextConfig = {
  turbopack: {
    // Pin the workspace root to this project. Without it Turbopack walks up
    // looking for a lockfile, finds the stray package-lock.json in the user's
    // home directory, and warns that it is ignoring it because tracing that
    // root would pull in the entire home directory.
    root: path.resolve(import.meta.dirname),
  },
  async redirects() {
    return [
      { source: "/browse", destination: "/offers", permanent: false },
      // `/listings/new` is listed BEFORE `/listings/:id` for readability only:
      // the `:id` rule below would already send it to `/offers/new`, since
      // `new` is a legal `:id` match and Next resolves the static
      // `/offers/new` segment ahead of the dynamic one. Stating it explicitly
      // means the intent survives a future change to either route's shape.
      { source: "/listings/new", destination: "/offers/new", permanent: false },
      // Single segment, deliberately: `/listings/:id` matches `/listings/abc`
      // and NOT `/listings/a/b`, which has never been a route here. The leading
      // slash before the colon is required — without it path-to-regexp treats
      // the pattern as a literal and can loop.
      { source: "/listings/:id", destination: "/offers/:id", permanent: false },
    ];
  },
};

export default nextConfig;
