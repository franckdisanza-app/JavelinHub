'use client';

import { useActionState } from 'react';

import { changePasswordAction, updateAvatarAction, updateNameAction } from '@/app/settings/actions';
import { InitialsAvatar } from '@/components/initials-avatar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';

/**
 * The three account forms.
 *
 * THREE FORMS AND THREE ACTIONS, not one of each. They fail independently and
 * for unrelated reasons — a rejected picture must not discard a name the user
 * just typed, and a wrong current password must not make them re-pick a
 * picture. It is the same reasoning `AvatarForm` used when it was split out of
 * the coach profile save, applied to the whole page.
 */

/** Rename. The name is published on reviews and on a coach's directory card. */
export function NameForm({ currentName }: { currentName: string }) {
  const [state, formAction, pending] = useActionState(updateNameAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.status === 'success' ? <Alert tone="success">Your name is saved.</Alert> : null}
      {state.status === 'error' && state.message && !errors.fullName ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <Field
        id="fullName"
        label="Your name"
        hint="Shown on any review you write, and on your coach card if you have one."
        error={errors.fullName}
      >
        <Input
          id="fullName"
          name="fullName"
          type="text"
          autoComplete="name"
          maxLength={120}
          required
          // `defaultValue` from the server on first render, from the returned
          // state after a failed one — so a rejected name is still in the box
          // to correct rather than silently reverted.
          defaultValue={state.values?.fullName ?? currentName}
          invalid={Boolean(errors.fullName)}
          aria-describedby={fieldDescribedBy('fullName', { hint: true, error: errors.fullName })}
        />
      </Field>

      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving…' : 'Save name'}
        </Button>
      </div>
    </form>
  );
}

export interface AvatarFormProps {
  name: string;
  /** Ready-to-render URL for the current picture, or `null` for none. */
  currentUrl: string | null;
  /** The stored object path, needed to delete the file when replacing or clearing. */
  currentPath: string | null;
  /** False on the mock backend, which has no file storage at all. */
  available: boolean;
}

/**
 * Upload, replace or remove the profile picture. **For everyone**, not only
 * coaches — `setMyAvatar` was always open to any signed-in user and only the UI
 * was coach-facing.
 *
 * Two forms rather than one, because they are two different submissions: the
 * upload carries a file and the removal carries nothing but an intent. A single
 * form with a mode flag would need the file input to be optional-but-present,
 * and would make "remove" depend on the browser having nothing selected.
 */
export function AvatarForm({ name, currentUrl, currentPath, available }: AvatarFormProps) {
  const [state, formAction, pending] = useActionState(updateAvatarAction, idleFormState);

  return (
    <div className="flex flex-col gap-4">
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <div className="flex items-center gap-4">
        <InitialsAvatar name={name} src={currentUrl} size="lg" />
        <p className="text-sm leading-relaxed text-muted">
          {currentUrl
            ? 'This is what other people see beside your name.'
            : 'No picture yet — people see your initials, which is a perfectly good default.'}
        </p>
      </div>

      {available ? (
        <>
          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="set" />
            {/* The file being replaced, deleted only after the column has moved. */}
            <input type="hidden" name="current" value={currentPath ?? ''} />
            <Field
              id="avatar"
              label={currentUrl ? 'Replace your picture' : 'Upload a picture'}
              hint="PNG, JPEG or WebP, up to 2 MB. Square images work best — anything else is cropped to a square."
            >
              <Input
                id="avatar"
                name="avatar"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                required
                aria-describedby={fieldDescribedBy('avatar', { hint: true })}
              />
            </Field>
            <div>
              <Button type="submit" variant="secondary" disabled={pending}>
                {pending ? 'Uploading…' : currentUrl ? 'Replace picture' : 'Upload picture'}
              </Button>
            </div>
          </form>

          {/*
            Its own form, so removing a picture does not require the file input
            above to be empty — and so that input's `required` cannot block it.
          */}
          {currentPath ? (
            <form action={formAction}>
              <input type="hidden" name="intent" value="clear" />
              <input type="hidden" name="current" value={currentPath} />
              <Button type="submit" variant="danger" size="sm" disabled={pending}>
                Remove picture
              </Button>
            </form>
          ) : null}
        </>
      ) : (
        <Alert tone="info" title="Picture uploads are not available here.">
          This app is running on the local JSON store, which has no file storage. Everything else on this
          page works; set <code className="font-mono text-mono-13">DATA_BACKEND=supabase</code> to upload a
          picture.
        </Alert>
      )}
    </div>
  );
}

/**
 * Change the password, knowing the old one.
 *
 * NOT the reset form. That one asks for no current password because its user
 * reached it by proving control of their inbox precisely to say they do not
 * have one; here a session alone is a weaker claim, so the old password is the
 * second factor.
 *
 * Nothing is echoed back on failure — the action returns no `values` — so both
 * boxes clear. A password rendered into HTML lands in the browser cache, in a
 * bfcache snapshot, and in any proxy that sees the response.
 */
export function PasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, idleFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {state.status === 'success' ? (
        <Alert tone="success" title="Your password is changed.">
          You are still signed in here. Use the new one next time.
        </Alert>
      ) : null}
      {state.status === 'error' && state.message && Object.keys(errors).length === 0 ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <Field id="current" label="Current password" error={errors.current}>
        <Input
          id="current"
          name="current"
          type="password"
          autoComplete="current-password"
          required
          invalid={Boolean(errors.current)}
          aria-describedby={fieldDescribedBy('current', { error: errors.current })}
        />
      </Field>

      <Field id="password" label="New password" hint="At least 8 characters." error={errors.password}>
        <Input
          id="password"
          name="password"
          type="password"
          // `new-password` tells a password manager to offer to generate one and
          // then to save the result — the difference between a manager that
          // helps here and one that autofills the password being replaced.
          autoComplete="new-password"
          required
          invalid={Boolean(errors.password)}
          aria-describedby={fieldDescribedBy('password', { hint: true, error: errors.password })}
        />
      </Field>

      <Field id="confirm" label="Confirm new password" error={errors.confirm}>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          invalid={Boolean(errors.confirm)}
          aria-describedby={fieldDescribedBy('confirm', { error: errors.confirm })}
        />
      </Field>

      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Changing…' : 'Change password'}
        </Button>
      </div>
    </form>
  );
}
