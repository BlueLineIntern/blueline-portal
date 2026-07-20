// BlueLine Advisor CRM — shared admin shell.
// Every page under /admin/ loads this first. It guards the session (bounce to
// /admin.html to log in), injects the sidebar shell, and exposes:
//   SESSION            {token, email} for the signed-in admin
//   api(path, opts)    fetch wrapper: auth header, JSON, 401 -> login redirect
//   escapeHtml, fmtDate, fmtDateTime, relTime, initShell(activePage)

const ADMIN_SESSION_KEY = 'blueline_admin_session';

const SESSION = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY) || 'null');
    if (saved && saved.token) return saved;
  } catch { /* fall through */ }
  return null;
})();

// No session -> straight to the login page. location.replace so Back doesn't
// bounce the user between the two pages.
if (!SESSION) {
  location.replace('/admin.html');
}

function logoutLocal() {
  localStorage.removeItem(ADMIN_SESSION_KEY);
  location.replace('/admin.html');
}

// Authenticated JSON fetch. Any 401 means the server session died (expired,
// revoked) — clear the stale local copy and return to login.
async function api(path, opts = {}) {
  const headers = { Authorization: `Bearer ${SESSION.token}`, ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    logoutLocal();
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString();
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString();
}

// "3m ago" / "2h ago" / "5d ago" / date — for activity feeds and last-contact.
function relTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

const NAV_ITEMS = [
  { id: 'dashboard', href: '/admin/', icon: '⌂', label: 'Dashboard' },
  { id: 'contacts', href: '/admin/contacts.html', icon: '☰', label: 'Contacts' },
  { id: 'operations', href: '/admin/operations.html', icon: '▦', label: 'Operations' },
  { id: 'onboarding', href: '/admin/onboarding.html', icon: '➔', label: 'Onboarding' },
  { id: 'settings', href: '/admin/settings.html', icon: '⚙', label: 'Settings' },
];

// Friendly display name for a staff/assignee email. Keeps board columns and
// task chips readable ("Frank" not "fsabin@…"). Falls back to a capitalized
// local-part so a new admin account still renders sensibly before it's mapped.
const STAFF_LABELS = {
  'fsabin@blueline-advisors.com': 'Frank',
  'jyoung@blueline-advisors.com': 'Jenn',
  'intern@blueline-advisors.com': 'Intern',
};
// Roster members (non-login teammates) resolve their id -> name here; pages call
// registerStaff() after loading /api/admin/team so labels work everywhere.
const DYNAMIC_STAFF_LABELS = {};
function registerStaff(members) {
  (members || []).forEach((m) => { if (m && m.id) DYNAMIC_STAFF_LABELS[m.id] = m.name; });
}
function staffLabel(id) {
  if (!id) return 'Unassigned';
  if (STAFF_LABELS[id]) return STAFF_LABELS[id];
  if (DYNAMIC_STAFF_LABELS[id]) return DYNAMIC_STAFF_LABELS[id];
  if (String(id).startsWith('m-')) return '(removed)'; // roster member since deleted
  const local = String(id).split('@')[0] || String(id);
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// Builds the sidebar into #sidebar-root and wires logout, the global search
// palette (Ctrl/Cmd-K), and the notification bell. Call once per page.
function initShell(activePage) {
  const root = document.getElementById('sidebar-root');
  if (!root || !SESSION) return;
  root.innerHTML = `
    <div class="sidebar-brand">
      <a href="/admin/"><img src="/assets/wealthadvisorstransparentwhite.png" alt="BlueLine Advisors" /></a>
    </div>
    <div class="sidebar-search">
      <button type="button" id="shell-search-btn">🔍 Search<span class="kbd">Ctrl K</span></button>
    </div>
    <nav class="sidebar-nav">
      ${NAV_ITEMS.map((n) =>
        `<a href="${n.href}" class="${n.id === activePage ? 'active' : ''}"><span class="nav-icon">${n.icon}</span>${n.label}</a>`
      ).join('')}
    </nav>
    <div class="sidebar-notif">
      <button type="button" id="shell-notif-btn"><span class="nav-icon">🔔</span>Notifications<span class="notif-badge hidden" id="notif-badge"></span></button>
    </div>
    <div class="sidebar-foot">
      <div class="who">${escapeHtml(SESSION.email || '')}</div>
      <button type="button" id="shell-logout-btn">Log out</button>
    </div>`;
  document.getElementById('shell-logout-btn').addEventListener('click', async () => {
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SESSION.token}` },
      });
    } catch { /* network errors don't block local logout */ }
    logoutLocal();
  });
  document.getElementById('shell-search-btn').addEventListener('click', openPalette);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
    }
    if (e.key === 'Escape') {
      closePalette();
      closeNotifPanel();
    }
  });
  document.getElementById('shell-notif-btn').addEventListener('click', toggleNotifPanel);
  refreshNotifications(); // badge appears once loaded; fire-and-forget
}

// ---------- Notifications (derived: overdue tasks + activity since last seen) ----------

const TL_LABELS = {
  'account-created': 'created their portal account',
  'login': 'signed in to the portal',
  'assessment-completed': 'completed an assessment',
  'assessment-updated': 'updated an assessment',
  'onboarding-completed': 'completed the onboarding workflow',
  'agreement-signed': 'signed the advisory agreement',
  'assignments-changed': 'had module assignments changed',
  'task-completed': 'task completed',
  'meeting-held': 'meeting held',
  'note-added': 'note added',
};

let notifState = { overdue: [], fresh: [], seen: null, loaded: false };

async function refreshNotifications() {
  try {
    const [taskData, actData, seenData] = await Promise.all([
      api('/api/admin/tasks'),
      api('/api/admin/activity'),
      api('/api/admin/notifseen'),
    ]);
    const now = new Date();
    notifState.seen = seenData.seen;
    notifState.overdue = (taskData.tasks || []).filter((t) => {
      if (t.status !== 'open' || !t.due) return false;
      const d = new Date(t.due);
      return !isNaN(d) && d < now;
    });
    notifState.fresh = (actData.entries || []).filter(
      (e) => !notifState.seen || String(e.ts) > String(notifState.seen)
    );
    notifState.loaded = true;
    updateNotifBadge();
  } catch { /* badge just stays hidden if this fails */ }
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const count = notifState.overdue.length + notifState.fresh.length;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('hidden', count === 0);
}

function closeNotifPanel() {
  const p = document.getElementById('notif-panel');
  if (p) p.remove();
}

function toggleNotifPanel() {
  if (document.getElementById('notif-panel')) { closeNotifPanel(); return; }
  const panel = document.createElement('div');
  panel.className = 'notif-panel';
  panel.id = 'notif-panel';
  const overdueRows = notifState.overdue.map((t) => `
    <div class="notif-item"><span class="n-dot" style="background:var(--red)"></span>
      <div><strong>Overdue:</strong> ${escapeHtml(t.title)}
        <div class="n-when">due ${escapeHtml(fmtDateTime(t.due))}${t.client ? ` · ${escapeHtml(t.client)}` : ''}</div>
      </div></div>`).join('');
  const freshRows = notifState.fresh.map((e) => `
    <div class="notif-item"><span class="n-dot" style="background:var(--sky)"></span>
      <div>${escapeHtml(e.client)} ${escapeHtml(TL_LABELS[e.type] || e.type)}${e.detail && e.detail.module ? ` (${escapeHtml(e.detail.module)})` : ''}
        <div class="n-when">${escapeHtml(relTime(e.ts))}</div>
      </div></div>`).join('');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px;">
      <h3>Notifications</h3>
      <button type="button" class="btn btn-ghost btn-small" id="notif-mark-read">Mark all read</button>
    </div>
    ${overdueRows || ''}
    ${freshRows || ''}
    ${!overdueRows && !freshRows ? '<p class="palette-empty">All caught up. Nothing needs you right now.</p>' : ''}`;
  document.body.appendChild(panel);
  document.getElementById('notif-mark-read').addEventListener('click', async () => {
    try {
      const data = await api('/api/admin/notifseen', { method: 'POST' });
      notifState.seen = data.seen;
      notifState.fresh = [];
      updateNotifBadge();
      closeNotifPanel();
    } catch { /* leave the panel open on failure */ }
  });
}

// ---------- Global search palette (Ctrl/Cmd-K) ----------

let paletteData = null; // lazy-loaded on first open, then cached for the page

async function loadPaletteData() {
  if (paletteData) return paletteData;
  const [contacts, tasks, notes, onboardings] = await Promise.all([
    api('/api/admin/contacts').catch(() => ({ contacts: [] })),
    api('/api/admin/tasks').catch(() => ({ tasks: [] })),
    api('/api/admin/notes').catch(() => ({ notes: [] })),
    api('/api/admin/onboarding').catch(() => ({ records: [] })),
  ]);
  const entries = [];
  (contacts.contacts || []).forEach((c) => entries.push({
    group: 'Contacts',
    title: c.name || c.email,
    sub: [c.email, c.household, (c.tags || []).join(', ')].filter(Boolean).join(' · '),
    text: `${c.name} ${c.email} ${c.household} ${(c.tags || []).join(' ')}`.toLowerCase(),
    href: `/admin/contacts.html?c=${encodeURIComponent(c.email)}`,
  }));
  (tasks.tasks || []).forEach((t) => entries.push({
    group: 'Tasks',
    title: t.title,
    sub: [t.status === 'done' ? 'completed' : 'open', t.client, t.due ? fmtDate(t.due) : ''].filter(Boolean).join(' · '),
    text: `${t.title} ${t.description} ${t.client}`.toLowerCase(),
    href: `/admin/tasks.html?q=${encodeURIComponent(t.title)}&f=${t.status === 'done' ? 'done' : 'open'}`,
  }));
  (notes.notes || []).forEach((n) => entries.push({
    group: 'Notes',
    title: n.body.length > 70 ? `${n.body.slice(0, 70)}…` : n.body,
    sub: [n.client, (n.tags || []).join(', ')].filter(Boolean).join(' · '),
    text: `${n.body} ${n.client} ${(n.tags || []).join(' ')}`.toLowerCase(),
    href: `/admin/contacts.html?c=${encodeURIComponent(n.client)}&tab=notes`,
  }));
  (onboardings.records || []).filter((r) => !r.deleted).forEach((r) => {
    const p = (r.data && r.data.profile) || {};
    const c = (r.data && r.data.consent) || {};
    const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || c.name || '';
    entries.push({
      group: 'Onboarding',
      title: `${r.onboardingId}${name ? ` — ${name}` : ''}`,
      sub: r.completionTime ? 'completed' : 'in progress',
      text: `${r.onboardingId} ${name} ${p.email || ''} ${c.email || ''}`.toLowerCase(),
      href: `/admin/onboarding.html?id=${encodeURIComponent(r.onboardingId)}`,
    });
  });
  paletteData = entries;
  return entries;
}

function closePalette() {
  const p = document.getElementById('palette-backdrop');
  if (p) p.remove();
}

function openPalette() {
  if (document.getElementById('palette-backdrop')) return;
  closeNotifPanel();
  const backdrop = document.createElement('div');
  backdrop.className = 'palette-backdrop';
  backdrop.id = 'palette-backdrop';
  backdrop.innerHTML = `
    <div class="palette">
      <input type="text" id="palette-input" placeholder="Search contacts, tasks, notes, onboarding…" autocomplete="off" />
      <div class="palette-results" id="palette-results"><p class="palette-empty">Type to search everything.</p></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closePalette(); });
  const input = document.getElementById('palette-input');
  input.focus();
  let selIndex = 0;

  async function renderResults() {
    const q = input.value.trim().toLowerCase();
    const box = document.getElementById('palette-results');
    if (!box) return;
    if (!q) { box.innerHTML = '<p class="palette-empty">Type to search everything.</p>'; return; }
    const data = await loadPaletteData();
    const hits = data
      .map((e) => ({ e, rank: e.text.startsWith(q) ? 0 : e.text.includes(q) ? 1 : -1 }))
      .filter((h) => h.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 12)
      .map((h) => h.e);
    if (!hits.length) { box.innerHTML = '<p class="palette-empty">No matches.</p>'; return; }
    selIndex = Math.min(selIndex, hits.length - 1);
    let lastGroup = '';
    box.innerHTML = hits.map((h, i) => {
      const header = h.group !== lastGroup ? `<div class="palette-group">${h.group}</div>` : '';
      lastGroup = h.group;
      return `${header}<a class="palette-result ${i === selIndex ? 'sel' : ''}" data-i="${i}" href="${h.href}">
        <div class="pr-title">${escapeHtml(h.title)}</div>
        ${h.sub ? `<div class="pr-sub">${escapeHtml(h.sub)}</div>` : ''}
      </a>`;
    }).join('');
    box.querySelectorAll('.palette-result').forEach((a) =>
      a.addEventListener('mouseenter', () => {
        selIndex = Number(a.dataset.i);
        box.querySelectorAll('.palette-result').forEach((x) => x.classList.toggle('sel', x === a));
      })
    );
  }

  input.addEventListener('input', () => { selIndex = 0; renderResults(); });
  input.addEventListener('keydown', (e) => {
    const results = [...document.querySelectorAll('.palette-result')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      selIndex = (selIndex + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      results.forEach((x, i) => x.classList.toggle('sel', i === selIndex));
      results[selIndex].scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && results[selIndex]) {
      location.assign(results[selIndex].href);
    }
  });
  // Kick off the data load in the background so first keystrokes feel instant.
  loadPaletteData();
}
