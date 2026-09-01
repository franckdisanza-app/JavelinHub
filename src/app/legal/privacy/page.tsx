import type { Metadata } from 'next';
import Link from 'next/link';

import { Fact, LegalPage, LegalSection } from '@/app/legal/legal-chrome';
import { legalIsComplete } from '@/lib/legal';

/**
 * The privacy notice.
 *
 * **EVERY FACTUAL CLAIM BELOW WAS READ OUT OF THE CODE**, which is what makes
 * this worth having as a draft rather than a template to be filled in later.
 * Three of them are unusual enough that a generic notice would state the
 * opposite, and each is load-bearing for a data-subject request:
 *
 *   * deletion ANONYMISES rather than erases, because the foreign-key graph
 *     leaves no honest alternative (`docs/ROADMAP.md` §4, `0018`);
 *   * the rate limiter stores an HMAC of an address and never the address, so
 *     the table is not a record of who asked for a password reset
 *     (`src/lib/rate-limit.ts`);
 *   * the error log deliberately carries no user id, email address, request
 *     header or query string (`src/lib/observability.ts`).
 *
 * If any of those three change, this page is wrong and has to change with it.
 *
 * See `terms/page.tsx` for why this is `noindex` until `LEGAL` is filled in.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Privacy notice',
  robots: legalIsComplete() ? undefined : { index: false, follow: false },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy notice"
      summary="What JavelinHub stores about you, why, who else sees it, and how to get it removed."
    >
      <LegalSection id="controller" title="Who is responsible">
        <p>
          <Fact name="legalName" /> is the data controller for the personal data described here.
          Registered address: <Fact name="registeredAddress" />. Data-protection enquiries and
          requests go to <Fact name="privacyEmail" />.
        </p>
      </LegalSection>

      <LegalSection id="collected" title="What we store">
        <p>When you create an account:</p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>your email address and display name;</li>
          <li>
            a password, stored only as a hash by our authentication provider &mdash; we never hold
            the password itself and cannot recover it for you;
          </li>
          <li>a profile picture, if you upload one. This is public.</li>
        </ul>
        <p>If you become a coach, additionally:</p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>your application, including the biography and experience you wrote in it;</li>
          <li>your public headline, biography and years coaching;</li>
          <li>the offers you publish, and every revision of them.</li>
        </ul>
        <p>When you buy or sell:</p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>the order: which offer, which coach, and the price at the time;</li>
          <li>
            files exchanged against that order &mdash; which for a video review means video of you.
            These are stored privately and are readable only by the two parties to the order;
          </li>
          <li>reviews you write, published under your display name;</li>
          <li>reports you file, which are visible to administrators.</li>
        </ul>
        <p>
          <strong>Payment card details never reach us.</strong> They are handled entirely by our
          payments provider; we store only the fact and amount of a payment.
        </p>
      </LegalSection>

      <LegalSection id="not-collected" title="What we deliberately do not store">
        <p>
          <strong>Not your IP address.</strong> Sign-in, sign-up, password reset and invite
          redemption are rate limited, and the limiter stores a keyed hash of the address or email
          rather than the value itself. The table is therefore not a record of who has asked for a
          password reset, which it would otherwise be.
        </p>
        <p>
          <strong>Not your identity in our error logs.</strong> When something breaks, the log
          records what failed and where. It carries no user id, no email address, no request headers
          &mdash; which would include your session &mdash; and no query strings.
        </p>
        <p>
          <strong>No advertising or analytics cookies</strong>, and no third-party trackers. See{' '}
          <Link href="#cookies" className="underline underline-offset-2">
            cookies
          </Link>{' '}
          below.
        </p>
      </LegalSection>

      <LegalSection id="why" title="Why we are allowed to store it">
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>
            <strong>To perform our contract with you</strong> &mdash; your account, your orders, the
            files delivered against them, and payment.
          </li>
          <li>
            <strong>Our legitimate interests</strong> &mdash; keeping the marketplace safe:
            moderation, the reports queue, the administrator action log, and rate limiting. We keep
            these to the minimum that makes them work, which is why the limiter stores a hash.
          </li>
          <li>
            <strong>Legal obligation</strong> &mdash; transaction records we are required to retain
            for tax and accounting.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="shared" title="Who else sees it">
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>
            <strong>The other party to an order.</strong> A coach sees that you claimed their offer
            and any file you send them; you see what they send back.
          </li>
          <li>
            <strong>Everyone, for the things that are public by design</strong> &mdash; your display
            name and picture, a coach&rsquo;s headline and biography, published offers, and reviews
            under their author&rsquo;s name. Your email address is never public.
          </li>
          <li>
            <strong>Our processors</strong>, who handle data on our instructions only: our database,
            authentication and file-storage provider; our hosting provider; our email provider; and
            our payments provider.
          </li>
        </ul>
        <p>
          Some of those processors operate outside the UK and EEA. Transfers are covered by the
          standard contractual clauses or an equivalent safeguard.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="How long we keep it, and what deletion actually does">
        <p>
          You can delete your account from your settings at any time. <strong>Deletion anonymises
          your record rather than erasing it, and you should understand why before you rely on
          it.</strong>
        </p>
        <p>
          Your purchases and reviews are attached to other people&rsquo;s history. A coach&rsquo;s
          sales count and rating are made of real orders and real reviews; erasing yours would
          silently rewrite their record. One person leaving must not change what happened to somebody
          else. So on deletion:
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>
            your name, email address, picture and any biography are removed from the record and
            replaced;
          </li>
          <li>your profile picture is deleted from storage;</li>
          <li>your sign-in credential is disabled, so the account cannot be used again;</li>
          <li>
            the reviews you wrote remain, no longer attributed to a named living person, and the
            orders behind them remain as anonymous rows.
          </li>
        </ul>
        <p>
          A coach with offers still on sale must withdraw them first; the system will refuse the
          deletion until they have. An administrator who has issued an invite code cannot delete
          their own account and is removed by another administrator.
        </p>
        <p>
          If that is not sufficient for you, write to <Fact name="privacyEmail" /> and say so &mdash;
          there are cases where full erasure is possible and we will tell you honestly which yours
          is.
        </p>
      </LegalSection>

      <LegalSection id="rights" title="Your rights">
        <p>
          You have the right to ask for a copy of your data, to have it corrected, to object to or
          restrict how we use it, to receive it in a portable form, and to ask for it to be erased
          &mdash; subject to what the section above explains. Most of these you can exercise yourself
          from your settings; for the rest, write to <Fact name="privacyEmail" />.
        </p>
        <p>
          If you are unhappy with how we have handled a request you can complain to{' '}
          <Fact name="supervisoryAuthority" />.
        </p>
      </LegalSection>

      <LegalSection id="cookies" title="Cookies">
        <p>
          JavelinHub sets <strong>strictly necessary cookies only</strong>: the pair that keeps you
          signed in. There are no advertising cookies, no analytics cookies, and no third-party
          trackers, which is why you have not been shown a consent banner &mdash; none is required
          for cookies that are essential to a service you asked for.
        </p>
        <p>
          If that ever changes, this section changes with it and a banner appears before the first
          non-essential cookie is set.
        </p>
      </LegalSection>

      <LegalSection id="security" title="Security">
        <p>
          Access to data is enforced by the database itself rather than only by the application, so a
          mistake in a page cannot expose a row the rules do not allow. Files delivered against an
          order live in private storage and are served through links that expire minutes after they
          are issued. Changing your password ends every other session on your account.
        </p>
        <p>
          No system is perfect. If you find a vulnerability, please tell us at{' '}
          <Fact name="privacyEmail" /> before telling anyone else.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
