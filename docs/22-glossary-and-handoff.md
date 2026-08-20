# 22. Glossary, Open Questions, and Handoff Checklist

---

## Glossary

### Domain terms

| Term | Meaning |
|---|---|
| **FPA** | Financial Picture Analysis — the 5 core assessment modules: risk, budget, retirement, networth, compensation. Distinct from the 12 "category" modules. |
| **Category modules** | The 12 non-FPA assessments across budgeting/spending, risk assessment, estate planning, insurance planning. Generated from `MODULE_FORMS`. |
| **Assignment** | Which modules a given client is allowed to see (`assignments:<email>`). Absent means "all visible" (legacy default). |
| **Household** | A family or company grouping of contacts (`household:hh-<hex>`). Can share assessment answers. |
| **Shared vs personal module** | Shared modules store one answer per household (`hhresponses:`); personal store one per person (`responses:`). |
| **Prospect** | A contact with `status: 'prospect'`. A **filter** over the single contact list, not a separate store. |
| **Materialised (compliance)** | Each recurring obligation exists as one record per due date, so each occurrence carries its own sign-off. Not a rule expanded at render time. |
| **Compliance area** | One of exactly **six** categories. Deliberately six, not fifteen. |
| **Sign-off** | Two-party compliance confirmation: an owner and a reviewer. |
| **Ready / done** | Two-stage task completion. `readyAt` = ticked off (hand-off state); `done` = confirmed, which fires side effects. |
| **Key documents** | Household-level record of whether an IPS, Advisory Agreement, etc. were completed. App-only — not a SharePoint column. |

### System terms

| Term | Meaning |
|---|---|
| **Workspace** | Data-visibility boundary **between staff members**, not between customers. Every CRM record carries a `workspace` (an admin's email). |
| **Shared firm view** | Frank's workspace, shared by designated staff. Its managers get elevated rights. |
| **Shared firm view manager** | `canManageSharedFirmView()` — Frank plus members of his workspace. Can add/rename admins, reset MFA/passwords, edit firm links, view the audit log. |
| **Super admin** | Frank only. Hardcoded comparison to `FRANK_ADMIN_EMAIL`. The only role that can delete an admin account. |
| **Legacy admin** | One of the 3 accounts in `ADMIN_ACCOUNTS` whose password is a Cloudflare secret rather than a KV hash. Cannot be reset in-app. |
| **KV admin** | An admin added through Settings; salted PBKDF2 hash in `admin_account:`. Resettable in-app. |
| **`__all__`** | Sentinel workspace value for the read-only combined view. GET-only, 4 allowlisted paths. |
| **The mock** | `dev-server.ps1`, the PowerShell re-implementation of the backend used for local dev. |
| **Inverted timestamp** (`invTs`) | `CEILING - now`, used as a key suffix so lexicographically-ascending keys are chronologically descending. Lets "newest N" be one bounded list call. |
| **Envelope** | The encrypted record wrapper: `{v:1, enc:'aesgcm', iv, ct}`. |
| **Legacy plaintext** | Pre-encryption records, still read transparently by `decryptToObject`. |
| **Best-effort** | Operations (timeline writes, Graph pushes) wrapped so failure is logged but never blocks the primary write. |
| **Fail closed** | Encryption/MFA failures throw rather than degrading, so a key problem can never be mistaken for "no data" or "no MFA". |
| **Write token** | The per-session `onboarding_secret:` that prevents one browser session editing another's onboarding record. |
| **Upload ticket** | An encrypted blob handed to the browser carrying the SharePoint upload destination, so the client cannot redirect the write. |
| **Drip-feed** | Compliance items appearing on sign-off rather than all at once. |

### Cloudflare terms

| Term | Meaning |
|---|---|
| **Worker** | A serverless V8 isolate. Here: one Worker named `blueline-portal`. |
| **KV** | Workers KV — eventually-consistent key-value store. **The entire database.** |
| **Static Assets** | Cloudflare's built-in static file serving from `./public`. **Serves files without invoking the Worker** — the cause of security finding H-1. |
| **Workers Builds** | Cloudflare's GitHub-App CI. Configured dashboard-side, leaves no trace in the repo. |
| **Cron Trigger** | Scheduled invocation. Here `*/1 * * * *`. |
| **`workerd`** | The local Workers runtime. **No `win32-arm64` build** — the reason `dev-server.ps1` exists. |
| **Binding** | A named resource injected as `env.<NAME>` (`PORTAL_KV`, `ASSETS`). |

---

## Open questions

Things that could not be determined without access I did not have. Ordered by importance.

### Requires Cloudflare dashboard access

| # | Question | Why it matters |
|---|---|---|
| 1 | **Is `DATA_ENCRYPTION_KEY` set?** | If not, all client PII including passport/licence numbers and medical notes is stored in **plain text** with no warning. Security H-2. **Check this first.** |
| 2 | **Is MFA enabled on the Cloudflare account, for every user?** | It is the only control against the catastrophic scenario in [20-failure-impact.md](20-failure-impact.md). |
| 3 | Do `ADMIN_PASSWORD_JYOUNG` and `ADMIN_PASSWORD_INTERN` exist? | If not, those staff cannot log in and the error looks like a forgotten password. |
| 4 | Who has Cloudflare account access, and at what role? | Dashboard access is the true break-glass credential for this system. |
| 5 | Are there KV API tokens issued, and to what scope? | A read token bypasses all application authorization. |
| 6 | Is Workers Builds configured for preview deploys on non-`main` branches? | Would provide staging nearly free. |
| 7 | Actual KV storage size, read/write volume, and cost? | The every-minute cron is the main driver. |
| 8 | Are there Cloudflare notification rules configured? | Determines whether anyone learns about an error spike. |

### Requires Microsoft 365 / Entra access

| # | Question | Why it matters |
|---|---|---|
| 9 | **When does `OUTLOOK_CLIENT_SECRET` expire?** | Its lapse kills every integration at once. Highest-probability real incident. |
| 10 | Exact granted Graph application permissions? | `Calendars.ReadWrite.All` is confirmed in-code; `Sites.*` and `Mail.Read` are inferred. |
| 11 | Is the app registration scoped (`Sites.Selected`) or tenant-wide? | Determines blast radius of a path-construction bug. |
| 12 | Is there a SharePoint retention/versioning policy on the document libraries? | Affects whether uploaded files are recoverable. |
| 13 | Which SharePoint site and list names correspond to each configured id? | Nothing in the repo records the human-readable names. |

### Requires the original developer or firm

| # | Question | Why it matters |
|---|---|---|
| 14 | **Is the public GitHub repo intentional?** | Security H-3. Assumed unintentional. |
| 15 | Is `blueline-portal.fsabin.workers.dev` given to real clients today, or is this pre-launch? | Changes the urgency of M-3 (custom domain) and of the whole security list. |
| 16 | How many real clients and contacts exist? | Determines when O(n) listing becomes a problem. |
| 17 | Has the onboarding wizard ever received real (non-fake) data? | It stores plaintext and warns against real data. If real data went in, that is a live exposure. |
| 18 | Did anyone retain their 8 MFA backup codes? | Determines whether route 1 of MFA recovery exists. |
| 19 | Are the 4 `agent/*` remote branches abandoned? | Assumed yes; recommend pruning. |
| 20 | What version of pdf-lib is vendored? | Nothing records it. |
| 21 | Is there any recordkeeping/retention obligation this system is expected to satisfy? | Relevant to C-1 (no backups) for an SEC-registered adviser. |

---

## Recommended future documentation

Not written here, and worth adding:

| Document | Why |
|---|---|
| **Runbook: Cloudflare secret rotation** | Especially the distinction between safe (`OUTLOOK_CLIENT_SECRET`) and dangerous (`DATA_ENCRYPTION_KEY`) rotations |
| **Backup and restore procedure** | Cannot be written until a backup exists (C-1) |
| **SharePoint site/list map** | Human-readable names against each configured id |
| **Incident log** | A running record of what broke and why; the git history partly serves this today |
| **Client-facing support guide** | For advisors: how to invite, reset, and troubleshoot a client, given there is no email |
| **Data inventory / retention policy** | What personal data is held, where, for how long — likely a compliance requirement for an RIA |
| **Onboarding-wizard decision** | Whether to productionise it (and encrypt it) or retire it |

---

## Handoff and access checklist

For whoever takes over. **Nothing below reveals a secret value** — it lists what access is needed.

### Source control
- [ ] GitHub access to `franksabin/blueline-portal` with write permission
- [ ] Confirm whether the repo should be **private** (currently public — security H-3)
- [ ] Understand that deployment is via the **Cloudflare Workers Builds GitHub App**, not Actions
- [ ] Decide whether to prune the 4 stale `agent/*` remote branches

### Hosting and runtime
- [ ] Cloudflare account access, with the role recorded
- [ ] **MFA enabled** on your own Cloudflare account
- [ ] Locate: Workers & Pages -> `blueline-portal` -> Settings, Deployments, Logs, Metrics
- [ ] Confirm the Workers Builds GitHub integration is connected
- [ ] Note there is **no staging environment**

### Database
- [ ] Access to the `PORTAL_KV` namespace (id in `wrangler.toml`)
- [ ] Know how to browse/edit KV in the dashboard — this is the break-glass tool for MFA lockout
- [ ] **Confirm `DATA_ENCRYPTION_KEY` is set** (question 1 above)
- [ ] **Understand there are no backups** (C-1) and decide whether to accept that
- [ ] Get the encryption key into the firm's password manager, with two people holding access

### Authentication
- [ ] A staff admin account, with MFA enrolled
- [ ] **Store your 8 backup codes somewhere safe** (shown once, at enrolment)
- [ ] Confirm which `ADMIN_PASSWORD_*` secrets exist
- [ ] Understand that Frank's super-admin role is hardcoded and not transferable without a deploy

### DNS and domain
- [ ] Registrar/DNS access for `blueline-advisors.com` (currently Squarespace — separate from this app)
- [ ] Note there is **no custom domain** for the portal (security M-3)
- [ ] Decide whether to add `portal.blueline-advisors.com`

### Vendors and integrations
- [ ] Microsoft 365 / Entra admin access, or a named contact who has it
- [ ] Locate the app registration (`BlueLineSyncOutlook`) and **record its secret expiry date**
- [ ] Review granted Graph application permissions
- [ ] SharePoint access to every configured list and library
- [ ] Record the site/list names against their configured ids

### CI/CD
- [ ] Understand: push to `main` -> live in 1-2 minutes, **no gate**
- [ ] Know both rollback routes (`git revert`; Cloudflare Deployments -> Rollback)
- [ ] Know that code rollback **does not** undo data changes

### Monitoring and backups
- [ ] Accept that there is **no** uptime monitoring, error tracking, alerting, or analytics
- [ ] Accept that there are **no backups of anything**
- [ ] Recommended: add an uptime check, a Cloudflare error-rate notification, and a KV export

### Knowledge transfer
- [ ] Read [21-new-developer-start-here.md](21-new-developer-start-here.md)
- [ ] Ship two or three real changes **while the original developer is still reachable**
- [ ] Skim `STATUS.md`
- [ ] Read the "do not fix these" list in [17-technical-debt.md](17-technical-debt.md)

### First-week actions (from the security review)
- [ ] Verify `DATA_ENCRYPTION_KEY` (H-2)
- [ ] Add `public/_headers` to fix the missing security headers (H-1)
- [ ] Decide on repo visibility (H-3)
- [ ] Add `.gitattributes` (`* text=auto eol=lf`) so the test suite stops showing false failures
- [ ] Put the Entra secret expiry in a calendar with a month's warning
- [ ] Start a KV backup (C-1)

---

## Credentials needed, by system

Names and locations only — **no values.**

| System | What you need | Where it lives |
|---|---|---|
| GitHub | Account with write access to the repo | GitHub |
| Cloudflare | Account login + MFA | Cloudflare |
| BlueLine Portal (staff) | Email + password + TOTP authenticator | `ADMIN_PASSWORD_<NAME>` secret, or a KV admin created in Settings |
| Microsoft 365 / Entra | Admin access or a named contact | Microsoft |
| SharePoint | Access to the configured lists/libraries | Microsoft |
| DNS | Registrar access for `blueline-advisors.com` | Squarespace / registrar |

Application secrets themselves (`DATA_ENCRYPTION_KEY`, `OUTLOOK_CLIENT_SECRET`,
`ADMIN_PASSWORD_*`) are **write-only** in Cloudflare and cannot be read back. If they were not
recorded in a password manager when set, the only options are rotation — which is safe for the
Graph secret and the admin passwords, and **catastrophic for `DATA_ENCRYPTION_KEY`.**
