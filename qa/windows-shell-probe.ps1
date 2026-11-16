[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Snapshot','Launch')][string]$Action,
    [string]$Preview,
    [string]$Target
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$contract = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src/windows-file-types.json') -Raw | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class VokriShellProbe {
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int AssocQueryStringW(uint flags, uint kind, string association, string verb,
        StringBuilder result, ref uint length);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ShellInfo {
        public uint size, mask;
        public IntPtr owner;
        public string verb, file, parameters, directory;
        public int show;
        public IntPtr instance, idList;
        public string className;
        public IntPtr classKey;
        public uint hotKey;
        public IntPtr icon, process;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShellExecuteExW(ref ShellInfo info);

    public static string Query(uint kind, string association, string verb) {
        uint capacity = 32768;
        var result = new StringBuilder((int)capacity);
        return AssocQueryStringW(0, kind, association, verb, result, ref capacity) == 0 ? result.ToString() : null;
    }

    public static void Open(string file, string association, string verb) {
        var info = new ShellInfo {
            size = (uint)Marshal.SizeOf(typeof(ShellInfo)),
            mask = 0x00000101 | 0x00000400, // class name, synchronous handoff, no error UI
            className = association,
            file = file,
            verb = verb,
            show = 1
        };
        if (!ShellExecuteExW(ref info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

if ($Action -eq 'Snapshot') {
    $user = [Microsoft.Win32.Registry]::CurrentUser
    $roots = @('Software\Vokri\WindowsIntegration\Capabilities', "Software\Classes\Applications\$($contract.executable)",
        'Software\Classes\Directory\shell\VokriCode.Open')
    $extensions = foreach ($category in $contract.types.PSObject.Properties) { $category.Value }
    $roots += @(foreach ($category in $contract.types.PSObject.Properties) {
        "Software\Classes\Vokri.Code.$($category.Name).$($contract.version)"
    })
    $owned = @($roots | Where-Object {
        $key = $user.OpenSubKey($_)
        if (!$key) { return $false }
        $key.Dispose()
        return $true
    })
    $catalog = $user.OpenSubKey('Software\RegisteredApplications')
    try { $registered = $null -ne $catalog -and $catalog.GetValueNames() -contains $contract.application }
    finally { if ($catalog) { $catalog.Dispose() } }
    $choices = [ordered]@{}
    foreach ($extension in $extensions) {
        $choice = $user.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$extension\UserChoice")
        try {
            $choices[$extension] = [pscustomobject]@{
                ProgId = if ($choice) { $choice.GetValue('ProgId') }
                Hash = if ($choice) { $choice.GetValue('Hash') }
            }
        } finally { if ($choice) { $choice.Dispose() } }
    }
    [pscustomobject]@{ Owned = @($owned); Registered = $registered; Choices = $choices } | ConvertTo-Json -Depth 5 -Compress
    return
}

$expected = (Resolve-Path -LiteralPath (Join-Path $Preview $contract.executable)).Path
foreach ($category in $contract.types.PSObject.Properties) {
    $progId = "Vokri.Code.$($category.Name).$($contract.version)"
    $executable = [VokriShellProbe]::Query(2, $progId, 'open')
    if ($executable -ne $expected) { throw 'The Windows Shell resolved an unexpected executable.' }
    $icon = [VokriShellProbe]::Query(15, $progId, $null)
    $expectedIcon = Join-Path $Preview ('resources/app/assets/brand/documents/' + $category.Name.ToLowerInvariant() + '.ico')
    if ($icon -ne ('"' + $expectedIcon + '",0') -and $icon -ne ($expectedIcon + ',0')) {
        throw 'The Windows Shell resolved an unexpected document icon.'
    }
}
if (Test-Path -LiteralPath $Target -PathType Container) {
    [VokriShellProbe]::Open($Target, 'Directory', 'VokriCode.Open')
} else {
    $extension = [IO.Path]::GetExtension($Target)
    $category = @($contract.types.PSObject.Properties | Where-Object Value -Contains $extension)
    if ($category.Count -ne 1) { throw 'Choose a registered test fixture.' }
    [VokriShellProbe]::Open($Target, "Vokri.Code.$($category[0].Name).$($contract.version)", 'open')
}
Write-Output 'Windows Shell associations and document icons resolved.'
