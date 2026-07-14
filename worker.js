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
 *   responses:<email>          -> { modules: {...} }
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
 *   GET    /api/admin/clients               (Authorization: Bearer <ADMIN_TOKEN>)
 *   GET    /api/admin/onboarding            (Authorization: Bearer <ADMIN_TOKEN>)
 *   DELETE /api/admin/onboarding/:id        (Authorization: Bearer <ADMIN_TOKEN>) — soft delete
 *   POST   /api/admin/onboarding/:id/restore (Authorization: Bearer <ADMIN_TOKEN>)
 *
 * Set the admin secret with: wrangler secret put ADMIN_TOKEN
 * Optionally restrict browser origins with: wrangler secret put ALLOWED_ORIGIN
 *   (comma-separated list; defaults to the Worker's own origin only)
 *
 * NOTE: This remains a proof-of-concept-grade system. It is NOT hardened for
 * real client PII: there is still no per-admin identity/audit log, no
 * application-level encryption, and the onboarding flow is unauthenticated
 * beyond a per-session write token. See STATUS.md "Known gaps".
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const PBKDF2_ITERATIONS = 100000;
const ONBOARDING_TTL_SECONDS = 60 * 60 * 24 * 30; // secrets + soft-deleted records expire after 30 days

// Fixed-window rate limits: [max requests, window in seconds].
const RATE_LIMITS = {
  login: [10, 300], // 10 attempts / 5 min per IP
  register: [5, 3600], // 5 new accounts / hour per IP
  onboardingStart: [20, 3600], // 20 new onboardings / hour per IP
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
  return json({ modules: loadModules(raw) }, 200, cors);
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
  const modules = loadModules(raw);
  modules[moduleName] = { ...result.data, updatedAt: new Date().toISOString() };

  await env.PORTAL_KV.put(`responses:${email}`, JSON.stringify({ modules }));
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
  if (!isAdmin(request, env)) return json({ error: 'Not authorized' }, 401, cors);

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
  return json({ ok: true, updatedAt: record.updatedAt }, 200, cors);
}

function isAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = match ? match[1] : '';
  return !!env.ADMIN_TOKEN && timingSafeEqual(providedToken, env.ADMIN_TOKEN);
}

// Soft delete: mark the record and give it (and its write secret) a 30-day TTL
// so it can be restored within that window, then auto-purges. No hard delete
// from the admin UI, so a misclick isn't instantly destructive.
async function handleAdminDeleteOnboarding(request, env, cors, onboardingId) {
  if (!isAdmin(request, env)) return json({ error: 'Not authorized' }, 401, cors);
  if (!ONBOARDING_ID_PATTERN.test(onboardingId)) return json({ error: 'Invalid onboarding id' }, 400, cors);

  const raw = await env.PORTAL_KV.get(`onboarding:${onboardingId}`);
  if (!raw) return json({ error: 'Not found' }, 404, cors);
  const record = JSON.parse(raw);
  record.deleted = true;
  record.deletedAt = new Date().toISOString();
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record), {
    expirationTtl: ONBOARDING_TTL_SECONDS,
  });
  return json({ ok: true, deletedAt: record.deletedAt }, 200, cors);
}

async function handleAdminRestoreOnboarding(request, env, cors, onboardingId) {
  if (!isAdmin(request, env)) return json({ error: 'Not authorized' }, 401, cors);
  if (!ONBOARDING_ID_PATTERN.test(onboardingId)) return json({ error: 'Invalid onboarding id' }, 400, cors);

  const raw = await env.PORTAL_KV.get(`onboarding:${onboardingId}`);
  if (!raw) return json({ error: 'Not found or already purged' }, 404, cors);
  const record = JSON.parse(raw);
  record.deleted = false;
  delete record.deletedAt;
  // Re-put with no TTL so it stops counting down toward purge.
  await env.PORTAL_KV.put(`onboarding:${onboardingId}`, JSON.stringify(record));
  return json({ ok: true }, 200, cors);
}

async function handleAdminOnboarding(request, env, cors) {
  if (!isAdmin(request, env)) return json({ error: 'Not authorized' }, 401, cors);

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

async function handleAdminClients(request, env, cors) {
  if (!isAdmin(request, env)) return json({ error: 'Not authorized' }, 401, cors);

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
      clients.push({
        name: user.name,
        email: user.email,
        modules: loadModules(responsesRaw),
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
      return json({ error: 'Internal server error' }, 500, cors);
    }
  },
};
