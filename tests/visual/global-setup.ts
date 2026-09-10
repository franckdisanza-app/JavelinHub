import { rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * =============================================================================
 * A throwaway store that is actually thrown away.
 * =============================================================================
 *
 * `README.md` says of the two mock suites: *"Both suites provision and tear
 * down their own store."* `verify:pages` does. This one did not — it pointed
 * `MOCK_DB_PATH` at `./.playwright-store.json` and left the file there, so
 * every run inherited the last run's rows.
 *
 * THE FAILURE THAT COMES OF IT IS NOT THE OBVIOUS ONE. Duplicate fixtures were
 * already handled: the signup spec mints a fresh address per run, and says so.
 * What survived instead was the RATE LIMIT table. `signupIp` prices an account
 * at five an hour, keyed per IP, and every run of this suite signs up twice
 * from 127.0.0.1 — so the third consecutive run inside an hour is refused, the
 * form stays on `/signup`, and the assertion reports the redirect that did not
 * happen rather than the limit that did.
 *
 * It is invisible in CI, which starts from an empty checkout every time, and it
 * is exactly the shape of the other two failures found the same day: a suite
 * that passes or fails on something other than the code under test. Deleting
 * the store before the run makes a local run and a CI run the same run.
 *
 * The store re-seeds itself on the first request, so there is nothing to
 * replace it with — the absence IS the fixture.
 */
export default async function globalSetup(): Promise<void> {
  const store = path.resolve(process.cwd(), '.playwright-store.json');

  // `force` so a first run, or a run after somebody deleted it by hand, is not
  // an error. There is nothing to clean up in a teardown: the next run's setup
  // is the teardown, and leaving the file behind is what makes a failure
  // inspectable afterwards.
  await rm(store, { force: true });
}
