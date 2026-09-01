import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';

import { RESET_PASSWORD_PATH } from '@/lib/auth/paths';
import { redeemPasswordResetLink } from '@/lib/auth/password-reset';
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
   * GoTrue does not reliably forward extra query parameters through its own
   * `/verify` redirect, so on Supabase this is often absent and the default
   * below applies. It is honoured when present so the two backends behave the
   * same.
   */
  const next = safeNextPath(params.get('next')) ?? defaultDestination(params.get('type'));
  redirect(next);
}

/**
 * Where a link lands when it carried no `?next=`.
 *
 * ONE ROUTE, FOUR ERRANDS. Password reset, signup confirmation, an email change
 * and a magic link all come back here, and until now they all defaulted to the
 * password-reset form — so somebody who had just confirmed their email address
 * for the first time was greeted by a page asking them to choose a NEW
 * password. For the first screen a new account ever sees, that is the wrong
 * half of the trade the shared default was making.
 *
 * GoTrue names the errand in `type` on the redirect it sends. When it says so,
 * this believes it. When it does not — the parameter is absent, or a value
 * arrives that this does not recognise — the answer stays what it has always
 * been, and that conservatism is deliberate rather than laziness: of the four,
 * recovery is the only one whose user CANNOT get where they are going by any
 * other route. A confirming signup that lands on the wrong page is already
 * signed in and one click from anywhere; a locked-out user sent to `/offers`
 * has lost the only door they had.
 *
 * `type` is untrusted input like everything else in this URL, so it is matched
 * against a closed set and never interpolated into the path.
 */
function defaultDestination(type: string | null): string {
  switch (type) {
    case 'signup':
      // Matches the `?next=` that `signUp` asks GoTrue for, so the destination
      // is the same whether or not the parameter survives the round trip.
      return '/offers?welcome=1';
    case 'email_change':
      // Likewise `requestEmailChange`. The banner on `/settings` is what tells
      // them the change actually landed — GoTrue needs BOTH addresses to
      // confirm, so arriving here does not by itself mean it is done.
      return '/settings?email=changed';
    case 'magiclink':
      return '/offers';
    case 'recovery':
    default:
      return RESET_PASSWORD_PATH;
  }
}
