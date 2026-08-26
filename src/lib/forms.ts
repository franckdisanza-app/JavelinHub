/**
 * Shared form-state contract for every `useActionState` form in the app.
 *
 * This is a plain module, not a `'use server'` one, precisely so that it can
 * export *types and constants*: a file carrying the `'use server'` directive
 * may only export async functions, so the state shape a Server Action returns
 * has to live somewhere else. Client components import `idleFormState` and the
 * `FormState` type from here; actions import the helpers.
 */

import { isDataError } from '@/lib/data/types';

export interface FormState {
  /**
   * `idle` is the pre-submission state and renders nothing. Keeping it distinct
   * from `error` is what stops a freshly loaded form from showing a red banner.
   */
  status: 'idle' | 'error' | 'success';
  /** Form-level message, safe to render verbatim. */
  message?: string;
  /** Field-level messages keyed by the input's `name`. */
  fieldErrors?: Record<string, string>;
  /**
   * Values to re-populate the form with after a failed submit. Never put a
   * password in here — it would be echoed back into the HTML.
   */
  values?: Record<string, string>;
}

export const idleFormState: FormState = { status: 'idle' };

/** A failure with no particular field to blame. */
export function formError(message: string, values?: Record<string, string>): FormState {
  return { status: 'error', message, values };
}

/** A failure attributable to specific fields. */
export function fieldError(fieldErrors: Record<string, string>, values?: Record<string, string>): FormState {
  return {
    status: 'error',
    message: 'Please correct the highlighted fields.',
    fieldErrors,
    values,
  };
}

export function formSuccess(message: string): FormState {
  return { status: 'success', message };
}

/**
 * Turns an unknown thrown value into a `FormState`, or rethrows.
 *
 * Only `DataError` is converted — its `message` is written for end users and is
 * safe to render verbatim (see `docs/DATA-LAYER.md`). Anything else is a real
 * bug and is rethrown so it reaches `error.tsx` and the server log rather than
 * being flattened into a friendly-looking banner that hides a stack trace.
 *
 * `unauthorized` is deliberately NOT handled here: a caller that can redirect
 * to the login page should do so, and it must call `redirect()` outside of any
 * `try` block, so that decision belongs to the action.
 *
 * `fieldFor` lets an action attach the message to an input. The data layer
 * returns one human sentence rather than a machine-readable field name, so the
 * mapping is a caller-supplied heuristic and falls back to a form-level error.
 */
export function toFormState(
  error: unknown,
  options?: { values?: Record<string, string>; fieldFor?: (message: string, code: string) => string | null },
): FormState {
  if (!isDataError(error)) throw error;

  const field = options?.fieldFor?.(error.message, error.code) ?? null;
  if (field) {
    return {
      status: 'error',
      message: error.message,
      fieldErrors: { [field]: error.message },
      values: options?.values,
    };
  }
  return { status: 'error', message: error.message, values: options?.values };
}

/**
 * Field-guessing heuristic shared by the auth forms. Matches on the nouns the
 * data layer's validators use ("Email is required.", "Password must be …").
 */
export function guessAuthField(message: string): string | null {
  const text = message.toLowerCase();
  if (text.includes('email')) return 'email';
  if (text.includes('password')) return 'password';
  if (text.includes('full name')) return 'fullName';
  return null;
}
