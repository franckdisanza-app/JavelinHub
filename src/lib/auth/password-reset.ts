/**
 * =============================================================================
 * Password reset — the one flow that has to work when nothing else can.
 * =============================================================================
 *
 * A user who has forgotten their password cannot sign in, cannot prove who they
 * are with a session, and cannot be helped by anything in `DataClient`, which
 * takes an `Actor` for exactly that reason. The only thing they still control is
 * their inbox, so the whole design is: prove control of the address, receive a
 * short-lived single-use link, and land in a session that can set a new
 * password.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS NOT ON `DataClient`
 * -----------------------------------------------------------------------------
 * The interface abstracts ROWS, and every method on it takes an actor or is
 * deliberately public. This is neither: it is a credential-recovery mechanism
 * whose two backends do not merely differ in implementation, they differ in
 * WHAT EXISTS.
 *
 *   supabase   GoTrue owns all of it — minting, storing, emailing, expiring.
 *              We hand it an address and a `redirectTo`, and it takes over.
 *   mock       there is no email and no GoTrue, so the token mechanism is ours:
 *              `reset-tokens.ts`, which this file delegates to.
 *
 * That is the same split `src/lib/storage/*` is kept out of `DataClient` for,
 * inverted: there the mock had no analogue, here Supabase has no analogue to
 * reach into. What the two backends DO share — writing the new password once a
 * session exists — is a row write with an actor, so that half IS on
 * `DataClient`, as `updateMyPassword`.
 *
 * `session.ts` is the precedent for the shape of this file: the functions that
 * touch the mechanism dispatch on `DATA_BACKEND`, and nothing above them knows
 * which one is running.
 *
 * -----------------------------------------------------------------------------
 * THE LINK IS A CREDENTIAL
 * -----------------------------------------------------------------------------
 * Redeeming one produces a real session — that is what makes it useful, and it
 * is what GoTrue's recovery flow does too. So it is treated like a password:
 *
 *   * 32 random bytes from `randomBytes`, never a uuid or a timestamp;
 *   * stored as a SHA-256 hash, so a leaked `db.json` yields no usable links;
 *   * single-use — redeeming stamps `used_at`, and a spent row is dead;
 *   * one hour to live, checked against the stored `expires_at` rather than
 *     against anything in the link;
 *   * minting a new one kills the user's older pending links, so a forwarded
 *     email stops working the moment a fresh request is made.
 *
 * -----------------------------------------------------------------------------
 * IT NEVER SAYS WHETHER AN ADDRESS IS REGISTERED
 * -----------------------------------------------------------------------------
 * `requestPasswordReset` resolves the same way for a known address, an unknown
 * one and a malformed one. Any difference — a different message, an error, a
 * measurably different response time — turns the forgot-password form into the
 * account-enumeration oracle that `logInAction` already refuses to be.
 *
 * SERVER ONLY.
 */

import { AUTH_CALLBACK_PATH, RESET_PASSWORD_PATH } from '@/lib/auth/paths';
import { issueResetToken, redeemResetToken } from '@/lib/auth/reset-tokens';
import { createSession } from '@/lib/auth/session';
import { normalizeEmail } from '@/lib/data/mock/store';
import { createSupabaseServerClient } from '@/lib/data/supabase/serverClient';
import { dataBackend, isProduction, siteUrl } from '@/lib/env';

if (typeof window !== 'undefined') {
  throw new Error(
    'The password-reset layer is server-only and was imported into browser code. ' +
      'Call it from a server component, server action or route handler instead.',
  );
}

// Both paths moved to `./paths.ts` so `SupabaseDataClient` can reach them
// without dragging `next/headers` into a plain Node script. Re-exported here
// because this module is where callers expect to find them.
export { AUTH_CALLBACK_PATH, RESET_PASSWORD_PATH };

/**
 * Starts a reset for `email`, if there is an account behind it.
 *
 * RESOLVES REGARDLESS — see the header. The caller renders the same
 * confirmation either way and must not branch on anything this returns, which
 * is why it returns nothing.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const address = normalizeEmail(typeof email === 'string' ? email : '');
  if (address === '') return;

  if (dataBackend() === 'supabase') {
    const supabase = await createSupabaseServerClient();
    // `redirectTo` is built from CONFIGURATION, never from the request — see
    // `siteUrl()` for why a Host header must not decide where a reset link
    // points. GoTrue checks it against the project's Redirect URLs as well, so
    // a mismatch fails closed instead of emailing a link somewhere else.
    await supabase.auth.resetPasswordForEmail(address, {
      redirectTo: `${siteUrl()}${AUTH_CALLBACK_PATH}?next=${encodeURIComponent(RESET_PASSWORD_PATH)}`,
    });
    // The error is deliberately not inspected. GoTrue reports "user not found"
    // for an unregistered address, and surfacing that is precisely the
    // enumeration this flow refuses to be. A genuine outage is invisible here
    // too, which is the accepted cost of that.
    return;
  }

  // The mechanics live in `reset-tokens.ts` — mock only, no framework
  // underneath, so `scripts/verify-authz.mts` can exercise single use, expiry
  // and supersession directly.
  const token = await issueResetToken(address);
  if (!token) return;

  /*
   * THE MOCK'S "EMAIL". There is no mail transport in this backend and there
   * should not be one — the mock exists so the app runs with no external
   * services at all.
   *
   * So the link goes to the SERVER console, which is a developer's terminal and
   * not a surface any visitor can see. It is deliberately not returned from
   * this function: a value returned here would reach a Server Action, and from
   * there it is one careless render away from being shown to whoever typed the
   * address — which is the whole attack this flow is built to prevent, handed
   * over for free.
   *
   * Silenced in production for the same reason. If `DATA_BACKEND=mock` ever ran
   * in production it would already be broken (the store writes to a read-only
   * filesystem), but a reset link in a production log is not a thing to leave
   * to that.
   */
  if (!isProduction()) {
    const link = `${siteUrl()}${AUTH_CALLBACK_PATH}?token=${encodeURIComponent(token)}&next=${encodeURIComponent(RESET_PASSWORD_PATH)}`;
    console.log(`\n[mock] Password reset for ${address}\n[mock] ${link}\n`);
  }
}

/**
 * Redeems a link and, on success, leaves the caller signed in.
 *
 * Returns `true` when a session now exists. `false` means the link was absent,
 * malformed, expired, already used, or not ours — ONE answer for all of them,
 * because telling them apart tells a stranger holding a stale link whether it
 * was ever real.
 *
 * Route Handlers only: both branches write cookies.
 */
export async function redeemPasswordResetLink(params: URLSearchParams): Promise<boolean> {
  if (dataBackend() === 'supabase') {
    // PKCE. GoTrue's emailed link goes to its own `/verify` endpoint, which
    // redirects here with a one-time `code`; exchanging it is what writes the
    // session cookie pair through `setAll` in `serverClient.ts`.
    const code = params.get('code');
    if (!code) return false;

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    return !error && Boolean(data?.session);
  }

  const token = params.get('token');
  if (typeof token !== 'string' || token === '') return false;

  const userId = await redeemResetToken(token);
  if (!userId) return false;

  await createSession(userId);
  return true;
}
