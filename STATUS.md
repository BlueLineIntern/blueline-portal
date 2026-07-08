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

- `public/index.html` / `public/assets/style.css` / `public/assets/script.js` — client-facing login, five onboarding assessment modules, dashboard with SVG charts
- `public/assets/render.js` — shared chart builders (`donutChart`, `riskGauge`, `projectionChart`, `balanceBars`, `statBar`), module metadata (`MODULES`), and per-module result renderers; loaded by both index.html and admin.html
- `public/admin.html` — internal staff view, gated by `ADMIN_TOKEN` secret (separate from client logins): summary table of all clients plus a per-client "Details" view that renders the client's full dashboard (same charts/flags the client sees, via render.js)
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

Admin table shows per-module key stats plus a Flags column (rollover opportunity,
stock concentration, missing 401(k) match, negative cash flow).

**Legacy data:** records saved before the module rework (top-level
`budget`/`riskAnswers`) are ignored by `loadModules()` — those were test data.
Clients from that era just see an empty dashboard.

## Known gaps / flagged but not addressed
- No rate limiting on login/register.
- No data retention policy or encryption beyond Cloudflare defaults for client PII
  (names, emails, compensation, net worth, risk answers) in KV. The portal now
  collects substantially more sensitive data (salary, equity, net worth) than before.
- `ADMIN_TOKEN` grants full read access to all client data, no per-user audit log.
- Only one Cloudflare account/login in use (fsabin@blueline-advisors.com) — no
  documented plan for what happens to account ownership if that changes.
- Site is on the `workers.dev` subdomain, not a custom `blueline-advisors.com` domain.
- No Node.js on this machine — `worker.js` is not executed locally; it's verified by
  review and exercised only once deployed. The mock server duplicates its math.

## To continue in a new chat
Tell Claude: "Continue work on the BlueLine Advisors portal — read STATUS.md and
recent git log in C:\Users\joshu\Documents\blueline-portal for context."
