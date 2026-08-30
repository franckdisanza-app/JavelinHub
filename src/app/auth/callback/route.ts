import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';

import { redeemPasswordResetLink, RESET_PASSWORD_PATH } from '@/lib/auth/password-reset';
import { safeNextPath } from '@/lib/auth/session';

/**
 * Where a password-reset link lands.
 *
 * A ROUTE HANDLER RATHER THAN A PAGE, and that is forced rather than chosen:
 * redeeming the link writes a session cookie, and Next.js permits a cookie
 * write only from a Server Action, a Route Handler, or the proxy. A Server
 * Component cannot do it — see `src/proxy.ts`.
 *
 * A GET THAT MUTATES, which this app otherwise refuses to write (`logoutAction`
 * has the note about why). The exception is deliberate and is forced by the
 * medium: an email client can only offer a link, and the recipient can only
 * click it. The mitigations are on the token instead — single-use, one hour,
 * hashed at rest, and superseded by any newer request — so the damage a
 * prefetcher or a scanner can do is to burn one link, after which the user asks
 * for another. See `password-reset.ts`.
 *
 * ONE FAILURE ANSWER for every way a link can be bad: absent, malformed,
 * expired, already spent, or not ours. The user is sent back to the request
 * form with a sentence telling them to ask for a new one, and a stranger
 * holding a stale link learns nothing about whether it was ever real.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const redeemed = await redeemPasswordResetLink(params);
  if (!redeemed) redirect('/forgot-password?link=expired');

  /*
   * `?next=` is honoured, and it goes through the same `safeNextPath` the login
   * form's does — parsed against a throwaway origin and rebuilt from the parsed
   * parts, never pattern-matched. It matters more here than there: this URL is
   * emailed, so an unchecked value would make a link WE SENT redirect somewhere
   * else, with a freshly created session already in the browser.
   *
   * GoTrue does not forward extra query parameters through its own `/verify`
   * redirect, so on Supabase this is normally absent and the default applies.
   * It is honoured anyway rather than ignored, so the two backends behave the
   * same when it is present.
   */
  const next = safeNextPath(params.get('next')) ?? RESET_PASSWORD_PATH;
  redirect(next);
}
