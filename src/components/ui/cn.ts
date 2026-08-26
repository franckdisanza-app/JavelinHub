/**
 * Tiny class-name joiner.
 *
 * Deliberately not `clsx` or `tailwind-merge`: this POC has no runtime
 * dependencies beyond Next and React, and every call site here passes plain
 * strings and conditionals. It does not de-duplicate conflicting Tailwind
 * classes, so pass overrides last and keep them non-overlapping.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
