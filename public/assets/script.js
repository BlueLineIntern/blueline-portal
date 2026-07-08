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

const views = {
  auth: document.getElementById("view-auth"),
  dashboard: document.getElementById("view-dashboard"),
  questionnaire: document.getElementById("view-questionnaire"),
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.add("hidden"));
  views[name].classList.remove("hidden");
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

// ---------- Auth tabs ----------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById("login-form").classList.toggle("hidden", tab !== "login");
    document.getElementById("register-form").classList.toggle("hidden", tab !== "register");
  });
});

// ---------- Register ----------

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("register-error");
  errorEl.textContent = "";

  const name = document.getElementById("register-name").value.trim();
  const email = document.getElementById("register-email").value.trim();
  const password = document.getElementById("register-password").value;

  try {
    const data = await apiRequest("/api/register", {
      method: "POST",
      body: { name, email, password },
    });
    setSession({ token: data.token, name: data.name, email: data.email });
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------- Login ----------

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  try {
    const data = await apiRequest("/api/login", {
      method: "POST",
      body: { email, password },
    });
    setSession({ token: data.token, name: data.name, email: data.email });
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------- Logout ----------

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

// ---------- Dashboard ----------

let lastResponses = null;

const BUDGET_CATEGORIES = [
  "housing",
  "groceries",
  "transportation",
  "investments",
  "debt",
  "discretionary",
  "other",
];

function formatCurrency(amount) {
  return `$${Number(amount || 0).toLocaleString()}`;
}

function budgetTotal(budget) {
  return BUDGET_CATEGORIES.reduce((sum, key) => sum + (Number(budget[key]) || 0), 0);
}

function riskCategoryForScore(score) {
  if (score <= 9) return "Conservative";
  if (score <= 14) return "Moderately Conservative";
  if (score <= 19) return "Moderate";
  if (score <= 24) return "Moderately Aggressive";
  return "Aggressive";
}

function renderSummary(responses) {
  lastResponses = responses;
  document.getElementById("no-responses").classList.toggle("hidden", !!responses);
  document.getElementById("summary-card").classList.toggle("hidden", !responses);
  document.getElementById("edit-btn").classList.toggle("hidden", !responses);

  if (!responses) return;

  const experienceLabels = {
    beginner: "Beginner",
    intermediate: "Intermediate",
    advanced: "Advanced",
    expert: "Expert",
  };

  const budget = responses.budget || {};
  BUDGET_CATEGORIES.forEach((key) => {
    document.getElementById(`summary-budget-${key}`).textContent = formatCurrency(budget[key]);
  });
  document.getElementById("summary-budget-total").textContent = formatCurrency(budgetTotal(budget));

  document.getElementById("summary-experience").textContent = experienceLabels[responses.experienceLevel] || responses.experienceLevel || "—";
  document.getElementById("summary-risk").textContent =
    responses.riskScore != null ? `${responses.riskScore} / 25 — ${responses.riskCategory}` : "—";
  document.getElementById("summary-goal-short").textContent = responses.goalShortTerm || "—";
  document.getElementById("summary-goal-medium").textContent = responses.goalMediumTerm || "—";
  document.getElementById("summary-goal-long").textContent = responses.goalLongTerm || "—";
  document.getElementById("summary-updated").textContent = responses.updatedAt
    ? `Last updated: ${new Date(responses.updatedAt).toLocaleString()}`
    : "";
}

async function loadDashboard() {
  showView("dashboard");
  try {
    const data = await apiRequest("/api/questionnaire", { auth: true });
    renderSummary(data.responses);
  } catch (err) {
    if (err.message.includes("authenticated")) {
      clearSession();
      updateNav();
      showView("auth");
    }
  }
}

document.getElementById("start-questionnaire-btn").addEventListener("click", () => {
  showQuestionnaireForm(null);
});

document.getElementById("edit-btn").addEventListener("click", () => {
  showQuestionnaireForm(lastResponses);
});

document.getElementById("cancel-questionnaire-btn").addEventListener("click", () => {
  loadDashboard();
});

// ---------- Questionnaire ----------

function updateBudgetTotalDisplay() {
  const budget = {};
  BUDGET_CATEGORIES.forEach((key) => {
    budget[key] = Number(document.getElementById(`q-budget-${key}`).value) || 0;
  });
  document.getElementById("budget-total-value").textContent = formatCurrency(budgetTotal(budget));
}

BUDGET_CATEGORIES.forEach((key) => {
  document.getElementById(`q-budget-${key}`).addEventListener("input", updateBudgetTotalDisplay);
});

function updateRiskScoreDisplay() {
  const display = document.getElementById("risk-score-display");
  let score = 0;
  let answered = 0;
  for (let i = 1; i <= 5; i++) {
    const checked = document.querySelector(`input[name="q-risk-${i}"]:checked`);
    if (checked) {
      score += Number(checked.value);
      answered++;
    }
  }
  if (answered === 0) {
    display.textContent = "";
  } else if (answered < 5) {
    display.textContent = `${answered} of 5 questions answered`;
  } else {
    display.textContent = `Risk Score: ${score} / 25 — ${riskCategoryForScore(score)}`;
  }
}

document.querySelectorAll('.risk-question input[type="radio"]').forEach((input) => {
  input.addEventListener("change", updateRiskScoreDisplay);
});

function showQuestionnaireForm(existing) {
  const cancelBtn = document.getElementById("cancel-questionnaire-btn");
  cancelBtn.classList.toggle("hidden", !existing);
  document.getElementById("questionnaire-form").reset();

  if (existing) {
    const budget = existing.budget || {};
    BUDGET_CATEGORIES.forEach((key) => {
      document.getElementById(`q-budget-${key}`).value = budget[key] || 0;
    });
    if (existing.experienceLevel) {
      document.getElementById("q-experience").value = existing.experienceLevel;
    }
    if (existing.riskAnswers) {
      Object.entries(existing.riskAnswers).forEach(([question, value]) => {
        const input = document.querySelector(`input[name="q-risk-${question}"][value="${value}"]`);
        if (input) input.checked = true;
      });
    }
    document.getElementById("q-goal-short").value = existing.goalShortTerm || "";
    document.getElementById("q-goal-medium").value = existing.goalMediumTerm || "";
    document.getElementById("q-goal-long").value = existing.goalLongTerm || "";
  }

  updateBudgetTotalDisplay();
  updateRiskScoreDisplay();
  document.getElementById("questionnaire-error").textContent = "";
  showView("questionnaire");
}

document.getElementById("questionnaire-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("questionnaire-error");
  errorEl.textContent = "";

  const budget = {};
  BUDGET_CATEGORIES.forEach((key) => {
    budget[key] = Number(document.getElementById(`q-budget-${key}`).value) || 0;
  });

  const riskAnswers = {};
  for (let i = 1; i <= 5; i++) {
    const checked = document.querySelector(`input[name="q-risk-${i}"]:checked`);
    if (checked) riskAnswers[i] = Number(checked.value);
  }

  if (Object.keys(riskAnswers).length < 5) {
    errorEl.textContent = "Please answer all 5 risk tolerance questions.";
    return;
  }

  const payload = {
    budget,
    experienceLevel: document.getElementById("q-experience").value,
    riskAnswers,
    goalShortTerm: document.getElementById("q-goal-short").value.trim(),
    goalMediumTerm: document.getElementById("q-goal-medium").value.trim(),
    goalLongTerm: document.getElementById("q-goal-long").value.trim(),
  };

  try {
    await apiRequest("/api/questionnaire", { method: "POST", body: payload, auth: true });
    await loadDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------- Boot ----------

async function enterApp() {
  updateNav();
  await loadDashboard();
}

(function init() {
  updateNav();
  const session = getSession();
  if (session) {
    enterApp();
  } else {
    showView("auth");
  }
})();
