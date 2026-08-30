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
 * Falls back to `http://localhost:3000` so local development needs no setup.
 * That fallback is only reachable when the variable is unset, and an unset
 * variable in production means reset links point at localhost, which is a
 * visible failure rather than a silent one.
 */
export function siteUrl(): string {
  const value = process.env.NEXT_PUBLIC_SITE_URL;
  const raw = value && value.trim() !== '' ? value.trim() : 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
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
