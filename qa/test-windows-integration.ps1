Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'scripts/windows-integration.ps1'
$contract = Get-Content -LiteralPath (Join-Path $repo 'src/windows-file-types.json') -Raw | ConvertFrom-Json
$testId = [Guid]::NewGuid().ToString('N')
$prefix = "Software\Vokri\IntegrationTests\$testId"
$tempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd('\')
$temp = Join-Path $tempRoot "vokri-associations-$testId"
$user = [Microsoft.Win32.Registry]::CurrentUser
$registry = $user.CreateSubKey($prefix)

function Put([string]$Key, [string]$Name, [string]$Value) {
    $item = $registry.CreateSubKey($Key)
    try { $item.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $item.Dispose() }
}
function Read([string]$Key, [string]$Name) {
    $item = $registry.OpenSubKey($Key)
    if (!$item) { return $null }
    try { return $item.GetValue($Name) } finally { $item.Dispose() }
}
function Exists([string]$Key) {
    $item = $registry.OpenSubKey($Key)
    if (!$item) { return $false }
    $item.Dispose()
    return $true
}
function Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected [$Expected], found [$Actual]." }
}
function Preview([string]$Name) {
    $root = Join-Path $temp $Name
    $app = Join-Path $root 'resources/app'
    $icons = Join-Path $app 'assets/brand/documents'
    [void][IO.Directory]::CreateDirectory($icons)
    [IO.File]::WriteAllText((Join-Path $root $contract.executable), 'Fixture for registry command paths')
    [IO.File]::WriteAllText((Join-Path $app 'package.json'), '{}')
    Copy-Item -LiteralPath (Join-Path $repo 'assets/brand/vc.ico') -Destination (Split-Path -Parent $icons)
    foreach ($category in $contract.types.PSObject.Properties) {
        $name = $category.Name.ToLowerInvariant() + '.ico'
        Copy-Item -LiteralPath (Join-Path $repo "assets/brand/documents/$name") -Destination $icons
    }
    return $root
}
function Verify-Preserved {
    Equal (Read 'Software\Classes\.js' '') 'Other.Editor'
    Equal (Read 'Software\RegisteredApplications' 'Other Editor') 'Software\OtherEditor\Capabilities'
    Equal (Read 'Software\Classes\.js\OpenWithProgids' 'Other.Editor') ''
    Equal (Read $choice 'ProgId') 'Other.Editor'
    Equal (Read $choice 'Hash') 'Unrelated demo hash'
    Equal ([IO.File]::ReadAllText($projectFile)) 'Keep this source file'
}

try {
    [void][IO.Directory]::CreateDirectory($temp)
    $projectFile = Join-Path $temp 'source.js'
    [IO.File]::WriteAllText($projectFile, 'Keep this source file')
    $choice = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.js\UserChoice'
    Put 'Software\Classes\.js' '' 'Other.Editor'
    Put 'Software\Classes\.js\OpenWithProgids' 'Other.Editor' ''
    Put 'Software\RegisteredApplications' 'Other Editor' 'Software\OtherEditor\Capabilities'
    Put $choice 'ProgId' 'Other.Editor'
    Put $choice 'Hash' 'Unrelated demo hash'
    $first = Preview 'first version'
    $update = Preview 'updated version'
    $capability = 'Software\Vokri\WindowsIntegration\Capabilities'
    $classes = 'Software\Classes'
    & $script Register -InstallRoot $first -TestScope $testId
    Equal (& $script Status -TestScope $testId).Registered $true
    Equal (Read 'Software\RegisteredApplications' $contract.application) $capability
    Verify-Preserved
    foreach ($category in $contract.types.PSObject.Properties) {
        $progId = "Vokri.Code.$($category.Name).$($contract.version)"
        $program = "$classes\$progId"
        $iconPath = Join-Path $first ('resources/app/assets/brand/documents/' + $category.Name.ToLowerInvariant() + '.ico')
        Equal (Read "$program\DefaultIcon" '') ('"' + $iconPath + '",0')
        $command = '"' + (Join-Path $first $contract.executable) + '" --vokri-open -- "%1"'
        Equal (Read "$program\shell\open\command" '') $command
        Equal (Read "$classes\Directory\shell\VokriCode.Open\command" '') $command
        foreach ($extension in $category.Value) {
            Equal (Read "$capability\FileAssociations" $extension) $progId
            $item = $registry.OpenSubKey("$classes\$extension\OpenWithProgids")
            try {
                Equal ($item.GetValueKind($progId)) ([Microsoft.Win32.RegistryValueKind]::None)
                Equal ($item.GetValue($progId).Length) 0
            } finally { $item.Dispose() }
        }
    }
    & $script Register -InstallRoot $update -TestScope $testId
    & $script Register -InstallRoot $update -TestScope $testId
    Equal (Read "$classes\Vokri.Code.Code.1\shell\open\command" '') ('"' + (Join-Path $update $contract.executable) + '" --vokri-open -- "%1"')
    Verify-Preserved
    & $script Unregister -TestScope $testId
    & $script Unregister -TestScope $testId
    Equal (& $script Status -TestScope $testId).Registered $false
    Equal (Exists $capability) $false
    Equal (Exists "$classes\Applications\$($contract.executable)") $false
    Equal (Exists "$classes\Directory\shell\VokriCode.Open") $false
    foreach ($category in $contract.types.PSObject.Properties) {
        $progId = "Vokri.Code.$($category.Name).$($contract.version)"
        Equal (Exists "$classes\$progId") $false
        foreach ($extension in $category.Value) { Equal (Read "$classes\$extension\OpenWithProgids" $progId) $null }
    }
    Verify-Preserved
    Put "$classes\Vokri.Code.Code.1" '' 'Foreign ownership'
    try { & $script Register -InstallRoot $first -TestScope $testId; throw 'Expected a collision rejection.' }
    catch { if ($_.Exception.Message -notmatch 'conflicting Explorer registration') { throw } }
    & $script Unregister -TestScope $testId
    Equal (Read "$classes\Vokri.Code.Code.1" '') 'Foreign ownership'
    Equal (Exists $capability) $false
    Verify-Preserved
    Write-Output 'Registry lifecycle verified.'
} finally {
    $registry.Dispose()
    $user.DeleteSubKeyTree($prefix, $false)
    if (Test-Path -LiteralPath $temp) {
        $resolved = (Resolve-Path -LiteralPath $temp).Path
        if ((Split-Path -Parent $resolved) -ne $tempRoot -or (Split-Path -Leaf $resolved) -ne "vokri-associations-$testId") {
            throw 'Unexpected registry fixture path during cleanup.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
