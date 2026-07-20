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
 *
 * NOTE: This remains a proof-of-concept-grade system. Admin access now uses
 * per-email login + sessions and writes an audit log, but there is still no
 * application-level encryption of client PII, and the onboarding flow is
 * unauthenticated beyond a per-session write token. See STATUS.md "Known gaps".
 */

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
  // Each admin has their own password secret; fall back to the legacy shared
  // ADMIN_PASSWORD while individual secrets are being rolled out. Trim both
  // sides so a stray trailing newline in a secret (a very common result of how
  // secrets get pasted/piped in) doesn't cause a silent length mismatch.
  const account = ADMIN_ACCOUNTS.find((a) => a.email === normalizedEmail);
  const expectedPassword = account
    ? ((env[account.secret] || env.ADMIN_PASSWORD) || '').trim()
    : '';
  const passOk = !!expectedPassword && timingSafeEqual(String(password).trim(), expectedPassword);
  if (!account || !passOk) {
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
  const admins = [];
  for (const a of ADMIN_ACCOUNTS) {
    const mfa = await getAdminMfa(env, a.email); // throws on decrypt fail -> 500 (fail closed)
    admins.push({ email: a.email, mfaEnabled: !!(mfa && mfa.confirmed) });
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
  if (!ADMIN_ACCOUNTS.some((a) => a.email === normalized)) {
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
  if (typeof body.status === 'string') {
    if (!CONTACT_STATUSES.includes(body.status)) return { error: 'Invalid status' };
    out.status = body.status;
  }
  if (typeof body.household === 'string') out.household = body.household.trim().slice(0, 200);
  if (typeof body.phone === 'string') out.phone = body.phone.trim().slice(0, 50);
  if (typeof body.advisor === 'string') {
    const adv = body.advisor.trim().toLowerCase();
    if (adv && !ADMIN_ACCOUNTS.some((a) => a.email === adv)) return { error: 'Advisor must be an admin account' };
    out.advisor = adv;
  }
  if (Array.isArray(body.tags)) {
    out.tags = body.tags
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().slice(0, 40))
      .slice(0, 20);
  }
  if (Array.isArray(body.importantDates)) {
    out.importantDates = body.importantDates
      .filter((d) => d && typeof d.label === 'string' && d.label.trim())
      .map((d) => ({ label: String(d.label).trim().slice(0, 60), date: String(d.date || '').trim().slice(0, 40) }))
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

  const merged = new Map(); // email -> entry

  // CRM contact records first (decrypt failure fails closed like elsewhere).
  for (const keyName of await listKeys(env, 'contact:')) {
    const rec = await decryptToObject(env, await env.PORTAL_KV.get(keyName));
    if (!rec || !rec.email) continue;
    merged.set(rec.email, {
      email: rec.email,
      name: rec.name || '',
      status: rec.status || 'prospect',
      archived: !!rec.archived,
      household: rec.household || '',
      advisor: rec.advisor || '',
      phone: rec.phone || '',
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
      status: 'active', // an account holder you never categorized is a live client
      archived: false,
      household: '',
      advisor: '',
      phone: '',
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

  return json({ contacts: [...merged.values()], admins: ADMIN_ACCOUNTS.map((a) => a.email) }, 200, cors);
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
  const record = { ...existing, ...fields, email, updatedAt: new Date().toISOString() };
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

// ---------- Advisor CRM: timeline, tasks, notes ----------
// Timeline entries are the client relationship history (kept forever, keyed
// per client); each write is mirrored to a global activity: feed (13-month TTL
// like audit) that powers the dashboard and notifications. Tasks and notes are
// first-class records. All payloads are encrypted at rest like assessment data.

const TASK_PRIORITIES = ['low', 'medium', 'high'];
const TASK_CATEGORIES = ['follow-up', 'review', 'meeting', 'onboarding', 'compliance', 'other'];
const TASK_CHECKLIST_MAX = 50;
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

function invTs(now = Date.now()) {
  return String(AUDIT_TS_CEILING - now).padStart(14, '0');
}

// Record a client-history event. Dual-write: per-client timeline (permanent)
// + global activity feed (expiring). Best-effort like logAudit — a telemetry
// failure must never break the request that triggered it.
async function logTimeline(env, client, type, actor, detail) {
  try {
    const email = String(client || '').trim().toLowerCase();
    if (!isValidEmail(email)) return;
    const entry = {
      ts: new Date().toISOString(),
      client: email,
      type,
      actor: actor || 'system',
      detail: detail == null ? null : detail,
    };
    const suffix = `${invTs()}-${randomHex(4)}`;
    const encrypted = await encryptJSON(env, entry);
    await env.PORTAL_KV.put(`timeline:${email}:${suffix}`, encrypted);
    await env.PORTAL_KV.put(`activity:${suffix}`, encrypted, { expirationTtl: AUDIT_TTL_SECONDS });
  } catch {
    // swallow — history is best-effort
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
    priority: TASK_PRIORITIES.includes(fields.priority) ? fields.priority : 'medium',
    category: TASK_CATEGORIES.includes(fields.category) ? fields.category : 'other',
    status: 'open',
    checklist: sanitizeChecklist(fields.checklist),
    createdBy: fields.createdBy || 'system',
    createdAt: new Date().toISOString(),
    completedAt: null,
    history: [{ ts: new Date().toISOString(), actor: fields.createdBy || 'system', type: 'created', detail: null }],
  };
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
  if (body.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(body.priority)) return { error: 'Invalid priority' };
    out.priority = body.priority;
  }
  if (body.category !== undefined) {
    if (!TASK_CATEGORIES.includes(body.category)) return { error: 'Invalid category' };
    out.category = body.category;
  }
  if (body.status !== undefined) {
    if (!['open', 'done'].includes(body.status)) return { error: 'Invalid status' };
    out.status = body.status;
  }
  if (body.checklist !== undefined) out.checklist = sanitizeChecklist(body.checklist);
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
  if (wasOpen && task.status === 'done') {
    task.completedAt = new Date().toISOString();
    logHistory('completed', null);
    if (task.client) {
      await logTimeline(env, task.client, task.category === 'meeting' ? 'meeting-held' : 'task-completed',
        adminEmail, { title: task.title });
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

  await env.PORTAL_KV.put(`task:${id}`, await encryptJSON(env, task));
  return json({ task }, 200, cors);
}

async function handleAdminDeleteTask(request, env, cors, id) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  await env.PORTAL_KV.delete(`task:${id}`);
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

function isAdminAccount(email) {
  return ADMIN_ACCOUNTS.some((a) => a.email === email);
}

// Assignees are admin accounts only (lists are a separate grouping dimension).
async function allowedAssigneeSet(env) {
  return new Set(ADMIN_ACCOUNTS.map((a) => a.email));
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
    if (!isAdminAccount(account)) return json({ error: 'Pick an existing admin account' }, 400, cors);
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
  };
  await env.PORTAL_KV.put(`note:${id}`, await encryptJSON(env, note));
  await logTimeline(env, client, 'note-added', adminEmail, null);
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
  await env.PORTAL_KV.delete(`note:${id}`);
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

async function handleAdminTimeline(request, env, cors, rawEmail) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isValidEmail(email)) return json({ error: 'Invalid client email' }, 400, cors);
  const cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  const result = await pagedEncryptedList(env, `timeline:${email}:`, cursor, 50);
  return json(result, 200, cors);
}

async function handleAdminActivity(request, env, cors) {
  const adminEmail = await getAdminEmail(request, env);
  if (!adminEmail) return json({ error: 'Not authorized' }, 401, cors);
  const cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  const result = await pagedEncryptedList(env, 'activity:', cursor, 30);
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
      if (url.pathname === '/api/admin/contacts' && request.method === 'GET') {
        return await handleAdminContacts(request, env, cors);
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
};
