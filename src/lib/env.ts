/**
 * Server-side environment accessor.
 *
 * Every configurable value in the app is read through this module. Nothing
 * anywhere else in `src/` may reference `process.env` directly, and no secret
 * is ever hardcoded — the only defaults here are non-secret conveniences
 * (`DATA_BACKEND`, `MOCK_DB_PATH`, the seed admin's *email*).
 *
 * `SESSION_SECRET` and `SEED_ADMIN_PASSWORD` have no default at all: if they
 * are missing the accessor throws with the exact line to add to `.env.local`,
 * because silently falling back to a well-known value is how POCs ship
 * forgeable sessions.
 *
 * Accessors are functions, not module-level constants, so that importing this
 * file never throws — only *asking for* a missing required value does. That
 * keeps a page that has nothing to do with sessions from crashing because the
 * session secret is unset.
 */

/** Values that are safe to expose to the browser bundle. */
const PUBLIC_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;

function missing(name: string, hint: string): never {
  throw new Error(
    `Missing required environment variable ${name}. ` +
      `Add it to .env.local (copy .env.local.example if you have not yet), then restart the dev server. ${hint}`,
  );
}

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Which `DataClient` implementation `getDataClient()` should build.
 *
 * Unset means `mock`. Any *other* value throws rather than falling back:
 * `DATA_BACKEND=supabse` used to silently select the mock, which is the worst
 * possible outcome — the app comes up looking healthy while reading a local
 * JSON file instead of the database you thought you had pointed it at.
 */
export function dataBackend(): 'mock' | 'supabase' {
  const value = read('DATA_BACKEND');
  if (value === undefined || value === 'mock') return 'mock';
  if (value === 'supabase') return 'supabase';
  throw new Error(
    `Invalid DATA_BACKEND value "${value}" in .env.local. It must be "mock" (the default) or "supabase".`,
  );
}

/** Path to the mock JSON store, relative to `process.cwd()` unless absolute. */
export function mockDbPath(): string {
  return read('MOCK_DB_PATH') ?? './data/db.json';
}

/**
 * HMAC key for the local mock session cookie. Required — no default.
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
export function sessionSecret(): string {
  return (
    read('SESSION_SECRET') ??
    missing(
      'SESSION_SECRET',
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  );
}

/**
 * True when the app is running a production build.
 *
 * Lives here for the same reason every other `process.env` read does: nothing
 * in `src/` outside this module touches `process.env`. The session layer needs
 * it to decide whether the session cookie gets the `Secure` attribute — the POC
 * has to work over plain `http://localhost`, where a `Secure` cookie would be
 * dropped by the browser and the user could never stay signed in.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Email of the admin account the mock store seeds on first run. Non-secret. */
export function seedAdminEmail(): string {
  return read('SEED_ADMIN_EMAIL') ?? 'admin@javelin.test';
}

/** Password for the seeded admin account. Required — no default, ever. */
export function seedAdminPassword(): string {
  return (
    read('SEED_ADMIN_PASSWORD') ??
    missing(
      'SEED_ADMIN_PASSWORD',
      'Pick any local-only password; it becomes the seeded admin login and is never committed.',
    )
  );
}

/**
 * The app's own public origin — `https://javelinhub.example`, no trailing slash.
 *
 * ONE THING NEEDS THIS AND IT IS SECURITY-RELEVANT: the absolute link in a
 * password-reset email. `resetPasswordForEmail` takes a `redirectTo`, and that
 * URL is emailed to somebody who is, by definition, locked out and inclined to
 * click it.
 *
 * IT IS DELIBERATELY NOT DERIVED FROM THE REQUEST. The obvious implementation
 * reads the `Host` (or `X-Forwarded-Host`) header of the request that submitted
 * the form, and that header is attacker-controlled: a crafted request produces
 * a real, valid reset link for a real account pointing at the attacker's
 * domain, sent by us, to the victim. Host-header poisoning of password-reset
 * emails is a well-worn bug and configuration is the only fix that does not
 * depend on a proxy being configured exactly right.
 *
 * Supabase applies a second, independent check — `redirectTo` must match the
 * project's Redirect URLs allow-list — so a misconfiguration here fails closed
 * rather than sending a poisoned link. Both are wanted; neither replaces the
 * other.
 *
 * Falls back to `http://localhost:3000` so local development needs no setup —
 * and **only** in development. In production the fallback is a throw.
 *
 * THE OLD COMMENT CLAIMED THE FALLBACK WAS "a visible failure rather than a
 * silent one" IN PRODUCTION. It is not, and the reasoning was one step short.
 * The chain runs: variable unset -> link built as `http://localhost:3000/...`
 * -> GoTrue checks it against the project's Redirect URLs and refuses ->
 * `resetPasswordForEmail` returns an error -> `requestPasswordReset` does not
 * inspect it, deliberately, because inspecting it re-opens the account
 * enumeration oracle -> `requestPasswordResetAction` swallows it, deliberately,
 * for the same reason -> the user is told to check an inbox nothing was sent
 * to. Every one of those swallows is individually correct, and together they
 * make a misconfiguration invisible to the one person who would notice it: a
 * user who is locked out and by definition cannot report it through the app.
 *
 * So the failure moves to the only place it can be loud — the first request
 * that asks, in production, which is far earlier and far cheaper than a support
 * thread about reset emails that never arrive. Development is untouched: the
 * fallback still applies, so `npm run dev` and `verify:pages` need no setup.
 */
export function siteUrl(): string {
  const value = process.env.NEXT_PUBLIC_SITE_URL;
  const trimmed = typeof value === 'string' ? value.trim() : '';

  if (trimmed === '') {
    if (isProduction()) {
      missing(
        'NEXT_PUBLIC_SITE_URL',
        "It is this app's own public origin with no trailing slash, e.g. https://javelin-hub.vercel.app — " +
          'and the same origin must be listed under Supabase → Authentication → URL Configuration → Redirect URLs, ' +
          'or GoTrue refuses every emailed link.',
      );
    }
    return 'http://localhost:3000';
  }

  return trimmed.replace(/\/+$/, '');
}

/**
 * Supabase configuration. Unused while `DATA_BACKEND=mock`, declared here so
 * that the eventual `SupabaseDataClient` is a config change and not a code
 * change. `NEXT_PUBLIC_*` reads are written as static member expressions
 * because Next.js inlines them at build time by literal text match.
 */
export function supabaseUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return value && value.trim() !== '' ? value.trim() : null;
}

export function supabaseAnonKey(): string | null {
  const value = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return value && value.trim() !== '' ? value.trim() : null;
}

export function supabaseServiceRoleKey(): string | null {
  return read('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

/**
 * Throws unless every value the Supabase backend needs is present. Called by
 * the future `SupabaseDataClient` constructor so misconfiguration surfaces at
 * startup rather than on the first query.
 */
export function requireSupabaseConfig(): {
  url: string;
  anonKey: string;
  serviceRoleKey: string | null;
} {
  const url = supabaseUrl() ?? missing(PUBLIC_KEYS[0], 'It is the project URL from the Supabase dashboard.');
  const anonKey =
    supabaseAnonKey() ?? missing(PUBLIC_KEYS[1], 'It is the anon/public API key from the Supabase dashboard.');
  return { url, anonKey, serviceRoleKey: supabaseServiceRoleKey() };
}

/**
 * Transactional-email configuration.
 *
 * `apiKey` is `null` until Resend is wired up, and `sendEmail()` treats that as
 * "log and skip" rather than as an error — see `src/lib/email/send.ts` for why
 * that is the right default rather than an unfinished one.
 *
 * `from` has a default and the default is deliberately a `.invalid` address:
 * RFC 6761 reserves that TLD, so it can never resolve and can never be somebody
 * else's mailbox. An unset sender that silently became `noreply@localhost` or a
 * real-looking domain is how test mail ends up being delivered from an address
 * the business does not control.
 *
 * NOT VALIDATED AS AN ADDRESS HERE. `assertRuntimeConfig()` does that at boot,
 * because a malformed sender fails on the first send rather than at startup —
 * which is exactly the class of silent production failure that check exists for.
 */
export function emailConfig(): { apiKey: string | null; from: string } {
  return {
    apiKey: read('RESEND_API_KEY') ?? null,
    from: read('EMAIL_FROM') ?? 'JavelinHub <noreply@javelinhub.invalid>',
  };
}

/**
 * =============================================================================
 * The boot check — every misconfiguration that is otherwise SILENT.
 * =============================================================================
 *
 * Everything else in this module is lazy on purpose: importing it never throws,
 * and only *asking for* a missing value does. That is right for a value one
 * page needs, and it is exactly wrong for the four below, because nothing on a
 * healthy-looking deployment ever asks for them until the damage is done.
 *
 * Each of these has already been written down somewhere in this repository as a
 * failure that is invisible to the person who would report it:
 *
 *   DATA_BACKEND=mock       README.md: "`/` and `/login` return 200 while
 *                           `/offers` and `/coaches` return 500." The store
 *                           writes to a serverless filesystem that is read-only
 *                           and not shared between invocations, so the marketing
 *                           page comes up and the product does not.
 *
 *   SESSION_SECRET          `rate-limit.ts`: the limiter FAILS OPEN, deliberately
 *                           and correctly, and `bucketFor()` reads this key
 *                           inside the same `try`. So an unset secret does not
 *                           produce an error anywhere — it produces signup,
 *                           login, password reset and invite redemption with no
 *                           throttle at all, and says nothing.
 *
 *   NEXT_PUBLIC_SITE_URL    `siteUrl()` above, at length: the link is built,
 *                           GoTrue refuses it, `requestPasswordReset` does not
 *                           inspect the error (that would re-open the
 *                           enumeration oracle) and the user is told to check an
 *                           inbox nothing was sent to. Every swallow in that
 *                           chain is individually correct.
 *
 *   the Supabase pair       every page that reads data answers 500 while the two
 *                           that do not keep answering 200.
 *
 * `siteUrl()` already throws on demand, and that is kept — this is the earlier,
 * louder half of the same idea, not a replacement for it.
 *
 * -----------------------------------------------------------------------------
 * WHY IT IS SAFE TO THROW HERE, AND WHY CI IS NOT AFFECTED
 * -----------------------------------------------------------------------------
 * The only caller is `register()` in `src/instrumentation.ts`, and Next skips
 * that hook entirely during a production build — `registerInstrumentation()` in
 * `next/dist/server/lib/router-utils/instrumentation-globals.external.js` opens
 * with *"Ensure registerInstrumentation is not called in production build"* and
 * returns when `NEXT_PHASE` is `phase-production-build`.
 *
 * That distinction is the whole reason this can exist. `next build` sets
 * `NODE_ENV=production`, so a check keyed on `isProduction()` alone would fire
 * during the CI build — which passes `DATA_BACKEND=mock` deliberately and has no
 * business knowing a deployment's own origin. The layout's `generateMetadata`
 * is written as a function rather than a const for precisely this reason; the
 * same trap, avoided a different way.
 *
 * -----------------------------------------------------------------------------
 * IT REPORTS EVERY FAILURE AT ONCE
 * -----------------------------------------------------------------------------
 * A deploy that fails four times for four variables is four round trips through
 * a build queue. All of them are collected and raised together.
 */
export function assertRuntimeConfig(): void {
  if (!isProduction()) return;

  const problems: string[] = [];

  // Read directly rather than through `dataBackend()`: an invalid value should
  // be reported as itself, beside the others, rather than throwing on its own
  // and hiding the rest.
  const backend = read('DATA_BACKEND');
  if (backend === undefined || backend === 'mock') {
    problems.push(
      'DATA_BACKEND is "mock" (or unset, which means mock). The mock store writes to ./data/db.json, ' +
        'and a serverless filesystem is read-only and not shared between invocations — so it cannot serve ' +
        'a deployment even as a stopgap. Set DATA_BACKEND=supabase.',
    );
  } else if (backend !== 'supabase') {
    problems.push(`DATA_BACKEND is "${backend}", which is neither "mock" nor "supabase".`);
  }

  if (read('SESSION_SECRET') === undefined) {
    problems.push(
      'SESSION_SECRET is unset. It keys the rate limiter\'s bucket HMAC on BOTH backends, and the limiter ' +
        'fails open by design — so without it signup, login, password reset and invite redemption are ' +
        'unthrottled and nothing says so. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  if (typeof process.env.NEXT_PUBLIC_SITE_URL !== 'string' || process.env.NEXT_PUBLIC_SITE_URL.trim() === '') {
    problems.push(
      "NEXT_PUBLIC_SITE_URL is unset. It is this app's own public origin with no trailing slash, and it is " +
        'the absolute base of every link GoTrue emails. Add the same origin to Supabase → Authentication → ' +
        'URL Configuration → Redirect URLs, or GoTrue refuses the redirect and the failure reaches nobody.',
    );
  }

  if (backend === 'supabase') {
    if (supabaseUrl() === null) problems.push('NEXT_PUBLIC_SUPABASE_URL is unset, and DATA_BACKEND=supabase needs it.');
    if (supabaseAnonKey() === null) {
      problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY is unset, and DATA_BACKEND=supabase needs it.');
    }
  }

  /*
   * Only when mail is actually switched on. An unset `RESEND_API_KEY` is a
   * supported state — `sendEmail()` logs and skips — so it is not a problem to
   * report. A key that IS set beside a sender nobody can reply to, or one still
   * pointing at the `.invalid` default, is: it means the first real
   * notification goes out from an address that does not exist.
   */
  const mail = emailConfig();
  if (mail.apiKey !== null) {
    if (mail.from.includes('.invalid')) {
      problems.push(
        'RESEND_API_KEY is set but EMAIL_FROM is still the .invalid placeholder. Set it to a sender on a domain ' +
          'verified in Resend, e.g. "JavelinHub <noreply@yourdomain.com>", or mail will be rejected or land in spam.',
      );
    } else if (!/^[^<>]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mail.from)) {
      problems.push(`EMAIL_FROM ("${mail.from}") is not an address or a "Name <address>" pair.`);
    }
  }

  if (problems.length === 0) return;

  throw new Error(
    `Refusing to start: ${problems.length} production configuration ${problems.length === 1 ? 'problem' : 'problems'}.\n\n` +
      problems.map((line, i) => `  ${i + 1}. ${line}`).join('\n\n') +
      '\n\nEach of these fails silently at runtime rather than loudly, which is why the server stops here instead.',
  );
}
