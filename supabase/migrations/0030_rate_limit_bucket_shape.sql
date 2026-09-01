-- ===========================================================================
-- 0030_rate_limit_bucket_shape.sql — anon may consume a limit, not fill a table.
-- ===========================================================================
--
-- !! NOT APPLIED. Push it, then re-run `npm run verify:supabase`. !!
--
-- ---------------------------------------------------------------------------
-- WHAT IS WRONG WITHOUT THIS
-- ---------------------------------------------------------------------------
-- `consume_rate_limit()` has to be callable by `anon`: every form it protects —
-- signup, login, password reset, invite redemption — is reachable without a
-- session. 0013 grants it accordingly, and `src/lib/rate-limit.ts` explains at
-- length why the bucket is an HMAC rather than an address:
--
--   > "a caller can invoke `consume_rate_limit()` with any bucket string they
--   >  like. If buckets were `reset:victim@example.com`, anyone could burn a
--   >  victim's reset budget to the floor and lock them out of their own
--   >  account recovery. So the key is never sent."
--
-- That reasoning is right and it closes the attack it describes. It leaves the
-- other one open: the caller still chooses the string, and the function's first
-- act is an `insert … on conflict do update`. **A fresh random bucket per
-- request is a fresh row per request**, from an unauthenticated caller, in the
-- one table every login path writes to. The only cleanup is a 1-in-100
-- sample that deletes rows older than a day — which a caller sending new
-- buckets never triggers on their own rows, and which gets slower as the table
-- it is scanning grows, on a random 1% of everybody's logins.
--
-- ---------------------------------------------------------------------------
-- THE FIX IS TO NOTICE THAT THE BUCKET HAS A SHAPE
-- ---------------------------------------------------------------------------
-- `bucketFor()` is `createHmac('sha256', …).digest('hex')` — exactly 64
-- lowercase hex characters, always, for every caller and both backends. So a
-- bucket that is not 64 hex characters did not come from this application, and
-- there is no legitimate request to refuse by rejecting it.
--
-- IT RETURNS `true`, NOT `false`. "Allow" is the answer the rest of this
-- function gives when it cannot count — an empty bucket already returns `true`
-- today — and it is the answer `rate-limit.ts` insists on:
--
--   > "a limiter that can take the site down is a worse liability than the
--   >  abuse it prevents."
--
-- Returning `false` would mean a caller could deny service to anybody by
-- guessing at the shape rule, which inverts the whole posture. So a malformed
-- bucket is admitted and simply not counted; what it cannot do is create a row.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS NOT
-- ---------------------------------------------------------------------------
-- Not a cap on how many rows a legitimate caller can create — an attacker who
-- computes valid buckets still cannot, because computing one needs
-- `SESSION_SECRET`. Not a replacement for scheduling the cleanup properly:
-- moving that sweep to `pg_cron` and out of the hot path is a separate change
-- and a better one, left out here so this file does one thing.
--
-- Recreated in full because `CREATE OR REPLACE FUNCTION` cannot patch a body.
-- Everything below is 0013's, unchanged, except the guard at the top.

create or replace function public.consume_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count  integer;
  v_window interval;
begin
  -- ADDED IN 0030. `bucketFor()` in src/lib/rate-limit.ts produces exactly 64
  -- lowercase hex characters. Anything else was not produced by this
  -- application, so it is admitted (see the header — refusing would hand out a
  -- denial of service) and counted against nothing.
  --
  -- This subsumes 0013's `p_bucket = ''` check: the empty string does not match
  -- the pattern either.
  if p_bucket is null or p_bucket !~ '^[0-9a-f]{64}$' then
    return true;
  end if;

  if p_limit is null or p_limit < 1 then
    return false;
  end if;

  if p_window_seconds is null or p_window_seconds < 1 then
    return false;
  end if;

  v_window := make_interval(secs => p_window_seconds);

  insert into public.rate_limits as r (bucket, count, window_started_at)
  values (p_bucket, 1, now())
  on conflict (bucket) do update
    set
      count = case
                when r.window_started_at <= now() - v_window then 1
                else r.count + 1
              end,
      window_started_at = case
                when r.window_started_at <= now() - v_window then now()
                else r.window_started_at
              end
  returning r.count into v_count;

  if random() < 0.01 then
    delete from public.rate_limits where window_started_at < now() - interval '1 day';
  end if;

  return v_count <= p_limit;
end;
$$;

comment on function public.consume_rate_limit(text, integer, integer) is
  'Counts one attempt against an opaque bucket and returns whether it is within the limit. Counts the attempt even when over, so hammering an exhausted bucket keeps it exhausted. The bucket must be an application-computed HMAC — 64 lowercase hex characters, enforced since 0030 — never an address in the clear: anon can call this, and a guessable bucket would let anyone exhaust a victim recovery budget. A bucket of any other shape is ADMITTED and not counted, because refusing would be a denial of service.';

-- `create or replace` preserves the owner and the ACL, so neither strictly
-- needs restating. Both are restated anyway, for the reason 0005 gives: it
-- keeps the file independently correct when applied to a database where an
-- earlier migration left the function owned by somebody else. The incoming
-- owner needs CREATE on the schema for the duration of the transfer and gets
-- it back immediately — see the long note at the end of 0002.
grant create on schema public to javelin_privileged;
alter function public.consume_rate_limit(text, integer, integer) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.consume_rate_limit(text, integer, integer) from public;
grant execute on function public.consume_rate_limit(text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- AFTER PUSHING, add to the read-only tier of `scripts/verify-supabase.mts`,
-- beside the rate-limit assertions already there — all three are anonymous
-- RPCs and need no fixtures:
--
--   * a 64-hex bucket still counts: call it `limit + 1` times and see the last
--     answer flip to false, exactly as the existing assertions do.
--   * `p_bucket => 'not-a-hash'` answers true, repeatedly, forever.
--   * `p_bucket => repeat('A', 64)` (uppercase) answers true — the pattern is
--     lowercase because `digest('hex')` is.
--
-- The second and third are the ones that matter: they are how you tell "the
-- guard is applied" from "the guard is applied and also refuses real traffic".
--
-- ROLLBACK: re-apply 0013's body, which is this file minus the guard.
-- ---------------------------------------------------------------------------
