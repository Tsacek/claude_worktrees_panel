# Shared by the panel's scripts (dot-sourced): the repository's panel config and folder patterns.

# Reads .claude/worktrees-panel.json from the current directory (the panel runs the scripts in the
# session's checkout), else the given checkout, else the main checkout. Missing keys stay unset; a file
# that does not parse throws, naming the file.
function Read-PanelConfig([string]$Repo) {
    $dirs = @((Get-Location).Path, $Repo)
    $first = & git -C $Repo worktree list --porcelain 2>$null | Select-Object -First 1
    if ($first -like 'worktree *') { $dirs += $first.Substring(9) }
    foreach ($d in $dirs) {
        $f = Join-Path $d '.claude\worktrees-panel.json'
        if (-not (Test-Path -LiteralPath $f)) { continue }
        try { return ([IO.File]::ReadAllText($f) | ConvertFrom-Json) }
        catch { throw "$f does not parse: $($_.Exception.Message)" }
    }
    return [pscustomobject]@{}
}

function Get-ConfigList($Config, [string]$Key) {
    $p = $Config.PSObject.Properties[$Key]
    if (-not $p -or $null -eq $p.Value) { return [string[]]@() }
    return [string[]]@($p.Value | ForEach-Object { [string]$_ } | Where-Object { $_ })
}

function Get-ConfigText($Config, [string]$Key) {
    $p = $Config.PSObject.Properties[$Key]
    if (-not $p -or $null -eq $p.Value) { return '' }
    return [string]$p.Value
}

# The folders under $Root matching a relative pattern such as "packages/*/build/*/obj", as relative
# paths with backslashes. A segment may hold * and ?; links are never followed.
# shortcut: no "**" segments; add them if a repository needs build folders at varying depths.
function Resolve-DirPattern([string]$Root, [string]$Pattern) {
    $current = @('')
    foreach ($seg in ($Pattern -split '[\\/]' | Where-Object { $_ })) {
        $next = @()
        foreach ($rel in $current) {
            $base = if ($rel) { Join-Path $Root $rel } else { $Root }
            if ($seg -match '[*?]') {
                foreach ($d in (Get-ChildItem -LiteralPath $base -Directory -Force -Filter $seg -ErrorAction SilentlyContinue)) {
                    if (($d.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                    $next += $(if ($rel) { "$rel\$($d.Name)" } else { $d.Name })
                }
            } else {
                $full = Join-Path $base $seg
                if (-not (Test-Path -LiteralPath $full -PathType Container)) { continue }
                if (([IO.File]::GetAttributes($full) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                $next += $(if ($rel) { "$rel\$seg" } else { $seg })
            }
        }
        $current = $next
        if ($current.Count -eq 0) { break }
    }
    return [string[]]@($current | Where-Object { $_ })
}

# Where PR status comes from, read off the origin URL: Azure DevOps, GitHub, or nothing.
function Get-PrProvider([string]$Url, $Config) {
    $u = ([string]$Url).Trim()
    $org = $null
    if ($u -match '^https://(?:[^@/]+@)?dev\.azure\.com/([^/]+)/([^/]+)/_git/([^/?#]+)') {
        $org = $Matches[1]; $project = $Matches[2]; $name = $Matches[3]; $site = "https://dev.azure.com/$org"
    } elseif ($u -match '^https://(?:[^@/]+@)?([^./]+)\.visualstudio\.com/(?:DefaultCollection/)?([^/]+)/_git/([^/?#]+)') {
        $org = $Matches[1]; $project = $Matches[2]; $name = $Matches[3]; $site = "https://$org.visualstudio.com"
    } elseif ($u -match '^(?:ssh://)?[^@/]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::v3|/v3)/([^/]+)/([^/]+)/([^/]+?)/?$') {
        $org = $Matches[1]; $project = $Matches[2]; $name = $Matches[3]; $site = "https://dev.azure.com/$org"
    }
    if ($org) {
        $token = Get-ConfigText $Config 'adoTokenName'
        if (-not $token) { $token = "worktrees-panel:ado:$org" }
        return [pscustomobject]@{
            kind = 'ado'; name = 'Azure DevOps'; org = $org
            api = "https://dev.azure.com/$org/$project/_apis/git/repositories/$name"
            web = "$site/$project/_git/$name"
            home = "$site/$project"; tokenPage = "$site/_usersSettings/tokens"; tokenName = $token
        }
    }
    if ($u -match '^(?:https://(?:[^@/]+@)?github\.com/|(?:ssh://)?git@github\.com[:/])([^/]+)/([^/]+?)(?:\.git)?/?$') {
        $slug = "$($Matches[1])/$($Matches[2])"
        return [pscustomobject]@{
            kind = 'github'; name = 'GitHub'; org = $Matches[1]; api = $slug; web = "https://github.com/$slug"
            home = "https://github.com/$slug"; tokenPage = ''; tokenName = ''
        }
    }
    $hostName = if ($u -match '^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)') { $Matches[1] } else { 'this remote' }
    return [pscustomobject]@{ kind = 'none'; name = $hostName; org = ''; api = ''; web = ''; home = ''; tokenPage = ''; tokenName = '' }
}
