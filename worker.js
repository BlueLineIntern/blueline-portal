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
 *   onboarding_counter         -> sequence number for onboarding ids
 *   rl:<scope>:<ip>            -> { count, windowStart }    (TTL'd, rate limiting)
 *
 * Endpoints:
 *   POST   /api/register                    { name, email, password }
 *   POST   /api/login                       { email, password }
 *   POST   /api/logout                      (Authorization: Bearer <token>)
 *   GET    /api/assessments                 (Authorization: Bearer <token>)
 *   POST   /api/assessments/:module         (Authorization: Bearer <token>)
 *   POST   /api/onboarding/start            -> { onboardingId, writeToken }
 *   POST   /api/onboarding/:id              (X-Onboarding-Token: <writeToken>)
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
  const legacy = ADMIN_ACCOUNTS.find((a) => a.email === normalizedEmail);
  if (legacy) {
    // Trim both sides so a stray trailing newline in a secret (a very common
    // result of how secrets get pasted/piped in) doesn't cause a silent
    // length mismatch. Falls back to the old shared ADMIN_PASSWORD secret
    // while individual ones are still being rolled out.
    const expected = ((env[legacy.secret] || env.ADMIN_PASSWORD) || '').trim();
    return !!expected && timingSafeEqual(String(password).trim(), expected);
  }
  const raw = await env.PORTAL_KV.get(`admin_account:${normalizedEmail}`);
  if (!raw) return false;
  const account = JSON.parse(raw);
  const attemptedHash = await hashPassword(password, account.salt, account.iterations);
  return timingSafeEqual(attemptedHash, account.hash);
}

// Legacy roster + everyone added through the app, deduplicated. This is the
// single source of truth for "who is an admin" everywhere else in the file.
async function allAdminEmails(env) {
  const legacy = ADMIN_ACCOUNTS.map((a) => a.email);
  const added = (await listKeys(env, 'admin_account:')).map((k) => k.slice('admin_account:'.length));
  return [...new Set([...legacy, ...added])];
}

async function isAdminAccount(env, email) {
  return (await allAdminEmails(env)).includes(email);
}

// Create a new KV-backed admin. Rejects an email already in use by either the
// legacy roster or another KV admin, so the two lists never collide.
async function handleAdminCreateAdmin(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Onboarding-Token',
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

  const { name, email, password } = body;
  if (!name || !isValidEmail(email) || !password || password.length < 8) {
    return json(
      { error: 'name, a valid email, and a password of at least 8 characters are required' },
      400,
      cors
    );
  }

  const normalizedEmail = email.trim().toLowerCase();
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

  const token = randomHex(32);
  await env.PORTAL_KV.put(`session:${token}`, normalizedEmail, { expirationTtl: SESSION_TTL_SECONDS });

  await logTimeline(env, normalizedEmail, 'account-created', 'client', null);
  return json({ token, name, email: normalizedEmail }, 201, cors);
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
  return env.PORTAL_KV.get(`admin_session:${match[1]}`);
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
    return JSON.parse(raw);
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
  const names = await addedAdminNames(env);
  const admins = [];
  for (const email of await allAdminEmails(env)) {
    const mfa = await getAdminMfa(env, email); // throws on decrypt fail -> 500 (fail closed)
    admins.push({ email, name: names[email] || null, mfaEnabled: !!(mfa && mfa.confirmed) });
  }
  return json({ admins, you: adminEmail }, 200, cors);
}

// One admin resets another's MFA (recovery for a lost authenticator). Deleting
// the record forces fresh enrollment on that admin's next login. Any signed-in
// admin may reset any admin account; the action is audit-logged. Trade-off: a
// compromised admin session could reset the other's MFA — acceptable for a
// two-person firm where both hold equal access anyway.
async function handleAdminResetMfa(request, env, cors, targetEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
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

async function handleGetAssessments(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);

  const raw = await env.PORTAL_KV.get(`responses:${email}`);
  return json({ modules: await loadModules(env, raw) }, 200, cors);
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

  const raw = await env.PORTAL_KV.get(`responses:${email}`);
  const modules = await loadModules(env, raw);
  const firstCompletion = !modules[moduleName];
  modules[moduleName] = { ...result.data, updatedAt: new Date().toISOString() };

  await env.PORTAL_KV.put(`responses:${email}`, await encryptJSON(env, { modules }));

  // CRM history + automation: record the event, and the FIRST completion of a
  // module opens a review task for the advisor (deduped by marker, so
  // re-saves/edits never pile up duplicates).
  await logTimeline(env, email, firstCompletion ? 'assessment-completed' : 'assessment-updated', 'client', {
    module: moduleName,
  });
  if (firstCompletion) {
    await maybeAutoTask(env, `review-assessment-${moduleName}`, email, {
      title: `Review ${moduleName} assessment - ${email}`,
      description: `The client completed the ${moduleName} assessment. Review their responses.`,
      category: 'review',
    });
  }
  return json({ module: modules[moduleName], modules }, 200, cors);
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

async function handleGetAssignments(request, env, cors) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, cors);
  const raw = await env.PORTAL_KV.get(`assignments:${email}`);
  return json({ assignments: loadAssignments(raw) }, 200, cors);
}

async function handleAdminSetAssignments(request, env, cors, rawEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);

  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Invalid client email' }, 400, cors);
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

// ---------- Onboarding proof of concept ----------
// Sample/test data only. Each session is issued a per-session write token at
// /start; every save must present it via the X-Onboarding-Token header. This
// stops anyone who guesses a (sequential, predictable) onboarding id from
// overwriting someone else's in-progress record. It is NOT full client auth —
// there is no account, no login — but it closes the "anyone can POST to any id"
// hole. The token is stored under a separate key and never returned by the
// admin endpoints.

const ONBOARDING_ID_PATTERN = /^BLA-ONB-\d{4}-\d{4}$/;
const ONBOARDING_MAX_BYTES = 100_000;

async function handleOnboardingStart(request, env, cors) {
  if (!(await checkRateLimit(env, 'onboardingStart', clientIp(request)))) {
    return json({ error: 'Too many onboarding sessions started. Please try again later.' }, 429, cors);
  }

  // KV has no atomic increment; a race here can skip or repeat a number.
  // Acceptable for a proof of concept.
  const n = (Number(await env.PORTAL_KV.get('onboarding_counter')) || 0) + 1;
  await env.PORTAL_KV.put('onboarding_counter', String(n));
  const onboardingId = `BLA-ONB-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;

  const writeToken = randomHex(24);
  await env.PORTAL_KV.put(`onboarding_secret:${onboardingId}`, writeToken, {
    expirationTtl: ONBOARDING_TTL_SECONDS,
  });

  const record = {
    onboardingId,
    startTime: new Date().toISOString(),
    completionTime: null,
    currentStep: 0,
    data: {},
    deleted: false,
    updatedAt: new Date().toISOString(),
  };
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record));
  return json({ onboardingId, writeToken, startTime: record.startTime }, 201, cors);
}

async function handleOnboardingSave(request, env, cors, onboardingId) {
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
    data: body.data,
    deleted: false,
    updatedAt: new Date().toISOString(),
  };
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record));

  // CRM history + automation on state transitions (not on every save). The
  // client identity comes from the wizard's own profile/consent emails; when
  // neither is present yet there is nobody to attach history to, so skip.
  const d = record.data || {};
  const clientEmail = String(((d.profile && d.profile.email) || (d.consent && d.consent.email) || '')).trim().toLowerCase();
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
    }
  }
  return json({ ok: true, updatedAt: record.updatedAt }, 200, cors);
}


// Soft delete: mark the record and give it (and its write secret) a 30-day TTL
// so it can be restored within that window, then auto-purges. No hard delete
// from the admin UI, so a misclick isn't instantly destructive.
async function handleAdminDeleteOnboarding(request, env, cors, onboardingId) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  if (!ONBOARDING_ID_PATTERN.test(onboardingId)) return json({ error: 'Invalid onboarding id' }, 400, cors);

  const raw = await env.PORTAL_KV.get(`onboarding:${onboardingId}`);
  if (!raw) return json({ error: 'Not found' }, 404, cors);
  const record = JSON.parse(raw);
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
  if (!ONBOARDING_ID_PATTERN.test(onboardingId)) return json({ error: 'Invalid onboarding id' }, 400, cors);

  const raw = await env.PORTAL_KV.get(`onboarding:${onboardingId}`);
  if (!raw) return json({ error: 'Not found or already purged' }, 404, cors);
  const record = JSON.parse(raw);
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

  const records = [];
  let cursor;
  do {
    const page = await env.PORTAL_KV.list({ prefix: 'onboarding:', cursor });
    for (const key of page.keys) {
      const raw = await env.PORTAL_KV.get(key.name);
      if (!raw) continue;
      try {
        records.push(JSON.parse(raw));
      } catch {}
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);

  records.sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));
  return json({ records }, 200, cors);
}

// Returns a page of audit entries (who did what, when), newest first. Because
// keys use an inverted timestamp (see logAudit), the newest entries sort first,
// so a bounded KV list returns them directly — the cost is flat regardless of
// how large the log grows. Pass the returned `cursor` back as ?cursor=... to
// fetch the next (older) page; `hasMore`/`cursor` are null once exhausted.
async function handleAdminAudit(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);

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

async function getGraphToken(env) {
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

    const record = {
      ...existing,
      ...householdFieldsFromSharePoint(fields),
      sharePointItemId: item.id,
      updatedAt: spModified ? spModified.toISOString() : new Date().toISOString(),
    };
    await env.PORTAL_KV.put(`household:${hhId}`, await encryptJSON(env, record));
    synced += 1;
  }
  return { synced, skipped, skippedNewerLocal, timestamp: new Date().toISOString() };
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

// Push a compliance item's current state to a dedicated SharePoint list, as a
// disaster-recovery mirror — same reasoning and same shape as household push:
// if the Worker or KV is unavailable, the compliance register still needs to
// be readable directly in SharePoint. Push-only, no pull: compliance items are
// managed entirely in this app (checkboxes, the Complete button, the drawer),
// so unlike contacts there is no reason to ever edit one directly in
// SharePoint, and no conflict to resolve.
//
// Requires a SharePoint list already created with these columns (Text unless
// noted): ComplianceId, WhatToDo (multi-line), DueDate, Frequency, Source,
// Mandated (Yes/No text), Owner, OwnerCompleted, Reviewer, ReviewerCompleted,
// Status, CompletedAt, Notes (multi-line). Title (the list's built-in column)
// holds the item name. Skips silently if SHAREPOINT_COMPLIANCE_LIST_ID isn't
// configured, so this ships safely before that list exists.
//
// Best-effort: any failure is logged and returns the item unchanged, so a
// SharePoint outage can never block saving a compliance item in the app.
async function pushComplianceToSharePoint(env, item) {
  if (!env.SHAREPOINT_COMPLIANCE_LIST_ID) return item;
  try {
    const token = await getGraphToken(env);
    const siteId = env.SHAREPOINT_SITE_ID;
    const listId = env.SHAREPOINT_COMPLIANCE_LIST_ID;
    const fields = {
      Title: item.item,
      ComplianceId: item.id,
      WhatToDo: item.whatToDo || '',
      DueDate: item.dueDate || '',
      Frequency: item.frequency || '',
      Source: item.source || '',
      Mandated: item.mandated ? 'Yes' : 'No',
      Owner: item.owner || '',
      OwnerCompleted: item.ownerCompleted || '',
      Reviewer: item.reviewer || '',
      ReviewerCompleted: item.reviewerCompleted || '',
      Status: complianceStatus(item),
      CompletedAt: item.completedAt || '',
      Notes: item.notes || '',
    };

    if (item.sharePointItemId) {
      const patchUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${item.sharePointItemId}/fields`;
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (patchRes.ok) return { ...item, sharePointItemId: item.sharePointItemId };
      // The row may have been removed independently on the SharePoint side
      // (manual cleanup, list rebuilt) — recreate rather than fail outright.
      console.error('Failed to update compliance item in SharePoint, recreating:', patchRes.status, await patchRes.text());
    }

    const createUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
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
    const url = `https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}/lists/${env.SHAREPOINT_COMPLIANCE_LIST_ID}/items/${item.sharePointItemId}`;
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
    return json({ resources, categories, configured }, 200, cors);
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
// Occurrences are generated ONE AT A TIME, on completion, not in a batch up
// front. Saving a new monthly item creates exactly one row (the entered due
// date); the next month's row only appears once that one is fully signed off,
// and so on indefinitely. This avoids a save instantly flooding the tracker
// with up to a year of not-yet-due rows.
const COMPLIANCE_FREQUENCIES = ['One time', 'Weekly', 'Monthly', 'Quarterly', 'Semi-annually', 'Annually'];

// Steps keyed by lowercased label. "One time" is deliberately absent — no step
// means no repeat. The legacy spreadsheet wording is mapped too so an item
// seeded as "Annual" still recurs correctly if someone turns it into a series.
const COMPLIANCE_FREQ_STEPS = {
  'weekly': { days: 7 },
  'monthly': { months: 1 },
  'quarterly': { months: 3 },
  'semi-annually': { months: 6 },
  'semi-annual': { months: 6 },
  'annually': { months: 12 },
  'annual': { months: 12 },
};

// Hard cap on how many steps ahead we'll search for the next occurrence date,
// so a corrupted seriesStart can never turn into a runaway loop.
const COMPLIANCE_MAX_OCCURRENCES = 200;

function complianceFreqStep(frequency) {
  return COMPLIANCE_FREQ_STEPS[String(frequency || '').trim().toLowerCase()] || null;
}

// Date-only maths done in UTC on purpose: these values have no time of day, and
// doing it in local time would let a DST boundary shift a due date by a day.
function isoAddDays(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isoAddMonths(iso, months) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const target = m - 1 + months;
  const ty = y + Math.floor(target / 12);
  const tm = ((target % 12) + 12) % 12;
  // Clamp to the month's length: Jan 31 + 1 month is Feb 28, not Mar 3.
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

// The next due date after `afterIso` in a series starting at `startIso`. Each
// occurrence is stepped from the START rather than from the previous one, so a
// monthly series beginning Jan 31 runs Jan 31, Feb 28, Mar 31 — stepping from
// the previous date would clamp once and then stay stuck on the 28th.
function complianceNextOccurrenceDate(startIso, frequency, afterIso) {
  const step = complianceFreqStep(frequency);
  if (!step) return null;
  for (let i = 1; i <= COMPLIANCE_MAX_OCCURRENCES; i++) {
    const iso = step.days ? isoAddDays(startIso, step.days * i) : isoAddMonths(startIso, step.months * i);
    if (iso > afterIso) return iso;
  }
  return null;
}

function complianceOccurrenceFrom(template, dueDate, seriesId) {
  return {
    ...template,
    id: `cx-${invTs()}-${randomHex(3)}`,
    seriesId,
    dueDate,
    // A new occurrence is always outstanding — sign-offs belong to one date only.
    ownerCompleted: '', ownerCompletedBy: '',
    reviewerCompleted: '', reviewerCompletedBy: '',
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
}

// Advance a series by exactly one occurrence, and only once the given item —
// the latest occurrence in its series — is fully signed off (CLOSED). This is
// what makes recurrence a drip feed instead of a batch: a monthly item never
// has more than one open (not-yet-due) row waiting at a time.
//
// Only fires off the latest existing date in the series — never backfills —
// and skips a date already taken by an item of the same name, which is what
// stops a seeded quarterly item (already materialised four times by the
// workbook) from gaining a duplicate if someone turns it into a series.
// The other occurrences of the same recurring obligation. A series created in
// the app is grouped by seriesId, but the 128 seeded rows have no seriesId at
// all — there, same item NAME is the only thing tying occurrences together
// (which is exactly how the workbook expressed a quarterly item: four rows
// sharing a name).
function complianceSeriesPeers(items, item) {
  if (item.seriesId) return items.filter((x) => x.seriesId === item.seriesId);
  const name = String(item.item).trim().toLowerCase();
  return items.filter((x) => String(x.item).trim().toLowerCase() === name);
}

function complianceAdvanceSeries(items, item) {
  if (!complianceFreqStep(item.frequency)) return null;
  if (complianceStatus(item) !== 'CLOSED') return null;
  // Only the newest occurrence advances, so closing an old backlog row doesn't
  // graft an extra date onto a series that has already moved past it.
  if (complianceSeriesPeers(items, item).some((x) => String(x.dueDate) > String(item.dueDate))) return null;

  const start = item.seriesStart || item.dueDate;
  const nextDate = complianceNextOccurrenceDate(start, item.frequency, item.dueDate);
  if (!nextDate) return null;
  const key = `${String(item.item).trim().toLowerCase()}|${nextDate}`;
  if (items.some((x) => `${String(x.item).trim().toLowerCase()}|${x.dueDate}` === key)) return null;

  // Promote to a real series on the way out. A seeded row carries a frequency
  // ("Annual") but no seriesId, and without this it could never recur — signing
  // it off would close it and nothing would replace it. Done only once we know
  // an occurrence is actually being created, so a no-op advance leaves the
  // record untouched.
  if (!item.seriesId) {
    item.seriesId = `cs-${invTs()}-${randomHex(3)}`;
    item.seriesStart = item.seriesStart || item.dueDate;
  }
  const occurrence = complianceOccurrenceFrom(item, nextDate, item.seriesId);
  items.push(occurrence);
  return occurrence;
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

function withComplianceStatus(item) {
  return {
    ...item,
    status: complianceStatus(item),
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
  // 2028"), and rejecting those would make those items unsaveable. Whether it
  // repeats is decided by complianceFreqStep, which simply finds no step for
  // anything it doesn't recognise.
  if (body.frequency !== undefined) out.frequency = str(body.frequency, 100);
  if (body.source !== undefined) out.source = str(body.source, 100);
  if (body.notes !== undefined) out.notes = str(body.notes, 2000);
  if (body.mandated !== undefined) out.mandated = !!body.mandated;

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
  const items = await getComplianceItems(env);
  return json({
    items: complianceSort(items).map(withComplianceStatus),
    owners: COMPLIANCE_OWNERS,
    reviewers: COMPLIANCE_REVIEWERS,
    frequencies: COMPLIANCE_FREQUENCIES,
  }, 200, cors);
}

async function handleAdminComplianceCreate(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeComplianceFields(body, { requireCore: true });
  if (error) return json({ error }, 400, cors);

  const items = await getComplianceItems(env);
  const step = complianceFreqStep(fields.frequency);
  // Only the one row the user actually entered is created here, even for a
  // recurring frequency. seriesId/seriesStart mark it as the head of a series;
  // the next occurrence is generated later, once this one is signed off (see
  // complianceAdvanceSeries).
  const seriesId = step ? `cs-${invTs()}-${randomHex(3)}` : '';
  const base = {
    id: `cx-${invTs()}-${randomHex(3)}`,
    whatToDo: '', frequency: '', source: '', notes: '', mandated: false,
    ...fields,
    seriesId,
    seriesStart: step ? fields.dueDate : '',
    ownerCompleted: fields.ownerCompleted || '',
    ownerCompletedBy: '',
    reviewerCompleted: fields.reviewerCompleted || '',
    reviewerCompletedBy: '',
    createdAt: new Date().toISOString(),
    createdBy: adminEmail,
    updatedAt: null,
  };
  items.push(base);
  let created = 1;
  const occurrence = complianceAdvanceSeries(items, base);
  if (occurrence) created = 2;

  // Best-effort disaster-recovery mirror — see pushComplianceToSharePoint.
  // Runs before the KV write so a successful push's item id is captured
  // immediately. base is a brand-new item, so this is always a create; a
  // fresh occurrence (rare on create — it needs the new item already CLOSED)
  // gets its own row too rather than waiting for its first edit.
  Object.assign(base, await pushComplianceToSharePoint(env, base));
  if (occurrence) Object.assign(occurrence, await pushComplianceToSharePoint(env, occurrence));

  await saveComplianceItems(env, items);
  await logAudit(env, adminEmail, 'compliance-create', { id: base.id, item: base.item, occurrences: created });
  return json({ item: withComplianceStatus(base), created }, 200, cors);
}

async function handleAdminComplianceUpdate(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeComplianceFields(body);
  if (error) return json({ error }, 400, cors);

  const items = await getComplianceItems(env);
  const idx = items.findIndex((x) => x.id === id);
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

  // Setting a recurring frequency on a one-off item promotes it to a series, so
  // "make this monthly" works on the 128 seeded items too and not only on newly
  // added ones. No occurrence is generated yet — that only happens once this
  // item is signed off (see complianceAdvanceSeries below).
  let created = 0;
  if (fields.frequency !== undefined && complianceFreqStep(next.frequency) && !next.seriesId) {
    next.seriesId = `cs-${invTs()}-${randomHex(3)}`;
    next.seriesStart = next.dueDate;
  }
  // Dropping back to "One time" stops the series growing without touching the
  // occurrences already generated (deleting dated sign-off records silently
  // would destroy evidence).
  if (fields.frequency !== undefined && !complianceFreqStep(next.frequency)) {
    next.seriesId = '';
    next.seriesStart = '';
  }
  // Completing this occurrence (owner + reviewer sign-off, or owner alone when
  // no reviewer is required) drips the next due date into existence.
  const occurrence = complianceAdvanceSeries(items, next);
  if (occurrence) created = 1;

  // Best-effort disaster-recovery mirror — see pushComplianceToSharePoint.
  Object.assign(next, await pushComplianceToSharePoint(env, next));
  if (occurrence) Object.assign(occurrence, await pushComplianceToSharePoint(env, occurrence));

  await saveComplianceItems(env, items);
  return json({ item: withComplianceStatus(next), created }, 200, cors);
}

async function handleAdminComplianceDelete(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const items = await getComplianceItems(env);
  const idx = items.findIndex((x) => x.id === id);
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
    removedItems = items.filter((x) => x.seriesId === sid);
    const kept = items.filter((x) => x.seriesId !== sid);
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
  await saveComplianceItems(env, items);
  await logAudit(env, adminEmail, 'compliance-delete', {
    id, item: target.item, series: wholeSeries, removed: removedCount,
  });
  return json({ ok: true, removed: removedCount }, 200, cors);
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
  return json(
    { contacts: await buildContactList(env), admins: await allAdminEmails(env), adminNames: await addedAdminNames(env) },
    200,
    cors
  );
}

// The merge itself, without the HTTP wrapper, so any other caller can read the
// same shape the CRM UI does rather than re-deriving it from KV.
async function buildContactList(env) {
  const merged = new Map(); // email -> entry

  // CRM contact records first (decrypt failure fails closed like elsewhere).
  for (const keyName of await listKeys(env, 'contact:')) {
    const rec = await decryptToObject(env, await env.PORTAL_KV.get(keyName));
    if (!rec || !rec.email) continue;
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
    });
  }

  // Portal accounts: merge into (or create) an entry per user.
  for (const keyName of await listKeys(env, 'user:')) {
    const email = keyName.slice('user:'.length);
    const userRaw = await env.PORTAL_KV.get(keyName);
    if (!userRaw) continue;
    const user = JSON.parse(userRaw);
    const entry = merged.get(email) || {
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
    };
    entry.hasAccount = true;
    if (!entry.name) entry.name = user.name || '';
    try {
      entry.modules = await loadModules(env, await env.PORTAL_KV.get(`responses:${email}`));
    } catch {
      entry.modulesError = true;
    }
    entry.assignments = loadAssignments(await env.PORTAL_KV.get(`assignments:${email}`));
    merged.set(email, entry);
  }

  return [...merged.values()];
}

// Create/update the CRM fields for one contact. Partial update: only the
// fields present in the body change; the rest of the record is preserved.
async function handleAdminUpsertContact(request, env, cors, targetEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const email = String(targetEmail).trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Invalid contact email' }, 400, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);

  const { fields, error } = sanitizeContactFields(body);
  if (error) return json({ error }, 400, cors);

  const existing = (await decryptToObject(env, await env.PORTAL_KV.get(`contact:${email}`))) || {
    email,
    status: 'prospect',
    createdAt: new Date().toISOString(),
  };
  let record = { ...existing, ...fields, email, updatedAt: new Date().toISOString() };
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
  const email = String(targetEmail).trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Invalid contact email' }, 400, cors);
  const existing = (await decryptToObject(env, await env.PORTAL_KV.get(`contact:${email}`))) || {
    email,
    status: 'prospect',
    createdAt: new Date().toISOString(),
  };
  const record = {
    ...existing,
    email,
    archived,
    archivedAt: archived ? new Date().toISOString() : null,
    archivedBy: archived ? adminEmail : null,
    updatedAt: new Date().toISOString(),
  };
  await env.PORTAL_KV.put(`contact:${email}`, await encryptJSON(env, record));
  await logAudit(env, adminEmail, archived ? 'archive-contact' : 'unarchive-contact', { client: email });
  return json({ contact: record }, 200, cors);
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
const HOUSEHOLD_ROLES = ['head', 'spouse', 'partner', 'child', 'dependent', 'other'];
const HOUSEHOLD_EMAIL_TYPES = ['', 'work', 'home', 'other'];

function sanitizeHouseholdFields(body) {
  const out = {};
  if (body.name !== undefined) {
    const n = String(body.name || '').trim();
    if (!n) return { error: 'Household name is required' };
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
      if (seen.has(email)) return { error: 'A person can only appear once in a household' };
      seen.add(email);
      const role = String(m.role || '').trim().toLowerCase();
      members.push({ email, role: HOUSEHOLD_ROLES.includes(role) ? role : 'other' });
      if (members.length >= 20) break;
    }
    out.members = members;
  }
  if (body.email !== undefined) {
    const e = String(body.email || '').trim().toLowerCase();
    if (e && !isValidEmail(e)) return { error: 'Household email is not valid' };
    out.email = e.slice(0, 200);
  }
  if (body.emailType !== undefined) {
    const t = String(body.emailType || '').trim().toLowerCase();
    if (!HOUSEHOLD_EMAIL_TYPES.includes(t)) return { error: 'Invalid email type' };
    out.emailType = t;
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

async function handleAdminListHouseholds(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const { items, errors } = await readAllEncrypted(env, 'household:');
  return json({ households: items, decryptErrors: errors }, 200, cors);
}

async function handleAdminCreateHousehold(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeHouseholdFields(body);
  if (error) return json({ error }, 400, cors);
  if (!fields.name) return json({ error: 'Household name is required' }, 400, cors);
  const id = `hh-${randomHex(6)}`;
  let record = {
    id,
    type: 'household',
    name: fields.name,
    members: fields.members || [],
    email: fields.email || '',
    emailType: fields.emailType || '',
    emailPrimary: fields.emailPrimary !== undefined ? fields.emailPrimary : true,
    assignedTo: fields.assignedTo || '',
    advisorRep: fields.advisorRep || '',
    contactType: fields.contactType || '',
    background: fields.background || '',
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
  await logAudit(env, adminEmail, 'create-household', { id, name: record.name });
  return json({ household: record }, 200, cors);
}

async function handleAdminUpdateHousehold(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const raw = await env.PORTAL_KV.get(`household:${id}`);
  if (!raw) return json({ error: 'Household not found' }, 404, cors);
  const existing = await decryptToObject(env, raw);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeHouseholdFields(body);
  if (error) return json({ error }, 400, cors);
  // Archive is a soft-delete toggle, handled here rather than as its own route
  // because a household has no portal account to keep consistent.
  if (body.archived !== undefined) {
    fields.archived = !!body.archived;
    fields.archivedAt = body.archived ? new Date().toISOString() : null;
  }
  let record = { ...existing, ...fields, id, type: 'household', updatedAt: new Date().toISOString() };
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
  const raw = await env.PORTAL_KV.get(`household:${id}`);
  if (!raw) return json({ error: 'Household not found' }, 404, cors);
  // Decrypted so its sharePointItemId is known — an intentional delete here
  // should remove the SharePoint backup row too, or it reads as a still-live
  // household if someone checks SharePoint during a later outage.
  const existing = await decryptToObject(env, raw);
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
async function syncTaskToOutlook(env, task) {
  if (!outlookConfigured(env)) return null;
  try {
    const wanted = taskCalendarOwners(task);
    const existing = taskOutlookEvents(task);
    const payload = wanted.length ? outlookEventBody(task, outlookTimeZone(env)) : null;
    const next = {};
    let changed = false;

    // No usable date (or nobody selected) means this can't be an event at all —
    // withdraw every copy rather than leaving stale ones behind.
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
          continue;
        }
        // 404 — deleted in Outlook; fall through and recreate it.
      }
      const res = await graphCalendarFetch(env, 'POST', `/users/${encodeURIComponent(owner)}/events`, payload);
      if (!res.ok) {
        console.error('Outlook event create failed:', owner, res.status, await res.text());
        continue;
      }
      const created = await res.json();
      if (created.id) { next[owner] = created.id; changed = true; }
    }

    // Mailboxes that were unticked (or all of them, if this stopped being an
    // event) lose their copy.
    for (const [owner, id] of Object.entries(existing)) {
      if (next[owner]) continue;
      await deleteOutlookEvent(env, owner, id);
      changed = true;
    }

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
    try {
      const contact = await decryptToObject(env, await env.PORTAL_KV.get(`contact:${client}`));
      if (contact && contact.advisor) assignee = contact.advisor;
    } catch {}
    await createTask(env, { ...fields, client, assignee, createdBy: 'auto' });
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
  const { items, errors } = await readAllEncrypted(env, 'task:');
  return json({ tasks: items, decryptErrors: errors }, 200, cors);
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
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  if (!body.title || !String(body.title).trim()) return json({ error: 'Title is required' }, 400, cors);
  const { fields, error } = sanitizeTaskFields(body, await allowedAssigneeSet(env));
  if (error) return json({ error }, 400, cors);
  const task = await createTask(env, { ...fields, createdBy: adminEmail });
  return json({ task }, 200, cors);
}

async function handleAdminUpdateTask(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const raw = await env.PORTAL_KV.get(`task:${id}`);
  if (!raw) return json({ error: 'Task not found' }, 404, cors);
  const task = await decryptToObject(env, raw);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { fields, error } = sanitizeTaskFields(body, await allowedAssigneeSet(env));
  if (error) return json({ error }, 400, cors);

  const wasOpen = task.status === 'open';
  const prevAssignee = task.assignee || '';
  Object.assign(task, fields);

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
        // Carry the prep items forward but unticked — it's a fresh occurrence.
        checklist: (task.checklist || []).map((c) => ({ ...c, done: false })),
        createdBy: adminEmail,
      });
      logHistory('repeat-spawned', { nextId: spawned.id, due: nextDue });
    }
  }
  if (!wasOpen && task.status === 'open') {
    task.completedAt = null; // reopened
    logHistory('reopened', null);
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
  const raw = await env.PORTAL_KV.get(`task:${id}`);
  let task = null;
  if (raw) {
    try { task = await decryptToObject(env, raw); } catch {}
  }
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

async function getBoardLists(env) {
  try {
    const rec = await decryptToObject(env, await env.PORTAL_KV.get(BOARD_LISTS_KEY));
    if (rec && Array.isArray(rec.lists)) return rec.lists;
    // Migrate the earlier team_roster (free-text members) → custom lists.
    const legacy = await decryptToObject(env, await env.PORTAL_KV.get('team_roster'));
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
  return json({ lists: await getBoardLists(env) }, 200, cors);
}

async function handleAdminCreateList(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const body = await request.json().catch(() => null);
  const type = (body && body.type) === 'person' ? 'person' : 'custom';
  const lists = await getBoardLists(env);
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
  await env.PORTAL_KV.put(BOARD_LISTS_KEY, await encryptJSON(env, { lists }));
  return json({ list, lists }, 200, cors);
}

async function handleAdminDeleteList(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const lists = (await getBoardLists(env)).filter((l) => l.id !== id);
  await env.PORTAL_KV.put(BOARD_LISTS_KEY, await encryptJSON(env, { lists }));
  // Tasks that referenced this list (or an unlisted assignee) just fall into
  // Unassigned on the board; they aren't rewritten here.
  return json({ lists }, 200, cors);
}

// ---------- Notes ----------

async function handleAdminListNotes(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const client = new URL(request.url).searchParams.get('client');
  const prefix = client ? `note:${String(client).trim().toLowerCase()}:` : 'note:';
  const { items, errors } = await readAllEncrypted(env, prefix);
  return json({ notes: items, decryptErrors: errors }, 200, cors);
}

async function handleAdminCreateNote(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const client = String(body.client || '').trim().toLowerCase();
  if (!isValidEmail(client)) return json({ error: 'A valid client email is required' }, 400, cors);
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
  const raw = await env.PORTAL_KV.get(`note:${id}`);
  if (!raw) return json({ error: 'Note not found' }, 404, cors);
  const note = await decryptToObject(env, raw);
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
  const raw = await env.PORTAL_KV.get(`note:${id}`);
  let note = null;
  if (raw) {
    try { note = await decryptToObject(env, raw); } catch {}
  }
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
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Invalid client email' }, 400, cors);
  const cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  const result = await pagedEncryptedList(env, `timeline:${email}:`, cursor, 50);
  result.entries = await filterDeletedReferences(result.entries, env);
  return json(result, 200, cors);
}

async function handleAdminActivity(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  const result = await pagedEncryptedList(env, 'activity:', cursor, 30);
  result.entries = await filterDeletedReferences(result.entries, env);
  return json(result, 200, cors);
}

// Per-admin notification read cursor. Notifications themselves are DERIVED
// (activity newer than this timestamp + overdue tasks) — nothing is fanned out
// or stored per event, so there is nothing to keep consistent.
async function handleAdminGetNotifSeen(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const seen = await env.PORTAL_KV.get(`notif_seen:${adminEmail}`);
  return json({ seen: seen || null }, 200, cors);
}

async function handleAdminSetNotifSeen(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const seen = new Date().toISOString();
  await env.PORTAL_KV.put(`notif_seen:${adminEmail}`, seen);
  return json({ seen }, 200, cors);
}

async function handleAdminClients(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);

  const clients = [];
  let cursor;
  do {
    const page = await env.PORTAL_KV.list({ prefix: 'user:', cursor });
    for (const key of page.keys) {
      const email = key.name.slice('user:'.length);
      const userRaw = await env.PORTAL_KV.get(key.name);
      const responsesRaw = await env.PORTAL_KV.get(`responses:${email}`);
      const assignmentsRaw = await env.PORTAL_KV.get(`assignments:${email}`);
      if (!userRaw) continue;
      const user = JSON.parse(userRaw);
      // Decrypt per client; a single undecryptable record surfaces as an error
      // flag on that client rather than failing the whole listing.
      let modules = {};
      let modulesError = false;
      try {
        modules = await loadModules(env, responsesRaw);
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

  return json({ clients }, 200, cors);
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

export default {
  async fetch(request, env) {
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
      const saveMatch = url.pathname.match(/^\/api\/assessments\/([a-z]+)$/);
      if (saveMatch && request.method === 'POST') {
        return await handleSaveAssessment(request, env, cors, saveMatch[1]);
      }
      if (url.pathname === '/api/onboarding/start' && request.method === 'POST') {
        return await handleOnboardingStart(request, env, cors);
      }
      const onbMatch = url.pathname.match(/^\/api\/onboarding\/(BLA-ONB-\d{4}-\d{4})$/);
      if (onbMatch && request.method === 'POST') {
        return await handleOnboardingSave(request, env, cors, onbMatch[1]);
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
        try {
          const result = await syncSharePointHouseholds(env);
          await logAudit(env, adminEmail, 'sync-sharepoint-households', result);
          return json(result, 200, cors);
        } catch (err) {
          console.error('SharePoint household sync failed:', err);
          return json({ error: 'Sync failed: ' + (err && err.message) }, 500, cors);
        }
      }
      // One-off diagnostic: lists every SharePoint list in the configured site
      // (name + id), so a new list's id can be found without re-pasting Azure
      // credentials anywhere outside Cloudflare's own encrypted secrets.
      if (url.pathname === '/api/admin/sharepoint/lists' && request.method === 'GET') {
        const adminEmail = await getAdminEmail(request, env);
        if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
        try {
          const token = await getGraphToken(env);
          const resp = await fetch(`https://graph.microsoft.com/v1.0/sites/${env.SHAREPOINT_SITE_ID}/lists`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!resp.ok) throw new Error('Graph API error: ' + resp.status);
          const data = await resp.json();
          const lists = (data.value || []).map((l) => ({ name: l.displayName, id: l.id }));
          return json({ lists }, 200, cors);
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
      // Archive/unarchive must be matched before the generic upsert route below,
      // whose `(.+)` would otherwise swallow the "/archive" suffix into the email.
      const archiveMatch = url.pathname.match(/^\/api\/admin\/contacts\/(.+)\/(archive|unarchive)$/);
      if (archiveMatch && request.method === 'POST') {
        return await handleAdminArchiveContact(request, env, cors, decodeURIComponent(archiveMatch[1]), archiveMatch[2] === 'archive');
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
      const onbRestoreMatch = url.pathname.match(/^\/api\/admin\/onboarding\/(BLA-ONB-\d{4}-\d{4})\/restore$/);
      if (onbRestoreMatch && request.method === 'POST') {
        return await handleAdminRestoreOnboarding(request, env, cors, onbRestoreMatch[1]);
      }
      const onbDeleteMatch = url.pathname.match(/^\/api\/admin\/onboarding\/(BLA-ONB-\d{4}-\d{4})$/);
      if (onbDeleteMatch && request.method === 'DELETE') {
        return await handleAdminDeleteOnboarding(request, env, cors, onbDeleteMatch[1]);
      }
      if (url.pathname.startsWith('/api/')) {
        return json({ error: 'Not found' }, 404, cors);
      }
      return env.ASSETS.fetch(request);
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
