# Deploying, and the checks that go around it

Everything here is a step somebody has to take **outside this repository** —
a dashboard, an account, a decision. Nothing on this page can be automated from
inside the codebase, which is exactly why it is written down: the failures it
prevents are the ones that leave a deployment looking healthy.

Read [`supabase/README.md`](../supabase/README.md) for the schema and
[`README.md`](../README.md) for the environment variables themselves.

---

## Before the first real user — the order matters

### 1. Remove the fabricated data

The live project was seeded from `demo-seed.sql`. Those rows feed
`offer_stats` and `coach_stats` exactly as real ones would, which is the whole
reason `is_demo` exists.

```sql
-- supabase/demo-teardown.sql, in the SQL editor
```

Then confirm, and **do not skip the confirmation** — the teardown deletes on the
flag, and anything that was inserted without it survives:

```bash
npm run check:demo-data
```

Exit 0 means clean. Exit 1 lists what remains. **Exit 2 means it could not
reach the database, which is not the same as a pass** and is deliberately a
different code.

#### The four accounts the teardown does not touch

`@javelinhub-verify.test` — created by the write tiers of `verify:supabase`
before `is_demo` existed, so they carry `false`. One of them, **Verify Coach**,
is a visible row in the public coach directory. Remove them by hand:

```sql
-- Check first. This should return four rows and nothing else.
select id, email, full_name, role, coach_status
  from public.profiles
 where email like '%@javelinhub-verify.test';
```

They cannot simply be deleted while they own listings or have sold anything —
the foreign-key graph is the same one that makes account deletion anonymise
rather than erase. Withdraw their offers first, then use the ordinary path.

### 2. Push the schema

```bash
npm run db:link      # once
npx supabase db push --linked --dry-run   # read what it will do
npm run db:push
npm run verify:supabase                   # immediately after, every time
```

Migrations `0029`–`0032` are applied. Anything later is not until this is run
again.

### 3. Revoke the demo invite codes

Redeeming one promotes the holder straight to approved coach, and the codes are
identical in every clone of this repository. `demo-teardown.sql` deletes the
ones flagged `is_demo`; this catches anything else:

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
