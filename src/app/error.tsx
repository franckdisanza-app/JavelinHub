'use client';

import { useEffect } from 'react';

import Link from 'next/link';

import { Button, linkButtonClass } from '@/components/ui/button';

/**
 * Last-resort boundary for genuinely unexpected errors.
 *
 * It is NOT where `DataError` should land. By the time an error reaches a
 * client error boundary, Next.js has serialised it: in a production build only
 * a `digest` survives, and the message is replaced with a generic string. So a
 * `forbidden` handled here would render as "something went wrong" to the user
 * and be untestable. Handle `DataError` where it is thrown instead —
 * `toFormState()` in Server Actions, `resolveDataError()` in Server Components
 * (see `src/lib/data-error.tsx`). Anything that gets this far is a bug.
 *
 * Error boundaries must be Client Components. `retry` re-runs the failed
 * segment (stable since Next 16.3); `reset` would only clear the boundary
 * without re-fetching.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // The server log is the only place the real stack exists in production.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-start px-4 py-16 sm:py-24">
      <p className="font-mono text-sm font-semibold text-danger">Error</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">Something went wrong</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        That is on us, not on you. Try again — if it keeps happening, the details are in the server log.
      </p>
      {error.digest ? (
        <p className="mt-3 text-xs text-faint">
          Reference: <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
      <div className="mt-7 flex flex-col gap-2 sm:flex-row">
        <Button onClick={retry}>Try again</Button>
        <Link href="/" className={linkButtonClass({ variant: 'secondary' })}>
          Go home
        </Link>
      </div>
    </div>
  );
}
