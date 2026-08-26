# PROGRESS — JavelinHub (Foundational Layer, Local POC)

## Resumption protocol

If a session is interrupted and a new one picks this up, the new session **must**:

1. Read this file top to bottom.
2. Independently verify the claimed state — confirm each file listed under
   "Files claimed complete" actually exists, run `npm run dev`, and exercise the
   flows marked working.
3. Report a status summary **before** continuing any build work.

Do not trust any claim in this file without step 2.

> **Editing this file programmatically:** use slicing/concatenation, or a
> *replacer function*. A literal dollar-backtick sequence inside a
> `String.prototype.replace` **replacement string** means "splice in everything
> before the match" — that corrupted this file twice while documenting a regex
> `$` anchor, duplicating the whole document into itself both times.

## Build method

Subagents with isolated context build one area each. After each builder, a
separate critic-agent — with no knowledge of the implementation beyond the spec
and quality bar — reviews the work. Fixes loop back to the original builder
until the critic approves every criterion. No criterion may be silently skipped
or watered down.

## Stack (locked)

- Next.js 16.3.1 (App Router), React 19.2.8, TypeScript 5, Tailwind CSS v4
- Mock JSON-file data layer behind a Supabase-shaped interface
- Mock session cookie mirroring Supabase Auth's user shape
- All Supabase config via env vars (currently unused) — no hardcoded secrets

## Phase log

| # | Event | Status | Notes |
|---|-------|--------|-------|
| 0 | Scaffold Next.js + TS + Tailwind, `.env.local.example`, PROGRESS.md | ✅ done | 2026-08-17 |
| 1 | **schema-agent** — SQL schema + RLS migrations, `DataClient` interface, mock data layer, env accessor | ✅ done, awaiting critic | Scope: `supabase/migrations/0001_init.sql`, `0002_rls.sql`, `seed.sql`; `src/lib/env.ts`, `src/lib/data/{types,client,index}.ts`, `src/lib/data/mock/{store,mockClient}.ts`. Contract: every mutating method takes `Actor = { userId } \| null` and resolves role/coach_status from the store — never trusts caller-supplied role. |

| 1c | **critic-agent #1 (phase 1)** — independent adversarial review | ❌ **REJECTED** | Criteria 1–4, 6, 7 PASS (verified by the critic's own from-scratch 174-assertion suite: privilege forgery, TOCTOU actors, input injection, and a 6-way concurrency race on invite redemption all correctly refused). Criterion 5 (SQL RLS static correctness) FAIL. 8 defects, 2 HIGH. |
| 1d | **schema-agent rework** — D1–D8 + 2 divergences + regression suite | ✅ claimed done | All 8 defects + both divergences addressed; added `npm run verify:authz` (87 assertions, throwaway store), `npm run typecheck`, `turbopack.root`. |
| 1e | **critic-agent #1 re-review** | ❌ **REJECTED** (narrowly) | D1, D2, D3, D5, D6, D7, X2 confirmed CLOSED **by execution**. D4 approach independently endorsed: the `SECURITY INVOKER` flip is load-bearing and correct, and the three `*_privileged` policies are unreachable by any JWT (`authenticated`/`anon`/`service_role` are not members of `javelin_privileged`). 6 new defects: N1–N3 MEDIUM, N4–N6 LOW. |
| 1f | **schema-agent rework #2** — N1–N5 | ⚠️ **interrupted** | Agent hit a session limit mid-edit, on its own account partway through "the N1 assertions and the remaining injection coverage". State had to be re-derived, not trusted. |
| 1g | **Session resumed** — orchestrator verified actual state per the resumption protocol | ✅ done | 2026-08-18. Findings below. N6 (stale `PROGRESS.md` claim) fixed by the orchestrator; N5's last assertion fixed inline rather than by resuming the agent. |
| 1h | **critic-agent #1 final re-review** | ❌ REJECTED — **documentation only** | N1 product half, N2, N3, N4, N5, N6 all verified CLOSED by execution. Three files still described the pre-N1 `PublicProfile` shape, incl. the interface contract UI agents are told to read. No functional, security, or interface objection remaining. |
| 1i | **Doc fixes + enum-drift fix** (orchestrator) | ✅ done | `client.ts`, `docs/DATA-LAYER.md`, `supabase/README.md` ×2 corrected to `{ id, full_name, is_approved_coach }` with the rationale. Suite's `ENUM_VALUES` now derived from exported `ROLES`/`COACH_STATUSES` instead of hardcoded. Re-verified: tsc 0, lint 0, **115 passed / 0 failed**, `db.json` md5 unchanged. Project-wide grep for stale public-shape claims: clean. |
| **1 — PHASE COMPLETE** | **Phase 1 cleared for the UI agents** | ✅ | 3 critic rounds. Every criterion PASS except live RLS enforcement, which is DEFERRED with the substitute check personally performed by the critic. |

## Phase 2 — auth layer + app shell

| # | Event | Status | Notes |
|---|-------|--------|-------|
| 2a | **auth-agent** — session, signup/login/logout, invite redemption, admin invite UI, app shell | ✅ claimed done | Session cookie is `{ uid, iat }` only — no `role`/`coach_status`. HMAC-SHA256, `timingSafeEqual`, httpOnly, 30-day expiry enforced twice (cookie `Max-Age` **and** signed `iat`, so a replayed cookie still expires). Open-redirect-safe `?next=`. |
| 2b | **critic-agent #2 (fresh context)** | ❌ **REJECTED** | 4 defects. Criteria 1,2,3,4,6,7,10 PASS. Crit. 5 FAIL (open redirect + 500), crit. 8 FAIL (tap targets), crit. 11 FAIL (focus indicator), crit. 9 **DEFERRED** (screenshots impossible). Closed the builder's admin-password gap: admin login through the real form **works** (303 → /browse, /admin/invites → 200). |
| 2c | **auth-agent rework** — C1/C2 open redirect | ⚠️ **interrupted** | Session limit. Landed the `safeNextPath` rewrite; died before C3/C4. |
| 2d | **Session resumed** — orchestrator verified + finished C3/C4 | ✅ done | 2026-08-18. Details below. |
| 2e | **critic-agent #2 re-review** | ⬜ pending | Blocked only on re-verifying C1–C4. |
| 2f | **critic-agent #2, second instance — crashed, transcript lost** | ⚠️ | Server error mid-review, same as the first instance. No transcript persisted this time (`SendMessage` resume failed: "No transcript found"), so continuity was impossible — a **third, fully fresh** critic instance was launched with complete context rebuilt from this file rather than attempting further resumption. |
| 2g | **critic-agent #3 (fresh, full context)** | ✅ completed | Ran alone, no concurrent dev-server use. |
| 2h | **critic-agent #3 verdict** | ✅ **APPROVED** | C1–C4 all CLOSED, verified from scratch with no continuity assumed. 24 redirect payloads, 24 forged cookies, live-promotion test, full regression sweep. |
| 2i | **Dead-CSS cleanup** (orchestrator) | ✅ done | See "Tailwind scans your documentation" below. |
| **2 — PHASE COMPLETE** | **Phase 2 approved** | ✅ | Criterion 9 (visual review) remains the single DEFERRED item, correctly not upgraded on the strength of measurements. |

### Phase 2 — final verification evidence (critic #3, independent)

- **C1 CLOSED.** 24 payloads POSTed through the real Server-Action protocol to inspect the actual `Location` header: `//evil.example`, `///evil.example`, `/\evil.example`, `https://evil.example/`, `javascript:alert(1)`, raw tab, raw newline, CRLF — **every one redirected to `/browse`**, never cross-origin, never a raw control byte in `Location`. `/browse?q=x#y` round-tripped intact. DOM-tampering variant (overwriting the hidden field's live value to `//evil.example` before submitting through the real client protocol) also landed on `/browse` — confirming `logInAction`'s own `safeNextPath()` call is the boundary, not the URL.
- **C2 CLOSED.** Zero 500s across ~35 GET+POST attack variants; the dev log for the whole sweep has no error-like lines.
- **C3 CLOSED.** Suppressor gone from `nav-bar.tsx`; global `:focus-visible` rule intact with its "Never remove it" comment. Skip-link reversion confirmed clean **without focusing anything**: compiled CSS has `.sr-only` at line 479 and `.focus\:not-sr-only:focus` at line 1231 — later, higher specificity (0,2,0 vs 0,1,0), and its properties fully reverse every property `.sr-only` sets.
- **C4 CLOSED.** Measured live at 375×812: wordmark 44, menu trigger 44, all three footer links 44, every primary submit 44, and `/admin/invites` **Copy and Revoke now 44 (were 34)** — reached by actually logging in through the real admin form. The only sub-44px elements remaining are the skip link (keyboard-only) and inline sentence links, both named exceptions.
- **No regressions.** 24 forged cookies (wrong secret, flipped byte, sig↔body swap, HMAC-SHA1 substitution, injected `role:'admin'` on a real learner signature, missing/future/31-day-stale `iat`, non-JSON and array bodies, correctly-signed unknown uid): zero 500s, zero unauthorized admin access — each either fully anonymous (307) or correctly resolved to the real non-admin identity the signature actually named (404). Live-promotion verified two ways with one unchanged cookie. All four invite-failure messages still byte-identical. Zero hydration warnings across six routes.

### ⚠️ Methodological trap worth remembering: `curl` on Git Bash mangles `//` arguments

The critic could not trust `curl` for the redirect tests. **Git Bash/MSYS on Windows silently rewrites a literal `//evil.example` argument to `/evil.example` before curl ever receives it** (confirmed with `--trace-ascii`) — which would have produced a **false "vulnerable" reading**. It rebuilt the harness in Node (`fetch`/`FormData`, no shell argv involved). The orchestrator's earlier GET-side sweep happened to be sound because it percent-encoded every payload (`%2F%2F…`), which MSYS leaves alone — but any future agent testing path-shaped payloads through Git Bash must percent-encode or avoid the shell entirely.

### Tailwind scans your documentation — a dead rule this file created

Critic #3 found `.focus-visible\:outline-none:focus-visible { outline-style: none }` in the compiled CSS and correctly traced it to prose: **Tailwind v4's zero-config scanner text-matches the whole repo, including Markdown**, and this file's own C3 defect history contains the literal class name in backticks. A project-wide grep confirmed it appeared in no `.tsx`/`.ts` file, and a live DOM query returned zero elements — unreachable dead CSS, not an active suppressor.

Fixed at the root rather than left documented, because the next reviewer would repeat the same investigation: `src/app/globals.css` now carries `@source not "../../**/*.md";` with a comment explaining why. Verified in the production bundle afterwards: **zero** `outline-none` occurrences, while `:focus-visible{outline:2px solid var(--focus)}`, `.min-h-11`, and both `sr-only` variants all remain correctly emitted. tsc, lint and build stay clean.

### Phase 2 defects (critic #2)

| ID | Sev | Defect | Status |
|---|---|---|---|
| C1 | HIGH | **Open redirect** — `safeNextPath` rejected `//` and `/\` by literal prefix match but not C0 control characters. A tab payload starts with a single slash, passes, and browsers strip the tab per WHATWG → protocol-relative URL to `evil.example`. No DOM tampering needed; a crafted link suffices. | ✅ closed |
| C2 | HIGH | **Unhandled 500** from the same input — a newline payload reached Node's header writer (`ERR_INVALID_CHAR`, `POST /login 500`). Anonymous, one crafted link. | ✅ closed |
| C3 | MED | Focus ring suppressed on the header wordmark — **the first tab stop on every page** — by `focus-visible:outline-none` at specificity (0,2,0) beating the global `:focus-visible` at (0,1,0). Contradicted the codebase's own "Never remove it" comment. | ✅ closed |
| C4 | MED | Tap targets under 44px at 375px: footer links 20px, Copy 34px, Revoke 34px, every primary submit 42px, wordmark 33px. | ✅ closed |

**C1/C2 fix, verified by the orchestrator against the real function source** — extracted verbatim into an isolated harness, since `session.ts` imports `next/headers` and cannot load outside Next. The fix parses against a throwaway origin, checks `url.origin` is unchanged, and **rebuilds the value from `pathname + search + hash`** rather than echoing raw input, so a denylist cannot be outflanked by the next exotic character. Results: tab / newline / CRLF / CR / protocol-relative / triple-slash / absolute / `javascript:` all rejected; NUL, form-feed and vtab neutralised to percent-encoded same-origin paths; `/browse?q=x#y` round-trips intact. **Exhaustive C0+DEL sweep, 4 payload shapes each: 0 control characters survive, 0 cross-origin escapes.** The builder's dying note about a "residual NUL defect" was a false alarm — the parser percent-encodes it to `%00`.
**C1/C2 additionally verified end-to-end against the running app** (the harness proves only the helper, not what reaches the wire). Crafted-link payloads sent as `GET /login?next=…`:

| payload | status | rendered hidden field |
|---|---|---|
| `/<TAB>/evil.example` | 200 | **omitted entirely** |
| `/<LF>/evil.example` | 200 | **omitted entirely** |
| `/<CRLF>/evil.example` | 200 | **omitted entirely** |
| `//evil.example` | 200 | **omitted entirely** |
| `https://evil.example/` | 200 | **omitted entirely** |
| `javascript:alert(1)` | 200 | **omitted entirely** |
| `/browse?q=x#y` | 200 | `value="/browse?q=x#y"` — intact |

No 500 on any payload, and no control character survives into the markup — the rejected value yields no field at all rather than a sanitised-but-present one. This closes the vector the critic described as "the value survives the query string into the rendered field". **Still outstanding for the critic's re-review:** the POST path, i.e. what lands in the `Location` header after a *successful* login carrying a crafted `next`.

**C3/C4 fixed by the orchestrator**, the agent having run out of session: suppressor removed and the wordmark given a 44px hit area; `min-h-11` moved into the `button.tsx` SIZES primitive so phases 3–4 inherit it rather than repeating the fix per call site; footer links given `inline-flex min-h-11`. Re-measured live at 375px: wordmark 44, menu 46×44, footer links 44, primary CTAs 50, inputs 46 at 16px, **zero horizontal overflow**.

Two elements remain under 44px **by design, not oversight**: the "Skip to content" link (keyboard-only, never touch-reachable) and inline links inside sentences such as "New here? Create an account." — WCAG 2.5.5 carries an explicit inline exception for targets in a block of text.

### ⚠️ A wrong diagnosis, made and reverted — recorded so it is not repeated

The orchestrator measured the skip link as staying clipped at 32×16 when focused, concluded `focus:not-sr-only` was failing to override `sr-only` in Tailwind v4, and replaced it with hand-written CSS. **That diagnosis was wrong.** `document.hasFocus()` is `false` in this environment — the Browser pane never composites — and Chrome does not match `:focus` in an unfocused document, so no focus style could ever have appeared. Proven by inspecting the emitted stylesheet: the `focus:not-sr-only` rule **is** generated, at a later byte offset (~23762) than `.sr-only` (~11858) and at higher specificity, so it wins correctly in a real browser. The change was reverted in full and the original idiomatic Tailwind restored.

**Consequence for anyone reviewing this project: `:focus` and `:focus-visible` behaviour cannot be verified in this environment at all.** Only CSS-text inspection is valid here. C3 stands because it was proven that way — specificity of the emitted rules — and not by focusing anything.

### Phase 2 — still unverified

- **Criterion 9, visual review: DEFERRED.** Neither the critic nor the orchestrator could screenshot; the Browser pane is not displayed, so the page never composites frames. Substitute checks performed and clean: zero horizontal overflow at 375px and 1280px, zero element overlaps, no clipping, no invisible text, no scaffold remnants, contrast 4.70 light / 5.80 dark with zero AA failures, coherent 12/14/16/18/24/48px type scale. **Nobody has actually looked at these pages.** Needs a human eye or a compositing browser.
- **Physical keyboard traversal order** — synthetic Tab keypresses never reach the page, so tab order is unverified.

Orchestrator-verified independently: `npm run verify:authz` still **115/115** (phase 1 intact). The builder's one phase-1 edit — `isProduction()` in `src/lib/env.ts` — is genuinely additive and correctly motivated: a `Secure` cookie is dropped by the browser on plain `http://localhost`, and the project rule is that nothing outside `env.ts` touches `process.env`.

Known gaps carried into review, self-reported by the builder rather than hidden:
- **Admin password login never exercised end-to-end** — reading `SEED_ADMIN_PASSWORD` was blocked, so the admin UI was driven with a hand-minted signed cookie. The password path is proven only by the learner/coach logins that share the identical action.
- **Visual design unreviewed by eye** — the browser pane wasn't compositing, so flows were driven via DOM events and asserted on DOM/HTTP/server-log rather than looked at.
- `npm run build` emits a pre-existing phase-1 warning at `store.ts:291` (dynamic filesystem access → whole-project tracing). Out of phase-2 scope; harmless locally, would bloat a deployment.
- `/listings/new` was chosen as the approved-coach nav target. If coach-agent picks a different route, update `navLinksFor()` in `site-header.tsx` plus links on `/`, `/redeem`, and the placeholder.

## Phase 3 — coach application + admin approval queue

| # | Event | Status | Notes |
|---|-------|--------|-------|
| 3a | **coach-agent** — `/coach/apply`, `/admin/applications`, nav link | ✅ claimed done | Two prior launches died to transient server-side errors before doing any work; the third produced 9 files: `admin/applications/{actions,filters,page,review-form}.tsx`, `coach/apply/{actions,apply-form,page}.tsx`, `src/lib/format.ts`, plus a minimal edit to `navLinksFor()`. Its own completion report never arrived (last signal was "stopped, no completion record") — treated as unverified per the resumption protocol. |
| 3b | **Session resumed — orchestrator independently verified the full flow live** | ✅ done | 2026-08-18. Every claim below was exercised through real signup/login/HTTP forms in the browser, or read from `data/db.json` directly — not inferred from source. |
| 3c | **critic-agent #6 (phase 3)** | ❌ **REJECTED** | Criteria 1–6, 8, 9 PASS. Crit. 7 FAIL (D1) and crit. 10 FAIL (D2). 6 findings. |
| 3d | **Orchestrator fixes for D1–D5** | ✅ done | 2026-08-19. All closed; D1 turned out to be broader than reported — see below. |
| 3e | **critic-agent #7 — phase 3 re-review** | ❌ **REJECTED** | D3, D5 CLOSED. D1 **NOT** closed (N1: same class survived on `user_name`). D2 **partially** closed — the rewritten comment was still wrong. D4 closed behaviourally but shipped a new false comment (N2). Plus N3, N4. |
| 3f | **Orchestrator fixes — systemic this time** | ✅ done | 2026-08-19. See below. |
| 3g | **critic-agent #8 — phase 3 second re-review** | ✅ **APPROVED** | N1–N4 and D2 all CLOSED, verified in a **production build**. Independently reproduced the `anywhere` vs `break-word` mechanism. One non-blocking observation (`div` gap) — closed below. |
| 3h | **`div` gap closed** (orchestrator) | ✅ done | Selector broadened from a tag list to `:where(body *)`. |
| **3 — PHASE COMPLETE** | **Phase 3 approved** | ✅ | |
| **ALL PHASES COMPLETE** | **1, 2, 3, 4 all critic-approved** | ✅ | 8 critic rounds, every phase rejected at least once. |

### The mechanism, independently confirmed

Critic #8 reproduced the sizing behaviour in an isolated harness rather than accepting the explanation — 200-char token, 375px container:

| | grid item width | container at `width: min-content` | wraps? |
|---|---|---|---|
| `overflow-wrap: normal` | 1967px | 1967px | no |
| `overflow-wrap: break-word` | **1967px** | **1967px** | **no** |
| `overflow-wrap: anywhere` | **375px** | **15px** | **yes** |

So only `anywhere` lowers min-content size — which is precisely why applying `break-words` everywhere still left `/browse` at 464px, and why the earlier fix needed `min-w-0` in four places to compensate. With `min-width: auto` forced back onto the grid items, `/browse` still measures 375 = 375: the base rule alone now carries it.

### The residual `div` gap, and why the selector is now `body *`

Critic #8 demonstrated live that a tag list leaves a hole wherever a bare text node lands in a `div`: a 200-char token injected into `Alert`'s body div took the page to **1798px**, while the identical token in a `p` in the same place left it at **375**. Nothing in the current code renders user text into a bare `div`, so it was not a live defect — but `Alert`'s body is the most plausible place a future echo lands, and a tag list would mean revisiting the rule every time a new component echoes user text. That is the per-site approach that already failed twice.

Selector broadened to `:where(body *)`. Re-verified with the critic's own repro: the bare-`div` text node now computes `overflow-wrap: anywhere` and the page stays at **375**.

### Collateral damage check (the risk of any systemic fix)

Critic #8 checked this specifically and found none: invite codes stay on one line at 375px **and 320px** (on `/login` at 320px they wrap once after a hyphen, which default line-breaking does anyway — not a mid-code split); the `tabular-nums` price column never wraps; all non-wrapping badges stay one line at 375/320/1280; admin row date columns hold at `shrink-0`. A mid-word-break sweep across seven pages at both 375 and 320 found **zero** unintended breaks.

## Final quality bar

| Criterion | Status |
|---|---|
| App runs with `npm run dev`, zero errors | ✅ clean boot; `build` exits 0 with only the known pre-existing `store.ts:291` warning |
| Learner can sign up, log in, browse with no console errors | ✅ fresh signup → auto-login → `/browse` with 6 listings, **zero console errors** |
| Coach redeems valid invite code → immediately approved | ✅ nav flips to coach in the same response; single-use; 6-way concurrency race yields exactly one winner |
| Public application → admin queue → approve/reject mutates `coach_status` | ✅ every transition confirmed in `data/db.json`, not just the UI |
| Only approved coaches create listings (UI **and** data layer), RLS correct on static review | ✅ anonymous / `none` / `pending_review` / `rejected` **and a forged actor** all refused at the data layer; UI blocks independently; RLS reviewed line-by-line across 3 critic rounds |
| Listings show title, price, coach name, description in browse/search | ✅ all four fields signed out; search matches title + description only, matching the SQL indexes |
| No hardcoded secrets; env vars for all Supabase-shaped config | ✅ `process.env` appears **only** in `src/lib/env.ts`; `SESSION_SECRET` and `SEED_ADMIN_PASSWORD` have no defaults and throw; demo fixtures documented as public POC credentials in `README.md` |
| Browse + listing-detail mobile-responsive | ✅ 375 = 375 with hostile fixtures (118-char names, 200-char tokens) across every page, at 375, 320 and 1280 |

## Explicitly deferred — and honestly so

| Item | Why | Substitute check |
|---|---|---|
| **Live Postgres RLS enforcement** | No Docker, no `psql`, no Supabase project. **Not one line of SQL has ever executed.** | Policies reviewed line-by-line by a critic across three rounds; every mock authorization check mirrors a named policy; the mock is independently enforced and covered by 115 committed assertions. A `pg-query-emscripten` parse proved top-level syntax only — `$…$` bodies are opaque to it, so PL/pgSQL is hand-reviewed. |
| **Visual appearance** | Screenshots time out — the Browser pane never composites frames. | Geometry and emitted markup only: zero overflow at 375/320/1280, zero overlaps, no clipping, AA contrast (4.70 light / 5.80 dark), coherent type scale, no scaffold remnants. **Nobody has actually looked at these pages.** The wrapping category badge clears its own stadium radius by ~0.25px and specifically wants a human eye. |
| **`:focus` / `:focus-visible` behaviour** | `document.hasFocus()` is always false here, so Chrome never matches the pseudo-class. An agent misdiagnosed a *working* utility this way and its change was reverted. | Verified by reading emitted CSS: exactly one `:focus-visible` rule, zero outline-suppressing rules. |
| **Physical keyboard tab order** | Synthetic Tab keypresses never reach the page. | Markup order and `aria` wiring reviewed; not traversed. |

## Deployment checklist inherited from phase 1 (nobody has verified these)

- PL/pgSQL body compilation.
- Every `GRANT` / `REVOKE` / `ALTER … OWNER` succeeding — `0002_rls.sql` assumes the migration runner **inherits** `javelin_privileged`; a `NOINHERIT` runner fails.
- Policy semantics under a real `authenticated` JWT.
- Whether `create trigger … on auth.users` is permitted by the target project's grants.
- The `session_user = 'authenticator'` assumption, load-bearing in **two** places. Holds on stock Supabase; breaks on self-hosted PostgREST with a different `db-uri` user, or a pooler that rewrites `session_user`.

### Why the first D1 fix failed, and what changed

The critic's central criticism was correct and worth recording in full: **the fix stopped at the fields the previous critic happened to name.** Patching the five reported sites left `application.user_name` echoed unguarded at two more (`admin/applications/page.tsx:223`, and the outcome banner via `ui/alert.tsx:39`) — and a name is user-controlled, because `signup-form.tsx` sets **no `maxLength`** on `fullName` while `signUp` accepts up to 120 characters. Measured: **1204px** on `?status=approved`, **1054px** on the `pending` tab via the banner alone, **1279px** in a production build, **1471px** at desktop width. Unremovable, since `DataClient` has no delete, no withdrawal, and **no profile-update method at all**.

Two rounds of per-site patching missed a field each time, so the fix is now **systemic**: a zero-specificity base rule in `globals.css` applying `overflow-wrap: anywhere` to every text-bearing element, so any stored string reaching any page wraps by default — including code not yet written.

The mechanism, which explains both earlier failures: **`overflow-wrap: break-word` does not change an element's intrinsic min-content size**, so a flex or grid item still refuses to narrow below its longest token no matter how the text wraps. **`anywhere` does** change it. That is why `break-words` everywhere still left `/browse` at 464px, and why the earlier fix needed `min-w-0` threaded through four wrappers to compensate.

### Findings

| ID | Sev | Item | Status |
|---|---|---|---|
| N1 | MED/HIGH | D1's class survived on `user_name` at two sites; reachable through the ordinary signup form, permanent, and reproduced in a production build. | ✅ closed by the base rule |
| N2 | LOW | **The D4 fix shipped a false comment** claiming the error id "matches what `fieldDescribedBy` builds, so the failure is announced with the field" — it emits only the hint id. It also contradicted the correct comment fifteen lines above it. | ✅ closed |
| N3 | LOW/MED | The mobile menu's "Signed in as {name}" had neither wrap nor truncation — **1093px** on every page once opened — while the desktop copy already used `max-w-[14ch] truncate`. | ✅ closed — truncated, verified 170px with ellipsis |
| N4 | LOW | `invite.note` echoed unguarded: `/admin/invites` measured **1731px** with a 200-character note. | ✅ closed by the base rule |
| D2 | LOW | The rewritten failure-mode table was **still wrong**: it claimed a non-admin never sees the message, but on the JavaScript path the action result returns alone (HTTP 200, no re-render) and the message **does** render in the row. The 404 happens only on the no-JS document POST. | ✅ closed — both paths now documented, having been measured |

D6 (`guessApplicationField` unreachable) confirmed INFO by the critic and left as deliberate defence-in-depth.

### Verification with hostile fixtures

Fixtures: a **118-character unbroken applicant name** (the case that defeated the previous fix), 200-character tokens in bio, experience and reviewer note, 79-character sport, a 200-character invite note, and a listing carrying 120/200/55-character tokens in title, description and category.

| Surface | Critic measured | Now |
|---|---|---|
| `/admin/applications?status=approved` | 1204px | **375 = 375** |
| `?status=all` | 1204px | **375 = 375** |
| `?status=pending&reviewed=<id>` (banner alone) | 1054px | **375 = 375** |
| `/admin/invites` (200-char note) | 1731px | **375 = 375** |
| Mobile menu open, 118-char name | 1093px | **375 = 375**, name clipped to 170px |
| `/browse` (hostile listing) | — | **375 = 375** |
| `/listings/[id]` (hostile title/desc/category) | — | **375 = 375** |

Line-box measurement (`Range.getClientRects`, the technique the critic used to catch the banner case) reports no overflowing text on any surface once `sr-only` and `overflow: hidden` elements are excluded — both of which are clipped by design and were confirmed to have box right edges ≤ 375.

`tsc`, `lint`, `build` clean (only the known `store.ts:291` warning); `verify:authz` **115/115**; fixtures reseeded; `scripts/` back to its three permanent files; no stray processes.

### Phase 3 defects (critic #6)

| ID | Sev | Defect | Status |
|---|---|---|---|
| D1 | **MED/HIGH** | **Any signed-in learner could permanently break every admin's mobile review queue.** Five sites echoing stored user text used `whitespace-pre-wrap` with no `overflow-wrap`, so a single unbroken token wrapped at whitespace only. Measured **2393px** document width at a 375px viewport. There is no application delete or withdrawal in `DataClient`, and rejecting does not remove the row from the `rejected`/`all` tabs — so the damage is permanent. The reverse also held: an admin's reviewer note broke the applicant's own `/coach/apply`. | ✅ closed |
| D2 | LOW | The failure-mode table in `reviewApplicationAction`'s doc comment was **wrong about two of its four rows**. `forbidden` for a non-admin is never rendered in the row — the re-render 404s. `forbidden` for self-review is unreachable through the UI, and a hand-crafted POST lands the message on **another applicant's** form. | ✅ closed |
| D3 | LOW | Two of four failure paths silently discarded the reviewer's typed note (`formError` called without `values`), so an admin who typed a long rejection and tripped a validation error lost it. | ✅ closed |
| D4 | LOW | The reviewer-note textarea was `aria-describedby`-linked to an error it never set `aria-invalid` for. The message is form-level ("That application has already been reviewed" is not about the note). | ✅ closed |
| D5 | LOW | `ReviewFormProps.filter` was typed `string`, discarding the `ApplicationFilter` union at the one place the value crosses a component boundary. | ✅ closed |
| D6 | INFO | `guessApplicationField` is unreachable because the action pre-validates to exactly the data layer's bounds. Left as deliberate defence-in-depth — the comment is already honest about it. | — no change |

### D1 was broader than the critic found, and the root cause was not wrapping

Two things the review did not reach:

1. **The same defect class was live on the public pages.** A coach controls a listing's title, description and category, so an unbroken token there breaks `/browse` and `/listings/[id]` **for every anonymous visitor** — a wider blast radius than the admin-only queue. Phase 4's critic had approved those pages, having only tested the echoed *search term*. Eight further echo sites were hardened.

2. **`break-words` alone did not fix it.** With the utility applied everywhere, `/browse` still measured **464px**. The real blocker was the flex/grid **`min-width: auto`** floor: a grid item refuses to shrink below its longest unbroken token, so no amount of `overflow-wrap` helps until `min-w-0` is set through the whole chain — the `<li>`, the `Card`, and the two inner flex wrappers.

   The last holdout was the `Badge` primitive. Its `whitespace-nowrap` beat a `whitespace-normal` override, because `cn` **explicitly does not de-duplicate conflicting Tailwind classes** — its own doc comment says overrides must be "non-overlapping". Fighting it with a conflicting class was the wrong shape of fix, so `Badge` gained a `wrap` prop instead. Even then it stayed 428px wide: `inline-flex` makes the label an anonymous flex item that inherits `min-width: auto`, so the wrapping variant had to become `inline-block`, where ordinary text wrapping applies.

**Verified by measurement with hostile fixtures in place** — 200-character unbroken tokens in bio, experience and reviewer note, a 79-character sport (the data layer caps it at 80), and a listing carrying them in title, description and category:

| Page | Before | After |
|---|---|---|
| `/browse` (hostile listing) | 464px (after `break-words` alone) | **375 = 375** |
| `/admin/applications?status=all` | **2393px** | **375 = 375** |
| `?status=pending` | 2393px | **375 = 375** |
| `?status=rejected` (hostile note) | 1729px | **375 = 375** |
| `/coach/apply` (hostile note echoed back) | 2393px | **375 = 375** |

`tsc`, `lint` and `build` clean throughout (only the known `store.ts:291` warning); `verify:authz` **115/115**; fixtures reseeded to 3 profiles / 6 listings / 2 unredeemed invites / 0 applications; `scripts/` back to its three permanent files; no stray processes.

### Phase 3 — independently verified by the orchestrator, by execution

- **Static checks**: `npx tsc --noEmit` clean. `npm run lint` clean. `npm run build` succeeds (exit 0) with only the pre-existing phase-1 `store.ts:291` warning already on record — nothing new from phase 3. `npm run verify:authz` **115/115**, `data/db.json` md5-confirmed unchanged by the suite.
- **Real application → real admin queue → real approval**, checked in the store itself, not the UI: a fresh learner signed up through `/signup`, applied through `/coach/apply` — `coach_status` flipped `none → pending_review` in `data/db.json`. It appeared in `/admin/applications` with name, email, bio, experience, sport and submitted date all correct. Admin approved it — `role: 'coach'`, `coach_status: 'approved'`, `reviewed_by` stamped with the admin's id, all in the store.
- **Rejection path**, second applicant, no sport given: rejected with a note — `coach_status: 'rejected'` in the store, **`role` correctly left untouched** (`learner`), note text preserved and shown back to the applicant verbatim.
- **Re-application after rejection — verified as a real submission, not just rendered copy.** The UI claims a rejected applicant can apply again; checked the data layer (`mockClient.ts:515-523`) confirms the only blocks are `coach_status === 'approved'` or an existing `pending` application — `rejected` is neither. Then proved it live: the rejected applicant's second submission succeeded with zero console errors, `coach_status` became `pending_review` again, and **both** application records survived (old `rejected` kept, new `pending` created) — matching the page's own "a new application replaces nothing" copy exactly.
- **Admin self-review is refused, and the buttons are withheld rather than just erroring** — stronger than the brief required. The admin applied to their own queue; their own listing showed an explanatory alert ("This is your own application. Another administrator has to decide it.") with **no Approve/Reject buttons offered at all**. Already-decided applications (the approved and rejected ones above) render the same way — no buttons, an explanatory line instead — closing the double-review path at the UI level for the common case.
- **The underlying data-layer conflict guard was independently confirmed, not just inferred from the UI hiding buttons.** Extracted the real hidden Server Action fields from a still-pending application's review form via JS and fired two genuinely concurrent POST requests at it (`Promise.all`, not sequential) — simulating two admins racing the same item. Result: one request redirected (the winner), one returned a plain 200 with no redirect (the loser, handled inline); `preview_logs` showed **no server errors**; the store ended with the application `approved` exactly once, `reviewed_by`/`reviewed_at` set once, applicant promoted exactly once. The conflict path is real, not just a UI affordance.
- **Route guards match the established phase-2 pattern exactly**: a signed-in learner hitting `/admin/applications` gets the same 404 treatment as `/admin/invites` (confirmed via rendered page text: the shared 404 title, no admin-area strings leaked); anonymous gets a clean 307. Neither 500s.
- **`user_email` correctly scoped**: shown on the admin queue (intended — `CoachApplicationWithUser` is an admin-only surface), absent everywhere else checked.
- **Mobile at 375px**, both new pages: zero horizontal overflow. Two sub-44px elements on each page are inline links inside sentences ("Need to fast-track someone instead? Issue an invite code.", "Been given an invite code? … Redeem an invite code."), matching the exact WCAG 2.5.5 inline-exception pattern phase 2 already established — not new defects. The form's `Textarea` (`src/components/ui/input.tsx:34`) reuses the **same shared `BASE` class** as `Input`, including `text-base` (16px, with the iOS-zoom-prevention comment already in place from phase 2) — phase 3 correctly reused the primitive rather than inlining a new one.
- **Console**: zero errors or warnings across every exercised flow, aside from one single, expected `[error] 404` matching the orchestrator's own intentional learner-on-admin-page test (same benign pattern phase 2 already established) and the pre-existing font-preload dev warnings.
- Fixture state fully restored: `data/db.json` deleted and reseeded via the app's own idempotent seeder (not hand-edited) — confirmed byte-for-byte back to the documented 3 profiles / 6 listings / 2 invites / 0 applications. Zero node processes left running.

### Phase 3 — still owed an independent critic

The orchestrator's verification above covers functional correctness and the specific defect classes previous phases surfaced (self-escalation, double-review races, route-guard parity, primitive reuse). It has **not** substituted for an adversarial code-quality review with no knowledge of the implementation — that is still owed per the build method, and is what critic-agent #3 is for.

## Phase 4 — listing creation + browse/search

| # | Event | Status | Notes |
|---|-------|--------|-------|
| 4a | **marketplace-agent** — three consecutive launches failed | ⚠️ | Two session limits and one server-side 500, each killing the agent before it did any work (last one got as far as "I'll start by reading the required context files"). |
| 4b | **Built by the orchestrator directly** | ✅ done | 2026-08-19. **Deviation from the build method, recorded deliberately.** After three infrastructure failures on one phase, the work was done inline. The part of the method that actually protects quality — *the reviewer is never the author* — is preserved and matters **more** here, not less, since the author is the orchestrator. |
| 4c | **critic-agent #4 verdict** | ❌ **REJECTED** | Criteria 1–5, 7–10 PASS. Crit. 6 FAIL (D1, a money bug), crit. 11 FAIL (D2–D7). Visual polish DEFERRED. |
| 4e | **Orchestrator fixes for D1–D7 + notes** | ✅ done | 2026-08-19. All seven closed and re-verified by execution; see below. |
| 4f | **critic-agent #5 — phase 4 re-review** | ✅ **APPROVED** | All seven defects CLOSED. D1 attacked with 89 adversarial cases plus an exhaustive 6000-case sweep. 3 new LOW items (N1–N3). |
| 4g | **Orchestrator fixes for N1–N3** | ✅ done | All three closed and re-verified. |
| **4 — PHASE COMPLETE** | **Phase 4 approved** | ✅ | Visual polish remains the single DEFERRED item across the whole project. |

### How D1 was proven closed

The critic did not accept the 23-case list. It threw every separator convention and parser trick it could construct — German `1.234,56`, Swiss `1'234.56`, French `1 234,56` with regular/non-breaking/thin spaces, Arabic decimal separator `62٫50`, middle-dot `62·50`, `1,,234`, `1,000,00`, `+1,234`, `1e2,00`, `4_500`, `0x10`, fullwidth `４５`, Arabic-Indic `٤٥`, Devanagari `१२`, a zero-width space inside the digits, LRM/RTL-override characters, and `62,50` followed by `\n`, `\r`, `\t`, NBSP and U+2028 — **89/89 as expected**.

It specifically checked the trailing-newline class, noting that in Perl and Python the dollar anchor matches *before* a trailing newline, and confirmed by execution rather than assumption that JavaScript's does not without the `m` flag (`/^\d+$/.test("45\n") === false`).

It then recorded the structural reason the fix is robust rather than lucky: **a decimal comma in a two-decimal price leaves one or two digits after the comma, and `THOUSANDS_GROUPED` demands exactly three — the two classes cannot overlap.** Confirmed by an exhaustive sweep: *all 6000 decimal-comma forms rejected*. End-to-end through the Server Action with the page gate bypassed, every hostile price wrote **0 rows**, while `1,234.56` → 123456, `62.50` → 6250, `1.15` → 115.

### N-series (phase 4 re-review)

| ID | Sev | Item | Status |
|---|---|---|---|
| N1 | LOW | The D3 fix left `buildBackHref`'s JSDoc stranded above the newly-inserted `firstValue`, so the back-link **security rationale** documented an unrelated helper while the function it described had none. | ✅ closed — doc block reunited with its function |
| N2 | LOW | `firstValue` was duplicated **character-identically** across browse and detail. Two private copies of a normalisation rule drift the moment one is tightened. | ✅ closed — extracted to `src/lib/search-params.ts` and imported by both |
| N3 | LOW | **Horizontal overflow at 375px**: the result-count line echoes the raw search term, so a pasted 300-character unbroken token produced a **2040px** scroll width against a 375px viewport. | ✅ closed — `break-words` on that line; re-measured **375 = 375**, count line wraps at 343 |

N3 is worth recording carefully for two reasons. First, the critic **exonerated its own prime suspect**: it isolated the cause rather than blaming the newly-added `(no matches)` option, proving the `<select>` clips its own content (rendered box 343px, right edge 359 < 375) and that `describeResults` was byte-identical to the pre-fix version — so this was **pre-existing, not a regression**. Second, it **self-reported the miss**: it had under-tested this in review 1 by checking only status codes and escaping for long params, never layout. Browse being mobile-responsive is an explicit quality-bar item, so the fix landed despite the LOW severity and the degenerate input.

### Phase 4 defects (critic #4) — all closed

| ID | Sev | Defect | Status |
|---|---|---|---|
| D1 | **MED** | **`parsePriceToCents` stripped commas before validating them**, so a decimal comma published a **100× price**: `62,50` → `625000` cents → **£6,250.00**. Proven end-to-end by the critic, not by inspection. Compounding it: the field hint says "e.g. 45 or 45.00" so nothing warns against a comma, and `DataClient` has **no listing update or delete** — the wrong price is permanent and the coach cannot fix it. | ✅ closed |
| D2 | LOW-MED | Browse cards did not fill their grid cell when content was short (measured `264×170` inside a `343`-wide cell). All six seed titles are long, which is exactly why the fixtures hid it. | ✅ closed |
| D3 | LOW | `?published=1` was a **dead parameter** — the redirect set it, the detail page never read it, so a coach got no publish confirmation. Half-implemented a pattern the project already uses twice and *does* read (`?submitted=1`, `?redeemed=1`). | ✅ closed |
| D4 | LOW | The comment justifying `Math.round` **stated a false fact** — `45.55 * 100` is exactly `4555`, not inexact. The code was right and the rounding load-bearing, but a maintainer told to verify comments would find the claim false and might "simplify" the rounding away, reintroducing a penny loss. | ✅ closed |
| D5 | LOW | An over-long category chosen from the **dropdown** reported its error under **"Or add a new category"** — a field the user left blank — while the select itself showed nothing. | ✅ closed |
| D6 | LOW | The action skipped the data layer's 3-character title minimum, so submitting `ab` rendered **"Title is required."** against a field visibly containing text. | ✅ closed |
| D7 | LOW | An unknown `?category=` left the select showing "All categories" while the count line said "0 listings in Nope" — pressing Search then silently dropped the filter. | ✅ closed |

Also addressed from the critic's non-defect notes: `browse/page.tsx` now uses the shared `fieldDescribedBy('q', …)` helper instead of a hard-coded id that was correct only by coincidence; the redundant `focus-visible:rounded` (duplicating the global `:focus-visible` radius) removed; the `priceCents as number` assertion replaced with a real null-narrowing guard; browse card titles changed `h3` → `h2` to stop skipping a heading level under the page `h1`.

### Phase 4 fix verification (by execution)

- **23/23 price cases pass**, including every value the critic probed. `62,50` → `null`, `4,5` → `null`, `1,2,3,4` → `null`, `12,34` → `null`, `1,23,456` → `null`; while `1,234.56` → `123456`, `1,234` → `123400`, `62.50` → `6250`, `1.15` → `115`, `4.35` → `435`, `8.20` → `820`, `16.08` → `1608` (the genuine binary-float traps `Math.trunc` would each undercharge by a penny).
- **End-to-end through the real Server Action**: publishing at `62,50` is now **refused** with a field-level "Enter a price like 45 or 45.00…" and no row written; publishing at `1,234.56` succeeds, stores `price_cents: 123456`, and renders **£1,234.56**. No `625000` row exists anywhere.
- **D3** verified live: the destination now renders a "Listing published" success `Alert` inside a live region (`role` count 1) rather than ignoring the flag.
- **D2** verified live at 375px: all 7 cards measure card-width === cell-width (343 = 343). The fix is structural (`w-full`), so it holds regardless of content length rather than being masked by long fixtures.
- **D7** verified live: `?category=Nope` now emits `<option value="Nope" selected>Nope (no matches)</option>`, so the control agrees with the count line; a known category still selects normally with no duplicate option.
- `tsc` clean, `lint` clean, `build` exit 0 with only the known pre-existing `store.ts:291` warning, `verify:authz` **115/115**. Fixtures reseeded to 3 profiles / 6 listings / 2 unredeemed invites / 0 applications; `scripts/` back to its three permanent files; no stray processes.
| 4d | **critic-agent (phase 3)** | ⬜ queued | Still owed. Sequenced after 4c — two `next dev` servers in one project directory share `.next/` and corrupt each other's builds. |

### Files created (phase 4)

| File | What it is |
|---|---|
| `src/app/browse/page.tsx` | public browse + search; filters live in the URL via a plain GET form (no client component, works without JS) |
| `src/app/listings/[id]/page.tsx` | public listing detail + the inert Buy stub; `generateMetadata` |
| `src/app/listings/new/page.tsx` | listing composer, gated on `coach_status` with a distinct explanation per state |
| `src/app/listings/new/new-listing-form.tsx` | `useActionState` form, matching the house pattern |
| `src/app/listings/new/actions.ts` | `createListingAction` — currency parsing, field validation, `DataError` mapping |
| `src/components/listing-card.tsx` | browse result card; renders title, price, coach name, description |
| `src/components/ui/select.tsx` | native `<select>` styled to match `Input` (the one genuinely missing primitive) |
| `src/lib/format.ts` | **extended** with `formatPrice` / `parsePriceToCents` alongside the existing `formatDate` |

### Phase 4 — verified by execution

- **Static**: `tsc` clean, `lint` clean, `build` exit 0 with `/listings/[id]` registered and only the known pre-existing `store.ts:291` warning. `verify:authz` **115/115** — phase 1 intact.
- **Browse works signed out**, with no actor anywhere on the page: all 6 seeded listings render **title, price, coach name and description** (the explicit quality-bar item), correct count line, prices formatted from integer cents (`4500` → `£45.00`).
- **Search parity with the SQL indexes held deliberately.** Title keyword matches; a description-only keyword matches (`withdrawal`, `periodised`, `foul` each → 1); case-insensitive (`JAVELIN`). Critically, a **category name** and a **coach name** as keywords both return **0** — correct, and the thing most likely to be "helpfully" broken. Category is a separate exact-match filter; combined keyword + category works and the URL is linkable.
- **Empty states are distinct**: "Nothing matched those filters" (with a Clear control) vs "No listings yet"; the Clear control is absent when no filter is active.
- **Listing detail**: title, price, coach name, category, description; back link round-trips filters (`?q=grip&category=Track+%26+Field`), re-encoded through `URLSearchParams` rather than pasted through. Garbage id **and** uuid-shaped-but-unknown id both → **404, not 500**.
- **The Buy stub is genuinely inert** — a real `disabled` attribute plus `aria-describedby` pointing at "Payments are not part of this proof of concept… nothing is charged." No fake checkout.
- **Authorization, both layers.** Data layer refuses, verified by direct call: anonymous → `unauthorized`; learner (`coach_status: 'none'`) → `forbidden`; **a forged actor carrying `role: 'coach'`/`coach_status: 'approved'` for a learner → still `forbidden`**; `pending_review` → `forbidden`. Approved coach allowed, with `coach_id` taken from the actor. UI half: anonymous → 307; learner → the block with both routes offered and no form rendered.
- **Publish end-to-end**: coach published "Grip & Release Masterclass", redirected to its detail page, and the store shows `price_cents: 6250` — a correct integer for `62.50`, the float-rounding case — `coach_id` the coach's own, ampersand escaped correctly. It then appeared in signed-out browse (7 listings), was searchable by keyword, and its **brand-new category became an available filter option**.
- **Validation**: an over-precise price (`45.999`), a 9-character description and a missing category produced three distinct field errors naming the actual problem, values re-populated, no 500.
- **Mobile at 375px**: zero horizontal overflow on browse and detail; inputs 16px at 44–46px. Browse listing titles measure 21px but use a **stretched-link** pattern — probing the card's centre, top-left and bottom-right all resolve to the listing link, so the real target is the full 343×210 card. The detail page's "← Back to browse" was a genuine 18px standalone nav link and was **sized to 44px**, following the precedent phase 2 set for footer nav links.
- **Console**: zero errors and zero hydration warnings across every phase-4 page; only the pre-existing font-preload dev noise already on record.
- Fixtures reset via the app's own seeder: 3 profiles at original statuses, 6 listings, 2 unredeemed invites, 0 applications. No stray processes.

### Phase 1 — facts the UI agents must know

1. `getPublicProfile(userId)` returns **exactly** `{ id, full_name, is_approved_coach }` and is the **only** profile shape a public page may render.
2. `getProfile(actor, userId)` takes the actor **first** and throws `forbidden` for a non-owner non-admin.
3. `coach_status === 'approved'` does **not** imply `role === 'coach'` — an admin who becomes a coach stays an admin. Never branch admin UI on `role === 'coach'` alone.
4. Search matches **title + description only**; category is a separate exact-match filter.
5. `DataClient` has **no** listing update/delete, profile update, application withdrawal, or pagination. Any UI needing those requires an interface addition first — raise it, don't work around it.

### Deployment checklist inherited from phase 1 (unverifiable locally)

- PL/pgSQL body compilation — never executed.
- Every `GRANT`/`REVOKE`/`ALTER … OWNER` succeeding; `0002_rls.sql:824-845` assumes the migration runner **inherits** `javelin_privileged` — a `NOINHERIT` runner fails there.
- Policy semantics under a real `authenticated` JWT.
- Whether `create trigger … on auth.users` is permitted by the target project's grants.
- The `session_user = 'authenticator'` assumption, now load-bearing in **two** places (the guard trigger and `grant_admin`). Holds on stock Supabase; breaks on a self-hosted PostgREST with a different `db-uri` user, or a pooler that changes `session_user`.

### Resumption findings (2026-08-18) — verified, not trusted

The interrupted rework had in fact landed **more** than its last message implied.
Verified directly at the source, not from any claim:

- **N1 CLOSED** in both halves. `public.public_profiles` (`0002_rls.sql:369-374`) projects exactly `id`, `full_name`, and a derived `(coach_status = 'approved') as is_approved_coach` — `role` and `coach_status` are gone. `PublicProfile` (`types.ts:47-51`) and `toPublicProfile()` (`mockClient.ts:186-192`) match.
- **N2 CLOSED.** The guard's second exemption is now `session_user <> 'authenticator'` (`0002_rls.sql:197`) — a positive test closed by construction — replacing the two-string denylist that failed open for any custom JWT role.
- **N3 CLOSED.** `on conflict (id) do nothing` (`0002_rls.sql:858`), and the redundant `unique` on `profiles.email` is dropped in favour of a non-unique `lower(email)` index (`0001_init.sql:70,82`). The mock's own signup email-uniqueness check still stands independently (`mockClient.ts:233-235`).
- **N4 CLOSED.** The view comment now states the mechanism correctly — it *bypasses* `profiles` RLS and breaks if FORCE RLS is ever enabled.
- **N5 CLOSED**, and the suite grew 87 → 115 assertions with genuine race and injection coverage: a 3-way race on a **fresh** code asserting exactly one winner and one promotion, and an actual injected `coach_id`/`id`/`created_at` payload proven ignored.

One assertion was still failing on resumption, and it was a **test bug, not a product
defect**: it scanned the serialized public payload for the substring `"admin"`, but the
seeded admin's `full_name` is "Ada Administrator". Renaming the fixture would have hidden
an unsound assertion — a display name is user-chosen and is not a privilege disclosure — so
it was replaced with a structural check: no privilege-bearing key present, and no value that
is a role/status enum member. **Suite now 115 passed, 0 failed.**

### Critic #1 second-pass defect list (N-series)

| ID | Sev | Defect | Status |
|---|---|---|---|
| N1 | MED | `public_profiles` published `role` + `coach_status` to `anon`, **reopening the D8 oracle in a stronger form** — `where role = 'admin'` would enumerate the entire admin roster with only the anon key, no uuid needed; and every user's `rejected`/`pending_review` state was world-readable. | ✅ closed |
| N2 | MED | Guard trigger's exemption was a **denylist of two literal strings** that fails open: any custom JWT role added later could set its own `role='admin'`. | ✅ closed |
| N3 | MED | `handle_new_user`'s untargeted `on conflict` could leave a user **authenticated with no profile row**, reachable via the project's own documented seeding workflow. | ✅ closed |
| N4 | LOW | View comment mis-stated its own mechanism and contradicted the README — dangerous because the file's own follow-up suggests enabling FORCE RLS later. | ✅ closed |
| N5 | LOW | Two suite assertions didn't test what their labels claimed (a "exactly one winner" race asserting **zero** winners against an already-spent code; an "owned by actor, not input" test that never passed an input `coach_id`). | ✅ closed |
| N6 | LOW | `PROGRESS.md` cited a "62-assertion suite" that no longer existed — stale text in the file the resumption protocol tells the next session to trust. | ✅ closed |

### ⚠️ Interface change — downstream agents must read this

`getProfile` is now **`getProfile(actor, userId)`** and throws `forbidden` for a non-owner non-admin.

A new **`getPublicProfile(userId)`** returns a `PublicProfile` whose shape is **exactly**:

```ts
{ id: string; full_name: string; is_approved_coach: boolean }
```

No `email`, no `role`, no `coach_status` — publishing `role` to anonymous callers
would enumerate every administrator (defect N1), and `coach_status` would make
every rejected application world-readable.

**Public pages must render `PublicProfile`, never `Profile`.** For a verified-coach
badge use `is_approved_coach`; the raw enum is deliberately unavailable.

Other notable rework decisions:
- Coach promotion raises privilege only from `learner`; an admin who redeems an invite code stays an admin. Self-review of one's own application is refused in both mock and SQL.
- The profile privilege guard is gated on `current_user = 'javelin_privileged'` (a `NOLOGIN` role owning the privileged functions), not a settable GUC. The guard trigger is `SECURITY INVOKER` by necessity.
- Mock search narrowed to title + description only, matching the SQL indexes, so results don't change at swap time.
- `public.apply_to_coach()` RPC makes `pending_review` reachable in SQL exactly as the mock does it.

### Critic #1 defect list (phase 1)

| ID | Sev | Defect | Status |
|---|---|---|---|
| D1 | HIGH | `coach_status='pending_review'` reachable in mock, **impossible in SQL** — no privileged path sets it; a real Supabase client would wedge the user (application row committed, profile update rejected 42501, retry → 23505). Code comment claiming a path exists is false. | 🔄 fixing via `apply_to_coach()` RPC |
| D2 | HIGH | Coach promotion unconditionally overwrites `role`, **permanently demoting an admin** (verified: 0 admins remain, seeder does not repair, only recovery is deleting `db.json`). Triggers: admin redeems the invite code printed beside their own row in the README; or admin self-approves their own application (no self-review check in mock or SQL). | 🔄 fixing: promote only from `learner`; forbid self-review |
| D3 | MED | `.env.local.example` is itself matched by `.gitignore`'s `.env*`, so the template the README says to copy can never be committed. | 🔄 fixing |
| D4 | MED | `javelin.privileged_profile_write` GUC is a placeholder **any role may SET**, and is the sole gate on the profile privilege guard. | 🔄 fixing via owner-identity check |
| D5 | MED | No supported way to create/restore an admin: `auth.uid()` is NULL for service-role/SQL-editor writes, so the guard raises 42501. With D2 this is a hard lockout. | 🔄 fixing |
| D6 | LOW | `invites.created_by/redeemed_by` and `coach_applications.reviewed_by` are NO ACTION while `profiles` cascades from `auth.users` → deleting any such user aborts with 23503. | 🔄 fixing |
| D7 | LOW | `DATA_BACKEND` typo silently selects the mock instead of failing loudly. | 🔄 fixing |
| D8 | LOW | `is_admin(uuid)` granted to `anon` — an anonymous admin-targeting oracle. | 🔄 fixing |
| X1 | — | Divergence: public profile select exposes `email` to anonymous readers in both mock and SQL. Fixing now, before UI renders `Profile` objects. | 🔄 `public_profiles` view |
| X2 | — | Divergence: mock search matches category + coach name; SQL indexes only title + description. | 🔄 aligning |

Verified correct by the critic, not to be re-litigated: `listings_insert_approved_coach` requires **both** `coach_id = auth.uid()` and approved status; the WITH-CHECK-cannot-see-OLD problem is correctly solved with a BEFORE UPDATE trigger; only admins update `coach_applications.status` and `invites`; the 42P17 recursion risk is correctly routed through `SECURITY DEFINER` helpers; all five definer functions pin `search_path` with `pg_temp` last; `redeem_invite_code`'s conditional update is a genuine concurrency lock.

## Files claimed complete

Verify each of these exists before trusting this section (see resumption protocol).

| File | What it is |
|---|---|
| `supabase/migrations/0001_init.sql` | extensions, enums, tables, indexes, `updated_at` triggers |
| `supabase/migrations/0002_rls.sql` | RLS enable + all policies, `is_admin()` / `is_approved_coach()` definer helpers, profile column-guard trigger, `redeem_invite_code()` and `review_coach_application()` RPCs |
| `supabase/seed.sql` | SQL mirror of the mock seed fixtures |
| `supabase/README.md` | swap path + mock-check ↔ RLS-policy mapping table |
| `src/lib/env.ts` | every `process.env` read; `SESSION_SECRET` / `SEED_ADMIN_PASSWORD` have no defaults |
| `src/lib/data/types.ts` | domain types, `Actor`, `DataError`, `isDataError`, `dataErrorStatus` |
| `src/lib/data/client.ts` | the `DataClient` interface (the swap surface) |
| `src/lib/data/mock/store.ts` | JSON load/save, atomic writes, mutex, scrypt passwords, idempotent seeding |
| `src/lib/data/mock/mockClient.ts` | `DataClient` impl; every authorization check comments the RLS policy it mirrors |
| `src/lib/data/index.ts` | `getDataClient()` factory reading `DATA_BACKEND` |
| `docs/DATA-LAYER.md` | usage guide for downstream agents |
| `README.md` | rewritten: setup, demo fixtures (public POC credentials), env table |
| `.env.local` | working local config (gitignored) with a generated `SESSION_SECRET` |

**How to re-verify this phase yourself** (the resumption protocol requires it —
do not trust the claims above):

```bash
npm run typecheck && npm run lint && npm run verify:authz && npm run dev
```

`npm run verify:authz` runs `scripts/verify-authz.mts` against a throwaway store
in the OS temp dir — it never touches `data/db.json` (the critic confirmed the
file is byte-identical before and after a run). It is the committed regression
suite for the defects found in review, including: an admin who redeems an invite
code is **still an admin** (D2), and applying reaches `coach_status =
'pending_review'` (D1).

Independently re-proved by the critic against the reworked code, using its own
from-scratch suite rather than the builder's: anonymous actors refused all 10
mutating/privileged methods across 6 empty-actor shapes; five forged-actor
shapes (including a nested `profile: { role: 'admin' }`) refused on all
privileged methods; two TOCTOU getter actors refused with no side effects;
`coach_id` / `user_id` / `status` / `reviewed_by` injection all ignored;
`signUp` with `role: 'admin'` still mints a learner; mutating a returned
`Profile` or `PublicProfile` grants nothing; a 6-way concurrency race on one
invite code yields exactly one winner and one promotion; failed redemptions
consume nothing.

**Not** yet built: pages, forms, auth/session, UI components — `src/app/**` is
still the scaffold.

## Quality bar status — SUPERSEDED

This early table is kept only so the file reads chronologically. It is **stale**
and its "not started" entries are wrong. The verified end state is the
**"Final quality bar"** section above: all eight criteria pass, with four items
explicitly deferred and their substitute checks recorded.
## Explicitly deferred

| Item | Reason | Substitute check |
|---|---|---|
| Live Postgres RLS enforcement | No real Supabase project / running Postgres in this phase | SQL policies verified by static review **and** the mock data layer independently enforces the same rules in code |

---

# REBRAND — JavelinHub brand system (phases A–D)

Product decision, 2026-08-20: the app adopts the **JavelinHub** brand and
narrows from a generic multi-sport coaching marketplace to a javelin-throwing
platform. Four phases: **A** tokens/primitives, **B** mark/shell, **C** data
layer for video reviews + training blocks, **D** pages/copy/USD.

`docs/brand-guidelines.html` (v1.1) is the **source of truth** for tokens, type,
spacing and voice. If a phase requires deviating from it, stop and flag it —
the doc gets amended, not the code.

## Decisions locked before phase A

| Question | Decision |
|---|---|
| Dark mode | **Dropped.** Light-only; the `prefers-color-scheme` block comes out. |
| Product scope | **Rebrand + scaffold the missing pillars** (video review, training blocks). |
| Currency | **USD.** (v1.0 of the brand doc mocked CHF; the code had GBP.) |
| Brand doc | **Amended to v1.1 first**, then built to. |
| Phase order | **A → B → C → D**, so a renderable app exists before a new authorization surface lands. |

## Brand doc v1.1 — nine amendments to v1.0

Written 2026-08-20 into `docs/brand-guidelines.html` (v1.0 came from
`~/Downloads`; the doc now lives in the repo so it versions with the code).

1. **Steel darkened** `#6D746C` → `#5A615A`. The original is **4.47:1** on Sheet
   — a WCAG AA failure, and it carried every label, eyebrow and caption in the
   system.
2. **Foul Red added** `#B3261E` (6.07:1 on Sheet). v1.0 had no error colour at
   all while its own Voice section specified a failed-payment message.
3. **White promoted** to a named token; it was already carrying cards and inputs.
4. **The one-blue rule scoped to the content area.** As written it contradicted
   itself — blue was reserved for "the mark and the action", which is two on
   every screen with a header.
5. **`Big Shoulders Display` → `Big Shoulders`**, variable. See below.
6. **Input text raised to 16px**, mono floor 10px, in-card Book button to 44px.
7. **System rules made explicit** — radius 0, elevation none, 1px rule, 34/8
   spacing, 44px targets, 2px focus ring.
8. **Light-only declared.**
9. **Units pinned** — meters to 2dp, whole degrees, minutes, USD.

### The font family in v1.0 never rendered

`Big Shoulders Display` has been **retired from the Google Fonts catalogue** —
consolidated into the variable superfamily `Big Shoulders`. Confirmed against
`next/font`'s own catalogue (`next/dist/compiled/@next/font/dist/google/font-data.json`):
the old name is **absent**; `Big Shoulders` is present with weights 100–900 plus
a variable axis. A stylesheet asking for the retired name falls back silently to
`Arial Narrow`, so v1.0 was not displaying as designed for anyone.

Upside: `Big Shoulders` and `Newsreader` are both variable, so the full weight
range costs one axis each rather than five static cuts — the payload concern
raised against v1.0's five-weight request disappears.

Verified in-browser after writing v1.1: all three families report `loaded`
(`document.fonts.check('900 60px "Big Shoulders"')` → true), 8 swatches, 6
system-rule cards, 6 amendment callouts, and **375 = 375** with zero horizontal
overflow at a 375px viewport.

## Resumption protocol — run 2026-08-20, before any phase A work

Per the protocol at the top of this file, `PROGRESS.md`'s claims were verified
independently rather than trusted. **Everything it claims about phases 1–4 held.**

| Check | Result |
|---|---|
| Claimed files exist | ✅ all — `supabase/` (4), `scripts/` (3), 57 files under `src/` |
| `npm run verify:authz` | ✅ **115 passed, 0 failed**, exit 0 |
| `data/db.json` unmutated by the suite | ✅ md5 `76210923…` identical before and after |
| `npx tsc --noEmit` | ✅ clean, exit 0 |
| `npm run lint` | ✅ clean, exit 0 |
| `npm run dev` | ✅ Ready in 638ms, zero errors |
| Learner signup → browse | ✅ auto-login → `/browse`, 6 listings; store shows `role: learner`, `coach_status: none` |
| Invite redemption → approved | ✅ `THROWERS-WELCOME` → `role: coach`, `coach_status: approved` in the **same response**; nav flipped to "New listing", Coach badge appeared; invite records the redeemer, single-use |
| Application → admin queue → mutation | ✅ `none → pending_review` with `role` untouched; queue showed name, email, sport and bio; approve → `role: coach`, `coach_status: approved`, `status: approved`, `reviewed_by` an admin, `reviewed_at` set |
| Approved-only listing creation | ✅ approved coach published at `62.50` → `price_cents: 6250` (the binary-float trap case), redirect carried `?published=1`; **learner is blocked** — no form and no publish button rendered at all |
| Console errors, all flows | ✅ zero |
| Server errors, all flows | ✅ zero |

### Two corrections to this file's claims

1. **"No stray processes" was stale.** A `next dev` for this project (PID 17204,
   started 10:02 that morning) was still holding port 3000 — an unmanaged
   holdover from the interrupted prior session. It could not be run alongside a
   second server, since this file itself records that two `next dev` processes
   in one project directory share `.next/` and corrupt each other's builds. It
   was stopped and a managed server started in its place.

2. **Fixtures are NOT reset.** `data/db.json` still carries the resumption
   test records: profiles `resume-check@javelin.test` (promoted to coach via
   invite) and `applicant-two@javelin.test` (approved via the queue), one
   listing "Run-Up Rhythm Audit", one approved application, and
   `THROWERS-WELCOME` marked redeemed. Two attempts to restore the baseline —
   deleting the file to let the idempotent seeder regenerate it, then rewriting
   it in place — were **denied by the permission classifier**. Low impact:
   `/data` is gitignored and documented as "regenerated on first run", so this
   is disposable scratch, not a tracked artifact. Baseline to restore to is
   3 profiles / 6 listings / 2 unredeemed invites / 0 applications.

## Known environment limitation — screenshots are impossible

Re-confirmed on 2026-08-20, unchanged from phases 2–4: `computer` →
`screenshot` fails with "the Browser pane is not displayed, so the page is not
compositing frames". Tried: publishing the page, resizing the viewport, and
requesting a screenshot at desktop preset — all fail the same way after 5s.

**This is not a licence to leave style criteria unverified.** Everything below
is available without compositing and must be used instead:

- computed styles via `getComputedStyle` through `javascript_tool`
- `document.fonts.check(...)` for whether a face actually loaded
- `scrollWidth` vs `clientWidth` at 375px for overflow
- `getBoundingClientRect()` for tap-target and element geometry
- `Range.getClientRects()` for line-box overflow of text specifically
- grepping the emitted CSS bundle for the tokens actually applied
- DOM/ARIA assertions via `read_page`

Visual confirmation is the **user's** job at each phase boundary. A critic must
not accept "couldn't screenshot" as the reason a style criterion went unchecked.

## Phase A — tokens and primitives

| # | Event | Status | Notes |
|---|-------|--------|-------|
| A1 | **phase-A builder** launched | ✅ | Scope: `globals.css`, font wiring in `layout.tsx`, the files in `src/components/ui/`. Explicitly out of scope: wordmark/shell (B), data layer (C), page copy + currency (D). Given `docs/brand-guidelines.html` v1.1 as source of truth with instructions to stop and flag rather than silently deviate. |
| A2 | **phase-A builder** completed | ✅ claimed done | 11 files changed, **zero page files touched** — every primitive kept its existing API (`tone="raised"`, `BadgeTone`, `AlertTone`, `variant`/`size`, `wrap`, `invalid`), so no call site broke. |
| A3 | **Orchestrator spot-check** (not a substitute for the critic) | ✅ mechanical criteria confirmed | Re-ran the gates and greps independently rather than trusting the builder's report. |
| A4 | **critic-agent (phase A)** | ⬜ running | Fresh context. Receives only the spec and the quality bar — never the builder's account of what it did or why. |

### Orchestrator spot-check results (independent, by execution)

`npx tsc --noEmit` exit 0 · `npm run lint` exit 0 · `npm run verify:authz` **115 passed, 0 failed** — Phase A did not touch authorization, as required.

| Grep | Result |
|---|---|
| `rounded` in `src/components/ui/` | **0** |
| `shadow-` in `src/` | **0** |
| `dark:` / `prefers-color-scheme` in `src/` | **2 hits, both comments forbidding them** (`globals.css:29`, `ui/index.ts:32`) |
| `geist` in `src/` + `package.json` | **0** |
| raw hex in `src/components/` | **0** |
| raw hex in `src/app/**.tsx,.ts` | **0** |
| `rounded` elsewhere in `src/` | **6**, all in Phase B/D files: `nav-bar.tsx:70,84,159`, `page.tsx:96`, `admin/applications/page.tsx:165,257` |

One discrepancy in the builder's own report: it wrote "5 leftovers" then listed six lines. The list is right, the count is not. Immaterial to the criteria — those files are out of Phase A scope — but recorded because an uncorrected miscount is how a real leftover gets lost.

### The "remove Geist from package.json" criterion is a phantom

`package.json` declares exactly three dependencies — `next`, `react`, `react-dom`. Geist was never a package: it ships inside `next/font/google`, which lives in the `next` package itself. There is nothing to remove, and the criterion is satisfied by removing the imports from `layout.tsx`. Recorded so no reviewer burns time hunting a dependency that never existed.

| A4 | **critic-agent (phase A)** | ❌ **REJECTED** (narrowly) | All six numbered criteria PASS, all non-regression gates PASS, every prior-phase accessibility win confirmed surviving **by execution**. 9 findings: D1–D2 MED, D3–D9 LOW. Two of them (D7, D8) are defects in the **brand doc**, not the code. |
| A5 | **Doc corrections** (orchestrator) | ✅ done | Four amendments to `docs/brand-guidelines.html`; see below. |
| A6 | **phase-A builder rework** — D1–D6, D9 | ⬜ running | Looped back to the original builder, per method. |

### What the critic verified rather than assumed

Worth recording because it sets the bar for later phases. It did **not** trust `document.fonts.status`: it forced `document.fonts.load()`, then measured rendered text width on canvas to prove no silent fallback — `Big Shoulders` @900/60px measures 559.2px where Arial Narrow renders the same string at 816.7px, and the variable axis produces three distinct widths (100→383.7, 400→451.4, 900→559.2). It did not trust the grep for criterion 2: it set the browser to a genuine dark OS preference, confirmed `matchMedia` matched, and observed the page still render Sheet-on-Ink. It did not trust the doc's contrast figures: it recomputed all seven and found two wrong. It did not trust that `verify:authz` counting to 115 meant the suite was intact: it read the harness, confirmed `refuses()` fails when a call *succeeds*, and checked the file's mtime predates Phase A.

It also proved the `overflow-wrap: anywhere` base rule is still load-bearing rather than merely present — 375px with the rule, **2043px** with `break-word` or `normal` substituted.

### Two miscounts, same source

The builder reported "5 leftovers" and listed six lines; it reported "11 files changed" and mtimes show ten. Immaterial to the criteria, and recorded only because an uncounted file is how a real leftover survives a sweep.

### The doc was wrong in four places — amended, not worked around

Found by the critic, verified independently by the orchestrator before acting:

| Doc claim | Actual | Action |
|---|---|---|
| Ink on Sheet **15.3:1** | **17.71:1** | corrected |
| Chalk vs Ink **14.3:1** | **15.97:1** | corrected |
| "Every pair clears 4.5:1", unqualified | the disabled Buy control is 1.86:1 — correctly, WCAG SC 1.4.3 exempts inactive components | carve-out added |
| Mono scale 16/13/11/10; tracking a flat +0.14em | the doc's **own specimens** use a 12px step (`.btn`, `.card .price`) and three different tracking values (.14 labels / .1 buttons+chips / .06 column heads) | scale and tracking corrected to match the specimens |

The other five contrast figures verified exact. Both errors **understated** the true ratio, so nothing built against them was at risk.

The last row matters for method: it resolved **in the code's favour**. `Button`'s 11/12/13 sizes and the 0.1em tracking on buttons and badges were conformant all along; the doc's summary line was a simplification that matched none of its own components. Only the comments citing it were wrong. This is the first case in the project where the source-of-truth document, not the implementation, was the thing that had to change — which is exactly what the "flag, don't silently adjust" rule exists to surface.

| A6a | **phase-A builder rework — interrupted** | ⚠️ | Agent terminated on a session limit (`resets 3pm Europe/Zurich`) immediately after its first action, reporting only "Re-reading the amended doc before touching anything." |
| A6b | **Orchestrator verified state per the resumption protocol** | ✅ | **Nothing had landed.** Not trusted — checked on disk. |
| A6c | **phase-A builder resumed** after the limit reset | ⬜ running | Same agent, context intact. Instructed to verify-and-report per finding rather than batching all seven, so a second interruption cannot lose the whole rework. |

### Resumption check after the builder's session limit (2026-08-20)

The dying agent's own last words were that it had not yet touched anything. That claim was **verified rather than believed**, per this file's resumption protocol — a previous phase (1f/2c) established that an interrupted agent can have landed either more or less than its final message implies.

| Evidence | Result |
|---|---|
| mtimes on all 10 Phase A files | unchanged, all still in the original 11:02–11:17 build window |
| D2 — `badge.tsx:59` | still `'inline-block max-w-full break-words'` |
| D3 — `globals.css:10` | still a single `@source not "../../**/*.md"`, Markdown only |
| D6 — `globals.css:17-18` | still claims "the nine literal values from section 03" |
| D9 — `globals.css:121` vs `:170` | `--font-body` still declared-but-unused, `body` still duplicating the stack literally |

Conclusion: zero rework landed; the full D1–D6 + D9 set is still outstanding. In this instance the dying agent's self-report was accurate — recorded because the protocol's value is that it is run every time, not only when it turns up a surprise.

| A6d | **phase-A builder rework completed** | ✅ claimed done | All seven findings closed. |
| A7 | **Orchestrator spot-check** | ✅ confirmed on disk | Gates re-run independently; each finding verified at its file and line. |
| A8 | **critic-agent (phase A) re-review** | ⬜ running | Same critic instance, its own findings in context. Not the author. |

### Orchestrator spot-check of the rework (independent, by execution)

`npx tsc --noEmit` exit 0 · `npm run lint` exit 0 · `npm run verify:authz` **115 passed, 0 failed**.

| Finding | Verified at | State |
|---|---|---|
| D1 | `globals.css` | 15 references to the new `--text-display-*` / `--text-body-*` / `--text-mono-*` / `--text-field` tokens |
| D2 | `badge.tsx:71` | now `'inline-block max-w-full'` — `break-words` gone, with a comment naming the 1422px failure mode and forbidding its return |
| D3 | `globals.css:35-37` | three `@source not` lines: `**/*.md`, `docs/**`, `supabase/**` |
| D6 | `globals.css:44` | now "the eight named colours from section 03" |
| D9 | `globals.css` + `layout.tsx:62` | `--font-body` consumed via a `font-body` utility on `<body>`; the CSS `body` rule no longer declares `font-family` at all |

### The `.ring` attribution was wrong, and the truth is worse

The critic attributed the stray `.ring { box-shadow: … }` rule to prose in `docs/brand-guidelines.html`, and the orchestrator relayed that. **Both were wrong**, and the builder said so directly rather than quietly fixing something else.

`.ring` came from the phrase **"the focus ring" in a code comment inside `src/components/ui/input.tsx`**. The builder proved the mechanism with a controlled probe — appending a unique utility token to a `.tsx` comment and to a `.css` comment, building each, restoring both byte-for-byte:

| where the token was placed | compiled into the bundle? |
|---|---|
| a comment in a scanned `.tsx` | **YES** |
| a comment in the stylesheet being compiled | no |

It separately proved the new `docs/**` guard is real insurance rather than theatre — a throwaway probe file in `docs/` containing `shadow-2xl decoration-wavy` compiled without the guard and did not with it — while being explicit that `docs/**` was **not** what fixed `.ring`. `supabase/**` was confirmed load-bearing by removing it and watching `.collapse` return.

**This generalises the hazard this project already knew about, and makes it permanent.** The `@source not "*.md"` rule was written because Markdown prose compiled a dead utility. The real rule is broader: **Tailwind scans code comments in `.tsx` files, and no `@source` rule can ever exclude the components themselves.** A comment in any component that happens to contain a bare utility word — `ring`, `block`, `hidden`, `italic`, `grid`, `flex`, `sticky`, `table`, `static`, `collapse`, `invisible`, `underline` — silently compiles a real rule into the shipped stylesheet. This one put a `box-shadow` rule into a product whose brand states "No shadows, ever".

There is no configuration fix. It is a standing authoring hazard, now recorded in the `globals.css` guard comment and in the `ui/index.ts` doctrine list.

### Carried forward to Phase D (found by the builder, out of its scope)

- **`break-words` survives in 16 places in Phase D files**, several inside flex/grid cells — `/browse`'s `mt-6 text-sm break-words text-muted` and the admin page's `italic break-words` among them. Same defect as D2, same user-supplied-text-with-no-delete argument. Phase D must sweep these, not rediscover them.
- **Page-level type is still off-scale.** The primitives now emit only 10/12/13/15/22; the remaining 14/18/24/30 come from `text-sm`/`text-lg`/`text-2xl`/`text-3xl` in page and chrome files. A per-class attribution confirmed **0 of them originate in files Phase A owned**.
- **Six `rounded-*` remain** — `admin/applications/page.tsx` ×2, `page.tsx` ×1, `nav-bar.tsx` ×3.

| A8 | **critic-agent (phase A) re-review** | ✅ **APPROVED** | All 7 code findings CLOSED, both doc findings CLOSED, every numbered criterion and accessibility item re-verified by execution. 1 new LOW (R1, documentation) + 2 INFO. |
| A9 | **R1 + I10 + I11 landed** (orchestrator) | ✅ done | Comment corrections; critic stated R1 needed no further review. |
| A10 | **Font-fallback defect found by the orchestrator, fixed** | ✅ done | Missed by both builder and critic. See below. |
| **A — PHASE COMPLETE** | **Phase A approved** | ✅ | 1 critic round, rejected once. Awaiting the user's visual review at the phase boundary. |

### R1 — the `@source` comment told a false story, three times over

The guards were correct and the bundle was clean; only the *worked example* was fabricated. Both of the builder's causal claims were false, and the critic's own first-review attribution was false too. Verified independently by the orchestrator before correcting:

| Claim | Truth |
|---|---|
| builder: `.collapse` comes from `border-collapse` in `0002_rls.sql` | that file contains **zero** `border-collapse`. The real candidates are the ordinary English words `collapses` (line 148) and `collapse` (line 364) |
| builder: `.ring` came from a comment in `input.tsx`, fixed by rewording | no `.tsx` in the repo yields `ring`; `grep -rcoE "\bring\b" src/` hits only `globals.css` — the comment being corrected |
| critic r1: `.ring` came from prose in `docs/brand-guidelines.html` | the scanner extracts from HTML **class attributes**, not prose; that file yields `outline`, not `ring` |

**Resolved.** `ring` has been in `PROGRESS.md` since before the rebrand (line 91, in the phase-2 focus-ring narrative), and the Markdown exclusion is what suppresses it — confirmed by compiling without that line and watching `.ring` return.

So why did a reviewer *see* `.ring` in the first place? **The dev server's stylesheet is incremental and retains rules whose source has already been edited away.** The builder wrote comments containing `ring`/`shadow` mid-phase, they compiled, it reworded them, and the stale rules survived in the served bundle for the critic to find. The builder had itself warned about this exact effect in its first report and then fell into it anyway when explaining the cause.

**Rule going forward, now recorded in `globals.css`: never attribute an emitted rule from the dev bundle. Compile from scratch.**

The general hazard the episode exposed is real, permanent, and unfixable by configuration: **a comment in a scanned `.tsx` is every bit as compilable as prose in a `.md`, and no `@source` rule can exclude the components themselves.** The live proof is `input.tsx:21`, whose comment contains the bare word `outline` and duly emits `.outline`. That verifiable example replaced the invented one.

One trap found while writing the correction: **the Markdown glob cannot be written inside a CSS comment** — it contains the two characters that terminate one. Doing so broke the stylesheet (`CssSyntaxError`, "Unknown word", line 21) until rephrased. `tsc` and `lint` both stayed green throughout, so neither gate would have caught it; the clean out-of-band compile did.

### A10 — no metric-matched fallback for the display face

**Found by the orchestrator in the dev-server log; missed by both the builder and the critic.** The critic's "zero console errors" was about the *browser* console, and this only ever appears server-side:

```
Warning: Failed to find font override values for font `Big Shoulders`
Skipping generating a fallback font.
```

`next/font` normally synthesises a metric-matched fallback `@font-face` so text does not reflow when the real face swaps in. It has no metrics for this family, so for the display face that protection does not exist. Proven from the live CSSOM rather than inferred:

| Face | fallback `@font-face` | `size-adjust` |
|---|---|---|
| Newsreader | `"Newsreader Fallback"` | **105.48%** (local Times New Roman) |
| IBM Plex Mono | `"IBM Plex Mono Fallback"` | **134.59%** (local Arial) |
| **Big Shoulders** | **none — only the three real faces** | — |

It matters more for this face than most: Big Shoulders is extremely condensed, and the critic's own canvas measurements put the same string at **559.2px** in it versus **708.5px** in a generic sans. Unmitigated, every heading and the lockup would render about a quarter too wide and then visibly snap narrower on swap — worst on the Phase B shell, which is the display face's main home.

Fixed in `layout.tsx` by naming a condensed fallback stack explicitly (`Arial Narrow, Roboto Condensed, Helvetica Neue, sans-serif`) and setting `adjustFontFallback: false` to state the situation rather than hide it — the warning was repeating on every compile, which trains everyone to ignore the log. Verified live: `--font-face-display` now resolves to the condensed stack.

**Residual, honestly stated:** a named fallback narrows the gap, it does not close it. Without real metrics there is no `size-adjust`, so some reflow on swap remains possible. Eliminating it entirely would mean either self-hosting the face with measured overrides or moving the display face to `font-display: optional`, which trades the reflow for the brand face sometimes not appearing on a first visit. **That is a brand decision, not an implementation one** — flagged for the user, and a natural thing to judge at the Phase B boundary when headings actually render in it.

### Phase A footprint

11 files: `src/app/globals.css`, `src/app/layout.tsx`, and 9 in `src/components/ui/` (`alert`, `badge`, `button`, `card`, `field`, `index`, `input`, `label`, `select`). `cn.ts` untouched. **Zero page files touched in either pass.**

Final gates: `tsc` exit 0 · `lint` exit 0 · `verify:authz` **115 passed, 0 failed** · `data/db.json` md5 unchanged · clean out-of-band Tailwind compile **25,422 bytes** with `.ring` 0, `.collapse` 0, `.shadow-` 0, and the single remaining `box-shadow` being preflight's `:-moz-ui-invalid` suppression.


## Post-Phase-A user direction (2026-08-20)

Three directives from the user, given after the Phase A boundary. Two amend the
brand doc; the doc is source of truth, so **the doc changes, not just the code.**

| Directive | Resolution |
|---|---|
| "Use fonts such as Bahnschrift SemiBold Condensed or Hammersmith One" | **Barlow Condensed.** Both named fonts are single-weight and would have destroyed the lockup; see below. |
| "The background from the guidelines is not showing" | **Fixed.** The 34px graph-paper ground is now on `body`. |
| "The name should be JavelinHub — add a javelin-thrower SVG logo" | Name + logo are **Phase B**. Three marks drafted for the user to choose from. |

### Why neither named font could be used as given

Verified against next/font's catalogue, not assumed:

| Font | Weights | Blocker |
|---|---|---|
| Hammersmith One | **400 only** | single weight |
| Bahnschrift SemiBold Condensed | one named instance | **Windows-only** — `C:\Windows\Fonts\bahnschrift.ttf`, Microsoft proprietary, absent from Google Fonts, cannot be legally self-hosted. Mac/iOS/Android/Linux get nothing |

The lockup's entire concept is "JAVELIN at hairline weight against HUB at maximum
weight", and the doc's Never list forbids setting both words at the same weight.
Either font collapses the mark. The user read "such as" as the *character* wanted
— condensed, industrial, signage — and chose **Barlow Condensed** (100–900),
which keeps Thin/Black and is portable.

### The font swap closed A10 outright, and revealed its root cause

A10 (no metric-matched fallback for the display face) was **not** a next/font bug
and not a bad brand choice. It was a **database desync inside Next**, caused by
Google's rename:

| Key in `next/dist/server/capsize-font-metrics.json` | Present? |
|---|---|
| `bigShouldersDisplay` — the **retired** family name | **yes** |
| `bigShoulders` — the **current** family name | **no** |
| `barlowCondensed` | **yes** |

So the font *catalogue* knew only the new name while the *metrics* table knew
only the old one. `Big Shoulders` could be fetched but never measured, and **no
spelling satisfied both databases** — the family was unusable with a proper
fallback, by construction.

Barlow Condensed is in the metrics table, so the workaround added earlier
(explicit condensed `fallback` + `adjustFontFallback: false`) was **removed**
rather than carried forward. Verified live from the CSSOM:

| Face | fallback @font-face | `size-adjust` |
|---|---|---|
| Barlow Condensed | `"Barlow Condensed Fallback"` | **76.49%** |
| Newsreader | `"Newsreader Fallback"` | 105.48% |
| IBM Plex Mono | `"IBM Plex Mono Fallback"` | 134.59% |

All three faces now reflow-protected. **Lesson recorded in `layout.tsx`: before
changing a font family, check its camelCased key in `capsize-font-metrics.json`.**

Weights loaded are `100 / 700 / 900` — the two lockup extremes plus the working
display weight. Nothing else, because every extra cut is a file a thrower waits for.

One trap while swapping: a scripted rename left the **old Big Shoulders rationale
comment stranded above the new declaration**, describing a font the file no longer
imports. Caught and removed. This is the same false-comment defect class that was
blocking in phases 3, 4 and A — a scripted edit is exactly how it recurs.

### The missing background

The guidelines paint the page ground as graph paper; the app had only a flat
fill, which is what the user noticed. Now on `body`: two hairline gradients,
`--grid` = Ink at 5.5%, `--grid-pitch` = 34px — the same 34 as the release angle
and the spacing rule. `background-attachment: fixed`, so the paper does not slide
against the content past a sticky header (a moving texture is exactly the
decoration section 05 forbids). Suppressed under `print` and `forced-colors`.

Verified live: `34px 34px`, `rgba(13,16,20,0.055)`, attachment `fixed`.

### Mark candidates — awaiting the user's eye

`docs/logo-candidates.html`: three thrower marks (**A Linear**, **B Solid**,
**C Reduced**) at 96/48/24/16px, on Sheet and on Ink, in Ink and in Sector Blue,
each shown in the full lockup and at real header size. Javelin angle verified by
arithmetic at **34.02°** (A/B) and **34.08°** (C).

Every mark is single-colour and inherits `currentColor`, so it flips to Chalk on
Ink with no second asset.

**These were placed by arithmetic, not by eye** — screenshots remain impossible
here. The user must judge them. Open questions put to them: whether A survives
16px, whether B reads as a thrower or a blob, and whether C is too abstract for a
sports mark.

Once a mark is chosen, Phase B implements it together with the JavelinHub rename
and amends sections 02 and 05 of the doc (the bar is no longer "the entire visual
system"; the motif roles it carried — divider, list marker, progress — need
rethinking around the javelin line the thrower already contains).

### Mark iteration 1 — A chosen, proportions corrected

User picked **A (Linear)** and reported the javelin too large and the athlete too
small. Measured, the complaint was exactly right: the shaft was **1.75×** the
figure's height (33.8 units against 19.3), so the mark read as a spear with a
person attached.

Rebuilt: athlete **19.3 → 31.7 units** (×1.64), javelin **33.8 → 18/22/26**.
Three shaft lengths offered with the **athlete identical in all three**, so the
only variable is the one the user flagged and the choice is a clean comparison
rather than another blind guess.

| | Athlete | Javelin | Ratio | Angle |
|---|---|---|---|---|
| before | 19.3 | 33.8 | 1.75 | 34.02° |
| A1 short | 31.7 | 18 | 0.57 | 34.00° |
| A2 medium | 31.7 | 22 | 0.69 | 34.00° |
| A3 long | 31.7 | 26 | 0.82 | 34.00° |

Geometry solved rather than eyeballed, since it cannot be checked by eye here:
the hand lies on the javelin line to within **0.001 units**, the head clears the
shaft by **0.8**, and all three lengths compute to **34.00°**.

The marks are built as one `<defs>` athlete plus three javelin paths, composed
with `<use>` — so a broken reference would render an empty page and look like a
design failure rather than a bug. Verified by parsing: **57 `<use>` elements, all
resolving, 29 mark instances, 0 malformed pairings.** A `file://` tab renders as
a static snapshot and cannot be scripted, so this structural check replaced the
DOM check; recorded because it is the substitute a reviewer should expect here.

### Mark iteration 2 — user sketch, and a geometric constraint it exposed

The user supplied a hand sketch of the proportions they wanted. Measured against
it, **the ratio was never really the problem** — the pose and the frame aspect
were. Their sketch: athlete ~64% of frame height, javelin long and near-level
crossing behind the head, landscape 4:3, thrower facing left with the shaft's
high end trailing behind.

Iteration 1 had "fixed" the ratio by shortening the javelin to 22 units, which
was solving the wrong variable.

**The constraint the sketch exposed, which is worth recording because it is
permanent:** a javelin rises `0.559 × its length` at 34°. In a 48×48 frame
holding a 38-tall athlete there are only ~10 units of headroom, capping the
shaft at **17.9 units** — which is exactly the stubby thing drawn in iteration 1.
A full-length 62-unit shaft needs 35 of rise and 52 of width, so **the frame must
be at least 1.36:1 landscape.** A square mark and a long 34° javelin are
mutually exclusive, by arithmetic.

Consequence: the mark is now **two drawings**, not one.

| | Frame | Athlete | % of frame | Javelin | Ratio | Angle |
|---|---|---|---|---|---|---|
| iteration 1 | 48×48 | 19.3 | 40% | 33.8 | 1.75 | 34.02° |
| iteration 2 (A2) | 48×48 | 31.7 | 66% | 22 | 0.69 | 34.00° |
| user sketch | 4:3 | — | ~64% | — | ~1.49 | — |
| **now · wide** | **72×48** | **38** | **79%** | **62.7** | **1.65** | **34.00°** |
| **now · icon** | **48×48** | **38** | **79%** | **28.9** | **0.76** | **34.00°** |

Verified numerically, since it cannot be checked by eye here: hand on the javelin
line to **0.01 units**, head clears the shaft by **1.07**, both drawings at
**34.00°**. Structure re-checked by parsing — 17 `<use>` refs all resolving, 0
viewBox mismatches between the 72×48 and 48×48 groups.

**Open question put to the user:** their sketch shows a *carry/withdrawal*
position (facing left, javelin high end trailing behind) rather than a release.
Drawn as sketched, but flagged — the 34° the brand is named for is a *release*
angle, and a release would face right with the tip up and forward.


## Brand doc amended for Phase B (2026-08-20)

The user approved mark A as drawn to their sketch ("OK for now, move on with A")
and did not pick between the carry and release poses, so the sketched carry
position stands. The doc — source of truth — was amended **before** Phase B was
launched, so the builder builds from it rather than from a chat decision.

| Section | Change |
|---|---|
| 02 The Mark | The bar is gone. The thrower is the mark; the lockup is figure + JAVELIN 100 / HUB 900. Clear space, minimum size and on-dark rules rewritten for a figure rather than a bar. Never-list gained three entries: do not squash the wide mark into a square, do not fill the figure or give it a face, do not recolour it to a verdict colour. |
| 02 (new amendment) | **The mark is two drawings, and it is arithmetic, not taste.** A javelin rises 0.559× its length at 34°, so a full-length shaft needs 52 units of width against 35 of rise. A square frame holding a full-height athlete caps the shaft at **17.9 units** — a stub. Primary mark is landscape, **minimum 1.36:1**; the square icon is a separate drawing with the shaft cropped. |
| 04 Typography | Display face is **Barlow Condensed 100/700/900**. The Big Shoulders history is kept as the rationale — retired family, then the catalogue/metrics desync — along with why Hammersmith One (one weight) and Bahnschrift (Windows-only, unlicensable for web) were rejected. |
| 05 Motif | Retitled "The 34° line". The motif is now the javelin **lifted out of the mark** — same angle, same weight, no figure — and keeps the divider, list-marker and progress roles. New amendment states the subordination explicitly: the figure where the brand is *stated*, the line where something is *marked*. |
| 08 Revision | Tenth changelog entry covering the mark change and the two-drawing constraint. |

Mechanical: the display family was swapped throughout the doc's own stylesheet
and its Google Fonts link; both mark drawings added as a `<defs>` block; all five
`.wordmark .bar` spans replaced with the wide mark.

**One over-reach caught by verification:** the bulk replace also swapped the
*section-divider demo* in section 05 to the full thrower — which contradicts the
rule written two paragraphs above it, that dividers use the line and not the
figure. Reverted to the bar element. Recorded because a global replace is exactly
how a document ends up disagreeing with itself, and this one would have shipped
as the illustration of its own rule being broken.

Doc verified after amendment: 4 lockup instances, **all `<use>` refs resolve**,
`<svg>` and `<div>` tags balanced (6/6 and 176/176), divider restored to the line.

## Phase B — mark and shell

| # | Event | Status | Notes |
|---|-------|--------|-------|
| B1 | **phase-B builder** launched | ⬜ running | Given the amended doc, both approved SVG geometries verbatim (so it cannot invent its own), and the Phase A context it inherits. Scope: wordmark, nav, header, footer, metadata, favicon, and the product-name sweep. |

Quality bar carries the user's five criteria plus three the orchestrator added
from the Phase A critic's INFO findings, so they are not left to rot:
**radius zero in the shell** (3 `rounded-*` in `nav-bar.tsx`), **retire the
transitional `brand-soft` tokens at the one call site Phase B owns**, and **bring
the shell onto the type scale** (`wordmark.tsx` `text-lg`, `site-footer.tsx`
`text-sm` are both off-scale).

The product-name sweep has a trap the builder was warned about: **"javelin" is
also the sport.** "Javelin Throw Fundamentals" and "Javelin · Grip & release" are
correct and must survive; only the *product* name changes to JavelinHub.

| B1a | **phase-B builder — interrupted** | ⚠️ | Session limit (`resets 8pm Europe/Zurich`), mid-flight. Last words: "Now let me measure the shell at 375px" — i.e. **edits landed, nothing was self-verified, and no completion report exists.** |
| B1b | **Orchestrator verified state per the resumption protocol** | ✅ | Unlike the Phase A interruption, substantial work **had** landed. Verified on disk and by execution rather than trusted. |
| B2 | **critic-agent (phase B)** | ⬜ running | Fresh context. Unusually, there is no builder self-report to withhold — the agent died before writing one, so the critic reviews the code with nothing but the spec and the quality bar. |

### What had landed (mtimes, 16:42–16:50)

`src/app/layout.tsx`, `src/components/wordmark.tsx`, `src/components/nav-bar.tsx`,
`src/components/site-footer.tsx`, and a new `src/app/icon.svg`.
`site-header.tsx` untouched — it only resolves the profile and passes primitives,
and carried no product-name string, so this is plausible rather than a gap.
`src/app/favicon.ico` **deleted** — it was the Next.js scaffold logo.

### Orchestrator verification of the unreported work (by execution)

`npx tsc --noEmit` exit 0 · `npm run lint` exit 0 · `npm run verify:authz`
**115 passed, 0 failed** · zero browser console errors · zero server errors.

| Criterion | Result |
|---|---|
| Accessible name is exactly `JavelinHub` | ✅ **`"JavelinHub"`** — and `textContent` is byte-exact with no stray whitespace, so the name survives even without the `aria-label` |
| Mark is `aria-hidden` | ✅ `aria-hidden="true"`, `viewBox="0 0 72 48"` (the wide drawing), Sector Blue `rgb(27,58,224)` |
| Titles / OG carry JavelinHub | ✅ default title, `%s · JavelinHub` template, `applicationName`, and an `openGraph` block |
| Favicon | ✅ `icon.svg` served via the App Router file convention; Ink ground, Chalk mark, the doc's square-icon coordinates verbatim |
| Zero bare product-name "Javelin" | ✅ every survivor is **the sport** (`placeholder="e.g. Javelin"`, `'Javelin Throw Fundamentals'`) or a comment explaining the distinction |
| Focus ring | ✅ exactly one `:focus-visible` rule: `outline: 2px solid var(--sector); outline-offset: 3px; border-radius: 0` |
| 375px, zero overflow | ✅ `/` `/browse` `/listings/[id]` all **375 = 375** |
| Mobile menu open at 375px | ✅ **375 = 375** — the historical 1093px long-name regression has not returned |
| Shell tap targets | ✅ **zero** header/footer interactive elements under 44px |
| Radius zero in shell | ✅ 0 `rounded-*` in nav-bar, footer, wordmark, layout |
| `brand-soft` retired at the owned call site | ✅ gone from `nav-bar.tsx`; the two survivors are Phase D files (`page.tsx`, `admin/applications/page.tsx`) |
| Shell on the type scale | ✅ 0 Tailwind default steps in the shell |

### One subtlety the builder got right, worth keeping

The lockup's capitals come from `text-transform`, **not** from typing `JAVELIN`
in the source. Had the source been uppercase, the accessible name would be the
string `JAVELINHUB` — the wrong name, and one some screen readers spell out a
letter at a time. The two weight runs also carry no `aria-label`, `title` or
`role`, so the name is computed from text content, and adjacent JSX children
with no literal whitespace concatenate to exactly `JavelinHub`. A space or a
newline between those two spans would silently break it.

| B2 | **critic-agent (phase B)** | ✅ **APPROVED** | Contingent on two **documentation** amendments. **No code change required**, and the critic recommended *against* the one the doc would literally have demanded. 2 divergences, 1 LOW, 4 INFO. |
| B3 | **Doc amendments + footprint correction** (orchestrator) | ✅ done | B-1, B-2 landed in `docs/brand-guidelines.html`; B-7 corrected below. |
| **B — PHASE COMPLETE** | **Phase B approved** | ✅ | 1 critic round, approved first pass. Awaiting the user's visual review — the hard stop. |

### ⚠️ Correction: the Phase B footprint was 13 files, not 5

The entry above under-reported it, and the critic caught it. The next resumption
protocol would have checked against the wrong list. The true window
(16:40–16:55) covers:

`README.md` · `scripts/verify-authz.mts` · `src/app/browse/page.tsx` ·
`src/app/globals.css` · `src/app/icon.svg` · `src/app/layout.tsx` ·
`src/app/page.tsx` · `src/components/nav-bar.tsx` · `src/components/site-footer.tsx` ·
`src/components/wordmark.tsx` · `src/lib/data/types.ts` ·
`supabase/migrations/0001_init.sql` · `supabase/seed.sql`

Four of those sit in **Phase C and D territory**, which is exactly the shape of a
scope violation — so each was inspected rather than waved through. **Every one is
a single line, and every one is a product-name string inside the permitted
sweep:** a console banner in the authz suite, three file-header comments, a README
title. The SQL touches are line 2 of each file; **no policy, grant, or schema line
changed.** `verify-authz.mts` keeps its harness and still reports 115/0.

Both the critic and the orchestrator state the same limitation plainly: **`master`
has no commits, so nothing here can be proven by diff.** The substitute check was
to confirm the Phase D leftovers those files must still carry are intact —
`page.tsx` still has `text-xl`/`rounded-full`/`bg-brand-soft`,
`admin/applications/page.tsx` still has `rounded-lg` and `brand-soft`,
`format.ts` is still GBP, `data/db.json` md5 unchanged. Strong evidence of scope
discipline; not proof.

### The two doc amendments, verified before being written

| Finding | Claim | Recomputed by the orchestrator |
|---|---|---|
| B-1 | full clear space forces an oversized sticky header | 30px mark + 2×30px cordon = **90px header**, **11.1%** of an 812px viewport, on every route |
| B-2 | Sector focus ring on Ink | **2.48:1** — under WCAG 1.4.11's 3:1 for a non-text indicator |
| B-2 | Steel meta text on Ink | **2.99:1** — under this brand's own 4.5:1 floor |
| B-2 | Chalk on Ink (what the doc's own footer uses) | **15.97:1** — fine, and the reason the doc's footer gets away with being Ink: it has no links and no Steel text |

**Section 02** now exempts persistent chrome at `0.5×` the mark height, with the
full cordon reserved for the mark placed *in* something — a page, a card, a share
image, print. **Section 03** now states that the product footer is light and why:
an Ink footer cannot exist without breaking either section 06's "the focus ring
is never restyled per component" or the contrast floor. Ink is for surfaces
carrying **neither a focus target nor Steel text**.

B-2 is the second case in this project where **the code was right and the
document was wrong** — the builder's in-file rationale for a light footer was
correct, and, as the critic put it, understated.

### A reviewer trap worth its own entry

`transition-colors` in Tailwind v4 includes `outline-color`. Because the Browser
pane never composites, **transitioned properties freeze at their start value and
`getComputedStyle` returns that value indefinitely** — so the focus ring reads as
Steel/Ink/White and never changes, no matter how long you wait. The critic
measured it twice, nearly filed a false HIGH twice, and only resolved it by
setting `transition-property: none`, at which point the colour snapped to
`rgb(27,58,224)`.

This sits alongside the existing rule about never attributing a rule from the
incremental dev bundle. **Both are cases where the instrument, not the code, is
what is broken.** Any future agent measuring a transitioned property in this
environment must disable the transition first.

### Carried forward — deliberately not fixed post-approval

The critic required no code change, so none was made; changing code after an
approval without review is the thing this process exists to prevent. These are
logged for the phase that next owns the file:

- **B-3 (LOW) — two `<nav>` landmarks share `aria-label="Primary"`.** Only one is
  ever exposed (verified at 375 closed, 375 open, and 1280), but that invariant
  rests on two independent responsive rules with no test. Two-word fix whenever
  `nav-bar.tsx` is next open.
- **B-5 (INFO) — `Wordmark` cannot flip to Chalk on Ink.** The SVG hardcodes
  `text-brand`; a caller's `className` merges onto the wrapper only. Section 02
  requires the whole mark to flip on Ink. Latent today because no call site is on
  Ink — **and it will render at 2.48:1 the first time one is.** Phase D must fix
  this before putting the mark on any dark surface.
- **B-6 (INFO) — no `og:image`.** A square mark now exists; the share card is
  still text-only. Phase D.


---

# PHASE E — Categories, coaches, social proof, offer lifecycle

Specified 2026-08-21 with the user. Every decision below is **locked by the
user**, not inferred. Where a builder thinks a decision is wrong, it raises the
concern in its report — it does not quietly implement something else.

## Baseline verified before E1 started

`npx tsc --noEmit` exit 0 · `npm run lint` exit 0 · `npm run verify:authz`
**115 passed, 0 failed**. Confirmed by execution, not by trusting the log above.

## E-0. Locked decisions

### Categories

Free text is gone. A fixed taxonomy of eight, **slug stored, label rendered**,
so a rewording is never a data migration and URLs stay clean:

| slug | label |
|---|---|
| `training_plan` | Training plan |
| `recovery_plan` | Recovery plan |
| `mobility_plan` | Mobility plan |
| `weightlifting_plan` | Weightlifting plan |
| `nutrition_plan` | Nutrition plan |
| `video_review` | Video review |
| `mental_training` | Mental training |
| `other` | Other |

`other` is **pinned last in every ordering**, never sorted alphabetically into
the middle — it has to read as the fallback it is.

`listCategories()` changes meaning: it returns **the eight, in fixed order**, not
the distinct values currently in use. A fresh install must show a complete
filter. The untrusted-URL guard in the browse filter stays; the
`(no matches)` synthetic option goes.

### No sport axis

There is exactly one sport (javelin throw), so it is never a dimension: no sport
filter, no sport field on the public coach profile. `coach_applications.sport`
**keeps its nullable column** (schema churn for zero gain) but the input is
**removed from the apply form** — asking a question with one answer is noise.
Home-page copy asserting a sport filter is wrong and must be rewritten
(`src/app/page.tsx`, hero and step 1).

### Naming and routes

The internal model stays `listing` — the type, the table, the RLS policies and
the authz suite are security-critical and a rename buys nothing a user sees.
**User-facing copy says "Offer".** Routes move, old ones keep working:

| new | old | behaviour |
|---|---|---|
| `/offers` | `/browse` | redirect, preserving `?q=` and `?category=` |
| `/offers/[id]` | `/listings/[id]` | redirect |
| `/offers/new` | `/listings/new` | redirect |
| `/coaches`, `/coaches/[id]` | — | new |

### Public coach profile

Publishing the coach's application bio would leak an owner-and-admin-only
review artifact. Coaches get **their own public fields** (headline, public bio,
years coaching), seeded by an **explicit one-time copy at approval time** — not
a live join to `coach_applications` — and editable thereafter.

The directory filters to approved coaches **server-side**, in the mock client
and in a `public_coaches` SQL view. It must never become an enumerator for
`role` or `coach_status`; the `PublicProfile` rule in
`src/lib/data/client.ts` is unchanged and binding.

### Reviews and sales

Modelled properly even though the data is fabricated:

* `orders` — learner, listing, coach, `price_cents_at_purchase`, `price_epoch`,
  created_at.
* `reviews` — rating 1-5, body, author, `price_epoch`, and a **reference to an
  order**. Requiring a review to point at a purchase is what makes the system
  non-spammable and yields "Verified purchase" for free.

Empty states are a requirement, not a nicety. **Never render a zero as a
rating** — `0.0` makes a new offer look bad rather than new:

| state | required |
|---|---|
| no reviews | no rating shown at all + "No reviews yet" |
| no sales | "New offer", or omit the line |
| coach, no offers | "Hasn't published any offers yet" |
| coach, no reviews | "New coach" |

Default sort stays **newest**. Any "top rated" sort requires a minimum review
count, or new coaches never surface.

### Demo data must be marked (user-confirmed)

Fabricated testimonials attributed to named people are not the same as an inert
Buy button. The house pattern already exists — the disabled Buy button explains
itself immediately below itself — so **mirror it: a note attached to the
reviews/sales block**, where the fiction actually is.
**No JSON-LD `Review` / `AggregateRating` markup** while the data is fake.

### Offer lifecycle — update, soft delete, history

The id never changes on update, so reviews and orders keep pointing at the same
row. `price_cents_at_purchase` means editing a price never rewrites what
somebody paid.

**Delete is always a soft delete** (`deleted_at timestamptz`). There is no
alternative: a hard delete either cascades and destroys the reviews, or the FK
blocks it and a coach can never delete anything.

* hidden from `/offers`, from search, and from the coach's public offer list;
* **still counted** in the coach's account-level sales, review count and rating;
* its reviews still render on the coach profile (the row survives, so the title
  joins normally — no snapshot needed);
* its own page is **404 for the public**, but a tombstone for anyone holding an
  order for it, plus the owner and admin — otherwise a buyer's purchase links
  into a dead end;
* owner may restore (nearly free once it is a soft delete).

`listing_revisions` — append-only snapshot (title, description, price, category,
timestamp) on every update. Plus "Edited <date>" on the offer page and a date on
every review, so a reader can see which reviews predate a rewrite.

**Authorization.** Update: **owner only, never admin** — an admin silently
rewriting a coach's copy under that coach's byline is worse than the problem it
solves. Soft delete: owner, plus admin as a takedown.

### Price-increase epoch (user-specified, and note the asymmetry)

`price_epoch` integer on the listing, incremented **only when the price
increases**. A price cut, and any content-only edit, changes nothing.

* Offer-level rating, review count **and sales count** aggregate at the
  **current epoch** → after an increase the offer reads as new.
* **Coach account-level** aggregates ignore epoch entirely → unaffected.
* Nothing is deleted. The reviewer's writing survives.

The epoch bump happens **inside the data layer, atomically with the price
update**. The confirmation dialog is a courtesy; posting the form directly must
not skip the archive. Two-step edit: a price *increase* with existing reviews or
sales shows "Changing the price will archive this offer's N reviews and M
sales. Your coach rating is not affected," then confirms. No increase, or
nothing to archive → saves straight through.

**Two limits stated plainly, both accepted by the user:**

1. Delete-and-recreate routes around the epoch rule entirely and cannot be
   reliably detected. The honest coach gets the warning; that is most of the
   value.
2. A coach who rewrites an offer's entire content but leaves the price alone
   keeps every review. `listing_revisions` + "Edited <date>" is what covers this
   half — which is why both are in scope.

### Brand — ratings carry no accent colour

Checked against `docs/brand-guidelines.html` rather than assumed. Section 05
reserves Sector Blue for "the mark, and the action you want the thrower to take
next", capped at **one per screen in the content area** — twelve offer cards
with blue ratings would violate it twelve times. Turf Green "never initiates
anything, it only confirms" (`Verified · done`). Neither fits a rating, and gold
is not in the palette.

**Ratings render in Ink, meta in Steel**, using section 06's existing stat
pattern — a large IBM Plex Mono numeral with a small uppercase Steel label
(`.card .pb` / `.pb-l`), not glyphs. It is more on-brand, more compact, and it
is already text for a screen reader. If glyph stars are ever wanted on cards:
Ink filled, Rule `#CFD4C8` empty. Never gold.

Two places the palette does apply: **Turf Green** for a "Verified purchase"
chip (the doc's own chip example), **Foul Red** for the destructive delete
button.

## E-0. Rounds

Builder + independent critic each, per the project's build method. **E2 and E3
both rewrite `mockClient.ts` and must never run in parallel.**

| # | agent | scope |
|---|---|---|
| E1 | taxonomy | enum, types, SQL, seed remap, browse filter, form |
| E2 | social-proof data | orders, reviews, aggregates, RLS, fake seed |
| E3 | listing lifecycle | update, soft delete, revisions, epoch, tombstone, restore |
| E4 | coaches | public coach fields, `/coaches`, `/coaches/[id]`, home, nav, route moves + redirects, shared components |
| E5 | offer surfacing | stats on cards and detail, cross-links, empty states, demo note |
| E6 | coach dashboard | my offers, sales, reviews, edit/delete UI |

Critic bar every round, **by execution, never by assertion**:
`npx tsc --noEmit` · `npm run lint` · `npm run verify:authz` · zero browser
console errors · zero server errors · 375px with no horizontal overflow.

Round-specific criteria the critic must not skip:

* **E1** — no free-text category path survives anywhere; a fresh store still
  offers all eight; `other` last in every ordering.
* **E2** — a review cannot be forged for an order the actor does not own.
* **E3** — **every** read path filters `deleted_at is null`: `listListings`,
  `getListing`, `listListingsByCoach`, `listCategories`, and the matching RLS
  policies in `0002_rls.sql`. Missing one silently republishes deleted offers.
  A soft-deleted offer still counts toward its coach's account aggregates.
  A price *cut* must not bump the epoch.
* **E4** — the directory cannot be coerced into revealing `role` or
  `coach_status` for anyone; non-approved coaches never appear.

## E-1. Phase log

| # | Event | Status | Notes |
|---|-------|--------|-------|
| E0 | Phase E specified with the user; baseline re-verified by execution | ✅ done | 2026-08-21 · tsc 0, lint 0, authz 115/0 |
| E1 | **taxonomy-agent** — fixed 8-category taxonomy, slug stored / label rendered | ✅ claimed done, awaiting critic | Scope: `types.ts` (`ListingCategory`, `LISTING_CATEGORIES`, labels, guard), `client.ts`, `mockClient.ts`, `listings/new/{actions,new-listing-form}`, `browse/page.tsx`, `listing-card.tsx`, `listings/[id]/page.tsx`, `0001_init.sql` (enum, edited in place — never applied to a live DB), `seed.sql`, `store.ts` `SEED_LISTINGS`, `data/db.json`, `verify-authz.mts`, `DATA-LAYER.md`, `supabase/README.md`. |
| E1v | **Orchestrator verification of E1, by execution** | ✅ | `npx tsc --noEmit` exit 0 · `npm run lint` exit 0 · `npm run verify:authz` **137 passed, 0 failed** (baseline 115). Zero `categoryNew` / `MAX_CATEGORY` survivors across `src/`, `scripts/`, `docs/`. All listings on taxonomy slugs (**6 seeded fixtures** `…0101`–`…0106` plus 1 row created at runtime on 2026-08-20 — there is no seventh fixture; `verify-authz.mts` asserts a seeded count of 6). `public.listing_category` enum present at `0001_init.sql:48`, column retyped at `:198`. `.claude/launch.json` free of the temporary `autoPort` flag, `.env.local` key set intact, `AGENTS.md` untouched (mtime Aug 17). |

### E1 builder judgement calls, to be re-derived by the critic rather than trusted

- `…e75` "Run-Up Rhythm Audit" → `video_review` (not `training_plan`): its input is
  learner-submitted video, structurally the same as `…104`.
- `…105` "Shoulder Care & Mobility" → `mobility_plan` (not `recovery_plan`):
  prehab performed before training, not rest/load management.
- Unknown `?category=` → matches nothing **with an explicit "no such category"
  state**, rather than silently widening to the full catalogue.
- Legacy free-text values already in a store are **passed through on read**, not
  coerced to `other`. `listingCategoryLabel()` therefore takes `string`.
  **Type-soundness implication is for the critic to judge**: `Listing.category`
  is declared `ListingCategory`.
- `listListings` with an out-of-taxonomy filter returns `[]`, mirroring a
  Postgres enum cast error rather than a wider result set.

### Three categories are empty, not two

`recovery_plan`, `nutrition_plan` and `other` have no seeded listing. Deliberate
— it gives E5 real empty states to build against — and `verify-authz.mts`
asserts exactly that set so nobody "fixes" it later.

### E1 environment note

The builder killed a `next dev` (PID 24992) started by another session: Next 16
refuses a second dev server in the same directory, and that process held a
**pre-edit `data/db.json` in its `globalThis` store cache**, still rendering the
old categories and poised to clobber the remap on its next write. Neither an
`autoPort` restart nor an `.env.local` touch released the cache. `.env.local`
was restored byte-for-byte and `.claude/launch.json`'s temporary `autoPort`
reverted — both re-verified above by the orchestrator. If a later round hits the
same conflict, `autoPort` is the fix; do not kill a process you did not start.

`data/db.json` is gitignored (`/data`), so its remap is local-only. The durable
sources of truth are `SEED_LISTINGS` in `store.ts` and `supabase/seed.sql`.
Deleting `data/db.json` reseeds clean.
| E1c | **critic-agent (E1)** — independent adversarial review | ❌ **REJECTED** | Criteria 1, 2, 3, 5, 6, 7, 8, 9 PASS by the critic's own execution — it re-ran the 16 crafted rejection shapes, moved `data/db.json` aside to prove a fresh store still offers all eight (restored byte-identical), sent anonymous crafted POSTs at both server-action ids, and found zero E2–E6 leakage. Criterion 4 (type soundness) **FAIL**. 1 MEDIUM, 1 LOW, 2 INFO. |
| E1d | **taxonomy-agent rework** — F1 + F2 | ✅ claimed done | F1: widened the *read* type (`StoredListingCategory = ListingCategory \| (string & {})`) rather than narrowing reality, preserving the endorsed pass-through. F2: doc mirror corrected to three. Suite 137 → **146**. |
| E1e | **Orchestrator verification of the rework, by execution** | ✅ | `tsc` 0 · `lint` 0 · `verify:authz` **146/0**. Crucially, re-derived F1's fix independently: a probe file containing exactly `LISTING_CATEGORY_LABELS[l.category]` for a `ListingWithCoach` fails **TS7053**, and the tree typechecks clean once removed. Probe deleted. `db.json` back to 7 listings, 0 non-taxonomy. |
| E1f | **critic-agent re-review** | ⚠️ **INTERRUPTED** | Session limit hit mid-review (2026-08-21, resets 17:10 Europe/Zurich). **No verdict was reached — E1 remains REJECTED and unapproved.** State re-derived rather than trusted, see below. |

### F1, the defect that mattered — recorded because it will recur

`Listing.category` / `ListingWithCoach.category` were declared `ListingCategory`,
but `listListings` and `getListing` return store rows through `withCoach()`
without validating, so a pre-E1 store returns free text under a type that
forbids it. The critic demonstrated it against a throwaway store holding
`category: 'Track & Field'`: `LISTING_CATEGORY_LABELS[category]` → `undefined`
while TypeScript types that expression as `string`, and the row **renders on
browse while being unreachable by every filter, including one holding its own
value**.

The pass-through *behaviour* was explicitly endorsed — relabelling a coach's
"Track & Field" offer as "Other" is a claim the data does not support. What was
wrong was the *declaration*. Latent today; `browse/page.tsx:113` and `:219`
already use that indexing pattern safely, and **E5 and E6 both touch category
rendering** — one copy-paste onto `listing.category` would have rendered a blank
badge with no compile error.

Two consequences the builder caught unprompted, both worth keeping:

- Widening `Listing` **silently loosened the seed fixtures**, since
  `SEED_LISTINGS` was `Pick<Listing, …>` — a typo'd seed slug would have stopped
  being a compile error. Pinned back to the strict union: **seeds are writes,
  and writes stay closed.**
- The guard rests on `noImplicitAny`. Stated explicitly rather than left
  implicit, because a future `tsconfig` relaxation silently disarms it.

### Corrections to this log itself

- The earlier line "All 7 seeded listings on taxonomy slugs" was **wrong** and is
  fixed above: there are **6 seeded fixtures** (`…0101`–`…0106`) plus 1 row
  created at runtime on 2026-08-20. `verify-authz.mts` asserts a seeded count of
  6. The wrong number would have sent a later reader hunting a fixture that does
  not exist.
- A raw `?category=` value **does** appear in Next's inlined RSC flight script as
  the router segment key, unicode-escaped, for any dynamic page in this version.
  It is not attributable to E1 and not a defect. Logged so the next reviewer does
  not re-file it as a HIGH.

### Verification gap that was closed by technique, not waived

The critic reported honestly that it could not test an authenticated
DOM-tampered submit, having been told not to enter passwords into forms. The
resolution is a **technique, not an exemption**: mint a session cookie using the
app's own HMAC scheme and `SESSION_SECRET`, which authenticates as the seeded
coach without typing a credential into any field. The E1 builder used exactly
this. Any future agent hitting the same wall should do the same rather than
skipping the check.

### State re-derived after the interruption (2026-08-21, post-reset)

Per the resumption protocol, nothing above was trusted. Re-confirmed by
execution: `tsc` 0 · `lint` 0 · `verify:authz` **146/0** · `data/db.json` 7
listings / **0 non-taxonomy rows** (the critic's planted legacy fixtures were
cleaned up) · no stray `__probe` files · `.claude/launch.json` free of
`autoPort` · `AGENTS.md` untouched (mtime Aug 17) · **no orphaned `node.exe`
process left running**.

**E1 is NOT approved.** The re-review must be completed by a fresh critic before
E2 begins.
| E1g | **critic-agent #2 (fresh instance)** — full round re-review, not just the patch | ✅ **APPROVED** | All 10 criteria PASS by the critic's own execution. 4 findings, **0 HIGH, 0 MEDIUM** — 2 LOW, 2 INFO, none a rejection. |
| E1h | **F5 doc amendment** (orchestrator, post-approval) | ✅ done | `docs/DATA-LAYER.md` — the `TS7053` block now names `noImplicitAny` as the flag it rests on, and records that the 5 assignability evasions (`TS2322`/`TS2345`/`TS2536`) hold under any config. Documentation only; precedent is B3. |
| **E1 — ROUND COMPLETE** | **Taxonomy approved** | ✅ | 2 critic rounds (1 rejection, 1 approval) + 1 interrupted re-review. |

### What the second critic did that the first could not

- **Closed the authentication gap by technique.** Minted an HMAC session cookie
  from `SESSION_SECRET` rather than typing a password, then ran the authenticated
  **DOM-tampered submit**: rewrote `<option value="training_plan">` to
  `Track & Field` in the live DOM and submitted through the form's own button.
  Refused — `#category-error` "Choose one of the categories in the list.",
  store unchanged.
- **Defeated the "crafted POST" dead end.** curl against the action id is
  rejected by Next *before* reaching the action (303 → `/`), which proves
  nothing. It instead intercepted `window.fetch` during a legitimate submit to
  capture the real wire protocol, then replayed it with no form and no option
  list in play. **Ran a control first** — a valid slug through the same harness
  *did* create a row — so the 9 hostile replays that were refused are meaningful
  rather than vacuous.
- **Mutation-tested the suite instead of trusting its green.** Made
  `isListingCategory` permissive → **132 passed, 14 failed**. Made
  `listCategories()` return distinct-values-in-use → **142 passed, 4 failed**.
  Both files restored to matching md5. This is the check that distinguishes 146
  real assertions from 146 vacuous ones.
- **Probed 10 ways around the F1 guard**, not just the one that works: direct
  index, destructure-then-index, optional-chained index, three assignment
  targets, `includes()`, and a generic constraint — **TS7053 ×3, TS2322 ×3,
  TS2345, TS2536**. Established that only the TS7053 arm depends on
  `noImplicitAny`; the rest are config-independent. This is what F5 documents.
- **Proved the `SEED_LISTINGS` re-pinning actually bites** by introducing
  `'trainig_plan'` → `TS2820` with a did-you-mean. Reverted.
- **Ran the legacy row end-to-end through a live server** with an XSS payload as
  its category: `Track & Field <img src=x onerror=alert(1)>` rendered
  HTML-escaped on both browse and detail, `querySelector('img[src="x"]')` null.

### Carried forward — deliberately not fixed post-approval

Changing code after an approval without review is the thing this process exists
to prevent. Logged for the round that next owns each file.

- **F3 (LOW) — `listingCategoryLabel()` can return a non-string, violating its
  own signature.** `types.ts:115-117`. `store.ts:loadFromDisk()` does no per-row
  shape validation, so a `db.json` holding `category: 42` flows through and
  React renders `42`. Demonstrated on a throwaway store. Not a rejection: no
  version of this app has ever *written* a non-string category, and the store is
  uniformly unvalidated — `title` and `price_cents` share the property exactly.
  A fix narrows at the store boundary, or softens the doc claim at
  `StoredListingCategory:71-94` ("what a category column may actually CONTAIN"),
  which currently promises slightly more than the type delivers.
- **F4 (LOW) — the sanctioned rendering path accepts any string in the
  program.** `types.ts:115`. `StoredListingCategory` is assignability-equivalent
  to `string`, so `listingCategoryLabel(listing.title)` compiles and would render
  a title as a category badge. **Unchanged from before the rework, so not a
  regression** — recorded because the F1 fix is *marketed* as making the render
  path safe, and it is safe against the blank-badge bug but **not** against a
  wrong-field bug. A real fix needs a branded type, probably not worth it. Do
  not assume more than the type gives.
- **F6 (INFO) — home-page copy still asserts a sport filter.**
  `src/app/page.tsx:24`, `:78`, `:142`. **Not an E1 scope violation** —
  `page.tsx` belongs to E4 and E1 correctly left it alone. But E1 has now made
  those lines **factually false in the shipped product**, and they stay false
  until E4 runs. **E4 must fix this**; it is the one carried-forward item with a
  named owner.

### The SQL migration remains statically verified only — stated, not waived

There is no Postgres in this phase, so `create type public.listing_category`,
the retyped column and the enum's sort behaviour **cannot be executed**. The
substitute check was performed rather than assumed: the enum members were parsed
out of `0001_init.sql` programmatically and compared **position-by-position**
against `LISTING_CATEGORIES` (identical, `other` last); the column at `:198` is
the enum type, `not null`, no default; `listings_category_idx` exists;
`0002_rls.sql` has **zero** `category` references, so nothing is stale there;
and the tsvector/trigram indexes cover **title + description only**, which is the
parity claim `mockClient.listListings:344-352` makes and `verify-authz.mts:257,262`
asserts from the mock side.

### Environment left as found (re-verified by the orchestrator)

`data/db.json` md5 `e3ee20793e4c0c10ca9091dab452ea00`, 7 listings, **0
non-taxonomy rows**. No stray probe files. `grep trainig_plan` clean — the
mutation test was reverted. `.claude/launch.json` free of `autoPort`.
`AGENTS.md` mtime Aug 17. **No `node.exe` running** — all three dev servers the
critic started were stopped, port 3000 has no listener.
| E2 | **social-proof-agent** — orders, reviews, two-level aggregates, RLS, fake seed | ✅ claimed done | Scope: `types.ts`, `client.ts`, `index.ts`, `mock/{store,mockClient}.ts`, `verify-authz.mts`, `0001_init.sql`, `0002_rls.sql`, `seed.sql`, `DATA-LAYER.md`, `supabase/README.md`, `README.md`, `data/db.json`. **Zero files under `src/app/` or `src/components/`** — verified by the orchestrator with `find -newermt`. Suite 146 → **256**. |
| E2v | **Orchestrator verification of E2, by execution** | ✅ | `tsc` 0 · `lint` 0 · `verify:authz` **256/0**. Seed coherent: 6 listings / 10 orders / 8 reviews / 8 profiles, `…0103` at **epoch 2** so the asymmetry is live in data rather than theoretical. E3 grep hits are comments and one deliberate tripwire only. |
| E2c | **critic-agent (E2)** — independent adversarial review | ❌ **REJECTED** | 9 of 10 criteria PASS. **0 HIGH, 2 MEDIUM, 3 LOW, 3 INFO. No live authorization defect** — the code repelled every attack constructed against it. Criterion 8 (assertions not vacuous) FAILS by execution. |
| E2d | **social-proof-agent rework** — F1–F7 | 🔄 in progress | F1 re-aim the vacuous injection assertions; F2 stamp the order's epoch; F3 doc/shape mismatch; F4 missing divergence row; F5 soften or enforce the rating-0 claim; F6 wrong rationale comment; F7 (orchestrator's call) drop `price_epoch` from the public view. |

### F1 — the defect that rejected the round, and why a green suite hid it

The critic mutation-tested all **19** behaviours the suite claims to cover.
Fifteen were caught. **Four shipped green:**

| mutation | suite result |
|---|---|
| `createReview` honours a caller-supplied `listing_id` | 256 passed, 0 failed |
| `createReview` honours a caller-supplied `author_id` | 256 passed, 0 failed |
| `listMyOrders` filters on `actor.learner_id` when present | 256 passed, 0 failed |
| `createListing` stamps `price_epoch: 0` | 256 passed, 0 failed |

Cause: the crafted-payload assertion at `verify-authz.mts:1030` aims at `…0202`,
an order **already reviewed in the seed**. The duplicate check at
`mockClient.ts:739` returns `conflict` first, so the injected columns are never
reached. The assertion passes for a reason unrelated to its own comment.

**This is the exact trap the same file warns about 70 lines earlier** at
`:958-961` — "against an already-reviewed order the duplicate check would catch
it instead, and the assertion would pass for a reason that has nothing to do
with ownership". The builder identified the trap for the ownership test and then
walked into it for the injection test.

**The code is correct** — proven directly against an *unreviewed* order: none of
`author_id`, `listing_id`, `price_epoch`, `id`, `created_at` is honoured, and
`listMyOrders` under five forged actor shapes returned 0 rows belonging to anyone
else. So this is a **test-coverage defect, not a vulnerability**. It still
rejects: with no Postgres, this suite *is* the executable half of the guarantee,
and a refactor spreading `...input` into the review row — the likeliest way
criterion 1 breaks — would ship green.

**Rule this establishes: a negative authorization assertion must target a
fixture whose *only* possible failure reason is the one under test.** Aim at an
already-conflicting row and the test proves nothing while looking green.

### F2 — review epoch stamping: DECIDED, changed to the order's epoch

Three independent parties reached the same conclusion — the builder raised it
against its own instructions, the critic found it without knowing that, and the
orchestrator agreed. **`mockClient.ts:758` changes from `listing.price_epoch` to
the order's epoch.**

A buyer who purchases at epoch 1 and reviews *after* a price rise was being
stamped epoch 2 — their review appeared as feedback on a version they never
bought, and the archive leaked. It was also inconsistent with `orders`, which
already carry the epoch they were purchased at.

**Accepted consequence, recorded so it is not rediscovered as a bug:** such a
review is archived the moment it is written and never appears on the offer page.
It still counts toward the coach's account rating. The user was told this is now
the behaviour and that it is a one-line reversal.

### F7 — orchestrator's call, not a critic finding

`offer_stats` published `price_epoch` to `anon`, letting an anonymous visitor read
how many times an offer's price had been raised. Nothing asked for it and E5 does
not need it — it renders rating, review count and sales count. **Removed from the
public projection.**

### What the critic proved rather than assumed

- **Criterion 1**, beyond the suite: `order_id` as an object with a `toString`
  returning the real id (`invalid`), whitespace-padded id (`forbidden`),
  `__proto__` / `constructor` (`not_found` — `Array.find`, no prototype hit),
  `input.order_id` as a getter (`forbidden`), and an **`actor.userId` getter that
  flips between reads** (`forbidden` — `requireActorId:162` snapshots once, so
  there is no TOCTOU window). Two *concurrent* submits → one accepted, one
  `conflict`, exactly 1 row: the `mutateDb` mutex holds.
- **Criterion 3**, both directions, by mutating `…0103`'s epoch at runtime rather
  than reading the seed: bumping 2 → 3 took the offer to `{null, 0, 0}` while the
  coach stayed byte-identical at `{4.4, 9, 10}`.
- **Criterion 6**: `actor.userId` is the **only** actor property read anywhere in
  `mockClient.ts`, read exactly once, at `:162`.
- **Criterion 10**: a **pre-E2 store upgrades cleanly** despite `DB_VERSION`
  staying at 1 — a `db.json` with no `orders`/`reviews` keys, no `price_epoch`
  and a legacy `category: 'Track & Field'` loaded fine, arrays supplied by
  `emptyDb()`, epoch backfilled to 1, legacy free text passed through.
- The one numeric parity claim was checked by execution: JS `Math.round(x*10)/10`
  vs Postgres `round(numeric,1)` agree for **every** (sum, count) pair up to 2000
  reviews — **0 disagreements**.

### Correction to the E1 log entry above

The E1 environment note records `data/db.json` at **7** listings. It now holds
**6**. E2 reseeded the store because the pre-existing one was incoherent — it
held an epoch-2 order against an epoch-1 listing, an impossible combination that
would have hidden the epoch asymmetry entirely on the local store. The cost, paid
knowingly: one runtime-created listing (`…be75`, 2026-08-20) and two random-id
coach profiles from E1 testing are gone. All were local-only test residue; the
durable mirrors are `SEED_*` in `store.ts` and `supabase/seed.sql`, and the file
is gitignored.

### Still statically verified only — stated, not waived

No Postgres exists in this phase, so `reviews_insert_own_purchase`, the three
`orders_select_*` policies and the two aggregate views **cannot be executed**.
The critic's substitute checks were performed rather than assumed: the policy set
was **parsed programmatically** and tabulated by table/verb/role, confirming
`public.orders` has exactly three policies, all `select`, all `to authenticated`,
scoped to `learner_id = auth.uid()` / `coach_id = auth.uid()` / `is_admin()`,
with **no `to anon` policy and no INSERT/UPDATE/DELETE policy for any client
role**; both aggregate views are non-`security_invoker` and granted to
`anon, authenticated`; `offer_stats` joins `l.price_epoch` into all three
sub-selects while `coach_stats` carries no epoch predicate and reads
`orders.coach_id` directly.
| E2e | **social-proof-agent rework** — F1–F7 delivered | ✅ claimed done | Suite 256 → **284**. All 4 previously-surviving mutants now caught, plus 2 new mutants guarding F2 and F3. |
| E2f | **Orchestrator verification of the rework, by execution** | ✅ | `tsc` 0 · `lint` 0 · `verify:authz` **284/0**. `PublicReview` is a field-by-field projection carrying **0** of `order_id` / `author_id`. Stamping is `order.price_epoch` (`mockClient.ts:784`). `price_epoch` absent from `OfferStats`. **Zero** files under `src/app/` or `src/components/`. |
| E2g | **critic-agent (E2) re-review** | ⚠️ **INTERRUPTED** | Second session limit of the project, hit mid-re-review (resets 22:10 Europe/Zurich). **No verdict — E2 remains REJECTED and unapproved.** State re-derived, not trusted. |

### How the builder closed F1, and the rule it now encodes

The crafted-payload assertion is re-aimed at `…0210`, the *other* never-reviewed
seeded order, and each server-resolved column is asserted **separately against a
different injected value** (`author_id` = Lena, `listing_id` = `…0106`,
`price_epoch` = 99, plus `id` and `created_at`), then checked from the outside:
the offer named in the payload gained no review and is still unrated, the offer
the order actually bought gained it, and the learner named in the payload is not
credited.

The fixture comment now states in one line **why the target must be unreviewed**,
so the next person aiming a write test does not re-derive the trap. That comment
is the durable half of the fix; the assertion alone would have been re-broken.

`listMyOrders` gained three forged-actor shapes (`learner_id`, nested `claims`,
prototype `role`), each asserting the rows are non-empty **and** all the actor's
own — non-emptiness matters, or a method returning `[]` would pass.

### F3 — the builder chose the larger fix, for a reachability reason

Offered "correct the two doc claims **or** project the shape", it projected —
`ReviewWithAuthor` / `ReviewWithListing` are gone, replaced by `PublicReview`
= `{ id, listing_id, rating, body, created_at, author_name }`, a field-by-field
projection **deliberately not a spread**, so a column added to `reviews` later
cannot escape by default.

Its reason was better than the finding: **`order_id` is a valid argument to
`getOrder()`**, so publishing it on a public review made the buyer/seller-scoped
order read partly reachable from an anonymous page. That is a reachability
argument, not tidiness, and it also defused the existence oracle in F4.

SQL mirrors it on the `public_profiles` precedent: `reviews_select_public
using (true)` is **dropped**; `reviews` now has `_own_author` / `_own_coach` /
`_admin` policies, and anonymous callers read a new `public.public_reviews` view.

### F2 — the case that could not previously exist is now pinned

A new block plants an **unreviewed epoch-1 order on the re-priced offer**,
reviews it, and pins: stamped epoch 1 · offer review count and rating unmoved ·
absent from the offer page · **+1 on the coach account and readable on the coach
profile**. Fixture removed afterwards. Mutant 14 (stamp the listing's epoch)
trips this block.

### Accepted residual — recorded so it is not re-filed as a finding

`price_epoch` is out of `OfferStats` and the public view, but
**`Listing.price_epoch` is still publicly readable** via `getListing()` /
`listListings()`, and `listings` is world-readable in SQL — so an anonymous
visitor can still infer how many times a price has been raised. The builder
flagged it rather than fixing it unilaterally, which was right.

**Accepted by the orchestrator.** Closing it requires a projected public listing
shape, which breaks the project's "types mirror the row shapes" invariant for the
exact row **E3's update path must write**. E4/E5 must simply never render it. If
it is ever closed, the projection is the way, and it should be done in the round
that owns the listing write path.

### Ruling: do not enumerate unreachable divergences

The mock falls back to `'Former member'` for a missing review author; the
`public_reviews` view inner-joins and would drop the row. **Neither backend can
reach that state** — `reviews.author_id` is `ON DELETE CASCADE`, so the review
dies with the profile. The defensive fallback stays and **no divergence row is
added**: a divergence table that enumerates unreachable states becomes noise and
weakens the rows that matter.

### State re-derived after the second interruption

Nothing above trusted. Re-confirmed by execution: `tsc` 0 · `lint` 0 ·
`verify:authz` **284/0** · `price_epoch: order.price_epoch` present at
`mockClient.ts:784` · `PublicReview` carries **0** leak columns · **no** stray
probe or `.bak` files · store coherent at 6 listings / 10 orders / 8 reviews /
8 profiles with `…0103` at epoch 2 and **0** rating-0 rows · **no `node.exe`
running**.

**E2 is NOT approved.** A fresh critic must complete the re-review before E3.
| E2h | **social-proof-agent rework #2** — F1–F6, fixed as a *pattern* not as two patches | ✅ done | Suite 284 → **315**. Shared `expectShape()` helper + 5 named column-set constants; every projection call site now asserted. |
| E2i | **critic-agent #2 (E2) re-review** | ✅ **APPROVED** | Both MEDIUMs genuinely closed. Its own 63-mutant set re-run in full: **62 caught, 1 survives**. 1 LOW, 2 INFO remain — **and it corrected the builder's report to the orchestrator.** |
| E2j | **F5 note corrected** (orchestrator, post-approval) | ✅ done | `verify-authz.mts` — the note named its fragility **backwards**. Comment only; precedent B3/E1h. Re-verified `tsc` 0 · `lint` 0 · **315/0**. |
| **E2 — ROUND COMPLETE** | **Reviews-and-sales data layer approved** | ✅ | 2 critic rejections, 1 approval, 1 interrupted re-review. **Zero live authorization or privacy defects were ever found** — both rejections were test-coverage defects. |

### The lesson of E2, worth more than the code

**Both rejections were the same failure: a green suite that proved nothing.** No
attack any critic constructed ever got through the actual code. What kept
failing was the evidence.

The recurring shape: **this file states a testing rule in a comment and then
fails to apply it at the neighbouring call site.**

1. Round 1 — the unreviewed-fixture rule was stated at `:958-961`, applied to the
   ownership test, and violated 70 lines later by the injection test.
2. Round 2 — the "a refusal proves nothing without a matching success" rule was
   stated at `:1070-1071` for `createReview`, and the order reads had **no**
   positive control at all.

The structural fix was the right response to a recurring failure: a shared
`expectShape(label, row, columns)` that **fails on `undefined`**, plus five
hand-written column-set constants declared independently of the code under test.
Making the assertion one line per site removes the cost-based excuse to check one
projection and skip its neighbour. The builder then swept every call site rather
than the two named:

| shape | sites | before | after |
|---|---|---|---|
| `toPublicReview` | `listReviewsForListing`, `listReviewsForCoach` | 1 of 2 | **2 of 2** |
| `withListing` | `getOrder`, `listMyOrders`, `listOrdersForCoach` | 1 of 3 | **3 of 3** |
| `offerStats` | `getOfferStats`, `listOfferStats` | 1 of 2 | **2 of 2** |

The sweep for vacuous positive controls found **ten more** beyond the five the
critic named, all fixed — including `anon listListings`, where `[]` would have
passed.

### What the critic proved rather than accepted

- **`expectShape()` really fails on `undefined`** — extracted verbatim and run
  against six inputs: `undefined`, `null`, `[][0]`, `{}` all FAIL; a correct row
  PASSes; a row with **one** extra column FAILs.
- **The shape assertions are not self-confirming.** The expected column sets are
  hand-written literals at `:127-145`, not derived from `toPublicReview()`'s own
  output. Proven discriminating with three single-column mutants the builder did
  not have: `+price_epoch` → 2 failures, `+order_id` → 2, **−`listing_title`** → 2.
- **All 26 `allows()` call sites** enumerated mechanically and classified: 19
  assert the captured return value, 6 assert a store re-read, 1 borderline but
  unreachable. **Nothing asserts something that would hold if the method returned
  nothing** — verified by execution, not by reading (`getOrder` returning `null`
  → 6 failures; `undefined` → 6).
- **20 further mutants** against the newly-guarded surfaces, all caught.

### Corrections to the builder's own round report

- **There are 26 `allows(` call sites, not 28.** The other two hits are prose
  inside comments *about* `allows()`. Counting them inflated the denominator.
- **F4 was reported closed. It is not** — see below.

### F4 — OPEN, knowingly accepted, and assigned

`mockClient.ts:733`. The finding named **`createReview`**'s order lookup. The
three new assertions at `verify-authz.mts:458-460` are aimed at **`getOrder`**'s
lookup at `:667`. Six mutants, run by the critic:

| widened predicate | `getOrder` (`:667`) | `createReview` (`:733`) |
|---|---|---|
| `\|\| o.learner_id === orderId` | caught, 1 failure | **survives 315/0** |
| `\|\| o.listing_id === orderId` | caught, 1 failure | **survives 315/0** |
| `\|\| o.coach_id === orderId` | caught, 1 failure | **survives 315/0** |

The `getOrder` half is well done — each assertion bites independently, exactly
one failure per mutant, no overlap. **INFO, not a privilege issue**: the
ownership check at `:740` still gates every path, re-confirmed by execution
(Lena, Nils, an admin and anonymous all refused on Aisha's order). The residual
correctness bug would be reviewing *one of your own* orders selected by the wrong
predicate.

**Assigned to E3**, which will be editing this file anyway. The fix is three
`not_found` assertions against `createReview`, e.g.
`createReview(AISHA, { order_id: AISHA.userId, … })`.

### F5 — the note named its own fragility backwards. Corrected.

The note claimed that moving validation inside `mutateDb` would make the loops
"pass for the wrong reason — a duplicate conflict wearing an `invalid` label".
The critic **built that exact refactor and ran it: 15 failures**, every one
reading `expected code 'invalid', got 'conflict'`. `refuses()` compares the exact
`DataError` code, so a conflict can never wear an `invalid` label.

This mattered enough to fix post-approval because the note told a future
maintainer that **a genuine red suite was the predicted silent-pass** — the one
reading that could get a real failure waved through. The note now says the loops
fail loudly, that this is the safe outcome, and states the *real* limitation:
because the targets are already reviewed, those 15 assertions prove only the
error **code**, never that a bad rating fails to **land in the store**.

### Carried forward

- **F-i (INFO)** — `verify-authz.mts:1018-1022`, `taxonomyProbes`'s follow-up is
  `.every()` over a possibly-empty array with no length assertion. Unreachable:
  `Promise.all` over `LISTING_CATEGORIES.map` fixes the length at 8 inside the
  test itself, not by the method under test. The one `allows()` follow-up in the
  file that does not stand on its own.
- **F-ii (INFO)** — HMR WebSocket errors (`ws://localhost:3000/_next/hmr`) appear
  in the Browser pane console on any dev-server page load. **Not an application
  error** — the preview harness's own socket to `next dev`; `preview_logs
  --level error` reports none. **Logged so no future critic re-files it as a
  console-error regression.**

### Still statically verified only — stated, not waived

No Postgres exists in this phase. The critic split F3's claim honestly:

- **Checked**: `coach_stats`'s outer `FROM` is exactly `public.profiles p` — the
  three `from public.orders` / `from public.reviews` occurrences are all inside
  correlated scalar subqueries, and there is no `UNION`. So an unknown id yields
  **zero rows**, not a zeros row, and the prescribed coalesce is right.
- **Not checked, and not claimed**: that a brand-new coach *with* a profile row
  comes back as zeros — this rests on `count(*)`=0, `avg()`=NULL and
  `round(NULL::numeric,1)`=NULL over empty sets. Standard documented Postgres
  semantics, and the view depends on nothing else, but **it was not executed**.

### Environment (re-verified by the orchestrator)

`mockClient.ts`, `store.ts` and `types.ts` are **byte-identical** to the version
reviewed the previous round — the rework was **test and documentation only**,
which is the right shape given no behaviour defect was ever found. md5
re-verified after **every one of 86 mutations**; the harness aborts on drift and
never drifted. No probe files, `scripts/` back to three files, no `node.exe`,
nothing listening on 3000.
| E3 | **lifecycle-agent** — update, soft delete, revisions, epoch increment, tombstone, restore | ⚠️ **INTERRUPTED, then resumed** | Third session limit of the project (resets 00:10 Europe/Zurich), hit **mid-build** — the agent had finished the code and was about to build its mutation harness. |
| E3v | **Orchestrator verification of the interrupted state, by execution** | ✅ | `tsc` 0 · `lint` 0 · `verify:authz` **489/0** (floor was 315). `updateListing` / `softDeleteListing` / `restoreListing` / `listMyListings` / revisions all present in `client.ts`. **Zero** files under `src/app/` or `src/components/`. No stray probe or `.bak` files. No `node.exe` running. |

### Why this interruption was riskier than the previous two

E1 and E2 were cut off **mid-review**, where the hazard is a half-applied
mutation left in the tree. E3 was cut off **mid-build**, where the hazard is
half-written behaviour that typechecks. The verification above was therefore
aimed at completeness, not just cleanliness — and the highest-risk invariant was
read directly rather than inferred from a green suite:

`mockClient.ts:776,782` — `const priceIncreased = priceCents > listing.price_cents;`
then `if (priceIncreased) listing.price_epoch += 1;`. **Strictly greater**, so
neither a price cut nor an unchanged price bumps the epoch. That is the locked
rule stated correctly.

### What the interruption left undone

1. **All mutation testing.** The agent's last words were that it was about to
   build the harness. A 489-assertion suite that has never been mutation-tested
   is exactly the state both E2 rejections were about — **489/0 is not evidence
   until something has been broken and seen to fail.**
2. **`docs/DATA-LAYER.md` was never updated.** It is the guide E5 and E6 will
   read, and it currently documents none of the lifecycle.
3. **The E2-F4 pickup is unconfirmed** — three `not_found` assertions against
   `createReview`'s order lookup.

All three were handed back to the same agent, which retains its build context.
The mutation list sent to it names the two failure modes most likely to be
subtly wrong and silently destructive: the price comparison flipped to `>=` (an
unchanged price bumps) or to `!==` (a **cut** bumps), plus **each `deleted_at`
filter removed one read path at a time**, so that a single unguarded path cannot
hide behind a guarded neighbour.
| E3c | **critic-agent (E3)** — 87 mutants written from scratch | ❌ **REJECTED** | Code correct, 84/87 caught. Criterion 8 FAIL. 5 MEDIUM, 2 LOW, 2 INFO. |
| E3d | **lifecycle-agent rework** — F1–F9 + `deleted_by` | ✅ done | Suite 497 → **561**. `mockClient.ts` **byte-identical** to the reviewed version: tests, docs and SQL only. |
| E3e | **critic-agent (E3) re-review** | ✅ **APPROVED** | All three rejection defects reproduced closed at 9, 6 and 2 failures, **plus two harder F1 variants the critic invented**. Zero regressions across the full 87-mutant set. |
| E3f | **F12 + F13 doc amendments** (orchestrator, post-approval) | ✅ done | `0002_rls.sql` — header said "four things" above a list of six; and the revoke's silent-undo hazard was undocumented. Comments only; precedent B3/E1h/E2j. Re-verified `tsc` 0 · `lint` 0 · **561/0**. |
| **E3 — ROUND COMPLETE** | **Offer lifecycle approved** | ✅ | 1 rejection, 1 approval, 1 mid-**build** interruption. |

### F1 — the most consequential defect of Phase E, and the fifth instance of one rule

Deleting the scope filter from `listListingRevisions` — the method returning a
coach's **private price history** — left the suite at **530 passed, 0 failed**.

Cause: `lifecycle.id` was the only listing ever successfully updated anywhere in
the suite (all 15 `updateListing` call sites target it or a not-found probe), so
`listing_revisions` only ever held rows for one `listing_id`, and
`every(r => r.listing_id === lifecycle.id)` was **vacuously true whether the
method filtered or not**. The critic built the missing fixture and read a rival's
title and superseded price out of the method. Any approved coach could reach it
by creating and editing one offer.

**This is the fifth occurrence of the same rule across three rounds** — E2-F1,
E2-F2, E3-F1, plus the two the audit then found. The rule, restated because it
keeps costing rounds:

> **A negative assertion must target a fixture whose only possible failure reason
> is the one under test.** An assertion over rows that can only come from one
> source cannot discriminate, however it is spelled.

### The audit — and the critic's better method for it

The builder enumerated all 16 `.every()` sites and found **two more**, both real:
`listOrdersForCoach` (every order in the store was a sale by one coach, so the
scope assertion held either way) and `listMyOrders` (`.every()` with no
non-emptiness guard, so `[]` passed). Both now bite when widened **and** when
emptied.

The critic did not audit that list. It **enumerated mechanically, by mutation**,
which is source-agnostic and strictly stronger — it does not care whether an
assertion is spelled `.every()`, `.some()`, `.filter().length`, a count or an
`expectShape`:

> For every method returning a collection or a scoped row: does **widening its
> scope predicate to `() => true`** get caught? Does **emptying it to
> `() => false`** get caught?

An assertion whose fixture set has one source fails the widening mutant by
construction, so **the widening mutant *is* the test for the defect class.**
19 methods, 47 mutants. **Adopt this for every future round.**

Its F1 reproduction included a variant the builder did not have and which is the
one that matters: scoping by *the actor's own listings* rather than the requested
one — a subtle widening that leaks nothing across coaches and would survive a fix
aimed only at the crude "return everything" mutant. Still caught, at 1 failure.
**The fix is sensitive to the predicate, not merely to the row count.**

### F5 — the builder corrected the orchestrator's ruling, and was right

The ruling prescribed `revoke select (deleted_by) on public.listings from anon,
authenticated`. **That is a silent no-op.** In PostgreSQL table-level and
column-level privileges are held separately: a table-level `SELECT` confers every
column, and a column-level revoke does not subtract from it. Supabase grants
table-level `SELECT` by default, so the migration would have looked like it
closed the hole while the column stayed readable.

The working form, implemented: `revoke select on public.listings from anon,
authenticated` then a column-wise `grant select (…)` omitting `deleted_by`.
Verified by the critic **by parsing both files and diffing**:

```
TABLE columns   (11) … deleted_by …
GRANTED columns (10) … deleted_by absent
in table, NOT granted : deleted_by   ← exactly the intended omission
granted, NOT in table : (none)       ← no latent breakage
TS Listing minus granted : deleted_by ← matches Omit<Listing,'deleted_by'>
```

Order also checked: the `javelin_privileged` grant precedes the revoke and is
untouched by it (the guard must read `old.deleted_by`), and no later statement
re-grants `listings` to a client role.

**Consequence, documented in three files:** `SELECT *` expands to every column,
so a client holding only column privileges gets **42501 on `select=*`** — not a
row with the column quietly missing. `SupabaseDataClient` must enumerate columns,
and any new `listings` column must be added to that grant.

### Carried forward — assigned to E4

- **F10 (LOW, pre-existing Phase D, NOT an E3 regression)** —
  `getMyCoachApplication`'s actor scope is unasserted. Widening
  `.filter(a => a.user_id === profile.id)` to `() => true` leaves the suite at
  **561/0**, and because the method sorts newest-first and takes `[0]`, **whoever
  filed most recently is served to everybody**. Demonstrated: Marcus asks for his
  own application and receives Priya's private bio. `PROGRESS.md` E-0 calls that
  bio an owner-and-admin-only artifact. Only two assertions exist and at that
  point in the run the learner is the only user who has filed, so the fixture
  cannot discriminate. **Fix:** a second user files afterwards; assert the first
  still gets their own row, named by `user_id` and by a bio unique to them.
- **F11 (INFO, pre-existing)** — `listCoachApplications` ignores its `status`
  filter undetected. Admin-only and a convenience rather than an authorization
  predicate.

### F7 — accepted as sufficient, with the residual named

An unexpected throw now costs one labelled failed assertion **and the summary
still prints** — verified on both channels: `=== 361 passed, 1 failed ===`,
exit 1. It does **not** resume past the throw; a top-level-`await` ESM entry
cannot be. The misparse risk is closed on both the summary line and the exit
code, and the construction cannot produce a false green. Making it resume would
mean restructuring 2672 lines into per-section async functions, buying debugging
visibility and **no additional safety**. Not spent.

### Environment note for future rounds

**Port 3000 is occupied by a different project of the user's** ("Franck Di Sanza
— Lanceur de javelot suisse", PID 21360). The critic used `autoPort`, reverted
it, and **left that process alone** — correct. Any future agent must do the same:
the port being busy is not evidence of a stale JavelinHub server.

Separately: the builder's mutation harness lived in the shared session scratchpad
and **a critic's run overwrote it**. Harnesses must live in a directory unique to
the agent and round.
| E4 | **coaches-agent** — public coach fields, `/coaches` + `/coaches/[id]`, route moves, two-entry home, shared components | ✅ done | **First round to ship UI.** Interrupted twice mid-build by session limits; implementation survived both intact. |
| E4c | **critic-agent (E4)** — 86 mutants from scratch | ❌ **REJECTED** | **1 HIGH, 5 MEDIUM, 8 LOW, 4 INFO.** Live behaviour passed criteria 1–5, 7, 9, 10 under heavy attack. |
| E4d | **coaches-agent rework** — all 15 findings | ✅ done | Suite 705 → **750**. 46 mutants, 46 caught. |
| E4e | **critic re-review** | ❌ **REJECTED** (one MEDIUM, narrowly) | F1 and 13 others closed and independently verified. **F3 not closed** — the new fixture was exactly its own *descending* sort. |
| E4f | **F3 fixed by the orchestrator**, verified by the critic | ✅ | Test fixture + comment only; `mockClient.ts` byte-identical. Suite **751**. |
| E4g | **critic final re-review** | ✅ **APPROVED** | **151 mutants applied this round, 145 caught**; all 6 survivors proved inert or unreachable **by execution**. |
| E4h | **Label correction** (orchestrator, post-approval) | ✅ done | Three assertion labels named the wrong row after the orchestrator's own reindex. Strings only; precedent B3/E1h/E2j/E3f. `tsc` 0 · `lint` 0 · **751/0**. |
| **E4 — ROUND COMPLETE** | **Coaches, routes and the first UI approved** | ✅ | 2 rejections, 1 approval, 2 mid-build interruptions. |

### F1 — the project's first HIGH, and why a well-intentioned assertion could not see it

`updateMyCoachProfile` is the one path a coach has into their own profile row.
The builder knew it and labelled the block *"the obvious place for a role
escalation to be introduced by accident"* — then aimed it at **Nils Berg, whose
`role` already is `'coach'`**, while the method's own gate guarantees every
reachable actor already holds `coach_status === 'approved'`. Both assertions held
whether or not the method wrote those columns.

Inserting `profile.role = 'coach'` into the write block gave **705 passed, 0
failed**. And it is reachable: an **admin who redeems an invite code** is
`role=admin, coach_status=approved`, passes the gate, and under that mutant
**their own bio edit demotes them out of the admin role** — the bug
`promoteToCoachRole()` exists to prevent, and rule 2 of `DATA-LAYER.md`.

The fix could not be a rewording. The only subject for whom the mutation is
observable is an admin who is *also* an approved coach. The critic then proved the
new block's **own non-vacuity** by instrumenting the run — `coach_headline` moves
`null → "Administrator who also coaches"`, so the role assertion is about a write
that actually happened — and ran nine privilege mutants: demotion, escalation,
`role='learner'`, a **surgical `if (role==='admin') role='coach'`**, a
`coach_status` change, an email change, and two non-vacuity probes. All caught.

### F3 — rejected twice, and the second time is the more instructive

Round 1: the id list was already in **ascending** order, so "in the order given"
could not be told from "sorted".

Round 2's fix reordered it to `[unknown, empty, seeded]` and added a guard
asserting the list is not its ascending sort. **That list is exactly its own
descending sort**, and the guard only excluded ascending — so `sort().reverse()`
and a descending `localeCompare` comparator both survived at **750/0**.

Why it mattered: this codebase orders `desc` almost everywhere
(`byCreatedAtDesc` ×13, `order by created_at desc, id desc`), so a Supabase
`listCoachStats` served from `order by coach_id desc` is a plausible
implementation — and `coaches/page.tsx:115` zips `stats[index]` positionally. On
the current seed that renders **Cory Vaughn's 4.4 / 8 reviews under Nils Berg's
name**, and "New coach" under Cory's.

The comment also claimed the list was "neither ascending nor descending", which
was false — the **E2-F5 shape**: a note misdescribing its own fragility.

Fixed to `[EMPTY_COACH, unknown, COACH]`, with a **second** meta-assertion
rejecting the descending sort, labelled as the case that slipped through. The
critic verified both guards are load-bearing by regressing the fixture to each bad
ordering and confirming each guard fires on exactly the regression it names, and
added two **minimal-transposition** mutants of its own — swap the first two
entries, swap the last two — so the block is now sensitive to **any** reordering,
not merely to a wholesale sort. Both caught.

> **Rule this adds:** a fixture guard that excludes one ordering excludes only
> that ordering. Exclude ascending *and* descending, and prefer a minimal
> transposition as the mutant, not a full sort.

### F5 — the fix that created its own regression, caught by the builder

Raising the nav breakpoint was not sufficient: at 1024 with an admin the **Log
out button** was then crushed to **34×113** — the identical letter-column failure,
relocated. A flex item may shrink to min-content, and the min-content of a
wrappable "Log out" is "out". Three coordinated changes were needed
(`whitespace-nowrap`, `shrink-0`, `flex-wrap`).

Final measurements, **7 widths × 4 viewer types**: every nav item at full label
width and exactly **44px** tall; Log out **80×44** at every desktop width; the
crushed-element detector empty at every cell; `document.scrollWidth` never
exceeding the viewport, including the mobile panel open at 375.

### Accepted, with the IA fix assigned

**The admin header is two lines at every desktop width.** Accepted by the
orchestrator: nothing truncated, nothing overlapping, no ellipsis, every target
full size, no sideways scroll — the critic independently agreed it "reads as a
two-row header, not as damage". The real one-line fix is moving
`Admin`/`Applications` out of the primary row, which is an **information-
architecture decision deserving its own round**, not an unreviewed change at the
end of this one. **Assigned to E6, which adds a seventh nav item and makes it
worse.**

### Assigned to E5

**`listOfferStats` has no order assertion at all** — both `sort()` and
`sort().reverse()` survive. Its contract says "in the order given". An
**E2-era gap**, not an E4 regression; nothing zips it positionally yet, and **E5
is the first round to render offer stats** and therefore the first to depend on
it.

### The six surviving mutants, each proved inert BY EXECUTION

Recorded so no future round re-files them as gaps:

1. `coach_status = 'approved'` in `updateMyCoachProfile` — the gate guarantees
   every reachable actor already holds it, so the write cannot change reachable
   state. Any **other** value is caught (14 failures).
2–4. `isApprovedCoachProfile` widened by `role === 'coach'`, at either call site
   — the E4 critic classified these as **unreachable** on the grounds that "the
   only producible states are `admin/none`, `coach/approved`, `learner/none`,
   `learner/rejected`, `learner/pending_review`".

   > ### ⚠️ THAT CLAIM IS FALSE, AND E5's CRITIC DISPROVED IT BY EXECUTION
   >
   > **`coach/rejected` IS producible.** The sequence, reproduced twice against a
   > throwaway store: file an application (`learner`/`pending_review`) → **redeem
   > an invite code, which approves without closing the still-pending
   > application** (`coach`/`approved`) → publish an offer → an admin rejects that
   > pending application → **`{ role: 'coach', coach_status: 'rejected' }`, with
   > the offer still live in `listListings`.**
   >
   > So the mutants are **NOT inert**. Re-tested against a store that actually
   > holds the state, `isApprovedCoachProfile` widened by `|| role === 'coach'`
   > **admits that profile** — `getPublicCoach()` would publish a de-approved
   > coach and `listCoaches()` would list them.
   >
   > **The shipped code is correct** (`mockClient.ts:310-311` tests
   > `coach_status === 'approved'` only, and fails closed), so there is **no live
   > defect**. What was wrong was this record — written specifically so a future
   > round would not re-file it, and which would have told E6 that widening that
   > predicate is harmless. **It is not. Do not widen it.**
   >
   > The underlying data-layer question this exposes, which **no round has
   > decided**: should `redeemInviteCode` close a pending application? Leaving it
   > open is what lets a later rejection de-approve someone who was approved by
   > invite. E5 guarded its links around the state rather than changing the data
   > layer unilaterally, which was right for a presentation round.
5. The approval copy taking the applicant's *newest* application — always the row
   under review, since a pending application blocks a new one and only a pending
   one can be reviewed. Both **discriminable** wrong-lookups are caught.

### What the builder flagged rather than silently implementing

- **The apply-form bio hint** now discloses at the point of collection that the
  bio becomes the first draft of a public profile. **Endorsed**: between approval
  and the coach's next login, text written for a private audience is already
  published, and the locked spec's rationale did not close that.
- **`updateMyCoachProfile` has no UI** and no round owned one. **Assigned to E6**
  — without it the field is never editable.
- **Seven pages carry pre-existing one-blue violations** it deliberately did not
  touch, since sweeping four rounds' ownership is the unreviewed change this
  process exists to prevent. **Still unassigned.**
- **The brand doc says US dollars; `formatPrice` uses GBP.** Pre-existing.

### ⚠️ NOBODY HAS VISUALLY LOOKED AT ANY OF THESE PAGES

Screenshots are impossible in this environment — the Browser pane is not
displayed (PROGRESS.md:617). **Every** visual claim in this round, across three
critic reviews, is a computed-style / geometry measurement (`getComputedStyle`,
`getBoundingClientRect`, `elementFromPoint`) against a live dev server. That is
strictly stronger than eyeballing for colour, size, tap target and overflow — and
it says **nothing** about whether the pages look right. Stated by the critic in
all three reports, and carried to the user verbatim each time.
| E5 | **surfacing-agent** — offer stats, reviews, cross-links, five empty states, demo disclosure | ✅ done | Interrupted **three times** mid-round by session limits. **No data-layer method added**: `mockClient.ts` byte-identical to E4's `4b295c0a…` throughout. |
| E5c | **critic-agent (E5)** — first review | ❌ **REJECTED** | No behavioural defect. **The round's entire deliverable had no durable executable evidence.** |
| E5d | **rework** — harness promoted to the repo | ✅ done | `scripts/verify-pages.mts` + `npm run verify:pages`, planting its own fixtures. |
| E5e | **critic re-review** | ❌ **REJECTED** (narrowly, 1 MEDIUM) | The demo-data disclosure — **the one requirement the user confirmed personally** — had no positive control. |
| E5f | **N4/N5/N11 fixed by the orchestrator** | ✅ | Assertions only. **The critic's own specified fix for N11 was insufficient** — see below. |
| E5g | **critic final review** | ✅ **APPROVED** | 88 mutants across three reviews. Found a fourth issue (LOW) in the code just added. |
| E5h | **W5/W6 + an extractor blind spot** (orchestrator, post-approval) | ✅ | See the warning below — this went **beyond** the one-element fix the critic specified, and E6's critic must re-verify it. |
| **E5 — ROUND COMPLETE** | **Offer surfacing approved** | ✅ | 2 rejections, 1 approval, 3 mid-round interruptions. |

### The finding that defined the round: correct code, no evidence

The first rejection found **no behavioural defect at all**. What it found was that
**five rendering regressions ship green** through `tsc`, `lint` **and** the
758-assertion authz suite:

| mutant | rendered effect | `verify:authz` |
|---|---|---|
| `/offers` links every coach unconditionally | emits an href that 404s | **758/0** |
| coach page links a withdrawn offer | href 404s, honest "(no longer on sale)" gone | **758/0** |
| demo note narrowed to the spec's literal scope | 3 fabricated ratings, **no disclosure** | **758/0** |
| coach "sold but unreviewed" collapsed | wrong wording | **758/0** |
| card collapses the fifth empty state | "No reviews yet" count 2 → 0 | **758/0** |

`verify:authz` is **structurally incapable** of catching any of them: it never
renders anything. **That is the argument for the second suite, and it is
evidence rather than preference.**

The cause of the blindness was the project's most expensive rule, for the sixth
time: the harness rendered against the **pristine seed**, which contains none of
the three states these guards exist for — and two of them **cannot be produced
through any UI path at all**. The builder had the fixture in hand, in its own
probe script, and proved the behaviour without ever rendering a page against it.

### `npm run verify:pages` — the durable outcome of Phase E

`scripts/verify-pages.mts`, **134 assertions**. Plants its own fixtures into a
throwaway store (`mkdtempSync` + `MOCK_DB_PATH`), boots a server on an
OS-assigned free port, asserts, kills the process tree, removes the store.
`data/db.json` is byte-identical across a full run.

Four design decisions, each verified by the critic rather than accepted:

1. **Fixtures are planted BEFORE the server boots.** The store is cached on the
   server's `globalThis`; a post-boot write is invisible to it. E1's lost
   afternoon, encoded.
2. **`next dev`, not `next start`.** `next start` serves whatever `.next` holds,
   so a page edited since the last build would be certified green **from a stale
   artifact** — exactly the false-green class this suite exists to stop.
3. **`node <next-bin>`, not the npm shim**, so the child is a real process
   killable by pid; `taskkill /T /F` on Windows, because `next dev` forks workers
   that outlive their parent. Measured: SIGKILL mid-run leaves **5 → 0**
   processes, no held port.
4. **`BASE` dropped entirely rather than wrapped.** A server someone else started
   reads a store nobody planted — every fixture assertion would then *silently*
   measure pages lacking the state under test. An escape hatch would have
   re-created the defect the suite was built to close.

The three planted states, none reachable from the seed:

| state | how |
|---|---|
| de-approved coach **with a published offer** | apply → redeem invite → publish → admin rejects the still-pending application |
| withdrawn offer **that still carries a review** | `softDeleteListing(CORY, …0104)` |
| coach who has **sold and is unreviewed** | invite + offer, then an order planted via `mutateDb` — `DataClient` has no `createOrder` |

### N11 — the critic's own specified fix was insufficient, and that is worth keeping

The critic specified: *"assert every per-review rating is an integer 1–5, with a
control that the extraction is non-empty."* Implemented exactly, **the mutant
still passed at 131/0** — replacing `{review.rating}` with a literal `{5}`
renders "5 out of 5", and **5 is an integer in 1–5**. A range check cannot catch
it.

Replaced with a tie the numerals cannot trivially satisfy: **their mean, rounded
the way `Rating` rounds, must equal the 42px aggregate rendered on the same
page.** Under `{5}` that is 5.0 against a displayed 4.4, failing on three pages.

The critic then attacked the replacement five ways and it held — including
**Z5, the minimal mutation**: one single review numeral out of eight changed from
`3` to `4`. Caught. It also forced the skip gate (`Z6`, `Rating` renders no
numeral at all) and confirmed the gate **cannot conceal a defect**: the mean
check does skip, and 8 other assertions fire.

> **Rule this adds:** an "is it in the valid range" assertion is not a test of a
> value. Tie the value to something it cannot satisfy by accident — here, an
> aggregate rendered from the same data on the same page.

### The disclosure had no positive control — on the one requirement the user confirmed

Deleting the coach profile's demo-data note (`{false ? (`) left the suite at
**115/0** while Cory Vaughn's page rendered **eleven fabricated numerals and
eight invented testimonials attributed to named people, undisclosed.**

Three demo-note conditionals existed; **each had only half a pair.** The file's
own header claimed *"every negative assertion below has a positive control beside
it"* — false at that line, the E2-F5 shape again. All three pairs now bite in
both directions.

### ⚠️ E5h went beyond what the critic specified — E6's critic must re-verify

The critic's W5/W6 fix was **one array element**. Applying it revealed that
`cardsByOffer()`'s href pattern demanded a closing quote straight after the id,
so on any **filtered** grid — where `/offers` builds hrefs as
`/offers/<id>?category=…` — it matched nothing and returned an **empty map**
rather than failing.

Nothing depended on it, because every existing card assertion reads an
unfiltered page. But the first assertion that did not would have been certified
by nothing. The pattern now tolerates an optional query string.

**This is a post-approval change to reviewed code, which is broader than the
doc-and-comment precedent (B3/E1h/E2j/E3f/E4h).** It is verified — clean run
**134/0**, and both fixture-drift probes (`nutrition_plan`, which E1 pins as
deliberately empty, and a junk category) now **fail at 133/1** where both
previously passed at 134/0 — but it has **not been through a critic.** E6's
critic must re-review `cardsByOffer()` and the F3 control.

### Carried forward to E6

- **W2 (INFO) — the F2 fixture silently switched off a branch.** Withdrawing
  `…0104` took Cory from 6 published offers to 5, so
  `otherOffers.length > shownOffers.length` is **false on every page the suite
  fetches** and the "See all N offers" overflow link **never renders anywhere in
  it**. It rendered before the fixture existed. Mutating the count survives
  134/0. Closed by planting one extra offer for Cory.
- **W3 (INFO) — a dead branch.** The plural *"sold N times, and none of the
  buyers has written about it"* never renders: no fixture offer has ≥2 sales and
  zero reviews. Reachable in production the moment an offer sells twice before
  anyone writes. Closed by a second order against `…0105`.
- **`beforeFirstItem()` is a landmine for the nav-IA round.** It splits on the
  document's first `<li>`. No chrome renders one today — but **E6 rebuilds the
  nav**, and a nav as `<ul><li>` would make every `ownStats` assertion read the
  header instead of the page. It fails loudly rather than passing blind.
- **The two suites have opposite failure shapes.** `verify-authz.mts` turns an
  unexpected throw into one labelled failure and still prints its summary
  (E3-F7); `verify-pages.mts` propagates and prints none. Both exit 1, so no
  false green either way — but two siblings that differ will mislead whoever
  wires them into CI. **E6 runs both; E6 aligns them.**
- **Accepted:** a hard `SIGKILL` leaks one ~17KB temp store. No process, no port,
  no user data, OS reclaims it. A `SIGINT`/`SIGTERM` handler is welcome if E6 is
  in the file anyway.

### Two things the builder refused to fake, both correctly

- **"Edited &lt;date&gt;" is not implementable truthfully on a public page.**
  `listing.updated_at` also moves on **withdraw and restore**, so rendering
  "Edited" from it would be a false claim about a coach's copy. The truthful
  source is `listing_revisions`, which is owner-and-admin-only. Needs a public
  `content_updated_at` or a public revision count, in the round that owns the
  listing write path. **Not faked.**
- **The demo note was moved and its condition widened**, deviating from "attached
  to the reviews/sales block". The critic reverted it to the literal wording and
  measured the result: `/offers/…0106` renders **3 fabricated ratings and 4
  fabricated sales counts with no disclosure at all**. Across 14 pages, zero
  undisclosed and zero notes with nothing to disclaim. **The deviation is right.**

### ⚠️ NOBODY HAS VISUALLY LOOKED AT ANY OF THESE PAGES

Stated by the critic in all three of its reports and carried here verbatim.
`verify:pages` reads **served HTML, not a laid-out DOM** — it cannot see computed
style, geometry, or 375px overflow, so **a CSS regression that changed a colour
or reintroduced a corner radius would pass it.** The fresh-bundle grep is the
standing check for the radius/shadow half; the rest is manual and was done by
hand through the Browser pane, not committed.

In particular: **two 42px numerals now sit on every offer card whose title is
16px** — the numerals are 2.6× the title and the largest type on the card. No
human has seen whether that reads as balanced or as top-heavy.
