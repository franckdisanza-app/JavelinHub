/**
 * Data-layer entry point.
 *
 * Call `getDataClient()` from server components, server actions and route
 * handlers. Never import `MockDataClient` (or, later, `SupabaseDataClient`)
 * directly from calling code — going through the factory is what makes the
 * backend swap a one-line config change.
 *
 *     import { getDataClient } from '@/lib/data';
 *
 *     const db = getDataClient();
 *     const listings = await db.listListings({ q: 'javelin' });
 *
 * See `src/lib/data/client.ts` and `docs/DATA-LAYER.md` for usage rules — in
 * particular the actor rule: every mutating method takes the actor first, and
 * the data layer resolves privileges itself.
 */

import { dataBackend } from '@/lib/env';

import type { DataClient } from './client';
import { MockDataClient } from './mock/mockClient';
import { SupabaseDataClient } from './supabase/supabaseClient';

export type { DataClient } from './client';
export type {
  CoachApplicationFilter,
  CoachDirectoryFilter,
  CreateCoachApplicationInput,
  CreateInviteInput,
  CreateListingInput,
  CreateReviewInput,
  ListingFilter,
  ListingSort,
  SignInInput,
  SignUpInput,
  UpdateListingInput,
  UpdateMyCoachProfileInput,
} from './client';
export { isListingSort, LISTING_SORTS } from './client';
export * from './types';
export * from './pagination';

let cached: DataClient | null = null;

export function getDataClient(): DataClient {
  if (cached) return cached;

  const backend = dataBackend();

  // Caching the CLIENT is safe for both backends and is what keeps this a
  // process-lifetime decision rather than a per-request one. Neither
  // implementation holds request state: the mock reads its JSON store on demand,
  // and `SupabaseDataClient` opens a fresh request-scoped Supabase client inside
  // every method — see the header of `supabase/serverClient.ts` for why holding
  // one on the instance would serve the first visitor's session to everybody.
  cached = backend === 'supabase' ? new SupabaseDataClient() : new MockDataClient();
  return cached;
}
