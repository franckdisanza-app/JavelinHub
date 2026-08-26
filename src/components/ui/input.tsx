import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

// A field is a White box with a 1px rule line and square corners (guidelines
// section 06). `min-h-11` is the 44px WCAG 2.5.5 touch floor, matching `Select`.
//
// `text-field` is the 16px carve-out token, and 16px is not a style choice:
// iOS Safari zooms the whole page in when a focused input's font-size is below
// 16px, which wrecks a 375px layout. The v1.1 amendment codifies it — labels
// are 10px, the values people type are always 16px. It is a token of its own
// rather than a step of the mono scale because the rule holds for `Textarea`
// too, which is set in the body face.
const BASE =
  'block w-full min-h-11 border bg-surface px-3 py-2.5 text-field text-ink ' +
  'placeholder:text-faint transition-colors ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted';

// Hover darkens the rule to Ink rather than to Sector Blue. Blue is the signal
// colour — one per screen, spent on the action the thrower should take next —
// so it belongs to the focus outline here, not to every field a pointer crosses.
const OK = 'border-line hover:border-ink';
const BAD = 'border-danger';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Draws the error border and is what `Field` uses to wire up `aria-invalid`. */
  invalid?: boolean;
}

/**
 * A single-line field. Set in Plex Mono: section 04 gives the mono face
 * everything measured — distances, timestamps, codes — and the doc's own field
 * specimen is a mono box. `Textarea` deliberately does not follow it.
 */
export function Input({ invalid = false, className, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(BASE, 'font-mono', invalid ? BAD : OK, className)}
      {...props}
    />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

/**
 * Multi-line prose — a coach bio, an application, a plan description.
 *
 * Stays in the body face rather than mono. Section 04 gives Newsreader the job
 * of making a bio "feel written rather than generated", and it names bios
 * specifically; a paragraph typed into a monospaced box reads as a terminal.
 * Mono is for the measured single-line values, which is what `Input` holds.
 */
export function Textarea({ invalid = false, className, rows = 4, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(BASE, invalid ? BAD : OK, 'resize-y', className)}
      {...props}
    />
  );
}
