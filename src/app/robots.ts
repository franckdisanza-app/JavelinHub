import type { MetadataRoute } from 'next';

import { siteUrl } from '@/lib/env';

/**
 * =============================================================================
 * What a crawler may look at.
 * =============================================================================
 *
 * There was no `robots.txt` at all, which means the default — crawl everything.
 * Most of this site should be crawled: a marketplace whose offers and coaches
 * cannot be found is not doing its job, and `sitemap.ts` beside this file
 * exists to help. The disallow list is the other half.
 *
 * WHAT IS EXCLUDED, AND WHY EACH ONE:
 *
 *   /admin      the review queue, the reports queue, the coach console. It is
 *               already invisible — `requireAdmin()` answers a signed-in
 *               non-admin with `notFound()` rather than a 403, precisely so the
 *               area's existence is not confirmed. Publishing the paths in a
 *               file served at a well-known URL would undo that for free.
 *   /settings   the account page, including the delete-account form.
 *   /orders     one order, naming a buyer, a seller and a file.
 *   /purchases  a purchase history.
 *   /coach      the seller's own dashboard and editor.
 *   /redeem     an invite-code form. Nothing to index and a thing to hammer.
 *   /auth       the callback that redeems an emailed link. A crawler following
 *               one would burn a single-use token — the reset flow is built to
 *               survive that (the user asks for another), but there is no
 *               reason to invite it.
 *   /login, /signup, /forgot-password, /reset-password
 *               no content, and `/reset-password` only means anything to
 *               somebody holding a live session from a link.
 *
 * Every one of those is behind a real check as well — this file is a courtesy
 * to well-behaved crawlers, never a boundary. A `robots.txt` that is doing
 * security work is a `robots.txt` describing a vulnerability.
 *
 * `force-dynamic` because `siteUrl()` throws in production when
 * `NEXT_PUBLIC_SITE_URL` is unset, and a build must not be the thing that asks.
 * The answer is a few hundred bytes and costs nothing to produce per request.
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const origin = siteUrl();

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          // `/api/health` is the only route under it today. Nothing to index,
          // and a crawler hitting it on a schedule is a database read per hit.
          '/api',
          '/admin',
          '/settings',
          '/orders',
          '/purchases',
          '/coach',
          '/redeem',
          '/auth',
          '/login',
          '/signup',
          '/forgot-password',
          '/reset-password',
          // NOTE: `/legal/*` is deliberately absent — terms, privacy and the
          // refund policy are meant to be found, and Stripe checks they are
          // reachable during Connect onboarding. While `src/lib/legal.ts` still
          // has gaps each of those pages sets its own `robots: { index: false }`
          // in metadata, which is the right instrument: the condition is
          // computed, and this file is a static list.
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
