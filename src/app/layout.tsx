import type { Metadata } from 'next';
import { Barlow_Condensed, IBM_Plex_Mono, Newsreader } from 'next/font/google';

import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

import './globals.css';

/*
 * The three brand faces (guidelines section 04). Each is exposed as a CSS
 * variable rather than a class so `globals.css` can compose it into the
 * `--font-display` / `--font-body` / `--font-mono` theme tokens, and components
 * pick a face with `font-display` / `font-mono` instead of importing anything.
 *
 * The display face is Barlow Condensed; the note on it below explains why it is
 * not the Big Shoulders the first draft of the brand called for.
 */

/*
 * Barlow Condensed carries the lockup, and the weight list is the mark itself:
 * 100 for JAVELIN and 900 for HUB — the run-up against the release. 700 is the
 * working display weight for card titles and section heads. Nothing else is
 * loaded, because every extra cut is a file a thrower waits for.
 *
 * This family replaced Big Shoulders, which could not be made to work. Google
 * retired `Big Shoulders Display` and consolidated it into `Big Shoulders`, and
 * Next's two databases disagree about that rename: the font catalogue knows
 * only the new name, while `capsize-font-metrics.json` still keys the old one
 * (`bigShouldersDisplay` is present, `bigShoulders` is absent). So the family
 * could be *fetched* but never *measured* — next/font emitted "Failed to find
 * font override values" on every compile and skipped generating the
 * metric-matched fallback that stops text reflowing on swap. There was no
 * spelling that satisfied both databases.
 *
 * Barlow Condensed is in the metrics table, so the fallback is generated
 * normally and no override is needed here. If this family is ever changed,
 * check `capsize-font-metrics.json` for its camelCased key first.
 */
const barlowCondensed = Barlow_Condensed({
  variable: '--font-face-display',
  subsets: ['latin'],
  weight: ['100', '700', '900'],
});

/* The body face. Loaded variable with italics — coach bios and plan
 * descriptions are the reading surface of this product. */
const newsreader = Newsreader({
  variable: '--font-face-body',
  subsets: ['latin'],
  weight: 'variable',
  style: ['normal', 'italic'],
});

/* Anything measured: distances, timestamps, labels, buttons, tags. No variable
 * cut exists for this family, so the three weights the brand uses are listed. */
const plexMono = IBM_Plex_Mono({
  variable: '--font-face-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

/*
 * The product name is one word, two weights, and never spaced: JavelinHub.
 * Titles, the title template and the Open Graph card all carry it in full — a
 * bare "Javelin" is the sport, not the product, and the two have to stay
 * distinguishable in a browser tab and in a shared link alike.
 *
 * The icon is not declared here. `src/app/icon.svg` is the App Router file
 * convention, and Next emits the `<link rel="icon">` tag from it; naming it in
 * this object as well would ship the same icon twice. The default
 * `favicon.ico` that came with the scaffold has been deleted — it was the Next
 * logo, and nothing in this app should show someone else's mark.
 *
 * No exclamation marks, no "unlock your potential" — section 07. The
 * description says what the product does and stops.
 */
const TITLE = 'JavelinHub — coaching and video review for throwers';
const DESCRIPTION =
  'JavelinHub connects throwers with the coaches who can help. Browse coaches, browse the offers they publish, or apply to coach.';

export const metadata: Metadata = {
  title: {
    default: TITLE,
    template: '%s · JavelinHub',
  },
  description: DESCRIPTION,
  applicationName: 'JavelinHub',
  openGraph: {
    type: 'website',
    siteName: 'JavelinHub',
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${barlowCondensed.variable} ${newsreader.variable} ${plexMono.variable} h-full antialiased`}
    >
      {/* `font-body` is what actually sets Newsreader on the page. globals.css
          deliberately leaves `font-family` off its `body` rule so this token is
          the only definition of the body stack. */}
      <body className="flex min-h-full flex-col bg-bg font-body text-ink">
        <a
          href="#main"
          className="sr-only bg-brand px-4 py-2 font-mono text-mono-12 tracking-[0.1em] uppercase text-brand-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        {/* Renders the signed-in user; resolved fresh from the data layer per request. */}
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
