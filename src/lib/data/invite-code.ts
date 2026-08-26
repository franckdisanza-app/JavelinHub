/**
 * Invite-code minting — shared by every `DataClient` implementation.
 *
 * Extracted from `mock/mockClient.ts` when `SupabaseDataClient` was added, for
 * the same reason `validation.ts` was: an invite code is part of the product's
 * surface, not an implementation detail of one store. Two generators would let
 * the format drift between backends, and `invites.code` has no format
 * constraint in SQL to catch it — `0001_init.sql` types the column as plain
 * `text`, so a second, subtly different generator would be accepted silently
 * and the admin UI would start showing two shapes of code.
 *
 * SERVER ONLY — `node:crypto`.
 */

import { randomInt } from 'node:crypto';

/**
 * Deliberately missing I, L, O, U, 0 and 1.
 *
 * Codes get read aloud, written down and retyped, and the excluded characters
 * are the ones that get confused for each other in that loop. U is out because
 * it keeps four-character groups from spelling anything unfortunate.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** A fresh code in `XXXX-XXXX-XXXX` form. */
export function generateInviteCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < 3; group += 1) {
    let chunk = '';
    for (let index = 0; index < 4; index += 1) {
      // randomInt, not Math.random: an invite code is a bearer credential that
      // promotes its holder to an approved coach, so it must not be guessable
      // from observed codes.
      chunk += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    groups.push(chunk);
  }
  return groups.join('-');
}
