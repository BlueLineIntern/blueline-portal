# 17. Technical Debt and Risk Review

Each item: evidence, impact, severity, recommendation. Security-specific findings live in
[14-security-review.md](14-security-review.md) and are cross-referenced rather than repeated.

**Severity here is engineering risk** (likelihood of causing a defect or blocking work), not
security severity.

---

## Summary

| ID | Severity | Item |
|---|---|---|
| **D-1** | High | The dev backend is a second, hand-written implementation |
| **D-2** | High | Bus factor of 1; no second developer has worked in the code |
| **D-3** | High | Test suite is source-text assertions; 2 of 3 fail on Windows |
| **D-4** | Medium | `worker.js` is a single 8,414-line module |
| **D-5** | Medium | Route ordering is load-bearing and silently breakable |
| **D-6** | Medium | No type checking or linting of any kind |
| **D-7** | Medium | Duplicated declarations across 3 files (UI / worker / mock) |
| **D-8** | Medium | Duplicated timeline label maps |
| **D-9** | Medium | Open bug: mock serialises 1-element arrays as objects |
| **D-10** | Medium | Every-minute cron amplifies an eventual-consistency bug |
| **D-11** | Medium | Hard-coded staff identity; ownership not transferable |
| **D-12** | Low | Manual cache-busting |
| **D-13** | Low | Stale documentation inside `worker.js` |
| **D-14** | Low | `contacts.html` is 5,988 lines |
| **D-15** | Low | No cleanup path for several KV namespaces |
| **D-16** | Low | Line-ending inconsistency; no `.gitattributes` |
| **D-17** | Low | Misleadingly named `agreement-pdf-worker.js` |
| **D-18** | Info | Vendored dependency with no version tracking |

---

## D-1 — The dev backend is a second implementation (High)

**Evidence.** `dev-server.ps1` is 3,265 lines of PowerShell re-implementing the same API surface
as `worker.js`. Its own header says to keep computed fields in sync with `worker.js`. It exists
because `workerd` has no `win32-arm64` build, so `wrangler` cannot install on the developer's
machine.

**Impact.** Every backend change must be written **twice, in two languages**. Divergence is not
hypothetical — three instances were found and fixed in a single session on 2026-08-20:

| Divergence | Effect |
|---|---|
| `Get-AccessibleWorkspaces` returned a nested array | **Every** admin endpoint 403'd locally |
| `Read-JsonBody` (undefined function) called instead of `Read-Body` | Admin rename returned 500 locally; worked in production |
| Validation order in the password-reset endpoint differed | Worker gave a misleading error; **the mock was the correct one** |

That last one is the instructive case: the mock is not merely a lossy copy — the two
implementations can each be right about different things, and reconciling them is real work.
Worse, the mock has **no Graph layer at all**, so every SharePoint and Outlook path is untestable
locally.

**Recommendation.** Retire the mock. `wrangler dev` runs the real `worker.js` and works on any
x64 machine, in WSL2, or in a Linux container on the existing hardware. This is the single
highest-leverage change available: it eliminates a whole bug class, halves the cost of every
backend change, and makes integration paths testable. Until then, treat the divergence checklist
in [11-local-development.md](11-local-development.md) as mandatory.

## D-2 — Bus factor of 1 (High)

254 commits over 6 weeks, effectively one developer working with AI assistance. No other person
has debugged this system. These documents reduce the risk but do not remove it — reading docs is
not the same as having fixed a bug at 11pm.

**Recommendation.** Have a second engineer work through
[21-new-developer-start-here.md](21-new-developer-start-here.md) and ship two or three real
changes while the original developer is still available to answer questions.

## D-3 — Tests are source-text assertions (High)

**Evidence.** `scripts/test-portal-regressions.js` asserts on literal source strings:

```js
check(worker.includes("? loadAssignments(await env.PORTAL_KV.get(`assignments:${m}`))\n      : [];"),
  'an unregistered member has an explicit empty assignment list');
```

**Two separate problems.**

1. **They break on reformatting.** Any whitespace change to correct code fails the test. They
   test *text*, not behaviour, so they cannot catch a runtime regression that preserves the
   string, and they fail on a change that preserves the behaviour.
2. **2 of 3 currently fail on any Windows checkout.** `core.autocrlf=true` with no
   `.gitattributes` means Git stores LF and checks out CRLF; the assertions contain `\n`.
   **Verified:** both failing assertions pass against LF-normalised sources, and the guarded
   behaviour is intact. They pass on Linux/CI and fail on Windows regardless of code correctness.

**Impact.** A developer runs the suite, sees red, learns the suite is unreliable, and stops
running it. That is worse than having no tests.

**Recommendation.** (a) Add `.gitattributes` with `* text=auto eol=lf`. (b) Convert the
source-text assertions into behavioural tests where practical — `test-prospects.js` and
`test-household-sync.js` already show the pattern (import/stub the logic and assert on results).
(c) Run them in CI so they cannot silently rot.

## D-4 — `worker.js` is one 8,414-line module (Medium)

Every endpoint, all auth, encryption, Graph integration, and the cron in one file. Mitigated by
33 `// ----------` section headers and unusually good comments, but: no module boundaries, no way
to unit-test a piece in isolation, merge conflicts on any parallel work, and a mental model that
must be reconstructed from scratch.

**Recommendation.** Do not embark on a big-bang split. Extract seams that already exist —
`crypto`, `sharepoint`, `outlook`, `compliance` are each cleanly delimited by section headers.
Cloudflare's bundler handles multiple modules fine. Extract only when you are already editing an
area.

## D-5 — Route ordering is load-bearing (Medium)

**Evidence.** `contactMatch = /^\/api\/admin\/contacts\/(.+)$/` (`worker.js:8309`) uses greedy
`(.+)`. Every `/contacts/:email/<suffix>` route must be declared **above** it. The code documents
this at `worker.js:8054` and `8238`.

**Impact.** Adding a route in the "wrong" place produces no error — the request is silently
handled as a contact upsert with a nonsense email. This is the easiest way to break the file, and
nothing detects it.

**Recommendation.** Add a comment block above the generic route marking it as a boundary
("ADD NOTHING BELOW"), and add a test asserting a known sub-resource route returns its expected
status rather than a contact upsert.

## D-6 — No type checking or linting (Medium)

No TypeScript, ESLint, Prettier, or JSDoc types. 38,500 lines of untyped JS where a typo in a
property name is a silent `undefined`.

**Recommendation.** Cheapest meaningful step: add `// @ts-check` plus a `jsconfig.json` and fix
what surfaces. This gets most of the value without a rewrite or a build step. A Prettier config
would also stop whitespace churn — which would in turn stop breaking D-3's assertions.

## D-7 — Triplicated field declarations (Medium)

**Evidence, quoted from `scripts/test-prospects.js`:** *"the prospect Additional Info fields are
declared in three places (`contacts.html` for the form, `worker.js` for validation,
`dev-server.ps1` for the local mock). A key registered in the UI but not on the server is…"*

**Impact.** Adding a field means three edits in three languages. Miss the server one and the
field silently fails to save — no error, the value just vanishes. A test exists precisely because
this happened.

**Recommendation.** Generate the UI field list from a single declaration, or at minimum keep the
existing test and extend it to every triplicated set (task categories, compliance enums, client
info keys).

## D-8 — Two timeline label maps (Medium)

`shared.js` `TL_LABELS` (firm-wide activity feed) and `contacts.html` `TIMELINE_LABELS`
(contact Timeline tab) are independent maps of the same event types. Adding an event type and
updating only one leaves the **raw slug** (`password-reset`) rendering in the other. This was
observed and fixed during the 2026-08-20 work.

**Recommendation.** Move `TIMELINE_LABELS` into `shared.js` and have both surfaces read one map,
with per-surface capitalisation applied at render time.

## D-9 — Open bug: mock serialises 1-element arrays as objects (Medium)

**Evidence, reproduced 2026-08-20.** With exactly **one** board list configured,
`GET /api/admin/lists` returns `{"lists": {...}}` — a bare object — instead of
`{"lists":[{...}]}`. PowerShell's `ConvertTo-Json` unrolls a one-element array. `operations.html`
then calls `boardLists.map(...)` and throws `TypeError: boardLists.map is not a function`; the
Board view renders nothing.

Adding a second list masks it. **Local-only** — `worker.js` is JS and has no such unrolling.

**Impact.** The Board view is unusable locally in a common configuration, and the failure looks
like a frontend bug.

**Recommendation.** Fix centrally in the mock's `Send-Json` by forcing array-ness for known
collection keys, and audit every collection-returning endpoint (`contacts`, `tasks`, `admins`,
`workspaces`, `documents`, `checklist`, `history`, `calendarOwners`) for the same pattern.

## D-10 — Every-minute cron amplifies a consistency bug (Medium)

`crons = ["*/1 * * * *"]` runs a full SharePoint contacts + households sync every 60 seconds
(~43,200/month). Beyond cost and Graph-throttling exposure, the tight loop **increases the
probability** of the eventual-consistency clobbering bug documented in
`scripts/test-household-sync.js`: the shorter the window, the likelier the pull reads a pre-save
KV copy and rebuilds from a stale base.

**Recommendation.** Relax to `*/5` or `*/15` after confirming no workflow depends on near-instant
propagation.

## D-11 — Hard-coded staff identity (Medium)

`isSuperAdmin` is a literal comparison to `FRANK_ADMIN_EMAIL` (`worker.js:96`). Jenn, Intern and
Eric are hardcoded permanent shared-view managers and cannot be demoted through the UI. Three
staff passwords live in Cloudflare secrets keyed by name.

**Impact.** Ownership cannot be transferred, and no staff change involving these four can be made
without a code change and deploy. If Frank leaves the firm, the super-admin role requires a
developer.

**Recommendation.** Move the super-admin designation into KV (`super_admin` key or a role field
on `admin_account:`) with a bootstrap fallback to the current constant. Migrate the three legacy
accounts to KV-backed records so all staff are managed uniformly — this also removes the
plaintext-secret comparison path.

## D-12 — Manual cache-busting (Low)

`shared.js?v=20260817-6` / `shared.css?v=20260817-6` is hand-maintained across 8 admin pages
(currently consistent). Forgetting to bump serves stale JS — made materially worse because the
intended `Cache-Control: no-cache` does not apply in production (security H-1).

**Recommendation.** Fix H-1 first, then either automate the token or accept revalidation.

## D-13 — Stale documentation in `worker.js` (Low)

- `worker.js:59-62` claims *"there is still no application-level encryption of client PII"* —
  **false**, and contradicted by the KV layout comment 40 lines above and the implementation at
  line 1077.
- `worker.js:29-43` lists ~13 endpoints; there are 87.

These are the first things a new developer or auditor reads. Both lead to wrong conclusions about
the system's security posture. **Fix or delete them.**

## D-14 — `contacts.html` is 5,988 lines (Low)

The largest file, mixing markup, CSS, and a very large inline script covering contacts,
prospects, ~10 detail tabs, households, import, documents, and client info. Hard to navigate and
impossible to unit-test.

**Recommendation.** Extract the inline script to `admin/contacts.js` as a first step — mechanical,
low-risk, and it makes the file greppable and syntax-checkable. This also moves toward dropping
`'unsafe-inline'` from CSP (security L-1).

## D-15 — No cleanup path for several namespaces (Low)

`user:`, `assignments:`, `responses:`, `hhresponses:`, `clientinfo:`, and `timeline:` have no
delete handler. Removing a contact leaves their portal account, module assignments, answers, KYC
record, and permanent timeline behind. Harmless at current scale; a data-retention and
right-to-erasure problem later, and it means "delete this client" is not actually possible today.

## D-16 — Line-ending inconsistency (Low)

`core.autocrlf=true`, no `.gitattributes`. Git stores LF; Windows checks out CRLF. Consequences:
D-3's test failures, and confusing behaviour for tools that write LF (a file can end up
mixed-ending on disk while committing clean). Note that `grep -c $'\r'` **silently reports 0** on
a CRLF file in this Git Bash — use Node to check endings reliably.

**Recommendation.** Add `.gitattributes` with `* text=auto eol=lf`.

## D-17 — Misleadingly named module (Low)

`agreement-pdf-worker.js` is **not** a Cloudflare Worker and is not deployed separately. It is a
module imported by `worker.js:9`. Rename to `agreement-pdf.js`.

## D-18 — Vendored dependency, no version tracking (Info)

`vendor/pdf-lib.esm.min.js` is committed with no recorded version, changelog, or update path.
Vendoring is the right call here (it is what makes the no-build-step architecture work), but
nothing will tell you if a security advisory affects the bundled copy.

**Recommendation.** Add a one-line `vendor/README.md` recording the package, version, source URL,
and date vendored.

---

## Fragile areas — handle with care

Ranked by "chance a well-intentioned change breaks something subtle".

| Area | Why fragile | Before changing |
|---|---|---|
| SharePoint sync merge logic | Timestamp comparison + eventual consistency + field ownership. Already produced a data-loss bug. | Read `scripts/test-household-sync.js` in full. Run it. |
| Route table ordering | Silent misrouting, no error | See D-5 |
| `encryptJSON` / `decryptToObject` | Wrong changes corrupt or expose data irreversibly | Never change the envelope format without a migration. Understand why it throws. |
| Task status transitions | Interlocking rules for `readyAt`/`completedAt`/history/recurrence/Outlook | Read `worker.js:7200-7460` end to end |
| Workspace filtering | Omitting a check silently leaks across workspaces | Copy an existing handler's first four lines verbatim |
| Compliance blob writes | Read-modify-write race | See security M-4 |
| Household member handling | Registered vs unregistered members change assignment semantics | Read `worker.js:2171-2181` |

## Things that look like bugs but are deliberate

**Do not "fix" these.** Each has a written rationale in-code or in `STATUS.md`.

| Observation | Why it is correct |
|---|---|
| Clients never see their scored results | Product decision |
| Outlook events have no attendees | Graph would email real invitations on every save |
| Frequency never generates the next compliance occurrence | Future dates arrive by spreadsheet import; sign-off evidence needs materialised rows |
| Compliance "Open" count stays flat | Seeded rows lack `seriesId`; drip-feed on sign-off is by design |
| Learning tags use a plain-text column, not Choice | Graph cannot reliably write SharePoint Choice columns |
| The kanban board is empty until you add lists | Fully manual by design |
| `compatibility_date` is old | Deployed Worker already runs those semantics |
| The PDF import is a relative path | Nothing here can resolve a bare npm specifier |
| Only six compliance areas | Deliberate cognitive-load choice |
| `tasks.html` is a 20-line stub | Keeps old links working |
| Completed tasks disappear after 7 days | View filter, not retention |
| `decryptToObject` throws instead of returning null | Fail closed — prevents overwriting unreadable data with empty |
