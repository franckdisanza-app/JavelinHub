import type { Metadata } from 'next';
import Link from 'next/link';

import { Fact, LegalPage, LegalSection } from '@/app/legal/legal-chrome';
import { legalIsComplete } from '@/lib/legal';

/**
 * The refund policy.
 *
 * THE HARD PART HERE IS THE INTERACTION WITH CONSUMER LAW, and it is why this
 * document has to know about `fulfilment`. Under UK/EU distance-selling rules a
 * consumer normally has 14 days to cancel — but for digital content supplied
 * immediately, that right can be waived, and the waiver has to be taken
 * expressly and acknowledged at the point of purchase.
 *
 * `fulfilment = 'instant'` is precisely that case and `fulfilment =
 * 'personalised'` is precisely not. So the two modes get different paragraphs
 * rather than one hedged one, and the instant path is the one that needs a
 * checkbox on the checkout page. That checkbox is a **gap**, not an oversight:
 * see the note in the last section.
 *
 * See `terms/page.tsx` for why this is `noindex` until `LEGAL` is filled in.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Refund policy',
  robots: legalIsComplete() ? undefined : { index: false, follow: false },
};

export default function RefundsPage() {
  return (
    <LegalPage
      title="Refund policy"
      summary="When you can get your money back, how to ask, and what the two delivery modes change."
    >
      <LegalSection id="statutory" title="Your statutory rights come first">
        <p>
          Nothing on this page reduces the rights you have by law. If an offer is not as described,
          not delivered, or not of satisfactory quality, you are entitled to a remedy regardless of
          anything below.
        </p>
      </LegalSection>

      <LegalSection id="window" title="The window">
        <p>
          You have <Fact name="refundWindowDays" /> days from the date of your order to request a
          refund, subject to the two cases below.
        </p>
      </LegalSection>

      <LegalSection id="personalised" title="Offers made for you">
        <p>
          Most offers on JavelinHub are personalised: you claim, the coach works, and they deliver
          against your order. For these:
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>
            <strong>Before the coach has delivered anything</strong> &mdash; a full refund, no reason
            needed.
          </li>
          <li>
            <strong>After delivery</strong> &mdash; a refund if what you received does not match what
            the offer described, or was not delivered within a reasonable time. Because the work was
            made for you specifically, we will not normally refund simply because you changed your
            mind after receiving it.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="instant" title="Instant downloads">
        <p>
          Some offers are a file you download the moment you claim. The offer page tells you which
          kind you are buying before you claim it.
        </p>
        <p>
          For these, you are asked at checkout to agree that delivery begins immediately and to
          acknowledge that you lose the 14-day right to cancel once the download is available. That
          is a choice you make explicitly, and it is why the acknowledgement is a separate step
          rather than buried in these terms.
        </p>
        <p>
          You are still entitled to a refund if the file is faulty, is not what the offer described,
          or does not work.
        </p>
      </LegalSection>

      <LegalSection id="how" title="How to ask">
        <p>
          Write to <Fact name="contactEmail" /> with your order reference, which is on the order page
          under{' '}
          <Link href="/purchases" className="underline underline-offset-2">
            your purchases
          </Link>
          . Tell us what happened. We will usually speak to the coach before deciding, and we will
          tell you the outcome and the reason for it.
        </p>
        <p>
          Where a refund is due it goes back to the original payment method. The coach&rsquo;s share
          is reversed with it.
        </p>
      </LegalSection>

      <LegalSection id="coaches" title="If you are a coach">
        <p>
          A refund reverses your share of the sale. Where a refund happens because an offer was
          materially not as described, the commission is reversed too. Repeated refunds against the
          same offer are grounds for an administrator to withdraw it and to review your standing.
        </p>
      </LegalSection>

      <LegalSection id="unbuilt" title="What is not built yet">
        <p>
          Payments are not live on JavelinHub, and neither is the machinery this policy describes.
          Being specific about that is better than being vague:
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>refunds are processed by hand, by email, and not from within the product;</li>
          <li>there is no automated dispute path and no in-product refund button;</li>
          <li>
            the checkout acknowledgement described under <em>instant downloads</em> is rendered and
            recorded on the order, but the payment it sits in front of is a placeholder rather than a
            charge.
          </li>
        </ul>
        <p>
          This section is removed when those are real. Until then it is here so that nobody &mdash;
          buyer, coach or operator &mdash; reads this page as describing something that already works.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
