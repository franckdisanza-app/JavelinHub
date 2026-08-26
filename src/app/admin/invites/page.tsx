import type { Metadata } from 'next';

import { CreateInviteForm } from '@/app/admin/invites/create-invite-form';
import { CopyCodeButton, RevokeInviteForm } from '@/app/admin/invites/invite-actions';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getActor, getCurrentProfile, requireAdmin } from '@/lib/auth/session';
import { getDataClient } from '@/lib/data';
import type { Invite } from '@/lib/data/types';

/**
 * `generateMetadata` runs independently of the page body, so a static
 * `metadata` export here would put "Invite codes" in the tab title even on the
 * 404 a non-admin gets — quietly confirming the page exists to exactly the
 * person `requireAdmin()` declined to confirm it to.
 */
export async function generateMetadata(): Promise<Metadata> {
  const profile = await getCurrentProfile();
  return { title: profile?.role === 'admin' ? 'Invite codes' : 'Not found' };
}

export default async function AdminInvitesPage() {
  // Anonymous -> /login?next=/admin/invites. Signed in but not an admin -> 404,
  // so the page's existence is not confirmed to someone poking at URLs. Either
  // way `listInvites` below would refuse them anyway: there is no non-admin
  // select policy on invites at all, in the mock or in SQL.
  await requireAdmin('/admin/invites');

  const actor = await getActor();
  const db = getDataClient();
  const invites = await db.listInvites(actor);

  // Redeemers are shown by name only. `getPublicProfile` is the right call
  // here even for an admin screen: an admin *may* read full profiles, but this
  // list has no need for anybody's email address.
  const redeemerIds = [...new Set(invites.map((invite) => invite.redeemed_by).filter((id): id is string => !!id))];
  const redeemerNames = new Map(
    await Promise.all(
      redeemerIds.map(async (id) => [id, (await db.getPublicProfile(id))?.full_name ?? 'a deleted account'] as const),
    ),
  );

  const active = invites.filter((invite) => statusOf(invite).kind === 'active').length;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-12">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Invite codes</h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
        An invite code approves whoever redeems it as a coach immediately, with no review. Each code works exactly once.
        Treat one like a password: anyone holding it can sell on the marketplace.
      </p>

      <div className="mt-8 flex flex-col gap-8">
        <Card tone="raised">
          <CardHeader title="Generate a code" description="Codes are random, one-use, and safe to read aloud." />
          <CardBody>
            <CreateInviteForm />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="All codes"
            description={
              invites.length === 0
                ? 'None yet.'
                : `${invites.length} total, ${active} still redeemable. Newest first.`
            }
          />
          <CardBody className="py-0">
            {invites.length === 0 ? (
              <p className="py-6 text-sm text-muted">Generate your first code above.</p>
            ) : (
              <ul className="divide-y divide-line">
                {invites.map((invite) => (
                  <InviteRow key={invite.code} invite={invite} redeemerNames={redeemerNames} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function InviteRow({
  invite,
  redeemerNames,
}: {
  invite: Invite;
  redeemerNames: Map<string, string>;
}) {
  const status = statusOf(invite);

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-base font-semibold tracking-[0.12em] text-ink">{invite.code}</code>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>

        {invite.note ? <p className="mt-1.5 text-sm text-ink">{invite.note}</p> : null}

        <p className="mt-1 text-xs text-muted">
          Created {formatDate(invite.created_at)}
          {invite.expires_at ? ` · Expires ${formatDate(invite.expires_at)}` : ' · No expiry'}
          {invite.redeemed_by
            ? ` · Redeemed by ${redeemerNames.get(invite.redeemed_by) ?? 'a deleted account'}${
                invite.redeemed_at ? ` on ${formatDate(invite.redeemed_at)}` : ''
              }`
            : ''}
          {invite.revoked_at ? ` · Revoked ${formatDate(invite.revoked_at)}` : ''}
        </p>
      </div>

      {status.kind === 'active' ? (
        <div className="flex shrink-0 items-start gap-2">
          <CopyCodeButton code={invite.code} />
          <RevokeInviteForm code={invite.code} />
        </div>
      ) : null}
    </li>
  );
}

type InviteStatus = {
  kind: 'active' | 'redeemed' | 'revoked' | 'expired';
  label: string;
  tone: BadgeTone;
};

/**
 * Display status, in the same precedence the data layer uses when it refuses a
 * redemption: revoked, then already-redeemed, then expired.
 */
function statusOf(invite: Invite): InviteStatus {
  if (invite.revoked_at) return { kind: 'revoked', label: 'Revoked', tone: 'danger' };
  if (invite.redeemed_by) return { kind: 'redeemed', label: 'Redeemed', tone: 'neutral' };
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
    return { kind: 'expired', label: 'Expired', tone: 'warn' };
  }
  return { kind: 'active', label: 'Active', tone: 'success' };
}

/**
 * Fixed locale and fixed time zone, deliberately. A date formatted with the
 * server's locale and then re-rendered with the browser's is the classic source
 * of a React hydration warning.
 */
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatDate(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? 'an unknown date' : DATE_FORMAT.format(value);
}
