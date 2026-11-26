# Asks for an Azure DevOps personal access token in its own console window, checks it, and stores it in
# Windows Credential Manager under -Target, where the worktrees panel reads it. The token is typed here
# only: it never passes through the panel. The panel passes the values it read off the origin URL.
param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$AdoApi,
    [Parameter(Mandatory = $true)][string]$TokenPage,
    [string]$Org = ''
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { $Host.UI.RawUI.WindowTitle = 'Azure DevOps token for the Worktrees panel' } catch { }

Write-Host ''
Write-Host 'Azure DevOps token for the Worktrees panel' -ForegroundColor Cyan
Write-Host ''
Write-Host "1. Create a token at $TokenPage"
Write-Host "   Organization: $Org. Scope: Code > Read."
Write-Host '2. Paste it below. It is stored in Windows Credential Manager as' $Target
Write-Host ''

$secure = Read-Host 'Token (input hidden, Enter on empty cancels)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $pat = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$pat = ([string]$pat).Trim()
if (-not $pat) {
    Write-Host 'Nothing entered, nothing stored.'
    Read-Host 'Press Enter to close' | Out-Null
    return
}

Write-Host 'Checking the token with Azure DevOps...'
$auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$pat"))
$why = ''
try {
    $r = Invoke-WebRequest -Uri "$($AdoApi)?api-version=7.1" -Headers @{ Authorization = $auth } -UseBasicParsing -TimeoutSec 20
    if ($r.StatusCode -ne 200 -or -not ([string]$r.Content).TrimStart().StartsWith('{')) { $why = 'the token was refused (sign-in page returned)' }
} catch {
    $resp = $_.Exception.Response
    if (-not $resp) { $why = "Azure DevOps could not be reached ($($_.Exception.Message))" }
    elseif ([int]$resp.StatusCode -eq 401) { $why = 'the token was refused (401): wrong, expired or missing the Code > Read scope' }
    elseif ([int]$resp.StatusCode -eq 403) { $why = 'access was blocked (403): connect the VPN or sign in to Azure DevOps in the browser' }
    else { $why = "HTTP $([int]$resp.StatusCode)" }
}

if ($why) {
    Write-Host "Check failed: $why" -ForegroundColor Yellow
    $answer = Read-Host 'Store the token anyway? [y/N]'
    if ($answer -notmatch '^(y|yes)$') {
        Write-Host 'Nothing stored.'
        Read-Host 'Press Enter to close' | Out-Null
        return
    }
} else {
    Write-Host 'The token works.' -ForegroundColor Green
}

& cmdkey.exe "/generic:$Target" '/user:ado' "/pass:$pat" | Out-Null
$pat = $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Stored as $Target. Press Retry in the Worktrees panel." -ForegroundColor Green
} else {
    Write-Host "cmdkey could not store the token (exit code $LASTEXITCODE)." -ForegroundColor Red
}
Read-Host 'Press Enter to close' | Out-Null
