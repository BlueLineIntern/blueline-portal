// Shared rendering for assessment results: SVG chart builders and per-module
// result renderers. Used by both the client dashboard (script.js) and the
// admin detail view (admin.html). No DOM lookups at load time — everything
// here is pure string-building.

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function fmtMoney(amount) {
  const n = Number(amount || 0);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

function fmtCompact(amount) {
  const n = Number(amount || 0);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

const PALETTE = [
  "#4AABDB", "#1B2A4A", "#6BAA75", "#F2A65A", "#8E7CC3",
  "#3690c0", "#C77B58", "#5b6b7f", "#A3B86C", "#D4AC6E",
];

// ---------- SVG chart helpers ----------

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function donutArcPath(cx, cy, rOuter, rInner, startDeg, endDeg) {
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const so = polar(cx, cy, rOuter, startDeg);
  const eo = polar(cx, cy, rOuter, endDeg);
  const si = polar(cx, cy, rInner, startDeg);
  const ei = polar(cx, cy, rInner, endDeg);
  return [
    `M ${so.x.toFixed(2)} ${so.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${eo.x.toFixed(2)} ${eo.y.toFixed(2)}`,
    `L ${ei.x.toFixed(2)} ${ei.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${si.x.toFixed(2)} ${si.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

/**
 * Donut chart with legend. segments: [{ label, value, color }]
 * centerTop / centerBottom: text in the donut hole.
 */
function donutChart(segments, { centerTop = "", centerBottom = "", format = fmtMoney, showPct = true } = {}) {
  const visible = segments.filter((s) => s.value > 0);
  const total = visible.reduce((sum, s) => sum + s.value, 0);
  const size = 180;
  const cx = size / 2, cy = size / 2, rOuter = 84, rInner = 54;

  let paths = "";
  if (total <= 0) {
    paths = `<circle cx="${cx}" cy="${cy}" r="${(rOuter + rInner) / 2}" fill="none" stroke="#e6ecf2" stroke-width="${rOuter - rInner}" />`;
  } else if (visible.length === 1) {
    paths = `<circle cx="${cx}" cy="${cy}" r="${(rOuter + rInner) / 2}" fill="none" stroke="${visible[0].color}" stroke-width="${rOuter - rInner}" />`;
  } else {
    let angle = 0;
    for (const seg of visible) {
      const sweep = (seg.value / total) * 360;
      // cap at 359.9 to avoid degenerate full-circle arcs
      const end = Math.min(angle + sweep, angle + 359.9);
      paths += `<path d="${donutArcPath(cx, cy, rOuter, rInner, angle, end)}" fill="${seg.color}"><title>${escapeHtml(seg.label)}: ${format(seg.value)}</title></path>`;
      angle += sweep;
    }
  }

  const legend = segments
    .map((s) => {
      const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
      return `<li><span class="legend-swatch" style="background:${s.color}"></span>
        <span class="legend-label">${escapeHtml(s.label)}</span>
        <span class="legend-value">${format(s.value)}${showPct ? ` <em>(${pct}%)</em>` : ""}</span></li>`;
    })
    .join("");

  return `
    <div class="chart-donut">
      <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Breakdown chart">
        ${paths}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-center-top">${escapeHtml(centerTop)}</text>
        <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="donut-center-bottom">${escapeHtml(centerBottom)}</text>
      </svg>
      <ul class="chart-legend">${legend}</ul>
    </div>`;
}

/** Semicircular gauge for the risk score (5–25). */
function riskGauge(score, category) {
  const size = 220;
  const cx = size / 2, cy = 108, r = 88;
  const bands = ["#a8d5ec", "#7fc2e3", "#56afd9", "#3690c0", "#1B2A4A"];
  const bandLabels = ["Conservative", "Mod. Conservative", "Moderate", "Mod. Aggressive", "Aggressive"];

  let arcs = "";
  for (let i = 0; i < 5; i++) {
    const start = -90 + i * 36;
    const end = start + 34.5;
    arcs += `<path d="${donutArcPath(cx, cy, r, r - 22, start, end)}" fill="${bands[i]}"><title>${bandLabels[i]}</title></path>`;
  }

  const frac = Math.max(0, Math.min(1, (score - 5) / 20));
  const needleDeg = -90 + frac * 180;
  const tip = polar(cx, cy, r - 30, needleDeg);

  return `
    <div class="chart-gauge">
      <svg viewBox="0 0 ${size} 130" role="img" aria-label="Risk score gauge">
        ${arcs}
        <line x1="${cx}" y1="${cy}" x2="${tip.x.toFixed(1)}" y2="${tip.y.toFixed(1)}" stroke="#1c2530" stroke-width="3" stroke-linecap="round" />
        <circle cx="${cx}" cy="${cy}" r="6" fill="#1c2530" />
        <text x="14" y="126" class="gauge-end-label">Conservative</text>
        <text x="${size - 14}" y="126" text-anchor="end" class="gauge-end-label">Aggressive</text>
      </svg>
      <p class="gauge-caption"><strong>${score} / 25</strong> — ${escapeHtml(category)}</p>
    </div>`;
}

/** Retirement projection area chart with target line. */
function projectionChart(retirement) {
  const { currentAge, targetAge, currentSavings, monthlyContribution, employerMatchMonthly, targetNestEgg } = retirement;
  const monthlyRate = 0.06 / 12;
  const contribution = monthlyContribution + employerMatchMonthly;

  const points = [];
  let balance = currentSavings;
  points.push({ age: currentAge, balance });
  for (let age = currentAge + 1; age <= targetAge; age++) {
    for (let m = 0; m < 12; m++) balance = balance * (1 + monthlyRate) + contribution;
    points.push({ age, balance });
  }

  const W = 560, H = 260, padL = 56, padR = 16, padT = 16, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxY = Math.max(targetNestEgg, points[points.length - 1].balance, 1) * 1.12;
  const ageSpan = Math.max(targetAge - currentAge, 1);

  const x = (age) => padL + ((age - currentAge) / ageSpan) * plotW;
  const y = (val) => padT + plotH - (val / maxY) * plotH;

  const linePts = points.map((p) => `${x(p.age).toFixed(1)},${y(p.balance).toFixed(1)}`).join(" ");
  const areaPts = `${padL},${(padT + plotH).toFixed(1)} ${linePts} ${(padL + plotW).toFixed(1)},${(padT + plotH).toFixed(1)}`;

  // x-axis ticks roughly every 5 years, always including endpoints
  const step = ageSpan > 25 ? 10 : 5;
  const tickAges = [];
  for (let a = currentAge; a < targetAge; a += step) tickAges.push(a);
  tickAges.push(targetAge);
  const xTicks = tickAges
    .map((a) => `<text x="${x(a).toFixed(1)}" y="${H - 12}" text-anchor="middle" class="axis-label">${a}</text>`)
    .join("");

  const yTicks = [0.5, 1]
    .map((f) => {
      const v = maxY * f;
      return `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${padL + plotW}" y2="${y(v).toFixed(1)}" class="grid-line" />
        <text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="axis-label">${fmtCompact(v)}</text>`;
    })
    .join("");

  const targetY = y(Math.min(targetNestEgg, maxY));
  const endBalance = points[points.length - 1].balance;

  return `
    <div class="chart-projection">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected retirement savings by age">
        ${yTicks}
        <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#c9d4df" />
        <polygon points="${areaPts}" fill="rgba(74,171,219,0.18)" />
        <polyline points="${linePts}" fill="none" stroke="#4AABDB" stroke-width="3" stroke-linejoin="round" />
        <line x1="${padL}" y1="${targetY.toFixed(1)}" x2="${padL + plotW}" y2="${targetY.toFixed(1)}"
          stroke="#F2A65A" stroke-width="2" stroke-dasharray="7 5" />
        <text x="${padL + 6}" y="${(targetY - 7).toFixed(1)}" class="target-label">Target: ${fmtCompact(targetNestEgg)}</text>
        <circle cx="${x(targetAge).toFixed(1)}" cy="${y(endBalance).toFixed(1)}" r="5" fill="#1B2A4A" />
        ${xTicks}
        <text x="${padL + plotW / 2}" y="${H - 0.5}" text-anchor="middle" class="axis-title">Age</text>
      </svg>
    </div>`;
}

/** Horizontal progress-style bar with a label, capped at 100% width. */
function statBar(label, pct, color) {
  const width = Math.max(0, Math.min(100, pct));
  return `
    <div class="stat-bar">
      <div class="stat-bar-header"><span>${escapeHtml(label)}</span><strong>${Math.round(pct)}%</strong></div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${width}%;background:${color}"></div></div>
    </div>`;
}

/** Paired horizontal stacked bars: assets vs liabilities. */
function balanceBars(assetSegments, liabilitySegments) {
  const totalAssets = assetSegments.reduce((s, a) => s + a.value, 0);
  const totalLiabilities = liabilitySegments.reduce((s, a) => s + a.value, 0);
  const maxTotal = Math.max(totalAssets, totalLiabilities, 1);

  function stackedBar(segments, total) {
    const widthPct = (total / maxTotal) * 100;
    let inner = "";
    for (const seg of segments) {
      if (seg.value <= 0) continue;
      const w = (seg.value / maxTotal) * 100;
      inner += `<div class="stack-seg" style="width:${w}%;background:${seg.color}" title="${escapeHtml(seg.label)}: ${fmtMoney(seg.value)}"></div>`;
    }
    return `<div class="stack-track" style="width:${Math.max(widthPct, 0.5)}%">${inner}</div>`;
  }

  const legend = [...assetSegments, ...liabilitySegments]
    .filter((s) => s.value > 0)
    .map(
      (s) => `<li><span class="legend-swatch" style="background:${s.color}"></span>
        <span class="legend-label">${escapeHtml(s.label)}</span>
        <span class="legend-value">${fmtMoney(s.value)}</span></li>`
    )
    .join("");

  return `
    <div class="chart-balance">
      <div class="balance-row"><span class="balance-row-label">Assets</span><div class="balance-bar-area">${stackedBar(assetSegments, totalAssets)}</div><span class="balance-row-total">${fmtCompact(totalAssets)}</span></div>
      <div class="balance-row"><span class="balance-row-label">Liabilities</span><div class="balance-bar-area">${stackedBar(liabilitySegments, totalLiabilities)}</div><span class="balance-row-total">${fmtCompact(totalLiabilities)}</span></div>
      <ul class="chart-legend legend-columns">${legend}</ul>
    </div>`;
}

// ---------- Module labels ----------

const BUDGET_EXPENSES = [
  ["housing", "Housing / Rent"],
  ["utilities", "Utilities"],
  ["groceries", "Groceries"],
  ["transportation", "Transportation"],
  ["insurance", "Insurance"],
  ["healthcare", "Healthcare"],
  ["debt", "Debt Payments"],
  ["childcareEducation", "Childcare & Education"],
  ["discretionary", "Entertainment & Discretionary"],
  ["other", "Other"],
];

const NETWORTH_ASSETS = [
  ["cash", "Cash & Savings"],
  ["brokerage", "Brokerage / Investments"],
  ["retirement", "Retirement Accounts"],
  ["realEstate", "Real Estate"],
  ["businessEquity", "Business Ownership"],
  ["otherAssets", "Other Assets"],
];

const NETWORTH_LIABILITIES = [
  ["mortgage", "Mortgage"],
  ["studentLoans", "Student Loans"],
  ["autoLoans", "Auto Loans"],
  ["creditCards", "Credit Cards"],
  ["businessDebt", "Business Debt"],
  ["otherDebts", "Other Debts"],
];

const EQUITY_TYPE_LABELS = {
  rsu: "RSUs",
  options: "Stock Options",
  espp: "ESPP",
  partnership: "Partnership Interest",
  none: "None",
};

const CONCENTRATION_LABELS = {
  none: "None",
  under5: "Under 5%",
  "5to15": "5–15%",
  "15to30": "15–30%",
  over30: "Over 30%",
};

const EXPERIENCE_LABELS = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
  expert: "Expert",
};

// ---------- Per-module result renderers ----------

function renderRiskResult(m) {
  const alloc = m.suggestedAllocation || {};
  const goals = [
    ["3–5 yr", m.goalShortTerm],
    ["5–10 yr", m.goalMediumTerm],
    ["10+ yr", m.goalLongTerm],
  ].filter(([, v]) => v);
  return `
    ${riskGauge(m.score, m.category)}
    <div class="stat-rows">
      <div class="stat-row"><span>Investment Experience</span><strong>${escapeHtml(EXPERIENCE_LABELS[m.experienceLevel] || m.experienceLevel)}</strong></div>
    </div>
    <h3 class="result-subheading">Suggested Starting Allocation</h3>
    ${donutChart(
      [
        { label: "Stocks", value: alloc.stocks || 0, color: PALETTE[0] },
        { label: "Bonds", value: alloc.bonds || 0, color: PALETTE[1] },
        { label: "Cash", value: alloc.cash || 0, color: PALETTE[3] },
      ],
      { centerTop: `${alloc.stocks || 0}%`, centerBottom: "stocks", format: (v) => `${v}%`, showPct: false }
    )}
    ${goals.length ? `<h3 class="result-subheading">Goals</h3><div class="stat-rows">${goals
      .map(([label, v]) => `<div class="stat-row"><span>${label}</span><strong class="goal-text">${escapeHtml(v)}</strong></div>`)
      .join("")}</div>` : ""}`;
}

function renderBudgetResult(m) {
  const segments = BUDGET_EXPENSES.map(([key, label], i) => ({
    label,
    value: m.expenses[key] || 0,
    color: PALETTE[i % PALETTE.length],
  }));
  const surplusClass = m.surplus < 0 ? "negative" : "positive";
  return `
    ${donutChart(segments, { centerTop: fmtCompact(m.totalExpenses), centerBottom: "expenses/mo" })}
    <div class="stat-rows">
      <div class="stat-row"><span>Monthly Take-Home Income</span><strong>${fmtMoney(m.monthlyIncome)}</strong></div>
      <div class="stat-row"><span>Monthly Expenses</span><strong>${fmtMoney(m.totalExpenses)}</strong></div>
      <div class="stat-row"><span>Monthly Savings & Investing</span><strong>${fmtMoney(m.monthlySavings)}</strong></div>
      <div class="stat-row"><span>Unallocated Cash Flow</span><strong class="${surplusClass}">${fmtMoney(m.surplus)}</strong></div>
    </div>
    ${statBar("Savings Rate", m.savingsRate, m.savingsRate >= 15 ? "#6BAA75" : m.savingsRate >= 8 ? "#F2A65A" : "#C0392B")}
    <p class="result-note">${
      m.surplus < 0
        ? "Your reported spending and saving exceed your income — worth a close look together."
        : "A savings rate of 15%+ of take-home pay is a strong baseline for long-term goals."
    }</p>`;
}

function renderRetirementResult(m) {
  const readiness = m.readinessPct == null ? null : Math.min(m.readinessPct, 100);
  const rolloverNote =
    m.oldEmployerPlans !== "none"
      ? `<p class="result-flag">You have ${m.oldEmployerPlans === "one" ? "an old employer plan" : "multiple old employer plans"} — we'll review consolidation and rollover options with you.</p>`
      : "";
  return `
    ${projectionChart(m)}
    <div class="stat-rows">
      <div class="stat-row"><span>Projected at Age ${m.targetAge}</span><strong>${fmtMoney(m.projectedBalance)}</strong></div>
      <div class="stat-row"><span>Target Nest Egg (4% rule)</span><strong>${fmtMoney(m.targetNestEgg)}</strong></div>
      <div class="stat-row"><span>Monthly Contributions (incl. match)</span><strong>${fmtMoney(m.monthlyContribution + m.employerMatchMonthly)}</strong></div>
    </div>
    ${
      readiness == null
        ? ""
        : statBar(`On Track: ${m.readinessPct}% of target`, readiness, readiness >= 90 ? "#6BAA75" : readiness >= 60 ? "#F2A65A" : "#C0392B")
    }
    ${rolloverNote}
    <p class="result-note">Assumes 6% annual growth for illustration only — actual planning uses far more than one number.</p>`;
}

function renderNetWorthResult(m) {
  const assetSegments = NETWORTH_ASSETS.map(([key, label], i) => ({
    label,
    value: m.assets[key] || 0,
    color: PALETTE[i % PALETTE.length],
  }));
  const liabilitySegments = NETWORTH_LIABILITIES.map(([key, label], i) => ({
    label,
    value: m.liabilities[key] || 0,
    color: PALETTE[(i + 5) % PALETTE.length],
  }));
  const nwClass = m.netWorth < 0 ? "negative" : "positive";
  return `
    <p class="headline-stat">Net Worth: <strong class="${nwClass}">${fmtMoney(m.netWorth)}</strong></p>
    ${balanceBars(assetSegments, liabilitySegments)}
    <h3 class="result-subheading">Asset Composition</h3>
    ${donutChart(assetSegments, { centerTop: fmtCompact(m.totalAssets), centerBottom: "total assets" })}`;
}

function renderCompensationResult(m) {
  const mix = donutChart(
    [
      { label: "Base Salary", value: m.baseSalary, color: PALETTE[0] },
      { label: "Bonus / Commission", value: m.annualBonus, color: PALETTE[3] },
      { label: "Equity Compensation", value: m.annualEquityValue, color: PALETTE[1] },
    ],
    { centerTop: fmtCompact(m.totalComp), centerBottom: "total comp" }
  );
  const types = (m.equityTypes || []).map((t) => EQUITY_TYPE_LABELS[t] || t);
  const benefits = [
    m.hsaEligible ? "HSA access" : null,
    m.deferredComp ? "Deferred comp plan" : null,
  ].filter(Boolean);
  const concentrationFlag = m.concentrationFlag
    ? `<p class="result-flag">${CONCENTRATION_LABELS[m.employerStockConcentration]} of your investable assets is in employer stock — concentration risk we should plan around.</p>`
    : "";
  return `
    ${mix}
    <div class="stat-rows">
      <div class="stat-row"><span>Equity Award Types</span><strong>${types.length ? escapeHtml(types.join(", ")) : "—"}</strong></div>
      <div class="stat-row"><span>401(k) Contribution</span><strong>${m.contributionPct}% of salary</strong></div>
      <div class="stat-row"><span>Employer Match</span><strong>${m.employerMatchPct}% of salary</strong></div>
      <div class="stat-row"><span>Other Benefits</span><strong>${benefits.length ? escapeHtml(benefits.join(", ")) : "—"}</strong></div>
      <div class="stat-row"><span>Employer Stock Concentration</span><strong>${CONCENTRATION_LABELS[m.employerStockConcentration] || "—"}</strong></div>
    </div>
    ${concentrationFlag}
    ${
      m.contributionPct < m.employerMatchPct
        ? `<p class="result-flag">You're contributing less than your employer match — that's unclaimed compensation.</p>`
        : ""
    }`;
}

const MODULES = [
  {
    key: "risk",
    title: "Risk Tolerance & Investor Profile",
    description: "Five quick questions to gauge how you handle market swings — and see the portfolio mix that fits.",
    renderResult: renderRiskResult,
  },
  {
    key: "budget",
    title: "Budget & Cash Flow Analysis",
    description: "Map your monthly income and spending to see your savings rate and where cash flow can improve.",
    renderResult: renderBudgetResult,
  },
  {
    key: "retirement",
    title: "Retirement Readiness",
    description: "Project where your current savings path leads and how it compares to the retirement you want.",
    renderResult: renderRetirementResult,
  },
  {
    key: "networth",
    title: "Net Worth Snapshot",
    description: "A simple balance sheet — what you own vs. what you owe — as the starting point for your plan.",
    renderResult: renderNetWorthResult,
  },
  {
    key: "compensation",
    title: "Compensation & Employer Benefits",
    description: "Salary, bonus, equity awards, and benefits — often the most under-optimized part of a professional's finances.",
    renderResult: renderCompensationResult,
  },
];

// ---------- Category module labels ----------

const SPENDING_ESSENTIALS = [
  ["housing", "Housing / Rent"],
  ["utilities", "Utilities"],
  ["groceries", "Groceries"],
  ["transportation", "Transportation"],
  ["healthcare", "Healthcare"],
  ["insurance", "Insurance"],
];

const SPENDING_DISCRETIONARY = [
  ["dining", "Dining Out"],
  ["entertainment", "Entertainment"],
  ["shopping", "Shopping"],
  ["subscriptions", "Subscriptions"],
  ["travel", "Travel"],
  ["other", "Other"],
];

const DEBT_TYPES = [
  ["creditCards", "Credit Cards"],
  ["autoLoans", "Auto Loans"],
  ["studentLoans", "Student Loans"],
  ["personalLoans", "Personal / Other Loans"],
];
const DEBT_TYPE_LABELS = Object.fromEntries(DEBT_TYPES);

const INSTRUMENT_OPTIONS = [
  ["stocks", "Individual Stocks"],
  ["bonds", "Bonds"],
  ["mutualFunds", "Mutual Funds"],
  ["etfs", "ETFs"],
  ["options", "Options"],
  ["crypto", "Crypto"],
  ["realEstate", "Real Estate"],
  ["annuities", "Annuities"],
];
const INSTRUMENT_LABELS = Object.fromEntries(INSTRUMENT_OPTIONS);

const KNOWLEDGE_YEARS_LABELS = {
  none: "No investing experience",
  under3: "Under 3 years",
  "3to10": "3–10 years",
  over10: "More than 10 years",
};

const ESTATE_DOCS = [
  ["will", "Will"],
  ["trust", "Revocable Living Trust"],
  ["financialPoa", "Durable Financial Power of Attorney"],
  ["healthcareDirective", "Healthcare Directive / Proxy"],
  ["hipaaAuthorization", "HIPAA Authorization"],
];
const ESTATE_DOC_LABELS = Object.fromEntries(ESTATE_DOCS);

const BENEFICIARY_NAMED_LABELS = { all: "All of them", some: "Some of them", none: "None", na: "Not applicable" };
const TOD_LABELS = { yes: "Yes", no: "No", na: "Not applicable" };
const LAST_REVIEWED_LABELS = {
  within1: "Within the last year",
  "1to3": "1–3 years ago",
  over3: "More than 3 years ago",
  never: "Never",
};
const LIFE_EVENT_LABELS = {
  marriage: "Marriage",
  divorce: "Divorce",
  birth: "Birth or adoption",
  death: "Death in the family",
  move: "Moved states",
  none: "None of these",
};

const CHARITABLE_INTENT_LABELS = {
  none: "No charitable plans",
  annual: "Lifetime giving",
  bequest: "Bequest in estate",
  both: "Lifetime giving and a bequest",
  unsure: "Not sure yet",
};
const ANNUAL_GIFTING_LABELS = { none: "None", family: "To family", charity: "To charity", both: "To family and charity" };
const SPECIAL_CIRCUMSTANCE_LABELS = {
  minorChildren: "Minor children",
  specialNeeds: "Family member with special needs",
  blendedFamily: "Blended family",
  businessSuccession: "Business succession",
  none: "None",
};

const COVERAGE_LINES = [
  ["termLife", "Life Insurance"],
  ["disability", "Disability Insurance"],
  ["umbrella", "Umbrella Liability"],
  ["longTermCare", "Long-Term Care"],
  ["homeAuto", "Home & Auto"],
];
const COVERAGE_LINE_LABELS = Object.fromEntries(COVERAGE_LINES);

const LTC_AGE_LABELS = { under40: "Under 40", "40to49": "40–49", "50to59": "50–59", "60plus": "60+" };
const LTC_FUNDING_LABELS = {
  insurance: "Long-term care insurance",
  selfFund: "Self-fund from savings",
  hybrid: "Hybrid life / LTC policy",
  none: "No plan yet",
};
const YES_NO_UNSURE_LABELS = { yes: "Yes", no: "No", unsure: "Not sure" };

/** Checklist rows with a yes / no / unsure marker and optional detail text. */
function checklistRows(rows) {
  const MARKERS = { yes: ["✓", "check-yes"], no: ["✕", "check-no"], unsure: ["?", "check-unsure"] };
  return `<div class="check-rows">${rows
    .map((r) => {
      const [mark, cls] = MARKERS[r.status] || MARKERS.unsure;
      return `<div class="check-row"><span class="check-marker ${cls}">${mark}</span>
        <span class="check-label">${escapeHtml(r.label)}</span>
        ${r.detail ? `<span class="check-detail">${escapeHtml(r.detail)}</span>` : ""}</div>`;
    })
    .join("")}</div>`;
}

// ---------- Category module result renderers ----------

// 12 distinct hues so no two segments of the spending donut share a color.
const SPENDING_COLORS = [...PALETTE, "#B56576", "#7A9E9F"];

function renderSpendingResult(m) {
  const segments = [
    ...SPENDING_ESSENTIALS.map(([key, label], i) => ({
      label,
      value: (m.essentials && m.essentials[key]) || 0,
      color: SPENDING_COLORS[i],
    })),
    ...SPENDING_DISCRETIONARY.map(([key, label], i) => ({
      label,
      value: (m.discretionary && m.discretionary[key]) || 0,
      color: SPENDING_COLORS[i + 6],
    })),
  ];
  const leftoverClass = m.leftover < 0 ? "negative" : "positive";
  return `
    ${donutChart(segments, { centerTop: fmtCompact(m.totalSpending), centerBottom: "spending/mo" })}
    <div class="stat-rows">
      <div class="stat-row"><span>Monthly Income</span><strong>${fmtMoney(m.monthlyIncome)}</strong></div>
      <div class="stat-row"><span>Essential Spending</span><strong>${fmtMoney(m.totalEssentials)}</strong></div>
      <div class="stat-row"><span>Discretionary Spending</span><strong>${fmtMoney(m.totalDiscretionary)}</strong></div>
      <div class="stat-row"><span>Left Over Each Month</span><strong class="${leftoverClass}">${fmtMoney(m.leftover)}</strong></div>
    </div>
    ${statBar("Discretionary Share of Spending", m.discretionaryPct, m.highDiscretionary ? "#F2A65A" : "#6BAA75")}
    ${m.overspending ? `<p class="result-flag">Spending exceeds income by ${fmtMoney(-m.leftover)} per month — the first planning priority.</p>` : ""}
    ${m.highDiscretionary ? `<p class="result-flag">Discretionary purchases are ${m.discretionaryPct}% of total spending — a large lever if cash flow needs to improve.</p>` : ""}`;
}

function renderSavingsResult(m) {
  const hasCoverage = m.monthsCovered != null;
  const coveragePct = hasCoverage ? Math.min(100, (m.monthsCovered / m.targetMonths) * 100) : 0;
  const barLabel = hasCoverage
    ? `Emergency Fund: ${m.monthsCovered} of ${m.targetMonths} months`
    : "Emergency Fund Coverage (no monthly expenses reported)";
  const barColor = !hasCoverage ? "#9fb0bf" : m.funded ? "#6BAA75" : m.monthsCovered < 3 ? "#C0392B" : "#F2A65A";
  return `
    ${statBar(barLabel, coveragePct, barColor)}
    <div class="stat-rows">
      <div class="stat-row"><span>Emergency Fund Balance</span><strong>${fmtMoney(m.emergencyFund)}</strong></div>
      <div class="stat-row"><span>Target (${m.targetMonths} months of expenses)</span><strong>${fmtMoney(m.targetAmount)}</strong></div>
      <div class="stat-row"><span>Shortfall</span><strong class="${m.shortfall > 0 ? "negative" : "positive"}">${fmtMoney(m.shortfall)}</strong></div>
      <div class="stat-row"><span>Months to Target (at current savings)</span><strong>${m.monthsToTarget == null ? "—" : m.monthsToTarget}</strong></div>
    </div>
    ${m.goalsNotes ? `<div class="stat-rows"><div class="stat-row"><span>Savings Goals</span><strong class="goal-text">${escapeHtml(m.goalsNotes)}</strong></div></div>` : ""}
    ${hasCoverage && m.monthsCovered < 3 ? `<p class="result-flag">Less than 3 months of expenses in reserve — building the emergency fund comes before most other goals.</p>` : ""}`;
}

function renderDebtResult(m) {
  const segments = DEBT_TYPES.map(([key, label], i) => ({
    label,
    value: (m.debts && m.debts[key] && m.debts[key].balance) || 0,
    color: PALETTE[i % PALETTE.length],
  }));
  const highestLabel = m.highestRateType ? DEBT_TYPE_LABELS[m.highestRateType] || m.highestRateType : "";
  return `
    ${donutChart(segments, { centerTop: fmtCompact(m.totalDebt), centerBottom: "total debt" })}
    <div class="stat-rows">
      <div class="stat-row"><span>Total Debt</span><strong>${fmtMoney(m.totalDebt)}</strong></div>
      <div class="stat-row"><span>Weighted Average Rate</span><strong>${m.weightedAvgRate}%</strong></div>
      <div class="stat-row"><span>Monthly Debt Payments</span><strong>${fmtMoney(m.monthlyDebtPayments)}</strong></div>
      <div class="stat-row"><span>Debt-to-Income</span><strong>${m.dtiPct == null ? "—" : `${m.dtiPct}%`}</strong></div>
    </div>
    ${m.dtiPct == null ? "" : statBar("Debt-to-Income Ratio", m.dtiPct, m.dtiPct >= 36 ? "#C0392B" : m.dtiPct >= 28 ? "#F2A65A" : "#6BAA75")}
    ${m.highDti ? `<p class="result-flag">Debt payments are ${m.dtiPct}% of gross income — above the 36% level lenders and planners watch.</p>` : ""}
    ${m.highInterest ? `<p class="result-flag">High-interest debt detected${highestLabel ? ` — ${highestLabel} carry the highest rate` : ""}; paying these down is usually the best guaranteed return.</p>` : ""}`;
}

function renderRiskCapacityResult(m) {
  return `
    <p class="headline-stat">Risk Capacity: <strong>${escapeHtml(m.level)}</strong></p>
    ${statBar(`Capacity Score: ${m.score} / 25`, ((m.score - 5) / 20) * 100, "#4AABDB")}
    <p class="result-note">Capacity measures your financial ability to take investment risk — time horizon, income
    stability, and reserves. It is separate from risk tolerance (your willingness to take risk); your advisor
    compares the two when building your portfolio.</p>`;
}

function renderBehaviorResult(m) {
  return `
    <p class="headline-stat">Investor Profile: <strong>${escapeHtml(m.profile)}</strong></p>
    ${statBar(`Behavior Score: ${m.score} / 20`, ((m.score - 4) / 16) * 100, "#4AABDB")}
    ${m.biggestConcern ? `<div class="stat-rows"><div class="stat-row"><span>Biggest Concern</span><strong class="goal-text">${escapeHtml(m.biggestConcern)}</strong></div></div>` : ""}
    ${m.coachingFlag ? `<p class="result-flag">Responses suggest a strong urge to sell in downturns — plan for behavioral coaching during drawdowns.</p>` : ""}`;
}

function renderKnowledgeResult(m) {
  const instruments = (m.instruments || []).map((k) => INSTRUMENT_LABELS[k] || k);
  return `
    <p class="headline-stat">Knowledge Level: <strong>${escapeHtml(m.level)}</strong></p>
    ${statBar(`Knowledge Score: ${m.knowledgeScore} / 12`, (m.knowledgeScore / 12) * 100, "#4AABDB")}
    <div class="stat-rows">
      <div class="stat-row"><span>Years Investing</span><strong>${escapeHtml(KNOWLEDGE_YEARS_LABELS[m.yearsInvesting] || m.yearsInvesting)}</strong></div>
      <div class="stat-row"><span>Instruments Used</span><strong class="goal-text">${instruments.length ? escapeHtml(instruments.join(", ")) : "—"}</strong></div>
      <div class="stat-row"><span>Self-Rated Knowledge</span><strong>${m.selfRating} / 5</strong></div>
      <div class="stat-row"><span>Worked With an Advisor</span><strong>${m.hadAdvisor ? "Yes" : "No"}</strong></div>
    </div>`;
}

function renderEstateDocsResult(m) {
  const rows = ESTATE_DOCS.map(([key, label]) => {
    const doc = (m.documents && m.documents[key]) || {};
    return { label, status: doc.status, detail: doc.year != null ? `Updated ${doc.year}` : "" };
  });
  const staleLabels = (m.stale || []).map((k) => ESTATE_DOC_LABELS[k] || k);
  return `
    ${checklistRows(rows)}
    ${statBar("Document Completeness", m.completenessPct, m.completenessPct >= 80 ? "#6BAA75" : m.completenessPct >= 40 ? "#F2A65A" : "#C0392B")}
    ${(m.missing || []).includes("will") ? `<p class="result-flag">No will in place — without one, state law decides how your assets pass. This is the first document to put in place.</p>` : ""}
    ${staleLabels.length ? `<p class="result-flag">${escapeHtml(staleLabels.join(", "))} last updated 5+ years ago — review recommended.</p>` : ""}`;
}

function renderBeneficiariesResult(m) {
  const gapAreas = [];
  if (m.retirementAccounts === "some" || m.retirementAccounts === "none") gapAreas.push("retirement accounts");
  if (m.lifePolicies === "some" || m.lifePolicies === "none") gapAreas.push("life insurance policies");
  if (m.todBrokerage === "no") gapAreas.push("taxable brokerage accounts");
  const events = (m.eventsSinceReview || []).map((k) => LIFE_EVENT_LABELS[k] || k);
  return `
    <div class="stat-rows">
      <div class="stat-row"><span>Retirement Account Beneficiaries</span><strong>${escapeHtml(BENEFICIARY_NAMED_LABELS[m.retirementAccounts] || m.retirementAccounts)}</strong></div>
      <div class="stat-row"><span>Life Insurance Beneficiaries</span><strong>${escapeHtml(BENEFICIARY_NAMED_LABELS[m.lifePolicies] || m.lifePolicies)}</strong></div>
      <div class="stat-row"><span>Brokerage TOD Designations</span><strong>${escapeHtml(TOD_LABELS[m.todBrokerage] || m.todBrokerage)}</strong></div>
      <div class="stat-row"><span>Last Reviewed</span><strong>${escapeHtml(LAST_REVIEWED_LABELS[m.lastReviewed] || m.lastReviewed)}</strong></div>
      <div class="stat-row"><span>Life Events Since Review</span><strong>${events.length ? escapeHtml(events.join(", ")) : "None"}</strong></div>
    </div>
    ${m.gapCount > 0 ? `<p class="result-flag">Beneficiary gaps found: ${escapeHtml(gapAreas.join(", "))}.</p>` : ""}
    ${(m.eventsSinceReview || []).includes("divorce") ? `<p class="result-flag">Update beneficiaries after divorce — outdated designations override wills.</p>` : ""}
    ${m.reviewNeeded ? `<p class="result-flag">A beneficiary and titling review with your advisor is recommended.</p>` : ""}`;
}

function renderLegacyResult(m) {
  const circumstances = (m.specialCircumstances || [])
    .filter((k) => k !== "none")
    .map((k) => SPECIAL_CIRCUMSTANCE_LABELS[k] || k);
  const topics = m.discussionTopics || [];
  return `
    <div class="stat-rows">
      <div class="stat-row"><span>Charitable Intentions</span><strong>${escapeHtml(CHARITABLE_INTENT_LABELS[m.charitableIntent] || m.charitableIntent)}</strong></div>
      <div class="stat-row"><span>Annual Gifting</span><strong>${escapeHtml(ANNUAL_GIFTING_LABELS[m.annualGifting] || m.annualGifting)}</strong></div>
      <div class="stat-row"><span>Special Circumstances</span><strong>${circumstances.length ? escapeHtml(circumstances.join(", ")) : "None"}</strong></div>
    </div>
    ${
      topics.length
        ? `<h3 class="result-subheading">Topics for your advisor</h3><ul class="topic-list">${topics
            .map((t) => `<li>${escapeHtml(t)}</li>`)
            .join("")}</ul>`
        : `<p class="result-note">No specific legacy planning topics flagged — revisit as circumstances change.</p>`
    }
    ${m.legacyNotes ? `<div class="stat-rows"><div class="stat-row"><span>Notes</span><strong class="goal-text">${escapeHtml(m.legacyNotes)}</strong></div></div>` : ""}`;
}

function renderLifeInsuranceResult(m) {
  const segments = [
    { label: "Debts", value: m.debts || 0, color: PALETTE[0] },
    { label: "Income Replacement", value: (m.annualIncome || 0) * (m.incomeYears || 0), color: PALETTE[1] },
    { label: "Mortgage", value: m.mortgageBalance || 0, color: PALETTE[3] },
    { label: "Education", value: m.educationCosts || 0, color: PALETTE[2] },
  ];
  const gapRow =
    m.gap > 0
      ? `<div class="stat-row"><span>Coverage Gap</span><strong class="negative">${fmtMoney(m.gap)}</strong></div>`
      : `<div class="stat-row"><span>Coverage Surplus</span><strong class="positive">${fmtMoney(-m.gap)}</strong></div>`;
  return `
    ${donutChart(segments, { centerTop: fmtCompact(m.dimeNeed), centerBottom: "DIME need" })}
    <div class="stat-rows">
      <div class="stat-row"><span>Estimated Need (DIME)</span><strong>${fmtMoney(m.dimeNeed)}</strong></div>
      <div class="stat-row"><span>Current Coverage</span><strong>${fmtMoney(m.currentCoverage)}</strong></div>
      ${gapRow}
    </div>
    ${
      m.coveragePct == null
        ? ""
        : statBar(`Coverage: ${m.coveragePct}% of estimated need`, Math.min(m.coveragePct, 100), m.coveragePct >= 100 ? "#6BAA75" : m.coveragePct >= 60 ? "#F2A65A" : "#C0392B")
    }
    ${m.underinsured ? `<p class="result-flag">Current coverage is ${fmtMoney(m.gap)} short of the DIME estimate — a term policy quote is worth reviewing.</p>` : ""}`;
}

function renderCoverageResult(m) {
  const rows = COVERAGE_LINES.map(([key, label]) => {
    const line = (m.lines && m.lines[key]) || {};
    return { label, status: line.status, detail: line.amount != null ? fmtMoney(line.amount) : "" };
  });
  const gaps = m.gaps || [];
  const otherGaps = gaps.filter((k) => k !== "disability" && k !== "umbrella").map((k) => COVERAGE_LINE_LABELS[k] || k);
  return `
    ${checklistRows(rows)}
    ${statBar(`Coverage Lines in Place: ${m.coveredCount} of ${COVERAGE_LINES.length}`, (m.coveredCount / COVERAGE_LINES.length) * 100, m.coveredCount >= 4 ? "#6BAA75" : m.coveredCount >= 2 ? "#F2A65A" : "#C0392B")}
    ${gaps.includes("disability") ? `<p class="result-flag">No disability insurance — future income is most families' largest asset, and it's the one most often left unprotected.</p>` : ""}
    ${gaps.includes("umbrella") ? `<p class="result-flag">No umbrella liability policy — inexpensive protection against lawsuits and large claims.</p>` : ""}
    ${otherGaps.length ? `<p class="result-flag">Other coverage gaps to review: ${escapeHtml(otherGaps.join(", "))}.</p>` : ""}`;
}

function renderLtcResult(m) {
  return `
    <p class="headline-stat">LTC Readiness: <strong>${escapeHtml(m.readiness)}</strong></p>
    <div class="stat-rows">
      <div class="stat-row"><span>Age Band</span><strong>${escapeHtml(LTC_AGE_LABELS[m.ageBand] || m.ageBand)}</strong></div>
      <div class="stat-row"><span>Family History of LTC Needs</span><strong>${escapeHtml(YES_NO_UNSURE_LABELS[m.familyHistory] || m.familyHistory)}</strong></div>
      <div class="stat-row"><span>Funding Plan</span><strong>${escapeHtml(LTC_FUNDING_LABELS[m.fundingPlan] || m.fundingPlan)}</strong></div>
      <div class="stat-row"><span>Assets Earmarked for Care</span><strong>${m.assetsEarmarked === "yes" ? "Yes" : "No"}</strong></div>
    </div>
    ${m.timelyFlag ? `<p class="result-flag">No long-term care plan yet at an age where options are best — the prime LTC planning window is roughly ages 50–65.</p>` : ""}
    <p class="result-note">Roughly 70% of people over 65 will need some form of long-term care during their lives.</p>`;
}

// ---------- Category structure (home hub) ----------

const CATEGORY_MODULES = [
  {
    key: "spending",
    title: "Spending Habits Review",
    description: "Break your monthly spending into essentials and discretionary to see where the money actually goes.",
    category: "budgeting",
    renderResult: renderSpendingResult,
  },
  {
    key: "savings",
    title: "Emergency Fund & Savings Goals",
    description: "Measure your emergency fund against a target and map the path to fully funded.",
    category: "budgeting",
    renderResult: renderSavingsResult,
  },
  {
    key: "debt",
    title: "Debt Management Review",
    description: "List balances and rates so your advisor can prioritize the smartest payoff order.",
    category: "budgeting",
    renderResult: renderDebtResult,
  },
  {
    key: "riskcapacity",
    title: "Risk Capacity Analysis",
    description: "Five questions about your finances that measure how much risk your situation can absorb.",
    category: "riskassessment",
    renderResult: renderRiskCapacityResult,
  },
  {
    key: "behavior",
    title: "Investor Behavior Profile",
    description: "How you react when markets move — the habits that shape real-world returns.",
    category: "riskassessment",
    renderResult: renderBehaviorResult,
  },
  {
    key: "knowledge",
    title: "Investment Knowledge & Experience",
    description: "Your investing background and comfort level, so advice lands at the right depth.",
    category: "riskassessment",
    renderResult: renderKnowledgeResult,
  },
  {
    key: "estatedocs",
    title: "Estate Document Checklist",
    description: "A quick checklist of the five core estate documents and when they were last updated.",
    category: "estate",
    renderResult: renderEstateDocsResult,
  },
  {
    key: "beneficiaries",
    title: "Beneficiary & Titling Review",
    description: "Confirm the right people are named on your accounts and policies — designations override wills.",
    category: "estate",
    renderResult: renderBeneficiariesResult,
  },
  {
    key: "legacy",
    title: "Legacy & Gifting Goals",
    description: "Charitable, gifting, and family goals that shape how your estate plan is structured.",
    category: "estate",
    renderResult: renderLegacyResult,
  },
  {
    key: "lifeinsurance",
    title: "Life Insurance Needs (DIME)",
    description: "A quick DIME estimate of how much life insurance your family would need.",
    category: "insurance",
    renderResult: renderLifeInsuranceResult,
  },
  {
    key: "coverage",
    title: "Insurance Coverage Inventory",
    description: "An inventory of your insurance lines to spot gaps in your protection.",
    category: "insurance",
    renderResult: renderCoverageResult,
  },
  {
    key: "ltc",
    title: "Long-Term Care Readiness",
    description: "Where you stand on planning for long-term care costs later in life.",
    category: "insurance",
    renderResult: renderLtcResult,
  },
];

const CATEGORIES = [
  {
    key: "onboarding",
    title: "Onboarding",
    description: "Start here — the Financial Picture Analysis and the guided New Client Onboarding every new client completes.",
    type: "onboarding",
  },
  {
    key: "budgeting",
    title: "Budgeting & Spending",
    description: "Spending habits, emergency savings, and debt — the cash-flow foundation of your plan.",
    type: "modules",
    moduleKeys: ["spending", "savings", "debt"],
  },
  {
    key: "riskassessment",
    title: "Risk Assessment",
    description: "A deeper look at your capacity, behavior, and experience with investment risk.",
    type: "modules",
    moduleKeys: ["riskcapacity", "behavior", "knowledge"],
  },
  {
    key: "estate",
    title: "Estate Planning",
    description: "Documents, beneficiaries, and legacy goals — making sure your wishes are carried out.",
    type: "modules",
    moduleKeys: ["estatedocs", "beneficiaries", "legacy"],
  },
  {
    key: "insurance",
    title: "Insurance Planning",
    description: "Life, disability, liability, and long-term care — protecting the plan against what can go wrong.",
    type: "modules",
    moduleKeys: ["lifeinsurance", "coverage", "ltc"],
  },
];
