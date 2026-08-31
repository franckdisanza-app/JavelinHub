import Link from 'next/link';

import { cn } from '@/components/ui/cn';

/**
 * The row of administrator surfaces, on every one of them.
 *
 * WHY THIS EXISTS: the site header carries at most a couple of admin entries
 * before it stops fitting on the 1024px row it is designed around, and there
 * are now five of these pages. Before this component, each page ended with a
 * hand-written sentence naming "the other two admin surfaces" — prose that was
 * already wrong the moment a third arrived, and wrong in the quiet way where
 * nothing breaks and a page simply becomes unreachable.
 *
 * A server component with no state: the current page is passed in rather than
 * read from `usePathname()`, so this stays out of the client bundle and every
 * admin page keeps rendering entirely on the server.
 */
export type AdminSurface = 'invites' | 'applications' | 'reviews' | 'reports' | 'coaches';

const SURFACES: { key: AdminSurface; href: string; label: string }[] = [
  { key: 'reports', href: '/admin/reports', label: 'Reports' },
  { key: 'applications', href: '/admin/applications', label: 'Applications' },
  { key: 'coaches', href: '/admin/coaches', label: 'Coaches' },
  { key: 'reviews', href: '/admin/reviews', label: 'Reviews' },
  { key: 'invites', href: '/admin/invites', label: 'Invites' },
];

export function AdminNav({ current }: { current: AdminSurface }) {
  return (
    <nav aria-label="Administrator sections" className="mt-5 flex flex-wrap gap-2">
      {SURFACES.map((surface) => {
        const active = surface.key === current;
        return (
          <Link
            key={surface.key}
            href={surface.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // Square, like the application filter tabs it sits above. Section
              // 06: there is no radius token because there is no radius.
              'inline-flex min-h-11 items-center border px-3.5 text-sm font-medium transition-colors',
              active
                ? 'border-transparent bg-brand-soft text-brand-soft-ink'
                : 'border-line-strong bg-surface text-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            {surface.label}
          </Link>
        );
      })}
    </nav>
  );
}
