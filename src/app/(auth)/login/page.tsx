import type { Metadata } from 'next';
import Link from 'next/link';

import { LoginForm } from '@/app/(auth)/login/login-form';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { safeNextPath } from '@/lib/auth/session';
import { seedAdminEmail } from '@/lib/env';

export const metadata: Metadata = { title: 'Log in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // `searchParams` is a Promise in this version of Next.
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = safeNextPath(rawNext);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Log in</h1>
        <p className="mt-1.5 text-sm text-muted">
          New here?{' '}
          <Link href="/signup" className="font-medium text-brand underline underline-offset-2">
            Create an account
          </Link>
          .
        </p>
      </div>

      <Card tone="raised">
        <CardBody>
          <LoginForm next={next} />
        </CardBody>
        {next ? (
          <CardFooter>You&rsquo;ll be sent back to {next} once you are signed in.</CardFooter>
        ) : null}
      </Card>

      <DemoAccounts />
    </div>
  );
}

/**
 * The POC's fixture accounts, so the flows can be exercised without reading the
 * README first.
 *
 * These are public demo credentials for a local proof of concept and live in
 * the seed data and the README on purpose. The admin password is the one thing
 * that is NOT printed: it comes from `SEED_ADMIN_PASSWORD` in `.env.local`,
 * which is per-machine and not ours to publish.
 */
function DemoAccounts() {
  const rows = [
    { role: 'Coach', email: 'coach@javelin.test', password: 'coach1234' },
    { role: 'Learner', email: 'learner@javelin.test', password: 'learner1234' },
    { role: 'Admin', email: seedAdminEmail(), password: null },
  ];

  return (
    <Card>
      <CardHeader
        title="Demo accounts"
        description="Local proof-of-concept fixtures. Never reuse these anywhere real."
      />
      <CardBody className="py-0">
        <dl className="divide-y divide-line">
          {rows.map((row) => (
            <div key={row.role} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
              <dt className="w-20 shrink-0 text-sm font-semibold text-ink">{row.role}</dt>
              <dd className="min-w-0 text-sm text-muted">
                <span className="block font-mono text-[0.8125rem] break-all text-ink">{row.email}</span>
                {row.password ? (
                  <span className="mt-0.5 block font-mono text-[0.8125rem] break-all text-ink">{row.password}</span>
                ) : (
                  <span className="mt-0.5 block">
                    Password is your <code className="font-mono text-[0.8125rem] text-ink">SEED_ADMIN_PASSWORD</code>{' '}
                    from <code className="font-mono text-[0.8125rem] text-ink">.env.local</code>.
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </CardBody>
      <CardFooter>
        Seeded invite codes: <code className="font-mono text-ink">JAVELIN-COACH-2026</code> and{' '}
        <code className="font-mono text-ink">THROWERS-WELCOME</code>. Each one works once.
      </CardFooter>
    </Card>
  );
}
