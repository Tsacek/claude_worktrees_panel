# Checks the config helpers: origin URL parsing and folder patterns. Run: powershell -File tests/config.check.ps1
. (Join-Path $PSScriptRoot '../scripts/config.ps1')
$fail = 0
function Check($name, $got, $want) { if ("$got" -ne "$want") { $script:fail++; "FAIL $name : got '$got' want '$want'" } }
$cfg = [pscustomobject]@{}
$cases = @(
    @('https://dev.azure.com/acme/My%20Proj/_git/repo', 'ado', 'https://dev.azure.com/acme/My%20Proj/_apis/git/repositories/repo', 'https://dev.azure.com/acme/My%20Proj/_git/repo'),
    @('https://acme@dev.azure.com/acme/Proj/_git/repo', 'ado', 'https://dev.azure.com/acme/Proj/_apis/git/repositories/repo', 'https://dev.azure.com/acme/Proj/_git/repo'),
    @('https://acme.visualstudio.com/DefaultCollection/Proj/_git/repo', 'ado', 'https://dev.azure.com/acme/Proj/_apis/git/repositories/repo', 'https://acme.visualstudio.com/Proj/_git/repo'),
    @('git@ssh.dev.azure.com:v3/acme/Proj/repo', 'ado', 'https://dev.azure.com/acme/Proj/_apis/git/repositories/repo', 'https://dev.azure.com/acme/Proj/_git/repo'),
    @('acme@vs-ssh.visualstudio.com:v3/acme/Proj/repo', 'ado', 'https://dev.azure.com/acme/Proj/_apis/git/repositories/repo', 'https://dev.azure.com/acme/Proj/_git/repo'),
    @('https://github.com/octo/tool.git', 'github', 'octo/tool', 'https://github.com/octo/tool'),
    @('git@github.com:octo/tool.git', 'github', 'octo/tool', 'https://github.com/octo/tool'),
    @('ssh://git@github.com/octo/tool', 'github', 'octo/tool', 'https://github.com/octo/tool'),
    @('https://gitlab.com/octo/tool.git', 'none', '', ''),
    @('', 'none', '', '')
)
foreach ($c in $cases) {
    $p = Get-PrProvider $c[0] $cfg
    Check "$($c[0]) kind" $p.kind $c[1]
    Check "$($c[0]) api" $p.api $c[2]
    Check "$($c[0]) web" $p.web $c[3]
}
Check 'gitlab host' (Get-PrProvider 'https://gitlab.com/octo/tool.git' $cfg).name 'gitlab.com'
Check 'token default' (Get-PrProvider 'https://dev.azure.com/acme/P/_git/r' $cfg).tokenName 'worktrees-panel:ado:acme'
Check 'token config' (Get-PrProvider 'https://dev.azure.com/acme/P/_git/r' ([pscustomobject]@{ adoTokenName = 'X' })).tokenName 'X'

# Folder patterns: a fake tree with a link that must not be followed.
$root = Join-Path $env:TEMP "wtp-pattern-$PID"
New-Item -ItemType Directory -Force "$root\packages\A\build\x64\obj", "$root\packages\B\build\x64\obj", "$root\packages\B\dist", "$root\Elsewhere\build\x64\obj" | Out-Null
cmd /c mklink /J "$root\packages\C" "$root\Elsewhere" | Out-Null
$got = (Resolve-DirPattern $root 'packages/*/build/*/obj') -join ';'
Check 'pattern obj' $got 'packages\A\build\x64\obj;packages\B\build\x64\obj'
Check 'pattern bin' ((Resolve-DirPattern $root 'packages/*/dist') -join ';') 'packages\B\dist'
Check 'pattern none' ((Resolve-DirPattern $root 'Nope/*') -join ';') ''
cmd /c rmdir "$root\packages\C"
Remove-Item -Recurse -Force $root
"$fail failures"
