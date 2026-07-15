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
  { id: 'tasks', href: '/admin/tasks.html', icon: '✓', label: 'Tasks' },
  { id: 'onboarding', href: '/admin/onboarding.html', icon: '➔', label: 'Onboarding' },
  { id: 'settings', href: '/admin/settings.html', icon: '⚙', label: 'Settings' },
];

// Builds the sidebar into #sidebar-root and wires logout. Call once per page.
function initShell(activePage) {
  const root = document.getElementById('sidebar-root');
  if (!root || !SESSION) return;
  root.innerHTML = `
    <div class="sidebar-brand">
      <a href="/admin/"><img src="/assets/wealthadvisorstransparentwhite.png" alt="BlueLine Advisors" /></a>
    </div>
    <nav class="sidebar-nav">
      ${NAV_ITEMS.map((n) =>
        `<a href="${n.href}" class="${n.id === activePage ? 'active' : ''}"><span class="nav-icon">${n.icon}</span>${n.label}</a>`
      ).join('')}
    </nav>
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
}
