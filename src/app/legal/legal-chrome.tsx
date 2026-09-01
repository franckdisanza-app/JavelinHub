import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { LEGAL, LEGAL_LAST_UPDATED, legalGaps, type LegalFacts } from '@/lib/legal';

/**
 * =============================================================================
 * The shared furniture of a legal document.
 * =============================================================================
 *
 * Three pages — terms, privacy, refunds — with the same masthead, the same two
 * banners and the same typographic treatment, so they read as one set rather
 * than as three documents that happened to land in the same folder.
 *
 * A Server Component with no interactivity, which is why it can sit beside the
 * pages rather than under `components/`: nothing else in the app renders a
 * legal document, and a shared primitive that has exactly one kind of consumer
 * belongs next to it.
 *
 * ON THE TYPE. These are the only pages in the product that are *read* at
 * length rather than scanned, so the measure is capped near 68 characters and
 * the body face carries everything. Headings are display type at the two steps
 * the scale offers below the page title; there is no third level, because a
 * legal document that needs `h4` needs restructuring instead.
 */

/**
 * One fact from `LEGAL`, or a marker that it is missing.
 *
 * THE MARKER IS DELIBERATELY UGLY. It is Foul Red on Chalk in the mono face at
 * a size nothing else on the page uses, because its entire job is to be
 * impossible to skim past — a document that looks finished and is not is the
 * failure this whole mechanism exists to prevent. It reads as a blank in a form
 * rather than as an error, which is what it is.
 */
export function Fact({ name }: { name: keyof LegalFacts }) {
  const value = LEGAL[name];

  if (value === null || (Array.isArray(value) && value.length === 0)) {
    return (
      <span className="border border-danger bg-surface-2 px-1.5 py-0.5 font-mono text-mono-11 tracking-[0.08em] uppercase text-danger">
        {name}
      </span>
    );
  }

  if (Array.isArray(value)) return <>{value.join(', ')}</>;
  return <>{String(value)}</>;
}

/** A section heading inside a document. */
export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2
        id={id}
        className="font-display text-display-22 leading-[0.9] font-bold tracking-[0.005em] uppercase text-ink"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The page shell: title, the two standing banners, and the document.
 *
 * BANNER ONE IS UNCONDITIONAL and stays until a person removes it. It says the
 * document has not been reviewed by a lawyer, which no code can ever verify —
 * see the note in `src/lib/legal.ts`. Keying it off `legalIsComplete()` would
 * make filling in an address look like passing a legal review.
 *
 * BANNER TWO clears itself, because it lists exactly the facts still missing
 * from `LEGAL` and disappears when there are none.
 */
export function LegalPage({
  title,
  summary,
  children,
}: {
  title: string;
  /** One sentence on what this document covers. Rendered under the title. */
  summary: string;
  children: ReactNode;
}) {
  const gaps = legalGaps();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-col gap-2 border-b border-line-strong pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">{title}</h1>
        <p className="text-body-17 text-muted">{summary}</p>
        <p className="font-mono text-mono-11 tracking-[0.1em] uppercase text-faint">
          Last updated {LEGAL_LAST_UPDATED}
        </p>
      </header>

      <div className="mt-6 flex flex-col gap-4">
        <Alert tone="warn" title="This is a draft and has not been reviewed by a lawyer.">
          <p>
            It was written from the software itself, so what it says about how JavelinHub behaves is
            accurate. Whether it is sufficient, enforceable or right for this business is a question
            for somebody qualified to answer it. Do not rely on it, and do not publish it as final.
          </p>
        </Alert>

        {gaps.length > 0 ? (
          <Alert tone="error" title={`${gaps.length} facts are still missing.`}>
            <p>
              Every red marker below is one of these. Fill them in at <code>src/lib/legal.ts</code> —
              one object, one edit — and this banner, the markers and the{' '}
              <code>noindex</code> on this page all clear themselves.
            </p>
            <ul className="mt-3 flex list-disc flex-col gap-1 pl-5">
              {gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>

      {/* `max-w-[68ch]` rather than the container's own width: this is the only
          reading surface in the product, and 68 characters is where a long
          paragraph stops being hard work. */}
      <article className="mt-10 flex max-w-[68ch] flex-col gap-8 text-body-17 leading-relaxed text-ink">
        {children}
      </article>
    </div>
  );
}
