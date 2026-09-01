'use client';

import { useEffect } from 'react';

import { Button, linkButtonClass } from '@/components/ui/button';

import './globals.css';

/**
 * =============================================================================
 * The boundary above the root layout.
 * =============================================================================
 *
 * `error.tsx` beside this file wraps a route SEGMENT — `loading.tsx`,
 * `not-found.tsx`, `page.tsx` and any nested layout. What it explicitly does
 * NOT wrap is the layout it sits next to, and in this app that is the one place
 * an error is most likely to come from: the root layout renders `<SiteHeader />`,
 * which resolves the signed-in profile through the data layer on every single
 * request. A backend that is unreachable, a schema that was never pushed, a
 * cookie naming a user who no longer exists — all of it runs there, above every
 * segment boundary in the app.
 *
 * Without this file that error falls through to the framework's own 500 page,
 * which is unstyled, says nothing, and offers nowhere to go.
 *
 * -----------------------------------------------------------------------------
 * IT REPLACES THE ROOT LAYOUT, SO IT OWNS THE DOCUMENT
 * -----------------------------------------------------------------------------
 * `<html>` and `<body>` are written here because there is no layout above this
 * one to provide them. Two consequences follow, and both are deliberate:
 *
 *   * **`globals.css` is imported directly.** The token system — every colour in
 *     this product — is defined in `:root` there, and that file says in as many
 *     words that nothing outside its palette block may write a colour literal.
 *     Importing the sheet is what lets this page keep that rule; hand-inlining
 *     nine hexes to avoid the import would break it.
 *
 *   * **The brand faces are NOT loaded.** `next/font` is called from the root
 *     layout, and this file is what stands in for that layout — so
 *     `--font-face-display` and its two siblings are undefined here. That is
 *     survivable rather than broken because every font token in `globals.css`
 *     carries a real fallback (`'Arial Narrow'`, Georgia, `ui-monospace`), so
 *     the page renders in the right shapes and the wrong faces. Calling
 *     `next/font` again from an error boundary would mean fetching a font in
 *     order to apologise for a failure that may itself have been a fetch.
 *
 * No `metadata` export: error boundaries are Client Components, where it is not
 * supported. React's `<title>` element is the documented substitute.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT REACH FOR
 * -----------------------------------------------------------------------------
 * No `<SiteHeader />` and no `<Wordmark />`: the header is the single most
 * likely thing to have just thrown, and the lockup carries an SVG this page
 * does not need. `Button` and `linkButtonClass` ARE imported, and the
 * distinction is not arbitrary — they render no data, take no props from the
 * failed tree and cannot themselves throw, whereas copying their class strings
 * here would leave two definitions of a button to drift apart.
 *
 * The escape hatch is a plain `<a>` rather than `next/link`. A router that
 * failed to render its own tree is not the thing to hand the recovery path to,
 * and a full page load is exactly what is wanted here.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // In production Next has already replaced the message with a generic string
    // and kept only the digest; the real stack exists solely in the server log,
    // where `instrumentation.ts` writes one searchable JSON line for it.
    console.error(error);
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-bg font-body text-ink">
        <title>Something went wrong · JavelinHub</title>
        <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start px-4 py-16 sm:py-24">
          {/* The name in text, at the smallest display step. The full lockup is
              not used because its mark may not render below 26px and this page
              wants a quiet mastnote, not a logo. */}
          <p className="font-display text-display-22 leading-none tracking-[0.005em] uppercase text-ink">
            <span className="font-thin">Javelin</span>
            <span className="font-black">Hub</span>
          </p>

          <p className="mt-10 font-mono text-sm font-semibold text-danger">Error</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            The page could not be loaded
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Something failed before the page could be built, and it is not something you did. Try again — if it
            keeps happening, the details are in the server log.
          </p>

          {error.digest ? (
            <p className="mt-3 text-xs text-faint">
              Reference: <code className="font-mono">{error.digest}</code>
            </p>
          ) : null}

          <div className="mt-7 flex flex-col gap-2 sm:flex-row">
            {/* `retry()` re-runs the failed tree. It is offered first because a
                render that failed on an unreachable backend often succeeds on
                the next attempt, and the alternative costs the user their page. */}
            <Button type="button" onClick={() => retry()}>
              Try again
            </Button>
            {/*
              A plain anchor, and the lint rule that wants `next/link` here is
              wrong for this one file. `global-error` stands in for the root
              layout, so the router's tree is the thing that just failed; a
              client-side navigation would re-enter it and can land straight
              back on this page. A document request rebuilds everything from
              scratch, which is the only recovery worth offering.
            */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className={linkButtonClass({ variant: 'secondary' })}>
              Go home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
