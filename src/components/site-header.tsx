import { NavBar, type NavLink } from '@/components/nav-bar';
import { getCurrentProfile } from '@/lib/auth/session';
import type { Profile } from '@/lib/data/types';

/**
 * Resolves the signed-in user on every request and hands the Client Component
 * only what it needs to render.
 *
 * Reading the profile here — rather than caching role/coach_status in the
 * session cookie — is what makes the nav correct the instant a user redeems an
 * invite code. Server Actions that change privilege call
 * `revalidatePath('/', 'layout')`, which re-runs this component.
 */
export async function SiteHeader() {
  const profile = await getCurrentProfile();
  return (
    <NavBar links={navLinksFor(profile)} userName={profile?.full_name ?? null} roleLabel={roleLabelFor(profile)} />
  );
}

/**
 * The nav for a given viewer.
 *
 * The first two items are the product's two entry points and are the same for
 * everyone, signed in or not: **Offers** and **Coaches**. They mirror the two
 * hero buttons — a single "Browse" was the right nav while there was a single
 * catalogue, and it stopped being right the moment a second one existed.
 *
 * Both labels are one word on purpose. These are set in the display face at
 * 22px uppercase and sit in a single row from `lg` up — NOT from `md`, which is
 * what an earlier version of this comment claimed and what the component
 * actually did. Measured with an administrator's six items, the row was 266px
 * tall at 768px and 90px at 900px, with labels wrapping one letter per line;
 * only 1024px held them on one line. `nav-bar.tsx` now hands 768-1023px to the
 * mobile panel, which is a column and cannot fail that way. Below `lg` these
 * labels never share a row at all, so their length is not what constrains them
 * — keeping them short is for the 1024px row and for scanability, not for
 * 768px.
 *
 * Note the two independent facts below. `coach_status === 'approved'` is what
 * permits publishing an offer; `role === 'admin'` is what permits the admin
 * area. They are not the same axis and an admin can be both — see
 * `docs/DATA-LAYER.md`, "Becoming a coach only ever raises privilege".
 */
function navLinksFor(profile: Profile | null): NavLink[] {
  const links: NavLink[] = [
    { href: '/offers', label: 'Offers' },
    { href: '/coaches', label: 'Coaches' },
  ];
  if (!profile) return links;

  if (profile.coach_status === 'approved') {
    links.push({ href: '/offers/new', label: 'New offer' });
  } else {
    links.push({ href: '/coach/apply', label: 'Become a coach' });
    links.push({ href: '/redeem', label: 'Redeem invite' });
  }

  if (profile.role === 'admin') {
    links.push({ href: '/admin/invites', label: 'Admin' });
    links.push({ href: '/admin/applications', label: 'Applications' });
  }

  return links;
}

function roleLabelFor(profile: Profile | null): string | null {
  if (!profile) return null;
  if (profile.role === 'admin') return 'Admin';
  if (profile.coach_status === 'approved') return 'Coach';
  return null;
}
