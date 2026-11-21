# Sets the ANTHROPIC_API_KEY secret for the PREVIEW and PROD Workers (Cloudflare account from wrangler.jsonc).
# Prints and stores nothing: the key lives only in this process memory and goes to wrangler via stdin.
# Run (from any folder): powershell -ExecutionPolicy Bypass -File scripts\set-anthropic-key.ps1
# One environment only: add -Only preview or -Only production. Key rotation is the same run.
# The file is ASCII on purpose (UTF-8 without BOM): Windows PowerShell 5.1 and pwsh 7 parse it identically.
param(
    [ValidateSet('both', 'preview', 'production')][string]$Only = 'both'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$sec = $null; $key = $null; $out = $null

$envs = @()
if ($Only -ne 'production') { $envs += 'preview' }
if ($Only -ne 'preview') { $envs += 'production' }

try {
    Set-Location -LiteralPath $repo

    $sec = Read-Host 'Anthropic API key (sk-ant-..., input is hidden)' -AsSecureString
    $key = [System.Net.NetworkCredential]::new('', $sec).Password
    if ($key -notmatch '^sk-ant-[A-Za-z0-9_-]{20,}$') { throw 'The key must look like sk-ant-... - check that you copied it whole' }

    foreach ($e in $envs) {
        Write-Host "wrangler secret put ANTHROPIC_API_KEY ($e) ..."
        # The value goes through stdin and never reaches the output; wrangler output is shown only on failure.
        # wrangler warnings on stderr must not stop the script because of $ErrorActionPreference = 'Stop'.
        $ErrorActionPreference = 'Continue'
        $out = $key | & npx.cmd wrangler secret put ANTHROPIC_API_KEY --env $e 2>&1
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) { $out | Out-Host; throw "secret put ANTHROPIC_API_KEY ($e) failed with exit code $LASTEXITCODE" }
        Write-Host "OK: $e"
    }

    Write-Host ''
    Write-Host 'Done. Check (names only, no values): npx wrangler secret list --env preview'
    Write-Host 'Second guard: set a monthly spend limit of 5 USD in Anthropic Console -> Settings -> Limits.'
}
finally {
    $key = $null; $sec = $null; $out = $null
}
