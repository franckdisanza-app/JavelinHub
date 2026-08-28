'use client';

import { useActionState } from 'react';

import { updateAvatarAction } from '@/app/coach/profile/actions';
import { InitialsAvatar } from '@/components/initials-avatar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';

export interface AvatarFormProps {
  name: string;
  /** Ready-to-render URL for the current picture, or `null` for none. */
  currentUrl: string | null;
  /** The stored object path, needed to delete the file when clearing. */
  currentPath: string | null;
  /** False on the mock backend, which has no file storage at all. */
  available: boolean;
}

/**
 * Upload or remove the profile picture.
 *
 * Two forms rather than one, because they are two different submissions: the
 * upload carries a file and the removal carries nothing but an intent. A single
 * form with a mode flag would need the file input to be optional-but-present
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
            ? 'This is what learners see beside your name.'
            : 'No picture yet — learners see your initials, which is a perfectly good default.'}
        </p>
      </div>

      {available ? (
        <>
          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="set" />
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
            Its own form, so that removing a picture does not require the file
            input above to be empty — and so the file input's `required` cannot
            block it.
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
          This app is running on the local JSON store, which has no file storage. Everything else on this page
          works; set <code className="font-mono text-mono-13">DATA_BACKEND=supabase</code> to upload a picture.
        </Alert>
      )}
    </div>
  );
}
