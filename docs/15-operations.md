# 15. Operations

---

## Error handling

**One top-level try/catch** wraps the entire request dispatch (`worker.js:8400-8407`):

```js
} catch (err) {
  console.error('Unhandled error', url.pathname, request.method, (err && err.stack) || err);
  return json({ error: 'Internal server error' }, 500, cors);
}
```

Design: real error logged server-side with path and method for context; caller gets a generic
message with no stack leak. Correct.

Handler-level patterns:

| Pattern | Where | Rationale |
|---|---|---|
| Best-effort with swallowed errors | `logTimeline` (*"swallow — history is best-effort"*), Outlook push, SharePoint push | A history or calendar failure must never block the underlying business write |
| Fail closed | `decryptToObject` throws; `getAdminMfa` throws -> 500 | Never treat undecryptable data as absent |
| Independent try/catch per job | `handleScheduled` | *"a contacts sync failure must not skip the household pull, and vice versa — they're independent lists with independent risk"* |
| Per-record error counting | `readAllEncrypted` returns `{items, errors}` | One corrupt record cannot blank a whole listing; the count surfaces in the UI as a warning |

That last one is worth noting as a good pattern: `handleAdminListTasks` returns
`decryptErrors: n`, and the page renders *"Warning: N task(s) could not be decrypted."* Partial
failure is visible rather than silent.

## Logging and observability

Enabled in `wrangler.toml`:

```toml
[observability]
enabled = true
[observability.logs]
enabled = true
```

| Signal | Where to see it |
|---|---|
| `console.error('Unhandled error', path, method, stack)` | Cloudflare dashboard -> Workers -> blueline-portal -> Logs; or `wrangler tail` |
| `console.log('Scheduled SharePoint sync completed:', result)` | Same |
| `console.error('Scheduled SharePoint sync failed:', err)` | Same |
| Request metrics, invocation counts, CPU time, error rate | Cloudflare Workers Metrics |
| Business-level actions | The in-app **audit log** (Settings page) |

### What does not exist

| Missing | Consequence |
|---|---|
| Error tracking (Sentry etc.) | No aggregation, no alerting, no release correlation |
| Uptime monitoring | An outage is discovered by a user reporting it |
| **Alerting on cron failure** | SharePoint sync can be broken for days with nobody knowing — it only logs |
| Analytics / product telemetry | No usage data at all |
| Structured logging | Plain `console.*` strings; not queryable by field |
| Request tracing / correlation ids | Cannot follow one request across log lines |
| Performance monitoring | No latency budgets or slow-query visibility |

**Highest-value additions, cheapest first:** (1) a Cloudflare notification on Worker error-rate
spike; (2) an external uptime check against `/` and one authenticated endpoint; (3) a log line the
cron emits on *success* so its absence is detectable.

## The audit log

The best operational tool in the system. `logAudit()` (`worker.js:767`) writes
`audit:<invTs>:<rand>` with `{ts, email, action, detail}`, ~13-month TTL.

**Key naming trick:** inverted timestamps mean the newest entry sorts first, so the viewer reads
with a single bounded `list({limit:50})` — cost stays flat as the log grows rather than requiring
a full-namespace scan.

Actions logged: `login`, `create-admin`, `rename-admin`, `remove-admin`, `reset-mfa`,
`reset-password`, `workspace-access-changed`, `create-client-invite`, `create-client-reset`,
`update-contact`, `update-client-info`, `set-assignments`, `delete-onboarding`,
`restore-onboarding`.

**Deliberate privacy choice:** `update-client-info` records field **names only**, never values —
*"the values here include passport and licence numbers and medical notes; the audit log has a
13-month TTL and its own viewer, and copying that material into it would spread it for no
investigative gain"* (`worker.js:5430-5435`).

Viewer: Settings page, loaded **once on entry and on manual Refresh only** — deliberately not on
the 20s poll, since the log does not change live and polling would burn KV reads per open tab.
"Load older" pages 10 at a time.

## Incident investigation playbook

**1. Is the site up?**
```bash
curl -sI https://blueline-portal.fsabin.workers.dev/ | head -1
```
Assets are served by the Cloudflare asset platform, so a 200 here does **not** prove the Worker
is healthy. Test the Worker separately:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://blueline-portal.fsabin.workers.dev/api/admin/admins
# expect 401 (Worker running, auth rejecting). 500 = Worker broken.
```

**2. What changed?** `git log --oneline -10`. Deploys follow pushes to `main` within ~2 minutes,
so correlate incident time with push time.

**3. Read the logs.** Cloudflare -> Workers -> Logs, or `wrangler tail` on an x64 machine. Look
for `Unhandled error` with the pathname.

**4. Who did what?** Settings -> Audit Log. Covers all privileged actions with actor and
timestamp.

**5. Is it integration-only?** If the CRM works but SharePoint/Outlook features are dead,
suspect `OUTLOOK_CLIENT_SECRET` expiry first — see
[18-troubleshooting.md](18-troubleshooting.md).

**6. Everyone locked out of login with 500s?** Suspect `DATA_ENCRYPTION_KEY` — `getAdminMfa`
fails closed by design.

**7. Rollback.** `git revert` + push, or Cloudflare Deployments -> Rollback.
**Remember: code rollback does not undo data changes, and there is no backup.**

## Testing strategy

**Honest assessment: there is effectively no automated test coverage.** Three script files,
~1,200 lines, mostly asserting on source text rather than behaviour.

| File | Lines | Type | Status | Covers |
|---|---|---|---|---|
| `test-prospects.js` | 1,041 | Behavioural w/ stubs + source assertions | **FAILS on Windows** (CRLF) | Clients/Prospects split, learning tags, prospect field registration |
| `test-household-sync.js` | 108 | Behavioural w/ stubs | **PASSES** (12 assertions) | SharePoint household pull clobbering app-only fields |
| `test-portal-regressions.js` | 57 | Source-text assertions | **FAILS on Windows** (CRLF) | Household assignments, invite consumption, onboarding auth, signature validation |

```bash
node scripts/test-household-sync.js
node scripts/test-portal-regressions.js
node scripts/test-prospects.js
```

> ### The two failures are line endings, not defects
> `core.autocrlf=true` + no `.gitattributes` -> Git stores LF, checks out CRLF on Windows. Both
> failing tests assert on literal strings containing `\n`. **Verified:** both assertions pass
> against LF-normalised sources and the guarded behaviour is intact. They pass on Linux/CI.
> Fix with a `.gitattributes` containing `* text=auto eol=lf`. Full detail in
> [11-local-development.md](11-local-development.md).

**Nothing runs these automatically.** No CI, no pre-commit hook, no pre-deploy gate.

### Coverage gaps, by risk

| Untested | Risk |
|---|---|
| **All SharePoint/Outlook paths** | High — the mock has no Graph layer, so these are only ever exercised in production |
| Encryption round-trip | High — a regression here is silent and irreversible |
| Auth/MFA/TOTP end to end | High — RFC vectors were checked once during development, not on an ongoing basis |
| Workspace isolation | High — a missing check silently leaks data across staff |
| Every HTTP handler | High — no endpoint has an integration test |
| Chunked upload | Medium |
| Recurrence date maths (month-end clamping) | Medium — pure function, trivially testable, currently untested |
| All frontend behaviour | Medium |

**Recommended first tests**, in order — each is high-value and cheap because the logic is already
pure:

1. `advanceDue()` — month-end clamping, all 6 repeat intervals.
2. `encryptJSON`/`decryptToObject` round-trip, including the legacy-plaintext path and the
   throw-on-missing-key behaviour.
3. TOTP against the RFC 6238 vectors (the code claims this was validated; make it permanent).
4. `accessibleWorkspaceOwners()` truth table for all four roles.
5. `riskCategoryForScore()` boundaries.

All five are pure functions reachable by importing `worker.js` in Node with a stubbed `env`.

## Maintenance scripts

| Script | Purpose | Safe to re-run? |
|---|---|---|
| `scripts/add-compliance-area.js` | One-off: stamped `complianceArea` onto compliance seed rows and normalised `frequency` into a filterable value while preserving original wording as `frequencyDetail` | **No — already applied.** Historical record only. |

There are no operational scripts — no backup, restore, export, KV inspection, user
administration, or data-repair tooling. Everything is done through the UI or the Cloudflare
dashboard.

## Migration process

No migration system. See [12-deployment.md](12-deployment.md). The dominant and preferred pattern
is **read-time tolerance**: write new fields optimistically, default them when absent
(`recordWorkspace()` defaulting to Frank; missing `assignments:` meaning "all visible";
`decryptToObject` passing legacy plaintext through; `hnw` category applied on read).

Avoid bulk rewrites: there is no transaction, no dry-run facility, and **no backup**.

## Routine maintenance calendar

Nothing here is currently automated or scheduled. Recommended:

| Cadence | Task |
|---|---|
| **Before expiry** | Rotate `OUTLOOK_CLIENT_SECRET`. **Put the expiry date in a calendar now** — its lapse kills every integration at once. |
| Daily (recommended) | Verify a KV backup ran — **once one exists** (security C-1) |
| Weekly | Skim the audit log for unexpected privileged actions |
| Weekly | Check Cloudflare Logs for repeated `Scheduled SharePoint sync failed` |
| Monthly | Confirm Cloudflare usage is within expectations (the every-minute cron is the main driver) |
| Quarterly | Review admin accounts and remove departed staff; confirm MFA enrolled on all |
| Quarterly | Re-check `vendor/pdf-lib.esm.min.js` for advisories |
| On staff change | Add/remove admin; if it involves one of the four hardcoded accounts, a code change is required |

## Performance notes

No profiling has been done. Structural characteristics:

- **Listing endpoints are O(n) KV reads.** `readAllEncrypted(env, 'task:')` enumerates keys then
  `get()`s each one. Fine at hundreds of records; will become the first bottleneck.
- Two in-memory caches (Graph token, AES key) are per-isolate and correctly implemented.
- Admin pages poll every 30s; each poll issues several parallel requests
  (`workspaces`, `contacts`, `tasks`, `activity`, `notifseen`, `lists`). With 4 staff and a few
  tabs open, this is the dominant steady-state KV read load — more than actual user activity.
- The audit log's inverted-timestamp keys are the one place read cost was deliberately engineered
  to stay flat.
