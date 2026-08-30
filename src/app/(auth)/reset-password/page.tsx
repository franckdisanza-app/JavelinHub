import type { Metadata } from 'next';
import Link from 'next/link';

import { ResetPasswordForm } from '@/app/(auth)/reset-password/reset-password-form';
import { Alert } from '@/components/ui/alert';
import { linkButtonClass } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { getCurrentProfile } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Set a new password' };

/**
 * Set a new password. Reached from `/auth/callback`, which is reached from the
 * emailed link.
 *
 * GATED ON A SESSION, and it is the same session `/auth/callback` created by
 * redeeming that link. So the chain of trust is: control of the inbox → a
 * single-use token → a session → this page → `updateMyPassword`, which writes
 * for whoever the session names and takes no user id.
 *
 * NO `requireUser()` HERE, deliberately, even though this is a signed-in page.
 * That helper redirects to `/login?next=/reset-password`, and sending somebody
 * whose whole problem is that they cannot log in to the login form is the one
 * dead end this feature exists to remove. An anonymous visitor gets the reset
 * flow instead.
 *
 * Which also means this page is reachable by anyone already signed in, and that
 * is fine — it is a change-password form for them, and the only thing it can
 * change is their own password.
 */
export default async function ResetPasswordPage() {
  const profile = await getCurrentProfile();

  if (!profile) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Set a new password</h1>
        </div>
        <Alert tone="warn" title="This page needs a valid reset link.">
          <p>
            Open the most recent link we emailed you and you will land back here. Links can be used once
            and expire after an hour.
          </p>
          <p className="mt-3">
            <Link href="/forgot-password" className={linkButtonClass({ variant: 'secondary', size: 'sm' })}>
              Send a new link
            </Link>
          </p>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Set a new password</h1>
        {/*
          The address is named so a user who holds two accounts can see WHICH one
          they are about to change. It is their own profile's email — the same
          fact the header already renders for them — and this page is never shown
          for anybody else's session.
        */}
        <p className="mt-1.5 text-sm break-words text-muted">
          For <span className="font-medium text-ink">{profile.email}</span>.
        </p>
      </div>

      <Card tone="raised">
        <CardBody>
          <ResetPasswordForm />
        </CardBody>
      </Card>
    </div>
  );
}
