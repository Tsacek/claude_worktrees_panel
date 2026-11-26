# Checks and removes git worktrees for the worktrees panel. Prints a JSON array, one result per item.
# The items come as a JSON array of { path, branch, branchAction: none | safe | force } on stdin,
# or base64-encoded in -ItemsB64.
# A worktree is removed only when it holds nothing but git-ignored files (build output): no
# untracked or modified files, no submodule pointing at another commit, and submodule edits only
# when -DiscardSubmoduleChanges is given. Links (junctions, symlinks) inside it are unlinked
# first, never followed, so the delete cannot reach data shared through them.
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$ItemsB64 = '',
    [string]$Protect = '',
    [switch]$DiscardSubmoduleChanges,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:GIT_TERMINAL_PROMPT = '0'

# Progress for the panel: "@progress <done> <total> <what>" lines on stderr, read as they come.
function Write-Step([int]$Done, [int]$Total, [string]$Text) {
    [Console]::Error.WriteLine("@progress $Done $Total $Text")
}

function Get-NormPath([string]$p) {
    if (-not $p) { return '' }
    return $p.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

function Invoke-Git([string]$Dir, [string[]]$GitArgs) {
    $out = & git -C $Dir @GitArgs 2>&1
    return @{ code = $LASTEXITCODE; text = (@($out) -join "`n").Trim() }
}

# Why the worktree cannot be removed, or '' when it holds only ignored files.
function Get-Blocker([string]$Dir) {
    $st = Invoke-Git $Dir @('status', '--porcelain=v2', '--ignore-submodules=none')
    if ($st.code -ne 0) { return "git status failed: $($st.text)" }
    $reasons = @()
    foreach ($line in ($st.text -split "`n" | Where-Object { $_ })) {
        if ($line.StartsWith('?')) { $reasons += 'untracked files'; continue }
        if ($line.StartsWith('u')) { $reasons += 'unmerged files'; continue }
        if ($line.StartsWith('1') -or $line.StartsWith('2')) {
            $f = $line -split ' '
            $sub = $f[2]
            $name = $f[-1]
            if ($sub.StartsWith('N')) { $reasons += 'uncommitted changes'; continue }
            if ($sub[1] -eq 'C') {
                # A submodule left on another commit loses nothing if a ref outside this worktree holds
                # that commit: its remote branches, or its origin when that is the main checkout's copy.
                $subDir = Join-Path $Dir $name
                $sha = (Invoke-Git $subDir @('rev-parse', 'HEAD')).text
                $safe = [bool](Invoke-Git $subDir @('branch', '-r', '--contains', $sha)).text
                if (-not $safe) {
                    $origin = (Invoke-Git $subDir @('remote', 'get-url', 'origin')).text
                    if ($origin -and (Test-Path -LiteralPath $origin)) {
                        $safe = [bool](Invoke-Git $origin @('for-each-ref', '--count=1', '--contains', $sha)).text
                    }
                }
                if (-not $safe) { $reasons += "submodule $name has commits kept nowhere else"; continue }
            }
            if (($sub[2] -eq 'M' -or $sub[3] -eq 'U') -and -not $DiscardSubmoduleChanges) { $reasons += "changes inside submodule $name" }
        }
    }
    return (($reasons | Select-Object -Unique) -join ', ')
}

# Unlinks every junction / symlink under $Root without descending into it.
function Remove-Links([string]$Root) {
    $count = 0
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        try { $entries = [IO.Directory]::EnumerateFileSystemEntries($dir) } catch { continue }
        foreach ($e in $entries) {
            try { $attr = [IO.File]::GetAttributes($e) } catch { continue }
            $isDir = ($attr -band [IO.FileAttributes]::Directory) -ne 0
            if (($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                if ($isDir) { [IO.Directory]::Delete($e, $false) } else { [IO.File]::Delete($e) }
                $count++
            } elseif ($isDir) {
                $stack.Push($e)
            }
        }
    }
    return $count
}

$itemsJson = if ($ItemsB64) {
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ItemsB64))
} else {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::In.ReadToEnd()
}
# Skip a byte-order mark or anything else a pipe put before the JSON.
$start = $itemsJson.IndexOf('[')
if ($start -lt 0) { Write-Output '[]'; return }
$itemsJson = $itemsJson.Substring($start)
$items = $itemsJson | ConvertFrom-Json
$known = @{}
$mainPath = ''
foreach ($line in (& git -C $Repo worktree list --porcelain 2>$null)) {
    if ($line -like 'worktree *') {
        $p = Get-NormPath $line.Substring(9)
        if (-not $mainPath) { $mainPath = $p }
        $known[$p] = $true
    }
}
. (Join-Path $PSScriptRoot 'config.ps1')
$beforeRemove = @()
try { $beforeRemove = @(Get-ConfigList (Read-PanelConfig $Repo) 'beforeRemove') } catch { }
$results = New-Object System.Collections.Generic.List[object]
$needPrune = $false

$itemList = @($items)
$verb = if ($DryRun) { 'checking' } else { 'removing' }
foreach ($it in $itemList) {
    $path = [string]$it.path
    Write-Step $results.Count $itemList.Count "$verb $(Split-Path $path -Leaf)"
    $norm = Get-NormPath $path
    $r = [pscustomobject]@{ path = $path; branch = [string]$it.branch; ok = $false; reason = ''; removed = $false; links = 0; branchDeleted = $false; branchError = '' }
    $results.Add($r)

    if (-not $known.ContainsKey($norm)) { $r.reason = 'not a worktree of this repository'; continue }
    if ($norm -eq $mainPath) { $r.reason = 'the main checkout is never removed'; continue }
    if ($Protect -and $norm -eq (Get-NormPath $Protect)) { $r.reason = 'this session runs in it'; continue }

    $missing = -not (Test-Path -LiteralPath $path)
    # A folder without its .git link: git run inside it would answer for the main checkout above it.
    $leftover = (-not $missing) -and -not (Test-Path -LiteralPath (Join-Path $path '.git'))
    if (-not $missing -and -not $leftover) {
        $why = Get-Blocker $path
        if ($why) { $r.reason = $why; continue }
    }
    $r.ok = $true
    if ($leftover) { $r.reason = 'leftover of a partial delete: git cannot check these files' }
    if ($DryRun) { continue }

    if ($missing) {
        $needPrune = $true
        $r.removed = $true
    } elseif ($leftover) {
        try { $r.links = Remove-Links $path } catch { $r.ok = $false; $r.reason = "could not unlink links: $($_.Exception.Message)"; continue }
        & cmd.exe /d /c rd /s /q "$path" 2>$null
        if (Test-Path -LiteralPath $path) { $r.ok = $false; $r.reason = 'some leftover files stayed (in use?)'; continue }
        $needPrune = $true
        $r.removed = $true
        $r.reason = ''
    } else {
        # The repository's own step first (its config's beforeRemove), run from the main checkout.
        if ($beforeRemove.Count -gt 0) {
            $cmd = @($beforeRemove | ForEach-Object { $_.Replace('{path}', $path) })
            $rest = if ($cmd.Count -gt 1) { $cmd[1..($cmd.Count - 1)] } else { @() }
            Push-Location -LiteralPath $Repo
            try { & $cmd[0] @rest *> $null } catch { } finally { Pop-Location }
        }
        try { $r.links = Remove-Links $path } catch { $r.ok = $false; $r.reason = "could not unlink links: $($_.Exception.Message)"; continue }
        # Re-check right before the delete; nothing may have changed since the check above.
        $why = Get-Blocker $path
        if ($why) { $r.ok = $false; $r.reason = $why; continue }
        $rm = Invoke-Git $Repo @('worktree', 'remove', $path)
        if ($rm.code -ne 0 -and $rm.text -match 'submodule') {
            # Checked clean above: --force only drops git-ignored files and allowed submodule edits.
            $rm = Invoke-Git $Repo @('worktree', 'remove', '--force', $path)
        }
        if ($rm.code -ne 0) { $r.ok = $false; $r.reason = "git worktree remove failed: $($rm.text)"; continue }
        $r.removed = $true
        if (Test-Path -LiteralPath $path) { $r.reason = 'removed from git, but some files stayed (in use?)' }
    }

    $action = [string]$it.branchAction
    if ($r.branch -and ($action -eq 'safe' -or $action -eq 'force')) {
        $flag = if ($action -eq 'force') { '-D' } else { '-d' }
        $br = Invoke-Git $Repo @('branch', $flag, $r.branch)
        if ($br.code -eq 0) { $r.branchDeleted = $true } else { $r.branchError = $br.text }
    }
}

if ($needPrune -and -not $DryRun) { [void](Invoke-Git $Repo @('worktree', 'prune')) }
Write-Step $itemList.Count $itemList.Count 'done'
ConvertTo-Json -InputObject ([object[]]$results.ToArray()) -Depth 4 -Compress
