# 10. Environment and Configuration

**No values appear in this document.** Names, purposes, and requirements only.

---

## How configuration reaches the app

There are three mechanisms, and no `.env` file in production:

| Mechanism | Used for | Where defined |
|---|---|---|
| **Cloudflare secrets** | All credentials and the encryption key | Dashboard, or `wrangler secret put <NAME>` |
| **Cloudflare bindings** | KV namespace, static assets | `wrangler.toml` |
| **Hardcoded constants** | Staff identities, TTLs, limits, list of admin accounts | `worker.js` source |
| `.dev.vars` (local only) | Local overrides for `wrangler dev` | Gitignored; **not used** by the PowerShell mock |

`wrangler.toml` in full:

```toml
name = "blueline-portal"
main = "worker.js"
compatibility_date = "2024-09-23"   # pinned deliberately - see note below

[[kv_namespaces]]
binding = "PORTAL_KV"
id = "dadc7f3c3d66491bbc97ded5efa59bc4"

[assets]
directory = "./public"
binding = "ASSETS"

[triggers]
crons = ["*/1 * * * *"]

[observability]
enabled = true
[observability.logs]
enabled = true
```

> `compatibility_date` is intentionally left at an older date. The in-file comment explains:
> nothing needs it specifically any more, but the deployed Worker already runs on those
> semantics, so moving it would change runtime behaviour for no benefit. **Do not bump it
> casually.**

---

## Complete secret / variable inventory

### Required for core operation

| Name | Secret? | Purpose | If missing |
|---|---|---|---|
| `PORTAL_KV` | Binding | The entire datastore | **Total failure.** Nothing works. |
| `ASSETS` | Binding | Static file serving | No UI |

### Authentication

| Name | Secret? | Required? | Purpose | If missing |
|---|---|---|---|---|
| `ADMIN_PASSWORD_FSABIN` | **Yes** | Yes, for Frank to log in | Password for `fsabin@blueline-advisors.com` | That account cannot log in. Error is "Invalid email or password" — indistinguishable from a wrong password. |
| `ADMIN_PASSWORD_JYOUNG` | **Yes** | Yes, for Jenn | Password for `jyoung@blueline-advisors.com` | Same |
| `ADMIN_PASSWORD_INTERN` | **Yes** | Yes, for the intern account | Password for `intern@blueline-advisors.com` | Same |
| `ADMIN_PASSWORD` | **Yes** | **No — legacy** | Pre-migration shared staff password fallback | Nothing. **Confirmed absent in production (2026-08-20).** The fallback branch fails closed. Dead code. |

Compared as trimmed plaintext against the submitted password via `timingSafeEqual`
(`worker.js:135-137`). These are **not** hashed, because there is nothing hashed to compare
against. Admins added through the UI instead get salted PBKDF2 hashes in KV and do not use
secrets at all.

**Adding a fourth secret-backed staff account requires editing `ADMIN_ACCOUNTS`
(`worker.js:85-89`) and redeploying.** Adding a KV-backed admin does not.

### Encryption

| Name | Secret? | Required? | Purpose |
|---|---|---|---|
| `DATA_ENCRYPTION_KEY` | **Yes** | **Effectively yes** | AES-256-GCM key material for all sensitive records at rest |

Any-length high-entropy string; SHA-256'd to a 256-bit key (`worker.js:1099-1113`). Suggested
generation is in-code: `openssl rand -base64 48`.

> **Three warnings, all load-bearing:**
> 1. **If unset, all "encrypted" records are silently written in plaintext.** No log, no warning.
>    See [14-security-review.md](14-security-review.md) H-2.
> 2. **If lost or changed after real data is encrypted, that data is permanently unreadable.**
>    There is no escrow and no re-encryption migration. Never rotate without writing one first.
> 3. Setting it on an existing plaintext deployment does **not** retroactively encrypt. Old
>    records read back via the legacy path; only new writes are encrypted.

### Microsoft Graph (SharePoint + Outlook)

All Graph access uses one app registration despite the `OUTLOOK_` naming.

| Name | Secret? | Required? | Purpose |
|---|---|---|---|
| `OUTLOOK_CLIENT_ID` | No (id) | For any Graph feature | Entra app registration client id |
| `OUTLOOK_CLIENT_SECRET` | **Yes** | For any Graph feature | Client secret. **Expires** — see below. |
| `OUTLOOK_TENANT_ID` | No (id) | For any Graph feature | Microsoft tenant id |
| `OUTLOOK_TIMEZONE` | No | Optional | Windows timezone name for pushed events. Default `Eastern Standard Time`. |

If any of the first three is missing, `outlookConfigured()` returns false and calendar push is
**silently skipped** — no error surfaces to the user.

> **Operational reminder not currently documented anywhere in the repo:** Entra client secrets
> have an expiry date (commonly 6, 12, or 24 months). When `OUTLOOK_CLIENT_SECRET` expires,
> **every** Graph feature stops at once — SharePoint sync, document upload/download, learning
> library, calendar push, email reading — while the core CRM keeps working. The failure is
> logged but not alerted. Put the expiry date in a calendar reminder. This is the single most
> likely "everything integration-related broke overnight" cause.

### SharePoint object ids

All non-secret identifiers. Missing ones disable the corresponding feature silently.

| Name | Purpose | Feature disabled if missing |
|---|---|---|
| `SHAREPOINT_SITE_ID` | The site everything else resolves against | All SharePoint features |
| `SHAREPOINT_LIST_ID` | Contacts list | Contact sync |
| `SHAREPOINT_HOUSEHOLDS_LIST_ID` | Households list | Household sync |
| `SHAREPOINT_LEARNING_LIST_ID` | Learning/SOP document library | Learning library |
| `SHAREPOINT_CLIENT_DOCS_LIST_ID` | Client documents library | Client document upload/list |
| `SHAREPOINT_COMPLIANCE_LIST_ID` | Compliance list | Compliance SharePoint mirroring |
| `SHAREPOINT_COMPLIANCE_SITE_ID` | Site for compliance, if different from the main site | Compliance mirroring |
| `SHAREPOINT_NOTES_LIST_ID` | Notes list | Notes mirroring |

Two diagnostic endpoints exist to resolve these without the SharePoint admin UI:
`GET /api/admin/sharepoint/site` and `GET /api/admin/sharepoint/lists` (shared-view managers
only). **Use these first when a SharePoint feature is misbehaving.**

### Networking

| Name | Secret? | Required? | Purpose |
|---|---|---|---|
| `ALLOWED_ORIGIN` | No | Optional | Comma-separated extra allowed browser origins. Defaults to the Worker's own origin only. |

---

## Hardcoded configuration (not environment-driven)

Things a new developer may reasonably expect to be configurable but which are in source. **Each
requires a code change and deploy.**

| Constant | Value | Location | Notes |
|---|---|---|---|
| `ADMIN_ACCOUNTS` | 3 staff emails + secret names | `worker.js:85-89` | Real email addresses, in a public repo |
| `FRANK_ADMIN_EMAIL` | `fsabin@blueline-advisors.com` | `worker.js:90` | **`isSuperAdmin` is a literal comparison to this.** Ownership is not transferable without a deploy. |
| `JENN_ADMIN_EMAIL`, `INTERN_ADMIN_EMAIL`, `ERIC_ADMIN_EMAIL` | staff emails | `worker.js:91-93` | Permanent shared-firm-view managers; cannot be demoted via UI |
| `LEGACY_ADMIN_NAMES` | display names | `worker.js:97-102` | |
| `SESSION_TTL_SECONDS` | 7 days | `worker.js:67` | Client sessions |
| `ADMIN_SESSION_TTL_SECONDS` | 12 hours | `worker.js:108` | Staff sessions |
| `PBKDF2_ITERATIONS` | 100,000 | `worker.js:68` | Changing this invalidates nothing (iterations stored per record) but new/old records differ |
| `CLIENT_PASSWORD_MIN_LENGTH` | 8 | `worker.js:109` | |
| `ADMIN_PASSWORD_MIN_LENGTH` | 10 | `worker.js:110` | |
| `CLIENT_INVITE_TTL_SECONDS` | 7 days | `worker.js:70` | |
| `CLIENT_RESET_TTL_SECONDS` | 24 hours | `worker.js:75` | |
| `ONBOARDING_TTL_SECONDS` | 30 days | `worker.js:69` | |
| `MFA_PENDING_TTL_SECONDS` | 10 minutes | `worker.js:844` | |
| `AUDIT_TTL_SECONDS` | ~400 days | `worker.js:424` | ~13 months |
| `RATE_LIMITS` | 5 scopes | `worker.js:427-433` | |
| `CLIENT_DOC_MAX` / `LEARNING_MAX_UPLOAD` | 250 MB / 2 GB | `worker.js:5461`, `3667` | |
| `CLIENT_DOC_CHUNK` / `LEARNING_UPLOAD_CHUNK` | 5 MB each | `worker.js:5460`, `3666` | Must stay a multiple of 320 KiB |
| `ONBOARDING_MAX_BYTES` | 100,000 | `worker.js:2225` | |
| `OUTLOOK_DEFAULT_TIMEZONE` | `Eastern Standard Time` | `worker.js:6904` | Overridable by env |
| `OUTLOOK_DEFAULT_DURATION_MIN` | 60 | `worker.js:6905` | |
| `COMPLIANCE_SEED` | 128 items | `compliance-seed.js` | Imported at build |
| Cron schedule | `*/1 * * * *` | `wrangler.toml` | See deployment doc for cost note |
| Frontend asset cache-buster | `?v=20260817-6` | Each admin HTML `<script src>` | **Manual.** See below. |

> **Manual cache-busting.** Admin pages load `shared.js?v=20260817-6` and
> `shared.css?v=20260817-6`. This query string is hand-maintained. **If you change `shared.js` or
> `shared.css` and do not bump `v=` in every page that loads them, browsers may serve a stale
> copy** — and because the intended `Cache-Control: no-cache` does not actually apply in
> production (security finding H-1), that risk is real, not theoretical. Grep for the current
> token and update all occurrences together. **Currently consistent:** all 8 admin pages carry
> `?v=20260817-6` for both files (verified 2026-08-20).

---

## Environment differences

There are only two environments and **no staging**.

| | Production | Local development |
|---|---|---|
| Backend | `worker.js` on Cloudflare | `dev-server.ps1` (PowerShell re-implementation) |
| Data | Cloudflare KV, encrypted | In-memory hashtables, **no encryption**, wiped on restart |
| Secrets | Cloudflare secrets | Hardcoded dev values in `dev-server.ps1` |
| Staff passwords | Cloudflare secrets | `$adminPasswords` in `dev-server.ps1` (`dev-<name>-pass`) |
| MFA | Real TOTP, encrypted at rest | Real TOTP, in-memory unencrypted |
| SharePoint / Outlook | Real Graph calls | **None — no mock.** Values stored and echoed only. |
| Cron | Every 60s | Not simulated |
| Port | 443 | 8787 |

> Because the local mock has **no Graph layer at all**, every SharePoint and Outlook code path is
> untestable locally. Those paths can only be exercised against production. Plan changes there
> accordingly — this is the highest-risk category of change in the system.

## Setting a secret

```bash
wrangler secret put DATA_ENCRYPTION_KEY
```

Or Cloudflare dashboard -> Workers & Pages -> `blueline-portal` -> Settings -> Variables and
Secrets. **Secrets take effect immediately; no redeploy needed.** Values are write-only and
cannot be read back afterwards — record them in the firm's password manager at the time of
setting.

> `wrangler` **cannot be installed on the original developer's machine** (Windows ARM64;
> `workerd` has no win32-arm64 build). Secret changes there must go through the dashboard. On any
> x64 machine, or via WSL/Docker, the CLI works normally.

## Configuration checklist for a new deployment

1. Create a KV namespace; put its id in `wrangler.toml` under `[[kv_namespaces]]`.
2. Set `DATA_ENCRYPTION_KEY` **before any real data is entered.**
3. Set `ADMIN_PASSWORD_FSABIN` / `_JYOUNG` / `_INTERN`.
4. Create the Entra app registration; grant and admin-consent the Graph application permissions;
   set `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID`. **Record the secret's
   expiry date.**
5. Set `SHAREPOINT_SITE_ID` and each list id (use the two diagnostic endpoints to find them).
6. Optionally set `OUTLOOK_TIMEZONE` and `ALLOWED_ORIGIN`.
7. Deploy, then log in as Frank and complete MFA enrolment immediately.
