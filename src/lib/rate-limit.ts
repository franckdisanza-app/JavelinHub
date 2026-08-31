/**
 * =============================================================================
 * Rate limiting — the counter both backends share, and the keys it counts.
 * =============================================================================
 *
 * `docs/ROADMAP.md` §6 has wanted this since before signup existed. Password
 * reset made it urgent: `/forgot-password` is public, ungated, and sends mail.
 * GoTrue caps its own sending, so the exposure is not unlimited email — it is
 * that **one caller can exhaust the shared, project-wide mail quota and deny
 * password resets to everybody else**. A denial of service aimed squarely at
 * the one path that exists for people who cannot get in any other way.
 *
 * -----------------------------------------------------------------------------
 * THE BUCKET IS AN HMAC, AND THAT IS LOAD-BEARING
 * -----------------------------------------------------------------------------
 * `anon` must be able to consume a limit — the forms this protects are all
 * reachable without a session — so on Supabase a caller can invoke
 * `consume_rate_limit()` with any bucket string they like. If buckets were
 * `reset:victim@example.com`, anyone could burn a victim's reset budget to the
 * floor and lock them out of their own account recovery.
 *
 * So the key is never sent. `HMAC-SHA256(SESSION_SECRET, key)` is, and a caller
 * cannot compute the bucket for an address without the secret. The worst they
 * can do is exhaust their own.
 *
 * A second, smaller benefit: the stored bucket is not an address, so the table
 * is not a list of who has asked for a password reset.
 *
 * -----------------------------------------------------------------------------
 * IT FAILS OPEN
 * -----------------------------------------------------------------------------
 * If the limiter itself errors — the migration is not applied, the database is
 * unreachable, the store is locked — the request PROCEEDS.
 *
 * That is the deliberate choice and it is the opposite of how the rest of this
 * app fails. Everywhere else, an unanswerable authorization question is a
 * refusal. Here the question is not "may this person do this" but "have they
 * done it too often", and answering that wrongly by refusing turns a broken
 * counter into a total outage of login, signup and password reset at once. A
 * limiter that can take the site down is a worse liability than the abuse it
 * prevents.
 *
 * The corollary is that this is a SPEED BUMP, not a boundary. Nothing about
 * authorization may ever depend on it.
 *
 * -----------------------------------------------------------------------------
 * SO IS THE IP
 * -----------------------------------------------------------------------------
 * The IP comes from `clientIp()` in `./client-ip.ts`, which reads proxy headers
 * that are attacker-controlled unless something in front overwrites them. So
 * the per-IP limits are a speed bump on top of a speed bump — worth having,
 * because they are what stops one caller varying the email to bypass the
 * per-address limit, and never worth trusting.
 *
 * That function lives in its own module because it needs `next/headers`, which
 * does not resolve outside the Next runtime. Everything in THIS file is plain
 * Node, so `scripts/verify-authz.mts` can exercise the counting rules directly
 * — the same split, for the same reason, as `reset-tokens.ts` and
 * `password-reset.ts`.
 *
 * SERVER ONLY.
 */

import { createHmac } from 'node:crypto';

import { mutateDb } from '@/lib/data/mock/store';
import { createSupabaseServerClient } from '@/lib/data/supabase/serverClient';
import { dataBackend, sessionSecret } from '@/lib/env';

if (typeof window !== 'undefined') {
  throw new Error(
    'The rate limiter is server-only and was imported into browser code. ' +
      'Call it from a server action or route handler instead.',
  );
}

/**
 * The budgets, in one place so they can be read as a policy rather than found
 * one call site at a time.
 *
 * Two axes everywhere they both make sense, because each alone is trivially
 * bypassed: a per-address limit is defeated by varying the address, and a
 * per-IP limit by varying the IP. Neither is defeated by BOTH being in force,
 * cheaply.
 *
 * The numbers are deliberately generous. A limiter that fires on legitimate use
 * teaches people that the site is broken, and the traffic this is defending
 * against is orders of magnitude above a person retrying a password.
 */
export const LIMITS = {
  /** Per address. Three reset mails an hour is already more than anyone needs. */
  resetEmail: { limit: 3, windowSeconds: 60 * 60 },
  /**
   * Per IP. THE ONE THAT MATTERS for the shared mail quota — the per-address
   * limit above does nothing against a caller who varies the address, and
   * varying the address is free.
   */
  resetIp: { limit: 10, windowSeconds: 60 * 60 },
  /** Per address. Wrong-password retries are normal; a thousand are not. */
  loginEmail: { limit: 10, windowSeconds: 15 * 60 },
  loginIp: { limit: 30, windowSeconds: 15 * 60 },
  /** Per IP. Signup has no address to key on that is not attacker-chosen. */
  signupIp: { limit: 5, windowSeconds: 60 * 60 },
  /**
   * Per IP. An invite code is 30¹² ≈ 2⁵⁹, so this is not what stops it being
   * guessed — arithmetic already does. It is here so that trying is not free,
   * and because the same endpoint is a convenient thing to hammer.
   */
  redeemIp: { limit: 10, windowSeconds: 60 * 60 },
  /**
   * Per USER, not per IP — the one limit here keyed that way. Reporting needs an
   * account, `signupIp` already prices accounts, and the partial unique index on
   * `reports` caps repeats against any one subject at a single open report. So
   * the account is the scarce input, and an IP key would only punish everybody
   * sharing one office router.
   */
  reportUser: { limit: 20, windowSeconds: 60 * 60 },
} as const;

export type LimitName = keyof typeof LIMITS;

/** `HMAC-SHA256(SESSION_SECRET, key)`, hex. See the header for why. */
function bucketFor(key: string): string {
  return createHmac('sha256', sessionSecret()).update(key).digest('hex');
}

/**
 * Counts one attempt against `key` and reports whether it is within the limit.
 *
 * `true` = proceed. `false` = over the limit. **The attempt is counted either
 * way**, so hammering an exhausted bucket keeps it exhausted rather than
 * letting a caller wait out a window they are still filling.
 *
 * `key` is a plain string — `reset:someone@example.com`, `login-ip:1.2.3.4` —
 * and is hashed here. It never leaves this process.
 */
export async function consume(name: LimitName, key: string): Promise<boolean> {
  const { limit, windowSeconds } = LIMITS[name];
  const bucket = bucketFor(`${name}:${key}`);

  try {
    if (dataBackend() === 'supabase') {
      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.rpc('consume_rate_limit', {
        p_bucket: bucket,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      // FAILS OPEN — see the header. A missing migration lands here.
      if (error) return true;
      return data !== false;
    }

    return await mutateDb((db) => {
      const now = Date.now();
      const row = db.rate_limits.find((r) => r.bucket === bucket);

      if (!row) {
        db.rate_limits.push({ bucket, count: 1, window_started_at: new Date(now).toISOString() });
        return 1 <= limit;
      }

      // Mirrors the `case when r.window_started_at <= now() - interval` arms of
      // consume_rate_limit(): an expired window is RESTARTED, not trimmed.
      const startedAt = new Date(row.window_started_at).getTime();
      const expired = !Number.isFinite(startedAt) || startedAt <= now - windowSeconds * 1000;
      if (expired) {
        row.count = 1;
        row.window_started_at = new Date(now).toISOString();
      } else {
        row.count += 1;
      }

      // The same 1%-of-calls sweep the SQL function does, for the same reason:
      // one row per distinct bucket, forever, and nothing else deletes them.
      if (Math.random() < 0.01) {
        const horizon = now - 24 * 60 * 60 * 1000;
        db.rate_limits = db.rate_limits.filter(
          (r) => new Date(r.window_started_at).getTime() >= horizon,
        );
      }

      return row.count <= limit;
    });
  } catch {
    return true;
  }
}

/**
 * Consumes an address limit and an IP limit together, and reports whether BOTH
 * allow the request.
 *
 * Both are consumed even when the first refuses — short-circuiting would let a
 * caller who has exhausted one axis keep the other pristine, and the two
 * budgets exist precisely because either alone is bypassable.
 *
 * A `null` ip contributes nothing and does not refuse. See {@link clientIp}.
 */
export async function consumeBoth(
  byEmail: { name: LimitName; email: string },
  byIp: { name: LimitName; ip: string | null },
): Promise<boolean> {
  const emailOk = await consume(byEmail.name, byEmail.email.trim().toLowerCase());
  const ipOk = byIp.ip === null ? true : await consume(byIp.name, byIp.ip);
  return emailOk && ipOk;
}

/**
 * What a user is told when a limit fires.
 *
 * ONE SENTENCE FOR EVERY LIMIT, and it names no number, no window and no axis.
 * "You have made 3 of 3 reset requests for this address" would confirm that the
 * address is worth making requests for, which is the enumeration the reset form
 * is built not to answer — and telling a caller which axis they hit tells them
 * which one to vary.
 */
export const TOO_MANY_MESSAGE =
  'Too many attempts just now. Please wait a few minutes and try again.';
