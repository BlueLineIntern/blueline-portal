# 14. Security Review

**Scope:** read-only code review plus non-destructive observation of the live deployment.
No penetration testing, no fuzzing, no attempts to bypass authentication, no writes to
production. Verified 2026-08-20 against commit `68c61e4`.

**What could not be assessed:** Cloudflare account configuration (secret presence, KV access
tokens, account MFA), the Entra ID app registration's actual granted permissions, SharePoint
permissions, and Cloudflare audit logs. All require console access. These are the most
important remaining gaps and are listed as open questions in
[22-glossary-and-handoff.md](22-glossary-and-handoff.md).

---

## Findings summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| **C-1** | Critical | No backups of the datastore; total data loss is unrecoverable | Confirmed |
| **H-1** | High | Browser security headers do not apply to the live application | Confirmed live |
| **H-2** | High | Data-at-rest encryption is silently optional; production state unknown | Confirmed in code |
| **H-3** | High | Source repository is public | Confirmed live |
| **M-1** | Medium | Session tokens stored unhashed in KV | Confirmed |
| **M-2** | Medium | Onboarding records stored in plaintext | Confirmed |
| **M-3** | Medium | Client portal served from a `workers.dev` domain | Confirmed live |
| **M-4** | Medium | Single-blob compliance store has a lost-update race | Confirmed |
| **M-5** | Medium | No deployment gate; tests are not enforced and 2 of 3 fail locally | Confirmed |
| **L-1** | Low | `'unsafe-inline'` required in CSP by architecture | Confirmed |
| **L-2** | Low | `/api/admin/mfa/enroll` is not rate limited | Confirmed |
| **L-3** | Low | No session revocation or listing capability | Confirmed |
| **I-1** | Info | Stale/contradictory security comments in `worker.js` header | Confirmed |
| **I-2** | Info | Dead `ADMIN_PASSWORD` fallback branch | Confirmed |

### What is done *well* (stated because it is unusual at this scale)

- Passwords: PBKDF2-SHA256, 100k iterations, per-user 16-byte random salt, `timingSafeEqual`
  comparison. Correct.
- **Mandatory** TOTP 2FA for all staff, with rate limiting on verification and single-use
  SHA-256-hashed backup codes.
- Invite and reset tokens are stored **hashed** (`sha256Hex`), so a KV dump can't be replayed.
- Encryption **fails closed**: `decryptToObject` throws rather than returning null, so a missing
  key can never be mistaken for "no data" and overwrite real records (`worker.js:1157-1176`).
- MFA lookup failure also fails closed — a decrypt error becomes a 500, not an MFA bypass
  (`worker.js:813-816`).
- Consistent input validation: every string length-capped, every enum whitelisted.
- Consistent output escaping — `escapeHtml` is used ~2.7x more often than `innerHTML` across the
  admin pages, and it is implemented correctly via `textContent` round-trip
  (`shared.js:106-111`).
- KYC/medical/passport data deliberately isolated into `clientinfo:` so it stays out of the
  contacts boot payload and out of the SharePoint sync path — a real privacy-by-design decision
  with the reasoning written down (`worker.js:5233-5250`).
- Audit logging records field *names* but never sensitive values, explicitly to avoid spreading
  passport/licence numbers into a 13-month-retention log (`worker.js:5430-5435`).
- CSRF is structurally absent: bearer tokens in headers, no cookies, no wildcard CORS.
- No secrets committed. `git grep` and a full-history scan for key patterns found nothing;
  `.gitignore` correctly covers `.dev.vars`, `.env`, `.wrangler/`.

---

## C-1 — No backups (Critical)

**Evidence.** No backup, export, or snapshot mechanism exists anywhere in the repository,
`wrangler.toml`, or the scheduled handler. `handleScheduled` (`worker.js:7901-7916`) performs
only SharePoint syncs. Cloudflare Workers KV has no automatic point-in-time recovery.

**Impact.** All 29 record namespaces — contacts, KYC data, tasks, notes, households, compliance
history, audit log, client assessment answers — exist in exactly one place. An accidental
namespace deletion, a compromised Cloudflare account, or a bad migration script means
**permanent, total loss** of the firm's CRM. For an SEC-registered investment adviser this also
has recordkeeping implications (books-and-records rules expect retained, recoverable records).

Partial mitigation exists by accident: contacts, client documents, compliance items, and the
learning library are mirrored to SharePoint, so *some* data could be rebuilt. Tasks, notes,
`clientinfo:`, timeline, audit log, assessment responses, and households' app-only fields
exist **only** in KV.

**Recommendation.** Add a scheduled export. A second cron in the same Worker can enumerate KV
by prefix and write a JSON snapshot to SharePoint or R2 daily. This is a few hours of work and
removes the worst downside in the system. Test the restore path, not just the export.

---

## H-1 — Security headers do not apply to the live application (High)

**Evidence — confirmed live.** `serveAsset()` (`worker.js:7934-7950`) sets
`Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy`, `Permissions-Policy`, and `Strict-Transport-Security`. Live observation:

| Request | Headers present? |
|---|---|
| `GET /` | **None.** `Cache-Control: public, max-age=0, must-revalidate` |
| `GET /assets/script.js` | **None.** |
| `GET /admin/settings` | **None.** |
| `GET /definitely-not-a-real-file-xyz.html` (404) | **All of them**, plus `Cache-Control: no-cache` |

**Root cause.** `wrangler.toml` declares `[assets]` with no `run_worker_first`. Cloudflare
Workers Static Assets therefore serves any path matching a file in `./public` **directly, without
invoking the Worker**. `serveAsset` runs only as the fall-through for paths that match no asset —
i.e. only for 404s. Every security header in this codebase is applied exclusively to responses
that need them least.

**Impact.** The live application has no CSP (so any XSS becomes fully exploitable), no
clickjacking protection, no MIME-sniffing protection, and no HSTS. The intended
`Cache-Control: no-cache` is also not applied, reintroducing the exact stale-JS problem the
code comment at `worker.js:7918-7931` describes fixing.

**Recommendation.** Two options; the second is better for a static-heavy site:

1. Set `run_worker_first` for the relevant routes in `[assets]` so the Worker sees asset
   requests. Costs a Worker invocation per asset request.
2. **Preferred:** add a `public/_headers` file, which Cloudflare Workers Static Assets applies
   natively at no invocation cost. Move the header set there and keep `serveAsset` as-is for
   the 404 path.

Verify after deploying by re-running `curl -I` on `/` and confirming CSP is present.

---

## H-2 — Encryption is silently optional (High if unset)

**Evidence.** `encryptJSON` (`worker.js:1132-1147`):

```js
const key = await getDataKey(env);
if (!key) return plaintext;   // no log, no warning, no error
```

`getDataKey` returns `null` when `env.DATA_ENCRYPTION_KEY` is absent. So with the secret unset,
every "encrypted" namespace — `contact:`, `clientinfo:` (passport, green-card and driver's-licence
numbers, medical conditions), `task:`, `note:`, `household:`, `clientdoc:`, `docreq:`,
`compliance_items`, `timeline:`, `activity:`, `admin_mfa:` — is written in plain text, with no
indication anywhere in the UI or logs.

**Whether the secret is set in production is UNKNOWN** — Cloudflare secrets are write-only and
this could not be checked without dashboard access.

**Impact if unset.** A leaked KV export or a stolen KV read token exposes the firm's complete
client PII in clear text, including identity-document numbers and medical notes. Also:
`admin_mfa:` records would be plaintext, exposing TOTP seeds — which would let an attacker with
KV read access generate valid second factors.

**Recommendation.**
1. **Immediately verify** the secret is set: Cloudflare -> Workers & Pages -> blueline-portal ->
   Settings -> Variables and Secrets. Look for `DATA_ENCRYPTION_KEY`.
2. If unset, set it — but understand that **existing plaintext records stay plaintext** (they are
   read back via the legacy path) and only subsequent writes are encrypted. A re-encryption pass
   over existing keys is needed for real coverage.
3. Add a startup/diagnostic warning so this state is visible rather than silent. A line in the
   existing `/api/admin/sharepoint/site`-style diagnostic endpoints reporting
   `dataEncryption: 'on'|'OFF'` would make it observable without exposing the key.
4. Record in the runbook that this key must never be rotated without a re-encryption migration
   (`worker.js:1090-1093` already warns; it belongs in ops docs too).

---

## H-3 — Public source repository (High)

**Evidence.** `gh repo view franksabin/blueline-portal --json visibility` returns
`{"visibility":"PUBLIC","isPrivate":false}`. Created 2026-07-08.

**Impact.** No credentials are exposed — that was checked and is clean. What *is* exposed:

- The complete server-side authorization model, including which endpoints are gated by which
  role and the exact `X-Admin-Workspace` mechanism.
- Every endpoint path and its expected payload shape.
- The full KV schema and which records are encrypted.
- **Real staff email addresses** hardcoded at `worker.js:85-89` (`fsabin@`, `jyoung@`,
  `intern@blueline-advisors.com`), plus `esullivan@` elsewhere — a ready-made target list for
  credential stuffing and phishing.
- The names of all Cloudflare secrets, which tells an attacker exactly what to look for if they
  ever gain partial access.
- The dev mock's password *format* (`dev-<name>-pass`), which hints at naming conventions.

None of this is a vulnerability by itself — the security does not depend on the code being
secret. But for a firm holding client financial data, publishing the blueprint is very likely
unintended and it materially lowers the effort of attacking the system.

**Recommendation.** Make the repository private unless there is a deliberate reason for it to
be public. If it must stay public, move `ADMIN_ACCOUNTS` emails into environment configuration.
Note that making it private does not un-publish history — assume everything already committed
is public knowledge, and rotate anything you would not want known (nothing sensitive was found,
so this is likely a non-issue in practice).

---

## M-1 — Session tokens stored unhashed

`session:<token>` and `admin_session:<token>` use the raw bearer token as the KV key
(`worker.js:611, 1031`). Anyone with KV read access can enumerate live tokens and impersonate
any user or admin without a password or second factor.

This is inconsistent with the codebase's own better practice: invite and reset tokens *are*
hashed (`client_invite:${await sha256Hex(token)}`). Applying the same treatment to sessions —
store `session:<sha256(token)>`, hash on lookup — costs one hash per request and closes the gap.
Requires invalidating existing sessions on deploy.

## M-2 — Onboarding records stored in plaintext

`onboarding:<id>` is written with bare `JSON.stringify` (`worker.js:2261, 2329, 2431, 2452`) —
the only client-data namespace not passed through `encryptJSON`. Records include a `data{}` blob
and a captured signature image.

**Mitigating context:** the wizard explicitly instructs *"Use fake/test data only — no real
personal details, no SSNs"* (`public/onboarding/index.html:131`) and labels its date-of-birth
field *"(fake data only)"*. It is a documented proof of concept.

**The risk is that the instruction is ignored.** A signature image plus name and DOB is
identity-theft-grade material. Either encrypt these records like everything else (a two-line
change), or gate the wizard behind an explicit feature flag so it cannot be reached by a real
client by accident.

## M-3 — Client portal on a `workers.dev` domain

Clients log in and upload financial documents at `blueline-portal.fsabin.workers.dev`. DNS
confirms no `portal.blueline-advisors.com` exists; the firm's own domain points to Squarespace.

This is a client-trust and anti-phishing problem more than a technical one: a security-aware
client cannot distinguish this from a phishing site, and it trains clients to accept non-firm
domains for financial data. It also puts the portal on a shared Cloudflare-wide domain and
embeds a personal-looking subdomain (`fsabin`) in a firm-facing URL.

**Recommendation.** Add a custom domain. Cloudflare makes this a few minutes of configuration
plus DNS. Keep the `workers.dev` hostname working during transition.

## M-4 — Lost-update race on the compliance tracker

All 128 compliance items live in one KV value (`compliance_items`). Every create/update/delete
reads the whole blob, mutates it, and writes it back (`worker.js:4524`). Two admins signing off
different items within the same read-modify-write window will silently lose one of the two
edits — last write wins, no conflict detection, no error.

Given a 4-person firm this is unlikely but not negligible, and compliance sign-off is exactly
the kind of record where a silently lost write matters. Options: per-item keys (`compliance:<id>`)
following the pattern already used for tasks and notes, or an optimistic-concurrency version
check on the existing `version: 1` field, which is currently stored but never checked.

## M-5 — No deployment gate

Pushing to `main` deploys to production in 1-2 minutes with no test run, no staging, and no
approval. There is no CI configuration in the repo (Workers Builds is configured dashboard-side).
Separately, 2 of the 3 test scripts currently fail on a Windows checkout — for line-ending
reasons rather than real defects (see [15-operations.md](15-operations.md)) — so a developer who
runs them sees failures and learns to ignore the suite.

**Recommendation.** Add a `.gitattributes` with `* text=auto eol=lf` to fix the false failures,
then run the three scripts in Workers Builds (or a GitHub Action) as a pre-deploy gate.

## L-1 — CSP requires `'unsafe-inline'`

The intended CSP includes `script-src 'self' 'unsafe-inline'` because every admin page carries
its own large inline `<script>`. This substantially weakens CSP's XSS mitigation. It is a
consequence of the no-build-step architecture, not an oversight. Moving inline scripts to
external files would allow dropping `'unsafe-inline'`; that is a meaningful refactor. Lower
priority than H-1 — a weakened CSP still beats no CSP.

## L-2 — `/api/admin/mfa/enroll` is not rate limited

Rate limiting is applied at exactly six call sites (`worker.js:568, 667, 713, 791, 999, 2239`).
`handleAdminMfaEnroll` is not among them. It does require a valid `pendingToken` (10-minute TTL,
password already proven), and the handler refuses to overwrite a *confirmed* authenticator, so
the practical impact is limited to churning unconfirmed enrolment secrets. Adding the
`adminlogin` scope to it is a one-line change.

## L-3 — No session revocation or visibility

There is no way to list active sessions or force-logout a user. The only lever is a password
reset (which now does kill sessions — added 2026-08-20). For a lost laptop scenario, that is the
documented procedure and it works, but an explicit "sign out everywhere" would be better.

## I-1 — Stale security comments in `worker.js`

The file header (`worker.js:59-62`) states: *"there is still no application-level encryption of
client PII"*. This is **false and self-contradicting** — the KV layout comment 40 lines above it
(`worker.js:22-23`) describes the AES-256-GCM envelope, and the implementation is at
`worker.js:1077+`.

Also stale: the header's endpoint list (`worker.js:29-43`) documents ~13 endpoints; there are
82.

This matters because a future developer or auditor reading the header will draw a wrong
conclusion about the system's security posture. Fix the comment.

## I-2 — Dead `ADMIN_PASSWORD` fallback

`worker.js:135` falls back to a shared `ADMIN_PASSWORD` secret when an individual one is unset.
The account owner confirmed (2026-08-20) that this secret **does not exist** in Cloudflare, so
the branch always yields `''` and the `!!expected` guard fails closed. It is dead code; removing
it eliminates a confusing shared-credential path.

**More useful corollary:** because there is no fallback, each of the three legacy accounts needs
its own `ADMIN_PASSWORD_<NAME>` secret to log in at all, and a missing one is indistinguishable
from a wrong password. Confirm `ADMIN_PASSWORD_JYOUNG` and `ADMIN_PASSWORD_INTERN` exist.

---

## Areas assessed and found acceptable

| Area | Assessment |
|---|---|
| SQL injection | N/A — no SQL |
| XSS | Consistent `escapeHtml` usage, correctly implemented. Weakened only by the missing CSP (H-1). No `eval`, no `new Function`, no `document.write` anywhere in shipped code. Three `insertAdjacentHTML` call sites exist in `contacts.html` (lines 1789, 1909, 4836); all three build their markup from functions that escape interpolated values. |
| CSRF | Structurally absent (bearer tokens, no cookies) |
| CORS | Restrictive; explicit allowlist only, no wildcard, no credentials mode |
| Password storage | PBKDF2-SHA256 100k + per-user salt + constant-time compare |
| File uploads | Chunked (5 MB chunks, a multiple of the 320 KiB Graph requires), size-capped (client documents 250 MB, learning library 2 GB, onboarding payload 100 KB), routed to SharePoint rather than stored/executed locally. Signature PNG validated by prefix without decoding attacker-controlled data. |
| Enumeration | Login returns a uniform "Invalid email or password". Onboarding ids are random, not sequential — with an in-code comment explaining the choice. |
| Secrets in source | None found in tree or history |
| Client-side data exposure | `clientinfo:` deliberately excluded from bulk payloads; clients cannot read other clients' data or their own scored results |
| Dependency supply chain | Essentially zero attack surface — one vendored library, no npm install at build time |
