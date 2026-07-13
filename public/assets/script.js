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

const VIEW_IDS = ["auth", "home", "dashboard", "risk", "budget", "retirement", "networth", "compensation"];

function showView(name) {
  VIEW_IDS.forEach((id) => document.getElementById(`view-${id}`).classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
  window.scrollTo(0, 0);
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
}

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

// ---------- Home hub ----------

function renderHome() {
  const session = getSession();
  document.getElementById("home-welcome").textContent = session ? `Welcome, ${session.name}` : "Welcome";

  const completed = MODULES.filter((mod) => currentModules[mod.key]).length;
  const statusEl = document.getElementById("home-fpa-status");
  statusEl.textContent =
    completed === 0
      ? "Not started"
      : completed === MODULES.length
        ? "All assessments complete ✓"
        : `${completed} of ${MODULES.length} assessments complete`;
  document.getElementById("home-fpa-fill").style.width = `${(completed / MODULES.length) * 100}%`;
  document.getElementById("home-open-fpa").textContent = completed === 0 ? "Start Analysis" : "Open Analysis";
}

// Land here after login: fetch assessment progress (which also validates the
// session), then show the hub with both offerings.
async function loadHome() {
  try {
    const data = await apiRequest("/api/assessments", { auth: true });
    currentModules = data.modules || {};
  } catch (err) {
    if (err.message.includes("authenticated")) {
      clearSession();
      updateNav();
      showView("auth");
      return;
    }
  }
  renderHome();
  showView("home");
}

document.getElementById("home-open-fpa").addEventListener("click", () => loadDashboard());
document.getElementById("dashboard-home-btn").addEventListener("click", () => loadHome());

// ---------- Financial Picture Analysis (assessment dashboard) ----------

let currentModules = {};

function renderDashboard() {
  const grid = document.getElementById("module-grid");
  const completed = MODULES.filter((mod) => currentModules[mod.key]).length;

  document.getElementById("progress-note").textContent = `${completed} of ${MODULES.length} complete.`;
  document.getElementById("progress-fill").style.width = `${(completed / MODULES.length) * 100}%`;

  grid.innerHTML = MODULES.map((mod, index) => {
    const data = currentModules[mod.key];
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
    // Results and charts are intentionally not shown to clients — the advisor
    // walks through them in person (printable from the admin detail view).
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
  }).join("");

  grid.querySelectorAll(".module-start-btn").forEach((btn) => {
    btn.addEventListener("click", () => openModuleForm(btn.dataset.module));
  });
}

async function loadDashboard() {
  showView("dashboard");
  try {
    const data = await apiRequest("/api/assessments", { auth: true });
    currentModules = data.modules || {};
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
    const data = await apiRequest(`/api/assessments/${key}`, { method: "POST", body: payload, auth: true });
    currentModules = data.modules || currentModules;
    showView("dashboard");
    renderDashboard();
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
