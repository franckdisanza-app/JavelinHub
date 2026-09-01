'use client';

import { useActionState } from 'react';

import { setOfferAssetAction } from '@/app/coach/offers/actions';
import { Alert } from '@/components/ui/alert';
import { Button, linkButtonClass } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { idleFormState } from '@/lib/forms';

/** Mirrors the bucket's own `allowed_mime_types`. A picker filter, not a check. */
const ACCEPT =
  'application/pdf,image/png,image/jpeg,image/webp,video/mp4,video/quicktime,text/plain,text/csv,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface OfferAssetFormProps {
  listingId: string;
  /** The stored object path, or `null` when nothing is attached. */
  currentPath: string | null;
  /** The current file's name, derived from the path for display only. */
  currentName: string | null;
  /** A short-lived signed URL so the coach can check what buyers will get. */
  currentUrl: string | null;
  /** False on the mock backend, which has no file storage at all. */
  available: boolean;
}

/**
 * Attach, replace or remove the file an instant offer delivers.
 *
 * TWO FORMS, not one — the same construction as `AvatarForm`, and for the same
 * reason: the upload carries a file and the removal carries nothing but an
 * intent. One form with a mode flag would need the file input to be
 * optional-but-present, and would make "remove" depend on the browser having
 * nothing selected.
 *
 * Rendered only for an instant offer. A personalised one has nothing to attach,
 * and `setListingAsset` refuses a path on one regardless of what this shows.
 */
export function OfferAssetForm({
  listingId,
  currentPath,
  currentName,
  currentUrl,
  available,
}: OfferAssetFormProps) {
  const [state, formAction, pending] = useActionState(setOfferAssetAction, idleFormState);

  return (
    <div className="flex flex-col gap-4">
      {state.status === 'error' && state.message ? <Alert tone="error">{state.message}</Alert> : null}

      {currentPath === null ? (
        /*
          Not a soft warning. `claim_offer` refuses an instant offer with no
          file, so this offer is on sale and cannot be bought — the coach has to
          learn that here rather than from a buyer.
        */
        <Alert tone="warn" title="No file attached, so nobody can claim this.">
          An instant-download offer hands over one file the moment it is claimed. Until you attach it, the
          offer is visible but every attempt to claim it is refused.
        </Alert>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-line p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium break-words text-ink">{currentName}</p>
            <p className="mt-0.5 text-xs text-faint">This is what a buyer downloads.</p>
          </div>
          {currentUrl ? (
            /*
              A short-lived signed URL, so an ordinary link rather than a route
              of ours — and no `download` attribute, because the signed URL
              already carries the filename as a content-disposition that a
              `download` attribute would not survive the redirect to apply.
            */
            <a
              href={currentUrl}
              rel="noopener noreferrer"
              className={linkButtonClass({ variant: 'secondary', size: 'sm' })}
            >
              Download<span className="sr-only"> {currentName}</span>
            </a>
          ) : (
            <span className="text-xs text-faint">Link unavailable</span>
          )}
        </div>
      )}

      {/*
        WHAT IS ATTACHED renders above regardless of the backend; only the
        CONTROLS depend on storage. An earlier draft returned this notice in
        place of the whole component, which hid a coach's own file from them on a
        backend where the row still says it is there — the display is a read, and
        the read works everywhere.
      */}
      {!available ? (
        <Alert tone="info" title="File uploads are not available here.">
          This app is running on the local JSON store, which has no file storage. Everything else on this
          page works; set <code className="font-mono text-mono-13">DATA_BACKEND=supabase</code> to attach or
          remove a file.
        </Alert>
      ) : (
        <>
          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="id" value={listingId} />
            <input type="hidden" name="intent" value="set" />
            <Field
              id="asset"
              label={currentPath ? 'Replace the file' : 'Attach the file'}
              hint="PDF, image, video, text, CSV or spreadsheet, up to 50 MB. Buyers who already claimed this get the new file too."
            >
              <Input
                id="asset"
                name="asset"
                type="file"
                accept={ACCEPT}
                required
                aria-describedby={fieldDescribedBy('asset', { hint: true })}
              />
            </Field>
            <div>
              <Button type="submit" variant="secondary" disabled={pending}>
                {pending ? 'Uploading…' : currentPath ? 'Replace file' : 'Attach file'}
              </Button>
            </div>
          </form>

          {/*
            Its own form, so removing does not require the file input above to be
            empty — and so that input's `required` cannot block it.
          */}
          {currentPath ? (
            <form action={formAction}>
              <input type="hidden" name="id" value={listingId} />
              <input type="hidden" name="intent" value="clear" />
              <Button type="submit" variant="danger" size="sm" disabled={pending}>
                Remove file
              </Button>
              <p className="mt-2 text-body-15 text-faint">
                The offer stays published but stops being claimable until you attach another one.
              </p>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}
