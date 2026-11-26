# Collects the state of every git worktree of a repository as JSON on stdout:
# push state, PR (Azure DevOps or GitHub, read off the origin URL), merged-into-base, line counts
# since branch-off, and the Claude desktop app sessions that run in each worktree.
# Git runs sequentially (parallel git calls contend and run slower here);
# the PR lookups run in parallel beside it.
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    # Empty: the config's "base", else the remote's default branch.
    [string]$Base = '',
    [switch]$Fetch
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$warnings = New-Object System.Collections.Generic.List[string]
$utf8 = New-Object System.Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'config.ps1')

$config = [pscustomobject]@{}
try { $config = Read-PanelConfig $Repo } catch { $warnings.Add($_.Exception.Message) }

# Progress for the panel: "@progress <done> <total> <what>" lines on stderr, read as they come.
function Write-Step([int]$Done, [int]$Total, [string]$Text) {
    [Console]::Error.WriteLine("@progress $Done $Total $Text")
}

function Get-NormPath([string]$p) {
    if (-not $p) { return '' }
    return $p.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

function Invoke-Git([string]$Dir, [string[]]$GitArgs) {
    $o = & git -C $Dir @GitArgs 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $o
}

function Read-ShortStat($lines) {
    $r = @{ files = 0; ins = 0; del = 0 }
    $s = ($lines | Out-String)
    if ($s -match '(\d+) files? changed') { $r.files = [int]$Matches[1] }
    if ($s -match '(\d+) insertions?') { $r.ins = [int]$Matches[1] }
    if ($s -match '(\d+) deletions?') { $r.del = [int]$Matches[1] }
    return $r
}

if ($Fetch) {
    Write-Step 0 1 'fetching origin'
    # Never block on a credential prompt: this runs in the background.
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'
    & git -C $Repo fetch origin --prune --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { $warnings.Add('git fetch failed (VPN / conditional access?); showing local refs') }
}

if (-not $Base) { $Base = Get-ConfigText $config 'base' }
if (-not $Base) {
    $head = & git -C $Repo symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null
    $Base = if ($LASTEXITCODE -eq 0 -and $head) { ([string]$head) -replace '^origin/', '' } else { 'main' }
}
$baseRef = "origin/$Base"
& git -C $Repo rev-parse --verify --quiet $baseRef 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { $baseRef = $Base }
$provider = Get-PrProvider ([string](& git -C $Repo remote get-url origin 2>$null)) $config

# Remote branches and local branch commit times, once.
$remoteHeads = @{}
foreach ($line in (Invoke-Git $Repo @('for-each-ref', '--format=%(refname:lstrip=3) %(objectname)', 'refs/remotes/origin'))) {
    $parts = $line -split ' ', 2
    if ($parts.Count -eq 2) { $remoteHeads[$parts[0]] = $parts[1] }
}

# Worktrees.
$worktrees = New-Object System.Collections.Generic.List[object]
$cur = $null
foreach ($line in (Invoke-Git $Repo @('worktree', 'list', '--porcelain'))) {
    if ($line -like 'worktree *') {
        if ($cur) { $worktrees.Add($cur) }
        $cur = @{ path = $line.Substring(9).Replace('/', '\'); head = ''; branch = ''; detached = $false; prunable = $false }
    } elseif ($line -like 'HEAD *') { $cur.head = $line.Substring(5) }
    elseif ($line -like 'branch *') { $cur.branch = $line.Substring(7) -replace '^refs/heads/', '' }
    elseif ($line -eq 'detached') { $cur.detached = $true }
    elseif ($line -like 'prunable*') { $cur.prunable = $true }
}
if ($cur) { $worktrees.Add($cur) }
$mainPath = if ($worktrees.Count -gt 0) { Get-NormPath $worktrees[0].path } else { '' }
# One step per worktree, then one for the PR answers.
$stepTotal = $worktrees.Count + 1
Write-Step 0 $stepTotal 'reading branches and sessions'

# Commits ahead of / behind the base and the last commit time of every checked-out branch, in one call.
$branchInfo = @{}
$patterns = @($worktrees | Where-Object { $_.branch } | ForEach-Object { "refs/heads/$($_.branch)" })
if ($patterns.Count -gt 0) {
    $fmt = "--format=%(refname:lstrip=2)|%(committerdate:unix)|%(ahead-behind:$baseRef)"
    foreach ($line in (Invoke-Git $Repo (@('for-each-ref', $fmt) + $patterns))) {
        $p = $line -split '\|'
        if ($p.Count -lt 3) { continue }
        $ab = $p[2] -split ' '
        $branchInfo[$p[0]] = @{ time = [int64]$p[1] * 1000; ahead = [int]$ab[0]; behind = [int]$ab[1] }
    }
}

# PR access and the PR lookups, started first so they overlap the git work. One test call says why PR
# status is unavailable, so the panel can tell the person how to fix it. Issue kinds: no-token, no-gh,
# unauthorized (expired, revoked, signed out), forbidden (conditional access, VPN), unreachable, error.
$prIssue = $null
$auth = $null
$lookup = $null

function Get-ErrorText($err) {
    $msg = [string]$err.Exception.Message
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $msg = [string]$err.ErrorDetails.Message }
    $msg = ($msg -replace '\s+', ' ').Trim()
    if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
    return $msg
}

$adoLookup = {
    param($branch, $auth, $provider)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ref = [uri]::EscapeDataString("refs/heads/$branch")
    $u = "$($provider.api)/pullrequests?searchCriteria.sourceRefName=$ref&searchCriteria.status=all&`$top=10&api-version=7.1"
    try {
        $r = Invoke-RestMethod -Uri $u -Headers @{ Authorization = $auth } -TimeoutSec 20
    } catch {
        return [pscustomobject]@{ error = $_.Exception.Message }
    }
    $all = @($r.value)
    if ($all.Count -eq 0) { return $null }
    # Prefer an active PR, then the newest one.
    $pick = $all | Where-Object { $_.status -eq 'active' } | Select-Object -First 1
    if (-not $pick) { $pick = $all | Sort-Object creationDate -Descending | Select-Object -First 1 }
    return [pscustomobject]@{
        id         = [int]$pick.pullRequestId
        title      = [string]$pick.title
        status     = [string]$pick.status
        draft      = [bool]$pick.isDraft
        url        = "$($provider.web)/pullrequest/$($pick.pullRequestId)"
        target     = ([string]$pick.targetRefName) -replace '^refs/heads/', ''
        lastSource = [string]$pick.lastMergeSourceCommit.commitId
    }
}

# GitHub through the gh CLI and its own sign-in; states are mapped to the Azure DevOps words.
$ghLookup = {
    param($branch, $auth, $provider)
    $out = & gh pr list -R $provider.api --head $branch --state all --limit 10 --json number,title,state,isDraft,url,baseRefName,headRefOid,createdAt 2>$null
    if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ error = "gh pr list failed (exit $LASTEXITCODE)" } }
    # PowerShell 5.1 emits a JSON array as one object: assign first, then wrap.
    $parsed = ($out | Out-String) | ConvertFrom-Json
    $all = @($parsed)
    if ($all.Count -eq 0) { return $null }
    $pick = $all | Where-Object { $_.state -eq 'OPEN' } | Select-Object -First 1
    if (-not $pick) { $pick = $all | Sort-Object createdAt -Descending | Select-Object -First 1 }
    $status = switch ([string]$pick.state) { 'OPEN' { 'active' } 'MERGED' { 'completed' } default { 'abandoned' } }
    return [pscustomobject]@{
        id         = [int]$pick.number
        title      = [string]$pick.title
        status     = $status
        draft      = [bool]$pick.isDraft
        url        = [string]$pick.url
        target     = [string]$pick.baseRefName
        lastSource = [string]$pick.headRefOid
    }
}

if ($provider.kind -eq 'ado') {
    try {
        if (-not ('WtPanelCredMan' -as [type])) {
            Add-Type -Language CSharp -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class WtPanelCredMan {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential)]
  struct CREDENTIAL { public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; }
  public static string Read(string target) { IntPtr p; if (!CredRead(target,1,0,out p)) return null;
    var c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));
    string s=Marshal.PtrToStringUni(c.CredentialBlob,c.CredentialBlobSize/2); CredFree(p); return s; }
}
'@
        }
        $pat = [WtPanelCredMan]::Read($provider.tokenName)
        if ($pat) { $auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$pat")) }
    } catch { }

    if (-not $auth) {
        $prIssue = [pscustomobject]@{ kind = 'no-token'; detail = "no token in Windows Credential Manager under $($provider.tokenName)" }
    } else {
        try {
            $probe = Invoke-WebRequest -Uri "$($provider.api)?api-version=7.1" -Headers @{ Authorization = $auth } -UseBasicParsing -TimeoutSec 20
            # A refused token can come back as 203 with a sign-in page instead of a 401.
            if ($probe.StatusCode -ne 200 -or -not ([string]$probe.Content).TrimStart().StartsWith('{')) {
                $prIssue = [pscustomobject]@{ kind = 'unauthorized'; detail = "HTTP $($probe.StatusCode), sign-in page instead of data" }
            }
        } catch {
            $resp = $_.Exception.Response
            $msg = Get-ErrorText $_
            if (-not $resp) { $prIssue = [pscustomobject]@{ kind = 'unreachable'; detail = $msg } }
            else {
                $code = [int]$resp.StatusCode
                $kind = if ($code -eq 401) { 'unauthorized' } elseif ($code -eq 403) { 'forbidden' } else { 'error' }
                $prIssue = [pscustomobject]@{ kind = $kind; detail = "HTTP $($code): $msg" }
            }
        }
    }
    if (-not $prIssue) { $lookup = $adoLookup }
} elseif ($provider.kind -eq 'github') {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        $prIssue = [pscustomobject]@{ kind = 'no-gh'; detail = 'gh (the GitHub CLI) is not on the PATH' }
    } else {
        $st = & gh auth status --hostname github.com 2>&1
        if ($LASTEXITCODE -ne 0) {
            $msg = (($st | Out-String) -replace '\s+', ' ').Trim()
            if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
            $prIssue = [pscustomobject]@{ kind = 'unauthorized'; detail = $msg }
        } else {
            $lookup = $ghLookup
        }
    }
}

$pool = $null
$prJobs = @{}
if ($lookup) {
    $pool = [RunspaceFactory]::CreateRunspacePool(1, 8)
    $pool.Open()
    foreach ($wt in $worktrees) {
        # Merged branches are usually deleted on the remote, so every branch is asked about.
        if (-not $wt.branch -or (Get-NormPath $wt.path) -eq $mainPath -or $prJobs.ContainsKey($wt.branch)) { continue }
        $ps = [PowerShell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($lookup).AddArgument($wt.branch).AddArgument($auth).AddArgument($provider)
        $prJobs[$wt.branch] = @{ ps = $ps; handle = $ps.BeginInvoke() }
    }
}

# Desktop app sessions, keyed by worktree path.
$sessionsByPath = @{}
$sessionRoot = Join-Path $env:LOCALAPPDATA 'Claude-Data'
$sessionFiles = @()
if (Test-Path $sessionRoot) {
    $sessionFiles = Get-ChildItem -Path $sessionRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'claude-code-sessions' } |
        Where-Object { Test-Path $_ } |
        ForEach-Object { Get-ChildItem -Path $_ -Recurse -File -Filter 'local_*.json' -ErrorAction SilentlyContinue }
}
foreach ($f in $sessionFiles) {
    try { $j = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json } catch { continue }
    $p = $j.worktreePath
    if (-not $p) { $p = $j.cwd }
    $key = Get-NormPath $p
    if (-not $key) { continue }
    if (-not $sessionsByPath.ContainsKey($key)) { $sessionsByPath[$key] = New-Object System.Collections.Generic.List[object] }
    $sessionsByPath[$key].Add([pscustomobject]@{
        id           = [string]$j.sessionId
        title        = [string]$j.title
        archived     = [bool]$j.isArchived
        lastActivity = [int64]$(if ($j.lastActivityAt) { $j.lastActivityAt } else { 0 })
        turns        = [int]$(if ($j.completedTurns) { $j.completedTurns } else { 0 })
        waiting      = [bool]$j.interruptedAwaitingPerson
    })
}

# Branch-off stats only change with the commits, so they are cached across runs.
$cachePath = Join-Path $env:LOCALAPPDATA 'claude-worktrees-panel\stat-cache.json'
$statCache = @{}
if (Test-Path $cachePath) {
    try {
        $cached = [IO.File]::ReadAllText($cachePath) | ConvertFrom-Json
        foreach ($p in $cached.PSObject.Properties) { $statCache[$p.Name] = @{ files = [int]$p.Value.files; ins = [int]$p.Value.ins; del = [int]$p.Value.del } }
    } catch { }
}
$usedKeys = @{}

$rows = New-Object System.Collections.Generic.List[object]
foreach ($wt in $worktrees) {
    $dir = $wt.path
    Write-Step $rows.Count $stepTotal "git $(Split-Path $dir -Leaf)"
    $isMain = (Get-NormPath $dir) -eq $mainPath
    $row = [pscustomobject]@{
        path = $dir; name = (Split-Path $dir -Leaf); branch = $wt.branch; head = $wt.head
        detached = [bool]$wt.detached; main = [bool]$isMain
        status = ''; detail = ''; commits = 0; unpushed = 0; behindRemote = 0; behindBase = 0
        remote = $false; pr = $null; leftover = $false
        files = 0; ins = 0; del = 0; dirtyFiles = 0; dirtyIns = 0; dirtyDel = 0; lastCommit = [int64]0
        sessions = @()
    }
    $sess = $sessionsByPath[(Get-NormPath $dir)]
    if ($sess) { $row.sessions = [object[]]@($sess | Sort-Object lastActivity -Descending) }
    $rows.Add($row)

    if ($wt.prunable -or -not (Test-Path -LiteralPath $dir)) {
        $row.status = 'missing'
        # Prunable with the folder still there: a delete stopped partway and took the .git link with it.
        if (Test-Path -LiteralPath $dir) {
            $row.leftover = $true
            $row.detail = 'partly deleted: the .git link is gone, some files are left'
        } else {
            $row.detail = 'folder is gone (prunable)'
        }
        continue
    }

    $mb = Invoke-Git $dir @('merge-base', 'HEAD', $baseRef)
    $bi = if ($wt.branch) { $branchInfo[$wt.branch] } else { $null }
    if ($bi) {
        $row.commits = $bi.ahead; $row.behindBase = $bi.behind; $row.lastCommit = $bi.time
    } elseif ($mb) {
        $c = (Invoke-Git $dir @('rev-list', '--left-right', '--count', "$baseRef...HEAD")) -split '\s+'
        if ($c.Count -ge 2) { $row.behindBase = [int]$c[0]; $row.commits = [int]$c[1] }
        $lc = Invoke-Git $dir @('log', '-1', '--format=%ct', 'HEAD')
        if ($lc) { $row.lastCommit = [int64]$lc * 1000 }
    }
    if ($mb) {
        $ck = "$mb..$($wt.head)"
        $st = $statCache[$ck]
        if (-not $st) {
            $st = Read-ShortStat (Invoke-Git $dir @('diff', '--shortstat', '--no-renames', '--ignore-submodules=all', $mb, 'HEAD'))
            $statCache[$ck] = $st
        }
        $usedKeys[$ck] = $true
        $row.files = $st.files; $row.ins = $st.ins; $row.del = $st.del
    }
    $row.dirtyFiles = @(Invoke-Git $dir @('status', '--porcelain', '--ignore-submodules=all') | Where-Object { $_ }).Count
    if ($row.dirtyFiles -gt 0) {
        $ds = Read-ShortStat (Invoke-Git $dir @('diff', '--shortstat', '--no-renames', '--ignore-submodules=all', 'HEAD'))
        $row.dirtyIns = $ds.ins; $row.dirtyDel = $ds.del
    }

    if ($wt.branch) {
        if ($remoteHeads[$wt.branch]) {
            $row.remote = $true
            $rc = (Invoke-Git $dir @('rev-list', '--left-right', '--count', "origin/$($wt.branch)...HEAD")) -split '\s+'
            if ($rc.Count -ge 2) { $row.behindRemote = [int]$rc[0]; $row.unpushed = [int]$rc[1] }
        } else {
            $row.unpushed = $row.commits
        }
    }
}

# Collect the PRs, then decide each row's status.
Write-Step $worktrees.Count $stepTotal 'waiting for PR status'
$prErrors = 0
foreach ($row in $rows) {
    $job = if ($row.branch) { $prJobs[$row.branch] } else { $null }
    if ($job) {
        if (-not $job.ContainsKey('result')) {
            $job.result = @($job.ps.EndInvoke($job.handle)) | Select-Object -First 1
            $job.ps.Dispose()
        }
        $pr = $job.result
        if ($pr -and $pr.PSObject.Properties['error']) { $prErrors++; $pr = $null }
        $row.pr = $pr
    }
    if ($row.status -eq 'missing') { continue }
    $pr = $row.pr
    if ($row.main) {
        $row.status = 'main'
    } elseif ($row.detached) {
        $row.status = 'detached'
    } elseif ($pr -and $pr.status -eq 'completed') {
        $row.status = 'merged'
        if ($pr.lastSource -and $pr.lastSource -ne $row.head) {
            $n = Invoke-Git $row.path @('rev-list', '--count', "$($pr.lastSource)..HEAD")
            if ($n -and [int]$n -gt 0) { $row.status = 'merged+'; $row.detail = "$n commit(s) after the merged PR" }
        }
    } elseif ($pr -and $pr.status -eq 'active') {
        $row.status = 'pr'
    } elseif ($row.commits -eq 0) {
        $row.status = 'empty'
    } elseif ($row.remote -and $row.unpushed -eq 0) {
        $row.status = 'pushed'
    } elseif ($row.remote) {
        $row.status = 'ahead'
    } else {
        $row.status = 'local'
    }
    if ($pr -and $pr.status -eq 'abandoned') { $row.detail = "PR $($pr.id) abandoned" }
}
if ($pool) { $pool.Close() }
if ($prErrors -gt 0) { $prIssue = [pscustomobject]@{ kind = 'partial'; detail = "PR query failed for $prErrors branch(es)" } }

try {
    $keep = @{}
    foreach ($k in $usedKeys.Keys) { $keep[$k] = $statCache[$k] }
    [void](New-Item -ItemType Directory -Force -Path (Split-Path $cachePath))
    [IO.File]::WriteAllText($cachePath, (ConvertTo-Json -InputObject $keep -Compress), $utf8)
} catch { }

$doc = [pscustomobject]@{
    generatedAt = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    repo        = $Repo
    base        = $baseRef
    prEnabled   = [bool]$lookup
    provider    = [pscustomobject]@{
        kind = $provider.kind; name = $provider.name; org = $provider.org; web = $provider.web; api = $provider.api
        home = $provider.home; tokenPage = $provider.tokenPage; tokenName = $provider.tokenName
    }
    prIssue     = $prIssue
    build       = [pscustomobject]@{ dirs = [string[]]@(Get-ConfigList $config 'buildDirs'); binaries = [string[]]@(Get-ConfigList $config 'binaryDirs') }
    warnings    = [string[]]$warnings.ToArray()
    worktrees   = [object[]]$rows.ToArray()
}
Write-Step $stepTotal $stepTotal 'done'
ConvertTo-Json -InputObject $doc -Depth 6 -Compress
