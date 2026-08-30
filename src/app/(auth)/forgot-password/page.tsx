import type { Metadata } from 'next';
import Link from 'next/link';

import { ForgotPasswordForm } from '@/app/(auth)/forgot-password/forgot-password-form';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardFooter } from '@/components/ui/card';
import { firstValue } from '@/lib/search-params';
import { dataBackend } from '@/lib/env';

export const metadata: Metadata = { title: 'Reset your password' };

/**
 * Ask for a password-reset link.
 *
 * PUBLIC AND UNGATED, necessarily: everyone who needs this page is locked out
 * by definition, so there is nothing to require. That also makes it the app's
 * most abusable form — see `docs/ROADMAP.md` §6 on rate limiting, which this
 * flow does not yet have and which belongs in front of it before launch.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Set by `/auth/callback` for every way a link can be unusable — expired,
  // already used, malformed, or never ours. ONE message for all of them: see
  // the route handler for why they are not told apart.
  const linkFailed = firstValue((await searchParams).link) === 'expired';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Reset your password</h1>
        {/*
          The link's two constraints are stated BEFORE the form, not only in the
          confirmation afterwards. A user who knows the link works once and
          expires in an hour reads a dead link as expected rather than as the
          site being broken — and is less likely to hoard the email.
        */}
        <p className="mt-1.5 text-sm text-muted">
          We&rsquo;ll email you a link. It works once and expires in an hour. Remembered it?{' '}
          <Link href="/login" className="font-medium text-brand underline underline-offset-2">
            Log in
          </Link>
          .
        </p>
      </div>

      {linkFailed ? (
        <Alert tone="warn" title="That link no longer works.">
          Reset links can be used once and expire after an hour. Ask for a new one below.
        </Alert>
      ) : null}

      <Card tone="raised">
        <CardBody>
          <ForgotPasswordForm />
        </CardBody>
        {dataBackend() === 'mock' ? (
          /*
            The mock has no mail transport and should not have one — it exists so
            the app runs with no external services. The link is printed to the
            SERVER console instead, and saying so here saves the next developer
            wondering why no email arrived.

            Never the link itself: this page is rendered for whoever typed the
            address, and putting the link on it would hand an attacker a reset
            for any account they can name.
          */
          <CardFooter>
            Running on the local JSON store, which cannot send email. The link is printed in the terminal
            running <code className="font-mono text-ink">npm run dev</code>.
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}
