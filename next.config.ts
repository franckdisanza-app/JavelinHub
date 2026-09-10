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
 * WHY `permanent: true` (308), AND WHY IT WAS NOT ALWAYS:
 * the move IS permanent in intent, and 308 is the honest status for a renamed
 * canonical URL. It was held at 307 while nothing was deployed or indexed,
 * because a 308 is cached by the browser indefinitely: it makes the redirect
 * unobservable on a second page load, so a reviewer cannot re-verify it without
 * clearing browser state, and it would strand any developer who later serves
 * something else at these paths. That comment ended by saying to flip it "in the
 * commit that first deploys the app publicly", which has happened — so it is
 * flipped, and the two costs above are now the accepted price of not splitting
 * the ranking signal between the old paths and the new ones.
 */
/**
 * =============================================================================
 * Response headers.
 * =============================================================================
 *
 * There were none, which on a site carrying an irreversible "delete my account"
 * form and an administrator suspension console is the gap worth closing first:
 * nothing stopped either page being framed by another origin.
 *
 * WHERE THE CSP WENT: `src/proxy.ts`.
 * This file used to carry four directives — `frame-ancestors`, `base-uri`,
 * `form-action`, `object-src` — with a note saying the `script-src` half needed
 * a per-request nonce that a static `headers()` entry cannot mint, and setting
 * out the order the rollout had to go in. Step 1 of that order was "move these
 * headers into `src/proxy.ts`", and it has been done: the whole policy is now
 * built per request in `contentSecurityPolicy()` there, including the four that
 * used to be here, so there is exactly one place a directive is written.
 *
 * The rest of the headers below stay, and are NOT a leftover. They are static
 * by nature, and `headers()` matches `/:path*` — every path, including the
 * `_next/static` and image routes the proxy's matcher deliberately excludes.
 * A `nosniff` that stops applying to a served file is worse than useless.
 *
 * `Strict-Transport-Security` carries no `preload`. Preloading is a commitment
 * that is slow and awkward to reverse, and it belongs to whoever owns the
 * apex domain rather than to this config file. Browsers ignore the header over
 * plain HTTP, so local development is unaffected.
 *
 * `Permissions-Policy` denies the three capabilities this product has no use
 * for. `payment` is deliberately NOT denied: Stripe is on the roadmap and the
 * Payment Request API needs it, so denying it here would be a trap for the
 * commit that adds checkout.
 */
const SECURITY_HEADERS = [
  // No Content-Security-Policy here. It is per-request now and lives in
  // `src/proxy.ts` — a second, static one written beside it would be enforced
  // as well as the real one, and the intersection of two policies is the kind
  // of thing that breaks a page for a reason nobody can find.
  { key: "X-Frame-Options", value: "DENY" },
  // Stops a browser second-guessing a Content-Type. It matters most for the
  // files this app hands back from storage, where the type is whatever the
  // uploader declared.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Full URL to our own origin, origin only when crossing to another, nothing
  // at all when downgrading. Offer and coach URLs carry ids, and a signed
  // storage URL carries a token.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // `X-Powered-By: Next.js` on every response names the framework and its
  // presence to anyone scanning. It buys nothing.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  turbopack: {
    // Pin the workspace root to this project. Without it Turbopack walks up
    // looking for a lockfile, finds the stray package-lock.json in the user's
    // home directory, and warns that it is ignoring it because tracing that
    // root would pull in the entire home directory.
    root: path.resolve(import.meta.dirname),
  },
  async redirects() {
    return [
      { source: "/browse", destination: "/offers", permanent: true },
      // `/listings/new` is listed BEFORE `/listings/:id` for readability only:
      // the `:id` rule below would already send it to `/offers/new`, since
      // `new` is a legal `:id` match and Next resolves the static
      // `/offers/new` segment ahead of the dynamic one. Stating it explicitly
      // means the intent survives a future change to either route's shape.
      { source: "/listings/new", destination: "/offers/new", permanent: true },
      // Single segment, deliberately: `/listings/:id` matches `/listings/abc`
      // and NOT `/listings/a/b`, which has never been a route here. The leading
      // slash before the colon is required — without it path-to-regexp treats
      // the pattern as a literal and can loop.
      { source: "/listings/:id", destination: "/offers/:id", permanent: true },
    ];
  },
};

export default nextConfig;
