# 20. Failure-Impact Analysis

What actually happens when each dependency fails. Written so leadership can read the verdict
column and engineers can read the rest.

**Verdict scale:**

| Verdict | Meaning |
|---|---|
| **Catastrophic** | Product unusable and/or data permanently lost |
| **Degraded** | Core work continues; specific features stop |
| **Recoverable** | Breaks, but fully restorable with no data loss |
| **Mostly invisible** | Users would likely not notice |

---

## Summary

| # | Dependency fails | Verdict | Time to notice | Data loss? |
|---|---|---|---|---|
| 1 | Cloudflare Workers platform | **Catastrophic** | Immediate | No |
| 2 | Cloudflare KV | **Catastrophic** | Immediate | Possibly permanent |
| 3 | `DATA_ENCRYPTION_KEY` lost | **Catastrophic** | Minutes (login 500s) | **Yes, permanent** |
| 4 | Cloudflare account compromised | **Catastrophic** | Possibly never | Yes |
| 5 | Microsoft 365 / Graph outage | Degraded | Minutes-hours | No |
| 6 | `OUTLOOK_CLIENT_SECRET` expires | Degraded | **Hours-days** | No |
| 7 | A single SharePoint list id wrong | Degraded (one feature) | Days-weeks | No |
| 8 | SharePoint sync clobbering bug fires | Degraded | Minutes | **Yes, per-record** |
| 9 | GitHub unavailable | Mostly invisible | On next deploy | No |
| 10 | Cron stops running | Degraded, silent | **Days-weeks** | No |
| 11 | `ADMIN_PASSWORD_<NAME>` missing | Degraded (one person) | Immediate for them | No |
| 12 | All admins lose MFA devices | Recoverable | Immediate | No |
| 13 | Bad deploy | Recoverable | Minutes | Only if it mutated data |
| 14 | Original developer unavailable | Degraded | On the first incident | No |
| 15 | pdf-lib has a vulnerability | Mostly invisible | Never (nothing checks) | No |

---

## 1. Cloudflare Workers platform outage — Catastrophic

Everything is here: the app, the API, the static files, the database. A regional Cloudflare
outage takes the whole product offline for both staff and clients.

- **Mitigation available:** none. There is no multi-cloud story and, for a 4-person firm, adding
  one would be disproportionate.
- **Recovery:** automatic when Cloudflare recovers.
- **Detection:** a user reports it. There is no uptime monitoring.
- **Reasonable response:** accept the risk; add an external uptime check so you learn about it
  before a client does.

## 2. Cloudflare KV loss or deletion — Catastrophic

The single worst scenario in the system.

**All 29 namespaces exist in exactly one place, with no backup.** An accidental namespace
deletion, a bad bulk script, or account compromise means permanent loss of contacts, KYC records,
tasks, notes, households, compliance sign-off history, the audit log, and client assessment
answers.

**Partial reconstruction is possible by accident**, because SharePoint mirrors some data:

| Recoverable from SharePoint | **Not recoverable — KV only** |
|---|---|
| Contacts (SharePoint-owned scalars) | `clientinfo:` — KYC, passport/licence numbers, medical notes |
| Client documents (the files) | Tasks and their history/checklists |
| Compliance items | Notes |
| Learning library | Timeline and activity history |
| Households (SharePoint columns only) | Audit log |
| | Assessment responses (`responses:`, `hhresponses:`) |
| | Module assignments |
| | Households' app-only fields (`keyDocuments`, `kind`, `emailPrimary`, `members`) |
| | Portal accounts (`user:`) and board configuration |

**Recommendation (this is security finding C-1):** add a daily scheduled export. A second cron in
the existing Worker can enumerate KV by prefix and write a JSON snapshot to SharePoint or R2. Test
the restore, not just the export.

## 3. `DATA_ENCRYPTION_KEY` lost or changed — Catastrophic

`worker.js:1090-1093` states it plainly: if the key is lost or changed after real data is
encrypted, that data is **permanently unreadable.** There is no escrow, no re-encryption
migration, and no backup.

**Immediate symptom:** every admin login returns 500, because `getAdminMfa` decrypts
`admin_mfa:<email>` and throws by design rather than silently skipping MFA. Listings then report
"N record(s) could not be decrypted."

- **If changed:** restore the exact previous value. Do not guess — a wrong key is
  indistinguishable from a lost one.
- **If genuinely lost:** all encrypted records are gone. MFA records must be deleted from KV so
  admins can re-enrol; client data cannot be recovered.
- **Prevention:** store it in the firm's password manager **now**, with two people having access.
  Never rotate without writing and testing a re-encryption script first.

## 4. Cloudflare account compromise — Catastrophic

The code is explicit that encryption *does not* defend against this
(`worker.js:1085-1088`): the key lives in the same account as the data, so this protects against
a leaked KV export, not against an attacker inside the account.

**The control is MFA on the Cloudflare account itself** — and whether it is enabled is
**UNKNOWN**. This is on the handoff checklist as a priority item.

Blast radius: full data read, full data destruction, code replacement (the attacker could serve a
credential-harvesting page at the client portal URL), and secret exfiltration is *not* possible
(secrets are write-only) but secret *replacement* is.

## 5. Microsoft 365 / Graph outage — Degraded

The architecture handles this well, and by design: **KV is primary, SharePoint is a mirror.**

| Stops | Keeps working |
|---|---|
| Contact/household sync | All CRM reads and writes |
| Document upload and download | Tasks, notes, calendar, compliance |
| Learning library | Client portal, assessments, login |
| Outlook calendar push | Everything else |
| Client email reading | |

Failures are caught and logged; the two cron jobs have independent try/catch so one cannot block
the other. **No data is lost** — sync resumes on the next cron. Users see missing features, not
errors.

## 6. `OUTLOOK_CLIENT_SECRET` expires — Degraded, and the most likely real incident

One secret authenticates **all** Graph access. When it expires, every integration stops
simultaneously while the core CRM keeps working.

**This is the highest-probability failure in the system** because it is scheduled: Entra client
secrets expire on a fixed date (commonly 6-24 months), nothing in this codebase records that
date, and nothing alerts.

**Time to notice: hours to days**, because each feature degrades *silently* — no error surfaces,
the feature just stops happening. Someone eventually notices SharePoint has not updated.

**Action now:** find the expiry date in Entra and put it in a calendar reminder with a month's
warning. Rotation itself is safe and instant (unlike `DATA_ENCRYPTION_KEY`).

## 7. One wrong SharePoint list id — Degraded, single feature

Each integration gates on its own config and skips silently when unconfigured. A wrong or missing
list id disables exactly one feature with no error message.

**Time to notice: days to weeks** — nobody notices the learning library is empty until they need
it. Diagnose with `GET /api/admin/sharepoint/lists`, which exists for this purpose.

## 8. SharePoint sync clobbering bug fires — Degraded, with real data loss

Not a hypothetical: it happened and `scripts/test-household-sync.js` exists to pin the fix.

Because KV is eventually consistent, the every-minute pull can read a **pre-save** copy of a
record it just pushed, conclude SharePoint is newer, and rebuild from that stale base — wiping
fields SharePoint has no column for.

**Impact:** silent per-record loss of app-only fields. **Symptom:** "my change reverted itself
about a minute later." **Data loss is real but small-scale and re-enterable.**

Mitigations: keep the strip-undefined fix intact; relax the cron from `*/1` to `*/5`+ (a tighter
loop makes this *more* likely).

## 9. GitHub unavailable — Mostly invisible

The running site is unaffected — Cloudflare serves already-deployed code. You simply cannot
deploy. Recovery is automatic.

The one caveat: **GitHub is also the only backup of the source code.** A repo deletion would be
recoverable only from local clones. Given the repo is currently public, a copy almost certainly
exists elsewhere, but that is luck rather than a strategy.

## 10. Cron stops running — Degraded, and silently

If the cron trigger is removed or persistently fails, SharePoint sync stops. **Nothing alerts.**
The manual sync endpoints (`/api/admin/contacts/sync`, `/api/admin/households/sync`) still work,
so a shared-view manager can trigger it by hand.

**Time to notice: days to weeks.** The cron logs successes and failures, but nobody reads logs
unprompted.

**Cheap fix:** have something check for the absence of a recent success log line.

## 11. `ADMIN_PASSWORD_<NAME>` missing — Degraded, one person

That staff member cannot log in, and the error is `"Invalid email or password"` —
**indistinguishable from a wrong password.** They will reasonably conclude they forgot it.

There is no shared-password fallback (`ADMIN_PASSWORD` is confirmed absent), so the failure is
absolute for that account. Fix: set the secret. Immediate, no redeploy.

Worth verifying now whether `ADMIN_PASSWORD_JYOUNG` and `ADMIN_PASSWORD_INTERN` exist.

## 12. All admins lose their MFA devices — Recoverable

Layered recovery, best first:

1. **Backup codes** — 8 single-use codes issued at enrolment. (Did anyone keep them? **UNKNOWN.**)
2. **Another shared-view manager** resets their MFA from Settings.
3. **Last resort:** delete `admin_mfa:<email>` directly in KV via the Cloudflare dashboard, which
   forces re-enrolment on next login.

Route 3 means **Cloudflare dashboard access is the true break-glass credential** for this system.
Whoever holds it can restore admin access; whoever does not, cannot. Ensure at least two people
can reach it.

## 13. Bad deploy — Recoverable

`git revert` + push, or Cloudflare Deployments -> Rollback. Live again in 1-2 minutes.

**But code rollback does not undo data changes**, and there is no backup. A deploy that corrupted
or deleted records is not recoverable by rolling back. Treat data-mutating deploys as one-way.

Aggravating factors: no staging, no automated test gate, and 2 of 3 tests currently show red on a
Windows checkout so a developer may have stopped trusting the suite.

## 14. Original developer unavailable — Degraded

254 commits in 6 weeks from effectively one person. No one else has debugged this system.

**Mitigating factors** — genuinely better than typical:
- Unusually dense in-code comments that record *why*, not just what.
- `STATUS.md`: a 1,680-line design journal.
- These documents.
- Zero dependencies and no build step, so nothing rots and nothing is hidden behind tooling.

**Remaining risk:** reading is not the same as having fixed something under pressure. The fix is
to get a second engineer through
[21-new-developer-start-here.md](21-new-developer-start-here.md) and shipping real changes **while
the original developer is still reachable.**

## 15. pdf-lib vulnerability — Mostly invisible

One vendored dependency, no version recorded, nothing watching for advisories. Attack surface is
narrow (server-side PDF generation for signed agreements, plus client-side signing).

Nobody would find out unless they went looking. Cheap mitigation: a `vendor/README.md` recording
package, version, source URL, and date vendored.

---

## Composite scenario worth planning for

**"The Cloudflare account is compromised."** It is the only single event that is simultaneously
catastrophic, plausible, and currently under-defended:

1. Attacker reads all client PII (encryption does not help — key is in the same account).
2. Attacker can delete KV (no backup -> permanent loss).
3. Attacker can replace the Worker with a credential-harvesting page at the client portal URL,
   which clients have been trained to trust and which is not on a firm-branded domain.

**The three controls that matter, in order:**
1. **Cloudflare account MFA**, ideally hardware-key, for every user with access. Verify this
   first.
2. **Off-account backups** (C-1) so destruction is not permanent.
3. Least-privilege API tokens instead of shared account credentials.

None of these is expensive. All three are currently unverified or absent.
