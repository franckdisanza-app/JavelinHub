import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nowIso } from '@/lib/data/mock/store';

/**
 * =============================================================================
 * The mock's clock never repeats itself.
 * =============================================================================
 *
 * Every ordered read in the mock backend sorts on `created_at` with `id` as the
 * tie-break, and `id` is a random uuid. So two rows sharing a `created_at` are
 * not merely tied — they are ordered by the roll of `randomUUID()`, and the one
 * written second can sort first.
 *
 * `new Date().toISOString()` has millisecond resolution. Postgres's `now()` has
 * microsecond resolution and is the transaction timestamp, so the database
 * effectively never produces the tie at all. The mock produced it constantly,
 * and the difference was invisible until something wrote twice inside one tick.
 *
 * TWO BUGS CAME OUT OF THAT, both on a CI runner and neither reproducible on a
 * developer's machine:
 *
 *   * `verify:authz` drained a coach's offers, withdrew every one it was given,
 *     and was told an offer was still on sale — `sliceWindow` had skipped a
 *     tied row (see `pagination.test.mts`);
 *   * the newest revision of an offer was not the newest edit — "expected
 *     'Saved again at the same price', got 'Completely different offer, same
 *     price'".
 *
 * Whether either failed was a fact about how fast the machine was. This asserts
 * the property that removes the hardware from the question.
 */

describe('nowIso', () => {
  it('is strictly increasing, however tight the loop', () => {
    const seen = Array.from({ length: 2000 }, () => nowIso());

    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(
        seen[i]! > seen[i - 1]!,
        `call ${i} returned ${seen[i]}, which is not after ${seen[i - 1]}`,
      );
    }
  });

  it('sorts as a string the way it sorts as an instant', () => {
    // The whole backend compares these values with `localeCompare` rather than
    // by parsing them, which is only correct while the shape is fixed-width
    // ISO-8601 UTC. If that ever changes, every ordered read changes with it.
    const value = nowIso();

    assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(value).toISOString(), value);
  });

  it('does not run backwards when the wall clock has moved on', async () => {
    const before = nowIso();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = nowIso();

    assert.ok(after > before);
    // And it converges rather than drifting: once real time has passed the
    // last issued value, the wall clock is what is returned.
    assert.ok(new Date(after).getTime() - new Date(before).getTime() >= 1);
  });
});
