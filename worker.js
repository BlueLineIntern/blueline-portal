/**
 * BlueLine Advisors Client Questionnaire Portal — Cloudflare Worker API
 *
 * Requires a KV namespace binding called PORTAL_KV (see wrangler.toml).
 * KV layout:
 *   user:<email>          -> { name, email, salt, hash, iterations }
 *   session:<token>       -> email                         (TTL'd)
 *   responses:<email>     -> questionnaire object
 *
 * Endpoints:
 *   POST /api/register     { name, email, password }
 *   POST /api/login        { email, password }
 *   POST /api/logout       (Authorization: Bearer <token>)
 *   GET  /api/questionnaire            (Authorization: Bearer <token>)
 *   POST /api/questionnaire { ... }    (Authorization: Bearer <token>)
 *   GET  /api/admin/clients            (Authorization: Bearer <ADMIN_TOKEN secret>)
 *
 * Set the admin secret with: wrangler secret put ADMIN_TOKEN
 * (or Cloudflare dashboard -> Worker -> Settings -> Variables and secrets)
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const PBKDF2_ITERATIONS = 100000;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

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
    {
      name: 'PBKDF2',
      salt: hexToBuf(saltHex),
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return bufToHex(derived);
}

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bufToHex(bytes.buffer);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function getSessionEmail(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  const email = await env.PORTAL_KV.get(`session:${token}`);
  return email;
}

async function handleRegister(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, origin);

  const { name, email, password } = body;
  if (!name || !isValidEmail(email) || !password || password.length < 8) {
    return json(
      { error: 'name, a valid email, and a password of at least 8 characters are required' },
      400,
      origin
    );
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await env.PORTAL_KV.get(`user:${normalizedEmail}`);
  if (existing) {
    return json({ error: 'An account with this email already exists' }, 409, origin);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);

  await env.PORTAL_KV.put(
    `user:${normalizedEmail}`,
    JSON.stringify({ name, email: normalizedEmail, salt, hash, iterations: PBKDF2_ITERATIONS })
  );

  const token = randomHex(32);
  await env.PORTAL_KV.put(`session:${token}`, normalizedEmail, { expirationTtl: SESSION_TTL_SECONDS });

  return json({ token, name, email: normalizedEmail }, 201, origin);
}

async function handleLogin(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, origin);

  const { email, password } = body;
  if (!isValidEmail(email) || !password) {
    return json({ error: 'Email and password are required' }, 400, origin);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const userRaw = await env.PORTAL_KV.get(`user:${normalizedEmail}`);
  if (!userRaw) {
    return json({ error: 'Invalid email or password' }, 401, origin);
  }

  const user = JSON.parse(userRaw);
  const attemptedHash = await hashPassword(password, user.salt, user.iterations);

  if (attemptedHash !== user.hash) {
    return json({ error: 'Invalid email or password' }, 401, origin);
  }

  const token = randomHex(32);
  await env.PORTAL_KV.put(`session:${token}`, normalizedEmail, { expirationTtl: SESSION_TTL_SECONDS });

  return json({ token, name: user.name, email: normalizedEmail }, 200, origin);
}

async function handleLogout(request, env, origin) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    await env.PORTAL_KV.delete(`session:${match[1]}`);
  }
  return json({ ok: true }, 200, origin);
}

async function handleGetQuestionnaire(request, env, origin) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, origin);

  const raw = await env.PORTAL_KV.get(`responses:${email}`);
  return json({ responses: raw ? JSON.parse(raw) : null }, 200, origin);
}

async function handleSaveQuestionnaire(request, env, origin) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, origin);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, origin);

  const {
    budgetRange,
    experienceLevel,
    riskTolerance,
    goalShortTerm,
    goalMediumTerm,
    goalLongTerm,
  } = body;

  const risk = Number(riskTolerance);
  if (
    !budgetRange ||
    !experienceLevel ||
    !Number.isInteger(risk) ||
    risk < 1 ||
    risk > 10
  ) {
    return json(
      { error: 'budgetRange, experienceLevel, and riskTolerance (integer 1-10) are required' },
      400,
      origin
    );
  }

  const responses = {
    budgetRange,
    experienceLevel,
    riskTolerance: risk,
    goalShortTerm: goalShortTerm || '',
    goalMediumTerm: goalMediumTerm || '',
    goalLongTerm: goalLongTerm || '',
    updatedAt: new Date().toISOString(),
  };

  await env.PORTAL_KV.put(`responses:${email}`, JSON.stringify(responses));
  return json({ responses }, 200, origin);
}

async function handleAdminClients(request, env, origin) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = match ? match[1] : '';

  if (!env.ADMIN_TOKEN || providedToken !== env.ADMIN_TOKEN) {
    return json({ error: 'Not authorized' }, 401, origin);
  }

  const clients = [];
  let cursor;
  do {
    const page = await env.PORTAL_KV.list({ prefix: 'user:', cursor });
    for (const key of page.keys) {
      const email = key.name.slice('user:'.length);
      const userRaw = await env.PORTAL_KV.get(key.name);
      const responsesRaw = await env.PORTAL_KV.get(`responses:${email}`);
      if (!userRaw) continue;
      const user = JSON.parse(userRaw);
      clients.push({
        name: user.name,
        email: user.email,
        responses: responsesRaw ? JSON.parse(responsesRaw) : null,
      });
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);

  return json({ clients }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/api/register' && request.method === 'POST') {
        return await handleRegister(request, env, origin);
      }
      if (url.pathname === '/api/login' && request.method === 'POST') {
        return await handleLogin(request, env, origin);
      }
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        return await handleLogout(request, env, origin);
      }
      if (url.pathname === '/api/questionnaire' && request.method === 'GET') {
        return await handleGetQuestionnaire(request, env, origin);
      }
      if (url.pathname === '/api/questionnaire' && request.method === 'POST') {
        return await handleSaveQuestionnaire(request, env, origin);
      }
      if (url.pathname === '/api/admin/clients' && request.method === 'GET') {
        return await handleAdminClients(request, env, origin);
      }
      if (url.pathname.startsWith('/api/')) {
        return json({ error: 'Not found' }, 404, origin);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: 'Internal server error' }, 500, origin);
    }
  },
};
