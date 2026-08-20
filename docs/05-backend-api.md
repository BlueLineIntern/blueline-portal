# 5. Backend API Reference

Complete endpoint inventory for `worker.js`. **87 endpoints**: 52 exact-match paths, plus 35 method handlers across 30
pattern-matched (regex) paths -- several regex routes serve more than one method.

---

## Conventions

**Auth column:**

| Value | Meaning |
|---|---|
| *(none)* | Unauthenticated. Rate-limited. |
| `client` | `Authorization: Bearer <session token>` -> `getSessionEmail()` |
| `admin` | `Authorization: Bearer <admin session>` -> `getAdminEmail()` |
| `+ws` | Also calls `requestedAdminWorkspace()`; honours `X-Admin-Workspace`; 403 if not permitted |
| `+mgr` | Also requires `canManageSharedFirmView()` |
| `+super` | Also requires `isSuperAdmin()` (Frank only) |

**Every response is JSON** via `json(data, status, corsOrigin)` (`worker.js:467`), except asset
responses and file downloads. Errors are `{ error: "human-readable message" }`.

**Common status codes:** `400` validation, `401` no/expired session, `403` wrong workspace or
bad one-time token, `404` not found or not in workspace, `409` conflict, `429` rate limited,
`500` unhandled (logged server-side, generic message to caller).

---

## Client portal endpoints

| Method | Path | Auth | Purpose | Key failures |
|---|---|---|---|---|
| POST | `/api/register` | — | Create a portal account. **Requires a valid `invite` token bound to that email.** | 403 invalid/expired invite; 409 account exists; 400 password < 8; 429 (5/hr/IP) |
| POST | `/api/login` | — | Exchange email+password for a 7-day session | 401 invalid; 429 (10/5min/IP) |
| POST | `/api/reset-password` | — | Consume a `client_reset` token and set a new password. Kills all that client's sessions, issues one new. | 403 bad/expired/used token; 400 password < 8; 429 |
| POST | `/api/logout` | client | Delete the KV session | — |
| GET | `/api/assessments` | client | Own assessment answers (personal + household-shared merged) | 401 |
| POST | `/api/assessments/:module` | client | Save one module. `:module` must be one of the 17 in `MODULE_VALIDATORS`. | 400 per-module validation; 401 |
| GET | `/api/assignments` | client | Which modules this client should see | 401 |
| GET | `/api/household` | client | Own household context | 401 |
| GET | `/api/portal-links` | client | Firm-configured external platform links | 401 |
| GET | `/api/documents` | client | Own uploaded documents **only** — never advisor attachments | 401 |
| GET | `/api/document-requests` | client | Outstanding advisor document requests | 401 |
| POST | `/api/documents/upload` | client | Begin a chunked upload | 401, 400 |
| PUT | `/api/documents/chunk` | client | Upload one chunk | 401, 400 |

> `handleGetClientDocuments` deliberately returns only the client's own uploads. Advisor-attached
> documents are never exposed to the client side.

## Onboarding (proof of concept)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/onboarding/start` | client | Create an onboarding record; returns `{onboardingId, writeToken}` |
| POST | `/api/onboarding/:id` | client + `X-Onboarding-Token` | Save wizard progress |

Id format is enforced by regex: `BLA-ONB-\d{4}-(\d{4}|[a-f0-9]{16})`. **Dual authorization** —
the client session proves identity, the per-session write token prevents one browser session
editing another's record (`worker.js:2222-2225`). Body capped at `ONBOARDING_MAX_BYTES`
(100,000). Signature data URLs are validated to be real PNGs by checking the base64 prefix
`iVBORw0KGgo` without decoding attacker-controlled data (`isValidSignatureDataUrl`,
`worker.js:2229-2236`).

## Admin: authentication

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/admin/login` | — | Password step. Returns `{status:'mfa'\|'enroll', pendingToken}` — **never a session** |
| POST | `/api/admin/mfa/enroll` | pendingToken | Mint TOTP secret + 8 backup codes (returned once) |
| POST | `/api/admin/mfa/verify` | pendingToken | TOTP or backup code -> 12h session |
| POST | `/api/admin/logout` | admin | Delete the KV session |
| POST | `/api/admin/mfa/reset/:email` | admin +mgr | Clear another admin's MFA so they re-enrol |

## Admin: account management

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/admins` | admin | List admins with `mfaEnabled` and `legacy` flags |
| POST | `/api/admin/admins` | admin +mgr | Create a KV-backed admin (password >= 10) |
| DELETE | `/api/admin/admins/:email` | admin **+super** | Remove an admin. Frank rejected with 400. |
| POST | `/api/admin/admins/:email/name` | admin +mgr | Rename (stored separately from credentials) |
| POST | `/api/admin/admins/:email/reset-password` | admin +mgr | Reset a KV admin's password. **400 for the 3 legacy accounts** (their password is a Cloudflare secret). Kills that admin's sessions. |
| GET | `/api/admin/workspaces` | admin | Accessible workspaces, role flags, grants |
| POST | `/api/admin/workspaces/access` | admin +mgr | Assign employees to Frank's shared view. Owner must be Frank. |
| GET | `/api/admin/audit` | admin +mgr | Paginated audit log (newest first, cursor-based) |

`handleAdminDeleteAdmin` is the most side-effectful handler in the file: it writes an
`admin_disabled:` tombstone, preserves the display name, deletes `admin_account:` and
`admin_mfa:`, deletes every `admin_session:` and `admin_pending:` for that email, and strips
them from every workspace access list (`worker.js:231-274`).

## Admin: contacts and CRM

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/contacts` | admin +ws | List contacts (supports `__all__`) |
| POST | `/api/admin/contacts/:email` | admin +ws | Create/update a contact |
| POST | `/api/admin/contacts/:email/archive` \| `/unarchive` | admin +ws | Soft archive. Nothing deleted. |
| GET/POST | `/api/admin/contacts/:email/info` | admin +ws | KYC/suitability block (`clientinfo:`) |
| GET | `/api/admin/contacts/:email/emails` | admin +ws | Read client emails via Graph |
| POST | `/api/admin/contacts/:email/portal-invite` | admin +ws | Mint registration link (7d). 409 if account exists. |
| POST | `/api/admin/contacts/:email/portal-reset` | admin +ws | Mint password-reset link (24h). 409 if **no** account. |
| GET | `/api/admin/clients` | admin | Clients with assessment progress |
| POST | `/api/admin/assignments/:email` | admin | Set which modules a client sees |
| GET | `/api/admin/timeline/:email` | admin +ws | Paginated per-contact history |
| GET | `/api/admin/activity` | admin +ws | Firm-wide activity feed |
| GET/POST | `/api/admin/notifseen` | admin | Notification read-marker |
| GET/POST | `/api/admin/households` | admin +ws | List / create households |
| POST/DELETE | `/api/admin/households/:hh-id` | admin +ws | Update / delete household |

> **Route-order hazard.** `contactMatch = /^\/api\/admin\/contacts\/(.+)$/` at `worker.js:8309`
> uses greedy `(.+)`. Every `/contacts/:email/<suffix>` route **must** be declared above it. The
> existing ones are. If you add one below, `(.+)` captures `email/suffix` as the email and the
> request silently becomes a contact upsert.

## Admin: tasks, notes, board

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET/POST | `/api/admin/tasks` | admin +ws | List / create tasks and meetings |
| POST/DELETE | `/api/admin/tasks/:id` | admin +ws | Update / delete. Update handles status transitions, recurrence spawn, Outlook push. |
| GET/POST | `/api/admin/notes` | admin +ws | List / create notes |
| POST/DELETE | `/api/admin/notes/:id` | admin +ws | Update / delete |
| GET/POST | `/api/admin/lists` | admin +ws | Kanban board columns |
| DELETE | `/api/admin/lists/:id` | admin +ws | Remove a column (tasks fall to Unassigned) |

`handleAdminUpdateTask` (`worker.js:~7200-7460`) is the most complex handler. On an
`open -> done` transition it: stamps `completedAt` and `readyAt`, appends to per-task `history`,
writes a client timeline entry, stores the returned `timelineKeys`, and — if the task repeats —
creates the next occurrence via `createTask` with the checklist carried forward unticked and
calendar event ids deliberately *not* copied. See [16-business-rules.md](16-business-rules.md).

## Admin: documents

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/contacts/:email/documents` | admin +ws | List a client's documents |
| POST | `/api/admin/contacts/:email/documents/upload` | admin +ws | Start chunked upload to SharePoint |
| PUT | `/api/admin/client-documents/chunk` | admin +ws | Upload a chunk |
| POST/DELETE | `/api/admin/client-documents/:id` | admin +ws | Rename / delete |
| GET/POST | `/api/admin/contacts/:email/document-requests` | admin +ws | List / create requests |
| POST/DELETE | `/api/admin/document-requests/:id` | admin +ws | Update / delete |

## Admin: compliance

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/compliance` | admin | List the 128-item tracker |
| POST | `/api/admin/compliance` | admin | Create an item |
| POST/DELETE | `/api/admin/compliance/:id` | admin | Update (incl. sign-off) / delete |
| POST | `/api/admin/compliance/import` | admin | Bulk import |
| POST | `/api/admin/compliance/outlook-sync` | admin | Push compliance dates to Outlook |

Stored as a **single KV blob** (`compliance_items`), not one key per item. All 128 rows are read
and rewritten on every change — simple, and fine at this size, but not concurrency-safe: two
admins signing off simultaneously can lose one edit (last write wins). Filed in
[17-technical-debt.md](17-technical-debt.md).

## Admin: learning library

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/learning` | admin | List SharePoint library items |
| GET | `/api/admin/learning/fields` | admin | Report the resolved Category/Tags column config |
| POST | `/api/admin/learning/upload` | admin | Start chunked upload |
| PUT | `/api/admin/learning/upload/chunk` | admin | Upload a chunk |
| POST | `/api/admin/learning/note` | admin | Create a text note item |
| POST/DELETE | `/api/admin/learning/:id` | admin | Update / delete |
| GET | `/api/admin/learning/:id/content` | admin | Download/stream content |

## Admin: SharePoint / sync / diagnostics

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/admin/contacts/sync` | admin +mgr | Manual contact sync |
| POST | `/api/admin/households/sync` | admin +mgr | Manual household sync |
| GET | `/api/admin/sharepoint/site` | admin +mgr | Inspect resolved site (diagnostic) |
| GET | `/api/admin/sharepoint/lists` | admin +mgr | Enumerate lists (diagnostic) |

The two diagnostic endpoints exist to debug configuration without the Cloudflare dashboard.
They are gated to shared-view managers.

## Admin: onboarding, links

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/onboarding` | admin | List submissions |
| DELETE | `/api/admin/onboarding/:id` | admin | **Soft** delete (30-day TTL) |
| POST | `/api/admin/onboarding/:id/restore` | admin | Undo soft delete |
| GET | `/api/admin/portal-links` | admin | Read client-facing links |
| POST | `/api/admin/portal-links` | admin +mgr | Replace the link set |

## Fallbacks

| Condition | Behaviour |
|---|---|
| Unmatched `/api/*` | `404 {error:'Not found'}` (`worker.js:8396`) |
| Anything else | `serveAsset()` (`worker.js:8399`) — **only reached when the path is not a real asset** |
| Thrown error | Logged with pathname + method to Cloudflare Logs; caller gets generic `500` (`worker.js:8401-8406`) |

## Validation approach

No schema library. Each domain has a hand-written sanitizer returning `{fields}` or `{error}`:

| Function | Domain |
|---|---|
| `sanitizeTaskFields(body, allowedAssignees)` | Tasks — enforces title required, 200-char cap, valid priority/category/status/repeat, assignee must be a real admin |
| `sanitizeClientInfo(body)` | KYC block — per-field length caps, enum and date validation, money as numbers |
| `sanitizeChecklist(body.checklist)` | `[{id,text,done}]`, drops blanks |
| `sanitizeDocuments(...)` | Document metadata |
| `MODULE_VALIDATORS[module](body)` | Per-assessment-module validation (17 entries) |

**Every string is length-capped and every enum is whitelisted.** This is consistently applied
and is the codebase's main defence against injection and storage abuse. Money fields explicitly
permit negatives, with a comment noting an underwater balance sheet is a real answer.

## CORS

`corsHeaders(corsOrigin)` (`worker.js:456`). Same-origin by default; `ALLOWED_ORIGIN` may add a
comma-separated allowlist. Only an explicitly allowed origin is ever echoed back — there is no
wildcard and no credentials mode, because auth is bearer-token rather than cookie-based. This
also means **CSRF is structurally not a concern.**
