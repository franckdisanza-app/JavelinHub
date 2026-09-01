import { getDataClient } from '@/lib/data';
import { dataBackend } from '@/lib/env';
import { reportError } from '@/lib/observability';

/**
 * =============================================================================
 * Is this deployment actually able to serve?
 * =============================================================================
 *
 *     GET /api/health  ->  200 {"status":"ok"}        the data layer answered
 *                          503 {"status":"degraded"}  it did not
 *
 * WHAT THIS IS FOR, and it is a specific failure this project has already
 * described rather than a generic liveness probe. README.md:
 *
 *   > **The symptom when `DATA_BACKEND` is unset**, because it is not an
 *   > obvious one: `/` and `/login` return 200 while `/offers` and `/coaches`
 *   > return 500. An anonymous visitor never touches the data layer on the
 *   > first two, so only the pages that read data fail.
 *
 * The same shape covers a deploy pointed at a project whose schema was never
 * pushed — every table answers `PGRST205` — and one whose anon key is wrong.
 * In all three the site comes up, the marketing page renders, and the failure
 * is only visible on the pages that read. Nothing can distinguish "deployed"
 * from "deployed and working" without asking the data layer, so this asks it.
 *
 * -----------------------------------------------------------------------------
 * WHY IT READS THROUGH `DataClient` AND NOT A PING
 * -----------------------------------------------------------------------------
 * `select 1` proves a connection exists. It does not prove the schema is
 * applied, the views exist, the grants are right, or that the configured
 * backend is the one somebody meant. `listCoaches` with a limit of 1 goes
 * through the real public read path on BOTH backends — the JSON store on the
 * mock, `public_coaches` through PostgREST on Supabase — so a pass means the
 * thing an anonymous visitor does actually works.
 *
 * It is the cheapest read in the interface that still touches storage: one row,
 * from a view with the approval predicate already inside it, and it is
 * deliberately NOT the cached variant — a health check served from
 * `unstable_cache` would keep answering 200 for a minute after the database
 * went away, which is precisely the minute it exists to report on.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DOES NOT SAY
 * -----------------------------------------------------------------------------
 * The response body carries a status and the backend name, and nothing else.
 * No error message, no stack, no configuration, no counts. This endpoint is
 * unauthenticated by necessity — a probe cannot sign in — so it is written to
 * be useless to anybody but a probe. The REASON goes to the server log through
 * `reportError`, where an operator can read it and a visitor cannot.
 *
 * The backend name is the one thing published beyond the status, and it earns
 * its place: "deployed with `DATA_BACKEND` unset" is the failure quoted above,
 * and `{"backend":"mock"}` from a production URL diagnoses it instantly.
 * It discloses nothing an attacker gains from — the anon key in the browser
 * bundle already names the Supabase project.
 */

/** Never cached, never prerendered. A stale health check is a broken one. */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const backend = dataBackend();

  try {
    // One row. `listCoaches` is public on both backends and takes no actor, so
    // this needs no session and reaches Postgres as `anon` — the same identity
    // a first-time visitor has.
    await getDataClient().listCoaches(undefined, { limit: 1 });
  } catch (error) {
    // `source: 'background'` rather than 'request': this is not a user's page
    // failing, it is the probe reporting that they all would.
    reportError(error, { source: 'background', kind: 'health', route: '/api/health' });

    return Response.json(
      { status: 'degraded', backend },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return Response.json({ status: 'ok', backend }, { headers: { 'Cache-Control': 'no-store' } });
}
