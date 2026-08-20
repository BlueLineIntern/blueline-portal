# 4. Frontend

Two separate applications sharing a design-token file and one renderer module.

---

## Client portal

### Structure

**All client views live in a single HTML document** (`public/index.html`, 538 lines). Navigation
is CSS class toggling, not routing — `showView(name)` (`public/assets/script.js:114`) removes
`hidden` from the target `<section>` and adds it to the others.

| View id | Purpose |
|---|---|
| `view-auth` | Login / Create Account / **Set a new password** (3 forms, tab-switched) |
| `view-home` | Five-category landing hub. Answers "what needs my attention". |
| `view-dashboard` | Financial Picture Analysis progress (x-of-5) |
| `view-category` | Shared shell for the four category groups (x-of-3 progress, module cards) |
| `view-risk`, `view-budget`, `view-retirement`, `view-networth`, `view-compensation` | The five FPA module forms — **static HTML** |
| `view-assignments` | The assigned-modules list |
| `view-documents` | Document requests + upload + own uploads |
| `view-links` | Firm-configured external platform links |

**There is no URL routing.** Reloading always lands on `view-home` (or `view-auth`). Deep links
into a specific module are not possible on the client side. This is a deliberate simplicity
trade-off, not a bug — but it means the browser Back button does not navigate views.

### The form engine

The 12 **category** modules are not hand-written HTML. They are generated at boot from a
declarative spec, `MODULE_FORMS` (`script.js:1621`), by a small form engine. Each entry declares
fields, labels, input types, and optional `extra` sub-fields:

```js
{ key: "termLife", label: "Life Insurance",
  extra: { field: "amount", placeholder: "Total death benefit ($)" } }
```

Generated ids follow a fixed convention: section `view-<key>`, form `<key>-form`, error
`<key>-error`.

The **five FPA modules keep static HTML** because their layouts are bespoke. So there are two
parallel systems for rendering a questionnaire.

> **When adding a module:** prefer `MODULE_FORMS` (declarative — one object, no HTML). You must
> also add a matching validator to `MODULE_VALIDATORS` in `worker.js:1270`, or saves 400. See
> [19-common-tasks.md](19-common-tasks.md).

### Auth forms and one-time links

`script.js:1-25` captures advisor-issued tokens from the URL at load:

| Param | Stored in | Lifetime | Why |
|---|---|---|---|
| `?invite=<token>&email=` | `sessionStorage` | Survives reload | Registration may take several steps |
| `?reset=<token>&email=` | **Module scope only** | Lost on reload | Single-use and short-lived; persisting it adds risk for no benefit |

Both are **stripped from the URL** via `history.replaceState` immediately, so the token is not
left in the address bar, browser history, or a screenshot. Both clear any existing session first,
so an advisor-issued link always wins over whoever was signed in on that browser.

The reset flow hides the tab strip and both other forms — the client cannot log in (that is why
they are there) and should not be creating a second account.

### Client-side validation

Minimal and deliberately so — the server re-validates everything.

| Check | Where |
|---|---|
| `required`, `minlength="8"`, `type="email"` | HTML attributes |
| Password confirmation match | `script.js` reset handler — exists to catch a typo in a field nobody can see |
| Everything else | Server (`MODULE_VALIDATORS`, sanitizers) |

Errors render into a per-form `<p class="form-error" id="<x>-error">` element.

### Data fetching

One helper, `apiRequest(path, {method, body, auth})` (`script.js:40-60`): sets JSON headers,
attaches `Authorization: Bearer` when `auth: true`, throws `new Error(data.error)` on non-OK so
callers can `try/catch` and write the message into the form's error element.

**No loading skeletons or spinners** in most places; content appears when the fetch resolves.
Some panels use a `'Loading…'` placeholder string.

### Deliberate product constraint

**Clients never see their own scored results.** Completed module cards show a thank-you plus
Review/Edit. Scoring, charts, and risk categories render only on the advisor side, using the same
`render.js`. This is a product decision, not an oversight — do not "fix" it by exposing results.

---

## Admin CRM

### Structure

**Multi-page application.** Each page is a standalone HTML document with a large inline
`<script>`. No client-side router; navigation is real page loads.

| Page | Lines | Contents |
|---|---|---|
| `contacts.html` | 5,988 | Contacts + Prospects segmented list, contact detail (~10 tabs), households, CSV/SharePoint import, documents, client info, timeline |
| `compliance.html` | 1,849 | 128-item tracker, filters, sign-off, recurrence |
| `operations.html` | 1,557 | Tasks: kanban board + list view, task drawer, checklists |
| `calendar.html` | 918 | Month/week calendar over tasks and meetings |
| `index.html` | 891 | Dashboard: stat tiles, queues, activity feed, notifications |
| `learning.html` | 715 | SOP library over a SharePoint document library |
| `settings.html` | 519 | Admin accounts, workspace access, portal links, audit log |
| `onboarding.html` | 312 | Onboarding submission viewer |
| `tasks.html` | 20 | Redirect stub -> `operations.html?view=list` |

### `shared.js` — the only shared runtime

Loaded by every admin page as `<script src="/admin/shared.js?v=20260817-6">`. Provides:

| Area | Functions / constants |
|---|---|
| Session | `ADMIN_SESSION_KEY`, `SESSION`, `logoutLocal()` |
| **Networking** | `api(path, opts)` — the single entry point for all admin requests |
| Workspace | `ADMIN_WORKSPACE_KEY`, `ALL_ADMIN_WORKSPACES`, `CONTACT_WORKSPACES` / `TASK_WORKSPACES` / `HOUSEHOLD_WORKSPACES` maps |
| Shell | `NAV_ITEMS` (line 572), `initShell(page, opts)`, `icon()` |
| Formatting | `escapeHtml`, `fmtDate`, `fmtDateTime`, `relTime` |
| Tasks | `TASK_CATEGORY_LABELS`, `categoryBadge`, `priorityOptions`, `prioRailClass`, `dueMeta`, `duePill`, `parseDue` |
| Contact picker | `initContactPicker(selectId)` — searchable dropdown (line 284) |
| Timeline | `TL_LABELS`, icon map |
| Recents | `RECENT_KEY`, `RECENT_MAX` (6) |
| Onboarding display | `ONB_SECTIONS`, `onbSectionsHtml` |

`api()` (`shared.js:47`) is the important one. It:

1. attaches `Authorization: Bearer <admin token>`,
2. attaches `X-Admin-Workspace` from `localStorage`,
3. parses JSON and throws `Error(data.error)` on failure,
4. **on 401, clears the local session and redirects to login** (`shared.js:46`).

> Because of (4), calling `fetch()` directly instead of `api()` in an admin page bypasses both the
> workspace header and the 401 handling. A raw `fetch` that 401s can bounce the tab to `/` with no
> explanation. **Always use `api()`.**

### Navigation and the workspace switcher

`NAV_ITEMS` (`shared.js:572`) drives the sidebar. Note the label/route mismatch:

```js
{ id: 'operations', href: '/admin/operations.html', icon: 'check-square', label: 'Tasks' }
```

The nav entry labelled **"Tasks"** points at **operations.html**. `tasks.html` is only a stub.

`EMPLOYEE_FILTER_PAGES = new Set(['contacts','operations','calendar'])` (`shared.js:25`) — only
these three show the employee/workspace filter. `contacts.html` serves both the Clients and
Prospects nav entries via a `?seg=prospects` query param, keeping `activePage` as `contacts` so
the workspace filter and saved-filter key are shared.

### State and rendering

- Page state is module-scoped `let` variables (`allTasks`, `allContacts`, `boardLists`,
  `listFilters`, …).
- Rendering is manual: build an HTML string, assign `innerHTML`, re-attach event listeners.
- Event delegation on a container is the common pattern for lists (one listener, `closest()`
  dispatch), e.g. `settings.html` `#admins-body`.
- Polling every 30s (`POLL_INTERVAL_MS`). Guards exist against disruptive refresh — e.g.
  `operations.html` `loadData()` returns early if a drawer is open or a drag is in flight.
- `POLL_SKIP_TABS` (`contacts.html:843`) suppresses polling on tabs where a refresh would
  interrupt editing.
- The audit log deliberately does **not** poll, to avoid burning KV reads per open tab.

### Filters and deep links

`operations.html` and `contacts.html` keep filter state in JS objects (`LIST_FILTER_DEFAULTS`),
not in the DOM — because Reset and removable filter chips both need to *write* it, which reading
from the DOM cannot express. `syncFilterControls()` pushes state back to the controls.

Deep links supported (`operations.html`):
- Board: `?filter=today|week|overdue|mine`
- List: `?view=list&f=<quickfilter>&cat=<category>&q=<search>`

### Permissions in the UI

The frontend hides controls it believes you cannot use — e.g. `renderAdmins(admins, you, boss,
canDeleteAdmins)` only emits a "Remove admin" button when `canDeleteAdmins` is true, and the
"Add Admin" block is hidden unless `data.boss`.

> **This is cosmetic only.** Every one of those actions is independently enforced server-side.
> Never rely on a hidden button as a security control — and when adding a privileged feature,
> add the server check first.

### Styling

- `assets/tokens.css` (199 lines) — design tokens: `--sp-*` spacing, `--fs-*` type scale,
  colours, `--muted`.
- `admin/shared.css` (1,012) — admin components: `.panel`, `.data-table`, `.badge`, `.btn`,
  `.modal-backdrop`, `.kv-rows`, `.row-item`, priority rails.
- `assets/style.css` (1,462) — client portal.
- Plain hand-written CSS. No preprocessor, no utility framework, no CSS-in-JS.
- Modals follow one pattern: `.modal-backdrop.hidden` toggled by class, backdrop click closes via
  `if (e.target === e.currentTarget)`.

### Accessibility

Better than typical for a project this age, and deliberately so — `compliance.html:78-91` and
`:381` carry comments insisting every control has a **visible label, not just a placeholder**,
with visually-hidden labels where the design has no room. `aria-pressed`, `aria-label`, and
`title` attributes are used on icon buttons.

---

## Shared between both apps

`public/assets/render.js` (904 lines) holds chart builders, module metadata, and result
renderers, and is loaded by **both** the client portal and the admin contact detail view. Its
header says load order matters: `render.js` before `script.js`.

This is the one genuine code-sharing seam in the frontend and exists so scoring/presentation
logic is not duplicated between the two apps.

---

## Frontend gotchas

| Gotcha | Detail |
|---|---|
| Cache-busting is manual | `?v=20260817-6` on `shared.js`/`shared.css` in all 8 admin pages. Change the file, bump all 8. |
| `Cache-Control` does not apply live | See security H-1 — makes the above more dangerous than it looks |
| Two form systems | Category modules are declarative (`MODULE_FORMS`); FPA modules are static HTML |
| Two timeline label maps | `shared.js` `TL_LABELS` **and** `contacts.html` `TIMELINE_LABELS`. Adding a timeline event type requires updating **both**, or the raw slug shows on the contact Timeline tab. |
| Everything is global scope | No modules. Two pages declaring the same helper name will collide if ever loaded together. |
| `innerHTML` rebuilds lose focus/scroll | Full re-render is the norm; watch for it when adding live-updating panels |
