import type { Metadata } from 'next';
import Link from 'next/link';

import { RedeemForm } from '@/app/redeem/redeem-form';
import { Alert } from '@/components/ui/alert';
import { linkButtonClass } from '@/components/ui/button';
import { Card, CardBody, CardFooter } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Redeem an invite code' };

export default async function RedeemPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Redirects anonymous visitors to /login?next=/redeem. This is convenience —
  // `redeemInviteCode` refuses an anonymous actor on its own, and the action
  // handles that case too.
  const profile = await requireUser('/redeem');
  const params = await searchParams;

  const approved = profile.coach_status === 'approved';
  // `?redeemed=1` is set by the action's redirect. It is only ever trusted in
  // combination with the *stored* status, so pasting the query string by hand
  // cannot make the page claim you were approved.
  const justRedeemed = approved && params.redeemed === '1';

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Redeem an invite code</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        An administrator can issue you a one-use code that approves you as a coach immediately, skipping the
        application queue.
      </p>

      <div className="mt-6">
        {approved ? (
          <div className="flex flex-col gap-4">
            {justRedeemed ? (
              <Alert tone="success" title="Code accepted — you are now an approved coach.">
                That happened immediately: there is no second review step and nothing to wait for. Your code has been
                used up and cannot be redeemed again.
              </Alert>
            ) : (
              <Alert tone="success" title="You are already an approved coach.">
                There is nothing to redeem — you can publish offers right now. Spending a second code would do nothing
                for you and would burn one someone else could use.
              </Alert>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link href="/offers/new" className={linkButtonClass({})}>
                {justRedeemed ? 'Create your first offer' : 'Create an offer'}
              </Link>
              <Link href="/offers" className={linkButtonClass({ variant: 'secondary' })}>
                Browse offers
              </Link>
            </div>
          </div>
        ) : (
          <Card tone="raised">
            <CardBody>
              <RedeemForm />
            </CardBody>
            <CardFooter>
              No code?{' '}
              <Link href="/coach/apply" className="font-medium text-brand underline underline-offset-2">
                Apply to coach
              </Link>{' '}
              instead — an administrator reviews every application.
            </CardFooter>
          </Card>
        )}
      </div>
    </div>
  );
}
