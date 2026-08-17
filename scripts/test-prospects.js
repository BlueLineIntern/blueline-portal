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
// categoryFilter defaults to 'hnw', matching the page. Every fixture below is
// uncategorised, which contactCategory() reads as 'hnw' — so the segment
// assertions in this section exercise the split, not the lens. The lens gets its
// own fixtures in section 13.
const scope = {
  segment: 'clients', searchText: '', typeFilter: 'all', showArchived: false,
  categoryFilter: 'hnw', activeTags: new Set(), allContacts: [], allHouseholds: [],
};
const helpers = ['isProspect', 'contactCategory', 'groupCategory', 'contactMatches',
  'householdMatches', 'matchesTags', 'groupKind', 'groupsForEmail']
  .map((n) => extract(html, n)).join('\n');
const visibleRecords = new Function(`
  const CONTACT_CATEGORIES = ['hnw', 'business', 'vendor'];
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

// ---------- 6. Home's "Related To" is grouped the same way ----------

const home = fs.readFileSync(path.join(root, 'public/admin/index.html'), 'utf8');
const fillPickers = home.slice(home.indexOf('function fillPickers'), home.indexOf('const assignee = document.getElementById'));

check(/optgroup label="\$\{escapeHtml\(label\)\}"/.test(fillPickers)
  && fillPickers.includes("group('Clients', clients)") && fillPickers.includes("group('Prospects', prospects)"),
  "Home's Related To fields split into Clients and Prospects optgroups");
check(fillPickers.includes("(c.status || 'prospect') === 'prospect'"),
  'Home classifies a status-less contact as a prospect, same as everywhere else');
check(fillPickers.includes('(unavailable)'),
  "a task related to a since-archived contact keeps them listed on Home rather than silently re-pointing the form");

// ---------- 7. The searchable picker ----------

const sharedJs = fs.readFileSync(path.join(root, 'public/admin/shared.js'), 'utf8');
check(sharedJs.includes('function initContactPicker('),
  'the searchable contact picker lives in shared.js, so all three pages get one implementation');

// The <select> staying put is what keeps every existing `.value` read and
// boot-time change listener working. If a future edit replaces the element
// instead, Operations' FILTER_CONTROLS bindings silently stop firing.
const picker = extract(sharedJs, 'initContactPicker');
check(picker.includes("sel.dispatchEvent(new Event('change', { bubbles: true }))"),
  'picking a contact dispatches change on the original select, so existing listeners still fire');
check(picker.includes('wrap.appendChild(sel)') && !/sel\.remove\(\)|removeChild\(sel\)/.test(picker),
  'the picker keeps the <select> in the DOM as the value carrier rather than replacing it');
check(picker.includes('new MutationObserver'),
  'the picker re-syncs itself when the options are rebuilt, so callers never have to refresh it');
check(picker.includes("label.setAttribute('for', input.id)"),
  "the field's label is re-pointed at the search box, not left on the hidden select");
check(/if \(!c\) return false/.test(extract(ops, 'contactIsProspect')),
  'the unknown-contact guard is still in place after the picker rework');

for (const [file, src] of [['index.html', home], ['operations.html', ops], ['calendar.html', fs.readFileSync(path.join(root, 'public/admin/calendar.html'), 'utf8')]]) {
  check(src.includes('initContactPicker('), `${file} attaches the searchable picker`);
}

// shared.js/shared.css are cache-busted by query string; a bump that misses a
// page serves it the old picker-less copy against the new markup.
const adminPages = fs.readdirSync(path.join(root, 'public/admin')).filter((f) => f.endsWith('.html') && f !== 'tasks.html');
const versions = new Set();
adminPages.forEach((f) => {
  const src = fs.readFileSync(path.join(root, 'public/admin', f), 'utf8');
  (src.match(/shared\.(?:js|css)\?v=([\w-]+)/g) || []).forEach((v) => versions.add(v.split('=')[1]));
});
check(versions.size === 1,
  `every admin page requests the same shared.js/shared.css version (${[...versions].join(', ')})`);

// ---------- 8. Date-only dues parse as LOCAL midnight ----------
//
// The bug this pins: `new Date('2026-08-14')` is UTC midnight, which in every US
// timezone is the evening BEFORE. Date-only dues are the common case (Home's
// Today/Tomorrow/In-a-week picker and both quick-add forms produce them), so a
// task set to "due today" reported "Overdue - <yesterday>" and sat on the wrong
// day of the calendar.
const parseDue = eval('(' + extract(sharedJs, 'parseDue') + ')');
const dueMeta = new Function(`
  ${extract(sharedJs, 'parseDue')}
  ${extract(sharedJs, 'isSameLocalDay')}
  ${extract(sharedJs, 'dueMeta')}
  return dueMeta;
`)();

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const parsed = parseDue(todayStr);
check(parsed.getFullYear() === now.getFullYear() && parsed.getMonth() === now.getMonth()
  && parsed.getDate() === now.getDate() && parsed.getHours() === 0,
  'a date-only due parses as local midnight on that calendar day, not UTC midnight');

const todayMeta = dueMeta({ due: todayStr, status: 'open' });
check(todayMeta.today === true && todayMeta.overdue === false,
  'a task due today with a date-only due reads as "due today", not overdue');

const timed = dueMeta({ due: `${todayStr}T14:00`, status: 'open' });
check(timed.today === true, 'a due that carries a time still parses normally');
check(dueMeta({ due: 'not-a-date', status: 'open' }).state === 'none',
  'an unparseable due still degrades to no-due rather than throwing');

check(!/new Date\((?:t|task|a|b|x)\.due\)/.test(sharedJs + ops + home + fs.readFileSync(path.join(root, 'public/admin/calendar.html'), 'utf8')),
  'no admin page parses a task due with a bare new Date() any more');

// ---------- 9. Calendar sources ----------

const cal = fs.readFileSync(path.join(root, 'public/admin/calendar.html'), 'utf8');

check(cal.includes("id=\"src-ops\"") && cal.includes("id=\"src-compliance\""),
  'the calendar offers an Operational tasks and a Compliance checkbox');
check(cal.includes("api('/api/admin/compliance').catch(() => null)"),
  'compliance is additive: it can 403 or fail without stopping the meetings from rendering');
check(cal.includes('complianceAvailable = !!cmpData'),
  'a compliance failure marks the source unavailable rather than showing an empty toggle');
check(cal.includes("document.getElementById('src-compliance-wrap').classList.toggle('hidden', !complianceAvailable)"),
  'the Compliance checkbox is hidden outside the workspace that can read it');

// A compliance chip carries data-cmp, never data-id. The body's click delegation
// sends data-id into openDrawerEdit(), which looks the id up in allTasks — a
// compliance id would find nothing and the click would silently do nothing.
const cmpChip = cal.slice(cal.indexOf('function complianceChipHtml'), cal.indexOf('function chipHtml'));
check(cmpChip.includes('data-cmp=') && !cmpChip.includes('data-id='),
  'compliance chips are tagged data-cmp so they never fall into the meeting drawer');
check(cal.indexOf("closest('[data-cmp]')") < cal.indexOf("closest('[data-id]')"),
  'the click handler checks data-cmp before data-id');
check(cal.includes('/admin/compliance.html?item='),
  'a compliance chip hands off to the Compliance page rather than opening the meeting drawer');
check(fs.readFileSync(path.join(root, 'public/admin/compliance.html'), 'utf8').includes("new URLSearchParams(location.search).get('item')"),
  'the Compliance page honours ?item= so that hand-off lands on the right record');

// Date-only again, this time on the compliance side: same trap, same fix.
check(extract(cal, 'complianceAsEvent').includes('new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))'),
  'a compliance dueDate is parsed from its parts, so it lands on the right day too');

check(cal.includes('SOURCE_KEY') && cal.includes('localStorage.setItem(SOURCE_KEY'),
  'the source choice persists per admin');
check(cal.includes('NO_SOURCES_MSG'),
  'switching both sources off explains itself rather than rendering an empty grid');

// ---------- 10. Compliance -> Outlook ----------

const complianceOutlook = new Function(`
  const FRANK_ADMIN_EMAIL = 'fsabin@blueline-advisors.com';
  const JENN_ADMIN_EMAIL = 'jyoung@blueline-advisors.com';
  const OUTLOOK_DEFAULT_DURATION_MIN = 60;
  ${extract(worker, 'outlookTimeZone')}
  const OUTLOOK_DEFAULT_TIMEZONE = 'Eastern Standard Time';
  ${worker.match(/const COMPLIANCE_MAILBOX = \{[\s\S]*?\n\};/)[0]}
  ${/* Sourced from worker.js so the function runs, while the assertions below
       stay hardcoded to 06:00 — changing the slot SHOULD fail this suite. */
    worker.match(/const COMPLIANCE_OUTLOOK_TIME = '[^']*';/)[0]}
  ${extract(worker, 'complianceMailboxFor')}
  ${extract(worker, 'complianceReviewerRequired')}
  ${extract(worker, 'complianceSignedOff')}
  ${extract(worker, 'complianceStatus')}
  ${extract(worker, 'complianceCalendarOwners')}
  ${extract(worker, 'outlookEventTimes')}
  ${extract(worker, 'outlookEventBody')}
  ${extract(worker, 'complianceOutlookPayload')}
  ${extract(worker, 'complianceOutlookEvents')}
  return { complianceCalendarOwners, complianceOutlookPayload, complianceOutlookEvents, complianceStatus };
`)();

const openItem = {
  id: 'c001', dueDate: '2026-09-30', item: 'Quarterly fee and billing review',
  whatToDo: 'Check valuation methods, billing frequency, fee rates, and rebates.',
  complianceArea: 'Fees & Client Accounts', frequency: 'Quarterly', requirement: 'Required',
  owner: 'Jennifer', reviewer: 'Frank', source: 'Compliance Manual',
  ownerCompleted: '', reviewerCompleted: '', completedAt: '',
};

check(complianceOutlook.complianceCalendarOwners(openItem).sort().join(',')
  === 'fsabin@blueline-advisors.com,jyoung@blueline-advisors.com',
  'an open item lands on BOTH the owner and the reviewer (an item cannot close without the reviewer)');

check(complianceOutlook.complianceCalendarOwners({ ...openItem, reviewer: 'N/A' }).join(',')
  === 'jyoung@blueline-advisors.com',
  "reviewer 'N/A' means the item closes on the owner alone, so only the owner gets it");

// Completing an item is what withdraws its events: the owner list goes empty and
// reconcileOutlookEvents deletes every mailbox no longer wanted.
const closed = { ...openItem, ownerCompleted: '2026-09-28', reviewerCompleted: '2026-09-29', completedAt: '2026-09-29' };
check(complianceOutlook.complianceStatus(closed) === 'CLOSED'
  && complianceOutlook.complianceCalendarOwners(closed).length === 0,
  'a completed item wants no calendar entry, so completing it removes the events');

check(complianceOutlook.complianceCalendarOwners({ ...openItem, dueDate: '' }).length === 0,
  'an undated item cannot be placed on a calendar and is skipped');

// The failure mode that looks exactly like success: an owner nobody has a
// mailbox for silently gets no event. Skipped rather than guessed at — inventing
// an address would write a real event onto the wrong person's calendar.
check(complianceOutlook.complianceCalendarOwners({ ...openItem, owner: 'Dana', reviewer: 'N/A' }).length === 0,
  'an owner with no mailbox on record is skipped, never guessed at');

const payload = complianceOutlook.complianceOutlookPayload({}, openItem);
// 06:00 rather than the all-day banner: an all-day strip is easy to scroll past,
// and with a dozen due in one week the strip is all anyone sees.
check(payload.isAllDay === false,
  'a compliance item is a timed block, not an all-day banner entry');
check(payload.start.dateTime === '2026-09-30T06:00:00' && payload.end.dateTime === '2026-09-30T07:00:00',
  'it sits at 06:00-07:00 on the day it is due');
check(payload.start.timeZone === 'Eastern Standard Time' && payload.end.timeZone === payload.start.timeZone,
  '06:00 is local wall-clock in the configured zone, not UTC');
// ~100 events each firing Outlook's default 15-minute reminder would mean ~100
// alerts at 05:45. The slot exists to place the item, not to raise an alarm.
check(payload.isReminderOn === false,
  'no reminder is set, so nothing fires at 05:45 across a hundred items');
check(payload.subject.startsWith('[Compliance] '),
  'the subject is prefixed so it is distinguishable from a meeting in Outlook');
check(/Owner: Jennifer/.test(payload.body.content) && /Reviewer: Frank/.test(payload.body.content)
  && /Area: Fees & Client Accounts/.test(payload.body.content),
  'the event body carries who owns it, who reviews it, and which area it belongs to');
check(!('attendees' in payload),
  'no attendees are sent — Graph emails an invitation to every attendee it is given');

check(Object.keys(complianceOutlook.complianceOutlookEvents({ outlookEvents: { 'A@B.com': 'x', '': 'y', 'c@d.com': '' } })).join(',') === 'a@b.com',
  'stored event ids are read back lowercased, with blanks dropped');

// The reconcile is shared with meetings rather than copied — the retry,
// 404-recreate and orphan-avoidance rules are subtle enough that a second copy
// would drift.
check(worker.includes('async function reconcileOutlookEvents(')
  && extract(worker, 'syncTaskToOutlook').includes('reconcileOutlookEvents(')
  && extract(worker, 'syncComplianceToOutlook').includes('reconcileOutlookEvents('),
  'meetings and compliance items share one Outlook reconcile implementation');

// Bulk safety.
check(worker.includes('const COMPLIANCE_OUTLOOK_BATCH ='),
  'the backfill is batched — a Worker cannot finish 128 items of Graph calls in one request');
check(extract(worker, 'handleAdminComplianceOutlookSync').includes('nextOffset'),
  'the backfill reports where to resume, so a failure does not restart the whole run');
check(worker.indexOf("'/api/admin/compliance/outlook-sync'") < worker.indexOf('const complianceMatch = url.pathname.match'),
  'the outlook-sync route is matched before the greedy /compliance/(.+) item route');
check(extract(worker, 'handleAdminComplianceOutlookSync').includes("workspace !== FRANK_ADMIN_EMAIL"),
  'the backfill is refused outside the workspace allowed to read compliance');

// A rejected Graph write must be reported, not just logged: "0 added or updated"
// with no other signal reads as "everything was already up to date", which is
// the opposite conclusion to "every write was refused".
check(extract(worker, 'reconcileOutlookEvents').includes('failed += 1'),
  'rejected Graph calls are counted, not only logged to the console');
check(/return \{ fields: \{[^}]*\}, failed \};/.test(extract(worker, 'syncComplianceToOutlook')),
  'the failure count is returned beside the fields, never merged into the stored record');
check(!/outlookEvents: next, outlookSyncedAt: [^}]*failed/.test(worker),
  'nothing writes a transient failure count onto the compliance item itself');
check(fs.readFileSync(path.join(root, 'public/admin/compliance.html'), 'utf8').includes('rejected by Outlook'),
  'the sync button reports rejected writes rather than silently under-counting');

// Deleting an item must take its calendar copies with it: nothing else would
// ever remove them, since the record holding their ids is about to be gone.
check(/for \(const it of removedItems\) \{[\s\S]*?deleteOutlookEvent/.test(worker),
  'deleting a compliance item withdraws its Outlook events');

// Token caching is what makes the batch size viable: without it every Graph
// call costs two subrequests.
check(extract(worker, 'getGraphToken').includes('graphTokenCache'),
  'the Graph token is cached, halving subrequests per Graph call');

// ---------- 11. Operations opens on Board ----------

const toggle = ops.slice(ops.indexOf('<div class="view-toggle" id="view-toggle">'), ops.indexOf('</div>', ops.indexOf('id="view-toggle"')));
check(toggle.indexOf('data-view="board"') < toggle.indexOf('data-view="list"'),
  'the Tasks toggle reads Board | List, in that order');
check(/data-view="board" class="active"/.test(toggle) && !/data-view="list" class="active"/.test(toggle),
  'Board is the button marked active in the markup');
check(/let currentView = 'board';/.test(ops),
  'Board is the view the page actually opens on, not just the highlighted button');

// The stub keeps every legacy link on List. If this ever flips, the dashboard
// queues, the search palette and the contacts "full task manager" link all
// silently land on a Kanban board instead of the filtered list they asked for.
check(fs.readFileSync(path.join(root, 'public/admin/tasks.html'), 'utf8').includes("operations.html?view=list"),
  'the tasks.html stub still pins legacy links to List');
check(/if \(view === 'list' \|\| view === 'board'\) currentView = view;/.test(ops)
  && /else if \(p\.has\('f'\) \|\| p\.has\('cat'\) \|\| p\.has\('q'\)\) currentView = 'list';/.test(ops),
  'an explicit ?view=, or any of ?f=/?cat=/?q=, still overrides the Board default');

// ---------- 12. Clients and Prospects are separate sidebar entries ----------

const navSrc = sharedJs.slice(sharedJs.indexOf('const NAV_ITEMS = ['), sharedJs.indexOf('];', sharedJs.indexOf('const NAV_ITEMS = [')));
check(/id: 'clients'/.test(navSrc) && /id: 'prospects'/.test(navSrc) && !/id: 'contacts'/.test(navSrc),
  'the sidebar has Clients and Prospects entries, not a single Contacts one');
check(navSrc.indexOf("id: 'clients'") < navSrc.indexOf("id: 'prospects'"),
  'Clients sits above Prospects in the sidebar');
check(/id: 'prospects'[^}]*href: '\/admin\/contacts\.html\?seg=prospects'/.test(navSrc),
  'Prospects points at the same page with ?seg=prospects — one page, two entries');

// This is the load-bearing part. Both entries are the contacts PAGE, and every
// page-keyed behaviour (the employee workspace filter, its saved-filter
// localStorage key, the "leaving a filtered page" reset) must key on that.
// Keying on the nav id instead would reset the employee filter every time
// someone moved between Clients and Prospects.
check(/id: 'clients', page: 'contacts'/.test(navSrc) && /id: 'prospects', page: 'contacts'/.test(navSrc),
  'both entries declare page: contacts, so page-keyed behaviour is shared');
check(sharedJs.includes("EMPLOYEE_FILTER_PAGES.has(link.dataset.navPage)"),
  'the leaving-a-filtered-page reset keys on the page, never the nav id');
check(sharedJs.includes("EMPLOYEE_FILTER_PAGES = new Set(['contacts', 'operations', 'calendar'])"),
  'the employee-filter page list still names contacts, which both entries map to');
check(/initShell\('contacts', \{/.test(html),
  "contacts.html still identifies as the 'contacts' page, whichever side it is showing");

// The segment can change without a navigation (opening a prospect from inside a
// family, converting one), so the highlight has to be movable.
check(sharedJs.includes('function setActiveNav('),
  'the sidebar highlight can be moved without a reload');
check(extract(html, 'renderSegmentChrome').includes('setActiveNav('),
  'a segment change in place moves the sidebar highlight with it');

// The in-page toggle is gone: two controls for one piece of state is how they
// end up disagreeing.
check(!html.includes('id="segment-toggle"'),
  'the old in-page Clients/Prospects toggle is gone — the sidebar is the only switch');
check(!/\.view-toggle \{/.test(html),
  'its now-unused CSS went with it');

// ---------- 13. HNW / Businesses / Vendors lens ----------

check(/const CONTACT_CATEGORIES = \['hnw', 'business', 'vendor'\];/.test(worker),
  'the three categories are declared server-side');
check(extract(worker, 'sanitizeContactFields').includes("if (!CONTACT_CATEGORIES.includes(body.category)) return { error: 'Invalid category' };"),
  'an unknown category is rejected rather than stored');

// App-only, exactly like importantDates. Both SharePoint pull sites spread the
// existing record BEFORE the SharePoint fields, so a key with no column survives
// a sync. Adding it to the field list without adding a column would blank it on
// every pull — the same bug class as the key-document dates.
const spFields = extract(worker, 'contactFieldsFromSharePoint');
check(!spFields.includes('category'),
  'category is app-only and stays out of the SharePoint field mapping');
check(/const contact = \{\s*\.\.\.\(existing/.test(worker) && /\{\s*\.\.\.record,\s*\.\.\.contactFieldsFromSharePoint/.test(worker),
  'both SharePoint pull sites spread the existing record first, so app-only keys survive');

// Defaulted on READ, so every pre-existing contact appears under HNW without a
// bulk migration write.
check(worker.includes("category: CONTACT_CATEGORIES.includes(rec.category) ? rec.category : DEFAULT_CONTACT_CATEGORY,"),
  'a contact that predates the field reads as HNW rather than vanishing from all three lenses');
check(extract(html, 'contactCategory').includes("return CONTACT_CATEGORIES.includes(v) ? v : 'hnw';"),
  'the client applies the same default, so the two cannot disagree');

// A family is a HNW household, a company is a business, and vendors have no
// grouping at all.
check(extract(html, 'groupCategory').includes("groupKind(h) === 'company' ? 'business' : 'hnw'"),
  "a grouping's kind IS its category — family means HNW, company means business");

// Run the real visibleRecords() across all three lenses on both sides.
const lensRoster = [
  { email: 'hnwc@x.com', name: 'HNW Client', status: 'active', category: 'hnw', tags: [] },
  { email: 'bizc@x.com', name: 'Biz Client', status: 'active', category: 'business', tags: [] },
  { email: 'venc@x.com', name: 'Vendor Client', status: 'active', category: 'vendor', tags: [] },
  { email: 'hnwp@x.com', name: 'HNW Prospect', status: 'prospect', category: 'hnw', tags: [] },
  { email: 'bizp@x.com', name: 'Biz Prospect', status: 'prospect', category: 'business', tags: [] },
  { email: 'venp@x.com', name: 'Vendor Prospect', status: 'prospect', category: 'vendor', tags: [] },
  // No category at all — every contact in the book looks like this today.
  { email: 'old@x.com', name: 'Legacy Contact', status: 'active', tags: [] },
];
const lensGroups = [
  { id: 'g-fam', kind: 'family', name: 'A Family', tags: [], members: [] },
  { id: 'g-co', kind: 'company', name: 'A Company', tags: [], members: [] },
];
function lensRun(seg, cat) {
  visibleRecords.set({ ...scope, segment: seg, categoryFilter: cat, allContacts: lensRoster, allHouseholds: lensGroups });
  const r = visibleRecords.visibleRecords();
  return { people: r.loose.map((c) => c.email).sort(), groups: r.groups.map((g) => g.id).sort() };
}

check(lensRun('clients', 'hnw').people.join(',') === 'hnwc@x.com,old@x.com',
  'the HNW lens on Clients shows HNW clients and every uncategorised one');
check(lensRun('clients', 'business').people.join(',') === 'bizc@x.com',
  'the Businesses lens on Clients shows only business clients');
check(lensRun('clients', 'vendor').people.join(',') === 'venc@x.com',
  'the Vendors lens on Clients shows only vendor clients');
check(lensRun('prospects', 'hnw').people.join(',') === 'hnwp@x.com',
  'the same lens applies on the Prospects side');
check(lensRun('prospects', 'vendor').people.join(',') === 'venp@x.com',
  'a vendor prospect is reachable — vendors exist on both sides');

check(lensRun('clients', 'hnw').groups.join(',') === 'g-fam',
  'the HNW lens shows families');
check(lensRun('clients', 'business').groups.join(',') === 'g-co',
  'the Businesses lens shows companies');
check(lensRun('clients', 'vendor').groups.length === 0,
  'the Vendors lens shows no groupings at all');

// Nobody may fall through every position — that is what makes this a lens rather
// than three filters that can all miss.
const reachedByLens = new Set(['hnw', 'business', 'vendor'].flatMap((cat) =>
  lensRun('clients', cat).people.concat(lensRun('prospects', cat).people)));
check(lensRoster.every((c) => reachedByLens.has(c.email)),
  'every contact is reachable from exactly one lens position on one of the two sides');

// Re-categorising or opening a contact outside the current lens must move the
// lens, or they drop off the list they were just edited on.
check(html.includes('if (payload.category !== categoryFilter) {'),
  'saving a contact into a different category moves the lens to follow them');
check(extract(html, 'openProfile').includes('setCategory(contactCategory(opening))'),
  'opening a contact from search or Recently Viewed moves the lens to them');

// The two chrome functions both touch the family/company buttons, so the order
// has to be guaranteed rather than depend on each call site remembering.
check(extract(html, 'renderSegmentChrome').trimEnd().endsWith('renderCategoryChrome();\n  }')
  || /renderCategoryChrome\(\);\s*\}$/.test(extract(html, 'renderSegmentChrome').trim()),
  'renderSegmentChrome always ends by applying the category chrome');

// CSV round-trip: exporting then re-importing must not silently drop the field.
check(html.includes("'Type', 'Name', 'Email', 'PreferredName', 'Status', 'Category', 'Advisor',"),
  'Category is a CSV column, so export/import round-trips it');
check(html.includes("const IMPORT_CATEGORIES = ['hnw', 'business', 'vendor'];")
  && /Unknown Category/.test(html),
  'a typo\'d Category on import is rejected, not filed under the wrong lens');

// The control now lives in shared.css because three pages use it.
check(/^\.view-toggle \{/m.test(fs.readFileSync(path.join(root, 'public/admin/shared.css'), 'utf8')),
  '.view-toggle moved to shared.css, where Operations and Contacts both read it');
check(!/\.view-toggle \{/.test(ops) && !/\.view-toggle \{/.test(html),
  'neither page keeps a private copy of that CSS any more');

// ---------- 14. No cross-script global collisions ----------
//
// Every admin page loads render.js, then shared.js, then its own inline script,
// all as CLASSIC scripts sharing one top-level scope. A `const` in one that
// collides with a `const` in another is a SyntaxError that kills the whole page,
// and checking each block on its own cannot see it — which is exactly how a
// `const CATEGORIES` in contacts.html met the one already in render.js.
for (const page of fs.readdirSync(path.join(root, 'public/admin')).filter((f) => f.endsWith('.html'))) {
  const src = fs.readFileSync(path.join(root, 'public/admin', page), 'utf8');
  const externals = [...src.matchAll(/<script src="([^"?]+)/g)].map((m) => m[1]);
  const inline = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!externals.length && !inline.length) continue;
  const combined = externals
    .map((href) => fs.readFileSync(path.join(root, 'public', href.replace(/^\//, '')), 'utf8'))
    .concat(inline)
    .join('\n;\n');
  let err = null;
  try { new Function(combined); } catch (e) { err = e.message; }
  check(!err, `${page}: its scripts share one scope and declare no colliding globals${err ? ` (${err})` : ''}`);
}

console.log(`\n${passed} prospect checks passed`);
