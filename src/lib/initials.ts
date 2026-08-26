/**
 * Initials for a display name.
 *
 * Lives in `src/lib/` rather than beside the component that renders it, and the
 * reason is testability: `scripts/verify-authz.mts` is a plain Node ESM entry
 * point that cannot import a `.tsx` module, so a pure string function buried in
 * a React file is a function nothing can assert. This one has four documented
 * hazards and every one of them is now pinned.
 */

/**
 * First letter of the first word, plus first letter of the LAST word when there
 * is more than one. Uppercased.
 *
 * Four things it has to survive, all of which a 120-character free-text
 * `full_name` can produce:
 *
 *   * **an empty or whitespace-only name** — returns `''`, so the caller renders
 *     an empty tile rather than throwing;
 *   * **one word** — one letter, not a doubled one;
 *   * **more than two words** — first and LAST, so "Tomas Van Der Berg" is `TB`
 *     rather than `TV`; a middle name is not the family name;
 *   * **astral characters** — `Array.from` iterates CODE POINTS, so an emoji or
 *     any character outside the BMP yields one whole character. `name[0]` would
 *     yield half a surrogate pair, which renders as U+FFFD.
 *
 * `toUpperCase()` and NOT `toLocaleUpperCase()`, deliberately: the locale-aware
 * form is locale-sensitive (Turkish dotless ı), and this runs on the server
 * where the locale is the machine's — so the same name would produce a
 * different tile depending on where the page was rendered, inside a tree that
 * is then hydrated in the browser.
 */
export function initialsOf(fullName: string): string {
  const words = typeof fullName === 'string' ? fullName.trim().split(/\s+/).filter(Boolean) : [];
  if (words.length === 0) return '';
  const first = Array.from(words[0]!)[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1]!)[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}
