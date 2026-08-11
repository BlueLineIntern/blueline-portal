# BlueLine Advisors Portal — Status
<!-- diagnostic no-op: forcing an isolated Workers Build to rule out a deploy race across the last three rapid-fire pushes -->

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
admin-session-gated) with per-record Details + **Print / Save PDF** view. The
print stylesheet (`@media print` in shared.css) paginates the onboarding document
cleanly: each `.onb-section` uses `break-inside: avoid` so sections never split
across a page, the sidebar/actions/detail-header are hidden, and the branded
print-header carries the client + record id + date. Client-side exports on
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

**Signed agreement PDF** (`public/assets/sign-agreement.js`): the captured
signature is stamped onto the real agreement document
(`public/onboarding/advisory-agreement.pdf` — 2 pages, US Letter 612×792) and
offered as a download in two places: the wizard's confirmation step (the client's
own copy) and each Advisory Agreement panel on a contact's **Documents** tab in
admin (the firm's copy). One module drives both, so the two cannot disagree.
- **Generated on demand, never stored.** Built in the browser from the signature
  already on the onboarding record, so there is no second copy of a signed
  agreement in KV or SharePoint to go stale when a template or a signature
  changes. Not *byte*-identical between the two callers — pdf-lib names its
  XObjects with a random suffix — but the same template, placement and rendering.
- **The coordinates come from the template's own content stream**, not from
  measuring a screenshot: page 2 draws the grey signature box with
  `50.8 158.35 496.75 120.05 re f*`, and its text baselines are 257.15 (the
  printed client name), 223.75 (`Signature: ____`) and 184.35 (`Date: ____`).
  pdf-lib uses a bottom-left origin, so the signature is placed at (125, 226)
  contained to 240×26pt and the date at (100, 187.35). **The 26pt height cap is
  the binding constraint** — it is the only thing keeping the signature from
  colliding with the printed name 33pt above the rule, which is why it is a cap
  and not a target. **Re-exporting the agreement PDF invalidates every one of
  these numbers**; they are specific to this file.
- **The signature is cropped to its ink bounding box before stamping.** The pad is
  a fixed 600×180 bitmap that the ink rarely fills, and stamping it untrimmed
  scales the real signature down to an illegible sliver. Alpha is a sound ink test
  because the pad only ever `clearRect()`s its background — which is also why the
  stamp doesn't paint a white box over the underscore rule. Antialiasing is
  excluded with an alpha > 8 threshold; > 0 would defeat the crop.
- **pdf-lib 1.17.1 is vendored** at `public/assets/vendor/pdf-lib.min.js` (512KB)
  rather than installed: there is no `package.json` here and `worker.js` deploys as
  a plain ES module with no bundling step, so an npm import would mean introducing
  a build pipeline that cannot be tested on this machine (no Node, and workerd has
  no win32-arm64 build). It is a static asset under `public/`, so it does **not**
  count against the Worker script-size limit, and it is lazy-loaded on first click
  rather than on every page load of the wizard and the contact profile.
- `dev-server.ps1` needed `.pdf` added to its MIME map; prod already handled it,
  since `serveAsset` delegates to `env.ASSETS.fetch`.
- **The client's typed name replaces the template's printed sample name.** The
  template prints "Jeannette Smith" at baseline 257.15, which would otherwise
  contradict the signature beneath it. A rectangle in the box's own `#F7F7F7`
  fill covers it and the real name is drawn on top in Times-Bold 10.5 at the same
  baseline, shrinking to fit (7pt floor) when long. Drawn **before** the
  signature, so the patch can never erase it. Times, not Helvetica, throughout:
  the document is set in NotoSerif and a sans-serif fill-in reads as a different
  document. The name comes from `resolveClientName()` — `agreement.typedName`,
  then profile first + last, then `profile.name`, then `consent.name` — and
  **both callers go through that one function**, so the client's copy and the
  firm's copy cannot show different names for one signature. An unresolvable name
  leaves the template untouched rather than printing a blank.
  - **The cover is visual only.** The sample name is still in the page's text
    layer, so a text extractor (or copy-paste out of the PDF) still yields
    "Jeannette Smith". Acceptable for a labelled proof of concept; for anything
    real, re-export the template with no name rather than covering one.
  - It assumes that line is flat grey with nothing else on it. Give the box a
    border, a pattern or a second column and the patch becomes visible.
  - Names are **sanitised for WinAnsi** first, because pdf-lib's standard-14 fonts
    THROW on any character outside it — one autocorrected apostrophe would
    otherwise fail the entire download. Typographic punctuation is transliterated
    (’ → ', em dash → -), letters WinAnsi already covers are left intact (é, ü,
    ñ, ø, æ, þ, ß), and stroked/ligature letters that do **not** decompose under
    NFD are mapped explicitly (Ł → L, Đ → D, ı → i, Œ → OE). That last part is
    not theoretical: NFD folding alone silently deleted them, turning Łukasz into
    "ukasz" — losing the first letter of a client's name. Non-Latin scripts have
    no ASCII equivalent and are dropped, since a standard font cannot render them.
- Still a **proof of concept, deliberately**: the onboarding endpoints are
  unauthenticated by design (see above), so a signature here has **no signer
  attribution**, and the stamped PDF carries no tamper evidence — a PNG in a PDF
  can be swapped by anyone holding the file. It is not a legally binding
  signature and must not be relied on as an executed agreement. Making it real
  means either a proper e-sign provider (DocuSign/Adobe Sign, which is what the
  certificate and audit trail are actually bought for) or moving the agreement
  step behind the **existing authenticated client login**, which would take
  attribution from nothing to session + account + timestamp. Under Advisers Act
  Rule 204-2 an executed advisory agreement is a books-and-records item, so this
  needs compliance sign-off, not just code.

**Filing the signed agreement into SharePoint**: each Advisory Agreement panel
on a contact's Documents tab also has a **"File to Client Documents"** button,
which pushes the generated PDF into the same SharePoint library and family/
person folder as a manual attachment — `resolveClientDocFolder` decides which,
exactly as it already does for everything else on that tab.
- **No new server-side code.** This calls the *same* two endpoints the manual
  Attach flow already uses (`/api/admin/contacts/:email/documents/upload` then
  `/api/admin/client-documents/chunk`), feeding a `Blob` wrapping the generated
  PDF bytes through the identical chunking loop a `File` input already used —
  `Blob` and `File` share `.size` and `.slice()`, so no new upload code was
  needed, only a new caller.
- **Filed by filename, not by name**, to detect "already filed": the display
  name can be edited afterwards (rename is a KV-only op), but the filename is
  deterministic from the onboarding id, so the check survives a rename. Once
  filed, the button becomes a "Filed ✓" note instead of disappearing outright —
  a click is deliberate, never automatic on every save, so an autosave storm
  can't file duplicate copies of one signature.
- Hidden entirely (not shown-and-erroring) when `SHAREPOINT_CLIENT_DOCS_LIST_ID`
  isn't set — same rule as the Download button being absent with no signature.
  **Not exercisable against the not-configured guard locally**: the mock has no
  such check at all (always answers as configured), so that error path is
  confirmed by reading the code on both ends (`shared.js`'s `api()` throws
  `data.error` verbatim; the worker returns exactly `"SHAREPOINT_CLIENT_DOCS_LIST_ID
  is not set"`), not by running it.
- Verified against the mock end to end, including **both folder branches**: a
  contact with no household files under their own name (`Smith, Jeannette`); the
  same contact added to a household then files a second agreement under the
  family name (`Smith Family`) — and the first file did **not** retroactively
  move, matching the documented "a folder is never renamed after the fact" rule
  above.

**Auto-filing at the moment of signing (no admin click at all)**: the instant a
client's signature transitions from absent to present — the same
`nowSigned && !prevSigned` check `agreement-signed` already used — the server
itself generates the signed PDF and pushes it to SharePoint, before any admin
ever opens anything. `autoFileSignedAgreement()` in `worker.js`, wired into
`handleOnboardingSave` via `ctx.waitUntil()` so it runs in the background and
can never delay or fail the client's own save request.
- **This repo's first-ever npm-sourced import into `worker.js`.** Every previous
  feature here was either handwritten or (for browser code) a vendored UMD
  script tag — `worker.js` itself has never imported a package. `pdf-lib`'s real
  **ESM** build (`vendor/pdf-lib.esm.min.js`, confirmed zero imports of its own —
  every dependency already inlined) is imported by a **relative path**
  (`./agreement-pdf-worker.js` → `./vendor/pdf-lib.esm.min.js`), deliberately
  never a bare specifier like `'pdf-lib'`. A relative import needs no
  `package.json`, no `node_modules`, no npm install step — Cloudflare's bundler
  walks it from disk the same way it walks any other relative import in this
  file. A bare specifier would need dependency resolution this repo has no
  mechanism for.
- **Separate implementation from `public/assets/sign-agreement.js`, not a
  shared one** (`agreement-pdf-worker.js`, repo root, outside `public/` so it's
  never served to a browser). The browser file uses `Image`/`canvas`/`document`;
  none of that exists in the Workers runtime. The GEOMETRY constants and the
  name-sanitization table (`LETTER_SWAPS`, punctuation transliteration) are
  copied verbatim between the two files, each with a comment pointing at the
  other — **a template layout change has to be applied by hand in both
  places**, or the client's own download and the auto-filed copy will silently
  drift apart.
- **Known, deliberate gap: no ink-crop server-side.** The browser version crops
  the signature to its ink bounding box by reading canvas pixel alpha; nothing
  in the Workers runtime can decode a PNG's pixels without a hand-rolled
  decoder, which would have been a second unverifiable risk stacked on top of
  the first (this repo's first bundled import) in the same deploy. The
  auto-filed copy therefore embeds the full untrimmed 600×180 signature pad,
  contain-fit into the same box — legible in every case tested, but a
  signature occupying only a small part of the pad renders smaller in the
  auto-filed copy than in a manually-downloaded one. Real fix, not done here:
  either move the crop to capture time (store an already-cropped image so every
  consumer, including this one, needs no cropping logic at all) or write a real
  PNG alpha decoder — flagged here as a follow-up, not silently accepted.
- **Cannot be bundled or executed locally before deploy.** Node itself DOES run
  on this machine (`node --check` genuinely parsed both `worker.js` and
  `agreement-pdf-worker.js` clean — real verification, not visual inspection),
  but `wrangler`/`workerd` cannot install: the shell layer reports `x86_64`, but
  the actual Node install underneath is `win32 arm64`, and workerd has no
  win32-arm64 build (confirmed directly — `npm install wrangler` fails with
  `Unsupported platform: win32 arm64 LE` inside workerd's own installer). So the
  syntax is genuinely confirmed correct; the actual Cloudflare bundling step
  (resolving the relative imports, producing a working Worker) is not, and
  cannot be locally. The Cloudflare fact that makes shipping this without that
  survivable: **Workers Builds does not roll forward on a failed build** — a
  bundler error fails the *build*, and the previous deployment keeps serving.
  That claim is a documented characteristic of the platform, not something
  confirmed against this repo's specific dashboard config, and there is no
  dashboard access from here to read the actual build log if it ever does fail
  — only the live site's behavior is checkable, which proves a deploy landed,
  never *why* one didn't.
- **Idempotent by filename, not by event count.** The filename is deterministic
  from the onboarding id, so a client who clears and re-signs re-fires this
  whole function — and the existing `clientdoc:` KV record is **updated in
  place** (same id, `uploadedAt` preserved, `updatedAt` advanced), never
  duplicated; Graph's `conflictBehavior=replace` does the equivalent on the
  SharePoint side. Verified against the mock: a clear-then-resign on one record
  produced exactly one document, and a second record's document was untouched.
  (Timeline entries are a separate matter — `logTimeline`/`Write-Timeline` never
  dedupes, by existing design, same as the pre-existing `agreement-signed`
  entry it sits beside; multiple timeline entries for one document is expected,
  not a bug.)
- **A third document source, `system`** (distinct from `admin`/`client`) — the
  existing manual attach flow credits an admin, a client send-in credits the
  client; this credits neither, since nobody picked a file. Documents tab shows
  it with a green "auto-filed at signing" badge and "auto-filed \<date\>" instead
  of "attached by \<admin\>"; the Timeline tab's actor-suppression already
  excluded `'system'` before this feature existed, so "by system" never leaks
  into either view.
- **The manual "File to Client Documents" button still exists, deliberately.**
  It is the fallback for every agreement signed before this feature shipped
  (their `nowSigned && !prevSigned` transition already happened, so auto-filing
  never fires for them) and the retry path if the automatic filing ever fails
  silently in the background.
- Guarded the same way the manual button is: skips entirely, no error, when
  `SHAREPOINT_CLIENT_DOCS_LIST_ID` isn't set.
- **Real-Graph-unverified**, same category as Emails/Meetings/Learning above:
  no Azure credentials in this environment to run the actual Graph PUT against
  a live SharePoint drive. Verified here: the trigger condition, the
  find-or-update dedup logic, and the frontend rendering — all against the
  mock's simulated *outcome* (`Invoke-MockAutoFileAgreement` in
  `dev-server.ps1`, which fabricates a plausible record rather than running any
  real PDF/Graph code — PowerShell cannot execute `agreement-pdf-worker.js` or
  `pdf-lib` at all). NOT verified: that `PDFDocument.load()`/`embedPng()`/
  `embedFont()` actually succeed against the real template in the real Workers
  runtime, and that the Graph PUT's URL/query-param shape
  (`.../content?@microsoft.graph.conflictBehavior=replace`) is accepted as
  written — first real signature against a live, Graph-connected deployment is
  the actual test.

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
Tasks, Calendar, Onboarding, Learning, Settings (audit log + admin accounts).
Client portal is untouched and keeps its own look.

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
  with counts, search, New/Edit Contact modal, tabbed profile in the advisor's
  working order — **Overview, Notes, Tasks, Emails, Meetings, Timeline, Activity
  Log, Documents, Additional Info | Assessments** (incl. the assignment editor).
  The divider separates what's looked at on every visit from the record opened
  deliberately.
- **The Onboarding tab is switched OFF, not removed** (`SHOW_ONBOARDING_TAB =
  false` in contacts.html, hidden on request 2026-08-06). Flip that one constant
  to `true` and it returns on both the person and the family/company profile
  with nothing else to change — buttons, panels, renderers and the
  `?tab=onboarding` deep link are all still in place. While off: the two tab
  buttons are hidden, `?tab=onboarding` falls back to Overview (rather than
  opening a tab with no visible way to leave it), the renderers are skipped so a
  profile draw and every 20s poll do no wasted work, and the **"View Onboarding"
  / "Full record →" controls become links to `/admin/onboarding.html?id=…`**
  instead of tab jumps — they stay live rather than becoming dead buttons.
  Onboarding *data* is untouched: the Onboarding page, the submissions, the
  auto-tasks and the signed agreements shown on the Documents tab all still work.
- **Emails** (no storage — `fetchClientEmailHistory()` in worker.js) is a LIVE
  read of a client's email history via Microsoft Graph, fetched fresh every time
  the tab is opened and never written anywhere. Needs the same app registration
  as the SharePoint/calendar sync (`OUTLOOK_CLIENT_ID`/`SECRET`/`TENANT_ID`) plus
  the **`Mail.Read` Graph APPLICATION permission with admin consent** — a
  separate grant from `Calendars.ReadWrite.All`, so a firm that already has
  Meetings working still needs to add this one explicitly.
  - **There is no "search every mailbox at once" endpoint at this permission
    tier.** Graph mail search is always scoped to one specific mailbox
    (`/users/{mailbox}/messages`), so this queries **every current admin
    account's mailbox** (`allAdminEmails()` — the same dynamic list Settings
    manages, not a hard-coded name list) and merges the results client-side,
    deduped by `internetMessageId` (one message CC'd to two admins is found
    twice, once per mailbox). Confirmed with the firm: single-domain tenant, no
    Application Access Policy scoping `Mail.Read` down further — "every admin
    mailbox" is the intended full scope, not a fallback approximation of it.
  - **Search is two-stage, and the second stage is the one that matters.**
    Stage 1 finds candidates with `$search` (not `$filter`: Graph's `/messages`
    can only `$filter` by sender, never by recipient, so a filter-only approach
    would silently miss every email the client *received*). It prefers
    `participants:<addr>` KQL, which restricts matching to the people on the
    message, and falls back to a plain term search if the tenant rejects that
    shape — a 401/403 breaks out instead of retrying, so a permission failure
    still reads as "not authorized" rather than as a bad query. Stage 2,
    `messageParticipants()`, **drops any result whose
    from/sender/to/cc/bcc/replyTo doesn't actually contain the address.**
    `$search` scores on message *text*, so it returns mail that merely quotes an
    address — a forwarded thread, a signature block, a statement listing it. The
    first version shipped without this gate, as an "accepted tradeoff", and it
    showed up in production as unrelated mail under a client. The gate runs on
    the response rather than being trusted from the query, so it holds whichever
    search shape ran; `$top` is deliberately generous (100) because the gate
    discards part of every page. `$orderby` cannot be combined with `$search`, so
    Graph returns relevance order and the merge re-sorts by date.
  - `internetMessageId` is in the `$select` because dedupe keys on it — each
    mailbox's copy of one message has its own `id`, so deduping on `id` keeps
    both copies. It was missing from the original `$select`, which silently
    defeated the dedupe for anything CC'd to two admins.
  - **Three distinct states, not two.** "Not connected" (the Outlook app
    registration itself isn't configured) is different from "not authorized"
    (registration exists, but `Mail.Read` was never consented to — every
    mailbox query 403s) — collapsing them would send someone chasing the wrong
    setting. A per-mailbox failure that ISN'T total (one admin's mailbox down,
    others fine) surfaces as a "results may be incomplete" banner rather than
    either error state, so a partial result never silently reads as complete.
  - **Nothing is cached or stored — by design, not omission.** A client's email
    is exactly the kind of data that shouldn't have a second copy sitting in
    this app's KV once nobody's looking at it. The tab only re-fetches when
    actually opened (same on-demand pattern as Additional Info/Documents), not
    on the 20s background poll, and the frontend skips a re-fetch if the tab is
    just switched away from and back for the same contact.
  - **Every view is audit-logged** (`view-client-emails`: client + result count,
    never message content) — worth having given `Mail.Read` (application)'s
    tenant-wide reach once granted, same reasoning as the field-names-only audit
    entry on Additional Info.
  - Real-Graph-unverified, like the Learning and Client Documents uploads: no
    Azure credentials in this environment to test the actual `$search` query
    against a live mailbox.
- **Attached client documents** (`clientdoc:<email>:<invTs>-<rand>` KV,
  **encrypted**) sit at the TOP of the Documents tab, above the signed
  onboarding agreements: the agreements are a fixed historical record, this is
  the part that gets added to. Attach with a display name; rename and delete
  from the row.
  - **Bytes and metadata live in different stores.** The file goes to a
    SharePoint document library ("Client Documents"), filed under the client's
    **family folder** (see below), through the same chunked upload-session
    machinery the Learning tab uses — `POST /api/admin/contacts/:email/documents/upload`
    then `PUT /api/admin/client-documents/chunk` in 5 MiB slices, capped at
    250 MB. The **display name, original filename, size, who attached it and
    when, the folder it went into, and the webUrl** live in KV.
  - **Folder naming** (`resolveClientDocFolder`) makes the library's Name column
    read like a filing cabinet instead of a list of mailboxes. First match wins:
    1. the **family** the contact belongs to → the family's name
       (`Smith Family`); a *company* grouping deliberately does not count;
    2. no family → the contact's **own name, surname first** (`Smith, John`),
       inferred from the single free-text `name` field, since contacts have no
       surname field. Particle, suffix and title lists keep
       "Mary Van Der Berg" out of a `Berg` folder and "John Smith Jr." out of a
       `Jr.` one;
    3. no name on record → the **email**, which is what every client used to get.
  - Neither family names nor person names are unique, and a shared folder would
    **commingle unrelated clients' records** — a compliance problem, not a
    tidiness one. So when a name has more than one holder, the **oldest holder
    keeps the clean folder** it has been writing into and later ones get their id
    appended (`Smith Family (hh-bbb222)`, `Smith, John (jsmith@b.com)`).
    Resolved per upload rather than stored on the contact: nothing here renames a
    SharePoint folder, so a stored value would only go stale.
  - Because of that, **a folder is never renamed after the fact.** Rename a
    family, move a contact between families, or change their email, and *new*
    uploads go to the new folder while earlier files stay where they are. The
    `folder` field on each document record is what makes it possible to tell
    where an older file actually landed without asking Graph; records written
    before that field existed have none and predate family folders entirely.
    **Folders named by email from before this change were left in place** — no
    migration was run, so the library reads as a mix until they are moved by hand
    in SharePoint.
  - That split is the point: **no custom SharePoint column has to exist for
    naming to work**, listing a client's documents costs no Graph call at all,
    and a rename is a KV write instead of a PATCH that can fail against a column
    that isn't there. SharePoint still holds the file, so the firm's existing
    retention and backup policy covers client records rather than a second store
    having to. The name links straight to SharePoint's viewer — it already
    handles preview, range requests and permissions for every format.
  - Deleting removes the KV record **and** the SharePoint file (recoverable from
    its recycle bin). A Graph failure still drops the metadata and reports
    `fileDeleted: false`; the alternative is a row that can't be removed at all.
  - Needs `SHAREPOINT_CLIENT_DOCS_LIST_ID`. Unset → `configured: false` and the
    panel names the missing setting instead of looking broken.
- **Additional Info** (`clientinfo:<email>` KV, **encrypted**) — the
  suitability/KYC block: employment, written-agreement offering dates (ADV, CRS,
  privacy, fee/IPS/FP), investment profile, estimated net worth, estimated tax,
  health, and identifying documents. `GET`/`POST
  /api/admin/contacts/:email/info`, audit-logged as `update-client-info`.
  - **Its own record, not fields on the contact**, for two reasons. Privacy: it
    holds passport, green-card and driver's-licence numbers and medical notes,
    which on the contact record would ride in the `/api/admin/contacts` boot
    payload for *every* contact on every page load and every 20s poll — separate
    means it is fetched only for the client actually being looked at, when the
    tab is opened. And the contact record round-trips through the SharePoint
    Contacts sync, which has no columns for any of this.
  - **The audit entry records field NAMES only, never values.** The audit log has
    a 13-month TTL and its own viewer; copying passport numbers and medical
    notes into it would spread that material for no investigative gain.
  - **Estimated Net Worth and Estimated Liquid Net Worth are derived, never
    stored** (`clientInfoDerived()`): net worth = Assets + Non Liquid Assets −
    Liabilities, liquid = Assets − Liabilities (Assets means *liquid* assets).
    Two places holding the same number is one place for them to disagree. They
    stay read-only in edit mode and always render a figure — `$0.00` on an empty
    balance sheet is the answer, not a missing value; every other empty field
    reads **Not Set**.
  - One `AI_SECTIONS` spec drives the read view, the edit form and the save
    payload — with ~40 fields, three hand-maintained lists would drift within a
    week. Server-side: dates must be real `YYYY-MM-DD`, money parses `$`/commas
    and rounds to cents (negative allowed — an underwater balance sheet is a real
    answer), enums are validated against fixed lists, and validation builds a
    separate object so **a rejected save writes nothing at all**. The tab is in
    `POLL_SKIP_TABS`: its edit mode holds a whole form of unsaved input.
  - Date-only fields are formatted from their own parts, not via `fmtDate()`:
    `new Date('2026-03-01')` is UTC midnight, which renders as the day before in
    every US timezone.
- **Families and companies** (`household:<id>` KV, **encrypted**, id `hh-…`): a
  grouping of people advised together. Its own record, not the free-text
  `household` label that rides on a contact — it holds a name, members with
  roles, a shared email, status, tags and background. Keyed by generated id, not
  email: a grouping has no mailbox of its own. CRUD under
  `/api/admin/households[/:id]` (audit `create-household`/`update-household`/
  `delete-household`); deleting one keeps every member's contact record.
  - **`kind` discriminates family from company** — same record, same endpoints,
    same SharePoint mirror. A second entity would have duplicated all of that to
    express what is only a label and a role list. Roles: family = head/spouse/
    partner/child/dependent/other, company = primary/owner/officer/employee/
    other (`rolesForKind()`). A role the kind doesn't have is stored as `other`
    rather than rejected, which is also what makes changing a record's kind
    non-destructive.
  - **`kind` is NOT pushed to SharePoint.** The Households list has no Kind
    column and Graph fails the whole PATCH on an unknown field, which would
    break the mirror for every grouping. It is app-side only, like a contact's
    `importantDates`. Records written before `kind` existed have none and are
    normalized to `family` on read (one place: `handleAdminListHouseholds`).
  - **List UI is an accordion.** Each family/company is a header row; its
    members render nested underneath when expanded, and a person inside a
    visible grouping is *not* also shown at the top level (the same contact
    twice reads as two records). Open state lives outside the render so the 20s
    background poll can't collapse what was just opened. A search or tag filter
    force-opens every grouping in view — otherwise searching a member's name
    appears to return nothing — and disables Expand all while it's on.
    "People only" renders no groupings, so everyone appears flat there.
  - **Type is colour-coded three ways** (colour alone would fail anyone who
    can't separate the hues): glyph + avatar colour + a type badge, with a key in
    the toolbar. Person = sky (already the name-link colour, so people read as
    the default), family = green, company = violet. A grouping's block carries
    its colour as a left bar down every row, which is what marks where one
    grouping's members end. A person's profile shows the same colour-coded chip
    for each grouping they belong to, with their role, linking to its form.
  - The list count counts **records in view, not rows on screen** — members
    inside a collapsed grouping are still in view. CSV export likewise contains
    every visible person, so the file doesn't depend on which carets were open;
    its `Type` column reads Person/Family/Company.
  - **A grouping has its own profile** (`#group-view`, deep-linked `?hh=<id>`),
    with the same tab strip a person has — Overview, Notes, Tasks, Emails,
    Meetings, Timeline, Activity Log, Documents, Additional Info | Assessments
    (plus Onboarding, currently switched off with the person's — see
    `SHOW_ONBOARDING_TAB`) — where **every tab shows the union of its members'
    data**, each
    row attributed to the member it belongs to and linking to that person.
    Clicking a grouping's **name** in the list opens it; the caret and the rest
    of the row still toggle the accordion, and **Edit moved into the profile
    header** (the toggle is worth more on the row than a second edit affordance).
    A person's family/company chip now opens this profile too, and Back from a
    member returns to the grouping rather than the full list.
  - **Nothing is stored against the grouping itself.** Notes and tasks are keyed
    by a client *email* server-side (`isValidEmail` on both), so anything written
    from this view is attributed to a member picked explicitly — the picker sits
    next to the control with "a note belongs to a person, not a family" spelled
    out. Members without a contact record are listed in the roster (the grouping
    does claim them) but are **excluded from those pickers**, since there is no
    record to attach to. Writable: Notes, Tasks (plus the live done-checkbox,
    which needs only a task id), Documents (filed under the chosen member).
  - **Read-only, by deliberate choice, not omission:** Meetings (scheduling needs
    a type, advisor and prep checklist — the calendar owns that form, and each
    row links into it); Assessments (a summary per member, because a
    three-member family would otherwise render dozens of charts on one tab);
    Additional Info (individual answers — occupation, licence, health — where a
    form writing to several records at once would be a foot-gun); Onboarding.
  - **Additional Info adds one thing no member's record holds**: a combined
    balance sheet, summed from the same three inputs the per-person derivation
    uses so it cannot disagree with them. Members with nothing recorded
    contribute zero, which the panel says out loud.
  - **The combined Timeline has no "load older"** — paging N member cursors in
    step would interleave wrongly, so it shows the most recent 80 merged and
    says so, pointing at a member for their full history.
  - **Cost note:** Emails is the expensive tab — one request per member, each
    fanning out across every staff mailbox server-side. Every fetch-backed tab is
    in `GROUP_POLL_SKIP_TABS`, so the 20s poll re-renders the header only and
    never silently re-issues those calls.
  - Not yet: no UI to convert a family into a company, and a grouping has no
    print/PDF report of its own.
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
  (No hour-grid, recurring meetings, or document upload yet.)
- **Outlook calendar push** (`calendarOwners` on a `task:` record) — a meeting can
  be mirrored onto staff members' real Outlook calendars. The **"Add to Outlook
  calendars"** checkbox list in the meeting panel picks *which* mailboxes per
  meeting — **any number of them** (each restricted to an admin account, so it
  can't target arbitrary tenant mailboxes) — so one advisor can book onto
  another's calendar, or onto several at once. **Push-only** — Outlook is never
  read back; this app stays the source of truth.
  - `outlookEvents` is a `{mailbox: eventId}` map, reconciled as a **set** on every
    save: each ticked mailbox is created or PATCHed, and any mailbox no longer
    ticked has *only its own* copy deleted. Clearing every name (or removing the
    date, which stops it being an event at all) withdraws them all, and deleting
    the task takes every calendar entry with it. A 404 on PATCH means someone
    deleted that copy in Outlook, so it's recreated; any other PATCH error keeps
    the stored id rather than orphaning a real event.
  - **Legacy bridge**: records written before multi-calendar support carry the
    singular `calendarOwner` + `outlookEventId` + `outlookSyncedOwner`.
    `taskCalendarOwners()` / `taskOutlookEvents()` read those as a one-entry
    equivalent, so an already-synced meeting **PATCHes its existing event instead
    of duplicating it**, and the singular fields are blanked on first save under
    the new code so there's one source of truth afterward.
  - Sends **no attendees on purpose**: Graph emails an invitation to every
    attendee, so listing the client would fire real mail at them on save;
    inviting people stays a manual step in Outlook.
  - Uses the same app registration + client-credentials token as the SharePoint
    sync (`OUTLOOK_CLIENT_ID` / `OUTLOOK_CLIENT_SECRET` / `OUTLOOK_TENANT_ID`),
    which additionally needs the **`Calendars.ReadWrite.All` _application_
    permission with admin consent granted** in Azure AD. Times are sent as naive
    wall-clock strings plus a named Windows zone (Graph resolves DST); override
    the default `Eastern Standard Time` with `wrangler secret put OUTLOOK_TIMEZONE`.
    Skips silently when the `OUTLOOK_*` secrets are absent, and every failure is
    caught + logged so a Graph outage can never block saving the meeting.
  - **Not verifiable against the local mock**: `dev-server.ps1` has no Microsoft
    Graph behind it, so it stores/echoes `calendarOwners` (enough to exercise the
    picker and validation) but creates no real event. End-to-end confirmation
    requires a deploy with the secrets set. The reconcile logic itself (create /
    PATCH / delete sets, legacy migration, 404 recreate) is covered by unit tests
    run against the real source with a stubbed Graph layer.
- **Compliance** (`compliance.html`, sidebar "Compliance") is the firm's compliance
  calendar, seeded from `BlueLine_Compliance_Tracker.xlsx` and then owned by the
  app — the workbook is never written back to. Three views off one `?view=` param:
  **Tracker** (default), **Dashboard**, **Calendar**.
  - **Seed**: `compliance-seed.js` holds all 128 rows of the workbook's "Calendar
    Tracker" sheet, generated once and verified against the workbook's own
    Dashboard tab (Owner: Frank 64 / Jennifer 55 / Both 9; Reviewer: Frank 54 /
    Jennifer 64 / N/A 10). Single source of truth: `worker.js` imports it and
    `dev-server.ps1` parses the same file, so the mock can't drift from prod. Its
    array is deliberately strict JSON so PowerShell can read it after stripping
    the ES-module export prefix. Do not hand-edit.
  - **Status is DERIVED, never stored** — the workbook's Instructions tab is
    explicit that Status is automatic. An item is CLOSED once the owner *and* the
    reviewer have a completion date; items whose reviewer is `N/A` (the joint ones
    done by both people together) close on the owner alone. Deriving it means the
    status can never contradict the two check-offs on screen. Ticking a box writes
    today's date plus who ticked it; unticking clears both.
  - **Tracker is deliberately minimal** (asked for): item, owner check-off,
    reviewer check-off, status, Details. Sorted soonest-due first, so the top row
    is the most urgent. A due-date pill is the one addition — sorting by a date
    you can't see is disorienting. Everything else (what to do, frequency, source,
    mandated, notes, sign-off history) lives behind **Details**. CLOSED items leave
    the working list entirely for a **Completed** pill, so finished work is
    reachable without cluttering what's outstanding.
  - **Dashboard** mirrors the workbook's Dashboard tab (open/closed/total, % and
    by-owner / by-reviewer breakdowns) and adds an **Overdue** tile — the one
    number saying whether the firm is behind, which a static sheet couldn't show.
    Counts are computed client-side from the same item list the tracker renders,
    so the two can never disagree.
  - **Calendar** is due dates only, as asked: Sunday–Saturday, a fixed six-week
    month grid (so it doesn't jump between months) with each item on its due date;
    overdue red, closed struck through. Clicking one opens its Details. Day cells
    are a **fixed height with `min-width: 0`** and scroll internally — with
    `min-height` a busy day stretched its whole row, and without `min-width: 0` a
    long item name set the column's min-content width, so the boxes came out
    different sizes. Note a six-week grid always shows some greyed days of the
    neighbouring months; an item appearing there is not a duplicate.
  - **Recurrence** (`frequency` is a dropdown: One time / Weekly / Monthly /
    Quarterly / Semi-annually / Annually). Recurring items are **materialised** —
    one record per due date, each with its own pair of sign-offs — which is how
    the source workbook already worked (a quarterly item is four dated rows there)
    and is what compliance evidence needs: one row plus a rule would have nowhere
    to record who signed off which quarter.
    - Occurrences are generated to a **12-month horizon** and topped up on read,
      so a monthly item keeps appearing next month with no cron. The top-up only
      appends *after* a series' latest date, so deleting one occurrence doesn't
      resurrect it, and it skips any date already held by an item of the same
      name — which is what stops the 64 already-materialised seeded quarterly rows
      gaining duplicates if someone turns one into a series.
    - Each occurrence is stepped from the **series start**, not from the previous
      date: a monthly series from Jan 31 runs Jan 31 → Feb 28 → Mar 31, where
      stepping from the previous date would clamp once and stay stuck on the 28th.
      Date maths is UTC so a DST boundary can't shift a due date by a day.
    - Frequency stays **free text** on the wire: 66 seeded rows carry wordings the
      dropdown doesn't offer ("Ongoing / target Dec 2026"), and the drawer keeps
      the current value as an option so opening one of those and saving can't
      silently rewrite it. Whether something repeats is decided by looking up a
      step, and unrecognised wording simply has none.
    - **Delete series** clears every occurrence at once; plain Delete removes only
      that due date. Dropping a series back to "One time" stops it growing but
      leaves generated dates alone, since deleting dated sign-off records would
      destroy evidence.
  - **One encrypted KV blob** (`compliance_items`), matching the `board_lists`
    pattern rather than a key per item: 128 items are read together every load, so
    per-item keys would mean 128 KV gets per request — enough to blow the
    subrequest budget on a small plan. Trade-off: a read-modify-write race could
    drop a concurrent edit. Every write is a single-item mutation and the window is
    milliseconds, which is fine for a two-person compliance team and would not be
    for a large one. Seeding is keyed on the blob's *existence*, not on it having
    items, so deleting everything does not resurrect all 128.
  - **PowerShell gotcha, recorded because it cost real time**: `dev-server.ps1` is
    UTF-8 with no BOM, so PS 5.1 decodes it as Windows-1252 and an em-dash becomes
    three chars ending in U+201D — a curly double-quote, which PS accepts as a
    string delimiter. Inside a `"…"` literal that silently ends the string and
    breaks the whole file. Fine in comments; keep string literals ASCII.
- **Learning** (`learning.html`, sidebar "Learning") lists staff training videos
  and documents from a SharePoint **document library** ("Learning Resources"),
  via `GET /api/admin/learning`. Staff-facing only — nothing here is exposed to
  the client portal.
  - **NOT synced into KV**, unlike contacts/households: SharePoint stays the
    single copy and there's no two-way merge to get wrong. Each request hits Graph
    directly, so a file uploaded in SharePoint appears on the next refresh with no
    sync step to wait for. The listing itself is read-only — the one write is the
    upload below, which adds a file rather than editing an existing one.
  - **Add video** (`+ Add video`) uploads a video into the library from the app
    with a Name (Title), Category and optional Description. Two endpoints, because
    a training video is far too large for one request:
    - `POST /api/admin/learning/upload` validates the extension (mp4, mov, m4v,
      avi, wmv, webm, mkv), the 2 GB cap, the name, and the category against the
      column's Choice values, then opens a Graph **upload session** on the
      library's drive (`conflictBehavior: rename` — an upload never silently
      overwrites someone else's file of the same name).
    - `PUT /api/admin/learning/upload/chunk` proxies one 5 MiB slice (a multiple
      of the 320 KiB Graph requires), sequentially — Graph tracks a single expected
      byte range per session, so parallel PUTs would fight over it.
    - Chunks are **proxied through the Worker**, not sent browser→SharePoint: the
      upload URL's CORS behaviour isn't ours to control, and proxying keeps that
      pre-authenticated URL out of page JavaScript.
    - Session state (upload URL + the metadata to stamp on the file) rides in an
      **encrypted ticket** the client echoes back with each chunk — not KV. KV is
      eventually consistent and the first chunk can arrive within a second of the
      session opening, where a stale read would fail the upload outright. The
      chunk handler additionally refuses any ticket URL whose host isn't
      `*.sharepoint.com`, so an unset `DATA_ENCRYPTION_KEY` (ticket stored in the
      clear) can't be turned into a Worker-side SSRF.
    - Metadata is PATCHed onto the uploaded file's list item afterwards. A failure
      there is reported as a **warning, not an error**: the file is already in the
      library, and re-running the upload would only duplicate it.
  - A document library is a list underneath, so this reads the same
    `/sites/{id}/lists/{id}/items` endpoint as the contact/household syncs, with
    `driveItem` expanded for each file's own `webUrl`. Folders and any item
    without a `webUrl` are skipped. Needs `SHAREPOINT_LEARNING_LIST_ID`; when
    unset the endpoint returns `configured: false` and the page says which
    setting is missing rather than showing an empty library.
  - **Categories are data-driven**: the filter pills are built from the distinct
    `Category` values actually present, so adding a Choice value in SharePoint
    surfaces it with no code change. Requested explicitly — the alternative
    (hard-coded list) would need a deploy per new category.
  - **Column internal names are guessed defensively on read, resolved exactly on
    write.** SharePoint doesn't always match a column's internal name to its
    display name (a collision with a built-in gets suffixed, e.g. `Description` →
    `Description0`), so the listing's `pickField()` tries a candidate list.
    `GET /api/admin/learning/fields` dumps the raw field keys of the first few
    items to identify anything not covered — the same diagnostic role
    `/api/admin/sharepoint/lists` plays for list ids. The upload path can't guess,
    though: a PATCH naming a column that doesn't exist fails outright, so
    `resolveLearningColumns()` reads `/lists/{id}/columns` for the real internal
    names. That same call yields the Category column's Choice values, which is why
    the upload form's picker offers categories **no file uses yet** while the
    filter pills only show ones in use. When it fails, the endpoint returns
    `canUpload: false` and the page hides the button rather than offering an
    upload that couldn't be named.
  - Row title comes from the library's **Title** column, falling back to
    Description, then the filename — so a resource with neither filled in still
    renders a readable link instead of an unlabelled one. Under it sits one
    `Category · filename · size` line, with the filename omitted when it is
    already the title so a row never repeats itself.
  - **Description is not displayed** (asked for explicitly — the Title column is
    what labels a resource). It is still read, purely to back that title
    fallback, and is still matched by the search box. Note hiding the column in
    SharePoint would NOT have achieved this: hiding is a *view* setting, and this
    reads raw data through Graph, so stored values would still have surfaced.
    Links open SharePoint's own viewer in a new
    tab (`rel="noopener noreferrer"`), so no per-file embed code or sharing-link
    generation is needed. Reuses `Calendars`-era Graph creds — the existing
    `Sites.ReadWrite.All` application permission already covers a new library, so
    no extra Azure grant was required.
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
