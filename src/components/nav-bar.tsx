'use client';

/**
 * The header's interactive shell.
 *
 * This is the only Client Component in the app shell, and it receives nothing
 * but serialisable primitives — the signed-in user's *display name*, a role
 * label, and a list of `{ href, label }`. It never sees a `Profile` and it
 * never imports the data layer, which is what keeps `src/lib/data/**` (and the
 * emails it carries) out of the browser bundle entirely.
 *
 * Everything the user can actually *do* is still authorised server-side. These
 * links are presentation: hiding "Admin" from a learner is politeness, and
 * `requireAdmin()` plus the data layer's own role check are the enforcement.
 */

import { useEffect, useState } from 'react';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { InitialsAvatar } from '@/components/initials-avatar';
import { Badge } from '@/components/ui/badge';
import { Button, linkButtonClass } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Wordmark } from '@/components/wordmark';
import { logoutAction } from '@/lib/auth/actions';

export interface NavLink {
  href: string;
  label: string;
}

export interface NavBarProps {
  links: NavLink[];
  /** `null` when signed out. */
  userName: string | null;
  /** "Admin" / "Coach", or `null` for a plain learner. */
  roleLabel: string | null;
  /**
   * The signed-in user's picture, already cache-busted, or `null` for initials.
   *
   * The ONE place an avatar is visible to everybody who has one: a review
   * carries `author_name` and no picture, so without this a learner's upload
   * would render nowhere outside the form that made it.
   */
  avatarUrl?: string | null;
}

const MENU_ID = 'primary-navigation';

/*
 * Nav items, brand guidelines sections 04 and 06.
 *
 * Set in the display face: section 04's Barlow Condensed specimen lists its
 * jobs as "headlines, lockup, card titles, nav", and 22 is the bottom step of
 * the display scale (92 / 60 / 34 / 22). The face is extremely condensed, so 22
 * here occupies about the width 15px of a normal-width sans would.
 *
 * `font-bold` is not decoration and must not be dropped. Only 100, 700 and 900
 * are loaded — the lockup's two extremes plus the working display weight — so
 * an item left at the inherited 400 has no face to match. CSS font matching
 * then falls *down* to 100, and the nav renders as a hairline. Any display-face
 * text in this app has to name one of the three loaded weights.
 *
 * The current item is a transparent box with a 1px Sector Blue border and
 * Sector Blue letters — literally the chip construction section 06 specifies,
 * because v1.1 removed the soft-tint family from the palette and there is no
 * wash to sit on. That is what retired the transitional `brand-soft` tokens
 * from this file. Blue in the header does not spend the one-blue-per-screen
 * budget: section 03 scopes that rule to the content area and exempts chrome.
 *
 * Every item carries a `border`, transparent when it is not current, so making
 * an item current changes a colour and never a box size. No corner-radius
 * utility: section 06 states there is no radius token because there is no
 * radius, and the two that used to be on these items are gone.
 *
 * `min-h-11` is the 44px target. It is on the desktop row too — a laptop
 * trackpad is not a mouse, and the rule in this project has been a floor rather
 * than a mobile-only concession since phase 2.
 */
/*
 * THE ROW COLLAPSES TO THE MENU AT `lg`, NOT AT `md`, AND THAT IS MEASURED.
 *
 * These items are display type at 22px with no wrap protection, sitting in a
 * `justify-between` row beside the lockup, the signed-in name, a role chip and
 * a Log out button. At 768px with an administrator's six items there is not
 * enough room, and the failure mode is not a tidy overflow — the flex items
 * shrink below their content and the labels wrap ONE LETTER PER LINE:
 *
 *     768px, admin, before:  nav 266px tall, header 291px
 *                            ("Become a coach" alone = 266px tall)
 *     900px, admin, before:  nav  90px tall  — still wrapping
 *     1024px, admin:         nav  44px tall  — correct
 *
 * So the breakpoint was simply in the wrong place, and adding a sixth item made
 * an already-broken band worse rather than creating the problem. Raising it to
 * `lg` hands 768-1023px to the mobile panel, which is a column and cannot wrap
 * this way. Every `md:` in this component moved together — the desktop nav, the
 * desktop account block, the trigger button and the panel — because a mismatch
 * between any two of them shows both navs at once, or neither.
 *
 * MOVING THE BREAKPOINT WAS NOT SUFFICIENT ON ITS OWN, and the reason is worth
 * writing down because it is not obvious. A flex item's `min-width: auto` stops
 * it shrinking below its MIN-CONTENT width — but the min-content width of
 * wrappable text is its widest WORD. "Log out" therefore has a min-content of
 * about 34px ("out"), so at 1024px with an administrator's six nav items the
 * row compressed the Log out button to 34px wide and 113px tall: the same
 * letter-per-line failure, now in the account block instead of the nav.
 *
 * Three changes together, and all three are load-bearing:
 *
 *   1. `whitespace-nowrap` on the nav items and on the Log out button, so their
 *      min-content is the whole label and flex can no longer crush them;
 *   2. `shrink-0` on the account block, so it keeps its natural width;
 *   3. `flex-wrap` on the row, so that when the three children genuinely do not
 *      fit — an admin between roughly 1024 and 1200 — the row takes a SECOND
 *      LINE instead of overflowing the viewport horizontally.
 *
 * Without (3), (1) and (2) would simply trade a crushed button for a horizontal
 * scrollbar, which is the one outcome this project treats as a hard failure.
 *
 * WHAT THAT LEAVES, measured at 1024 / 1152 / 1280 with a clean seed:
 *
 *   signed out (4 items)      69px, one line
 *   approved coach (3 items)  69px, one line
 *   administrator (6 items)  125px, TWO lines
 *
 * The administrator case is the wrap doing its job, not a residual bug. The row
 * is capped at `max-w-6xl` (1152px), and six display-face items plus the lockup
 * plus the account block need about 1145px of content inside 1104px of usable
 * width — so it takes a second line at every desktop size rather than at some
 * of them. Every item is fully legible, nothing is crushed, and the page never
 * scrolls sideways. If a one-line admin header is ever wanted, the fix is to
 * move `Admin` / `Applications` out of the primary row, not to let the row
 * shrink its children again.
 */
const NAV_LINK =
  'inline-flex min-h-11 items-center border px-3 font-display text-display-22 font-bold tracking-[0.005em] whitespace-nowrap uppercase leading-none transition-colors';
const NAV_LINK_CURRENT = 'border-brand text-brand';
const NAV_LINK_REST = 'border-transparent text-muted hover:bg-surface-2 hover:text-ink';

export function NavBar({ links, userName, roleLabel, avatarUrl = null }: NavBarProps) {
  const pathname = usePathname();

  // The panel is open *for a particular route*. Storing the pathname rather
  // than a boolean means a navigation closes it for free, during render — no
  // effect that resets state, which React now flags as a cascading render, and
  // it covers back/forward too, which never fire a link's click handler.
  const [openForPath, setOpenForPath] = useState<string | null>(null);
  const open = openForPath !== null && openForPath === pathname;
  const setOpen = (next: boolean) => setOpenForPath(next ? pathname : null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenForPath(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  /**
   * LONGEST MATCH WINS, and a plain prefix test is not good enough any more.
   *
   * The old nav pair was `/browse` and `/listings/new`, which do not nest, so
   * `pathname === href || pathname.startsWith(href + '/')` marked exactly one
   * item. Moving the routes made `/offers/new` a CHILD of `/offers`, and that
   * test then marked BOTH: two `aria-current="page"` items in one nav — which
   * is invalid, since only one thing can be the current page — and two Sector
   * Blue chips lit at once.
   *
   * So a candidate has to beat every other link in the set, not merely match.
   * `/offers/new` matches `/offers` (length 7) and `/offers/new` (length 11);
   * only the longer one is current. Ties are impossible — two links with the
   * same href would be the same item.
   *
   * Computed once per render over the whole link set rather than per item,
   * because "am I current?" is not answerable by an item on its own.
   */
  const currentHref = links.reduce<string | null>((best, link) => {
    const matches = pathname === link.href || pathname.startsWith(`${link.href}/`);
    if (!matches) return best;
    return best === null || link.href.length > best.length ? link.href : best;
  }, null);

  const isCurrent = (href: string) => href === currentHref;

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        {/*
          The label is the product name and nothing else. Section 02's v1.1
          amendment fixes the lockup's accessible name as the single string
          `JavelinHub`, so the old "Javelin — home" is gone twice over: it was
          the wrong name, and it was the pre-rebrand one.

          It is stated rather than left to the text content, even though the
          content already computes to exactly `JavelinHub` (verified:
          `textContent` on this anchor is the mixed-case string, because the
          capitals are a `text-transform` and the two weight runs sit adjacent
          with no whitespace between them). Stating it means the name does not
          depend on a name-from-contents traversal, and it is one label on one
          element — not the two separately labelled elements the doc forbids.

          Corners square: section 06 says there is no radius token because there
          is no radius. This link used to carry a corner-radius utility.
        */}
        <Link href="/" aria-label="JavelinHub" className="inline-flex min-h-11 items-center">
          <Wordmark />
        </Link>

        {/* ---- Desktop ---- */}
        <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isCurrent(link.href) ? 'page' : undefined}
              className={cn(NAV_LINK, isCurrent(link.href) ? NAV_LINK_CURRENT : NAV_LINK_REST)}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden shrink-0 items-center gap-3 lg:flex">
          {userName ? (
            <>
              <span className="flex items-center gap-2 text-body-15">
                <InitialsAvatar name={userName} src={avatarUrl} size="sm" />
                <span className="max-w-[14ch] truncate font-medium text-ink" title={userName}>
                  {userName}
                </span>
                {roleLabel ? <Badge tone="brand">{roleLabel}</Badge> : null}
              </span>
              <LogoutForm />
            </>
          ) : (
            <>
              <Link href="/login" className={linkButtonClass({ variant: 'secondary', size: 'sm' })}>
                Log in
              </Link>
              <Link href="/signup" className={linkButtonClass({ size: 'sm' })}>
                Sign up
              </Link>
            </>
          )}
        </div>

        {/* ---- Mobile trigger ---- */}
        <Button
          variant="secondary"
          size="sm"
          // 44px minimum: below that a thumb misses it as often as it hits.
          className="min-h-11 min-w-11 lg:hidden"
          aria-expanded={open}
          aria-controls={MENU_ID}
          onClick={() => setOpen(!open)}
        >
          <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" className="h-5 w-5">
            {open ? (
              <path
                d="M5 5l10 10M15 5L5 15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            ) : (
              <path
                d="M3 6h14M3 10h14M3 14h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            )}
          </svg>
        </Button>
      </div>

      {/* ---- Mobile panel ---- */}
      <div id={MENU_ID} hidden={!open} className="border-t border-line bg-surface lg:hidden">
        <nav aria-label="Primary" className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              aria-current={isCurrent(link.href) ? 'page' : undefined}
              className={cn(
                NAV_LINK,
                'w-full',
                isCurrent(link.href) ? NAV_LINK_CURRENT : 'border-transparent text-ink hover:bg-surface-2',
              )}
            >
              {link.label}
            </Link>
          ))}

          <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
            {userName ? (
              <>
                <p className="flex items-center gap-2 px-3 text-body-15 text-muted">
                  <span>
                    Signed in as{' '}
                    {/* Truncated like the desktop copy at the top of this file — a
                        120-character name is a legal signup. */}
                    <span className="inline-block max-w-[18ch] truncate align-bottom font-medium text-ink" title={userName}>
                      {userName}
                    </span>
                  </span>
                  {roleLabel ? <Badge tone="brand">{roleLabel}</Badge> : null}
                </p>
                <LogoutForm fullWidth />
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className={linkButtonClass({ variant: 'secondary', fullWidth: true })}
                >
                  Log in
                </Link>
                <Link href="/signup" onClick={() => setOpen(false)} className={linkButtonClass({ fullWidth: true })}>
                  Sign up
                </Link>
              </>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}

/**
 * Logging out is a POST, never a link. A GET that destroys the session is
 * followed by link prefetchers and can be triggered from any other site with an
 * `<img>` tag.
 */
function LogoutForm({ fullWidth = false }: { fullWidth?: boolean }) {
  return (
    <form action={logoutAction} className={fullWidth ? 'w-full' : 'shrink-0'}>
      {/*
        `whitespace-nowrap` is not cosmetic here. A flex item may shrink to its
        MIN-CONTENT width, which for wrappable text is the widest word — "out",
        about 34px. In the desktop header row that produced a 34x113 button with
        one letter per line. See the long note at the top of this file.
      */}
      <Button
        type="submit"
        variant="secondary"
        size={fullWidth ? 'md' : 'sm'}
        fullWidth={fullWidth}
        className="whitespace-nowrap"
      >
        Log out
      </Button>
    </form>
  );
}
