# 3. Repository Guide

---

## Complete file inventory

Every tracked file, with its purpose and size. Nothing here is generated — there is no build
output in the repo.

### Root

| File | Lines | Purpose | Read before changing? |
|---|---|---|---|
| `worker.js` | 8,414 | **The entire backend.** All ~85 API endpoints, auth, encryption, Graph integration, cron. | **Yes, always** |
| `dev-server.ps1` | 3,265 | Local PowerShell re-implementation of the backend for development. Not deployed. | **Yes, if touching the backend** |
| `STATUS.md` | 1,680 | The original developer's running design journal. Explains *why* for most decisions. | **Yes, for context** |
| `compliance-seed.js` | 143 | 128 seeded regulatory compliance obligations. Imported by `worker.js`. | If touching compliance |
| `agreement-pdf-worker.js` | 158 | Server-side generation of the signed advisory-agreement PDF. Imported by `worker.js`. | If touching agreements |
| `wrangler.toml` | 26 | Cloudflare config: KV binding, assets, cron, observability. | **Yes, for deploy/infra** |
| `README.md` | 1 | Contains only the text `# blueline-portal`. No useful content. | No |
| `.gitignore` | — | Ignores `node_modules/`, `.wrangler/`, `.dev.vars`, `.env`, logs, and local test harnesses. | No |

### `public/` — client portal

| File | Lines | Purpose |
|---|---|---|
| `index.html` | 538 | **All** client-facing views in one document (auth, home hub, category views, module forms, documents, links), toggled by adding/removing the `hidden` class. |
| `assets/script.js` | 1,998 | Client portal logic: auth, view switching, the declarative `MODULE_FORMS` spec, form engine, saving. |
| `assets/render.js` | 904 | Chart and result renderers. **Shared with the admin side** so scoring logic exists once. |
| `assets/style.css` | 1,462 | Client portal styling. |
| `assets/tokens.css` | 199 | Design tokens (colours, spacing, type scale). |
| `assets/sign-agreement.js` | 398 | Client-side agreement signing / signature capture. |
| `assets/vendor/pdf-lib.min.js` | — | Browser build of pdf-lib (separate from the ESM one in `vendor/`). |
| `assets/blueline-logo.png`, `wealthadvisorstransparentwhite.png` | — | Branding images. |

### `public/admin/` — advisor CRM

| File | Lines | Purpose |
|---|---|---|
| `contacts.html` | 5,988 | **The largest file in the repo.** Contacts + Prospects, contact detail with ~10 tabs, households, import, documents, client info. |
| `compliance.html` | 1,849 | Compliance tracker: filters, sign-off, recurrence. |
| `operations.html` | 1,557 | Tasks: kanban board + list view, task drawer, checklists. |
| `shared.js` | 1,192 | **Read this second.** Session guard, authenticated `api()` wrapper, nav shell injection, workspace header, shared formatters, contact picker, timeline labels. |
| `shared.css` | 1,012 | Admin design tokens and components. |
| `calendar.html` | 918 | Calendar view over tasks/meetings. |
| `index.html` | 891 | Dashboard ("Home"): stat tiles, queues, activity feed, notifications. |
| `learning.html` | 715 | SOP/learning library backed by a SharePoint document library. |
| `settings.html` | 519 | Admin accounts, workspace access, portal links, audit log. |
| `onboarding.html` | 312 | Viewer for onboarding wizard submissions. |
| `tasks.html` | 20 | Redirect stub -> `operations.html?view=list`. Kept so old links work. |

### `public/onboarding/` — onboarding wizard (proof of concept)

| File | Lines | Purpose |
|---|---|---|
| `index.html` | 378 | Multi-step onboarding wizard shell. States plainly: *"Use fake/test data only — no real personal details, no SSNs."* |
| `onboarding.js` | 1,093 | Wizard steps, validation, signature capture, save calls. |
| `onboarding.css` | 450 | Wizard styling. |
| `advisory-agreement.pdf` | — | The template agreement document. |

### `scripts/` — tests and one-off migrations

| File | Lines | Type | Status |
|---|---|---|---|
| `test-prospects.js` | 1,041 | Behavioural test with stubs, Clients/Prospects split + learning tags | **FAILS on Windows checkout** (CRLF, not a real defect) |
| `add-compliance-area.js` | 180 | One-off migration, already applied. Stamps `complianceArea` onto compliance seed rows. | Historical; do not re-run |
| `test-household-sync.js` | 108 | Behavioural regression test for SharePoint household sync clobbering | **PASSES** (12 assertions) |
| `test-portal-regressions.js` | 57 | Source-text assertions across 4 files | **FAILS on Windows checkout** (CRLF, not a real defect) |

See [15-operations.md](15-operations.md) for the CRLF explanation and the fix.

### `vendor/`

| File | Purpose |
|---|---|
| `pdf-lib.esm.min.js` | ESM build of pdf-lib with all dependencies inlined. **Imported by `worker.js` via relative path.** The only third-party runtime dependency. |

### Untracked / local-only

| Path | Notes |
|---|---|
| `.wrangler/` | Wrangler cache. Contains only Cloudflare `account.id` and `account.name` — no tokens. Gitignored. |
| `.claude/launch.json` | Dev-server launch config used by the developer's tooling. Points at `dev-server.ps1` on port 8787. |
| `public/crm-test.html`, `crm2-test.html` | Local browser test harnesses that run the real `worker.js` against a mock KV. Correctly excluded by the `public/*-test.html` rule in `.gitignore`. |

> **Verified not a problem.** These harness files exist on the developer's disk and
> `.gitignore` warns *"Never deploy these... the harness pages have no place on the live
> site."* I checked whether the warning had been defeated by files being tracked before the
> rule was added: they are **not** tracked (`git ls-files public/` lists 25 files, none of them
> test harnesses), and both `/crm-test.html` and `/crm2-test.html` return **404** on the live
> site. The exclusion is working as intended. Noted here because "gitignored but already
> tracked" is a common real failure and worth re-checking if harness files are ever added again.

## Entry points

| Entry point | File | Trigger |
|---|---|---|
| HTTP requests | `worker.js` -> `export default { fetch }` (~line 7950) | Every non-asset request |
| Scheduled job | `worker.js` -> `export default { scheduled }` (line 8410) -> `handleScheduled()` (line 7901) | Cron `*/1 * * * *` |
| Client portal UI | `public/index.html` + `assets/script.js` | Browser at `/` |
| Admin login | `public/admin.html` | Browser at `/admin.html` |
| Admin app | `public/admin/index.html` + `shared.js` | Browser at `/admin/` |
| Onboarding wizard | `public/onboarding/index.html` | Browser at `/onboarding/` |

## Files you must understand before major changes

In priority order:

1. **`worker.js:7950-8400`** — the route table. Order matters; see
   [02-architecture.md](02-architecture.md).
2. **`worker.js:77-140`** — `ADMIN_ACCOUNTS`, `verifyAdminPassword`. Staff identity is
   hardcoded here.
3. **`worker.js:310-436`** — the workspace/permission model. Almost every admin handler calls
   into it.
4. **`worker.js:1077-1176`** — encryption envelope. Get this wrong and you corrupt or expose
   client data.
5. **`public/admin/shared.js:1-105`** — the `api()` wrapper and session guard. Every admin page
   depends on it, including the automatic `X-Admin-Workspace` header and 401 handling.
6. **`dev-server.ps1`** — because a backend change without a matching mock change makes local
   testing lie to you.
7. **`STATUS.md`** — before concluding any design decision is arbitrary, search it. Most
   oddities are deliberate and explained.

## Code conventions actually used

- **Comment density is high and the comments are load-bearing.** They frequently record why an
  obvious-looking alternative was rejected. Match this when you edit; it is the codebase's main
  defence against a future developer "fixing" something deliberate.
- `async function handleX(request, env, cors, ...)` is the handler signature.
- Sanitize-then-write: each domain has a `sanitizeX(body)` function returning `{ fields }` or
  `{ error }`. Validation is manual, not schema-driven.
- Errors return `json({ error: '...' }, status, cors)`. Client-visible messages are written for
  humans.
- No TypeScript, no JSDoc types, no linter config. **There is no type checking anywhere.**

## Dead, legacy, and vestigial code

| Item | Location | Status |
|---|---|---|
| Security headers in `serveAsset()` | `worker.js:7934-7950` | **Effectively dead in production** — only reached on 404s. Not dead code by inspection, only by deployment config. |
| `ADMIN_PASSWORD` fallback | `worker.js:135` | Legacy shared-password migration path. Secret confirmed **not present** in Cloudflare, so this branch yields `''` and fails closed. Safe to remove. |
| `tasks.html` | `public/admin/tasks.html` | Intentional redirect stub for old links. Keep. |
| Legacy plaintext record support | `worker.js:1157-1176` | `decryptToObject` passes through pre-encryption plaintext records. Still needed if any old records exist. |
| Legacy `audit:<ISO>` keys | Documented in `STATUS.md` | Superseded by inverted-timestamp keys; expire on their own. |
| `team_roster` migration | Referenced in `STATUS.md` and board-list code | Migrates old roster members to custom board lists on first read. |
| `add-compliance-area.js` | `scripts/` | One-off migration, already applied. |
| Header endpoint list | `worker.js:29-43` | **Stale.** Lists ~13 endpoints; there are ~85. |
| "no application-level encryption" note | `worker.js:59-62` | **Stale and contradicted** by the encryption implemented at `worker.js:1077+` and by the KV layout comment 40 lines above it. |

## Branches

`main` is the deployed branch. Also present on the remote: `agent/admin-workspaces`,
`agent/fix-household-assessment-assignments`, `agent/polish-portal-ui`,
`agent/shared-firm-view-managers`. Local-only: `agent/restore-admin-client-commits`,
`claude/infallible-fermi-d06163`.

**ASSUMPTION:** these are stale AI-agent working branches, already merged or abandoned. Nothing
references them. Recommend pruning after confirming no unmerged work.
