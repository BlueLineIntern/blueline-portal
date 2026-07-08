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
