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
            $rate = if ($income -gt 0) { [math]::Round(($savings / $income) * 100, 1) } else { 0 }
            return @{
                monthlyIncome = $income; expenses = $expenses; monthlySavings = $savings
                totalExpenses = $total; surplus = $income - $total - $savings; savingsRate = $rate
            }
        }
        'retirement' {
            $months = [math]::Round(([double]$body.targetAge - [double]$body.currentAge) * 12)
            $rate = 0.06 / 12
            $contribution = [double]$body.monthlyContribution + [double]$body.employerMatchMonthly
            $balance = [double]$body.currentSavings
            foreach ($m in 1..$months) { $balance = $balance * (1 + $rate) + $contribution }
            $target = [math]::Round([double]$body.desiredMonthlyIncome * 12 * 25)
            $readiness = if ($target -gt 0) { [math]::Min(999, [math]::Round($balance / $target * 100)) } else { $null }
            return @{
                currentAge = [double]$body.currentAge; targetAge = [double]$body.targetAge
                currentSavings = [double]$body.currentSavings; monthlyContribution = [double]$body.monthlyContribution
                employerMatchMonthly = [double]$body.employerMatchMonthly; desiredMonthlyIncome = [double]$body.desiredMonthlyIncome
                oldEmployerPlans = $body.oldEmployerPlans; projectedBalance = [math]::Round($balance)
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
            $body = Read-Body $ctx
            if ($users.ContainsKey($body.email)) { Send-Json $ctx 409 @{ error = 'An account with this email already exists' }; continue }
            $users[$body.email] = @{ name = $body.name; email = $body.email; password = $body.password }
            $token = New-Token
            $sessions[$token] = $body.email
            Send-Json $ctx 201 @{ token = $token; name = $body.name; email = $body.email }
        }
        elseif ($path -eq '/api/login' -and $method -eq 'POST') {
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
        elseif ($path -eq '/api/admin/clients' -and $method -eq 'GET') {
            $clients = @($users.Values | ForEach-Object {
                $mods = if ($responses.ContainsKey($_.email)) { $responses[$_.email] } else { @{} }
                @{ name = $_.name; email = $_.email; modules = $mods }
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
