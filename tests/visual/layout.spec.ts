import { expect, test } from '@playwright/test';

/**
 * =============================================================================
 * The assertions the other two suites cannot make.
 * =============================================================================
 *
 * Read `playwright.config.ts` first for why this suite exists at all. In short:
 * `verify:pages` reads served HTML, so a CSS regression that reintroduced a
 * corner radius, shipped a shadow, or pushed a page sideways at 375px passes it
 * green. Everything below needs a laid-out DOM.
 *
 * **Public pages only.** Signing in would mean provisioning accounts, which is
 * `verify-pages.mts`'s job and which it already does properly with a seeded
 * throwaway store. Layout does not become a different problem behind a session,
 * and the pages that need a session share the same components and the same
 * container widths as these.
 */

/**
 * Every page a stranger can reach without a session.
 *
 * `/offers/[id]` and `/coaches/[id]` are deliberately absent: their ids come
 * from the seed and hard-coding one couples this suite to `store.ts`. The card
 * components they render are exercised through the two grids, and the detail
 * pages use the same container and the same primitives.
 */
const PUBLIC_PAGES = [
  '/',
  '/offers',
  '/coaches',
  '/login',
  '/signup',
  '/forgot-password',
  '/legal/terms',
  '/legal/privacy',
  '/legal/refunds',
] as const;

/**
 * THE 375px QUESTION, asked properly.
 *
 * `PROGRESS.md` names this as something the served-HTML suite "cannot see", and
 * it is the failure mode a component comment in `listing-card.tsx` already
 * predicts by name: a coach called `Aaaa…` (300 characters) pushing the page
 * sideways because a flex item refused to shrink. `min-w-0` is sprinkled
 * through the components to prevent exactly that, and until now nothing
 * checked whether it worked.
 *
 * The assertion is on `documentElement.scrollWidth` rather than on any
 * individual element, because the symptom is the page scrolling — an element
 * wider than the viewport inside its own `overflow-x: auto` container is
 * correct and common (`docs/` shows tables that way).
 *
 * A pixel of tolerance: sub-pixel layout rounding can produce 375.5 on a
 * perfectly correct page, and a suite that fails on rounding gets switched off.
 */
test.describe('no page scrolls sideways', () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path} fits its viewport`, async ({ page }) => {
      await page.goto(path);
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth, `${path} overflows horizontally`).toBeLessThanOrEqual(innerWidth + 1);
    });
  }
});

/**
 * =============================================================================
 * The brand's two absolute rules, as computed style.
 * =============================================================================
 *
 * Section 06 of the brand guidelines states both without qualification: **"No
 * shadows, ever"**, and there is no radius token because there is no radius.
 * `initials-avatar.tsx` lists the objects it applies to by name — "buttons,
 * cards, inputs, chips, avatars, video frames and the focus indicator alike".
 *
 * These have been enforced until now by a grep over the emitted CSS bundle,
 * which `globals.css` documents as unreliable in the worst way: **the dev
 * server's stylesheet is incremental and retains rules whose source has already
 * been edited away**, and that cost a reviewer three wrong attributions once
 * already. Reading `getComputedStyle` on the rendered page cannot be fooled
 * that way — it reports what is actually painted, whatever produced it.
 *
 * WHAT IS EXCLUDED, AND WHY EACH ONE:
 *   * `[data-nextjs-*]` and `nextjs-portal` — Next's dev overlay is not ours
 *     and does not ship.
 *   * elements inside `<svg>` — `rx`/`ry` on a rect is drawing, not a corner
 *     radius on a box, and the wordmark's own mark uses round line caps.
 *
 * The focus indicator is deliberately NOT excluded. Section 06 says it is
 * Sector Blue and never restyled per component, and an outline is not a shadow
 * — anything that ships a `box-shadow` to draw one is the regression this
 * catches. (`globals.css` records that the three-letter utility for it emits
 * exactly that, which is why its name is never written in a scanned file.)
 */
test.describe('brand section 06 — no radius, no shadows', () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path} paints no rounded corner and no shadow`, async ({ page }) => {
      await page.goto(path);

      const offenders = await page.evaluate(() => {
        const bad: Array<{ tag: string; cls: string; radius: string; shadow: string }> = [];

        for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
          if (el.closest('[data-nextjs-dialog-overlay], nextjs-portal, svg')) continue;

          const style = getComputedStyle(el);
          const radius = [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomLeftRadius,
            style.borderBottomRightRadius,
          ].find((value) => value !== '0px' && value !== '');
          const shadow = style.boxShadow !== 'none' && style.boxShadow !== '' ? style.boxShadow : undefined;

          if (radius || shadow) {
            bad.push({
              tag: el.tagName.toLowerCase(),
              cls: String(el.className).slice(0, 90),
              radius: radius ?? '-',
              shadow: shadow ?? '-',
            });
          }
        }
        return bad.slice(0, 10);
      });

      expect(offenders, `rounded corners or shadows on ${path}: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
    });
  }
});

/**
 * WCAG 2.5.5, which `button.tsx` is explicitly built around.
 *
 *   > `min-h-11` is 44px — the WCAG 2.5.5 / iOS touch-target floor. It lives
 *   > here in the primitive rather than at each call site so every consumer
 *   > inherits it; padding alone put 'md' at 41.6px, two pixels short
 *   > everywhere it was used.
 *
 * That comment records a real regression, caught by hand. This is the check
 * that would have caught it — and it measures the rendered box, so a call site
 * that overrides the primitive's height is caught too.
 *
 * TWO EXEMPTIONS, both the standard's own rather than conveniences.
 *
 * **Inline links.** 2.5.5 does not apply to "a target that is in a sentence or
 * block of text". `listing-card.tsx` relies on that for the coach byline and
 * explains at length why making it a flex box would be worse than the rule it
 * would satisfy — an inline-flex link inherits `min-width: auto` and refuses to
 * break a long unbroken name, which is how a 300-character coach name pushes a
 * 375px page sideways.
 *
 * **Visually hidden controls.** The skip link in `layout.tsx` is `sr-only`
 * until it takes focus, at which point `focus:not-sr-only` gives it real size
 * and real padding. Measured while hidden it is its padding box and nothing
 * else — 32x16, which this test found on its first run. Measuring a control in
 * the state where it cannot be pointed at is measuring nothing, so the filter
 * matches the `sr-only` SIGNATURE rather than a class name (a component may
 * hide something any way it likes): `clip-path: inset(50%)` in Tailwind v4, or
 * the legacy `clip: rect(0,0,0,0)`.
 */
test.describe('touch targets clear 44px', () => {
  for (const path of ['/offers', '/coaches', '/login', '/legal/terms'] as const) {
    test(`${path} has no standalone control under 44px`, async ({ page }) => {
      await page.goto(path);

      const small = await page.evaluate(() => {
        const bad: Array<{ text: string; h: number; w: number }> = [];

        for (const el of Array.from(document.querySelectorAll<HTMLElement>('a[href], button'))) {
          if (el.closest('[data-nextjs-dialog-overlay], nextjs-portal')) continue;
          // The 2.5.5 exception: a target inside running text.
          if (el.closest('p, li')) continue;
          // Visually hidden, e.g. the `sr-only` skip link before it is focused.
          // See the header: this is the `sr-only` signature, not a class check.
          //
          // BOTH SPELLINGS. Tailwind v4 implements `sr-only` with
          // `clip-path: inset(50%)`; v3 and hand-written versions use the legacy
          // `clip: rect(0,0,0,0)`. Checking only the legacy one is what this
          // test did on its second run, and it kept reporting the skip link as a
          // 32x16 target — measured while it was invisible.
          const style = getComputedStyle(el);
          if (style.clipPath === 'inset(50%)') continue;
          if (style.clip === 'rect(0px, 0px, 0px, 0px)') continue;

          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;

          if (box.height < 44 - 0.5) {
            bad.push({ text: (el.textContent ?? '').trim().slice(0, 40), h: Math.round(box.height), w: Math.round(box.width) });
          }
        }
        return bad.slice(0, 10);
      });

      expect(small, `controls under 44px on ${path}: ${JSON.stringify(small, null, 2)}`).toEqual([]);
    });
  }
});

/**
 * =============================================================================
 * The status codes, because a loading state can silently take them away.
 * =============================================================================
 *
 * This is here for one specific reason, recorded so it is not deleted as
 * duplication of `verify:pages`. A `loading.tsx` commits the response status
 * the moment its fallback renders, which is why Cache Components was measured
 * and backed out — and when the two browse loading states were added they were
 * written one directory too high, put a Suspense boundary over `/offers/[id]`,
 * and turned a withdrawn offer's 404 into a 200. `verify:pages` caught it.
 *
 * These assertions are the cheap sentinel in front of that class of mistake, at
 * the layer where it is caused: a real browser navigation, reading the real
 * response status. They overlap `verify:pages` deliberately and by two
 * assertions only.
 */
test.describe('streaming has not eaten the status codes', () => {
  test('an unknown offer is still a 404', async ({ page }) => {
    const response = await page.goto('/offers/00000000-0000-4000-8000-000000000000');
    expect(response?.status()).toBe(404);
  });

  test('an unknown coach is still a 404', async ({ page }) => {
    const response = await page.goto('/coaches/00000000-0000-4000-8000-000000000000');
    expect(response?.status()).toBe(404);
  });

  test('the two browse pages are 200 for a stranger', async ({ page }) => {
    for (const path of ['/offers', '/coaches'] as const) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} should be 200`).toBe(200);
    }
  });
});
