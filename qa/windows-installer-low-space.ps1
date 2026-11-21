param([Parameter(Mandatory)][string]$Reports)

$ErrorActionPreference = 'Stop'
$reports = (Resolve-Path -LiteralPath $Reports).Path
$base = Get-Content -Raw -LiteralPath (Join-Path $reports '0.1.0.msi.inventory.json') | ConvertFrom-Json
$next = Get-Content -Raw -LiteralPath (Join-Path $reports '0.1.1.msi.inventory.json') | ConvertFrom-Json
$registration = 'Software\Vokri\Installer'
if ($base.scope -ne 'perUser' -or $next.scope -ne 'perUser' -or
    (Get-ItemPropertyValue -LiteralPath "HKCU:\$registration" -Name Scope -ErrorAction SilentlyContinue) -or
    (Get-ItemPropertyValue -LiteralPath "HKLM:\$registration" -Name Scope -ErrorAction SilentlyContinue)) {
    throw 'Use current-account packages on a clean Windows test system.'
}
foreach ($package in @($base, $next)) {
    if ($package.package.name -notmatch '^0\.1\.[01]\.msi$' -or $package.productCode -notmatch '^[0-9A-Fa-f-]{36}$') {
        throw 'The lifecycle packages have an unexpected identity.'
    }
    $file = Join-Path $reports $package.package.name
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $package.package.sha256) {
        throw 'The lifecycle package hash differs from its inventory.'
    }
}

function Invoke-Installer([string]$Arguments, [string]$Operation, [int[]]$Expected) {
    $log = Join-Path $reports "low-space-$Operation.log"
    $program = Join-Path $env:SystemRoot 'System32\msiexec.exe'
    $process = Start-Process -FilePath $program -ArgumentList "$Arguments /qn /norestart /L*v `"$log`"" -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(120000)) { $process.Kill(); throw "Windows Installer timed out. See $log" }
    if ($process.ExitCode -notin $Expected) { throw "$Operation exited with $($process.ExitCode). See $log" }
    return Get-Content -LiteralPath $log -Raw
}

$id = [Guid]::NewGuid().ToString('N')
$image = Join-Path $reports "disk-$id.vhdx"
$script = Join-Path $reports "disk-$id.txt"
$mounted = $false
$installAttempted = $false
$result = [ordered]@{ volumeBytes = 0; freeBeforeInstallBytes = 0; freeBeforeUpgradeBytes = 0; preflightRejected = $false; retainedVersion = $null; uninstalled = $false }
try {
    if ((Test-Path -LiteralPath $image) -or (Test-Path -LiteralPath $script)) { throw 'The scratch disk already exists.' }
    Set-Content -LiteralPath $script -Value ('create vdisk file="' + $image + '" maximum=1280 type=expandable') -Encoding ascii
    & (Join-Path $env:SystemRoot 'System32\diskpart.exe') /s $script
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $image -PathType Leaf)) { throw 'Could not create the isolated disk image.' }
    $attachment = Mount-DiskImage -ImagePath $image -Access ReadWrite -NoDriveLetter -PassThru
    $mounted = $true
    $disk = $attachment | Get-Disk
    if (@($disk).Count -ne 1 -or $disk.IsBoot -or $disk.IsSystem -or $disk.PartitionStyle -ne 'RAW' -or $disk.Size -ne 1280MB) {
        throw 'Refusing to initialize a disk that differs from the new scratch image.'
    }
    $partition = Initialize-Disk -InputObject $disk -PartitionStyle MBR -PassThru |
        New-Partition -UseMaximumSize -AssignDriveLetter
    if (!$partition.DriveLetter -or $partition.DiskNumber -ne $disk.Number) { throw 'The scratch partition could not be verified.' }
    Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel 'VOKRI G11 test' -Confirm:$false | Out-Null
    $drive = [IO.DriveInfo]::new([string]$partition.DriveLetter)
    $target = Join-Path $drive.RootDirectory.FullName 'VOKRI Code'
    $manifest = Join-Path $target 'resources\app\package.json'
    $previous = Join-Path $reports $base.package.name
    $updated = Join-Path $reports $next.package.name
    $result.volumeBytes = $drive.TotalSize
    $result.freeBeforeInstallBytes = $drive.AvailableFreeSpace
    $installAttempted = $true
    $null = Invoke-Installer "/i `"$previous`" INSTALLFOLDER=`"$target`"" 'install' @(0)
    $original = (Get-FileHash -LiteralPath (Join-Path $target 'VokriCode.exe')).Hash
    $ballast = Join-Path $drive.RootDirectory.FullName "space-$id.bin"
    $stream = [IO.File]::Open($ballast, 'CreateNew', 'Write', 'None')
    try { $stream.SetLength($drive.AvailableFreeSpace - 96MB); $stream.Flush($true) }
    finally { $stream.Dispose() }
    $result.freeBeforeUpgradeBytes = $drive.AvailableFreeSpace
    if ($result.freeBeforeUpgradeBytes -lt 80MB -or $result.freeBeforeUpgradeBytes -gt 112MB) {
        throw 'The actual free space differs from the intended test condition.'
    }
    try {
        $log = Invoke-Installer "/i `"$updated`" INSTALLFOLDER=`"$target`"" 'upgrade' @(1603)
        if ($log -notmatch 'OutOfDiskSpace.*(?:value is | = )''?1' -or
            $log -notmatch 'InstallValidate\. Return value 3\.' -or
            $log -match 'RemoveExistingProducts\. Return value 1\.') {
            throw 'Windows did not stop the upgrade at disk validation. Inspect the upgrade log.'
        }
        $result.preflightRejected = $true
        $result.retainedVersion = (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version
        if ($result.retainedVersion -ne $base.version -or
            (Get-FileHash -LiteralPath (Join-Path $target 'VokriCode.exe')).Hash -ne $original -or
            (Get-ItemPropertyValue -LiteralPath "HKCU:\$registration" -Name Version) -ne $base.version) {
            throw 'The insufficient-space upgrade changed the installed version.'
        }
    } finally { Remove-Item -LiteralPath $ballast -ErrorAction SilentlyContinue }
    $null = Invoke-Installer "/x {$($base.productCode)}" 'uninstall' @(0)
    $result.uninstalled = !(Test-Path -LiteralPath $target) -and
        !(Get-ItemPropertyValue -LiteralPath "HKCU:\$registration" -Name Scope -ErrorAction SilentlyContinue)
    if (!$result.uninstalled) { throw 'The disposable test installation was not removed.' }
} finally {
    try {
        if ($installAttempted -and !$result.uninstalled) {
            $null = Invoke-Installer "/x {$($next.productCode)}" 'cleanup-next' @(0, 1605)
            $null = Invoke-Installer "/x {$($base.productCode)}" 'cleanup-base' @(0, 1605)
        }
    } finally {
        if ($mounted) { Dismount-DiskImage -ImagePath $image }
        Remove-Item -LiteralPath $image,$script -ErrorAction SilentlyContinue
        $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $reports 'low-space.json') -Encoding utf8
    }
}
Write-Host 'Windows Installer rejected the upgrade before removing the installed version.'
