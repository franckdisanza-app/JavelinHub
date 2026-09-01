/**
 * =============================================================================
 * Is there fabricated data in the database this is pointed at?
 * =============================================================================
 *
 *     npm run check:demo-data
 *
 * `0006_demo_flag.sql` put an `is_demo` column on every table that can hold a
 * fixture, `0027` extended it to the three added since, and the comments on
 * those columns are unambiguous about why:
 *
 *   > `orders.is_demo` — "TRUE for a fabricated purchase. Nobody paid for this.
 *   >  Feeds the public sales counts through offer_stats/coach_stats exactly as
 *   >  a real order would — which is precisely why it is worth being able to
 *   >  find."
 *   > `invites.is_demo` — "…grant approved-coach status to whoever redeems one
 *   >  — revoke them before any real deployment."
 *
 * The flag, the indexes and the `demo_data_summary` view have all existed for
 * twenty-odd migrations. **What did not exist was anything that ASKS.** So the
 * mechanism was a convention plus a query somebody had to remember to run, and
 * the live project was seeded past every one of those warnings without anything
 * anywhere objecting. This is the thing that objects.
 *
 * -----------------------------------------------------------------------------
 * WHY IT NEEDS THE SERVICE-ROLE KEY
 * -----------------------------------------------------------------------------
 * `demo_data_summary` is revoked from `anon` and `authenticated` (0007, and
 * again in 0028 after 0027 recreated it), deliberately: it is a pre-launch
 * check rather than something the app shows. `service_role` still holds the
 * grant Supabase's default privileges gave it, which is what makes an operator
 * script possible without a direct database connection.
 *
 * THIS IS A READ AND NOTHING ELSE. `src/lib/auth/account-deletion.ts` is the
 * only file in `src/` that touches this key, and it makes one `fetch` to one
 * GoTrue endpoint for exactly the reason this makes one `fetch` to one view:
 * the danger the key carries is BYPASSRLS, and never constructing a client from
 * it is what keeps that danger out of the data path. Do not add a
 * `createClient` here either.
 *
 * -----------------------------------------------------------------------------
 * EXIT CODES, because this is meant to be wired into something
 * -----------------------------------------------------------------------------
 *   0  no fabricated rows. Safe to launch against this database.
 *   1  fabricated rows found, listed per table.
 *   2  could not answer — missing configuration, or the request failed. NOT the
 *      same as "clean", and deliberately a different code: a launch gate that
 *      cannot reach the database must never report a pass.
 *
 * The code is set with `process.exitCode` and the process is left to end on its
 * own, never `process.exit()`. `process.exit()` tears the loop down while
 * `fetch`'s handles are still open, and on Windows libuv aborts outright —
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, which exits 127.
 * A gate that reports "command not found" when it means "found 167 rows" is
 * worse than no gate. `verify-pages.mts` sets `process.exitCode` for the same
 * reason.
 */

// `@next/env` is CommonJS, so it has no named exports through the ESM loader.
// Same import shape as `verify-supabase.mts`.
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });

const URL_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
const SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();

interface SummaryRow {
  table_name: string;
  rows: number;
}

/** Thrown by {@link fail} so the top level can tell a refusal from a bug. */
class Unanswerable extends Error {}

function fail(message: string, hint?: string): never {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exitCode = 2;
  throw new Unanswerable(message);
}

async function readSummary(): Promise<SummaryRow[]> {
  const response = await fetch(`${URL_BASE}/rest/v1/demo_data_summary?select=*`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  }).catch((error: unknown) => {
    fail(`Could not reach the database: ${(error as Error).message}`);
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300).replace(/\s+/g, ' ');
    fail(
      `The database answered ${response.status}: ${body}`,
      'A 42501 means the view is revoked from this key too; a 404 means migrations 0006/0027 are not applied.',
    );
  }

  return (await response.json()) as SummaryRow[];
}

async function main(): Promise<void> {
  if (URL_BASE === '') {
    fail('NEXT_PUBLIC_SUPABASE_URL is not set.', 'It lives in .env.local.');
  }
  if (SERVICE_ROLE_KEY === '') {
    fail(
      'SUPABASE_SERVICE_ROLE_KEY is not set, and demo_data_summary is readable with nothing else.',
      'Supabase dashboard -> Project Settings -> API. This script only ever reads.',
    );
  }

  console.log(`\n  Asking ${URL_BASE} for fabricated rows…\n`);

  const rows = await readSummary();

  // Widest table name, so the counts line up in a column.
  const width = rows.reduce((max, row) => Math.max(max, row.table_name.length), 0);
  const sorted = rows
    .slice()
    .sort((a, b) => Number(b.rows) - Number(a.rows) || a.table_name.localeCompare(b.table_name));

  let total = 0;
  for (const row of sorted) {
    const count = Number(row.rows) || 0;
    total += count;
    console.log(`  ${count > 0 ? '!' : ' '} ${row.table_name.padEnd(width)}  ${String(count).padStart(6)}`);
  }
  console.log('');

  if (total === 0) {
    console.log('  No fabricated rows. This database is clean.\n');
    return;
  }

  const tables = rows.filter((row) => Number(row.rows) > 0).length;
  process.exitCode = 1;

  console.error(`  ${total} fabricated row(s) across ${tables} table(s).`);
  console.error('');
  console.error('  These feed the public ratings and sales counts exactly as real rows do,');
  console.error('  and the seeded invite codes grant approved-coach status to whoever');
  console.error('  redeems one. Remove them before this database serves a real user:');
  console.error('');
  console.error('      npx supabase db query --linked -f supabase/demo-teardown.sql');
  console.error('');
  console.error('  The teardown deletes on the flag, so anything the seed adds later is');
  console.error('  covered for free. It does NOT remove the four @javelinhub-verify.test');
  console.error('  accounts, which predate the flag and carry is_demo = false.');
  console.error('');
}

try {
  await main();
} catch (error) {
  // `fail()` has already printed and set the code. Anything else is a bug and
  // should surface with its stack rather than be flattened into an exit code.
  if (!(error instanceof Unanswerable)) throw error;
}
