# Measures the disk use of folders for the worktrees panel. Reads a JSON array of folder paths on
# stdin and prints a JSON array of { path, bytes, obj, bin, files, ms }: obj is what the config's
# buildDirs hold, bin what its binaryDirs hold. Junctions and symlinks are counted as nothing and never
# followed, so linked data is not part of a worktree's size.
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [int]$Threads = 4
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

$raw = [Console]::In.ReadToEnd()
$start = $raw.IndexOf('[')
if ($start -lt 0) { Write-Output '[]'; return }
# PowerShell 5.1 emits a JSON array as one object: assign first, then wrap.
$parsed = $raw.Substring($start) | ConvertFrom-Json
$paths = @($parsed)
if ($paths.Count -eq 0) { Write-Output '[]'; return }

# Progress for the panel: "@progress <done> <total> <what>" lines on stderr, read as they come.
function Write-Step([int]$Done, [int]$Total, [string]$Text) {
    [Console]::Error.WriteLine("@progress $Done $Total $Text")
}

. (Join-Path $PSScriptRoot 'config.ps1')
$config = [pscustomobject]@{}
try { $config = Read-PanelConfig $Repo } catch { }
$buildPatterns = @(Get-ConfigList $config 'buildDirs')
$binaryPatterns = @(Get-ConfigList $config 'binaryDirs')

# The folders the panel can clean, keyed by lower-case full path: 1 = build output, 2 = binaries.
function Get-Buckets([string]$Root) {
    $b = @{}
    foreach ($p in $binaryPatterns) { foreach ($rel in (Resolve-DirPattern $Root $p)) { $b[(Join-Path $Root $rel).ToLowerInvariant()] = 2 } }
    foreach ($p in $buildPatterns) { foreach ($rel in (Resolve-DirPattern $Root $p)) { $b[(Join-Path $Root $rel).ToLowerInvariant()] = 1 } }
    return $b
}

# Also counts the build output the panel can clean, found on the same walk.
$measure = {
    param([string]$Root, [hashtable]$Buckets)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $bytes = [int64]0
    $obj = [int64]0
    $bin = [int64]0
    $files = 0
    $stack = New-Object System.Collections.Generic.Stack[object]
    try { $stack.Push(@([IO.DirectoryInfo]::new($Root), 0, 0)) } catch { }
    while ($stack.Count -gt 0) {
        $top = $stack.Pop()
        $dir = $top[0]; $depth = $top[1]; $bucket = $top[2]
        try { $entries = $dir.EnumerateFileSystemInfos() } catch { continue }
        try {
            foreach ($e in $entries) {
                $attr = $e.Attributes
                if (($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                if (($attr -band [IO.FileAttributes]::Directory) -ne 0) {
                    $b = $bucket
                    if ($b -eq 0 -and $Buckets.Count -gt 0) {
                        $hit = $Buckets[$e.FullName.ToLowerInvariant()]
                        if ($hit) { $b = $hit }
                    }
                    $stack.Push(@([IO.DirectoryInfo]$e, ($depth + 1), $b))
                } else {
                    $len = ([IO.FileInfo]$e).Length
                    $bytes += $len; $files++
                    if ($bucket -eq 1) { $obj += $len } elseif ($bucket -eq 2) { $bin += $len }
                }
            }
        } catch { }
    }
    return [pscustomobject]@{ path = $Root; bytes = $bytes; obj = $obj; bin = $bin; files = $files; ms = [int64]$sw.ElapsedMilliseconds }
}

$pool = [RunspaceFactory]::CreateRunspacePool(1, [Math]::Max(1, $Threads))
$pool.Open()
$jobs = foreach ($p in $paths) {
    $ps = [PowerShell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($measure).AddArgument([string]$p).AddArgument((Get-Buckets ([string]$p)))
    @{ ps = $ps; handle = $ps.BeginInvoke() }
}
Write-Step 0 $paths.Count 'measuring'
$done = 0
$results = foreach ($j in $jobs) {
    $m = @($j.ps.EndInvoke($j.handle)) | Select-Object -First 1
    $j.ps.Dispose()
    $done++
    if ($m) { Write-Step $done $paths.Count ([IO.Path]::GetFileName([string]$m.path)) }
    $m
}
$pool.Close()
ConvertTo-Json -InputObject ([object[]]@($results | Where-Object { $_ })) -Compress
