/**
 * Display formatting shared across the app.
 *
 * The locale, currency and time zone are all pinned, deliberately. A value
 * formatted with the server's locale and then re-rendered with the browser's is
 * the classic source of a React hydration warning, and this text appears on
 * pages that Client Components re-render after a form submit.
 */
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * The marketplace is single-currency for this proof of concept. It lives here,
 * once, so that making it per-listing later is a schema change plus one call
 * site rather than a hunt through the pages.
 */
const PRICE_FORMAT = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
});

/** A date only — "18 Aug 2026". Returns a safe placeholder for unparseable input. */
export function formatDate(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? 'an unknown date' : DATE_FORMAT.format(value);
}

/** Integer cents to display currency — `4500` becomes "£45.00". */
export function formatPrice(cents: number): string {
  if (!Number.isFinite(cents)) return '—';
  return PRICE_FORMAT.format(cents / 100);
}

/** A comma here may only separate thousands: `1,234` yes, `62,50` no. */
const THOUSANDS_GROUPED = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;

/** Plain decimal, at most two places, no sign and no exponent. */
const PLAIN_AMOUNT = /^\d+(\.\d{1,2})?$/;

/**
 * Parses what a human types into the integer cents the data layer demands.
 *
 * Returns `null` for anything it will not accept, so the caller can attach its
 * own message to the field. The data layer rejects `12.5`, `"1000"` and
 * negatives outright with `invalid`; converting here means the coach sees
 * "Enter a price like 45 or 45.00" instead of that.
 *
 * Comma placement is validated BEFORE the commas are stripped. Stripping first
 * silently accepts a decimal comma: `62,50` becomes `6250` and publishes
 * £6,250.00 instead of £62.50 — a hundredfold overcharge. There is no listing
 * edit or delete in this phase, so a price published that way cannot be
 * corrected by the coach at all.
 *
 * `Math.round` is load-bearing, not decoration: `1.15 * 100` is
 * `114.99999999999999` in binary floating point — as are 4.35, 8.20 and 16.08 —
 * and `Math.trunc` would quietly charge a penny less on every one of them.
 */
export function parsePriceToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^£/, '').trim();
  if (trimmed === '') return null;
  if (trimmed.includes(',') && !THOUSANDS_GROUPED.test(trimmed)) return null;

  const cleaned = trimmed.replace(/,/g, '');
  if (!PLAIN_AMOUNT.test(cleaned)) return null;

  const cents = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
