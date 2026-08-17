// This repo has no package.json/build pipeline (see STATUS.md), so this MUST
// stay a relative-path import of a file already committed to the repo, never a
// bare specifier like `import ... from 'pdf-lib'` — a bare specifier needs npm
// dependency resolution at build time, which nothing here provides. The
// vendored file has zero imports of its own (`vendor/pdf-lib.esm.min.js`, a
// real ESM build with all its dependencies already inlined), so this needs no
// node_modules to resolve — just esbuild walking a relative path on disk,
// which Cloudflare's bundler does regardless of package.json.
import { buildSignedAgreementServer, resolveClientNameServer } from './agreement-pdf-worker.js';

/**
 * BlueLine Advisors Client Onboarding Portal — Cloudflare Worker API
 *
 * Assessments cover the five Financial Picture Analysis modules (risk, budget,
 * retirement, networth, compensation) plus twelve category modules across
 * budgeting/spending, risk assessment, estate planning, and insurance planning.
 *
 * Requires a KV namespace binding called PORTAL_KV (see wrangler.toml).
 * KV layout:
 *   user:<email>               -> { name, email, salt, hash, iterations }
 *   session:<token>            -> email                    (TTL'd)
 *   responses:<email>          -> AES-256-GCM envelope of { modules: {...} }
 *                                 (see DATA_ENCRYPTION_KEY; legacy plaintext still read)
 *   onboarding:<id>            -> onboarding POC record (sample/test data only)
 *   onboarding_secret:<id>     -> per-session write token  (TTL'd, never returned)
 *   client_invite:<sha256>      -> invited client email (7-day TTL, one use)
 *   rl:<scope>:<ip>            -> { count, windowStart }    (TTL'd, rate limiting)
 *
 * Endpoints:
 *   POST   /api/register                    { name, email, password, invite }
 *   POST   /api/login                       { email, password }
 *   POST   /api/logout                      (Authorization: Bearer <token>)
 *   GET    /api/assessments                 (Authorization: Bearer <token>)
 *   POST   /api/assessments/:module         (Authorization: Bearer <token>)
 *   POST   /api/onboarding/start            (Authorization: Bearer <client session>)
 *   POST   /api/onboarding/:id              (client session + X-Onboarding-Token)
 *   POST   /api/admin/login                 { email, password } -> { token, email }
 *   POST   /api/admin/logout                (Authorization: Bearer <admin session>)
 *   GET    /api/admin/clients               (Authorization: Bearer <admin session>)
 *   GET    /api/admin/onboarding            (Authorization: Bearer <admin session>)
 *   DELETE /api/admin/onboarding/:id        (Authorization: Bearer <admin session>) — soft delete
 *   POST   /api/admin/onboarding/:id/restore (Authorization: Bearer <admin session>)
 *
 * Admins each sign in with their own password (see ADMIN_ACCOUNTS); set them
 * with: wrangler secret put ADMIN_PASSWORD_FSABIN (and ..._JYOUNG)
 * Encrypt client responses at rest with: wrangler secret put DATA_ENCRYPTION_KEY
 *   (a long random string; if lost/changed, encrypted data is unrecoverable)
 * Optionally restrict browser origins with: wrangler secret put ALLOWED_ORIGIN
 *   (comma-separated list; defaults to the Worker's own origin only)
 * Microsoft Graph (SharePoint sync + Outlook calendar push) uses one app
 *   registration: OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET / OUTLOOK_TENANT_ID.
 *   Pushing meetings to staff Outlook calendars (any number of them per meeting)
 *   additionally needs the Calendars.ReadWrite.All APPLICATION permission with
 *   admin consent granted.
 *   Override the assumed timezone with: wrangler secret put OUTLOOK_TIMEZONE
 *   (a Windows zone name, e.g. "Central Standard Time"; default Eastern)
 *
 * NOTE: This remains a proof-of-concept-grade system. Admin access now uses
 * per-email login + sessions and writes an audit log, but there is still no
 * application-level encryption of client PII, and the onboarding flow is
 * unauthenticated beyond a per-session write token. See STATUS.md "Known gaps".
 */

import { COMPLIANCE_SEED } from './compliance-seed.js';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const PBKDF2_ITERATIONS = 100000;
const ONBOARDING_TTL_SECONDS = 60 * 60 * 24 * 30; // secrets + soft-deleted records expire after 30 days
const CLIENT_INVITE_TTL_SECONDS = 60 * 60 * 24 * 7;

// Admin staff each sign in with their own password. The password for each email
// lives in its own Cloudflare secret (the `secret` field below); set them with:
//   wrangler secret put ADMIN_PASSWORD_FSABIN
//   wrangler secret put ADMIN_PASSWORD_JYOUNG
// During the transition from the old shared password, login also accepts the
// legacy ADMIN_PASSWORD secret if an individual one isn't set — delete
// ADMIN_PASSWORD in Cloudflare once both individual secrets exist so passwords
// are truly per-person. Sessions are shorter-lived than client sessions.
const ADMIN_ACCOUNTS = [
  { email: 'fsabin@blueline-advisors.com', secret: 'ADMIN_PASSWORD_FSABIN' },
  { email: 'jyoung@blueline-advisors.com', secret: 'ADMIN_PASSWORD_JYOUNG' },
  { email: 'intern@blueline-advisors.com', secret: 'ADMIN_PASSWORD_INTERN' },
];
const FRANK_ADMIN_EMAIL = 'fsabin@blueline-advisors.com';
const JENN_ADMIN_EMAIL = 'jyoung@blueline-advisors.com';
const INTERN_ADMIN_EMAIL = 'intern@blueline-advisors.com';
const ERIC_ADMIN_EMAIL = 'esullivan@blueline-advisors.com';
const ALL_ADMIN_WORKSPACES = '__all__';
const DISABLED_ADMIN_PREFIX = 'admin_disabled:';
const isSuperAdmin = (email) => String(email || '').trim().toLowerCase() === FRANK_ADMIN_EMAIL;
const DEFAULT_FRANK_WORKSPACE_MEMBERS = [
  JENN_ADMIN_EMAIL,
  INTERN_ADMIN_EMAIL,
  ERIC_ADMIN_EMAIL,
];
const LEGACY_ADMIN_NAMES = {
  'fsabin@blueline-advisors.com': 'Frank',
  'jyoung@blueline-advisors.com': 'Jenn',
  'intern@blueline-advisors.com': 'Intern',
  'esullivan@blueline-advisors.com': 'Eric S',
};
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const ADMIN_PASSWORD_MIN_LENGTH = 10; // a step above the client minimum (8) — elevated privilege

// ---------- Admin accounts added through the app ----------
// The ADMIN_ACCOUNTS list above is the original, hardcoded roster: each entry's
// password lives in its own Cloudflare secret, so adding one always needs a
// code change + redeploy. Admins added later live in KV instead — salted
// PBKDF2 hash, same mechanism client accounts already use (admin_account:<email>)
// — so a signed-in admin can add a new one from Settings with no code, no
// secrets, no deploy. MFA is unaffected either way: it's still mandatory,
// looked up by email, independent of where the password itself lives.

async function verifyAdminPassword(env, normalizedEmail, password) {
  if (await env.PORTAL_KV.get(`${DISABLED_ADMIN_PREFIX}${normalizedEmail}`)) return false;
  const stored = await env.PORTAL_KV.get(`admin_account:${normalizedEmail}`);
  if (stored) {
    const account = JSON.parse(stored);
    const attemptedHash = await hashPassword(password, account.salt, account.iterations);
    return timingSafeEqual(attemptedHash, account.hash);
  }
  const legacy = ADMIN_ACCOUNTS.find((a) => a.email === normalizedEmail);
  if (legacy) {
    // Trim both sides so a stray trailing newline in a secret (a very common
    // result of how secrets get pasted/piped in) doesn't cause a silent
    // length mismatch. Falls back to the old shared ADMIN_PASSWORD secret
    // while individual ones are still being rolled out.
    const expected = ((env[legacy.secret] || env.ADMIN_PASSWORD) || '').trim();
    return !!expected && timingSafeEqual(String(password).trim(), expected);
  }
  return false;
}

// Legacy roster + everyone added through the app, deduplicated. This is the
// single source of truth for "who is an admin" everywhere else in the file.
async function allAdminEmails(env) {
  const legacy = ADMIN_ACCOUNTS.map((a) => a.email);
  const added = (await listKeys(env, 'admin_account:')).map((k) => k.slice('admin_account:'.length));
  const disabled = new Set((await listKeys(env, DISABLED_ADMIN_PREFIX)).map((k) => k.slice(DISABLED_ADMIN_PREFIX.length)));
  return [...new Set([...legacy, ...added])].filter((email) => !disabled.has(email));
}

async function allAdminWorkspaceOwners(env) {
  const active = await allAdminEmails(env);
  const former = (await listKeys(env, DISABLED_ADMIN_PREFIX)).map((k) => k.slice(DISABLED_ADMIN_PREFIX.length));
  return [...new Set([...active, ...former])];
}

async function isAdminAccount(env, email) {
  return (await allAdminEmails(env)).includes(email);
}

// Create a new KV-backed admin. Rejects an email already in use by either the
// legacy roster or another KV admin, so the two lists never collide.
async function handleAdminCreateAdmin(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can add admin accounts' }, 403, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const email = String(body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Enter a valid email address' }, 400, cors);
  const name = String(body.name || '').trim().slice(0, 200);
  if (!name) return json({ error: "Enter the admin's name" }, 400, cors);
  const password = String(body.password || '');
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    return json({ error: `Password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters` }, 400, cors);
  }
  if (await isAdminAccount(env, email)) {
    return json({ error: 'An admin with this email already exists' }, 409, cors);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
  await env.PORTAL_KV.put(
    `admin_account:${email}`,
    JSON.stringify({ email, name, salt, hash, iterations: PBKDF2_ITERATIONS, createdAt: new Date().toISOString(), createdBy: adminEmail })
  );
  await env.PORTAL_KV.delete(`${DISABLED_ADMIN_PREFIX}${email}`);
  await logAudit(env, adminEmail, 'create-admin', { email, name });
  // No MFA record yet — same as any admin's first login, they'll be walked
  // through enrollment (handleAdminMfaEnroll) the first time they sign in.
  return json({ email, name }, 201, cors);
}

// {email: name} for KV-added admins only — the legacy roster's names are a
// hardcoded client-side lookup (STAFF_LABELS) and don't need duplicating here.
async function addedAdminNames(env) {
  const names = {};
  for (const keyName of await listKeys(env, 'admin_account:')) {
    const raw = await env.PORTAL_KV.get(keyName);
    if (!raw) continue;
    try {
      const account = JSON.parse(raw);
      if (account.name) names[account.email] = account.name;
    } catch { /* skip a corrupt record rather than fail the whole list */ }
  }
  return names;
}

// Display-name overrides are kept separate from credentials so renaming an
// admin can never disturb their password hash (or a legacy account's Worker
// secret). This also lets the original hardcoded accounts be renamed in the UI.
async function effectiveAdminNames(env) {
  const names = { ...LEGACY_ADMIN_NAMES, ...(await addedAdminNames(env)) };
  for (const keyName of await listKeys(env, 'admin_name:')) {
    const email = keyName.slice('admin_name:'.length);
    const name = String((await env.PORTAL_KV.get(keyName)) || '').trim();
    if (name) names[email] = name;
  }
  return names;
}

async function handleAdminRenameAdmin(request, env, cors, targetEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can rename admin accounts' }, 403, cors);
  const email = String(targetEmail || '').trim().toLowerCase();
  if (!(await isAdminAccount(env, email))) return json({ error: 'Not an admin account' }, 404, cors);
  const body = await request.json().catch(() => null);
  const name = String((body && body.name) || '').trim().slice(0, 200);
  if (!name) return json({ error: "Enter the admin's name" }, 400, cors);
  await env.PORTAL_KV.put(`admin_name:${email}`, name);
  await logAudit(env, adminEmail, 'rename-admin', { target: email, name });
  return json({ email, name }, 200, cors);
}

async function handleAdminDeleteAdmin(request, env, cors, targetEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  if (!isSuperAdmin(adminEmail)) return json({ error: 'Only Frank can remove admin accounts' }, 403, cors);
  const email = String(targetEmail || '').trim().toLowerCase();
  if (email === FRANK_ADMIN_EMAIL) return json({ error: 'The super-admin account cannot be removed' }, 400, cors);
  if (!(await isAdminAccount(env, email))) return json({ error: 'Not an admin account' }, 404, cors);

  const names = await effectiveAdminNames(env);
  await env.PORTAL_KV.put(`${DISABLED_ADMIN_PREFIX}${email}`, JSON.stringify({
    email,
    name: names[email] || email.split('@')[0],
    removedAt: new Date().toISOString(),
    removedBy: adminEmail,
  }));
  await env.PORTAL_KV.put(`admin_name:${email}`, names[email] || email.split('@')[0]);
  await env.PORTAL_KV.delete(`admin_account:${email}`);
  await env.PORTAL_KV.delete(`admin_mfa:${email}`);

  for (const keyName of await listKeys(env, 'admin_session:')) {
    if ((await env.PORTAL_KV.get(keyName)) === email) await env.PORTAL_KV.delete(keyName);
  }
  for (const keyName of await listKeys(env, 'admin_pending:')) {
    const raw = await env.PORTAL_KV.get(keyName);
    try {
      if (raw && JSON.parse(raw).email === email) await env.PORTAL_KV.delete(keyName);
    } catch { /* ignore a corrupt expired pending record */ }
  }
  for (const keyName of await listKeys(env, WORKSPACE_ACCESS_PREFIX)) {
    const raw = await env.PORTAL_KV.get(keyName);
    try {
      const access = JSON.parse(raw || '{}');
      const members = Array.isArray(access.members) ? access.members.filter((member) => member !== email) : [];
      await env.PORTAL_KV.put(keyName, JSON.stringify({ ...access, members }));
    } catch { /* leave a corrupt access record untouched */ }
  }
  await logAudit(env, adminEmail, 'remove-admin', { target: email });
  return json({ ok: true, email }, 200, cors);
}

// ---------- Admin workspaces ----------
// Every admin has a private data workspace and shared firm view managers can oversee them.
// For employees the choice is exclusive: someone assigned to Frank works only
// in Frank's workspace; everyone else works only in their own workspace.
// Records written before workspaces existed belong to Frank, preserving the
// current firm's data while preventing it from appearing in new employees'
// private displays.
const WORKSPACE_ACCESS_PREFIX = 'admin_workspace_access:';
const workspaceAccessKey = (owner) => `${WORKSPACE_ACCESS_PREFIX}${owner}`;
const recordWorkspace = (record) => String((record && record.workspace) || FRANK_ADMIN_EMAIL).trim().toLowerCase();

async function workspaceMembers(env, owner) {
  const raw = await env.PORTAL_KV.get(workspaceAccessKey(owner));
  if (!raw) return owner === FRANK_ADMIN_EMAIL ? [...DEFAULT_FRANK_WORKSPACE_MEMBERS] : [];
  try {
    const parsed = JSON.parse(raw);
    const members = Array.isArray(parsed.members)
      ? [...new Set(parsed.members.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))]
      : [];
    // The original managers and Eric are permanent members of the shared firm view.
    if (owner === FRANK_ADMIN_EMAIL) {
      for (const manager of [JENN_ADMIN_EMAIL, INTERN_ADMIN_EMAIL, ERIC_ADMIN_EMAIL]) {
        if (!members.includes(manager)) members.push(manager);
      }
    }
    return members;
  } catch {
    return [];
  }
}

async function canManageSharedFirmView(env, email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!(await isAdminAccount(env, normalized))) return false;
  return normalized === FRANK_ADMIN_EMAIL || (await workspaceMembers(env, FRANK_ADMIN_EMAIL)).includes(normalized);
}

async function accessibleWorkspaceOwners(env, adminEmail) {
  const admins = await allAdminWorkspaceOwners(env);
  const activeAdmins = new Set(await allAdminEmails(env));
  const frankMembers = await workspaceMembers(env, FRANK_ADMIN_EMAIL);
  // An employee assigned to Frank shares Frank's workspace and does not have a
  // separate selectable display. Their dormant personal data is preserved, but
  // the display becomes visible again only when Frank returns them to personal.
  if (await canManageSharedFirmView(env, adminEmail)) {
    return admins.filter((owner) => owner === FRANK_ADMIN_EMAIL || !activeAdmins.has(owner) || !frankMembers.includes(owner));
  }
  return frankMembers.includes(adminEmail)
    ? [FRANK_ADMIN_EMAIL]
    : [adminEmail];
}

async function requestedAdminWorkspace(request, env, adminEmail) {
  const allowed = await accessibleWorkspaceOwners(env, adminEmail);
  const requested = String(request.headers.get('X-Admin-Workspace') || allowed[0]).trim().toLowerCase();
  const path = new URL(request.url).pathname;
  const combinedList = request.method === 'GET'
    && ['/api/admin/workspaces', '/api/admin/contacts', '/api/admin/households', '/api/admin/tasks'].includes(path);
  if (requested === ALL_ADMIN_WORKSPACES && await canManageSharedFirmView(env, adminEmail) && combinedList) return ALL_ADMIN_WORKSPACES;
  return allowed.includes(requested) ? requested : null;
}

async function handleAdminWorkspaces(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const names = await effectiveAdminNames(env);
  const admins = await allAdminEmails(env);
  const allowed = await accessibleWorkspaceOwners(env, adminEmail);
  const requested = await requestedAdminWorkspace(request, env, adminEmail);
  const sharedViewManager = await canManageSharedFirmView(env, adminEmail);
  const sharedManagers = new Set([FRANK_ADMIN_EMAIL, ...(await workspaceMembers(env, FRANK_ADMIN_EMAIL))]);
  const workspaces = allowed.map((owner) => ({
    owner,
    name: names[owner] || owner.split('@')[0],
    own: owner === adminEmail,
    members: sharedViewManager ? [] : undefined,
  }));
  const grants = {};
  if (sharedViewManager) {
    for (const owner of admins) grants[owner] = await workspaceMembers(env, owner);
  }
  return json({
    you: adminEmail,
    boss: sharedViewManager,
    superAdmin: isSuperAdmin(adminEmail),
    canManageSharedView: sharedViewManager,
    sharedOwner: FRANK_ADMIN_EMAIL,
    active: requested || allowed[0],
    workspaces,
    admins: admins.map((email) => ({
      email,
      name: names[email] || email.split('@')[0],
      supervisor: sharedManagers.has(email),
      permanentSharedView: [FRANK_ADMIN_EMAIL, JENN_ADMIN_EMAIL, INTERN_ADMIN_EMAIL, ERIC_ADMIN_EMAIL].includes(email),
    })),
    grants,
  }, 200, cors);
}

async function handleAdminSaveWorkspaceAccess(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can manage display access' }, 403, cors);
  const body = await request.json().catch(() => null);
  if (!body || !isValidEmail(body.owner) || !Array.isArray(body.members)) {
    return json({ error: 'owner and members are required' }, 400, cors);
  }
  const owner = String(body.owner).trim().toLowerCase();
  if (owner !== FRANK_ADMIN_EMAIL) return json({ error: "Employees can only be assigned to Frank's display" }, 400, cors);
  const admins = new Set(await allAdminEmails(env));
  const members = [...new Set([JENN_ADMIN_EMAIL, INTERN_ADMIN_EMAIL, ERIC_ADMIN_EMAIL, ...body.members.map((e) => String(e || '').trim().toLowerCase())])]
    .filter((e) => e && e !== owner && admins.has(e));
  await env.PORTAL_KV.put(workspaceAccessKey(owner), JSON.stringify({ members, updatedAt: new Date().toISOString(), updatedBy: adminEmail }));
  await logAudit(env, adminEmail, 'workspace-access-changed', { owner, members });
  return json({ owner, members }, 200, cors);
}
const AUDIT_TTL_SECONDS = 60 * 60 * 24 * 400; // audit entries retained ~13 months

// Fixed-window rate limits: [max requests, window in seconds].
const RATE_LIMITS = {
  login: [10, 300], // 10 attempts / 5 min per IP
  register: [5, 3600], // 5 new accounts / hour per IP
  onboardingStart: [20, 3600], // 20 new onboardings / hour per IP
  adminlogin: [10, 300], // 10 admin login attempts / 5 min per IP
};

// ---------- CORS ----------
// Frontend and API are same-origin, so real browser traffic never needs
// permissive CORS. We only ever echo an origin we explicitly allow (the
// Worker's own origin, plus anything in ALLOWED_ORIGIN). No credentials mode:
// auth uses bearer tokens, not cookies.

function resolveCorsOrigin(request, url, env) {
  const reqOrigin = request.headers.get('Origin');
  if (!reqOrigin) return null; // same-origin or non-browser client
  const allowed = new Set([url.origin]);
  if (env.ALLOWED_ORIGIN) {
    for (const o of env.ALLOWED_ORIGIN.split(',')) {
      const trimmed = o.trim();
      if (trimmed) allowed.add(trimmed);
    }
  }
  return allowed.has(reqOrigin) ? reqOrigin : null;
}

function corsHeaders(corsOrigin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Admin-Workspace, X-Onboarding-Token, X-Upload-Ticket, X-Upload-Offset',
    Vary: 'Origin',
  };
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
  return headers;
}

function json(data, status, corsOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
  });
}

// ---------- Rate limiting ----------
// KV-backed fixed window. KV is eventually consistent, so this is a brute-force
// speed bump, not a hard concurrency guarantee — bursts racing the same window
// may slightly under-count. Good enough to blunt credential stuffing; a real
// deployment should layer Cloudflare's native rate-limiting rules on top.

async function checkRateLimit(env, scope, ip) {
  const [limit, windowSec] = RATE_LIMITS[scope];
  const key = `rl:${scope}:${ip}`;
  const now = Date.now();
  let rec = null;
  try {
    const raw = await env.PORTAL_KV.get(key);
    if (raw) rec = JSON.parse(raw);
  } catch {}

  if (!rec || now - rec.windowStart >= windowSec * 1000) {
    rec = { count: 1, windowStart: now };
    await env.PORTAL_KV.put(key, JSON.stringify(rec), { expirationTtl: windowSec });
    return true;
  }
  if (rec.count >= limit) return false;
  rec.count += 1;
  // Keep the original window's remaining TTL rather than resetting it.
  const remaining = Math.max(1, windowSec - Math.floor((now - rec.windowStart) / 1000));
  await env.PORTAL_KV.put(key, JSON.stringify(rec), { expirationTtl: remaining });
  return true;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// ---------- Crypto helpers ----------

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

async function hashPassword(password, saltHex, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBuf(saltHex), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bufToHex(derived);
}

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bufToHex(bytes.buffer);
}

// Constant-time string comparison to avoid leaking token/hash length or
// prefix through response timing.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function getSessionEmail(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return env.PORTAL_KV.get(`session:${match[1]}`);
}

// ---------- Auth ----------

async function handleRegister(request, env, cors) {
  if (!(await checkRateLimit(env, 'register', clientIp(request)))) {
    return json({ error: 'Too many attempts. Please try again later.' }, 429, cors);
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);

  const { name, email, password, invite } = body;
  if (!name || !isValidEmail(email) || !password || password.length < 8) {
    return json(
      { error: 'name, a valid email, and a password of at least 8 characters are required' },
      400,
      cors
    );
  }

  const normalizedEmail = email.trim().toLowerCase();
  const inviteToken = String(invite || '').trim();
  if (!inviteToken) {
    return json({ error: 'A registration invitation from your advisor is required' }, 403, cors);
  }
  const inviteKey = `client_invite:${await sha256Hex(inviteToken)}`;
  const inviteEmail = String((await env.PORTAL_KV.get(inviteKey)) || '').trim().toLowerCase();
  if (!inviteEmail || inviteEmail !== normalizedEmail) {
    return json({ error: 'This registration invitation is invalid or has expired' }, 403, cors);
  }
  const existing = await env.PORTAL_KV.get(`user:${normalizedEmail}`);
  if (existing) {
    return json({ error: 'An account with this email already exists' }, 409, cors);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);

  await env.PORTAL_KV.put(
    `user:${normalizedEmail}`,
    JSON.stringify({ name, email: normalizedEmail, salt, hash, iterations: PBKDF2_ITERATIONS })
  );
  // One-time use: consuming the link before issuing the session prevents two
  // near-simultaneous requests from intentionally reusing it after this point.
  await env.PORTAL_KV.delete(inviteKey);

  const token = randomHex(32);
  await env.PORTAL_KV.put(`session:${token}`, normalizedEmail, { expirationTtl: SESSION_TTL_SECONDS });

  await logTimeline(env, normalizedEmail, 'account-created', 'client', null);
  return json({ token, name, email: normalizedEmail }, 201, cors);
}

async function handleAdminCreateClientInvite(request, env, cors, rawEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isValidEmail(email) || !(await contactBelongsToWorkspace(env, email, workspace))) {
    return json({ error: 'Contact not found in this workspace' }, 404, cors);
  }
  if (await env.PORTAL_KV.get(`user:${email}`)) {
    return json({ error: 'This contact already has a portal account' }, 409, cors);
  }
  const token = randomHex(32);
  await env.PORTAL_KV.put(`client_invite:${await sha256Hex(token)}`, email, {
    expirationTtl: CLIENT_INVITE_TTL_SECONDS,
  });
  await logAudit(env, adminEmail, 'create-client-invite', { client: email });
  return json({ invite: token, email, expiresIn: CLIENT_INVITE_TTL_SECONDS }, 201, cors);
}

async function handleLogin(request, env, cors) {
  if (!(await checkRateLimit(env, 'login', clientIp(request)))) {
    return json({ error: 'Too many login attempts. Please try again later.' }, 429, cors);
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);

  const { email, password } = body;
  if (!isValidEmail(email) || !password) {
    return json({ error: 'Email and password are required' }, 400, cors);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const userRaw = await env.PORTAL_KV.get(`user:${normalizedEmail}`);
  if (!userRaw) {
    return json({ error: 'Invalid email or password' }, 401, cors);
  }

  const user = JSON.parse(userRaw);
  const attemptedHash = await hashPassword(password, user.salt, user.iterations);
  if (!timingSafeEqual(attemptedHash, user.hash)) {
    return json({ error: 'Invalid email or password' }, 401, cors);
  }

  const token = randomHex(32);
  await env.PORTAL_KV.put(`session:${token}`, normalizedEmail, { expirationTtl: SESSION_TTL_SECONDS });

  await logTimeline(env, normalizedEmail, 'login', 'client', null);
  return json({ token, name: user.name, email: normalizedEmail }, 200, cors);
}

async function handleLogout(request, env, cors) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    await env.PORTAL_KV.delete(`session:${match[1]}`);
  }
  return json({ ok: true }, 200, cors);
}

// ---------- Admin auth ----------
// Two hardcoded staff accounts (ADMIN_ACCOUNTS), each with its own password
// secret. A successful login mints a short-lived admin session token; every admin
// endpoint resolves that token back to the staff email via getAdminEmail so
// actions can be attributed in the audit log.

// Keys are audit:<invTs>:<rand> where invTs = (AUDIT_TS_CEILING - now) zero-padded
// to 14 digits. Inverting the timestamp makes the NEWEST entry sort first
// lexicographically, so the viewer can fetch the most recent N with a single
// bounded KV list — no full-namespace scan as the log grows. The ceiling keeps
// the value 14 digits (starting with '0') until ~year 2286, so these also sort
// ahead of any legacy audit:<ISO-timestamp> keys from before this change.
const AUDIT_TS_CEILING = 10_000_000_000_000;

async function logAudit(env, email, action, detail) {
  try {
    const now = Date.now();
    const ts = new Date(now).toISOString();
    const invTs = String(AUDIT_TS_CEILING - now).padStart(14, '0');
    await env.PORTAL_KV.put(
      `audit:${invTs}:${randomHex(4)}`,
      JSON.stringify({ ts, email: email || 'unknown', action, detail: detail == null ? null : detail }),
      { expirationTtl: AUDIT_TTL_SECONDS }
    );
  } catch {
    // An audit-log write must never break the underlying request.
  }
}

async function getAdminEmail(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const email = await env.PORTAL_KV.get(`admin_session:${match[1]}`);
  return email && await isAdminAccount(env, email) ? email : null;
}

async function handleAdminLogin(request, env, cors) {
  if (!(await checkRateLimit(env, 'adminlogin', clientIp(request)))) {
    return json({ error: 'Too many login attempts. Please try again later.' }, 429, cors);
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);

  const { email, password } = body;
  if (!isValidEmail(email) || !password) {
    return json({ error: 'Email and password are required' }, 400, cors);
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const passOk = await verifyAdminPassword(env, normalizedEmail, password);
  if (!passOk) {
    return json({ error: 'Invalid email or password' }, 401, cors);
  }

  // Password is correct, but it is NOT sufficient on its own — a second factor
  // (TOTP) is always required. Issue a short-lived pending token; the caller
  // must complete /api/admin/mfa/verify (or enroll first) to get a real session.
  // getAdminMfa throws on a decrypt failure, which the top-level handler turns
  // into a 500 — i.e. we fail closed rather than silently skipping MFA.
  const mfa = await getAdminMfa(env, normalizedEmail);
  const enrolled = !!(mfa && mfa.confirmed);
  const pendingToken = randomHex(32);
  await env.PORTAL_KV.put(
    `admin_pending:${pendingToken}`,
    JSON.stringify({ email: normalizedEmail }),
    { expirationTtl: MFA_PENDING_TTL_SECONDS }
  );
  return json({ status: enrolled ? 'mfa' : 'enroll', pendingToken }, 200, cors);
}

async function handleAdminLogout(request, env, cors) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    await env.PORTAL_KV.delete(`admin_session:${match[1]}`);
  }
  return json({ ok: true }, 200, cors);
}

// ---------- Admin MFA (TOTP, RFC 6238) ----------
// Admin sign-in is two steps: password (handleAdminLogin) issues a short-lived
// pending token; the caller then proves a second factor via mfa/verify to get a
// real session. First-time users enroll (mfa/enroll) an authenticator secret and
// confirm it with a code. TOTP verification (base32 + HMAC-SHA1 truncation) is
// validated against the RFC 6238 test vectors. The per-admin secret + hashed
// backup codes live encrypted (DATA_ENCRYPTION_KEY) under admin_mfa:<email>.
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_ISSUER = 'BlueLine Advisors';
const MFA_PENDING_TTL_SECONDS = 600; // 10 min to complete the second factor
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(b32) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(b32).replace(/=+$/, '').toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function totpAt(secretBytes, counter) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = sig[19] & 0x0f;
  const bin =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

// Accept the current 30s step plus one on each side, to tolerate clock skew.
async function verifyTotp(secretB32, code) {
  const clean = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const secretBytes = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  for (let w = -1; w <= 1; w++) {
    const expected = await totpAt(secretBytes, counter + w);
    if (timingSafeEqual(clean, expected)) return true;
  }
  return false;
}

function generateTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20))); // 160-bit
}

function otpauthUri(email, secretB32) {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateBackupCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const hex = randomHex(5); // 10 hex chars
    codes.push(`${hex.slice(0, 5)}-${hex.slice(5)}`);
  }
  return codes;
}

// Load/save the per-admin MFA record. getAdminMfa lets a decrypt failure throw
// (fail closed) so a broken key can never be read as "no MFA configured".
async function getAdminMfa(env, email) {
  const raw = await env.PORTAL_KV.get(`admin_mfa:${email}`);
  if (!raw) return null;
  return decryptToObject(env, raw);
}

async function putAdminMfa(env, email, record) {
  await env.PORTAL_KV.put(`admin_mfa:${email}`, await encryptJSON(env, record));
}

async function resolvePending(env, token) {
  if (!token) return null;
  const raw = await env.PORTAL_KV.get(`admin_pending:${token}`);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw);
    return pending && await isAdminAccount(env, pending.email) ? pending : null;
  } catch {
    return null;
  }
}

// Begin enrollment: generate a fresh (unconfirmed) secret + backup codes and
// return them once. Refuses if a confirmed authenticator already exists, so a
// stolen password alone can't silently replace a working second factor.
async function handleAdminMfaEnroll(request, env, cors) {
  const body = await request.json().catch(() => null);
  const pending = await resolvePending(env, body && body.pendingToken);
  if (!pending) return json({ error: 'Session expired — please sign in again.' }, 401, cors);

  const existing = await getAdminMfa(env, pending.email);
  if (existing && existing.confirmed) return json({ error: 'MFA is already set up.' }, 409, cors);

  const secret = generateTotpSecret();
  const backupCodes = generateBackupCodes();
  const hashed = [];
  for (const code of backupCodes) hashed.push({ hash: await sha256Hex(code), used: false });
  await putAdminMfa(env, pending.email, {
    secret,
    confirmed: false,
    backupCodes: hashed,
    createdAt: new Date().toISOString(),
  });

  return json(
    { secret, otpauthUri: otpauthUri(pending.email, secret), backupCodes },
    200,
    cors
  );
}

// Complete the second factor: accept a valid TOTP code or an unused backup code,
// confirm enrollment on first success, and mint the real admin session.
async function handleAdminMfaVerify(request, env, cors) {
  if (!(await checkRateLimit(env, 'adminlogin', clientIp(request)))) {
    return json({ error: 'Too many attempts. Please try again later.' }, 429, cors);
  }
  const body = await request.json().catch(() => null);
  const pending = await resolvePending(env, body && body.pendingToken);
  if (!pending) return json({ error: 'Session expired — please sign in again.' }, 401, cors);
  const code = body && body.code;
  if (!code) return json({ error: 'Enter the 6-digit code.' }, 400, cors);

  const mfa = await getAdminMfa(env, pending.email);
  if (!mfa) return json({ error: 'MFA is not set up.' }, 400, cors);

  let ok = await verifyTotp(mfa.secret, code);
  let usedBackup = false;
  if (!ok) {
    const codeHash = await sha256Hex(String(code).replace(/\s/g, '').toLowerCase());
    const match = (mfa.backupCodes || []).find((bc) => !bc.used && timingSafeEqual(bc.hash, codeHash));
    if (match) {
      match.used = true;
      ok = true;
      usedBackup = true;
    }
  }
  if (!ok) return json({ error: 'Invalid code.' }, 401, cors);

  if (!mfa.confirmed || usedBackup) {
    mfa.confirmed = true;
    await putAdminMfa(env, pending.email, mfa);
  }
  await env.PORTAL_KV.delete(`admin_pending:${body.pendingToken}`);

  const token = randomHex(32);
  await env.PORTAL_KV.put(`admin_session:${token}`, pending.email, {
    expirationTtl: ADMIN_SESSION_TTL_SECONDS,
  });
  await logAudit(env, pending.email, 'login', { mfa: usedBackup ? 'backup-code' : 'totp' });
  return json({ token, email: pending.email, usedBackup }, 200, cors);
}

// List the admin accounts and whether each has MFA set up — powers the
// "Admin Accounts" card so one admin can see and reset the other.
async function handleAdminListAdmins(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const names = await effectiveAdminNames(env);
  const admins = [];
  for (const email of await allAdminEmails(env)) {
    const mfa = await getAdminMfa(env, email); // throws on decrypt fail -> 500 (fail closed)
    admins.push({ email, name: names[email] || null, mfaEnabled: !!(mfa && mfa.confirmed) });
  }
  return json({
    admins,
    you: adminEmail,
    boss: await canManageSharedFirmView(env, adminEmail),
    canDeleteAdmins: isSuperAdmin(adminEmail),
  }, 200, cors);
}

// One admin resets another's MFA (recovery for a lost authenticator). Deleting
// the record forces fresh enrollment on that admin's next login. Any signed-in
// Shared firm view managers may reset any admin account; the action is audit-logged.
async function handleAdminResetMfa(request, env, cors, targetEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can reset admin MFA' }, 403, cors);
  const normalized = String(targetEmail).trim().toLowerCase();
  if (!(await isAdminAccount(env, normalized))) {
    return json({ error: 'Not an admin account' }, 404, cors);
  }
  await env.PORTAL_KV.delete(`admin_mfa:${normalized}`);
  await logAudit(env, adminEmail, 'reset-mfa', { target: normalized });
  return json({ ok: true }, 200, cors);
}

// ---------- Data-at-rest encryption (AES-256-GCM) ----------
// Sensitive client records (assessment responses) are encrypted before being
// written to KV, so a leaked KV export is useless without the DATA_ENCRYPTION_KEY
// secret (set with: wrangler secret put DATA_ENCRYPTION_KEY — use a long random
// string, e.g. `openssl rand -base64 48`). Stored envelope is self-describing:
//   { v: 1, enc: 'aesgcm', iv: <base64>, ct: <base64> }
// so records written before this feature (plain { modules }) still read back.
//
// LIMITATION (be honest about it): the key lives in the same Cloudflare account
// as the data, so this protects against a leaked KV export / stolen read token,
// NOT against a compromise of the Cloudflare account itself. MFA on the account
// is the control for that.
//
// KEY HANDLING IS CRITICAL: if DATA_ENCRYPTION_KEY is lost or changed after real
// data is encrypted, that data becomes permanently unreadable. Never rotate it
// without a re-encryption migration.

// The imported AES key is cached across requests within a warm isolate. Keyed on
// the secret string so a rotated secret is re-imported rather than reused.
let cachedDataKey = null;
let cachedDataKeySource = null;

async function getDataKey(env) {
  const secret = env.DATA_ENCRYPTION_KEY;
  if (!secret) return null;
  if (cachedDataKey && cachedDataKeySource === secret) return cachedDataKey;
  // Normalize any-length secret to a 256-bit key via SHA-256. The secret is
  // expected to be high-entropy random material, not a human password.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  cachedDataKey = key;
  cachedDataKeySource = secret;
  return key;
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Serialize an object for storage, encrypting when a key is configured. When no
// key is set (pre-rollout), stores plaintext so saves don't break — set
// DATA_ENCRYPTION_KEY before any real client data is entered.
async function encryptJSON(env, obj) {
  const plaintext = JSON.stringify(obj);
  const key = await getDataKey(env);
  if (!key) return plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh IV per record
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return JSON.stringify({ v: 1, enc: 'aesgcm', iv: bytesToBase64(iv), ct: bytesToBase64(ct) });
}

// Parse a stored string back into an object, transparently decrypting the
// encrypted envelope and passing legacy plaintext through unchanged. Throws if a
// record is encrypted but cannot be decrypted (missing/wrong key, tampering) so
// callers never silently treat undecryptable data as empty and overwrite it.
async function decryptToObject(env, raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt/legacy junk — matches prior lenient behavior
  }
  if (!parsed || parsed.enc !== 'aesgcm') return parsed; // legacy plaintext record
  const key = await getDataKey(env);
  if (!key) throw new Error('Encrypted record found but DATA_ENCRYPTION_KEY is not set');
  const ptBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(parsed.iv) },
    key,
    base64ToBytes(parsed.ct)
  );
  return JSON.parse(new TextDecoder().decode(ptBuf));
}

// ---------- Assessment modules ----------

// Read the modules map out of a stored responses:<email> string, decrypting as
// needed. Async because decryption is; throws on decrypt failure (see
// decryptToObject) rather than returning {} which would risk data loss on save.
async function loadModules(env, raw) {
  const rec = await decryptToObject(env, raw);
  // Records from the pre-module schema have budget/riskAnswers at the top level;
  // they were test data and are intentionally not migrated.
  return rec && typeof rec.modules === 'object' ? rec.modules : {};
}

function num(value, { min = 0, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

const EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'];
const RISK_QUESTION_COUNT = 5;

const BUDGET_EXPENSE_CATEGORIES = [
  'housing',
  'utilities',
  'groceries',
  'transportation',
  'insurance',
  'healthcare',
  'debt',
  'childcareEducation',
  'discretionary',
  'other',
];

const NETWORTH_ASSETS = ['cash', 'brokerage', 'retirement', 'realEstate', 'businessEquity', 'otherAssets'];
const NETWORTH_LIABILITIES = ['mortgage', 'studentLoans', 'autoLoans', 'creditCards', 'businessDebt', 'otherDebts'];

const EQUITY_TYPES = ['rsu', 'options', 'espp', 'partnership', 'none'];
const OLD_PLAN_OPTIONS = ['none', 'one', 'multiple'];
const STOCK_CONCENTRATION = ['none', 'under5', '5to15', '15to30', 'over30'];

const SPENDING_ESSENTIALS = ['housing', 'utilities', 'groceries', 'transportation', 'healthcare', 'insurance'];
const SPENDING_DISCRETIONARY = ['dining', 'entertainment', 'shopping', 'subscriptions', 'travel', 'other'];
const SAVINGS_TARGET_MONTHS = [3, 6, 12];
const DEBT_TYPES = ['creditCards', 'autoLoans', 'studentLoans', 'personalLoans'];
const RISKCAPACITY_QUESTION_COUNT = 5;
const BEHAVIOR_QUESTION_COUNT = 4;
const YEARS_INVESTING = ['none', 'under3', '3to10', 'over10'];
const KNOWLEDGE_INSTRUMENTS = ['stocks', 'bonds', 'mutualFunds', 'etfs', 'options', 'crypto', 'realEstate', 'annuities'];
const ESTATE_DOCUMENTS = ['will', 'trust', 'financialPoa', 'healthcareDirective', 'hipaaAuthorization'];
const YES_NO_UNSURE = ['yes', 'no', 'unsure'];
const BENEFICIARY_COVERAGE = ['all', 'some', 'none', 'na'];
const TOD_OPTIONS = ['yes', 'no', 'na'];
const LAST_REVIEWED = ['within1', '1to3', 'over3', 'never'];
const LIFE_EVENTS = ['marriage', 'divorce', 'birth', 'death', 'move', 'none'];
const CHARITABLE_INTENT = ['none', 'annual', 'bequest', 'both', 'unsure'];
const ANNUAL_GIFTING = ['none', 'family', 'charity', 'both'];
const SPECIAL_CIRCUMSTANCES = ['minorChildren', 'specialNeeds', 'blendedFamily', 'businessSuccession', 'none'];
const COVERAGE_LINES = ['termLife', 'disability', 'umbrella', 'longTermCare', 'homeAuto'];
const LTC_AGE_BANDS = ['under40', '40to49', '50to59', '60plus'];
const LTC_FUNDING_PLANS = ['insurance', 'selfFund', 'hybrid', 'none'];

function riskCategoryForScore(score) {
  if (score <= 9) return 'Conservative';
  if (score <= 14) return 'Moderately Conservative';
  if (score <= 19) return 'Moderate';
  if (score <= 24) return 'Moderately Aggressive';
  return 'Aggressive';
}

function allocationForCategory(category) {
  return {
    Conservative: { stocks: 25, bonds: 55, cash: 20 },
    'Moderately Conservative': { stocks: 40, bonds: 45, cash: 15 },
    Moderate: { stocks: 55, bonds: 35, cash: 10 },
    'Moderately Aggressive': { stocks: 70, bonds: 25, cash: 5 },
    Aggressive: { stocks: 85, bonds: 12, cash: 3 },
  }[category];
}

function capacityLevelForScore(score) {
  if (score <= 9) return 'Low';
  if (score <= 14) return 'Moderately Low';
  if (score <= 19) return 'Moderate';
  if (score <= 24) return 'Moderately High';
  return 'High';
}

function behaviorProfileForScore(score) {
  if (score <= 7) return 'Highly Cautious';
  if (score <= 11) return 'Cautious';
  if (score <= 15) return 'Composed';
  return 'Opportunistic';
}

function knowledgeLevelForScore(score) {
  if (score <= 3) return 'Novice';
  if (score <= 6) return 'Developing';
  if (score <= 9) return 'Experienced';
  return 'Sophisticated';
}

const MODULE_VALIDATORS = {
  risk(body) {
    if (!EXPERIENCE_LEVELS.includes(body.experienceLevel)) {
      return { error: 'experienceLevel is required' };
    }
    if (!body.answers || typeof body.answers !== 'object') {
      return { error: 'answers is required' };
    }
    const answers = {};
    let score = 0;
    for (let i = 1; i <= RISK_QUESTION_COUNT; i++) {
      const value = Number(body.answers[i]);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        return { error: `answers.${i} must be an integer 1-5` };
      }
      answers[i] = value;
      score += value;
    }
    const category = riskCategoryForScore(score);
    return {
      data: {
        experienceLevel: body.experienceLevel,
        answers,
        score,
        category,
        suggestedAllocation: allocationForCategory(category),
        goalShortTerm: String(body.goalShortTerm || '').slice(0, 1000),
        goalMediumTerm: String(body.goalMediumTerm || '').slice(0, 1000),
        goalLongTerm: String(body.goalLongTerm || '').slice(0, 1000),
      },
    };
  },

  budget(body) {
    const monthlyIncome = num(body.monthlyIncome, { max: 10_000_000 });
    if (monthlyIncome === null) return { error: 'monthlyIncome must be a non-negative number' };
    const monthlySavings = num(body.monthlySavings, { max: 10_000_000 });
    if (monthlySavings === null) return { error: 'monthlySavings must be a non-negative number' };

    if (!body.expenses || typeof body.expenses !== 'object') {
      return { error: 'expenses is required' };
    }
    const expenses = {};
    let totalExpenses = 0;
    for (const key of BUDGET_EXPENSE_CATEGORIES) {
      const value = num(body.expenses[key], { max: 10_000_000 });
      if (value === null) return { error: `expenses.${key} must be a non-negative number` };
      expenses[key] = value;
      totalExpenses += value;
    }

    const surplus = monthlyIncome - totalExpenses - monthlySavings;
    const savingsRate = monthlyIncome > 0 ? Math.round((monthlySavings / monthlyIncome) * 1000) / 10 : 0;
    return { data: { monthlyIncome, expenses, monthlySavings, totalExpenses, surplus, savingsRate } };
  },

  retirement(body) {
    const currentAge = num(body.currentAge, { min: 18, max: 99 });
    if (currentAge === null) return { error: 'currentAge must be between 18 and 99' };
    const targetAge = num(body.targetAge, { min: 19, max: 100 });
    if (targetAge === null || targetAge <= currentAge) {
      return { error: 'targetAge must be greater than currentAge' };
    }
    const currentSavings = num(body.currentSavings, { max: 1_000_000_000 });
    if (currentSavings === null) return { error: 'currentSavings must be a non-negative number' };
    const monthlyContribution = num(body.monthlyContribution, { max: 10_000_000 });
    if (monthlyContribution === null) return { error: 'monthlyContribution must be a non-negative number' };
    const employerMatchMonthly = num(body.employerMatchMonthly, { max: 10_000_000 });
    if (employerMatchMonthly === null) return { error: 'employerMatchMonthly must be a non-negative number' };
    const desiredMonthlyIncome = num(body.desiredMonthlyIncome, { max: 10_000_000 });
    if (desiredMonthlyIncome === null) return { error: 'desiredMonthlyIncome must be a non-negative number' };
    if (!OLD_PLAN_OPTIONS.includes(body.oldEmployerPlans)) {
      return { error: 'oldEmployerPlans must be one of: ' + OLD_PLAN_OPTIONS.join(', ') };
    }

    // Deterministic 6% nominal annual growth assumption, compounded monthly.
    const months = Math.round((targetAge - currentAge) * 12);
    const monthlyRate = 0.06 / 12;
    const contribution = monthlyContribution + employerMatchMonthly;
    let balance = currentSavings;
    for (let m = 0; m < months; m++) {
      balance = balance * (1 + monthlyRate) + contribution;
    }
    const projectedBalance = Math.round(balance);
    // 4% rule: sustainable nest egg = 25x annual income need.
    const targetNestEgg = Math.round(desiredMonthlyIncome * 12 * 25);
    const readinessPct =
      targetNestEgg > 0 ? Math.min(999, Math.round((projectedBalance / targetNestEgg) * 100)) : null;

    return {
      data: {
        currentAge,
        targetAge,
        currentSavings,
        monthlyContribution,
        employerMatchMonthly,
        desiredMonthlyIncome,
        oldEmployerPlans: body.oldEmployerPlans,
        projectedBalance,
        targetNestEgg,
        readinessPct,
      },
    };
  },

  networth(body) {
    if (!body.assets || typeof body.assets !== 'object' || !body.liabilities || typeof body.liabilities !== 'object') {
      return { error: 'assets and liabilities are required' };
    }
    const assets = {};
    let totalAssets = 0;
    for (const key of NETWORTH_ASSETS) {
      const value = num(body.assets[key], { max: 10_000_000_000 });
      if (value === null) return { error: `assets.${key} must be a non-negative number` };
      assets[key] = value;
      totalAssets += value;
    }
    const liabilities = {};
    let totalLiabilities = 0;
    for (const key of NETWORTH_LIABILITIES) {
      const value = num(body.liabilities[key], { max: 10_000_000_000 });
      if (value === null) return { error: `liabilities.${key} must be a non-negative number` };
      liabilities[key] = value;
      totalLiabilities += value;
    }
    return {
      data: { assets, liabilities, totalAssets, totalLiabilities, netWorth: totalAssets - totalLiabilities },
    };
  },

  compensation(body) {
    const baseSalary = num(body.baseSalary, { max: 100_000_000 });
    if (baseSalary === null) return { error: 'baseSalary must be a non-negative number' };
    const annualBonus = num(body.annualBonus, { max: 100_000_000 });
    if (annualBonus === null) return { error: 'annualBonus must be a non-negative number' };
    const annualEquityValue = num(body.annualEquityValue, { max: 100_000_000 });
    if (annualEquityValue === null) return { error: 'annualEquityValue must be a non-negative number' };

    if (!Array.isArray(body.equityTypes) || !body.equityTypes.every((t) => EQUITY_TYPES.includes(t))) {
      return { error: 'equityTypes must be an array of: ' + EQUITY_TYPES.join(', ') };
    }
    const contributionPct = num(body.contributionPct, { max: 100 });
    if (contributionPct === null) return { error: 'contributionPct must be between 0 and 100' };
    const employerMatchPct = num(body.employerMatchPct, { max: 100 });
    if (employerMatchPct === null) return { error: 'employerMatchPct must be between 0 and 100' };
    if (!STOCK_CONCENTRATION.includes(body.employerStockConcentration)) {
      return { error: 'employerStockConcentration must be one of: ' + STOCK_CONCENTRATION.join(', ') };
    }

    const totalComp = baseSalary + annualBonus + annualEquityValue;
    return {
      data: {
        baseSalary,
        annualBonus,
        annualEquityValue,
        equityTypes: [...new Set(body.equityTypes)],
        contributionPct,
        employerMatchPct,
        hsaEligible: !!body.hsaEligible,
        deferredComp: !!body.deferredComp,
        employerStockConcentration: body.employerStockConcentration,
        totalComp,
        concentrationFlag: ['15to30', 'over30'].includes(body.employerStockConcentration),
      },
    };
  },

  spending(body) {
    const monthlyIncome = num(body.monthlyIncome, { max: 10_000_000 });
    if (monthlyIncome === null) return { error: 'monthlyIncome must be a non-negative number' };
    if (!body.essentials || typeof body.essentials !== 'object') {
      return { error: 'essentials is required' };
    }
    if (!body.discretionary || typeof body.discretionary !== 'object') {
      return { error: 'discretionary is required' };
    }
    const essentials = {};
    let totalEssentials = 0;
    for (const key of SPENDING_ESSENTIALS) {
      const value = num(body.essentials[key], { max: 10_000_000 });
      if (value === null) return { error: `essentials.${key} must be a non-negative number` };
      essentials[key] = value;
      totalEssentials += value;
    }
    const discretionary = {};
    let totalDiscretionary = 0;
    for (const key of SPENDING_DISCRETIONARY) {
      const value = num(body.discretionary[key], { max: 10_000_000 });
      if (value === null) return { error: `discretionary.${key} must be a non-negative number` };
      discretionary[key] = value;
      totalDiscretionary += value;
    }
    const totalSpending = totalEssentials + totalDiscretionary;
    const leftover = monthlyIncome - totalSpending;
    const discretionaryPct =
      totalSpending > 0 ? Math.round((totalDiscretionary / totalSpending) * 1000) / 10 : 0;
    return {
      data: {
        monthlyIncome,
        essentials,
        discretionary,
        totalEssentials,
        totalDiscretionary,
        totalSpending,
        leftover,
        discretionaryPct,
        overspending: leftover < 0,
        highDiscretionary: discretionaryPct >= 40,
      },
    };
  },

  savings(body) {
    const monthlyExpenses = num(body.monthlyExpenses, { max: 10_000_000 });
    if (monthlyExpenses === null) return { error: 'monthlyExpenses must be a non-negative number' };
    const emergencyFund = num(body.emergencyFund, { max: 1_000_000_000 });
    if (emergencyFund === null) return { error: 'emergencyFund must be a non-negative number' };
    const monthlySavings = num(body.monthlySavings, { max: 10_000_000 });
    if (monthlySavings === null) return { error: 'monthlySavings must be a non-negative number' };
    const targetMonths = Number(body.targetMonths);
    if (!SAVINGS_TARGET_MONTHS.includes(targetMonths)) {
      return { error: 'targetMonths must be one of: ' + SAVINGS_TARGET_MONTHS.join(', ') };
    }

    const monthsCovered =
      monthlyExpenses > 0 ? Math.round((emergencyFund / monthlyExpenses) * 10) / 10 : null;
    const targetAmount = monthlyExpenses * targetMonths;
    const shortfall = Math.max(0, targetAmount - emergencyFund);
    const monthsToTarget =
      shortfall === 0 ? 0 : monthlySavings > 0 ? Math.ceil(shortfall / monthlySavings) : null;
    return {
      data: {
        monthlyExpenses,
        emergencyFund,
        monthlySavings,
        targetMonths,
        goalsNotes: String(body.goalsNotes || '').slice(0, 1000),
        monthsCovered,
        targetAmount,
        shortfall,
        monthsToTarget,
        funded: shortfall === 0,
      },
    };
  },

  debt(body) {
    if (!body.debts || typeof body.debts !== 'object') {
      return { error: 'debts is required' };
    }
    const debts = {};
    let totalDebt = 0;
    let weightedSum = 0;
    for (const key of DEBT_TYPES) {
      const entry = body.debts[key];
      if (!entry || typeof entry !== 'object') return { error: `debts.${key} is required` };
      const balance = num(entry.balance, { max: 10_000_000_000 });
      if (balance === null) return { error: `debts.${key}.balance must be a non-negative number` };
      const rate = num(entry.rate, { max: 100 });
      if (rate === null) return { error: `debts.${key}.rate must be between 0 and 100` };
      debts[key] = { balance, rate };
      totalDebt += balance;
      weightedSum += balance * rate;
    }
    const monthlyDebtPayments = num(body.monthlyDebtPayments, { max: 10_000_000 });
    if (monthlyDebtPayments === null) return { error: 'monthlyDebtPayments must be a non-negative number' };
    const grossMonthlyIncome = num(body.grossMonthlyIncome, { max: 10_000_000 });
    if (grossMonthlyIncome === null) return { error: 'grossMonthlyIncome must be a non-negative number' };

    const weightedAvgRate = totalDebt > 0 ? Math.round((weightedSum / totalDebt) * 10) / 10 : 0;
    const dtiPct =
      grossMonthlyIncome > 0
        ? Math.round((monthlyDebtPayments / grossMonthlyIncome) * 1000) / 10
        : null;
    let highestRateType = null;
    for (const key of DEBT_TYPES) {
      if (debts[key].balance > 0 && (highestRateType === null || debts[key].rate > debts[highestRateType].rate)) {
        highestRateType = key;
      }
    }
    return {
      data: {
        debts,
        monthlyDebtPayments,
        grossMonthlyIncome,
        totalDebt,
        weightedAvgRate,
        dtiPct,
        highestRateType,
        highDti: dtiPct !== null && dtiPct >= 36,
        highInterest: DEBT_TYPES.some((key) => debts[key].balance > 0 && debts[key].rate >= 10),
      },
    };
  },

  riskcapacity(body) {
    if (!body.answers || typeof body.answers !== 'object') {
      return { error: 'answers is required' };
    }
    const answers = {};
    let score = 0;
    for (let i = 1; i <= RISKCAPACITY_QUESTION_COUNT; i++) {
      const value = Number(body.answers[i]);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        return { error: `answers.${i} must be an integer 1-5` };
      }
      answers[i] = value;
      score += value;
    }
    return { data: { answers, score, level: capacityLevelForScore(score) } };
  },

  behavior(body) {
    if (!body.answers || typeof body.answers !== 'object') {
      return { error: 'answers is required' };
    }
    const answers = {};
    let score = 0;
    for (let i = 1; i <= BEHAVIOR_QUESTION_COUNT; i++) {
      const value = Number(body.answers[i]);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        return { error: `answers.${i} must be an integer 1-5` };
      }
      answers[i] = value;
      score += value;
    }
    return {
      data: {
        answers,
        score,
        profile: behaviorProfileForScore(score),
        coachingFlag: score <= 7,
        biggestConcern: String(body.biggestConcern || '').slice(0, 1000),
      },
    };
  },

  knowledge(body) {
    if (!YEARS_INVESTING.includes(body.yearsInvesting)) {
      return { error: 'yearsInvesting must be one of: ' + YEARS_INVESTING.join(', ') };
    }
    if (!Array.isArray(body.instruments) || !body.instruments.every((t) => KNOWLEDGE_INSTRUMENTS.includes(t))) {
      return { error: 'instruments must be an array of: ' + KNOWLEDGE_INSTRUMENTS.join(', ') };
    }
    const selfRating = Number(body.selfRating);
    if (!Number.isInteger(selfRating) || selfRating < 1 || selfRating > 5) {
      return { error: 'selfRating must be an integer 1-5' };
    }
    const instruments = [...new Set(body.instruments)];
    const instrumentCount = instruments.length;
    const yearsPoints = { none: 0, under3: 1, '3to10': 2, over10: 3 }[body.yearsInvesting];
    const knowledgeScore = yearsPoints + Math.min(4, instrumentCount) + selfRating;
    return {
      data: {
        yearsInvesting: body.yearsInvesting,
        instruments,
        selfRating,
        hadAdvisor: !!body.hadAdvisor,
        instrumentCount,
        knowledgeScore,
        level: knowledgeLevelForScore(knowledgeScore),
      },
    };
  },

  estatedocs(body) {
    if (!body.documents || typeof body.documents !== 'object') {
      return { error: 'documents is required' };
    }
    const currentYear = new Date().getFullYear();
    const documents = {};
    const missing = [];
    const unsure = [];
    const stale = [];
    let haveCount = 0;
    for (const key of ESTATE_DOCUMENTS) {
      const doc = body.documents[key];
      if (!doc || typeof doc !== 'object' || !YES_NO_UNSURE.includes(doc.status)) {
        return { error: `documents.${key}.status must be one of: ` + YES_NO_UNSURE.join(', ') };
      }
      let year = null;
      if (doc.status === 'yes' && doc.year !== null && doc.year !== undefined) {
        const value = Number(doc.year);
        if (!Number.isInteger(value) || value < 1900 || value > 2100) {
          return { error: `documents.${key}.year must be an integer 1900-2100` };
        }
        year = value;
      }
      documents[key] = { status: doc.status, year };
      if (doc.status === 'yes') {
        haveCount += 1;
        if (year !== null && year <= currentYear - 5) stale.push(key);
      } else if (doc.status === 'no') {
        missing.push(key);
      } else {
        unsure.push(key);
      }
    }
    return {
      data: {
        documents,
        haveCount,
        completenessPct: Math.round((haveCount / 5) * 100),
        missing,
        unsure,
        stale,
      },
    };
  },

  beneficiaries(body) {
    if (!BENEFICIARY_COVERAGE.includes(body.retirementAccounts)) {
      return { error: 'retirementAccounts must be one of: ' + BENEFICIARY_COVERAGE.join(', ') };
    }
    if (!BENEFICIARY_COVERAGE.includes(body.lifePolicies)) {
      return { error: 'lifePolicies must be one of: ' + BENEFICIARY_COVERAGE.join(', ') };
    }
    if (!TOD_OPTIONS.includes(body.todBrokerage)) {
      return { error: 'todBrokerage must be one of: ' + TOD_OPTIONS.join(', ') };
    }
    if (!LAST_REVIEWED.includes(body.lastReviewed)) {
      return { error: 'lastReviewed must be one of: ' + LAST_REVIEWED.join(', ') };
    }
    if (!Array.isArray(body.lifeEvents) || !body.lifeEvents.every((e) => LIFE_EVENTS.includes(e))) {
      return { error: 'lifeEvents must be an array of: ' + LIFE_EVENTS.join(', ') };
    }
    const lifeEvents = [...new Set(body.lifeEvents)];
    const gapCount =
      (['some', 'none'].includes(body.retirementAccounts) ? 1 : 0) +
      (['some', 'none'].includes(body.lifePolicies) ? 1 : 0) +
      (body.todBrokerage === 'no' ? 1 : 0);
    const eventsSinceReview = lifeEvents.filter((e) => e !== 'none');
    const reviewNeeded =
      ['over3', 'never'].includes(body.lastReviewed) || eventsSinceReview.length > 0 || gapCount > 0;
    return {
      data: {
        retirementAccounts: body.retirementAccounts,
        lifePolicies: body.lifePolicies,
        todBrokerage: body.todBrokerage,
        lastReviewed: body.lastReviewed,
        lifeEvents,
        gapCount,
        eventsSinceReview,
        reviewNeeded,
      },
    };
  },

  legacy(body) {
    if (!CHARITABLE_INTENT.includes(body.charitableIntent)) {
      return { error: 'charitableIntent must be one of: ' + CHARITABLE_INTENT.join(', ') };
    }
    if (!ANNUAL_GIFTING.includes(body.annualGifting)) {
      return { error: 'annualGifting must be one of: ' + ANNUAL_GIFTING.join(', ') };
    }
    if (
      !Array.isArray(body.specialCircumstances) ||
      !body.specialCircumstances.every((c) => SPECIAL_CIRCUMSTANCES.includes(c))
    ) {
      return { error: 'specialCircumstances must be an array of: ' + SPECIAL_CIRCUMSTANCES.join(', ') };
    }
    const specialCircumstances = [...new Set(body.specialCircumstances)];
    const discussionTopics = [];
    if (['annual', 'both'].includes(body.charitableIntent)) {
      discussionTopics.push('Charitable giving strategy (donor-advised fund, QCDs)');
    }
    if (['bequest', 'both'].includes(body.charitableIntent)) {
      discussionTopics.push('Charitable bequest planning');
    }
    if (specialCircumstances.includes('minorChildren')) {
      discussionTopics.push('Guardianship and trust provisions for minor children');
    }
    if (specialCircumstances.includes('specialNeeds')) {
      discussionTopics.push('Special needs trust planning');
    }
    if (specialCircumstances.includes('blendedFamily')) {
      discussionTopics.push('Blended family estate structuring');
    }
    if (specialCircumstances.includes('businessSuccession')) {
      discussionTopics.push('Business succession planning');
    }
    if (['family', 'both'].includes(body.annualGifting)) {
      discussionTopics.push('Annual gift tax exclusion strategy');
    }
    return {
      data: {
        charitableIntent: body.charitableIntent,
        annualGifting: body.annualGifting,
        specialCircumstances,
        legacyNotes: String(body.legacyNotes || '').slice(0, 2000),
        discussionTopics,
        topicCount: discussionTopics.length,
      },
    };
  },

  lifeinsurance(body) {
    const debts = num(body.debts, { max: 1_000_000_000 });
    if (debts === null) return { error: 'debts must be a non-negative number' };
    const annualIncome = num(body.annualIncome, { max: 100_000_000 });
    if (annualIncome === null) return { error: 'annualIncome must be a non-negative number' };
    const incomeYears = num(body.incomeYears, { max: 40 });
    if (incomeYears === null) return { error: 'incomeYears must be between 0 and 40' };
    const mortgageBalance = num(body.mortgageBalance, { max: 1_000_000_000 });
    if (mortgageBalance === null) return { error: 'mortgageBalance must be a non-negative number' };
    const educationCosts = num(body.educationCosts, { max: 1_000_000_000 });
    if (educationCosts === null) return { error: 'educationCosts must be a non-negative number' };
    const currentCoverage = num(body.currentCoverage, { max: 1_000_000_000 });
    if (currentCoverage === null) return { error: 'currentCoverage must be a non-negative number' };

    const dimeNeed = Math.round(debts + annualIncome * incomeYears + mortgageBalance + educationCosts);
    const gap = Math.round(dimeNeed - currentCoverage);
    const coveragePct = dimeNeed > 0 ? Math.min(999, Math.round((currentCoverage / dimeNeed) * 100)) : null;
    return {
      data: {
        debts,
        annualIncome,
        incomeYears,
        mortgageBalance,
        educationCosts,
        currentCoverage,
        dimeNeed,
        gap,
        coveragePct,
        underinsured: gap > 0,
      },
    };
  },

  coverage(body) {
    if (!body.lines || typeof body.lines !== 'object') {
      return { error: 'lines is required' };
    }
    const lines = {};
    const gaps = [];
    const unsure = [];
    let coveredCount = 0;
    for (const key of COVERAGE_LINES) {
      const line = body.lines[key];
      if (!line || typeof line !== 'object' || !YES_NO_UNSURE.includes(line.status)) {
        return { error: `lines.${key}.status must be one of: ` + YES_NO_UNSURE.join(', ') };
      }
      let amount = null;
      if (line.status === 'yes' && key !== 'homeAuto' && line.amount !== null && line.amount !== undefined) {
        amount = num(line.amount, { max: 1_000_000_000 });
        if (amount === null) return { error: `lines.${key}.amount must be a non-negative number` };
      }
      lines[key] = { status: line.status, amount };
      if (line.status === 'yes') coveredCount += 1;
      else if (line.status === 'no') gaps.push(key);
      else unsure.push(key);
    }
    return { data: { lines, coveredCount, gaps, unsure } };
  },

  ltc(body) {
    if (!LTC_AGE_BANDS.includes(body.ageBand)) {
      return { error: 'ageBand must be one of: ' + LTC_AGE_BANDS.join(', ') };
    }
    if (!YES_NO_UNSURE.includes(body.familyHistory)) {
      return { error: 'familyHistory must be one of: ' + YES_NO_UNSURE.join(', ') };
    }
    if (!LTC_FUNDING_PLANS.includes(body.fundingPlan)) {
      return { error: 'fundingPlan must be one of: ' + LTC_FUNDING_PLANS.join(', ') };
    }
    if (!['yes', 'no'].includes(body.assetsEarmarked)) {
      return { error: 'assetsEarmarked must be yes or no' };
    }
    let readiness;
    if (body.fundingPlan !== 'none' && body.assetsEarmarked === 'yes') readiness = 'Planned';
    else if (body.fundingPlan !== 'none') readiness = 'Partially planned';
    else readiness = 'Not yet planned';
    const timelyFlag = ['50to59', '60plus'].includes(body.ageBand) && readiness === 'Not yet planned';
    return {
      data: {
        ageBand: body.ageBand,
        familyHistory: body.familyHistory,
        fundingPlan: body.fundingPlan,
        assetsEarmarked: body.assetsEarmarked,
        readiness,
        timelyFlag,
      },
    };
  },
};

// ---------- Household-shared portal ----------
// Every member of a family sees one portal: the same documents, the same
// requests, and each other's assessments. Resolved per request from the
// household record rather than stored on the client, so adding or removing a
// member takes effect immediately and there is no second copy to fall out of
// step.
//
// Scope, decided deliberately and worth knowing before changing anything here:
//   * FAMILIES only, not companies — same rule resolveClientDocFolder uses.
//   * EVERY member, including child/dependent roles.
//   * Automatic for every family; there is no per-household opt-in.
// The consequence is that a document one member uploaded is visible to all of
// them, including estate documents filed before this existed. That is the
// intended behaviour here, but it is the reason every shared row is labelled
// with whose it is rather than silently blended — a client should be able to see
// that they are looking at a spouse's file.
//
// Always returns at least the caller, so a client in no household behaves
// exactly as they did before any of this.
async function householdPortalMembers(env, email) {
  const addr = String(email || '').trim().toLowerCase();
  try {
    const { items } = await readAllEncrypted(env, 'household:');
    const families = items.filter((h) => h && h.id && groupKindOf(h) !== 'company' && !h.archived);
    const mine = families
      .filter((h) => (h.members || []).some((m) => m && String(m.email || '').toLowerCase() === addr))
      .sort(oldestFirst);
    if (!mine.length) return { members: [addr], household: null };
    // Nothing stops a contact being listed in two families; oldest wins, the
    // same tie-break the document folder resolver uses, so the two agree.
    const hh = mine[0];
    const members = [];
    for (const m of hh.members || []) {
      const e = String((m && m.email) || '').trim().toLowerCase();
      if (e && !members.includes(e)) members.push(e);
    }
    if (!members.includes(addr)) members.push(addr);
    return { members, household: hh };
  } catch (err) {
    // A read failure must never widen access. Falling back to just the caller
    // fails closed: they see their own portal, never someone else's.
    console.error('Could not resolve household for the portal, using own records only:', err);
    return { members: [addr], household: null };
  }
}

// Display name for a member, for the "whose is this" labels. Falls back to the
// address so a member with no contact record still renders.
async function memberDisplayNames(env, emails) {
  const names = {};
  for (const e of emails) {
    try {
      const rec = await decryptToObject(env, await env.PORTAL_KV.get(`contact:${e}`));
      names[e] = (rec && rec.name) || e;
    } catch {
      names[e] = e;
    }
  }
  return names;
}

// The household this client shares a portal with, for the member switcher and
// the whose-is-it labels. `shared` is false for a client in no family, which is
// how the UI knows to hide all of it.
async function handleGetHousehold(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);
  const { members, household } = await householdPortalMembers(env, email);
  const names = await memberDisplayNames(env, members);
  const roleOf = {};
  for (const m of (household && household.members) || []) {
    roleOf[String((m && m.email) || '').toLowerCase()] = (m && m.role) || '';
  }
  return json({
    shared: members.length > 1,
    householdName: (household && household.name) || '',
    you: email,
    members: members.map((e) => ({ email: e, name: names[e], role: roleOf[e] || '' })),
  }, 200, cors);
}

// ---------- Shared vs personal assessments ----------
// A household shares ONE copy of most assessments: a couple has one budget, one
// net worth, one estate checklist, and making each spouse retype them was the
// whole complaint. Those live in a single household record.
//
// These four do NOT share, because they describe a person rather than a
// household — and because a shared copy means whoever saves second erases the
// other's answers outright. Each member keeps their own, which is also what
// leaves a per-client suitability record rather than one blended profile:
const PERSONAL_ASSESSMENTS = new Set([
  'risk',         // Risk Tolerance & Investor Profile
  'riskcapacity', // Risk Capacity Analysis
  'behavior',     // Investor Behavior Profile
  'knowledge',    // Investment Knowledge & Experience
]);
const isPersonalAssessment = (key) => PERSONAL_ASSESSMENTS.has(key);
const hhResponsesKey = (id) => `hhresponses:${id}`;

// Splits a stored module map into the shared and personal halves.
function splitModules(all) {
  const shared = {};
  const personal = {};
  for (const k of Object.keys(all || {})) {
    if (isPersonalAssessment(k)) personal[k] = all[k];
    else shared[k] = all[k];
  }
  return { shared, personal };
}

// The shared half for a household, with a migration fallback.
//
// Shared answers used to live in each member's own responses:<email> record.
// Reading only the household blob would make every one of them look unanswered
// the moment this shipped, so anything missing from the blob is recovered from
// the members' own records, newest wins. The next save of that module writes it
// to the household blob and the fallback stops mattering for it.
async function loadSharedModules(env, household, members) {
  const shared = await loadModules(env, await env.PORTAL_KV.get(hhResponsesKey(household.id)));
  for (const m of members) {
    let mine;
    try {
      mine = await loadModules(env, await env.PORTAL_KV.get(`responses:${m}`));
    } catch {
      continue; // one unreadable member record must not sink the whole read
    }
    for (const [k, v] of Object.entries(mine)) {
      if (isPersonalAssessment(k)) continue;
      const have = shared[k];
      if (!have) { shared[k] = v; continue; }
      // Both exist — keep whichever was updated last.
      if (String(v && v.updatedAt || '') > String(have.updatedAt || '')) shared[k] = v;
    }
  }
  return shared;
}

// { shared, personal, members, household } for one client. Personal is only ever
// that client's own; shared is the household's (or their own, when they are in
// no household and there is nothing to share with).
async function loadAssessmentsFor(env, email) {
  const { members, household } = await householdPortalMembers(env, email);
  const own = await loadModules(env, await env.PORTAL_KV.get(`responses:${email}`));
  const { shared: ownShared, personal } = splitModules(own);
  if (!household) return { shared: ownShared, personal, members, household: null };
  return { shared: await loadSharedModules(env, household, members), personal, members, household };
}

// One flat map, the shape every existing consumer expects (the client's form
// populators, the advisor's result renderers). Personal wins on key collision,
// though the two sets are disjoint by construction.
async function effectiveModulesFor(env, email) {
  const { shared, personal } = await loadAssessmentsFor(env, email);
  return { ...shared, ...personal };
}

// The household's shared assessments plus every member's personal ones, so the
// portal can show a spouse's risk profile alongside the shared work.
async function handleGetAssessments(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);

  const { shared, members, household } = await loadAssessmentsFor(env, email);
  const personalByMember = {};
  for (const m of members) {
    try {
      personalByMember[m] = splitModules(await loadModules(env, await env.PORTAL_KV.get(`responses:${m}`))).personal;
    } catch {
      personalByMember[m] = {};
    }
  }
  return json({
    // `modules` keeps the old flat shape (this caller's effective set) so
    // anything still reading it behaves; shared/personalByMember are what the
    // portal renders from.
    modules: { ...shared, ...(personalByMember[email] || {}) },
    shared,
    personalByMember,
    personalKeys: [...PERSONAL_ASSESSMENTS],
    householdId: (household && household.id) || '',
    you: email,
  }, 200, cors);
}

async function handleSaveAssessment(request, env, cors, moduleName) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);

  // Own-property lookup only: the route regex admits any lowercase word, and a
  // plain index would resolve inherited keys like 'constructor' into a callable
  // that bypasses validation entirely.
  const validator = Object.prototype.hasOwnProperty.call(MODULE_VALIDATORS, moduleName)
    ? MODULE_VALIDATORS[moduleName]
    : null;
  if (!validator) return json({ error: 'Unknown assessment module' }, 404, cors);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);

  const result = validator(body);
  if (result.error) return json({ error: result.error }, 400, cors);

  // Which member's assessment this is, for the PERSONAL ones only. A shared
  // household portal lets one member open another's risk profile, so that save
  // has to land on the ORIGINAL owner's record — writing it to the caller
  // instead would fork a second copy and leave the spouse's own answers stale.
  //
  // Validated against the caller's household, NOT taken on trust: without this
  // check `owner` would let any authenticated client write assessment answers
  // into any other client's record by naming their address.
  const { members, household } = await householdPortalMembers(env, email);
  const requested = String((body && body.owner) || '').trim().toLowerCase();
  let owner = email;
  if (requested && requested !== email) {
    if (!members.includes(requested)) {
      return json({ error: 'That assessment does not belong to your household' }, 403, cors);
    }
    owner = requested;
  }

  // Where this module lives. A shared module goes to the ONE household record —
  // `owner` is meaningless for it, since there is only one copy and every member
  // edits that. A personal module goes to its owner's own record. A client in no
  // household keeps everything in their own record, exactly as before.
  const shared = !isPersonalAssessment(moduleName) && !!household;
  const storeKey = shared ? hhResponsesKey(household.id) : `responses:${owner}`;
  // For a shared module the pre-change answer may still be sitting in a member's
  // own record, so read through the same fallback the GET uses. Otherwise the
  // first save after this shipped would report firstCompletion and re-open a
  // review task for something the client already finished.
  const modules = shared
    ? await loadSharedModules(env, household, members)
    : await loadModules(env, await env.PORTAL_KV.get(storeKey));
  const firstCompletion = !modules[moduleName];
  modules[moduleName] = { ...result.data, updatedAt: new Date().toISOString() };

  if (shared) {
    // Only the shared half belongs in the household record; a member's personal
    // answers recovered by the fallback must not be copied into it.
    await env.PORTAL_KV.put(storeKey, await encryptJSON(env, { modules: splitModules(modules).shared }));
  } else {
    await env.PORTAL_KV.put(storeKey, await encryptJSON(env, { modules }));
  }

  // CRM history + automation: record the event, and the FIRST completion of a
  // module opens a review task for the advisor (deduped by marker, so
  // re-saves/edits never pile up duplicates). Logged against the OWNER, so the
  // advisor's timeline shows whose assessment changed, with `by` naming who
  // actually filled it in when that was a different member.
  // A shared module has no owner, so it is attributed to whoever actually filled
  // it in. A personal one is attributed to its owner, with filledInBy naming the
  // member who typed it when that was someone else.
  const attributedTo = shared ? email : owner;
  await logTimeline(env, attributedTo, firstCompletion ? 'assessment-completed' : 'assessment-updated', 'client', {
    module: moduleName,
    ...(shared ? { household: true } : {}),
    ...(!shared && owner !== email ? { filledInBy: email } : {}),
  });
  if (firstCompletion) {
    // Keyed to whoever it is attributed to, not blindly to the caller: for a
    // personal module the advisor is reviewing THAT member's assessment, and
    // using the caller would open the task against the wrong client whenever one
    // member completed another's.
    await maybeAutoTask(env, `review-assessment-${moduleName}`, attributedTo, {
      title: `Review ${moduleName} assessment - ${attributedTo}`,
      description: `The ${moduleName} assessment was completed`
        + `${shared ? ' for this household' : ' for this client'}`
        + `${!shared && owner !== email ? ` by ${email}` : ''}. Review their responses.`,
      category: 'review',
    });
  }
  // `owner`/`shared` come back so the portal knows whether to patch the household
  // copy or one member's, instead of assuming it was the caller's.
  return json({
    module: modules[moduleName],
    modules: await effectiveModulesFor(env, email),
    owner: shared ? '' : owner,
    shared,
  }, 200, cors);
}

// ---------- Module assignments ----------
// Admins can restrict which modules a client sees. An assignment record is a
// JSON array of assignable keys stored under assignments:<email>. No record
// (null) means "everything is visible" — so existing clients and brand-new
// registrations are never locked out of an empty portal until an admin
// deliberately narrows the list. Assignable keys are the 17 assessment modules
// plus the New Client Onboarding wizard (a link, not a stored module).
const ONBOARDING_WIZARD_KEY = 'onboardingWizard';
const ASSIGNABLE_KEYS = [...Object.keys(MODULE_VALIDATORS), ONBOARDING_WIZARD_KEY];

function loadAssignments(raw) {
  if (!raw) return null; // null = all modules visible (default)
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k) => ASSIGNABLE_KEYS.includes(k)) : null;
  } catch {
    return null;
  }
}

// Per member, plus a household union. A shared portal has to show a module if
// ANY member is assigned it — otherwise a spouse assigned something the caller
// isn't would have their own work hidden from the portal they share.
//
// A single null (= "no record, everything visible") makes the whole union null,
// because one member with no assignment record means everything is visible to
// the household by the same rule that applies to them individually.
async function handleGetAssignments(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);
  const { members } = await householdPortalMembers(env, email);
  const byMember = {};
  let union = [];
  let anyUnrestricted = false;
  for (const m of members) {
    // A household record can include people who have never created a portal
    // account. They do not have work in the portal and must not turn a missing
    // assignment record into the legacy "everything is visible" default.
    const hasAccount = !!(await env.PORTAL_KV.get(`user:${m}`));
    const list = hasAccount
      ? loadAssignments(await env.PORTAL_KV.get(`assignments:${m}`))
      : [];
    byMember[m] = list;
    if (list === null) anyUnrestricted = true;
    else for (const k of list) if (!union.includes(k)) union.push(k);
  }
  return json({
    // `assignments` keeps the old shape (the union) so existing callers and the
    // gate checks behave; byMember is what a shared portal filters each member's
    // own grid with.
    assignments: anyUnrestricted ? null : union,
    byMember,
    you: email,
  }, 200, cors);
}

async function handleAdminSetAssignments(request, env, cors, rawEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);

  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Invalid client email' }, 400, cors);
  if (!(await contactBelongsToWorkspace(env, email, workspace))) return json({ error: 'Client not found in this workspace' }, 404, cors);
  const exists = await env.PORTAL_KV.get(`user:${email}`);
  if (!exists) return json({ error: 'Unknown client' }, 404, cors);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.assignments)) {
    return json({ error: 'assignments must be an array of module keys' }, 400, cors);
  }
  // Keep only known keys, de-duplicated and in the canonical order.
  const set = new Set(body.assignments.filter((k) => ASSIGNABLE_KEYS.includes(k)));
  const clean = ASSIGNABLE_KEYS.filter((k) => set.has(k));

  await env.PORTAL_KV.put(`assignments:${email}`, JSON.stringify(clean));
  await logAudit(env, adminEmail, 'set-assignments', { client: email, assignments: clean });
  await logTimeline(env, email, 'assignments-changed', adminEmail, { count: clean.length });
  return json({ assignments: clean }, 200, cors);
}

// ---------- Authenticated client onboarding ----------
// Every onboarding is bound to the signed-in portal account as well as a
// per-session write token. The token prevents one browser session from editing
// another; client auth prevents a caller from claiming somebody else's email.

const ONBOARDING_ID_PATTERN = /^BLA-ONB-\d{4}-(?:\d{4}|[a-f0-9]{16})$/;
const ONBOARDING_MAX_BYTES = 100_000;

function isValidSignatureDataUrl(value) {
  if (typeof value !== 'string' || value.length > 90_000) return false;
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  // A PNG signature must have the standard eight-byte signature. Checking the
  // encoded prefix avoids decoding attacker-controlled data in the Worker.
  return match[1].startsWith('iVBORw0KGgo');
}

async function handleOnboardingStart(request, env, cors) {
  const clientEmail = await getSessionEmail(request, env);
  if (!clientEmail) return json({ error: 'Sign in to the client portal before starting onboarding' }, 401, cors);
  if (!(await checkRateLimit(env, 'onboardingStart', clientIp(request)))) {
    return json({ error: 'Too many onboarding sessions started. Please try again later.' }, 429, cors);
  }

  // Random ids avoid the non-atomic KV counter race and are not enumerable.
  const onboardingId = `BLA-ONB-${new Date().getFullYear()}-${randomHex(8)}`;

  const writeToken = randomHex(24);
  await env.PORTAL_KV.put(`onboarding_secret:${onboardingId}`, writeToken, {
    expirationTtl: ONBOARDING_TTL_SECONDS,
  });

  const record = {
    onboardingId,
    startTime: new Date().toISOString(),
    completionTime: null,
    currentStep: 0,
    clientEmail,
    data: {},
    deleted: false,
    updatedAt: new Date().toISOString(),
  };
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record));
  return json({ onboardingId, writeToken, startTime: record.startTime }, 201, cors);
}

async function handleOnboardingSave(request, env, cors, onboardingId, ctx) {
  if (!ONBOARDING_ID_PATTERN.test(onboardingId)) {
    return json({ error: 'Invalid onboarding id' }, 400, cors);
  }

  const providedToken = request.headers.get('X-Onboarding-Token') || '';
  const expectedToken = await env.PORTAL_KV.get(`onboarding_secret:${onboardingId}`);
  if (!expectedToken || !timingSafeEqual(providedToken, expectedToken)) {
    return json({ error: 'Invalid or missing onboarding write token' }, 401, cors);
  }

  const existingRaw = await env.PORTAL_KV.get(`onboarding:${onboardingId}`);
  if (!existingRaw) {
    return json({ error: 'Unknown onboarding id — call /api/onboarding/start first' }, 404, cors);
  }
  const existing = JSON.parse(existingRaw);
  const sessionEmail = await getSessionEmail(request, env);
  const legacyEmail = onboardingRecordEmail(existing);
  const boundEmail = String(existing.clientEmail || legacyEmail || '').toLowerCase();
  if (!sessionEmail || (boundEmail && boundEmail !== sessionEmail)) {
    return json({ error: 'This onboarding session does not belong to your portal account' }, 403, cors);
  }
  if (existing.deleted) {
    return json({ error: 'This onboarding record has been removed' }, 410, cors);
  }

  const text = await request.text();
  if (text.length > ONBOARDING_MAX_BYTES) {
    return json({ error: 'Payload too large' }, 413, cors);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, cors);
  }
  if (!body || body.onboardingId !== onboardingId || !body.data || typeof body.data !== 'object') {
    return json({ error: 'Body must include a matching onboardingId and a data object' }, 400, cors);
  }

  const record = {
    onboardingId,
    startTime: existing.startTime,
    completionTime: typeof body.completionTime === 'string' ? body.completionTime : existing.completionTime,
    currentStep: Number.isInteger(body.currentStep) ? body.currentStep : existing.currentStep,
    clientEmail: sessionEmail,
    data: body.data,
    deleted: false,
    updatedAt: new Date().toISOString(),
  };
  // CRM history + automation on state transitions (not on every save). The
  // client identity comes from the wizard's own profile/consent emails; when
  // neither is present yet there is nobody to attach history to, so skip.
  const d = record.data || {};
  const submittedEmails = [d.profile && d.profile.email, d.consent && d.consent.email]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  if (submittedEmails.some((value) => value !== sessionEmail)) {
    return json({ error: 'Onboarding email must match the signed-in portal account' }, 400, cors);
  }
  const signature = d.agreement && d.agreement.signatureDataUrl;
  if (signature && !isValidSignatureDataUrl(signature)) {
    return json({ error: 'The captured signature is not a valid PNG image' }, 400, cors);
  }
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record));
  const clientEmail = sessionEmail;
  if (isValidEmail(clientEmail)) {
    const justCompleted = record.completionTime && !existing.completionTime;
    const prevSigned = !!(existing.data && existing.data.agreement && existing.data.agreement.signatureDataUrl);
    const nowSigned = !!(d.agreement && d.agreement.signatureDataUrl);
    if (justCompleted) {
      await logTimeline(env, clientEmail, 'onboarding-completed', 'client', { onboardingId });
      await maybeAutoTask(env, `review-onboarding-${onboardingId}`, clientEmail, {
        title: `Review completed onboarding ${onboardingId}`,
        description: `${clientEmail} finished the onboarding workflow. Review the submission.`,
        category: 'onboarding',
      });
    }
    if (nowSigned && !prevSigned) {
      await logTimeline(env, clientEmail, 'agreement-signed', 'client', { onboardingId });
      await maybeAutoTask(env, `open-account-${onboardingId}`, clientEmail, {
        title: `Open account - agreement signed (${onboardingId})`,
        description: `${clientEmail} signed the advisory agreement. Begin account opening.`,
        category: 'onboarding',
      });
      // Best-effort, in the background: must never delay or fail the client's
      // save request, which is what THEY are waiting on right now. If this
      // throws, the admin's manual "File to Client Documents" button on the
      // Documents tab is still there as a fallback — nothing here is the only
      // way this ever gets filed.
      const filingTask = autoFileSignedAgreement(env, onboardingId, clientEmail, record.data)
        .catch((err) => console.error('Auto-file to SharePoint failed for', onboardingId, err));
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(filingTask);
      // A SEPARATE background task, not folded into the SharePoint filing above:
      // a Graph outage must never stop this simple KV write, and a signature on
      // a date the server can't parse must never stop the filing.
      const keyDocTask = recordAdvisoryAgreementDate(env, clientEmail, d.agreement.signedAt)
        .catch((err) => console.error('Recording the advisory agreement date failed for', onboardingId, err));
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(keyDocTask);
    }
    // The CRM follows the wizard: mid-workflow the person is 'onboarding', and
    // finishing hands them to Contacts as a live client. Runs on every save so
    // a contact record exists from the first step that carries an email.
    await syncOnboardingContact(env, clientEmail, record);
  }
  return json({ ok: true, updatedAt: record.updatedAt }, 200, cors);
}

// Mirror an onboarding record's state onto the person's CRM contact record,
// creating it if the wizard is the first thing that ever knew about them.
//
// Status is only ever moved FORWARD along the wizard's own path
// (missing/prospect -> onboarding -> active). An advisor who has already
// categorized someone as 'active' or 'inactive' outranks the wizard — a
// returning client re-running onboarding must not be demoted, and a
// deliberately deactivated contact must not be revived. Best-effort: a failure
// here never blocks the client's save.
async function syncOnboardingContact(env, email, record) {
  try {
    const desired = record.completionTime ? 'active' : 'onboarding';
    const allowedFrom = desired === 'active' ? ['prospect', 'onboarding'] : ['prospect'];
    const existing = await decryptToObject(env, await env.PORTAL_KV.get(`contact:${email}`));

    const d = record.data || {};
    const p = d.profile || {};
    const c = d.consent || {};
    const wizardName = [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || String(c.name || '').trim();

    let contact;
    if (!existing) {
      contact = { email, status: desired, createdAt: new Date().toISOString() };
    } else {
      contact = { ...existing, email };
      if (allowedFrom.includes(existing.status || 'prospect')) contact.status = desired;
    }
    // The wizard fills a blank name; it never overwrites what an advisor typed.
    if (wizardName && !contact.name) contact.name = wizardName.slice(0, 200);
    if (existing && contact.status === existing.status && contact.name === existing.name) return;

    contact.updatedAt = new Date().toISOString();
    // Push before persisting, same as the admin edit path, so the SharePoint
    // mirror can't pull a stale Status back over this change.
    contact = await pushContactToSharePoint(env, contact);
    await env.PORTAL_KV.put(`contact:${email}`, await encryptJSON(env, contact));
  } catch {
    // swallow — CRM mirroring is best-effort, the submission itself is saved
  }
}


// Soft delete: mark the record and give it (and its write secret) a 30-day TTL
// so it can be restored within that window, then auto-purges. No hard delete
// from the admin UI, so a misclick isn't instantly destructive.
async function handleAdminDeleteOnboarding(request, env, cors, onboardingId) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  if (!ONBOARDING_ID_PATTERN.test(onboardingId)) return json({ error: 'Invalid onboarding id' }, 400, cors);

  const raw = await env.PORTAL_KV.get(`onboarding:${onboardingId}`);
  if (!raw) return json({ error: 'Not found' }, 404, cors);
  const record = JSON.parse(raw);
  if (!(await onboardingBelongsToWorkspace(env, record, workspace))) return json({ error: 'Not found' }, 404, cors);
  record.deleted = true;
  record.deletedAt = new Date().toISOString();
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record), {
    expirationTtl: ONBOARDING_TTL_SECONDS,
  });
  await logAudit(env, adminEmail, 'delete-onboarding', { onboardingId });
  return json({ ok: true, deletedAt: record.deletedAt }, 200, cors);
}

async function handleAdminRestoreOnboarding(request, env, cors, onboardingId) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  if (!ONBOARDING_ID_PATTERN.test(onboardingId)) return json({ error: 'Invalid onboarding id' }, 400, cors);

  const raw = await env.PORTAL_KV.get(`onboarding:${onboardingId}`);
  if (!raw) return json({ error: 'Not found or already purged' }, 404, cors);
  const record = JSON.parse(raw);
  if (!(await onboardingBelongsToWorkspace(env, record, workspace))) return json({ error: 'Not found' }, 404, cors);
  record.deleted = false;
  delete record.deletedAt;
  // Re-put with no TTL so it stops counting down toward purge.
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record));
  await logAudit(env, adminEmail, 'restore-onboarding', { onboardingId });
  return json({ ok: true }, 200, cors);
}

async function handleAdminOnboarding(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);

  const records = [];
  let cursor;
  do {
    const page = await env.PORTAL_KV.list({ prefix: 'onboarding:', cursor });
    for (const key of page.keys) {
      const raw = await env.PORTAL_KV.get(key.name);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw);
        if (await onboardingBelongsToWorkspace(env, record, workspace)) records.push(record);
      } catch {}
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);

  records.sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));
  return json({ records, workspace }, 200, cors);
}

function onboardingRecordEmail(record) {
  const data = (record && record.data) || {};
  return String(
    (record && record.clientEmail)
    || (data.profile && data.profile.email)
    || (data.consent && data.consent.email)
    || ''
  ).trim().toLowerCase();
}

async function onboardingBelongsToWorkspace(env, record, workspace) {
  const email = onboardingRecordEmail(record);
  // A submission that has not captured an email yet is part of the legacy,
  // unassigned intake queue and therefore remains in Frank's workspace.
  return email
    ? contactBelongsToWorkspace(env, email, workspace)
    : workspace === FRANK_ADMIN_EMAIL;
}

// Returns a page of audit entries (who did what, when), newest first. Because
// keys use an inverted timestamp (see logAudit), the newest entries sort first,
// so a bounded KV list returns them directly — the cost is flat regardless of
// how large the log grows. Pass the returned `cursor` back as ?cursor=... to
// fetch the next (older) page; `hasMore`/`cursor` are null once exhausted.
async function handleAdminAudit(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  // Audit entries predate workspace ownership and can contain client names and
  // emails from anywhere in the firm. Until every entry carries a workspace,
  // the safe view is the shared-manager-only firm log.
  if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can view the firm audit log' }, 403, cors);

  const AUDIT_PAGE_SIZE = 10;
  const cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  const listOpts = { prefix: 'audit:', limit: AUDIT_PAGE_SIZE };
  if (cursor) listOpts.cursor = cursor;
  const page = await env.PORTAL_KV.list(listOpts);

  const entries = [];
  for (const key of page.keys) {
    const raw = await env.PORTAL_KV.get(key.name);
    if (!raw) continue;
    try {
      entries.push(JSON.parse(raw));
    } catch {}
  }

  // Guarantee display order even if legacy (non-inverted) keys are mixed in.
  entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return json(
    {
      entries,
      limit: AUDIT_PAGE_SIZE,
      hasMore: !page.list_complete,
      cursor: page.list_complete ? null : page.cursor,
    },
    200,
    cors
  );
}

// ---------- SharePoint Contacts sync ----------
// Fetch contacts from the BlueLineCRM SharePoint list and upsert them into KV.
// Pull-only: SharePoint is a read source, app edits are the source of truth.

// Client-credentials tokens are valid for about an hour, and every Graph call
// used to mint a fresh one — two subrequests per call instead of one. That was
// merely wasteful for a single meeting push; it halves how many compliance items
// fit in one batch (see handleAdminComplianceOutlookSync), which is what made it
// worth fixing. Cached in module scope, so it survives across requests handled by
// the same isolate and is dropped whenever that isolate is recycled.
//
// Keyed by tenant + client id so a config change can't serve a token minted for
// the previous credentials. Expiry is taken from the response with a 60s margin
// rather than assumed.
let graphTokenCache = null;

async function getGraphToken(env) {
  const cacheKey = `${env.OUTLOOK_TENANT_ID}:${env.OUTLOOK_CLIENT_ID}`;
  if (graphTokenCache && graphTokenCache.key === cacheKey && graphTokenCache.expires > Date.now()) {
    return graphTokenCache.token;
  }
  const body = new URLSearchParams({
    client_id: env.OUTLOOK_CLIENT_ID,
    client_secret: env.OUTLOOK_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const response = await fetch('https://login.microsoftonline.com/' + env.OUTLOOK_TENANT_ID + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error('Failed to get Graph token: ' + response.statusText);
  const data = await response.json();
  const ttl = Number(data.expires_in);
  graphTokenCache = {
    key: cacheKey,
    token: data.access_token,
    expires: Date.now() + (Number.isFinite(ttl) && ttl > 120 ? (ttl - 60) * 1000 : 0),
  };
  return data.access_token;
}

// Scalar contact fields SharePoint owns and can overwrite the app with, in
// either direction of sync. importantDates, archived/archivedAt/archivedBy,
// and sharePointItemId are deliberately NOT in this list — they exist only in
// the app (SharePoint has no columns for them), so pulling must never let a
// bare object literal without them stand in for the whole record, and pushing
// must never send them anywhere.
function contactFieldsFromSharePoint(fields) {
  return {
    name: String(fields.Name || '').trim().slice(0, 200),
    preferredName: String(fields.PreferredName || '').trim().slice(0, 200),
    status: ['prospect', 'onboarding', 'active', 'inactive'].includes(String(fields.Status || '').trim().toLowerCase())
      ? String(fields.Status).trim().toLowerCase()
      : 'prospect',
    household: String(fields.Household || '').trim().slice(0, 200),
    advisor: String(fields.Advisor || '').trim().slice(0, 200),
    phone: String(fields.Phone || '').trim().slice(0, 50),
    workEmail: String(fields.WorkEmail || '').trim().toLowerCase().slice(0, 200),
    workPhone: String(fields.WorkPhone || '').trim().slice(0, 50),
    address: String(fields.Address || '').trim().slice(0, 300),
    gender: String(fields.Gender || '').trim().slice(0, 40),
    // Tags is "Multiple lines of text" in SharePoint — a plain string, not a
    // multi-value column — so it arrives comma-separated ("client, vip"),
    // never as an array. Array.isArray(fields.Tags) was always false against
    // a real value from this column type, meaning every tag pulled from
    // SharePoint was silently discarded as [] regardless of content.
    tags: String(fields.Tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.slice(0, 40))
      .slice(0, 20),
  };
}

function contactFieldsToSharePoint(record) {
  return {
    // SharePoint's built-in Title column is required on most list templates.
    // The pull side never reads it (contacts are keyed by Email, not Title),
    // but a create/update that omits a required column is rejected outright —
    // silently, from this app's point of view, since the push is best-effort
    // and only logs to the Worker's own console. Falls back to the email so a
    // brand-new contact with no name yet still satisfies the requirement.
    Title: record.name || record.email,
    Email: record.email,
    Name: record.name || '',
    PreferredName: record.preferredName || '',
    Status: record.status || 'prospect',
    Household: record.household || '',
    Advisor: record.advisor || '',
    Phone: record.phone || '',
    WorkEmail: record.workEmail || '',
    WorkPhone: record.workPhone || '',
    Address: record.address || '',
    Gender: record.gender || '',
    // Multiple lines of text, not a multi-value column — send comma-joined
    // text, matching the format the read side now parses and the format the
    // contact modal's own Tags input already uses ("client, vip").
    Tags: (record.tags || []).join(', '),
  };
}

// Pull-with-merge, both ways per record: whichever side has the newer
// Modified/updatedAt wins for the SharePoint-owned scalar fields. This used
// to be an unconditional replace with a bare object literal that had no
// importantDates/archived/sharePointItemId at all -- meaning every contact's
// important dates and archived flag were being erased on every run of this
// (previously every-minute) sync, regardless of which side had actually
// changed. Fixed here rather than as separate work, since a correct two-way
// merge needs the same "don't clobber app-owned fields" logic either way.
async function syncSharePointContacts(env) {
  const token = await getGraphToken(env);
  const siteId = env.SHAREPOINT_SITE_ID;
  const listId = env.SHAREPOINT_LIST_ID;

  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?expand=fields`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error('Failed to fetch SharePoint items: ' + response.statusText);
  const data = await response.json();

  let synced = 0;
  let skippedNewerLocal = 0;
  if (data.value && Array.isArray(data.value)) {
    for (const item of data.value) {
      const fields = item.fields || {};
      const email = fields.Email && String(fields.Email).trim().toLowerCase();
      if (!email) continue; // Skip items without an email

      const spModified = fields.Modified ? new Date(fields.Modified) : null;
      const existing = await decryptToObject(env, await env.PORTAL_KV.get(`contact:${email}`));

      // An app-side edit newer than what SharePoint has on file hasn't been
      // pushed yet (or the push failed) -- pulling now would throw that edit
      // away. Skip; the next push attempt (or a manual retry) reconciles it.
      if (existing && existing.updatedAt && spModified) {
        const localUpdated = new Date(existing.updatedAt);
        if (localUpdated.getTime() >= spModified.getTime()) {
          skippedNewerLocal += 1;
          continue;
        }
      }

      const contact = {
        ...(existing || { createdAt: fields.Created ? new Date(fields.Created).toISOString() : new Date().toISOString() }),
        email,
        ...contactFieldsFromSharePoint(fields),
        sharePointItemId: item.id,
        updatedAt: spModified ? spModified.toISOString() : new Date().toISOString(),
      };

      await env.PORTAL_KV.put(`contact:${email}`, await encryptJSON(env, contact));
      synced += 1;
    }
  }

  return { synced, skippedNewerLocal, timestamp: new Date().toISOString() };
}

// Push a locally-edited contact out to SharePoint, with the same "most recent
// edit wins" rule the pull side uses: if SharePoint's Modified stamp for this
// contact is already newer than what the app knew about when the edit was
// made, the just-made app edit is discarded in favor of adopting SharePoint's
// version (returned to the caller so the API response reflects what actually
// got saved, rather than silently pretending the edit succeeded). Otherwise
// the app's edit is pushed. Best-effort: any failure returns the record
// unchanged so a SharePoint outage never blocks saving a contact.
//
// Title/Email are never candidates for exclusion below: Title satisfies
// SharePoint's built-in required column, Email is this app's identity key.
const CONTACT_OPTIONAL_SP_FIELDS = [
  'Name', 'PreferredName', 'Status', 'Household', 'Advisor',
  'Phone', 'WorkEmail', 'WorkPhone', 'Address', 'Gender', 'Tags',
];
const SP_EXCLUDED_FIELDS_KEY = 'sharepoint:contact-fields:excluded';

// This app has no visibility into the Contacts list's actual column types —
// unlike the Households list, which this app defined from scratch, the
// Contacts list already existed. A field this app treats as plain text may
// really be a SharePoint Choice column (rejects a value outside its defined
// options), a Person/Group lookup (rejects a plain string), or Managed
// Metadata (rejects a plain string tag) — and Graph's 400 on a bad value
// never says which field. Rather than requiring a person to go check column
// types by hand every time this happens, isolate the offending field(s) by
// bisection and remember them, so the push still gets everything else
// through instead of failing outright on one bad column.
//
// `send(fieldsObj)` performs the actual HTTP call and returns {ok}. Returns
// the subset of `candidates` that SharePoint accepts together with `base`.
async function isolateAcceptedFields(send, base, candidates, allFields) {
  if (candidates.length === 0) return [];
  const attempt = { ...base };
  for (const key of candidates) attempt[key] = allFields[key];
  const result = await send(attempt);
  if (result.ok) return candidates; // whole slice works together
  if (candidates.length === 1) return []; // this one field is the problem
  const mid = Math.ceil(candidates.length / 2);
  const left = await isolateAcceptedFields(send, base, candidates.slice(0, mid), allFields);
  const right = await isolateAcceptedFields(send, base, candidates.slice(mid), allFields);
  return left.concat(right);
}

// Sends as much of `allFields` as SharePoint will accept. Tries everything
// first (so a schema fix on SharePoint's side is picked up automatically and
// clears the cached exclusion list); on failure, retries with the last-known
// bad fields already stripped; if that still fails, re-isolates from scratch
// (something new broke, or something old got fixed) and persists the result.
// Returns {ok, sentFields, excludedFields}.
async function sendContactFieldsResilient(env, send, allFields) {
  const base = { Title: allFields.Title, Email: allFields.Email };
  const optional = Object.fromEntries(CONTACT_OPTIONAL_SP_FIELDS.map((k) => [k, allFields[k]]));

  const full = { ...base, ...optional };
  let result = await send(full);
  if (result.ok) {
    await env.PORTAL_KV.delete(SP_EXCLUDED_FIELDS_KEY).catch(() => {});
    return { ok: true, sentFields: full, excludedFields: [] };
  }

  let cachedExcluded = [];
  try {
    cachedExcluded = JSON.parse((await env.PORTAL_KV.get(SP_EXCLUDED_FIELDS_KEY)) || '[]');
  } catch {
    cachedExcluded = [];
  }
  if (cachedExcluded.length) {
    const reduced = { ...base };
    CONTACT_OPTIONAL_SP_FIELDS.filter((k) => !cachedExcluded.includes(k)).forEach((k) => (reduced[k] = allFields[k]));
    result = await send(reduced);
    if (result.ok) return { ok: true, sentFields: reduced, excludedFields: cachedExcluded };
  }

  // Fresh isolation: something changed since the cache was built (a newly
  // broken column, or a previously-broken one that's now fixed).
  const accepted = await isolateAcceptedFields(send, base, CONTACT_OPTIONAL_SP_FIELDS, optional);
  const excluded = CONTACT_OPTIONAL_SP_FIELDS.filter((k) => !accepted.includes(k));
  await env.PORTAL_KV.put(SP_EXCLUDED_FIELDS_KEY, JSON.stringify(excluded)).catch(() => {});
  if (excluded.length) {
    console.error(
      'SharePoint rejected these contact fields — likely a column type mismatch (Choice/Person/Managed Metadata) on the Contacts list. Excluding them from future pushes until the schema changes:',
      excluded.join(', ')
    );
  }
  const finalFields = { ...base };
  accepted.forEach((k) => (finalFields[k] = allFields[k]));
  const finalResult = await send(finalFields);
  return { ok: finalResult.ok, sentFields: finalFields, excludedFields: excluded };
}

async function pushContactToSharePoint(env, record) {
  if (!env.SHAREPOINT_LIST_ID) return record;
  try {
    const token = await getGraphToken(env);
    const siteId = env.SHAREPOINT_SITE_ID;
    const listId = env.SHAREPOINT_LIST_ID;

    // Fast path: the item id from a previous sync/push. Falls back to a
    // lookup by email for a contact that arrived via the original pull-only
    // sync (or whose stored id has since gone stale) — email is already this
    // app's natural key for a contact, so it's a reliable fallback match.
    let item = null;
    if (record.sharePointItemId) {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${record.sharePointItemId}?expand=fields`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) item = await res.json();
    }
    let lookupFailed = false;
    if (!item) {
      const escaped = record.email.replace(/'/g, "''");
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?expand=fields&$filter=fields/Email eq '${escaped}'`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            // Graph often rejects a $filter on a column that isn't indexed
            // unless this is set; harmless to send even if the column is
            // indexed or the tenant doesn't require it.
            Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly',
          },
        }
      );
      if (res.ok) {
        const found = await res.json();
        item = (found.value || [])[0] || null;
      } else {
        // Genuinely don't know whether a row already exists — proceeding to
        // "create" below would risk minting a duplicate every time this
        // contact is edited, for as long as the lookup keeps failing. Bail
        // out instead; the error is visible in the Worker's own logs.
        lookupFailed = true;
        console.error('Failed to look up contact in SharePoint by email:', res.status, await res.text());
      }
    }
    if (lookupFailed) return record;

    if (item) {
      const spModified = item.fields.Modified ? new Date(item.fields.Modified) : null;
      const ourKnown = record.updatedAt ? new Date(record.updatedAt) : null;
      // >1s guards against ordinary clock/formatting rounding reading as a
      // conflict on every single push.
      if (spModified && ourKnown && spModified.getTime() - ourKnown.getTime() > 1000) {
        return {
          ...record,
          ...contactFieldsFromSharePoint(item.fields),
          sharePointItemId: item.id,
          updatedAt: spModified.toISOString(),
        };
      }
      const allFields = contactFieldsToSharePoint(record);
      let lastErr = null;
      const patchUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${item.id}/fields`;
      const sendPatch = async (fieldsObj) => {
        const res = await fetch(patchUrl, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(fieldsObj),
        });
        if (!res.ok) lastErr = { status: res.status, text: await res.text() };
        return { ok: res.ok };
      };
      const { ok, sentFields } = await sendContactFieldsResilient(env, sendPatch, allFields);
      if (!ok) {
        console.error('Failed to push contact to SharePoint even with reduced fields:', lastErr && lastErr.status, lastErr && lastErr.text, 'attempted:', JSON.stringify(sentFields));
        return record;
      }
      return { ...record, sharePointItemId: item.id, updatedAt: new Date().toISOString() };
    }

    // No SharePoint item for this email yet — create one. Closes the gap
    // where a brand-new "+ New Person" contact never reached SharePoint at all.
    //
    // Unlike the update path above, this can't reuse sendContactFieldsResilient
    // directly for the CREATE call itself — POST mints a new row every time
    // it's called, so bisecting a bad field by repeating the create would
    // leave a duplicate row behind for every attempt. Instead: create once
    // with only Title/Email (always required, essentially guaranteed to be
    // accepted), then push everything else onto that single row via PATCH —
    // which, unlike POST, is safe to retry as many times as isolation needs.
    const allFields = contactFieldsToSharePoint(record);
    const base = { Title: allFields.Title, Email: allFields.Email };
    const createUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: base }),
    });
    if (!createRes.ok) {
      console.error('Failed to create contact in SharePoint:', createRes.status, await createRes.text(), 'payload:', JSON.stringify(base));
      return record;
    }
    const created = await createRes.json().catch(() => ({}));
    const newId = created.id || null;
    if (!newId) {
      console.error('Contact created in SharePoint but no item id came back; cannot push its other fields onto it yet — the next edit will find it by email and retry.');
      return { ...record, updatedAt: new Date().toISOString() };
    }

    let lastErr = null;
    const patchUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${newId}/fields`;
    const sendPatch = async (fieldsObj) => {
      const res = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fieldsObj),
      });
      if (!res.ok) lastErr = { status: res.status, text: await res.text() };
      return { ok: res.ok };
    };
    const { ok, sentFields } = await sendContactFieldsResilient(env, sendPatch, allFields);
    if (!ok) {
      console.error('Created the contact in SharePoint, but could not push its other fields even reduced:', lastErr && lastErr.status, lastErr && lastErr.text, 'attempted:', JSON.stringify(sentFields));
    }
    return {
      ...record,
      sharePointItemId: newId,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('Error pushing contact to SharePoint:', err);
    return record;
  }
}

// Push one note out to the SharePoint Notes list. The app is the source of
// truth for notes (opposite of contacts), so a push failure must never break
// note creation — log it and move on rather than throwing.
async function pushNoteToSharePoint(env, note) {
  try {
    const token = await getGraphToken(env);
    const url = `https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}/lists/${env.SHAREPOINT_NOTES_LIST_ID}/items`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          ClientEmail: note.client,
          NoteAuthor: note.author,
          Body: note.body,
          Tags: (note.tags || []).join(', '),
          Pinned: note.pinned ? 'Yes' : 'No',
        },
      }),
    });
    if (!response.ok) {
      console.error('Failed to push note to SharePoint:', response.status, await response.text());
    }
  } catch (err) {
    console.error('Error pushing note to SharePoint:', err);
  }
}

// Push a household's current state to the SharePoint Households list. Unlike
// note push (which always appends — a note is a permanent, individually
// meaningful record), this UPSERTS by the SharePoint item id captured on the
// first successful push and carried on the household record afterward as
// `sharePointItemId`. The whole point is a disaster-recovery mirror: if the
// Worker or KV is unavailable, an advisor opening SharePoint directly needs
// ONE current row per household, not a growing log of every edit.
//
// Requires a SharePoint list already created with these columns (Text unless
// noted): HouseholdId, Members (multi-line), Email, EmailType, AssignedTo,
// AdvisorRep, ContactType, Tags, Background (multi-line), Status,
// Archived (Yes/No text), UpdatedAsOf. Title (the list's built-in column)
// holds the household name. Skips silently if SHAREPOINT_HOUSEHOLDS_LIST_ID
// isn't configured, so this is safe to ship before that list exists.
//
// Best-effort like note push: a failure here must never break saving the
// household record itself, so every error is caught and logged, never thrown.
// Scalar household fields that round-trip safely from SharePoint. Members is
// deliberately excluded: on push it's written as a human-readable string like
// "Jane Smith (jane@example.com) — Head" for legibility during an outage, and
// reliably parsing arbitrary free-typed edits back into structured {email,
// role} pairs is a different, fragility-prone feature (a slightly reworded
// line, a removed dash, a typo'd role all become silent data loss). Members
// stays app-owned: editable here, mirrored outward, never read back.
function householdFieldsFromSharePoint(fields) {
  return {
    name: String(fields.Title || '').trim().slice(0, 200) || undefined,
    email: String(fields.Email || '').trim().toLowerCase().slice(0, 200),
    emailType: HOUSEHOLD_EMAIL_TYPES.includes(String(fields.EmailType || '').trim().toLowerCase())
      ? String(fields.EmailType).trim().toLowerCase()
      : '',
    assignedTo: String(fields.AssignedTo || '').trim().toLowerCase().slice(0, 200),
    advisorRep: String(fields.AdvisorRep || '').trim().slice(0, 200),
    contactType: String(fields.ContactType || '').trim().slice(0, 60),
    tags: String(fields.Tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20),
    background: String(fields.Background || '').trim().slice(0, 5000),
    status: CONTACT_STATUSES.includes(String(fields.Status || '').trim().toLowerCase())
      ? String(fields.Status).trim().toLowerCase()
      : 'active',
    archived: String(fields.Archived || '').trim().toLowerCase() === 'yes',
  };
}

// Push a household's current state to SharePoint, upserting by the stored
// item id, with the same "most recent edit wins" rule as contacts: if
// SharePoint's Modified stamp is already newer than what the app knew about,
// the app edit just made is discarded in favor of adopting SharePoint's
// scalar fields (Members excepted — see householdFieldsFromSharePoint)
// instead of overwriting SharePoint with now-stale app data.
async function pushHouseholdToSharePoint(env, household) {
  if (!env.SHAREPOINT_HOUSEHOLDS_LIST_ID) return household;
  try {
    const token = await getGraphToken(env);
    const siteId = env.SHAREPOINT_SITE_ID;
    const listId = env.SHAREPOINT_HOUSEHOLDS_LIST_ID;

    let item = null;
    if (household.sharePointItemId) {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${household.sharePointItemId}?expand=fields`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) item = await res.json();
    }

    if (item) {
      const spModified = item.fields.Modified ? new Date(item.fields.Modified) : null;
      const ourKnown = household.updatedAt ? new Date(household.updatedAt) : null;
      if (spModified && ourKnown && spModified.getTime() - ourKnown.getTime() > 1000) {
        return {
          ...household,
          ...Object.fromEntries(Object.entries(householdFieldsFromSharePoint(item.fields)).filter(([, v]) => v !== undefined)),
          sharePointItemId: item.id,
          updatedAt: spModified.toISOString(),
        };
      }
    }

    // Resolve each member's email to a name where we have one on file, so the
    // backup is legible to a person during an outage rather than a bare list
    // of addresses. Missing/undecryptable contacts just fall back to the email.
    const memberLines = await Promise.all(
      (household.members || []).map(async (m) => {
        let display = m.email;
        try {
          const c = await decryptToObject(env, await env.PORTAL_KV.get(`contact:${m.email}`));
          if (c && c.name) display = `${c.name} (${m.email})`;
        } catch {
          // undecryptable/missing contact — email alone is still useful
        }
        return `${display} — ${m.role}`;
      })
    );
    const fields = {
      Title: household.name,
      HouseholdId: household.id,
      Members: memberLines.join('\n'),
      Email: household.email || '',
      EmailType: household.emailType || '',
      AssignedTo: household.assignedTo || '',
      AdvisorRep: household.advisorRep || '',
      ContactType: household.contactType || '',
      Tags: (household.tags || []).join(', '),
      Background: household.background || '',
      Status: household.status || '',
      Archived: household.archived ? 'Yes' : 'No',
    };

    if (item) {
      const patchUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${item.id}/fields`;
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (patchRes.ok) {
        const updated = await patchRes.json().catch(() => ({}));
        return { ...household, sharePointItemId: item.id, updatedAt: updated.Modified || new Date().toISOString() };
      }
      // The row may have been removed on the SharePoint side independently of
      // the app (manual cleanup, list rebuilt) — recreate rather than fail.
      console.error('Failed to update household in SharePoint, recreating:', patchRes.status, await patchRes.text());
    }

    const createUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!createRes.ok) {
      console.error('Failed to create household in SharePoint:', createRes.status, await createRes.text());
      return household;
    }
    const created = await createRes.json().catch(() => ({}));
    return {
      ...household,
      sharePointItemId: created.id || null,
      updatedAt: (created.fields && created.fields.Modified) || new Date().toISOString(),
    };
  } catch (err) {
    console.error('Error pushing household to SharePoint:', err);
    return household;
  }
}

// Pull households from SharePoint, applying only to existing app records
// matched by HouseholdId and only when SharePoint's Modified is newer than
// the app's own updatedAt (mirrors syncSharePointContacts' rule). A row with
// no HouseholdId, or one that doesn't match any household in the app, is
// skipped rather than adopted as a new household: app-generated ids (hh-…)
// have no natural counterpart a freshly-typed SharePoint row could carry, so
// there is no safe way to originate a brand-new household from SharePoint
// alone the way a brand-new contact can originate from an email match.
async function syncSharePointHouseholds(env) {
  if (!env.SHAREPOINT_HOUSEHOLDS_LIST_ID) return { synced: 0, skipped: 0, skippedNewerLocal: 0, timestamp: new Date().toISOString() };
  const token = await getGraphToken(env);
  const siteId = env.SHAREPOINT_SITE_ID;
  const listId = env.SHAREPOINT_HOUSEHOLDS_LIST_ID;
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?expand=fields`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('Failed to fetch SharePoint household items: ' + response.statusText);
  const data = await response.json();

  let synced = 0;
  let skipped = 0;
  let skippedNewerLocal = 0;
  // Rows SharePoint reported as newer but whose SharePoint-owned fields already
  // match ours — the steady state after any app-side save, and the case that
  // must not write. See the note in the loop.
  let skippedNoChange = 0;
  for (const item of data.value || []) {
    const fields = item.fields || {};
    const hhId = String(fields.HouseholdId || '').trim();
    if (!hhId) { skipped += 1; continue; }
    const existing = await decryptToObject(env, await env.PORTAL_KV.get(`household:${hhId}`));
    if (!existing) { skipped += 1; continue; } // no app-side counterpart to apply this row to

    const spModified = fields.Modified ? new Date(fields.Modified) : null;
    if (existing.updatedAt && spModified) {
      const localUpdated = new Date(existing.updatedAt);
      if (localUpdated.getTime() >= spModified.getTime()) { skippedNewerLocal += 1; continue; }
    }

    // The timestamp guard above is NOT sufficient on its own, and this is where
    // key-document dates were being silently destroyed about a minute after
    // being set.
    //
    // Saving a household pushes it to SharePoint, which bumps that row's
    // Modified to now. This pull then runs within the minute, sees Modified as
    // newer than the copy it just read, and rebuilds the record from that copy.
    // KV is eventually consistent, so the copy read above can still be the
    // pre-save one — and rebuilding from a stale base wipes every field
    // SharePoint has no column for. Those fields are exactly the app-owned ones:
    // keyDocuments, kind, emailPrimary, members. The push having set Modified is
    // what makes the guard let a stale read through, so the two faults line up
    // precisely rather than cancelling out.
    //
    // The defence is to make the write conditional on SharePoint actually
    // carrying something different. In the steady state it does not: the app
    // pushed those very values moments ago, so the fields match and this skips,
    // and a skipped write cannot clobber anything. A row genuinely edited in
    // SharePoint still differs, so real edits still flow in.
    // undefined is stripped, not spread. householdFieldsFromSharePoint returns
    // `name: undefined` for a blank Title to mean "leave it alone", but object
    // spread COPIES an undefined value rather than skipping it — so spreading it
    // raw would blank a real household name from an empty SharePoint Title.
    // pushHouseholdToSharePoint already filters this on its own merge; the pull
    // never did.
    const spFields = Object.fromEntries(
      Object.entries(householdFieldsFromSharePoint(fields)).filter(([, v]) => v !== undefined)
    );
    // Re-read as late as possible too. It does not make KV strongly consistent,
    // but it shrinks the stale window from "however long this whole loop takes"
    // to a single get, and costs one read on a path that was about to write.
    const fresh = (await decryptToObject(env, await env.PORTAL_KV.get(`household:${hhId}`))) || existing;
    const changed = Object.entries(spFields).some(([k, v]) => (
      v !== undefined && JSON.stringify(fresh[k]) !== JSON.stringify(v)
    ));
    if (!changed) { skippedNoChange += 1; continue; }

    const record = {
      ...fresh,
      ...spFields,
      sharePointItemId: item.id,
      updatedAt: spModified ? spModified.toISOString() : new Date().toISOString(),
    };
    await env.PORTAL_KV.put(`household:${hhId}`, await encryptJSON(env, record));
    synced += 1;
  }
  return { synced, skipped, skippedNewerLocal, skippedNoChange, timestamp: new Date().toISOString() };
}

// Remove a household's backup row when the grouping itself is deleted in the
// app — an intentional delete should not leave a phantom row that reads as a
// still-current household if someone is looking at SharePoint during a later
// outage. Best-effort: never throws.
async function deleteHouseholdFromSharePoint(env, household) {
  if (!env.SHAREPOINT_HOUSEHOLDS_LIST_ID || !household || !household.sharePointItemId) return;
  try {
    const token = await getGraphToken(env);
    const url = `https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}/lists/${env.SHAREPOINT_HOUSEHOLDS_LIST_ID}/items/${household.sharePointItemId}`;
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) console.error('Failed to delete household from SharePoint:', res.status, await res.text());
  } catch (err) {
    console.error('Error deleting household from SharePoint:', err);
  }
}

// Mirror COMPLETED compliance items to a dedicated SharePoint list — a record
// of finished work, not a live copy of the tracker. Outstanding items stay in
// the app; what lands here is the evidence of what was actually signed off,
// which is also the part that most needs to survive the app being unavailable.
//
// Push-only, no pull: compliance items are managed entirely in this app (the
// checkboxes, the Complete button, the drawer), so unlike contacts there is no
// reason to ever edit one directly in SharePoint and no conflict to resolve.
//
// Requires a SharePoint list already created with these columns (Text unless
// noted): ComplianceId, WhatToDo (multi-line), DueDate, Frequency, Source,
// Mandated (Yes/No text), Owner, OwnerCompleted, Reviewer, ReviewerCompleted,
// Status, CompletedAt, Notes (multi-line). Title (the list's built-in column)
// holds the item name. Skips silently if SHAREPOINT_COMPLIANCE_LIST_ID isn't
// configured, so this ships safely before that list exists.
//
// The list may live on its own site — see complianceSiteId below. Both ids are
// discoverable without leaving the app: /api/admin/sharepoint/site?url=… turns
// a site address into its Graph id, and /api/admin/sharepoint/lists?site=<id>
// then names every list on it.
//
// Best-effort: any failure is logged and returns the item unchanged, so a
// SharePoint outage can never block saving a compliance item in the app.
// The compliance register can live on a DIFFERENT SharePoint site from the
// rest of the integration — a dedicated compliance site keeps the register off
// a general team site that other staff browse for unrelated reasons. Set
// SHAREPOINT_COMPLIANCE_SITE_ID to point it elsewhere; unset, it falls back to
// the main site, so this changes nothing for an existing deployment.
function complianceSiteId(env) {
  return env.SHAREPOINT_COMPLIANCE_SITE_ID || env.SHAREPOINT_SITE_ID;
}

async function pushComplianceToSharePoint(env, item) {
  if (!env.SHAREPOINT_COMPLIANCE_LIST_ID) return item;

  // ONLY COMPLETED ITEMS ARE MIRRORED. The list is a record of finished work,
  // not a live copy of the tracker.
  //
  // An item that is not (or no longer) complete must not just be skipped — if
  // it already has a row, that row has to go, or reopening a completed item
  // would leave SharePoint asserting it was signed off when it isn't. That is
  // the one way this mirror could actively mislead, so removal is handled here
  // rather than only on delete. Clearing sharePointItemId at the same time
  // means completing it again creates a fresh row instead of PATCHing an id
  // that no longer exists.
  if (complianceStatus(item) !== 'CLOSED') {
    if (!item.sharePointItemId) return item; // never mirrored; nothing to undo
    await deleteComplianceFromSharePoint(env, item);
    return { ...item, sharePointItemId: null };
  }

  try {
    const token = await getGraphToken(env);
    const siteId = complianceSiteId(env);
    const listId = env.SHAREPOINT_COMPLIANCE_LIST_ID;
    const fields = {
      Title: item.item,
      ComplianceId: item.id,
      WhatToDo: item.whatToDo || '',
      DueDate: item.dueDate || '',
      Frequency: item.frequency || '',
      Source: item.source || '',
      // The existing SharePoint column keeps its name so no list change is
      // needed; only the VALUE changes, from Yes/No to Required/Best practice,
      // so the mirror says what the app says.
      Mandated: item.requirement || (item.mandated ? 'Required' : 'Best practice'),
      // Sent only if the list has the column. SharePoint decides a column's
      // INTERNAL name when it's created and it doesn't always match what was
      // typed, so a display name of "ComplianceArea" is likely but not
      // guaranteed to be the field name Graph wants. sendComplianceFields
      // below retries without this key if the write is rejected, so a mismatch
      // costs one extra request rather than silently stopping every completed
      // item from mirroring — the failure mode that hid the Tags column bug.
      ComplianceArea: item.complianceArea || '',
      Owner: item.owner || '',
      OwnerCompleted: item.ownerCompleted || '',
      Reviewer: item.reviewer || '',
      ReviewerCompleted: item.reviewerCompleted || '',
      Status: complianceStatus(item),
      CompletedAt: item.completedAt || '',
      Notes: item.notes || '',
    };

    // Writes `fields`, and if Graph rejects it, writes again without the
    // optional keys. A column whose internal name differs from its display
    // name (or that hasn't been added yet) then costs one wasted request
    // instead of stopping the mirror entirely — the whole record still lands,
    // just without that one value.
    const OPTIONAL_FIELDS = ['ComplianceArea'];
    const sendFields = async (url, method, wrap) => {
      const attempt = async (payload) => fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(wrap ? { fields: payload } : payload),
      });
      let res = await attempt(fields);
      if (res.ok || !OPTIONAL_FIELDS.some((k) => k in fields)) return res;
      const rejected = await res.text();
      const reduced = { ...fields };
      OPTIONAL_FIELDS.forEach((k) => delete reduced[k]);
      const retry = await attempt(reduced);
      if (retry.ok) {
        console.error(
          `SharePoint rejected the compliance write including ${OPTIONAL_FIELDS.join(', ')} — `
          + 'succeeded without it, so the column is missing or its internal name differs from its display name. '
          + 'Response was:', rejected
        );
      }
      return retry;
    };

    if (item.sharePointItemId) {
      const patchUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${item.sharePointItemId}/fields`;
      const patchRes = await sendFields(patchUrl, 'PATCH', false);
      if (patchRes.ok) return { ...item, sharePointItemId: item.sharePointItemId };
      // The row may have been removed independently on the SharePoint side
      // (manual cleanup, list rebuilt) — recreate rather than fail outright.
      console.error('Failed to update compliance item in SharePoint, recreating:', patchRes.status, await patchRes.text());
    }

    const createUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items`;
    const createRes = await sendFields(createUrl, 'POST', true);
    if (!createRes.ok) {
      console.error('Failed to create compliance item in SharePoint:', createRes.status, await createRes.text());
      return item;
    }
    const created = await createRes.json().catch(() => ({}));
    return { ...item, sharePointItemId: created.id || null };
  } catch (err) {
    console.error('Error pushing compliance item to SharePoint:', err);
    return item;
  }
}

// Mirrors deleteHouseholdFromSharePoint: an intentional delete in the app
// should remove the backup row too, or it reads as still-current during a
// later outage. Best-effort: never throws.
async function deleteComplianceFromSharePoint(env, item) {
  if (!env.SHAREPOINT_COMPLIANCE_LIST_ID || !item || !item.sharePointItemId) return;
  try {
    const token = await getGraphToken(env);
    const url = `https://graph.microsoft.com/v1.0/sites/${complianceSiteId(env)}/lists/${env.SHAREPOINT_COMPLIANCE_LIST_ID}/items/${item.sharePointItemId}`;
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) console.error('Failed to delete compliance item from SharePoint:', res.status, await res.text());
  } catch (err) {
    console.error('Error deleting compliance item from SharePoint:', err);
  }
}

// ---------- Learning resources (SharePoint document library) ----------
// Staff training material — videos and documents — kept in a SharePoint
// document library ("Learning Resources") and listed read-only in the admin
// Learning tab. A document library IS a list underneath, so this reads through
// the same /lists/{id}/items endpoint the contact and household syncs use, with
// driveItem expanded to get each file's own webUrl.
//
// Read-only and NOT synced into KV, unlike contacts/households: nothing here is
// edited in the app, so SharePoint stays the single copy and there is no
// two-way merge to get wrong. Each request goes straight to Graph, which also
// means a file uploaded in SharePoint shows up on the next refresh with no sync
// step to wait for.
//
// Links open SharePoint's own viewer in a new tab rather than embedding a
// player, so no per-file embed code or sharing-link generation is needed.

// SharePoint decides a column's *internal* name when it's created, and it does
// not always match the display name — a display name that collides with a
// built-in field gets suffixed ("Description" -> "Description0"), and spaces
// become escaped sequences. Rather than hard-code one guess, try the plausible
// internal names in order. /api/admin/learning/fields dumps the real ones if a
// library ends up with something not covered here.
function pickField(fields, candidates) {
  for (const key of candidates) {
    const val = fields[key];
    if (val !== undefined && val !== null && String(val).trim()) return String(val).trim();
  }
  return '';
}

const LEARNING_CATEGORY_FIELDS = ['Category', 'Category0'];
const LEARNING_DESCRIPTION_FIELDS = ['Description', 'Description0', '_ExtendedDescription', 'Comments'];
// A document library already ships a built-in Title column, so a *second*
// column someone names "Title" would be suffixed — hence both spellings.
const LEARNING_TITLE_FIELDS = ['Title', 'Title0'];

// The write path needs the *exact* internal names, not a best-guess read: a
// PATCH against a column that doesn't exist fails the whole request. So for
// uploads the columns are resolved from the list's own schema rather than from
// the candidate lists above, which also yields the Category column's Choice
// values for the picker (including categories no file uses yet).
async function resolveLearningColumns(env, token) {
  const url = `https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}`
    + `/lists/${env.SHAREPOINT_LEARNING_LIST_ID}/columns`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Graph API error ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const cols = ((await res.json()).value || []).filter((c) => !c.readOnly && !c.hidden);
  // Internal name first (that's what a PATCH takes), display name as the
  // fallback for a column created with a name we don't have a candidate for.
  const find = (candidates, display) =>
    cols.find((c) => candidates.includes(c.name))
    || cols.find((c) => String(c.displayName || '').toLowerCase() === display)
    || null;
  const category = find(LEARNING_CATEGORY_FIELDS, 'category');
  return {
    title: find(LEARNING_TITLE_FIELDS, 'title'),
    category,
    description: find(LEARNING_DESCRIPTION_FIELDS, 'description'),
    // A free-text Category column has no choices; the UI then lets any value
    // be typed instead of forcing a pick from an empty list.
    categoryChoices: (category && category.choice && category.choice.choices) || [],
    categoryIsChoice: Boolean(category && category.choice),
  };
}

// A document library is backed by a drive, and uploads go through the drive
// (not the list) endpoint — so the drive id is needed before any upload.
async function getLearningDriveId(env, token) {
  const url = `https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}`
    + `/lists/${env.SHAREPOINT_LEARNING_LIST_ID}/drive`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Could not resolve the library drive (Graph ' + res.status + ')');
  const drive = await res.json();
  if (!drive.id) throw new Error('Library drive has no id');
  return drive.id;
}

async function fetchLearningResources(env) {
  if (!env.SHAREPOINT_LEARNING_LIST_ID) return { resources: [], configured: false };

  const token = await getGraphToken(env);
  // driveItem carries the file's real webUrl, size and folder/file marker;
  // fields carries the custom Category/Description columns.
  const url = `https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}`
    + `/lists/${env.SHAREPOINT_LEARNING_LIST_ID}/items?expand=fields,driveItem&$top=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Graph API error ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();

  const resources = [];
  for (const item of data.value || []) {
    const fields = item.fields || {};
    const drive = item.driveItem || {};
    // A document library's items include its folders. Keep files only —
    // a folder has no webUrl worth linking and no content to open.
    if (drive.folder) continue;
    if (!drive.file && !fields.FileLeafRef) continue;

    const name = String(drive.name || fields.FileLeafRef || '').trim();
    const webUrl = drive.webUrl || item.webUrl || '';
    if (!webUrl) continue; // nothing to link to

    const description = pickField(fields, LEARNING_DESCRIPTION_FIELDS);
    resources.push({
      id: item.id,
      name,
      // Title is the intended display name. It falls back to Description, then
      // to the filename, so a resource with neither column filled in still
      // renders a readable link rather than an empty row.
      title: pickField(fields, LEARNING_TITLE_FIELDS) || description || name,
      description,
      category: pickField(fields, LEARNING_CATEGORY_FIELDS),
      webUrl,
      size: typeof drive.size === 'number' ? drive.size : null,
      modified: drive.lastModifiedDateTime || fields.Modified || null,
    });
  }

  // Category, then title — so the flat list still reads as grouped when no
  // category filter is applied.
  resources.sort((a, b) =>
    (a.category || '￿').localeCompare(b.category || '￿') || a.title.localeCompare(b.title));

  return { resources, configured: true };
}

async function handleAdminLearning(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  try {
    const { resources, configured } = await fetchLearningResources(env);
    // Categories come from the data rather than a hard-coded list, so adding a
    // new Choice value in SharePoint surfaces it here with no code change.
    const categories = [...new Set(resources.map((r) => r.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    // The upload form's category picker wants the column's own Choice values,
    // which include categories no file uses yet. Resolving the schema is a
    // second Graph call, so a failure here degrades to the data-derived list
    // rather than failing the whole listing.
    let categoryChoices = [];
    let categoryIsChoice = false;
    let canUpload = false;
    if (configured) {
      try {
        const cols = await resolveLearningColumns(env, await getGraphToken(env));
        categoryChoices = cols.categoryChoices;
        categoryIsChoice = cols.categoryIsChoice;
        canUpload = true;
      } catch (err) {
        console.error('Could not resolve learning columns:', err);
      }
    }
    return json({ resources, categories, categoryChoices, categoryIsChoice, canUpload, configured }, 200, cors);
  } catch (err) {
    console.error('Failed to fetch learning resources:', err);
    return json({ error: 'Failed to load learning resources: ' + (err && err.message) }, 500, cors);
  }
}

// Diagnostic twin of /api/admin/sharepoint/lists: dumps the raw field keys of
// the first few items so a Category/Description column whose internal name
// isn't in the candidate lists above can be identified without guessing.
async function handleAdminLearningFields(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  if (!env.SHAREPOINT_LEARNING_LIST_ID) {
    return json({ error: 'SHAREPOINT_LEARNING_LIST_ID is not set' }, 400, cors);
  }
  try {
    const token = await getGraphToken(env);
    const url = `https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}`
      + `/lists/${env.SHAREPOINT_LEARNING_LIST_ID}/items?expand=fields&$top=3`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Graph API error ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    return json({
      items: (data.value || []).map((i) => ({ id: i.id, fields: i.fields || {} })),
      resolvedBy: {
        title: LEARNING_TITLE_FIELDS,
        category: LEARNING_CATEGORY_FIELDS,
        description: LEARNING_DESCRIPTION_FIELDS,
      },
    }, 200, cors);
  } catch (err) {
    return json({ error: 'Failed to read learning list fields: ' + (err && err.message) }, 500, cors);
  }
}

// ---------- Learning uploads ----------
// Adding a video is a two-step dance because training videos are far too large
// for one request:
//
//   1. POST /api/admin/learning/upload      -> Graph upload session + a ticket
//   2. PUT  /api/admin/learning/upload/chunk -> one 5 MiB slice at a time
//
// Chunks are proxied through the Worker rather than sent straight from the
// browser to the SharePoint upload URL: that URL's CORS behaviour isn't
// something we control, and proxying keeps the pre-authenticated URL out of
// page JavaScript.
//
// The session state (upload URL + the Title/Category/Description to stamp on
// the file when it lands) rides along in an encrypted ticket the client echoes
// back with each chunk, rather than in KV. KV is eventually consistent, and the
// first chunk can arrive within a second of the session being created — a stale
// read there would fail the upload outright.

const LEARNING_UPLOAD_CHUNK = 5 * 1024 * 1024; // multiple of 320 KiB, as Graph requires
const LEARNING_MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2 GB
const LEARNING_VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'avi', 'wmv', 'webm', 'mkv'];

// SharePoint rejects " * : < > ? / \ | and leading/trailing dots or spaces.
function sanitizeLearningFilename(raw) {
  const base = String(raw || '').split(/[\\/]/).pop();
  return base.replace(/["*:<>?|]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 200);
}

async function handleAdminLearningUploadStart(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  if (!env.SHAREPOINT_LEARNING_LIST_ID) {
    return json({ error: 'SHAREPOINT_LEARNING_LIST_ID is not set' }, 400, cors);
  }
  const body = await request.json().catch(() => ({}));

  const filename = sanitizeLearningFilename(body.filename);
  const size = Number(body.size);
  const title = String(body.title || '').trim();
  const category = String(body.category || '').trim();
  const description = String(body.description || '').trim();

  if (!filename) return json({ error: 'A file is required' }, 400, cors);
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (!LEARNING_VIDEO_EXTS.includes(ext)) {
    return json({ error: `Unsupported video format ".${ext}" — use ${LEARNING_VIDEO_EXTS.join(', ')}` }, 400, cors);
  }
  if (!Number.isFinite(size) || size <= 0) return json({ error: 'File size is missing' }, 400, cors);
  if (size > LEARNING_MAX_UPLOAD) return json({ error: 'File is larger than the 2 GB limit' }, 400, cors);
  if (!title) return json({ error: 'A name is required' }, 400, cors);

  try {
    const token = await getGraphToken(env);
    const cols = await resolveLearningColumns(env, token);
    // Reject an unknown category up front rather than uploading the file and
    // then failing to label it.
    if (category && cols.categoryIsChoice && !cols.categoryChoices.includes(category)) {
      return json({ error: `"${category}" is not one of the library's categories` }, 400, cors);
    }

    const driveId = await getLearningDriveId(env, token);
    const sessionUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/`
      + `${encodeURIComponent(filename)}:/createUploadSession`;
    const res = await fetch(sessionUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // rename, not replace: an upload never silently overwrites a video
      // someone else put in the library under the same filename.
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: filename } }),
    });
    if (!res.ok) {
      throw new Error('Graph API error ' + res.status + ': ' + (await res.text()).slice(0, 300));
    }
    const session = await res.json();
    if (!session.uploadUrl) throw new Error('Graph returned no uploadUrl');

    const ticket = await encryptJSON(env, {
      uploadUrl: session.uploadUrl, driveId, size, filename, title, category, description,
    });
    return json({ ticket, chunkSize: LEARNING_UPLOAD_CHUNK }, 200, cors);
  } catch (err) {
    console.error('Failed to start learning upload:', err);
    return json({ error: 'Could not start the upload: ' + (err && err.message) }, 500, cors);
  }
}

// One chunk. The ticket comes in X-Upload-Ticket and the byte offset in
// X-Upload-Offset; the body is the raw slice.
async function handleAdminLearningUploadChunk(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);

  let ticket;
  try {
    ticket = await decryptToObject(env, request.headers.get('X-Upload-Ticket') || '');
  } catch {
    return json({ error: 'Upload ticket could not be read — start the upload again' }, 400, cors);
  }
  if (!ticket || !ticket.uploadUrl) return json({ error: 'Missing upload ticket' }, 400, cors);
  // Belt to the ticket's braces: with DATA_ENCRYPTION_KEY unset the ticket is
  // stored in the clear, so refuse to fetch anything that isn't a SharePoint
  // upload endpoint no matter what the ticket claims.
  let host = '';
  try { host = new URL(ticket.uploadUrl).hostname; } catch { host = ''; }
  if (!/\.sharepoint\.com$/i.test(host)) {
    return json({ error: 'Upload ticket points somewhere unexpected' }, 400, cors);
  }

  const offset = Number(request.headers.get('X-Upload-Offset'));
  if (!Number.isFinite(offset) || offset < 0) return json({ error: 'Bad chunk offset' }, 400, cors);
  const chunk = await request.arrayBuffer();
  if (!chunk.byteLength) return json({ error: 'Empty chunk' }, 400, cors);
  const end = offset + chunk.byteLength - 1;
  if (end >= ticket.size) return json({ error: 'Chunk runs past the declared file size' }, 400, cors);

  try {
    const res = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${offset}-${end}/${ticket.size}` },
      body: chunk,
    });
    // 202 = accepted, more to come. 200/201 = the last chunk; the body is the
    // finished driveItem.
    if (res.status === 202) {
      await res.text().catch(() => '');
      return json({ done: false, nextOffset: end + 1 }, 200, cors);
    }
    if (!res.ok) {
      throw new Error('SharePoint rejected the chunk (' + res.status + '): ' + (await res.text()).slice(0, 300));
    }
    const item = await res.json();
    const applied = await applyLearningMetadata(env, ticket, item);
    return json({ done: true, resource: applied.resource, warning: applied.warning }, 200, cors);
  } catch (err) {
    console.error('Learning chunk upload failed:', err);
    return json({ error: 'Upload failed: ' + (err && err.message) }, 500, cors);
  }
}

// Stamp Title/Category/Description onto the freshly uploaded file. The file is
// already in the library at this point, so a metadata failure is reported as a
// warning rather than an error — re-running the upload would just duplicate it.
async function applyLearningMetadata(env, ticket, item) {
  const resource = {
    id: item.id,
    name: item.name || ticket.filename,
    title: ticket.title,
    category: ticket.category,
    webUrl: item.webUrl || '',
    size: typeof item.size === 'number' ? item.size : ticket.size,
  };
  try {
    const token = await getGraphToken(env);
    const cols = await resolveLearningColumns(env, token);
    const fields = {};
    if (cols.title) fields[cols.title.name] = ticket.title;
    if (cols.category && ticket.category) fields[cols.category.name] = ticket.category;
    if (cols.description && ticket.description) fields[cols.description.name] = ticket.description;
    if (!Object.keys(fields).length) {
      return { resource, warning: 'Uploaded, but the library has no Title column to name it in.' };
    }

    // The upload returns a driveItem; the columns hang off its list item.
    const liRes = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${ticket.driveId}/items/${item.id}/listItem?$select=id`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!liRes.ok) throw new Error('Graph ' + liRes.status + ' resolving the list item');
    const listItemId = (await liRes.json()).id;

    const patch = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}`
      + `/lists/${env.SHAREPOINT_LEARNING_LIST_ID}/items/${listItemId}/fields`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      }
    );
    if (!patch.ok) throw new Error('Graph ' + patch.status + ': ' + (await patch.text()).slice(0, 200));
    return { resource, warning: '' };
  } catch (err) {
    console.error('Failed to set learning metadata:', err);
    return {
      resource,
      warning: 'The video uploaded, but its name and category could not be saved: '
        + (err && err.message) + ' — set them in SharePoint.',
    };
  }
}

// ---------- Compliance tracker ----------
// The firm's compliance calendar, seeded from BlueLine_Compliance_Tracker.xlsx
// and then owned by the app (the workbook is not written back to).
//
// ONE encrypted KV blob rather than a key per item, matching the board_lists
// pattern. 128 items are always read together and written rarely, so a key each
// would mean 128 KV gets per page load — enough to blow the per-request
// subrequest budget on a small plan. Trade-off: a read-modify-write race could
// drop a concurrent edit. The window is a few ms and every write is a targeted
// single-item mutation, so with a two-person compliance team this is acceptable;
// it would not be for a large team hammering the same list.
const COMPLIANCE_KEY = 'compliance_items';
// "Both" is deliberately gone: an item owned by everyone is owned by no one,
// and those items closed on the owner alone with no second pair of eyes.
// Existing 'Both' rows are migrated to Frank owns / Jennifer reviews on read
// (see getComplianceItems), which also gives them the review step they lacked.
const COMPLIANCE_OWNERS = ['Frank', 'Jennifer'];
const COMPLIANCE_REVIEWERS = ['Frank', 'Jennifer', 'N/A'];

// ---------- Recurrence ----------
// Recurring items are MATERIALISED: each due date is its own record with its own
// pair of sign-offs. That matches how the source workbook already worked — a
// quarterly item appears there as four separate dated rows — and it means every
// occurrence is ticked off independently, which is what compliance evidence
// needs. The alternative (one row plus a rule, expanded at render time) would
// have nowhere to record who signed off which quarter.
//
// Frequency is DESCRIPTIVE ONLY. It records how often an obligation comes
// round, but the app never materialises the next occurrence itself — future
// due dates arrive by importing a spreadsheet that lists them. The date-
// stepping machinery this used to need is gone with it.
const COMPLIANCE_FREQUENCIES = ['Quarterly', 'Annual', 'One-time', 'Ongoing', 'Monthly', 'Semi-annual', 'Weekly'];

// Exactly six, deliberately. AI, cybersecurity, privacy, BCP, vendors and
// device/technology matters all live together under Technology, Privacy &
// Resilience rather than splintering into their own top-level areas — six
// stable categories people can hold in their head beats fifteen precise ones.
const COMPLIANCE_AREAS = [
  'Governance & Regulatory',
  'Trading & Investments',
  'Fees & Client Accounts',
  'Marketing & Communications',
  'Personnel & Ethics',
  'Technology, Privacy & Resilience',
];

const COMPLIANCE_REQUIREMENTS = ['Required', 'Best practice'];

// Lowercased item name -> area, built from the seed. Used only to backfill
// records written before complianceArea existed; new items carry their own.
const COMPLIANCE_AREA_BY_ITEM = new Map(
  COMPLIANCE_SEED.filter((r) => r.complianceArea)
    .map((r) => [String(r.item).trim().toLowerCase(), r.complianceArea])
);

// "One-time: target Q3 2027" -> One-time. Matches scripts/add-compliance-area.js
// so a record migrated on read lands on the same value the seed already has.
function normaliseComplianceFrequency(raw) {
  const s = String(raw || '').trim();
  const l = s.toLowerCase();
  if (l.startsWith('one-time') || l.startsWith('one time')) return 'One-time';
  if (l.startsWith('ongoing')) return 'Ongoing';
  if (l.startsWith('quarterly')) return 'Quarterly';
  if (l.startsWith('annual')) return 'Annual';
  if (l.startsWith('semi-annual')) return 'Semi-annual';
  if (l.startsWith('monthly')) return 'Monthly';
  if (l.startsWith('weekly')) return 'Weekly';
  return s || 'One-time';
}

// An item needs a reviewer unless the reviewer is explicitly "N/A".
function complianceReviewerRequired(item) {
  return String(item.reviewer || '').trim() !== 'N/A';
}

// Every required sign-off is in. This is the precondition for completing, NOT
// completion itself — closing is now a deliberate act (see completedAt below).
function complianceSignedOff(item) {
  const ownerDone = !!String(item.ownerCompleted || '').trim();
  const reviewerDone = !!String(item.reviewerCompleted || '').trim();
  return ownerDone && (!complianceReviewerRequired(item) || reviewerDone);
}

// Status keys off a stored completedAt rather than being derived purely from
// the two check-offs. Ticking the last box used to close the item instantly,
// which meant the sign-off gesture and the "this is finished" decision were
// the same click and neither could happen without the other. Now the boxes
// record who has signed off, and completing is its own explicit step.
function complianceStatus(item) {
  return String(item.completedAt || '').trim() ? 'CLOSED' : 'OPEN';
}

// Whose turn it is, or '' when finished/blocked. Drives the calendar's colour
// coding: work flows owner -> reviewer -> done, so the person named here is
// whoever the item is actually waiting on right now.
function complianceAwaiting(item) {
  if (complianceStatus(item) === 'CLOSED') return '';
  if (!String(item.ownerCompleted || '').trim()) return String(item.owner || '').trim();
  if (complianceReviewerRequired(item) && !String(item.reviewerCompleted || '').trim()) {
    return String(item.reviewer || '').trim();
  }
  return ''; // signed off by everyone, waiting only on the Complete button
}

// Soonest due first, so the tracker's top row is always the most urgent thing.
// Ties broken by item name to keep the order stable across reloads.
function complianceSort(items) {
  return items.slice().sort((a, b) =>
    String(a.dueDate).localeCompare(String(b.dueDate)) || String(a.item).localeCompare(String(b.item)));
}

// The user-facing workflow stage, distinct from the coarse OPEN/CLOSED status
// the rest of the app keys off.
//
// Deliberately FOUR values, not the five requested: "Owner complete" and
// "Awaiting review" describe the identical condition (owner has signed, review
// hasn't happened), and shipping both would put two labels on one state with
// no rule for choosing between them. "Awaiting review" is the one kept, per the
// stated preference for it as the user-facing wording.
const COMPLIANCE_WORKFLOW = ['Open', 'Waiting', 'Awaiting review', 'Completed'];

function complianceWorkflow(item) {
  if (complianceStatus(item) === 'CLOSED') return 'Completed';
  // Blocked on someone/something else, recorded explicitly rather than inferred.
  if (String(item.waitingOn || '').trim()) return 'Waiting';
  // Owner has signed off and a reviewer is still owed — the stage the reviewer
  // queue is built from.
  if (String(item.ownerCompleted || '').trim()
      && complianceReviewerRequired(item)
      && !String(item.reviewerCompleted || '').trim()) {
    return 'Awaiting review';
  }
  // Signed off by everyone but not yet closed also reads as awaiting review:
  // the outstanding action is the review sign-off being turned into a close.
  if (complianceSignedOff(item)) return 'Awaiting review';
  return 'Open';
}

// ---------- Compliance -> Outlook ----------
// Every OPEN compliance item is mirrored onto the real Outlook calendars of the
// people responsible for it, as an all-day event on its due date. Same app
// registration, same Calendars.ReadWrite.All application permission and the same
// reconcile as meetings (reconcileOutlookEvents) — a compliance item is just
// another record with a date and a set of mailboxes.
//
// Owner AND reviewer both get a copy. An item cannot close without the
// reviewer's sign-off, so a deadline only the owner can see is a deadline the
// reviewer discovers late. Reviewer 'N/A' means the item closes on the owner
// alone, so that case is owner-only.
//
// `owner`/`reviewer` are display names in this record ('Frank', 'Jennifer'), not
// addresses — the tracker was seeded from a spreadsheet that used first names.
// Anything not in this map is skipped rather than guessed at: inventing a
// mailbox would write a real event onto the wrong person's calendar.
const COMPLIANCE_MAILBOX = {
  frank: FRANK_ADMIN_EMAIL,
  jennifer: JENN_ADMIN_EMAIL,
};

function complianceMailboxFor(name) {
  return COMPLIANCE_MAILBOX[String(name || '').trim().toLowerCase()] || '';
}

// CLOSED items get no calendar entry: finished work on a calendar is noise, and
// completing an item is what withdraws its events (reconcile deletes any mailbox
// that is no longer wanted). Undated items likewise can't be placed.
function complianceCalendarOwners(item) {
  if (complianceStatus(item) === 'CLOSED') return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.dueDate || '').trim())) return [];
  const names = [item.owner];
  if (complianceReviewerRequired(item)) names.push(item.reviewer);
  return [...new Set(names.map(complianceMailboxFor).filter(Boolean))];
}

// Shaped into the same fields outlookEventBody reads. A bare YYYY-MM-DD due with
// no `T` is treated as all-day by outlookEventTimes, which is exactly right: a
// compliance obligation is due on a day, not at a time.
// Compliance items land at 06:00 on their due date rather than in the all-day
// banner at the top of the day. An all-day event collapses into a strip that is
// easy to scroll past, and with a dozen due in a week that strip is all anyone
// sees; a timed block sits above the working day where it reads as work.
//
// 06:00 local (OUTLOOK_TIMEZONE, default Eastern) — outlookEventTimes gives it
// the standard OUTLOOK_DEFAULT_DURATION_MIN, so 06:00–07:00.
const COMPLIANCE_OUTLOOK_TIME = '06:00';

function complianceOutlookPayload(env, item) {
  const lines = [];
  if (item.whatToDo) lines.push(String(item.whatToDo));
  if (item.complianceArea) lines.push(`Area: ${item.complianceArea}`);
  if (item.frequency) lines.push(`Frequency: ${item.frequency}`);
  if (item.requirement) lines.push(`Requirement: ${item.requirement}`);
  if (item.owner) lines.push(`Owner: ${item.owner}`);
  if (complianceReviewerRequired(item) && item.reviewer) lines.push(`Reviewer: ${item.reviewer}`);
  if (item.source) lines.push(`Source: ${item.source}`);
  lines.push('', 'Tracked in the BlueLine portal — Compliance. Sign-off happens there, not here.');
  const payload = outlookEventBody({
    // Prefixed so a compliance obligation is distinguishable from a meeting at a
    // glance in Outlook, where there is no other context to tell them apart.
    title: `[Compliance] ${String(item.item || '').trim() || '(untitled)'}`,
    description: lines.join('\n'),
    due: `${String(item.dueDate).trim()}T${COMPLIANCE_OUTLOOK_TIME}`,
  }, outlookTimeZone(env));
  if (!payload) return null;
  // No reminder. Outlook's default would fire 15 minutes before — i.e. 05:45 —
  // on every one of these, and there are ~100 of them. The 06:00 slot exists to
  // put the item where it will be seen at the start of the day, not to raise an
  // alarm before it. Flip to true (or set reminderMinutesBeforeStart) if the
  // firm decides it wants the prompt.
  payload.isReminderOn = false;
  return payload;
}

function complianceOutlookEvents(item) {
  if (!item.outlookEvents || typeof item.outlookEvents !== 'object') return {};
  const out = {};
  for (const [owner, id] of Object.entries(item.outlookEvents)) {
    const key = String(owner || '').trim().toLowerCase();
    if (key && id) out[key] = String(id);
  }
  return out;
}

// Returns `{ fields, failed }` — the fields to merge onto the item (null when
// nothing changed) and how many Graph calls errored on this attempt. The two are
// kept apart deliberately: `failed` describes the attempt, not the record, and
// merging it in would persist it onto the stored item.
//
// Best-effort like every other push here: a Graph outage must never block saving
// a compliance item, which is the record that actually matters.
async function syncComplianceToOutlook(env, item) {
  if (!outlookConfigured(env)) return { fields: null, failed: 0 };
  try {
    const wanted = complianceCalendarOwners(item);
    const existing = complianceOutlookEvents(item);
    const payload = wanted.length ? complianceOutlookPayload(env, item) : null;
    const { events: next, changed, failed } = await reconcileOutlookEvents(env, wanted, existing, payload);
    if (!changed && JSON.stringify(next) === JSON.stringify(existing)) return { fields: null, failed };
    return { fields: { outlookEvents: next, outlookSyncedAt: new Date().toISOString() }, failed };
  } catch (err) {
    console.error('Error syncing compliance item to Outlook:', err);
    return { fields: null, failed: 1 };
  }
}

function withComplianceStatus(item) {
  return {
    ...item,
    status: complianceStatus(item),
    workflow: complianceWorkflow(item),
    reviewerRequired: complianceReviewerRequired(item),
    // Both surfaced so the client doesn't re-derive them and drift from here.
    signedOff: complianceSignedOff(item),
    awaiting: complianceAwaiting(item),
  };
}

// Reads the blob, seeding it from the spreadsheet export on first ever call.
// The presence of the blob — not whether it has any items — is what marks it as
// seeded, so deleting every item does NOT resurrect all 128 on the next load.
// Brings stored rows up to the current shape. Two migrations, both idempotent
// and both applied on read then written back once if anything changed:
//
//  - owner 'Both' -> Frank owns, Jennifer reviews. Those rows also had
//    reviewer 'N/A', so this is what gives them a review step at all.
//  - Items that were closed under the old derive-from-checkboxes rule have no
//    completedAt, so they'd silently reopen now that status keys off it.
//    Backfill from the later of the two sign-off dates.
function migrateComplianceItems(items) {
  let changed = false;
  const migrated = items.map((it) => {
    const next = { ...it };
    if (String(next.owner || '').trim() === 'Both') {
      next.owner = 'Frank';
      if (String(next.reviewer || '').trim() === 'N/A' || !String(next.reviewer || '').trim()) {
        next.reviewer = 'Jennifer';
      }
      changed = true;
    }
    if (next.completedAt === undefined) {
      const ownerDone = String(next.ownerCompleted || '').trim();
      const reviewerDone = String(next.reviewerCompleted || '').trim();
      const reviewerNeeded = String(next.reviewer || '').trim() !== 'N/A';
      // Mirrors the OLD close rule exactly, so anything that read as CLOSED
      // before this change still reads as CLOSED after it.
      const wasClosed = ownerDone && (!reviewerNeeded || reviewerDone);
      next.completedAt = wasClosed
        ? (reviewerDone && reviewerDone > ownerDone ? reviewerDone : ownerDone)
        : '';
      next.completedBy = wasClosed ? String(next.reviewerCompletedBy || next.ownerCompletedBy || '') : '';
      changed = true;
    }
    // mandated (boolean) -> requirement (label). "Best practice" rather than
    // "No": the firm still elects to do these, they just aren't externally
    // mandated, and "No" reads as "unnecessary".
    if (next.requirement === undefined) {
      next.requirement = next.mandated ? 'Required' : 'Best practice';
      delete next.mandated;
      changed = true;
    }
    // Split the free-text frequency into a filterable value plus the original
    // wording, so "One-time: target Q3 2027" can be filtered as One-time
    // without losing the target date.
    if (next.frequencyDetail === undefined) {
      const norm = normaliseComplianceFrequency(next.frequency);
      next.frequencyDetail = norm === String(next.frequency || '').trim() ? '' : String(next.frequency || '').trim();
      next.frequency = norm;
      changed = true;
    }
    // Area is stored, never derived at render time. Records predating the field
    // are matched to the seed by item name — the same basis the seed itself was
    // classified on, so a recurring obligation's rows all agree.
    if (next.complianceArea === undefined) {
      next.complianceArea = COMPLIANCE_AREA_BY_ITEM.get(String(next.item || '').trim().toLowerCase()) || '';
      changed = true;
    }
    if (next.waitingOn === undefined) {
      next.waitingOn = '';
      changed = true;
    }
    // "Jenn" and "Jennifer" must not coexist as separate values — a filter on
    // one would silently miss the other's items.
    ['owner', 'reviewer'].forEach((k) => {
      if (String(next[k] || '').trim() === 'Jenn') { next[k] = 'Jennifer'; changed = true; }
    });
    return next;
  });
  return { items: migrated, changed };
}

async function getComplianceItems(env) {
  const rec = await decryptToObject(env, await env.PORTAL_KV.get(COMPLIANCE_KEY));
  if (rec && Array.isArray(rec.items)) {
    const { items, changed } = migrateComplianceItems(rec.items);
    if (changed) await saveComplianceItems(env, items);
    return items;
  }
  const seeded = COMPLIANCE_SEED.map((row) => ({
    ...row,
    // The seed still carries 'Both' rows; run them through the same migration
    // rather than maintaining two copies of that rule.
    ...(String(row.owner || '').trim() === 'Both'
      ? { owner: 'Frank', reviewer: String(row.reviewer || '').trim() && row.reviewer !== 'N/A' ? row.reviewer : 'Jennifer' }
      : {}),
    ownerCompleted: '',
    ownerCompletedBy: '',
    reviewerCompleted: '',
    reviewerCompletedBy: '',
    completedAt: '',
    completedBy: '',
    createdAt: new Date().toISOString(),
    createdBy: 'seed',
    updatedAt: null,
  }));
  await saveComplianceItems(env, seeded);
  return seeded;
}

async function saveComplianceItems(env, items) {
  await env.PORTAL_KV.put(COMPLIANCE_KEY, await encryptJSON(env, { version: 1, items }));
}

const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());

// Shared by create and update. Returns {fields} or {error}; only keys actually
// present in the body are returned, so an update can be partial.
function sanitizeComplianceFields(body, { requireCore = false } = {}) {
  const out = {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  if (body.item !== undefined || requireCore) {
    const v = str(body.item, 300);
    if (!v) return { error: 'Item name is required' };
    out.item = v;
  }
  if (body.dueDate !== undefined || requireCore) {
    const v = str(body.dueDate, 10);
    if (!isIsoDate(v)) return { error: 'Due date must be YYYY-MM-DD' };
    out.dueDate = v;
  }
  if (body.owner !== undefined || requireCore) {
    const v = str(body.owner, 60);
    if (!v) return { error: 'Owner is required' };
    out.owner = v;
  }
  if (body.reviewer !== undefined || requireCore) {
    // Free text rather than a strict enum: roles get reassigned and new staff
    // appear, and rejecting an unknown name here would make an item unsaveable.
    // The UI offers the known names; "N/A" is what drives the close rule.
    out.reviewer = str(body.reviewer, 60) || 'N/A';
  }
  if (body.whatToDo !== undefined) out.whatToDo = str(body.whatToDo, 2000);
  // Free text rather than a strict enum: the 128 seeded rows carry wordings the
  // dropdown doesn't offer ("Ongoing / target Dec 2026", "One-time: Jan 1,
  // 2028"), and rejecting those would make those items unsaveable. Nothing
  // parses it — it's a label shown on the row.
  // Normalised on the way in so a hand-typed or imported "One-time: Jan 2028"
  // is filterable, with the original wording kept alongside it.
  if (body.frequency !== undefined) {
    const raw = str(body.frequency, 100);
    const norm = normaliseComplianceFrequency(raw);
    out.frequency = norm;
    out.frequencyDetail = norm === raw ? '' : raw;
  }
  // An explicit frequencyDetail wins over the one inferred above, so a caller
  // that already split the two doesn't get its detail overwritten.
  if (body.frequencyDetail !== undefined) out.frequencyDetail = str(body.frequencyDetail, 200);
  if (body.source !== undefined) out.source = str(body.source, 100);
  if (body.notes !== undefined) out.notes = str(body.notes, 2000);
  if (body.waitingOn !== undefined) out.waitingOn = str(body.waitingOn, 200);
  if (body.complianceArea !== undefined) {
    const v = str(body.complianceArea, 60);
    // Rejected rather than coerced: a typo'd area would silently vanish from
    // its filter, and there are only six valid values.
    if (v && !COMPLIANCE_AREAS.includes(v)) return { error: 'Unknown compliance area' };
    out.complianceArea = v;
  }
  if (body.requirement !== undefined) {
    const v = str(body.requirement, 30);
    if (v && !COMPLIANCE_REQUIREMENTS.includes(v)) return { error: 'Requirement must be Required or Best practice' };
    out.requirement = v || 'Best practice';
  }
  // Legacy boolean, still accepted so an older client or a stored payload
  // doesn't lose the distinction on save.
  if (body.mandated !== undefined && body.requirement === undefined) {
    out.requirement = body.mandated ? 'Required' : 'Best practice';
  }

  // The two check-offs. An empty string clears one (re-opening the item);
  // anything else must be a real date, so a stray value can't silently close it.
  for (const key of ['ownerCompleted', 'reviewerCompleted']) {
    if (body[key] === undefined) continue;
    const v = str(body[key], 10);
    if (v && !isIsoDate(v)) return { error: `${key} must be YYYY-MM-DD or empty` };
    out[key] = v;
  }
  return { fields: out };
}

async function handleAdminComplianceList(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  if (workspace !== FRANK_ADMIN_EMAIL) return json({ error: "Compliance is only available in Frank's shared view" }, 403, cors);
  const items = await getComplianceItems(env);
  const shaped = complianceSort(items.filter((item) => recordWorkspace(item) === workspace)).map(withComplianceStatus);
  return json({
    items: shaped,
    owners: COMPLIANCE_OWNERS,
    reviewers: COMPLIANCE_REVIEWERS,
    frequencies: COMPLIANCE_FREQUENCIES,
    areas: COMPLIANCE_AREAS,
    requirements: COMPLIANCE_REQUIREMENTS,
    workflows: COMPLIANCE_WORKFLOW,
    // Source values come from the data rather than a fixed list — the set grows
    // as policies are added, and a hardcoded list would quietly omit new ones.
    sources: [...new Set(shaped.map((i) => String(i.source || '').trim()).filter(Boolean))].sort(),
    workspace,
  }, 200, cors);
}

async function handleAdminComplianceCreate(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  if (workspace !== FRANK_ADMIN_EMAIL) return json({ error: "Compliance is only available in Frank's shared view" }, 403, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeComplianceFields(body, { requireCore: true });
  if (error) return json({ error }, 400, cors);

  const items = await getComplianceItems(env);
  // Exactly one row is created, whatever the frequency. Frequency is now purely
  // descriptive — it says how often the obligation recurs, but the app no
  // longer materialises the next occurrence on its own. Future dates come from
  // importing a spreadsheet that lists them.
  const base = {
    id: `cx-${invTs()}-${randomHex(3)}`,
    workspace,
    whatToDo: '', frequency: 'One-time', frequencyDetail: '',
      source: '', notes: '', waitingOn: '',
      complianceArea: '', requirement: 'Best practice',
    ...fields,
    ownerCompleted: fields.ownerCompleted || '',
    ownerCompletedBy: '',
    reviewerCompleted: fields.reviewerCompleted || '',
    reviewerCompletedBy: '',
    createdAt: new Date().toISOString(),
    createdBy: adminEmail,
    updatedAt: null,
  };
  items.push(base);

  // Best-effort disaster-recovery mirror — see pushComplianceToSharePoint.
  // Runs before the KV write so a successful push's item id is captured
  // immediately rather than being left null until the next edit.
  Object.assign(base, await pushComplianceToSharePoint(env, base));
  // Same reason: capture the event ids on the first write rather than leaving
  // the item unsynced until someone edits it.
  Object.assign(base, (await syncComplianceToOutlook(env, base)).fields || {});

  await saveComplianceItems(env, items);
  await logAudit(env, adminEmail, 'compliance-create', { id: base.id, item: base.item });
  return json({ item: withComplianceStatus(base), created: 1 }, 200, cors);
}

async function handleAdminComplianceUpdate(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  if (workspace !== FRANK_ADMIN_EMAIL) return json({ error: "Compliance is only available in Frank's shared view" }, 403, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeComplianceFields(body);
  if (error) return json({ error }, 400, cors);

  const items = await getComplianceItems(env);
  const idx = items.findIndex((x) => x.id === id && recordWorkspace(x) === workspace);
  if (idx < 0) return json({ error: 'Compliance item not found' }, 404, cors);

  const next = { ...items[idx], ...fields, updatedAt: new Date().toISOString() };
  // Stamp who ticked each box, and clear the stamp when a box is unticked, so
  // the details view can always answer "who signed this off?".
  if (fields.ownerCompleted !== undefined) {
    next.ownerCompletedBy = fields.ownerCompleted ? adminEmail : '';
  }
  if (fields.reviewerCompleted !== undefined) {
    next.reviewerCompletedBy = fields.reviewerCompleted ? adminEmail : '';
  }

  // Explicit complete / reopen. Refused unless every required sign-off is in,
  // so the button can't be used to skip the review step it exists to protect.
  if (body.complete !== undefined) {
    if (body.complete) {
      if (!complianceSignedOff(next)) {
        return json({ error: 'Both the owner and reviewer must sign off before this can be completed' }, 400, cors);
      }
      // Date-only, matching ownerCompleted/reviewerCompleted — these are
      // sign-off dates in a compliance record, not timestamps.
      next.completedAt = new Date().toISOString().slice(0, 10);
      next.completedBy = adminEmail;
    } else {
      next.completedAt = '';
      next.completedBy = '';
    }
  }
  // Un-ticking a sign-off on an already-completed item would leave it CLOSED
  // with an incomplete audit trail, so completion is withdrawn with it.
  if ((fields.ownerCompleted !== undefined || fields.reviewerCompleted !== undefined)
      && next.completedAt && !complianceSignedOff(next)) {
    next.completedAt = '';
    next.completedBy = '';
  }
  items[idx] = next;

  // Best-effort disaster-recovery mirror — see pushComplianceToSharePoint.
  Object.assign(next, await pushComplianceToSharePoint(env, next));
  // And the owner's/reviewer's real Outlook calendars. Runs AFTER the status
  // logic above so completing an item withdraws its events in the same save:
  // complianceCalendarOwners() returns nothing for a CLOSED item, and the
  // reconcile deletes every mailbox that is no longer wanted.
  Object.assign(next, (await syncComplianceToOutlook(env, next)).fields || {});

  await saveComplianceItems(env, items);
  // created is always 0 now: completing an item no longer materialises its next
  // occurrence. Kept in the response so the client's `if (res.created)` reload
  // path stays valid rather than reading undefined.
  return json({ item: withComplianceStatus(next), created: 0 }, 200, cors);
}

// Bring a SLICE of the tracker in line with Outlook, and report where to resume.
//
// Batched deliberately. A Worker has a bounded subrequest budget and wall clock,
// and the tracker is ~128 items each needing up to two Graph calls (owner +
// reviewer) — one request could not finish, and a half-finished bulk write to
// real calendars is the worst outcome available. The client loops, so progress
// is visible and a failure resumes from the last completed batch instead of
// starting the whole thing again.
//
// Idempotent: each item's own `outlookEvents` map records what it already has,
// so re-running patches existing events rather than creating duplicates. That is
// what makes it safe to press the button twice.
const COMPLIANCE_OUTLOOK_BATCH = 12;

async function handleAdminComplianceOutlookSync(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  if (workspace !== FRANK_ADMIN_EMAIL) return json({ error: "Compliance is only available in Frank's shared view" }, 403, cors);
  if (!outlookConfigured(env)) return json({ error: 'Outlook is not configured for this deployment' }, 400, cors);

  const body = await request.json().catch(() => ({}));
  const offset = Math.max(0, Number(body && body.offset) || 0);

  const items = await getComplianceItems(env);
  // Index within the FULL list so the offset the client sends back stays valid;
  // filtering first would renumber the slice under it.
  const mine = [];
  items.forEach((it, i) => { if (recordWorkspace(it) === workspace) mine.push(i); });

  const slice = mine.slice(offset, offset + COMPLIANCE_OUTLOOK_BATCH);
  let synced = 0;
  let cleared = 0;
  // Graph calls that errored. Without this a run where every PATCH was rejected
  // reports "0 added or updated", which reads the same as "everything was
  // already up to date" — the opposite conclusion.
  let failed = 0;
  // Names this deployment has no mailbox for. An item owned by someone not in
  // COMPLIANCE_MAILBOX silently gets no calendar entry, which is the one failure
  // mode that looks identical to success — so it is counted and named rather
  // than left for someone to notice months later. Legacy 'Both' rows are
  // migrated away by getComplianceItems before they reach here; a third staff
  // member added as an owner is the case this actually catches.
  const unmapped = new Set();
  for (const i of slice) {
    const item = items[i];
    const isOpen = complianceStatus(item) !== 'CLOSED';
    const wanted = complianceCalendarOwners(item);
    if (isOpen && !wanted.length && /^\d{4}-\d{2}-\d{2}$/.test(String(item.dueDate || '').trim())) {
      [item.owner, complianceReviewerRequired(item) ? item.reviewer : '']
        .filter(Boolean)
        .forEach((n) => { if (!complianceMailboxFor(n)) unmapped.add(String(n).trim()); });
    }
    const { fields, failed: itemFailed } = await syncComplianceToOutlook(env, item);
    failed += itemFailed;
    if (!fields) continue;
    items[i] = { ...item, ...fields };
    if (wanted.length) synced += 1; else cleared += 1;
  }
  // Written once per batch rather than per item: this is one KV blob, and a
  // write per item would be 12 read-modify-writes of the whole tracker.
  if (synced || cleared) await saveComplianceItems(env, items);

  const done = offset + slice.length >= mine.length;
  if (done) {
    await logAudit(env, adminEmail, 'compliance-outlook-sync', { total: mine.length });
  }
  return json({
    processed: offset + slice.length,
    total: mine.length,
    synced,
    cleared,
    failed,
    unmapped: [...unmapped],
    done,
    nextOffset: done ? null : offset + slice.length,
  }, 200, cors);
}

async function handleAdminComplianceDelete(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  if (workspace !== FRANK_ADMIN_EMAIL) return json({ error: "Compliance is only available in Frank's shared view" }, 403, cors);
  const items = await getComplianceItems(env);
  const idx = items.findIndex((x) => x.id === id && recordWorkspace(x) === workspace);
  if (idx < 0) return json({ error: 'Compliance item not found' }, 404, cors);
  const target = items[idx];

  // ?series=1 removes every occurrence of a recurring item ever generated.
  // Without it, deleting just the single open (undated-future) occurrence is
  // enough — completed occurrences already have their successor materialised,
  // so nothing regenerates behind you.
  const wholeSeries = new URL(request.url).searchParams.get('series') === '1' && !!target.seriesId;
  let removedCount = 1;
  let removedItems = [target];
  if (wholeSeries) {
    const sid = target.seriesId;
    removedItems = items.filter((x) => x.seriesId === sid && recordWorkspace(x) === workspace);
    const kept = items.filter((x) => x.seriesId !== sid || recordWorkspace(x) !== workspace);
    removedCount = items.length - kept.length;
    items.length = 0;
    items.push(...kept);
  } else {
    items.splice(idx, 1);
  }
  // Best-effort — see deleteComplianceFromSharePoint. Sequential, not
  // Promise.all: a whole series can be dozens of rows, and this must never
  // fire that many concurrent Graph calls at once.
  for (const it of removedItems) await deleteComplianceFromSharePoint(env, it);
  // The calendar copies go with it. Nothing else would ever remove them — the
  // record carrying their ids is about to be gone — so they would sit on real
  // calendars forever, pointing at an item that no longer exists.
  for (const it of removedItems) {
    for (const [owner, eventId] of Object.entries(complianceOutlookEvents(it))) {
      await deleteOutlookEvent(env, owner, eventId);
    }
  }
  await saveComplianceItems(env, items);
  await logAudit(env, adminEmail, 'compliance-delete', {
    id, item: target.item, series: wholeSeries, removed: removedCount,
  });
  return json({ ok: true, removed: removedCount }, 200, cors);
}

// Replace the whole open register from a spreadsheet — the "reset" import.
//
// COMPLETED ITEMS ARE KEPT. That is the one deliberate limit on how much this
// wipes: a closed item is the evidence that a filing was actually signed off,
// by whom, and on what date. Discarding that because a new spreadsheet was
// imported would destroy the audit trail the register exists to produce, and
// nothing in a fresh import can reconstruct it.
//
// Everything is validated BEFORE anything is deleted, so a bad row on line 40
// cannot leave the register half-wiped with no way back.
async function handleAdminComplianceImport(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  if (workspace !== FRANK_ADMIN_EMAIL) return json({ error: "Compliance is only available in Frank's shared view" }, 403, cors);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items)) return json({ error: 'Invalid JSON body' }, 400, cors);
  if (!body.items.length) return json({ error: 'That file has no rows to import' }, 400, cors);
  if (body.items.length > 1000) return json({ error: 'That file has more than 1000 rows' }, 400, cors);

  // Validate every row first; report the row number so a failure is fixable.
  const prepared = [];
  for (let i = 0; i < body.items.length; i += 1) {
    const { fields, error } = sanitizeComplianceFields(body.items[i], { requireCore: true });
    if (error) return json({ error: `Row ${i + 2}: ${error}` }, 400, cors);
    prepared.push(fields);
  }

  const items = await getComplianceItems(env);
  const otherWorkspaces = items.filter((it) => recordWorkspace(it) !== workspace);
  const workspaceItems = items.filter((it) => recordWorkspace(it) === workspace);
  // complianceStatus, not a stored flag — CLOSED is derived from completedAt.
  const kept = workspaceItems.filter((it) => complianceStatus(it) === 'CLOSED');
  const dropped = workspaceItems.filter((it) => complianceStatus(it) !== 'CLOSED');

  const created = prepared.map((fields) => {
    return {
      id: `cx-${invTs()}-${randomHex(3)}`,
      workspace,
      whatToDo: '', frequency: 'One-time', frequencyDetail: '',
      source: '', notes: '', waitingOn: '',
      complianceArea: '', requirement: 'Best practice',
      ...fields,
      // Imported rows always start outstanding. Sign-off columns in the file
      // are ignored on purpose: this is a reset, and honouring a "signed off"
      // column would let a spreadsheet edit close an item with no real
      // sign-off behind it.
      ownerCompleted: '', ownerCompletedBy: '',
      reviewerCompleted: '', reviewerCompletedBy: '',
      completedAt: '', completedBy: '',
      sharePointItemId: null,
      createdAt: new Date().toISOString(),
      createdBy: adminEmail,
      updatedAt: null,
    };
  });

  const next = [...otherWorkspaces, ...kept, ...created];
  await saveComplianceItems(env, next);

  // Mirrors are best-effort and run AFTER the authoritative save, so a
  // SharePoint problem can't roll back or block an import that already
  // succeeded locally. Sequential to avoid a burst of concurrent Graph calls.
  //
  // Only the deletes actually reach Graph: imported rows always start
  // outstanding, and the mirror carries completed items only, so each push
  // below returns immediately without a network call. Kept rather than removed
  // so this stays correct if imports ever preserve completion.
  for (const it of dropped) await deleteComplianceFromSharePoint(env, it);
  // Dropped rows lose their calendar copies for the same reason a deleted item
  // does. The newly created rows are NOT pushed to Outlook here: an import can
  // be a hundred rows, which is far past what one request's Graph budget and
  // wall-clock allow. They are picked up by the Sync to Outlook button on the
  // Compliance page, which batches (see handleAdminComplianceOutlookSync).
  for (const it of dropped) {
    for (const [owner, eventId] of Object.entries(complianceOutlookEvents(it))) {
      await deleteOutlookEvent(env, owner, eventId);
    }
  }
  for (let i = 0; i < created.length; i += 1) {
    created[i] = await pushComplianceToSharePoint(env, created[i]);
  }
  await saveComplianceItems(env, [...otherWorkspaces, ...kept, ...created]);

  await logAudit(env, adminEmail, 'compliance-import', {
    replaced: dropped.length, imported: created.length, keptCompleted: kept.length,
  });
  return json({
    replaced: dropped.length, imported: created.length, keptCompleted: kept.length,
  }, 200, cors);
}

// ---------- Advisor CRM: contacts ----------
// contact:<email> holds the CRM fields an advisor manages about a person
// (status, household, advisor, tags, …), stored encrypted. It exists
// independently of a portal account: prospects can be created before they
// register, and registered clients without a contact record still appear in
// the merged listing with sensible defaults.
const CONTACT_STATUSES = ['prospect', 'onboarding', 'active', 'inactive'];

// Collect every key under a prefix (bounded by small-firm scale; the same
// full-scan pattern the client listing already uses).
async function listKeys(env, prefix) {
  const names = [];
  let cursor;
  do {
    const page = await env.PORTAL_KV.list({ prefix, cursor });
    for (const key of page.keys) names.push(key.name);
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);
  return names;
}

function sanitizeContactFields(body) {
  const out = {};
  if (typeof body.name === 'string') out.name = body.name.trim().slice(0, 200);
  if (typeof body.preferredName === 'string') out.preferredName = body.preferredName.trim().slice(0, 200);
  if (typeof body.status === 'string') {
    if (!CONTACT_STATUSES.includes(body.status)) return { error: 'Invalid status' };
    out.status = body.status;
  }
  if (typeof body.household === 'string') out.household = body.household.trim().slice(0, 200);
  if (typeof body.phone === 'string') out.phone = body.phone.trim().slice(0, 50);
  if (typeof body.workEmail === 'string') out.workEmail = body.workEmail.trim().toLowerCase().slice(0, 200);
  if (typeof body.workPhone === 'string') out.workPhone = body.workPhone.trim().slice(0, 50);
  if (typeof body.address === 'string') out.address = body.address.trim().slice(0, 300);
  if (typeof body.gender === 'string') out.gender = body.gender.trim().slice(0, 40);
  // Free-text advisor name (e.g. "Fred Sabin"), not tied to an admin account email.
  if (typeof body.advisor === 'string') out.advisor = body.advisor.trim().slice(0, 200);
  if (Array.isArray(body.tags)) {
    out.tags = body.tags
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().slice(0, 40))
      .slice(0, 20);
  }
  if (Array.isArray(body.importantDates)) {
    out.importantDates = body.importantDates
      .filter((d) => d && typeof d.label === 'string' && d.label.trim())
      .map((d) => ({
        label: String(d.label).trim().slice(0, 60),
        date: String(d.date || '').trim().slice(0, 40),
        // Birthdays and anniversaries recur; a closing date or a policy expiry
        // happens once. Legacy rows predate this flag and were all treated as
        // recurring, so absent reads as true to preserve their behaviour.
        repeatsAnnually: d.repeatsAnnually === undefined ? true : !!d.repeatsAnnually,
      }))
      .slice(0, 20);
  }
  return { fields: out };
}

// One boot payload for the CRM UI: contact records merged with portal
// accounts, each entry carrying modules + assignments so the front end can
// compute completion, filters, and search without further calls.
async function handleAdminContacts(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const visibleWorkspaces = workspace === ALL_ADMIN_WORKSPACES
    ? await accessibleWorkspaceOwners(env, adminEmail)
    : workspace;
  return json(
    { contacts: await buildContactList(env, visibleWorkspaces), admins: await allAdminEmails(env), adminNames: await effectiveAdminNames(env), workspace },
    200,
    cors
  );
}

// The merge itself, without the HTTP wrapper, so any other caller can read the
// same shape the CRM UI does rather than re-deriving it from KV.
async function buildContactList(env, workspace = FRANK_ADMIN_EMAIL) {
  const merged = new Map(); // email -> entry
  const visibleWorkspaces = new Set(Array.isArray(workspace) ? workspace : [workspace]);

  // CRM contact records first (decrypt failure fails closed like elsewhere).
  for (const keyName of await listKeys(env, 'contact:')) {
    const rec = await decryptToObject(env, await env.PORTAL_KV.get(keyName));
    if (!rec || !rec.email) continue;
    const owner = recordWorkspace(rec);
    if (!visibleWorkspaces.has(owner)) continue;
    merged.set(rec.email, {
      email: rec.email,
      name: rec.name || '',
      preferredName: rec.preferredName || '',
      status: rec.status || 'prospect',
      archived: !!rec.archived,
      household: rec.household || '',
      advisor: rec.advisor || '',
      phone: rec.phone || '',
      workEmail: rec.workEmail || '',
      workPhone: rec.workPhone || '',
      address: rec.address || '',
      gender: rec.gender || '',
      tags: rec.tags || [],
      importantDates: rec.importantDates || [],
      createdAt: rec.createdAt || null,
      updatedAt: rec.updatedAt || null,
      hasAccount: false,
      modules: {},
      modulesError: false,
      assignments: null,
      workspace: owner,
    });
  }

  // Portal accounts: merge into (or create) an entry per user.
  for (const keyName of await listKeys(env, 'user:')) {
    const email = keyName.slice('user:'.length);
    const userRaw = await env.PORTAL_KV.get(keyName);
    if (!userRaw) continue;
    const user = JSON.parse(userRaw);
    const existing = merged.get(email);
    // A portal account without a CRM contact predates workspace ownership and
    // therefore belongs to Frank until an employee creates its contact record.
    if (!existing && !visibleWorkspaces.has(FRANK_ADMIN_EMAIL)) continue;
    const entry = existing || {
      email,
      name: '',
      preferredName: '',
      status: 'active', // an account holder you never categorized is a live client
      archived: false,
      household: '',
      advisor: '',
      phone: '',
      workEmail: '',
      workPhone: '',
      address: '',
      gender: '',
      tags: [],
      importantDates: [],
      createdAt: null,
      updatedAt: null,
      modules: {},
      modulesError: false,
      assignments: null,
      workspace: FRANK_ADMIN_EMAIL,
    };
    entry.hasAccount = true;
    if (!entry.name) entry.name = user.name || '';
    try {
      // Through effectiveModulesFor, NOT responses:<email> directly: most
      // assessments now live in a shared household record, and reading the
      // client's own key alone would show every one of them as "Not started" to
      // the advisor for anyone in a household.
      entry.modules = await effectiveModulesFor(env, email);
    } catch {
      entry.modulesError = true;
    }
    entry.assignments = loadAssignments(await env.PORTAL_KV.get(`assignments:${email}`));
    merged.set(email, entry);
  }

  return [...merged.values()];
}

async function contactBelongsToWorkspace(env, email, workspace) {
  try {
    const contact = await decryptToObject(env, await env.PORTAL_KV.get(`contact:${email}`));
    if (contact) return recordWorkspace(contact) === workspace;
  } catch {
    return false; // unreadable ownership must fail closed
  }
  // Portal-only clients have no ownership field and are part of the legacy
  // dataset, which belongs to Frank until a contact record assigns them.
  return workspace === FRANK_ADMIN_EMAIL && !!(await env.PORTAL_KV.get(`user:${email}`));
}

// Create/update the CRM fields for one contact. Partial update: only the
// fields present in the body change; the rest of the record is preserved.
async function handleAdminUpsertContact(request, env, cors, targetEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const email = String(targetEmail).trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Invalid contact email' }, 400, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);

  const { fields, error } = sanitizeContactFields(body);
  if (error) return json({ error }, 400, cors);

  const stored = await decryptToObject(env, await env.PORTAL_KV.get(`contact:${email}`));
  if (stored && recordWorkspace(stored) !== workspace) return json({ error: 'Contact not found in this workspace' }, 404, cors);
  // A portal account with no contact record is legacy Frank data. Only a firm
  // shared firm view manager may deliberately claim it into a new employee's display; otherwise an
  // employee who guessed the email could silently take ownership of the client.
  if (!stored && workspace !== FRANK_ADMIN_EMAIL && !(await canManageSharedFirmView(env, adminEmail))
      && await env.PORTAL_KV.get(`user:${email}`)) {
    return json({ error: 'Only shared firm view managers can assign an existing portal client to this admin display' }, 403, cors);
  }
  const existing = stored || {
    email,
    status: 'prospect',
    workspace,
    createdAt: new Date().toISOString(),
  };
  let record = { ...existing, ...fields, email, workspace, updatedAt: new Date().toISOString() };
  // Best-effort two-way mirror — see pushContactToSharePoint. May return the
  // record adopted from a newer SharePoint edit instead of what was just
  // submitted here; either way, what's persisted and returned is the true
  // final state, not necessarily this request's own input.
  record = await pushContactToSharePoint(env, record);
  await env.PORTAL_KV.put(`contact:${email}`, await encryptJSON(env, record));
  await logAudit(env, adminEmail, 'update-contact', { client: email });
  return json({ contact: record }, 200, cors);
}

// Archive (soft-delete) or restore a contact. Nothing is erased — an archived
// contact is just hidden from the working views; their tasks/notes/timeline are
// untouched. Creates a contact: record if the client only had a portal account.
async function handleAdminArchiveContact(request, env, cors, targetEmail, archived) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const email = String(targetEmail).trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Invalid contact email' }, 400, cors);
  const stored = await decryptToObject(env, await env.PORTAL_KV.get(`contact:${email}`));
  if (stored && recordWorkspace(stored) !== workspace) return json({ error: 'Contact not found in this workspace' }, 404, cors);
  const existing = stored || {
    email,
    status: 'prospect',
    workspace,
    createdAt: new Date().toISOString(),
  };
  const record = {
    ...existing,
    email,
    workspace,
    archived,
    archivedAt: archived ? new Date().toISOString() : null,
    archivedBy: archived ? adminEmail : null,
    updatedAt: new Date().toISOString(),
  };
  await env.PORTAL_KV.put(`contact:${email}`, await encryptJSON(env, record));
  await logAudit(env, adminEmail, archived ? 'archive-contact' : 'unarchive-contact', { client: email });
  return json({ contact: record }, 200, cors);
}

// ---------- Advisor CRM: client additional info ----------
// The suitability / KYC block behind a contact's **Additional Info** tab:
// employment, written-agreement offering dates, investment profile, estimated
// net worth, tax figures, health, and identifying documents.
//
// Its own KV record (`clientinfo:<email>`), NOT fields on the contact, for two
// reasons:
//   1. Privacy. This holds passport, green-card and driver's-licence numbers and
//      medical notes. On the contact record it would ride in the /api/admin/
//      contacts boot payload for EVERY contact on every page load and every 20s
//      poll. Separate means it is fetched only for the client being looked at.
//   2. The contact record round-trips through the SharePoint Contacts sync.
//      There are no columns for any of this, and keeping it out of that record
//      keeps it out of that code path entirely.
//
// Encrypted at rest like every other client record — which means, as everywhere
// else, only if DATA_ENCRYPTION_KEY is set.
const CLIENT_INFO_ENUMS = {
  investmentObjective: ['', 'Capital Preservation', 'Income', 'Growth & Income', 'Growth', 'Aggressive Growth', 'Speculation'],
  timeHorizon: ['', 'Less than 1 year', '1-3 years', '3-5 years', '5-10 years', 'More than 10 years'],
  riskTolerance: ['', 'Conservative', 'Moderately Conservative', 'Moderate', 'Moderately Aggressive', 'Aggressive'],
  experienceMutualFunds: ['', 'None', 'Limited', 'Good', 'Extensive'],
  experienceStocksBonds: ['', 'None', 'Limited', 'Good', 'Extensive'],
  experiencePartnerships: ['', 'None', 'Limited', 'Good', 'Extensive'],
  confirmedByTaxReturn: ['', 'Yes', 'No'],
  taxBracket: ['', '10%', '12%', '22%', '24%', '32%', '35%', '37%'],
  smoker: ['', 'Yes', 'No'],

  // Prospect pipeline fields. Same record and same endpoint as the suitability
  // block above — the key sets are disjoint, so a prospect's Additional Info and
  // a client's coexist and converting a prospect keeps both. Must stay
  // character-identical to AI_OPTIONS in public/admin/contacts.html and
  // $clientInfoEnums in dev-server.ps1.
  pipelineStage: ['', 'New Lead', 'Contacted', 'Meeting Scheduled', 'Discovery Held', 'Proposal Delivered',
    'Follow-Up', 'Verbal Commitment', 'Paperwork Out', 'Dormant / Nurture', 'Closed - Lost'],
  prospectRating: ['', 'A - High priority', 'B - Medium', 'C - Low', 'D - Nurture only'],
  closeProbability: ['', '10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%'],
  leadSource: ['', 'Client Referral', 'Professional / COI Referral', 'Personal Network', 'Website / Inbound',
    'Seminar or Event', 'Social Media', 'Advertising', 'Cold Outreach', 'Existing Client Family Member',
    'Walk-In', 'Other'],
  referralThankYouSent: ['', 'Yes', 'No'],
  preferredContactMethod: ['', 'Email', 'Phone', 'Text', 'In Person', 'Video Call'],
  marketingConsent: ['', 'Yes', 'No'],
  primaryPlanningNeed: ['', 'Retirement Planning', 'Investment Management', 'Tax Planning', 'Estate Planning',
    'Insurance & Risk', 'Education Funding', 'Business or Succession Planning', 'Divorce or Life Transition',
    'Charitable Giving', 'Comprehensive Planning'],
  decisionTimeframe: ['', 'Immediate', '1-3 months', '3-6 months', '6-12 months', 'More than a year', 'Unknown'],
  fitAssessment: ['', 'Strong fit', 'Good fit', 'Marginal', 'Not a fit', 'Too early to say'],
  prospectOutcome: ['', 'Open', 'Won', 'Lost', 'Dormant'],
  outcomeReason: ['', 'Fees', 'Investment approach', 'Personal fit', 'Stayed with current advisor',
    'Chose another firm', 'Timing - not ready', 'No response', 'Not a fit for us', 'Other'],
};

const CLIENT_INFO_DATES = [
  'occupationStartDate', 'retirementDate',
  'signedFeeAgreementDate', 'signedIpsAgreementDate', 'signedFpAgreementDate',
  'lastAdvOfferingDate', 'initialCrsOfferingDate', 'lastCrsOfferingDate',
  'lastPrivacyOfferingDate', 'driversLicenseIssuedDate', 'driversLicenseExpiresDate',
  // Prospect pipeline dates.
  'expectedCloseDate', 'nextStepDate', 'firstContactDate', 'firstMeetingDate',
  'lastContactDate', 'doNotContactUntil', 'crsDeliveredDate', 'advDeliveredDate',
  'privacyNoticeDeliveredDate', 'proposalSentDate', 'agreementSentDate', 'outcomeDate',
];

// Money fields are stored as numbers so the derived net-worth figures are
// arithmetic rather than string parsing. Negative is allowed: an underwater
// balance sheet is a real answer, not a typo to reject.
// Prospect money figures are estimates the advisor was told, not verified
// balances — they are deliberately NOT summed into clientInfoDerived()'s net
// worth, which describes a client's actual balance sheet.
const CLIENT_INFO_MONEY = ['grossAnnualIncome', 'assets', 'nonLiquidAssets', 'liabilities', 'adjustedGrossIncome', 'estimatedTaxes',
  'estimatedInvestableAssets', 'estimatedHeldAwayAssets', 'expectedAssetsToTransfer',
  'estimatedProspectIncome', 'estimatedAnnualRevenue'];

// Short free text, with the cap each one gets.
const CLIENT_INFO_TEXT = {
  occupation: 120,
  otherInvestingExperience: 2000,
  taxYear: 4,
  height: 20,
  weight: 20,
  medicalConditions: 2000,
  driversLicenseNumber: 60,
  driversLicenseState: 40,
  birthPlace: 120,
  maidenName: 120,
  passportNumber: 60,
  greenCardNumber: 60,
  personalInterests: 2000,
  importantInformation: 4000,
  // Prospect pipeline free text.
  nextStep: 200,
  referredBy: 120,
  referralRelationship: 120,
  campaignOrEvent: 120,
  meetingsHeld: 10,
  bestTimeToReach: 120,
  currentAdvisorOrFirm: 120,
  currentCustodian: 120,
  reasonForChange: 2000,
  servicesOfInterest: 2000,
  decisionMakers: 200,
  lifeEventsOrTriggers: 2000,
  objectionsOrConcerns: 2000,
  competingFirms: 200,
  prospectNotes: 4000,
};

// Estimated net worth and estimated liquid net worth are DERIVED, never stored:
// two places holding the same number is one place for them to disagree. Assets
// here means liquid assets, which is what makes liquid net worth assets minus
// liabilities.
function clientInfoDerived(info) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    estimatedNetWorth: n(info.assets) + n(info.nonLiquidAssets) - n(info.liabilities),
    estimatedLiquidNetWorth: n(info.assets) - n(info.liabilities),
  };
}

function sanitizeClientInfo(body) {
  const out = {};
  for (const [key, max] of Object.entries(CLIENT_INFO_TEXT)) {
    if (body[key] !== undefined) out[key] = String(body[key] == null ? '' : body[key]).trim().slice(0, max);
  }
  for (const key of CLIENT_INFO_DATES) {
    if (body[key] === undefined) continue;
    const v = String(body[key] || '').trim();
    // Empty clears the field; anything else must be a real ISO date, so a
    // half-typed "2026-3" can't be stored and then render as a bad date.
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: `${key} must be a date (YYYY-MM-DD)` };
    if (v && Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) return { error: `${key} is not a real date` };
    out[key] = v;
  }
  for (const key of CLIENT_INFO_MONEY) {
    if (body[key] === undefined) continue;
    const raw = body[key];
    if (raw === '' || raw === null) { out[key] = null; continue; }
    const num = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(num)) return { error: `${key} must be a number` };
    // Rounded to cents: a float with more precision than money has invites
    // 1234.5600000000001 in the UI.
    out[key] = Math.round(num * 100) / 100;
  }
  for (const [key, allowed] of Object.entries(CLIENT_INFO_ENUMS)) {
    if (body[key] === undefined) continue;
    const v = String(body[key] || '').trim();
    if (!allowed.includes(v)) return { error: `${key} must be one of: ${allowed.filter(Boolean).join(', ')}` };
    out[key] = v;
  }
  if (body.taxYear !== undefined && out.taxYear && !/^\d{4}$/.test(out.taxYear)) {
    return { error: 'taxYear must be a 4-digit year' };
  }
  return { fields: out };
}

async function handleAdminGetClientInfo(request, env, cors, email) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const key = `clientinfo:${String(email || '').trim().toLowerCase()}`;
  let info = {};
  try {
    info = (await decryptToObject(env, await env.PORTAL_KV.get(key))) || {};
  } catch (err) {
    // Fail closed like the rest of the CRM: an undecryptable record must not
    // read as empty, or the next save would overwrite it with blanks.
    return json({ error: 'Could not decrypt this client info record' }, 500, cors);
  }
  return json({ info: { ...info, ...clientInfoDerived(info) } }, 200, cors);
}

async function handleAdminUpdateClientInfo(request, env, cors, email) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const addr = String(email || '').trim().toLowerCase();
  if (!isValidEmail(addr)) return json({ error: 'Invalid email' }, 400, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeClientInfo(body);
  if (error) return json({ error }, 400, cors);

  const key = `clientinfo:${addr}`;
  let existing;
  try {
    existing = (await decryptToObject(env, await env.PORTAL_KV.get(key))) || {};
  } catch {
    return json({ error: 'Could not decrypt this client info record' }, 500, cors);
  }
  const record = {
    ...existing,
    ...fields,
    email: addr,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedBy: adminEmail,
  };
  await env.PORTAL_KV.put(key, await encryptJSON(env, record));
  // Field NAMES only. The values here include passport and licence numbers and
  // medical notes; the audit log has a 13-month TTL and its own viewer, and
  // copying that material into it would spread it for no investigative gain.
  await logAudit(env, adminEmail, 'update-client-info', {
    client: addr,
    fields: Object.keys(fields).sort(),
  });
  return json({ info: { ...record, ...clientInfoDerived(record) } }, 200, cors);
}

// ---------- Advisor CRM: client documents ----------
// Files an admin attaches to a contact — tax returns, statements, a signed form
// that arrived by post. Split across two stores on purpose:
//
//   bytes    -> a SharePoint document library ("Client Documents"), one folder
//               per client, uploaded through the same chunked upload-session
//               machinery the Learning tab uses.
//   metadata -> KV (`clientdoc:<email>:<invTs>-<rand>`): the display name, the
//               original filename, who attached it and when, and the webUrl.
//
// Keeping the *name* in KV rather than a SharePoint Title column is the point of
// the split: no custom column has to exist in the library for naming to work,
// listing a client's documents costs no Graph call at all, and a rename is a KV
// write instead of a PATCH that can fail against a column that isn't there.
// SharePoint still holds the file itself, so the firm's existing retention and
// backup policy covers client records rather than a second store having to.
//
// Needs SHAREPOINT_CLIENT_DOCS_LIST_ID. Unset -> `configured: false` and the tab
// says which setting is missing (the Learning tab's pattern) rather than
// pretending uploads are broken.
const CLIENT_DOC_CHUNK = 5 * 1024 * 1024; // multiple of the 320 KiB Graph requires
const CLIENT_DOC_MAX = 250 * 1024 * 1024; // 250 MB — statements and scans, not video

// SharePoint rejects " * : < > ? / \ | and leading/trailing dots and spaces.
function sanitizeDocFilename(raw) {
  const base = String(raw || '').split(/[\\/]/).pop();
  return base.replace(/["*:<>?|]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 200);
}

// Documents file under the client's *family*, so the library's Name column
// reads like a filing cabinet instead of a list of mailboxes. Resolution order,
// first match wins:
//
//   1. The family this contact belongs to -> the family's name ("Smith Family").
//   2. No family -> the contact's own name, surname first ("Smith, John").
//   3. No name on record -> the email, which is what this used to do for
//      everyone and is where their earlier documents already are.
//
// A *company* grouping deliberately does not count: only families were asked
// for, so a contact who is only in a company files under their own name.
//
// Neither family names nor person names are unique, and a shared folder would
// commingle unrelated clients' records — a compliance problem, not a tidiness
// one. See uniqueFolderName for how that is handled.
//
// Resolved per upload rather than stored on the contact: nothing here renames a
// SharePoint folder, so a stored value would only go stale. The resolved name IS
// recorded on each document (see the chunk handler) so it is always possible to
// tell where a given file went without asking Graph.

// Sort helper: oldest record first, id as a stable tie-break for records
// written before createdAt existed.
function oldestFirst(a, b) {
  const at = String(a.createdAt || ''), bt = String(b.createdAt || '');
  if (at !== bt) {
    if (!at) return 1;
    if (!bt) return -1;
    return at.localeCompare(bt);
  }
  return String(a.id || '').localeCompare(String(b.id || ''));
}

// The plain name when `id` is its only holder, otherwise the name with `id`
// appended. The oldest holder keeps the clean name, so an existing folder never
// changes because a same-named record was created later — only the newcomers
// are suffixed. `holders` is [{ key, id, createdAt }] with key already lowered.
function uniqueFolderName(name, id, holders) {
  const key = String(name || '').trim().toLowerCase();
  const sharing = holders.filter((h) => h.key === key).sort(oldestFirst);
  if (sharing.length < 2 || sharing[0].id === id) return sanitizeDocFilename(name);
  return sanitizeDocFilename(`${name} (${id})`);
}

// Parts of a surname rather than a given name, so "Mary Van Der Berg" files
// under "Van Der Berg", not "Berg".
const SURNAME_PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della',
  'di', 'da', 'dos', 'du', 'la', 'le', 'lo', 'el', 'al', 'bin', 'ibn', 'mac', 'mc',
  'st', 'st.', 'saint', 'ter', 'ten', 'op', 'vander', 'vande']);
// Generational and credential tails that must not be mistaken for a surname, so
// "John Smith Jr." files under "Smith", not "Jr.".
const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v',
  'md', 'm.d.', 'phd', 'ph.d.', 'esq', 'esq.', 'cpa', 'cfp', 'cfa', 'dds', 'do',
  'rn', 'jd', 'llm', 'ea']);
// Titles dropped from the front for the same reason.
const NAME_TITLES = new Set(['mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'miss',
  'dr', 'dr.', 'prof', 'prof.', 'rev', 'rev.', 'sir', 'hon', 'hon.', 'fr', 'fr.']);

// "John Smith" -> "Smith, John". The contact record holds one free-text `name`
// and no surname field, so the surname has to be inferred; the particle, suffix
// and title lists above are what keep that inference from filing someone under
// "Jr." or "Berg". Falls back to the email when there is nothing to work with.
function personDocFolder(rawName, email) {
  const emailFolder = sanitizeDocFilename(String(email || '').toLowerCase());
  const cleaned = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return emailFolder;
  // Already typed surname-first — however it was entered is how it should file.
  if (cleaned.includes(',')) return sanitizeDocFilename(cleaned) || emailFolder;

  let parts = cleaned.split(' ');
  const suffixes = [];
  while (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1].toLowerCase())) {
    suffixes.unshift(parts.pop());
  }
  while (parts.length > 1 && NAME_TITLES.has(parts[0].toLowerCase())) parts.shift();
  const tail = suffixes.length ? ' ' + suffixes.join(' ') : '';
  // A mononym ("Cher"), or a name stripped down to one token: nothing to invert.
  if (parts.length === 1) return sanitizeDocFilename(parts[0] + tail) || emailFolder;

  // Walk back over particles so the whole surname travels to the front, while
  // cut > 1 guarantees at least one token is left as the given name.
  let cut = parts.length - 1;
  while (cut > 1 && SURNAME_PARTICLES.has(parts[cut - 1].toLowerCase())) cut--;
  const surname = parts.slice(cut).join(' ');
  const given = parts.slice(0, cut).join(' ');
  return sanitizeDocFilename(`${surname}, ${given}${tail}`) || emailFolder;
}

async function resolveClientDocFolder(env, email) {
  const addr = String(email || '').trim().toLowerCase();
  const emailFolder = sanitizeDocFilename(addr);

  // A folder name is not worth failing an upload over: any read problem falls
  // back to the mailbox folder, which still lands the file under this client.
  try {
    const { items } = await readAllEncrypted(env, 'household:');
    const families = items.filter((h) => h && h.id && h.name && groupKindOf(h) !== 'company' && !h.archived);
    const mine = families
      .filter((h) => (h.members || []).some((m) => m && String(m.email || '').toLowerCase() === addr))
      .sort(oldestFirst);
    if (mine.length) {
      // A contact is not stopped from joining two families anywhere in the app,
      // so the oldest wins rather than whichever happened to be read first.
      const family = mine[0];
      return uniqueFolderName(family.name, family.id, families.map((h) => ({
        key: String(h.name).trim().toLowerCase(), id: h.id, createdAt: h.createdAt,
      })));
    }

    // No family: file under the person's own name, surname first.
    const { items: contacts } = await readAllEncrypted(env, 'contact:');
    const me = contacts.find((c) => c && String(c.email || '').toLowerCase() === addr);
    const mine2 = personDocFolder(me && me.name, addr);
    if (mine2 === emailFolder) return emailFolder; // no name to collide on
    // Two contacts with the same name would share a folder, so the same
    // oldest-keeps-it rule applies, with the email standing in as the id.
    const holders = contacts
      .filter((c) => c && c.email && c.name)
      .map((c) => ({
        key: personDocFolder(c.name, c.email).toLowerCase(),
        id: String(c.email).toLowerCase(),
        createdAt: c.createdAt,
      }));
    return uniqueFolderName(mine2, addr, holders);
  } catch (err) {
    console.error('Could not resolve a document folder, using the mailbox folder:', err);
    return emailFolder;
  }
}

async function getClientDocsDriveId(env, token) {
  const url = `https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}`
    + `/lists/${env.SHAREPOINT_CLIENT_DOCS_LIST_ID}/drive`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Could not resolve the Client Documents drive (Graph ' + res.status + ')');
  const drive = await res.json();
  if (!drive.id) throw new Error('Client Documents drive has no id');
  return drive.id;
}

// Fires once, automatically, the instant a client's signature transitions from
// absent to present (see the nowSigned && !prevSigned check in
// handleOnboardingSave) — no admin click involved. Uses the SAME Graph
// plumbing as the manual "File to Client Documents" button
// (resolveClientDocFolder, getGraphToken, getClientDocsDriveId) so a signature
// filed automatically lands in exactly the folder a manual attach would have
// used. Skips silently (not an error) when SharePoint isn't configured — same
// rule the manual button already follows.
// Fires on the SAME transition as autoFileSignedAgreement (signature absent ->
// present), so signing in the portal shows up on the client's family/company
// Overview — Key Documents — Advisory Agreement without an admin typing it in
// by hand.
//
// A direct KV read-modify-write, NOT a full save through
// handleAdminUpdateHousehold: this must only ever touch keyDocuments.advisoryAgreement,
// never risk disturbing Members, Name, or triggering the two-way SharePoint
// contact mirror as a side effect of an automated background action.
// keyDocuments is merged, matching sanitizeHouseholdFields/handleAdminUpdateHousehold:
// an existing IPS date must survive this write untouched.
//
// Silently does nothing if the client is in no family or company yet — the same
// "orphan" case the CSV importer surfaces as a warning rather than an error, and
// consistent with the manual Key Documents panel having nowhere to put a date
// for someone who isn't in a grouping either.
//
// Overwrites rather than preserving an earlier date on purpose: a clear-and-resign
// re-fires this whole function, and the recorded date should reflect the LATEST
// real signature, not the first — the same reasoning autoFileSignedAgreement
// already uses for why its SharePoint upload is conflictBehavior=replace.
async function recordAdvisoryAgreementDate(env, clientEmail, signedAt) {
  const date = String(signedAt || '').slice(0, 10);
  if (!isIsoDate(date)) return;
  const addr = String(clientEmail || '').trim().toLowerCase();
  const { items } = await readAllEncrypted(env, 'household:');
  const matches = items
    .filter((h) => h && h.id && !h.archived && (h.members || [])
      .some((m) => m && String(m.email || '').toLowerCase() === addr))
    .sort((a, b) => {
      const kind = Number(groupKindOf(a) === 'company') - Number(groupKindOf(b) === 'company');
      return kind || oldestFirst(a, b);
    });
  const hh = matches[0];
  if (!hh) return;
  const record = {
    ...hh,
    keyDocuments: { ...(hh.keyDocuments || {}), advisoryAgreement: date },
    updatedAt: new Date().toISOString(),
  };
  await env.PORTAL_KV.put(`household:${hh.id}`, await encryptJSON(env, record));
}

async function autoFileSignedAgreement(env, onboardingId, clientEmail, data) {
  if (!env.SHAREPOINT_CLIENT_DOCS_LIST_ID) return;
  const agreement = data && data.agreement;
  if (!agreement || !agreement.signatureDataUrl) return;

  const templateRes = await env.ASSETS.fetch(new Request('https://assets.local/onboarding/advisory-agreement.pdf'));
  if (!templateRes.ok) throw new Error('Could not read the agreement template asset');
  const templateBytes = await templateRes.arrayBuffer();

  const pdfBytes = await buildSignedAgreementServer(templateBytes, {
    signatureDataUrl: agreement.signatureDataUrl,
    signedAt: agreement.signedAt,
    clientName: resolveClientNameServer(data),
  });

  const filename = `Advisory_Agreement_${onboardingId.replace(/[^A-Za-z0-9._-]+/g, '_')}_signed.pdf`;
  const token = await getGraphToken(env);
  const driveId = await getClientDocsDriveId(env, token);
  const folder = await resolveClientDocFolder(env, clientEmail);
  const path = `${folder}/${filename}`;
  const uploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/`
    + `${path.split('/').map(encodeURIComponent).join('/')}:/content`
    // `replace`, not `rename`: the filename is fully deterministic from
    // onboardingId, so a name collision on this exact path is always the SAME
    // logical document (a re-sign after Clear), never an unrelated file. A
    // client can clear and re-sign, which re-fires this whole function; the
    // filed copy should reflect the latest signature, not accumulate
    // "(1)", "(2)" copies of a superseded one.
    + `?@microsoft.graph.conflictBehavior=replace`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
    body: pdfBytes,
  });
  if (!uploadRes.ok) {
    throw new Error('Graph rejected the auto-filed agreement (' + uploadRes.status + '): '
      + (await uploadRes.text()).slice(0, 300));
  }
  const item = await uploadRes.json();

  // Find-or-update by filename (not create-always): the filename is
  // deterministic, so a re-sign must UPDATE the existing clientdoc record in
  // place, or the Documents tab would show two rows for what Graph just
  // replaced as one file.
  const { items: existingDocs } = await readAllEncrypted(env, `clientdoc:${clientEmail}:`);
  const existing = existingDocs.find((d) => d.filename === filename);
  const nowIso = new Date().toISOString();
  const docRecord = {
    id: existing ? existing.id : `${clientEmail}:${invTs()}-${randomHex(4)}`,
    client: clientEmail,
    name: `Advisory Agreement (Signed) — ${onboardingId}`,
    filename,
    folder,
    webUrl: item.webUrl || '',
    driveId,
    driveItemId: item.id || '',
    size: typeof item.size === 'number' ? item.size : pdfBytes.byteLength,
    // Distinct from 'admin' (a staff attachment) and 'client' (a client send-in)
    // — this was neither; nobody picked a file, the record filed itself. The
    // Documents tab must render this source distinctly rather than crediting an
    // admin who didn't do it.
    uploadedBy: 'system',
    source: 'system',
    category: 'miscellaneous',
    uploadedAt: existing ? existing.uploadedAt : nowIso,
    updatedAt: nowIso,
  };
  await env.PORTAL_KV.put(`clientdoc:${docRecord.id}`, await encryptJSON(env, docRecord));
  await logTimeline(env, clientEmail, 'agreement-filed', 'system', { onboardingId, webUrl: docRecord.webUrl });
}

async function handleAdminListClientDocs(request, env, cors, email) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const addr = String(email || '').trim().toLowerCase();
  const { items, errors } = await readAllEncrypted(env, `clientdoc:${addr}:`);
  // Inverted-timestamp keys already list newest-first; sorted again so a record
  // written before this used inverted keys can't jump the order.
  items.sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
  return json({
    documents: items,
    decryptErrors: errors,
    configured: !!env.SHAREPOINT_CLIENT_DOCS_LIST_ID,
  }, 200, cors);
}

// ---- Shared upload plumbing (admin attach AND client send-in) ----
// Extracted rather than copied for the client path: the Graph dance is fiddly
// (upload session, the sharepoint.com host check on the returned URL,
// Content-Range arithmetic, inverted-timestamp ids) and two copies of it would
// drift — which is exactly the failure this file's comments keep warning about.
// Callers own what legitimately differs: authentication, their own size and
// type limits, and what the finished record says.

// `extra` is merged into the encrypted ticket, so a caller can carry its own
// context through the chunk loop (the client path uses it for requestId).
async function createClientDocUploadSession(env, addr, filename, name, extra) {
  const token = await getGraphToken(env);
  const driveId = await getClientDocsDriveId(env, token);
  const folder = await resolveClientDocFolder(env, addr);
  const path = `${folder}/${filename}`;
  // The folder is created implicitly by uploading into its path, so no
  // separate "does this client have a folder yet" round trip is needed.
  const sessionUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/`
    + `${path.split('/').map(encodeURIComponent).join('/')}:/createUploadSession`;
  const res = await fetch(sessionUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: filename } }),
  });
  if (!res.ok) throw new Error('Graph API error ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const session = await res.json();
  if (!session.uploadUrl) throw new Error('Graph returned no uploadUrl');
  // `folder` rides along so the finished record can name the folder the bytes
  // actually went into, rather than re-resolving it after the upload and
  // possibly recording a different answer than the path used above.
  return encryptJSON(env, {
    uploadUrl: session.uploadUrl, driveId, folder, filename, name, client: addr, ...(extra || {}),
  });
}

// Reads and validates the ticket. Returns { error } for the caller to return
// verbatim, or { ticket }.
async function readUploadTicket(env, request) {
  let ticket;
  try {
    ticket = await decryptToObject(env, request.headers.get('X-Upload-Ticket') || '');
  } catch {
    return { error: 'Upload ticket could not be read — start the upload again' };
  }
  if (!ticket || !ticket.uploadUrl) return { error: 'Missing upload ticket' };
  let host = '';
  try { host = new URL(ticket.uploadUrl).hostname; } catch { host = ''; }
  // The ticket is encrypted with our own key, so this can't be attacker-supplied
  // — but it is a URL we then POST bytes to, and pinning the host means a bug
  // that ever let one be forged still can't be used to proxy them elsewhere.
  if (!/\.sharepoint\.com$/i.test(host)) return { error: 'Upload ticket points somewhere unexpected' };
  return { ticket };
}

// Pushes one chunk. Returns { status: 202-ish } shapes the caller turns into
// JSON: { done: false, nextOffset } while more is expected, or { item } with the
// finished driveItem once SharePoint has the whole file.
async function proxyClientDocChunk(env, ticket, offset, chunk) {
  const end = offset + chunk.byteLength - 1;
  const res = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes ${offset}-${end}/${ticket.size}` },
    body: chunk,
  });
  if (res.status === 202) {
    await res.text().catch(() => '');
    return { done: false, nextOffset: end + 1 };
  }
  if (!res.ok) {
    throw new Error('SharePoint rejected the chunk (' + res.status + '): ' + (await res.text()).slice(0, 300));
  }
  return { done: true, item: await res.json() };
}

// Builds the KV record for a finished upload. `uploadedBy` is an admin email on
// the attach path and the client's own address on the send-in path; `source`
// distinguishes them, and is what gates client visibility (see
// handleGetClientDocuments — a client must never be shown an advisor's
// attachment, which was filed with no expectation of being visible to them).
function clientDocRecord(ticket, item, uploadedBy, source) {
  const id = `${ticket.client}:${invTs()}-${randomHex(4)}`;
  return {
    id,
    client: ticket.client,
    name: ticket.name,
    filename: item.name || ticket.filename,
    // The folder this file went into. Folder names are derived per upload and
    // nothing renames a folder afterwards, so without this there is no way to
    // tell where an older file landed — records written before this field
    // existed have none and predate family folders entirely.
    folder: ticket.folder || '',
    webUrl: item.webUrl || '',
    driveId: ticket.driveId,
    driveItemId: item.id || '',
    size: typeof item.size === 'number' ? item.size : ticket.size,
    uploadedBy,
    source,
    // Only the client path sets one; an advisor attachment has no section to
    // file under, and defaults to Miscellaneous if anything ever reads it.
    category: sanitizeDocCategory(ticket.category),
    uploadedAt: new Date().toISOString(),
  };
}

async function handleAdminClientDocUploadStart(request, env, cors, email) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const addr = String(email || '').trim().toLowerCase();
  if (!isValidEmail(addr)) return json({ error: 'Invalid email' }, 400, cors);
  if (!env.SHAREPOINT_CLIENT_DOCS_LIST_ID) {
    return json({ error: 'SHAREPOINT_CLIENT_DOCS_LIST_ID is not set' }, 400, cors);
  }
  const body = await request.json().catch(() => ({}));
  const filename = sanitizeDocFilename(body.filename);
  const size = Number(body.size);
  const name = String(body.name || '').trim().slice(0, 200);

  if (!filename) return json({ error: 'A file is required' }, 400, cors);
  if (!name) return json({ error: 'A document name is required' }, 400, cors);
  if (!Number.isFinite(size) || size <= 0) return json({ error: 'File size is missing' }, 400, cors);
  if (size > CLIENT_DOC_MAX) return json({ error: 'File is larger than the 250 MB limit' }, 400, cors);

  try {
    const ticket = await createClientDocUploadSession(env, addr, filename, name, { size });
    return json({ ticket, chunkSize: CLIENT_DOC_CHUNK }, 200, cors);
  } catch (err) {
    console.error('Failed to start client document upload:', err);
    return json({ error: 'Could not start the upload: ' + (err && err.message) }, 500, cors);
  }
}

// Same shape as the Learning chunk endpoint — see the comment there for why the
// bytes are proxied and why the session rides in an encrypted ticket instead of
// KV. The client is taken from the ticket, not the URL, so a ticket can't be
// replayed against a different contact.
async function handleAdminClientDocUploadChunk(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);

  const { ticket, error } = await readUploadTicket(env, request);
  if (error) return json({ error }, 400, cors);

  const offset = Number(request.headers.get('X-Upload-Offset'));
  if (!Number.isFinite(offset) || offset < 0) return json({ error: 'Bad chunk offset' }, 400, cors);
  const chunk = await request.arrayBuffer();
  if (!chunk.byteLength) return json({ error: 'Empty chunk' }, 400, cors);
  if (offset + chunk.byteLength - 1 >= ticket.size) {
    return json({ error: 'Chunk runs past the declared file size' }, 400, cors);
  }

  try {
    const out = await proxyClientDocChunk(env, ticket, offset, chunk);
    if (!out.done) return json(out, 200, cors);
    const record = clientDocRecord(ticket, out.item, adminEmail, 'admin');
    await env.PORTAL_KV.put(`clientdoc:${record.id}`, await encryptJSON(env, record));
    await logAudit(env, adminEmail, 'attach-client-document', {
      client: ticket.client, name: record.name, filename: record.filename,
    });
    return json({ done: true, document: record }, 200, cors);
  } catch (err) {
    console.error('Client document chunk upload failed:', err);
    return json({ error: 'Upload failed: ' + (err && err.message) }, 500, cors);
  }
}

// Rename only — the display name is the one thing about an attachment worth
// correcting after the fact, and it lives in KV, so this never touches Graph.
async function handleAdminRenameClientDoc(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const raw = await env.PORTAL_KV.get(`clientdoc:${id}`);
  if (!raw) return json({ error: 'Document not found' }, 404, cors);
  const existing = await decryptToObject(env, raw);
  const body = await request.json().catch(() => null);
  const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  if (!name) return json({ error: 'A document name is required' }, 400, cors);
  const record = { ...existing, name, updatedAt: new Date().toISOString(), updatedBy: adminEmail };
  await env.PORTAL_KV.put(`clientdoc:${id}`, await encryptJSON(env, record));
  await logAudit(env, adminEmail, 'rename-client-document', { client: existing.client, id, name });
  return json({ document: record }, 200, cors);
}

// Removes the attachment. The file in SharePoint goes too — leaving it would
// make the library disagree with the tab, and SharePoint's own recycle bin is
// the recovery path. A Graph failure still drops the metadata (best-effort,
// logged): the alternative is a row that can't be removed from the UI at all.
async function handleAdminDeleteClientDoc(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const raw = await env.PORTAL_KV.get(`clientdoc:${id}`);
  if (!raw) return json({ error: 'Document not found' }, 404, cors);
  const existing = await decryptToObject(env, raw);
  let fileDeleted = false;
  if (existing && existing.driveId && existing.driveItemId) {
    try {
      const token = await getGraphToken(env);
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/drives/${existing.driveId}/items/${existing.driveItemId}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
      );
      fileDeleted = res.ok || res.status === 404;
      if (!fileDeleted) console.error('Failed to delete client document from SharePoint:', res.status, await res.text());
    } catch (err) {
      console.error('Error deleting client document from SharePoint:', err);
    }
  }
  await env.PORTAL_KV.delete(`clientdoc:${id}`);
  await logAudit(env, adminEmail, 'delete-client-document', {
    // name rides along so the merged contact timeline can say which document,
    // not just that "a" document was deleted.
    client: existing && existing.client, id, name: existing && existing.name, fileDeleted,
  });
  return json({ ok: true, fileDeleted }, 200, cors);
}

// ---------- Document requests + client-side uploads ----------
// A request is the advisor asking for a specific document ("2024 tax return");
// the client sees it as an outstanding item on their Documents tab and clears it
// by uploading. Keyed per client with an inverted timestamp so a KV list returns
// newest-first, same as clientdoc.
//
// Client uploads land in the SAME SharePoint library as advisor attachments, in
// the same family folder, so the firm's existing retention and backup cover them
// and there is one document store rather than two. What differs is the ceiling:
// this is the only place a non-admin can write into the firm's tenant, so it is
// capped far tighter than the advisor path and restricted to document types.
const CLIENT_UPLOAD_MAX = 25 * 1024 * 1024; // 25 MB — a scanned return, not video
const CLIENT_UPLOAD_TYPES = ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt'];
// A ceiling on how much one client can accumulate. Without it a client-facing
// write endpoint has no upper bound on what it can push into the tenant.
const CLIENT_UPLOAD_COUNT_MAX = 200;
const DOC_REQUEST_STATUSES = ['open', 'fulfilled', 'cancelled'];

// The sections a client files a document under on their Documents tab. Kept
// deliberately short: this is a filing hint from someone who is not a filing
// clerk, so four buckets they can pick without thinking beats a taxonomy they
// get wrong. 'other' is the catch-all and the default for anything that
// arrives without one — including every record written before this existed.
//
// Metadata only: the SharePoint path is still <family folder>/<file>, unchanged
// by this. Filing into per-category subfolders would reorganise a library the
// firm already has open in Explorer, which is not a side effect worth causing
// for a labelling feature.
const DOC_CATEGORIES = [
  { id: 'tax', label: 'Tax Returns' },
  { id: 'trust', label: 'Trust Documents' },
  { id: 'estate', label: 'Estate Documents' },
  { id: 'other', label: 'Miscellaneous' },
];
const DOC_CATEGORY_IDS = DOC_CATEGORIES.map((c) => c.id);
function sanitizeDocCategory(raw) {
  const c = String(raw || '').trim().toLowerCase();
  return DOC_CATEGORY_IDS.includes(c) ? c : 'other';
}

function docRequestExtension(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function sanitizeDocRequest(body) {
  const label = String((body && body.label) || '').trim().slice(0, 160);
  if (!label) return { error: 'A document name is required' };
  return {
    fields: {
      label,
      notes: String((body && body.notes) || '').trim().slice(0, 1000),
      dueDate: String((body && body.dueDate) || '').trim().slice(0, 10),
      // The section the fulfilling upload files itself under, so a document the
      // advisor asked for lands in the right place without the client having to
      // categorise it — they are answering a specific request, not filing.
      category: sanitizeDocCategory(body && body.category),
    },
  };
}

async function handleAdminListDocRequests(request, env, cors, email) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const addr = String(email || '').trim().toLowerCase();
  const { items, errors } = await readAllEncrypted(env, `docreq:${addr}:`);
  items.sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
  return json({ requests: items, decryptErrors: errors }, 200, cors);
}

async function handleAdminCreateDocRequest(request, env, cors, email) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const addr = String(email || '').trim().toLowerCase();
  if (!isValidEmail(addr)) return json({ error: 'Invalid email' }, 400, cors);
  const body = await request.json().catch(() => ({}));
  const { fields, error } = sanitizeDocRequest(body);
  if (error) return json({ error }, 400, cors);

  const id = `${addr}:${invTs()}-${randomHex(4)}`;
  const record = {
    id, client: addr, ...fields,
    status: 'open',
    requestedBy: adminEmail,
    requestedAt: new Date().toISOString(),
    fulfilledAt: null,
    fulfilledDocId: '',
  };
  await env.PORTAL_KV.put(`docreq:${id}`, await encryptJSON(env, record));
  await logAudit(env, adminEmail, 'request-client-document', { client: addr, label: record.label });
  // Timeline entry so the ask shows in the contact's merged Timeline & Activity
  // alongside the upload that eventually clears it.
  await logTimeline(env, addr, 'document-requested', adminEmail, { label: record.label });
  return json({ request: record }, 200, cors);
}

// Cancel / reopen. A fulfilled request is not reopened here — the upload that
// cleared it still exists, so re-asking is a new request rather than an edit.
async function handleAdminUpdateDocRequest(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const raw = await env.PORTAL_KV.get(`docreq:${id}`);
  if (!raw) return json({ error: 'Request not found' }, 404, cors);
  const existing = await decryptToObject(env, raw);
  const body = await request.json().catch(() => ({}));
  const next = { ...existing };
  if (body.status !== undefined) {
    if (!DOC_REQUEST_STATUSES.includes(body.status)) return json({ error: 'Invalid status' }, 400, cors);
    if (existing.status === 'fulfilled') {
      return json({ error: 'That request has already been fulfilled — ask again with a new request' }, 400, cors);
    }
    next.status = body.status;
    next.cancelledAt = body.status === 'cancelled' ? new Date().toISOString() : null;
  }
  if (body.label !== undefined || body.notes !== undefined || body.dueDate !== undefined) {
    const { fields, error } = sanitizeDocRequest({ ...existing, ...body });
    if (error) return json({ error }, 400, cors);
    Object.assign(next, fields);
  }
  next.updatedAt = new Date().toISOString();
  await env.PORTAL_KV.put(`docreq:${id}`, await encryptJSON(env, next));
  return json({ request: next }, 200, cors);
}

async function handleAdminDeleteDocRequest(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const raw = await env.PORTAL_KV.get(`docreq:${id}`);
  const existing = raw ? await decryptToObject(env, raw) : null;
  await env.PORTAL_KV.delete(`docreq:${id}`);
  await logAudit(env, adminEmail, 'delete-document-request', {
    client: existing && existing.client, label: existing && existing.label,
  });
  return json({ ok: true }, 200, cors);
}

// ---- Client-facing ----

// Outstanding asks, plus recently cleared ones so the client can see their
// upload registered rather than the row just vanishing.
async function handleGetDocRequests(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);
  const { members } = await householdPortalMembers(env, email);
  const names = await memberDisplayNames(env, members);
  const items = [];
  for (const m of members) {
    const { items: mine } = await readAllEncrypted(env, `docreq:${m}:`);
    // forEmail/forName say who was actually asked, so a shared request reads as
    // "asked of Jeannette" rather than looking like it was addressed to whoever
    // happens to be logged in.
    for (const r of mine) items.push({ ...r, forEmail: m, forName: names[m] });
  }
  const requests = items
    .filter((r) => r.status !== 'cancelled')
    .sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')))
    .map((r) => ({
      id: r.id, label: r.label, notes: r.notes || '', dueDate: r.dueDate || '',
      category: sanitizeDocCategory(r.category),
      status: r.status, requestedAt: r.requestedAt, fulfilledAt: r.fulfilledAt || null,
      forEmail: r.forEmail, forName: r.forName,
    }));
  return json({ requests, categories: DOC_CATEGORIES, you: email }, 200, cors);
}

// ONLY the client's own uploads. An advisor's attachment is filed in the same
// library but was put there with no expectation of being visible to the client —
// it may be an internal memo, a draft, or a document about someone else in the
// family. Gating on source === 'client' is what keeps this endpoint from
// retroactively exposing everything the firm has ever filed. Records written
// before `source` existed have none, so they are advisor attachments by
// definition and correctly excluded.
async function handleGetClientDocuments(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);
  const { members } = await householdPortalMembers(env, email);
  const names = await memberDisplayNames(env, members);
  const items = [];
  for (const m of members) {
    const { items: mine } = await readAllEncrypted(env, `clientdoc:${m}:`);
    for (const d of mine) items.push({ ...d, ownerEmail: m, ownerName: names[m] });
  }
  const documents = items
    .filter((d) => d.source === 'client')
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))
    .map((d) => ({
      id: d.id, name: d.name, filename: d.filename, size: d.size, uploadedAt: d.uploadedAt,
      // Anything filed before categories existed reads as Miscellaneous rather
      // than vanishing from a tab that now only renders known sections.
      category: sanitizeDocCategory(d.category),
      // Whose upload this is. The household shares the library, so a row has to
      // say who sent it — otherwise a spouse's file is indistinguishable from
      // your own.
      ownerEmail: d.ownerEmail, ownerName: d.ownerName,
    }));
  // Sections travel with the data so the portal renders whatever the server
  // knows about, rather than keeping its own copy of the list to drift.
  return json({ documents, categories: DOC_CATEGORIES, you: email }, 200, cors);
}

async function handleClientDocUploadStart(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);
  if (!env.SHAREPOINT_CLIENT_DOCS_LIST_ID) {
    return json({ error: 'Document upload is not set up yet — please contact your advisor.' }, 400, cors);
  }
  const body = await request.json().catch(() => ({}));
  const filename = sanitizeDocFilename(body.filename);
  const size = Number(body.size);
  const name = String(body.name || '').trim().slice(0, 200);
  const requestId = String(body.requestId || '').trim().slice(0, 200);

  if (!filename) return json({ error: 'Choose a file to upload.' }, 400, cors);
  if (!name) return json({ error: 'Give the document a name.' }, 400, cors);
  if (!Number.isFinite(size) || size <= 0) return json({ error: 'File size is missing.' }, 400, cors);
  if (size > CLIENT_UPLOAD_MAX) {
    return json({ error: 'That file is larger than the 25 MB limit.' }, 400, cors);
  }
  const ext = docRequestExtension(filename);
  if (!CLIENT_UPLOAD_TYPES.includes(ext)) {
    return json({
      error: `We can't accept ".${ext || 'unknown'}" files. Please upload a PDF, image, or Office document.`,
    }, 400, cors);
  }
  // Counted against the CALLER, not the household. A household-wide cap would
  // let one member exhaust it and block their spouse from uploading anything;
  // per-account is also the right unit for the abuse this guards against, since
  // that is what an attacker controls.
  const existing = await listKeys(env, `clientdoc:${email}:`);
  if (existing.length >= CLIENT_UPLOAD_COUNT_MAX) {
    return json({ error: 'You have reached the upload limit — please contact your advisor.' }, 400, cors);
  }
  // A requestId is only honoured if it belongs to someone in this client's
  // household and is still open — so one member can clear a request addressed to
  // another (the point of a shared portal), but nobody can clear a request
  // belonging to an unrelated client by guessing an id.
  // The request's own category wins over anything the client sent: the advisor
  // said what they were asking for, so the answer files where they filed the ask.
  const { members } = await householdPortalMembers(env, email);
  let validRequestId = '';
  let category = sanitizeDocCategory(body.category);
  if (requestId) {
    const raw = await env.PORTAL_KV.get(`docreq:${requestId}`);
    const req = raw ? await decryptToObject(env, raw) : null;
    if (req && members.includes(req.client) && req.status === 'open') {
      validRequestId = requestId;
      category = sanitizeDocCategory(req.category);
    }
  }

  try {
    const ticket = await createClientDocUploadSession(env, email, filename, name, {
      size, requestId: validRequestId, category,
    });
    return json({ ticket, chunkSize: CLIENT_DOC_CHUNK }, 200, cors);
  } catch (err) {
    console.error('Failed to start client-side document upload:', err);
    return json({ error: 'Could not start the upload — please try again.' }, 500, cors);
  }
}

async function handleClientDocUploadChunk(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);

  const { ticket, error } = await readUploadTicket(env, request);
  if (error) return json({ error }, 400, cors);
  // The ticket carries the client it was issued for; refusing a mismatch means
  // one client's ticket can never be used to file a document under another.
  if (ticket.client !== email) return json({ error: 'Upload ticket does not belong to you' }, 403, cors);

  const offset = Number(request.headers.get('X-Upload-Offset'));
  if (!Number.isFinite(offset) || offset < 0) return json({ error: 'Bad chunk offset' }, 400, cors);
  const chunk = await request.arrayBuffer();
  if (!chunk.byteLength) return json({ error: 'Empty chunk' }, 400, cors);
  if (offset + chunk.byteLength - 1 >= ticket.size) {
    return json({ error: 'Chunk runs past the declared file size' }, 400, cors);
  }

  try {
    const out = await proxyClientDocChunk(env, ticket, offset, chunk);
    if (!out.done) return json(out, 200, cors);
    const record = clientDocRecord(ticket, out.item, email, 'client');
    await env.PORTAL_KV.put(`clientdoc:${record.id}`, await encryptJSON(env, record));

    // Clear the request this was sent against, if any. Re-read rather than
    // trusting the ticket's snapshot: the advisor may have cancelled it while
    // the bytes were in flight.
    if (ticket.requestId) {
      const raw = await env.PORTAL_KV.get(`docreq:${ticket.requestId}`);
      const req = raw ? await decryptToObject(env, raw) : null;
      // Household-scoped, matching the check at upload-start: one member
      // fulfilling another's request is the point of a shared portal, and
      // comparing against the caller alone would leave a spouse's request
      // sitting open even though the document arrived.
      const { members } = await householdPortalMembers(env, email);
      if (req && members.includes(req.client) && req.status === 'open') {
        const next = {
          ...req, status: 'fulfilled',
          fulfilledAt: new Date().toISOString(), fulfilledDocId: record.id,
          // Who actually sent it, when that wasn't the person asked.
          ...(req.client !== email ? { fulfilledBy: email } : {}),
        };
        await env.PORTAL_KV.put(`docreq:${ticket.requestId}`, await encryptJSON(env, next));
      }
    }
    // Timeline, not audit: logAudit records what an *admin* did, and this is the
    // client acting. It shows in the contact's merged Timeline & Activity.
    await logTimeline(env, email, 'document-uploaded', 'client', {
      name: record.name, filename: record.filename,
    });
    return json({ done: true, document: {
      id: record.id, name: record.name, filename: record.filename,
      size: record.size, category: record.category, uploadedAt: record.uploadedAt,
    } }, 200, cors);
  } catch (err) {
    console.error('Client-side document upload failed:', err);
    return json({ error: 'Upload failed — please try again.' }, 500, cors);
  }
}

// ---------- Advisor CRM: client emails ----------
// A read-only view of a client's email history, pulled live from the firm's
// mailboxes via Microsoft Graph — never stored. Needs the Mail.Read
// APPLICATION permission (with admin consent) on the same app registration
// getGraphToken() already authenticates as (OUTLOOK_CLIENT_ID/SECRET/
// TENANT_ID) — the same one Calendars.ReadWrite.All rides on for meetings.
//
// There is no "search every mailbox in the tenant at once" endpoint at this
// permission tier: Graph mail search is always scoped to one specific mailbox
// (/users/{mailbox}/messages). So this queries EVERY current admin account's
// mailbox (allAdminEmails — the same dynamic list Settings manages, not a
// hard-coded 3 names) and merges the results. Firm confirmed single-domain
// tenant, no Application Access Policy restricting Mail.Read to a subset — so
// "every admin mailbox" is the intended full scope, not an approximation of it.
//
// NOTHING is cached or written to KV: every open of the tab is a live Graph
// call. A client's email is exactly the kind of data that should have no
// second copy sitting in this app's storage once someone stops looking at it.
//
// SEARCH IS TWO-STAGE, and the second stage is the one that matters.
//
// Stage 1 — find candidates. $search, not $filter: Graph's /messages resource
// cannot $filter by recipient (to/cc) at all, only by sender, so a filter-only
// approach would silently miss every email the client RECEIVED. The query
// prefers `participants:<addr>` KQL, which restricts matching to the people on
// the message, and falls back to a plain term search if the tenant rejects that
// shape.
//
// Stage 2 — reject anything the client isn't actually on. $search scores on
// message *text*, so it returns mail that merely quotes an address: a forwarded
// thread, a signature block, a statement that lists it. This was the original
// version's accepted-tradeoff bug, and it showed up in practice as unrelated
// mail appearing under a client. messageParticipants() now gates every result on
// the address being a real sender or recipient. The gate runs on the response
// rather than being trusted from the query, so it holds no matter which of the
// two search shapes ran, and no matter how Graph chose to rank things.
//
// Real-Graph-unverified, like the Learning and Client Documents uploads: there
// are no Azure credentials in this environment to run either query against a
// live mailbox. The participant gate itself is plain set membership over the
// address fields and is exercised end-to-end against the dev mock, which seeds a
// deliberate body-text-only decoy.
// Every address on a message: sender, from, to, cc, bcc and reply-to. This is
// what decides whether a message is actually part of a client's correspondence,
// INDEPENDENT of how Graph decided to match it.
function messageParticipants(m) {
  const out = new Set();
  const add = (entry) => {
    const addr = entry && entry.emailAddress && entry.emailAddress.address;
    if (addr) out.add(String(addr).trim().toLowerCase());
  };
  add(m.from);
  add(m.sender);
  (m.toRecipients || []).forEach(add);
  (m.ccRecipients || []).forEach(add);
  (m.bccRecipients || []).forEach(add);
  (m.replyTo || []).forEach(add);
  return out;
}

const CLIENT_EMAIL_SELECT = 'subject,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,'
  + 'receivedDateTime,bodyPreview,webLink,isDraft,internetMessageId';

// One mailbox, one client address. Tries a `participants:` KQL search first,
// which restricts the match to the people on the message instead of any text
// inside it, and falls back to the plain term search if the tenant rejects that
// query shape — the participant filter downstream makes both precise, so the
// fallback costs recall precision, never correctness.
async function searchMailboxForClient(env, token, mailbox, clientEmail) {
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`;
  // $top is generous because the participant filter below discards whatever
  // Graph matched on body text; a tight $top would spend the page on noise.
  const queries = [
    `${base}?$search="participants:${encodeURIComponent(clientEmail)}"&$top=100&$select=${CLIENT_EMAIL_SELECT}`,
    `${base}?$search="${encodeURIComponent(clientEmail)}"&$top=100&$select=${CLIENT_EMAIL_SELECT}`,
  ];
  let lastStatus = 0;
  for (const url of queries) {
    try {
      // $orderby cannot be combined with $search on this resource — Graph
      // rejects the combination — so results come back relevance-ordered and
      // are re-sorted by date after merging every mailbox's results below.
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' },
      });
      if (res.ok) return { ok: true, status: 200, messages: (await res.json()).value || [] };
      lastStatus = res.status;
      // A permission failure is about Mail.Read, not the query shape — retrying
      // with a different search syntax would fail identically and only muddy
      // the "not authorized" signal the UI keys off.
      if (res.status === 403 || res.status === 401) break;
    } catch (err) {
      lastStatus = 0;
    }
  }
  return { ok: false, status: lastStatus, messages: [] };
}

async function fetchClientEmailHistory(env, clientEmail) {
  if (!outlookConfigured(env)) return { emails: [], configured: false, permissionMissing: false };

  const token = await getGraphToken(env);
  const mailboxes = await allAdminEmails(env);
  const target = String(clientEmail).trim().toLowerCase();
  const perMailbox = await Promise.all(mailboxes.map(async (mailbox) => {
    const r = await searchMailboxForClient(env, token, mailbox, target);
    return { mailbox, ...r };
  }));

  const anySucceeded = perMailbox.some((r) => r.ok);
  const allForbidden = perMailbox.length > 0 && perMailbox.every((r) => !r.ok && r.status === 403);
  // Distinguished from "not configured" (the env vars themselves are missing):
  // this is the one Mail.Read specifically was never consented to, which the
  // Learning-tab-style "not configured" message would misdescribe.
  if (!anySucceeded && allForbidden) {
    return { emails: [], configured: true, permissionMissing: true };
  }

  const seen = new Set();
  const merged = [];
  let droppedNotParticipant = 0;
  for (const { mailbox, messages } of perMailbox) {
    for (const m of messages) {
      // THE precision gate. Graph's $search scores on message *text*, so a mail
      // that merely quotes an address — a forwarded thread, a signature block, a
      // statement listing it — comes back as a hit. Requiring the address to be
      // an actual sender or recipient is the only way to be sure a message
      // belongs to this client's correspondence, and it is checked here rather
      // than trusted from the query so it holds whichever search shape ran.
      if (!messageParticipants(m).has(target)) {
        droppedNotParticipant += 1;
        continue;
      }
      // A message CC'd to two admins is found once per mailbox it landed in;
      // internetMessageId identifies the actual message across those copies
      // (each copy has its own `id`, so deduping on that would keep both).
      const dedupeKey = m.internetMessageId || m.id;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push({
        id: m.id,
        subject: m.subject || '(no subject)',
        from: (m.from && m.from.emailAddress) || null,
        to: (m.toRecipients || []).map((r) => r.emailAddress).filter(Boolean),
        cc: (m.ccRecipients || []).map((r) => r.emailAddress).filter(Boolean),
        receivedDateTime: m.receivedDateTime || null,
        bodyPreview: (m.bodyPreview || '').slice(0, 400),
        webLink: m.webLink || '',
        isDraft: !!m.isDraft,
        viaMailbox: mailbox,
      });
    }
  }
  merged.sort((a, b) => String(b.receivedDateTime || '').localeCompare(String(a.receivedDateTime || '')));

  return {
    emails: merged.slice(0, 100),
    configured: true,
    permissionMissing: false,
    // Surfaced so a partial result (one mailbox down, others fine) doesn't
    // silently read as "this client has no other email."
    mailboxErrors: perMailbox.filter((r) => !r.ok).map((r) => ({ mailbox: r.mailbox, status: r.status })),
    // Diagnostic: how many text-only matches the participant gate rejected. A
    // large number here is the gate doing its job, not a fault.
    droppedNotParticipant,
  };
}

async function handleAdminListClientEmails(request, env, cors, email) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const addr = String(email || '').trim().toLowerCase();
  if (!isValidEmail(addr)) return json({ error: 'Invalid email' }, 400, cors);
  try {
    const result = await fetchClientEmailHistory(env, addr);
    // Best-effort, count only — an audit trail of WHO looked at a client's
    // email history is worth having given Mail.Read's tenant-wide reach; the
    // messages themselves are never written anywhere by this app.
    await logAudit(env, adminEmail, 'view-client-emails', { client: addr, count: result.emails.length });
    return json(result, 200, cors);
  } catch (err) {
    console.error('Failed to fetch client email history:', err);
    return json({ error: 'Failed to load email history: ' + (err && err.message) }, 500, cors);
  }
}

// ---------- Advisor CRM: households ----------
// A household groups people who are advised together (a couple, a family).
// It is a first-class record rather than the free-text `household` tag that
// rides along on a contact: it holds its own name, members with roles, and its
// own status, and it is owned by this app rather than SharePoint — the sync has
// no household entity to overwrite it from.
//
// Keyed by generated id, NOT by email: a household has no mailbox of its own,
// and its members' addresses already key their own contact records. The
// optional email here is a shared address (thesmiths@…), not an identity.
// A grouping is either a **family** (the original household) or a **company**.
// Both are the same record — a name, members with roles, a shared email, status,
// tags — so `kind` discriminates them instead of a second entity with its own
// KV prefix, endpoints and SharePoint mirror to keep in step. Only the member
// roles and the labels differ.
//
// `kind` is deliberately NOT pushed to SharePoint: the Households list has no
// Kind column, and Graph fails the whole PATCH on an unknown field, which would
// break the mirror for every grouping. It lives app-side only, like
// importantDates on a contact. A record written before `kind` existed has none,
// and reads as a family (see handleAdminListHouseholds).
const GROUP_KINDS = ['family', 'company'];
// Firm-level documents whose completion date is tracked per grouping. Adding
// one here is the only server-side change needed; the admin UI renders its own
// labels from the same key list.
const KEY_DOCUMENT_KEYS = ['ips', 'advisoryAgreement'];
const HOUSEHOLD_ROLES = ['head', 'spouse', 'partner', 'child', 'dependent', 'other'];
const COMPANY_ROLES = ['primary', 'owner', 'officer', 'employee', 'other'];
const HOUSEHOLD_EMAIL_TYPES = ['', 'work', 'home', 'other'];

function rolesForKind(kind) {
  return kind === 'company' ? COMPANY_ROLES : HOUSEHOLD_ROLES;
}

function groupKindOf(record) {
  return record && record.kind === 'company' ? 'company' : 'family';
}

// `existingKind` is the kind already on the record being updated, so a PATCH
// that doesn't mention `kind` still validates member roles against the right
// list. Creates pass nothing and default to family.
function sanitizeHouseholdFields(body, existingKind) {
  const out = {};
  // Resolved first: the member roles below are validated against it.
  let kind = existingKind === 'company' ? 'company' : 'family';
  if (body.kind !== undefined) {
    const k = String(body.kind || '').trim().toLowerCase();
    if (!GROUP_KINDS.includes(k)) return { error: 'Invalid kind — must be family or company' };
    kind = k;
    out.kind = k;
  }
  const noun = kind === 'company' ? 'Company' : 'Family';
  if (body.name !== undefined) {
    const n = String(body.name || '').trim();
    if (!n) return { error: `${noun} name is required` };
    out.name = n.slice(0, 200);
  }
  if (body.members !== undefined) {
    if (!Array.isArray(body.members)) return { error: 'Members must be a list' };
    const seen = new Set();
    const members = [];
    for (const m of body.members) {
      if (!m) continue;
      const email = String(m.email || '').trim().toLowerCase();
      if (!email) continue;
      if (!isValidEmail(email)) return { error: `Member "${email}" is not a valid email` };
      // One row per person: two roles for the same member is contradictory
      // rather than additive, and the UI has no way to show both.
      if (seen.has(email)) return { error: `A person can only appear once in a ${noun.toLowerCase()}` };
      seen.add(email);
      const role = String(m.role || '').trim().toLowerCase();
      // An unrecognised role falls back to "other" rather than erroring, which
      // is also what makes changing a record's kind non-destructive: roles the
      // new kind doesn't have simply land on Other.
      const valid = rolesForKind(kind);
      members.push({ email, role: valid.includes(role) ? role : 'other' });
      if (members.length >= 20) break;
    }
    out.members = members;
  }
  if (body.email !== undefined) {
    const e = String(body.email || '').trim().toLowerCase();
    if (e && !isValidEmail(e)) return { error: `${noun} email is not valid` };
    out.email = e.slice(0, 200);
  }
  if (body.emailType !== undefined) {
    const t = String(body.emailType || '').trim().toLowerCase();
    if (!HOUSEHOLD_EMAIL_TYPES.includes(t)) return { error: 'Invalid email type' };
    out.emailType = t;
  }
  // Key documents: the date each was completed, held on the GROUPING rather
  // than per-person, because an IPS and an advisory agreement are executed for
  // a household as a whole — recording them on each member would be the same
  // fact stored N times, free to disagree.
  //
  // App-side only, like `kind` and a contact's importantDates: the SharePoint
  // Households list has no columns for these, and Graph fails the whole PATCH
  // on an unknown field. Nothing extra is needed to enforce that — the mirror
  // in pushHouseholdToSharePoint sends an explicit allowlist, so a field it
  // doesn't name is never transmitted.
  if (body.keyDocuments !== undefined) {
    if (typeof body.keyDocuments !== 'object' || body.keyDocuments === null || Array.isArray(body.keyDocuments)) {
      return { error: 'Key documents must be an object' };
    }
    const docs = {};
    for (const key of KEY_DOCUMENT_KEYS) {
      if (body.keyDocuments[key] === undefined) continue;
      const v = String(body.keyDocuments[key] || '').trim().slice(0, 10);
      // Empty clears the date — "we recorded this by mistake" has to be
      // undoable, so a blank is a valid value rather than a rejected one.
      if (v && !isIsoDate(v)) return { error: `${key} date must be YYYY-MM-DD` };
      docs[key] = v;
    }
    // Only the keys actually sent appear here. handleAdminUpdateHousehold
    // merges this over the stored value — the record spread is shallow, so
    // replacing wholesale would let a PATCH naming one document blank another.
    out.keyDocuments = docs;
  }
  if (body.emailPrimary !== undefined) out.emailPrimary = !!body.emailPrimary;
  if (body.assignedTo !== undefined) out.assignedTo = String(body.assignedTo || '').trim().toLowerCase().slice(0, 200);
  if (body.advisorRep !== undefined) out.advisorRep = String(body.advisorRep || '').trim().slice(0, 200);
  if (body.contactType !== undefined) out.contactType = String(body.contactType || '').trim().slice(0, 60);
  if (body.background !== undefined) out.background = String(body.background || '').trim().slice(0, 5000);
  if (body.status !== undefined) {
    if (!CONTACT_STATUSES.includes(body.status)) return { error: 'Invalid status' };
    out.status = body.status;
  }
  if (Array.isArray(body.tags)) {
    out.tags = body.tags
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().slice(0, 40))
      .slice(0, 20);
  }
  return { fields: out };
}

async function invalidHouseholdMembers(env, members, workspace) {
  const invalid = [];
  for (const member of members || []) {
    if (!(await contactBelongsToWorkspace(env, member.email, workspace))) invalid.push(member.email);
  }
  return invalid;
}

async function handleAdminListHouseholds(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const { items, errors } = await readAllEncrypted(env, 'household:');
  const visibleWorkspaces = workspace === ALL_ADMIN_WORKSPACES
    ? new Set(await accessibleWorkspaceOwners(env, adminEmail))
    : new Set([workspace]);
  // Normalized here rather than in the page: records predate `kind`, and every
  // consumer would otherwise need the same `kind || 'family'` fallback.
  const households = items
    .filter((h) => visibleWorkspaces.has(recordWorkspace(h)))
    .map((h) => ({ ...h, kind: groupKindOf(h) }));
  return json({ households, decryptErrors: errors, workspace }, 200, cors);
}

async function handleAdminCreateHousehold(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeHouseholdFields(body);
  if (error) return json({ error }, 400, cors);
  const invalidMembers = await invalidHouseholdMembers(env, fields.members, workspace);
  if (invalidMembers.length) return json({ error: 'Every member must be a contact in this admin display' }, 400, cors);
  const kind = fields.kind || 'family';
  if (!fields.name) {
    return json({ error: `${kind === 'company' ? 'Company' : 'Family'} name is required` }, 400, cors);
  }
  const id = `hh-${randomHex(6)}`;
  let record = {
    id,
    workspace,
    type: 'household',
    kind,
    name: fields.name,
    members: fields.members || [],
    email: fields.email || '',
    emailType: fields.emailType || '',
    emailPrimary: fields.emailPrimary !== undefined ? fields.emailPrimary : true,
    assignedTo: fields.assignedTo || '',
    advisorRep: fields.advisorRep || '',
    contactType: fields.contactType || '',
    background: fields.background || '',
    keyDocuments: fields.keyDocuments || {},
    tags: fields.tags || [],
    status: fields.status || 'active',
    archived: false,
    sharePointItemId: null,
    createdBy: adminEmail,
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
  // Best-effort two-way mirror — see pushHouseholdToSharePoint. Runs before the
  // KV write so a successful push's item id (and, on a first-ever save, there
  // is nothing to conflict with) is captured immediately rather than left
  // null until the next edit.
  record = await pushHouseholdToSharePoint(env, record);
  await env.PORTAL_KV.put(`household:${id}`, await encryptJSON(env, record));
  await logAudit(env, adminEmail, 'create-household', { id, name: record.name, kind });
  return json({ household: record }, 200, cors);
}

async function handleAdminUpdateHousehold(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const raw = await env.PORTAL_KV.get(`household:${id}`);
  if (!raw) return json({ error: 'Household not found' }, 404, cors);
  const existing = await decryptToObject(env, raw);
  if (recordWorkspace(existing) !== workspace) return json({ error: 'Household not found' }, 404, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeHouseholdFields(body, groupKindOf(existing));
  if (error) return json({ error }, 400, cors);
  const invalidMembers = await invalidHouseholdMembers(env, fields.members, workspace);
  if (invalidMembers.length) return json({ error: 'Every member must be a contact in this admin display' }, 400, cors);
  // Archive is a soft-delete toggle, handled here rather than as its own route
  // because a household has no portal account to keep consistent.
  if (body.archived !== undefined) {
    fields.archived = !!body.archived;
    fields.archivedAt = body.archived ? new Date().toISOString() : null;
  }
  // Merged, not replaced: the spread below is shallow, so a PATCH naming only
  // one key document would otherwise wipe the dates recorded for the others.
  // Sending a key with an empty string still clears that one on purpose.
  if (fields.keyDocuments) {
    fields.keyDocuments = { ...(existing.keyDocuments || {}), ...fields.keyDocuments };
  }
  let record = {
    ...existing,
    ...fields,
    id,
    type: 'household',
    kind: fields.kind || groupKindOf(existing),
    updatedAt: new Date().toISOString(),
  };
  // sharePointItemId carries over from `existing` via the spread above. Push
  // may return this record unchanged (pushed successfully), with a fresh
  // sharePointItemId (first push, or the prior one went stale), or merged
  // with newer scalar fields adopted from SharePoint if SharePoint had moved
  // since our last known state — see pushHouseholdToSharePoint.
  record = await pushHouseholdToSharePoint(env, record);
  await env.PORTAL_KV.put(`household:${id}`, await encryptJSON(env, record));
  await logAudit(env, adminEmail, 'update-household', { id });
  return json({ household: record }, 200, cors);
}

async function handleAdminDeleteHousehold(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const raw = await env.PORTAL_KV.get(`household:${id}`);
  if (!raw) return json({ error: 'Household not found' }, 404, cors);
  // Decrypted so its sharePointItemId is known — an intentional delete here
  // should remove the SharePoint backup row too, or it reads as a still-live
  // household if someone checks SharePoint during a later outage.
  const existing = await decryptToObject(env, raw);
  if (recordWorkspace(existing) !== workspace) return json({ error: 'Household not found' }, 404, cors);
  await deleteHouseholdFromSharePoint(env, existing);
  // Deleting the grouping never touches the member contacts themselves.
  await env.PORTAL_KV.delete(`household:${id}`);
  await logAudit(env, adminEmail, 'delete-household', { id });
  return json({ ok: true }, 200, cors);
}

// ---------- Advisor CRM: timeline, tasks, notes ----------
// Timeline entries are the client relationship history (kept forever, keyed
// per client); each write is mirrored to a global activity: feed (13-month TTL
// like audit) that powers the dashboard and notifications. Tasks and notes are
// first-class records. All payloads are encrypted at rest like assessment data.

const TASK_PRIORITIES = ['low', 'medium', 'high'];
// Recurrence. '' means one-off. A repeating task spawns its next instance when
// it's marked done (rather than a cron pre-generating them), so ignoring a
// recurring task can never pile up a backlog of identical overdue copies.
const TASK_REPEATS = ['', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

// Advance a due value by one repeat interval, preserving whether it carried a
// time ("2026-07-27" vs "2026-07-27T14:00"). Returns '' if there's nothing to
// advance from, which callers treat as "don't spawn a next instance".
function advanceDue(due, repeat) {
  if (!due || !repeat) return '';
  const hasTime = String(due).includes('T');
  const d = new Date(hasTime ? due : `${due}T00:00`);
  if (isNaN(d.getTime())) return '';
  const addMonths = (n) => {
    const day = d.getDate();
    d.setMonth(d.getMonth() + n);
    // JS rolls Jan 31 + 1 month into early March; clamp back to the last day
    // of the month we actually meant.
    if (d.getDate() !== day) d.setDate(0);
  };
  switch (repeat) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'monthly': addMonths(1); break;
    case 'quarterly': addMonths(3); break;
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
    default: return '';
  }
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return hasTime ? `${date}T${p(d.getHours())}:${p(d.getMinutes())}` : date;
}
const TASK_CATEGORIES = [
  'follow-up', 'review', 'meeting', 'onboarding', 'compliance', 'other',
  'investment-reports', 'operational-task', 'trading', 'investment-policy-statement', 'financial-planning',
];
// Confirmation state for an event. '' means unset (an ordinary task); a newly
// booked meeting starts 'unconfirmed' until the client actually confirms.
const EVENT_STATUSES = ['', 'unconfirmed', 'confirmed', 'cancelled'];
const TASK_CATEGORY_MAX_LEN = 60;
// Advisors can pick from the known list or type a custom category name
// (contacts.html's "Create new category…" option) — accept either, as long
// as it's a non-empty, reasonably short string. Falls back to 'other'.
function sanitizeTaskCategory(raw) {
  if (TASK_CATEGORIES.includes(raw)) return raw;
  const cat = String(raw || '').trim().slice(0, TASK_CATEGORY_MAX_LEN);
  return cat || 'other';
}
const TASK_CHECKLIST_MAX = 50;
const TASK_DOCUMENTS_MAX = 50;
const TASK_HISTORY_MAX = 200;

// Normalize a checklist payload into [{id, text, done}], dropping blank items
// and capping the count. Ids are preserved when present so toggles are stable.
function sanitizeChecklist(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    const text = String(item.text || '').trim().slice(0, 300);
    if (!text) continue;
    out.push({
      id: (typeof item.id === 'string' && item.id) ? item.id.slice(0, 40) : randomHex(6),
      text,
      done: !!item.done,
    });
    if (out.length >= TASK_CHECKLIST_MAX) break;
  }
  return out;
}

// Required-documents list for a meeting: [{id, name, ready}]. Same shape as the
// checklist (there's no file storage yet — R2 is a later phase — so this tracks
// which documents have been gathered, not the files themselves).
function sanitizeDocuments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    const name = String(item.name || '').trim().slice(0, 200);
    if (!name) continue;
    out.push({
      id: (typeof item.id === 'string' && item.id) ? item.id.slice(0, 40) : randomHex(6),
      name,
      ready: !!item.ready,
    });
    if (out.length >= TASK_DOCUMENTS_MAX) break;
  }
  return out;
}

function invTs(now = Date.now()) {
  return String(AUDIT_TS_CEILING - now).padStart(14, '0');
}

// Record a client-history event. Dual-write: per-client timeline (permanent)
// + global activity feed (expiring). Best-effort like logAudit — a telemetry
// failure must never break the request that triggered it.
// Returns the KV keys the entry was written under, so a caller that owns a
// deletable record (a note, a task) can store them and delete the timeline
// entry directly when that record is deleted — rather than relying solely on
// best-effort filtering at read time. Returns null on failure (best-effort).
async function logTimeline(env, client, type, actor, detail) {
  try {
    const email = String(client || '').trim().toLowerCase();
    if (!isValidEmail(email)) return null;
    const entry = {
      ts: new Date().toISOString(),
      client: email,
      type,
      actor: actor || 'system',
      detail: detail == null ? null : detail,
    };
    const suffix = `${invTs()}-${randomHex(4)}`;
    const encrypted = await encryptJSON(env, entry);
    const timelineKey = `timeline:${email}:${suffix}`;
    const activityKey = `activity:${suffix}`;
    await env.PORTAL_KV.put(timelineKey, encrypted);
    await env.PORTAL_KV.put(activityKey, encrypted, { expirationTtl: AUDIT_TTL_SECONDS });
    return { timelineKey, activityKey };
  } catch {
    // swallow — history is best-effort
    return null;
  }
}

// Delete timeline/activity entries logged for a note or task, so removing the
// record also removes its footprint from Recent Activity / the Timeline tab
// instead of leaving an orphaned entry that read-time filtering has to catch.
async function deleteTimelineRefs(env, record) {
  if (!record || !Array.isArray(record.timelineKeys)) return;
  for (const key of record.timelineKeys) {
    await env.PORTAL_KV.delete(key).catch(() => {});
  }
}

// ---------- Outlook calendar push ----------
// A meeting scheduled in this app can be mirrored onto staff members' real
// Outlook calendars. Which mailboxes it lands in is chosen per meeting
// (`calendarOwners`, any number of them), so one advisor can book onto another's
// calendar, or onto several at once. Push-only: Outlook is never read back, and
// this app stays the source of truth. Reuses the same app registration +
// client-credentials token as the SharePoint sync (getGraphToken), which needs
// the Calendars.ReadWrite.All APPLICATION permission with admin consent granted.
//
// Deliberately sends NO attendees. Graph emails an invitation to every attendee
// it's given, so listing the client would fire real mail at them the moment an
// advisor saves a meeting — never a side effect a save should have. The event is
// a private calendar entry; inviting people stays a manual step in Outlook.
//
// Best-effort like the SharePoint pushes: every failure is caught and logged so
// a Graph outage can never block saving the meeting itself.

const OUTLOOK_DEFAULT_TIMEZONE = 'Eastern Standard Time';
const OUTLOOK_DEFAULT_DURATION_MIN = 60;

function outlookConfigured(env) {
  return !!(env.OUTLOOK_CLIENT_ID && env.OUTLOOK_CLIENT_SECRET && env.OUTLOOK_TENANT_ID);
}

// Windows zone name (Graph resolves DST itself). Override per deployment with
// the OUTLOOK_TIMEZONE secret if the firm isn't on Eastern.
function outlookTimeZone(env) {
  return env.OUTLOOK_TIMEZONE || OUTLOOK_DEFAULT_TIMEZONE;
}

// `due`/`endDue` are naive wall-clock strings ("2026-08-03T14:00" or a bare
// "2026-08-03"), so times are sent as bare local date-times paired with a named
// zone rather than converted to UTC here. Arithmetic runs through Date in UTC
// purely to borrow its calendar rollover, then slices back to a naive string —
// the values never represent real UTC instants.
function outlookEventTimes(task, tz) {
  const due = String(task.due || '').trim();
  const day = due.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  if (task.allDay || !due.includes('T')) {
    // Graph treats an all-day event's end as EXCLUSIVE, so a single-day event
    // ends on the following day.
    const endDay = new Date(`${String(task.endDue || '').slice(0, 10) || day}T00:00:00Z`);
    if (isNaN(endDay.getTime())) return null;
    endDay.setUTCDate(endDay.getUTCDate() + 1);
    return {
      isAllDay: true,
      start: { dateTime: `${day}T00:00:00`, timeZone: tz },
      end: { dateTime: `${endDay.toISOString().slice(0, 10)}T00:00:00`, timeZone: tz },
    };
  }

  const start = due.slice(0, 16);
  let end = String(task.endDue || '').slice(0, 16);
  if (!end || end <= start) {
    const d = new Date(`${start}:00Z`);
    if (isNaN(d.getTime())) return null;
    d.setUTCMinutes(d.getUTCMinutes() + OUTLOOK_DEFAULT_DURATION_MIN);
    end = d.toISOString().slice(0, 16);
  }
  return {
    isAllDay: false,
    start: { dateTime: `${start}:00`, timeZone: tz },
    end: { dateTime: `${end}:00`, timeZone: tz },
  };
}

function outlookEventBody(task, tz) {
  const times = outlookEventTimes(task, tz);
  if (!times) return null; // no usable date — nothing to put on a calendar
  const payload = {
    subject: String(task.title || '').trim() || '(untitled)',
    body: { contentType: 'text', content: String(task.description || '') },
    ...times,
  };
  if (task.location) payload.location = { displayName: String(task.location) };
  return payload;
}

async function graphCalendarFetch(env, method, path, payload) {
  const token = await getGraphToken(env);
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

// A 404 is success here: the event is already gone from Outlook.
async function deleteOutlookEvent(env, owner, eventId) {
  if (!owner || !eventId) return;
  const res = await graphCalendarFetch(
    env, 'DELETE', `/users/${encodeURIComponent(owner)}/events/${encodeURIComponent(eventId)}`
  );
  if (!res.ok && res.status !== 404) {
    console.error('Outlook event delete failed:', res.status, await res.text());
  }
}

// The mailboxes a task should currently appear on. Reads the singular
// `calendarOwner` from records written before multi-calendar support so meetings
// already synced to one person keep working (and get migrated on next save).
function taskCalendarOwners(task) {
  const raw = Array.isArray(task.calendarOwners)
    ? task.calendarOwners
    : (task.calendarOwner ? [task.calendarOwner] : []);
  return [...new Set(raw.map((o) => String(o || '').trim().toLowerCase()).filter(Boolean))];
}

// {mailbox: outlookEventId} for events we've already pushed. Same legacy bridge:
// a pre-multi record stored one id + the mailbox it lived in, which is exactly
// one entry of this map — so the reconcile below updates that existing event
// instead of abandoning it and creating a duplicate alongside it.
function taskOutlookEvents(task) {
  if (task.outlookEvents && typeof task.outlookEvents === 'object') {
    const out = {};
    for (const [owner, id] of Object.entries(task.outlookEvents)) {
      const key = String(owner || '').trim().toLowerCase();
      if (key && id) out[key] = String(id);
    }
    return out;
  }
  const legacyOwner = String(task.outlookSyncedOwner || task.calendarOwner || '').trim().toLowerCase();
  return legacyOwner && task.outlookEventId ? { [legacyOwner]: String(task.outlookEventId) } : {};
}

// Reconcile a task's Outlook events against the mailboxes it should be on.
// Returns the fields to persist, or null when nothing changed. Set-based: each
// wanted mailbox is created or patched, and any mailbox no longer wanted has its
// event deleted — so unticking one name removes only that copy.
//
// Always returns the legacy singular fields blanked once it writes, so a record
// has exactly one source of truth after its first save under this code.
// Bring the set of Outlook events for ONE record in line with the mailboxes it
// should currently be on. Set-based: each wanted mailbox is created or patched,
// and any mailbox no longer wanted has its copy deleted — so removing one name
// withdraws only that person's event.
//
// Shared by meetings and compliance items rather than written twice: the retry,
// 404-recreate and orphan-avoidance rules below are subtle enough that a second
// copy would drift from this one within a release.
//
// A null `payload` means "this can't be an event at all" (no usable date, or
// nobody selected) and withdraws every copy rather than leaving stale ones.
async function reconcileOutlookEvents(env, wanted, existing, payload) {
  const next = {};
  let changed = false;
  // Graph calls that came back an error. Counted rather than only logged: a
  // bulk run writes to live calendars, and "23 of 109 synced" with no
  // explanation is indistinguishable from "the rest were already up to date".
  let failed = 0;
  const targets = payload ? wanted : [];

  for (const owner of targets) {
    const priorId = existing[owner];
    if (priorId) {
      const res = await graphCalendarFetch(
        env, 'PATCH', `/users/${encodeURIComponent(owner)}/events/${encodeURIComponent(priorId)}`, payload
      );
      if (res.ok) { next[owner] = priorId; continue; }
      if (res.status !== 404) {
        // Keep the id: the event probably still exists and dropping it here
        // would orphan it on someone's calendar forever.
        console.error('Outlook event update failed:', owner, res.status, await res.text());
        next[owner] = priorId;
        failed += 1;
        continue;
      }
      // 404 — deleted in Outlook; fall through and recreate it.
    }
    const res = await graphCalendarFetch(env, 'POST', `/users/${encodeURIComponent(owner)}/events`, payload);
    if (!res.ok) {
      console.error('Outlook event create failed:', owner, res.status, await res.text());
      failed += 1;
      continue;
    }
    const created = await res.json();
    if (created.id) { next[owner] = created.id; changed = true; }
  }

  for (const [owner, id] of Object.entries(existing)) {
    if (next[owner]) continue;
    await deleteOutlookEvent(env, owner, id);
    changed = true;
  }

  return { events: next, changed, failed };
}

async function syncTaskToOutlook(env, task) {
  if (!outlookConfigured(env)) return null;
  try {
    const wanted = taskCalendarOwners(task);
    const existing = taskOutlookEvents(task);
    const payload = wanted.length ? outlookEventBody(task, outlookTimeZone(env)) : null;
    const { events: next, changed } = await reconcileOutlookEvents(env, wanted, existing, payload);

    const hadLegacy = task.outlookEventId || task.outlookSyncedOwner || task.calendarOwner;
    if (!changed && !hadLegacy && JSON.stringify(next) === JSON.stringify(existing)) return null;
    return {
      outlookEvents: next,
      // Retire the pre-multi fields now that outlookEvents carries the truth.
      outlookEventId: '',
      outlookSyncedOwner: '',
      calendarOwner: '',
    };
  } catch (err) {
    console.error('Error syncing task to Outlook:', err);
    return null;
  }
}

async function createTask(env, fields) {
  const id = `${invTs()}-${randomHex(4)}`;
  const task = {
    id,
    workspace: String(fields.workspace || FRANK_ADMIN_EMAIL).trim().toLowerCase(),
    title: String(fields.title || '').trim().slice(0, 200),
    description: String(fields.description || '').trim().slice(0, 2000),
    client: fields.client || '',
    assignee: fields.assignee || '',
    list: fields.list || '',
    due: fields.due || '',
    repeat: TASK_REPEATS.includes(fields.repeat) ? fields.repeat : '',
    priority: TASK_PRIORITIES.includes(fields.priority) ? fields.priority : 'medium',
    category: sanitizeTaskCategory(fields.category),
    status: 'open',
    // Ticked off but not yet closed. The Tasks page ticks this first and only
    // completes on a second, deliberate press, so a stray click can't fire
    // completion's side effects (client timeline entry, next occurrence of a
    // repeating task). Held on the record rather than in the page so it survives
    // a reload and is visible to whoever looks next — that is the whole point of
    // a hand-off state. See handleAdminUpdateTask for the transitions.
    readyAt: null,
    readyBy: '',
    checklist: sanitizeChecklist(fields.checklist),
    meetingType: fields.meetingType || '',
    documents: sanitizeDocuments(fields.documents),
    // Event fields. These were previously dropped here (only the update path
    // saved them), so a meeting created with an end time, location, or all-day
    // flag lost them until it was edited again.
    location: fields.location || '',
    endDue: fields.endDue || '',
    allDay: !!fields.allDay,
    eventStatus: EVENT_STATUSES.includes(fields.eventStatus) ? fields.eventStatus : '',
    // Mailboxes to mirror onto. taskCalendarOwners also accepts the singular
    // legacy field, so an older caller passing calendarOwner still works.
    calendarOwners: taskCalendarOwners(fields),
    outlookEvents: {},
    createdBy: fields.createdBy || 'system',
    createdAt: new Date().toISOString(),
    completedAt: null,
    history: [{ ts: new Date().toISOString(), actor: fields.createdBy || 'system', type: 'created', detail: null }],
    timelineKeys: [],
  };
  if (task.client) {
    const refs = await logTimeline(env, task.client, task.category === 'meeting' ? 'meeting-added' : 'task-added', task.createdBy, {
      taskId: id,
      title: task.title,
      due: task.due || null,
    });
    if (refs) task.timelineKeys.push(refs.timelineKey, refs.activityKey);
  }
  const synced = await syncTaskToOutlook(env, task);
  if (synced) Object.assign(task, synced);
  await env.PORTAL_KV.put(`task:${id}`, await encryptJSON(env, task));
  return task;
}

// Fire an automatic task exactly once per rule occurrence: a plain marker key
// records that the rule already ran, so replays (re-saves, retries) don't pile
// up duplicate tasks. Assignee defaults to the contact's primary advisor.
async function maybeAutoTask(env, rule, client, fields) {
  try {
    const marker = `autotask:${rule}:${client}`;
    if (await env.PORTAL_KV.get(marker)) return;
    await env.PORTAL_KV.put(marker, '1');
    let assignee = '';
    let workspace = FRANK_ADMIN_EMAIL;
    try {
      const contact = await decryptToObject(env, await env.PORTAL_KV.get(`contact:${client}`));
      if (contact) {
        if (contact.advisor) assignee = contact.advisor;
        workspace = recordWorkspace(contact);
      }
    } catch {}
    await createTask(env, { ...fields, client, assignee, workspace, createdBy: 'auto' });
  } catch {
    // swallow — automation is best-effort
  }
}

// Decrypt every record under a prefix, skipping (but counting) broken entries
// so one corrupt record can't blank a whole listing.
async function readAllEncrypted(env, prefix) {
  const items = [];
  let errors = 0;
  for (const keyName of await listKeys(env, prefix)) {
    try {
      const rec = await decryptToObject(env, await env.PORTAL_KV.get(keyName));
      if (rec) items.push(rec);
    } catch {
      errors++;
    }
  }
  return { items, errors };
}

async function handleAdminListTasks(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const { items, errors } = await readAllEncrypted(env, 'task:');
  const visibleWorkspaces = workspace === ALL_ADMIN_WORKSPACES
    ? new Set(await accessibleWorkspaceOwners(env, adminEmail))
    : new Set([workspace]);
  return json({ tasks: items.filter((task) => visibleWorkspaces.has(recordWorkspace(task))), decryptErrors: errors, workspace }, 200, cors);
}

// allowedAssignees is a Set of assignable identifiers (admin account emails).
// Board "lists" are a separate grouping (task.list); only real accounts can own
// work, so assignee stays admin-only.
function sanitizeTaskFields(body, allowedAssignees) {
  const out = {};
  if (body.title !== undefined) {
    const t = String(body.title || '').trim();
    if (!t) return { error: 'Title is required' };
    out.title = t.slice(0, 200);
  }
  if (body.description !== undefined) out.description = String(body.description || '').trim().slice(0, 2000);
  if (body.client !== undefined) {
    const c = String(body.client || '').trim().toLowerCase();
    if (c && !isValidEmail(c)) return { error: 'Client must be an email address' };
    out.client = c;
  }
  if (body.assignee !== undefined) {
    const a = String(body.assignee || '').trim().toLowerCase();
    if (a && allowedAssignees && !allowedAssignees.has(a)) return { error: 'Assignee must be an admin account' };
    out.assignee = a;
  }
  // Which board list (custom bucket) the task sits in. Free string: an unknown
  // id just means the task lands in Unassigned on the board.
  if (body.list !== undefined) out.list = String(body.list || '').trim().slice(0, 40);
  if (body.due !== undefined) out.due = String(body.due || '').trim().slice(0, 40);
  if (body.repeat !== undefined) {
    const r = String(body.repeat || '').trim();
    if (!TASK_REPEATS.includes(r)) return { error: 'Invalid repeat interval' };
    out.repeat = r;
  }
  if (body.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(body.priority)) return { error: 'Invalid priority' };
    out.priority = body.priority;
  }
  if (body.category !== undefined) {
    const cat = TASK_CATEGORIES.includes(body.category) ? body.category : String(body.category || '').trim();
    if (!cat || cat.length > TASK_CATEGORY_MAX_LEN) return { error: 'Invalid category' };
    out.category = cat;
  }
  if (body.status !== undefined) {
    if (!['open', 'done'].includes(body.status)) return { error: 'Invalid status' };
    out.status = body.status;
  }
  if (body.checklist !== undefined) out.checklist = sanitizeChecklist(body.checklist);
  if (body.meetingType !== undefined) out.meetingType = String(body.meetingType || '').trim().slice(0, 40);
  if (body.documents !== undefined) out.documents = sanitizeDocuments(body.documents);
  // Event fields. A meeting IS a task here (category 'meeting'), so these live
  // on the same record and simply stay unset on an ordinary task. `due` is the
  // start; endDue is the matching end so an event can express a span, which a
  // plain task never needs.
  if (body.location !== undefined) out.location = String(body.location || '').trim().slice(0, 200);
  if (body.endDue !== undefined) out.endDue = String(body.endDue || '').trim().slice(0, 40);
  if (body.allDay !== undefined) out.allDay = !!body.allDay;
  if (body.eventStatus !== undefined) {
    const s = String(body.eventStatus || '').trim();
    if (s && !EVENT_STATUSES.includes(s)) return { error: 'Invalid event status' };
    out.eventStatus = s;
  }
  // Whose Outlook calendars this meeting is mirrored onto. Each is restricted to
  // an admin account — the same set assignee allows — so this can't be pointed at
  // arbitrary mailboxes in the tenant. An empty list means "don't put it on any
  // calendar", and removing a name withdraws that person's copy.
  // `calendarOwner` (singular) is still accepted so an older client or a stored
  // legacy payload keeps working; it normalizes into the list.
  if (body.calendarOwners !== undefined || body.calendarOwner !== undefined) {
    const raw = body.calendarOwners !== undefined
      ? body.calendarOwners
      : (body.calendarOwner ? [body.calendarOwner] : []);
    if (!Array.isArray(raw)) return { error: 'calendarOwners must be an array of admin emails' };
    const owners = [...new Set(raw.map((o) => String(o || '').trim().toLowerCase()).filter(Boolean))];
    for (const owner of owners) {
      if (allowedAssignees && !allowedAssignees.has(owner)) {
        return { error: 'Calendar owner must be an admin account' };
      }
    }
    out.calendarOwners = owners;
    // Any surviving singular value would shadow the list on the next read.
    out.calendarOwner = '';
  }
  return { fields: out };
}

async function handleAdminCreateTask(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  if (!body.title || !String(body.title).trim()) return json({ error: 'Title is required' }, 400, cors);
  const { fields, error } = sanitizeTaskFields(body, await allowedAssigneeSet(env));
  if (error) return json({ error }, 400, cors);
  if (fields.client && !(await contactBelongsToWorkspace(env, fields.client, workspace))) {
    return json({ error: 'Client not found in this workspace' }, 400, cors);
  }
  const task = await createTask(env, { ...fields, workspace, createdBy: adminEmail });
  return json({ task }, 200, cors);
}

async function handleAdminUpdateTask(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const raw = await env.PORTAL_KV.get(`task:${id}`);
  if (!raw) return json({ error: 'Task not found' }, 404, cors);
  const task = await decryptToObject(env, raw);
  if (recordWorkspace(task) !== workspace) return json({ error: 'Task not found in this workspace' }, 404, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeTaskFields(body, await allowedAssigneeSet(env));
  if (error) return json({ error }, 400, cors);
  if (fields.client && !(await contactBelongsToWorkspace(env, fields.client, workspace))) {
    return json({ error: 'Client not found in this workspace' }, 400, cors);
  }

  const wasOpen = task.status === 'open';
  const wasReady = !!task.readyAt;
  const prevAssignee = task.assignee || '';
  Object.assign(task, fields);

  // `ready` rides on the body rather than being a sanitized field: like
  // compliance's `complete`, it stamps who and when, which sanitizeTaskFields
  // has no admin identity to do.
  if (body.ready !== undefined) {
    if (body.ready) {
      if (!task.readyAt) {
        task.readyAt = new Date().toISOString();
        task.readyBy = adminEmail;
      }
    } else {
      task.readyAt = null;
      task.readyBy = '';
      // Un-ticking an already-completed task would leave it done with no record
      // of ever having been ticked off, so completion is withdrawn with it —
      // the same rule compliance applies when a sign-off is retracted. Set
      // before the transition checks below so the reopen branch picks it up.
      if (task.status === 'done') task.status = 'open';
    }
  }
  // Completing implies readiness. Callers that close a task in one step — the
  // Home rail and the contact task/meeting tabs, where a two-press gate on a
  // compact row would be worse than the misclick it prevents — send only
  // status:'done', and stamping here keeps the invariant that every completed
  // task records when it was ticked off. Without this they would 400 or, worse,
  // complete with an empty readyAt and read as never having been ticked.
  if (task.status === 'done' && !task.readyAt) {
    task.readyAt = new Date().toISOString();
    task.readyBy = adminEmail;
  }

  // Per-task history: append meaningful events so the Operations drawer can
  // show a task's story (assignments, completion, notes) without a new store.
  if (!Array.isArray(task.history)) task.history = [];
  const logHistory = (type, detail) =>
    task.history.push({ ts: new Date().toISOString(), actor: adminEmail, type, detail: detail || null });

  if ('assignee' in fields && (fields.assignee || '') !== prevAssignee) {
    logHistory('assigned', { from: prevAssignee || null, to: fields.assignee || null });
  }
  let spawned = null;
  if (wasOpen && task.status === 'done') {
    task.completedAt = new Date().toISOString();
    logHistory('completed', null);
    if (task.client) {
      const refs = await logTimeline(env, task.client, task.category === 'meeting' ? 'meeting-held' : 'task-completed',
        adminEmail, { taskId: id, title: task.title });
      if (refs) {
        if (!Array.isArray(task.timelineKeys)) task.timelineKeys = [];
        task.timelineKeys.push(refs.timelineKey, refs.activityKey);
      }
    }
    // Recurring task: completing this one schedules the next. Needs a due date
    // to advance from — a repeating task with no date has nothing to compute.
    const nextDue = advanceDue(task.due, task.repeat);
    if (nextDue) {
      spawned = await createTask(env, {
        title: task.title,
        description: task.description,
        client: task.client,
        assignee: task.assignee,
        list: task.list,
        due: nextDue,
        repeat: task.repeat,
        priority: task.priority,
        category: task.category,
        meetingType: task.meetingType,
        location: task.location,
        allDay: task.allDay,
        // The next occurrence belongs on the same calendars as this one. Event
        // ids are deliberately NOT carried over — createTask pushes fresh
        // events, so copying them would make the new occurrence overwrite the
        // completed one's calendar entries.
        calendarOwners: taskCalendarOwners(task),
        workspace,
        // Carry the prep items forward but unticked — it's a fresh occurrence.
        checklist: (task.checklist || []).map((c) => ({ ...c, done: false })),
        createdBy: adminEmail,
      });
      logHistory('repeat-spawned', { nextId: spawned.id, due: nextDue });
    }
  }
  if (!wasOpen && task.status === 'open') {
    task.completedAt = null; // reopened
    // Reopening drops the tick too, so the task goes back to needing both
    // presses rather than sitting one click from closing again.
    task.readyAt = null;
    task.readyBy = '';
    logHistory('reopened', null);
  }
  // Logged after the transitions above, and only while the task stays open, so
  // a one-step completion reads as "completed" rather than "ticked off" plus
  // "completed", and un-ticking a done task reads as "reopened" rather than both.
  if (wasOpen && task.status === 'open') {
    if (!wasReady && task.readyAt) logHistory('ready', null);
    if (wasReady && !task.readyAt) logHistory('unready', null);
  }
  // A free-text note/comment travels on the update body (not a task field).
  if (body.comment !== undefined && String(body.comment).trim()) {
    logHistory('comment', { text: String(body.comment).trim().slice(0, 2000) });
  }
  if (task.history.length > TASK_HISTORY_MAX) task.history = task.history.slice(-TASK_HISTORY_MAX);

  // Runs after every field change above, so a retitled/rescheduled/reassigned
  // meeting updates its Outlook event (or moves mailboxes) in one place.
  const synced = await syncTaskToOutlook(env, task);
  if (synced) Object.assign(task, synced);

  await env.PORTAL_KV.put(`task:${id}`, await encryptJSON(env, task));
  return json({ task, spawned }, 200, cors);
}

async function handleAdminDeleteTask(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const raw = await env.PORTAL_KV.get(`task:${id}`);
  let task = null;
  if (raw) {
    try { task = await decryptToObject(env, raw); } catch {}
  }
  if (!task || recordWorkspace(task) !== workspace) return json({ error: 'Task not found in this workspace' }, 404, cors);
  await env.PORTAL_KV.delete(`task:${id}`);
  await deleteTimelineRefs(env, task);
  // Take every mirrored Outlook event down with it, so a deleted meeting doesn't
  // linger on anyone's real calendar.
  if (task && outlookConfigured(env)) {
    try {
      for (const [owner, eventId] of Object.entries(taskOutlookEvents(task))) {
        await deleteOutlookEvent(env, owner, eventId);
      }
    } catch (err) {
      console.error('Error removing Outlook events for deleted task:', err);
    }
  }
  return json({ ok: true }, 200, cors);
}

// ---------- Board lists ----------
// The Operations board is built from editable "lists" (columns). A list is
// either a PERSON list (bound to an admin account — tasks assigned to that
// account show there) or a CUSTOM list (a named bucket like "Waiting on client"
// — tasks show there when task.list === list.id). One encrypted KV blob.

const BOARD_LISTS_KEY = 'board_lists';
const BOARD_LISTS_MAX = 50;
const boardListsKey = (workspace) => workspace === FRANK_ADMIN_EMAIL ? BOARD_LISTS_KEY : `${BOARD_LISTS_KEY}:${workspace}`;

async function getBoardLists(env, workspace = FRANK_ADMIN_EMAIL) {
  try {
    const rec = await decryptToObject(env, await env.PORTAL_KV.get(boardListsKey(workspace)));
    if (rec && Array.isArray(rec.lists)) return rec.lists;
    // Migrate the earlier team_roster (free-text members) → custom lists.
    const legacy = workspace === FRANK_ADMIN_EMAIL
      ? await decryptToObject(env, await env.PORTAL_KV.get('team_roster'))
      : null;
    if (legacy && Array.isArray(legacy.members)) {
      return legacy.members.map((m) => ({ id: m.id, type: 'custom', name: m.name, createdAt: m.createdAt || null }));
    }
  } catch { /* fall through to empty */ }
  return [];
}

// Assignees are admin accounts only (lists are a separate grouping dimension).
async function allowedAssigneeSet(env) {
  return new Set(await allAdminEmails(env));
}

async function handleAdminListLists(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  return json({ lists: await getBoardLists(env, workspace), workspace }, 200, cors);
}

async function handleAdminCreateList(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const body = await request.json().catch(() => null);
  const type = (body && body.type) === 'person' ? 'person' : 'custom';
  const lists = await getBoardLists(env, workspace);
  if (lists.length >= BOARD_LISTS_MAX) return json({ error: 'Too many lists' }, 400, cors);

  let list;
  if (type === 'person') {
    const account = String((body && body.account) || '').trim().toLowerCase();
    if (!(await isAdminAccount(env, account))) return json({ error: 'Pick an existing admin account' }, 400, cors);
    if (lists.some((l) => l.type === 'person' && l.account === account)) {
      return json({ error: 'That person already has a list' }, 400, cors);
    }
    list = { id: `l-${randomHex(6)}`, type: 'person', account, createdAt: new Date().toISOString() };
  } else {
    const name = String((body && body.name) || '').trim().slice(0, 60);
    if (!name) return json({ error: 'List name is required' }, 400, cors);
    if (lists.some((l) => l.type === 'custom' && l.name.toLowerCase() === name.toLowerCase())) {
      return json({ error: 'A list with that name already exists' }, 400, cors);
    }
    list = { id: `l-${randomHex(6)}`, type: 'custom', name, createdAt: new Date().toISOString() };
  }
  lists.push(list);
  await env.PORTAL_KV.put(boardListsKey(workspace), await encryptJSON(env, { lists }));
  return json({ list, lists }, 200, cors);
}

async function handleAdminDeleteList(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const lists = (await getBoardLists(env, workspace)).filter((l) => l.id !== id);
  await env.PORTAL_KV.put(boardListsKey(workspace), await encryptJSON(env, { lists }));
  // Tasks that referenced this list (or an unlisted assignee) just fall into
  // Unassigned on the board; they aren't rewritten here.
  return json({ lists }, 200, cors);
}

// ---------- Portal links (client-facing external logins) ----------
// The links the Links tab shows a client — Tamarac, eMoney, anything else the
// firm wants to hand off to. Firm-wide rather than per-client: the login URL for
// a platform is the same for everyone, and a per-client copy would be N records
// to keep in step for no gain. `enabled` is how a link is retired without
// losing its URL.
//
// NO CREDENTIALS ARE STORED HERE, deliberately. Holding a client's password to
// a third-party financial platform would put the firm in custody of the
// credential to their aggregated data, let any admin sign in as them with no
// audit trail on the vendor's side, and generally breaks those vendors' terms.
// Both platforms invite clients directly and let them set their own password;
// this tab only points at the front door. If a username ever needs to ride
// along it can be added per-client without touching this shape — but a password
// field does not belong in it.
const PORTAL_LINKS_KEY = 'portal_links';
const PORTAL_LINKS_MAX = 12;

// https ONLY, and parsed rather than pattern-matched. This value becomes an
// href in the client portal, so `javascript:...` here would be stored XSS
// against clients, entered by an admin. Checked on the way in (below) and again
// on the way out when rendering (see renderLinks in script.js) — the write-side
// check is the real gate, the read-side one is for records written before it.
function isSafeLinkUrl(raw) {
  try {
    return new URL(String(raw)).protocol === 'https:';
  } catch {
    return false;
  }
}

async function getPortalLinks(env) {
  try {
    const rec = await decryptToObject(env, await env.PORTAL_KV.get(PORTAL_LINKS_KEY));
    if (rec && Array.isArray(rec.links)) return rec.links;
  } catch { /* fall through to empty */ }
  return [];
}

function sanitizePortalLinks(body) {
  if (!body || !Array.isArray(body.links)) return { error: 'links must be a list' };
  if (body.links.length > PORTAL_LINKS_MAX) return { error: `No more than ${PORTAL_LINKS_MAX} links` };
  const links = [];
  for (const raw of body.links) {
    if (!raw) continue;
    const label = String(raw.label || '').trim().slice(0, 80);
    const url = String(raw.url || '').trim().slice(0, 500);
    if (!label) return { error: 'Every link needs a label' };
    if (!isSafeLinkUrl(url)) return { error: `"${label}" needs a valid https:// address` };
    links.push({
      // Ids are stable across edits so a future per-client visibility list can
      // reference them; generated here when a new row arrives without one.
      id: String(raw.id || '').trim().slice(0, 40) || `lnk-${randomHex(4)}`,
      label,
      url,
      description: String(raw.description || '').trim().slice(0, 300),
      enabled: raw.enabled !== false,
    });
  }
  return { links };
}

async function handleAdminGetPortalLinks(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  return json({ links: await getPortalLinks(env) }, 200, cors);
}

// Whole-list replace rather than per-row endpoints: the editor is a short list
// the admin edits as a unit, and a replace keeps ordering (which is display
// order) trivially correct.
async function handleAdminSavePortalLinks(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can change firm-wide portal links' }, 403, cors);
  const body = await request.json().catch(() => null);
  const { links, error } = sanitizePortalLinks(body);
  if (error) return json({ error }, 400, cors);
  await env.PORTAL_KV.put(PORTAL_LINKS_KEY, await encryptJSON(env, { links }));
  await logAudit(env, adminEmail, 'update-portal-links', { count: links.length });
  return json({ links }, 200, cors);
}

// Client-facing. Returns only enabled links, and only the fields the portal
// renders — `enabled` is an admin concern and doesn't need to leave the server.
async function handleGetPortalLinks(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);
  const links = (await getPortalLinks(env))
    .filter((l) => l.enabled !== false && isSafeLinkUrl(l.url))
    .map((l) => ({ id: l.id, label: l.label, url: l.url, description: l.description || '' }));
  return json({ links }, 200, cors);
}

// ---------- Notes ----------

async function handleAdminListNotes(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const client = new URL(request.url).searchParams.get('client');
  if (client && !(await contactBelongsToWorkspace(env, String(client).trim().toLowerCase(), workspace))) {
    return json({ error: 'Contact not found in this workspace' }, 404, cors);
  }
  const prefix = client ? `note:${String(client).trim().toLowerCase()}:` : 'note:';
  const { items, errors } = await readAllEncrypted(env, prefix);
  const visible = [];
  for (const note of items) {
    if (await contactBelongsToWorkspace(env, note.client, workspace)) visible.push(note);
  }
  return json({ notes: visible, decryptErrors: errors }, 200, cors);
}

async function handleAdminCreateNote(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const client = String(body.client || '').trim().toLowerCase();
  if (!isValidEmail(client)) return json({ error: 'A valid client email is required' }, 400, cors);
  if (!(await contactBelongsToWorkspace(env, client, workspace))) return json({ error: 'Contact not found in this workspace' }, 404, cors);
  const text = String(body.body || '').trim();
  if (!text) return json({ error: 'Note text is required' }, 400, cors);

  const id = `${client}:${invTs()}-${randomHex(4)}`;
  // Log first so the note record can carry the timeline entry's own keys —
  // deleting the note later can then delete its timeline footprint directly.
  const refs = await logTimeline(env, client, 'note-added', adminEmail, { noteId: id, body: text.slice(0, 300) });
  const note = {
    id,
    client,
    author: adminEmail,
    body: text.slice(0, 10000),
    tags: Array.isArray(body.tags)
      ? body.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 20)
      : [],
    pinned: !!body.pinned,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    timelineKeys: refs ? [refs.timelineKey, refs.activityKey] : [],
  };
  await env.PORTAL_KV.put(`note:${id}`, await encryptJSON(env, note));
  await pushNoteToSharePoint(env, note);
  return json({ note }, 200, cors);
}

async function handleAdminUpdateNote(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const raw = await env.PORTAL_KV.get(`note:${id}`);
  if (!raw) return json({ error: 'Note not found' }, 404, cors);
  const note = await decryptToObject(env, raw);
  if (!(await contactBelongsToWorkspace(env, note.client, workspace))) return json({ error: 'Note not found' }, 404, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  if (body.body !== undefined) {
    const text = String(body.body || '').trim();
    if (!text) return json({ error: 'Note text is required' }, 400, cors);
    note.body = text.slice(0, 10000);
  }
  if (body.tags !== undefined && Array.isArray(body.tags)) {
    note.tags = body.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 20);
  }
  if (body.pinned !== undefined) note.pinned = !!body.pinned;
  note.updatedAt = new Date().toISOString();
  await env.PORTAL_KV.put(`note:${id}`, await encryptJSON(env, note));
  return json({ note }, 200, cors);
}

async function handleAdminDeleteNote(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const raw = await env.PORTAL_KV.get(`note:${id}`);
  let note = null;
  if (raw) {
    try { note = await decryptToObject(env, raw); } catch {}
  }
  if (!note || !(await contactBelongsToWorkspace(env, note.client, workspace))) return json({ error: 'Note not found' }, 404, cors);
  await env.PORTAL_KV.delete(`note:${id}`);
  await deleteTimelineRefs(env, note);
  return json({ ok: true }, 200, cors);
}

// ---------- Timeline / activity reads ----------

// Bounded newest-first page over an inverted-timestamp prefix (audit-log style).
async function pagedEncryptedList(env, prefix, cursorParam, pageSize) {
  const listOpts = { prefix, limit: pageSize };
  if (cursorParam) listOpts.cursor = cursorParam;
  const page = await env.PORTAL_KV.list(listOpts);
  const entries = [];
  for (const key of page.keys) {
    try {
      const rec = await decryptToObject(env, await env.PORTAL_KV.get(key.name));
      if (rec) entries.push(rec);
    } catch {}
  }
  return { entries, hasMore: !page.list_complete, cursor: page.list_complete ? null : page.cursor };
}

// Check if a referenced item still exists (used to filter deleted notes/tasks from timeline)
async function itemExists(env, type, id) {
  if (type === 'note') return !!(await env.PORTAL_KV.get(`note:${id}`));
  if (type === 'task') return !!(await env.PORTAL_KV.get(`task:${id}`));
  return true; // if no ID provided or unknown type, include the entry
}

const TASK_TIMELINE_TYPES = ['task-added', 'task-completed', 'meeting-added', 'meeting-held'];

// Filter timeline entries to exclude references to deleted notes/tasks/meetings.
// Two layers, oldest-first because they catch different things:
//  1. Content check: a note/task can never be created or edited with an empty
//     body/title, so an entry showing one is *always* leftover noise from a
//     deletion that happened before entries carried an id to look up — no KV
//     read needed, and it catches history logged before this filter existed.
//  2. Id check: for entries that do carry a noteId/taskId (everything logged
//     after this change), confirm the record still exists — this is what
//     actually needs to run for well-formed post-fix entries, since deletion
//     now also removes the entry directly (see deleteTimelineRefs) and this is
//     just a backstop for anything that slips past that.
async function filterDeletedReferences(entries, env) {
  const filtered = [];
  for (const entry of entries) {
    const d = entry.detail || {};
    let isValid = true;

    if (entry.type === 'note-added') {
      isValid = !!String(d.body || '').trim();
      if (isValid && d.noteId) isValid = await itemExists(env, 'note', d.noteId);
    } else if (TASK_TIMELINE_TYPES.includes(entry.type)) {
      isValid = !!String(d.title || '').trim();
      if (isValid && d.taskId) isValid = await itemExists(env, 'task', d.taskId);
    }

    if (isValid) filtered.push(entry);
  }
  return filtered;
}

async function handleAdminTimeline(request, env, cors, rawEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Invalid client email' }, 400, cors);
  if (!(await contactBelongsToWorkspace(env, email, workspace))) return json({ error: 'Contact not found in this workspace' }, 404, cors);
  const cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  const result = await pagedEncryptedList(env, `timeline:${email}:`, cursor, 50);
  result.entries = await filterDeletedReferences(result.entries, env);
  return json(result, 200, cors);
}

async function handleAdminActivity(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  let cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  const visible = [];
  let hasMore = true;
  // Filter while walking pages, not after returning one global page. Using the
  // remaining result count as each KV limit means a page can never contain more
  // visible entries than we can return, so advancing its cursor cannot skip one.
  while (visible.length < 30 && hasMore) {
    const page = await pagedEncryptedList(env, 'activity:', cursor, 30 - visible.length);
    const entries = await filterDeletedReferences(page.entries, env);
    for (const entry of entries) {
      if (await contactBelongsToWorkspace(env, entry.client, workspace)) visible.push(entry);
    }
    cursor = page.cursor || undefined;
    hasMore = page.hasMore;
  }
  return json({ entries: visible, hasMore, cursor: hasMore ? cursor : null }, 200, cors);
}

// Per-admin, per-workspace notification read cursor. Notifications themselves are DERIVED
// (activity newer than this timestamp + overdue tasks) — nothing is fanned out
// or stored per event, so there is nothing to keep consistent.
async function handleAdminGetNotifSeen(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  let seen = await env.PORTAL_KV.get(`notif_seen:${adminEmail}:${workspace}`);
  // Preserve the pre-workspace read cursor on the shared firm display only.
  if (!seen && workspace === FRANK_ADMIN_EMAIL) {
    seen = await env.PORTAL_KV.get(`notif_seen:${adminEmail}`);
  }
  return json({ seen: seen || null }, 200, cors);
}

async function handleAdminSetNotifSeen(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
  const seen = new Date().toISOString();
  await env.PORTAL_KV.put(`notif_seen:${adminEmail}:${workspace}`, seen);
  return json({ seen }, 200, cors);
}

async function handleAdminClients(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const workspace = await requestedAdminWorkspace(request, env, adminEmail);
  if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);

  const clients = [];
  let cursor;
  do {
    const page = await env.PORTAL_KV.list({ prefix: 'user:', cursor });
    for (const key of page.keys) {
      const email = key.name.slice('user:'.length);
      const userRaw = await env.PORTAL_KV.get(key.name);
      const assignmentsRaw = await env.PORTAL_KV.get(`assignments:${email}`);
      if (!userRaw) continue;
      if (!(await contactBelongsToWorkspace(env, email, workspace))) continue;
      const user = JSON.parse(userRaw);
      // Decrypt per client; a single undecryptable record surfaces as an error
      // flag on that client rather than failing the whole listing.
      let modules = {};
      let modulesError = false;
      try {
        // Same reason as buildContactList: shared assessments live in the
        // household record, so reading responses:<email> alone would report them
        // as never started for every client in a household.
        modules = await effectiveModulesFor(env, email);
      } catch {
        modulesError = true;
      }
      clients.push({
        name: user.name,
        email: user.email,
        modules,
        modulesError,
        assignments: loadAssignments(assignmentsRaw),
      });
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);

  return json({ clients, workspace }, 200, cors);
}

async function handleScheduled(env) {
  try {
    const result = await syncSharePointContacts(env);
    console.log('Scheduled SharePoint sync completed:', result);
  } catch (err) {
    console.error('Scheduled SharePoint sync failed:', err);
  }
  // Separate try/catch: a contacts sync failure must not skip the household
  // pull, and vice versa — they're independent lists with independent risk.
  try {
    const result = await syncSharePointHouseholds(env);
    console.log('Scheduled SharePoint household sync completed:', result);
  } catch (err) {
    console.error('Scheduled SharePoint household sync failed:', err);
  }
}

// Static assets, with revalidation forced on the app's own code.
//
// None of these filenames are content-hashed (index.html loads plain
// "assets/script.js"), so with no Cache-Control the browser applies heuristic
// caching and can serve a stale copy for a long time. That already bit us once:
// a fixed Home progress calculation kept rendering the old numbers because the
// browser was still running the previous script.js. In production it is worse
// than a stale number — a client running yesterday's JS against today's API is
// a version mismatch nobody can see or explain.
//
// `no-cache` does NOT mean "don't cache": it means revalidate before use, so
// the browser still stores the file and a 304 keeps repeat loads cheap. Applied
// only to the app's own code and markup; images and fonts keep whatever the
// assets platform sets, since those change rarely and are big.
const REVALIDATE_EXT = /\.(?:html|js|css)$/i;

async function serveAsset(request, env) {
  const res = await env.ASSETS.fetch(request);
  const path = new URL(request.url).pathname;
  // Response from ASSETS is immutable; clone before touching headers.
  const out = new Response(res.body, res);
  // A directory URL ("/", "/admin/") serves index.html, so match it too.
  if (REVALIDATE_EXT.test(path) || path.endsWith('/')) out.headers.set('Cache-Control', 'no-cache');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  out.headers.set('X-Frame-Options', 'DENY');
  out.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  out.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (new URL(request.url).protocol === 'https:') {
    out.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = resolveCorsOrigin(request, url, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(cors) });
    }

    try {
      if (url.pathname === '/api/register' && request.method === 'POST') {
        return await handleRegister(request, env, cors);
      }
      if (url.pathname === '/api/login' && request.method === 'POST') {
        return await handleLogin(request, env, cors);
      }
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        return await handleLogout(request, env, cors);
      }
      if (url.pathname === '/api/assessments' && request.method === 'GET') {
        return await handleGetAssessments(request, env, cors);
      }
      if (url.pathname === '/api/assignments' && request.method === 'GET') {
        return await handleGetAssignments(request, env, cors);
      }
      if (url.pathname === '/api/portal-links' && request.method === 'GET') {
        return await handleGetPortalLinks(request, env, cors);
      }
      if (url.pathname === '/api/household' && request.method === 'GET') {
        return await handleGetHousehold(request, env, cors);
      }
      if (url.pathname === '/api/document-requests' && request.method === 'GET') {
        return await handleGetDocRequests(request, env, cors);
      }
      if (url.pathname === '/api/documents' && request.method === 'GET') {
        return await handleGetClientDocuments(request, env, cors);
      }
      if (url.pathname === '/api/documents/upload' && request.method === 'POST') {
        return await handleClientDocUploadStart(request, env, cors);
      }
      if (url.pathname === '/api/documents/chunk' && request.method === 'PUT') {
        return await handleClientDocUploadChunk(request, env, cors);
      }
      const saveMatch = url.pathname.match(/^\/api\/assessments\/([a-z]+)$/);
      if (saveMatch && request.method === 'POST') {
        return await handleSaveAssessment(request, env, cors, saveMatch[1]);
      }
      if (url.pathname === '/api/onboarding/start' && request.method === 'POST') {
        return await handleOnboardingStart(request, env, cors);
      }
      const onbMatch = url.pathname.match(/^\/api\/onboarding\/(BLA-ONB-\d{4}-(?:\d{4}|[a-f0-9]{16}))$/);
      if (onbMatch && request.method === 'POST') {
        return await handleOnboardingSave(request, env, cors, onbMatch[1], ctx);
      }
      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        return await handleAdminLogin(request, env, cors);
      }
      if (url.pathname === '/api/admin/mfa/enroll' && request.method === 'POST') {
        return await handleAdminMfaEnroll(request, env, cors);
      }
      if (url.pathname === '/api/admin/mfa/verify' && request.method === 'POST') {
        return await handleAdminMfaVerify(request, env, cors);
      }
      if (url.pathname === '/api/admin/admins' && request.method === 'GET') {
        return await handleAdminListAdmins(request, env, cors);
      }
      if (url.pathname === '/api/admin/admins' && request.method === 'POST') {
        return await handleAdminCreateAdmin(request, env, cors);
      }
      const adminDeleteMatch = url.pathname.match(/^\/api\/admin\/admins\/([^/]+)$/);
      if (adminDeleteMatch && request.method === 'DELETE') {
        return await handleAdminDeleteAdmin(request, env, cors, decodeURIComponent(adminDeleteMatch[1]));
      }
      const adminNameMatch = url.pathname.match(/^\/api\/admin\/admins\/([^/]+)\/name$/);
      if (adminNameMatch && request.method === 'POST') {
        return await handleAdminRenameAdmin(request, env, cors, decodeURIComponent(adminNameMatch[1]));
      }
      if (url.pathname === '/api/admin/workspaces' && request.method === 'GET') {
        return await handleAdminWorkspaces(request, env, cors);
      }
      if (url.pathname === '/api/admin/workspaces/access' && request.method === 'POST') {
        return await handleAdminSaveWorkspaceAccess(request, env, cors);
      }
      if (url.pathname === '/api/admin/contacts' && request.method === 'GET') {
        return await handleAdminContacts(request, env, cors);
      }
      if (url.pathname === '/api/admin/households' && request.method === 'GET') {
        return await handleAdminListHouseholds(request, env, cors);
      }
      if (url.pathname === '/api/admin/households' && request.method === 'POST') {
        return await handleAdminCreateHousehold(request, env, cors);
      }
      {
        // Declared before the /contacts/:email routes below would ever see it;
        // the id shape (hh-…) can't collide with an email anyway.
        const hhMatch = url.pathname.match(/^\/api\/admin\/households\/(hh-[a-f0-9]+)$/);
        if (hhMatch && request.method === 'POST') {
          return await handleAdminUpdateHousehold(request, env, cors, hhMatch[1]);
        }
        if (hhMatch && request.method === 'DELETE') {
          return await handleAdminDeleteHousehold(request, env, cors, hhMatch[1]);
        }
      }
      if (url.pathname === '/api/admin/contacts/sync' && request.method === 'POST') {
        const adminEmail = await getAdminEmail(request, env);
        if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
        if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can run firm-wide SharePoint sync' }, 403, cors);
        try {
          const result = await syncSharePointContacts(env);
          await logAudit(env, adminEmail, 'sync-sharepoint-contacts', result);
          return json(result, 200, cors);
        } catch (err) {
          console.error('SharePoint sync failed:', err);
          return json({ error: 'Sync failed: ' + (err && err.message) }, 500, cors);
        }
      }
      if (url.pathname === '/api/admin/households/sync' && request.method === 'POST') {
        const adminEmail = await getAdminEmail(request, env);
        if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
        if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can run firm-wide SharePoint sync' }, 403, cors);
        try {
          const result = await syncSharePointHouseholds(env);
          await logAudit(env, adminEmail, 'sync-sharepoint-households', result);
          return json(result, 200, cors);
        } catch (err) {
          console.error('SharePoint household sync failed:', err);
          return json({ error: 'Sync failed: ' + (err && err.message) }, 500, cors);
        }
      }
      // Resolves a SharePoint site URL to the opaque site id Graph wants, so
      // pointing a feature at a different site doesn't require hunting that id
      // down by hand. Pass the address bar URL:
      //   /api/admin/sharepoint/site?url=https://contoso.sharepoint.com/sites/Compliance
      if (url.pathname === '/api/admin/sharepoint/site' && request.method === 'GET') {
        const adminEmail = await getAdminEmail(request, env);
        if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
        if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can inspect SharePoint configuration' }, 403, cors);
        const raw = url.searchParams.get('url');
        if (!raw) return json({ error: 'Pass ?url=<the site address>' }, 400, cors);
        let host;
        let path;
        try {
          const parsed = new URL(raw);
          host = parsed.hostname;
          // Graph wants the server-relative path with no trailing slash;
          // everything after /sites/<name> (a library, a page) is not part of
          // the site's own address and would make the lookup 404.
          const m = parsed.pathname.match(/^\/sites\/[^/]+/) || parsed.pathname.match(/^\/teams\/[^/]+/);
          path = m ? m[0] : '';
        } catch {
          return json({ error: 'That does not look like a URL' }, 400, cors);
        }
        try {
          const token = await getGraphToken(env);
          // No path = the tenant's root site, which Graph addresses differently.
          const target = path
            ? `https://graph.microsoft.com/v1.0/sites/${host}:${path}`
            : `https://graph.microsoft.com/v1.0/sites/${host}`;
          const resp = await fetch(target, { headers: { Authorization: `Bearer ${token}` } });
          if (!resp.ok) {
            return json({ error: `Graph could not find that site (${resp.status}). ${(await resp.text()).slice(0, 200)}` }, resp.status, cors);
          }
          const site = await resp.json();
          return json({ id: site.id, name: site.displayName || site.name, webUrl: site.webUrl }, 200, cors);
        } catch (err) {
          return json({ error: 'Failed to resolve site: ' + (err && err.message) }, 500, cors);
        }
      }
      // One-off diagnostic: lists every SharePoint list in a site (name + id),
      // so a new list's id can be found without re-pasting Azure credentials
      // anywhere outside Cloudflare's own encrypted secrets. Defaults to the
      // main site; ?site=<id> targets any other one, which is what makes
      // configuring a feature against a different site possible.
      if (url.pathname === '/api/admin/sharepoint/lists' && request.method === 'GET') {
        const adminEmail = await getAdminEmail(request, env);
        if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
        if (!(await canManageSharedFirmView(env, adminEmail))) return json({ error: 'Only shared firm view managers can inspect SharePoint configuration' }, 403, cors);
        const siteId = url.searchParams.get('site') || env.SHAREPOINT_SITE_ID;
        try {
          const token = await getGraphToken(env);
          const resp = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/lists`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!resp.ok) throw new Error('Graph API error: ' + resp.status);
          const data = await resp.json();
          const lists = (data.value || []).map((l) => ({ name: l.displayName, id: l.id }));
          return json({ site: siteId, lists }, 200, cors);
        } catch (err) {
          return json({ error: 'Failed to list SharePoint lists: ' + (err && err.message) }, 500, cors);
        }
      }
      // Compliance tracker. The collection path is matched before the /:id
      // routes so the greedy `(.+)` can't swallow it.
      if (url.pathname === '/api/admin/compliance' && request.method === 'GET') {
        return await handleAdminComplianceList(request, env, cors);
      }
      if (url.pathname === '/api/admin/compliance' && request.method === 'POST') {
        return await handleAdminComplianceCreate(request, env, cors);
      }
      // Before the generic /compliance/(.+) below, which would otherwise
      // swallow "import" as an item id and route it into the update handler.
      if (url.pathname === '/api/admin/compliance/import' && request.method === 'POST') {
        return await handleAdminComplianceImport(request, env, cors);
      }
      // Same reason as /import: before the greedy /compliance/(.+) below, which
      // would otherwise take "outlook-sync" for an item id.
      if (url.pathname === '/api/admin/compliance/outlook-sync' && request.method === 'POST') {
        return await handleAdminComplianceOutlookSync(request, env, cors);
      }
      const complianceMatch = url.pathname.match(/^\/api\/admin\/compliance\/(.+)$/);
      if (complianceMatch && request.method === 'POST') {
        return await handleAdminComplianceUpdate(request, env, cors, decodeURIComponent(complianceMatch[1]));
      }
      if (complianceMatch && request.method === 'DELETE') {
        return await handleAdminComplianceDelete(request, env, cors, decodeURIComponent(complianceMatch[1]));
      }
      // Learning resources. Exact-match paths, so the /fields diagnostic can't
      // be swallowed by the list route regardless of declaration order.
      if (url.pathname === '/api/admin/learning' && request.method === 'GET') {
        return await handleAdminLearning(request, env, cors);
      }
      if (url.pathname === '/api/admin/learning/fields' && request.method === 'GET') {
        return await handleAdminLearningFields(request, env, cors);
      }
      if (url.pathname === '/api/admin/learning/upload' && request.method === 'POST') {
        return await handleAdminLearningUploadStart(request, env, cors);
      }
      if (url.pathname === '/api/admin/learning/upload/chunk' && request.method === 'PUT') {
        return await handleAdminLearningUploadChunk(request, env, cors);
      }
      // Every nested contact endpoint (info, documents, requests, email,
      // archive) is workspace-gated here so a guessed URL cannot bypass the
      // filtered Contacts list. Bare /contacts/:email POST is checked inside
      // the upsert handler because it is also how a new workspace claims a new
      // contact email.
      const scopedContactMatch = url.pathname.match(/^\/api\/admin\/contacts\/([^/]+)\/.+$/);
      if (scopedContactMatch) {
        const adminEmail = await getAdminEmail(request, env);
        if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
        const workspace = await requestedAdminWorkspace(request, env, adminEmail);
        if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
        const email = decodeURIComponent(scopedContactMatch[1]).trim().toLowerCase();
        if (!(await contactBelongsToWorkspace(env, email, workspace))) {
          return json({ error: 'Contact not found in this workspace' }, 404, cors);
        }
      }
      const clientInviteMatch = url.pathname.match(/^\/api\/admin\/contacts\/(.+)\/portal-invite$/);
      if (clientInviteMatch && request.method === 'POST') {
        return await handleAdminCreateClientInvite(request, env, cors, decodeURIComponent(clientInviteMatch[1]));
      }
      // Archive/unarchive must be matched before the generic upsert route below,
      // whose `(.+)` would otherwise swallow the "/archive" suffix into the email.
      const archiveMatch = url.pathname.match(/^\/api\/admin\/contacts\/(.+)\/(archive|unarchive)$/);
      if (archiveMatch && request.method === 'POST') {
        return await handleAdminArchiveContact(request, env, cors, decodeURIComponent(archiveMatch[1]), archiveMatch[2] === 'archive');
      }
      // Additional Info and client documents, also matched before the greedy
      // upsert route below for the same reason /archive is: its `(.+)` would
      // otherwise swallow the suffix into the email.
      const infoMatch = url.pathname.match(/^\/api\/admin\/contacts\/(.+)\/info$/);
      if (infoMatch && request.method === 'GET') {
        return await handleAdminGetClientInfo(request, env, cors, decodeURIComponent(infoMatch[1]));
      }
      if (infoMatch && request.method === 'POST') {
        return await handleAdminUpdateClientInfo(request, env, cors, decodeURIComponent(infoMatch[1]));
      }
      const emailsMatch = url.pathname.match(/^\/api\/admin\/contacts\/(.+)\/emails$/);
      if (emailsMatch && request.method === 'GET') {
        return await handleAdminListClientEmails(request, env, cors, decodeURIComponent(emailsMatch[1]));
      }
      // The chunk route carries its client in the encrypted ticket, so it is a
      // fixed path rather than a per-contact one.
      if (url.pathname === '/api/admin/client-documents/chunk' && request.method === 'PUT') {
        return await handleAdminClientDocUploadChunk(request, env, cors);
      }
      const docUploadMatch = url.pathname.match(/^\/api\/admin\/contacts\/(.+)\/documents\/upload$/);
      if (docUploadMatch && request.method === 'POST') {
        return await handleAdminClientDocUploadStart(request, env, cors, decodeURIComponent(docUploadMatch[1]));
      }
      const docListMatch = url.pathname.match(/^\/api\/admin\/contacts\/(.+)\/documents$/);
      if (docListMatch && request.method === 'GET') {
        return await handleAdminListClientDocs(request, env, cors, decodeURIComponent(docListMatch[1]));
      }
      // Matched BEFORE the bare /contacts/(.+) route below, which would
      // otherwise swallow ".../document-requests" as a contact email.
      const docReqListMatch = url.pathname.match(/^\/api\/admin\/contacts\/(.+)\/document-requests$/);
      if (docReqListMatch && request.method === 'GET') {
        return await handleAdminListDocRequests(request, env, cors, decodeURIComponent(docReqListMatch[1]));
      }
      if (docReqListMatch && request.method === 'POST') {
        return await handleAdminCreateDocRequest(request, env, cors, decodeURIComponent(docReqListMatch[1]));
      }
      // Item ids begin with the owning client's email. Gate the non-nested item
      // routes too; otherwise someone could bypass Contacts isolation by
      // guessing a document/request id directly.
      const scopedClientItemMatch = url.pathname.match(/^\/api\/admin\/(?:document-requests|client-documents)\/(.+)$/);
      if (scopedClientItemMatch) {
        const adminEmail = await getAdminEmail(request, env);
        if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
        const workspace = await requestedAdminWorkspace(request, env, adminEmail);
        if (!workspace) return json({ error: 'You do not have access to that workspace' }, 403, cors);
        const ownerEmail = decodeURIComponent(scopedClientItemMatch[1]).split(':')[0].trim().toLowerCase();
        if (!(await contactBelongsToWorkspace(env, ownerEmail, workspace))) {
          return json({ error: 'Item not found in this workspace' }, 404, cors);
        }
      }
      // Request ids are `<email>:<invTs>-<rand>` — same greedy match as documents.
      const docReqItemMatch = url.pathname.match(/^\/api\/admin\/document-requests\/(.+)$/);
      if (docReqItemMatch && request.method === 'POST') {
        return await handleAdminUpdateDocRequest(request, env, cors, decodeURIComponent(docReqItemMatch[1]));
      }
      if (docReqItemMatch && request.method === 'DELETE') {
        return await handleAdminDeleteDocRequest(request, env, cors, decodeURIComponent(docReqItemMatch[1]));
      }
      // Document ids are `<email>:<invTs>-<rand>`, so the id itself carries a
      // colon — matched greedily and used as-is rather than split apart.
      const docItemMatch = url.pathname.match(/^\/api\/admin\/client-documents\/(.+)$/);
      if (docItemMatch && request.method === 'POST') {
        return await handleAdminRenameClientDoc(request, env, cors, decodeURIComponent(docItemMatch[1]));
      }
      if (docItemMatch && request.method === 'DELETE') {
        return await handleAdminDeleteClientDoc(request, env, cors, decodeURIComponent(docItemMatch[1]));
      }
      const contactMatch = url.pathname.match(/^\/api\/admin\/contacts\/(.+)$/);
      if (contactMatch && request.method === 'POST') {
        return await handleAdminUpsertContact(request, env, cors, decodeURIComponent(contactMatch[1]));
      }
      if (url.pathname === '/api/admin/tasks' && request.method === 'GET') {
        return await handleAdminListTasks(request, env, cors);
      }
      if (url.pathname === '/api/admin/tasks' && request.method === 'POST') {
        return await handleAdminCreateTask(request, env, cors);
      }
      const taskMatch = url.pathname.match(/^\/api\/admin\/tasks\/(.+)$/);
      if (taskMatch && request.method === 'POST') {
        return await handleAdminUpdateTask(request, env, cors, decodeURIComponent(taskMatch[1]));
      }
      if (taskMatch && request.method === 'DELETE') {
        return await handleAdminDeleteTask(request, env, cors, decodeURIComponent(taskMatch[1]));
      }
      if (url.pathname === '/api/admin/portal-links' && request.method === 'GET') {
        return await handleAdminGetPortalLinks(request, env, cors);
      }
      if (url.pathname === '/api/admin/portal-links' && request.method === 'POST') {
        return await handleAdminSavePortalLinks(request, env, cors);
      }
      if (url.pathname === '/api/admin/lists' && request.method === 'GET') {
        return await handleAdminListLists(request, env, cors);
      }
      if (url.pathname === '/api/admin/lists' && request.method === 'POST') {
        return await handleAdminCreateList(request, env, cors);
      }
      const listMatch = url.pathname.match(/^\/api\/admin\/lists\/(.+)$/);
      if (listMatch && request.method === 'DELETE') {
        return await handleAdminDeleteList(request, env, cors, decodeURIComponent(listMatch[1]));
      }
      if (url.pathname === '/api/admin/notes' && request.method === 'GET') {
        return await handleAdminListNotes(request, env, cors);
      }
      if (url.pathname === '/api/admin/notes' && request.method === 'POST') {
        return await handleAdminCreateNote(request, env, cors);
      }
      const noteMatch = url.pathname.match(/^\/api\/admin\/notes\/(.+)$/);
      if (noteMatch && request.method === 'POST') {
        return await handleAdminUpdateNote(request, env, cors, decodeURIComponent(noteMatch[1]));
      }
      if (noteMatch && request.method === 'DELETE') {
        return await handleAdminDeleteNote(request, env, cors, decodeURIComponent(noteMatch[1]));
      }
      const timelineMatch = url.pathname.match(/^\/api\/admin\/timeline\/(.+)$/);
      if (timelineMatch && request.method === 'GET') {
        return await handleAdminTimeline(request, env, cors, decodeURIComponent(timelineMatch[1]));
      }
      if (url.pathname === '/api/admin/activity' && request.method === 'GET') {
        return await handleAdminActivity(request, env, cors);
      }
      if (url.pathname === '/api/admin/notifseen' && request.method === 'GET') {
        return await handleAdminGetNotifSeen(request, env, cors);
      }
      if (url.pathname === '/api/admin/notifseen' && request.method === 'POST') {
        return await handleAdminSetNotifSeen(request, env, cors);
      }
      const resetMfaMatch = url.pathname.match(/^\/api\/admin\/mfa\/reset\/(.+)$/);
      if (resetMfaMatch && request.method === 'POST') {
        return await handleAdminResetMfa(request, env, cors, decodeURIComponent(resetMfaMatch[1]));
      }
      if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
        return await handleAdminLogout(request, env, cors);
      }
      if (url.pathname === '/api/admin/clients' && request.method === 'GET') {
        return await handleAdminClients(request, env, cors);
      }
      const asgMatch = url.pathname.match(/^\/api\/admin\/assignments\/(.+)$/);
      if (asgMatch && request.method === 'POST') {
        return await handleAdminSetAssignments(request, env, cors, decodeURIComponent(asgMatch[1]));
      }
      if (url.pathname === '/api/admin/onboarding' && request.method === 'GET') {
        return await handleAdminOnboarding(request, env, cors);
      }
      if (url.pathname === '/api/admin/audit' && request.method === 'GET') {
        return await handleAdminAudit(request, env, cors);
      }
      const onbRestoreMatch = url.pathname.match(/^\/api\/admin\/onboarding\/(BLA-ONB-\d{4}-(?:\d{4}|[a-f0-9]{16}))\/restore$/);
      if (onbRestoreMatch && request.method === 'POST') {
        return await handleAdminRestoreOnboarding(request, env, cors, onbRestoreMatch[1]);
      }
      const onbDeleteMatch = url.pathname.match(/^\/api\/admin\/onboarding\/(BLA-ONB-\d{4}-(?:\d{4}|[a-f0-9]{16}))$/);
      if (onbDeleteMatch && request.method === 'DELETE') {
        return await handleAdminDeleteOnboarding(request, env, cors, onbDeleteMatch[1]);
      }
      if (url.pathname.startsWith('/api/')) {
        return json({ error: 'Not found' }, 404, cors);
      }
      return await serveAsset(request, env);
    } catch (err) {
      // Log the real error server-side so 500s are diagnosable via Cloudflare
      // live logs (`wrangler tail` / dashboard → Logs), without leaking stack
      // detail to the client. The most common cause here is an encrypted record
      // (e.g. admin_mfa:<email>) that the current DATA_ENCRYPTION_KEY can't
      // decrypt — login fails closed by design; fix the key or clear the record.
      // Errors are logged with path and method for context.
      console.error('Unhandled error', url.pathname, request.method, (err && err.stack) || err);
      return json({ error: 'Internal server error' }, 500, cors);
    }
  },
  async scheduled(event, env, ctx) {
    await handleScheduled(env);
  },
};
