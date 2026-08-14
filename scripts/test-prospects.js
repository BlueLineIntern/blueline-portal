// Behavioural tests for the Clients / Prospects split on the Contacts page.
//
// Two things are worth pinning down here, and neither is visible from reading
// one file:
//
//   1. The segment is a FILTER over one contact list, not a second store. Every
//      person must appear on exactly one side of the toggle, and the counts must
//      add up — a person who falls through both filters is invisible in the app
//      with nothing to indicate they exist.
//   2. The prospect Additional Info fields are declared in three places
//      (contacts.html for the form, worker.js for validation, dev-server.ps1 for
//      the local mock). A key registered in the UI but not on the server is
//      silently truncated to 0 chars or rejected on every save.
//
// Same approach as test-household-sync.js: pull the real functions out of the
// shipped source and run them, rather than restating the logic here where it
// could agree with itself while disagreeing with the app.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/admin/contacts.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
const mock = fs.readFileSync(path.join(root, 'dev-server.ps1'), 'utf8');

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed += 1;
  console.log(`PASS  ${message}`);
}

function extract(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('could not find ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

// ---------- 1. The segment split ----------

// visibleRecords() reads page state (segment, searchText, typeFilter, …) and
// two collections. Declared here as the globals it expects, then the real
// function is evaluated against them.
const scope = {
  segment: 'clients', searchText: '', typeFilter: 'all', showArchived: false,
  activeTags: new Set(), allContacts: [], allHouseholds: [],
};
const helpers = ['isProspect', 'contactMatches', 'householdMatches', 'matchesTags', 'groupKind', 'groupsForEmail']
  .map((n) => extract(html, n)).join('\n');
const visibleRecords = new Function(`
  ${Object.keys(scope).map((k) => `let ${k};`).join(' ')}
  ${helpers}
  ${extract(html, 'visibleRecords')}
  return { visibleRecords, set: (s) => { ${Object.keys(scope).map((k) => `${k} = s.${k};`).join(' ')} } };
`)();

const roster = [
  { email: 'active@example.com', name: 'Ada Client', status: 'active', tags: [] },
  { email: 'onb@example.com', name: 'Ben Onboarding', status: 'onboarding', tags: [] },
  { email: 'inactive@example.com', name: 'Cara Inactive', status: 'inactive', tags: [] },
  { email: 'lead@example.com', name: 'Dev Lead', status: 'prospect', tags: [] },
  { email: 'lead2@example.com', name: 'Eve Lead', status: 'prospect', tags: [] },
  // A portal account that never got a CRM record: worker.js's merge defaults it
  // to 'prospect', so an absent status must read the same way here.
  { email: 'nostatus@example.com', name: 'Fay Unknown', tags: [] },
  { email: 'gone@example.com', name: 'Gus Archived', status: 'active', archived: true, tags: [] },
];
const households = [
  { id: 'hh-1', kind: 'family', name: 'Smith Family', tags: [],
    members: [{ email: 'active@example.com', role: 'head' }, { email: 'lead@example.com', role: 'spouse' }] },
];

function run(overrides) {
  visibleRecords.set({ ...scope, allContacts: roster, allHouseholds: households, ...overrides });
  return visibleRecords.visibleRecords();
}

const clients = run({ segment: 'clients' });
const prospects = run({ segment: 'prospects' });

check(prospects.loose.map((c) => c.email).sort().join(',')
  === 'lead2@example.com,lead@example.com,nostatus@example.com',
  'Prospects lists every prospect, including a record with no status at all');
check(!clients.loose.some((c) => c.email === 'lead2@example.com'),
  'a prospect is not listed as a top-level client');
check(clients.loose.map((c) => c.email).sort().join(',') === 'inactive@example.com,onb@example.com',
  'Clients lists onboarding and inactive people, and excludes the archived one');
check(prospects.groups.length === 0 && clients.groups.length === 1,
  'families and companies appear on the Clients side only');
check(clients.people.some((c) => c.email === 'lead@example.com'),
  'a prospect who belongs to a family still renders nested under it, like an archived member');

// The invariant that makes this a split rather than two filters that can both
// miss: nobody falls through. Reachability is checked against `people` (records
// in view) rather than `loose`, because a client who belongs to a family is
// reached by expanding that family, not as a top-level row.
const reachable = new Set([...clients.people, ...prospects.people].map((c) => c.email));
const live = roster.filter((c) => !c.archived).map((c) => c.email);
check(live.every((e) => reachable.has(e)),
  'no non-archived person is invisible on both sides of the toggle');

// The one deliberate overlap: a prospect inside a family is listed as a prospect
// AND stays on the family's roster, exactly as an archived member does. Every
// other person belongs to one side only.
const onBoth = live.filter((e) => prospects.people.some((c) => c.email === e)
  && clients.people.some((c) => c.email === e));
check(onBoth.join(',') === 'lead@example.com',
  'the only people on both sides are prospects who belong to a family or company');

check(run({ segment: 'prospects', showArchived: true }).loose.length === 0
  && run({ segment: 'clients', showArchived: true }).loose.map((c) => c.email).join(',') === 'gone@example.com',
  'the archived toggle stays scoped to the segment on screen');

// The type filter is a clients-side control that is hidden, not reset, when the
// toggle flips — leaving it on Families used to empty the Prospects list.
check(run({ segment: 'prospects', typeFilter: 'families' }).loose.length === 3,
  'a stale "Families" type filter does not empty the Prospects list');

check(run({ segment: 'prospects', searchText: 'Eve' }).loose.map((c) => c.email).join(',') === 'lead2@example.com',
  'search narrows within the segment');
check(run({ segment: 'clients', searchText: 'Eve' }).loose.length === 0,
  'search on the Clients side does not reach across into prospects');

// ---------- 2. Prospect Additional Info round-trips ----------

const sectionSrc = html.slice(html.indexOf('const PROSPECT_AI_SECTIONS'), html.indexOf('function aiSectionsFor'));
const uiFields = [...sectionSrc.matchAll(/\['(\w+)', '[^']*', '(\w+)'\]/g)].map((m) => ({ key: m[1], type: m[2] }));
check(uiFields.length > 30, `the prospect form declares its fields (${uiFields.length} found)`);

const CLIENT_INFO_ENUMS = eval('(' + worker.slice(worker.indexOf('{', worker.indexOf('const CLIENT_INFO_ENUMS')), worker.indexOf('\n};', worker.indexOf('const CLIENT_INFO_ENUMS')) + 2) + ')');
const CLIENT_INFO_DATES = eval(worker.match(/const CLIENT_INFO_DATES = (\[[\s\S]*?\]);/)[1]);
const CLIENT_INFO_MONEY = eval(worker.match(/const CLIENT_INFO_MONEY = (\[[\s\S]*?\]);/)[1]);
const CLIENT_INFO_TEXT = eval('(' + worker.slice(worker.indexOf('{', worker.indexOf('const CLIENT_INFO_TEXT')), worker.indexOf('\n};', worker.indexOf('const CLIENT_INFO_TEXT')) + 2) + ')');
const sanitizeClientInfo = eval('(' + extract(worker, 'sanitizeClientInfo') + ')');

const bucketOf = (k) => (CLIENT_INFO_DATES.includes(k) ? 'date'
  : CLIENT_INFO_MONEY.includes(k) ? 'money'
    : CLIENT_INFO_ENUMS[k] ? 'select'
      : CLIENT_INFO_TEXT[k] ? 'text' : null);

const unregistered = uiFields.filter((f) => bucketOf(f.key) === null);
check(unregistered.length === 0,
  `every prospect field the form can submit is validated by worker.js${unregistered.length ? ` (missing: ${unregistered.map((f) => f.key).join(', ')})` : ''}`);

const mistyped = uiFields.filter((f) => bucketOf(f.key) !== (f.type === 'longtext' ? 'text' : f.type));
check(mistyped.length === 0,
  `each prospect field is validated as the type the form renders${mistyped.length ? ` (${mistyped.map((f) => `${f.key}: form=${f.type} worker=${bucketOf(f.key)}`).join('; ')})` : ''}`);

// No key may mean one thing on a prospect and another on a client: the two
// blocks share a single clientinfo:<email> record, so a collision would have one
// silently overwrite the other when a prospect converts.
const clientSectionSrc = html.slice(html.indexOf('const AI_SECTIONS'), html.indexOf('const PROSPECT_AI_SECTIONS'));
const clientKeys = new Set([...clientSectionSrc.matchAll(/\['(\w+)', '[^']*', '\w+'\]/g)].map((m) => m[1]));
const collisions = uiFields.filter((f) => clientKeys.has(f.key));
check(collisions.length === 0,
  `prospect and client field names are disjoint in the shared record${collisions.length ? ` (${collisions.map((f) => f.key).join(', ')})` : ''}`);

// A real save, through the real validator.
const saved = sanitizeClientInfo({
  pipelineStage: 'Proposal Delivered',
  prospectRating: 'A - High priority',
  expectedCloseDate: '2026-09-30',
  nextStep: 'Send the fee comparison',
  estimatedInvestableAssets: '$1,250,000',
  leadSource: 'Client Referral',
  reasonForChange: 'Unhappy with responsiveness at current firm.',
});
check(!saved.error, 'a filled-in prospect pipeline saves without error');
check(saved.fields.estimatedInvestableAssets === 1250000,
  'a prospect money figure is parsed out of "$1,250,000" into a number');
check(saved.fields.expectedCloseDate === '2026-09-30' && saved.fields.nextStep === 'Send the fee comparison',
  'prospect dates and free text survive the round trip');

check(sanitizeClientInfo({ pipelineStage: 'Closed - Won' }).error,
  'a pipeline stage outside the list is rejected rather than stored');
check(sanitizeClientInfo({ expectedCloseDate: '2026-9' }).error,
  'a half-typed prospect date is rejected, like the client dates');
check(!sanitizeClientInfo({ pipelineStage: '' }).error,
  'clearing a prospect select back to Not Set is allowed');

// Converting is a status change on the contact record and nothing else, so the
// suitability answers a client already has must still validate alongside the
// pipeline history that got them there.
const mixed = sanitizeClientInfo({ pipelineStage: 'Verbal Commitment', riskTolerance: 'Moderate', assets: 500000 });
check(!mixed.error && mixed.fields.pipelineStage === 'Verbal Commitment' && mixed.fields.riskTolerance === 'Moderate',
  'prospect and client answers coexist in one record, so converting loses nothing');

// ---------- 3. The local mock agrees with the worker ----------

const mockEnumBlock = mock.slice(mock.indexOf('$clientInfoEnums = @{'), mock.indexOf('\n}', mock.indexOf('$clientInfoEnums = @{')));
const mockDates = mock.slice(mock.indexOf('$clientInfoDates = @('), mock.indexOf(')', mock.indexOf("'outcomeDate'")));
const mockMoney = mock.slice(mock.indexOf('$clientInfoMoney = @('), mock.indexOf(')', mock.indexOf("'estimatedAnnualRevenue'")));

const prospectEnumKeys = Object.keys(CLIENT_INFO_ENUMS).filter((k) => !clientKeys.has(k) && uiFields.some((f) => f.key === k));
const enumDrift = prospectEnumKeys.filter((k) => {
  const m = mockEnumBlock.match(new RegExp(`${k} = @\\(([\\s\\S]*?)\\)`));
  if (!m) return true;
  const got = (m[1].match(/'[^']*'/g) || []).map((s) => s.slice(1, -1));
  return JSON.stringify(got) !== JSON.stringify(CLIENT_INFO_ENUMS[k].filter(Boolean));
});
check(enumDrift.length === 0,
  `dev-server.ps1 accepts exactly the prospect options worker.js does${enumDrift.length ? ` (drifted: ${enumDrift.join(', ')})` : ''}`);

const dateDrift = uiFields.filter((f) => f.type === 'date' && !mockDates.includes(`'${f.key}'`));
const moneyDrift = uiFields.filter((f) => f.type === 'money' && !mockMoney.includes(`'${f.key}'`));
check(dateDrift.length === 0 && moneyDrift.length === 0,
  `dev-server.ps1 validates the prospect dates and money fields too${dateDrift.concat(moneyDrift).length ? ` (missing: ${dateDrift.concat(moneyDrift).map((f) => f.key).join(', ')})` : ''}`);

// ---------- 4. Prospect is gone from the client form ----------

const modal = html.slice(html.indexOf('<select id="cm-status">'), html.indexOf('</select>', html.indexOf('<select id="cm-status">')));
check(!modal.includes('value="prospect"'),
  'Prospect is no longer selectable as a status in the client contact form');
check(worker.includes("const CONTACT_STATUSES = ['prospect', 'onboarding', 'active', 'inactive'];"),
  "'prospect' remains a valid stored status — the form dropped it, the data model did not");

// ---------- 5. Linking a task to a prospect (Operations) ----------

const ops = fs.readFileSync(path.join(root, 'public/admin/operations.html'), 'utf8');

// The real functions from operations.html, over a tiny DOM stand-in. `select`
// and `optgroup` are the only elements fillContactSelect touches.
const opsScope = new Function(`
  let allContacts = [];
  const escapeHtml = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const SELECTS = {};
  const document = { getElementById: (id) => SELECTS[id] };
  ${extract(ops, 'contactIsProspect')}
  ${extract(ops, 'fillContactSelect')}
  return {
    setContacts: (c) => { allContacts = c; },
    contactIsProspect,
    fill: (current) => {
      SELECTS.sel = {
        innerHTML: '', value: '',
        querySelector: () => ({ outerHTML: '<option value="">— none —</option>' }),
      };
      fillContactSelect('sel', current);
      return SELECTS.sel;
    },
  };
`)();

opsScope.setContacts([
  { email: 'ada@example.com', name: 'Ada Whitfield', status: 'active' },
  { email: 'ben@example.com', name: 'Ben Ortiz', status: 'onboarding' },
  { email: 'dev@example.com', name: 'Dev Lindqvist', status: 'prospect' },
  { email: 'fay@example.com', name: 'Fay Osei' }, // no status: a portal account with no CRM record
]);

check(opsScope.contactIsProspect('dev@example.com') === true
  && opsScope.contactIsProspect('fay@example.com') === true,
  'Operations reads a prospect (and a status-less record) the same way the Contacts page does');
check(opsScope.contactIsProspect('ada@example.com') === false
  && opsScope.contactIsProspect('ben@example.com') === false,
  'a client is not treated as a prospect on a task');

// The bug this pins: a task pointing at an email the page cannot see must NOT
// borrow the "no status means prospect" default. Archived, deleted, or in
// another workspace is unknown — badging it Prospect asserts something about a
// record this page never loaded.
check(opsScope.contactIsProspect('ghost@example.com') === false,
  'a task pointing at a contact this page cannot see is not labelled a prospect');

const filled = opsScope.fill('');
check(/<optgroup label="Clients">[\s\S]*Ada Whitfield[\s\S]*Ben Ortiz[\s\S]*<\/optgroup>/.test(filled.innerHTML),
  'the related-contact picker groups clients under a Clients optgroup');
check(/<optgroup label="Prospects">[\s\S]*Dev Lindqvist[\s\S]*Fay Osei[\s\S]*<\/optgroup>/.test(filled.innerHTML),
  'prospects are selectable on a task, under their own Prospects optgroup');
check(filled.innerHTML.indexOf('label="Clients"') < filled.innerHTML.indexOf('label="Prospects"'),
  'Clients comes before Prospects in the picker');

// Same rule fillSelect already documents: a value that has fallen out of range
// stays visible, or `sel.value = current` silently fails and the control resets
// — which on a filter quietly widens the view and in the drawer misreports the
// task's contact.
const orphan = opsScope.fill('ghost@example.com');
check(orphan.innerHTML.includes('ghost@example.com (unavailable)') && orphan.value === 'ghost@example.com',
  "a task's contact that is no longer listed is kept as an explicit (unavailable) option");

const known = opsScope.fill('dev@example.com');
check(!known.innerHTML.includes('(unavailable)') && known.value === 'dev@example.com',
  'a contact that IS listed is selected without a duplicate option');

check(ops.includes("fillContactSelect('filter-client'") && ops.includes("fillContactSelect('d-client'"),
  'both the task drawer and the list filter use the grouped picker');

console.log(`\n${passed} prospect checks passed`);
