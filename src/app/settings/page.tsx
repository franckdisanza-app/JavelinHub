import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import Link from 'next/link';

import { AvatarForm, EmailForm, NameForm, PasswordForm } from '@/app/settings/settings-forms';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/session';
import { firstValue } from '@/lib/search-params';
import { avatarCacheBuster, avatarPublicUrl, avatarStorageAvailable } from '@/lib/storage/avatars';

export const metadata: Metadata = { title: 'Account settings' };

const SETTINGS_PATH = '/settings';

/**
 * Account settings — **for everyone**, coach or athlete or administrator.
 *
 * THE COUNTERPART `/coach/profile` SAYS IT IS NOT. That page carries the note
 * "WHAT THIS PAGE IS NOT: an account page… `full_name` and `email` live on
 * `auth.users` / the privilege-guarded part of `profiles`, and changing either
 * is a different job with different consequences". This is that page, and the
 * split holds: `/coach/profile` edits the three columns published through
 * `public_coaches`, and this one edits the account behind them.
 *
 * `requireUser()` is the whole gate, and it is enough because every action here
 * takes no subject id — each one resolves the actor and writes their own row, in
 * TypeScript and again in Postgres through `profiles_update_own`. There is no
 * shape of any of them that touches another account, so there is no role to
 * check.
 *
 * A static `metadata` export rather than `generateMetadata`, unlike the admin
 * pages: those hide their own existence from a non-admin and must not leak a
 * title into the 404, while this page exists for every signed-in user and hides
 * nothing.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Anonymous visitors land on /login?next=/settings and come straight back.
  const profile = await requireUser(SETTINGS_PATH);

  /*
   * Set by `/auth/callback` when an email-change link is redeemed — the
   * `emailRedirectTo` GoTrue was given points here. Trusted only to show a
   * message: the address rendered below comes from the PROFILE, so if the flag
   * were forged the page would congratulate somebody on a change that had not
   * happened and then show them their unchanged address two lines down.
   */
  const emailJustChanged = firstValue((await searchParams).email) === 'changed';

  /*
   * `avatarCacheBuster` appends the profile's `updated_at`, because the public
   * URL of an avatar is a pure function of its path — replacing a picture at the
   * same path would otherwise keep serving the CDN's copy of the old one.
   */
  const avatarUrl = avatarCacheBuster(avatarPublicUrl(profile.avatar_path), profile.updated_at);

  return (
    <Shell>
      {emailJustChanged ? (
        <Alert tone="success" title="Your email is confirmed.">
          You now sign in with <strong className="font-medium">{profile.email}</strong>. If that is still
          the old address, the other confirmation link has not been followed yet — both have to be.
        </Alert>
      ) : null}

      <Card tone="raised">
        <CardHeader
          title="Your name"
          description="The name other people see. Changing it updates every review you have written."
        />
        <CardBody>
          <NameForm currentName={profile.full_name} />
        </CardBody>
      </Card>

      <Card tone="raised">
        <CardHeader title="Your picture" description="Optional. Initials are the default and always fine." />
        <CardBody>
          <AvatarForm
            name={profile.full_name}
            currentUrl={avatarUrl}
            currentPath={profile.avatar_path}
            available={avatarStorageAvailable()}
          />
        </CardBody>
        {profile.coach_status === 'approved' ? (
          <CardFooter>
            <p>
              Your picture and name appear on your{' '}
              <Link href="/coach/profile" className="font-medium text-brand underline underline-offset-2">
                coach profile
              </Link>
              , which is where your headline, bio and years coaching are edited.
            </p>
          </CardFooter>
        ) : (
          /*
            HONEST ABOUT WHERE IT SHOWS. A learner's picture currently renders
            here and in the header and nowhere else — reviews carry
            `author_name` and no avatar, because `PublicReview` projects the
            name alone. Letting somebody upload a picture nobody will see,
            without saying so, would be the small dishonesty that makes a
            product feel careless.
          */
          <CardFooter>
            <p>
              For now your picture appears here and in the header. It goes public if you become a coach —
              on your coach card and your profile page.
            </p>
          </CardFooter>
        )}
      </Card>

      <Card tone="raised">
        <CardHeader
          title="Your email"
          description="The address you sign in with. Changing it needs both addresses to confirm."
        />
        <CardBody>
          <EmailForm currentEmail={profile.email} />
        </CardBody>
      </Card>

      <Card tone="raised">
        <CardHeader
          title="Your password"
          description="You need your current one. If you have forgotten it, sign out and use the reset link instead."
        />
        <CardBody>
          <PasswordForm />
        </CardBody>
      </Card>

      {/*
        Still said plainly rather than left to be discovered. Deletion is a legal
        obligation, and a settings page that silently lacks it reads as a page
        where it is hidden somewhere.
      */}
      <Alert tone="info" title="Not here yet: deleting your account.">
        <p>
          There is no self-service way to delete an account. It is being built, and it will anonymise your
          profile rather than erase your purchases — deleting those would rewrite other people&rsquo;s
          sales and ratings. Until then, ask an administrator.
        </p>
      </Alert>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Account settings</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        Your name, your picture, your email and your password. Everyone has this page.
      </p>
      <div className="mt-8 flex flex-col gap-6">{children}</div>
    </div>
  );
}
