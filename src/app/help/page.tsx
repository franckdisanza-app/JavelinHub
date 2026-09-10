import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Fact } from '@/app/legal/legal-chrome';
import { Alert } from '@/components/ui';
import { LEGAL } from '@/lib/legal';

/**
 * =============================================================================
 * Help and contact.
 * =============================================================================
 *
 * WHY THIS PAGE EXISTS. Until it did, there was no route anywhere in the
 * product — no `/contact`, no `/help`, no FAQ — through which a person could
 * reach a human being. The footer offered four destinations and three legal
 * documents, and every one of those documents describes rights that are
 * exercised by getting in touch. A marketplace that takes money and cannot be
 * written to is one that cannot honour its own refund policy.
 *
 * IT IS NOT A FAQ, and that is deliberate. Invented questions age into lies.
 * Every section below is a route in this app or a fact in `src/lib/legal.ts`,
 * so the page is wrong only when the product changes underneath it — the same
 * property the legal drafts were written for.
 *
 * `noindex` UNTIL THERE IS AN ADDRESS, for the reason the legal pages carry the
 * same flag: a support page that ranks and then cannot be contacted is worse
 * than no support page, because it looks like an answer.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Help and contact',
  description:
    'How to get help with an order, report something wrong, manage your account, or reach JavelinHub.',
  robots: LEGAL.contactEmail === null ? { index: false, follow: false } : undefined,
};

/**
 * The contact address as something you can click, or the same red marker the
 * legal documents use when a fact is missing.
 *
 * `Fact` is imported from the legal chrome rather than copied, because two
 * markers that are meant to look identical and are defined in two places stop
 * being identical the first time one is touched.
 */
function ContactAddress() {
  const address = LEGAL.contactEmail;
  if (address === null) return <Fact name="contactEmail" />;

  return (
    <a
      href={`mailto:${address}`}
      className="underline decoration-line underline-offset-2 transition-colors hover:decoration-ink"
    >
      {address}
    </a>
  );
}

function HelpSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2
        id={id}
        className="font-display text-display-22 leading-[0.9] font-bold tracking-[0.005em] uppercase text-ink"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const INLINE_LINK = 'underline decoration-line underline-offset-2 transition-colors hover:decoration-ink';

export default function HelpPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-col gap-2 border-b border-line-strong pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Help and contact</h1>
        <p className="text-body-17 text-muted">
          Where to go for the thing you are trying to do, and how to reach us when none of it fits.
        </p>
      </header>

      {LEGAL.contactEmail === null ? (
        <div className="mt-6">
          <Alert tone="error" title="There is no contact address yet.">
            <p>
              Every route below is real and works. The address is not: set{' '}
              <code>contactEmail</code> in <code>src/lib/legal.ts</code> and the marker below, this
              banner and the <code>noindex</code> on this page all clear themselves.
            </p>
          </Alert>
        </div>
      ) : null}

      <article className="mt-10 flex max-w-[68ch] flex-col gap-8 text-body-17 leading-relaxed text-ink">
        <HelpSection id="contact" title="Writing to us">
          <p>
            Email <ContactAddress />. Tell us the email address on your account and, if it is about
            an order, the offer&rsquo;s title &mdash; those two together are enough to find anything.
          </p>
          <p className="text-body-15 text-muted">
            Please do not send passwords or card details. Nobody here will ever ask you for either.
          </p>
        </HelpSection>

        <HelpSection id="orders" title="A problem with something you claimed">
          <p>
            Everything you have claimed is at{' '}
            <Link href="/purchases" className={INLINE_LINK}>
              your purchases
            </Link>
            , and each one opens onto its own order page. What happens there depends on how the offer
            is delivered, which is shown on the offer before you claim it:
          </p>
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              <strong>Ready to download</strong> &mdash; the file is on the order page the moment you
              claim. If the download fails, reload the page: the link is minted fresh each time and
              expires quickly by design.
            </li>
            <li>
              <strong>Made for you</strong> &mdash; the coach delivers against your order. You can
              upload to the same page, which is how you send a video for review.
            </li>
          </ul>
          <p>
            If a coach has not delivered and is not answering, write to us with the offer title. We
            can see the order and whether anything was delivered against it.
          </p>
        </HelpSection>

        <HelpSection id="money" title="Refunds and payment">
          <p>
            <strong>Claiming is free while the pilot runs, and nothing is charged.</strong> There is
            no card on file and no payment to refund. When that changes, the{' '}
            <Link href="/legal/refunds" className={INLINE_LINK}>
              refund policy
            </Link>{' '}
            is what applies, and it distinguishes offers made for you from files supplied
            immediately, because consumer law does.
          </p>
        </HelpSection>

        <HelpSection id="reporting" title="Reporting a review or a coach">
          <p>There are controls for both, and they go to the same queue:</p>
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              <strong>A review</strong> &mdash; a coach can report a review of their own offer, from
              the review itself.
            </li>
            <li>
              <strong>A coach</strong> &mdash; anybody signed in can report a coach, from that
              coach&rsquo;s profile.
            </li>
          </ul>
          <p>
            Someone reads every report. Deciding a report is justified is a separate act from acting
            on it, so upholding a report about a review does not automatically delete the review, and
            upholding one about a coach does not automatically suspend them.
          </p>
        </HelpSection>

        <HelpSection id="account" title="Your account">
          <p>
            Your name, picture, email address and password are all at{' '}
            <Link href="/settings" className={INLINE_LINK}>
              settings
            </Link>
            , along with the way out. Two things worth knowing before you use them:
          </p>
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              Changing your email needs <strong>both</strong> addresses to confirm, so the change is
              not finished until you have clicked the link sent to each.
            </li>
            <li>
              Changing your password signs out every other session. That is deliberate, and it means
              your phone asking you to sign in again is not a fault.
            </li>
          </ul>
          <p>
            Locked out?{' '}
            <Link href="/forgot-password" className={INLINE_LINK}>
              Ask for a reset link
            </Link>
            . It lasts an hour and can be used once.
          </p>
        </HelpSection>

        <HelpSection id="coaching" title="Coaching on JavelinHub">
          <p>
            There are two ways to reach approved-coach status:{' '}
            <Link href="/coach/apply" className={INLINE_LINK}>
              apply
            </Link>{' '}
            and wait for a decision, or{' '}
            <Link href="/redeem" className={INLINE_LINK}>
              redeem an invite code
            </Link>{' '}
            if somebody has given you one. Only approved coaches can publish, and an application is
            read by a person.
          </p>
        </HelpSection>

        <HelpSection id="security" title="Reporting a security problem">
          <p>
            Email <ContactAddress /> with &ldquo;security&rdquo; in the subject line, and describe
            what you found and how to reproduce it. Please give us a chance to fix it before you tell
            anybody else.
          </p>
          <p className="text-body-15 text-muted">
            There is no bug bounty and no reward. We will not pursue anybody who reports a genuine
            finding in good faith and does not access, change or keep other people&rsquo;s data while
            doing it.
          </p>
        </HelpSection>
      </article>
    </div>
  );
}
