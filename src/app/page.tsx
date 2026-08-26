import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { linkButtonClass } from '@/components/ui/button';
import { getCurrentProfile } from '@/lib/auth/session';

/**
 * The landing page.
 *
 * -----------------------------------------------------------------------------
 * TWO ENTRY POINTS, ONE SECTOR BLUE
 * -----------------------------------------------------------------------------
 * There are now two ways in — browse the offers, or browse the coaches — and
 * section 03 allows exactly ONE Sector Blue element per screen in the content
 * area ("if a page body has two blue buttons, one of them isn't the primary
 * action"). The mark and the persistent chrome are exempt; these are not.
 *
 * **Browse coaches is the blue one.** The headline directly above it says "Find
 * a coach who has done the thing you are trying to do", and the primary action
 * has to be the one the sentence just asked for — a hero whose words name a
 * person and whose blue button opens a catalogue of plans is two pages arguing.
 * It is also the better answer for the visitor this page is written for: a
 * thrower who does not yet know which of eight plan types they need is served
 * by people first and by inventory second. Browse offers sits beside it as the
 * ghost variant, which is the doc's own secondary.
 *
 * Two consequences, both of which were live violations before this round and
 * are fixed here rather than left for a later type sweep:
 *
 *   * the hero eyebrow chip was `tone="brand"` — a second blue element, and an
 *     eyebrow is meta, not an action. It is Steel now.
 *   * the "Log in" link was Sector Blue — a third. A link inside a sentence is
 *     not the primary action of a screen; it is Ink, underlined.
 *
 * -----------------------------------------------------------------------------
 * F6 — copy that had become false
 * -----------------------------------------------------------------------------
 * This page claimed "Browse sessions by sport and price" and "Filter by sport
 * or discipline", and the taxonomy round removed the sport axis entirely: there
 * is one sport, and the filter is a fixed eight-category taxonomy. Those lines
 * described a control that does not exist. They now describe the one that does.
 */
export default async function HomePage() {
  const profile = await getCurrentProfile();
  const isApprovedCoach = profile?.coach_status === 'approved';

  return (
    <>
      {/* ---------------------------------------------------------------- Hero */}
      <section className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <div className="max-w-2xl">
            {/* Steel, not brand: see the one-blue note above. */}
            <Badge tone="neutral">Coaching marketplace</Badge>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-ink sm:text-5xl">
              Find a coach who has done the thing you are trying to do.
            </h1>
            <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
              JavelinHub connects throwers with coaches who have been vetted before they can sell
              anything. Read what a coach actually offers, what they have been rated, and what their
              buyers said — then start with the person or with the plan, whichever you already know.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {/* The one Sector Blue element in this page's content area. */}
              <Link href="/coaches" className={linkButtonClass({ size: 'lg' })}>
                Browse coaches
              </Link>
              <Link href="/offers" className={linkButtonClass({ variant: 'secondary', size: 'lg' })}>
                Browse offers
              </Link>
            </div>

            {/*
              `min-h-11` on the STANDALONE links below is the 44px target, and
              it is not optional here. WCAG 2.5.5's exception covers "a link
              inside a sentence"; each of these is the entire content of its own
              paragraph, so the exception does not reach them — measured at
              128x14 before this was added. The "Log in" link two lines down
              sits inside a sentence and is genuinely exempt.
            */}
            <div className="mt-5 flex flex-col gap-1 text-sm text-muted">
              {profile ? (
                <>
                  <p>
                    Signed in as <span className="font-medium text-ink">{profile.full_name}</span>.
                  </p>
                  <p>
                    {isApprovedCoach ? (
                      <Link href="/offers/new" className="inline-flex min-h-11 items-center font-medium text-ink underline underline-offset-2">
                        Publish an offer
                      </Link>
                    ) : (
                      <Link href="/coach/apply" className="inline-flex min-h-11 items-center font-medium text-ink underline underline-offset-2">
                        Become a coach
                      </Link>
                    )}
                  </p>
                </>
              ) : (
                <>
                  <p>
                    Already have an account?{' '}
                    {/* Ink, not blue — see the one-blue note above. */}
                    <Link href="/login" className="font-medium text-ink underline underline-offset-2">
                      Log in
                    </Link>
                    .
                  </p>
                  <p>
                    <Link href="/signup" className="inline-flex min-h-11 items-center font-medium text-ink underline underline-offset-2">
                      Create a free account
                    </Link>
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- For learners */}
      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <h2 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">How it works</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Three steps, no subscription, no algorithmic feed.
        </p>

        <ol className="mt-6 grid gap-4 sm:grid-cols-3">
          {[
            {
              step: '1',
              title: 'Start with a coach or a plan',
              body: 'Browse coaches and read their profiles, or search offer titles and descriptions and filter by category — training plan, video review, mobility, and five more.',
            },
            {
              step: '2',
              title: 'Compare real offers',
              body: 'Every offer shows its price up front and the name of the coach behind it, alongside what that coach has been rated across everything they sell.',
            },
            {
              step: '3',
              title: 'Work with your coach',
              body: 'Pick the session that fits, and take it from there. JavelinHub gets out of the way once you have found each other.',
            },
          ].map((item) => (
            <li key={item.step}>
              <Card className="h-full">
                <CardBody>
                  {/*
                    A square Ink-ruled box with an Ink mono numeral, not a blue
                    circle. Two brand rules met at once: section 06 states there
                    is no radius token because there is no radius (this element
                    previously carried a full corner-radius utility, whose name
                    is deliberately not written here — naming it in a comment
                    compiles it straight back into the stylesheet, which is the
                    hazard globals.css documents), and section 03 caps Sector
                    Blue at one element per screen in the content area, where
                    three blue numerals spent the budget three times over. That
                    retires one of the two remaining `brand-soft` call sites
                    globals.css marks for deletion.
                  */}
                  <span
                    aria-hidden="true"
                    className="inline-flex h-8 w-8 items-center justify-center border border-ink font-mono text-mono-13 font-medium text-ink"
                  >
                    {item.step}
                  </span>
                  <h3 className="mt-3 font-semibold text-ink">{item.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
                </CardBody>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      {/* --------------------------------------------------------- For coaches */}
      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Coaching on JavelinHub</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted sm:text-base">
              Nobody can publish an offer, or appear in the coach directory, until they are an
              approved coach. There are exactly two ways to get there, and both end in the same
              place.
            </p>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Card tone="raised">
              <CardBody className="flex h-full flex-col">
                <Badge tone="success">Instant</Badge>
                <h3 className="mt-3 text-lg font-semibold text-ink">Redeem an invite code</h3>
                <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted">
                  Coaches we have already spoken to get a one-use code from an administrator. Redeeming it approves you
                  on the spot — no queue, no second review.
                </p>
                <div className="mt-5">
                  <Link href="/redeem" className={linkButtonClass({ variant: 'secondary' })}>
                    I have a code
                  </Link>
                </div>
              </CardBody>
            </Card>

            <Card tone="raised">
              <CardBody className="flex h-full flex-col">
                <Badge tone="neutral">Reviewed</Badge>
                <h3 className="mt-3 text-lg font-semibold text-ink">Apply to coach</h3>
                <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted">
                  Tell us your background and what you would coach. An administrator reads every
                  application and approves or declines it. If you are approved, what you wrote about
                  yourself becomes the first draft of your public profile.
                </p>
                <div className="mt-5">
                  <Link href="/coach/apply" className={linkButtonClass({ variant: 'secondary' })}>
                    Start an application
                  </Link>
                </div>
              </CardBody>
            </Card>
          </div>
        </div>
      </section>
    </>
  );
}
