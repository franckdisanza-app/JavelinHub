import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';

import { CoachProfileForm } from '@/app/coach/profile/profile-form';
import { InitialsAvatar } from '@/components/initials-avatar';
import { Alert } from '@/components/ui/alert';
import { linkButtonClass } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/session';
import { avatarCacheBuster, avatarPublicUrl } from '@/lib/storage/avatars';

export const metadata: Metadata = { title: 'Your coach profile' };

const PROFILE_PATH = '/coach/profile';

/**
 * The coach's own public profile, edited by its owner.
 *
 * WHAT THIS PAGE IS NOT: an account page. It edits the three columns published
 * through `public_coaches` and nothing else. `full_name` and `email` live on
 * `auth.users` / the privilege-guarded part of `profiles`, and changing either
 * is a different job with different consequences — see `docs/ROADMAP.md`.
 *
 * Gating is on `coach_status === 'approved'`, and it is a courtesy rather than
 * the boundary: `updateMyCoachProfile` refuses a non-approved actor on its own,
 * in TypeScript and again in Postgres. A non-approved visitor gets an
 * explanation and the two routes to approval rather than a 404 — unlike
 * `/admin`, whose *existence* is worth hiding, there is nothing sensitive about
 * this page and being told "you need to be an approved coach first" is the
 * useful answer.
 */
export default async function CoachProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Anonymous visitors land on /login?next=/coach/profile and come straight back.
  const profile = await requireUser(PROFILE_PATH);
  const params = await searchParams;

  if (profile.coach_status !== 'approved') {
    return (
      <Shell>
        <NotACoachPanel status={profile.coach_status} />
      </Shell>
    );
  }

  // The flag only ever refines a state the store already confirms — it cannot
  // manufacture one. Same rule as `coach/apply/page.tsx`.
  const justSaved = params.saved === '1';

  return (
    <Shell>
      {justSaved ? (
        <Alert tone="success" title="Profile saved.">
          Your coach page and your card in the directory both show this now.
        </Alert>
      ) : null}

      {/*
        THE PICTURE MOVED TO `/settings`, and so did the name. Both belong to the
        account rather than to the coach profile — `setMyAvatar` was always open
        to any signed-in user and only this page was coach-facing, which meant an
        athlete could not set a picture at all.
        
        A preview stays, because this page is where a coach checks how their card
        looks, and sending them somewhere else to see it would be worse than the
        one link.
      */}
      <Card tone="raised">
        <CardHeader
          title="Your picture and name"
          description="Shown beside each other in the directory and on your own page."
        />
        <CardBody className="flex items-center gap-4">
          <InitialsAvatar
            name={profile.full_name}
            src={avatarCacheBuster(avatarPublicUrl(profile.avatar_path), profile.updated_at)}
            size="lg"
          />
          <p className="text-sm leading-relaxed text-muted">
            <span className="font-medium text-ink">{profile.full_name}</span>
            <br />
            Both are edited in{' '}
            <Link href="/settings" className="font-medium text-brand underline underline-offset-2">
              account settings
            </Link>
            , because everyone has them — not only coaches.
          </p>
        </CardBody>
      </Card>

      <Card tone="raised">
        <CardHeader
          title="Your public profile"
          description="Everything here is visible to anyone browsing the directory, signed in or not."
        />
        <CardBody>
          <CoachProfileForm
            headline={profile.coach_headline}
            bio={profile.coach_bio}
            years={profile.coach_years_coaching}
          />
        </CardBody>
        <CardFooter>
          <p>
            Your name and email are not edited here — this page covers only what the public sees.{' '}
            <Link href={`/coaches/${profile.id}`} className="font-medium text-brand underline underline-offset-2">
              View your public page
            </Link>
            .
          </p>
        </CardFooter>
      </Card>

      <DirectoryPreview
        name={profile.full_name}
        headline={profile.coach_headline}
        years={profile.coach_years_coaching}
        avatarUrl={avatarCacheBuster(avatarPublicUrl(profile.avatar_path), profile.updated_at)}
      />
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Your coach profile</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        How you appear in the coach directory and on your own page.
      </p>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}

/**
 * Shown to a learner, an applicant awaiting review, and a rejected applicant.
 *
 * The three get the same two routes out because the two routes are the same:
 * apply, or redeem an invite. Only the opening sentence differs, because
 * "you have not applied" and "we have your application" are different facts and
 * telling an applicant to apply again would be wrong.
 */
function NotACoachPanel({ status }: { status: 'none' | 'pending_review' | 'rejected' }) {
  const opening =
    status === 'pending_review'
      ? 'Your coach application is with an administrator. Once it is approved you can write your public profile here.'
      : status === 'rejected'
        ? 'Your last application was not approved, so there is no public profile to edit yet. You can apply again.'
        : 'Only approved coaches have a public profile. There are two ways to become one.';

  return (
    <Card>
      <CardHeader title="You are not an approved coach yet" description={opening} />
      <CardBody>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link href="/coach/apply" className={linkButtonClass({})}>
            {status === 'pending_review' ? 'See your application' : 'Apply to coach'}
          </Link>
          <Link href="/redeem" className={linkButtonClass({ variant: 'secondary' })}>
            Redeem an invite code
          </Link>
        </div>
      </CardBody>
      <CardFooter>
        <p>Redeeming an invite code approves you immediately, with no review.</p>
      </CardFooter>
    </Card>
  );
}

/**
 * What the directory card actually renders from these fields.
 *
 * Included because two of the three columns are only ever seen by their owner
 * on a page they had to go looking for, and a coach editing a headline has no
 * other way to find out that it is the one line under their name. It is a
 * PREVIEW, not the component: `CoachCard` also needs `CoachStats`, and
 * rebuilding those here to show a coach their own numbers would duplicate the
 * account-level rollup for no gain.
 *
 * The bio is deliberately absent — the card does not show it, and implying it
 * does would be the opposite of useful.
 */
function DirectoryPreview({
  name,
  headline,
  years,
  avatarUrl,
}: {
  name: string;
  headline: string | null;
  years: number | null;
  avatarUrl: string | null;
}) {
  return (
    <Card>
      <CardHeader title="How your card reads" description="Your entry in the coach directory." />
      <CardBody>
        <div className="flex items-start gap-3">
          <InitialsAvatar name={name} src={avatarUrl} />
          <div className="min-w-0">
            <p className="font-semibold break-words text-ink">{name}</p>
            {headline ? (
              <p className="mt-0.5 text-sm leading-relaxed break-words text-muted">{headline}</p>
            ) : (
              <p className="mt-0.5 text-sm text-faint italic">No headline yet</p>
            )}
            {/*
              `years !== null`, never a truthiness test. A coach in their first
              season stores 0 and must read as "First season coaching" — a
              falsy check would silently render them the same as somebody who
              declined to answer. See `docs/DATA-LAYER.md`, "Zero years is not
              the same as no years".
            */}
            {years !== null ? (
              <p className="mt-1 text-xs text-faint">
                {years === 0 ? 'First season coaching' : `${years} ${years === 1 ? 'year' : 'years'} coaching`}
              </p>
            ) : null}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
