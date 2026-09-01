import { defineConfig, devices } from '@playwright/test';

/**
 * =============================================================================
 * The third suite — the one that looks at a laid-out page.
 * =============================================================================
 *
 * `PROGRESS.md` states the gap this exists to close, and states it in capitals:
 *
 *   > ⚠️ NOBODY HAS VISUALLY LOOKED AT ANY OF THESE PAGES
 *   > `verify:pages` reads **served HTML, not a laid-out DOM**, so it cannot see
 *   > computed style, geometry, or 375px overflow, so **a CSS regression that
 *   > changed a colour or reintroduced a corner radius would pass it.**
 *
 * That sentence is the specification for this file. These tests assert only
 * things the other two suites are structurally incapable of seeing — geometry,
 * computed style and viewport behaviour. **Nothing here re-tests authorization
 * or content**: `verify:authz` owns the first with 1,210 assertions and
 * `verify:pages` owns the second with 396, and duplicating either would mean
 * two places to update and one of them going stale.
 *
 * -----------------------------------------------------------------------------
 * IT RUNS AGAINST A THROWAWAY MOCK STORE, LIKE `verify:pages`
 * -----------------------------------------------------------------------------
 * `DATA_BACKEND=mock` and a `MOCK_DB_PATH` under the OS temp directory, so this
 * never touches `data/db.json` and never reaches the live database. The store
 * seeds itself on the first request, which is enough: these tests need a page
 * with cards on it, not a particular row.
 *
 * `SESSION_SECRET` is a throwaway that signs nothing outliving the run, exactly
 * as `verify.yml` passes one to the CI build.
 *
 * -----------------------------------------------------------------------------
 * `next dev`, NOT `next build && next start`
 * -----------------------------------------------------------------------------
 * A production build takes about as long as the whole suite runs, and none of
 * these assertions is about production output: Tailwind emits the same computed
 * styles either way, and the geometry is the geometry. `reuseExistingServer`
 * means a developer with `npm run dev` already up pays nothing at all.
 *
 * The port is fixed rather than chosen, which is the one thing this gives up
 * against `verify-pages.mts` — Playwright needs a `baseURL` before the server
 * starts. 3100 is deliberately not 3000, so it cannot collide with a dev server
 * somebody is looking at.
 */

const PORT = 3100;

export default defineConfig({
  testDir: './tests/visual',
  // No `fullyParallel`: one dev server, and these tests are cheap. Parallel
  // workers against a single Next dev process mostly measure compilation.
  workers: 1,
  // A failing geometry assertion is a real failure, not a flake. Retrying would
  // only hide an intermittent layout bug, which is the kind worth keeping.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // On failure only — a passing run of a suite that exists to watch layout
    // should not fill a CI artifact store with identical screenshots.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    /*
     * The two viewports the brand guidelines and the WCAG target size are
     * argued about at. 375 is the width every "does it overflow" question is
     * really about; 1280 is where the three-column grid exists at all.
     *
     * BOTH ARE CHROMIUM, and the mobile one is a viewport rather than
     * `devices['iPhone SE']`. That preset carries
     * `defaultBrowserType: 'webkit'`, which means a second browser engine to
     * download in CI and on every contributor's machine — for a suite whose
     * assertions are about layout width, computed radius and box height, none
     * of which is engine-specific. Cross-engine rendering is a real thing to
     * test and this is not the suite that tests it; pretending otherwise costs
     * ~90s of install per run for no assertion.
     */
    {
      name: 'mobile-375',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: false },
    },
    { name: 'desktop-1280', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
  ],

  webServer: {
    command: 'npm run dev',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    // Next's first compile of a route is slow and this suite visits several.
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      DATA_BACKEND: 'mock',
      MOCK_DB_PATH: './.playwright-store.json',
      SESSION_SECRET: 'playwright-throwaway-session-secret',
      SEED_ADMIN_PASSWORD: 'playwright-throwaway-admin-password',
    },
  },
});
