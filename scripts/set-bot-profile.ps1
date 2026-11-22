# Sets the profile of ONE Telegram bot: name, description, short description, command menu and avatar (assets/bot/*.jpg).
# The bot token is typed into a hidden prompt: it is never a command-line argument, is never printed or stored,
# lives only in this process environment and is removed at the end.
# Run (from any folder), one bot at a time - first the test bot, then the working one:
#   powershell -ExecutionPolicy Bypass -File scripts\set-bot-profile.ps1 preview
#   powershell -ExecutionPolicy Bypass -File scripts\set-bot-profile.ps1 production
# Add -NoPhoto to leave the avatar alone. Safe to repeat. The script refuses a token of the wrong bot (checks getMe).
# The file is ASCII on purpose (UTF-8 without BOM): Windows PowerShell 5.1 and pwsh 7 parse it identically.
param(
    [Parameter(Mandatory = $true, Position = 0)][ValidateSet('preview', 'production')][string]$Target,
    [switch]$NoPhoto
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$sec = $null; $token = $null

try {
    Set-Location -LiteralPath $repo

    $who = if ($Target -eq 'preview') { 'TEST bot (@Tokarenko_trener_preview_bot)' } else { 'WORKING (production) bot' }
    $sec = Read-Host "Token of the $who from @BotFather (input is hidden)" -AsSecureString
    $token = [System.Net.NetworkCredential]::new('', $sec).Password
    if ($token -notmatch '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$') { throw 'The token must look like 123456789:AA... - check that you copied it whole' }

    $env:TELEGRAM_BOT_TOKEN = $token
    $nodeArgs = @('scripts/set-bot-profile.ts', $Target)
    if ($NoPhoto) { $nodeArgs += '--no-photo' }
    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) { throw "set-bot-profile failed with exit code $LASTEXITCODE" }
    Write-Host ''
    Write-Host 'Done. Open the bot in Telegram: the name and avatar can take a minute (or a restart of the app) to refresh.'
}
finally {
    Remove-Item Env:\TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
    $token = $null; $sec = $null
}
