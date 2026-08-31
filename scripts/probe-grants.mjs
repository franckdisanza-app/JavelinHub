/**
 * Which functions can an ANONYMOUS caller execute?
 *
 * Written for one question, on one day: `verify:supabase` found that
 * `record_admin_action()` — which `0019` believed it had closed with
 * `revoke all ... from public` — answered 204 to an anonymous POST. Supabase's
 * project bootstrap runs
 *
 *   alter default privileges in schema public
 *     grant all on functions to anon, authenticated, service_role;
 *
 * so every function created in `public` gets an EXPLICIT grant to those roles,
 * and revoking from the `public` pseudo-role does not touch it.
 *
 * Every other privileged function guards itself (`is_admin()`, a null
 * `jwt_uid()` check), so being reachable is harmless for them — this sweep is
 * how that was established rather than assumed. Kept in the repo because the
 * next migration to add a function will hit the same default privileges.
 *
 *   node --env-file=.env.local scripts/probe-grants.mjs
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and the anon key first.');
  process.exit(1);
}

const NOWHERE = '00000000-0000-4000-8000-0000000000ff';

/** Every client-reachable function, with arguments PostgREST will accept. */
const CALLS = [
  ['is_admin', {}],
  ['is_approved_coach', {}],
  ['jwt_uid', {}],
  ['record_admin_action', { p_action: 'grant_admin', p_subject_id: NOWHERE, p_reason: 'probe' }],
  ['grant_admin', { p_user_id: NOWHERE }],
  ['apply_to_coach', { p_sport: 'javelin', p_experience: 'probe', p_bio: 'probe' }],
  ['review_coach_application', { p_application_id: NOWHERE, p_decision: 'approved', p_note: null }],
  ['redeem_invite_code', { p_code: 'PROBE-PROBE' }],
  ['claim_offer', { p_listing_id: NOWHERE }],
  ['remove_review', { p_review_id: NOWHERE, p_reason: null }],
  ['report_review', { p_review_id: NOWHERE, p_reason: 'spam', p_note: null }],
  ['report_coach', { p_coach_id: NOWHERE, p_reason: 'scam', p_note: null }],
  ['resolve_report', { p_report_id: NOWHERE, p_status: 'upheld', p_note: null }],
  ['set_coach_status', { p_user_id: NOWHERE, p_status: 'suspended', p_reason: null }],
  ['delete_my_account', {}],
];

for (const [fn, body] of CALLS) {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
  // A 2xx is the one that matters: it means the function RAN for an anonymous
  // caller and did not refuse.
  const verdict = response.status < 300 ? 'RAN' : 'refused';
  console.log(`${verdict.padEnd(8)} ${String(response.status).padEnd(4)} ${fn.padEnd(26)} ${text}`);
}
