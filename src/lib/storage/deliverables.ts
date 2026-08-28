/**
 * =============================================================================
 * Delivery file storage — PRIVATE, unlike avatars.
 * =============================================================================
 *
 * `avatars.ts` serves a public bucket: a URL is a pure function of the path,
 * there is no expiry, and a CDN caches it. **None of that is true here**, and
 * the difference is the whole point. A training plan or a video review is
 * something one person claimed; it must be readable by the two people the order
 * names and by nobody else, including anyone who has the URL.
 *
 * So every read is a SIGNED URL, minted per request, short-lived, and only for
 * a caller the storage policies already admit. `createSignedUrl` is not a
 * bypass: it runs through the request-scoped client, so
 * `deliverables_read_party` is evaluated against the real `auth.uid()` and a
 * caller who is not on the order gets an error rather than a link.
 *
 * The same split as avatars applies: the PATH is data and lives in the
 * `deliverables` table through `DataClient`; the BYTES are storage and live
 * here, Supabase only.
 *
 * SERVER ONLY.
 */

import { createSupabaseServerClient } from '@/lib/data/supabase/serverClient';
import { DataError } from '@/lib/data/types';
import { dataBackend } from '@/lib/env';

if (typeof window !== 'undefined') {
  throw new Error(
    'Delivery storage is server-only and was imported into browser code. ' +
      'Call it from a server component, server action or route handler instead.',
  );
}

/** Mirrors the buckets created in `supabase/migrations/0011_delivery.sql`. */
export const DELIVERABLES_BUCKET = 'deliverables';
export const OFFER_ASSETS_BUCKET = 'offer-assets';

/** Kept in step with both buckets' own `file_size_limit` / `allowed_mime_types`. */
export const DELIVERY_MAX_BYTES = 50 * 1024 * 1024;

export const DELIVERY_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/**
 * How long a download link lives.
 *
 * Long enough to click and for a large video to start streaming, short enough
 * that a link pasted somewhere public is worthless by the time anyone finds it.
 * The link is minted fresh on every page render, so this is not a session
 * length — it is the window in which a leaked URL still works.
 */
const SIGNED_URL_SECONDS = 300;

/** False on the mock backend, which has no file storage at all. */
export function deliveryStorageAvailable(): boolean {
  return dataBackend() === 'supabase';
}

export interface DeliveryFileCheck {
  ok: boolean;
  message?: string;
}

/**
 * Validates a candidate file WITHOUT reading it. Both rules are enforced again
 * by the bucket, which is the guarantee; this is the readable half.
 */
export function checkDeliveryFile(file: File): DeliveryFileCheck {
  if (file.size === 0) return { ok: false, message: 'That file is empty.' };
  if (file.size > DELIVERY_MAX_BYTES) return { ok: false, message: 'Files have to be 50 MB or smaller.' };
  if (!DELIVERY_MIME_TYPES.includes(file.type)) {
    return { ok: false, message: 'Use a PDF, image, video, text, CSV or spreadsheet file.' };
  }
  return { ok: true };
}

/**
 * Strips a browser-supplied filename down to something safe to store and to
 * render.
 *
 * The name reaches two places that matter: the object key, and a `download`
 * attribute the other party will click. Path separators and traversal are
 * removed so the key cannot escape its folder — the storage policy would refuse
 * that anyway, but a name that produces a refusal is a worse error than a name
 * that was cleaned.
 */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    // Control characters, escaped rather than written literally: an earlier
    // version of this line held the raw bytes and compiled to a class that
    // stripped almost everything.
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const capped = cleaned.slice(0, 120);
  return capped === '' ? 'file' : capped;
}

/**
 * Uploads a delivery file and returns its object path.
 *
 * The path is DERIVED — `<order_id>/<uploader_id>/<random>-<name>` — so nothing
 * a caller supplies decides where it lands. Segment 1 is what
 * `deliverables_read_party` looks the order up by; segment 2 is what
 * `deliverables_write_party` pins the writer to. The random prefix means two
 * uploads of `throw.mp4` are two files rather than one silently overwriting the
 * other, which matters when the buyer and the coach are both attaching to the
 * same order.
 */
export async function uploadDeliveryFile(
  orderId: string,
  uploaderId: string,
  file: File,
): Promise<{ path: string; fileName: string }> {
  if (!deliveryStorageAvailable()) {
    throw new DataError(
      'invalid',
      'File delivery needs the Supabase backend. This app is running on the local mock store.',
    );
  }

  const check = checkDeliveryFile(file);
  if (!check.ok) throw new DataError('invalid', check.message ?? 'That file could not be used.');

  const fileName = safeFileName(file.name);
  const unique = crypto.randomUUID().slice(0, 8);
  const path = `${orderId}/${uploaderId}/${unique}-${fileName}`;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.storage.from(DELIVERABLES_BUCKET).upload(path, file, {
    contentType: file.type,
    // Never overwrite: the random prefix already makes the key unique, and an
    // upsert here would let a second upload silently replace a delivered file.
    upsert: false,
  });

  if (error) {
    throw new DataError('invalid', 'That file could not be uploaded. Please try again.');
  }

  return { path, fileName };
}

/**
 * A short-lived download link, or `null`.
 *
 * `null` rather than a throw: a page renders a list of files, and one that has
 * gone missing from the bucket should cost that row its link, not the whole
 * page. The caller shows the file without a download and the rest still works.
 */
export async function signedDeliveryUrl(path: string, downloadAs?: string): Promise<string | null> {
  if (!deliveryStorageAvailable()) return null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.storage
      .from(DELIVERABLES_BUCKET)
      .createSignedUrl(path, SIGNED_URL_SECONDS, downloadAs ? { download: downloadAs } : undefined);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * Removes the stored object. Best-effort, like `deleteAvatar`.
 *
 * The row is what makes a file part of the order; the bytes are housekeeping.
 * But see `supabase/README.md`, "Storage objects are not cleaned up by
 * cascades": the object must go FIRST, because once the row (or the uploader's
 * account) is gone, no delete policy admits anybody and the object becomes
 * permanently unreachable litter.
 */
export async function deleteDeliveryFile(path: string): Promise<void> {
  if (!deliveryStorageAvailable()) return;
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.storage.from(DELIVERABLES_BUCKET).remove([path]);
  } catch {
    // Deliberately swallowed — see above.
  }
}
