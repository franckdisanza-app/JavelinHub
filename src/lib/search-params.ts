/**
 * Helpers for reading Next's `searchParams`, which hands back
 * `string | string[] | undefined` per key.
 */

/**
 * A search param may legitimately arrive repeated (`?q=a&q=b`); take the first
 * and ignore the rest.
 *
 * Shared rather than copied: browse and listing-detail both normalise params,
 * and two identical private copies of a rule like "take the first" drift apart
 * the moment one of them is tightened.
 */
export function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
