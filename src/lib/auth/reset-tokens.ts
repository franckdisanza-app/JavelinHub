/**
 * =============================================================================
 * Mock reset tokens — the half of password reset that GoTrue would own.
 * =============================================================================
 *
 * **MOCK BACKEND ONLY.** On Supabase every line of this is GoTrue's: minting,
 * storing, emailing, expiring and redeeming a recovery token. Nothing here runs
 * when `DATA_BACKEND=supabase`, and `password-reset.ts` is what decides.
 *
 * SPLIT OUT OF `password-reset.ts` ON PURPOSE, and the reason is testability
 * rather than tidiness. Its sibling writes cookies, so it imports the session
 * layer and through it `next/headers`, which needs a request context that a
 * plain Node script does not have. Everything in THIS file is store reads and
 * writes with no framework underneath, so `scripts/verify-authz.mts` can
 * exercise the rules that actually matter — single use, expiry, supersession —
 * the same way it exercises every other authorization rule in the app.
 *
 * The token is a credential. See the header of `password-reset.ts` for the
 * whole list of properties that follows from that; the three enforced here are:
 * it is stored only as a SHA-256 hash, it is spent inside the same `mutateDb`
 * that validates it, and minting a new one kills the older ones.
 *
 * SERVER ONLY.
 */

import { createHash, randomBytes } from 'node:crypto';

import { mutateDb, newId, normalizeEmail } from '@/lib/data/mock/store';

if (typeof window !== 'undefined') {
  throw new Error(
    'Reset tokens are server-only and were imported into browser code. ' +
      'Call them from a server component, server action or route handler instead.',
  );
}

/**
 * How long a link lives.
 *
 * Long enough to find the email and click it, short enough that a link sitting
 * in a mailbox somebody else later reads is usually worthless. GoTrue's own
 * default is one hour, so matching it keeps both backends explicable with one
 * sentence.
 */
export const TOKEN_TTL_SECONDS = 60 * 60;

/** 32 bytes. Long enough that guessing is not a strategy worth modelling. */
const TOKEN_BYTES = 32;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mints a reset token for `email`, or returns `null` when no account has that
 * address.
 *
 * THE RETURN VALUE IS A LIVE CREDENTIAL. Exactly one caller may have it — the
 * thing that delivers it to the address it was minted for. It must never be
 * returned from a Server Action, and `requestPasswordReset` is `Promise<void>`
 * so that it cannot be: a value that reaches an action is one careless render
 * away from being shown to whoever typed the address, which would let anyone
 * reset any account they can name.
 *
 * `null` for an unknown address rather than a throw, because the caller must
 * behave identically either way — see the enumeration note in
 * `password-reset.ts`.
 */
export async function issueResetToken(email: string): Promise<string | null> {
  const address = normalizeEmail(typeof email === 'string' ? email : '');
  if (address === '') return null;

  const token = randomBytes(TOKEN_BYTES).toString('base64url');

  const issued = await mutateDb((db) => {
    // `auth_users`, NOT `profiles`. The credential table is the one that
    // decides whether an account can be signed into, and `profiles.email`
    // deliberately carries no unique constraint — the same reasoning `signUp`
    // uses for its duplicate check.
    const user = db.auth_users.find((u) => u.email === address);
    if (!user) return false;

    const now = new Date();

    // SUPERSESSION. Older pending links for this user die here, so requesting a
    // reset twice leaves exactly one working link. Without it, a first email
    // that was forwarded, quoted or left in a shared inbox stays live for its
    // full hour after the user has already asked for another.
    for (const row of db.password_resets) {
      if (row.user_id === user.id && row.used_at === null) row.used_at = now.toISOString();
    }

    db.password_resets.push({
      id: newId(),
      user_id: user.id,
      token_hash: hashToken(token),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000).toISOString(),
      used_at: null,
    });
    return true;
  });

  return issued ? token : null;
}

/**
 * Redeems a token and returns the user id it was minted for, or `null`.
 *
 * ONE ANSWER FOR EVERY FAILURE — absent, malformed, expired, already spent, or
 * belonging to a deleted account. Telling them apart tells a stranger holding a
 * stale link whether it was ever real.
 *
 * Validation and spending happen in the SAME `mutateDb`, which the store
 * serialises. That is what makes single-use true rather than merely intended:
 * two concurrent redemptions of one link cannot both find it unspent.
 */
export async function redeemResetToken(token: string): Promise<string | null> {
  if (typeof token !== 'string' || token === '') return null;
  const presented = hashToken(token);

  return mutateDb((db) => {
    const now = new Date();

    // Matched on the HASH, so the token is never compared against anything
    // stored — the same property `verifyPassword` has.
    const row = db.password_resets.find((r) => r.token_hash === presented);
    if (!row) return null;
    if (row.used_at !== null) return null;
    if (new Date(row.expires_at).getTime() <= now.getTime()) return null;

    row.used_at = now.toISOString();

    // The account may have been deleted between minting and redeeming. The row
    // is still spent above, which is correct: a token presented once is used
    // whatever it turned out to point at.
    return db.auth_users.some((u) => u.id === row.user_id) ? row.user_id : null;
  });
}
