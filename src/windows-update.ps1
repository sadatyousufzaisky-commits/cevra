param([int]$WaitForEditor)

$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1"
$candidate = $env:VOKRI_UPDATE_FILE
$stream = $null

function Read-MsiProperty($Database, [string]$Name) {
    $view = $Database.OpenView('SELECT `Value` FROM `Property` WHERE `Property` = ?')
    try {
        $argument = $installer.CreateRecord(1)
        $argument.StringData(1) = $Name
        $view.Execute($argument)
        $row = $view.Fetch()
        if ($null -ne $row) { return $row.StringData(1) }
    } finally { $view.Close() }
}

try {
    if ($WaitForEditor) { Wait-Process -Id $WaitForEditor -Timeout 120 -ErrorAction SilentlyContinue }
    if ($WaitForEditor -and (Get-Process -Id $WaitForEditor -ErrorAction SilentlyContinue)) { throw 'VOKRI Code is still running.' }
    $stream = [IO.File]::Open($candidate, 'Open', 'Read', 'Read')
    if ($stream.Length -gt 1GB) { throw 'Package exceeds the size limit.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $candidate
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -cne $env:VOKRI_UPDATE_SIGNER) {
        [Console]::WriteLine('SIGNATURE')
        exit 1
    }
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase($candidate, 0)
    if ((Read-MsiProperty $database 'ProductName') -cne 'VOKRI Code' -or
        (Read-MsiProperty $database 'UpgradeCode') -ine ('{' + $env:VOKRI_UPDATE_FAMILY + '}') -or
        (Read-MsiProperty $database 'VOKRIINSTALLSCOPE') -cne $env:VOKRI_UPDATE_SCOPE) {
        [Console]::WriteLine('IDENTITY')
        exit 1
    }
    $nextVersion = Read-MsiProperty $database 'ProductVersion'
    if ($nextVersion -cnotmatch '^\d+\.\d+\.\d+$' -or [version]$nextVersion -le [version]$env:VOKRI_UPDATE_VERSION) {
        [Console]::WriteLine('VERSION')
        exit 1
    }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
    if ($WaitForEditor) {
        $program = Join-Path $env:SystemRoot 'System32\msiexec.exe'
        Start-Process -FilePath $program -ArgumentList ('/i "' + $candidate + '" REBOOT=ReallySuppress') -Wait
    } else { [Console]::WriteLine($nextVersion) }
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($WaitForEditor) {
        Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
        try { [IO.Directory]::Delete([IO.Path]::GetDirectoryName($candidate)) } catch {}
    }
}
