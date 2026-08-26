import type { Metadata } from 'next';
import Link from 'next/link';

import { SignupForm } from '@/app/(auth)/signup/signup-form';
import { Card, CardBody, CardFooter } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Sign up' };

export default function SignupPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Create your account</h1>
        <p className="mt-1.5 text-sm text-muted">
          Already have one?{' '}
          <Link href="/login" className="font-medium text-brand underline underline-offset-2">
            Log in
          </Link>
          .
        </p>
      </div>

      <Card tone="raised">
        <CardBody>
          <SignupForm />
        </CardBody>
        <CardFooter>
          Everyone starts as a learner. You can{' '}
          <Link href="/redeem" className="font-medium text-brand underline underline-offset-2">
            redeem an invite code
          </Link>{' '}
          or{' '}
          <Link href="/coach/apply" className="font-medium text-brand underline underline-offset-2">
            apply to coach
          </Link>{' '}
          afterwards.
        </CardFooter>
      </Card>
    </div>
  );
}
