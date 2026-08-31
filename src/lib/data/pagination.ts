/**
 * Keyset pagination, for both backends.
 *
 * =============================================================================
 * WHY KEYSET AND NOT OFFSET
 * =============================================================================
 * `LIMIT n OFFSET m` is one line and wrong in two ways that matter here.
 *
 * It is **unstable under writes**: every list in this product is newest-first,
 * so a row inserted between two requests shifts everything down by one, and the
 * reader of page 2 sees the last row of page 1 again while a different row is
 * skipped entirely. On a review queue that means a moderator can miss a review
 * that nobody ever sees again.
 *
 * And it gets **slower the deeper you go**: Postgres has to walk and discard the
 * first `m` rows on every request, so page 100 costs a hundred times page 1.
 * Keyset asks `where (key, id) < (last key, last id)` instead, which is an index
 * range scan at the same cost for every page.
 *
 * The price is that pages are only reachable in order — there is no "jump to
 * page 7" — which is why the UI offers "Next" and the browser's own Back rather
 * than numbered pages. For a marketplace list that is the honest interaction
 * anyway; nobody has an opinion about page 7.
 *
 * =============================================================================
 * THE TIE-BREAK IS NOT OPTIONAL
 * =============================================================================
 * Every keyset here is `(key, id)`, never `key` alone. Two offers created in the
 * same millisecond — or two rows sharing a price, once the browse sort is by
 * price — are ordered arbitrarily without a tie-break, and an arbitrary order is
 * an order that can change between two requests. `id` is unique and never
 * reused, so it makes the sort total and the cursor exact.
 *
 * =============================================================================
 * A CURSOR IS NOT A CAPABILITY
 * =============================================================================
 * The cursor carries a position and nothing else. **Every scope, filter and
 * entitlement is re-derived from the actor and the arguments on every request**,
 * exactly as it is on the first page — so a cursor taken from one person's
 * `/purchases` and pasted into another's changes which rows are skipped and
 * cannot change which rows exist to be skipped. Do not ever put a coach id, a
 * status filter or an actor into one.
 *
 * The `scope` string guards against the milder failure: a cursor from the offer
 * browse used against the coach directory would decode to a keyset that means
 * nothing there. `decodeCursor` returns `null` for a mismatch, and `null` means
 * "start at the beginning" rather than an error — a hand-edited URL should show
 * page one, not a 500.
 */

/** Rows per page when a caller does not say. Tuned for a 3-column grid. */
export const DEFAULT_PAGE_SIZE = 24;

/**
 * The ceiling, applied to every request. It is the whole point of this file:
 * before it, a caller asking for a list got the entire table, and the only thing
 * standing between the product and a table scan was the seed being six rows.
 */
export const MAX_PAGE_SIZE = 100;

/** What a caller asks for. Both fields optional — omit it entirely for page one. */
export interface PageRequest {
  /** From the previous page's `nextCursor`. Anything unrecognised means page one. */
  cursor?: string | null;
  /** Clamped to `[1, MAX_PAGE_SIZE]`; non-integers and nonsense fall back to the default. */
  limit?: number;
}

/** What every unbounded read returns. */
export interface Page<T> {
  items: T[];
  /**
   * Pass back as `cursor` to get the next page. `null` means this was the last
   * one — computed by asking for one row more than requested and seeing whether
   * it arrived, so it is never a guess.
   */
  nextCursor: string | null;
  /**
   * Rows matching the filter, ignoring the cursor — what "137 offers" is
   * counted from, and what a queue's tab counts read.
   *
   * `null` when the backend could not produce one. Callers must render the
   * absence rather than printing 0: "no offers" and "we did not count" are
   * different sentences.
   */
  total: number | null;
}

/** The position half of a cursor: the ordering value, then the tie-break. */
export interface Keyset {
  /** The ordering column's value, as text. Timestamps are ISO-8601; numbers are decimal. */
  key: string;
  id: string;
}

/**
 * How one read is ordered, shared by both backends so they cannot drift.
 *
 * `scope` names the read, `column` names the SQL column, and `numeric` says
 * which comparison to use — Postgres compares an `integer` column numerically
 * and the mock compares JavaScript strings, so `'9'` and `'10'` order
 * differently in the two unless the mock is told.
 */
export interface KeysetSpec {
  scope: string;
  column: string;
  numeric?: boolean;
  /**
   * `'desc'` for every list in this product except the browse page's
   * cheapest-first sort. It flips BOTH halves of the keyset — the comparison and
   * the tie-break — because a half-flipped keyset silently returns the wrong
   * page rather than failing.
   */
  direction?: 'asc' | 'desc';
  /**
   * The unique column that breaks ties. `'id'` for everything except invites,
   * whose primary key is the CODE — `public.invites` has no `id` column at all,
   * and a keyset that named one would be a filter on nothing.
   *
   * `Keyset.id` still carries the value whatever the column is called; this is
   * only how the SQL side spells it.
   */
  tieBreak?: string;
}

/**
 * Every paginated read's ordering, in one table.
 *
 * WHY THEY LIVE TOGETHER rather than beside each method: the mock and the
 * Supabase client must sort and seek identically, and a spec written twice is a
 * spec that will differ once. Both import from here.
 *
 * The `scope` strings are also what stops a cursor being carried from one list
 * to another, so they must stay distinct — and stable, since a change invalidates
 * every cursor already in somebody's URL bar (which is harmless: they fall back
 * to page one).
 *
 * NOTE THE COLUMNS THAT ARE NOT `created_at`. `removed_reviews` is ordered by
 * when the removal happened, not by when the review was written, because that is
 * the order a moderation log is read in. Getting one of these wrong does not
 * fail — it produces a list whose "Next" skips rows.
 */
export const KEYSETS = {
  /** Browse, newest first — the default sort. */
  listings: { scope: 'listings', column: 'created_at' },
  /** Browse, cheapest first. The one ascending keyset in the product. */
  listingsPriceAsc: { scope: 'listings-price-asc', column: 'price_cents', numeric: true, direction: 'asc' },
  /** Browse, dearest first. */
  listingsPriceDesc: { scope: 'listings-price-desc', column: 'price_cents', numeric: true },
  /** A coach's public offer list. */
  coachListings: { scope: 'coach-listings', column: 'created_at' },
  /** A coach's own dashboard, withdrawn offers included. */
  myListings: { scope: 'my-listings', column: 'created_at' },
  /** Every offer of one coach, for an administrator. */
  adminListings: { scope: 'admin-listings', column: 'created_at' },
  /** The public coach directory. */
  coaches: { scope: 'coaches', column: 'created_at' },
  /** Coaches an administrator may act on. */
  adminCoaches: { scope: 'admin-coaches', column: 'created_at' },
  /** Reviews of one offer. */
  listingReviews: { scope: 'listing-reviews', column: 'created_at' },
  /** Reviews across one coach's whole account. */
  coachReviews: { scope: 'coach-reviews', column: 'created_at' },
  /** The moderation queue. */
  moderation: { scope: 'moderation', column: 'created_at' },
  /** The removal log — ordered by the REMOVAL, not by the review. */
  removedReviews: { scope: 'removed-reviews', column: 'removed_at' },
  /** A buyer's purchases. */
  myOrders: { scope: 'my-orders', column: 'created_at' },
  /** A coach's sales. */
  coachOrders: { scope: 'coach-orders', column: 'created_at' },
  /** One offer's edit history. */
  revisions: { scope: 'revisions', column: 'created_at' },
  /** A reporter's own reports. */
  myReports: { scope: 'my-reports', column: 'created_at' },
  /** The moderation queue for reports. */
  reports: { scope: 'reports', column: 'created_at' },
  /** The administrator audit log. */
  adminActions: { scope: 'admin-actions', column: 'created_at' },
  /** Invite codes. Keyed on the CODE, because `invites` has no `id` column. */
  invites: { scope: 'invites', column: 'created_at', tieBreak: 'code' },
  /** Coach applications. */
  applications: { scope: 'applications', column: 'created_at' },
} as const satisfies Record<string, KeysetSpec>;

/**
 * NUL. Not a character that can appear in a timestamp, a decimal number or a
 * UUID, so `split` can never find one inside a field rather than between two.
 */
const SEPARATOR = '\u0000';

/**
 * The three characters that carry meaning in PostgREST's `or=` grammar.
 *
 * `supabaseKeysetFilter` interpolates a cursor's two fields into that grammar,
 * and this is what makes the interpolation safe BY CONSTRUCTION rather than by
 * argument: a decoded cursor containing any of them is rejected as malformed
 * before it can reach a query. A dot is deliberately not here - timestamps carry
 * fractional seconds, and PostgREST splits a filter on its first two dots only.
 */
const UNSAFE_IN_FILTER = /[,()]/;

/**
 * Opaque, not secret.
 *
 * Everything inside is already in the caller's hands — it is the ordering value
 * and id of a row they were just shown. base64url is here so that a cursor is
 * one URL-safe token rather than two query parameters somebody is tempted to
 * hand-assemble, and so the key can change shape later without breaking a
 * bookmarked link in a way that looks like data corruption.
 */
export function encodeCursor(spec: KeysetSpec, keyset: Keyset): string {
  const raw = [spec.scope, keyset.key, keyset.id].join(SEPARATOR);
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * `null` for anything this read cannot use — absent, malformed, truncated, or
 * belonging to a different list. Never throws: a cursor arrives from a URL, and
 * a URL is user input.
 */
export function decodeCursor(spec: KeysetSpec, cursor: string | null | undefined): Keyset | null {
  if (typeof cursor !== 'string' || cursor === '') return null;

  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const parts = raw.split(SEPARATOR);
  if (parts.length !== 3) return null;

  const [scope, key, id] = parts;
  // A cursor from another list decodes cleanly and means nothing here.
  if (scope !== spec.scope) return null;
  if (key === '' || id === '') return null;
  // See `UNSAFE_IN_FILTER`. Rejecting here rather than escaping downstream keeps
  // the guarantee in one place that both backends pass through.
  if (UNSAFE_IN_FILTER.test(key) || UNSAFE_IN_FILTER.test(id)) return null;

  return { key, id };
}

/**
 * The requested size, clamped.
 *
 * A `limit` reaches this from a query string, so every hostile shape has to land
 * somewhere sensible: `0` and negatives would return nothing for ever, `1e9`
 * would be the table scan this file exists to prevent, and `NaN` would make
 * `.slice()` return an empty array with no error anywhere.
 */
export function normaliseLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  const whole = Math.floor(limit);
  if (whole < 1) return 1;
  if (whole > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return whole;
}

/** The empty page, for the many short-circuits that know there is nothing to read. */
export function emptyPage<T>(): Page<T> {
  return { items: [], nextCursor: null, total: 0 };
}

/**
 * A page before its rows have been projected.
 *
 * WHY THIS EXISTS AS A SEPARATE SHAPE: the cursor has to be built from the RAW
 * row, because the projection is usually narrower than the row it came from —
 * `PublicCoach` has no `created_at` and `PublicReview` has no `price_epoch`, on
 * purpose. Computing the cursor after projecting would mean either putting the
 * ordering column back into a projection that deliberately dropped it, or
 * ordering by something else. Both are worse than one extra type.
 *
 * The Supabase side also needs the split for a second reason: its projection is
 * asynchronous (a name lookup is another query), and the `+1` arithmetic must
 * happen before that so the extra row is never given a name it does not need.
 */
export interface Window<Row> {
  rows: Row[];
  nextCursor: string | null;
  total: number | null;
}

/**
 * Turns `limit + 1` fetched rows into a window.
 *
 * The extra row is the whole trick: if it arrived there is a next page, and the
 * cursor is built from the LAST ROW OF THIS PAGE rather than from the extra one,
 * because the next request asks for rows strictly after that position.
 */
export function windowOf<Row>(
  spec: KeysetSpec,
  fetched: readonly Row[],
  limit: number,
  keyOf: (row: Row) => Keyset,
  total: number | null,
): Window<Row> {
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched.slice();
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor: hasMore && last ? encodeCursor(spec, keyOf(last)) : null,
    total,
  };
}

/** `Window` -> `Page`, once the caller has projected the rows. */
export function pageOf<Row, Out>(window: Window<Row>, items: Out[]): Page<Out> {
  return { items, nextCursor: window.nextCursor, total: window.total };
}

/**
 * The mock's whole implementation of paging: seek past the cursor, take one row
 * more than asked for, and hand back a window.
 *
 * `sorted` must ALREADY be in the read's order — this seeks and slices, it does
 * not sort, because the order is the read's business and several of them are not
 * a plain `created_at desc` (see `KEYSETS`).
 */
export function sliceWindow<Row>(
  spec: KeysetSpec,
  sorted: readonly Row[],
  page: PageRequest | undefined,
  keyOf: (row: Row) => Keyset,
): Window<Row> {
  const limit = normaliseLimit(page?.limit);
  const cursor = decodeCursor(spec, page?.cursor);

  const after = cursor
    ? sorted.filter((row) => {
        const key = keyOf(row);
        return isAfterCursor(spec, cursor, key.key, key.id);
      })
    : sorted;

  // `total` counts everything matching the filter, IGNORING the cursor — it is
  // "137 offers", not "113 offers left".
  return windowOf(spec, after.slice(0, limit + 1), limit, keyOf, sorted.length);
}

/**
 * Every page of a read, concatenated.
 *
 * **For writers that must cover the whole set, never for rendering.** There are
 * exactly two callers and both are the same shape: withdraw every one of a
 * coach's offers before deleting or suspending them. `set_coach_status()` and
 * `delete_my_account()` both REFUSE while any offer is still on sale, so a
 * caller that walked only the first page would take twenty-four offers down and
 * then be told to take their offers off sale — having already half-emptied
 * somebody's shop.
 *
 * A page-sized read is the right answer everywhere a human is looking at the
 * result. This is for the places where "all of them" is the requirement.
 *
 * `maxPages` is a real limit, not a formality: it bounds the work a single
 * request can do, and it makes a cursor that fails to advance a thrown error
 * rather than a hang. Reaching it throws, because the caller's whole contract is
 * that it saw everything — silently returning a prefix would be the bug this
 * function exists to prevent.
 */
export async function drainAll<T>(
  fetchPage: (page: PageRequest) => Promise<Page<T>>,
  maxPages = 50,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;

  for (let visited = 0; visited < maxPages; visited += 1) {
    const page = await fetchPage({ cursor, limit: MAX_PAGE_SIZE });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }

  throw new Error(`drainAll: more than ${maxPages} pages — refusing to act on a partial list`);
}

/** The keyset almost every read uses: newest first, id as the tie-break. */
export function byCreatedAt<Row extends { created_at: string; id: string }>(row: Row): Keyset {
  return { key: row.created_at, id: row.id };
}

/**
 * The mock's half of the keyset: is `row` strictly after `cursor` in a
 * descending sort?
 *
 * Must agree exactly with the SQL predicate `supabaseKeysetFilter` builds, or
 * the two backends disagree about which row starts page two — a difference that
 * shows up as a duplicated or a skipped row, never as an error.
 */
export function isAfterCursor(spec: KeysetSpec, cursor: Keyset, key: string, id: string): boolean {
  const ascending = spec.direction === 'asc';

  if (spec.numeric) {
    const rowKey = Number(key);
    const cursorKey = Number(cursor.key);
    if (rowKey !== cursorKey) return ascending ? rowKey > cursorKey : rowKey < cursorKey;
  } else if (key !== cursor.key) {
    return ascending ? key > cursor.key : key < cursor.key;
  }

  // The tie-break follows the same direction. It has to: a descending list with
  // an ascending tie-break would revisit rows it had already shown whenever two
  // of them shared a key.
  return ascending ? id > cursor.id : id < cursor.id;
}

/**
 * The Supabase half: PostgREST's spelling of `(column, id) < (key, id)`.
 *
 * There is no row-value comparison in the query grammar, so it is written out —
 * strictly less on the ordering column, OR equal on it and strictly less on the
 * tie-break.
 *
 * The values are interpolated rather than parameterised because PostgREST's
 * `or=` takes a string. That is safe for these two and only these two: both come
 * from `decodeCursor`, which rejects any payload containing a comma or a
 * parenthesis — the characters that could break out of this grammar. **Do not
 * reuse this helper for a value that came straight from a caller.**
 */
export function supabaseKeysetFilter(spec: KeysetSpec, cursor: Keyset): string {
  const op = spec.direction === 'asc' ? 'gt' : 'lt';
  const tie = spec.tieBreak ?? 'id';
  return `${spec.column}.${op}.${cursor.key},and(${spec.column}.eq.${cursor.key},${tie}.${op}.${cursor.id})`;
}

/** The tie-break column, for the second `.order()` that has to match the filter. */
export function tieBreakColumn(spec: KeysetSpec): string {
  return spec.tieBreak ?? 'id';
}

/** `.order()`'s argument, so a caller cannot order one way and page the other. */
export function supabaseAscending(spec: KeysetSpec): boolean {
  return spec.direction === 'asc';
}
