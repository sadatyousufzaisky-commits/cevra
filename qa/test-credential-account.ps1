$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'The account-isolation fixture runs on the disposable hosted Windows runner.'
}

$name = 'cevraqa' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'aZ9!') -AsPlainText -Force
$login = [System.Management.Automation.PSCredential]::new(".\$name", $password)
$scope = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$reference = [Guid]::NewGuid().ToString('D')
$folder = Join-Path $env:PUBLIC $name
$executable = Join-Path $folder 'vault-probe.exe'
$vault = (Resolve-Path -LiteralPath 'dist/vokri-credential-vault.exe').Path
$account = $null
$otherWritten = $false
$directoryCreated = $false

function Assert-Probe([string[]] $command, [int] $expected, [bool] $otherAccount) {
    $options = @{
        FilePath = $executable
        ArgumentList = $command
        WorkingDirectory = $folder
        WindowStyle = 'Hidden'
        PassThru = $true
        Wait = $true
    }
    if ($otherAccount) {
        $options.Credential = $login
        $options.LoadUserProfile = $true
        $options.UseNewEnvironment = $true
    }
    $child = Start-Process @options
    if ($child.ExitCode -ne $expected) {
        throw "Credential account fixture returned $($child.ExitCode), expected $expected."
    }
}

try {
    New-Item -Path $folder -ItemType Directory | Out-Null
    $directoryCreated = $true
    Copy-Item -LiteralPath 'dist/cevra-credential-vault-probe.exe' -Destination $executable
    $account = New-LocalUser -Name $name -Password $password
    $users = Get-LocalGroup -SID 'S-1-5-32-545'
    if ((Get-LocalGroupMember -Group $users).SID -notcontains $account.SID) {
        Add-LocalGroupMember -Group $users -Member $account
    }
    Start-Service -Name seclogon
    Assert-Probe @('seed', $scope, 'openai', $reference, 'first') 0 $false
    Assert-Probe @('verify', $scope, 'openai', $reference, 'first') 0 $false
    Assert-Probe @('verify', $scope, 'openai', $reference, 'first') 3 $true
    Assert-Probe @('seed', $scope, 'openai', $reference, 'second') 0 $true
    $otherWritten = $true
    Assert-Probe @('verify', $scope, 'openai', $reference, 'second') 0 $true
    Assert-Probe @('verify', $scope, 'openai', $reference, 'first') 0 $false
    Write-Output 'Verified separate Windows accounts see only their own synthetic key at the same target.'
} finally {
    try {
        if ($otherWritten) { Assert-Probe @('delete', $scope, 'openai', $reference, 'second') 0 $true }
    } finally {
        try {
            $removed = Start-Process -FilePath $vault -ArgumentList @('delete', $scope, 'openai', $reference) -WindowStyle Hidden -PassThru -Wait
            if ($removed.ExitCode -ne 0) { throw 'Could not remove the hosted credential fixture.' }
        } finally {
            if ($account) { Remove-LocalUser -SID $account.SID }
            if ($directoryCreated) {
                if (Test-Path -LiteralPath $executable -PathType Leaf) { Remove-Item -LiteralPath $executable }
                Remove-Item -LiteralPath $folder
            }
        }
    }
}
