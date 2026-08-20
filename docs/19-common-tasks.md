# 19. Common Developer Tasks

Recipes for the changes you are most likely to make. Each lists every file that must change —
**the recurring theme is that most changes touch three places** (UI, `worker.js`,
`dev-server.ps1`).

---

## Add an API endpoint

**Files:** `worker.js` (handler + route), `dev-server.ps1` (mock).

1. Write the handler near related code, under the appropriate `// ----------` section:

```js
async function handleAdminDoThing(request, env, cors, targetId) {
  // These four lines are the contract. Copy them verbatim.
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);

  // Add for privileged actions only:
  // if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: '...' }, 403, cors);
  // if (!isSuperAdmin(adminEmail)) return json({ error: '...' }, 403, cors);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeThing(body);
  if (error) return json({ error }, 400, cors);

  const record = { ...fields, workspace, updatedAt: new Date().toISOString(), updatedBy: adminEmail };
  await env.PORTAL_KV.put(`thing:${id}`, await encryptJSON(env, record));
  await logAudit(env, adminEmail, 'update-thing', { id });   // names, never sensitive values
  return json({ thing: record }, 200, cors);
}
```

2. Register the route in the dispatch chain (`worker.js:7962-8399`):

> **CRITICAL:** if the path is `/api/admin/contacts/:email/<anything>`, declare it **above**
> `contactMatch` at `worker.js:8309`. That route's greedy `(.+)` silently swallows anything
> declared after it and treats the request as a contact upsert. No error is raised.

3. Mirror it in `dev-server.ps1` in the request `if/elseif` chain. Use `Read-Body` (**not**
   `Read-JsonBody`, which does not exist), and remember `continue` targets the request loop.

4. Verify deployed: a registered route returns **401/403**, not 404.

**Checklist:** auth check? workspace check? privilege check? sanitizer? encrypted write? audit
log? mock updated? route above the greedy contact route?

---

## Add a field to an existing record

**Files:** `contacts.html` (or the relevant page), `worker.js`, `dev-server.ps1`.

Three places, always. A field registered in the UI but missing from the server sanitizer is
**silently dropped with no error** — this has happened before and `scripts/test-prospects.js`
exists because of it.

1. **UI:** add the input and include it in the payload.
2. **`worker.js`:** add it to the sanitizer. For `clientinfo`, that means one of
   `CLIENT_INFO_TEXT` (with a length cap), `CLIENT_INFO_MONEY`, `CLIENT_INFO_DATES`, or
   `CLIENT_INFO_ENUMS`.
3. **`dev-server.ps1`:** add the same validation to the mock.

No migration needed — KV is schemaless. Existing records simply lack the key; default it on read.
**Do not run a bulk backfill** (no transaction, no backup).

---

## Add a database "table"

There are no tables. Choose a key namespace and follow the conventions:

| Decision | Convention |
|---|---|
| Key shape | `thing:<id>` — one record per key, unless the set is small and always read together (see `compliance_items`, and note its lost-update race first) |
| Id shape | `${invTs()}-${randomHex(4)}` if you need newest-first ordering; `hh-<hex>` style prefixes elsewhere |
| Encryption | `await encryptJSON(env, record)` if it contains client data |
| Tenancy | **Include `workspace`** and filter on read |
| Listing | `listKeys(env, 'thing:')` then `decryptToObject` each; consider `readAllEncrypted` to get the per-record error count |
| Deletion | Write it. Also delete `timelineKeys[]` via `deleteTimelineRefs`. |
| Documentation | Add it to the KV layout comment at `worker.js:19-28` and to [07-data-model.md](07-data-model.md) |

---

## Add an assessment module

**Files:** `public/assets/script.js`, `worker.js`, possibly `public/index.html`,
`public/assets/render.js`.

1. **Frontend:** add an entry to `MODULE_FORMS` (`script.js:1621`) — declarative, no HTML needed.
   Generated ids are `view-<key>`, `<key>-form`, `<key>-error`.
   *(The five FPA modules use static HTML instead; follow `MODULE_FORMS` for anything new.)*
2. **Backend:** add a validator to `MODULE_VALIDATORS` (`worker.js:1270`) returning
   `{data}` or `{error}`. **Without this, saves 400** — the module key must exist in that object.
3. `ASSIGNABLE_KEYS` derives from `Object.keys(MODULE_VALIDATORS)` automatically, so the module
   becomes assignable with no extra work.
4. Decide **shared vs personal** (household-level or per-person) and update `splitModules()`.
5. If it needs a results chart, add a renderer in `render.js` (shared with the admin view).
6. Mirror validation in `dev-server.ps1`.

---

## Add a page to the admin app

**Files:** new `public/admin/<page>.html`, `public/admin/shared.js`.

1. Copy an existing small page (`onboarding.html`, 312 lines, is the cleanest template).
2. Keep the standard head: `shared.css?v=<token>`, then `shared.js?v=<token>`, then
   `initShell('<pageId>')`.
3. Add an entry to `NAV_ITEMS` (`shared.js:572`):
   ```js
   { id: 'thing', href: '/admin/thing.html', icon: 'check-square', label: 'Thing' }
   ```
4. If the page should show the employee/workspace filter, add its id to `EMPLOYEE_FILTER_PAGES`
   (`shared.js:25`).
5. Use `api()` for **every** request — never bare `fetch()`, or you lose the workspace header and
   the 401 handling.
6. Use `escapeHtml()` on every interpolated value.

No routing config is needed — the file's path *is* its URL.

---

## Add a role or permission

**Files:** `worker.js`, the relevant page, `dev-server.ps1`.

Roles are functions, not data. The three checks are `isSuperAdmin()`,
`canManageSharedFirmView()`, and `isAdminAccount()`.

- **New privilege on an existing role:** add the check to the handler and hide the control in the
  UI. Server first.
- **A genuinely new role:** add the predicate near `worker.js:340`, return it in
  `handleAdminListAdmins`/`handleAdminWorkspaces` so the UI can branch, then enforce it per
  handler.

> There is no middleware. Every check is per handler. Omitting one leaks silently — nothing
> detects it.

Note `isSuperAdmin` is a hardcoded comparison to `FRANK_ADMIN_EMAIL`. Making ownership
transferable is a real change; see [17-technical-debt.md](17-technical-debt.md) D-11.

---

## Add a staff account

**Two different procedures.**

**Preferred — no code change:** Settings -> Admin Accounts -> fill name, email, password (>= 10)
-> Add Admin. Creates a KV-backed admin. They enrol MFA on first login. Hand the password over
directly — **no email is sent.**

**Legacy secret-backed (only if you specifically need it):**
1. Add to `ADMIN_ACCOUNTS` (`worker.js:85-89`) with a new secret name.
2. `wrangler secret put ADMIN_PASSWORD_<NAME>` (or dashboard).
3. Deploy.
4. Add to `$adminPasswords` in `dev-server.ps1` for local dev.
5. Consider `LEGACY_ADMIN_NAMES` for the display name.

There is little reason to choose the legacy path for a new account.

---

## Add an environment variable

1. Use it in `worker.js` as `env.MY_VAR`.
2. **Gate on it** — follow the existing pattern so a missing value degrades rather than throws:
   ```js
   function myFeatureConfigured(env) { return !!(env.MY_VAR); }
   ```
3. Set it: `wrangler secret put MY_VAR`, or dashboard. Immediate, no redeploy.
4. **Document it in [10-configuration.md](10-configuration.md)** with purpose, required/optional,
   secret/non-secret, and the symptom when missing.
5. Add a dev default in `dev-server.ps1` if the feature needs to work locally.

> Consider also logging or surfacing "configured / not configured" in a diagnostic endpoint.
> Silent degradation is the most common diagnosability complaint in this system.

---

## Add a form

1. Markup with a `<p class="form-error" id="<x>-error">` element.
2. **Visible `<label>` for every control** — the codebase is explicit that a placeholder is not a
   label (`compliance.html:90-91`). Use a visually-hidden label if the design has no room.
3. Submit handler: `preventDefault()`, clear the error element, `try { await api(...) } catch (err)
   { errorEl.textContent = err.message }`.
4. Server-side sanitizer with length caps and enum whitelists. Client-side validation is a
   convenience only.
5. Mirror in `dev-server.ps1`.

---

## Add a timeline event type

**Files:** `worker.js`, `public/admin/shared.js`, `public/admin/contacts.html`.

1. Call `logTimeline(env, clientEmail, 'my-event', adminEmail, detail)`. Store the returned
   `timelineKeys` on the owning record so `deleteTimelineRefs` can clean up.
2. Add an icon entry to the map in `shared.js` (~line 737).
3. Add a label to `TL_LABELS` in `shared.js` (~line 981) — lowercase phrasing
   (*"set a new portal password"*).
4. **Add a label to `TIMELINE_LABELS` in `contacts.html` (~line 4646)** — sentence case
   (*"Set a new portal password"*).

> **Step 4 is the one people miss.** There are two independent label maps. Update only
> `shared.js` and the contact Timeline tab renders the raw slug (`my-event`). This exact mistake
> occurred on 2026-08-20.

---

## Add an audit action

1. `await logAudit(env, adminEmail, 'my-action', { target: x })`.
2. Add a label to `AUDIT_ACTION_LABELS` in `settings.html` (~line 445) — otherwise the raw action
   slug renders.
3. If the detail shape is new, extend `auditDetail()` in `settings.html` (~line 432), or the
   viewer shows a raw JSON blob.

**Never put sensitive values in `detail`** — field names only. The log has a 13-month TTL and its
own viewer; `update-client-info` deliberately logs only key names.

---

## Change the completed-task retention window

`operations.html`: change `COMPLETED_VISIBLE_DAYS`. The empty-state message interpolates it, so it
stays consistent automatically. Nothing server-side changes — it is a view filter.

---

## Deploy

```bash
git add -A
git commit -m "..."
git push origin main
```

Live in 1-2 minutes. Verify:

```bash
curl -sL https://blueline-portal.fsabin.workers.dev/admin/settings.html | grep -c YOUR_MARKER
```

Then run the checklist in [12-deployment.md](12-deployment.md) — especially bumping the `?v=`
cache-buster if you touched `shared.js`/`shared.css`.

---

## Roll back

`git revert <sha> && git push origin main`, or Cloudflare -> Deployments -> Rollback for speed.

**Code rollback does not undo data changes, and there is no backup.**

---

## The universal pre-commit checklist

- [ ] Backend change mirrored in `dev-server.ps1`?
- [ ] New field declared in all three places (UI / worker / mock)?
- [ ] Auth **and** workspace check on every new handler?
- [ ] Route declared above `contactMatch` if it is a contact sub-resource?
- [ ] `escapeHtml()` on every interpolated value?
- [ ] Sensitive values kept out of the audit log?
- [ ] `encryptJSON` used for client data?
- [ ] Both timeline label maps updated, if applicable?
- [ ] `?v=` cache-buster bumped in all 8 pages, if `shared.*` changed?
- [ ] Tests run (`node scripts/test-*.js` — expect 2 CRLF failures on Windows)?
- [ ] Comment explaining *why*, if the change looks arbitrary? (House style — the comments are
      this codebase's main defence against a future developer "fixing" something deliberate.)
