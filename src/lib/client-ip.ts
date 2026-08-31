/**
 * The calling client's IP, read from proxy headers.
 *
 * **ITS OWN MODULE FOR ONE REASON**, and it is the same one that split
 * `reset-tokens.ts` out of `password-reset.ts`: this needs `next/headers`,
 * which does not resolve outside the Next runtime at all — a plain Node script
 * importing it dies with `ERR_MODULE_NOT_FOUND`. Keeping it here leaves
 * `rate-limit.ts` free of any framework import, so `scripts/verify-authz.mts`
 * can exercise the counting rules that actually matter.
 *
 * **IT IS NOT TRUSTWORTHY AND MUST NEVER BE TREATED AS IF IT WERE.** Both
 * headers below are attacker-controlled unless something in front of the app
 * overwrites them. Vercel does; a bare `next start` behind nothing does not. So
 * an IP-keyed rate limit is a speed bump on top of a speed bump — worth having,
 * because it is what stops one caller varying the email address to bypass a
 * per-address limit, and never worth basing an authorization decision on.
 *
 * SERVER ONLY.
 */

import { headers } from 'next/headers';

/**
 * The caller's IP, or `null` when nothing in front of the app reports one.
 *
 * `null` is not an error and must not become one. Locally there is no proxy, so
 * every request would share a single bucket and the per-IP limits would collapse
 * into one global budget — locking a developer out of their own login form after
 * five attempts. `null` therefore means "do not apply an IP limit"; the
 * per-address limits still apply.
 */
export async function clientIp(): Promise<string | null> {
  try {
    const store = await headers();

    // `x-real-ip` first: where it is set at all it is set by the proxy, whereas
    // `x-forwarded-for` is a LIST a client can prepend to. Vercel sets both.
    const real = store.get('x-real-ip')?.trim();
    if (real) return real;

    const forwarded = store.get('x-forwarded-for');
    if (!forwarded) return null;
    // The leftmost entry is the original client by convention — and is also the
    // one a client can forge when no proxy overwrites the header. See the
    // header: this is a speed bump, and treating it as one is the whole posture.
    const first = forwarded.split(',')[0]?.trim();
    return first && first !== '' ? first : null;
  } catch {
    // `headers()` throws outside a request scope. Nothing that calls this should
    // be running there, but a rate limiter must not be what breaks a request.
    return null;
  }
}
