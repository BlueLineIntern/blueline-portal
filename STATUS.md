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
  name): `fsabin@` → `ADMIN_PASSWORD_FSABIN`, `jyoung@` → `ADMIN_PASSWORD_JYOUNG`,
  `intern@` → `ADMIN_PASSWORD_INTERN`.
  Each **password is per-person**, living only in its own Cloudflare secret
  (never in source or git). During rollout, login falls back to the legacy shared
  `ADMIN_PASSWORD` when an individual secret isn't set — delete `ADMIN_PASSWORD`
  in Cloudflare once all individual secrets exist to make passwords truly
  per-person. Set them with `wrangler secret put ADMIN_PASSWORD_FSABIN` (and
  `..._JYOUNG`, `..._INTERN`), or in the Cloudflare dashboard.
- `POST /api/admin/login` `{email,password}` → finds the account by email and
  `timingSafeEqual(password, <that account's secret>)` (both trimmed). Password is
  **not sufficient on its own** — it returns `{status:'mfa'|'enroll', pendingToken}`
  (10-min TTL `admin_pending:<token>`), never a session. Rate-limited (`adminlogin`,
  10/5min/IP). `POST /api/admin/logout` deletes the session.
- **MFA (TOTP, RFC 6238, mandatory)**: every admin signs in with a second factor.
  `POST /api/admin/mfa/enroll` `{pendingToken}` mints a 160-bit base32 secret +
  8 single-use backup codes (returns them once, with an `otpauth://` URI; refuses
  if a confirmed authenticator already exists). `POST /api/admin/mfa/verify`
  `{pendingToken,code}` accepts a TOTP (±1 30s step for clock skew) or an unused
  backup code, confirms enrollment on first success, then mints the
  `admin_session:<token>` (12-hour TTL) and returns `{token,email}`; also
  rate-limited. The per-admin record `admin_mfa:<email>` (secret + hashed backup
  codes) is stored **encrypted** (DATA_ENCRYPTION_KEY); a decrypt failure throws
  (fail closed — never read as "no MFA"). Backup-code hashes are SHA-256. TOTP
  (base32 + HMAC-SHA1 truncation) validated against the RFC 6238 test vectors.
  Admin page has "Enter code" and "Set up MFA" cards (secret shown for manual
  entry — no QR yet — plus backup codes); the mock mirrors the whole flow in
  memory (unencrypted) with matching TOTP so it's testable locally.
- **MFA recovery (admin-resets-admin)**: `GET /api/admin/admins` lists each admin
  account + whether MFA is set up; `POST /api/admin/mfa/reset/:email`
  (admin-session-gated, target must be in `ADMIN_ACCOUNTS`) deletes that admin's
  `admin_mfa:<email>` so they re-enroll on next login. Audit-logged as `reset-mfa`
  `{target}`. Admin page has an "Admin Accounts" card with per-admin MFA status
  and a Reset MFA button. So a locked-out admin (lost device + all backup codes)
  is rescued by the other admin — no Cloudflare dashboard needed. Last-resort
  manual recovery is still to delete `admin_mfa:<email>` in KV directly.
- Every admin endpoint now calls `getAdminEmail(request, env)` (resolves the
  bearer token → session email) instead of comparing a static token; a missing/
  expired session → 401. The admin page (`admin.html`) has an email+password
  login card, shows "Signed in as <email>", persists the session in
  localStorage (`blueline_admin_session`), auto-restores on load, and logs out
  (clearing the server session so the old token is rejected).
- **Audit log**: `logAudit()` writes `audit:<ts>:<rand>` KV entries (~13-month
  TTL) on login, set-assignments, and onboarding delete/restore, each recording
  `{ts,email,action,detail}`. Keys use an **inverted timestamp**
  (`audit:<14-digit (AUDIT_TS_CEILING - now)>:<rand>`) so the newest entry sorts
  first and the viewer reads with a single bounded `list({limit:50})` — cost is
  flat as the log grows, no full-namespace scan. (Legacy `audit:<ISO>` keys from
  before this change sort after the inverted ones and are re-sorted by `ts` in the
  response; they expire on their own.) **Viewer**: `GET /api/admin/audit`
  (admin-gated) → `{entries, limit, hasMore, cursor}`; pass the `cursor` back as
  `?cursor=` to page to the next (older) 10 (opaque KV cursor in the worker, a
  numeric offset in the mock; page size 10). The admin page has an "Audit Log"
  card (When / Admin / Action / Detail, newest first) loaded **once on entry and
  on manual Refresh only — deliberately NOT on the 20s poll**, since the log
  doesn't change live and polling it would burn Cloudflare reads per open tab. A
  **"Load older"** button appends the next page and hides itself when `cursor` is
  exhausted; Refresh collapses back to the newest page.
  (The local `dev-server.ps1` mirrors login/logout/session-gating with DEV-ONLY
  per-person passwords in `$adminPasswords` (`dev-fsabin-pass`/`dev-jyoung-pass`)
  and now also mirrors the audit writes + `/api/admin/audit` in memory so the
  viewer is exercisable locally.)

## Advisor CRM (multi-page admin app under /admin/)
The admin side is now a Wealthbox-inspired CRM. `admin.html` = login + MFA only
(redirects into `/admin/` on success); pages share `admin/shared.css` (modern
sans-serif design tokens, sidebar shell) + `admin/shared.js` (session guard,
authenticated `api()` wrapper, shell injection). Pages: Dashboard, Contacts,
Tasks, Onboarding, Settings (audit log + admin accounts). Client portal is
untouched and keeps its own look.

- **Contacts** (`contact:<email>` KV, **encrypted**): status
  (prospect/onboarding/active/inactive), household label, primary advisor (must
  be an admin), phone, tags, important dates. Contacts exist independently of
  portal accounts (prospects). `GET /api/admin/contacts` = one merged boot
  payload (contact records + `user:` accounts with modules/assignments;
  account-only entries default to `active`); `POST /api/admin/contacts/:email`
  upserts (partial), audit-logged as `update-contact`. **Archive** (soft-delete):
  `POST /api/admin/contacts/:email/{archive,unarchive}` sets `archived` +
  `archivedAt`/`archivedBy` (audit `archive-contact`/`unarchive-contact`); nothing
  is erased — tasks/notes/timeline stay intact. Archived contacts are hidden from
  the contacts working list (own **Archived** filter tab), the dashboard
  counts/alerts/queues, and global search; the profile has an Archive/Unarchive
  button. Route matched **before** the greedy upsert route so the `/archive`
  suffix isn't swallowed; upsert preserves the `archived` flag. UI: filter pills
  with counts, search, New/Edit Contact modal, tabbed profile (Overview,
  Assessments incl. assignment editor, Tasks, Notes, Timeline, Documents = signed
  agreements from linked onboardings, Activity Log = audit entries for this
  contact).
- **Tasks** (`task:<invTs>-<rand>` KV, **encrypted**): title, description,
  client, assignee (admin), **`list`** (board-column id, see below), due,
  priority (low/medium/high), category
  (follow-up/review/meeting/onboarding/compliance/other), status (open/done),
  createdBy, completedAt, plus **`checklist`** ([{id,text,done}]) and per-task
  **`history`** ([{ts,actor,type,detail}] — created/assigned/completed/reopened/
  comment), plus **`meetingType`** (a meeting-type label). (A `documents` field
  also exists in the schema but is currently unused by the UI — the calendar's
  "required documents" section was removed in favour of a single prep checklist.) CRUD under `/api/admin/tasks[/:id]`. The update endpoint appends
  history automatically on assignee/status changes and accepts a `comment` field
  (a note, appended as a `comment` history entry — not a task column). Completing
  a task also writes a `task-completed` (or `meeting-held`) client-timeline event.
  **Meetings are tasks** with category `meeting` — no calendar integration yet.
  **Assignees are admin accounts only** (Frank=fsabin, jyoung=Jenn, intern);
  validation returns 400 otherwise. The task UI lives entirely on the
  **Operations page** now (Board + List views — see below); the contact profile
  still has a Tasks tab with quick-add. Display names come from `staffLabel()`
  in shared.js.
- **Notes** (`note:<client>:<invTs>-<rand>` KV, **encrypted**): body (plain
  text), tags, pinned, author. CRUD under `/api/admin/notes[/:id]`
  (`?client=` filter). Creating one writes a `note-added` timeline event.
  Notes tab on the profile: composer + pinned-first list with pin/edit/delete.
- **Timeline / activity** (`logTimeline()`): dual-write — per-client
  `timeline:<email>:<invTs>-<rand>` (kept forever, the relationship record) +
  global `activity:<invTs>-<rand>` mirror (~13-month TTL) for the dashboard.
  Both **encrypted**; writes are best-effort (never break the triggering
  request). Events: account-created, login, assessment-completed/updated,
  onboarding-completed, agreement-signed, assignments-changed, task-completed,
  meeting-held, note-added. Reads: `GET /api/admin/timeline/:email` and
  `GET /api/admin/activity` (bounded newest-first pages + cursor, audit-style
  inverted-timestamp keys).
- **Auto-tasks** (`maybeAutoTask()`, dedupe marker `autotask:<rule>:<client>`):
  first completion of an assessment → "Review <module> assessment"; onboarding
  completion → "Review completed onboarding <id>"; agreement signature →
  "Open account - agreement signed (<id>)". Assignee defaults to the contact's
  primary advisor. Markers make replays (re-saves/retries) a no-op — verified.
- The dev mock mirrors all endpoints + hooks in memory (`$contacts`, `$tasks`,
  `$notes`, `$timelineLog`, `$autoTaskMarkers`). Two PS 5.1 gotchas encoded
  there: `[ordered]@{}` has `.Contains()` not `.ContainsKey()`, and em-dashes
  inside double-quoted .ps1 strings get mangled into string-terminating smart
  quotes when the file lacks a BOM — use plain hyphens.
- Real-worker verification: `worker.js` is exercised in a browser harness
  (module import + in-memory KV; harness files are gitignored) — CRM records
  confirmed encrypted at rest, auto-task dedupe confirmed, timeline dual-write
  confirmed.
- **Dashboard** (`/admin/`): greeting, stat tiles (Active/Prospects/Onboarding
  from contact statuses, Tasks Due Today, Overdue in red), one-click **work
  queue** chips (Assessments to review → `tasks.html?cat=review`, Onboarding to
  review, Unsigned agreements → onboarding page, Waiting on client → contacts,
  Overdue → `tasks.html?f=overdue`), and six widgets: Today's Tasks + Overdue +
  Upcoming Meetings + Waiting for Review (all with complete-from-dashboard
  checkboxes), Recent Client Activity (from the activity feed, linked to
  profiles), **Compliance Alerts** (rule-based, computed client-side: completed
  onboarding w/o signature, admin without MFA, active account clients with no
  recorded activity in 90+ days). 30s refresh.
- **Global search** (Ctrl/Cmd-K palette in `shared.js`, on every admin page):
  searches contacts (name/email/household/tags), tasks (title/description),
  notes (body/tags), and onboarding records; grouped results, arrow-key +
  Enter navigation, deep links (`contacts.html?c=&tab=`, `tasks.html?q=&f=`,
  `onboarding.html?id=`). Data loads lazily on first open and is cached per
  page view.
- **Notifications** (bell in the sidebar, every page): DERIVED, not stored —
  overdue open tasks (nag until completed) + activity entries newer than the
  per-admin `notif_seen:<email>` cursor (`GET/POST /api/admin/notifseen`).
  "Mark all read" advances the cursor; nothing is fanned out per event.
- **Board lists** (`board_lists` KV, **encrypted**): the board's columns are an
  editable, ordered list of `[{id: l-<hex>, type, account?, name?}]`. A **person**
  list is bound to an admin `account` (shows tasks assigned to them); a **custom**
  list is a named bucket (e.g. "Waiting on client") that tasks land in via
  `task.list`. `GET/POST/DELETE /api/admin/lists`; managed from the board's
  **"Lists"** modal (segmented Person/Custom add — Person picks from accounts not
  already added). Nothing auto-appears: the board is **fully manual** (chosen in
  design) — Unassigned + Completed are always present, everything else you add.
  Removing a list leaves its tasks intact — they fall into Unassigned
  (`columnForTask` maps unknown list/assignee there). Migrates the earlier
  `team_roster` members → custom lists on first read. (This replaces the
  short-lived non-login "team roster"; assignees are admin-only again.)
- **Operations** (`operations.html`, sidebar "Operations") is the single task
  workspace — the old separate Tasks page was merged in as a **List view**. A
  Board/List toggle switches between them; both are views over the same `task:`
  records. `tasks.html` is now a redirect stub → `operations.html?view=list&…`
  so every old link (dashboard queues, search palette, contacts "full task
  manager") keeps working. **List view**: quick filters (My/All Open/Due
  Today/This Week/Overdue/Completed) + client/assignee/priority/category filters
  + search + rows with complete/edit/delete (edit opens the same drawer).
- **Operations board** view: a Kanban **view over the same `task:` records** — no
  second store. Columns are the board lists you've added + Unassigned + Completed.
  `columnForTask`: done→Completed; a custom-list placement (`task.list`) wins;
  else the person list matching `task.assignee`; else Unassigned. Native HTML5
  drag-and-drop: drop on a person → `POST {assignee, list:'', status:'open'}`;
  drop on a custom list → `POST {list, status:'open'}` (assignee kept); drop on
  Completed → `{status:'done'}`; drop on Unassigned → clears both. Compact cards
  show priority dot, colour-coded due, client, and checklist progress bar. **+ Add
  Card** per column (prefills that column's assignee or list) and clicking a card
  opens a reusable **slide-out drawer** (`.drawer` in shared.css) to edit every
  field (incl. an assignee dropdown and a List dropdown), manage the checklist
  (toggles auto-save), add notes, and read history. Board filter pills (All/Mine/
  Due Today/This Week/Overdue) with `?filter=` deep-link. Drag-and-drop is
  desktop-grade; on touch the drawer's dropdowns are the fallback.
- Dashboard has an **Operations widget** (My tasks today / Overdue / Due this
  week) linking into the board via `?filter=`.
- **Calendar** (`calendar.html`, sidebar "Calendar") — a third view over the same
  `task:` records (alongside Board + List). Any task with a `due` date appears;
  meetings are tasks with `category: 'meeting'`. **Month/Week/Day/Agenda** views
  (Week/Day are day-column lists, not an hour grid). Click a day → create;
  clicking an item opens the meeting **slide-out panel** (client, advisor,
  date/time, meeting type, notes, related tasks for the client, a single
  **preparation checklist** = `checklist`, notes/history = comments) — all
  editing the existing task, no duplicate records. **Meeting type** is a plain
  label (Initial Consultation / Annual Review / Investment Review / Retirement /
  Tax Planning); it does NOT auto-fill the checklist or title — you build your
  own prep list. Calendar items are **colour-coded by prep readiness**: no prep
  items = blue, some outstanding = red, all done = green (`prepStatus()`).
  Deep links: `?view=`, `?date=YYYY-MM-DD`, `?task=<id>` (auto-opens the panel).
  The dashboard **Upcoming Meetings** widget shows client, time, prep readiness,
  and the client's open-task count, linking to the meeting in the calendar.
  (No hour-grid, recurring meetings, calendar sync, or document upload yet.)
- `contacts.html` honors `?c=<email>&tab=<tab>`. `operations.html` honors
  `?view=<board|list>`, `?filter=<today|week|overdue|mine>` (board pill), and
  `?f=<quick filter>&cat=<category>&q=<search>` (list; presence of any implies
  `view=list`). `tasks.html` is a redirect stub preserving these params.

## Known gaps / STILL NOT addressed (the "bigger lifts" — need real work)
- Admin has per-person login, sessions, mandatory TOTP MFA (with admin-resets-
  admin recovery), and an audit log with a viewer, but there is no anomaly
  alerting yet, and if BOTH admins are simultaneously locked out recovery still
  needs `admin_mfa:<email>` deleted in KV. Revoking one person now means rotating only that person's secret
  (e.g. `ADMIN_PASSWORD_JYOUNG`) — as long as the legacy shared `ADMIN_PASSWORD`
  has been deleted from Cloudflare. Clients have no MFA (deliberate — a
  compromised client login exposes only that one client's data).
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
