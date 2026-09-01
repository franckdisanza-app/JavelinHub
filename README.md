# JavelinHub — coaching marketplace (local POC)

A Next.js 16 (App Router) marketplace where learners browse **coaches**
(`/coaches`) or the **offers** they publish (`/offers`), and coaches reach
approved status either by redeeming an admin invite code or by applying to a
review queue.

The domain model is still called `listing` — the type, the table, the RLS
policies and the authorization suite all keep that name, because they are
security-critical and a rename buys nothing a user sees. Only the URLs and the
copy say "offer". `/browse` and `/listings/*` redirect to the new paths with
their query strings intact.

The app runs on either of **two interchangeable backends**, selected by
`DATA_BACKEND` and sharing one interface (`DataClient`):

* `mock` — a local JSON store. The default, and what the verification suites run
  against.
* `supabase` — Postgres, with authorization enforced by the RLS policies in
  `supabase/migrations/`. Implemented and registered.

Switching between them is a config change; no calling code differs. **The
Supabase project exists but its schema has not been pushed yet**, so `mock` is
still the working default — see [`supabase/README.md`](supabase/README.md) for
the two outstanding steps, both of which need project credentials.

## Getting started (mock backend)

```bash
cp .env.local.example .env.local
# set SESSION_SECRET and SEED_ADMIN_PASSWORD — neither has a default
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm install
npm run dev
```

Open <http://localhost:3000>. The mock store seeds itself at `./data/db.json`
(gitignored) on the first request. Delete that file to reset.

## Demo fixtures

These are **credentials for the local MOCK store only** — `DATA_BACKEND=mock`,
a JSON file at `./data/db.json` that this repository seeds on first run. They
exist in the seed data and in this file on purpose. Never reuse them for
anything real, and note what changed below about the invite codes.

| Account | Email | Password | Role / status |
|---|---|---|---|
| Coach | `coach@javelin.test` | `coach1234` | `coach` / `approved` |
| Learner | `learner@javelin.test` | `learner1234` | `learner` / `none` |
| Admin | `SEED_ADMIN_EMAIL` (default `admin@javelin.test`) | `SEED_ADMIN_PASSWORD` — **from your `.env.local`, no default** | `admin` |
| New coach | `newcoach@javelin.test` | `coach1234` | `coach` / `approved`, with **nothing published** — the "new coach" empty state |
| Review authors | `marcus@` / `priya@` / `tomas@` / `aisha@javelin.test` | `learner1234` | `learner` / `none` |

### Invite codes, and why they are no longer printed here

Redeeming an invite code promotes the signed-in account **straight to an
approved coach** — someone who can publish offers under their own byline, be
listed in the public directory and upload into the private buckets. It is the
one credential in this project that grants a privilege rather than an identity.

The mock seed still mints two, and the migration that flags them says what that
means for anywhere real:

> `invites.is_demo` — *"TRUE for a fixture invite code. These are PUBLISHED IN
> README.md and grant approved-coach status to whoever redeems one — revoke them
> before any real deployment."*

That warning was written against a README that printed the codes in its
getting-started section, in a repository with a public URL. The codes are the
same in every clone, so anyone who read this file could have redeemed one
against **any deployment seeded from `seed.sql`**. So they are not printed here
any more. To find the local ones for your own mock store:

```bash
node -e "console.log(require('./data/db.json').invites.filter(i=>!i.redeemed_by).map(i=>i.code).join('\n'))"
```

**On a deployed project, revoke them.** They are minted by `seed.sql` and by
`demo-seed.sql`, both of which flag their rows:

```sql
update public.invites set revoked_at = now()
 where redeemed_by is null and revoked_at is null;
```

`npm run check:demo-data` reports whether any fabricated rows — invites
included — are still present.

**The purchases and reviews in the seed are fabricated.** Nobody bought anything
and nobody wrote any of it; there is no checkout in this POC and the Buy button
is inert. They exist so the ratings, review lists and sales counts have real
data — including real *empty* states — to render. `aisha@javelin.test` holds one
seeded purchase that has not been reviewed, which is the account to sign in as
if you want to exercise writing a review.

## Configuration

Every environment value is read through `src/lib/env.ts`; nothing else in `src/`
touches `process.env`, and no secret is hardcoded anywhere.

| Variable | Default | Notes |
|---|---|---|
| `DATA_BACKEND` | `mock` | `mock` or `supabase`; any other value throws at startup |
| `MOCK_DB_PATH` | `./data/db.json` | resolved from the project root |
| `SESSION_SECRET` | **none** | required on **both** backends. Signs the mock session cookie, and keys the rate limiter's bucket HMAC on either — see the note below |
| `SEED_ADMIN_EMAIL` | `admin@javelin.test` | non-secret |
| `SEED_ADMIN_PASSWORD` | **none** | required on the mock backend; seeds the admin login. Unused on Supabase |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | this app's own public origin, no trailing slash. It is the absolute base of every link GoTrue emails — password reset, signup confirmation, email change. Deliberately **not** derived from the request's `Host` header, which is attacker-controlled. Set it in production, and add the same origin to Supabase → Authentication → URL Configuration → Redirect URLs, or GoTrue refuses the redirect |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | empty | required when `DATA_BACKEND=supabase`; both are browser-safe by design |
| `SUPABASE_SERVICE_ROLE_KEY` | empty | **exactly one file in `src/` reads it** — `src/lib/auth/account-deletion.ts`, which bans the GoTrue user on account deletion because `delete_my_account()` cannot reach the `auth` schema. That file builds **no** Supabase client; it makes one `fetch` to one admin endpoint. The key is `BYPASSRLS`, so a client built from it would ignore every policy — never construct one. Leave it blank and deletion still anonymises the profile and closes the app; what does not happen is the credential dying |

## Deploying to Vercel

`DATA_BACKEND` **must** be `supabase` in production. The mock backend writes to
`data/db.json`, and a serverless filesystem is read-only and not shared between
invocations — so it cannot work there even as a stopgap. Push the schema first
(see [`supabase/README.md`](supabase/README.md)); a deploy that points at an
empty database returns `PGRST205` from every page.

**The symptom when `DATA_BACKEND` is unset**, because it is not an obvious one:
`/` and `/login` return 200 while `/offers` and `/coaches` return 500. An
anonymous visitor never touches the data layer on the first two, so only the
pages that read data fail. The store now detects the read-only write and says
this in the error rather than surfacing a bare `EROFS`.

Project Settings → Environment Variables:

| Variable | Value |
|---|---|
| `DATA_BACKEND` | `supabase` |
| `NEXT_PUBLIC_SUPABASE_URL` | the project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable / anon key |
| `NEXT_PUBLIC_SITE_URL` | the real origin, e.g. `https://javelin-hub.vercel.app` |
| `SESSION_SECRET` | a random 32-byte hex string |

**`SESSION_SECRET` IS REQUIRED HERE TOO**, and an earlier revision of this file
said the opposite. It is not only the mock cookie's signing key: `rate-limit.ts`
derives every bucket as `HMAC-SHA256(SESSION_SECRET, key)` on **both** backends,
because `consume_rate_limit()` is callable by `anon` and a guessable bucket would
let anybody burn a victim's password-reset budget. Without the variable the
limiter fails open (it did not always — see the "IT FAILS OPEN" note in
`src/lib/rate-limit.ts`), which means signup, login, password reset and invite
redemption are unthrottled.

**A production server now refuses to start without it**, along with the other
three values whose absence is otherwise silent. `assertRuntimeConfig()` in
`src/lib/env.ts` is called from `register()` in `src/instrumentation.ts` and
raises every problem it finds at once:

| | what it looks like without the check |
|---|---|
| `DATA_BACKEND` is `mock` or unset | `/` and `/login` answer 200, every page that reads data answers 500 |
| `SESSION_SECRET` unset | the limiter fails open on all four public forms and says nothing |
| `NEXT_PUBLIC_SITE_URL` unset | GoTrue refuses every emailed link, and the reset flow swallows that error on purpose |
| the Supabase pair unset, with `DATA_BACKEND=supabase` | as the first row |

Next skips `register()` during a production build — `registerInstrumentation()`
returns early on `NEXT_PHASE=phase-production-build`, in as many words — so this
cannot fail the CI build, which passes mock values deliberately. The check runs
when a server actually starts.

`SEED_ADMIN_PASSWORD` genuinely is mock-only and can be left unset: it seeds the
mock store's admin account, and on Supabase nothing asks for it.

No `vercel.json` is required — `next build` output is detected automatically,
and `src/proxy.ts` deploys as the project's proxy (Vercel still labels it
"Middleware" in the build output).

## Documentation

* [`docs/DATA-LAYER.md`](docs/DATA-LAYER.md) — how to call the data layer, the
  actor rule, error handling. Read this before writing any page or server action.
* [`supabase/README.md`](supabase/README.md) — schema, RLS design notes, the
  mock-check ↔ RLS-policy mapping table, and the mock → Supabase swap path.
* [`docs/ROADMAP.md`](docs/ROADMAP.md) — what is missing and in what order, with
  the file that documents each absence. Read before planning a phase.
* [`PROGRESS.md`](PROGRESS.md) — build log and quality bar.

## Scripts

```bash
npm run dev           # dev server
npm run build         # production build
npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npm run verify:authz  # authorization regression suite (throwaway store)
npm run verify:pages  # rendered-page regression suite (throwaway store + server)
npm run verify:supabase   # the same rules, asked of the real database (read-only)
npm run check:demo-data   # is there fabricated data in the database this points at?
```

Two GitHub workflows run them. `.github/workflows/verify.yml` runs typecheck,
lint, build and both mock suites on every push and pull request, and needs no
secrets — a property worth preserving. `.github/workflows/release-checks.yml` is
`workflow_dispatch` only and runs `check:demo-data` against the live project;
it is separate precisely because it needs credentials, and a fork's pull request
cannot trigger a manual dispatch. **Run it immediately before any deploy that
will serve a real user**, after `demo-teardown.sql`.

`verify:authz` is the executable half of the security model. Both suites run
against the **mock** backend, which is the point: the mock is the code twin of
the RLS policy set, so asserting its rules is how the policies are reviewed while
no Postgres is reachable. Run it after any change to `src/lib/data/**`.

Neither of those two exercises `SupabaseDataClient`, and nothing can stand in
for RLS — so `verify:supabase` asks the database itself, over PostgREST and
GoTrue, with the same anon key a browser gets.

It is **read-only by default**, because there is no throwaway Postgres the way
there is a throwaway JSON file: it runs against whatever
`NEXT_PUBLIC_SUPABASE_URL` names, which for this project is the live one. The
default tier is every assertion that can be made with a GET — the column
revokes on `deleted_by` and `asset_path`, the self-scoped views returning
nothing for anon, the RLS refusals on every anon INSERT, the RPCs answering
with their own sentences, and the two enums matching the TypeScript unions.

That tier exists mainly to catch one specific silent failure. `0002_rls.sql`
says it in as many words — *"THIS REVOKE IS UNDONE BY ANY LATER BLANKET GRANT,
SILENTLY"* — and nothing in the app would notice, because the client always
names its columns.

```bash
VERIFY_SUPABASE_WRITES=1 npm run verify:supabase                        # + signed-in tier
VERIFY_SUPABASE_WRITES=1 VERIFY_SUPABASE_INVITE=XXXX-XXXX-XXXX npm run verify:supabase   # + coach tier
```

The write tiers create real accounts, listings and orders that **cannot be
fully cleaned up** — there is no hard delete of a listing for any role and no
delete path for an order, both by design — so they are opt-in and leave
labelled fixtures behind. The coach tier additionally needs an unredeemed
invite code, because publishing needs an approved coach and the only routes to
that require an administrator to already exist. Anything it cannot run reports
SKIP with the reason; a skipped assertion is counted separately and is never
reported as a pass.

`verify:pages` is the other half, and the two do not overlap: `verify:authz`
never renders anything, so it cannot see an empty state, a cross-link or a
missing demo-data disclosure. `verify:pages` plants the states the seed
deliberately does not contain — a coach who is no longer approved but still has
a published offer, a withdrawn offer that still carries a review, a coach who
has sold and has never been reviewed — starts a server against a throwaway
store, asserts against the real markup, and tears both down. It needs no
`.env.local`, never touches `data/db.json`, and picks a free port, so it will
not collide with a dev server. Run it after any change to `src/app/**` or
`src/components/**`.
