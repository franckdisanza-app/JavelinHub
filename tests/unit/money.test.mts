import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PRICE_CURRENCY, formatPrice, parsePriceToCents, priceAmount } from '@/lib/format';

/**
 * =============================================================================
 * Money in and money out.
 * =============================================================================
 *
 * `parsePriceToCents` is the only place a human's typing becomes a price, and
 * its own comment names two failures that were found by reasoning rather than
 * by a test:
 *
 *   * `62,50` — a decimal comma — became `6250` and published £6,250.00 for an
 *     offer meant to cost £62.50, a hundredfold overcharge;
 *   * `Math.trunc` instead of `Math.round` undercharged by a penny on every
 *     price whose float representation lands just below, of which 1.15, 4.35,
 *     8.20 and 16.08 are named examples.
 *
 * Both are asserted below. Neither is reachable from the other suites: one
 * never renders a form and the other reads served HTML, so a price that parsed
 * wrongly would simply be a different number in the markup, matching whatever
 * the code produced.
 */

describe('parsePriceToCents', () => {
  it('reads the ordinary spellings of a price', () => {
    assert.equal(parsePriceToCents('45'), 4500);
    assert.equal(parsePriceToCents('45.00'), 4500);
    assert.equal(parsePriceToCents('45.5'), 4550);
    assert.equal(parsePriceToCents('0'), 0);
    assert.equal(parsePriceToCents('0.99'), 99);
  });

  it('tolerates a leading pound sign and surrounding space', () => {
    assert.equal(parsePriceToCents('  £45.00  '), 4500);
    assert.equal(parsePriceToCents('£45'), 4500);
  });

  it('accepts thousands separators only where a thousands separator belongs', () => {
    assert.equal(parsePriceToCents('1,000'), 100_000);
    assert.equal(parsePriceToCents('1,234.56'), 123_456);
  });

  /**
   * THE HUNDREDFOLD OVERCHARGE. `62,50` is how most of Europe writes £62.50,
   * and stripping commas before validating their placement turns it into 6250.
   */
  it('refuses a decimal comma rather than reading it as thousands', () => {
    assert.equal(parsePriceToCents('62,50'), null);
    assert.equal(parsePriceToCents('1,00'), null);
    assert.equal(parsePriceToCents('12,3456'), null);
  });

  /**
   * THE PENNY. Each of these is a value whose float product with 100 lands
   * fractionally below the integer, so truncation would lose a penny per sale.
   */
  it('rounds rather than truncates the prices that float badly', () => {
    assert.equal(parsePriceToCents('1.15'), 115);
    assert.equal(parsePriceToCents('4.35'), 435);
    assert.equal(parsePriceToCents('8.20'), 820);
    assert.equal(parsePriceToCents('16.08'), 1608);
  });

  it('refuses more than two decimal places, so a third digit cannot be silently dropped', () => {
    assert.equal(parsePriceToCents('45.555'), null);
    assert.equal(parsePriceToCents('0.001'), null);
  });

  it('refuses what is not a plain positive decimal', () => {
    for (const value of ['', '   ', 'free', '-45', '+45', '4e2', '45.', '.45', '45p', '£', '1 000']) {
      assert.equal(parsePriceToCents(value), null, `accepted ${JSON.stringify(value)}`);
    }
  });

  it('refuses a number too large to be an exact integer of pence', () => {
    assert.equal(parsePriceToCents('999999999999999999'), null);
  });
});

describe('formatPrice', () => {
  it('renders integer pence as currency', () => {
    // A non-breaking space follows some currency symbols in some ICU versions,
    // so the assertion is on the digits and the symbol rather than on spacing.
    assert.match(formatPrice(4500), /£\s?45\.00/);
    assert.match(formatPrice(0), /£\s?0\.00/);
    assert.match(formatPrice(99), /£\s?0\.99/);
  });

  it('renders a placeholder rather than NaN for a non-finite value', () => {
    assert.equal(formatPrice(Number.NaN), '—');
    assert.equal(formatPrice(Number.POSITIVE_INFINITY), '—');
  });
});

describe('priceAmount', () => {
  /**
   * The machine-readable half, used only by the JSON-LD payload. It must carry
   * no symbol and no grouping: `schema.org/price` is a number, and a crawler
   * reading "£1,234.00" gets 1.
   */
  it('is a bare decimal with two places and no grouping', () => {
    assert.equal(priceAmount(4500), '45.00');
    assert.equal(priceAmount(0), '0.00');
    assert.equal(priceAmount(123_456), '1234.56');
    assert.equal(priceAmount(99), '0.99');
  });

  it('never emits NaN into structured data', () => {
    assert.equal(priceAmount(Number.NaN), '0.00');
  });

  /**
   * A true round trip, and note what it does NOT do: multiply by 100 in the
   * test. The first draft asserted `Number(priceAmount(cents)) * 100 === cents`
   * and failed on 1.15 with 114.99999999999999 — reproducing, inside the test,
   * the exact float defect the implementation uses `Math.round` to avoid. The
   * parser is the inverse, so the parser is what closes the loop.
   */
  it('round-trips through the parser it is the inverse of', () => {
    for (const typed of ['45', '45.00', '0.99', '1,234.56', '1.15', '8.20']) {
      const cents = parsePriceToCents(typed);
      assert.notEqual(cents, null, `${typed} did not parse`);
      assert.equal(parsePriceToCents(priceAmount(cents as number)), cents);
    }
  });
});

describe('PRICE_CURRENCY', () => {
  /**
   * One constant, one currency. The point of the assertion is not the value but
   * that there IS one exported value: the marketplace is single-currency, and
   * this is what a per-listing currency would have to replace.
   */
  it('is the single currency the marketplace prices in', () => {
    assert.equal(PRICE_CURRENCY, 'GBP');
  });
});
