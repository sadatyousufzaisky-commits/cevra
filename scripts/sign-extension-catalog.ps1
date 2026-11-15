param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][ValidateRange(1, [int]::MaxValue)][int]$Generation,
  [ValidateRange(1, 365)][int]$ValidDays = 180
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
$signingKeyPath = Join-Path $env:LOCALAPPDATA 'VokriCodeCatalog/signing-key.dpapi'
$protectedKey = [IO.File]::ReadAllBytes($signingKeyPath)
$signingKey = [Security.Cryptography.ProtectedData]::Unprotect($protectedKey, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
try {
  [Convert]::ToBase64String($signingKey) | node (Join-Path $PSScriptRoot 'sign-extension-catalog.cjs') $Destination $Generation $ValidDays
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  [Array]::Clear($signingKey, 0, $signingKey.Length)
}
