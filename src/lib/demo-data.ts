import { dataBackend } from '@/lib/env';

/**
 * =============================================================================
 * Is the data on this page fabricated?
 * =============================================================================
 *
 * Four pages carry a note saying the reviews and numbers on them are demo data,
 * and each one is attached to the block the fiction is actually in — the house
 * pattern `PROGRESS.md` sets out under "Demo data must be marked". Each was
 * gated on whether there was any content to disclaim (`reviews.length > 0`,
 * `stats.some(...)`) and on NOTHING ELSE.
 *
 * THAT WAS RIGHT UNTIL THE LIVE DATABASE WAS EMPTIED, and wrong from that
 * moment. `docs/DEPLOY.md` §1 records the teardown — 167 fabricated rows across
 * 7 tables removed and confirmed — and the release-checks workflow exists to
 * keep it that way. So on the deployed backend those conditions no longer mean
 * "this is fabricated". They mean "somebody has reviewed something", and the
 * first real buyer to write the first real review would have been told, under
 * their own words, that nobody wrote them.
 *
 * A false disclaimer is worse than a missing one. A missing one understates; a
 * false one tells a real coach their real sales are invented, in the same
 * sentence a stranger reads before deciding whether to trust them.
 *
 * -----------------------------------------------------------------------------
 * WHY THE BACKEND IS THE RIGHT TEST, AND `is_demo` IS NOT
 * -----------------------------------------------------------------------------
 * The fabricated rows are a property of THE MOCK STORE. `README.md` says so
 * without hedging — *"The purchases and reviews in the seed are fabricated.
 * Nobody bought anything and nobody wrote any of it"* — and that store seeds
 * itself from `store.ts` on first run, in every clone, every throwaway suite
 * store and every developer's `data/db.json`. There is no mock store whose
 * reviews are real.
 *
 * The schema does carry an `is_demo` flag, and it is deliberately NOT what this
 * asks. It is revoked from `anon` and `authenticated` (0007, again in 0028)
 * because it is a pre-launch operator check rather than something the
 * application shows, and reading it per row would mean either publishing the
 * flag or building a second privileged path to it. The backend answers the same
 * question with no read at all.
 *
 * THE RESIDUAL, stated rather than hidden: a review written by hand through the
 * UI of a mock store is real, and this still calls it fabricated. That is the
 * conservative direction — over-disclosing on a store that is overwhelmingly
 * fixtures — and it is the one to be wrong in.
 *
 * SERVER ONLY, like everything that reads configuration.
 */
export function dataIsFabricated(): boolean {
  return dataBackend() === 'mock';
}
