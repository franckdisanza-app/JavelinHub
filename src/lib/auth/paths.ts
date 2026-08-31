/**
 * The two routes that arrive in an email, and nothing else.
 *
 * **Its own module because of what it must NOT import.** Both of these strings
 * are needed by `SupabaseDataClient` — `signUp` builds the confirmation link's
 * `emailRedirectTo` from one — and the data layer is exercised by
 * `scripts/verify-authz.mts`, a plain Node script. Their natural home,
 * `password-reset.ts`, imports the session layer and through it `next/headers`,
 * which does not resolve outside the Next runtime at all.
 *
 * The same split, for the same reason, as `reset-tokens.ts` and `client-ip.ts`.
 * This file imports nothing and never should.
 *
 * A LINK IN AN EMAIL CANNOT BE CHANGED once it is sent, so both paths are
 * effectively permanent: they are registered in Supabase's Redirect URLs
 * allow-list, and a link already in somebody's inbox points at whatever they
 * said when it was minted. Renaming either means honouring the old path for as
 * long as an unexpired link might exist.
 */

/** Where every emailed link lands. Registered in Supabase → Redirect URLs. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * The callback's default destination.
 *
 * It is the RECOVERY page rather than the marketing one on purpose: of the
 * flows that land here, password reset is the one where arriving at the wrong
 * place strands somebody who cannot sign in by any other route. Signup
 * confirmation passes an explicit `?next=`, and if that were ever dropped in
 * transit a confirming user lands here already signed in — an odd screen, but a
 * recoverable one.
 */
export const RESET_PASSWORD_PATH = '/reset-password';
