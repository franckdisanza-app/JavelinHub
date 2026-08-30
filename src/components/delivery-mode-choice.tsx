'use client';

import { FULFILMENT_MODES, type FulfilmentMode } from '@/lib/data/types';

/**
 * How this offer is delivered — a radio group, shared by the composer and the
 * editor.
 *
 * ONE COPY OF THE EXPLANATION, which is why this is a component rather than
 * twenty lines in each form. A coach picking a delivery mode is making the one
 * decision on the page that they cannot undo after somebody claims the offer,
 * and two hand-maintained descriptions of that choice would eventually describe
 * it differently.
 *
 * A RADIO GROUP, not a `<select>`. There are two options, each needs a sentence
 * of explanation, and a select shows its options only while open — so the reader
 * would have to open it to find out what they are choosing between. The
 * corresponding cost is handled: `fieldset`/`legend` gives the group a name for
 * a screen reader, which is the thing a bare stack of inputs loses.
 *
 * `onChange` exists because the composer reveals a file input for `instant` and
 * hides it for `personalised`. Nothing here decides anything: the value posts as
 * `fulfilment`, and both the Server Action and `createListing` narrow it again.
 */
export interface DeliveryModeChoiceProps {
  /** Current selection. Controlled, so the parent can react to the change. */
  value: FulfilmentMode;
  onChange: (mode: FulfilmentMode) => void;
  /**
   * Locks the whole group. The editor passes this once an offer has been
   * claimed, because `guard_listing_update()` refuses the change from then on —
   * offering a control guaranteed to fail is worse than offering none, the same
   * rule the dashboard's Restore button follows.
   */
  disabled?: boolean;
  /** Why it is locked. Rendered in place of the hint when `disabled`. */
  disabledNote?: string;
  /**
   * False on the mock backend, which has no file storage. Instant delivery is
   * then not offerable at all — the mode exists to hand over a file — so the
   * option is rendered inert with an explanation rather than silently missing.
   */
  storageAvailable: boolean;
  error?: string;
}

const DESCRIPTIONS: Record<FulfilmentMode, string> = {
  personalised:
    'You upload something for each buyer after they claim it — and they can send you something first, which is how a video review works.',
  instant: 'You attach one file now. Every buyer downloads it the moment they claim the offer.',
};

export function DeliveryModeChoice({
  value,
  onChange,
  disabled = false,
  disabledNote,
  storageAvailable,
  error,
}: DeliveryModeChoiceProps) {
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={error ? 'fulfilment-error' : undefined}>
      {/*
        A `<legend>`, not the `Label` component: `Label` renders a real
        `<label>`, and a label names ONE control while this names the group. So
        the legend borrows the field-label class list from `label.tsx` rather
        than the component — keep the two in step by hand if that spec moves.
      */}
      <legend className="block font-mono text-mono-10 font-medium tracking-[0.14em] text-muted uppercase">
        How it is delivered
      </legend>

      <div className="flex flex-col border border-line">
        {FULFILMENT_MODES.map((mode) => {
          // Instant needs somewhere to put the file. On the mock store there is
          // nowhere, so the option is disabled here AND refused by the action.
          const unavailable = mode === 'instant' && !storageAvailable;
          const locked = disabled || unavailable;

          return (
            <label
              key={mode}
              className={
                'flex min-h-11 cursor-pointer items-start gap-3 border-b border-line p-3 last:border-b-0 ' +
                (locked ? 'cursor-not-allowed bg-surface-2' : 'hover:bg-surface-2')
              }
            >
              <input
                type="radio"
                name="fulfilment"
                value={mode}
                checked={value === mode}
                disabled={locked}
                onChange={() => onChange(mode)}
                className="mt-1 h-4 w-4 shrink-0 accent-brand"
              />
              <span className="min-w-0">
                <span className={'block text-sm font-semibold ' + (locked ? 'text-muted' : 'text-ink')}>
                  {mode === 'instant' ? 'Instant download' : 'Made for each buyer'}
                </span>
                <span className="mt-0.5 block text-body-15 leading-relaxed text-muted">
                  {unavailable
                    ? 'Not available here — this app is running on the local JSON store, which has no file storage.'
                    : DESCRIPTIONS[mode]}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {disabled && disabledNote ? <p className="text-body-15 text-faint">{disabledNote}</p> : null}
      {error ? (
        <p id="fulfilment-error" className="text-body-15 font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * Narrows a form value back to a mode on the client, for the two forms that
 * hold it in state. The SERVER does this again with `isFulfilmentMode` and does
 * not trust this — see the note on the component.
 */
export function toModeOrDefault(value: string | undefined, fallback: FulfilmentMode): FulfilmentMode {
  return value === 'instant' || value === 'personalised' ? value : fallback;
}
