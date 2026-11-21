[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$version = '6.0.2'
$location = Join-Path $PSScriptRoot '../dist/g11-toolchain'
New-Item -ItemType Directory -Path $location -Force | Out-Null
$packages = @{
    'wix' = '13CAED0AA86898C9952EB8BA82C6AC6B43D1575BB731AC848E5EDF5490A10428'
    'wixtoolset.ui.wixext' = '5A9B12517290CA6FE8BA4280845291E31964DD2A2DD671AACEBD2FAA10C04A95'
}
foreach ($id in $packages.Keys) {
    $archive = Join-Path $location "$id.zip"
    if (!(Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/$id/$version/$id.$version.nupkg" -OutFile $archive -TimeoutSec 60
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash -cne $packages[$id]) {
        throw "The WiX archive $id failed hash verification."
    }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $location $id) -Force
}
