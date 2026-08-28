import { cn } from '@/components/ui/cn';
import { initialsOf } from '@/lib/initials';

/**
 * A square avatar tile: an uploaded picture when there is one, initials
 * otherwise.
 *
 * THIS USED TO SAY "NO UPLOADS AND NO STORAGE, DELIBERATELY", and that comment
 * was right for as long as it lasted — an avatar upload is a file store, a MIME
 * sniffer, a size limit and a moderation problem, and it was the only
 * user-supplied binary the product would have had. `0008_avatars.sql` took
 * those on knowingly (2 MB, three image types, both enforced by the bucket
 * rather than by a form) because delivery needs the same machinery and this is
 * the cheapest place to prove it.
 *
 * INITIALS REMAIN THE DEFAULT AND ARE NOT A DEGRADED STATE. Most accounts will
 * never set a picture, `avatar_path` is null for all of them, and the tile is
 * complete without one. `src` is optional for that reason, and a broken or
 * unconfigured URL falls back rather than rendering a torn image.
 *
 * Square corners: section 06 lists avatars by name among the things that have
 * no radius — buttons, cards, inputs, chips, avatars, video frames and the
 * focus indicator alike. A softened avatar would be the one such object in the
 * product.
 *
 * (Two words are deliberately spelled around in this comment. These files are
 * scanned for class names, so naming the corner-softening utility or the
 * three-letter word for a focus indicator in prose COMPILES a real rule — the
 * latter emits a box-shadow, into a brand whose section 06 says "No shadows,
 * ever". See the note at the top of globals.css; this comment tripped it once
 * already and was rewritten.)
 *
 * `aria-hidden`, always. Every call site renders the full name in text
 * immediately beside this, so an accessible name here would make a screen
 * reader announce the person twice — once as two letters, once properly.
 */

/** Tile sizes. Both are Chalk-on-Ink-rule squares; only the box and type step differ. */
const SIZES = {
  sm: 'h-11 w-11 text-mono-13',
  lg: 'h-16 w-16 text-mono-16',
} as const;

export type InitialsAvatarSize = keyof typeof SIZES;

export function InitialsAvatar({
  name,
  src,
  size = 'sm',
  className,
}: {
  /** The display name. A `PublicProfile` / `PublicCoach` `full_name` — never an email. */
  name: string;
  /**
   * A ready-to-render URL, from `avatarPublicUrl()`. `null` or absent renders
   * initials, which is the normal case rather than a fallback.
   */
  src?: string | null;
  size?: InitialsAvatarSize;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        // `shrink-0` is load-bearing: the tile sits next to a name that wraps,
        // and a flex item with a long unbroken neighbour will otherwise be
        // squeezed to nothing at 375px.
        'inline-flex shrink-0 items-center justify-center overflow-hidden border border-ink bg-surface-2 font-mono font-medium tracking-[0.06em] text-ink select-none',
        SIZES[size],
        className,
      )}
    >
      {src ? (
        /*
         * A plain `<img>`, not `next/image`, and on purpose. The optimizer
         * needs `images.remotePatterns` naming the storage host — which is an
         * ENVIRONMENT value here, so it would bake a per-deployment origin into
         * build config. For a 44px tile served from a public bucket behind a
         * CDN there is nothing left for the optimizer to win.
         *
         * `object-cover` because an avatar is a square crop of whatever the
         * user uploaded; without it a portrait photo renders stretched.
         *
         * No `alt` text: the whole tile is `aria-hidden` (see above) because
         * every call site prints the name in text right beside it.
         */
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}
