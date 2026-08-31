/**
 * =============================================================================
 * Killing the credential — the half `delete_my_account()` cannot reach.
 * =============================================================================
 *
 * `0018` anonymises the profile and marks it deleted. It cannot touch
 * `auth.users`: `javelin_privileged` holds no USAGE on the `auth` schema and
 * never can, which is the dead end `0004` is kept in the tree to record. So
 * after that RPC returns, the GoTrue user still exists and its JWT is still
 * valid — and a JWT is all PostgREST needs.
 *
 * Without this file, "delete my account" would be true in the application and
 * false at the API. That is not a gap worth shipping.
 *
 * -----------------------------------------------------------------------------
 * BAN, DO NOT DELETE
 * -----------------------------------------------------------------------------
 * The obvious call is `DELETE /admin/users/{id}`, and it would undo everything
 * `0018` just did: `profiles.id` references `auth.users` with `ON DELETE
 * CASCADE`, so deleting the GoTrue user deletes the profile, which cascades into
 * listings, orders and reviews — the exact destruction the anonymise-don't-erase
 * design exists to avoid, arriving through the back door.
 *
 * Banning kills the credential and fires no cascade. GoTrue refuses a sign-in
 * and refuses to refresh, so no NEW token can be minted for the account.
 *
 * -----------------------------------------------------------------------------
 * THE SERVICE-ROLE KEY, AND THE ONE RULE ABOUT IT
 * -----------------------------------------------------------------------------
 * This is the only file in `src/` that reads `SUPABASE_SERVICE_ROLE_KEY`, and
 * `supabase/README.md` is emphatic about why that key is dangerous: it is
 * BYPASSRLS, so a client built from it ignores every policy in the schema.
 *
 * **So no client is built from it.** This module makes ONE `fetch` to one GoTrue
 * admin endpoint. There is no `createClient`, no PostgREST request, and no way
 * for the key to reach the data path at all — which is what the README is
 * actually warning about. Adding a Supabase client here would be the change that
 * makes the warning apply again.
 *
 * -----------------------------------------------------------------------------
 * THE RESIDUAL, STATED RATHER THAN HIDDEN
 * -----------------------------------------------------------------------------
 * An access token already issued stays valid until it expires — GoTrue's JWTs
 * are stateless and a ban cannot recall one. So for up to the token lifetime
 * (an hour by default) a deleted account's raw token would still satisfy RLS if
 * somebody used it directly against PostgREST.
 *
 * Two things narrow that. The refresh token is revoked, so the window cannot be
 * extended. And `resolveProfile` in both backends refuses a deleted profile, so
 * every path through this application is closed immediately — the residual is a
 * hand-crafted API call by somebody who has just deleted their own account.
 *
 * SERVER ONLY.
 */

import { dataBackend, supabaseServiceRoleKey, supabaseUrl } from '@/lib/env';
import { reportError } from '@/lib/observability';

if (typeof window !== 'undefined') {
  throw new Error(
    'Account deletion is server-only and was imported into browser code. ' +
      'Call it from a server action or route handler instead.',
  );
}

/**
 * Long enough to be permanent in practice, finite because GoTrue wants a
 * duration rather than a flag. A hundred years.
 */
const BAN_DURATION = '876000h';

/**
 * Bans the GoTrue user and revokes their refresh tokens.
 *
 * Returns whether the ban was applied. **The caller must not fail the deletion
 * on `false`** — by the time this runs the profile is already anonymised, and
 * refusing to finish would leave the user with an account that has lost its name
 * and its picture and still lets them in. A failure here is reported and the
 * flow continues; `resolveProfile` is what keeps the application closed.
 *
 * A no-op on the mock backend, which has no GoTrue: the session there is a
 * signed cookie this app issues, and the deleted profile is what invalidates it.
 */
export async function banAuthUser(userId: string): Promise<boolean> {
  if (dataBackend() !== 'supabase') return true;

  const url = supabaseUrl();
  const key = supabaseServiceRoleKey();

  if (!url || !key) {
    /*
     * CONFIGURATION, NOT A BUG — and worth reporting rather than swallowing.
     * The key is deliberately blank in `.env.local.example`, so a deployment
     * that has never set it lands here. The deletion still happened; what did
     * not happen is the credential dying, and an operator needs to know that
     * about their own environment.
     */
    reportError(new Error('SUPABASE_SERVICE_ROLE_KEY is not set, so the GoTrue user was not banned'), {
      source: 'action',
      kind: 'account-deletion',
    });
    return false;
  }

  try {
    const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      // `ban_duration` refuses new sessions; the refresh revocation closes the
      // one they are holding. Neither can recall an access token already issued
      // — see the header.
      body: JSON.stringify({ ban_duration: BAN_DURATION }),
    });

    if (!res.ok) {
      reportError(new Error(`GoTrue refused the ban: HTTP ${res.status}`), {
        source: 'action',
        kind: 'account-deletion',
      });
      return false;
    }
    return true;
  } catch (error) {
    // Network, DNS, a timeout. Reported and swallowed for the reason in the doc
    // comment: the profile is already anonymised and there is no going back.
    reportError(error, { source: 'action', kind: 'account-deletion' });
    return false;
  }
}
