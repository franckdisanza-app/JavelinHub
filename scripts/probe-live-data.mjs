/**
 * What is actually IN the live project?
 *
 * Written when the browse page rendered "0 offers" against Supabase and it was
 * not clear whether that meant an empty table or a broken query. Anon-readable
 * relations only — anything else answers 42501 and tells you nothing about the
 * row count.
 *
 *   node --env-file=.env.local scripts/probe-live-data.mjs
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and the anon key first.');
  process.exit(1);
}

const RELATIONS = [
  'listings',
  'public_coaches',
  'public_profiles',
  'public_listing_reviews',
  'public_coach_reviews',
  'offer_stats',
  'coach_stats',
];

for (const relation of RELATIONS) {
  // `head: true` + Prefer: count=exact returns the count in Content-Range and
  // no rows at all — the cheapest question you can ask a table.
  const response = await fetch(`${url}/rest/v1/${relation}?select=*&limit=1`, {
    method: 'HEAD',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
  });
  const range = response.headers.get('content-range') ?? '';
  const total = range.split('/')[1] ?? '?';
  console.log(`${String(response.status).padEnd(4)} ${relation.padEnd(24)} ${total} row(s)`);
}
