// Client portal app logic. Chart builders, module metadata, and result
// renderers live in render.js (shared with the admin detail view) — load
// render.js before this file.

// Frontend and API are served from the same Worker, so requests are same-origin.
const API_BASE_URL = "";

const SESSION_KEY = "blueline_session";

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function apiRequest(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const session = getSession();
    if (session && session.token) {
      headers["Authorization"] = `Bearer ${session.token}`;
    }
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------- View management ----------

// FPA module sections are static in index.html; the 12 category module
// sections are generated at boot (see "Generated category module forms").
const VIEW_IDS = ["auth", "home", "assignments", "documents", "links", "dashboard", "category"]
  .concat(MODULES.map((mod) => mod.key))
  .concat(CATEGORY_MODULES.map((mod) => mod.key));

// The tab strip. `view` is the section the tab lands on; `loader` runs on click.
// Adding the Documents tab later is one entry here plus its section — nothing
// else in the nav needs to change.
const CLIENT_TABS = [
  { id: "home", label: "Home", view: "home" },
  // id/view stay "assignments" (internal — matches the tab section, the
  // isAssigned()/assignedKeys plumbing, and /api/assignments); only the
  // displayed label changed, at the user's request, to match how every other
  // client-facing string already says "assessments".
  { id: "assignments", label: "Assessments", view: "assignments" },
  { id: "documents", label: "Documents", view: "documents" },
  { id: "links", label: "Links", view: "links" },
];

// Which tab is lit. Tracked separately from the visible view because the
// drill-downs (the FPA dashboard, a category, an individual module form) are all
// *inside* Assignments — showView swaps the section, but the strip must keep
// showing Assignments rather than going blank on a sub-page.
let activeTab = "home";

// Every view that lives under a tab, so a drill-down keeps the right tab lit.
const VIEW_TAB = { home: "home", links: "links", documents: "documents" };
["assignments", "dashboard", "category"]
  .concat(MODULES.map((m) => m.key))
  .concat(CATEGORY_MODULES.map((m) => m.key))
  .forEach((v) => { VIEW_TAB[v] = "assignments"; });

function showView(name) {
  VIEW_IDS.forEach((id) => document.getElementById(`view-${id}`).classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
  if (VIEW_TAB[name]) activeTab = VIEW_TAB[name];
  renderTabs();
  window.scrollTo(0, 0);
}

function renderTabs() {
  const wrap = document.getElementById("client-tabs");
  if (!getSession()) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  wrap.innerHTML = CLIENT_TABS.map((t) =>
    `<button type="button" class="client-tab${activeTab === t.id ? " active" : ""}" data-tab-id="${t.id}"
      aria-current="${activeTab === t.id ? "page" : "false"}">${escapeHtml(t.label)}</button>`
  ).join("");
  wrap.querySelectorAll(".client-tab").forEach((b) =>
    b.addEventListener("click", () => openTab(b.dataset.tabId))
  );
}

// Tab clicks always re-fetch rather than showing whatever was last rendered:
// assignments and links are both admin-controlled and can change between
// visits, and refreshState doubles as the session check.
function openTab(id) {
  if (id === "home") return loadHome();
  if (id === "assignments") return loadAssignments();
  if (id === "documents") return loadDocuments();
  if (id === "links") return loadLinks();
}

function updateNav() {
  const session = getSession();
  const navAuth = document.getElementById("nav-auth");
  const navUsername = document.getElementById("nav-username");
  if (session) {
    navAuth.classList.remove("hidden");
    navUsername.textContent = session.name;
  } else {
    navAuth.classList.add("hidden");
    navUsername.textContent = "";
  }
  renderTabs();
}

// ---------- Module assignments ----------
// assignedKeys is the list of module keys the admin has made visible to this
// client, or null when there is no assignment record (= everything visible).

let assignedKeys = null;

// Household sharing. Everyone in a family sees one portal: the same documents
// and requests, and each other's assessments. `viewingMember` is whose
// assessments are on screen — documents and requests are always the whole
// household's, since those are shared outright.
//
// Assessments are per-member rather than merged: two people can't both answer
// "my risk tolerance" in one record without the second save wiping the first.
let household = { shared: false, householdName: "", you: "", members: [] };
let modulesByMember = {};
let assignmentsByMember = {};
let viewingMember = "";

function isAssigned(key) {
  // Anything that isn't an array is treated as "no assignment record", i.e.
  // everything visible — the same meaning as null. Previously this called
  // .includes() on whatever arrived, so a response of the wrong shape threw
  // mid-render and left the client staring at a half-drawn page (with the
  // PREVIOUS client's rows still on it, after a logout/login). Failing open to
  // "show everything" matches the documented default and degrades to a visible,
  // usable portal rather than a broken one.
  if (!Array.isArray(assignedKeys)) return true;
  return assignedKeys.includes(key);
}

// Fetch assessment progress and assignments together. Both require a valid
// session, so this doubles as the session check on every entry point.
async function refreshState() {
  // Links ride along so Home can decide whether to offer the Links shortcut
  // without a second round trip. A links failure must not take down the
  // assessment state the rest of the portal depends on, so it degrades to an
  // empty list rather than rejecting the whole Promise.all.
  const [assessments, assignments, links, reqs, hh] = await Promise.all([
    apiRequest("/api/assessments", { auth: true }),
    apiRequest("/api/assignments", { auth: true }),
    apiRequest("/api/portal-links", { auth: true }).catch(() => ({ links: [] })),
    apiRequest("/api/document-requests", { auth: true }).catch(() => ({ requests: [] })),
    apiRequest("/api/household", { auth: true }).catch(() => null),
  ]);
  portalLinks = links.links || [];
  docRequests = reqs.requests || [];

  // Household. A failure here degrades to "just me", which is the pre-sharing
  // behaviour — it must never widen access, and it must never break the portal.
  const you = assessments.you || (getSession() || {}).email || "";
  household = hh && Array.isArray(hh.members) && hh.members.length
    ? hh
    : { shared: false, householdName: "", you, members: [{ email: you, name: "You", role: "" }] };

  // Per-member maps, with the caller's own set as the fallback so an older
  // worker that returns only `modules`/`assignments` still works.
  modulesByMember = assessments.byMember || { [you]: assessments.modules || {} };
  assignmentsByMember = assignments.byMember || { [you]: assignments.assignments };

  // Keep looking at whoever was selected, unless they've left the household.
  const stillThere = household.members.some((m) => m.email === viewingMember);
  setViewingMember(stillThere ? viewingMember : household.you || you);
}

// currentModules/assignedKeys stay "the member currently being viewed", so every
// existing render function (the FPA grid, the category grids, the form
// populators) works unchanged — switching member just repoints them.
function setViewingMember(email) {
  viewingMember = email;
  currentModules = modulesByMember[email] || {};
  assignedKeys = Object.prototype.hasOwnProperty.call(assignmentsByMember, email)
    ? assignmentsByMember[email]
    : null;
}

const memberName = (email) => {
  const m = (household.members || []).find((x) => x.email === email);
  return (m && m.name) || email;
};
const isYou = (email) => email === household.you;
// "You" for the caller's own rows, first name for anyone else — a full name on
// every row of a shared list is noise.
const shortMemberName = (email) =>
  isYou(email) ? "You" : String(memberName(email)).split(" ")[0] || memberName(email);

// ---------- Auth ----------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById("login-form").classList.toggle("hidden", tab !== "login");
    document.getElementById("register-form").classList.toggle("hidden", tab !== "register");
  });
});

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("register-error");
  errorEl.textContent = "";
  try {
    const data = await apiRequest("/api/register", {
      method: "POST",
      body: {
        name: document.getElementById("register-name").value.trim(),
        email: document.getElementById("register-email").value.trim(),
        password: document.getElementById("register-password").value,
      },
    });
    setSession({ token: data.token, name: data.name, email: data.email });
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  try {
    const data = await apiRequest("/api/login", {
      method: "POST",
      body: {
        email: document.getElementById("login-email").value.trim(),
        password: document.getElementById("login-password").value,
      },
    });
    setSession({ token: data.token, name: data.name, email: data.email });
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  try {
    await apiRequest("/api/logout", { method: "POST", auth: true });
  } catch (err) {
    // ignore network errors on logout
  }
  clearSession();
  updateNav();
  showView("auth");
});

// ---------- Home (landing) ----------

// done / total / outstanding for the whole household, computed in ONE place.
//
// This used to be two functions: an outstanding count summed over every member,
// and a total taken from just the member on screen. Home then did
// `total - outstanding`, mixing the two scopes, and a two-person household
// rendered "-1 of 17 assessments complete" with the progress bar showing FULL
// (a negative width is invalid CSS, so the browser dropped it and the fill
// stretched to its container). Returning every number from one walk is what
// stops those drifting apart again — don't reintroduce a separate total.
//
// Household-wide on purpose: Home must not report "all caught up" while a spouse
// still has three assessments open in the portal they share.
function assessmentTotals() {
  const all = MODULES.concat(CATEGORY_MODULES);
  const members = (household.members || []).map((m) => m.email);
  // No household data yet (first paint, or a failed /api/household): fall back
  // to the member on screen so Home renders something truthful rather than zero.
  const scope = members.length ? members : [viewingMember || household.you || ""];
  let done = 0;
  let total = 0;
  const perMember = [];
  for (const m of scope) {
    const asg = Object.prototype.hasOwnProperty.call(assignmentsByMember, m)
      ? assignmentsByMember[m]
      : (m === viewingMember ? assignedKeys : null);
    const answered = modulesByMember[m] || (m === viewingMember ? currentModules : {}) || {};
    let mDone = 0;
    let mTotal = 0;
    for (const mod of all) {
      // A non-array assignment record means "no record" = everything visible,
      // the same rule isAssigned uses.
      if (Array.isArray(asg) && !asg.includes(mod.key)) continue;
      mTotal += 1;
      if (answered[mod.key]) mDone += 1;
    }
    done += mDone;
    total += mTotal;
    perMember.push({ email: m, done: mDone, total: mTotal });
  }
  return { done, total, outstanding: Math.max(0, total - done), perMember };
}

// Percent for a progress bar, clamped to 0-100. A width outside that range is
// invalid CSS, which the browser silently drops — and an unset width on
// .progress-fill makes it fill its track, so a bad number renders as COMPLETE.
// Failing to 0 is the only safe direction here.
function progressPct(done, total) {
  if (!total || !Number.isFinite(done)) return 0;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

function renderHomeLanding() {
  const session = getSession();
  document.getElementById("home-welcome").textContent = session ? `Welcome, ${session.name}` : "Welcome";

  // One walk, one set of numbers — the attention count and the progress bar both
  // read from this so they can't disagree (see assessmentTotals).
  const totals = assessmentTotals();
  const outstanding = totals.outstanding;
  const openRequests = docRequests.filter((r) => r.status === "open");
  const anyAssigned = totals.total > 0 || isAssigned("onboardingWizard");

  // ---- What needs attention: the actual items, each with its own way in ----
  const rows = openRequests.map((r) => `
    <div class="home-todo">
      <div class="home-todo-main">
        <div class="home-todo-label">${escapeHtml(r.label)}</div>
        <div class="home-todo-sub">Requested by your advisor${r.dueDate ? ` · needed by ${escapeHtml(r.dueDate)}` : ""}</div>
      </div>
      <button type="button" class="btn btn-primary home-goto" data-goto="documents">Send</button>
    </div>`);
  if (anyAssigned && outstanding > 0) {
    rows.push(`
      <div class="home-todo">
        <div class="home-todo-main">
          <div class="home-todo-label">${outstanding} assessment${outstanding === 1 ? "" : "s"} to complete</div>
          <div class="home-todo-sub">So your advisor has the full picture</div>
        </div>
        <button type="button" class="btn btn-primary home-goto" data-goto="assignments">Continue</button>
      </div>`);
  }
  const card = document.getElementById("home-attention-card");
  const allClear = document.getElementById("home-allclear");
  card.classList.toggle("hidden", rows.length === 0);
  allClear.classList.toggle("hidden", rows.length > 0);
  if (rows.length) {
    document.getElementById("home-attention-list").innerHTML = rows.join("");
  } else {
    allClear.textContent = anyAssigned
      ? "You're all caught up — nothing is waiting on you."
      : "Nothing is waiting on you right now. Your advisor will add things here when they're ready.";
  }

  // ---- Quick links: open the platform directly from Home ----
  // Same https guard as the Links tab (see renderLinks) — this value becomes an
  // href, so it is re-checked at every point of use, not just on write.
  const safeLinks = portalLinks.filter((l) => isHttpsUrl(l.url));
  document.getElementById("home-links-card").classList.toggle("hidden", !safeLinks.length);
  document.getElementById("home-links").innerHTML = safeLinks
    .map((l) => `<a class="btn btn-primary home-link-btn" href="${escapeHtml(l.url)}"
      target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)} ↗</a>`)
    .join("");

  // ---- Progress ----
  const progressCard = document.getElementById("home-progress-card");
  progressCard.classList.toggle("hidden", !totals.total);
  if (totals.total) {
    // Says whose numbers these are. A shared household total is meaningless
    // without that — 16 of 34 looks like a broken count if you think it's yours.
    const scopeNote = household.shared ? " across your household" : "";
    document.getElementById("home-progress-line").textContent =
      `${totals.done} of ${totals.total} assessment${totals.total === 1 ? "" : "s"} complete${scopeNote}`;
    document.getElementById("home-progress-fill").style.width =
      `${progressPct(totals.done, totals.total)}%`;

    // Per-member breakdown, so a shared household can see who still owes work
    // rather than only a blended figure.
    const breakdown = document.getElementById("home-progress-members");
    if (breakdown) {
      breakdown.innerHTML = household.shared
        ? totals.perMember
            .map((p) => `<span class="home-progress-member">${escapeHtml(shortMemberName(p.email))}
              ${p.done}/${p.total}</span>`)
            .join("")
        : "";
      breakdown.classList.toggle("hidden", !household.shared);
    }
  }

}

// Delegated and bound ONCE, not per render: the attention rows are rebuilt on
// every load but the progress-card buttons are static markup, so re-binding
// inside renderHomeLanding would stack a fresh listener on them each time and
// fire openTab twice on the second visit.
document.getElementById("view-home").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-goto]");
  if (btn) openTab(btn.dataset.goto);
});

async function loadHome() {
  const errorEl = document.getElementById("home-error");
  errorEl.textContent = "";
  try {
    await refreshState();
  } catch (err) {
    if (err.message.includes("authenticated")) return bounceToAuth();
    errorEl.textContent = "We couldn't load your latest progress — refresh to try again.";
  }
  renderHomeLanding();
  showView("home");
}

// ---------- Links ----------

let portalLinks = [];

// Defence in depth: the write path already refuses anything but https
// (isSafeLinkUrl in worker.js) and the read path filters again, but this value
// ends up in an href, so it is re-checked at the point of use. A record written
// before that validation existed can't become a javascript: link here.
function isHttpsUrl(raw) {
  try {
    return new URL(String(raw)).protocol === "https:";
  } catch {
    return false;
  }
}

function renderLinks() {
  const grid = document.getElementById("links-grid");
  const safe = portalLinks.filter((l) => isHttpsUrl(l.url));
  document.querySelector(".links-note").classList.toggle("hidden", !safe.length);
  if (!safe.length) {
    grid.innerHTML = `<p class="empty">No links have been set up yet. Your advisor will add them here.</p>`;
    return;
  }
  // rel="noopener noreferrer" on every outbound link: without noopener the
  // opened page gets a handle back to this one via window.opener.
  grid.innerHTML = safe
    .map((l) => `
      <div class="card hub-card">
        <h2>${escapeHtml(l.label)}</h2>
        ${l.description ? `<p class="hub-card-desc">${escapeHtml(l.description)}</p>` : ""}
        <a class="btn btn-primary hub-card-btn" href="${escapeHtml(l.url)}"
           target="_blank" rel="noopener noreferrer">Open ${escapeHtml(l.label)} ↗</a>
      </div>`)
    .join("");
}

async function loadLinks() {
  const errorEl = document.getElementById("links-error");
  errorEl.textContent = "";
  try {
    const data = await apiRequest("/api/portal-links", { auth: true });
    portalLinks = data.links || [];
  } catch (err) {
    if (err.message.includes("authenticated")) return bounceToAuth();
    errorEl.textContent = "We couldn't load your links — refresh to try again.";
  }
  renderLinks();
  showView("links");
}

// ---------- Documents ----------
// Mirrors the server's limits (CLIENT_UPLOAD_MAX / CLIENT_UPLOAD_TYPES in
// worker.js). The server is the real gate — this is here so the client gets told
// before spending time uploading a file that will be refused.
const DOC_UPLOAD_MAX = 25 * 1024 * 1024;
const DOC_UPLOAD_TYPES = ["pdf", "jpg", "jpeg", "png", "heic", "doc", "docx", "xls", "xlsx", "csv", "txt"];

let docRequests = [];
let sentDocuments = [];
let docUploading = false;

// Sections come from the server (DOC_CATEGORIES in worker.js) so the two can't
// drift. Seeded with the same four so the tab still renders if that field is
// missing — an older worker, or a failed request that degraded to an empty list.
let docCategories = [
  { id: "tax", label: "Tax Returns" },
  { id: "trust", label: "Trust Documents" },
  { id: "estate", label: "Estate Documents" },
  { id: "other", label: "Miscellaneous" },
];

// Placeholder copy lives here, not on the server: it is presentation, and
// shipping it in the API payload would mean a deploy to reword a hint.
const DOC_PLACEHOLDERS = {
  tax: "e.g. 2024 federal return",
  trust: "e.g. Revocable trust agreement",
  estate: "e.g. Will, power of attorney",
  other: "What is it?",
};
const docPlaceholder = (id) => DOC_PLACEHOLDERS[id] || "What is it?";

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExt(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

// Returns an error string, or "" when the file is acceptable.
function checkFile(file) {
  if (!file) return "Choose a file first.";
  if (file.size > DOC_UPLOAD_MAX) return `That file is ${fmtBytes(file.size)} — the limit is 25 MB.`;
  const ext = fileExt(file.name);
  if (!DOC_UPLOAD_TYPES.includes(ext)) {
    return `We can't accept ".${ext || "unknown"}" files. Please upload a PDF, image, or Office document.`;
  }
  return "";
}

function renderDocuments() {
  // Requests. Fulfilled ones stay listed so an upload visibly registers rather
  // than the row silently disappearing.
  const open = docRequests.filter((r) => r.status === "open");
  const done = docRequests.filter((r) => r.status === "fulfilled");
  const list = document.getElementById("doc-requests-list");
  if (!docRequests.length) {
    list.innerHTML = `<p class="empty">Your advisor hasn't requested anything right now.</p>`;
  } else {
    list.innerHTML =
      open.map((r) => `
        <div class="doc-req" data-req="${escapeHtml(r.id)}">
          <div class="doc-req-main">
            <div class="doc-req-label">${escapeHtml(r.label)}${
              household.shared && r.forEmail
                ? ` <span class="doc-who">for ${escapeHtml(shortMemberName(r.forEmail))}</span>`
                : ""}</div>
            ${r.notes ? `<div class="doc-req-notes">${escapeHtml(r.notes)}</div>` : ""}
            ${r.dueDate ? `<div class="doc-req-notes">Needed by ${escapeHtml(r.dueDate)}</div>` : ""}
          </div>
          <div class="doc-req-actions">
            <input type="file" class="doc-file doc-req-file" data-req="${escapeHtml(r.id)}" />
            <button type="button" class="btn btn-primary doc-req-send" data-req="${escapeHtml(r.id)}">Upload</button>
          </div>
          <div class="progress-track hidden doc-req-progress"><div class="progress-fill"></div></div>
          <p class="form-error doc-req-error"></p>
        </div>`).join("") +
      done.map((r) => `
        <div class="doc-req doc-req-done">
          <div class="doc-req-main">
            <div class="doc-req-label">${escapeHtml(r.label)}${
              household.shared && r.forEmail
                ? ` <span class="doc-who">for ${escapeHtml(shortMemberName(r.forEmail))}</span>`
                : ""}</div>
            <div class="doc-req-notes">Received${r.fulfilledAt ? ` ${new Date(r.fulfilledAt).toLocaleDateString()}` : ""} — thank you.</div>
          </div>
          <span class="status-badge status-done">Received</span>
        </div>`).join("");
  }

  // One card per section, each showing what's been filed there and its own
  // upload control. A client uploading a tax return picks the Tax Returns
  // section rather than choosing a category from a dropdown — the section IS
  // the category, so there is nothing extra to get wrong.
  document.getElementById("doc-sections").innerHTML = docCategories.map((cat) => {
    const mine = sentDocuments.filter((d) => (d.category || "other") === cat.id);
    return `
      <div class="card">
        <h2>${escapeHtml(cat.label)}</h2>
        <div class="doc-cat-list">
          ${mine.length
            ? mine.map((d) => `
              <div class="doc-sent">
                <div class="doc-req-label">${escapeHtml(d.name)}${
                  household.shared && d.ownerEmail
                    ? ` <span class="doc-who">${escapeHtml(shortMemberName(d.ownerEmail))}</span>`
                    : ""}</div>
                <div class="doc-req-notes">${escapeHtml(d.filename)} · ${fmtBytes(d.size)} ·
                  ${d.uploadedAt ? escapeHtml(new Date(d.uploadedAt).toLocaleString()) : ""}</div>
              </div>`).join("")
            : `<p class="empty">Nothing here yet.</p>`}
        </div>
        <div class="doc-upload-row">
          <label class="sr-only-client" for="doc-name-${cat.id}">Document name</label>
          <input type="text" class="doc-input" id="doc-name-${cat.id}"
            placeholder="${escapeHtml(docPlaceholder(cat.id))}" maxlength="200" />
          <input type="file" class="doc-file doc-cat-file" id="doc-file-${cat.id}" data-cat="${cat.id}" />
          <button type="button" class="btn btn-primary doc-cat-send" data-cat="${cat.id}">Send</button>
        </div>
        <p class="hint">PDF, image (JPG/PNG/HEIC) or Office document, up to 25 MB.</p>
        <div class="progress-track hidden" id="doc-progress-${cat.id}"><div class="progress-fill" id="doc-fill-${cat.id}"></div></div>
        <p class="form-error" id="doc-error-${cat.id}"></p>
      </div>`;
  }).join("");

  wireDocUploads();
}

function wireDocUploads() {
  document.querySelectorAll(".doc-req-send").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".doc-req");
      const file = row.querySelector(".doc-req-file").files[0];
      const errEl = row.querySelector(".doc-req-error");
      const req = docRequests.find((r) => r.id === btn.dataset.req);
      errEl.textContent = "";
      const bad = checkFile(file);
      if (bad) { errEl.textContent = bad; return; }
      // The request's own label becomes the document name — the advisor already
      // said what they wanted, so making the client retype it is pure friction.
      // The request's own label becomes the document name, and the request's
      // category decides where it files (enforced server-side) — the advisor
      // already said both, so making the client restate them is pure friction.
      uploadDocument(file, req ? req.label : file.name, btn.dataset.req, "", {
        button: btn,
        errorEl: errEl,
        track: row.querySelector(".doc-req-progress"),
        fill: row.querySelector(".doc-req-progress .progress-fill"),
      });
    });
  });

  // One Send per section. The section the button sits in IS the category, so
  // nothing extra has to be chosen.
  document.querySelectorAll(".doc-cat-send").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      const nameEl = document.getElementById(`doc-name-${cat}`);
      const fileEl = document.getElementById(`doc-file-${cat}`);
      const errEl = document.getElementById(`doc-error-${cat}`);
      const file = fileEl.files[0];
      errEl.textContent = "";
      const bad = checkFile(file);
      if (bad) { errEl.textContent = bad; return; }
      // Fall back to the filename so a client who just picks a file isn't
      // blocked by an empty name field.
      const name = nameEl.value.trim() || file.name.replace(/\.[^.]+$/, "");
      uploadDocument(file, name, "", cat, {
        button: btn,
        errorEl: errEl,
        track: document.getElementById(`doc-progress-${cat}`),
        fill: document.getElementById(`doc-fill-${cat}`),
        onDone: () => { nameEl.value = ""; fileEl.value = ""; },
      });
    });
  });
}

// Chunked through our own Worker rather than straight to SharePoint: the upload
// URL is a capability, so it never leaves the server. Same shape as the admin
// path (see handleClientDocUploadChunk).
async function uploadDocument(file, name, requestId, category, ui) {
  if (docUploading) return;
  docUploading = true;
  ui.button.disabled = true;
  const originalLabel = ui.button.textContent;
  ui.button.textContent = "Sending…";
  ui.track.classList.remove("hidden");
  ui.fill.style.width = "0%";
  try {
    const start = await apiRequest("/api/documents/upload", {
      method: "POST",
      auth: true,
      body: {
        filename: file.name, size: file.size, name,
        requestId: requestId || undefined,
        category: category || undefined,
      },
    });
    const session = getSession();
    let offset = 0;
    let done = false;
    while (!done) {
      const slice = file.slice(offset, offset + start.chunkSize);
      const res = await fetch(`${API_BASE_URL}/api/documents/chunk`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "X-Upload-Ticket": start.ticket,
          "X-Upload-Offset": String(offset),
          "Content-Type": "application/octet-stream",
        },
        body: slice,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      if (data.done) { done = true; break; }
      offset = data.nextOffset;
      ui.fill.style.width = `${Math.round((offset / file.size) * 100)}%`;
    }
    ui.fill.style.width = "100%";
    if (ui.onDone) ui.onDone();
    await loadDocuments();
  } catch (err) {
    if (err.message.includes("authenticated")) return bounceToAuth();
    ui.errorEl.textContent = err.message;
    ui.track.classList.add("hidden");
  } finally {
    docUploading = false;
    ui.button.disabled = false;
    ui.button.textContent = originalLabel;
  }
}

async function loadDocuments() {
  const errorEl = document.getElementById("documents-error");
  errorEl.textContent = "";
  try {
    const [reqs, docs] = await Promise.all([
      apiRequest("/api/document-requests", { auth: true }),
      apiRequest("/api/documents", { auth: true }),
    ]);
    docRequests = reqs.requests || [];
    sentDocuments = docs.documents || [];
    // Server-supplied section list wins; the seeded default only covers an
    // older worker that doesn't send one.
    if (Array.isArray(docs.categories) && docs.categories.length) docCategories = docs.categories;
  } catch (err) {
    if (err.message.includes("authenticated")) return bounceToAuth();
    errorEl.textContent = "We couldn't load your documents — refresh to try again.";
  }
  renderDocuments();
  showView("documents");
}

// ---------- Assignments ----------

function bounceToAuth() {
  clearSession();
  updateNav();
  showView("auth");
}

function renderHome() {
  // Onboarding card — its two offerings (Financial Picture Analysis and the
  // New Client Onboarding wizard) are each gated by assignment; the whole card
  // hides only when both are unassigned.
  const assignedFpa = MODULES.filter((mod) => isAssigned(mod.key));
  const showFpa = assignedFpa.length > 0;
  const showWizard = isAssigned("onboardingWizard");
  document.getElementById("home-fpa-offering").classList.toggle("hidden", !showFpa);
  document.getElementById("home-wizard-offering").classList.toggle("hidden", !showWizard);
  document.getElementById("home-onboarding-card").classList.toggle("hidden", !showFpa && !showWizard);

  if (showFpa) {
    const completed = assignedFpa.filter((mod) => currentModules[mod.key]).length;
    document.getElementById("home-fpa-status").textContent =
      completed === 0
        ? "Not started"
        : completed === assignedFpa.length
          ? "All assessments complete ✓"
          : `${completed} of ${assignedFpa.length} assessments complete`;
    document.getElementById("home-fpa-fill").style.width = `${(completed / assignedFpa.length) * 100}%`;
    document.getElementById("home-open-fpa").textContent = completed === 0 ? "Start Analysis" : "Open Analysis";
  }

  const grid = document.getElementById("home-category-grid");
  grid.innerHTML = CATEGORIES.filter((cat) => cat.type === "modules")
    .map((cat) => {
      const assignedMods = cat.moduleKeys.filter((key) => isAssigned(key));
      if (!assignedMods.length) return ""; // whole category unassigned → hidden
      const done = assignedMods.filter((key) => currentModules[key]).length;
      const total = assignedMods.length;
      const status =
        done === 0 ? "Not started" : done === total ? "All assessments complete ✓" : `${done} of ${total} complete`;
      return `
        <div class="card hub-card">
          <h2>${escapeHtml(cat.title)}</h2>
          <p class="hub-card-desc">${escapeHtml(cat.description)}</p>
          <p class="hub-card-status">${status}</p>
          <div class="hub-card-progress progress-track"><div class="progress-fill" style="width:${(done / total) * 100}%"></div></div>
          <button class="btn btn-primary hub-card-btn category-open-btn" data-category="${cat.key}">${done === 0 ? "Start" : "Open"}</button>
        </div>`;
    })
    .join("");
  grid.querySelectorAll(".category-open-btn").forEach((btn) => {
    btn.addEventListener("click", () => openCategory(btn.dataset.category));
  });
}

// Fetch assessment progress (which also validates the session), then show the
// assigned work. The empty state is driven off the same assignment checks
// renderHome uses, so a client with nothing assigned sees one clear line
// instead of a page of hidden cards.
async function loadAssignments() {
  const errorEl = document.getElementById("assignments-error");
  errorEl.textContent = "";
  try {
    await refreshState();
  } catch (err) {
    if (err.message.includes("authenticated")) return bounceToAuth();
    errorEl.textContent = "We couldn't load your latest progress — refresh to try again.";
  }
  renderMemberSwitch();
  renderAssignmentsHeader();
  renderHome();
  const anyAssigned = MODULES.concat(CATEGORY_MODULES).some((mod) => isAssigned(mod.key))
    || isAssigned("onboardingWizard");
  document.getElementById("assignments-empty").classList.toggle("hidden", anyAssigned);
  showView("assignments");
}

// Hidden entirely for a client who shares with nobody, so a single client's
// portal looks exactly as it did before household sharing existed.
function renderMemberSwitch() {
  const wrap = document.getElementById("member-switch");
  if (!household.shared) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  document.getElementById("member-switch-btns").innerHTML = household.members
    .map((m) => {
      const done = Object.keys(modulesByMember[m.email] || {}).length;
      return `<button type="button" class="member-btn${m.email === viewingMember ? " active" : ""}"
        data-member="${escapeHtml(m.email)}">${escapeHtml(isYou(m.email) ? "You" : m.name)}
        <span class="member-btn-count">${done}</span></button>`;
    })
    .join("");
  wrap.querySelectorAll(".member-btn").forEach((b) =>
    b.addEventListener("click", () => {
      setViewingMember(b.dataset.member);
      // Re-render in place rather than refetching: the maps are already loaded,
      // and a round trip here would make switching feel laggy.
      renderMemberSwitch();
      renderAssignmentsHeader();
      renderHome();
      const any = MODULES.concat(CATEGORY_MODULES).some((mod) => isAssigned(mod.key))
        || isAssigned("onboardingWizard");
      document.getElementById("assignments-empty").classList.toggle("hidden", any);
    })
  );
}

// Says whose assessments are on screen, so someone filling in a spouse's forms
// can see that's what they're doing.
function renderAssignmentsHeader() {
  const own = !household.shared || viewingMember === household.you;
  document.getElementById("assignments-title").textContent =
    own ? "Your Assessments" : `${memberName(viewingMember)}'s Assessments`;
  document.getElementById("assignments-subtitle").textContent = own
    ? "The assessments and workflows your advisor has assigned to you."
    : `You're viewing ${memberName(viewingMember)}'s assessments. Anything you submit is saved as theirs.`;
}

document.getElementById("home-open-fpa").addEventListener("click", () => loadDashboard());
document.getElementById("dashboard-home-btn").addEventListener("click", () => loadAssignments());
document.getElementById("category-home-btn").addEventListener("click", () => loadAssignments());

// ---------- Financial Picture Analysis (assessment dashboard) ----------

let currentModules = {};

// Shared module card markup for the FPA dashboard and the category views.
// Results and charts are intentionally not shown to clients — the advisor
// walks through them in person (printable from the admin detail view).
function moduleCardHtml(mod, index, data) {
  if (!data) {
    return `
      <div class="card module-card module-card-empty">
        <div class="module-card-header">
          <span class="module-number">${index + 1}</span>
          <h2>${escapeHtml(mod.title)}</h2>
          <span class="status-badge status-pending">Not started</span>
        </div>
        <p class="module-description">${escapeHtml(mod.description)}</p>
        <button class="btn btn-primary module-start-btn" data-module="${mod.key}">Start Assessment</button>
      </div>`;
  }
  return `
    <div class="card module-card">
      <div class="module-card-header">
        <span class="module-number done">✓</span>
        <h2>${escapeHtml(mod.title)}</h2>
        <span class="status-badge status-done">Completed</span>
      </div>
      <p class="module-description">Thank you — your responses have been submitted. Your advisor will review your results with you.</p>
      <div class="module-card-footer">
        <span class="updated-at-inline">Submitted ${data.updatedAt ? new Date(data.updatedAt).toLocaleDateString() : ""}</span>
        <button class="btn btn-secondary module-start-btn" data-module="${mod.key}">Review / Edit Answers</button>
      </div>
    </div>`;
}

function renderDashboard() {
  const grid = document.getElementById("module-grid");
  const mods = MODULES.filter((mod) => isAssigned(mod.key));
  const completed = mods.filter((mod) => currentModules[mod.key]).length;

  document.getElementById("progress-note").textContent = `${completed} of ${mods.length} complete.`;
  document.getElementById("progress-fill").style.width = `${mods.length ? (completed / mods.length) * 100 : 0}%`;

  grid.innerHTML = mods.map((mod, index) => moduleCardHtml(mod, index, currentModules[mod.key])).join("");

  grid.querySelectorAll(".module-start-btn").forEach((btn) => {
    btn.addEventListener("click", () => openModuleForm(btn.dataset.module));
  });
}

async function loadDashboard() {
  showView("dashboard");
  try {
    await refreshState();
    renderDashboard();
  } catch (err) {
    if (err.message.includes("authenticated")) {
      clearSession();
      updateNav();
      showView("auth");
    }
  }
}

document.querySelectorAll(".back-btn").forEach((btn) => {
  btn.addEventListener("click", () => loadDashboard());
});

// ---------- Category views (one reusable section, re-rendered per category) ----------

let currentCategoryKey = null;

function renderCategory() {
  const cat = CATEGORIES.find((c) => c.key === currentCategoryKey);
  if (!cat || cat.type !== "modules") return;
  const mods = cat.moduleKeys
    .map((key) => CATEGORY_MODULES.find((mod) => mod.key === key))
    .filter((mod) => isAssigned(mod.key));
  const completed = mods.filter((mod) => currentModules[mod.key]).length;

  document.getElementById("category-title").textContent = cat.title;
  document.getElementById("category-desc").textContent = cat.description;
  document.getElementById("category-progress-note").textContent = `${completed} of ${mods.length} complete.`;
  document.getElementById("category-progress-fill").style.width = `${mods.length ? (completed / mods.length) * 100 : 0}%`;

  const grid = document.getElementById("category-module-grid");
  grid.innerHTML = mods.map((mod, index) => moduleCardHtml(mod, index, currentModules[mod.key])).join("");
  grid.querySelectorAll(".module-start-btn").forEach((btn) => {
    btn.addEventListener("click", () => openModuleForm(btn.dataset.module));
  });
}

// Synchronous show (used after saves and by form Back buttons — no refetch).
function showCategory(key) {
  currentCategoryKey = key;
  renderCategory();
  showView("category");
}

// Entry from the home hub: show immediately, then refresh from the server.
async function openCategory(key) {
  showCategory(key);
  try {
    await refreshState();
    renderCategory();
  } catch (err) {
    if (err.message.includes("authenticated")) {
      clearSession();
      updateNav();
      showView("auth");
    }
  }
}

// ---------- Form builders (dynamic field grids) ----------

function buildMoneyGrid(containerId, fields, idPrefix) {
  const container = document.getElementById(containerId);
  container.innerHTML = fields
    .map(
      ([key, label]) => `
      <div class="budget-field">
        <label for="${idPrefix}-${key}">${escapeHtml(label)} ($)</label>
        <input type="number" id="${idPrefix}-${key}" min="0" step="1" placeholder="0" required />
      </div>`
    )
    .join("");
}

buildMoneyGrid("budget-expense-grid", BUDGET_EXPENSES, "budget-exp");
buildMoneyGrid("networth-asset-grid", NETWORTH_ASSETS, "nw-asset");
buildMoneyGrid("networth-liability-grid", NETWORTH_LIABILITIES, "nw-debt");

function readMoneyGrid(fields, idPrefix) {
  const values = {};
  fields.forEach(([key]) => {
    values[key] = Number(document.getElementById(`${idPrefix}-${key}`).value) || 0;
  });
  return values;
}

function fillMoneyGrid(fields, idPrefix, values) {
  fields.forEach(([key]) => {
    document.getElementById(`${idPrefix}-${key}`).value = values && values[key] != null ? values[key] : "";
  });
}

// ---------- Module form open/populate ----------

function openModuleForm(key) {
  if (!isAssigned(key)) return; // not assigned to this client — not reachable via UI
  const data = currentModules[key];
  const populate = FORM_POPULATORS[key];
  document.getElementById(`${key}-form`).reset();
  populate(data || null);
  document.getElementById(`${key}-error`).textContent = "";
  showView(key);
}

const FORM_POPULATORS = {
  risk(data) {
    if (data) {
      document.getElementById("risk-experience").value = data.experienceLevel || "";
      Object.entries(data.answers || {}).forEach(([q, v]) => {
        const input = document.querySelector(`input[name="risk-q${q}"][value="${v}"]`);
        if (input) input.checked = true;
      });
      document.getElementById("risk-goal-short").value = data.goalShortTerm || "";
      document.getElementById("risk-goal-medium").value = data.goalMediumTerm || "";
      document.getElementById("risk-goal-long").value = data.goalLongTerm || "";
    }
    updateRiskScoreDisplay();
  },
  budget(data) {
    document.getElementById("budget-income").value = data ? data.monthlyIncome : "";
    document.getElementById("budget-savings").value = data ? data.monthlySavings : "";
    fillMoneyGrid(BUDGET_EXPENSES, "budget-exp", data ? data.expenses : null);
    updateBudgetTotals();
  },
  retirement(data) {
    document.getElementById("ret-current-age").value = data ? data.currentAge : "";
    document.getElementById("ret-target-age").value = data ? data.targetAge : "";
    document.getElementById("ret-current-savings").value = data ? data.currentSavings : "";
    document.getElementById("ret-monthly-contribution").value = data ? data.monthlyContribution : "";
    document.getElementById("ret-employer-match").value = data ? data.employerMatchMonthly : "";
    document.getElementById("ret-desired-income").value = data ? data.desiredMonthlyIncome : "";
    document.getElementById("ret-old-plans").value = data ? data.oldEmployerPlans : "";
  },
  networth(data) {
    fillMoneyGrid(NETWORTH_ASSETS, "nw-asset", data ? data.assets : null);
    fillMoneyGrid(NETWORTH_LIABILITIES, "nw-debt", data ? data.liabilities : null);
    updateNetWorthTotal();
  },
  compensation(data) {
    document.getElementById("comp-base").value = data ? data.baseSalary : "";
    document.getElementById("comp-bonus").value = data ? data.annualBonus : "";
    document.getElementById("comp-equity").value = data ? data.annualEquityValue : "";
    document.querySelectorAll('input[name="comp-equity-type"]').forEach((cb) => {
      cb.checked = !!(data && data.equityTypes && data.equityTypes.includes(cb.value));
    });
    document.getElementById("comp-contribution-pct").value = data ? data.contributionPct : "";
    document.getElementById("comp-match-pct").value = data ? data.employerMatchPct : "";
    document.getElementById("comp-hsa").checked = !!(data && data.hsaEligible);
    document.getElementById("comp-deferred").checked = !!(data && data.deferredComp);
    document.getElementById("comp-concentration").value = data ? data.employerStockConcentration : "";
  },
};

// ---------- Live form feedback ----------

function updateRiskScoreDisplay() {
  const display = document.getElementById("risk-score-display");
  let score = 0, answered = 0;
  for (let i = 1; i <= 5; i++) {
    const checked = document.querySelector(`input[name="risk-q${i}"]:checked`);
    if (checked) {
      score += Number(checked.value);
      answered++;
    }
  }
  if (answered === 0) display.textContent = "";
  else if (answered < 5) display.textContent = `${answered} of 5 questions answered`;
  else {
    const category =
      score <= 9 ? "Conservative" : score <= 14 ? "Moderately Conservative" : score <= 19 ? "Moderate" : score <= 24 ? "Moderately Aggressive" : "Aggressive";
    display.textContent = `Risk Score: ${score} / 25 — ${category}`;
  }
}

document.querySelectorAll('#risk-form input[type="radio"]').forEach((input) => {
  input.addEventListener("change", updateRiskScoreDisplay);
});

function updateBudgetTotals() {
  const expenses = readMoneyGrid(BUDGET_EXPENSES, "budget-exp");
  const total = Object.values(expenses).reduce((s, v) => s + v, 0);
  const income = Number(document.getElementById("budget-income").value) || 0;
  const savings = Number(document.getElementById("budget-savings").value) || 0;
  document.getElementById("budget-total-value").textContent = fmtMoney(total);
  const surplus = income - total - savings;
  const surplusEl = document.getElementById("budget-surplus-value");
  surplusEl.textContent = income > 0 ? ` · Unallocated: ${fmtMoney(surplus)}` : "";
  surplusEl.classList.toggle("negative", surplus < 0);
}

document.getElementById("budget-form").addEventListener("input", updateBudgetTotals);

function updateNetWorthTotal() {
  const assets = readMoneyGrid(NETWORTH_ASSETS, "nw-asset");
  const debts = readMoneyGrid(NETWORTH_LIABILITIES, "nw-debt");
  const net =
    Object.values(assets).reduce((s, v) => s + v, 0) - Object.values(debts).reduce((s, v) => s + v, 0);
  const el = document.getElementById("networth-total-value");
  el.textContent = fmtMoney(net);
  el.classList.toggle("negative", net < 0);
}

document.getElementById("networth-form").addEventListener("input", updateNetWorthTotal);

// ---------- Module form submission ----------

async function saveModule(key, payload, errorElId) {
  const errorEl = document.getElementById(errorElId);
  errorEl.textContent = "";
  try {
    // `owner` is whose assessment this is — filling in a spouse's form must save
    // to THEIR record, not fork a copy onto the person doing the typing. The
    // server validates it against the household and rejects anything outside it.
    const data = await apiRequest(`/api/assessments/${key}`, {
      method: "POST",
      body: { ...payload, owner: viewingMember || undefined },
      auth: true,
    });
    // Patch the map for whoever the server says it saved, then repoint the
    // derived view — otherwise the switcher's counts and the grid would keep
    // showing pre-save state until the next full refresh.
    const savedFor = data.owner || viewingMember;
    if (savedFor) modulesByMember[savedFor] = data.modules || modulesByMember[savedFor] || {};
    setViewingMember(viewingMember);
    if (household.shared) renderMemberSwitch();
    const catMod = CATEGORY_MODULES.find((mod) => mod.key === key);
    if (catMod) {
      showCategory(catMod.category);
    } else {
      showView("dashboard");
      renderDashboard();
    }
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

document.getElementById("risk-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const answers = {};
  for (let i = 1; i <= 5; i++) {
    const checked = document.querySelector(`input[name="risk-q${i}"]:checked`);
    if (checked) answers[i] = Number(checked.value);
  }
  if (Object.keys(answers).length < 5) {
    document.getElementById("risk-error").textContent = "Please answer all 5 risk tolerance questions.";
    return;
  }
  await saveModule(
    "risk",
    {
      experienceLevel: document.getElementById("risk-experience").value,
      answers,
      goalShortTerm: document.getElementById("risk-goal-short").value.trim(),
      goalMediumTerm: document.getElementById("risk-goal-medium").value.trim(),
      goalLongTerm: document.getElementById("risk-goal-long").value.trim(),
    },
    "risk-error"
  );
});

document.getElementById("budget-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveModule(
    "budget",
    {
      monthlyIncome: Number(document.getElementById("budget-income").value) || 0,
      monthlySavings: Number(document.getElementById("budget-savings").value) || 0,
      expenses: readMoneyGrid(BUDGET_EXPENSES, "budget-exp"),
    },
    "budget-error"
  );
});

document.getElementById("retirement-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const currentAge = Number(document.getElementById("ret-current-age").value);
  const targetAge = Number(document.getElementById("ret-target-age").value);
  if (targetAge <= currentAge) {
    document.getElementById("retirement-error").textContent = "Target retirement age must be greater than your current age.";
    return;
  }
  await saveModule(
    "retirement",
    {
      currentAge,
      targetAge,
      currentSavings: Number(document.getElementById("ret-current-savings").value) || 0,
      monthlyContribution: Number(document.getElementById("ret-monthly-contribution").value) || 0,
      employerMatchMonthly: Number(document.getElementById("ret-employer-match").value) || 0,
      desiredMonthlyIncome: Number(document.getElementById("ret-desired-income").value) || 0,
      oldEmployerPlans: document.getElementById("ret-old-plans").value,
    },
    "retirement-error"
  );
});

document.getElementById("networth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveModule(
    "networth",
    {
      assets: readMoneyGrid(NETWORTH_ASSETS, "nw-asset"),
      liabilities: readMoneyGrid(NETWORTH_LIABILITIES, "nw-debt"),
    },
    "networth-error"
  );
});

document.getElementById("compensation-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const equityTypes = Array.from(document.querySelectorAll('input[name="comp-equity-type"]:checked')).map(
    (cb) => cb.value
  );
  await saveModule(
    "compensation",
    {
      baseSalary: Number(document.getElementById("comp-base").value) || 0,
      annualBonus: Number(document.getElementById("comp-bonus").value) || 0,
      annualEquityValue: Number(document.getElementById("comp-equity").value) || 0,
      equityTypes,
      contributionPct: Number(document.getElementById("comp-contribution-pct").value) || 0,
      employerMatchPct: Number(document.getElementById("comp-match-pct").value) || 0,
      hsaEligible: document.getElementById("comp-hsa").checked,
      deferredComp: document.getElementById("comp-deferred").checked,
      employerStockConcentration: document.getElementById("comp-concentration").value,
    },
    "compensation-error"
  );
});

// ---------- Generated category module forms ----------
// Each of the 12 new modules is declared in MODULE_FORMS and its section DOM
// (view-<key>, <key>-form, <key>-error) is built at boot by a small engine.
// Field keys are dotted paths into the POST payload; number inputs read blank
// as 0, selects are required, and radios are validated like the risk module.

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]] = cur[parts[i]] || {};
  }
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj, path) {
  return path.split(".").reduce((cur, part) => (cur == null ? undefined : cur[part]), obj);
}

function fid(modKey, path) {
  return `${modKey}-f-${path.replace(/\./g, "-")}`;
}

function specFieldHtml(modKey, f) {
  switch (f.type) {
    case "heading":
      return (
        `<h2 class="section-heading">${escapeHtml(f.label)}</h2>` +
        (f.note ? `<p class="subtitle">${escapeHtml(f.note)}</p>` : "")
      );
    case "grid":
      return `<div class="budget-grid">${f.fields
        .map(
          (fld) => `
        <div class="budget-field">
          <label for="${fid(modKey, fld.key)}">${escapeHtml(fld.label)}</label>
          <input type="number" id="${fid(modKey, fld.key)}" min="${fld.min != null ? fld.min : 0}"${fld.max != null ? ` max="${fld.max}"` : ""} step="${fld.step || 1}" placeholder="0" />
        </div>`
        )
        .join("")}</div>`;
    case "select":
      return `
        <label for="${fid(modKey, f.key)}">${escapeHtml(f.label)}</label>
        <select id="${fid(modKey, f.key)}" required>
          <option value="" disabled selected>Select one</option>
          ${f.options.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}
        </select>`;
    case "radios":
      return f.questions
        .map(
          (q, i) => `
        <fieldset class="risk-question">
          <legend>${i + 1}. ${escapeHtml(q.legend)}</legend>
          ${q.options
            .map(
              (opt, j) =>
                `<label class="radio-option"><input type="radio" name="${modKey}-q${i + 1}" value="${j + 1}"${j === 0 ? " required" : ""} /> ${escapeHtml(opt)}</label>`
            )
            .join("")}
        </fieldset>`
        )
        .join("");
    case "checks":
      return (
        `<label>${escapeHtml(f.label)}</label>` +
        (f.note ? `<p class="hint">${escapeHtml(f.note)}</p>` : "") +
        `<div class="checkbox-group">${f.options
          .map(
            ([value, label]) =>
              `<label class="radio-option"><input type="checkbox" name="${fid(modKey, f.key)}" value="${value}" /> ${escapeHtml(label)}</label>`
          )
          .join("")}</div>`
      );
    case "checkbox":
      return `<div class="checkbox-group"><label class="radio-option"><input type="checkbox" id="${fid(modKey, f.key)}" /> ${escapeHtml(f.label)}</label></div>`;
    case "textarea":
      return `
        <label for="${fid(modKey, f.key)}">${escapeHtml(f.label)}</label>
        <textarea id="${fid(modKey, f.key)}" rows="${f.rows || 3}" maxlength="${f.maxlength || 1000}"${f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : ""}></textarea>`;
    case "statusRows":
      return `<div class="status-rows">${f.rows
        .map((r) => {
          const extra = r.extra
            ? `<input type="number" id="${fid(modKey, `${f.key}.${r.key}.${r.extra.field}`)}" min="${r.extra.min != null ? r.extra.min : 0}"${r.extra.max != null ? ` max="${r.extra.max}"` : ""} step="${r.extra.step || 1}" placeholder="${escapeHtml(r.extra.placeholder)}" aria-label="${escapeHtml(`${r.label} — ${r.extra.placeholder}`)}" />`
            : `<span class="status-row-spacer"></span>`;
          return `
        <div class="status-row">
          <span class="status-row-label">${escapeHtml(r.label)}</span>
          <select id="${fid(modKey, `${f.key}.${r.key}.status`)}" required aria-label="${escapeHtml(`${r.label} — status`)}">
            <option value="" disabled selected>Select one</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
            <option value="unsure">Not sure</option>
          </select>
          ${extra}
        </div>`;
        })
        .join("")}</div>`;
  }
  return "";
}

function readSpecForm(modKey, spec) {
  const payload = {};
  spec.fields.forEach((f) => {
    switch (f.type) {
      case "grid":
        f.fields.forEach((fld) => {
          setPath(payload, fld.key, Number(document.getElementById(fid(modKey, fld.key)).value) || 0);
        });
        break;
      case "select": {
        const value = document.getElementById(fid(modKey, f.key)).value;
        setPath(payload, f.key, f.number ? Number(value) : value);
        break;
      }
      case "radios": {
        const answers = {};
        f.questions.forEach((q, i) => {
          const checked = document.querySelector(`input[name="${modKey}-q${i + 1}"]:checked`);
          if (checked) answers[i + 1] = Number(checked.value);
        });
        setPath(payload, f.key, answers);
        break;
      }
      case "checks":
        setPath(
          payload,
          f.key,
          Array.from(document.querySelectorAll(`input[name="${fid(modKey, f.key)}"]:checked`)).map((cb) => cb.value)
        );
        break;
      case "checkbox":
        setPath(payload, f.key, document.getElementById(fid(modKey, f.key)).checked);
        break;
      case "textarea":
        setPath(payload, f.key, document.getElementById(fid(modKey, f.key)).value.trim());
        break;
      case "statusRows":
        f.rows.forEach((r) => {
          const entry = { status: document.getElementById(fid(modKey, `${f.key}.${r.key}.status`)).value };
          if (r.extra) {
            const raw = document.getElementById(fid(modKey, `${f.key}.${r.key}.${r.extra.field}`)).value;
            entry[r.extra.field] = raw === "" ? null : Number(raw);
          } else if (r.nullField) {
            entry[r.nullField] = null;
          }
          setPath(payload, `${f.key}.${r.key}`, entry);
        });
        break;
    }
  });
  return payload;
}

// Restores raw input fields only — derived fields are recomputed server-side.
function populateSpecForm(modKey, spec, data) {
  spec.fields.forEach((f) => {
    switch (f.type) {
      case "grid":
        f.fields.forEach((fld) => {
          const value = data ? getPath(data, fld.key) : null;
          document.getElementById(fid(modKey, fld.key)).value = value != null ? value : "";
        });
        break;
      case "select": {
        const value = data ? getPath(data, f.key) : null;
        document.getElementById(fid(modKey, f.key)).value = value != null ? String(value) : "";
        break;
      }
      case "radios":
        if (data) {
          Object.entries(getPath(data, f.key) || {}).forEach(([q, v]) => {
            const input = document.querySelector(`input[name="${modKey}-q${q}"][value="${v}"]`);
            if (input) input.checked = true;
          });
        }
        break;
      case "checks": {
        const values = (data && getPath(data, f.key)) || [];
        document.querySelectorAll(`input[name="${fid(modKey, f.key)}"]`).forEach((cb) => {
          cb.checked = values.includes(cb.value);
        });
        break;
      }
      case "checkbox":
        document.getElementById(fid(modKey, f.key)).checked = !!(data && getPath(data, f.key));
        break;
      case "textarea":
        document.getElementById(fid(modKey, f.key)).value = (data && getPath(data, f.key)) || "";
        break;
      case "statusRows":
        f.rows.forEach((r) => {
          const entry = data ? getPath(data, `${f.key}.${r.key}`) : null;
          document.getElementById(fid(modKey, `${f.key}.${r.key}.status`)).value = (entry && entry.status) || "";
          if (r.extra) {
            const value = entry && entry[r.extra.field];
            document.getElementById(fid(modKey, `${f.key}.${r.key}.${r.extra.field}`)).value = value != null ? value : "";
          }
        });
        break;
    }
  });
}

const MODULE_FORMS = {
  spending: {
    subtitle: "Where your money goes each month, split into essentials and everything else. Estimates are fine.",
    fields: [
      { type: "heading", label: "Monthly Income" },
      { type: "grid", fields: [{ key: "monthlyIncome", label: "Monthly Take-Home Income ($)" }] },
      { type: "heading", label: "Essential Expenses", note: "Roughly how much do you spend per month on each?" },
      { type: "grid", fields: SPENDING_ESSENTIALS.map(([key, label]) => ({ key: `essentials.${key}`, label: `${label} ($)` })) },
      { type: "heading", label: "Discretionary Spending" },
      { type: "grid", fields: SPENDING_DISCRETIONARY.map(([key, label]) => ({ key: `discretionary.${key}`, label: `${label} ($)` })) },
    ],
  },
  savings: {
    subtitle: "How prepared you are for a surprise expense — and the path to your target.",
    fields: [
      { type: "heading", label: "Your Numbers" },
      {
        type: "grid",
        fields: [
          { key: "monthlyExpenses", label: "Monthly Essential Expenses ($)" },
          { key: "emergencyFund", label: "Emergency Fund Balance ($)" },
          { key: "monthlySavings", label: "Monthly Amount You Save ($)" },
        ],
      },
      {
        type: "select",
        key: "targetMonths",
        label: "How many months of expenses would you like set aside?",
        number: true,
        options: [["3", "3 months"], ["6", "6 months"], ["12", "12 months"]],
      },
      {
        type: "textarea",
        key: "goalsNotes",
        label: "Other savings goals (optional)",
        maxlength: 1000,
        placeholder: "e.g. House down payment, new car, sabbatical",
      },
    ],
  },
  debt: {
    subtitle: "Balances and rates help us prioritize the smartest payoff order. Leave a row blank if it doesn't apply.",
    fields: [
      { type: "heading", label: "Your Debts" },
      {
        type: "grid",
        fields: DEBT_TYPES.flatMap(([key, label]) => [
          { key: `debts.${key}.balance`, label: `${label} — Balance ($)` },
          { key: `debts.${key}.rate`, label: `${label} — Interest Rate (%)`, max: 100, step: 0.1 },
        ]),
      },
      { type: "heading", label: "Monthly Picture" },
      {
        type: "grid",
        fields: [
          { key: "monthlyDebtPayments", label: "Total Monthly Debt Payments ($)" },
          { key: "grossMonthlyIncome", label: "Gross Monthly Income ($)" },
        ],
      },
    ],
  },
  riskcapacity: {
    subtitle: "Capacity is your financial ability to take risk — separate from how risk feels.",
    fields: [
      {
        type: "radios",
        key: "answers",
        questions: [
          {
            legend: "When will you begin withdrawing meaningful amounts from this portfolio?",
            options: ["Within 2 years", "2–5 years", "5–10 years", "10–15 years", "15+ years"],
          },
          {
            legend: "How stable is your household income?",
            options: ["Very unstable", "Somewhat unstable", "Average", "Stable", "Very stable with pension or guaranteed income"],
          },
          {
            legend: "How many months of expenses do you keep in cash reserves?",
            options: ["Under 1", "1–3", "3–6", "6–12", "12+"],
          },
          {
            legend: "What share of your total net worth does this portfolio represent?",
            options: ["Over 75%", "50–75%", "25–50%", "10–25%", "Under 10%"],
          },
          {
            legend: "If markets fell sharply, how much flexibility do you have to delay your goals?",
            options: ["None", "A little", "Some", "Quite a bit", "Complete flexibility"],
          },
        ],
      },
    ],
  },
  behavior: {
    subtitle: "How you actually respond to markets matters as much as any projection.",
    fields: [
      {
        type: "radios",
        key: "answers",
        questions: [
          {
            legend: "In a sharp market drop like March 2020, what did you do (or would you do)?",
            options: ["Sold everything", "Sold some", "Held on", "Held and rebalanced", "Bought more"],
          },
          {
            legend: "What is the largest one-year loss you could tolerate without selling?",
            options: ["5%", "10%", "20%", "30%", "40% or more"],
          },
          {
            legend: "During volatile markets, how often do you check your portfolio?",
            options: ["Many times a day", "Daily", "Weekly", "Monthly", "Rarely"],
          },
          {
            legend: "When an investment loses money, you usually...",
            options: ["Sell quickly", "Worry and watch daily", "Wait it out", "Re-evaluate the thesis calmly", "Buy more if the thesis still holds"],
          },
        ],
      },
      { type: "textarea", key: "biggestConcern", label: "What worries you most about investing? (optional)", maxlength: 1000 },
    ],
  },
  knowledge: {
    subtitle: "Your background helps your advisor pitch advice at the right depth.",
    fields: [
      {
        type: "select",
        key: "yearsInvesting",
        label: "How long have you been investing?",
        options: [
          ["none", "I haven't invested before"],
          ["under3", "Under 3 years"],
          ["3to10", "3–10 years"],
          ["over10", "More than 10 years"],
        ],
      },
      { type: "checks", key: "instruments", label: "Which have you personally invested in?", note: "Select all that apply.", options: INSTRUMENT_OPTIONS },
      {
        type: "select",
        key: "selfRating",
        label: "How would you rate your investment knowledge?",
        number: true,
        options: [
          ["1", "1 — Just starting"],
          ["2", "2"],
          ["3", "3 — Comfortable with the basics"],
          ["4", "4"],
          ["5", "5 — Very knowledgeable"],
        ],
      },
      { type: "checkbox", key: "hadAdvisor", label: "I have worked with a financial advisor before" },
    ],
  },
  estatedocs: {
    subtitle: "Which core estate documents do you have in place today? Estimates on years are fine.",
    fields: [
      {
        type: "statusRows",
        key: "documents",
        rows: ESTATE_DOCS.map(([key, label]) => ({
          key,
          label,
          extra: { field: "year", placeholder: "Year updated", min: 1900, max: 2100, step: 1 },
        })),
      },
    ],
  },
  beneficiaries: {
    subtitle: "Beneficiary designations pass outside your will — worth confirming they're current.",
    fields: [
      {
        type: "select",
        key: "retirementAccounts",
        label: "Do all your retirement accounts have named beneficiaries?",
        options: [["all", "All of them"], ["some", "Some of them"], ["none", "None"], ["na", "Not applicable"]],
      },
      {
        type: "select",
        key: "lifePolicies",
        label: "Do all your life insurance policies have named beneficiaries?",
        options: [["all", "All of them"], ["some", "Some of them"], ["none", "None"], ["na", "Not applicable"]],
      },
      {
        type: "select",
        key: "todBrokerage",
        label: "Do your taxable brokerage accounts have transfer-on-death designations?",
        options: [["yes", "Yes"], ["no", "No"], ["na", "Not applicable"]],
      },
      {
        type: "select",
        key: "lastReviewed",
        label: "When did you last review your beneficiary designations?",
        options: [
          ["within1", "Within the last year"],
          ["1to3", "1–3 years ago"],
          ["over3", "More than 3 years ago"],
          ["never", "Never"],
        ],
      },
      {
        type: "checks",
        key: "lifeEvents",
        label: "Any of these life events since your last review?",
        note: "Select all that apply.",
        options: [
          ["marriage", "Marriage"],
          ["divorce", "Divorce"],
          ["birth", "Birth or adoption"],
          ["death", "Death in the family"],
          ["move", "Moved states"],
          ["none", "None of these"],
        ],
      },
    ],
  },
  legacy: {
    subtitle: "Gifting, charitable, and family goals that shape how your estate plan is built.",
    fields: [
      {
        type: "select",
        key: "charitableIntent",
        label: "Do you have charitable giving intentions?",
        options: [
          ["none", "No charitable plans"],
          ["annual", "Yes — giving during my lifetime"],
          ["bequest", "Yes — a gift in my estate"],
          ["both", "Both lifetime giving and a bequest"],
          ["unsure", "Not sure yet"],
        ],
      },
      {
        type: "select",
        key: "annualGifting",
        label: "Do you make (or plan to make) regular annual gifts?",
        options: [["none", "No"], ["family", "Yes — to family"], ["charity", "Yes — to charity"], ["both", "Yes — to family and charity"]],
      },
      {
        type: "checks",
        key: "specialCircumstances",
        label: "Do any of these apply to your family?",
        note: "Select all that apply.",
        options: [
          ["minorChildren", "Minor children"],
          ["specialNeeds", "A family member with special needs"],
          ["blendedFamily", "A blended family"],
          ["businessSuccession", "A business that needs a succession plan"],
          ["none", "None of these"],
        ],
      },
      { type: "textarea", key: "legacyNotes", label: "Anything else about the legacy you'd like to leave? (optional)", maxlength: 2000 },
    ],
  },
  lifeinsurance: {
    subtitle: "The DIME method — Debts, Income, Mortgage, Education — gives a quick estimate of the coverage your family would need.",
    fields: [
      { type: "heading", label: "DIME Inputs" },
      {
        type: "grid",
        fields: [
          { key: "debts", label: "Non-Mortgage Debts ($)" },
          { key: "annualIncome", label: "Annual Income to Replace ($)" },
          { key: "incomeYears", label: "Years of Income to Replace", max: 40 },
          { key: "mortgageBalance", label: "Mortgage Balance ($)" },
          { key: "educationCosts", label: "Future Education Costs ($)" },
          { key: "currentCoverage", label: "Current Life Insurance Coverage ($)" },
        ],
      },
    ],
  },
  coverage: {
    subtitle: "A quick inventory of your insurance lines — amounts are optional but helpful.",
    fields: [
      {
        type: "statusRows",
        key: "lines",
        rows: [
          { key: "termLife", label: "Life Insurance", extra: { field: "amount", placeholder: "Total death benefit ($)" } },
          { key: "disability", label: "Disability Insurance", extra: { field: "amount", placeholder: "Monthly benefit ($)" } },
          { key: "umbrella", label: "Umbrella Liability", extra: { field: "amount", placeholder: "Coverage limit ($)" } },
          { key: "longTermCare", label: "Long-Term Care", extra: { field: "amount", placeholder: "Daily or monthly benefit ($)" } },
          { key: "homeAuto", label: "Home & Auto", nullField: "amount" },
        ],
      },
    ],
  },
  ltc: {
    subtitle: "About 70% of people over 65 need some form of long-term care — a plan beats a surprise.",
    fields: [
      {
        type: "select",
        key: "ageBand",
        label: "Your age",
        options: [["under40", "Under 40"], ["40to49", "40–49"], ["50to59", "50–59"], ["60plus", "60+"]],
      },
      {
        type: "select",
        key: "familyHistory",
        label: "Any family history of needing long-term care?",
        options: [["yes", "Yes"], ["no", "No"], ["unsure", "Not sure"]],
      },
      {
        type: "select",
        key: "fundingPlan",
        label: "How would you fund long-term care if needed?",
        options: [
          ["insurance", "Long-term care insurance"],
          ["selfFund", "Self-fund from savings"],
          ["hybrid", "A hybrid life / LTC policy"],
          ["none", "No plan yet"],
        ],
      },
      {
        type: "select",
        key: "assetsEarmarked",
        label: "Have you earmarked specific assets for potential care costs?",
        options: [["yes", "Yes"], ["no", "No"]],
      },
    ],
  },
};

function buildModuleSection(mod, spec) {
  const catTitle = (CATEGORIES.find((c) => c.key === mod.category) || {}).title || "Category";
  const section = document.createElement("section");
  section.id = `view-${mod.key}`;
  section.className = "view hidden module-view";
  section.innerHTML = `
    <div class="card">
      <h1>${escapeHtml(mod.title)}</h1>
      <p class="subtitle">${escapeHtml(spec.subtitle)}</p>
      <form id="${mod.key}-form" class="form">
        ${spec.fields.map((f) => specFieldHtml(mod.key, f)).join("")}
        <p class="form-error" id="${mod.key}-error"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost module-back-btn">Back to ${escapeHtml(catTitle)}</button>
          <button type="submit" class="btn btn-primary">Save Assessment</button>
        </div>
      </form>
    </div>`;
  document.querySelector("main.container").appendChild(section);

  section.querySelector(".module-back-btn").addEventListener("click", () => showCategory(mod.category));

  section.querySelector(`#${mod.key}-form`).addEventListener("submit", async (e) => {
    e.preventDefault();
    const radios = spec.fields.find((f) => f.type === "radios");
    if (radios) {
      const answered = radios.questions.filter((q, i) =>
        document.querySelector(`input[name="${mod.key}-q${i + 1}"]:checked`)
      ).length;
      if (answered < radios.questions.length) {
        document.getElementById(`${mod.key}-error`).textContent = `Please answer all ${radios.questions.length} questions.`;
        return;
      }
    }
    await saveModule(mod.key, readSpecForm(mod.key, spec), `${mod.key}-error`);
  });
}

CATEGORY_MODULES.forEach((mod) => {
  const spec = MODULE_FORMS[mod.key];
  buildModuleSection(mod, spec);
  FORM_POPULATORS[mod.key] = (data) => populateSpecForm(mod.key, spec, data);
});

// ---------- Boot ----------

async function enterApp() {
  updateNav();
  await loadHome();
}

(function init() {
  updateNav();
  if (getSession()) {
    enterApp();
  } else {
    showView("auth");
  }
})();
