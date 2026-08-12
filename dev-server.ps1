# Local dev server for the BlueLine portal frontend.
# Serves public/ and mocks the Worker API in-memory (no Cloudflare needed).
# The real API lives in worker.js — keep computed fields here in sync with it.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File dev-server.ps1

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'public'
$port = 8787

$users = @{}
$sessions = @{}
$responses = @{}
# Shared household assessments, keyed by household id. The worker stores these
# encrypted under hhresponses:<id>; only the four personal ones stay in
# $responses per member. See $personalAssessments.
$hhResponses = @{}
$assignments = @{}  # email -> array of assigned module keys ($null / absent = all visible)
$onboardings = @{}
$onbSecrets = @{}
$script:onbCounter = 0
$adminSessions = @{}  # admin session token -> admin email
$auditLog = [System.Collections.ArrayList]::new()  # audit entries, appended in order

# Mirror worker.js logAudit: record who did what, when. In the real worker these
# are audit:<ts>:<rand> KV entries; here they live in memory for the session.
function Write-Audit($email, $action, $detail) {
    $null = $auditLog.Add([ordered]@{
        ts     = (Get-Date).ToString('o')
        email  = if ($email) { $email } else { 'unknown' }
        action = $action
        detail = $detail
    })
}
# DEV ONLY credentials. The real worker uses ADMIN_ACCOUNTS + a per-email
# password secret; these throwaway per-person passwords exist only so the mock
# can be exercised locally and are intentionally NOT the production passwords.
$adminPasswords = @{
    'fsabin@blueline-advisors.com'  = 'dev-fsabin-pass'
    'jyoung@blueline-advisors.com'  = 'dev-jyoung-pass'
    'intern@blueline-advisors.com'  = 'dev-intern-pass'
}
$frankAdminEmail = 'fsabin@blueline-advisors.com'
$jennAdminEmail = 'jyoung@blueline-advisors.com'
$internAdminEmail = 'intern@blueline-advisors.com'
$allAdminWorkspaces = '__all__'
$adminWorkspaceAccess = @{
    $frankAdminEmail = @('jyoung@blueline-advisors.com', 'intern@blueline-advisors.com')
}
$adminNames = @{
    'fsabin@blueline-advisors.com' = 'Frank'
    'jyoung@blueline-advisors.com' = 'Jenn'
    'intern@blueline-advisors.com' = 'Intern'
}
$adminMfa = @{}      # email -> @{ secret; confirmed; backupCodes=@(@{hash;used}); createdAt }
$adminPending = @{}  # pending token -> email (short-lived between password and 2nd factor)
$contacts = @{}      # email -> CRM contact record (worker stores these encrypted in KV)

# Stand-in for the SharePoint "Learning Resources" library. There is no Graph
# behind the mock, so these are fixed rows plus whatever gets uploaded during
# the session (in memory only — a restart resets them). `title` is already
# resolved the way worker.js resolves it: Title column -> Description ->
# filename. The set covers all four combinations of those two columns being
# filled in, plus a row with no Category (sorts last, reachable only from All).
$learningResources = [System.Collections.ArrayList]::new()
@(
    @{ id = 'l1'; name = 'CRM-walkthrough.mp4'; title = 'Adding a new client in the CRM'
       description = 'Step-by-step walkthrough of the intake form and required fields.'
       category = 'Software Training'
       webUrl = 'https://bluelineadvisors.sharepoint.com/sites/BluelineTeam/Learning/CRM-walkthrough.mp4'
       size = 48234123; modified = '2026-07-20T14:02:00Z' }
    @{ id = 'l2'; name = 'Form-ADV-refresher.pdf'; title = 'Annual Form ADV refresher'
       description = 'Covers the 2026 filing changes.'; category = 'Compliance'
       webUrl = 'https://bluelineadvisors.sharepoint.com/sites/BluelineTeam/Learning/Form-ADV-refresher.pdf'
       size = 812004; modified = '2026-06-11T09:30:00Z' }
    @{ id = 'l3'; name = 'new-hire-checklist.docx'; title = 'new-hire-checklist.docx'
       description = ''; category = 'Onboarding'
       webUrl = 'https://bluelineadvisors.sharepoint.com/sites/BluelineTeam/Learning/new-hire-checklist.docx'
       size = 24500; modified = '2026-05-02T16:45:00Z' }
    @{ id = 'l4'; name = 'quarterly-review-deck.pptx'; title = 'Running a quarterly review meeting'
       description = ''; category = 'Onboarding'
       webUrl = 'https://bluelineadvisors.sharepoint.com/sites/BluelineTeam/Learning/quarterly-review-deck.pptx'
       size = 3300400; modified = '2026-07-01T11:15:00Z' }
    @{ id = 'l5'; name = 'misc-notes.txt'; title = 'Uncategorised scratch notes'
       description = 'Uncategorised scratch notes'; category = ''
       webUrl = 'https://bluelineadvisors.sharepoint.com/sites/BluelineTeam/Learning/misc-notes.txt'
       size = 1200; modified = '2026-07-25T08:00:00Z' }
) | ForEach-Object { $null = $learningResources.Add($_) }

# The mock's Category column is a Choice column, matching the real library, so
# the upload form shows a dropdown. Includes a value no file uses yet, which is
# the whole reason the real endpoint reads the column schema.
$learningCategoryChoices = @('Compliance', 'Onboarding', 'Software Training', 'Markets & Planning')
# uploadId -> @{ filename; title; category; description; size; received }
$learningUploads = @{}
$script:lrCounter = 0

# Compliance items. Loaded from the SAME compliance-seed.js the worker imports,
# so the mock can't drift from production data — that file's array is strict JSON
# precisely so this can parse it after stripping the ES module export prefix.
# The worker keeps these in one encrypted KV blob; here they live in memory.
$complianceItems = [System.Collections.ArrayList]::new()
$script:cmpCounter = 0
function Import-ComplianceSeed {
    $seedPath = Join-Path $PSScriptRoot 'compliance-seed.js'
    # Plain ASCII on purpose: this file is UTF-8 with no BOM, PowerShell 5.1
    # decodes it as Windows-1252, and an em-dash then becomes three chars ending
    # in U+201D — a curly double-quote, which PS accepts as a real string
    # delimiter. Inside a double-quoted string that silently ends the string and
    # corrupts the rest of the file. Safe in comments; never in "..." literals.
    if (-not (Test-Path $seedPath)) { Write-Host '  (no compliance-seed.js - Compliance tab will be empty)'; return }
    $raw = Get-Content $seedPath -Raw
    $start = $raw.IndexOf('[')
    $end = $raw.LastIndexOf(']')
    if ($start -lt 0 -or $end -le $start) { Write-Host '  (could not parse compliance-seed.js)'; return }
    $json = $raw.Substring($start, $end - $start + 1)
    foreach ($row in (ConvertFrom-Json $json)) {
        $null = $complianceItems.Add([ordered]@{
            id = $row.id; dueDate = $row.dueDate; item = $row.item; whatToDo = $row.whatToDo
            # The seed already carries normalised frequency, frequencyDetail,
            # complianceArea and requirement — see scripts/add-compliance-area.js.
            frequency = $row.frequency; frequencyDetail = $row.frequencyDetail
            complianceArea = $row.complianceArea
            source = $row.source; requirement = $row.requirement
            waitingOn = ''
            # Mirror worker.js: the seed still carries 'Both' rows, which become
            # Frank owns / Jennifer reviews — that also gives them a review step.
            owner = $(if (([string]$row.owner).Trim() -eq 'Both') { 'Frank' } else { $row.owner })
            reviewer = $(if (([string]$row.owner).Trim() -eq 'Both' -and (([string]$row.reviewer).Trim() -eq 'N/A' -or -not ([string]$row.reviewer).Trim())) { 'Jennifer' } else { $row.reviewer })
            notes = $row.notes
            ownerCompleted = ''; ownerCompletedBy = ''
            reviewerCompleted = ''; reviewerCompletedBy = ''
            completedAt = ''; completedBy = ''
            createdAt = (Get-Date).ToString('o'); createdBy = 'seed'; updatedAt = $null
        })
    }
}

# Frequency is DESCRIPTIVE ONLY, mirroring worker.js: it records how often an
# obligation comes round, but nothing generates the next occurrence — future
# due dates arrive by importing a spreadsheet listing them.
$complianceFrequencies = @('Quarterly', 'Annual', 'One-time', 'Ongoing', 'Monthly', 'Semi-annual', 'Weekly')
# Exactly six, mirroring worker.js COMPLIANCE_AREAS.
$complianceAreas = @('Governance & Regulatory', 'Trading & Investments', 'Fees & Client Accounts', 'Marketing & Communications', 'Personnel & Ethics', 'Technology, Privacy & Resilience')
$complianceRequirements = @('Required', 'Best practice')
$complianceWorkflows = @('Open', 'Waiting', 'Awaiting review', 'Completed')

# Mirror worker.js complianceStatus/complianceSignedOff/complianceAwaiting.
# Status now keys off a STORED completedAt, not the two check-offs: signing off
# records who approved, completing is a separate explicit act.
function Get-ComplianceReviewerRequired($it) { return ([string]$it.reviewer).Trim() -ne 'N/A' }
function Get-ComplianceSignedOff($it) {
    $ownerDone = [bool]([string]$it.ownerCompleted).Trim()
    $reviewerDone = [bool]([string]$it.reviewerCompleted).Trim()
    return ($ownerDone -and ((-not (Get-ComplianceReviewerRequired $it)) -or $reviewerDone))
}
function Get-ComplianceStatus($it) {
    if ([string]$it.completedAt -and ([string]$it.completedAt).Trim()) { return 'CLOSED' }
    return 'OPEN'
}
# Whose turn: owner -> reviewer -> nobody. Drives the calendar colour coding.
function Get-ComplianceAwaiting($it) {
    if ((Get-ComplianceStatus $it) -eq 'CLOSED') { return '' }
    if (-not ([string]$it.ownerCompleted).Trim()) { return ([string]$it.owner).Trim() }
    if ((Get-ComplianceReviewerRequired $it) -and -not ([string]$it.reviewerCompleted).Trim()) {
        return ([string]$it.reviewer).Trim()
    }
    return ''
}
# Mirror worker.js complianceWorkflow. FOUR states, not five: "Owner complete"
# and "Awaiting review" describe the same condition, so only the latter ships.
function Get-ComplianceWorkflow($it) {
    if ((Get-ComplianceStatus $it) -eq 'CLOSED') { return 'Completed' }
    if (([string]$it.waitingOn).Trim()) { return 'Waiting' }
    if (([string]$it.ownerCompleted).Trim() -and (Get-ComplianceReviewerRequired $it) `
        -and -not ([string]$it.reviewerCompleted).Trim()) { return 'Awaiting review' }
    if (Get-ComplianceSignedOff $it) { return 'Awaiting review' }
    return 'Open'
}
function ConvertTo-CompliancePayload($it) {
    $o = [ordered]@{}
    foreach ($k in $it.Keys) { $o[$k] = $it[$k] }
    $o['status'] = Get-ComplianceStatus $it
    $o['workflow'] = Get-ComplianceWorkflow $it
    $o['reviewerRequired'] = Get-ComplianceReviewerRequired $it
    $o['signedOff'] = Get-ComplianceSignedOff $it
    $o['awaiting'] = Get-ComplianceAwaiting $it
    return $o
}
$contactStatuses = @('prospect', 'onboarding', 'active', 'inactive')
$tasks = @{}   # id -> task record (listings sort by createdAt, so plain hashtable is fine)
$notes = @{}   # id -> note record
$timelineLog = [System.Collections.ArrayList]::new()  # client history entries (also the activity feed)
$autoTaskMarkers = @{}  # rule:client -> fired
$notifSeen = @{}        # admin email -> last time they opened notifications
$boardLists = @()       # board columns: [{id, type(person/custom), account?, name?, createdAt}]
$boardListsByWorkspace = @{} # non-Frank workspace -> private board columns
# Links the client portal's Links tab shows. Seeded with the two the firm asked
# for so local dev has something to render. NO credentials here by design — see
# the PORTAL_LINKS_KEY comment in worker.js for why.
$portalLinks = @(
    [ordered]@{ id = 'lnk-tamarac'; label = 'Tamarac'; url = 'https://clientportal.tamaracinc.com/'
        description = 'Your portfolio, performance reporting and statements.'; enabled = $true }
    [ordered]@{ id = 'lnk-emoney'; label = 'eMoney'; url = 'https://wealth.emaplan.com/'
        description = 'Your financial plan and account aggregation.'; enabled = $true }
)
$script:crmCounter = 0
$taskPriorities = @('low', 'medium', 'high')
$taskCategories = @(
    'follow-up', 'review', 'meeting', 'onboarding', 'compliance', 'other',
    'investment-reports', 'operational-task', 'trading', 'investment-policy-statement', 'financial-planning'
)
$taskRepeats = @('', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')
$eventStatuses = @('', 'unconfirmed', 'confirmed', 'cancelled')
$households = @{}   # id -> household record (worker stores these encrypted in KV)
$script:householdCounter = 0
$householdRoles = @('head', 'spouse', 'partner', 'child', 'dependent', 'other')
$companyRoles = @('primary', 'owner', 'officer', 'employee', 'other')
$groupKinds = @('family', 'company')

# Mirror worker.js sanitizeHouseholdFields' member handling: valid emails only,
# a known role, and no one listed twice.
function ConvertTo-HouseholdMembers($raw, $kind) {
    $out = @()
    $seen = @{}
    # Roles are validated against the record's kind, mirroring rolesForKind() in
    # worker.js: an unrecognised role becomes 'other' rather than an error.
    $valid = if ($kind -eq 'company') { $companyRoles } else { $householdRoles }
    foreach ($m in @($raw)) {
        if (-not $m) { continue }
        $email = ([string]$m.email).Trim().ToLower()
        if (-not $email) { continue }
        if ($email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { return @{ error = "Member `"$email`" is not a valid email" } }
        if ($seen.ContainsKey($email)) { return @{ error = 'A person can only appear once in a household' } }
        $seen[$email] = $true
        $role = ([string]$m.role).Trim().ToLower()
        if ($valid -notcontains $role) { $role = 'other' }
        $out += @{ email = $email; role = $role }
        if ($out.Count -ge 20) { break }
    }
    return @{ members = $out }
}

# Additional Info (worker.js: clientinfo:<email>) and attached client documents
# (clientdoc:<email>:<id>). In-memory here; a restart resets them.
$clientInfo = @{}        # email -> ordered hashtable of the suitability fields
$clientDocs = @{}        # doc id -> metadata record
$clientDocUploads = @{}  # ticket -> in-flight upload
$script:docCounter = 0
$docRequests = @{}       # request id -> advisor's ask for a specific document
$script:docReqCounter = 0
# Mirrors the worker's client-upload ceiling. Deliberately far tighter than the
# advisor path: this is the only place a non-admin writes into the firm's tenant.
$clientUploadMax = 25 * 1024 * 1024
$clientUploadTypes = @('pdf', 'jpg', 'jpeg', 'png', 'heic', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt')
# Mirror of DOC_CATEGORIES in worker.js — the sections on the client's
# Documents tab. Order is display order; 'other' is the default for anything
# arriving without a category, including pre-existing records.
$docCategories = @(
    [ordered]@{ id = 'tax'; label = 'Tax Returns' }
    [ordered]@{ id = 'trust'; label = 'Trust Documents' }
    [ordered]@{ id = 'estate'; label = 'Estate Documents' }
    [ordered]@{ id = 'other'; label = 'Miscellaneous' }
)
function Get-DocCategory($raw) {
    $c = ([string]$raw).Trim().ToLower()
    if (@('tax', 'trust', 'estate', 'other') -contains $c) { return $c }
    return 'other'
}

# Mirror of householdPortalMembers in worker.js. Everyone in a FAMILY (not a
# company) shares one portal: same documents, same requests, each other's
# assessments. Every member including child/dependent roles; automatic, no
# opt-in. Always returns at least the caller, so a client in no household
# behaves exactly as before. Returns , @(...) for the same load-bearing reason
# ConvertTo-CalendarOwners does - a bare single-element array unrolls to a string.
#
# CALL IT BY ASSIGNING, never inline inside @():  $mem = Get-HouseholdMembers $x
# `@(Get-HouseholdMembers $x)` wraps the returned array in ANOTHER array, so
# .Count reads 1 and -contains never matches. That produced exactly one bug here
# already: /api/household reported shared=false for a real two-person family and
# every household document query matched nothing.
function Get-HouseholdMembers($email) {
    $addr = ([string]$email).Trim().ToLower()
    $fam = @($households.Values | Where-Object {
        $_.id -and (Get-GroupKind $_) -ne 'company' -and -not $_.archived -and
        @($_.members | Where-Object { $_ -and ([string]$_.email).ToLower() -eq $addr }).Count -gt 0
    } | Sort-Object `
        @{ Expression = { if ([string]$_.createdAt) { [string]$_.createdAt } else { '9999' } } }, `
        @{ Expression = { [string]$_.id } })
    if (-not $fam.Count) { return , @($addr) }
    $out = [System.Collections.ArrayList]@()
    foreach ($m in $fam[0].members) {
        $e = ([string]$m.email).Trim().ToLower()
        if ($e -and -not $out.Contains($e)) { $null = $out.Add($e) }
    }
    if (-not $out.Contains($addr)) { $null = $out.Add($addr) }
    return , @($out.ToArray())
}

function Get-HouseholdRecord($email) {
    $addr = ([string]$email).Trim().ToLower()
    $fam = @($households.Values | Where-Object {
        $_.id -and (Get-GroupKind $_) -ne 'company' -and -not $_.archived -and
        @($_.members | Where-Object { $_ -and ([string]$_.email).ToLower() -eq $addr }).Count -gt 0
    } | Sort-Object `
        @{ Expression = { if ([string]$_.createdAt) { [string]$_.createdAt } else { '9999' } } }, `
        @{ Expression = { [string]$_.id } })
    if ($fam.Count) { return $fam[0] }
    return $null
}

# Mirror of PERSONAL_ASSESSMENTS in worker.js. A household shares ONE copy of
# every other assessment (one budget, one net worth); these four describe a
# person, and a shared copy would mean whoever saves second erases the other's.
$personalAssessments = @('risk', 'riskcapacity', 'behavior', 'knowledge')
function Test-PersonalAssessment($key) { return $personalAssessments -contains ([string]$key) }

# Shared half of a household's assessments, with the same migration fallback the
# worker uses: anything not yet in the household record is recovered from the
# members' own records (newest wins), so answers saved before the split don't
# look unanswered.
function Get-SharedModules($email) {
    $hh = Get-HouseholdRecord $email
    $out = @{}
    if (-not $hh) { return $out }
    if ($hhResponses.ContainsKey($hh.id)) {
        foreach ($k in $hhResponses[$hh.id].Keys) { $out[$k] = $hhResponses[$hh.id][$k] }
    }
    foreach ($m in (Get-HouseholdMembers $email)) {
        if (-not $responses.ContainsKey($m)) { continue }
        foreach ($k in @($responses[$m].Keys)) {
            if (Test-PersonalAssessment $k) { continue }
            $cand = $responses[$m][$k]
            if (-not $out.ContainsKey($k)) { $out[$k] = $cand; continue }
            if ([string]$cand.updatedAt -gt [string]$out[$k].updatedAt) { $out[$k] = $cand }
        }
    }
    return $out
}

# This member's personal assessments only.
function Get-PersonalModules($email) {
    $out = @{}
    if ($responses.ContainsKey($email)) {
        foreach ($k in @($responses[$email].Keys)) {
            if (Test-PersonalAssessment $k) { $out[$k] = $responses[$email][$k] }
        }
    }
    return $out
}

# One flat map, the shape the advisor views expect: shared + this client's own.
function Get-EffectiveModules($email) {
    $out = @{}
    $hh = Get-HouseholdRecord $email
    if ($hh) {
        foreach ($kv in (Get-SharedModules $email).GetEnumerator()) { $out[$kv.Key] = $kv.Value }
    } elseif ($responses.ContainsKey($email)) {
        # No household: everything lives in their own record, as before.
        foreach ($k in @($responses[$email].Keys)) { $out[$k] = $responses[$email][$k] }
    }
    foreach ($kv in (Get-PersonalModules $email).GetEnumerator()) { $out[$kv.Key] = $kv.Value }
    return $out
}

function Get-MemberName($email) {
    $e = ([string]$email).Trim().ToLower()
    if ($contacts.ContainsKey($e) -and ([string]$contacts[$e].name)) { return [string]$contacts[$e].name }
    if ($users.ContainsKey($e) -and ([string]$users[$e].name)) { return [string]$users[$e].name }
    return $e
}

# Fixed sample data standing in for a live Microsoft Graph mailbox search (see
# fetchClientEmailHistory in worker.js) - the mock has no Outlook behind it at
# all, unlike documents/info which at least have real in-memory CRUD.
$clientEmailsMock = @{
    'john.smith@example.com' = @(
        @{
            id = 'm1'; subject = 'Re: Q2 statement questions'
            from = @{ name = 'John Smith'; address = 'john.smith@example.com' }
            to = @(@{ name = 'Fred Sabin'; address = 'fsabin@blueline-advisors.com' })
            cc = @()
            receivedDateTime = '2026-07-28T14:32:00Z'
            bodyPreview = 'Thanks for walking through the statement on the call - one follow up, does the money market sweep count toward the liquidity target we discussed?'
            webLink = 'https://outlook.office.com/mail/id/mock-m1'
            isDraft = $false
            viaMailbox = 'fsabin@blueline-advisors.com'
        },
        @{
            id = 'm2'; subject = 'Q2 statement questions'
            from = @{ name = 'Fred Sabin'; address = 'fsabin@blueline-advisors.com' }
            to = @(@{ name = 'John Smith'; address = 'john.smith@example.com' })
            cc = @()
            receivedDateTime = '2026-07-27T09:10:00Z'
            bodyPreview = 'Hi John, attaching your Q2 statement. Happy to walk through it on a call this week if useful.'
            webLink = 'https://outlook.office.com/mail/id/mock-m2'
            isDraft = $false
            viaMailbox = 'fsabin@blueline-advisors.com'
        },
        # DECOY. Stands in for what Graph's $search actually returns and what the
        # first version of this feature wrongly displayed: a message that only
        # QUOTES the client's address in its text, between two advisors, with the
        # client on none of the address lines. The participant gate must drop it.
        @{
            id = 'm3'; subject = 'Internal: prospect list review'
            from = @{ name = 'Jenn Young'; address = 'jyoung@blueline-advisors.com' }
            to = @(@{ name = 'Fred Sabin'; address = 'fsabin@blueline-advisors.com' })
            cc = @()
            receivedDateTime = '2026-07-30T11:00:00Z'
            bodyPreview = 'Pulled the Q3 prospect list - john.smith@example.com and two others are up for a review call. No action needed yet.'
            webLink = 'https://outlook.office.com/mail/id/mock-m3'
            isDraft = $false
            viaMailbox = 'jyoung@blueline-advisors.com'
        }
    )
}

# Mirrors messageParticipants() in worker.js: a message belongs to a client's
# correspondence only if the address is an actual sender or recipient, never
# because the text mentions it. The mock's messages are already in the flattened
# shape the worker emits, so this checks from/to/cc rather than Graph's nested
# emailAddress objects.
function Test-ClientIsParticipant($msg, $email) {
    $addrs = New-Object System.Collections.Generic.HashSet[string]
    if ($msg.from -and $msg.from.address) { $null = $addrs.Add(([string]$msg.from.address).ToLower()) }
    foreach ($r in @($msg.to)) { if ($r -and $r.address) { $null = $addrs.Add(([string]$r.address).ToLower()) } }
    foreach ($r in @($msg.cc)) { if ($r -and $r.address) { $null = $addrs.Add(([string]$r.address).ToLower()) } }
    return $addrs.Contains(([string]$email).ToLower())
}
$clientInfoDates = @('occupationStartDate', 'retirementDate', 'signedFeeAgreementDate',
    'signedIpsAgreementDate', 'signedFpAgreementDate', 'lastAdvOfferingDate',
    'initialCrsOfferingDate', 'lastCrsOfferingDate', 'lastPrivacyOfferingDate',
    'driversLicenseIssuedDate', 'driversLicenseExpiresDate')
$clientInfoMoney = @('grossAnnualIncome', 'assets', 'nonLiquidAssets', 'liabilities',
    'adjustedGrossIncome', 'estimatedTaxes')
$clientInfoEnums = @{
    investmentObjective = @('Capital Preservation', 'Income', 'Growth & Income', 'Growth', 'Aggressive Growth', 'Speculation')
    timeHorizon = @('Less than 1 year', '1-3 years', '3-5 years', '5-10 years', 'More than 10 years')
    riskTolerance = @('Conservative', 'Moderately Conservative', 'Moderate', 'Moderately Aggressive', 'Aggressive')
    experienceMutualFunds = @('None', 'Limited', 'Good', 'Extensive')
    experienceStocksBonds = @('None', 'Limited', 'Good', 'Extensive')
    experiencePartnerships = @('None', 'Limited', 'Good', 'Extensive')
    confirmedByTaxReturn = @('Yes', 'No')
    taxBracket = @('10%', '12%', '22%', '24%', '32%', '35%', '37%')
    smoker = @('Yes', 'No')
}

# Net worth figures are derived on read, never stored - mirrors
# clientInfoDerived() in worker.js. Assets means liquid assets, which is what
# makes liquid net worth assets minus liabilities.
function Add-ClientInfoDerived($info) {
    $num = {
        param($v)
        if ($null -eq $v) { return 0.0 }
        $d = 0.0
        if ([double]::TryParse([string]$v, [ref]$d)) { return $d }
        return 0.0
    }
    $assets = & $num $info['assets']
    $nonLiquid = & $num $info['nonLiquidAssets']
    $liabilities = & $num $info['liabilities']
    $out = [ordered]@{}
    foreach ($k in $info.Keys) { $out[$k] = $info[$k] }
    $out['estimatedNetWorth'] = $assets + $nonLiquid - $liabilities
    $out['estimatedLiquidNetWorth'] = $assets - $liabilities
    return $out
}

# A grouping is a family or a company - same record, different label and roles.
function Get-GroupKind($rec) {
    if ($rec -and ([string]$rec.kind) -eq 'company') { return 'company' }
    return 'family'
}

# Mirror of the worker's client-document folder naming (see resolveClientDocFolder
# in worker.js): family folder first, then the person's own name surname-first,
# then the mailbox. Kept in step so the folder shown in a locally mocked webUrl
# matches what a real upload would produce.
function Format-DocName($raw) {
    $base = ([string]$raw).Split('\/')[-1]
    $base = $base -replace '["*:<>?|]', '-'
    $base = $base -replace '^[.\s]+', '' -replace '[.\s]+$', ''
    if ($base.Length -gt 200) { $base = $base.Substring(0, 200) }
    return $base
}

$script:SurnameParticles = @('van','von','der','den','de','del','della','di','da','dos','du','la','le','lo','el','al','bin','ibn','mac','mc','st','st.','saint','ter','ten','op','vander','vande')
$script:NameSuffixes = @('jr','jr.','sr','sr.','ii','iii','iv','v','md','m.d.','phd','ph.d.','esq','esq.','cpa','cfp','cfa','dds','do','rn','jd','llm','ea')
$script:NameTitles = @('mr','mr.','mrs','mrs.','ms','ms.','miss','dr','dr.','prof','prof.','rev','rev.','sir','hon','hon.','fr','fr.')

function Get-PersonDocFolder($rawName, $email) {
    $emailFolder = Format-DocName ([string]$email).ToLower()
    $cleaned = (([string]$rawName).Trim() -replace '\s+', ' ')
    if (-not $cleaned) { return $emailFolder }
    if ($cleaned.Contains(',')) {
        $c = Format-DocName $cleaned
        if ($c) { return $c } else { return $emailFolder }
    }
    $parts = [System.Collections.ArrayList]@($cleaned.Split(' '))
    $suffixes = [System.Collections.ArrayList]@()
    while ($parts.Count -gt 1 -and $script:NameSuffixes -contains ([string]$parts[$parts.Count - 1]).ToLower()) {
        $suffixes.Insert(0, $parts[$parts.Count - 1]); $parts.RemoveAt($parts.Count - 1)
    }
    while ($parts.Count -gt 1 -and $script:NameTitles -contains ([string]$parts[0]).ToLower()) { $parts.RemoveAt(0) }
    $tail = ''
    if ($suffixes.Count) { $tail = ' ' + ($suffixes -join ' ') }
    if ($parts.Count -eq 1) {
        $one = Format-DocName ([string]$parts[0] + $tail)
        if ($one) { return $one } else { return $emailFolder }
    }
    $cut = $parts.Count - 1
    while ($cut -gt 1 -and $script:SurnameParticles -contains ([string]$parts[$cut - 1]).ToLower()) { $cut-- }
    $surname = ($parts[$cut..($parts.Count - 1)] -join ' ')
    $given = ($parts[0..($cut - 1)] -join ' ')
    $out = Format-DocName "$surname, $given$tail"
    if ($out) { return $out } else { return $emailFolder }
}

# Oldest holder of a name keeps the clean folder; later ones get their id appended.
function Get-UniqueDocFolder($name, $id, $holders) {
    $key = ([string]$name).Trim().ToLower()
    $sharing = @($holders | Where-Object { $_.key -eq $key } | Sort-Object `
        @{ Expression = { if ([string]$_.createdAt) { [string]$_.createdAt } else { '9999' } } }, `
        @{ Expression = { [string]$_.id } })
    if ($sharing.Count -lt 2 -or ([string]$sharing[0].id) -eq ([string]$id)) { return Format-DocName $name }
    return Format-DocName "$name ($id)"
}

function Resolve-ClientDocFolder($email) {
    $addr = ([string]$email).Trim().ToLower()
    $emailFolder = Format-DocName $addr
    $families = @($households.Values | Where-Object { $_.id -and $_.name -and (Get-GroupKind $_) -ne 'company' })
    $mine = @($families | Where-Object {
        @($_.members | Where-Object { $_ -and ([string]$_.email).ToLower() -eq $addr }).Count -gt 0
    } | Sort-Object `
        @{ Expression = { if ([string]$_.createdAt) { [string]$_.createdAt } else { '9999' } } }, `
        @{ Expression = { [string]$_.id } })
    if ($mine.Count) {
        $famHolders = @($families | ForEach-Object {
            @{ key = ([string]$_.name).Trim().ToLower(); id = [string]$_.id; createdAt = [string]$_.createdAt } })
        return Get-UniqueDocFolder ([string]$mine[0].name) ([string]$mine[0].id) $famHolders
    }
    $me = $contacts[$addr]
    $myName = ''
    if ($me) { $myName = [string]$me.name }
    $folder = Get-PersonDocFolder $myName $addr
    if ($folder -eq $emailFolder) { return $emailFolder }
    $peopleHolders = @($contacts.Values | Where-Object { $_.email -and $_.name } | ForEach-Object {
        @{ key = (Get-PersonDocFolder $_.name $_.email).ToLower(); id = ([string]$_.email).ToLower(); createdAt = [string]$_.createdAt } })
    return Get-UniqueDocFolder $folder $addr $peopleHolders
}

# Assignees are admin accounts only (board lists are a separate grouping).
function Test-AssigneeAllowed($a) {
    $a = ([string]$a).Trim().ToLower()
    if (-not $a) { return $true }
    return $adminPasswords.ContainsKey($a)
}

# Mirror worker.js logTimeline: one entry serves both the per-client timeline
# and the global activity feed in the mock.
function Write-Timeline($client, $type, $actor, $detail) {
    if (-not $client) { return }
    $null = $timelineLog.Add([ordered]@{
        ts     = (Get-Date).ToString('o')
        client = ([string]$client).ToLower()
        type   = $type
        actor  = if ($actor) { $actor } else { 'system' }
        detail = $detail
    })
}

# Mirror worker.js filterDeletedReferences' content check: a note/task can
# never be created or edited with empty body/title, so an entry showing one is
# always leftover noise (from before delete handlers cleaned up their own
# timeline entries, or any other stale state). Belt-and-suspenders alongside
# the taskId/noteId cleanup the delete handlers do now.
function Test-TimelineEntryValid($e) {
    if ($e.type -eq 'note-added') { return [bool](([string]$e.detail.body).Trim()) }
    if (@('task-added', 'task-completed', 'meeting-added', 'meeting-held') -contains $e.type) {
        return [bool](([string]$e.detail.title).Trim())
    }
    return $true
}

# Mirror worker.js taskCalendarOwners: normalize the mailbox list, accepting the
# pre-multi singular `calendarOwner` so older payloads/records still work.
# Always returns an array — a bare @() would serialize to null, and the picker
# reads this straight back.
function ConvertTo-CalendarOwners($many, $one) {
    $src = if ($null -ne $many) { @($many) } elseif ([string]$one) { @([string]$one) } else { @() }
    $out = [System.Collections.ArrayList]::new()
    foreach ($o in $src) {
        $e = ([string]$o).Trim().ToLower()
        if ($e -and -not $out.Contains($e)) { $null = $out.Add($e) }
    }
    return , @($out.ToArray())
}

# Mirror worker.js sanitizeChecklist: normalize to [{id, text, done}], drop blanks.
function ConvertTo-Checklist($raw) {
    $out = @()
    foreach ($item in @($raw)) {
        if (-not $item) { continue }
        $text = ([string]$item.text).Trim()
        if (-not $text) { continue }
        $id = if ($item.id) { [string]$item.id } else { 'ci-{0}' -f ([guid]::NewGuid().ToString('N').Substring(0, 6)) }
        $out += [ordered]@{ id = $id; text = $text; done = [bool]$item.done }
        if ($out.Count -ge 50) { break }
    }
    return , @($out)
}

# Mirror worker.js sanitizeDocuments: normalize to [{id, name, ready}], drop blanks.
function ConvertTo-Documents($raw) {
    $out = @()
    foreach ($item in @($raw)) {
        if (-not $item) { continue }
        $name = ([string]$item.name).Trim()
        if (-not $name) { continue }
        $id = if ($item.id) { [string]$item.id } else { 'doc-{0}' -f ([guid]::NewGuid().ToString('N').Substring(0, 6)) }
        $out += [ordered]@{ id = $id; name = $name; ready = [bool]$item.ready }
        if ($out.Count -ge 50) { break }
    }
    return , @($out)
}

function New-MockTask($fields) {
    $script:crmCounter++
    $id = 'task-{0:d6}' -f $script:crmCounter
    $now = (Get-Date).ToString('o')
    $createdBy = if ($fields.createdBy) { $fields.createdBy } else { 'system' }
    $task = [ordered]@{
        id = $id
        workspace = if ($fields.workspace) { ([string]$fields.workspace).Trim().ToLower() } else { $frankAdminEmail }
        title = [string]$fields.title
        description = [string]$fields.description
        client = [string]$fields.client
        assignee = [string]$fields.assignee
        list = [string]$fields.list
        due = [string]$fields.due
        priority = if ($taskPriorities -contains $fields.priority) { $fields.priority } else { 'medium' }
        category = if ($taskCategories -contains $fields.category) { $fields.category } elseif (([string]$fields.category).Trim()) { ([string]$fields.category).Trim() } else { 'other' }
        status = 'open'
        # Ticked off but not yet closed — see the worker's createTask.
        readyAt = $null
        readyBy = ''
        repeat = if ($taskRepeats -contains [string]$fields.repeat) { [string]$fields.repeat } else { '' }
        checklist = ConvertTo-Checklist $fields.checklist
        meetingType = [string]$fields.meetingType
        documents = ConvertTo-Documents $fields.documents
        # Event fields (a task with category 'meeting'); inert on a plain task.
        location = [string]$fields.location
        endDue = [string]$fields.endDue
        allDay = [bool]$fields.allDay
        eventStatus = if ($eventStatuses -contains [string]$fields.eventStatus) { [string]$fields.eventStatus } else { '' }
        # Whose Outlook calendars this mirrors onto. The mock has no Microsoft
        # Graph behind it, so values are stored and echoed back (enough to
        # exercise the picker) but no real calendar event is ever created.
        calendarOwners = ConvertTo-CalendarOwners $fields.calendarOwners $fields.calendarOwner
        outlookEvents = @{}
        createdBy = $createdBy
        createdAt = $now
        completedAt = $null
        history = @([ordered]@{ ts = $now; actor = $createdBy; type = 'created'; detail = $null })
    }
    $tasks[$id] = $task
    if ($task.client) {
        $evt = if ($task.category -eq 'meeting') { 'meeting-added' } else { 'task-added' }
        Write-Timeline $task.client $evt $createdBy @{ taskId = $id; title = $task.title; due = $task.due }
    }
    return $task
}

# Mirror worker.js syncOnboardingContact: the CRM follows the wizard, and
# status only ever moves forward (missing/prospect -> onboarding -> active) so
# an advisor's own 'active'/'inactive' call outranks the wizard.
function Sync-OnboardingContact($email, $rec) {
    $desired = if ($rec.completionTime) { 'active' } else { 'onboarding' }
    $allowedFrom = if ($desired -eq 'active') { @('prospect', 'onboarding') } else { @('prospect') }
    $existing = $contacts[$email]

    $wizardName = ''
    if ($rec.data.profile) {
        $wizardName = (@($rec.data.profile.firstName, $rec.data.profile.lastName) | Where-Object { $_ }) -join ' '
    }
    if (-not $wizardName -and $rec.data.consent -and $rec.data.consent.name) { $wizardName = [string]$rec.data.consent.name }
    $wizardName = $wizardName.Trim()

    if (-not $existing) {
        $c = [ordered]@{ email = $email; name = ''; preferredName = ''; status = $desired; household = ''
            advisor = ''; phone = ''; workEmail = ''; workPhone = ''; address = ''; gender = ''
            tags = @(); importantDates = @(); createdAt = (Get-Date).ToString('o'); updatedAt = $null }
    }
    else {
        $c = $existing
        if ($allowedFrom -contains [string]$c.status) { $c.status = $desired }
    }
    # The wizard fills a blank name; it never overwrites what an advisor typed.
    if ($wizardName -and -not $c.name) { $c.name = $wizardName }
    $c.updatedAt = (Get-Date).ToString('o')
    $contacts[$email] = $c
}

# Mirror worker.js maybeAutoTask: fire each rule once per client.
function Invoke-AutoTask($rule, $client, $fields) {
    $marker = "${rule}:${client}"
    if ($autoTaskMarkers.ContainsKey($marker)) { return }
    $autoTaskMarkers[$marker] = $true
    $assignee = ''
    if ($contacts.ContainsKey($client) -and $contacts[$client].advisor) { $assignee = $contacts[$client].advisor }
    $f = @{} + $fields
    $f.client = $client
    $f.assignee = $assignee
    $f.createdBy = 'auto'
    $null = New-MockTask $f
}

# ---- Admin MFA (TOTP) mirror of worker.js. In-memory; no encryption (the real
# worker encrypts the secret at rest). Algorithm validated vs RFC 6238 vectors. ----
$base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function ConvertTo-Base32([byte[]]$bytes) {
    $bits = 0; $value = 0; $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) {
        $value = ($value -shl 8) -bor $b; $bits += 8
        while ($bits -ge 5) { [void]$sb.Append($base32Alphabet[(($value -shr ($bits - 5)) -band 31)]); $bits -= 5 }
    }
    if ($bits -gt 0) { [void]$sb.Append($base32Alphabet[(($value -shl (5 - $bits)) -band 31)]) }
    return $sb.ToString()
}
function ConvertFrom-Base32([string]$b32) {
    $bits = 0; $value = 0; $out = New-Object System.Collections.Generic.List[byte]
    foreach ($ch in $b32.TrimEnd('=').ToUpper().ToCharArray()) {
        $idx = $base32Alphabet.IndexOf($ch)
        if ($idx -lt 0) { continue }
        $value = ($value -shl 5) -bor $idx; $bits += 5
        if ($bits -ge 8) { $out.Add([byte](($value -shr ($bits - 8)) -band 0xff)); $bits -= 8 }
    }
    return $out.ToArray()
}
function Get-TotpCode([byte[]]$secret, [long]$counter) {
    $msg = New-Object byte[] 8
    $c = $counter
    for ($i = 7; $i -ge 0; $i--) { $msg[$i] = [byte]($c -band 0xff); $c = [long][math]::Floor($c / 256) }
    $hmac = New-Object System.Security.Cryptography.HMACSHA1
    $hmac.Key = $secret
    $sig = $hmac.ComputeHash($msg)
    $offset = $sig[19] -band 0x0f
    $bin = ((($sig[$offset] -band 0x7f) -shl 24) -bor (($sig[$offset + 1] -band 0xff) -shl 16) -bor (($sig[$offset + 2] -band 0xff) -shl 8) -bor ($sig[$offset + 3] -band 0xff))
    return ('{0:D6}' -f ($bin % 1000000))
}
function Test-Totp([string]$secretB32, [string]$code) {
    $clean = ($code -replace '\s', '')
    if ($clean -notmatch '^\d{6}$') { return $false }
    $secret = ConvertFrom-Base32 $secretB32
    $counter = [long][math]::Floor([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() / 30)
    for ($w = -1; $w -le 1; $w++) {
        if ((Get-TotpCode $secret ($counter + $w)) -eq $clean) { return $true }
    }
    return $false
}
function Get-Sha256Hex([string]$s) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}
function New-TotpSecret {
    $bytes = New-Object byte[] 20
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ConvertTo-Base32 $bytes
}
function New-BackupCodes {
    $codes = @()
    for ($i = 0; $i -lt 8; $i++) {
        $b = New-Object byte[] 5
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
        $hex = (($b | ForEach-Object { $_.ToString('x2') }) -join '')
        $codes += ($hex.Substring(0, 5) + '-' + $hex.Substring(5))
    }
    return $codes
}
function Get-OtpauthUri([string]$email, [string]$secret) {
    $issuer = 'BlueLine Advisors'
    $label = [Uri]::EscapeDataString("${issuer}:${email}")
    return "otpauth://totp/$label`?secret=$secret&issuer=$([Uri]::EscapeDataString($issuer))&algorithm=SHA1&digits=6&period=30"
}

# Fixed-window rate limiting, mirroring worker.js. [limit, windowSeconds].
$rateLimits = @{ login = @(10, 300); register = @(5, 3600); onboardingStart = @(20, 3600) }
$rateState = @{}

function Test-RateLimit($scope, $ip) {
    $limit = $rateLimits[$scope][0]
    $windowMs = $rateLimits[$scope][1] * 1000
    $key = "$scope`:$ip"
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $rec = $rateState[$key]
    if (-not $rec -or ($now - $rec.windowStart) -ge $windowMs) {
        $rateState[$key] = @{ count = 1; windowStart = $now }
        return $true
    }
    if ($rec.count -ge $limit) { return $false }
    $rec.count++
    return $true
}

function Get-ClientIp($ctx) {
    $ip = $ctx.Request.Headers['CF-Connecting-IP']
    if ($ip) { return $ip }
    return $ctx.Request.RemoteEndPoint.Address.ToString()
}

function Send-Json($ctx, $code, $obj) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 12))
    $ctx.Response.StatusCode = $code
    $ctx.Response.ContentType = 'application/json'
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.Close()
}

function Send-File($ctx, $path) {
    $types = @{ '.html'='text/html'; '.css'='text/css'; '.js'='application/javascript'; '.png'='image/png'; '.svg'='image/svg+xml' }
    $ext = [IO.Path]::GetExtension($path).ToLower()
    $ctx.Response.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
    # Mirrors serveAsset in worker.js. Without this the mock sent no
    # Cache-Control at all, so the browser cached script.js heuristically and
    # kept running an edited-away version - which cost real debugging time
    # chasing a bug that was already fixed on disk.
    if (@('.html', '.css', '.js') -contains $ext) {
        $ctx.Response.Headers['Cache-Control'] = 'no-cache'
    }
    $bytes = [IO.File]::ReadAllBytes($path)
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.Close()
}

function Read-Body($ctx) {
    # UTF-8 explicitly, not $ctx.Request.ContentEncoding: fetch() sends
    # "application/json" with no charset, HttpListener then falls back to the OS
    # ANSI codepage, and every non-ASCII character in a posted string arrives
    # mojibaked (an em-dash becomes three chars).
    $reader = New-Object IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
    $raw = $reader.ReadToEnd()
    if ($raw) { $raw | ConvertFrom-Json } else { $null }
}

function Get-SessionEmail($ctx) {
    $auth = $ctx.Request.Headers['Authorization']
    if ($auth -match '^Bearer\s+(.+)$') { return $sessions[$Matches[1]] }
    return $null
}

function Get-AdminEmail($ctx) {
    $auth = $ctx.Request.Headers['Authorization']
    if ($auth -match '^Bearer\s+(.+)$') { return $adminSessions[$Matches[1]] }
    return $null
}

function Get-RecordWorkspace($rec) {
    if ($rec -and [string]$rec.workspace) { return ([string]$rec.workspace).Trim().ToLower() }
    return $frankAdminEmail
}

function Test-SupervisorAdmin($adminEmail) {
    return $adminEmail -eq $frankAdminEmail -or $adminEmail -eq $jennAdminEmail -or $adminEmail -eq $internAdminEmail
}

function Get-AccessibleWorkspaces($adminEmail) {
    $frankMembers = @($adminWorkspaceAccess[$frankAdminEmail])
    if (Test-SupervisorAdmin $adminEmail) {
        return , @($adminPasswords.Keys | Where-Object { $_ -eq $frankAdminEmail -or $frankMembers -notcontains $_ })
    }
    if ($frankMembers -contains $adminEmail) { return , @($frankAdminEmail) }
    return , @($adminEmail)
}

function Get-AdminWorkspace($ctx, $adminEmail) {
    $allowed = @(Get-AccessibleWorkspaces $adminEmail)
    $requested = ([string]$ctx.Request.Headers['X-Admin-Workspace']).Trim().ToLower()
    if (-not $requested) { $requested = $allowed[0] }
    $combinedPath = @('/api/admin/workspaces', '/api/admin/contacts', '/api/admin/tasks') -contains $ctx.Request.Url.AbsolutePath
    if ($requested -eq $allAdminWorkspaces -and (Test-SupervisorAdmin $adminEmail) -and $ctx.Request.HttpMethod -eq 'GET' -and $combinedPath) {
        return $allAdminWorkspaces
    }
    if ($allowed -contains $requested) { return $requested }
    return $null
}

function New-Token { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) }) }

function Get-RiskCategory($score) {
    if ($score -le 9) { 'Conservative' }
    elseif ($score -le 14) { 'Moderately Conservative' }
    elseif ($score -le 19) { 'Moderate' }
    elseif ($score -le 24) { 'Moderately Aggressive' }
    else { 'Aggressive' }
}

function Get-Allocation($category) {
    switch ($category) {
        'Conservative'            { @{ stocks = 25; bonds = 55; cash = 20 } }
        'Moderately Conservative' { @{ stocks = 40; bonds = 45; cash = 15 } }
        'Moderate'                { @{ stocks = 55; bonds = 35; cash = 10 } }
        'Moderately Aggressive'   { @{ stocks = 70; bonds = 25; cash = 5 } }
        'Aggressive'              { @{ stocks = 85; bonds = 12; cash = 3 } }
    }
}

# [math]::Round defaults to banker's rounding (half-to-even); AwayFromZero
# matches worker.js's Math.round for these non-negative operands.
function Build-Module($name, $body) {
    switch ($name) {
        'risk' {
            $score = 0
            $answers = @{}
            foreach ($i in 1..5) { $v = [int]$body.answers.$i; $answers["$i"] = $v; $score += $v }
            $category = Get-RiskCategory $score
            return @{
                experienceLevel = $body.experienceLevel; answers = $answers; score = $score
                category = $category; suggestedAllocation = Get-Allocation $category
                goalShortTerm = "$($body.goalShortTerm)"; goalMediumTerm = "$($body.goalMediumTerm)"; goalLongTerm = "$($body.goalLongTerm)"
            }
        }
        'budget' {
            $expenses = @{}
            $total = 0.0
            foreach ($p in $body.expenses.PSObject.Properties) { $expenses[$p.Name] = [double]$p.Value; $total += [double]$p.Value }
            $income = [double]$body.monthlyIncome
            $savings = [double]$body.monthlySavings
            $rate = if ($income -gt 0) { [math]::Round(($savings / $income) * 100, 1, [MidpointRounding]::AwayFromZero) } else { 0 }
            return @{
                monthlyIncome = $income; expenses = $expenses; monthlySavings = $savings
                totalExpenses = $total; surplus = $income - $total - $savings; savingsRate = $rate
            }
        }
        'retirement' {
            $months = [math]::Round(([double]$body.targetAge - [double]$body.currentAge) * 12, [MidpointRounding]::AwayFromZero)
            $rate = 0.06 / 12
            $contribution = [double]$body.monthlyContribution + [double]$body.employerMatchMonthly
            $balance = [double]$body.currentSavings
            foreach ($m in 1..$months) { $balance = $balance * (1 + $rate) + $contribution }
            $target = [math]::Round([double]$body.desiredMonthlyIncome * 12 * 25, [MidpointRounding]::AwayFromZero)
            $readiness = if ($target -gt 0) { [math]::Min(999, [math]::Round($balance / $target * 100, [MidpointRounding]::AwayFromZero)) } else { $null }
            return @{
                currentAge = [double]$body.currentAge; targetAge = [double]$body.targetAge
                currentSavings = [double]$body.currentSavings; monthlyContribution = [double]$body.monthlyContribution
                employerMatchMonthly = [double]$body.employerMatchMonthly; desiredMonthlyIncome = [double]$body.desiredMonthlyIncome
                oldEmployerPlans = $body.oldEmployerPlans; projectedBalance = [math]::Round($balance, [MidpointRounding]::AwayFromZero)
                targetNestEgg = $target; readinessPct = $readiness
            }
        }
        'networth' {
            $assets = @{}; $ta = 0.0
            foreach ($p in $body.assets.PSObject.Properties) { $assets[$p.Name] = [double]$p.Value; $ta += [double]$p.Value }
            $debts = @{}; $tl = 0.0
            foreach ($p in $body.liabilities.PSObject.Properties) { $debts[$p.Name] = [double]$p.Value; $tl += [double]$p.Value }
            return @{ assets = $assets; liabilities = $debts; totalAssets = $ta; totalLiabilities = $tl; netWorth = $ta - $tl }
        }
        'compensation' {
            $totalComp = [double]$body.baseSalary + [double]$body.annualBonus + [double]$body.annualEquityValue
            return @{
                baseSalary = [double]$body.baseSalary; annualBonus = [double]$body.annualBonus
                annualEquityValue = [double]$body.annualEquityValue; equityTypes = @($body.equityTypes)
                contributionPct = [double]$body.contributionPct; employerMatchPct = [double]$body.employerMatchPct
                hsaEligible = [bool]$body.hsaEligible; deferredComp = [bool]$body.deferredComp
                employerStockConcentration = $body.employerStockConcentration; totalComp = $totalComp
                concentrationFlag = @('15to30', 'over30') -contains $body.employerStockConcentration
            }
        }
        'spending' {
            $essentials = @{}; $te = 0.0
            foreach ($p in $body.essentials.PSObject.Properties) { $essentials[$p.Name] = [double]$p.Value; $te += [double]$p.Value }
            $discretionary = @{}; $td = 0.0
            foreach ($p in $body.discretionary.PSObject.Properties) { $discretionary[$p.Name] = [double]$p.Value; $td += [double]$p.Value }
            $income = [double]$body.monthlyIncome
            $totalSpending = $te + $td
            $leftover = $income - $totalSpending
            $discPct = if ($totalSpending -gt 0) { [math]::Round(($td / $totalSpending) * 100, 1, [MidpointRounding]::AwayFromZero) } else { 0 }
            return @{
                monthlyIncome = $income; essentials = $essentials; discretionary = $discretionary
                totalEssentials = $te; totalDiscretionary = $td; totalSpending = $totalSpending
                leftover = $leftover; discretionaryPct = $discPct
                overspending = ($leftover -lt 0); highDiscretionary = ($discPct -ge 40)
            }
        }
        'savings' {
            $expenses = [double]$body.monthlyExpenses
            $fund = [double]$body.emergencyFund
            $monthly = [double]$body.monthlySavings
            $targetMonths = [double]$body.targetMonths
            $monthsCovered = if ($expenses -gt 0) { [math]::Round($fund / $expenses, 1, [MidpointRounding]::AwayFromZero) } else { $null }
            $targetAmount = $expenses * $targetMonths
            $shortfall = [math]::Max(0.0, $targetAmount - $fund)
            $monthsToTarget = if ($shortfall -eq 0) { 0 } elseif ($monthly -gt 0) { [int][math]::Ceiling($shortfall / $monthly) } else { $null }
            return @{
                monthlyExpenses = $expenses; emergencyFund = $fund; monthlySavings = $monthly
                targetMonths = $targetMonths; goalsNotes = "$($body.goalsNotes)"
                monthsCovered = $monthsCovered; targetAmount = $targetAmount; shortfall = $shortfall
                monthsToTarget = $monthsToTarget; funded = ($shortfall -eq 0)
            }
        }
        'debt' {
            $debts = @{}; $totalDebt = 0.0; $weighted = 0.0
            $highestRateType = $null; $highestRate = -1.0; $highInterest = $false
            foreach ($k in @('creditCards', 'autoLoans', 'studentLoans', 'personalLoans')) {
                $bal = [double]$body.debts.$k.balance
                $rate = [double]$body.debts.$k.rate
                $debts[$k] = @{ balance = $bal; rate = $rate }
                $totalDebt += $bal
                $weighted += $bal * $rate
                if ($bal -gt 0) {
                    if ($rate -gt $highestRate) { $highestRate = $rate; $highestRateType = $k }
                    if ($rate -ge 10) { $highInterest = $true }
                }
            }
            $payments = [double]$body.monthlyDebtPayments
            $income = [double]$body.grossMonthlyIncome
            $avgRate = if ($totalDebt -gt 0) { [math]::Round($weighted / $totalDebt, 1, [MidpointRounding]::AwayFromZero) } else { 0 }
            $dti = if ($income -gt 0) { [math]::Round(($payments / $income) * 100, 1, [MidpointRounding]::AwayFromZero) } else { $null }
            $highDti = ($null -ne $dti) -and ($dti -ge 36)
            return @{
                debts = $debts; monthlyDebtPayments = $payments; grossMonthlyIncome = $income
                totalDebt = $totalDebt; weightedAvgRate = $avgRate; dtiPct = $dti
                highestRateType = $highestRateType; highDti = $highDti; highInterest = $highInterest
            }
        }
        'riskcapacity' {
            $score = 0
            $answers = @{}
            foreach ($i in 1..5) { $v = [int]$body.answers.$i; $answers["$i"] = $v; $score += $v }
            $level = if ($score -le 9) { 'Low' } elseif ($score -le 14) { 'Moderately Low' } elseif ($score -le 19) { 'Moderate' } elseif ($score -le 24) { 'Moderately High' } else { 'High' }
            return @{ answers = $answers; score = $score; level = $level }
        }
        'behavior' {
            $score = 0
            $answers = @{}
            foreach ($i in 1..4) { $v = [int]$body.answers.$i; $answers["$i"] = $v; $score += $v }
            $profile = if ($score -le 7) { 'Highly Cautious' } elseif ($score -le 11) { 'Cautious' } elseif ($score -le 15) { 'Composed' } else { 'Opportunistic' }
            return @{
                answers = $answers; score = $score; profile = $profile
                coachingFlag = ($score -le 7); biggestConcern = "$($body.biggestConcern)"
            }
        }
        'knowledge' {
            $instruments = @()
            if ($null -ne $body.instruments) { $instruments = @(@($body.instruments) | Select-Object -Unique) }
            $count = $instruments.Count
            $yearsPoints = switch ("$($body.yearsInvesting)") {
                'none'   { 0 }
                'under3' { 1 }
                '3to10'  { 2 }
                'over10' { 3 }
                default  { 0 }
            }
            $selfRating = [int]$body.selfRating
            $kScore = $yearsPoints + [math]::Min(4, $count) + $selfRating
            $level = if ($kScore -le 3) { 'Novice' } elseif ($kScore -le 6) { 'Developing' } elseif ($kScore -le 9) { 'Experienced' } else { 'Sophisticated' }
            return @{
                yearsInvesting = "$($body.yearsInvesting)"; instruments = @($instruments)
                selfRating = $selfRating; hadAdvisor = [bool]$body.hadAdvisor
                instrumentCount = $count; knowledgeScore = $kScore; level = $level
            }
        }
        'estatedocs' {
            $currentYear = (Get-Date).Year
            $documents = @{}
            $missing = @(); $unsure = @(); $stale = @()
            $haveCount = 0
            foreach ($k in @('will', 'trust', 'financialPoa', 'healthcareDirective', 'hipaaAuthorization')) {
                $doc = $body.documents.$k
                $status = "$($doc.status)"
                $year = $null
                if ($status -eq 'yes' -and $null -ne $doc.year) { $year = [int]$doc.year }
                $documents[$k] = @{ status = $status; year = $year }
                if ($status -eq 'yes') {
                    $haveCount++
                    if ($null -ne $year -and $year -le ($currentYear - 5)) { $stale += $k }
                }
                elseif ($status -eq 'no') { $missing += $k }
                else { $unsure += $k }
            }
            return @{
                documents = $documents; haveCount = $haveCount
                completenessPct = [int][math]::Round($haveCount / 5 * 100)
                missing = @($missing); unsure = @($unsure); stale = @($stale)
            }
        }
        'beneficiaries' {
            $ra = "$($body.retirementAccounts)"; $lp = "$($body.lifePolicies)"
            $tod = "$($body.todBrokerage)"; $reviewed = "$($body.lastReviewed)"
            $events = @()
            if ($null -ne $body.lifeEvents) { $events = @(@($body.lifeEvents) | Select-Object -Unique) }
            $gapCount = 0
            if (@('some', 'none') -contains $ra) { $gapCount++ }
            if (@('some', 'none') -contains $lp) { $gapCount++ }
            if ($tod -eq 'no') { $gapCount++ }
            $eventsSinceReview = @($events | Where-Object { $_ -ne 'none' })
            $reviewNeeded = (@('over3', 'never') -contains $reviewed) -or ($eventsSinceReview.Count -gt 0) -or ($gapCount -gt 0)
            return @{
                retirementAccounts = $ra; lifePolicies = $lp; todBrokerage = $tod; lastReviewed = $reviewed
                lifeEvents = @($events); gapCount = $gapCount; eventsSinceReview = @($eventsSinceReview)
                reviewNeeded = $reviewNeeded
            }
        }
        'legacy' {
            $ci = "$($body.charitableIntent)"; $ag = "$($body.annualGifting)"
            $special = @()
            if ($null -ne $body.specialCircumstances) { $special = @(@($body.specialCircumstances) | Select-Object -Unique) }
            $topics = @()
            if (@('annual', 'both') -contains $ci) { $topics += 'Charitable giving strategy (donor-advised fund, QCDs)' }
            if (@('bequest', 'both') -contains $ci) { $topics += 'Charitable bequest planning' }
            if ($special -contains 'minorChildren') { $topics += 'Guardianship and trust provisions for minor children' }
            if ($special -contains 'specialNeeds') { $topics += 'Special needs trust planning' }
            if ($special -contains 'blendedFamily') { $topics += 'Blended family estate structuring' }
            if ($special -contains 'businessSuccession') { $topics += 'Business succession planning' }
            if (@('family', 'both') -contains $ag) { $topics += 'Annual gift tax exclusion strategy' }
            return @{
                charitableIntent = $ci; annualGifting = $ag; specialCircumstances = @($special)
                legacyNotes = "$($body.legacyNotes)"; discussionTopics = @($topics); topicCount = $topics.Count
            }
        }
        'lifeinsurance' {
            $debts = [double]$body.debts; $income = [double]$body.annualIncome; $years = [double]$body.incomeYears
            $mortgage = [double]$body.mortgageBalance; $education = [double]$body.educationCosts; $coverage = [double]$body.currentCoverage
            $dimeNeed = [math]::Round($debts + $income * $years + $mortgage + $education, [MidpointRounding]::AwayFromZero)
            $gap = [math]::Round($dimeNeed - $coverage, [MidpointRounding]::AwayFromZero)
            $pct = if ($dimeNeed -gt 0) { [math]::Min(999, [math]::Round($coverage / $dimeNeed * 100, [MidpointRounding]::AwayFromZero)) } else { $null }
            return @{
                debts = $debts; annualIncome = $income; incomeYears = $years
                mortgageBalance = $mortgage; educationCosts = $education; currentCoverage = $coverage
                dimeNeed = $dimeNeed; gap = $gap; coveragePct = $pct; underinsured = ($gap -gt 0)
            }
        }
        'coverage' {
            $lines = @{}; $gaps = @(); $unsure = @(); $coveredCount = 0
            foreach ($k in @('termLife', 'disability', 'umbrella', 'longTermCare', 'homeAuto')) {
                $line = $body.lines.$k
                $status = "$($line.status)"
                $amount = $null
                if ($status -eq 'yes' -and $k -ne 'homeAuto' -and $null -ne $line.amount) { $amount = [double]$line.amount }
                $lines[$k] = @{ status = $status; amount = $amount }
                if ($status -eq 'yes') { $coveredCount++ }
                elseif ($status -eq 'no') { $gaps += $k }
                else { $unsure += $k }
            }
            return @{ lines = $lines; coveredCount = $coveredCount; gaps = @($gaps); unsure = @($unsure) }
        }
        'ltc' {
            $plan = "$($body.fundingPlan)"; $earmarked = "$($body.assetsEarmarked)"
            $readiness = if ($plan -ne 'none' -and $earmarked -eq 'yes') { 'Planned' }
                         elseif ($plan -ne 'none') { 'Partially planned' }
                         else { 'Not yet planned' }
            $timely = (@('50to59', '60plus') -contains "$($body.ageBand)") -and ($readiness -eq 'Not yet planned')
            return @{
                ageBand = "$($body.ageBand)"; familyHistory = "$($body.familyHistory)"
                fundingPlan = $plan; assetsEarmarked = $earmarked
                readiness = $readiness; timelyFlag = $timely
            }
        }
    }
    return $null
}

Import-ComplianceSeed

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Mock portal server on http://localhost:$port/"
Write-Host "  compliance items loaded: $($complianceItems.Count)"

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
        $path = $ctx.Request.Url.AbsolutePath
        $method = $ctx.Request.HttpMethod

        if ($path -eq '/api/register' -and $method -eq 'POST') {
            if (-not (Test-RateLimit 'register' (Get-ClientIp $ctx))) { Send-Json $ctx 429 @{ error = 'Too many attempts. Please try again later.' }; continue }
            $body = Read-Body $ctx
            if ($users.ContainsKey($body.email)) { Send-Json $ctx 409 @{ error = 'An account with this email already exists' }; continue }
            $users[$body.email] = @{ name = $body.name; email = $body.email; password = $body.password }
            $token = New-Token
            $sessions[$token] = $body.email
            Write-Timeline $body.email 'account-created' 'client' $null
            Send-Json $ctx 201 @{ token = $token; name = $body.name; email = $body.email }
        }
        elseif ($path -eq '/api/login' -and $method -eq 'POST') {
            if (-not (Test-RateLimit 'login' (Get-ClientIp $ctx))) { Send-Json $ctx 429 @{ error = 'Too many login attempts. Please try again later.' }; continue }
            $body = Read-Body $ctx
            $u = $users[$body.email]
            if (-not $u -or $u.password -ne $body.password) { Send-Json $ctx 401 @{ error = 'Invalid email or password' }; continue }
            $token = New-Token
            $sessions[$token] = $body.email
            Write-Timeline $body.email 'login' 'client' $null
            Send-Json $ctx 200 @{ token = $token; name = $u.name; email = $u.email }
        }
        elseif ($path -eq '/api/logout' -and $method -eq 'POST') {
            Send-Json $ctx 200 @{ ok = $true }
        }
        elseif ($path -eq '/api/admin/login' -and $method -eq 'POST') {
            $body = Read-Body $ctx
            $email = ([string]$body.email).Trim().ToLower()
            $expected = $adminPasswords[$email]
            if ((-not $expected) -or (([string]$body.password).Trim() -ne $expected.Trim())) {
                Send-Json $ctx 401 @{ error = 'Invalid email or password' }; continue
            }
            # Password OK, but a second factor is always required. Issue a pending token.
            $mfa = $adminMfa[$email]
            $enrolled = ($mfa -and $mfa.confirmed)
            $pendingToken = New-Token
            $adminPending[$pendingToken] = $email
            $status = if ($enrolled) { 'mfa' } else { 'enroll' }
            Send-Json $ctx 200 @{ status = $status; pendingToken = $pendingToken }
        }
        elseif ($path -eq '/api/admin/mfa/enroll' -and $method -eq 'POST') {
            $body = Read-Body $ctx
            $email = $adminPending[[string]$body.pendingToken]
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Session expired — please sign in again.' }; continue }
            $existing = $adminMfa[$email]
            if ($existing -and $existing.confirmed) { Send-Json $ctx 409 @{ error = 'MFA is already set up.' }; continue }
            $secret = New-TotpSecret
            $codes = New-BackupCodes
            $hashed = @($codes | ForEach-Object { @{ hash = (Get-Sha256Hex $_); used = $false } })
            $adminMfa[$email] = @{ secret = $secret; confirmed = $false; backupCodes = $hashed; createdAt = (Get-Date).ToString('o') }
            Send-Json $ctx 200 @{ secret = $secret; otpauthUri = (Get-OtpauthUri $email $secret); backupCodes = $codes }
        }
        elseif ($path -eq '/api/admin/mfa/verify' -and $method -eq 'POST') {
            $body = Read-Body $ctx
            $pendingToken = [string]$body.pendingToken
            $email = $adminPending[$pendingToken]
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Session expired — please sign in again.' }; continue }
            $code = [string]$body.code
            if (-not $code) { Send-Json $ctx 400 @{ error = 'Enter the 6-digit code.' }; continue }
            $mfa = $adminMfa[$email]
            if (-not $mfa) { Send-Json $ctx 400 @{ error = 'MFA is not set up.' }; continue }
            $ok = Test-Totp $mfa.secret $code
            $usedBackup = $false
            if (-not $ok) {
                $codeHash = Get-Sha256Hex (($code -replace '\s', '').ToLower())
                foreach ($bc in $mfa.backupCodes) {
                    if ((-not $bc.used) -and ($bc.hash -eq $codeHash)) { $bc.used = $true; $ok = $true; $usedBackup = $true; break }
                }
            }
            if (-not $ok) { Send-Json $ctx 401 @{ error = 'Invalid code.' }; continue }
            if ((-not $mfa.confirmed) -or $usedBackup) { $mfa.confirmed = $true }
            $adminPending.Remove($pendingToken)
            $token = New-Token
            $adminSessions[$token] = $email
            $mfaMethod = if ($usedBackup) { 'backup-code' } else { 'totp' }
            Write-Audit $email 'login' @{ mfa = $mfaMethod }
            Send-Json $ctx 200 @{ token = $token; email = $email; usedBackup = $usedBackup }
        }
        elseif ($path -eq '/api/admin/workspaces' -and $method -eq 'GET') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $allowed = Get-AccessibleWorkspaces $adminEmail
            $active = Get-AdminWorkspace $ctx $adminEmail
            if (-not $active) { $active = $allowed[0] }
            $workspaces = @($allowed | ForEach-Object {
                @{ owner = $_; name = $adminNames[$_]; own = ($_ -eq $adminEmail) }
            })
            $admins = @($adminPasswords.Keys | ForEach-Object { @{ email = $_; name = $adminNames[$_]; supervisor = (Test-SupervisorAdmin $_) } })
            $grants = @{}
            if (Test-SupervisorAdmin $adminEmail) {
                foreach ($owner in $adminPasswords.Keys) { $grants[$owner] = @($adminWorkspaceAccess[$owner]) }
            }
            Send-Json $ctx 200 @{ you = $adminEmail; boss = (Test-SupervisorAdmin $adminEmail); sharedOwner = $frankAdminEmail; active = $active; workspaces = $workspaces; admins = $admins; grants = $grants }
        }
        elseif ($path -eq '/api/admin/workspaces/access' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            if (-not (Test-SupervisorAdmin $adminEmail)) { Send-Json $ctx 403 @{ error = 'Only firm supervisors can manage workspace access' }; continue }
            $body = Read-Body $ctx
            $owner = ([string]$body.owner).Trim().ToLower()
            if ($owner -ne $frankAdminEmail) { Send-Json $ctx 400 @{ error = "Employees can only be assigned to Frank's display" }; continue }
            $members = @(@($jennAdminEmail, $internAdminEmail) + @($body.members | ForEach-Object { ([string]$_).Trim().ToLower() }) |
                Where-Object { $_ -and $_ -ne $owner -and $adminPasswords.ContainsKey($_) } | Select-Object -Unique)
            $adminWorkspaceAccess[$owner] = $members
            Write-Audit $adminEmail 'workspace-access-changed' @{ owner = $owner; members = $members }
            Send-Json $ctx 200 @{ owner = $owner; members = $members }
        }
        elseif ($path -eq '/api/admin/tasks' -and $method -eq 'GET') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $visibleWorkspaces = if ($workspace -eq $allAdminWorkspaces) { @(Get-AccessibleWorkspaces $adminEmail) } else { @($workspace) }
            $sorted = @($tasks.Values | Where-Object { $visibleWorkspaces -contains (Get-RecordWorkspace $_) } | Sort-Object -Property createdAt -Descending)
            Send-Json $ctx 200 @{ tasks = $sorted; decryptErrors = 0; workspace = $workspace }
        }
        elseif ($path -eq '/api/admin/tasks' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $body = Read-Body $ctx
            if (-not $body -or -not [string]$body.title) { Send-Json $ctx 400 @{ error = 'Title is required' }; continue }
            if ($body.PSObject.Properties['priority'] -and $taskPriorities -notcontains [string]$body.priority) { Send-Json $ctx 400 @{ error = 'Invalid priority' }; continue }
            if ($body.PSObject.Properties['category'] -and $taskCategories -notcontains [string]$body.category -and -not ([string]$body.category).Trim()) { Send-Json $ctx 400 @{ error = 'Invalid category' }; continue }
            if ($body.PSObject.Properties['assignee'] -and -not (Test-AssigneeAllowed $body.assignee)) {
                Send-Json $ctx 400 @{ error = 'Assignee must be an admin account' }; continue
            }
            # Checked without a nested loop on purpose: `continue` has to target
            # the request loop, and PowerShell's `continue` takes a label (not a
            # level count), so continuing out of a foreach here would abort the
            # server rather than skip to the next request.
            # Assigned before piping, not piped straight from the call: the
            # function's `, @(...)` return is a 1-element array wrapping the real
            # array, so piping it directly hands Where-Object the whole array as
            # one item and every list of 2+ owners looks like a single bad email.
            $wantOwners = ConvertTo-CalendarOwners $body.calendarOwners $body.calendarOwner
            $badOwner = @($wantOwners) | Where-Object { -not (Test-AssigneeAllowed $_) } | Select-Object -First 1
            if ($badOwner) { Send-Json $ctx 400 @{ error = 'Calendar owner must be an admin account' }; continue }
            $task = New-MockTask @{
                title = [string]$body.title; description = [string]$body.description
                client = ([string]$body.client).Trim().ToLower(); assignee = ([string]$body.assignee).Trim().ToLower()
                list = ([string]$body.list).Trim()
                due = [string]$body.due; priority = [string]$body.priority; category = [string]$body.category
                repeat = [string]$body.repeat
                checklist = $body.checklist
                meetingType = [string]$body.meetingType
                documents = $body.documents
                location = [string]$body.location; endDue = [string]$body.endDue
                allDay = [bool]$body.allDay; eventStatus = [string]$body.eventStatus
                calendarOwners = $body.calendarOwners; calendarOwner = [string]$body.calendarOwner
                workspace = $workspace
                createdBy = $adminEmail
            }
            Send-Json $ctx 200 @{ task = $task }
        }
        elseif ($path -match '^/api/admin/tasks/(.+)$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $id = [Uri]::UnescapeDataString($Matches[1])
            if (-not $tasks.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Task not found' }; continue }
            $task = $tasks[$id]
            if ((Get-RecordWorkspace $task) -ne $workspace) { Send-Json $ctx 404 @{ error = 'Task not found in this workspace' }; continue }
            $body = Read-Body $ctx
            if (-not $body) { Send-Json $ctx 400 @{ error = 'Invalid JSON body' }; continue }
            $wasOpen = $task.status -eq 'open'
            $wasReady = [bool]$task.readyAt
            $prevAssignee = [string]$task.assignee
            $ownersGiven = $body.PSObject.Properties['calendarOwners'] -or $body.PSObject.Properties['calendarOwner']
            $newOwners = if ($ownersGiven) { ConvertTo-CalendarOwners $body.calendarOwners $body.calendarOwner } else { $null }
            # Flat check for the same reason as the create handler: `continue`
            # must reach the request loop, which a nested foreach would prevent.
            # @() so a single owner still iterates as one string, not as chars.
            $badOwner = @($newOwners) | Where-Object { -not (Test-AssigneeAllowed $_) } | Select-Object -First 1
            if ($badOwner) { Send-Json $ctx 400 @{ error = 'Calendar owner must be an admin account' }; continue }
            if ($ownersGiven) {
                $task.calendarOwners = $newOwners
                # Retire the pre-multi field so it can't shadow the list.
                if ($task.Contains('calendarOwner')) { $task.calendarOwner = '' }
            }
            foreach ($f in @('title', 'description', 'client', 'assignee', 'list', 'due', 'priority', 'category', 'status', 'meetingType', 'repeat', 'location', 'endDue', 'eventStatus')) {
                if ($body.PSObject.Properties[$f]) { $task[$f] = [string]$body.$f }
            }
            if ($body.PSObject.Properties['allDay']) { $task.allDay = [bool]$body.allDay }
            if ($body.PSObject.Properties['checklist']) { $task.checklist = ConvertTo-Checklist $body.checklist }
            if ($body.PSObject.Properties['documents']) { $task.documents = ConvertTo-Documents $body.documents }
            # Mirror of the worker's ready transitions (see handleAdminUpdateTask):
            # `ready` stamps who/when, un-ticking a done task withdraws the
            # completion, and completing without a tick stamps one so every done
            # task records when it was ticked off.
            if ($body.PSObject.Properties['ready']) {
                if ([bool]$body.ready) {
                    if (-not $task.readyAt) {
                        $task.readyAt = (Get-Date).ToString('o')
                        $task.readyBy = $adminEmail
                    }
                } else {
                    $task.readyAt = $null
                    $task.readyBy = ''
                    if ($task.status -eq 'done') { $task.status = 'open' }
                }
            }
            if ($task.status -eq 'done' -and -not $task.readyAt) {
                $task.readyAt = (Get-Date).ToString('o')
                $task.readyBy = $adminEmail
            }
            if (-not $task.history) { $task.history = @() }
            $appendHistory = {
                param($type, $detail)
                $task.history = @($task.history) + , ([ordered]@{ ts = (Get-Date).ToString('o'); actor = $adminEmail; type = $type; detail = $detail })
            }
            if ($body.PSObject.Properties['assignee'] -and ([string]$task.assignee) -ne $prevAssignee) {
                & $appendHistory 'assigned' ([ordered]@{ from = $prevAssignee; to = [string]$task.assignee })
            }
            if ($wasOpen -and $task.status -eq 'done') {
                $task.completedAt = (Get-Date).ToString('o')
                & $appendHistory 'completed' $null
                if ($task.client) {
                    $evt = if ($task.category -eq 'meeting') { 'meeting-held' } else { 'task-completed' }
                    Write-Timeline $task.client $evt $adminEmail @{ taskId = $id; title = $task.title }
                }
            }
            if ((-not $wasOpen) -and $task.status -eq 'open') {
                $task.completedAt = $null
                $task.readyAt = $null
                $task.readyBy = ''
                & $appendHistory 'reopened' $null
            }
            if ($wasOpen -and $task.status -eq 'open') {
                if ((-not $wasReady) -and $task.readyAt) { & $appendHistory 'ready' $null }
                if ($wasReady -and (-not $task.readyAt)) { & $appendHistory 'unready' $null }
            }
            if ($body.PSObject.Properties['comment'] -and ([string]$body.comment).Trim()) {
                & $appendHistory 'comment' ([ordered]@{ text = ([string]$body.comment).Trim() })
            }
            Send-Json $ctx 200 @{ task = $task }
        }
        elseif ($path -match '^/api/admin/tasks/(.+)$' -and $method -eq 'DELETE') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $delId = [Uri]::UnescapeDataString($Matches[1])
            if (-not $tasks.ContainsKey($delId) -or (Get-RecordWorkspace $tasks[$delId]) -ne $workspace) {
                Send-Json $ctx 404 @{ error = 'Task not found in this workspace' }; continue
            }
            $tasks.Remove($delId)
            # Drop this task's timeline/activity entries too, so a deleted task/
            # meeting doesn't linger in Recent Activity — mirrors worker.js's
            # deleteTimelineRefs (real backend deletes by stored key; the mock
            # just filters the in-memory log by taskId since it has no keys).
            $keep = @($timelineLog.ToArray() | Where-Object { -not ($_.detail -and $_.detail.taskId -eq $delId) })
            $timelineLog.Clear()
            foreach ($e in $keep) { $null = $timelineLog.Add($e) }
            Send-Json $ctx 200 @{ ok = $true }
        }
        # ---- Portal links (mirror of worker.js handleAdminGetPortalLinks etc.) ----
        # https-only validation is mirrored here on purpose: the client portal
        # renders these as hrefs, so a javascript: URL would be stored XSS, and
        # the mock is where that path gets exercised locally.
        elseif ($path -eq '/api/admin/portal-links' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            Send-Json $ctx 200 @{ links = @($portalLinks) }
        }
        elseif ($path -eq '/api/admin/portal-links' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            if (-not (Test-SupervisorAdmin $adminEmail)) { Send-Json $ctx 403 @{ error = 'Only firm supervisors can change firm-wide portal links' }; continue }
            $body = Read-Body $ctx
            if (-not $body -or $null -eq $body.links) { Send-Json $ctx 400 @{ error = 'links must be a list' }; continue }
            if (@($body.links).Count -gt 12) { Send-Json $ctx 400 @{ error = 'No more than 12 links' }; continue }
            $clean = [System.Collections.ArrayList]@()
            $bad = $null
            foreach ($l in @($body.links)) {
                if (-not $l) { continue }
                $label = ([string]$l.label).Trim()
                $url = ([string]$l.url).Trim()
                if (-not $label) { $bad = 'Every link needs a label'; break }
                $ok = $false
                try { $ok = ([Uri]$url).Scheme -eq 'https' } catch { $ok = $false }
                if (-not $ok) { $bad = "`"$label`" needs a valid https:// address"; break }
                $id = ([string]$l.id).Trim()
                if (-not $id) { $script:crmCounter++; $id = 'lnk-{0:d4}' -f $script:crmCounter }
                $null = $clean.Add([ordered]@{
                    id = $id; label = $label; url = $url
                    description = ([string]$l.description).Trim()
                    enabled = ($l.enabled -ne $false)
                })
            }
            if ($bad) { Send-Json $ctx 400 @{ error = $bad }; continue }
            $script:portalLinks = @($clean)
            Write-Audit $adminEmail 'update-portal-links' @{ count = $portalLinks.Count }
            Send-Json $ctx 200 @{ links = @($portalLinks) }
        }
        # ---- Document requests (mirror of worker.js handleAdminListDocRequests etc.) ----
        # Matched before the bare /api/admin/contacts/(.+) route further down,
        # which would otherwise swallow ".../document-requests" as an email.
        elseif ($path -match '^/api/admin/contacts/(.+)/document-requests$' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            $reqs = @($docRequests.Values | Where-Object { $_.client -eq $target } |
                Sort-Object -Property @{ Expression = { [string]$_['requestedAt'] } } -Descending)
            Send-Json $ctx 200 @{ requests = $reqs; decryptErrors = 0 }
        }
        elseif ($path -match '^/api/admin/contacts/(.+)/document-requests$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            if ($target -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { Send-Json $ctx 400 @{ error = 'Invalid email' }; continue }
            $body = Read-Body $ctx
            $label = ([string]$body.label).Trim()
            if (-not $label) { Send-Json $ctx 400 @{ error = 'A document name is required' }; continue }
            $script:docReqCounter++
            $id = "${target}:req$($script:docReqCounter)"
            $rec = [ordered]@{
                id = $id; client = $target; label = $label
                notes = ([string]$body.notes).Trim(); dueDate = ([string]$body.dueDate).Trim()
                category = (Get-DocCategory $body.category)
                status = 'open'; requestedBy = $adminEmail; requestedAt = (Get-Date).ToString('o')
                fulfilledAt = $null; fulfilledDocId = ''
            }
            $docRequests[$id] = $rec
            Write-Audit $adminEmail 'request-client-document' @{ client = $target; label = $label }
            Write-Timeline $target 'document-requested' $adminEmail @{ label = $label }
            Send-Json $ctx 200 @{ request = $rec }
        }
        elseif ($path -match '^/api/admin/document-requests/(.+)$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $id = [Uri]::UnescapeDataString($Matches[1])
            if (-not $docRequests.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Request not found' }; continue }
            $rec = $docRequests[$id]
            $body = Read-Body $ctx
            if ($body.PSObject.Properties['status']) {
                $s = [string]$body.status
                if (@('open', 'fulfilled', 'cancelled') -notcontains $s) { Send-Json $ctx 400 @{ error = 'Invalid status' }; continue }
                if ($rec.status -eq 'fulfilled') {
                    Send-Json $ctx 400 @{ error = 'That request has already been fulfilled — ask again with a new request' }; continue
                }
                $rec.status = $s
                $rec['cancelledAt'] = if ($s -eq 'cancelled') { (Get-Date).ToString('o') } else { $null }
            }
            if ($body.PSObject.Properties['category']) { $rec['category'] = Get-DocCategory $body.category }
            foreach ($f in @('label', 'notes', 'dueDate')) {
                if ($body.PSObject.Properties[$f]) { $rec[$f] = ([string]$body.$f).Trim() }
            }
            $rec['updatedAt'] = (Get-Date).ToString('o')
            Send-Json $ctx 200 @{ request = $rec }
        }
        elseif ($path -match '^/api/admin/document-requests/(.+)$' -and $method -eq 'DELETE') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $id = [Uri]::UnescapeDataString($Matches[1])
            $existing = if ($docRequests.ContainsKey($id)) { $docRequests[$id] } else { $null }
            $docRequests.Remove($id)
            Write-Audit $adminEmail 'delete-document-request' @{
                client = if ($existing) { $existing.client } else { $null }
                label = if ($existing) { $existing.label } else { $null }
            }
            Send-Json $ctx 200 @{ ok = $true }
        }
        # ---- Client-facing documents ----
        elseif ($path -eq '/api/document-requests' -and $method -eq 'GET') {
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            # Household-wide: forEmail/forName say who was actually asked.
            $mem = Get-HouseholdMembers $email
            $reqs = @($docRequests.Values | Where-Object { $mem -contains $_.client -and $_.status -ne 'cancelled' } |
                Sort-Object -Property @{ Expression = { [string]$_['requestedAt'] } } -Descending |
                ForEach-Object { [ordered]@{
                    id = $_.id; label = $_.label; notes = $_.notes; dueDate = $_.dueDate
                    category = (Get-DocCategory $_.category)
                    status = $_.status; requestedAt = $_.requestedAt; fulfilledAt = $_.fulfilledAt
                    forEmail = $_.client; forName = (Get-MemberName $_.client) } })
            Send-Json $ctx 200 @{ requests = $reqs; categories = $docCategories; you = $email }
        }
        elseif ($path -eq '/api/documents' -and $method -eq 'GET') {
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            # source -eq 'client' ONLY. An advisor's attachment lives in the same
            # store but was filed with no expectation of client visibility.
            # Household-wide, with ownerEmail/ownerName so a shared row says whose
            # upload it is rather than blending a spouse's files with your own.
            $mem = Get-HouseholdMembers $email
            $docs = @($clientDocs.Values | Where-Object { $mem -contains $_.client -and $_.source -eq 'client' } |
                Sort-Object -Property @{ Expression = { [string]$_['uploadedAt'] } } -Descending |
                ForEach-Object { [ordered]@{
                    id = $_.id; name = $_.name; filename = $_.filename
                    size = $_.size; category = (Get-DocCategory $_.category); uploadedAt = $_.uploadedAt
                    ownerEmail = $_.client; ownerName = (Get-MemberName $_.client) } })
            Send-Json $ctx 200 @{ documents = $docs; categories = $docCategories; you = $email }
        }
        elseif ($path -eq '/api/documents/upload' -and $method -eq 'POST') {
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            $body = Read-Body $ctx
            $fname = Format-DocName ([IO.Path]::GetFileName([string]$body.filename))
            $dname = ([string]$body.name).Trim()
            $size = [int64]$body.size
            $reqId = ([string]$body.requestId).Trim()
            if (-not $fname) { Send-Json $ctx 400 @{ error = 'Choose a file to upload.' }; continue }
            if (-not $dname) { Send-Json $ctx 400 @{ error = 'Give the document a name.' }; continue }
            if ($size -le 0) { Send-Json $ctx 400 @{ error = 'File size is missing.' }; continue }
            if ($size -gt $clientUploadMax) { Send-Json $ctx 400 @{ error = 'That file is larger than the 25 MB limit.' }; continue }
            $ext = ''
            if ($fname -match '\.([a-zA-Z0-9]+)$') { $ext = $Matches[1].ToLower() }
            if ($clientUploadTypes -notcontains $ext) {
                $shown = if ($ext) { $ext } else { 'unknown' }
                Send-Json $ctx 400 @{ error = "We can't accept `".$shown`" files. Please upload a PDF, image, or Office document." }; continue
            }
            $mine = @($clientDocs.Values | Where-Object { $_.client -eq $email })
            if ($mine.Count -ge 200) { Send-Json $ctx 400 @{ error = 'You have reached the upload limit — please contact your advisor.' }; continue }
            # Only honour a request id that really is this client's and still open.
            # The request's category wins: the advisor said what they were asking
            # for, so the answer files where they filed the ask.
            # Household-scoped: one member can clear a request addressed to
            # another (the point of a shared portal), but nobody can clear an
            # unrelated client's request by guessing an id.
            $validReq = ''
            $category = Get-DocCategory $body.category
            $mem = Get-HouseholdMembers $email
            if ($reqId -and $docRequests.ContainsKey($reqId)) {
                $r = $docRequests[$reqId]
                if ($mem -contains $r.client -and $r.status -eq 'open') {
                    $validReq = $reqId
                    $category = Get-DocCategory $r.category
                }
            }
            $folder = Resolve-ClientDocFolder $email
            $script:docCounter++
            $uid = "cdoc$($script:docCounter)"
            $clientDocUploads[$uid] = @{
                client = $email; filename = $fname; name = $dname; size = $size
                received = [int64]0; folder = $folder; requestId = $validReq
                category = $category; source = 'client'
            }
            Send-Json $ctx 200 @{ ticket = $uid; chunkSize = (1024 * 1024) }
        }
        elseif ($path -eq '/api/documents/chunk' -and $method -eq 'PUT') {
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            $uid = [string]$ctx.Request.Headers['X-Upload-Ticket']
            $up = if ($uid) { $clientDocUploads[$uid] } else { $null }
            if (-not $up) { Send-Json $ctx 400 @{ error = 'Missing upload ticket' }; continue }
            if ($up.client -ne $email) { Send-Json $ctx 403 @{ error = 'Upload ticket does not belong to you' }; continue }
            $offset = [int64]$ctx.Request.Headers['X-Upload-Offset']
            $buf = New-Object byte[] 65536
            $len = [int64]0
            while (($read = $ctx.Request.InputStream.Read($buf, 0, $buf.Length)) -gt 0) { $len += $read }
            if ($len -le 0) { Send-Json $ctx 400 @{ error = 'Empty chunk' }; continue }
            if (($offset + $len) -gt $up.size) { Send-Json $ctx 400 @{ error = 'Chunk runs past the declared file size' }; continue }
            $up.received = $offset + $len
            if ($up.received -lt $up.size) { Send-Json $ctx 200 @{ done = $false; nextOffset = $up.received }; continue }
            $script:docCounter++
            $id = "$($up.client):$($script:docCounter)"
            $rec = [ordered]@{
                id = $id; client = $up.client; name = $up.name; filename = $up.filename
                folder = $up.folder
                webUrl = "https://bluelineadvisors.sharepoint.com/sites/BluelineTeam/ClientDocuments/$($up.folder)/$($up.filename)"
                driveId = 'mock-drive'; driveItemId = "item-$($script:docCounter)"
                size = $up.size; uploadedBy = $up.client; source = 'client'
                category = $up.category
                uploadedAt = (Get-Date).ToString('o')
            }
            $clientDocs[$id] = $rec
            $clientDocUploads.Remove($uid)
            if ($up.requestId -and $docRequests.ContainsKey($up.requestId)) {
                $r = $docRequests[$up.requestId]
                # Household-scoped, matching the upload-start check — comparing
                # against the caller alone would leave a spouse's request open
                # even though the document arrived.
                $memChunk = Get-HouseholdMembers $email
                if ($memChunk -contains $r.client -and $r.status -eq 'open') {
                    $r.status = 'fulfilled'
                    $r.fulfilledAt = (Get-Date).ToString('o')
                    $r.fulfilledDocId = $id
                    if ($r.client -ne $email) { $r['fulfilledBy'] = $email }
                }
            }
            Write-Timeline $email 'document-uploaded' 'client' @{ name = $up.name; filename = $up.filename }
            Send-Json $ctx 200 @{ done = $true; document = [ordered]@{
                id = $id; name = $rec.name; filename = $rec.filename; size = $rec.size
                category = $rec.category; uploadedAt = $rec.uploadedAt } }
        }
        elseif ($path -eq '/api/portal-links' -and $method -eq 'GET') {
            if (-not (Get-SessionEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            $visible = @($portalLinks | Where-Object {
                $ok = $false
                try { $ok = ([Uri]$_.url).Scheme -eq 'https' } catch { $ok = $false }
                $_.enabled -ne $false -and $ok
            } | ForEach-Object { [ordered]@{ id = $_.id; label = $_.label; url = $_.url; description = $_.description } })
            Send-Json $ctx 200 @{ links = $visible }
        }
        elseif ($path -eq '/api/admin/lists' -and $method -eq 'GET') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $lists = if ($workspace -eq $frankAdminEmail) { @($boardLists) } else { @($boardListsByWorkspace[$workspace]) }
            Send-Json $ctx 200 @{ lists = $lists; workspace = $workspace }
        }
        elseif ($path -eq '/api/admin/lists' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $lists = if ($workspace -eq $frankAdminEmail) { @($boardLists) } else { @($boardListsByWorkspace[$workspace]) }
            $body = Read-Body $ctx
            $type = if (([string]$body.type) -eq 'person') { 'person' } else { 'custom' }
            $newId = 'l-{0}' -f ([guid]::NewGuid().ToString('N').Substring(0, 6))
            if ($type -eq 'person') {
                $account = ([string]$body.account).Trim().ToLower()
                if (-not $adminPasswords.ContainsKey($account)) { Send-Json $ctx 400 @{ error = 'Pick an existing admin account' }; continue }
                if ($lists | Where-Object { $_.type -eq 'person' -and $_.account -eq $account }) {
                    Send-Json $ctx 400 @{ error = 'That person already has a list' }; continue
                }
                $list = [ordered]@{ id = $newId; type = 'person'; account = $account; createdAt = (Get-Date).ToString('o') }
            }
            else {
                $name = ([string]$body.name).Trim()
                if (-not $name) { Send-Json $ctx 400 @{ error = 'List name is required' }; continue }
                if ($lists | Where-Object { $_.type -eq 'custom' -and $_.name.ToLower() -eq $name.ToLower() }) {
                    Send-Json $ctx 400 @{ error = 'A list with that name already exists' }; continue
                }
                $list = [ordered]@{ id = $newId; type = 'custom'; name = $name; createdAt = (Get-Date).ToString('o') }
            }
            $lists = @($lists) + $list
            if ($workspace -eq $frankAdminEmail) { $boardLists = $lists } else { $boardListsByWorkspace[$workspace] = $lists }
            Send-Json $ctx 200 @{ list = $list; lists = $lists }
        }
        elseif ($path -match '^/api/admin/lists/(.+)$' -and $method -eq 'DELETE') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $lid = [Uri]::UnescapeDataString($Matches[1])
            $lists = if ($workspace -eq $frankAdminEmail) { @($boardLists) } else { @($boardListsByWorkspace[$workspace]) }
            $lists = @($lists | Where-Object { $_.id -ne $lid })
            if ($workspace -eq $frankAdminEmail) { $boardLists = $lists } else { $boardListsByWorkspace[$workspace] = $lists }
            Send-Json $ctx 200 @{ lists = $lists }
        }
        elseif ($path -eq '/api/admin/notes' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $clientFilter = $ctx.Request.QueryString['client']
            $list = @($notes.Values | Where-Object { -not $clientFilter -or $_.client -eq $clientFilter.ToLower() } | Sort-Object -Property createdAt -Descending)
            Send-Json $ctx 200 @{ notes = $list; decryptErrors = 0 }
        }
        elseif ($path -eq '/api/admin/notes' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $body = Read-Body $ctx
            $client = ([string]$body.client).Trim().ToLower()
            if ($client -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { Send-Json $ctx 400 @{ error = 'A valid client email is required' }; continue }
            if (-not ([string]$body.body).Trim()) { Send-Json $ctx 400 @{ error = 'Note text is required' }; continue }
            $script:crmCounter++
            $id = 'note-{0:d6}' -f $script:crmCounter
            $note = [ordered]@{
                id = $id; client = $client; author = $adminEmail
                body = ([string]$body.body).Trim()
                tags = @($body.tags | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() })
                pinned = [bool]$body.pinned
                createdAt = (Get-Date).ToString('o'); updatedAt = $null
            }
            $notes[$id] = $note
            Write-Timeline $client 'note-added' $adminEmail @{ noteId = $id; body = $note.body }
            Send-Json $ctx 200 @{ note = $note }
        }
        elseif ($path -match '^/api/admin/notes/(.+)$' -and $method -eq 'POST') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $id = [Uri]::UnescapeDataString($Matches[1])
            if (-not $notes.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Note not found' }; continue }
            $note = $notes[$id]
            $body = Read-Body $ctx
            if ($body.PSObject.Properties['body']) {
                if (-not ([string]$body.body).Trim()) { Send-Json $ctx 400 @{ error = 'Note text is required' }; continue }
                $note.body = ([string]$body.body).Trim()
            }
            if ($body.PSObject.Properties['tags']) { $note.tags = @($body.tags | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() }) }
            if ($body.PSObject.Properties['pinned']) { $note.pinned = [bool]$body.pinned }
            $note.updatedAt = (Get-Date).ToString('o')
            Send-Json $ctx 200 @{ note = $note }
        }
        elseif ($path -match '^/api/admin/notes/(.+)$' -and $method -eq 'DELETE') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $delNoteId = [Uri]::UnescapeDataString($Matches[1])
            $notes.Remove($delNoteId)
            # Drop this note's timeline/activity entry too — same reasoning as
            # the task delete handler above.
            $keep = @($timelineLog.ToArray() | Where-Object { -not ($_.detail -and $_.detail.noteId -eq $delNoteId) })
            $timelineLog.Clear()
            foreach ($e in $keep) { $null = $timelineLog.Add($e) }
            Send-Json $ctx 200 @{ ok = $true }
        }
        elseif ($path -match '^/api/admin/timeline/(.+)$' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $client = [Uri]::UnescapeDataString($Matches[1]).ToLower()
            $entries = @($timelineLog.ToArray() | Where-Object { $_.client -eq $client -and (Test-TimelineEntryValid $_) })
            [array]::Reverse($entries)
            Send-Json $ctx 200 @{ entries = $entries; hasMore = $false; cursor = $null }
        }
        elseif ($path -eq '/api/admin/activity' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $entries = @($timelineLog.ToArray() | Where-Object { Test-TimelineEntryValid $_ })
            [array]::Reverse($entries)
            $entries = @($entries | Select-Object -First 30)
            Send-Json $ctx 200 @{ entries = $entries; hasMore = $false; cursor = $null }
        }
        elseif ($path -eq '/api/admin/notifseen' -and $method -eq 'GET') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $seen = if ($notifSeen.ContainsKey($adminEmail)) { $notifSeen[$adminEmail] } else { $null }
            Send-Json $ctx 200 @{ seen = $seen }
        }
        elseif ($path -eq '/api/admin/notifseen' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $notifSeen[$adminEmail] = (Get-Date).ToString('o')
            Send-Json $ctx 200 @{ seen = $notifSeen[$adminEmail] }
        }
        # ---- Households (mirror of worker.js handleAdminListHouseholds etc.) ----
        elseif ($path -eq '/api/admin/households' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            # kind is normalised on the way out, matching worker.js - a record
            # written before kind existed reads as a family. Written back onto
            # the stored record rather than a copy: OrderedDictionary has no
            # Clone() through PowerShell's adapter, and the normalised value is
            # the same one the record would have been saved with anyway.
            foreach ($h in @($households.Values)) { $h.kind = (Get-GroupKind $h) }
            Send-Json $ctx 200 @{ households = @($households.Values) }
        }
        elseif ($path -eq '/api/admin/households' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $body = Read-Body $ctx
            if (-not $body) { Send-Json $ctx 400 @{ error = 'Invalid JSON body' }; continue }
            $kind = 'family'
            if ($body.PSObject.Properties['kind']) {
                $kind = ([string]$body.kind).Trim().ToLower()
                if ($groupKinds -notcontains $kind) {
                    Send-Json $ctx 400 @{ error = 'Invalid kind - must be family or company' }; continue
                }
            }
            $noun = if ($kind -eq 'company') { 'Company' } else { 'Family' }
            $name = ([string]$body.name).Trim()
            if (-not $name) { Send-Json $ctx 400 @{ error = "$noun name is required" }; continue }
            $mem = ConvertTo-HouseholdMembers $body.members $kind
            if ($mem.error) { Send-Json $ctx 400 @{ error = $mem.error }; continue }
            # worker.js rejects an unknown status rather than coercing it, so
            # this must too — silently defaulting here would let a bad value
            # pass locally and 400 only in production.
            if ($body.PSObject.Properties['status'] -and $contactStatuses -notcontains ([string]$body.status)) {
                Send-Json $ctx 400 @{ error = 'Invalid status' }; continue
            }
            $script:householdCounter++
            $id = 'hh-{0:d6}' -f $script:householdCounter
            $rec = [ordered]@{
                id = $id; type = 'household'; kind = $kind; name = $name
                members = @($mem.members)
                email = ([string]$body.email).Trim().ToLower()
                emailType = ([string]$body.emailType).Trim().ToLower()
                emailPrimary = if ($body.PSObject.Properties['emailPrimary']) { [bool]$body.emailPrimary } else { $true }
                assignedTo = ([string]$body.assignedTo).Trim().ToLower()
                advisorRep = ([string]$body.advisorRep).Trim()
                contactType = ([string]$body.contactType).Trim()
                background = ([string]$body.background).Trim()
                tags = @($body.tags | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() })
                status = if ($contactStatuses -contains ([string]$body.status)) { [string]$body.status } else { 'active' }
                archived = $false
                createdBy = $adminEmail
                createdAt = (Get-Date).ToString('o'); updatedAt = $null
            }
            $households[$id] = $rec
            Write-Audit $adminEmail 'create-household' @{ id = $id; name = $name; kind = $kind }
            Send-Json $ctx 200 @{ household = $rec }
        }
        elseif ($path -match '^/api/admin/households/(hh-[a-z0-9]+)$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $id = $Matches[1]
            if (-not $households.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Household not found' }; continue }
            $body = Read-Body $ctx
            if (-not $body) { Send-Json $ctx 400 @{ error = 'Invalid JSON body' }; continue }
            $rec = $households[$id]
            # Resolved before members: their roles are validated against it.
            $kind = Get-GroupKind $rec
            if ($body.PSObject.Properties['kind']) {
                $k = ([string]$body.kind).Trim().ToLower()
                if ($groupKinds -notcontains $k) {
                    Send-Json $ctx 400 @{ error = 'Invalid kind - must be family or company' }; continue
                }
                $kind = $k
            }
            $rec.kind = $kind
            $noun = if ($kind -eq 'company') { 'Company' } else { 'Family' }
            if ($body.PSObject.Properties['name']) {
                $n = ([string]$body.name).Trim()
                if (-not $n) { Send-Json $ctx 400 @{ error = "$noun name is required" }; continue }
                $rec.name = $n
            }
            if ($body.PSObject.Properties['members']) {
                $mem = ConvertTo-HouseholdMembers $body.members $kind
                if ($mem.error) { Send-Json $ctx 400 @{ error = $mem.error }; continue }
                $rec.members = @($mem.members)
            }
            if ($body.PSObject.Properties['status'] -and $contactStatuses -notcontains ([string]$body.status)) {
                Send-Json $ctx 400 @{ error = 'Invalid status' }; continue
            }
            foreach ($f in @('email', 'emailType', 'assignedTo', 'advisorRep', 'contactType', 'background', 'status')) {
                if ($body.PSObject.Properties[$f]) { $rec[$f] = ([string]$body.$f).Trim() }
            }
            if ($body.PSObject.Properties['emailPrimary']) { $rec.emailPrimary = [bool]$body.emailPrimary }
            if ($body.PSObject.Properties['archived']) { $rec.archived = [bool]$body.archived }
            if ($body.PSObject.Properties['tags']) { $rec.tags = @($body.tags | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() }) }
            $rec.updatedAt = (Get-Date).ToString('o')
            $households[$id] = $rec
            Write-Audit $adminEmail 'update-household' @{ id = $id }
            Send-Json $ctx 200 @{ household = $rec }
        }
        elseif ($path -match '^/api/admin/households/(hh-[a-z0-9]+)$' -and $method -eq 'DELETE') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $id = $Matches[1]
            if (-not $households.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Household not found' }; continue }
            $households.Remove($id)
            Write-Audit $adminEmail 'delete-household' @{ id = $id }
            Send-Json $ctx 200 @{ ok = $true }
        }
        elseif ($path -eq '/api/admin/contacts' -and $method -eq 'GET') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $visibleWorkspaces = if ($workspace -eq $allAdminWorkspaces) { @(Get-AccessibleWorkspaces $adminEmail) } else { @($workspace) }
            $merged = @{}
            foreach ($rec in $contacts.Values) {
                $owner = Get-RecordWorkspace $rec
                if ($visibleWorkspaces -notcontains $owner) { continue }
                $merged[$rec.email] = [ordered]@{
                    email = $rec.email; name = $rec.name; preferredName = $rec.preferredName; status = $rec.status
                    archived = [bool]$rec.archived
                    household = $rec.household; advisor = $rec.advisor; phone = $rec.phone
                    workEmail = $rec.workEmail; workPhone = $rec.workPhone; address = $rec.address; gender = $rec.gender
                    tags = @($rec.tags); importantDates = @($rec.importantDates)
                    createdAt = $rec.createdAt; updatedAt = $rec.updatedAt
                    hasAccount = $false; modules = @{}; modulesError = $false; assignments = $null
                    workspace = $owner
                }
            }
            foreach ($u in $users.Values) {
                $entry = $merged[$u.email]
                if (-not $entry -and $visibleWorkspaces -notcontains $frankAdminEmail) { continue }
                if (-not $entry) {
                    $entry = [ordered]@{
                        email = $u.email; name = ''; preferredName = ''; status = 'active'
                        archived = $false
                        household = ''; advisor = ''; phone = ''
                        workEmail = ''; workPhone = ''; address = ''; gender = ''
                        tags = @(); importantDates = @()
                        createdAt = $null; updatedAt = $null
                        hasAccount = $false; modules = @{}; modulesError = $false; assignments = $null
                        workspace = $frankAdminEmail
                    }
                }
                $entry.hasAccount = $true
                if (-not $entry.name) { $entry.name = $u.name }
                # Effective (shared + personal), not the raw per-member record:
                # most assessments live in the household copy now, and reading
                # only $responses would show them as never started to the advisor.
                $entry.modules = Get-EffectiveModules $u.email
                $entry.assignments = if ($assignments.ContainsKey($u.email)) { @($assignments[$u.email]) } else { $null }
                $merged[$u.email] = $entry
            }
            Send-Json $ctx 200 @{ contacts = @($merged.Values); admins = @($adminPasswords.Keys); adminNames = $adminNames; workspace = $workspace }
        }
        elseif ($path -match '^/api/admin/contacts/(.+)/(archive|unarchive)$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            $archived = ($Matches[2] -eq 'archive')
            if ($target -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { Send-Json $ctx 400 @{ error = 'Invalid contact email' }; continue }
            $rec = $contacts[$target]
            if ($rec -and (Get-RecordWorkspace $rec) -ne $workspace) { Send-Json $ctx 404 @{ error = 'Contact not found in this workspace' }; continue }
            if (-not $rec) {
                $rec = [ordered]@{ email = $target; name = ''; status = 'prospect'; household = ''; advisor = ''; phone = ''
                    tags = @(); importantDates = @(); workspace = $workspace; createdAt = (Get-Date).ToString('o'); updatedAt = $null }
            }
            $rec.archived = $archived
            $rec.archivedAt = if ($archived) { (Get-Date).ToString('o') } else { $null }
            $rec.archivedBy = if ($archived) { $adminEmail } else { $null }
            $rec.updatedAt = (Get-Date).ToString('o')
            $contacts[$target] = $rec
            Write-Audit $adminEmail $(if ($archived) { 'archive-contact' } else { 'unarchive-contact' }) @{ client = $target }
            Send-Json $ctx 200 @{ contact = $rec }
        }
        # Additional Info and client documents, before the greedy upsert route
        # below for the same reason /archive is: its (.+) would swallow the
        # suffix into the email.
        elseif ($path -match '^/api/admin/contacts/(.+)/info$' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            $info = if ($clientInfo.ContainsKey($target)) { $clientInfo[$target] } else { [ordered]@{} }
            Send-Json $ctx 200 @{ info = (Add-ClientInfoDerived $info) }
        }
        elseif ($path -match '^/api/admin/contacts/(.+)/info$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            if ($target -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { Send-Json $ctx 400 @{ error = 'Invalid email' }; continue }
            $body = Read-Body $ctx
            if (-not $body) { Send-Json $ctx 400 @{ error = 'Invalid JSON body' }; continue }
            # Validated into a SEPARATE hashtable, merged into the stored record
            # only once every field passes - mirroring sanitizeClientInfo() in
            # worker.js, which builds its own `out`. Writing into the live record
            # while validating meant a rejected request still left the bad value
            # behind, and a stored bad taxYear then blocked every later save.
            $changes = [ordered]@{}
            $bad = $null
            foreach ($p in $body.PSObject.Properties) {
                $k = $p.Name
                $v = $p.Value
                if ($clientInfoDates -contains $k) {
                    $s = ([string]$v).Trim()
                    if ($s -and $s -notmatch '^\d{4}-\d{2}-\d{2}$') { $bad = "$k must be a date (YYYY-MM-DD)"; break }
                    $changes[$k] = $s
                }
                elseif ($clientInfoMoney -contains $k) {
                    $s = ([string]$v) -replace '[$,\s]', ''
                    if (-not $s) { $changes[$k] = $null; continue }
                    $num = 0.0
                    if (-not [double]::TryParse($s, [ref]$num)) { $bad = "$k must be a number"; break }
                    $changes[$k] = [math]::Round($num, 2)
                }
                elseif ($clientInfoEnums.ContainsKey($k)) {
                    $s = ([string]$v).Trim()
                    if ($s -and $clientInfoEnums[$k] -notcontains $s) {
                        $bad = "$k must be one of: $($clientInfoEnums[$k] -join ', ')"; break
                    }
                    $changes[$k] = $s
                }
                elseif ($k -eq 'taxYear') {
                    $s = ([string]$v).Trim()
                    # Checked against the INCOMING value only, not the merged
                    # record: a save that doesn't mention taxYear must not be
                    # judged on what is already stored.
                    if ($s -and $s -notmatch '^\d{4}$') { $bad = 'taxYear must be a 4-digit year'; break }
                    $changes[$k] = $s
                }
                else { $changes[$k] = ([string]$v).Trim() }
            }
            if ($bad) { Send-Json $ctx 400 @{ error = $bad }; continue }
            $rec = if ($clientInfo.ContainsKey($target)) { $clientInfo[$target] } else { [ordered]@{} }
            foreach ($k in $changes.Keys) { $rec[$k] = $changes[$k] }
            $rec['email'] = $target
            if (-not $rec.Contains('createdAt')) { $rec['createdAt'] = (Get-Date).ToString('o') }
            $rec['updatedAt'] = (Get-Date).ToString('o')
            $rec['updatedBy'] = $adminEmail
            $clientInfo[$target] = $rec
            # Field NAMES only, matching worker.js - the values include passport
            # and licence numbers that have no business in an audit record.
            Write-Audit $adminEmail 'update-client-info' @{ client = $target; fields = @($body.PSObject.Properties.Name | Sort-Object) }
            Send-Json $ctx 200 @{ info = (Add-ClientInfoDerived $rec) }
        }
        elseif ($path -match '^/api/admin/contacts/(.+)/emails$' -and $method -eq 'GET') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            # No real Graph behind the mock, so this is fixed sample data for the
            # one seeded test contact and empty for everyone else - enough to
            # exercise the tab's three states (has mail / no mail / not
            # configured) without live Outlook credentials.
            $candidates = if ($clientEmailsMock.ContainsKey($target)) { $clientEmailsMock[$target] } else { @() }
            # Same two-stage shape as the worker: the seeded list stands in for
            # what $search returns, then the participant gate drops text-only
            # matches (see the decoy in $clientEmailsMock).
            $msgs = @($candidates | Where-Object { Test-ClientIsParticipant $_ $target })
            $dropped = @($candidates).Count - $msgs.Count
            Write-Audit $adminEmail 'view-client-emails' @{ client = $target; count = $msgs.Count }
            Send-Json $ctx 200 @{ emails = $msgs; configured = $true; permissionMissing = $false
                mailboxErrors = @(); droppedNotParticipant = $dropped }
        }
        elseif ($path -match '^/api/admin/contacts/(.+)/documents$' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            # Sorted through an explicit indexer expression: `-Property uploadedAt`
            # does not resolve a key on an [ordered]@{} record, so it silently
            # left insertion order and the mock disagreed with the worker's
            # newest-first list.
            $docs = @($clientDocs.Values | Where-Object { $_.client -eq $target } |
                Sort-Object -Property @{ Expression = { [string]$_['uploadedAt'] } } -Descending)
            # The mock has no SharePoint, so it always reports configured - the
            # unconfigured path is exercised by unsetting the real env var.
            Send-Json $ctx 200 @{ documents = $docs; configured = $true }
        }
        elseif ($path -match '^/api/admin/contacts/(.+)/documents/upload$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            if ($target -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { Send-Json $ctx 400 @{ error = 'Invalid email' }; continue }
            $body = Read-Body $ctx
            $fname = [IO.Path]::GetFileName([string]$body.filename)
            $dname = ([string]$body.name).Trim()
            $size = [int64]$body.size
            if (-not $fname) { Send-Json $ctx 400 @{ error = 'A file is required' }; continue }
            if (-not $dname) { Send-Json $ctx 400 @{ error = 'A document name is required' }; continue }
            if ($size -le 0) { Send-Json $ctx 400 @{ error = 'File size is missing' }; continue }
            if ($size -gt (250 * 1024 * 1024)) { Send-Json $ctx 400 @{ error = 'File is larger than the 250 MB limit' }; continue }
            $script:docCounter++
            $uid = "doc$($script:docCounter)"
            $folder = Resolve-ClientDocFolder $target
            $clientDocUploads[$uid] = @{ client = $target; filename = $fname; name = $dname; size = $size; received = [int64]0; folder = $folder }
            # 1 MiB here rather than 5, so a small test file still exercises the
            # multi-chunk loop.
            Send-Json $ctx 200 @{ ticket = $uid; chunkSize = (1024 * 1024) }
        }
        elseif ($path -eq '/api/admin/client-documents/chunk' -and $method -eq 'PUT') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $uid = [string]$ctx.Request.Headers['X-Upload-Ticket']
            $up = if ($uid) { $clientDocUploads[$uid] } else { $null }
            if (-not $up) { Send-Json $ctx 400 @{ error = 'Missing upload ticket' }; continue }
            $offset = [int64]$ctx.Request.Headers['X-Upload-Offset']
            $buf = New-Object byte[] 65536
            $len = [int64]0
            while (($read = $ctx.Request.InputStream.Read($buf, 0, $buf.Length)) -gt 0) { $len += $read }
            if ($len -le 0) { Send-Json $ctx 400 @{ error = 'Empty chunk' }; continue }
            if (($offset + $len) -gt $up.size) { Send-Json $ctx 400 @{ error = 'Chunk runs past the declared file size' }; continue }
            $up.received = $offset + $len
            if ($up.received -lt $up.size) { Send-Json $ctx 200 @{ done = $false; nextOffset = $up.received }; continue }
            $script:docCounter++
            $id = "$($up.client):$($script:docCounter)"
            $rec = [ordered]@{
                id = $id; client = $up.client; name = $up.name; filename = $up.filename
                folder = $up.folder
                webUrl = "https://bluelineadvisors.sharepoint.com/sites/BluelineTeam/ClientDocuments/$($up.folder)/$($up.filename)"
                driveId = 'mock-drive'; driveItemId = "item-$($script:docCounter)"
                # source distinguishes an advisor attachment from a client
                # send-in; /api/documents shows the client only their own.
                size = $up.size; uploadedBy = $adminEmail; source = 'admin'; uploadedAt = (Get-Date).ToString('o')
            }
            $clientDocs[$id] = $rec
            $clientDocUploads.Remove($uid)
            Write-Audit $adminEmail 'attach-client-document' @{ client = $up.client; name = $up.name; filename = $up.filename }
            Send-Json $ctx 200 @{ done = $true; document = $rec }
        }
        elseif ($path -match '^/api/admin/client-documents/(.+)$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $id = [Uri]::UnescapeDataString($Matches[1])
            if (-not $clientDocs.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Document not found' }; continue }
            $body = Read-Body $ctx
            $n = ([string]$body.name).Trim()
            if (-not $n) { Send-Json $ctx 400 @{ error = 'A document name is required' }; continue }
            $rec = $clientDocs[$id]
            $rec.name = $n
            $rec['updatedAt'] = (Get-Date).ToString('o')
            $rec['updatedBy'] = $adminEmail
            Write-Audit $adminEmail 'rename-client-document' @{ client = $rec.client; id = $id; name = $n }
            Send-Json $ctx 200 @{ document = $rec }
        }
        elseif ($path -match '^/api/admin/client-documents/(.+)$' -and $method -eq 'DELETE') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $id = [Uri]::UnescapeDataString($Matches[1])
            if (-not $clientDocs.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Document not found' }; continue }
            $client = $clientDocs[$id].client
            $name = $clientDocs[$id].name
            $clientDocs.Remove($id)
            # name mirrors the worker so the merged contact timeline names the
            # document instead of just saying "a" document was deleted.
            Write-Audit $adminEmail 'delete-client-document' @{ client = $client; id = $id; name = $name; fileDeleted = $true }
            Send-Json $ctx 200 @{ ok = $true; fileDeleted = $true }
        }
        elseif ($path -match '^/api/admin/contacts/(.+)$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            if ($target -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { Send-Json $ctx 400 @{ error = 'Invalid contact email' }; continue }
            $body = Read-Body $ctx
            if (-not $body) { Send-Json $ctx 400 @{ error = 'Invalid JSON body' }; continue }
            if ($body.PSObject.Properties['status'] -and $contactStatuses -notcontains [string]$body.status) {
                Send-Json $ctx 400 @{ error = 'Invalid status' }; continue
            }
            $rec = $contacts[$target]
            if ($rec -and (Get-RecordWorkspace $rec) -ne $workspace) { Send-Json $ctx 404 @{ error = 'Contact not found in this workspace' }; continue }
            if (-not $rec) {
                $rec = [ordered]@{ email = $target; name = ''; preferredName = ''; status = 'prospect'; household = ''
                    advisor = ''; phone = ''; workEmail = ''; workPhone = ''; address = ''; gender = ''
                    tags = @(); importantDates = @(); workspace = $workspace; createdAt = (Get-Date).ToString('o'); updatedAt = $null }
            }
            # advisor is a free-typed name (e.g. "Fred Sabin"), not tied to an
            # admin account email -- mirrors worker.js's sanitizeContactFields,
            # which never validates it against $adminPasswords.
            foreach ($f in @('name', 'preferredName', 'status', 'household', 'advisor', 'phone', 'workEmail', 'workPhone', 'address', 'gender')) {
                if ($body.PSObject.Properties[$f]) { $rec[$f] = ([string]$body.$f).Trim() }
            }
            if ($body.PSObject.Properties['tags']) { $rec.tags = @($body.tags | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() }) }
            if ($body.PSObject.Properties['importantDates']) {
                # Mirror worker.js: an absent repeatsAnnually reads as true so
                # legacy rows (which were all treated as recurring) keep working.
                $rec.importantDates = @($body.importantDates | Where-Object { $_ -and $_.label } | ForEach-Object {
                    $rep = if ($_.PSObject.Properties['repeatsAnnually']) { [bool]$_.repeatsAnnually } else { $true }
                    @{ label = ([string]$_.label).Trim(); date = [string]$_.date; repeatsAnnually = $rep }
                })
            }
            $rec.updatedAt = (Get-Date).ToString('o')
            $rec.workspace = $workspace
            $contacts[$target] = $rec
            Write-Audit $adminEmail 'update-contact' @{ client = $target }
            Send-Json $ctx 200 @{ contact = $rec }
        }
        elseif ($path -eq '/api/admin/admins' -and $method -eq 'GET') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $admins = @($adminPasswords.Keys | ForEach-Object {
                    $m = $adminMfa[$_]
                    @{ email = $_; name = $adminNames[$_]; mfaEnabled = [bool]($m -and $m.confirmed) }
                })
            Send-Json $ctx 200 @{ admins = $admins; you = $adminEmail; boss = (Test-SupervisorAdmin $adminEmail) }
        }
        elseif ($path -match '^/api/admin/admins/(.+)/name$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            if (-not (Test-SupervisorAdmin $adminEmail)) { Send-Json $ctx 403 @{ error = 'Only firm supervisors can rename admin accounts' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            if (-not $adminPasswords.ContainsKey($target)) { Send-Json $ctx 404 @{ error = 'Not an admin account' }; continue }
            $body = Read-JsonBody $ctx
            $name = if ($body) { ([string]$body.name).Trim() } else { '' }
            if (-not $name) { Send-Json $ctx 400 @{ error = "Enter the admin's name" }; continue }
            if ($name.Length -gt 200) { $name = $name.Substring(0, 200) }
            $adminNames[$target] = $name
            Write-Audit $adminEmail 'rename-admin' @{ target = $target; name = $name }
            Send-Json $ctx 200 @{ email = $target; name = $name }
        }
        elseif ($path -match '^/api/admin/mfa/reset/(.+)$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            if (-not (Test-SupervisorAdmin $adminEmail)) { Send-Json $ctx 403 @{ error = 'Only firm supervisors can reset admin MFA' }; continue }
            $target = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            if (-not $adminPasswords.ContainsKey($target)) { Send-Json $ctx 404 @{ error = 'Not an admin account' }; continue }
            $adminMfa.Remove($target)
            Write-Audit $adminEmail 'reset-mfa' @{ target = $target }
            Send-Json $ctx 200 @{ ok = $true }
        }
        elseif ($path -eq '/api/admin/logout' -and $method -eq 'POST') {
            $auth = $ctx.Request.Headers['Authorization']
            if ($auth -match '^Bearer\s+(.+)$') { $adminSessions.Remove($Matches[1]) }
            Send-Json $ctx 200 @{ ok = $true }
        }
        elseif ($path -eq '/api/assessments' -and $method -eq 'GET') {
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            if (-not $responses.ContainsKey($email)) { $responses[$email] = @{} }
            # The household's ONE shared copy, plus each member's personal four.
            $sharedMods = Get-SharedModules $email
            $personalBy = [ordered]@{}
            foreach ($m in (Get-HouseholdMembers $email)) {
                $personalBy[$m] = Get-PersonalModules $m
            }
            $hhRec = Get-HouseholdRecord $email
            Send-Json $ctx 200 @{
                modules = (Get-EffectiveModules $email)
                shared = $sharedMods
                personalByMember = $personalBy
                personalKeys = $personalAssessments
                householdId = if ($hhRec) { [string]$hhRec.id } else { '' }
                you = $email
            }
        }
        elseif ($path -eq '/api/household' -and $method -eq 'GET') {
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            $members = Get-HouseholdMembers $email
            $hh = Get-HouseholdRecord $email
            $roleOf = @{}
            if ($hh) { foreach ($m in $hh.members) { $roleOf[([string]$m.email).ToLower()] = [string]$m.role } }
            Send-Json $ctx 200 @{
                shared = ($members.Count -gt 1)
                householdName = if ($hh) { [string]$hh.name } else { '' }
                you = $email
                members = @($members | ForEach-Object { [ordered]@{
                    email = $_; name = (Get-MemberName $_)
                    role = if ($roleOf.ContainsKey($_)) { $roleOf[$_] } else { '' } } })
            }
        }
        elseif ($path -match '^/api/assessments/([a-z]+)$' -and $method -eq 'POST') {
            $moduleName = $Matches[1]
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            $body = Read-Body $ctx
            $module = Build-Module $moduleName $body
            if (-not $module) { Send-Json $ctx 404 @{ error = 'Unknown assessment module' }; continue }
            # Whose assessment. Validated against the household, never trusted —
            # otherwise `owner` would let any client write answers into anyone
            # else's record just by naming their address.
            $owner = $email
            $wanted = ([string]$body.owner).Trim().ToLower()
            if ($wanted -and $wanted -ne $email) {
                # Assigned first, never @()-wrapped inline: Get-HouseholdMembers
                # returns `, @(...)`, and wrapping that in @() nests the array
                # instead of flattening it (same trap as ConvertTo-CalendarOwners).
                $hhMembers = Get-HouseholdMembers $email
                if ($hhMembers -notcontains $wanted) {
                    Send-Json $ctx 403 @{ error = 'That assessment does not belong to your household' }; continue
                }
                $owner = $wanted
            }
            $module['updatedAt'] = (Get-Date).ToString('o')
            # Where it lives: a shared module goes to the ONE household record
            # (owner is meaningless there - every member edits that same copy);
            # a personal module goes to its owner's own record. No household
            # means everything stays in their own record, as before.
            $hhRec = Get-HouseholdRecord $email
            $isShared = (-not (Test-PersonalAssessment $moduleName)) -and $null -ne $hhRec
            if ($isShared) {
                # Read through the fallback so a pre-split answer already sitting
                # in a member's own record isn't treated as a first completion
                # (which would re-open a review task for finished work).
                $existing = Get-SharedModules $email
                $firstCompletion = -not $existing.ContainsKey($moduleName)
                if (-not $hhResponses.ContainsKey($hhRec.id)) { $hhResponses[$hhRec.id] = @{} }
                $hhResponses[$hhRec.id][$moduleName] = $module
            } else {
                if (-not $responses.ContainsKey($owner)) { $responses[$owner] = @{} }
                $firstCompletion = -not $responses[$owner].ContainsKey($moduleName)
                $responses[$owner][$moduleName] = $module
            }
            # A shared module is attributed to whoever filled it in; a personal
            # one to its owner.
            $attributedTo = if ($isShared) { $email } else { $owner }
            $evt = if ($firstCompletion) { 'assessment-completed' } else { 'assessment-updated' }
            $detail = @{ module = $moduleName }
            if ($isShared) { $detail['household'] = $true }
            elseif ($owner -ne $email) { $detail['filledInBy'] = $email }
            Write-Timeline $attributedTo $evt 'client' $detail
            if ($firstCompletion) {
                Invoke-AutoTask "review-assessment-$moduleName" $attributedTo @{
                    title = "Review $moduleName assessment - $attributedTo"
                    description = "The $moduleName assessment was completed. Review their responses."
                    category = 'review'
                }
            }
            Send-Json $ctx 200 @{
                module = $module
                modules = (Get-EffectiveModules $email)
                owner = if ($isShared) { '' } else { $owner }
                shared = $isShared
            }
        }
        elseif ($path -eq '/api/assignments' -and $method -eq 'GET') {
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            # `, @(...)` — the comma is load-bearing. PowerShell unrolls an empty
            # array returned from an `if` expression into $null, which collapsed
            # "nothing assigned" ([]) into "no record, show everything" (null) —
            # the exact opposite meaning. Same reason ConvertTo-CalendarOwners
            # returns `, @(...)`. The real worker returns a JS array and was
            # never affected; this only ever misled local testing.
            $asg = if ($assignments.ContainsKey($email)) { , @($assignments[$email]) } else { $null }
            # Per member plus a household union: a shared portal must show a
            # module if ANY member is assigned it. One member with no record
            # (= everything visible) makes the whole union null, by the same rule
            # that applies to them individually.
            $byMember = [ordered]@{}
            $union = [System.Collections.ArrayList]@()
            $anyUnrestricted = $false
            foreach ($m in (Get-HouseholdMembers $email)) {
                if ($assignments.ContainsKey($m)) {
                    $list = @($assignments[$m])
                    # NO `, @(...)` here. That wrapper protects a single-element
                    # array from unrolling when it is RETURNED, but assigning it
                    # into a hashtable stores the wrapper itself - which
                    # serialized byMember as [["risk",...]] instead of ["risk",...].
                    # The client then sees an array whose only element is an array,
                    # so .includes(moduleKey) is false for everything and every
                    # module reads as unassigned. ConvertTo-Json -Depth handles a
                    # genuinely empty list fine; it is `[]`, which is what we want.
                    $byMember[$m] = $list
                    foreach ($k in $list) { if (-not $union.Contains($k)) { $null = $union.Add($k) } }
                } else {
                    $byMember[$m] = $null
                    $anyUnrestricted = $true
                }
            }
            $unionOut = if ($anyUnrestricted) { $null } else { , @($union.ToArray()) }
            Send-Json $ctx 200 @{ assignments = $unionOut; byMember = $byMember; you = $email }
        }
        elseif ($path -match '^/api/admin/assignments/(.+)$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $email = [Uri]::UnescapeDataString($Matches[1]).Trim().ToLower()
            if (-not $users.ContainsKey($email)) { Send-Json $ctx 404 @{ error = 'Unknown client' }; continue }
            $body = Read-Body $ctx
            if (-not $body -or $null -eq $body.assignments) { Send-Json $ctx 400 @{ error = 'assignments must be an array of module keys' }; continue }
            $assignments[$email] = @($body.assignments)
            Write-Audit $adminEmail 'set-assignments' @{ client = $email; assignments = @($assignments[$email]) }
            Write-Timeline $email 'assignments-changed' $adminEmail @{ count = @($assignments[$email]).Count }
            Send-Json $ctx 200 @{ assignments = @($assignments[$email]) }
        }
        elseif ($path -eq '/api/onboarding/start' -and $method -eq 'POST') {
            if (-not (Test-RateLimit 'onboardingStart' (Get-ClientIp $ctx))) { Send-Json $ctx 429 @{ error = 'Too many onboarding sessions started. Please try again later.' }; continue }
            $script:onbCounter++
            $id = 'BLA-ONB-{0}-{1:d4}' -f (Get-Date).Year, $script:onbCounter
            $writeToken = New-Token
            $onbSecrets[$id] = $writeToken
            $onboardings[$id] = @{
                onboardingId = $id
                startTime = (Get-Date).ToString('o')
                completionTime = $null
                currentStep = 0
                data = @{}
                deleted = $false
                updatedAt = (Get-Date).ToString('o')
            }
            Send-Json $ctx 201 @{ onboardingId = $id; writeToken = $writeToken; startTime = $onboardings[$id].startTime }
        }
        elseif ($path -match '^/api/onboarding/(BLA-ONB-\d{4}-\d{4})$' -and $method -eq 'POST') {
            $id = $Matches[1]
            $provided = $ctx.Request.Headers['X-Onboarding-Token']
            if (-not $onbSecrets.ContainsKey($id) -or $provided -ne $onbSecrets[$id]) {
                Send-Json $ctx 401 @{ error = 'Invalid or missing onboarding write token' }; continue
            }
            if (-not $onboardings.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Unknown onboarding id' }; continue }
            $rec = $onboardings[$id]
            if ($rec.deleted) { Send-Json $ctx 410 @{ error = 'This onboarding record has been removed' }; continue }
            $body = Read-Body $ctx
            if (-not $body -or $body.onboardingId -ne $id) { Send-Json $ctx 400 @{ error = 'Body must include a matching onboardingId' }; continue }
            $prevCompletion = $rec.completionTime
            $prevSigned = [bool]($rec.data -and $rec.data.agreement -and $rec.data.agreement.signatureDataUrl)
            $rec.completionTime = $body.completionTime
            $rec.currentStep = [int]$body.currentStep
            $rec.data = $body.data
            $rec.updatedAt = (Get-Date).ToString('o')
            # CRM history + automation on transitions, mirroring worker.js.
            $clientEmail = ''
            if ($body.data.profile -and $body.data.profile.email) { $clientEmail = ([string]$body.data.profile.email).Trim().ToLower() }
            elseif ($body.data.consent -and $body.data.consent.email) { $clientEmail = ([string]$body.data.consent.email).Trim().ToLower() }
            if ($clientEmail -match '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
                if ($rec.completionTime -and -not $prevCompletion) {
                    Write-Timeline $clientEmail 'onboarding-completed' 'client' @{ onboardingId = $id }
                    Invoke-AutoTask "review-onboarding-$id" $clientEmail @{
                        title = "Review completed onboarding $id"
                        description = "$clientEmail finished the onboarding workflow. Review the submission."
                        category = 'onboarding'
                    }
                }
                $nowSigned = [bool]($body.data.agreement -and $body.data.agreement.signatureDataUrl)
                if ($nowSigned -and -not $prevSigned) {
                    Write-Timeline $clientEmail 'agreement-signed' 'client' @{ onboardingId = $id }
                    Invoke-AutoTask "open-account-$id" $clientEmail @{
                        title = "Open account - agreement signed ($id)"
                        description = "$clientEmail signed the advisory agreement. Begin account opening."
                        category = 'onboarding'
                    }
                }
                Sync-OnboardingContact $clientEmail $rec
            }
            Send-Json $ctx 200 @{ ok = $true; updatedAt = $rec.updatedAt }
        }
        elseif ($path -eq '/api/admin/onboarding' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            Send-Json $ctx 200 @{ records = @($onboardings.Values) }
        }
        elseif ($path -eq '/api/admin/audit' -and $method -eq 'GET') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            if (-not (Test-SupervisorAdmin $adminEmail)) { Send-Json $ctx 403 @{ error = 'Only firm supervisors can view the firm audit log' }; continue }
            $all = @($auditLog.ToArray())
            [array]::Reverse($all)  # newest first, mirroring the worker
            $limit = 10
            # Mock cursor is a numeric offset into the newest-first list (the real
            # worker uses an opaque KV cursor; both are opaque to the client).
            $offset = 0
            $q = $ctx.Request.QueryString['cursor']
            if ($q) { [void][int]::TryParse($q, [ref]$offset) }
            $entries = @($all | Select-Object -Skip $offset -First $limit)
            $nextOffset = $offset + $limit
            $hasMore = $nextOffset -lt $all.Count
            $nextCursor = if ($hasMore) { "$nextOffset" } else { $null }
            Send-Json $ctx 200 @{ entries = $entries; limit = $limit; hasMore = $hasMore; cursor = $nextCursor }
        }
        elseif ($path -match '^/api/admin/onboarding/(BLA-ONB-\d{4}-\d{4})/restore$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $id = $Matches[1]
            if (-not $onboardings.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Not found or already purged' }; continue }
            $onboardings[$id].deleted = $false
            $onboardings[$id].Remove('deletedAt')
            Write-Audit $adminEmail 'restore-onboarding' @{ onboardingId = $id }
            Send-Json $ctx 200 @{ ok = $true }
        }
        elseif ($path -match '^/api/admin/onboarding/(BLA-ONB-\d{4}-\d{4})$' -and $method -eq 'DELETE') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $id = $Matches[1]
            if (-not $onboardings.ContainsKey($id)) { Send-Json $ctx 404 @{ error = 'Not found' }; continue }
            $onboardings[$id].deleted = $true
            $onboardings[$id]['deletedAt'] = (Get-Date).ToString('o')
            Write-Audit $adminEmail 'delete-onboarding' @{ onboardingId = $id }
            Send-Json $ctx 200 @{ ok = $true; deletedAt = $onboardings[$id]['deletedAt'] }
        }
        elseif ($path -eq '/api/admin/clients' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $clients = @($users.Values | ForEach-Object {
                # Same reason as the contact list: shared assessments live in the
                # household record, so the raw per-member map is incomplete.
                $mods = Get-EffectiveModules $_.email
                $asg = if ($assignments.ContainsKey($_.email)) { @($assignments[$_.email]) } else { $null }
                @{ name = $_.name; email = $_.email; modules = $mods; assignments = $asg }
            })
            Send-Json $ctx 200 @{ clients = $clients }
        }
        elseif ($path -eq '/api/admin/compliance' -and $method -eq 'GET') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            if ($workspace -ne $frankAdminEmail) { Send-Json $ctx 403 @{ error = "Compliance is only available in Frank's shared view" }; continue }
            # Soonest due first, matching worker.js complianceSort.
            $sorted = @($complianceItems | Where-Object { (Get-RecordWorkspace $_) -eq $workspace } | Sort-Object -Property @{Expression={[string]$_.dueDate}}, @{Expression={[string]$_.item}})
            $payload = @($sorted | ForEach-Object { ConvertTo-CompliancePayload $_ })
            Send-Json $ctx 200 @{ items = $payload; owners = @('Frank','Jennifer')
                                  reviewers = @('Frank','Jennifer','N/A'); frequencies = $complianceFrequencies
                                  areas = $complianceAreas; requirements = $complianceRequirements
                                  workflows = $complianceWorkflows
                                  sources = @($sorted | ForEach-Object { [string]$_.source } | Where-Object { $_ } | Sort-Object -Unique)
                                  workspace = $workspace }
        }
        # Mirror worker.js handleAdminComplianceImport. Must precede the generic
        # /compliance/(.+) route, which would swallow "import" as an item id.
        # Completed items are KEPT — a closed item is the evidence a filing was
        # signed off, and no fresh import can reconstruct that.
        elseif ($path -eq '/api/admin/compliance/import' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            if ($workspace -ne $frankAdminEmail) { Send-Json $ctx 403 @{ error = "Compliance is only available in Frank's shared view" }; continue }
            $body = Read-Body $ctx
            # -not on an EMPTY array is $true in PowerShell, so testing
            # `-not $body.items` would report "Invalid JSON body" for a
            # well-formed body carrying zero rows — a different error than
            # worker.js gives for the same input. Test for the property's
            # presence instead, and let the count check below own the empty case.
            # Also require it to actually BE an array: worker.js tests
            # Array.isArray, and @() would happily wrap a bare string into a
            # one-element list, turning a malformed body into a confusing
            # per-row validation error instead of "Invalid JSON body".
            if (-not $body -or -not $body.PSObject.Properties['items'] -or
                -not ($body.items -is [System.Collections.IEnumerable]) -or ($body.items -is [string])) {
                Send-Json $ctx 400 @{ error = 'Invalid JSON body' }; continue
            }
            $rows = @($body.items)
            if ($rows.Count -eq 0) { Send-Json $ctx 400 @{ error = 'That file has no rows to import' }; continue }
            if ($rows.Count -gt 1000) { Send-Json $ctx 400 @{ error = 'That file has more than 1000 rows' }; continue }
            # Validate everything BEFORE deleting anything, so a bad row can't
            # leave the register half-wiped.
            $rowNum = 1
            $bad = $null
            foreach ($r in $rows) {
                $rowNum++
                if (-not ([string]$r.item).Trim()) { $bad = "Row ${rowNum}: Item name is required"; break }
                if (([string]$r.dueDate) -notmatch '^\d{4}-\d{2}-\d{2}$') { $bad = "Row ${rowNum}: Due date must be YYYY-MM-DD"; break }
                if (-not ([string]$r.owner).Trim()) { $bad = "Row ${rowNum}: Owner is required"; break }
            }
            if ($bad) { Send-Json $ctx 400 @{ error = $bad }; continue }

            $otherWorkspaceItems = @($complianceItems | Where-Object { (Get-RecordWorkspace $_) -ne $workspace })
            $workspaceItems = @($complianceItems | Where-Object { (Get-RecordWorkspace $_) -eq $workspace })
            $keptItems = @($workspaceItems | Where-Object { (Get-ComplianceStatus $_) -eq 'CLOSED' })
            $droppedCount = $workspaceItems.Count - $keptItems.Count
            $newItems = New-Object System.Collections.ArrayList
            foreach ($r in $rows) {
                $script:cmpCounter++
                $null = $newItems.Add([ordered]@{
                    id = 'cx-{0:d4}' -f $script:cmpCounter
                    workspace = $workspace
                    dueDate = [string]$r.dueDate; item = ([string]$r.item).Trim()
                    whatToDo = [string]$r.whatToDo; frequency = [string]$r.frequency
                    source = [string]$r.source; requirement = $(if ([string]$r.requirement) { [string]$r.requirement } else { 'Best practice' })
                    complianceArea = [string]$r.complianceArea; frequencyDetail = [string]$r.frequencyDetail; waitingOn = ''
                    owner = ([string]$r.owner).Trim()
                    reviewer = if (([string]$r.reviewer).Trim()) { ([string]$r.reviewer).Trim() } else { 'N/A' }
                    notes = [string]$r.notes
                    ownerCompleted = ''; ownerCompletedBy = ''
                    reviewerCompleted = ''; reviewerCompletedBy = ''
                    completedAt = ''; completedBy = ''
                    createdAt = (Get-Date).ToString('o'); createdBy = $adminEmail; updatedAt = $null
                })
            }
            $complianceItems.Clear()
            foreach ($o in $otherWorkspaceItems) { $null = $complianceItems.Add($o) }
            foreach ($k in $keptItems) { $null = $complianceItems.Add($k) }
            foreach ($n in $newItems) { $null = $complianceItems.Add($n) }
            Write-Audit $adminEmail 'compliance-import' @{ replaced = $droppedCount; imported = $newItems.Count; keptCompleted = $keptItems.Count }
            Send-Json $ctx 200 @{ replaced = $droppedCount; imported = $newItems.Count; keptCompleted = $keptItems.Count }
        }
        elseif ($path -eq '/api/admin/compliance' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            if ($workspace -ne $frankAdminEmail) { Send-Json $ctx 403 @{ error = "Compliance is only available in Frank's shared view" }; continue }
            $body = Read-Body $ctx
            if (-not $body) { Send-Json $ctx 400 @{ error = 'Invalid JSON body' }; continue }
            if (-not ([string]$body.item).Trim()) { Send-Json $ctx 400 @{ error = 'Item name is required' }; continue }
            if (([string]$body.dueDate) -notmatch '^\d{4}-\d{2}-\d{2}$') { Send-Json $ctx 400 @{ error = 'Due date must be YYYY-MM-DD' }; continue }
            if (-not ([string]$body.owner).Trim()) { Send-Json $ctx 400 @{ error = 'Owner is required' }; continue }
            $script:cmpCounter++
            $new = [ordered]@{
                id = 'cx-{0:d4}' -f $script:cmpCounter
                workspace = $workspace
                dueDate = [string]$body.dueDate; item = ([string]$body.item).Trim()
                whatToDo = [string]$body.whatToDo; frequency = [string]$body.frequency
                source = [string]$body.source; requirement = $(if ([string]$body.requirement) { [string]$body.requirement } else { 'Best practice' })
                complianceArea = [string]$body.complianceArea; frequencyDetail = [string]$body.frequencyDetail; waitingOn = ''
                owner = ([string]$body.owner).Trim()
                reviewer = if (([string]$body.reviewer).Trim()) { ([string]$body.reviewer).Trim() } else { 'N/A' }
                notes = [string]$body.notes
                ownerCompleted = ''; ownerCompletedBy = ''
                reviewerCompleted = ''; reviewerCompletedBy = ''
                completedAt = ''; completedBy = ''
                createdAt = (Get-Date).ToString('o'); createdBy = $adminEmail; updatedAt = $null
            }
            $null = $complianceItems.Add($new)
            # Exactly one row, whatever the frequency — nothing generates the
            # next occurrence any more.
            Write-Audit $adminEmail 'compliance-create' @{ id = $new.id; item = $new.item }
            Send-Json $ctx 200 @{ item = (ConvertTo-CompliancePayload $new); created = 1 }
        }
        elseif ($path -match '^/api/admin/compliance/(.+)$' -and $method -eq 'POST') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            if ($workspace -ne $frankAdminEmail) { Send-Json $ctx 403 @{ error = "Compliance is only available in Frank's shared view" }; continue }
            $cid = [Uri]::UnescapeDataString($Matches[1])
            $it = $complianceItems | Where-Object { $_.id -eq $cid -and (Get-RecordWorkspace $_) -eq $workspace } | Select-Object -First 1
            if (-not $it) { Send-Json $ctx 404 @{ error = 'Compliance item not found' }; continue }
            $body = Read-Body $ctx
            if (-not $body) { Send-Json $ctx 400 @{ error = 'Invalid JSON body' }; continue }
            if ($body.PSObject.Properties['dueDate'] -and ([string]$body.dueDate) -notmatch '^\d{4}-\d{2}-\d{2}$') {
                Send-Json $ctx 400 @{ error = 'Due date must be YYYY-MM-DD' }; continue
            }
            # Validate the two check-off dates BEFORE mutating anything, and
            # without a nested loop: PowerShell's `continue` takes a label rather
            # than a level count, so continuing out of a foreach here would fall
            # through and send a second response on the same request.
            $ownerGiven = [bool]$body.PSObject.Properties['ownerCompleted']
            $reviewerGiven = [bool]$body.PSObject.Properties['reviewerCompleted']
            $ownerVal = if ($ownerGiven) { ([string]$body.ownerCompleted).Trim() } else { $null }
            $reviewerVal = if ($reviewerGiven) { ([string]$body.reviewerCompleted).Trim() } else { $null }
            $badDate = ($ownerVal -and $ownerVal -notmatch '^\d{4}-\d{2}-\d{2}$') -or
                       ($reviewerVal -and $reviewerVal -notmatch '^\d{4}-\d{2}-\d{2}$')
            if ($badDate) { Send-Json $ctx 400 @{ error = 'Completion dates must be YYYY-MM-DD or empty' }; continue }

            foreach ($f in @('item','whatToDo','dueDate','frequency','source','notes','owner','reviewer')) {
                if ($body.PSObject.Properties[$f]) { $it[$f] = [string]$body.$f }
            }
            if ($body.PSObject.Properties['requirement']) { $it.requirement = [string]$body.requirement }
            if ($body.PSObject.Properties['complianceArea']) { $it.complianceArea = [string]$body.complianceArea }
            if ($body.PSObject.Properties['waitingOn']) { $it.waitingOn = [string]$body.waitingOn }
            # Empty clears a check-off (re-opening the item); the stamp of who
            # ticked it is cleared with it.
            if ($ownerGiven) {
                $it.ownerCompleted = $ownerVal
                $it.ownerCompletedBy = if ($ownerVal) { $adminEmail } else { '' }
            }
            if ($reviewerGiven) {
                $it.reviewerCompleted = $reviewerVal
                $it.reviewerCompletedBy = if ($reviewerVal) { $adminEmail } else { '' }
            }
            # Explicit complete / reopen, gated on every required sign-off being
            # in so the button can't skip the review step it exists to protect.
            if ($body.PSObject.Properties['complete']) {
                if ([bool]$body.complete) {
                    if (-not (Get-ComplianceSignedOff $it)) {
                        Send-Json $ctx 400 @{ error = 'Both the owner and reviewer must sign off before this can be completed' }; continue
                    }
                    $it.completedAt = (Get-Date).ToString('yyyy-MM-dd')
                    $it.completedBy = $adminEmail
                } else {
                    $it.completedAt = ''; $it.completedBy = ''
                }
            }
            # Withdrawing a sign-off on a completed item withdraws completion too,
            # rather than leaving it CLOSED with an incomplete audit trail.
            if (($ownerGiven -or $reviewerGiven) -and [string]$it.completedAt -and -not (Get-ComplianceSignedOff $it)) {
                $it.completedAt = ''; $it.completedBy = ''
            }
            $it.updatedAt = (Get-Date).ToString('o')
            # created is always 0: completing an item no longer materialises its
            # next occurrence. Kept in the response so the client's
            # `if (res.created)` reload path reads a real value, not undefined.
            Send-Json $ctx 200 @{ item = (ConvertTo-CompliancePayload $it); created = 0 }
        }
        elseif ($path -match '^/api/admin/compliance/(.+)$' -and $method -eq 'DELETE') {
            $adminEmail = Get-AdminEmail $ctx
            if (-not $adminEmail) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $workspace = Get-AdminWorkspace $ctx $adminEmail
            if (-not $workspace) { Send-Json $ctx 403 @{ error = 'You do not have access to that workspace' }; continue }
            if ($workspace -ne $frankAdminEmail) { Send-Json $ctx 403 @{ error = "Compliance is only available in Frank's shared view" }; continue }
            $cid = [Uri]::UnescapeDataString($Matches[1])
            $it = $complianceItems | Where-Object { $_.id -eq $cid -and (Get-RecordWorkspace $_) -eq $workspace } | Select-Object -First 1
            if (-not $it) { Send-Json $ctx 404 @{ error = 'Compliance item not found' }; continue }
            # ?series=1 drops every occurrence of a repeating item ever generated.
            # Without it, deleting the single open occurrence is enough — a
            # completed one already has its successor materialised.
            $wholeSeries = ($ctx.Request.QueryString['series'] -eq '1') -and [bool]$it.seriesId
            $removed = 1
            if ($wholeSeries) {
                $doomed = @($complianceItems | Where-Object { $_.seriesId -eq $it.seriesId -and (Get-RecordWorkspace $_) -eq $workspace })
                $removed = $doomed.Count
                foreach ($d in $doomed) { $complianceItems.Remove($d) }
            }
            else { $complianceItems.Remove($it) }
            Write-Audit $adminEmail 'compliance-delete' @{ id = $cid; item = $it.item; series = $wholeSeries; removed = $removed }
            Send-Json $ctx 200 @{ ok = $true; removed = $removed }
        }
        elseif ($path -eq '/api/admin/learning' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            # Category, then title - the same sort the worker applies, so the flat
            # list reads as grouped with no category filter on.
            # An uncategorised row sorts last (a leading 1 beats every 0-prefixed
            # category), matching the worker's high-sentinel comparison.
            $res = @($learningResources | Sort-Object `
                @{ Expression = { if ($_.category) { "0$($_.category)" } else { '1' } } }, `
                @{ Expression = { $_.title } })
            $cats = @($res | ForEach-Object { $_.category } | Where-Object { $_ } | Sort-Object -Unique)
            Send-Json $ctx 200 @{ resources = $res; categories = $cats
                categoryChoices = $learningCategoryChoices; categoryIsChoice = $true
                canUpload = $true; configured = $true }
        }
        elseif ($path -eq '/api/admin/learning/upload' -and $method -eq 'POST') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $b = Read-Body $ctx
            $fname = [IO.Path]::GetFileName([string]$b.filename)
            $ext = ([IO.Path]::GetExtension($fname)).TrimStart('.').ToLower()
            $allowed = @('mp4', 'mov', 'm4v', 'avi', 'wmv', 'webm', 'mkv')
            if (-not $fname) { Send-Json $ctx 400 @{ error = 'A file is required' }; continue }
            if ($allowed -notcontains $ext) {
                Send-Json $ctx 400 @{ error = "Unsupported video format `".$ext`" - use $($allowed -join ', ')" }; continue
            }
            if (-not ([string]$b.title).Trim()) { Send-Json $ctx 400 @{ error = 'A name is required' }; continue }
            $cat = ([string]$b.category).Trim()
            if ($cat -and $learningCategoryChoices -notcontains $cat) {
                Send-Json $ctx 400 @{ error = "`"$cat`" is not one of the library's categories" }; continue
            }
            # The real worker hands back an encrypted ticket carrying the Graph
            # upload URL; the mock has no Graph, so the ticket is just a key into
            # an in-memory table. The client treats it as opaque either way.
            $script:lrCounter++
            $uid = "up$($script:lrCounter)"
            $learningUploads[$uid] = @{
                filename = $fname; title = ([string]$b.title).Trim(); category = $cat
                description = ([string]$b.description).Trim(); size = [int64]$b.size; received = [int64]0
            }
            # 1 MiB in the mock rather than 5, so a small test file still exercises
            # the multi-chunk loop.
            Send-Json $ctx 200 @{ ticket = $uid; chunkSize = (1024 * 1024) }
        }
        elseif ($path -eq '/api/admin/learning/upload/chunk' -and $method -eq 'PUT') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            $uid = [string]$ctx.Request.Headers['X-Upload-Ticket']
            $up = if ($uid) { $learningUploads[$uid] } else { $null }
            if (-not $up) { Send-Json $ctx 400 @{ error = 'Missing upload ticket' }; continue }
            $offset = [int64]$ctx.Request.Headers['X-Upload-Offset']
            # Drain the bytes without keeping them: the mock only needs the count
            # to drive progress and decide when the last chunk has landed.
            $buf = New-Object byte[] 65536
            $len = [int64]0
            while (($read = $ctx.Request.InputStream.Read($buf, 0, $buf.Length)) -gt 0) { $len += $read }
            if ($len -le 0) { Send-Json $ctx 400 @{ error = 'Empty chunk' }; continue }
            if (($offset + $len) -gt $up.size) {
                Send-Json $ctx 400 @{ error = 'Chunk runs past the declared file size' }; continue
            }
            $up.received = $offset + $len
            if ($up.received -lt $up.size) {
                Send-Json $ctx 200 @{ done = $false; nextOffset = $up.received }
                continue
            }
            $script:lrCounter++
            $row = @{
                id = "lu$($script:lrCounter)"; name = $up.filename; title = $up.title
                description = $up.description; category = $up.category
                webUrl = "https://bluelineadvisors.sharepoint.com/sites/BluelineTeam/Learning/$($up.filename)"
                size = $up.size; modified = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            }
            $null = $learningResources.Add($row)
            $learningUploads.Remove($uid)
            Write-Audit (Get-AdminEmail $ctx) 'learning-upload' @{ name = $row.name; title = $row.title; category = $row.category }
            Send-Json $ctx 200 @{ done = $true; resource = $row; warning = '' }
        }
        else {
            $rel = if ($path -eq '/') { 'index.html' } else { $path.TrimStart('/') }
            $file = Join-Path $root $rel
            if (Test-Path $file -PathType Container) { $file = Join-Path $file 'index.html' }
            if (Test-Path $file -PathType Leaf) { Send-File $ctx $file }
            else { Send-Json $ctx 404 @{ error = 'Not found' } }
        }
    } catch {
        try { Send-Json $ctx 500 @{ error = "Internal server error: $($_.Exception.Message)" } } catch {}
    }
}
