import type { ReactNode } from 'react';

/**
 * Narrow, centred shell for the sign-in / sign-up pages.
 *
 * A route group `(auth)` — the parentheses keep it out of the URL, so these
 * pages stay at `/login` and `/signup`.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-md px-4 py-10 sm:py-14">{children}</div>;
}
