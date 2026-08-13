const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'public/admin/shared.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'public/assets/script.js'), 'utf8');
const onboarding = fs.readFileSync(path.join(root, 'public/onboarding/onboarding.js'), 'utf8');

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed += 1;
  console.log(`PASS  ${message}`);
}

check(worker.includes("const hasAccount = !!(await env.PORTAL_KV.get(`user:${m}`))"),
  'unregistered household members are excluded from assessment assignments');
check(worker.includes("? loadAssignments(await env.PORTAL_KV.get(`assignments:${m}`))\n      : [];"),
  'an unregistered member has an explicit empty assignment list');

check(shared.includes('const HOUSEHOLD_WORKSPACES = new Map();'),
  'combined admin view records household ownership');
check(shared.includes('HOUSEHOLD_WORKSPACES.get(decodeURIComponent(householdMatch[1]))'),
  'household mutations route to their owning workspace');

check(worker.includes("const inviteKey = `client_invite:${await sha256Hex(inviteToken)}`"),
  'registration requires a hashed one-time invitation lookup');
check(worker.includes('await env.PORTAL_KV.delete(inviteKey);'),
  'registration consumes its invitation');
check(client.includes('sessionStorage.removeItem(REGISTRATION_INVITE_KEY);'),
  'the browser discards the invitation after registration');

check(worker.includes("if (!clientEmail) return json({ error: 'Sign in to the client portal before starting onboarding'"),
  'onboarding start requires client authentication');
check(worker.includes("String(existing.clientEmail || legacyEmail || '').toLowerCase()"),
  'onboarding saves remain bound to the originating account');
check(worker.includes('function isValidSignatureDataUrl(value)'),
  'onboarding validates captured signature data');
check(onboarding.includes('Authorization: `Bearer ${session.token}`'),
  'onboarding sends the client session to the API');

check(worker.includes('`BLA-ONB-${new Date().getFullYear()}-${randomHex(8)}`'),
  'onboarding identifiers use collision-resistant randomness');
check(worker.includes("groupKindOf(h) !== 'company' && !h.archived"),
  'document folder resolution ignores archived households');
check(worker.includes(".filter((h) => h && h.id && !h.archived && (h.members || [])"),
  'agreement dates ignore archived groupings');
check(worker.includes("const kind = Number(groupKindOf(a) === 'company') - Number(groupKindOf(b) === 'company');"),
  'agreement dates prefer an active family deterministically');

check(worker.includes("while (visible.length < 30 && hasMore)"),
  'activity pagination fills a workspace-filtered page');
check(worker.includes("return json({ entries: visible, hasMore, cursor: hasMore ? cursor : null }"),
  'activity returns the cursor after workspace filtering');

console.log(`\n${passed} portal regression checks passed`);
