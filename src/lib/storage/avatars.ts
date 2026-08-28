/**
 * =============================================================================
 * Avatar file storage.
 * =============================================================================
 *
 * THIS IS NOT PART OF `DataClient`, and the separation is the design rather
 * than an oversight.
 *
 * `DataClient` abstracts ROWS, and it has two complete implementations because
 * the mock is the code twin that `npm run verify:authz` exercises in place of
 * RLS. Storing BYTES is a different capability with a different backing store,
 * and the mock has no analogue for it — a JSON file cannot hold an object
 * bucket, and inventing a filesystem-backed imitation would mean maintaining a
 * second storage implementation that nothing ships on, to satisfy a symmetry
 * nobody needs.
 *
 * So the split runs along the honest line:
 *
 *   * the PATH is data. `DataClient.setMyAvatar()` writes `profiles.avatar_path`
 *     and BOTH backends implement it identically.
 *   * the FILE is storage. This module, and Supabase only.
 *
 * {@link avatarStorageAvailable} is how a page asks which world it is in, so
 * running on the mock degrades to "you cannot upload here" rather than to a
 * crash. Reading is unaffected either way: {@link avatarPublicUrl} is a pure
 * function of the configured Supabase origin, so a path that exists renders
 * wherever the origin is set.
 *
 * SERVER ONLY. Uploads go through the request-scoped client so that the
 * storage policies in `0008_avatars.sql` see the real `auth.uid()`; the
 * service-role key is not used here, exactly as it is not used anywhere in
 * `src/`.
 */

import { createSupabaseServerClient } from '@/lib/data/supabase/serverClient';
import { DataError } from '@/lib/data/types';
import { dataBackend, supabaseUrl } from '@/lib/env';

if (typeof window !== 'undefined') {
  throw new Error(
    'Avatar storage is server-only and was imported into browser code. ' +
      'Call it from a server component, server action or route handler instead.',
  );
}

/** Mirrors the bucket created in `supabase/migrations/0008_avatars.sql`. */
export const AVATAR_BUCKET = 'avatars';

/**
 * Kept in step with the bucket's own `allowed_mime_types` and
 * `file_size_limit`. Storage enforces both server-side, so these exist to
 * produce a sentence rather than a 400 — see the note in the migration.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Whether uploads are possible at all. False on the mock backend. */
export function avatarStorageAvailable(): boolean {
  return dataBackend() === 'supabase';
}

/**
 * The public URL for a stored avatar, or `null`.
 *
 * A pure function of the configured origin — no round trip, no signing, no
 * expiry, because the bucket is public. That is what makes an avatar cheap to
 * render on a directory page full of cards.
 *
 * Returns `null` for a missing path AND for an unconfigured origin, so a caller
 * has exactly one thing to check before falling back to initials.
 */
export function avatarPublicUrl(path: string | null | undefined): string | null {
  if (typeof path !== 'string' || path.trim() === '') return null;
  const origin = supabaseUrl();
  if (origin === null) return null;
  return `${origin}/storage/v1/object/public/${AVATAR_BUCKET}/${encodeURI(path)}`;
}

/** What {@link uploadAvatar} accepts, so callers can validate before reading bytes. */
export interface AvatarUploadCheck {
  ok: boolean;
  message?: string;
}

/**
 * Validates a candidate file WITHOUT reading it.
 *
 * Both rules are enforced again by the bucket, which is the guarantee; this is
 * the friendly half. Doing it here also avoids streaming two megabytes to
 * Supabase only to be told no.
 */
export function checkAvatarFile(file: File): AvatarUploadCheck {
  if (file.size === 0) return { ok: false, message: 'That file is empty.' };
  if (file.size > AVATAR_MAX_BYTES) {
    return { ok: false, message: 'Pictures have to be 2 MB or smaller.' };
  }
  if (!AVATAR_MIME_TYPES.includes(file.type)) {
    return { ok: false, message: 'Use a PNG, JPEG or WebP image.' };
  }
  return { ok: true };
}

/**
 * Stores the file and returns its path.
 *
 * The path is DERIVED from `userId` and the file's type — never taken from the
 * caller — so there is no input here that could aim the write at somebody
 * else's folder. The storage policies would refuse it anyway; this means the
 * question never reaches them.
 *
 * One object per user (`<uuid>/avatar.<ext>`) with `upsert`, so replacing an
 * avatar overwrites in place instead of accumulating orphans. The trade is that
 * the URL is stable, which a CDN will cache — {@link avatarCacheBuster} exists
 * because of that.
 */
export async function uploadAvatar(userId: string, file: File): Promise<string> {
  if (!avatarStorageAvailable()) {
    throw new DataError('invalid', 'Picture uploads need the Supabase backend. This app is running on the local mock store.');
  }

  const check = checkAvatarFile(file);
  if (!check.ok) throw new DataError('invalid', check.message ?? 'That picture could not be used.');

  const extension = EXTENSION_FOR_MIME[file.type];
  if (!extension) throw new DataError('invalid', 'Use a PNG, JPEG or WebP image.');

  const path = `${userId}/avatar.${extension}`;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type,
    // Long, because the object name only changes when the file type does. The
    // cache buster on the rendered URL is what makes a replacement visible.
    cacheControl: '3600',
  });

  if (error) {
    // Storage errors are not Postgres errors and carry no SQLSTATE, so
    // `errors.ts` cannot map them. The message is GoTrue/Storage's own and may
    // name internals, so it is replaced rather than shown.
    throw new DataError('invalid', 'That picture could not be uploaded. Please try again.');
  }

  return path;
}

/**
 * Removes the stored object. Best-effort by design.
 *
 * Clearing `profiles.avatar_path` is what makes an avatar gone as far as the
 * product is concerned; deleting the bytes is housekeeping. If the delete
 * fails, the row is still cleared and the orphan is invisible — so this never
 * throws and never blocks the column write.
 */
export async function deleteAvatar(path: string): Promise<void> {
  if (!avatarStorageAvailable()) return;
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.storage.from(AVATAR_BUCKET).remove([path]);
  } catch {
    // See the note above: an orphaned object is not worth failing a save over.
  }
}

/**
 * A stable per-version query string for an avatar URL.
 *
 * The object name is fixed (`avatar.png`), so replacing a picture does not
 * change its URL and a browser or CDN holding the old one keeps serving it.
 * Appending the profile's `updated_at` — which `setMyAvatar` bumps on every
 * write — busts exactly that cache and nothing else.
 */
export function avatarCacheBuster(url: string | null, updatedAt: string | null | undefined): string | null {
  if (url === null) return null;
  if (typeof updatedAt !== 'string' || updatedAt === '') return url;
  return `${url}?v=${encodeURIComponent(updatedAt)}`;
}
