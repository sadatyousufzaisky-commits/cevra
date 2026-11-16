[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Register', 'Unregister', 'Status')][string]$Action,
    [string]$InstallRoot = $PSScriptRoot,
    [ValidatePattern('^[a-f0-9]{32}$')][string]$TestScope
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows integration requires Windows.' }
$manifest = Join-Path $PSScriptRoot 'resources/app/src/windows-file-types.json'
if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) {
    $manifest = Join-Path $PSScriptRoot '../src/windows-file-types.json'
}
$contract = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$appName = [string]$contract.application
$owner = [string]$contract.owner
$marker = 'VokriRegistrationOwner'
$capability = 'Software\Vokri\WindowsIntegration\Capabilities'
$catalog = 'Software\RegisteredApplications'
$classes = 'Software\Classes'
$application = "$classes\Applications\$($contract.executable)"
$folderVerb = "$classes\Directory\shell\VokriCode.Open"
$categories = @($contract.types.PSObject.Properties)
$owned = [Collections.Generic.List[string]]::new()
$owned.Add($capability)
$owned.Add($application)
$owned.Add($folderVerb)
foreach ($category in $categories) { $owned.Add("$classes\Vokri.Code.$($category.Name).$($contract.version)") }

function Get-RegistryValue([string]$Key, [string]$Name) {
    $item = $hive.OpenSubKey($Key)
    if (!$item) { return $null }
    try {
        if ($item.GetValueNames() -notcontains $Name) { return $null }
        [pscustomobject]@{
            Value = $item.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            Kind = $item.GetValueKind($Name)
        }
    } finally { $item.Dispose() }
}

function Read-Owner([string]$Key) {
    $value = Get-RegistryValue $Key $marker
    if ($null -ne $value -and $value.Kind -eq [Microsoft.Win32.RegistryValueKind]::String) { return $value.Value }
}

function Registry-KeyExists([string]$Key) {
    $item = $hive.OpenSubKey($Key)
    if (!$item) { return $false }
    $item.Dispose()
    return $true
}

function Set-RegistryValue([string]$Key, [string]$Name, $Value, [Microsoft.Win32.RegistryValueKind]$Kind = 'String') {
    $before = Get-RegistryValue $Key $Name
    $item = $hive.CreateSubKey($Key)
    try {
        $journal.Add([pscustomobject]@{ Key = $Key; Name = $Name; Before = $before })
        $item.SetValue($Name, $Value, $Kind)
    } finally { $item.Dispose() }
}

function Remove-RegistryValue([string]$Key, [string]$Name) {
    $item = $hive.OpenSubKey($Key, $true)
    if (!$item) { return }
    try { $item.DeleteValue($Name, $false) } finally { $item.Dispose() }
}

function Is-EmptyProgId($Value) {
    return $null -ne $Value -and (
        ($Value.Kind -eq [Microsoft.Win32.RegistryValueKind]::None -and $Value.Value.Length -eq 0) -or
        ($Value.Kind -eq [Microsoft.Win32.RegistryValueKind]::String -and $Value.Value -ceq '')
    )
}

function Notify-Shell {
    if ($TestScope) { return }
    if (!('VokriShell.Associations' -as [type])) {
        Add-Type -Namespace VokriShell -Name Associations -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(uint eventId, uint flags, System.IntPtr item1, System.IntPtr item2);
'@
    }
    [VokriShell.Associations]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}

$mutex = [Threading.Mutex]::new($false, ('Local\Vokri.WindowsIntegration.' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
$locked = $false
$user = [Microsoft.Win32.Registry]::CurrentUser
$hive = $user
try {
    try { $locked = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'Another VOKRI Code registration operation is in progress.' }
    if ($TestScope) { $hive = $user.CreateSubKey("Software\Vokri\IntegrationTests\$TestScope") }

    $registered = Get-RegistryValue $catalog $appName
    if ($Action -eq 'Status') {
        [pscustomobject]@{ Registered = $null -ne $registered -and $registered.Value -ceq $capability -and (Read-Owner $capability) -ceq $owner }
        return
    }
    if ($Action -eq 'Unregister') {
        if ($null -ne $registered -and $registered.Value -ceq $capability -and (Read-Owner $capability) -ceq $owner) {
            Remove-RegistryValue $catalog $appName
        }
        foreach ($category in $categories) {
            $progId = "Vokri.Code.$($category.Name).$($contract.version)"
            if ((Read-Owner "$classes\$progId") -cne $owner) { continue }
            foreach ($extension in $category.Value) {
                $path = "$classes\$extension\OpenWithProgids"
                if (Is-EmptyProgId (Get-RegistryValue $path $progId)) { Remove-RegistryValue $path $progId }
            }
        }
        foreach ($key in $owned) {
            if ((Read-Owner $key) -ceq $owner) { $hive.DeleteSubKeyTree($key, $false) }
        }
        Notify-Shell
        Write-Output 'VOKRI Code Explorer registrations removed.'
        return
    }

    $root = (Get-Item -LiteralPath $InstallRoot).FullName
    if ($root -notmatch '^[A-Za-z]:\\' -or $root -match '[%"\r\n]') { throw 'Choose a local preview folder without percent signs.' }
    $exe = Join-Path $root $contract.executable
    $brand = Join-Path $root 'resources/app/assets/brand'
    $appIcon = Join-Path $brand 'vc.ico'
    foreach ($file in @($exe, $appIcon, (Join-Path $root 'resources/app/package.json'))) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Build a Windows integration preview before registering it.' }
    }
    $documents = @{}
    foreach ($category in $categories) {
        $file = Join-Path $brand ('documents/' + $category.Name.ToLowerInvariant() + '.ico')
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'The preview is missing a document icon.' }
        $documents[$category.Name] = '"' + $file + '",0'
    }
    $command = '"' + $exe + '" --vokri-open -- "%1"'
    $appIcon = '"' + $appIcon + '",0'
    if ($null -ne $registered -and
        ($registered.Kind -ne [Microsoft.Win32.RegistryValueKind]::String -or $registered.Value -cne $capability)) {
        throw 'An existing program already uses the VOKRI Code registration name.'
    }
    $newKeys = [Collections.Generic.List[string]]::new()
    foreach ($key in $owned) {
        if (!(Registry-KeyExists $key)) { $newKeys.Add($key) }
        elseif ((Read-Owner $key) -cne $owner) { throw 'An existing program owns a conflicting Explorer registration.' }
    }
    foreach ($category in $categories) {
        $progId = "Vokri.Code.$($category.Name).$($contract.version)"
        foreach ($extension in $category.Value) {
            $value = Get-RegistryValue "$classes\$extension\OpenWithProgids" $progId
            if ($null -ne $value -and !(Is-EmptyProgId $value)) { throw 'An existing program owns a conflicting Open with entry.' }
        }
    }
    $journal = [Collections.Generic.List[object]]::new()
    try {
        foreach ($key in $owned) { Set-RegistryValue $key $marker $owner }
        Set-RegistryValue $capability 'ApplicationName' $appName
        Set-RegistryValue $capability 'ApplicationDescription' 'Edit source code, data, and text files with VOKRI Code.'
        Set-RegistryValue $capability 'ApplicationIcon' $appIcon
        Set-RegistryValue $application 'FriendlyAppName' $appName
        Set-RegistryValue "$application\DefaultIcon" '' $appIcon
        Set-RegistryValue "$application\shell\open" 'MultiSelectModel' 'Document'
        Set-RegistryValue "$application\shell\open\command" '' $command
        Set-RegistryValue $folderVerb 'MUIVerb' 'Open Folder with VOKRI Code'
        Set-RegistryValue $folderVerb 'Icon' $appIcon
        Set-RegistryValue $folderVerb 'MultiSelectModel' 'Document'
        Set-RegistryValue "$folderVerb\command" '' $command
        foreach ($category in $categories) {
            $progId = "Vokri.Code.$($category.Name).$($contract.version)"
            $class = "$classes\$progId"
            $description = "VOKRI Code $($category.Name.ToLowerInvariant()) document"
            Set-RegistryValue $class '' $description
            Set-RegistryValue $class 'FriendlyTypeName' $description
            Set-RegistryValue "$class\Application" 'ApplicationName' $appName
            Set-RegistryValue "$class\Application" 'ApplicationIcon' $appIcon
            Set-RegistryValue "$class\DefaultIcon" '' $documents[$category.Name]
            Set-RegistryValue "$class\shell\open" 'MultiSelectModel' 'Document'
            Set-RegistryValue "$class\shell\open\command" '' $command
            foreach ($extension in $category.Value) {
                Set-RegistryValue "$capability\FileAssociations" $extension $progId
                Set-RegistryValue "$classes\$extension\OpenWithProgids" $progId ([byte[]]::new(0)) None
                Set-RegistryValue "$application\SupportedTypes" $extension ''
            }
        }
        Set-RegistryValue $catalog $appName $capability
    } catch {
        $failure = $_
        for ($index = $journal.Count - 1; $index -ge 0; $index--) {
            $change = $journal[$index]
            if ($null -eq $change.Before) { Remove-RegistryValue $change.Key $change.Name }
            else {
                $item = $hive.CreateSubKey($change.Key)
                try { $item.SetValue($change.Name, $change.Before.Value, $change.Before.Kind) } finally { $item.Dispose() }
            }
        }
        foreach ($key in $newKeys) { $hive.DeleteSubKeyTree($key, $false) }
        throw $failure
    }
    Notify-Shell
    Write-Output 'VOKRI Code is available in Windows Open with and Default apps.'
} finally {
    if ($TestScope -and $hive -ne $user) { $hive.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
