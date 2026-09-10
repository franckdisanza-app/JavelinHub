import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KEYSETS, MAX_PAGE_SIZE, byCreatedAt, sliceWindow, type Window } from '@/lib/data/pagination';

/**
 * =============================================================================
 * Keyset pagination, when two rows share a key.
 * =============================================================================
 *
 * THIS IS A REGRESSION TEST FOR A BUG THAT SHIPPED, and the way it was found is
 * the reason the file exists. `verify:authz` ran in CI for the first time and
 * failed ten assertions, beginning:
 *
 *     FAIL  nothing of theirs is on sale now — expected 0, got 1
 *     FAIL  NOW the coach can be suspended — threw: "Take their offers off sale first."
 *
 * The suite had drained every page of one coach's offers, withdrawn each one,
 * and been told an offer was still on sale. The drain had missed a row.
 *
 * `sliceWindow` selects a page by FILTERING — keep every row strictly after the
 * cursor in `(key, id)` — then taking the first `limit`. That is the next page
 * only if the array is already in `(key desc, id desc)` order. The mock's
 * `byCreatedAtDesc` compared `created_at` alone, so two rows created in the
 * same millisecond came out in insertion order: the tied row with the HIGHER id
 * was emitted first, the cursor moved past it, and the tied row with the lower
 * id — not yet shown — was then the only one that could satisfy `id < cursor.id`.
 * The other one was filtered out for ever.
 *
 * WHY NO OTHER SUITE COULD CATCH IT. It needs two rows in the same millisecond.
 * A developer's machine writes fixtures milliseconds apart and a CI runner does
 * not, so the failure was a property of the hardware — the worst kind of thing
 * to leave a suite to discover, since a green local run is not evidence. Here
 * the timestamps are equal by construction, which is not luck.
 *
 * The `total` count is asserted alongside, because a page that skips a row and
 * a page that reports the wrong total are the same bug seen from two sides, and
 * `docs/ROADMAP.md` §6 records that the count has been wrong before.
 */

/**
 * The shape both the comparator and the keyset see. Named, and passed to
 * `sliceWindow` explicitly below: inferring `Row` from a `readonly` array AND
 * from the generic `byCreatedAt` at the same time makes TypeScript give up with
 * TS7022 on the result, which reads as a mistake in the test rather than as the
 * inference limit it is.
 */
type Row = { id: string; created_at: string };

/** Three rows sharing one timestamp, ids deliberately NOT in insertion order. */
const SAME_MS = '2026-09-10T12:00:00.000Z';
const TIED: Row[] = [
  { id: 'b', created_at: SAME_MS },
  { id: 'c', created_at: SAME_MS },
  { id: 'a', created_at: SAME_MS },
];

/** What the mock's comparator must do: key first, then id, both descending. */
function byCreatedAtDesc(a: Row, b: Row): number {
  if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Walks every page the way `drainAll` does, and returns the ids it saw. */
function drainIds(rows: Row[], limit: number): string[] {
  const seen: string[] = [];
  let cursor: string | null = null;

  for (let guard = 0; guard <= rows.length + 1; guard += 1) {
    // NOT named `window`, which would shadow the DOM global for no reason.
    // Annotated because `cursor` is both an input to this call and assigned
    // from its result, which is a loop TypeScript will not infer through.
    const slice: Window<Row> = sliceWindow<Row>(KEYSETS.listings, rows, { cursor, limit }, byCreatedAt);
    seen.push(...slice.rows.map((row) => row.id));
    if (!slice.nextCursor) return seen;
    cursor = slice.nextCursor;
  }

  throw new Error('drainIds: the cursor never reached the end');
}

describe('sliceWindow — rows that share a key', () => {
  it('returns every tied row exactly once, at a page size of one', () => {
    const sorted = [...TIED].sort(byCreatedAtDesc);
    assert.deepEqual(drainIds(sorted, 1), ['c', 'b', 'a']);
  });

  it('agrees with a single page of the same rows', () => {
    const sorted = [...TIED].sort(byCreatedAtDesc);
    assert.deepEqual(drainIds(sorted, MAX_PAGE_SIZE), ['c', 'b', 'a']);
  });

  it('reports the total ignoring the cursor, on every page', () => {
    const sorted = [...TIED].sort(byCreatedAtDesc);
    const first = sliceWindow<Row>(KEYSETS.listings, sorted, { limit: 1 }, byCreatedAt);
    const second = sliceWindow<Row>(
      KEYSETS.listings,
      sorted,
      { cursor: first.nextCursor, limit: 1 },
      byCreatedAt,
    );

    assert.equal(first.total, 3);
    assert.equal(second.total, 3, 'the total is "3 offers", never "2 left"');
  });

  /**
   * The mixed case is the realistic one: a page boundary that lands in the
   * middle of a tie. Two rows share the newer timestamp and one is older, and
   * page one takes exactly one of the tied pair.
   */
  it('does not lose a row when a page boundary falls inside a tie', () => {
    const rows: Row[] = [
      { id: 'x', created_at: SAME_MS },
      { id: 'y', created_at: SAME_MS },
      { id: 'z', created_at: '2026-09-09T12:00:00.000Z' },
    ].sort(byCreatedAtDesc);

    assert.deepEqual(drainIds(rows, 1), ['y', 'x', 'z']);
    assert.deepEqual(drainIds(rows, 2), ['y', 'x', 'z']);
  });
});

/**
 * The guard that turns the bug above into a thrown error rather than a short
 * list. It is the half that matters for the NEXT read somebody adds: a
 * comparator that ties on nothing, or on the wrong column, now fails loudly on
 * page one instead of quietly dropping a row somewhere in the middle.
 */
describe('sliceWindow — the order it is handed', () => {
  it('refuses rows sorted on the key alone', () => {
    // Exactly the old comparator: `created_at` and nothing else. Stable, so the
    // tied rows keep insertion order — b, c, a — which is not id-descending.
    const partiallySorted = [...TIED].sort((a, b) => b.created_at.localeCompare(a.created_at));

    assert.throws(
      () => sliceWindow<Row>(KEYSETS.listings, partiallySorted, { limit: 1 }, byCreatedAt),
      /not in keyset order/,
      'a partial comparator must be an error, not a silently skipped row',
    );
  });

  it('accepts rows sorted on the key and the tie-break', () => {
    const sorted = [...TIED].sort(byCreatedAtDesc);
    assert.equal(sliceWindow<Row>(KEYSETS.listings, sorted, { limit: 1 }, byCreatedAt).rows.length, 1);
  });

  it('says which read was wrong, because the message is the whole value', () => {
    const partiallySorted = [...TIED].sort((a, b) => b.created_at.localeCompare(a.created_at));

    assert.throws(
      () => sliceWindow<Row>(KEYSETS.listings, partiallySorted, undefined, byCreatedAt),
      /sliceWindow\(listings\)/,
    );
  });
});
