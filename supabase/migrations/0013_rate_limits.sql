-- ===========================================================================
-- 0013_rate_limits.sql — a counter the application cannot cheat and a caller
-- cannot read.
-- ===========================================================================
--
-- `docs/ROADMAP.md` §6 has wanted this since before signup existed, and the
-- password-reset flow made it urgent: `/forgot-password` is public, ungated and
-- sends mail. GoTrue caps its own email sending, so the exposure is not
-- unlimited email — it is that **one caller can exhaust the shared, project-wide
-- mail quota and deny password resets to everybody**. A denial of service on
-- the one path that exists for people who cannot get in any other way.
--
-- WHY THIS IS IN POSTGRES AND NOT IN THE APPLICATION. A counter in module scope
-- works perfectly on one long-lived server and not at all on Vercel, where each
-- invocation may be a fresh instance and there is no shared memory between them.
-- Anything that actually limits has to live somewhere both instances can see,
-- and this project already has exactly one such place. Adding Redis for a single
-- integer would be a third service in a stack that has two dependencies.
--
-- FIXED WINDOW, not a sliding one or a token bucket. A fixed window admits a
-- burst of up to 2x the limit across a boundary — the classic objection — and
-- that is fine here: the point is to stop somebody making ten thousand requests,
-- not to smooth traffic. The cost of the alternatives is a second table or a
-- read-modify-write that is no longer one statement, and one statement is what
-- makes this correct under concurrency.

-- ---------------------------------------------------------------------------
-- 1. The table.
--
-- NO CLIENT MAY READ OR WRITE IT, EVER. RLS is enabled and there is not a single
-- policy, which is the strongest form of "no": every client role is refused by
-- default and there is no policy to review, weaken or accidentally widen. The
-- only way in is `consume_rate_limit()` below, which is SECURITY DEFINER.
--
-- Reading it would be a disclosure in its own right — the buckets are derived
-- from email addresses, so a readable table is an "has this person asked for a
-- password reset" oracle, and with enough patience an address enumerator.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  -- An OPAQUE key, never an email or an IP in the clear. See the HMAC note on
  -- the function below for why the application hashes it before it arrives.
  bucket             text primary key,
  count              integer not null default 0,
  window_started_at  timestamptz not null default now(),

  constraint rate_limits_count_positive check (count >= 0)
);

comment on table public.rate_limits is
  'Fixed-window request counters. Written ONLY by consume_rate_limit(); no client role may read or write it, and it carries no RLS policy at all. Buckets are opaque HMACs, never an address in the clear.';

alter table public.rate_limits enable row level security;

-- Stated rather than assumed. Supabase grants table privileges to anon and
-- authenticated by default, and RLS with no policy would already refuse them —
-- but a later blanket grant plus a later policy is two edits away, and this
-- makes the first of the two visibly wrong. Same reasoning as the column
-- revokes in 0002.
revoke all on public.rate_limits from anon, authenticated;

-- ⚠ WHAT THIS MIGRATION FORGOT, and 0014 supplies: the PRIVILEGED role needs a
-- grant on this table AND a policy admitting it. Left as written, because it is
-- what was applied — see the header of `0014_rate_limits_privileged.sql`.

-- For the sweep at the bottom of the function, and for any future cron.
create index if not exists rate_limits_window_idx on public.rate_limits (window_started_at);

-- ---------------------------------------------------------------------------
-- 2. consume_rate_limit(bucket, limit, window_seconds) -> boolean
--
-- TRUE means "you are within the limit, proceed". FALSE means "you are over it".
-- It COUNTS THE ATTEMPT EITHER WAY: a caller who keeps hammering a bucket they
-- have already exhausted keeps it exhausted, which is the behaviour that makes
-- a limiter worth having.
--
-- ONE STATEMENT does the whole read-modify-write, and that is the load-bearing
-- part. `insert ... on conflict do update` takes a row lock, so two concurrent
-- calls against the same bucket serialise and the second sees the first's
-- increment. A `select` followed by an `update` would let both read the same
-- count and both decide they were the fifth request.
--
-- THE BUCKET IS AN HMAC COMPUTED BY THE APPLICATION, and the reason is an attack
-- this design would otherwise create. `anon` must be able to call this — the
-- reset form is for people who cannot sign in — so a caller can invoke it with
-- any bucket string they like. If buckets were `reset:victim@example.com`, then
-- anyone could burn a victim's reset budget to the floor and lock them out of
-- their own account recovery. Because the bucket is `HMAC(SESSION_SECRET, key)`,
-- a caller cannot construct the bucket for an address they do not already share
-- a secret over. The worst they can do is exhaust their own.
--
-- SECURITY DEFINER, owned by javelin_privileged, so it can touch a table no
-- client role has any privilege on. It returns a boolean and nothing else: no
-- count, no window, no "try again in N seconds", because each of those is a
-- fact about a bucket the caller may not own.
-- ---------------------------------------------------------------------------
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
  -- Defensive, because these arrive from the application rather than from a
  -- constant: a zero or negative window would make every row instantly stale
  -- and the limiter a no-op that still looks installed.
  if p_bucket is null or p_bucket = '' then
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
      -- A window that has run out is RESTARTED rather than trimmed. That is what
      -- makes this fixed rather than sliding, and it is why the row does not
      -- need a history of individual timestamps.
      count = case
                when r.window_started_at <= now() - v_window then 1
                else r.count + 1
              end,
      window_started_at = case
                when r.window_started_at <= now() - v_window then now()
                else r.window_started_at
              end
  returning r.count into v_count;

  -- Housekeeping, at 1% of calls. The table grows one row per distinct bucket
  -- and nothing else ever deletes from it, so without this it accumulates a row
  -- per address that has ever asked for a reset — which is both unbounded and,
  -- since a bucket is derived from an address, a set worth not keeping.
  --
  -- Probabilistic rather than scheduled because this project has no cron. A day
  -- is far longer than any window here, so a swept row is one nothing could
  -- still be counting against.
  if random() < 0.01 then
    delete from public.rate_limits where window_started_at < now() - interval '1 day';
  end if;

  return v_count <= p_limit;
end;
$$;

comment on function public.consume_rate_limit(text, integer, integer) is
  'Counts one attempt against an opaque bucket and returns whether it is within the limit. Counts the attempt even when over, so hammering an exhausted bucket keeps it exhausted. The bucket must be an application-computed HMAC, never an address in the clear - anon can call this, and a guessable bucket would let anyone exhaust a victim recovery budget.';

-- ---------------------------------------------------------------------------
-- 3. Ownership and grants.
--
-- The same dance 0002 does for the four privileged RPCs, and for the same
-- reason: CREATE on the schema is granted for the ownership transfer and taken
-- straight back, so a SECURITY DEFINER function running as this role cannot
-- add objects to `public`.
--
-- `anon` gets EXECUTE as well as `authenticated`. That is not an oversight: the
-- forms this protects — password reset, signup, login — are all reachable
-- without a session, and a limiter that only applies to signed-in callers
-- protects nothing.
-- ---------------------------------------------------------------------------
grant create on schema public to javelin_privileged;
alter function public.consume_rate_limit(text, integer, integer) owner to javelin_privileged;
revoke create on schema public from javelin_privileged;

revoke all on function public.consume_rate_limit(text, integer, integer) from public;
grant execute on function public.consume_rate_limit(text, integer, integer) to anon, authenticated;
