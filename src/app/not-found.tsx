import Link from 'next/link';

import { linkButtonClass } from '@/components/ui/button';

/**
 * Renders for an unknown URL, and for any `notFound()` call — including
 * `requireAdmin()` refusing a signed-in non-admin. The wording therefore has to
 * work for both "no such page" and "not for you", without confirming which.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-start px-4 py-16 sm:py-24">
      <p className="font-mono text-sm font-semibold text-brand">404</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">We couldn&rsquo;t find that page</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        The link may be out of date, or the page may not be available to your account. If you were expecting to see
        something here, try signing in with the right account.
      </p>
      <div className="mt-7 flex flex-col gap-2 sm:flex-row">
        <Link href="/offers" className={linkButtonClass({})}>
          Browse offers
        </Link>
        <Link href="/" className={linkButtonClass({ variant: 'secondary' })}>
          Go home
        </Link>
      </div>
    </div>
  );
}
