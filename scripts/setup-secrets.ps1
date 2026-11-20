﻿# Секрети й вебхук для PREVIEW і PROD разом (акаунт Cloudflare з wrangler.jsonc). Нічого не друкує й не зберігає із секретів.
# Запуск (з будь-якої теки): powershell -ExecutionPolicy Bypass -File scripts\setup-secrets.ps1
# Один середовище: додай -Only preview або -Only production. Ротація секретів — той самий запуск.
# Файл у UTF-8 з BOM — без нього Windows PowerShell 5.1 ламає кирилицю.
param(
    [string]$OwnerId = '369942190',
    [ValidateSet('both', 'preview', 'production')][string]$Only = 'both',
    [string]$PreviewUrl = 'https://trener-preview.adhd-bot.workers.dev',
    [string]$ProdUrl = 'https://trener-prod.adhd-bot.workers.dev'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$token = $null; $secret = $null; $sec = $null; $bytes = $null; $items = $null

$targets = @()
if ($Only -ne 'production') { $targets += @{ Env = 'preview'; Label = 'PREVIEW'; Url = $PreviewUrl } }
if ($Only -ne 'preview') { $targets += @{ Env = 'production'; Label = 'PROD'; Url = $ProdUrl } }

try {
    Set-Location -LiteralPath $repo

    foreach ($t in $targets) {
        Write-Host ''
        Write-Host "=== $($t.Label) ($($t.Url)) ==="
        $sec = Read-Host "Токен $($t.Label)-бота з BotFather (ввід прихований)" -AsSecureString
        $token = [System.Net.NetworkCredential]::new('', $sec).Password
        if ($token -notmatch '^\d+:[A-Za-z0-9_-]{30,}$') { throw 'Токен має вигляд 123456789:AAA... — перевір, що скопіював цілком' }

        # Новий секрет вебхука на кожне середовище: 32 випадкові байти, base64url; лише в пам'яті процесу.
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

        $items = @(
            @{ Name = 'TELEGRAM_BOT_TOKEN'; Value = $token },
            @{ Name = 'TELEGRAM_WEBHOOK_SECRET'; Value = $secret },
            @{ Name = 'ALLOWED_TELEGRAM_IDS'; Value = $OwnerId }
        )
        foreach ($i in $items) {
            Write-Host "wrangler secret put $($i.Name) ($($t.Env)) ..."
            # Значення йде через stdin і не потрапляє у вивід; вивід показуємо лише при збої.
            # stderr wrangler (попередження) не має валити скрипт через $ErrorActionPreference = 'Stop'.
            $ErrorActionPreference = 'Continue'
            $out = $i.Value | & npx.cmd wrangler secret put $i.Name --env $t.Env 2>&1
            $ErrorActionPreference = 'Stop'
            if ($LASTEXITCODE -ne 0) { $out | Out-Host; throw "secret put $($i.Name) ($($t.Env)) завершився з кодом $LASTEXITCODE" }
        }

        # Worker має відповісти 200 на {} з новим секретом (нова версія з секретами підхоплюється за кілька секунд).
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
        Write-Host "Перевірка Worker $($t.Label): HTTP $code"
        if ($code -ne 200) { throw "Worker $($t.Label) не відповів 200 на {} з новим секретом — вебхук не ставлю" }

        # Вебхук у цьому ж процесі, поки секрет ще в пам'яті.
        $env:TELEGRAM_BOT_TOKEN = $token
        $env:TELEGRAM_WEBHOOK_SECRET = $secret
        $env:WORKER_URL = $t.Url
        & npm.cmd run set-webhook -- $t.Env
        if ($LASTEXITCODE -ne 0) { throw "set-webhook $($t.Env) завершився з кодом $LASTEXITCODE" }
        Write-Host "ГОТОВО $($t.Label). Звір @username бота вище — це має бути $($t.Label)-бот."

        Remove-Item Env:\TELEGRAM_BOT_TOKEN, Env:\TELEGRAM_WEBHOOK_SECRET, Env:\WORKER_URL -ErrorAction SilentlyContinue
        $token = $null; $secret = $null; $sec = $null; $bytes = $null; $items = $null
    }
    Write-Host ''
    Write-Host 'Усе. Напиши кожному боту /start.'
}
finally {
    Remove-Item Env:\TELEGRAM_BOT_TOKEN, Env:\TELEGRAM_WEBHOOK_SECRET, Env:\WORKER_URL -ErrorAction SilentlyContinue
    $token = $null; $secret = $null; $sec = $null; $bytes = $null; $items = $null
}
