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
}
$adminMfa = @{}      # email -> @{ secret; confirmed; backupCodes=@(@{hash;used}); createdAt }
$adminPending = @{}  # pending token -> email (short-lived between password and 2nd factor)

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
    $bytes = [IO.File]::ReadAllBytes($path)
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.Close()
}

function Read-Body($ctx) {
    $reader = New-Object IO.StreamReader($ctx.Request.InputStream, $ctx.Request.ContentEncoding)
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

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Mock portal server on http://localhost:$port/"

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
            Send-Json $ctx 201 @{ token = $token; name = $body.name; email = $body.email }
        }
        elseif ($path -eq '/api/login' -and $method -eq 'POST') {
            if (-not (Test-RateLimit 'login' (Get-ClientIp $ctx))) { Send-Json $ctx 429 @{ error = 'Too many login attempts. Please try again later.' }; continue }
            $body = Read-Body $ctx
            $u = $users[$body.email]
            if (-not $u -or $u.password -ne $body.password) { Send-Json $ctx 401 @{ error = 'Invalid email or password' }; continue }
            $token = New-Token
            $sessions[$token] = $body.email
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
        elseif ($path -eq '/api/admin/logout' -and $method -eq 'POST') {
            $auth = $ctx.Request.Headers['Authorization']
            if ($auth -match '^Bearer\s+(.+)$') { $adminSessions.Remove($Matches[1]) }
            Send-Json $ctx 200 @{ ok = $true }
        }
        elseif ($path -eq '/api/assessments' -and $method -eq 'GET') {
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            if (-not $responses.ContainsKey($email)) { $responses[$email] = @{} }
            Send-Json $ctx 200 @{ modules = $responses[$email] }
        }
        elseif ($path -match '^/api/assessments/([a-z]+)$' -and $method -eq 'POST') {
            $moduleName = $Matches[1]
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            $body = Read-Body $ctx
            $module = Build-Module $moduleName $body
            if (-not $module) { Send-Json $ctx 404 @{ error = 'Unknown assessment module' }; continue }
            $module['updatedAt'] = (Get-Date).ToString('o')
            if (-not $responses.ContainsKey($email)) { $responses[$email] = @{} }
            $responses[$email][$moduleName] = $module
            Send-Json $ctx 200 @{ module = $module; modules = $responses[$email] }
        }
        elseif ($path -eq '/api/assignments' -and $method -eq 'GET') {
            $email = Get-SessionEmail $ctx
            if (-not $email) { Send-Json $ctx 401 @{ error = 'Not authenticated' }; continue }
            $asg = if ($assignments.ContainsKey($email)) { @($assignments[$email]) } else { $null }
            Send-Json $ctx 200 @{ assignments = $asg }
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
            $rec.completionTime = $body.completionTime
            $rec.currentStep = [int]$body.currentStep
            $rec.data = $body.data
            $rec.updatedAt = (Get-Date).ToString('o')
            Send-Json $ctx 200 @{ ok = $true; updatedAt = $rec.updatedAt }
        }
        elseif ($path -eq '/api/admin/onboarding' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
            Send-Json $ctx 200 @{ records = @($onboardings.Values) }
        }
        elseif ($path -eq '/api/admin/audit' -and $method -eq 'GET') {
            if (-not (Get-AdminEmail $ctx)) { Send-Json $ctx 401 @{ error = 'Not authorized' }; continue }
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
                $mods = if ($responses.ContainsKey($_.email)) { $responses[$_.email] } else { @{} }
                $asg = if ($assignments.ContainsKey($_.email)) { @($assignments[$_.email]) } else { $null }
                @{ name = $_.name; email = $_.email; modules = $mods; assignments = $asg }
            })
            Send-Json $ctx 200 @{ clients = $clients }
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
