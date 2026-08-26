import { cn } from '@/components/ui/cn';
import { initialsOf } from '@/lib/initials';

/**
 * A square initials tile, derived entirely from the name.
 *
 * NO UPLOADS AND NO STORAGE, deliberately. An avatar upload is a file store, a
 * MIME sniffer, a size limit, an image proxy and a moderation problem, and it
 * would be the only user-supplied binary anywhere in this product. A tile
 * computed from a string is none of those things and cannot serve anything a
 * user did not already publish as their display name.
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
  size = 'sm',
  className,
}: {
  /** The display name. A `PublicProfile` / `PublicCoach` `full_name` — never an email. */
  name: string;
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
      {initialsOf(name)}
    </span>
  );
}
