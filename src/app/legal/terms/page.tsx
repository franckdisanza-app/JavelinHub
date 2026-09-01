import type { Metadata } from 'next';
import Link from 'next/link';

import { Fact, LegalPage, LegalSection } from '@/app/legal/legal-chrome';
import { legalIsComplete } from '@/lib/legal';

/**
 * Terms of service.
 *
 * `noindex` UNTIL THE FACTS ARE FILLED IN. An unfinished legal page that Google
 * has indexed is worse than no page at all: it is quotable, it outlives the
 * edit that fixes it, and it is the version somebody will find when they go
 * looking for what they agreed to. `robots.ts` cannot express this — it is a
 * static list and this condition is computed — so it lives here.
 *
 * `force-dynamic` for the same reason `robots.ts` and `sitemap.ts` carry it:
 * `siteUrl()` throws in production when `NEXT_PUBLIC_SITE_URL` is unset, and a
 * build must not be the thing that asks.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Terms of service',
  robots: legalIsComplete() ? undefined : { index: false, follow: false },
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of service"
      summary="The agreement between you and the operator of JavelinHub, and between buyers and coaches."
    >
      <LegalSection id="who" title="Who you are contracting with">
        <p>
          JavelinHub is operated by <Fact name="legalName" />, a company registered in{' '}
          <Fact name="governingLaw" /> under number <Fact name="companyNumber" />, whose registered
          address is <Fact name="registeredAddress" />. In these terms &ldquo;we&rdquo; and
          &ldquo;us&rdquo; mean that company, and &ldquo;you&rdquo; means the person using the site.
        </p>
        <p>
          Notices under these terms should be sent to <Fact name="contactEmail" />.
        </p>
      </LegalSection>

      <LegalSection id="marketplace" title="What JavelinHub is, and what it is not">
        <p>
          JavelinHub is a marketplace. Coaches publish offers &mdash; training plans, video reviews
          and similar &mdash; and buyers claim them. <strong>The contract for an offer is between the
          buyer and the coach.</strong> We provide the platform, take payment, and pass the coach
          their share; we are not the supplier of the coaching itself and we do not verify that any
          particular plan is suitable for any particular athlete.
        </p>
        <p>
          Coaches are approved by an administrator before they may publish, either by redeeming an
          invite code or by an application being reviewed. Approval means we have looked at an
          application. It is not an endorsement, a qualification check, or a warranty about outcomes.
        </p>
      </LegalSection>

      <LegalSection id="safety" title="Coaching is physical activity, and that carries risk">
        <p>
          Throwing is a strength and power event. Following a plan you bought here can injure you,
          particularly if you have an existing condition, are returning from injury, or progress
          faster than the plan intends. You are responsible for deciding whether a plan is
          appropriate for you, and for seeking medical advice where that decision is not obvious.
        </p>
        <p>
          Nothing here is medical advice and no coach on this platform is providing medical
          treatment through it.
        </p>
      </LegalSection>

      <LegalSection id="accounts" title="Your account">
        <p>
          You must be able to form a binding contract to hold an account, and the details you give us
          must be accurate. You are responsible for what happens under your account while you are
          signed in. If you believe someone else has access, change your password immediately &mdash;
          doing so signs out every other session on the account.
        </p>
        <p>
          You can delete your account from your settings at any time. What that does, and what it
          deliberately does not do, is described in the{' '}
          <Link href="/legal/privacy" className="underline underline-offset-2">
            privacy notice
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="selling" title="If you sell">
        <p>
          You must own or be licensed to sell everything you publish, and you must be able to deliver
          what the offer describes. You keep ownership of your material; you grant us the licence we
          need to host it, show it on the site and deliver it to the buyer who claimed it, and
          nothing more.
        </p>
        <p>
          We retain <Fact name="platformFeePercent" />% of each sale. The rest is paid out to you on
          the schedule our payments provider operates. You are responsible for your own tax.
        </p>
        <p>
          An administrator may withdraw an offer, suspend a coach account or remove a review. Where
          an administrator withdraws an offer you cannot restore it yourself; that is deliberate.
          Every such action is recorded in an append-only log.
        </p>
      </LegalSection>

      <LegalSection id="buying" title="If you buy">
        <p>
          Claiming an offer creates an order at the price shown at that moment. That price is fixed
          on the order and does not change afterwards, even if the coach later edits the offer.
        </p>
        <p>
          Some offers are delivered immediately as a download; others are made for you, and the coach
          delivers against your order after you claim it. Which one an offer is, is shown before you
          claim. Refunds are covered by the{' '}
          <Link href="/legal/refunds" className="underline underline-offset-2">
            refund policy
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="reviews" title="Reviews">
        <p>
          You may review an offer you have bought, once. Reviews are published under your name.
        </p>
        <p>
          <strong>Nobody can edit a review after it is published</strong> &mdash; not the author, not
          the coach, and not an administrator. An administrator can remove one, which archives it
          first, and that is the only route by which a review can cease to exist. A coach may report
          a review about their own offer for an administrator to look at.
        </p>
      </LegalSection>

      <LegalSection id="acceptable" title="What you may not do">
        <p>
          Do not publish anything unlawful, misleading, or that infringes somebody else&rsquo;s
          rights. Do not impersonate anyone. Do not attempt to reach data that is not yours, probe
          the service for vulnerabilities without permission, or automate access in a way that
          degrades it for other people. Do not use the platform to arrange payment outside it in
          order to avoid our fee.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="Our liability">
        <p>
          We do not exclude liability for death or personal injury caused by our negligence, for
          fraud, or for anything else that cannot lawfully be excluded. Subject to that, we are not
          liable for the acts or omissions of coaches or buyers, for injury arising from following a
          plan bought here, or for indirect or consequential loss.
        </p>
        <p>
          Nothing in these terms affects your statutory rights as a consumer.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes, and ending the agreement">
        <p>
          We may change these terms; the date at the top of this page shows when they were last
          changed, and material changes will be notified to the email address on your account. You
          may stop using the service at any time. We may suspend or close an account that breaches
          these terms.
        </p>
        <p>
          These terms are governed by the law of <Fact name="governingLaw" />, and its courts have
          exclusive jurisdiction.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
