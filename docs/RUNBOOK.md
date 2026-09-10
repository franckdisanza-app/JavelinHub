# The runbook — what to do when something has already happened

`docs/DEPLOY.md` covers getting the product out. This covers the day after: the
handful of situations that will actually arise, and what the code does in each
one. Every claim here is a property of something in this repository, cited so it
can be checked rather than believed.

**Read the first section before an incident, not during one.** It is the only
one whose first step is not obvious.

---

## 1. The site is down

**Symptom:** every route answers 500, including `/`.

That specificity is the diagnosis. `/` renders for an anonymous visitor without
touching the data layer, so a database problem cannot take it down — a database
problem produces 200 on `/` and `/login` and 500 on `/offers` and `/coaches`,
which is a *different* fault and is covered in §2.

500 on everything means the server did not start. `assertRuntimeConfig()` in
[`src/lib/env.ts`](../src/lib/env.ts) is called from `register()` in
`src/instrumentation.ts` and refuses to boot when any of five values is wrong,
because each of them otherwise fails *silently*.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<origin>/
curl -s https://<origin>/api/health
```

**Then read the Vercel runtime log** — Project → Logs, or `vercel logs` — for a
line beginning:

```
Refusing to start: N production configuration problems.
```

It names every problem at once, on purpose, so a deploy does not fail five times
for five variables. The five it checks:

| Variable | What its absence looks like |
|---|---|
| `DATA_BACKEND` | must be `supabase`. `mock` writes to a read-only serverless filesystem |
| `SESSION_SECRET` | the rate limiter fails open on every auth form and says nothing |
| `NEXT_PUBLIC_SITE_URL` | GoTrue refuses every emailed link, invisibly — see §3 |
| `NEXT_PUBLIC_SUPABASE_URL` | every page that reads data answers 500 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | as above |

Fix the variable in Project Settings → Environment Variables and **redeploy** —
an environment change alone does not restart the running deployment.

If the log shows something else, the failure is not the boot check.

> **This happened. TWICE, with the same cause.** The deployment answered 500 on
> `/`, `/offers` and `/api/health` for an unknown period, and `SESSION_SECRET`
> was absent from the production environment. Nothing raised it, which is why
> `.github/workflows/uptime.yml` now exists — with the limits its own header
> sets out.
>
> **The second time it was proven rather than inferred**, and the technique is
> worth reusing: `vercel env ls production` lists the variable names, and
> `SESSION_SECRET` was simply not among them. That takes a diagnosis of "one of
> five values is wrong" down to one value in a single command, without reading a
> log and without any secret being displayed. The variable is set now.
>
> **An environment variable that only exists in one place is a variable that can
> go missing without a trace.** There is no record in this repository of what
> production is configured with — deliberately, since four of the five are
> secret — so the check above is the only way to know. Run it before believing a
> deployment is configured, not after it fails.

---

## 2. The marketing page works and the product does not

**Symptom:** `/` and `/login` answer 200; `/offers` and `/coaches` answer 500.

`curl -s https://<origin>/api/health` distinguishes the three causes:

| Response | Meaning |
|---|---|
| `{"status":"ok","backend":"supabase"}` | the data layer is fine; the fault is elsewhere |
| `{"status":"ok","backend":"mock"}` | `DATA_BACKEND` is unset or wrong. §1 |
| `503 {"status":"degraded",…}` | the data layer could not answer |

The 503 carries no reason **by design** — the reason is in the server log, and
publishing it would publish the database's own error text. Check
[status.supabase.com](https://status.supabase.com), then the project's own
health in the dashboard, then whether the schema is actually applied
(`PGRST205` from every page means an empty database — see `docs/DEPLOY.md` §2).

---

## 3. "The password reset email never arrives"

**Check the boring cause first:** Supabase's built-in SMTP is a handful of
messages an hour *project-wide* and is documented as not for production. If
several people signed up at once, the mail was throttled, not lost. The fix is
Project Settings → Authentication → SMTP Settings, pointing at a real provider —
configuration only, no code.

**Then check the invisible cause.** `requestPasswordReset` deliberately does not
inspect GoTrue's error, because inspecting it re-opens the account-enumeration
oracle the same-answer-for-every-address design exists to close. So a rejected
`redirectTo` reaches nobody: the user is told to check an inbox nothing was sent
to, and they are by definition locked out and cannot report it through the app.

Three settings must agree, and none of them is in this repository:

1. `NEXT_PUBLIC_SITE_URL` on Vercel — the real origin, no trailing slash;
2. Supabase → Authentication → URL Configuration → **Redirect URLs** — the same
   origin listed;
3. Supabase → Authentication → URL Configuration → **Site URL** — the real
   origin, not `http://127.0.0.1:3000`.

**Do not "fix" this by deriving the origin from the request.** The `Host` header
is attacker-controlled, and a reset link built from it is a valid reset link for
a real account pointing at somebody else's domain, sent by us. The long comment
on `siteUrl()` in [`src/lib/env.ts`](../src/lib/env.ts) is the argument in full.

---

## 4. Somebody reports a review or a coach

Both land in one queue at **`/admin/reports`**. The rule the whole design turns
on:

> **Deciding something was wrong is never the same act as doing something about
> it.**

Upholding a report about a review does **not** delete the review; upholding one
about a coach does **not** suspend them. Each card links to the page where that
second decision is made, with its own confirmation. If you want both, do both.

* **Remove a review** — `/admin/reviews`. It **archives then deletes**: the row
  moves to `removed_reviews` and is gone from `reviews`, which is what keeps all
  five aggregates correct with no filter. There is no undo, and no edit path for
  anybody: an administrator may not rewrite an opinion published under somebody
  else's name.
* **Change a coach's standing** — `/admin/coaches`. See §5.

Everything an administrator does is appended to `admin_actions`, which has no
UPDATE or DELETE policy for any role, and is rendered at the bottom of
`/admin/reports`.

---

## 5. Suspend, demote or reinstate a coach

`/admin/coaches`. One control, and one ordering rule that is a property of the
database rather than a convention:

**`set_coach_status()` refuses while any of that coach's offers is on sale.** It
cannot withdraw them itself — it is `SECURITY DEFINER` owned by
`javelin_privileged`, and `guard_listing_update()` calls `auth.uid()`, which that
role can never reach. So the application takes the offers down first, **as the
administrator**, which makes `deleted_by` the administrator and means the coach
cannot put them straight back. A takedown a coach can undo in one click is not a
takedown.

Because the function refuses rather than fixing it up, "suspended but still
selling" is a state that cannot be reached however a caller sequences its
requests.

**Reinstating does not republish.** Nothing records which withdrawals belonged to
which suspension, so restoring is one decision per offer, from
`/admin/coaches` → that coach's offers.

---

## 6. "I want a refund"

**There is no payment, so there is nothing to refund.** Claiming is free while
the pilot runs: no Stripe, no card on file, no charge. Say so plainly and point
at `/help`.

What to do about the underlying complaint — an offer not delivered, or not as
described — is a judgement call today, because there is no order state machine to
carry it: an `Order` is a receipt with no status, no delivery deadline, no
dispute path and no refund. The published refund policy at `/legal/refunds`
describes a process that no code implements yet, and its own last section says
so.

**When payment lands, this section is a real procedure and must be rewritten.**

---

## 7. A data request — access, portability, or erasure

* **Access / portability** — `/settings` → **Download your data**. It hands the
  person a JSON file with their account, their published offers, their claimed
  offers, the reviews they wrote and the reports they filed. It runs entirely
  through the ordinary data layer with that user's own actor, so RLS scopes it;
  there is no privileged client anywhere near it. Point them at the button
  rather than exporting on their behalf.
* **Erasure** — `/settings` → delete the account. **It anonymises rather than
  erases**, and the privacy notice says so: the foreign-key graph leaves no
  honest alternative, because `orders.listing_id` is `ON DELETE RESTRICT` while
  `listings.coach_id` cascades, so a real delete would either be impossible or
  would rewrite somebody else's sales count and rating.

Three refusals that are invariants, not bugs, and each has a matching sentence
in the UI:

| Refusal | Why |
|---|---|
| A coach with an offer on sale cannot delete | `delete_my_account()` cannot withdraw offers (see §5's dead end). Withdraw them first |
| An administrator who has minted an invite cannot delete | `invites.created_by` is `ON DELETE RESTRICT`. Another administrator removes them |
| The GoTrue user is banned, not deleted | Deleting it cascades `profiles` and undoes the whole design |

**The residual, which must be stated if anyone asks:** an access token already
issued stays valid until it expires — up to an hour — so a raw token could still
satisfy RLS on a direct PostgREST call in that window. The refresh token is
revoked immediately and `resolveProfile` refuses the account in both backends, so
every path through the application is closed at once.

---

## 8. Restore from a backup

**This has never been rehearsed, and a restore that has never been rehearsed is a
hope rather than a control.** Do the rehearsal before you need it:

```bash
npx supabase db dump --linked -f backup.sql   # take one
# restore it into a SCRATCH project, and time it
```

Confirm which plan the project is on and what its point-in-time-recovery window
actually is — it is plan-dependent, and the answer is not knowable from this
repository.

**Two things no database restore brings back**, both worth knowing before you
promise anybody a recovery:

* **Storage objects.** Avatars and delivery files live in buckets that no
  database cascade or dump reaches. They are a separate backup.
* **GoTrue users.** `auth.users` is a different schema from the one the app's
  migrations own.

---

## 9. Rotating a key

| Key | What it is | What moving it breaks |
|---|---|---|
| `SESSION_SECRET` | signs the mock cookie; keys the rate limiter's bucket HMAC on **both** backends | every rate-limit bucket resets — harmless. Rotate freely |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser-safe by design, RLS still applies | must be changed in Vercel and redeployed together with the project |
| `SUPABASE_SERVICE_ROLE_KEY` | `BYPASSRLS`. Read by **exactly one file** in `src/` — `account-deletion.ts`, which bans the GoTrue user and builds no Supabase client | account deletion stops banning the credential; deletion still anonymises. Nothing else in the app notices |

**Never build a Supabase client from the service-role key.** It ignores every
policy, and the entire authorization model of this product is those policies.
The one file that reads it makes a single `fetch` to a single admin endpoint;
`scripts/check-demo-data.mts` does the same for the pre-launch check.

The local `.env.vercel` on a developer's machine holds the service-role key, the
JWT secret and the Postgres password. It is gitignored and has never been
committed — but it exists, and rotating after a laptop changes hands is the
whole procedure.

---

## 10. The only administrator account is lost

`grant_admin(uuid)` is the supported bootstrap and repair path. Its own comment
says so: *callable from psql or the SQL editor (where `auth.uid()` is null) or by
an existing admin.*

```sql
-- From the Supabase SQL editor, where auth.uid() is null.
select public.grant_admin('<the user uuid>');
```

**Make a second administrator before you need one.** An administrator who has
minted an invite code cannot delete their own account (§7), coach approval and
moderation stop entirely without one, and the recovery above needs dashboard
access that may sit with one person.

---

## 11. Unredeemed invite codes

Redeeming one promotes the holder **straight to approved coach** — able to
publish under their own byline, appear in the public directory, and upload into
the private buckets. It is the one credential in this product that grants a
privilege rather than an identity.

```sql
select code, created_at, expires_at
  from public.invites
 where redeemed_by is null and revoked_at is null;
```

```sql
update public.invites set revoked_at = now()
 where redeemed_by is null and revoked_at is null;
```

Codes minted by the project's own administrator are **not** demo data —
`is_demo` is false and no teardown will touch them. Check this list before any
launch, and after any round of testing.

---

## 12. Who to tell

`/help` is the only contact route the product has, and it renders a red marker
instead of an address until `contactEmail` is filled in at
[`src/lib/legal.ts`](../src/lib/legal.ts). While it is blank there is nowhere for
a user to report any of the above, and the page sets `noindex` on itself for that
reason.

That is the first thing to fix in this document's own dependency order.
