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
  // Recently-viewed holds client names. On a shared machine those must not
  // outlive the session, so they go with the token rather than lingering.
  localStorage.removeItem('blueline_recent_contacts');
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
  if (!res.ok) {
    // Carry the parsed body on the error: an endpoint may report partial work
    // alongside a failure, which is lost if callers only see the message.
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
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

// ---------- Task presentation (categories, priority, due urgency) ----------
// One definition for every admin page. These used to be copy-pasted per page —
// contacts.html and operations.html each carried their own PRIORITY_BADGE, and
// operations.html's category map silently never learned about the five
// categories added later (trading, investment-reports, …), so those rendered
// with an undefined class. Anything task-shaped renders through here now.
//
// Two independent visual channels, so a colour never means two things at once:
//   HUE (green/amber/red)  = time. Due dates only. See dueMeta/duePill.
//   LEADING RAIL           = priority. Red/amber/slate, never green.
//   NOMINAL HUE (violet/teal/slate/sky/navy) = category. Never the traffic light.

const TASK_CATEGORY_LABELS = {
  'follow-up': 'Follow-Up',
  meeting: 'Meeting',
  'investment-reports': 'Investment Reports',
  'operational-task': 'Operational Task',
  trading: 'Trading',
  'investment-policy-statement': 'Investment Policy Statement',
  'financial-planning': 'Financial Planning',
  // Legacy/automated categories: still written by onboarding and review flows,
  // so they must render even though the pickers no longer offer them.
  review: 'Review',
  onboarding: 'Onboarding',
  compliance: 'Compliance',
  other: 'Other',
};

// Categories the pickers offer, in display order. Legacy values above are
// deliberately excluded — they're recognised, not offered.
const TASK_CATEGORY_CHOICES = [
  'follow-up', 'meeting', 'investment-reports', 'operational-task',
  'trading', 'investment-policy-statement', 'financial-planning',
];

// Grouped by kind of work so related categories share a hue and the eye can
// group a long list. Repeats across 11 categories are fine: the text is the
// identifier, colour is only an aid to scanning.
const CATEGORY_BADGE = {
  'follow-up': 'badge-sky',        // client contact
  meeting: 'badge-sky',
  'investment-reports': 'badge-teal',   // reporting & planning deliverables
  'financial-planning': 'badge-teal',
  'investment-policy-statement': 'badge-teal',
  trading: 'badge-violet',         // portfolio actions
  'operational-task': 'badge-slate',    // internal operations
  review: 'badge-slate',
  compliance: 'badge-slate',
  onboarding: 'badge-navy',
  other: 'badge-gray',
};

// An advisor-typed custom category ("Client Gift Follow-up") has no entry in
// either map: show it verbatim and give it the neutral tag treatment.
function categoryLabel(cat) {
  if (!cat) return '';
  return TASK_CATEGORY_LABELS[cat] || String(cat);
}
function categoryBadgeClass(cat) {
  return CATEGORY_BADGE[cat] || 'badge-gray';
}
function categoryBadge(cat) {
  if (!cat) return '';
  const label = categoryLabel(cat);
  // title carries the full label so a name truncated by a narrow container
  // (the Home rail — see .rail-row .badge) is still readable on hover.
  return `<span class="badge ${categoryBadgeClass(cat)}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

// Sentinel option value for "type me a new category". Lives here so the
// contacts quick-add form and the operations drawer offer the same affordance.
const NEW_CATEGORY_VALUE = '__new_category__';
const promptNewCategoryName = () => (prompt('New category name:') || '').trim();

// <option> list for a category picker.
//   current — the task's existing category, or '' for an unset new-task picker.
// An unset picker leads with a disabled "-category-" placeholder so the field
// reads as unanswered rather than defaulting to Follow-Up behind the advisor's
// back. A custom or legacy value not among the offered choices is preserved as
// its own selected option, so merely opening the dropdown can't silently
// rewrite it.
function categoryOptions(current) {
  let opts = '';
  if (current && !TASK_CATEGORY_CHOICES.includes(current)) {
    opts += `<option value="${escapeHtml(current)}" selected>${escapeHtml(categoryLabel(current))}</option>`;
  } else if (!current) {
    opts += '<option value="" disabled selected>-category-</option>';
  }
  opts += TASK_CATEGORY_CHOICES
    .map((k) => `<option value="${escapeHtml(k)}"${k === current ? ' selected' : ''}>${escapeHtml(TASK_CATEGORY_LABELS[k])}</option>`)
    .join('');
  opts += `<option value="${NEW_CATEGORY_VALUE}">Create new category…</option>`;
  return opts;
}

// Priority picker options. Mirrors categoryOptions' placeholder behaviour.
const TASK_PRIORITY_CHOICES = ['low', 'medium', 'high'];
function priorityOptions(current) {
  return `<option value="" disabled${current ? '' : ' selected'}>-priority-</option>` +
    TASK_PRIORITY_CHOICES
      .map((p) => `<option value="${p}"${p === current ? ' selected' : ''}>${p.charAt(0).toUpperCase() + p.slice(1)} priority</option>`)
      .join('');
}

// Priority. The rail carries the colour; the text label stays neutral so the
// row has one coloured priority element, not two. Low is slate rather than
// green — green on work you still owe someone reads as "done".
const PRIORITY_RAIL = { high: 'prio-rail-high', medium: 'prio-rail-medium', low: 'prio-rail-low' };
function prioRailClass(priority) {
  return `prio-rail ${PRIORITY_RAIL[priority] || 'prio-rail-low'}`;
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Urgency for a task's due date. Superset of the old per-page dueInfo(): the
// {text, overdue, today, thisWeek} shape is preserved for existing callers,
// plus `state` (over|soon|ok|none) and ready-made class names.
//
// "soon" is today or tomorrow — the window where something is actionable now.
// A done task is never overdue; finished work shouldn't glow red forever.
function dueMeta(task) {
  const none = { text: '', state: 'none', overdue: false, today: false, thisWeek: false, pillClass: 'due-none', textClass: '' };
  if (!task || !task.due) return none;
  const d = new Date(task.due);
  if (isNaN(d)) return none;
  const now = new Date();
  const done = task.status === 'done';
  const today = isSameLocalDay(d, now);
  const overdue = !done && d < now && !today;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = isSameLocalDay(d, tomorrow);
  const thisWeek = d >= now && d - now < 7 * 86400e3;

  const hasTime = String(task.due).includes('T');
  const timeBit = hasTime ? ` ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  let label;
  if (today) label = `Due today${timeBit}`;
  else if (isTomorrow) label = `Due tomorrow${timeBit}`;
  else if (overdue) label = `Overdue · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  else label = `Due ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;

  const state = done ? 'ok' : overdue ? 'over' : (today || isTomorrow) ? 'soon' : 'ok';
  return {
    text: label,
    state,
    overdue,
    today,
    thisWeek,
    pillClass: `due-${state}`,
    textClass: state === 'ok' ? '' : `due-text-${state}`,
  };
}

// Full pill, for list rows. Always renders — a task with no due date shows a
// neutral "No due date" rather than vanishing, so a missing date is visible.
function duePill(task) {
  const d = dueMeta(task);
  if (!d.text) return '<span class="due due-none">No due date</span>';
  return `<span class="due ${d.pillClass}">${escapeHtml(d.text)}</span>`;
}

// Line-style icon set (2px stroke, no fill) matching the clean outline look
// of the CRM this sidebar is modeled on — the previous ⌂ ☰ ▦ etc. were
// Unicode glyphs, not icons, and render inconsistently across fonts/platforms.
// Paths are Feather Icons (MIT licensed) trimmed to the ones actually used.
const ICONS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  // Single person, for a contact row's avatar — deliberately paired with
  // `home` for a household row so the two read as the same kind of marker.
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'check-square': '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  'log-in': '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
};
function icon(name) {
  return `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

// `id` is the activePage key each page passes to initShell() — it is NOT the
// display label, so the two renames below (Dashboard -> Home, Operations ->
// Tasks) change only what the advisor reads. Ids and hrefs stay put so no page
// loses its active state and no existing bookmark breaks.
const NAV_ITEMS = [
  { id: 'dashboard', href: '/admin/', icon: 'home', label: 'Home' },
  { id: 'contacts', href: '/admin/contacts.html', icon: 'users', label: 'Contacts' },
  { id: 'operations', href: '/admin/operations.html', icon: 'check-square', label: 'Tasks' },
  { id: 'calendar', href: '/admin/calendar.html', icon: 'calendar', label: 'Calendar' },
  { id: 'onboarding', href: '/admin/onboarding.html', icon: 'log-in', label: 'Onboarding' },
  { id: 'learning', href: '/admin/learning.html', icon: 'book', label: 'Learning' },
  { id: 'settings', href: '/admin/settings.html', icon: 'settings', label: 'Settings' },
];

// ---------- Recently viewed contacts ----------
// The sidebar's "Recently Viewed" list. Stored per browser rather than per
// account on the server: it's a navigation convenience, not shared state.
// logoutLocal() clears it so it can't leak the client list on a shared machine.
const RECENT_KEY = 'blueline_recent_contacts';
const RECENT_MAX = 6;

function getRecentContacts() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((r) => r && r.email) : [];
  } catch {
    return []; // corrupt entry shouldn't break the shell
  }
}

function recordRecentContact(email, name) {
  if (!email) return;
  try {
    const list = getRecentContacts().filter((r) => r.email !== email);
    list.unshift({ email, name: name || email });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch { /* private mode / quota — the rail just stays empty */ }
}

// ---------- Activity feed presentation ----------
// The tile colour and glyph encode the KIND of event (task, meeting, note,
// client milestone). This is deliberately a separate vocabulary from the
// due-date traffic light, which means time — see the palette note in
// tokens.css. Nothing here reuses green/amber/red for urgency.
const ACTIVITY_KIND = {
  'task-added': { icon: '✓', cls: 'fi-task' },
  'task-completed': { icon: '✓', cls: 'fi-done' },
  'meeting-added': { icon: '▤', cls: 'fi-meeting' },
  'meeting-held': { icon: '▤', cls: 'fi-meeting' },
  'note-added': { icon: '✎', cls: 'fi-note' },
  'account-created': { icon: '☺', cls: 'fi-client' },
  'login': { icon: '→', cls: 'fi-client' },
  'assessment-completed': { icon: '◆', cls: 'fi-client' },
  'assessment-updated': { icon: '◆', cls: 'fi-client' },
  'onboarding-completed': { icon: '★', cls: 'fi-milestone' },
  'agreement-signed': { icon: '★', cls: 'fi-milestone' },
  'assignments-changed': { icon: '⚙', cls: 'fi-client' },
};
function activityKind(type) {
  return ACTIVITY_KIND[type] || { icon: '•', cls: 'fi-client' };
}

// Next annual recurrence of a stored important date, in days from today.
// importantDates hold a full date ("1975-04-12"); birthdays and anniversaries
// both recur yearly, so only month/day matter. Returns null for an unparseable
// entry rather than throwing — these are free-typed by the advisor.
function nextAnniversary(dateStr, from = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let next = new Date(today.getFullYear(), month, day);
  // Feb 29 in a common year rolls into Mar 1; accept that rather than skipping.
  if (next.getMonth() !== month) next = new Date(today.getFullYear(), month + 1, 0);
  if (next < today) {
    next = new Date(today.getFullYear() + 1, month, day);
    if (next.getMonth() !== month) next = new Date(today.getFullYear() + 1, month + 1, 0);
  }
  return { date: next, days: Math.round((next - today) / 86400000), year: Number(m[1]) };
}

// When an important date next falls, honouring whether it recurs. A recurring
// entry (birthday, anniversary) rolls forward to its next occurrence; a one-off
// (a closing date, a policy expiry) is upcoming only until the day itself and
// then stops surfacing for good, rather than returning every year forever.
// Entries saved before the flag existed have it undefined and were all treated
// as recurring, so that stays the default.
function upcomingImportantDate(entry, from = new Date()) {
  if (!entry || !entry.date) return null;
  const recurs = entry.repeatsAnnually === undefined ? true : !!entry.repeatsAnnually;
  if (recurs) return nextAnniversary(entry.date, from);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(entry.date).trim());
  if (!m) return null;
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const on = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(on.getTime()) || on < today) return null;
  return { date: on, days: Math.round((on - today) / 86400000), year: Number(m[1]) };
}

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

// Renders nothing at all until the advisor has actually opened a profile —
// an empty "Recently Viewed" heading is pure noise on a fresh install.
function recentSidebarHtml() {
  const recent = getRecentContacts();
  if (!recent.length) return '';
  return `
    <div class="sidebar-recent">
      <div class="sr-head">Recently Viewed</div>
      ${recent
        .map(
          (r) =>
            `<a href="/admin/contacts.html?c=${encodeURIComponent(r.email)}" title="${escapeHtml(r.email)}">${escapeHtml(r.name || r.email)}</a>`
        )
        .join('')}
    </div>`;
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
      <button type="button" id="shell-search-btn"><span class="nav-icon">${icon('search')}</span>Search<span class="kbd">Ctrl K</span></button>
    </div>
    <nav class="sidebar-nav">
      ${NAV_ITEMS.map((n) =>
        `<a href="${n.href}" class="${n.id === activePage ? 'active' : ''}"><span class="nav-icon">${icon(n.icon)}</span>${n.label}</a>`
      ).join('')}
    </nav>
    ${recentSidebarHtml()}
    <div class="sidebar-notif">
      <button type="button" id="shell-notif-btn"><span class="nav-icon">${icon('bell')}</span>Notifications<span class="notif-badge hidden" id="notif-badge"></span></button>
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
  // Archived contacts stay out of global search (find them via the Archived tab).
  (contacts.contacts || []).filter((c) => !c.archived).forEach((c) => entries.push({
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
