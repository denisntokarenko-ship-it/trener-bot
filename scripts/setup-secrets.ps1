# Secrets and webhook for the PREVIEW and PROD Workers (Cloudflare account from wrangler.jsonc). Prints and stores no secret.
# Run (from any folder): powershell -ExecutionPolicy Bypass -File scripts\setup-secrets.ps1 [-Only preview|production]
#   default step: asks the bot token (per environment) and the Anthropic key (once), makes a new random webhook secret,
#   puts TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ALLOWED_TELEGRAM_IDS, ANTHROPIC_API_KEY, checks the Worker answers 200
#   with the new secret and points the bot webhook at the Worker (npm run set-webhook; pending updates are kept).
#   Rotation of any secret is the same run.
# Account move (RUNBOOK, "Account move 2026-11-22"):
#   -Step pause-webhook : asks the PROD token, shows the bot and pending updates, deletes the webhook WITHOUT dropping
#                         pending updates (Telegram keeps them up to 24 h), shows the webhook is empty.
#   PROD secrets refuse to run while the PROD database has no users (data not imported yet), unless -AllowEmptyProd.
# The file is ASCII on purpose: Windows PowerShell 5.1 and pwsh 7 parse it identically.
param(
    [ValidateSet('secrets', 'pause-webhook')][string]$Step = 'secrets',
    [ValidateSet('both', 'preview', 'production')][string]$Only = 'both',
    [string]$OwnerId = '369942190',
    [string]$PreviewUrl = 'https://trener-preview.maistry-gromady.workers.dev',
    [string]$ProdUrl = 'https://trener-prod.maistry-gromady.workers.dev',
    [switch]$AllowEmptyProd
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$token = $null; $secret = $null; $sec = $null; $bytes = $null; $items = $null; $key = $null; $out = $null

function Read-Token([string]$label) {
    $s = Read-Host "$label bot token from BotFather (input is hidden)" -AsSecureString
    $t = [System.Net.NetworkCredential]::new('', $s).Password
    if ($t -notmatch '^\d+:[A-Za-z0-9_-]{30,}$') { throw 'The token must look like 123456789:AAA... - check that you copied it whole' }
    return $t
}
# Telegram Bot API call; the token stays in this process (URL is never printed).
function Invoke-Tg([string]$t, [string]$method, [hashtable]$body = @{}) {
    $r = Invoke-RestMethod -Uri "https://api.telegram.org/bot$t/$method" -Method Post -Body ($body | ConvertTo-Json -Compress) -ContentType 'application/json'
    if (-not $r.ok) { throw "Telegram $method failed" }
    return $r.result
}
function Invoke-Wrangler([string[]]$wargs, [string]$stdin) {
    # wrangler warnings on stderr must not stop the script because of $ErrorActionPreference = 'Stop'.
    $ErrorActionPreference = 'Continue'
    if ($null -ne $stdin) { $o = $stdin | & npx.cmd wrangler @wargs 2>&1 } else { $o = & npx.cmd wrangler @wargs 2>&1 }
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { $o | Out-Host; throw "wrangler $($wargs[0..2] -join ' ') failed with exit code $LASTEXITCODE" }
    return $o
}

try {
    Set-Location -LiteralPath $repo

    if ($Step -eq 'pause-webhook') {
        $token = Read-Token 'PROD'
        $me = Invoke-Tg $token 'getMe'
        $info = Invoke-Tg $token 'getWebhookInfo'
        Write-Host "Bot: @$($me.username). Webhook now: $($info.url). Pending updates: $($info.pending_update_count)"
        $null = Invoke-Tg $token 'deleteWebhook' @{ drop_pending_updates = $false }
        $info = Invoke-Tg $token 'getWebhookInfo'
        Write-Host "Webhook after deleteWebhook: '$($info.url)' (must be empty). Pending updates: $($info.pending_update_count)"
        if ($info.url) { throw 'Webhook is still set' }
        Write-Host 'Done. Telegram now keeps new messages until the webhook is set again (up to 24 hours).'
        return
    }

    $targets = @()
    if ($Only -ne 'production') { $targets += @{ Env = 'preview'; Label = 'PREVIEW'; Url = $PreviewUrl } }
    if ($Only -ne 'preview') { $targets += @{ Env = 'production'; Label = 'PROD'; Url = $ProdUrl } }

    if (($Only -ne 'preview') -and -not $AllowEmptyProd) {
        # Webhook to an empty PROD database would split the data: new messages here, history in the old account.
        $o = Invoke-Wrangler @('d1', 'execute', 'DB', '--remote', '--env', 'production', '--json', '--command', 'SELECT count(*) AS n FROM users') $null
        $n = (($o | Where-Object { $_ -is [string] }) -join "`n" | ConvertFrom-Json)[0].results[0].n
        Write-Host "PROD database users: $n"
        if ($n -lt 1) { throw 'PROD database has no users: the data import is not done yet. Stop here (or pass -AllowEmptyProd on purpose).' }
    }

    $sec = Read-Host 'Anthropic API key (sk-ant-..., input is hidden)' -AsSecureString
    $key = [System.Net.NetworkCredential]::new('', $sec).Password
    if ($key -notmatch '^sk-ant-[A-Za-z0-9_-]{20,}$') { throw 'The key must look like sk-ant-... - check that you copied it whole' }

    foreach ($t in $targets) {
        Write-Host ''
        Write-Host "=== $($t.Label) ($($t.Url)) ==="
        $token = Read-Token $t.Label

        # New webhook secret per environment: 32 random bytes, base64url; only in this process memory.
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

        $items = @(
            @{ Name = 'TELEGRAM_BOT_TOKEN'; Value = $token },
            @{ Name = 'TELEGRAM_WEBHOOK_SECRET'; Value = $secret },
            @{ Name = 'ALLOWED_TELEGRAM_IDS'; Value = $OwnerId },
            @{ Name = 'ANTHROPIC_API_KEY'; Value = $key }
        )
        foreach ($i in $items) {
            Write-Host "wrangler secret put $($i.Name) ($($t.Env)) ..."
            # The value goes through stdin and never reaches the output; wrangler output is shown only on failure.
            $out = Invoke-Wrangler @('secret', 'put', $i.Name, '--env', $t.Env) $i.Value
        }

        # The Worker must answer 200 to {} with the new secret (the new version with secrets is picked up within seconds).
        $code = 0
        for ($n = 1; $n -le 12; $n++) {
            try {
                $r = Invoke-WebRequest -Uri "$($t.Url)/tg/webhook" -Method Post -Body '{}' -ContentType 'application/json' `
                    -Headers @{ 'X-Telegram-Bot-Api-Secret-Token' = $secret } -UseBasicParsing
                $code = [int]$r.StatusCode
            } catch { $code = [int]$_.Exception.Response.StatusCode }
            if ($code -eq 200) { break }
            Start-Sleep -Seconds 5
        }
        Write-Host "Worker $($t.Label) check: HTTP $code"
        if ($code -ne 200) { throw "Worker $($t.Label) did not answer 200 to {} with the new secret - webhook is not set" }

        # Webhook in the same process while the secret is still in memory (drop_pending_updates: false).
        $env:TELEGRAM_BOT_TOKEN = $token
        $env:TELEGRAM_WEBHOOK_SECRET = $secret
        $env:WORKER_URL = $t.Url
        & npm.cmd run set-webhook -- $t.Env
        if ($LASTEXITCODE -ne 0) { throw "set-webhook $($t.Env) failed with exit code $LASTEXITCODE" }
        Write-Host "DONE $($t.Label). Check the @username above - it must be the $($t.Label) bot."

        Remove-Item Env:\TELEGRAM_BOT_TOKEN, Env:\TELEGRAM_WEBHOOK_SECRET, Env:\WORKER_URL -ErrorAction SilentlyContinue
        $token = $null; $secret = $null; $bytes = $null; $items = $null
    }
    Write-Host ''
    Write-Host 'All set. Check (names only): npx wrangler secret list --env production'
}
finally {
    Remove-Item Env:\TELEGRAM_BOT_TOKEN, Env:\TELEGRAM_WEBHOOK_SECRET, Env:\WORKER_URL -ErrorAction SilentlyContinue
    $token = $null; $secret = $null; $sec = $null; $bytes = $null; $items = $null; $key = $null; $out = $null
}
