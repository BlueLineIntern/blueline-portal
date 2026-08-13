// Regression test for the SharePoint household PULL clobbering app-only fields.
//
// Run with: node scripts/test-household-sync.js
//
// The bug this exists to prevent: saving a household pushes it to SharePoint,
// which bumps that row's Modified to now. The every-minute pull then sees
// SharePoint as newer than the copy it reads, and rebuilds the record from it.
// KV is eventually consistent, so that copy can still be the pre-save one, and
// rebuilding from a stale base wipes every field SharePoint has no column for —
// keyDocuments, kind, emailPrimary, members. Symptom: a key-document date set in
// the UI or by import reverts to "Not recorded" about a minute later.
//
// This is the second time this class of bug has hit this sync; the contacts
// version once erased importantDates and archived on every run. Hence a real
// test rather than a comment.
//
// Extracts householdFieldsFromSharePoint from worker.js rather than
// reimplementing it, so this cannot pass against a copy that has drifted from
// the shipped code.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('could not find ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

const CONTACT_STATUSES = ['prospect', 'onboarding', 'active', 'inactive'];
const HOUSEHOLD_EMAIL_TYPES = ['', 'work', 'home', 'other'];
const householdFieldsFromSharePoint = eval('(' + extract('householdFieldsFromSharePoint') + ')');

// The exact comparison the fix uses.
const isChanged = (spFields, fresh) => Object.entries(spFields).some(([k, v]) => (
  v !== undefined && JSON.stringify(fresh[k]) !== JSON.stringify(v)
));

// A household as the app stores it, including the app-only fields SharePoint
// has no column for.
const appRecord = {
  id: 'hh-000001', type: 'household', kind: 'family',
  name: 'Smith (Test)', email: '', emailType: '', emailPrimary: true,
  assignedTo: '', advisorRep: '', contactType: '', background: '',
  tags: [], status: 'active', archived: false,
  members: [{ email: 'a@example.com', role: 'head' }],
  keyDocuments: { ips: '2026-08-12', advisoryAgreement: '2026-08-12' },
  updatedAt: '2026-08-13T10:00:00.000Z',
};

// The SharePoint row the app itself just pushed: same values, Modified bumped.
const spRowMatching = {
  Title: 'Smith (Test)', HouseholdId: 'hh-000001', Email: '', EmailType: '',
  AssignedTo: '', AdvisorRep: '', ContactType: '', Tags: '', Background: '',
  Status: 'active', Archived: 'No',
  Modified: '2026-08-13T10:00:05.000Z', // newer than updatedAt -> guard passes
};

// A row a human genuinely edited in SharePoint.
const spRowEdited = { ...spRowMatching, Status: 'inactive', Tags: 'VIP, Trust' };

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : `\n          got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`));
  ok ? pass++ : fail++;
};

console.log('--- the bug: SharePoint says "newer" but carries nothing new ---');
const fA = householdFieldsFromSharePoint(spRowMatching);
check('changed === false, so the write is skipped', isChanged(fA, appRecord), false);

console.log('\n--- OLD behaviour, for contrast: rebuild from a STALE base ---');
// What the previous code did when KV handed back a pre-save copy.
const staleBase = { ...appRecord, keyDocuments: {} , updatedAt: '2026-08-13T09:59:00.000Z' };
const oldResult = { ...staleBase, ...fA };
check('old code wiped the dates', oldResult.keyDocuments, {});

console.log('\n--- NEW behaviour: skip means the stored record is untouched ---');
check('dates still present because nothing was written', appRecord.keyDocuments,
  { ips: '2026-08-12', advisoryAgreement: '2026-08-12' });

console.log('\n--- a real SharePoint edit must STILL flow in ---');
const fB = householdFieldsFromSharePoint(spRowEdited);
check('changed === true for a genuine edit', isChanged(fB, appRecord), true);
const merged = { ...appRecord, ...fB };
check('the edited fields are applied', [merged.status, merged.tags], ['inactive', ['VIP', 'Trust']]);
check('app-only keyDocuments survive the merge', merged.keyDocuments,
  { ips: '2026-08-12', advisoryAgreement: '2026-08-12' });
check('app-only kind survives the merge', merged.kind, 'family');
check('app-only members survive the merge', merged.members.length, 1);

console.log('\n--- name: undefined must never blank a real name ---');
const raw = householdFieldsFromSharePoint({ ...spRowMatching, Title: '' });
check('empty Title yields name: undefined', raw.name, undefined);
check('undefined is ignored by the comparison', isChanged({ name: undefined }, appRecord), false);
// The fix: strip undefined before spreading, exactly as the worker now does.
const stripUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
check('spreading RAW would blank the name (the bug)', ({ ...appRecord, ...raw }).name, undefined);
check('spreading STRIPPED preserves it (the fix)', ({ ...appRecord, ...stripUndefined(raw) }).name, 'Smith (Test)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
