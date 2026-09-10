# Deploying, and the checks that go around it

Everything here is a step somebody has to take **outside this repository** —
a dashboard, an account, a decision. Nothing on this page can be automated from
inside the codebase, which is exactly why it is written down: the failures it
prevents are the ones that leave a deployment looking healthy.

Read [`supabase/README.md`](../supabase/README.md) for the schema and
[`README.md`](../README.md) for the environment variables themselves.
[`RUNBOOK.md`](RUNBOOK.md) beside this file is the other half: what to do once
something has gone wrong rather than how to get it out.

---

## Before the first real user — the order matters

### 1. Remove the fabricated data — ✅ DONE

**The live project is clean.** 167 fabricated rows across 7 tables were removed
and the result confirmed; the four `@javelinhub-verify.test` accounts went with
them. Kept here because it has to be repeated after any of the seed-and-look
cycles below, and because both scripts are re-runnable.

```bash
npx supabase db query --linked -f supabase/demo-teardown.sql
npm run check:demo-data
```

Exit 0 means clean. Exit 1 lists what remains. **Exit 2 means it could not
reach the database, which is not the same as a pass** and is deliberately a
different code.

#### The four accounts the flag could not reach

`@javelinhub-verify.test` — created by the write tiers of `verify:supabase`
through the ordinary signup path, before `is_demo` existed, so they carry
`false` honestly. One of them, **Verify coach**, was a visible row in the public
coach directory. The write tiers mint fresh ones on every run, so this is a
standing chore rather than a one-off:

```bash
npx supabase db query --linked -f supabase/verify-fixtures-teardown.sql
```

**Read that file before running it.** The order of its statements is the whole
point: `listings.coach_id` cascades while `orders.listing_id` is `RESTRICT`, so
a single `delete from auth.users` asks Postgres to remove a listing and a sale
in one statement and succeeds or fails depending on which referential action it
processes first. It also does not reach storage — an avatar or delivery file
uploaded by a fixture survives as an orphan.

### 1b. Putting data back, when you need to look at a page

**An empty database renders empty states, and empty states are a small
fraction of what this product looks like.** Once the teardown has run, `/offers`
is a heading over nothing — which is correct, and useless for checking that a
card still lays out at 375px or that a rating still renders.

Three ways to get a populated screen, cheapest and safest first.

#### The right answer for almost every case: don't use production at all

```bash
DATA_BACKEND=mock npm run dev
```

The mock store seeds itself at `./data/db.json` on the first request — 6
coaches, offers across all eight categories, orders, reviews, and the awkward
states the live seed does not contain (a coach who is no longer approved but
still has a published offer, an offer that has sold and never been reviewed).
Delete the file to reset. **It cannot touch the live database**, and it needs no
credentials.

```bash
npm run verify:visual     # the same thing, asserted rather than eyeballed
npm run verify:pages      # renders 396 assertions against a throwaway store
```

Both suites provision and tear down their own store. Neither can reach
production — they hard-set `DATA_BACKEND=mock`.

#### If you genuinely need the Supabase path rendered

Point a local dev server at a **second, test-only Supabase project** (see the
last section of this file) and seed that. The Supabase backend differs from the
mock in ways that matter — RLS, the read models, PostgREST's `count=exact`
behaviour on a keyset filter — so there are real questions only it can answer.
None of them requires the *live* project.

#### If you must seed production — the cycle, in full

Only for something you cannot reproduce anywhere else, and never while a real
user has an account.

```bash
# 1. Confirm it is still empty, so you know what you are adding.
npm run check:demo-data          # expect: exit 0, "This database is clean"

# 2. Add the fabricated rows. Every one is flagged is_demo = true.
npx supabase db query --linked -f supabase/demo-seed.sql

# 3. Look at whatever you needed to look at.

# 4. Take it out again, and CONFIRM.
npx supabase db query --linked -f supabase/demo-teardown.sql
npm run check:demo-data          # expect: exit 0 again
```

**Step 4 is not optional and the confirmation is the point.** `is_demo` existed
for twenty-odd migrations with nothing that asked, and the live project was
seeded past every warning in the schema comments because the check was a query
somebody had to remember to run.

Three things the cycle does not cover, and each will outlive it:

- **Anything you create by hand through the UI carries `is_demo = false`**, so
  the teardown will not remove it and `check:demo-data` will report clean while
  it sits there. That is exactly how the four `@javelinhub-verify.test` accounts
  survived — use `supabase/verify-fixtures-teardown.sql` for those, and think
  before clicking "publish" on a live database.
- **Storage objects are not reached by any cascade.** An avatar or a delivery
  file uploaded during a look-around stays in its bucket after every row that
  pointed at it is gone. Check the three buckets.
- **Invite codes minted while testing.** They are not `is_demo` if you created
  them yourself, and an unredeemed code grants approved-coach status to whoever
  redeems it. `select code, created_at, expires_at from public.invites where
  redeemed_by is null and revoked_at is null;` — and revoke what you are not
  about to use.

### 2. Push the schema

```bash
npm run db:link      # once
npx supabase db push --linked --dry-run   # read what it will do
npm run db:push
npm run verify:supabase                   # immediately after, every time
```

**Every migration through `0033` is applied**, `0033_terms_acceptance.sql`
included — it was the last one outstanding, and it was not optional: it adds the
two columns that record a user's agreement to the terms, and it replaces
`handle_new_user()` and `guard_profile_privilege_columns()`. Until it was pushed,
every signup wrote a `terms_version` into user metadata that no trigger read.
No account was created in that window, so nothing is missing a consent record
that should have one.

Anything later than `0033` is not applied until this is run again.

**STOP TRACKING THAT BY HAND.** Which migration is applied used to be a fact
this page asserted and a reader had to trust, and it was wrong for as long as it
took somebody to notice. `verify:supabase` now asks the database instead — *"0033
is applied — the two columns exist"* — so a missing migration is a failed
assertion rather than a stale paragraph. Add the same shape when a migration
introduces something a client can see.

### 3. Revoke the invite codes you are not about to use

Redeeming one promotes the holder straight to approved coach. The **demo** codes
were identical in every clone of this repository and are gone with the rest of
the seed.

**Two live codes remain and they are not demo data** — they were minted by the
project's own administrator account, so `is_demo` is `false` and no teardown
will touch them. Checked on 2026-09-10, and the two are not equally urgent:

| minted | expires | |
|---|---|---|
| 2026-08-31 07:33 | 2026-09-02 | **already expired**, so it grants nothing. Still unrevoked, which is untidy rather than dangerous |
| 2026-08-31 08:52 | **never** | **this is the one.** Unredeemed, unrevoked, no expiry: whoever holds it becomes an approved coach the moment the site answers again |

Nobody can redeem either while the deployment is down, which is the only reason
this has not already been a problem. **Decide the second one before the site
comes back up**, not after. Check the current state before deciding:

```sql
select code, created_at, expires_at
  from public.invites
 where redeemed_by is null and revoked_at is null;
```

Keep one if a real coach is about to use it — that is a real case and the
reason this is not simply revoked as a matter of course. Otherwise:

```sql
update public.invites
   set revoked_at = now()
 where redeemed_by is null
   and revoked_at is null;
```

### 4. Fill in the legal facts

Every value in [`src/lib/legal.ts`](../src/lib/legal.ts) is `null`. While any
of them is, `/legal/terms`, `/legal/privacy` and `/legal/refunds` render a
red marker in place of the missing fact, list what is outstanding in a banner,
and set `noindex` on themselves.

**Stripe checks these three pages are reachable during Connect onboarding**, so
they are on the critical path to payments rather than beside it. They are drafts
and have not been reviewed by a lawyer; the banner saying so is unconditional
and removing it is a deliberate edit somebody makes after the review.

**`contactEmail` is now load-bearing for a fourth page.** `/help` is the only
route through which a user can reach a human being, and it renders the same red
marker and sets the same `noindex` while that value is `null`. Of the nine
facts, it is the one to fill in first: without it there is nowhere for anybody to
report any of the situations in [`RUNBOOK.md`](RUNBOOK.md).

---

## Vercel

Project Settings → Environment Variables:

| Variable | Value |
|---|---|
| `DATA_BACKEND` | `supabase` |
| `NEXT_PUBLIC_SUPABASE_URL` | the project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable / anon key |
| `NEXT_PUBLIC_SITE_URL` | the real origin, no trailing slash |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SUPABASE_SERVICE_ROLE_KEY` | optional — see below |
| `RESEND_API_KEY` | optional — see below |
| `EMAIL_FROM` | required **if** `RESEND_API_KEY` is set |

**The server refuses to start if the first five are wrong.**
`assertRuntimeConfig()` runs from `register()` in `src/instrumentation.ts` and
raises every problem at once. That is deliberate: each of those five fails
*silently* at runtime otherwise — a mock backend serves the marketing page and
500s everything that reads, an unset `SESSION_SECRET` unthrottles every auth
form without saying so, and an unset `NEXT_PUBLIC_SITE_URL` makes GoTrue refuse
every emailed link in a way the password-reset flow swallows on purpose.

Next skips `register()` during a production build, so this cannot fail the CI
build, which passes mock values deliberately.

`SUPABASE_SERVICE_ROLE_KEY` is read by exactly one file in `src/` —
`account-deletion.ts`, which bans the GoTrue user and builds no Supabase client.
Leave it blank and deletion still anonymises the profile and closes the account;
what does not happen is the credential dying.

No `vercel.json` is needed. `src/proxy.ts` deploys as the project's proxy
(Vercel still labels it "Middleware").

---

## Supabase dashboard — three settings this repo cannot reach

1. **Authentication → URL Configuration → Site URL** — change it off
   `http://127.0.0.1:3000` to the real origin.
2. **Authentication → URL Configuration → Redirect URLs** — add the same origin.
   Without it GoTrue refuses every link it emails, and
   `requestPasswordReset` does not inspect that error *by design* (inspecting it
   re-opens the account-enumeration oracle) — so the failure reaches nobody
   except a user who is locked out and cannot report it.
3. **Project Settings → Authentication → SMTP Settings** — point at Resend or
   another provider. The built-in SMTP is a handful of messages an hour
   project-wide and is documented as not for production. **This is configuration
   only**: it covers password reset, signup confirmation and email change, and
   no code in this repository changes.

`RESEND_API_KEY` and `EMAIL_FROM` are a *different* job — the app's own
notifications, in `src/lib/email/`. Setting the dashboard SMTP does not switch
those on, and switching those on does not fix the dashboard.

---

## After deploying

```bash
curl -s https://<origin>/api/health
```

`{"status":"ok","backend":"supabase"}` is a pass. `{"backend":"mock"}` from a
production URL diagnoses a missing `DATA_BACKEND` instantly, and `503` means the
data layer could not answer — the reason is in the server log, deliberately not
in the response.

**Point an uptime monitor at that path and alert on 503.** It exists to catch
the failures where the marketing page renders perfectly and the product is dead.

**There is now a stopgap in the repository**, because that instruction went
uncarried-out and the deployment spent an unknown period answering 500 to every
request with nothing raising it: `.github/workflows/uptime.yml` asks this
endpoint every 15 minutes and fails the run unless it answers `200` with
`"backend":"supabase"`. Read its header before relying on it — a scheduled
workflow can be delayed, GitHub disables one in a repository with no pushes for
60 days, and the only alert is a failed run. It is better than nothing and worse
than a monitoring service; replace it with one before the first real user.

**When it goes red, `docs/RUNBOOK.md` §1 is the procedure.** The distinction it
turns on: 500 on `/` as well means the server did not start, which is the boot
check and not the database.

Then, once and for real:

- click through a signup, a password reset and an email change, to prove the
  three dashboard settings above;
- run the **release checks** workflow (Actions → release checks → Run workflow)
  and confirm it is green;
- flip `permanent: false` to `true` in `next.config.ts`'s `redirects()`. The
  comment there explains why it was left temporary until this moment.

---

## Backups

Point-in-time recovery is plan-dependent on Supabase, and **a restore that has
never been rehearsed is a hope rather than a control.** Before the first real
user:

1. confirm which plan the project is on and what its PITR window actually is;
2. take a manual dump (`npx supabase db dump --linked -f backup.sql`);
3. restore it once into a scratch project, while nothing is at stake, and see
   how long it takes.

Step 3 is the one that gets skipped and the one that matters.

---

## A second project, for testing

**There is no staging project, and two checks are stuck because of it.**

- `verify:supabase` is deliberately kept out of CI, because it runs against
  whatever `NEXT_PUBLIC_SUPABASE_URL` names — putting production credentials
  somewhere every fork's pull request can reach would be wrong even for reads.
- Its **write tiers cannot provision fixtures at all** any more. GoTrue
  validates the address domain now that email confirmation is on, and no fake
  domain has an MX record, so they skip.

One second project fixes both. What it needs:

1. A new Supabase project — the free tier is enough; it holds no real data.
2. `npm run db:push` against it, so the schema matches.
3. **Email confirmation OFF** in its Authentication settings. That is the
   setting that unblocks the write tiers, and it is safe there precisely because
   it is not the live project.
4. `seed.sql`, then one administrator created from the SQL editor with
   `grant_admin()`, then one invite code minted. The write tiers need an
   unredeemed code because publishing needs an approved coach, and the only
   routes to that require an administrator to already exist.
5. Its URL and anon key as GitHub repository secrets, and a CI job that runs
   `VERIFY_SUPABASE_WRITES=1 npm run verify:supabase` against **it**.

Until step 5, `verify:supabase` stays an operator-run command and the write
tiers stay skipped — which the suite reports honestly rather than counting as
passes.

**Do not point the `release checks` workflow at the test project.** That one is
`workflow_dispatch` only and exists to ask the *live* database whether it still
holds fabricated rows; against a seeded test project it would always fail, and a
gate that always fails gets ignored.
