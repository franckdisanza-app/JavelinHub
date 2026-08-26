import { cn } from '@/components/ui/cn';

/**
 * The JavelinHub lockup — brand guidelines section 02.
 *
 * Two parts, and only one of them is text. The **mark** is the thrower carrying
 * the javelin at 34°, the angle the event is decided by; it is decorative and
 * `aria-hidden`, because a screen reader announcing "javelin thrower graphic"
 * beside the name would say the name twice. The **name** is real text set in two
 * weights: JAVELIN at 100 against HUB at 900 — the run-up against the release.
 *
 * ACCESSIBLE NAME. Section 02's v1.1 amendment fixes it as the single string
 * `JavelinHub` — never "Javelin Hub", never split across two labelled elements.
 * That is why the two weight runs carry no `aria-label`, no `title` and no
 * `role`: they are styled spans, so the name is computed from their text
 * content, and adjacent JSX children with no literal whitespace between them
 * concatenate to exactly `JavelinHub`. Do not put them on separate source lines
 * with a space, and do not "helpfully" label either half — either change would
 * turn one name into two.
 *
 * Where this lockup is the content of a link — the header — that link also
 * states `aria-label="JavelinHub"`. Same string, so nothing is contradicted;
 * it just stops the name depending on a name-from-contents traversal.
 *
 * The capitals come from CSS, not from the source text, which is what keeps the
 * name mixed-case: the doc's own lockup markup is `Javelin` + `Hub` under
 * `text-transform: uppercase`, and typing `JAVELIN`/`HUB` instead would make
 * the name the string `JAVELINHUB` — the wrong string, and one some screen
 * readers spell out a letter at a time.
 *
 * SIZE. One size, on purpose. The wide mark may not go below 26px tall
 * (section 02, minimum size) — under that the figure's limbs merge and the doc
 * requires switching to the square icon, which is a different drawing. At the
 * doc's own lockup proportions (mark height ≈ 0.87 × the type size) a 22px
 * lockup would put the mark at 19px, so the smallest display step this drawing
 * can sit beside is 34. A `size="sm"` prop would therefore be a prop whose only
 * job is to violate the mark's minimum.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-4 font-display text-display-34 leading-[0.85] tracking-[0.005em] uppercase text-ink',
        className,
      )}
    >
      {/* The wide mark, 72×48. Landscape is arithmetic, not taste: a javelin
          rises 0.559 × its own length at 34°, so a full-length shaft needs more
          width than a square frame gives it. Never squash this into a square —
          `src/app/icon.svg` holds the separately drawn square icon for that.
          30px tall clears the 26px floor; 45px wide preserves the 3:2 frame. */}
      <svg
        viewBox="0 0 72 48"
        aria-hidden="true"
        focusable="false"
        className="h-[30px] w-[45px] shrink-0 text-brand"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 40 L62 4.93" />
        <circle cx="44" cy="11" r="5" fill="currentColor" stroke="none" />
        <path d="M45 17 L46.5 29" />
        <path d="M45 17.5 L50 15 L54 10.32" />
        <path d="M45 18 L36 21" />
        <path d="M46.5 29 L38 34 L33 43" />
        <path d="M46.5 29 L53 35 L58 44" />
      </svg>
      {/* One word, no space — see the accessible-name note above. */}
      <span className="whitespace-nowrap">
        <span className="font-thin">Javelin</span><span className="font-black">Hub</span>
      </span>
    </span>
  );
}
