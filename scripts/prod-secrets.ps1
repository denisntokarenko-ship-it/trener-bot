# Ініціалізація й ротація секретів PROD-бота. Нічого не друкує й не зберігає із секретів.
# Запуск (з будь-якої теки): powershell -ExecutionPolicy Bypass -File scripts\prod-secrets.ps1 -OwnerId <telegram id власника>
# Файл у UTF-8 з BOM — без нього Windows PowerShell 5.1 ламає кирилицю.
param(
    [Parameter(Mandatory = $true)][string]$OwnerId,
    [string]$WorkerUrl = 'https://trener-prod.koxbe.workers.dev'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$token = $null; $secret = $null; $sec = $null
try {
    Set-Location -LiteralPath $repo

    $sec = Read-Host 'Токен PROD-бота з BotFather (ввід прихований)' -AsSecureString
    $token = [System.Net.NetworkCredential]::new('', $sec).Password
    if ($token -notmatch '^\d+:[A-Za-z0-9_-]{30,}$') { throw 'Токен має вигляд 123456789:AAA... — перевір, що скопіював цілком' }

    # Новий секрет вебхука: 32 випадкові байти, base64url; лише в пам'яті цього процесу.
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

    $items = @(
        @{ Name = 'TELEGRAM_BOT_TOKEN'; Value = $token },
        @{ Name = 'TELEGRAM_WEBHOOK_SECRET'; Value = $secret },
        @{ Name = 'ALLOWED_TELEGRAM_IDS'; Value = $OwnerId }
    )
    foreach ($i in $items) {
        Write-Host "wrangler secret put $($i.Name) ..."
        # Вивід показуємо лише при збої (значення йде через stdin, у вивід не потрапляє).
        # stderr wrangler (попередження) не має валити скрипт через $ErrorActionPreference = 'Stop'.
        $ErrorActionPreference = 'Continue'
        $out = $i.Value | & npx.cmd wrangler secret put $i.Name --env production 2>&1
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) { $out | Out-Host; throw "secret put $($i.Name) завершився з кодом $LASTEXITCODE" }
    }

    # Worker має відповісти 200 на {} з новим секретом (нова версія з секретами може підхопитись за кілька секунд).
    $code = 0
    for ($n = 1; $n -le 12; $n++) {
        try {
            $r = Invoke-WebRequest -Uri "$WorkerUrl/tg/webhook" -Method Post -Body '{}' -ContentType 'application/json' `
                -Headers @{ 'X-Telegram-Bot-Api-Secret-Token' = $secret } -UseBasicParsing
            $code = [int]$r.StatusCode
        } catch { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 200) { break }
        Start-Sleep -Seconds 5
    }
    Write-Host "Перевірка Worker: HTTP $code"
    if ($code -ne 200) { throw 'Worker не відповів 200 на {} з новим секретом — вебхук не ставлю' }

    # Живі кроки боргу F-0: чужий id (тиша) і повтор update_id (дедуп). Код 200 цього не доводить —
    # свідок після запуску: SELECT з processed_updates/users прода (RUNBOOK). Лишає 2 синтетичні рядки дедупу (крон прибере за 3 доби).
    function Send-Fake([int]$updateId) {
        $body = @{ update_id = $updateId; message = @{ message_id = 1; date = [int][double]::Parse((Get-Date -UFormat %s)); chat = @{ id = 111111111; type = 'private' }; from = @{ id = 111111111; is_bot = $false; first_name = 'X' }; text = '/start'; entities = @(@{ offset = 0; length = 6; type = 'bot_command' }) } } | ConvertTo-Json -Depth 6 -Compress
        try {
            (Invoke-WebRequest -Uri "$WorkerUrl/tg/webhook" -Method Post -Body $body -ContentType 'application/json' `
                -Headers @{ 'X-Telegram-Bot-Api-Secret-Token' = $secret } -UseBasicParsing).StatusCode
        } catch { [int]$_.Exception.Response.StatusCode }
    }
    $fakes = (Send-Fake 900100), (Send-Fake 900100), (Send-Fake 900101)
    Write-Host "Фейки від чужого id (очікую 200 200 200): $($fakes -join ' ')"

    # Вебхук у цьому ж процесі.
    $env:TELEGRAM_BOT_TOKEN = $token
    $env:TELEGRAM_WEBHOOK_SECRET = $secret
    $env:WORKER_URL = $WorkerUrl
    & npm.cmd run set-webhook -- production
    if ($LASTEXITCODE -ne 0) { throw "set-webhook завершився з кодом $LASTEXITCODE" }
    Write-Host 'ГОТОВО. Звір @username бота вище — це має бути PROD-бот. Далі напиши йому /start.'
}
finally {
    Remove-Item Env:\TELEGRAM_BOT_TOKEN, Env:\TELEGRAM_WEBHOOK_SECRET, Env:\WORKER_URL -ErrorAction SilentlyContinue
    $token = $null; $secret = $null; $sec = $null; $bytes = $null; $items = $null
}
