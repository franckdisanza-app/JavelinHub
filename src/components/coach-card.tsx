import Link from 'next/link';

import { InitialsAvatar } from '@/components/initials-avatar';
import { avatarPublicUrl } from '@/lib/storage/avatars';
import { Card } from '@/components/ui/card';
import { Rating } from '@/components/ui/stat';
import type { CoachStats, PublicCoach } from '@/lib/data/types';

/**
 * One coach in the directory grid.
 *
 * It takes a {@link PublicCoach} and never a `Profile`: `Profile` carries
 * `email`, and this component renders on an anonymous page. `PublicCoach`
 * carries no `email`, no `role` and no `coach_status` — see the note on that
 * type for why the last two matter more than they look.
 *
 * -----------------------------------------------------------------------------
 * WHY THERE IS NO "VERIFIED COACH" CHIP HERE
 * -----------------------------------------------------------------------------
 * Because `listCoaches` returns approved coaches and nothing else, **every card
 * in this grid would carry it**, which makes it decoration rather than
 * information. The fact is stated once, in a sentence at
 * the top of the directory, where it applies to the whole page. The chip earns
 * its place on the individual coach profile, where a visitor may have arrived
 * from a link and has nothing else to tell them.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE NUMBERS ARE, AND ARE NOT
 * -----------------------------------------------------------------------------
 * `stats` is ACCOUNT-level ({@link CoachStats}): every offer, every price
 * epoch, withdrawn offers included. That is deliberately not what an offer card
 * shows, and the two must not be reconciled — raising a price archives an
 * OFFER's rating, and it does not make somebody a worse coach.
 *
 * The rating goes through {@link Rating}, which renders "New coach" instead of
 * a numeral when `rating_average` is `null`. Never format that field directly.
 */
export function CoachCard({
  coach,
  stats,
  href,
}: {
  coach: PublicCoach;
  /** Account-level rollup for this coach. Always a row — zeros for a new coach. */
  stats: CoachStats;
  href: string;
}) {
  return (
    <Card
      tone="raised"
      className="relative flex h-full w-full min-w-0 flex-col transition-colors hover:border-brand/50"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-5">
        <div className="flex min-w-0 items-start gap-3">
          <InitialsAvatar name={coach.full_name} src={avatarPublicUrl(coach.avatar_path)} />
          <div className="min-w-0 flex-1">
            {/*
              Card titles are display type — section 04 assigns Barlow Condensed
              to "headlines, lockup, card titles, nav" — and `font-bold` is not
              emphasis: only 100 / 700 / 900 are loaded, so an item left at the
              inherited 400 falls DOWN to 100 and renders as a hairline.
            */}
            <h2 className="min-w-0 font-display text-display-22 leading-[0.9] font-bold tracking-[0.005em] break-words uppercase text-ink">
              {/*
                The whole card is one click target through this stretched link,
                so the accessible name stays the coach's name rather than
                becoming "view profile".
              */}
              <Link href={href} className="after:absolute after:inset-0">
                {coach.full_name}
              </Link>
            </h2>
            {/*
              The headline is optional and is genuinely absent for a coach who
              has not written one — an approved coach who arrived by invite code
              has no application to seed it from. Nothing is substituted for it:
              an invented line under someone's name is a claim they did not make.
            */}
            {coach.coach_headline ? (
              <p className="mt-1.5 text-body-15 break-words text-muted">{coach.coach_headline}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-auto pt-1">
          {/*
            Three states, and the middle one is the one that gets collapsed.
            "New coach" is only true of somebody who has sold NOTHING; a coach
            who has sold and simply not been written about yet is a different
            fact, and calling them new would be wrong.
          */}
          <Rating
            average={stats.rating_average}
            count={stats.review_count}
            emptyLabel={stats.sales_count === 0 ? 'New coach' : 'No reviews yet'}
          />
        </div>
      </div>
    </Card>
  );
}
