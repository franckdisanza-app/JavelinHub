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
/**
 * =============================================================================
 * Response headers.
 * =============================================================================
 *
 * There were none, which on a site carrying an irreversible "delete my account"
 * form and an administrator suspension console is the gap worth closing first:
 * nothing stopped either page being framed by another origin.
 *
 * WHY THE CSP IS FOUR DIRECTIVES AND NOT A POLICY:
 * a real `default-src` / `script-src` policy needs per-request nonces, because
 * Next injects inline bootstrap scripts and `next/font` injects inline styles.
 * That is a measured rollout behind `Content-Security-Policy-Report-Only` and a
 * report endpoint, and shipping a guessed one breaks the site on the first
 * render. The four below need no nonce, restrict nothing the app does, and are
 * each worth having on their own:
 *
 *   frame-ancestors 'none'  nobody may frame us. The modern spelling of
 *                           X-Frame-Options, which is sent alongside it for
 *                           older browsers that only understand that one.
 *   base-uri 'self'         an injected <base> cannot re-point every relative
 *                           URL on the page at another origin.
 *   form-action 'self'      a form cannot be made to POST somewhere else.
 *                           Every form here is a Server Action against its own
 *                           route, so this costs nothing.
 *   object-src 'none'       no <object>, <embed> or <applet>. There are none in
 *                           `src/` — grep for them — and there is no plausible
 *                           future in which this product grows one, so this is
 *                           a whole class of legacy plugin injection closed for
 *                           free. It does NOT fall back to `default-src`, so it
 *                           has to be named to exist.
 *
 * DELIBERATELY NOT ADDED: `frame-src 'none'`. Nothing embeds an iframe today
 * either, but Stripe's checkout and 3-D Secure do, and this file already
 * declines to deny `payment` in `Permissions-Policy` for exactly that reason —
 * see below. A directive that is free today and a silent breakage on the commit
 * that adds checkout is not free.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE `script-src` ROLLOUT IS ACTUALLY BLOCKED ON — verified, not guessed
 * -----------------------------------------------------------------------------
 * "Behind `Content-Security-Policy-Report-Only`" is the right plan and it does
 * not work from a standing start, because of an ordering in Next itself that is
 * easy to discover the expensive way:
 *
 *   `next/dist/server/app-render/app-render.js`
 *     const csp = headers['content-security-policy']
 *              || headers['content-security-policy-report-only'];
 *
 *   `next/dist/server/app-render/get-script-nonce-from-header.js`
 *     directives.find(d => d.startsWith('script-src'))
 *     || directives.find(d => d.startsWith('default-src'))
 *
 * So Next reads the ENFORCING header first, and only looks at the report-only
 * one when the enforcing header is absent. The policy above is present and has
 * no `script-src` and no `default-src` — so no nonce is ever extracted, no
 * nonce is attached to any framework script, and a report-only `script-src`
 * added beside it would report *every* Next bootstrap script as a violation.
 * That is not a measurement, it is noise that hides the one real finding.
 *
 * The rollout therefore has to go in this order, and each step is verifiable
 * before the next:
 *
 *   1. Move these headers into `src/proxy.ts`, which is where a per-request
 *      nonce can be minted. `headers()` here is static by definition.
 *   2. Put `script-src` WITH the nonce into the enforcing header, permissive
 *      enough to enforce nothing new, so that Next starts attaching the nonce.
 *   3. Only then add the strict report-only policy and a report endpoint, and
 *      read what comes back for a while.
 *   4. Tighten the enforcing header to match, one directive at a time.
 *
 * Two facts that make step 2 cheaper than it sounds, both measured here: the
 * app contains no inline `<script>`, no `dangerouslySetInnerHTML` and no
 * `next/script`, so the only inline scripts on any page are Next's own; and
 * every route already builds as `ƒ (Dynamic)`, so the "nonces disable static
 * optimization" cost the Next docs warn about has already been paid.
 *
 * CSP directives do NOT fall back to `default-src`, so naming only these three
 * leaves images, fonts and scripts unrestricted — which is deliberate: avatars
 * are served from the Supabase storage origin and an `img-src` written without
 * it would blank every card in the directory.
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
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
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
