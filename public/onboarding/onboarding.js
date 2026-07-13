// BlueLine Advisors onboarding — PROOF OF CONCEPT.
// Simulates the onboarding workflow with sample data only. All state lives in
// localStorage; nothing is sent to a server and no real client is onboarded.

const STORAGE_KEY = "bla_onboarding_poc";
const COUNTER_KEY = "bla_onboarding_poc_counter";

const STEPS = [
  "welcome", "consent", "regdocs", "agreement", "profile", "discovery",
  "snapshot", "risk", "uploads", "portal", "meetingprep", "confirm",
];

const STEP_TITLES = {
  welcome: "Welcome",
  consent: "Electronic Consent",
  regdocs: "Regulatory Documents",
  agreement: "Advisory Agreement Placeholder",
  profile: "Client Profile",
  discovery: "Planning Discovery",
  snapshot: "Financial Snapshot",
  risk: "Risk Assessment",
  uploads: "Document Upload Placeholder",
  portal: "Portal Setup",
  meetingprep: "First Meeting Prep",
  confirm: "Confirmation / Export",
};

// ---------- State ----------

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { onboardingId: null, startTime: null, completionTime: null, currentStep: 0, data: {} };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// IDs are issued by the server so they're unique across browsers. The server
// also issues a per-session write token that must accompany every save, so a
// guessed id can't be used to overwrite someone else's record. If the server
// is unreachable, fall back to a local id (marked so admin data isn't expected
// for it).
async function requestOnboardingId() {
  try {
    const res = await fetch("/api/onboarding/start", { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      if (data.onboardingId) return { id: data.onboardingId, writeToken: data.writeToken, local: false };
    }
  } catch {}
  const n = (Number(localStorage.getItem(COUNTER_KEY)) || 0) + 1;
  localStorage.setItem(COUNTER_KEY, String(n));
  return { id: `BLA-ONB-${new Date().getFullYear()}-L${String(n).padStart(3, "0")}`, writeToken: null, local: true };
}

// Push the current state to the server so the BlueLine team can review
// submissions in the admin view. Fire-and-forget: a failed sync never blocks
// the user, and the full record is re-sent on every step. The write token
// proves this browser owns the session.
function syncToServer() {
  if (!state.onboardingId || state.localOnly || !state.writeToken) return;
  fetch(`/api/onboarding/${encodeURIComponent(state.onboardingId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Onboarding-Token": state.writeToken,
    },
    body: JSON.stringify({
      onboardingId: state.onboardingId,
      currentStep: state.currentStep,
      completionTime: state.completionTime,
      data: state.data,
    }),
  }).catch(() => {});
}

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// ---------- Static definitions ----------

const REGDOCS = [
  { key: "crs", name: "Form CRS", version: "v2026.07" },
  { key: "adv2a", name: "ADV Part 2A", version: "v2026.07" },
  { key: "adv2b", name: "ADV Part 2B", version: "v2026.07" },
  { key: "privacy", name: "Privacy Notice", version: "v2026.07" },
];

const FAKE_DOC_TEXT =
  "SAMPLE DOCUMENT — FOR PROOF OF CONCEPT ONLY. This placeholder stands in for the " +
  "actual firm document, which will be attached in a later phase. It contains no real " +
  "disclosures, terms, or firm information. Acknowledging receipt here only records " +
  "that the workflow step was completed in the test environment.";

const PROFILE_FIELDS = [
  ["firstName", "First name", "text", true],
  ["lastName", "Last name", "text", true],
  ["preferredName", "Preferred name", "text", false],
  ["email", "Email", "email", true],
  ["phone", "Phone", "tel", true],
  ["street", "Street address", "text", true],
  ["city", "City", "text", true],
  ["state", "State", "text", true],
  ["zip", "ZIP", "text", true],
  ["dob", "Date of birth (fake data only)", "date", true],
  ["maritalStatus", "Marital status", "select", true, ["Single", "Married", "Partnered", "Divorced", "Widowed", "Prefer not to say"]],
  ["spouseName", "Spouse/partner name", "text", false],
  ["employer", "Employer", "text", false],
  ["occupation", "Occupation", "text", false],
  ["trustedContactName", "Trusted contact name", "text", false],
  ["trustedContactPhone", "Trusted contact phone", "tel", false],
  ["cpaName", "CPA name", "text", false],
  ["attorneyName", "Attorney name", "text", false],
  ["preferredCommunication", "Preferred communication method", "select", true, ["Email", "Phone", "Text", "Video call"]],
];

const RANGE_UNDER_5M = ["None", "Under $50K", "$50K–$250K", "$250K–$1M", "$1M–$5M", "Over $5M"];
const SNAPSHOT_FIELDS = {
  assets: [
    ["cashRange", "Cash range", RANGE_UNDER_5M],
    ["investmentRange", "Investment account range", RANGE_UNDER_5M],
    ["retirementRange", "Retirement account range", RANGE_UNDER_5M],
    ["realEstateRange", "Real estate value range", RANGE_UNDER_5M],
    ["businessRange", "Business value range", RANGE_UNDER_5M],
  ],
  liabilities: [
    ["mortgageRange", "Mortgage range", ["None", "Under $100K", "$100K–$300K", "$300K–$750K", "Over $750K"]],
    ["otherDebtRange", "Other debt range", ["None", "Under $25K", "$25K–$100K", "$100K–$250K", "Over $250K"]],
  ],
  income: [
    ["incomeRange", "Annual income range", ["Under $100K", "$100K–$250K", "$250K–$500K", "$500K–$1M", "Over $1M"]],
    ["spendingRange", "Annual spending range", ["Under $75K", "$75K–$150K", "$150K–$300K", "$300K–$600K", "Over $600K"]],
  ],
};

const RISK_QUESTIONS = [
  {
    q: "How would you describe your investment experience?",
    opts: ["None", "Limited (savings, CDs)", "Some (funds, stocks)", "Experienced (stocks, bonds, ETFs)", "Extensive (options, alternatives)"],
  },
  {
    q: "What is your primary investment time horizon?",
    opts: ["Less than 2 years", "2–4 years", "5–7 years", "8–15 years", "More than 15 years"],
  },
  {
    q: "If your portfolio dropped 20% in six months, what would you do?",
    opts: ["Sell everything", "Sell some", "Hold and wait", "Hold, maybe buy more", "Buy more — it's an opportunity"],
  },
  {
    q: "How much of your portfolio might you need to withdraw in the next 3 years?",
    opts: ["More than 50%", "25–50%", "10–25%", "Less than 10%", "None"],
  },
  {
    q: "How stable is your household income?",
    opts: ["Very unstable", "Somewhat unstable", "Average", "Stable", "Very stable"],
  },
  {
    q: "How comfortable are you with large swings in portfolio value year to year?",
    opts: ["Very uncomfortable", "Uncomfortable", "Neutral", "Comfortable", "Very comfortable"],
  },
  {
    q: "What is your primary investment objective?",
    opts: ["Preserve capital", "Steady income", "Balanced growth and safety", "Long-term growth", "Maximum growth"],
  },
  {
    q: "Which statement best matches how you think about losses vs. gains?",
    opts: [
      "Avoiding losses matters far more than gains",
      "Avoiding losses matters somewhat more",
      "Losses and gains matter equally",
      "Growth matters somewhat more than avoiding losses",
      "Growth matters far more than short-term losses",
    ],
  },
  {
    q: "How dependent will you be on this portfolio for living expenses?",
    opts: ["Entirely dependent", "Mostly dependent", "Partially dependent", "Slightly dependent", "Not dependent"],
  },
  {
    q: "If a single investment fell 30% but the outlook was unchanged, you would:",
    opts: ["Sell immediately", "Sell part of it", "Do nothing", "Review and probably hold", "Buy more at the lower price"],
  },
];

function riskProfileForScore(score) {
  if (score <= 20) return "Conservative";
  if (score <= 40) return "Moderate Conservative";
  if (score <= 60) return "Moderate";
  if (score <= 80) return "Moderate Growth";
  return "Growth";
}

const UPLOAD_ITEMS = {
  required: [
    ["driversLicense", "Driver's license"],
    ["investmentStatements", "Investment statements"],
    ["taxReturn", "Tax return"],
  ],
  optional: [
    ["estateDocs", "Estate documents"],
    ["trustDocs", "Trust documents"],
    ["insurancePolicies", "Insurance policies"],
    ["businessDocs", "Business documents"],
  ],
};

// ---------- Build dynamic form sections ----------

document.getElementById("regdoc-cards").innerHTML = REGDOCS.map(
  (d) => `
  <div class="regdoc-card">
    <div class="regdoc-info">
      <div class="regdoc-name">${d.name}</div>
      <div class="regdoc-version">${d.version} (sample)</div>
    </div>
    <button type="button" class="btn btn-ghost view-doc-btn" data-doc="${d.key}">View Document</button>
    <label class="check-option regdoc-ack">
      <input type="checkbox" id="regdoc-${d.key}" /> I acknowledge receipt
    </label>
  </div>`
).join("");

document.getElementById("profile-grid").innerHTML = PROFILE_FIELDS.map(([key, label, type, required, options]) => {
  const req = required ? ' <span class="req">*</span>' : "";
  if (type === "select") {
    return `<div class="field"><label for="pf-${key}">${label}${req}</label>
      <select id="pf-${key}"><option value="">Select one</option>${options.map((o) => `<option>${o}</option>`).join("")}</select></div>`;
  }
  return `<div class="field"><label for="pf-${key}">${label}${req}</label>
    <input type="${type}" id="pf-${key}" /></div>`;
}).join("");

function buildRangeSelects(containerId, fields) {
  document.getElementById(containerId).innerHTML = fields
    .map(
      ([key, label, options]) => `
      <div class="field"><label for="ss-${key}">${label} <span class="req">*</span></label>
        <select id="ss-${key}"><option value="">Select a range</option>${options.map((o) => `<option>${o}</option>`).join("")}</select></div>`
    )
    .join("");
}
buildRangeSelects("snapshot-assets", SNAPSHOT_FIELDS.assets);
buildRangeSelects("snapshot-liabilities", SNAPSHOT_FIELDS.liabilities);
buildRangeSelects("snapshot-income", SNAPSHOT_FIELDS.income);

document.getElementById("risk-questions").innerHTML = RISK_QUESTIONS.map(
  (rq, i) => `
  <fieldset class="risk-question">
    <legend>${i + 1}. ${rq.q}</legend>
    ${rq.opts
      .map((opt, j) => `<label class="radio-option"><input type="radio" name="rq-${i}" value="${j + 1}" /> ${opt}</label>`)
      .join("")}
  </fieldset>`
).join("");

function buildUploadList(containerId, items) {
  document.getElementById(containerId).innerHTML = items
    .map(
      ([key, label]) => `
      <div class="upload-item">
        <span class="upload-name">${label}</span>
        <label class="upload-later"><input type="checkbox" id="up-${key}" /> Will provide later</label>
      </div>`
    )
    .join("");
}
buildUploadList("uploads-required", UPLOAD_ITEMS.required);
buildUploadList("uploads-optional", UPLOAD_ITEMS.optional);

// ---------- Fake document modal ----------

document.querySelectorAll(".view-doc-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const doc = REGDOCS.find((d) => d.key === btn.dataset.doc);
    document.getElementById("doc-modal-title").textContent = doc.name;
    document.getElementById("doc-modal-version").textContent = `${doc.version} — sample document`;
    document.getElementById("doc-modal-body").textContent = FAKE_DOC_TEXT;
    document.getElementById("doc-modal").classList.remove("hidden");
  });
});
document.getElementById("doc-modal-close").addEventListener("click", () => {
  document.getElementById("doc-modal").classList.add("hidden");
});

// ---------- Signature pad ----------
// Drawable canvas for the advisory-agreement step. Captures mouse, trackpad,
// touch, and pen input via Pointer Events, and exports the drawing as a PNG
// data URL stored on the agreement record. Sample data only — not a legally
// binding signature.

let signatureHasInk = false;
let signaturePadReady = false;

function markSigned(hasInk) {
  signatureHasInk = hasInk;
  const wrap = document.querySelector(".signature-wrap");
  if (wrap) wrap.classList.toggle("signed", hasInk);
}

function initSignaturePad() {
  const canvas = document.getElementById("signature-pad");
  if (!canvas || signaturePadReady) return;
  signaturePadReady = true;

  const ctx = canvas.getContext("2d");
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#1c2530";

  let drawing = false;

  // Canvas is a fixed 600x180 internal bitmap shown at a responsive CSS width;
  // scale pointer coordinates from displayed size to bitmap size.
  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!signatureHasInk) markSigned(true);
    e.preventDefault();
  });
  const stop = (e) => {
    if (!drawing) return;
    drawing = false;
    e.preventDefault();
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", stop);

  document.getElementById("signature-clear").addEventListener("click", () => {
    clearSignature();
    if (state.data.agreement) {
      delete state.data.agreement.signatureDataUrl;
      delete state.data.agreement.signedAt;
      saveState();
    }
  });
}

function clearSignature() {
  const canvas = document.getElementById("signature-pad");
  if (!canvas) return;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  markSigned(false);
}

function restoreSignature(dataUrl) {
  const canvas = document.getElementById("signature-pad");
  if (!canvas || !dataUrl) return;
  const ctx = canvas.getContext("2d");
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    markSigned(true);
  };
  img.src = dataUrl;
}

// ---------- Navigation ----------

function showStep(index) {
  state.currentStep = index;
  saveState();

  STEPS.forEach((s, i) => {
    document.getElementById(`step-${s}`).classList.toggle("hidden", i !== index);
  });

  const stepKey = STEPS[index];
  document.getElementById("progress-label").textContent = `Step ${index + 1} of ${STEPS.length}: ${STEP_TITLES[stepKey]}`;
  document.getElementById("progress-id").textContent = state.onboardingId || "";
  document.getElementById("progress-fill").style.width = `${(index / (STEPS.length - 1)) * 100}%`;

  // Nav bar hidden on welcome (has its own Start button) and confirm (end of flow)
  const navBar = document.getElementById("nav-bar");
  navBar.classList.toggle("hidden", stepKey === "welcome" || stepKey === "confirm");
  document.getElementById("prev-btn").disabled = index <= 1;

  const populate = POPULATORS[stepKey];
  if (populate) populate();
  if (stepKey === "confirm") renderConfirmation();
  window.scrollTo(0, 0);
}

document.getElementById("start-btn").addEventListener("click", async () => {
  if (!state.onboardingId) {
    const btn = document.getElementById("start-btn");
    btn.disabled = true;
    const issued = await requestOnboardingId();
    btn.disabled = false;
    state.onboardingId = issued.id;
    state.writeToken = issued.writeToken;
    state.localOnly = issued.local;
    state.startTime = nowIso();
    saveState();
  }
  showStep(1);
});

document.getElementById("prev-btn").addEventListener("click", () => {
  if (state.currentStep > 1) showStep(state.currentStep - 1);
});

document.getElementById("next-btn").addEventListener("click", () => {
  const stepKey = STEPS[state.currentStep];
  const collect = COLLECTORS[stepKey];
  if (collect && !collect()) return; // validation failed
  saveState();
  syncToServer();
  if (state.currentStep < STEPS.length - 1) showStep(state.currentStep + 1);
});

document.getElementById("restart-btn").addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  state = loadState();
  document.querySelectorAll("input, textarea").forEach((el) => {
    if (el.type === "checkbox" || el.type === "radio") el.checked = false;
    else el.value = "";
  });
  document.querySelectorAll("select").forEach((el) => (el.value = ""));
  document.getElementById("risk-result").classList.add("hidden");
  clearSignature();
  showStep(0);
});

// ---------- Collectors (validate + store) and populators (restore) ----------

function setError(id, msg) {
  document.getElementById(id).textContent = msg || "";
  return !msg;
}

const COLLECTORS = {
  consent() {
    const name = document.getElementById("consent-name").value.trim();
    const email = document.getElementById("consent-email").value.trim();
    const ack = document.getElementById("consent-ack").checked;
    if (!name || !email) return setError("consent-error", "Name and email are required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError("consent-error", "Please enter a valid email address.");
    if (!ack) return setError("consent-error", "You must acknowledge and consent to continue.");
    state.data.consent = { onboardingId: state.onboardingId, name, email, consented: true, timestamp: nowIso() };
    return setError("consent-error", "");
  },

  regdocs() {
    const existing = (state.data.regdocs && state.data.regdocs.documents) || {};
    const documents = {};
    for (const d of REGDOCS) {
      if (!document.getElementById(`regdoc-${d.key}`).checked) {
        return setError("regdocs-error", "You must acknowledge receipt of all four documents to continue.");
      }
      documents[d.key] = {
        name: d.name,
        version: d.version,
        acknowledgedAt: (existing[d.key] && existing[d.key].acknowledgedAt) || nowIso(),
      };
    }
    state.data.regdocs = { onboardingId: state.onboardingId, documents };
    return setError("regdocs-error", "");
  },

  agreement() {
    const canvas = document.getElementById("signature-pad");
    if (!signatureHasInk) {
      return setError("agreement-error", "Please sign in the box above using your mouse, trackpad, or finger.");
    }
    if (!document.getElementById("agreement-ack").checked) {
      return setError("agreement-error", "Please confirm you understand this is a proof of concept.");
    }
    const existing = state.data.agreement || {};
    state.data.agreement = {
      onboardingId: state.onboardingId,
      placeholderAcknowledged: true,
      typedName: document.getElementById("agreement-typed-name").value.trim(),
      signatureDataUrl: canvas.toDataURL("image/png"),
      signedAt: existing.signedAt || nowIso(),
      timestamp: nowIso(),
    };
    return setError("agreement-error", "");
  },

  profile() {
    const profile = {};
    for (const [key, label, , required] of PROFILE_FIELDS) {
      const value = document.getElementById(`pf-${key}`).value.trim();
      if (required && !value) return setError("profile-error", `${label} is required.`);
      profile[key] = value;
    }
    if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
      return setError("profile-error", "Please enter a valid email address.");
    }
    state.data.profile = profile;
    return setError("profile-error", "");
  },

  discovery() {
    const val = (id) => document.getElementById(id).value.trim();
    if (!val("disc-prompt") || !val("disc-priorities")) {
      return setError("discovery-error", "The first two questions are required.");
    }
    state.data.discovery = {
      prompt: val("disc-prompt"),
      priorities: val("disc-priorities"),
      worries: val("disc-worries"),
      success: val("disc-success"),
      lifeEvents: val("disc-life-events"),
      lifeEventsDetail: val("disc-life-events-detail"),
      tax: val("disc-tax"),
      taxDetail: val("disc-tax-detail"),
      estate: val("disc-estate"),
      estateDetail: val("disc-estate-detail"),
      business: val("disc-business"),
      businessDetail: val("disc-business-detail"),
    };
    return setError("discovery-error", "");
  },

  snapshot() {
    const snapshot = {};
    const all = [...SNAPSHOT_FIELDS.assets, ...SNAPSHOT_FIELDS.liabilities, ...SNAPSHOT_FIELDS.income];
    for (const [key, label] of all) {
      const value = document.getElementById(`ss-${key}`).value;
      if (!value) return setError("snapshot-error", `Please select a range for: ${label}.`);
      snapshot[key] = value;
    }
    state.data.snapshot = snapshot;
    return setError("snapshot-error", "");
  },

  risk() {
    const answers = [];
    for (let i = 0; i < RISK_QUESTIONS.length; i++) {
      const checked = document.querySelector(`input[name="rq-${i}"]:checked`);
      if (!checked) return setError("risk-error", `Please answer question ${i + 1}.`);
      answers.push(Number(checked.value));
    }
    const sum = answers.reduce((a, b) => a + b, 0); // 10–50
    const score = Math.round(((sum - 10) / 40) * 99) + 1; // 1–100
    state.data.risk = { answers, score, profile: riskProfileForScore(score), timestamp: nowIso() };
    return setError("risk-error", "");
  },

  uploads() {
    const willProvide = {};
    for (const [key, label] of [...UPLOAD_ITEMS.required, ...UPLOAD_ITEMS.optional]) {
      willProvide[key] = { label, willProvideLater: document.getElementById(`up-${key}`).checked };
    }
    state.data.uploads = willProvide;
    return setError("uploads-error", "");
  },

  portal() {
    const format = document.getElementById("portal-format").value;
    const time = document.getElementById("portal-time").value;
    const phone = document.getElementById("portal-phone").value.trim();
    const email = document.getElementById("portal-email").value.trim();
    if (!format || !time || !phone || !email) {
      return setError("portal-error", "All four fields are required.");
    }
    state.data.portal = { meetingFormat: format, meetingTime: time, bestPhone: phone, bestEmail: email };
    return setError("portal-error", "");
  },

  meetingprep() {
    const val = (id) => document.getElementById(id).value.trim();
    if (!val("prep-accomplish")) {
      return setError("meetingprep-error", "Please tell us what you'd like to accomplish in the first meeting.");
    }
    state.data.meetingprep = {
      accomplish: val("prep-accomplish"),
      questions: val("prep-questions"),
      review: val("prep-review"),
      attendees: val("prep-attendees"),
    };
    if (!state.completionTime) {
      state.completionTime = nowIso();
    }
    return setError("meetingprep-error", "");
  },
};

const POPULATORS = {
  consent() {
    const d = state.data.consent;
    if (!d) return;
    document.getElementById("consent-name").value = d.name || "";
    document.getElementById("consent-email").value = d.email || "";
    document.getElementById("consent-ack").checked = !!d.consented;
  },
  regdocs() {
    const d = state.data.regdocs;
    REGDOCS.forEach((doc) => {
      document.getElementById(`regdoc-${doc.key}`).checked = !!(d && d.documents && d.documents[doc.key]);
    });
  },
  agreement() {
    initSignaturePad();
    const a = state.data.agreement;
    document.getElementById("agreement-ack").checked = !!(a && a.placeholderAcknowledged);
    document.getElementById("agreement-typed-name").value = (a && a.typedName) || "";
    if (a && a.signatureDataUrl) restoreSignature(a.signatureDataUrl);
    else clearSignature();
  },
  profile() {
    const d = state.data.profile;
    if (!d) return;
    PROFILE_FIELDS.forEach(([key]) => {
      document.getElementById(`pf-${key}`).value = d[key] || "";
    });
  },
  discovery() {
    const d = state.data.discovery;
    if (!d) return;
    const set = (id, v) => (document.getElementById(id).value = v || "");
    set("disc-prompt", d.prompt); set("disc-priorities", d.priorities);
    set("disc-worries", d.worries); set("disc-success", d.success);
    set("disc-life-events", d.lifeEvents); set("disc-life-events-detail", d.lifeEventsDetail);
    set("disc-tax", d.tax); set("disc-tax-detail", d.taxDetail);
    set("disc-estate", d.estate); set("disc-estate-detail", d.estateDetail);
    set("disc-business", d.business); set("disc-business-detail", d.businessDetail);
  },
  snapshot() {
    const d = state.data.snapshot;
    if (!d) return;
    [...SNAPSHOT_FIELDS.assets, ...SNAPSHOT_FIELDS.liabilities, ...SNAPSHOT_FIELDS.income].forEach(([key]) => {
      document.getElementById(`ss-${key}`).value = d[key] || "";
    });
  },
  risk() {
    const d = state.data.risk;
    if (d && d.answers) {
      d.answers.forEach((v, i) => {
        const input = document.querySelector(`input[name="rq-${i}"][value="${v}"]`);
        if (input) input.checked = true;
      });
    }
    updateRiskResultDisplay();
  },
  uploads() {
    const d = state.data.uploads;
    if (!d) return;
    Object.entries(d).forEach(([key, info]) => {
      const el = document.getElementById(`up-${key}`);
      if (el) el.checked = !!info.willProvideLater;
    });
  },
  portal() {
    const d = state.data.portal;
    if (!d) return;
    document.getElementById("portal-format").value = d.meetingFormat || "";
    document.getElementById("portal-time").value = d.meetingTime || "";
    document.getElementById("portal-phone").value = d.bestPhone || "";
    document.getElementById("portal-email").value = d.bestEmail || "";
  },
  meetingprep() {
    const d = state.data.meetingprep;
    if (!d) return;
    document.getElementById("prep-accomplish").value = d.accomplish || "";
    document.getElementById("prep-questions").value = d.questions || "";
    document.getElementById("prep-review").value = d.review || "";
    document.getElementById("prep-attendees").value = d.attendees || "";
  },
};

// Live risk score display once all 10 are answered
function updateRiskResultDisplay() {
  let sum = 0, answered = 0;
  for (let i = 0; i < RISK_QUESTIONS.length; i++) {
    const checked = document.querySelector(`input[name="rq-${i}"]:checked`);
    if (checked) { sum += Number(checked.value); answered++; }
  }
  const box = document.getElementById("risk-result");
  if (answered === RISK_QUESTIONS.length) {
    const score = Math.round(((sum - 10) / 40) * 99) + 1;
    document.getElementById("risk-score-value").textContent = score;
    document.getElementById("risk-profile-value").textContent = riskProfileForScore(score);
    box.classList.remove("hidden");
  } else {
    box.classList.add("hidden");
  }
}
document.querySelectorAll('#risk-questions input[type="radio"]').forEach((input) => {
  input.addEventListener("change", updateRiskResultDisplay);
});

// ---------- Confirmation & exports ----------

function completedSections() {
  const map = {
    consent: "Electronic Consent", regdocs: "Regulatory Documents", agreement: "Advisory Agreement Placeholder",
    profile: "Client Profile", discovery: "Planning Discovery", snapshot: "Financial Snapshot",
    risk: "Risk Assessment", uploads: "Document Upload Placeholder", portal: "Portal Setup",
    meetingprep: "First Meeting Prep",
  };
  return Object.keys(map).filter((k) => state.data[k]).map((k) => map[k]);
}

function missingItems() {
  const items = [];
  const uploads = state.data.uploads || {};
  for (const [key, label] of [...UPLOAD_ITEMS.required, ...UPLOAD_ITEMS.optional]) {
    const required = UPLOAD_ITEMS.required.some(([k]) => k === key);
    const info = uploads[key];
    if (info && info.willProvideLater) items.push(`${label} — client will provide later`);
    else if (required) items.push(`${label} — not yet confirmed`);
  }
  items.push("Advisory agreement e-signature (DocuSign, future phase)");
  items.push("Portal invitations (eMoney, secure messaging, custodian — future phase)");
  return items;
}

function renderConfirmation() {
  const p = state.data.profile || {};
  const r = state.data.risk || {};
  const a = state.data.agreement || {};
  const sections = completedSections();
  const missing = missingItems();

  const signatureBlock = a.signatureDataUrl
    ? `<h2 class="section-heading">Advisory Agreement Signature</h2>
       <p>Captured ${a.signedAt ? escapeHtml(new Date(a.signedAt).toLocaleString()) : ""}${a.typedName ? " · " + escapeHtml(a.typedName) : ""} — sample data, not legally binding.</p>
       <div class="signature-review"><img src="${escapeHtml(a.signatureDataUrl)}" alt="Captured signature" /></div>`
    : "";

  document.getElementById("confirm-summary").innerHTML = `
    <div class="summary-block">
      <div class="summary-row"><span>Client name</span><strong>${escapeHtml([p.firstName, p.lastName].filter(Boolean).join(" ") || "—")}</strong></div>
      <div class="summary-row"><span>Onboarding ID</span><strong>${escapeHtml(state.onboardingId || "—")}</strong></div>
      <div class="summary-row"><span>Risk score</span><strong>${r.score != null ? r.score + " / 100" : "—"}</strong></div>
      <div class="summary-row"><span>Risk profile</span><strong>${escapeHtml(r.profile || "—")}</strong></div>
      <div class="summary-row"><span>Completed sections</span><strong class="summary-ok">${sections.length} of 10</strong></div>
    </div>
    ${signatureBlock}
    <h2 class="section-heading">Completed</h2>
    <ul>${sections.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
    <h2 class="section-heading">Outstanding items</h2>
    <ul>${missing.map((m) => `<li class="summary-missing">${escapeHtml(m)}</li>`).join("")}</ul>
    <h2 class="section-heading">Next steps</h2>
    <ol>
      <li>BlueLine reviews your onboarding summary before the first meeting.</li>
      <li>You'll receive scheduling and portal invitations (future phase).</li>
      <li>Bring or send the outstanding documents listed above.</li>
    </ol>`;
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function buildContactsCsv() {
  const p = state.data.profile || {};
  const header = [
    "onboarding_id", "household_name", "first_name", "last_name", "preferred_name", "email", "phone",
    "address", "city", "state", "zip", "employer", "occupation", "marital_status",
    "trusted_contact_name", "trusted_contact_phone", "preferred_communication_method",
  ];
  const household = [p.lastName, p.spouseName ? "& " + p.spouseName : ""].filter(Boolean).join(" ") || p.lastName || "";
  const row = [
    state.onboardingId, household, p.firstName, p.lastName, p.preferredName, p.email, p.phone,
    p.street, p.city, p.state, p.zip, p.employer, p.occupation, p.maritalStatus,
    p.trustedContactName, p.trustedContactPhone, p.preferredCommunication,
  ];
  return toCsv([header, row]);
}

function buildNotesCsv() {
  const p = state.data.profile || {};
  const d = state.data.discovery || {};
  const r = state.data.risk || {};
  const m = state.data.meetingprep || {};
  const contactName = [p.firstName, p.lastName].filter(Boolean).join(" ");
  const created = state.completionTime || nowIso();

  const withDetail = (answer, detail) => [answer, detail].filter(Boolean).join(" — ");
  const notes = [
    ["Planning Discovery", d.prompt && `What prompted contact: ${d.prompt}`],
    ["Planning Discovery", d.priorities && `Top three priorities: ${d.priorities}`],
    ["Financial Concern", d.worries && `Keeps them awake financially: ${d.worries}`],
    ["Success Definition", d.success && `One-year success definition: ${d.success}`],
    ["Planning Discovery", d.lifeEvents && `Major life events: ${withDetail(d.lifeEvents, d.lifeEventsDetail)}`],
    ["Planning Discovery", d.tax && `Tax issues: ${withDetail(d.tax, d.taxDetail)}`],
    ["Planning Discovery", d.estate && `Estate planning issues: ${withDetail(d.estate, d.estateDetail)}`],
    ["Planning Discovery", d.business && `Business ownership issues: ${withDetail(d.business, d.businessDetail)}`],
    ["Risk Summary", r.score != null && `Risk score ${r.score}/100 — profile: ${r.profile}`],
    ["First Meeting Prep", m.accomplish && `Wants to accomplish: ${m.accomplish}`],
    ["First Meeting Prep", m.questions && `Questions to answer first: ${m.questions}`],
    ["First Meeting Prep", m.review && `Review before meeting: ${m.review}`],
    ["First Meeting Prep", m.attendees && `Additional attendees: ${m.attendees}`],
  ].filter(([, text]) => text);

  const rows = [["onboarding_id", "contact_name", "note_type", "note_text", "created_at"]];
  for (const [type, text] of notes) {
    rows.push([state.onboardingId, contactName, type, text, created]);
  }
  return toCsv(rows);
}

function buildSummaryHtml() {
  const p = state.data.profile || {};
  const d = state.data.discovery || {};
  const s = state.data.snapshot || {};
  const r = state.data.risk || {};
  const po = state.data.portal || {};
  const m = state.data.meetingprep || {};
  const a = state.data.agreement || {};
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ");
  const row = (label, value) =>
    `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value || "—")}</td></tr>`;

  const signatureSection = a.signatureDataUrl
    ? `<h2>Advisory Agreement Signature</h2>
<table>
${row("Typed name", a.typedName)}
${row("Signed at", a.signedAt ? new Date(a.signedAt).toLocaleString() : "")}
</table>
<div class="signature-box"><img src="${escapeHtml(a.signatureDataUrl)}" alt="Captured signature" /></div>
<p class="poc" style="margin-top:6px">Sample signature captured in the proof of concept — not a legally binding signature.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<title>Onboarding Summary — ${escapeHtml(state.onboardingId || "")}</title>
<style>
  body { font-family: Cambria, Georgia, serif; color: #1c2530; max-width: 800px; margin: 24px auto; padding: 0 20px; }
  .header { background: #1B2A4A; color: #fff; border-radius: 8px; padding: 18px 22px; }
  .header h1 { margin: 0; font-size: 1.4rem; }
  .header p { margin: 6px 0 0; opacity: 0.85; font-size: 0.9rem; }
  h2 { color: #1B2A4A; border-bottom: 2px solid #4AABDB; padding-bottom: 4px; margin-top: 28px; font-size: 1.1rem; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 6px 10px; border-bottom: 1px dashed #dfe6ee; vertical-align: top; }
  td:first-child { font-weight: 700; color: #1B2A4A; width: 260px; }
  .flag { background: #fdf3e6; border-left: 3px solid #F2A65A; padding: 8px 12px; margin: 6px 0; }
  .poc { color: #7a5220; font-size: 0.85rem; margin-top: 30px; }
  .signature-box { border: 1px solid #dfe6ee; border-radius: 8px; padding: 8px; max-width: 400px; background: #fff; }
  .signature-box img { display: block; width: 100%; height: auto; }
</style></head><body>
<div class="header">
  <h1>BlueLine Advisors — Onboarding Summary</h1>
  <p>${escapeHtml(state.onboardingId || "")} · Prepared ${new Date().toLocaleString()} · Internal use — sample data (proof of concept)</p>
</div>

<h2>Household Overview</h2>
<table>
${row("Client", name)}
${row("Preferred name", p.preferredName)}
${row("Spouse / partner", p.spouseName)}
${row("Marital status", p.maritalStatus)}
${row("Employer / occupation", [p.employer, p.occupation].filter(Boolean).join(" — "))}
${row("CPA", p.cpaName)}
${row("Attorney", p.attorneyName)}
</table>

<h2>Contact Information</h2>
<table>
${row("Email", p.email)}
${row("Phone", p.phone)}
${row("Address", [p.street, p.city, p.state, p.zip].filter(Boolean).join(", "))}
${row("Trusted contact", [p.trustedContactName, p.trustedContactPhone].filter(Boolean).join(" — "))}
${row("Preferred communication", p.preferredCommunication)}
</table>

<h2>Planning Priorities</h2>
<table>
${row("What prompted contact", d.prompt)}
${row("Top three priorities", d.priorities)}
${row("Keeps them awake", d.worries)}
${row("One-year success definition", d.success)}
${row("Major life events", [d.lifeEvents, d.lifeEventsDetail].filter(Boolean).join(" — "))}
${row("Tax issues", [d.tax, d.taxDetail].filter(Boolean).join(" — "))}
${row("Estate issues", [d.estate, d.estateDetail].filter(Boolean).join(" — "))}
${row("Business issues", [d.business, d.businessDetail].filter(Boolean).join(" — "))}
</table>

<h2>Financial Snapshot (ranges)</h2>
<table>
${row("Cash", s.cashRange)}
${row("Investment accounts", s.investmentRange)}
${row("Retirement accounts", s.retirementRange)}
${row("Real estate", s.realEstateRange)}
${row("Business value", s.businessRange)}
${row("Mortgage", s.mortgageRange)}
${row("Other debt", s.otherDebtRange)}
${row("Annual income", s.incomeRange)}
${row("Annual spending", s.spendingRange)}
</table>

<h2>Risk Profile</h2>
<table>
${row("Score", r.score != null ? `${r.score} / 100` : "")}
${row("Profile", r.profile)}
</table>

${signatureSection}

<h2>Communication & Meeting Preferences</h2>
<table>
${row("Meeting format", po.meetingFormat)}
${row("Meeting time", po.meetingTime)}
${row("Best phone", po.bestPhone)}
${row("Best email", po.bestEmail)}
</table>

<h2>First Meeting Questions</h2>
<table>
${row("Wants to accomplish", m.accomplish)}
${row("Questions to answer first", m.questions)}
${row("Review before meeting", m.review)}
${row("Additional attendees", m.attendees)}
</table>

<h2>Outstanding Items</h2>
${missingItems().map((item) => `<div class="flag">${escapeHtml(item)}</div>`).join("")}

<p class="poc">Generated by the BlueLine onboarding proof of concept. All data is sample/test data.</p>
</body></html>`;
}

function buildAuditJson() {
  const regdocs = state.data.regdocs || { documents: {} };
  const documentVersions = {};
  let regdocsAcknowledged = true;
  for (const d of REGDOCS) {
    const entry = regdocs.documents[d.key];
    if (entry) {
      documentVersions[d.name] = { version: entry.version, acknowledgedAt: entry.acknowledgedAt };
    } else {
      regdocsAcknowledged = false;
    }
  }
  return JSON.stringify(
    {
      onboarding_id: state.onboardingId,
      user_email: (state.data.consent && state.data.consent.email) || null,
      start_time: state.startTime,
      completion_time: state.completionTime,
      consent_acknowledged: !!(state.data.consent && state.data.consent.consented),
      consent_timestamp: (state.data.consent && state.data.consent.timestamp) || null,
      regulatory_documents_acknowledged: regdocsAcknowledged,
      document_versions: documentVersions,
      advisory_agreement_placeholder_timestamp: (state.data.agreement && state.data.agreement.timestamp) || null,
      advisory_agreement_signature_captured: !!(state.data.agreement && state.data.agreement.signatureDataUrl),
      advisory_agreement_signed_at: (state.data.agreement && state.data.agreement.signedAt) || null,
      advisory_agreement_typed_name: (state.data.agreement && state.data.agreement.typedName) || null,
      risk_score: (state.data.risk && state.data.risk.score) ?? null,
      risk_profile: (state.data.risk && state.data.risk.profile) || null,
      completed_sections: completedSections(),
      proof_of_concept: true,
    },
    null,
    2
  );
}

document.getElementById("export-contacts").addEventListener("click", () => {
  download("contacts.csv", buildContactsCsv(), "text/csv");
});
document.getElementById("export-notes").addEventListener("click", () => {
  download("notes.csv", buildNotesCsv(), "text/csv");
});
document.getElementById("export-summary").addEventListener("click", () => {
  download("onboarding_summary.html", buildSummaryHtml(), "text/html");
});
document.getElementById("export-audit").addEventListener("click", () => {
  download("audit_record.json", buildAuditJson(), "application/json");
});

// ---------- Boot ----------

showStep(state.onboardingId ? Math.min(state.currentStep, STEPS.length - 1) : 0);
