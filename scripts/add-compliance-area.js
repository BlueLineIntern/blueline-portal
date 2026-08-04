// One-off migration: stamp complianceArea onto every row of compliance-seed.js,
// and normalise frequency into a filterable value while preserving the original
// wording as frequencyDetail.
//
// Classification is BY ITEM NAME, not by id: a recurring obligation appears as
// several dated rows sharing a name, and they must all land in the same area.
// Stored on the row rather than derived at render time, per the requirement
// that areas not be recomputed from keywords on every page load.
const fs = require('fs');
const path = require('path');

const AREA = {
  'Governance & Regulatory': [
    'IAR and firm registration status review',
    'Form 13F filing',
    'Form N-PX data gathering and filing',
    'Firm-wide annual risk assessment (conflicts inventory, key-person risk, succession readiness)',
    'Annual Compliance Manual review (Rule 206(4)-7)',
    'Mock regulatory exam / document-request readiness review',
    'Large trader status screening (Rule 13h-1)',
    'Books and records systems review',
    'FINRA Entitlement User Accounts Certification',
    'Corporate records / organizational document review',
    'Confidentiality/severance agreement whistleblower-protection review',
    'Form ADV Annual Updating Amendment',
    'Firm Brochure / summary of material changes delivery',
    'Form CRS review for consistency with Form ADV',
    'AML program adoption, officer designation, initial staff training',
    'AML program full compliance date',
  ],
  'Trading & Investments': [
    'Valuation risk assessment (independent-source testing)',
    'Trade blotter review',
    'Trading activity review for manipulative-trading patterns',
    'Trade error log review',
    'Restricted list / watch list maintenance check',
    'Best execution / broker-dealer review',
    'Aggregation and allocation fairness testing',
    'Securities valuation review (stale/incorrect pricing)',
    'Digital assets policy compliance review',
    'Proxy voting policy compliance confirmation',
    'Principal trading policy compliance review',
    'Soft dollar policy compliance confirmation',
    'Third-party manager annual review',
  ],
  'Fees & Client Accounts': [
    'Quarterly fee and billing review',
    'Invoice/billing risk assessment (sample testing for overbilling)',
    'Supervisory review of client relationships and portfolios',
    'Advisory agreement and fee schedule disclosure consistency review',
    'Mutual fund share class and billing invoice review',
    'Custody / Form ADV custody disclosure review',
    'Inadvertent-custody check',
    'Complaint log review',
    'Corporate action / class action notice handling review',
    'Wrap fee program non-participation confirmation',
  ],
  'Marketing & Communications': [
    'Marketing material review against SEC Marketing Rule (sample testing)',
    'Website content archiving (snapshot each version as advertising/recordkeeping)',
    'Email and electronic communications review (incl. off-channel monitoring)',
    'Social media account inventory and content review',
    'Testimonial/endorsement disclosure and promoter due diligence check',
    'Performance-information prohibition confirmation',
    'Solicitor/promoter compensation disclosure review',
    'ESG disclosure accuracy review',
  ],
  'Personnel & Ethics': [
    'Preclearance log review (IPOs, private placements, margin accounts)',
    'Quarterly access person transaction report collection',
    'Annual Code of Ethics review',
    'Custodian/clearing report review and personnel monitoring',
    'Gifts and entertainment log review',
    'Political contribution attestation (covered associates)',
    'Outside business activity annual confirmation',
    'Continuing education monitoring',
    'Master Compliance Attestation Form collection (all staff)',
    'Remote office supervision review (all staff, incl. CCO designees)',
    'Annual compliance meeting and staff training',
    'Annual identification and notification of reporting persons',
    'Annual access person holdings report collection',
  ],
  'Technology, Privacy & Resilience': [
    'Cybersecurity committee meeting',
    'Annual BCP review',
    'Annual Cybersecurity Policy review and approval',
    'Annual AI Acceptable Use Policy review',
    'E&O and cyber insurance coverage adequacy review',
    'Annual cybersecurity testing',
    'Annual cybersecurity risk assessment',
    'Annual technology and staff device inventory',
    'Annual data back-up confirmation',
    'Cybersecurity awareness training',
    'GenAI controls effectiveness review',
    'GenAI platform training',
    'Reg S-ID covered-accounts determination reassessment',
    'Privacy Notice accuracy and delivery-exception review',
    'NPI safeguarding spot-check (access logs, encryption, disposal)',
    'Annual vendor due diligence review',
    'Cloud computing policy compliance review',
    'Electronic signature attestation and authentication log review',
    'Vendor Compliance Package completion tracking',
    'BCP tabletop exercise / disaster recovery test',
  ],
};

const byItem = new Map();
for (const [area, items] of Object.entries(AREA)) {
  for (const it of items) {
    if (byItem.has(it)) throw new Error(`"${it}" classified twice`);
    byItem.set(it, area);
  }
}

// "One-time: target Q3 2027" -> One-time; "Ongoing / target Dec 2026" -> Ongoing.
// The full wording survives as frequencyDetail so a target date isn't lost.
function normaliseFrequency(raw) {
  const s = String(raw || '').trim();
  const l = s.toLowerCase();
  if (l.startsWith('one-time') || l.startsWith('one time')) return 'One-time';
  if (l.startsWith('ongoing')) return 'Ongoing';
  if (l.startsWith('quarterly')) return 'Quarterly';
  if (l.startsWith('annual')) return 'Annual';
  if (l.startsWith('semi-annual')) return 'Semi-annual';
  if (l.startsWith('monthly')) return 'Monthly';
  if (l.startsWith('weekly')) return 'Weekly';
  return s || 'One-time';
}

const file = path.join(__dirname, '..', 'compliance-seed.js');
const src = fs.readFileSync(file, 'utf8');
const start = src.indexOf('[');
const end = src.lastIndexOf(']');
const rows = JSON.parse(src.slice(start, end + 1));

const missing = [];
const out = rows.map((r) => {
  const area = byItem.get(r.item);
  if (!area) missing.push(r.item);
  const freq = normaliseFrequency(r.frequency);
  const rebuilt = {
    id: r.id,
    dueDate: r.dueDate,
    item: r.item,
    whatToDo: r.whatToDo,
    frequency: freq,
    // Only kept when it actually says more than the normalised value does.
    frequencyDetail: freq === String(r.frequency).trim() ? '' : String(r.frequency).trim(),
    complianceArea: area || '',
    source: r.source,
    // Replaces the mandated boolean. "Best practice" is not "No": the firm
    // still elects to do it, it just isn't externally mandated.
    requirement: r.mandated ? 'Required' : 'Best practice',
    owner: r.owner,
    reviewer: r.reviewer,
    notes: r.notes || '',
  };
  return rebuilt;
});

if (missing.length) {
  console.error('UNCLASSIFIED items — refusing to write:');
  [...new Set(missing)].forEach((m) => console.error('  ' + m));
  process.exit(1);
}

const header = src.slice(0, start);
const body = out.map((r) => '  ' + JSON.stringify(r)).join(',\n');
fs.writeFileSync(file, `${header}[\n${body}\n];\n`);

const counts = {};
out.forEach((r) => { counts[r.complianceArea] = (counts[r.complianceArea] || 0) + 1; });
console.log('rows written:', out.length);
console.log('every row has an area:', out.every((r) => r.complianceArea));
console.log('\nby area:');
Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
const freqs = {};
out.forEach((r) => { freqs[r.frequency] = (freqs[r.frequency] || 0) + 1; });
console.log('\nnormalised frequency:', JSON.stringify(freqs));
console.log('rows keeping a frequencyDetail:', out.filter((r) => r.frequencyDetail).length);
