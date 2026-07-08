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

function renderSummary(responses) {
  lastResponses = responses;
  document.getElementById("no-responses").classList.toggle("hidden", !!responses);
  document.getElementById("summary-card").classList.toggle("hidden", !responses);
  document.getElementById("edit-btn").classList.toggle("hidden", !responses);

  if (!responses) return;

  const budgetLabels = {
    "under-500": "Under $500",
    "500-1500": "$500 – $1,500",
    "1500-5000": "$1,500 – $5,000",
    "5000-15000": "$5,000 – $15,000",
    "15000-plus": "$15,000+",
  };
  const experienceLabels = {
    beginner: "Beginner",
    intermediate: "Intermediate",
    advanced: "Advanced",
    expert: "Expert",
  };

  document.getElementById("summary-budget").textContent = budgetLabels[responses.budgetRange] || responses.budgetRange;
  document.getElementById("summary-experience").textContent = experienceLabels[responses.experienceLevel] || responses.experienceLevel;
  document.getElementById("summary-risk").textContent = `${responses.riskTolerance} / 10`;
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

const riskInput = document.getElementById("q-risk");
const riskValue = document.getElementById("q-risk-value");
riskInput.addEventListener("input", () => {
  riskValue.textContent = riskInput.value;
});

function showQuestionnaireForm(existing) {
  const cancelBtn = document.getElementById("cancel-questionnaire-btn");
  cancelBtn.classList.toggle("hidden", !existing);

  if (existing) {
    document.getElementById("q-budget").value = existing.budgetRange;
    document.getElementById("q-experience").value = existing.experienceLevel;
    riskInput.value = existing.riskTolerance;
    riskValue.textContent = existing.riskTolerance;
    document.getElementById("q-goal-short").value = existing.goalShortTerm || "";
    document.getElementById("q-goal-medium").value = existing.goalMediumTerm || "";
    document.getElementById("q-goal-long").value = existing.goalLongTerm || "";
  } else {
    document.getElementById("questionnaire-form").reset();
    riskInput.value = 5;
    riskValue.textContent = "5";
  }

  document.getElementById("questionnaire-error").textContent = "";
  showView("questionnaire");
}

document.getElementById("questionnaire-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("questionnaire-error");
  errorEl.textContent = "";

  const payload = {
    budgetRange: document.getElementById("q-budget").value,
    experienceLevel: document.getElementById("q-experience").value,
    riskTolerance: Number(riskInput.value),
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
