# Deletes build output in git worktrees for the worktrees panel: the folders the repository's panel
# config names in buildDirs and, with -IncludeBinaries, binaryDirs. Sources are never touched: a folder
# is deleted only when git ignores it, it is no link itself, and links inside it are unlinked first.
# Reads a JSON array of { path } on stdin; prints a JSON array, one result per item, with build and
# binaries saying which kind it cleaned.
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [switch]$IncludeBinaries,
    # Checks and lists the folders without deleting anything.
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

# Progress for the panel: "@progress <done> <total> <what>" lines on stderr, read as they come.
function Write-Step([int]$Done, [int]$Total, [string]$Text) {
    [Console]::Error.WriteLine("@progress $Done $Total $Text")
}

function Get-NormPath([string]$p) {
    if (-not $p) { return '' }
    return $p.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

function Test-Link([string]$p) {
    try { return ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0 } catch { return $true }
}

# Unlinks every junction / symlink under $Root without descending into it.
function Remove-Links([string]$Root) {
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
            } elseif ($isDir) {
                $stack.Push($e)
            }
        }
    }
}

. (Join-Path $PSScriptRoot 'config.ps1')
$config = Read-PanelConfig $Repo
$buildPatterns = @(Get-ConfigList $config 'buildDirs')
$binaryPatterns = if ($IncludeBinaries) { @(Get-ConfigList $config 'binaryDirs') } else { @() }

# The folders to clean in one worktree, relative to it, each with its kind: 'build' or 'binaries'.
function Get-BuildDirs([string]$Root) {
    $found = @()
    foreach ($p in $buildPatterns) { foreach ($rel in (Resolve-DirPattern $Root $p)) { $found += [pscustomobject]@{ rel = $rel; kind = 'build' } } }
    foreach ($p in $binaryPatterns) { foreach ($rel in (Resolve-DirPattern $Root $p)) { $found += [pscustomobject]@{ rel = $rel; kind = 'binaries' } } }
    return $found
}

$raw = [Console]::In.ReadToEnd()
$start = $raw.IndexOf('[')
if ($start -lt 0) { Write-Output '[]'; return }
$parsed = $raw.Substring($start) | ConvertFrom-Json
$items = @($parsed)

$known = @{}
foreach ($line in (& git -C $Repo worktree list --porcelain 2>$null)) {
    if ($line -like 'worktree *') { $known[(Get-NormPath $line.Substring(9))] = $true }
}

# Plan first, so the progress counts every folder.
$plans = foreach ($it in $items) {
    $path = [string]$it.path
    $r = [pscustomobject]@{ path = $path; ok = $false; reason = ''; cleaned = [string[]]@(); stayed = [string[]]@(); build = $false; binaries = $false }
    $dirs = @()
    if (-not $known.ContainsKey((Get-NormPath $path))) { $r.reason = 'not a worktree of this repository' }
    elseif (-not (Test-Path -LiteralPath (Join-Path $path '.git'))) { $r.reason = 'no .git link (a leftover): remove it instead' }
    else { $dirs = @(Get-BuildDirs $path) }
    [pscustomobject]@{ result = $r; dirs = $dirs }
}
$total = ($plans | ForEach-Object { $_.dirs.Count } | Measure-Object -Sum).Sum
if (-not $total) { $total = 0 }
$done = 0
Write-Step 0 ([Math]::Max(1, $total)) 'starting'

foreach ($plan in $plans) {
    $r = $plan.result
    if ($r.reason) { continue }
    $cleaned = New-Object System.Collections.Generic.List[string]
    $stayed = New-Object System.Collections.Generic.List[string]
    $skipped = New-Object System.Collections.Generic.List[string]
    foreach ($dir in $plan.dirs) {
        $rel = $dir.rel
        $full = Join-Path $r.path $rel
        Write-Step $done $total "$(Split-Path $r.path -Leaf): $rel"
        $done++
        if (Test-Link $full) { $skipped.Add("$rel is a link"); continue }
        & git -C $r.path check-ignore -q -- ($rel.Replace('\', '/')) 2>$null
        if ($LASTEXITCODE -ne 0) { $skipped.Add("$rel is not ignored by git"); continue }
        if (-not $DryRun) {
            try { Remove-Links $full } catch { $skipped.Add("$rel has a link that could not be unlinked"); continue }
            & cmd.exe /d /c rd /s /q "$full" 2>$null
            if (Test-Path -LiteralPath $full) { $stayed.Add($rel); continue }
        }
        $cleaned.Add($rel)
        if ($dir.kind -eq 'build') { $r.build = $true } else { $r.binaries = $true }
    }
    $r.cleaned = [string[]]$cleaned.ToArray()
    $r.stayed = [string[]]$stayed.ToArray()
    $r.ok = $stayed.Count -eq 0 -and $skipped.Count -eq 0
    $why = @()
    if ($stayed.Count) { $why += 'some files are in use (close Visual Studio or the running app)' }
    if ($skipped.Count) { $why += ($skipped -join ', ') }
    $r.reason = $why -join '; '
}
Write-Step $total ([Math]::Max(1, $total)) 'done'
ConvertTo-Json -InputObject ([object[]]@($plans | ForEach-Object { $_.result })) -Depth 4 -Compress
