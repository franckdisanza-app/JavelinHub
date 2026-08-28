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

These are **public demo credentials for a local POC**. They exist in the seed
data and in this file on purpose. Never reuse them for anything real.

| Account | Email | Password | Role / status |
|---|---|---|---|
| Coach | `coach@javelin.test` | `coach1234` | `coach` / `approved` |
| Learner | `learner@javelin.test` | `learner1234` | `learner` / `none` |
| Admin | `SEED_ADMIN_EMAIL` (default `admin@javelin.test`) | `SEED_ADMIN_PASSWORD` — **from your `.env.local`, no default** | `admin` |
| New coach | `newcoach@javelin.test` | `coach1234` | `coach` / `approved`, with **nothing published** — the "new coach" empty state |
| Review authors | `marcus@` / `priya@` / `tomas@` / `aisha@javelin.test` | `learner1234` | `learner` / `none` |

Seeded unredeemed invite codes: `JAVELIN-COACH-2026`, `THROWERS-WELCOME`.
Redeeming one promotes the signed-in account straight to an approved coach.

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
| `SESSION_SECRET` | **none** | required; signs the local session cookie |
| `SEED_ADMIN_EMAIL` | `admin@javelin.test` | non-secret |
| `SEED_ADMIN_PASSWORD` | **none** | required; seeds the admin login |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | empty | required when `DATA_BACKEND=supabase`; both are browser-safe by design |
| `SUPABASE_SERVICE_ROLE_KEY` | empty | **leave blank.** Nothing in `src/` reads it — it is `BYPASSRLS`, so a client built from it ignores every policy. Operator tasks only |

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

`SESSION_SECRET` and `SEED_ADMIN_PASSWORD` are **not** needed on Supabase and
should not be set there: they belong to the mock session cookie and the mock
seed. `src/lib/env.ts` only throws for them when something actually asks, and on
the Supabase path nothing does.

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
```

`verify:authz` is the executable half of the security model. Both suites run
against the **mock** backend, which is the point: the mock is the code twin of
the RLS policy set, so asserting its rules is how the policies are reviewed while
no Postgres is reachable. Run it after any change to `src/lib/data/**`.

Neither suite exercises `SupabaseDataClient` — that needs a database with the
schema applied, and nothing can stand in for RLS. Until then it is covered by
static review against the mapping table in `supabase/README.md`.

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
