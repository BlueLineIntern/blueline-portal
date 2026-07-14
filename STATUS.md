# BlueLine Advisors Portal — Status

**Live site:** https://blueline-portal.fsabin.workers.dev/
**Admin view:** https://blueline-portal.fsabin.workers.dev/admin (needs the `ADMIN_TOKEN` secret set in Cloudflare)
**Repo:** https://github.com/BlueLineIntern/blueline-portal
**Local path:** `C:\Users\joshu\Documents\blueline-portal`
**Cloudflare account:** fsabin@blueline-advisors.com (Worker + Pages: project name `blueline-portal`)

## Architecture
Single Cloudflare Worker serves both the static frontend (`public/`) and the API
(`worker.js`), same origin — no CORS needed. Data lives in a Cloudflare KV
namespace called `PORTAL_KV`.

- `public/index.html` / `public/assets/style.css` / `public/assets/script.js` — client-facing login; after login users land on a **five-category home hub** (`view-home`): **Onboarding** (badge "For all new clients"; contains the Financial Picture Analysis five-assessment dashboard `view-dashboard` with x-of-5 progress, plus the New Client Onboarding link to `/onboarding/`), **Budgeting & Spending**, **Risk Assessment**, **Estate Planning**, **Insurance Planning**. Each of the four module categories opens a shared `view-category` section (x-of-3 progress, module cards). The 12 new module forms are generated at boot from a declarative `MODULE_FORMS` spec + form engine in script.js (section id `view-<key>`, form `<key>-form`, error `<key>-error`); FPA forms remain static HTML. After save, FPA modules return to the dashboard, category modules to their category view. Clients never see results — completed cards show a thank-you + Review/Edit; results render only in admin.
- `public/assets/render.js` — shared chart builders (`donutChart`, `riskGauge`, `projectionChart`, `balanceBars`, `statBar`), module metadata (`MODULES` = FPA five, `CATEGORY_MODULES` = 12 new, `CATEGORIES` = 5 categories), and per-module result renderers; loaded by both index.html and admin.html
- `public/admin.html` — internal staff view, gated by `ADMIN_TOKEN` secret (separate from client logins): a **"Client Submissions" dropdown** (Name — email) that renders the selected client's detail inline — "x of 17 modules completed", a staff Flags block (rollover opportunity, stock concentration, missing 401(k) match, negative cash flow), then all five category sections with rendered module results, and email-matched New Client Onboarding records linking to the onboarding detail view. Polling refresh preserves the selection. Print/Save PDF produces a branded per-client report (one module per page). The "New Client Onboarding Submissions" table (all records incl. anonymous, delete/restore/trash) is unchanged.
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

## Onboarding proof of concept (`/onboarding/`)
Standalone 12-step wizard (`public/onboarding/`), sample/test data only, clearly
labeled as a POC. Progress persists in localStorage AND syncs to the server:
`POST /api/onboarding/start` issues sequential ids (`BLA-ONB-YYYY-NNNN`, KV key
`onboarding_counter`), each step re-posts full state to
`POST /api/onboarding/:id` (KV `onboarding:<id>`, 100KB cap, id must exist).
These endpoints are UNauthenticated by design (POC users have no accounts) —
anyone can create test records; do not put real client data through it.
Admin page shows an "Onboarding Submissions" table (`GET /api/admin/onboarding`,
ADMIN_TOKEN-gated) with per-record Details + print view. Client-side exports on
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
- **Soft delete + restore**: admin Delete marks `deleted:true` with a 30-day TTL
  instead of destroying the record; a "Deleted (N)" trash table offers Restore
  (`POST /api/admin/onboarding/:id/restore`). Records auto-purge after the window.
- Added `timingSafeEqual()` for password-hash, admin-token, and write-token
  comparisons.

## Known gaps / STILL NOT addressed (the "bigger lifts" — need real work)
- `ADMIN_TOKEN` is still a single shared secret: no per-staff identity, no audit
  log of who viewed/exported/deleted what. This is the biggest structural gap.
- No data retention policy for client-portal PII, and no application-level
  encryption beyond Cloudflare's at-rest defaults. (Onboarding POC records now do
  auto-expire when soft-deleted, but active records never age out.)
- No access logging / anomaly alerting on admin endpoints.
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
