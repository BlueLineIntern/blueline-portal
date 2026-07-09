/**
 * BlueLine Advisors Client Onboarding Portal — Cloudflare Worker API
 *
 * Requires a KV namespace binding called PORTAL_KV (see wrangler.toml).
 * KV layout:
 *   user:<email>          -> { name, email, salt, hash, iterations }
 *   session:<token>       -> email                         (TTL'd)
 *   responses:<email>     -> { modules: { risk, budget, retirement, networth, compensation } }
 *   onboarding:<id>       -> onboarding POC record (sample/test data only)
 *   onboarding_counter    -> sequence number for onboarding ids
 *
 * Endpoints:
 *   POST /api/register              { name, email, password }
 *   POST /api/login                 { email, password }
 *   POST /api/logout                (Authorization: Bearer <token>)
 *   GET  /api/assessments           (Authorization: Bearer <token>)
 *   POST /api/assessments/:module   { ...module fields }    (Authorization: Bearer <token>)
 *   POST /api/onboarding/start      -> { onboardingId }     (no auth — POC test data only)
 *   POST /api/onboarding/:id        { onboardingId, currentStep, completionTime, data }
 *   GET  /api/admin/clients         (Authorization: Bearer <ADMIN_TOKEN secret>)
 *   GET    /api/admin/onboarding      (Authorization: Bearer <ADMIN_TOKEN secret>)
 *   DELETE /api/admin/onboarding/:id  (Authorization: Bearer <ADMIN_TOKEN secret>)
 *
 * Set the admin secret with: wrangler secret put ADMIN_TOKEN
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const PBKDF2_ITERATIONS = 100000;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function getSessionEmail(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return env.PORTAL_KV.get(`session:${match[1]}`);
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

// ---------- Assessment modules ----------

function loadModules(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // Records from the pre-module schema have budget/riskAnswers at the top
    // level; they were test data and are intentionally not migrated.
    return parsed && typeof parsed.modules === 'object' ? parsed.modules : {};
  } catch {
    return {};
  }
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
};

async function handleGetAssessments(request, env, origin) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, origin);

  const raw = await env.PORTAL_KV.get(`responses:${email}`);
  return json({ modules: loadModules(raw) }, 200, origin);
}

async function handleSaveAssessment(request, env, origin, moduleName) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: 'Not authenticated' }, 401, origin);

  const validator = MODULE_VALIDATORS[moduleName];
  if (!validator) return json({ error: 'Unknown assessment module' }, 404, origin);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, origin);

  const result = validator(body);
  if (result.error) return json({ error: result.error }, 400, origin);

  const raw = await env.PORTAL_KV.get(`responses:${email}`);
  const modules = loadModules(raw);
  modules[moduleName] = { ...result.data, updatedAt: new Date().toISOString() };

  await env.PORTAL_KV.put(`responses:${email}`, JSON.stringify({ modules }));
  return json({ module: modules[moduleName], modules }, 200, origin);
}

// ---------- Onboarding proof of concept ----------
// Unauthenticated by design: the POC has no client accounts and holds
// sample/test data only. Records must be created via /start before saves
// are accepted, and payload size is capped.

const ONBOARDING_ID_PATTERN = /^BLA-ONB-\d{4}-\d{4}$/;
const ONBOARDING_MAX_BYTES = 100_000;

async function handleOnboardingStart(request, env, origin) {
  // KV has no atomic increment; a race here can skip or repeat a number.
  // Acceptable for a proof of concept.
  const n = (Number(await env.PORTAL_KV.get('onboarding_counter')) || 0) + 1;
  await env.PORTAL_KV.put('onboarding_counter', String(n));
  const onboardingId = `BLA-ONB-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
  const record = {
    onboardingId,
    startTime: new Date().toISOString(),
    completionTime: null,
    currentStep: 0,
    data: {},
    updatedAt: new Date().toISOString(),
  };
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record));
  return json({ onboardingId, startTime: record.startTime }, 201, origin);
}

async function handleOnboardingSave(request, env, origin, onboardingId) {
  if (!ONBOARDING_ID_PATTERN.test(onboardingId)) {
    return json({ error: 'Invalid onboarding id' }, 400, origin);
  }
  const existingRaw = await env.PORTAL_KV.get(`onboarding:${onboardingId}`);
  if (!existingRaw) {
    return json({ error: 'Unknown onboarding id — call /api/onboarding/start first' }, 404, origin);
  }

  const text = await request.text();
  if (text.length > ONBOARDING_MAX_BYTES) {
    return json({ error: 'Payload too large' }, 413, origin);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, origin);
  }
  if (!body || body.onboardingId !== onboardingId || !body.data || typeof body.data !== 'object') {
    return json({ error: 'Body must include a matching onboardingId and a data object' }, 400, origin);
  }

  const existing = JSON.parse(existingRaw);
  const record = {
    onboardingId,
    startTime: existing.startTime,
    completionTime: typeof body.completionTime === 'string' ? body.completionTime : existing.completionTime,
    currentStep: Number.isInteger(body.currentStep) ? body.currentStep : existing.currentStep,
    data: body.data,
    updatedAt: new Date().toISOString(),
  };
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record));
  return json({ ok: true, updatedAt: record.updatedAt }, 200, origin);
}

function isAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = match ? match[1] : '';
  return !!env.ADMIN_TOKEN && providedToken === env.ADMIN_TOKEN;
}

async function handleAdminDeleteOnboarding(request, env, origin, onboardingId) {
  if (!isAdmin(request, env)) {
    return json({ error: 'Not authorized' }, 401, origin);
  }
  if (!ONBOARDING_ID_PATTERN.test(onboardingId)) {
    return json({ error: 'Invalid onboarding id' }, 400, origin);
  }
  await env.PORTAL_KV.delete(`onboarding:${onboardingId}`);
  return json({ ok: true }, 200, origin);
}

async function handleAdminOnboarding(request, env, origin) {
  if (!isAdmin(request, env)) {
    return json({ error: 'Not authorized' }, 401, origin);
  }

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
  return json({ records }, 200, origin);
}

async function handleAdminClients(request, env, origin) {
  if (!isAdmin(request, env)) {
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
        modules: loadModules(responsesRaw),
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
      if (url.pathname === '/api/assessments' && request.method === 'GET') {
        return await handleGetAssessments(request, env, origin);
      }
      const saveMatch = url.pathname.match(/^\/api\/assessments\/([a-z]+)$/);
      if (saveMatch && request.method === 'POST') {
        return await handleSaveAssessment(request, env, origin, saveMatch[1]);
      }
      if (url.pathname === '/api/onboarding/start' && request.method === 'POST') {
        return await handleOnboardingStart(request, env, origin);
      }
      const onbMatch = url.pathname.match(/^\/api\/onboarding\/(BLA-ONB-\d{4}-\d{4})$/);
      if (onbMatch && request.method === 'POST') {
        return await handleOnboardingSave(request, env, origin, onbMatch[1]);
      }
      if (url.pathname === '/api/admin/clients' && request.method === 'GET') {
        return await handleAdminClients(request, env, origin);
      }
      if (url.pathname === '/api/admin/onboarding' && request.method === 'GET') {
        return await handleAdminOnboarding(request, env, origin);
      }
      const onbDeleteMatch = url.pathname.match(/^\/api\/admin\/onboarding\/(BLA-ONB-\d{4}-\d{4})$/);
      if (onbDeleteMatch && request.method === 'DELETE') {
        return await handleAdminDeleteOnboarding(request, env, origin, onbDeleteMatch[1]);
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
