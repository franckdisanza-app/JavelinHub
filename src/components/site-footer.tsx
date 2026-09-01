import Link from 'next/link';

import { Wordmark } from '@/components/wordmark';

/*
 * The footer carries the mark a second time, which is the one place the brand
 * is *stated* rather than used (section 05: "the figure where the brand is
 * being stated, the line where something is being marked").
 *
 * It stays on White rather than inverting to Ink. Section 03 lists the footer
 * among the surfaces Ink may accent, but it permits rather than requires it,
 * and inverting here would cost more than it buys: the focus indicator is
 * Sector Blue and is never restyled per component (section 06), and Sector Blue
 * on Ink measures about 2:1 — an indicator nobody can see. Steel, which carries
 * this footer's meta copy, fails on Ink for the same reason. A light footer
 * keeps both at their documented contrast.
 *
 * (The word for that indicator is deliberately not the three-letter one: a bare
 * utility name in a `.tsx` comment compiles a real rule, and that one ships a
 * box-shadow into a brand whose section 06 says "No shadows, ever".)
 *
 * Type sits on section 04's scales: body 15 for the prose, display 22 for the
 * nav items — the same step and face the header nav uses, because they are the
 * same kind of thing. The sizes this file used to carry existed on none of the
 * three scales.
 */

/*
 * One class string, four links. `min-h-11` is the 44px target: these are
 * standalone nav links, so the WCAG 2.5.5 exception for links inside a sentence
 * does not cover them — phase 2 sized them for exactly this reason and the
 * height must survive.
 *
 * `font-bold` is load-bearing, not emphasis. Only 100 / 700 / 900 of the
 * display face are loaded, so text left at the inherited 400 has no face to
 * match and CSS font matching falls down to 100 — a hairline footer.
 */
const FOOTER_LINK =
  'inline-flex min-h-11 items-center font-display text-display-22 font-bold leading-none tracking-[0.005em] uppercase text-muted transition-colors hover:text-ink';

/*
 * The legal row. Body face at the smallest body step, underlined — these are
 * documents rather than destinations, and the underline is what says so. Still
 * `min-h-11`: they are standalone links, so WCAG 2.5.5's in-a-sentence
 * exception does not cover them either.
 */
const LEGAL_LINK =
  'inline-flex min-h-11 items-center text-body-15 text-muted underline decoration-line underline-offset-2 transition-colors hover:text-ink hover:decoration-ink';

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex flex-col gap-2">
          <Wordmark />
          <p className="max-w-sm text-body-15 text-muted">
            A local proof of concept. Accounts, offers, reviews and invite codes are demo data.
          </p>
        </div>
        {/*
          TWO NAVS, NOT ONE ROW OF EIGHT. The first four are places to go; the
          last three are documents you consult, and they are set at the body
          scale rather than the display one because a legal link that shouts as
          loudly as "Offers" is a legal link nobody believes is load-bearing.
          Stripe requires all three to be reachable from the site during Connect
          onboarding, so they are in the footer of every page rather than on a
          single page somewhere.
        */}
        <div className="flex flex-col gap-4 sm:items-end">
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6">
            <Link href="/offers" className={FOOTER_LINK}>
              Offers
            </Link>
            <Link href="/coaches" className={FOOTER_LINK}>
              Coaches
            </Link>
            <Link href="/coach/apply" className={FOOTER_LINK}>
              Become a coach
            </Link>
            <Link href="/redeem" className={FOOTER_LINK}>
              Redeem an invite
            </Link>
          </nav>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-1">
            <Link href="/legal/terms" className={LEGAL_LINK}>
              Terms
            </Link>
            <Link href="/legal/privacy" className={LEGAL_LINK}>
              Privacy
            </Link>
            <Link href="/legal/refunds" className={LEGAL_LINK}>
              Refunds
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
