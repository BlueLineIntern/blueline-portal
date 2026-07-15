# BlueLine Advisors Portal — Status

**Live site:** https://blueline-portal.fsabin.workers.dev/
**Admin view:** https://blueline-portal.fsabin.workers.dev/admin (sign in with an `ADMIN_EMAILS` address + the `ADMIN_PASSWORD` secret set in Cloudflare)
**Repo:** https://github.com/BlueLineIntern/blueline-portal
**Local path:** `C:\Users\joshu\Documents\blueline-portal`
**Cloudflare account:** fsabin@blueline-advisors.com (Worker + Pages: project name `blueline-portal`)

## Architecture
Single Cloudflare Worker serves both the static frontend (`public/`) and the API
(`worker.js`), same origin — no CORS needed. Data lives in a Cloudflare KV
namespace called `PORTAL_KV`.

- `public/index.html` / `public/assets/style.css` / `public/assets/script.js` — client-facing login; after login users land on a **five-category home hub** (`view-home`): **Onboarding** (badge "For all new clients"; contains the Financial Picture Analysis five-assessment dashboard `view-dashboard` with x-of-5 progress, plus the New Client Onboarding link to `/onboarding/`), **Budgeting & Spending**, **Risk Assessment**, **Estate Planning**, **Insurance Planning**. Each of the four module categories opens a shared `view-category` section (x-of-3 progress, module cards). The 12 new module forms are generated at boot from a declarative `MODULE_FORMS` spec + form engine in script.js (section id `view-<key>`, form `<key>-form`, error `<key>-error`); FPA forms remain static HTML. After save, FPA modules return to the dashboard, category modules to their category view. Clients never see results — completed cards show a thank-you + Review/Edit; results render only in admin.
- `public/assets/render.js` — shared chart builders (`donutChart`, `riskGauge`, `projectionChart`, `balanceBars`, `statBar`), module metadata (`MODULES` = FPA five, `CATEGORY_MODULES` = 12 new, `CATEGORIES` = 5 categories), and per-module result renderers; loaded by both index.html and admin.html
- `public/admin.html` — internal staff view, gated by `ADMIN_TOKEN` secret (separate from client logins): a **"Client Submissions" dropdown** (Name — email) that renders the selected client's detail inline — "x of N modules completed" (N = the client's assigned module count), a staff Flags block (rollover opportunity, stock concentration, missing 401(k) match, negative cash flow), then only the category sections/modules assigned to that client (unassigned modules are omitted, not shown as "Not started"; a category with nothing assigned is hidden), and email-matched New Client Onboarding records linking to the onboarding detail view. Polling refresh preserves the selection. Print/Save PDF produces a branded per-client report (one module per page). The "New Client Onboarding Submissions" table (all records incl. anonymous, delete/restore/trash) is unchanged.
- `worker.js` — register/login/logout, per-module assessment save/load, admin listing
- `wrangler.toml` — Worker config incl. KV binding and static assets directory
- `dev-server.ps1` — local mock server (serves `public/` + in-memory API) for frontend
  testing on machines without Node/wrangler. Keep its computed fields in sync with
  `worker.js`. Launch config in `.claude/launch.json`.

## Onboarding modules (as of the five-module rework)
KV record `responses:<email>` = `{ modules: { risk, budget, retirement, networth, compensation } }`.
Each module object carries its own `updatedAt`. API: `GET /api/assessments`,
`POST /api/assessments/:module`. Validation + all derived fields computed
server-side in `worker.js` (`MODULE_VALIDATORS`).

1. **risk** — 5 scored questions (5–25) + experience level + goals.
   Derived: `score`, `category`, `suggestedAllocation` {stocks,bonds,cash}.
   Dashboard: score gauge + allocation donut.
2. **budget** — monthly take-home income, savings, 10 expense categories.
   Derived: `totalExpenses`, `surplus`, `savingsRate`. Dashboard: expense donut,
   savings-rate bar, negative-cash-flow warning.
3. **retirement** — ages, savings, contributions, employer match, desired income,
   old-employer-plan status (rollover lead flag). Derived: `projectedBalance`
   (6%/yr, monthly compounding), `targetNestEgg` (25× annual need), `readinessPct`.
   Dashboard: projection area chart with target line + readiness bar.
4. **networth** — 6 asset + 6 liability categories. Derived: totals + `netWorth`.
   Dashboard: stacked assets/liabilities bars + asset composition donut.
5. **compensation** — base/bonus/equity, equity award types, 401(k) contribution
   & match %, HSA/deferred comp, employer stock concentration. Derived:
   `totalComp`, `concentrationFlag`. Dashboard: comp-mix donut + flags for
   stock concentration and contributing below the employer match.

All charts are dependency-free inline SVG generated in `render.js`.

## Category modules (twelve, added with the five-category hub rework)
Same storage and API as the FPA five — `responses:<email>` module map, validation
and derived fields in `worker.js` `MODULE_VALIDATORS`, mirrored in
`dev-server.ps1` `Build-Module` (rounding uses `[MidpointRounding]::AwayFromZero`
to match JS `Math.round`). All keys are lowercase a-z (route regex constraint).

- **Budgeting & Spending**: `spending` (essentials vs discretionary; discretionaryPct,
  leftover, overspending/highDiscretionary flags), `savings` (emergency fund;
  monthsCovered, targetAmount, shortfall, monthsToTarget, funded), `debt` (4 debt
  types with balance+rate; totalDebt, weightedAvgRate, dtiPct, highestRateType,
  highDti ≥36%, highInterest ≥10%)
- **Risk Assessment**: `riskcapacity` (5 scored Qs, score 5–25 → level; ability vs
  willingness framing), `behavior` (4 scored Qs, score 4–20 → profile, coachingFlag),
  `knowledge` (years + instruments + self-rating → knowledgeScore /12 → level)
- **Estate Planning**: `estatedocs` (5 docs status+year; completenessPct, missing/
  unsure/stale ≥5yr lists), `beneficiaries` (gapCount, eventsSinceReview,
  reviewNeeded; divorce callout), `legacy` (charitable/gifting/special
  circumstances → discussionTopics list)
- **Insurance Planning**: `lifeinsurance` (DIME: dimeNeed, gap, coveragePct,
  underinsured), `coverage` (5 lines status+amount; coveredCount, gaps, unsure),
  `ltc` (readiness Planned/Partially/Not yet, timelyFlag for 50+)

`worker.js` validator dispatch uses an own-property guard (hasOwnProperty) so
inherited keys like `constructor` 404 instead of bypassing validation.

## Module assignments (admin-controlled visibility)
Admins can control which modules each client sees. KV key `assignments:<email>`
= JSON array of assignable keys; **no record = null = everything visible**
(so existing clients and new registrations are never locked out). Assignable
keys = the 17 module keys + `onboardingWizard` (the New Client Onboarding link).
- Client API: `GET /api/assignments` → `{ assignments: array|null }` (session-auth).
- Admin API: `POST /api/admin/assignments/:email` `{ assignments: [keys] }`
  (admin-session-gated; filters to known keys, stores canonical order). Each client
  in `GET /api/admin/clients` now also carries its `assignments`.
- Client filtering (`script.js`): `refreshState()` fetches assessments +
  assignments together; `isAssigned(key)` gates the home hub (offerings, category
  cards), the FPA dashboard, category views, and `openModuleForm`. A category with
  zero assigned modules disappears from the hub; the Onboarding card hides only
  when both FPA and the wizard are unassigned. Progress denominators use the
  assigned count.
- Admin editor (`admin.html`): an "Assigned Modules" card in the client detail,
  grouped by category with per-category "Select all" (indeterminate when partial).
  Onboarding shows exactly two checkboxes — **Financial Picture Analysis** (the
  five FPA keys toggled as one; each checkbox carries its keys in `data-keys`)
  and **New Client Onboarding** (`onboardingWizard`). A box is checked when any of
  its keys is assigned; Save flattens/de-dupes all checked `data-keys`. Built once
  per selected client and NOT re-rendered on the 20s poll, so unsaved checkbox
  edits survive a refresh. Save POSTs and updates the local copy.

## Onboarding proof of concept (`/onboarding/`)
Standalone 12-step wizard (`public/onboarding/`), sample/test data only, clearly
labeled as a POC. Progress persists in localStorage AND syncs to the server:
`POST /api/onboarding/start` issues sequential ids (`BLA-ONB-YYYY-NNNN`, KV key
`onboarding_counter`), each step re-posts full state to
`POST /api/onboarding/:id` (KV `onboarding:<id>`, 100KB cap, id must exist).
These endpoints are UNauthenticated by design (POC users have no accounts) —
anyone can create test records; do not put real client data through it.
Admin page shows an "Onboarding Submissions" table (`GET /api/admin/onboarding`,
admin-session-gated) with per-record Details + print view. Client-side exports on
the confirmation page: contacts.csv, notes.csv, onboarding_summary.html,
audit_record.json.

**Signature capture (step 4):** the Advisory Agreement step has a drawable
signature pad (`<canvas>` + Pointer Events — mouse, trackpad, touch, pen). The
drawing is stored on the agreement record as a PNG data URL
(`agreement.signatureDataUrl`) alongside `typedName` and `signedAt`, restored
onto the canvas when navigating back, and rendered in the confirmation summary,
the `onboarding_summary.html` export, and the admin detail/print view. Advancing
is blocked until something is actually drawn. Sample data only — explicitly
labeled "not a legally binding signature." NOTE: the coordinate math divides by
the canvas's displayed width, so it only works when the canvas has non-zero
layout size (a normal browser); a 0×0 viewport yields a blank pad.

**Legacy data:** records saved before the module rework (top-level
`budget`/`riskAnswers`) are ignored by `loadModules()` — those were test data.
Clients from that era just see an empty dashboard.

## Security hardening done (quick fixes, "1–4")
- **Rate limiting** (KV fixed-window, per `CF-Connecting-IP`): login 10/5min,
  register 5/hr, onboarding-start 20/hr → 429 past the limit. KV is eventually
  consistent, so this is a brute-force speed bump, not a hard guarantee; layer
  Cloudflare native rate-limiting rules on top for production.
- **CORS locked down**: no longer reflects arbitrary origins. `resolveCorsOrigin()`
  only echoes the Worker's own origin (or entries in the optional `ALLOWED_ORIGIN`
  secret). `Allow-Credentials` dropped (auth is bearer-token, not cookies).
- **Onboarding write auth**: `/api/onboarding/start` issues a per-session
  `writeToken` (stored under `onboarding_secret:<id>`, never returned by admin
  endpoints, 30-day TTL). Every save must present it via `X-Onboarding-Token`.
  Closes the "anyone can POST to a guessed sequential id" hole. Frontend stores
  the token in localStorage; local-only fallback (id prefix `L`) still applies if
  `/start` fails (e.g. rate-limited).
- **Encryption at rest (client responses)**: `responses:<email>` records are
  encrypted with AES-256-GCM before being written to KV (`encryptJSON` /
  `decryptToObject` / `getDataKey` in `worker.js`). The key is derived (SHA-256)
  from the `DATA_ENCRYPTION_KEY` secret; stored envelope is
  `{v,enc:'aesgcm',iv,ct}` with a fresh random 12-byte IV per record. Reads
  transparently pass through legacy plaintext records, and a decrypt failure
  throws (→ 500) rather than returning `{}`, so a bad key never causes a save to
  silently overwrite good data. If `DATA_ENCRYPTION_KEY` is unset, records are
  written as plaintext (rollout state) — **set it before real client data**.
  Validated by a browser round-trip harness (Web Crypto matches the Workers
  runtime): round-trip, unicode, legacy passthrough, wrong-key/tamper both throw,
  unique IVs. **Not runnable via `dev-server.ps1`** (mock keeps data in-memory
  plaintext; encryption is worker-only and the API/frontend contract is
  unchanged). LIMITATION: key and data share one Cloudflare account, so this
  defeats a leaked KV export, NOT a Cloudflare-account compromise — MFA covers that.
- **Soft delete + restore**: admin Delete marks `deleted:true` with a 30-day TTL
  instead of destroying the record; a "Deleted (N)" trash table offers Restore
  (`POST /api/admin/onboarding/:id/restore`). Records auto-purge after the window.
- Added `timingSafeEqual()` for password-hash, admin-token, and write-token
  comparisons.

## Admin authentication (per-email login + sessions + audit log)
Replaces the single bearer `ADMIN_TOKEN` with a login system:
- **Accounts** are hardcoded in `worker.js` `ADMIN_ACCOUNTS` (email → secret
  name): `fsabin@` → `ADMIN_PASSWORD_FSABIN`, `jyoung@` → `ADMIN_PASSWORD_JYOUNG`.
  Each **password is per-person**, living only in its own Cloudflare secret
  (never in source or git). During rollout, login falls back to the legacy shared
  `ADMIN_PASSWORD` when an individual secret isn't set — delete `ADMIN_PASSWORD`
  in Cloudflare once both individual secrets exist to make passwords truly
  per-person. Set them with `wrangler secret put ADMIN_PASSWORD_FSABIN` (and
  `..._JYOUNG`), or in the Cloudflare dashboard.
- `POST /api/admin/login` `{email,password}` → finds the account by email and
  `timingSafeEqual(password, <that account's secret>)` (both trimmed), mints an
  `admin_session:<token>` KV entry (12-hour TTL), returns `{token,email}`.
  Rate-limited (`adminlogin`, 10/5min/IP). `POST /api/admin/logout` deletes the session.
- Every admin endpoint now calls `getAdminEmail(request, env)` (resolves the
  bearer token → session email) instead of comparing a static token; a missing/
  expired session → 401. The admin page (`admin.html`) has an email+password
  login card, shows "Signed in as <email>", persists the session in
  localStorage (`blueline_admin_session`), auto-restores on load, and logs out
  (clearing the server session so the old token is rejected).
- **Audit log**: `logAudit()` writes `audit:<ts>:<rand>` KV entries (~13-month
  TTL) on login, set-assignments, and onboarding delete/restore, each recording
  `{ts,email,action,detail}`. Write-side only so far — no viewer UI yet.
  (The local `dev-server.ps1` mirrors login/logout/session-gating with DEV-ONLY
  per-person passwords in `$adminPasswords` (`dev-fsabin-pass`/`dev-jyoung-pass`);
  it does not implement the audit writes, which have no frontend surface.)

## Known gaps / STILL NOT addressed (the "bigger lifts" — need real work)
- Admin has per-person login, sessions, and a write-side audit log, but there is
  still **no MFA**, **no audit-log viewer UI**, and no anomaly alerting yet.
  Revoking one person now means rotating only that person's secret (e.g.
  `ADMIN_PASSWORD_JYOUNG`) — as long as the legacy shared `ADMIN_PASSWORD` has
  been deleted from Cloudflare.
- **Encryption scope is partial**: client assessment responses are now
  AES-256-GCM encrypted at rest (see Security hardening), but `user:` records,
  `onboarding:` POC records, and the audit log are still plaintext, and the key
  lives in the same Cloudflare account as the data (so an account compromise
  still exposes everything). Broadening scope + key isolation is the next lift;
  the DIY crypto must be blessed by the professional security review.
- No data retention policy for client-portal PII. (Onboarding POC records now do
  auto-expire when soft-deleted, but active records never age out.)
- Not code: as an RIA handling client PII, a written information security program
  (WISP) under Reg S-P / GLBA is required — policies, incident response, vendor
  risk assessment for Cloudflare. Needs compliance counsel, not an engineer.
- Only one Cloudflare account/login in use (fsabin@blueline-advisors.com) — no
  documented succession/break-glass plan.
- Site is on the `workers.dev` subdomain, not a custom `blueline-advisors.com` domain.
- No Node.js on this machine — `worker.js` is not executed locally; it's verified by
  review and exercised via `dev-server.ps1`, which mirrors its logic (kept in sync).

## To continue in a new chat
Tell Claude: "Continue work on the BlueLine Advisors portal — read STATUS.md and
recent git log in C:\Users\joshu\Documents\blueline-portal for context."
