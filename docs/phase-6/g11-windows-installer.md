# G11 Windows installer, updater, and uninstaller

VOKRI Code ships two offline Windows x64 MSI previews from the same editor build. Both contain Electron, the editor, and the native helpers. End users can run the installed editor without preparing Node.js, Electron, WiX, or a .NET SDK. [Windows Installer installation contexts](https://learn.microsoft.com/en-us/windows/win32/msi/installation-context)

| Package | Scope | Default folder |
| --- | --- | --- |
| `VOKRI-Code-<version>-x64-current-user.msi` | Current Windows account | `%LOCALAPPDATA%\Programs\VOKRI Code` |
| `VOKRI-Code-<version>-x64-all-users.msi` | All users, with administrator approval | `%ProgramFiles%\VOKRI Code` |

Setup describes the selected scope before installing. The Start menu shortcut is included. The desktop shortcut and File Explorer integration are optional. Explorer integration adds the existing VOKRI document types to **Open with** and the classic folder menu. You choose your preferred default apps in Windows Settings. Older portable previews that already registered this integration can unregister it with their own preview script before the MSI takes ownership. [Explorer integration](g10-windows-integration.md)

Run a newer MSI for the installed scope to upgrade. Windows Installer migrates feature selections and uses a transaction to restore the earlier installation after a failed upgrade. Setup includes an additional payload-sized margin when it checks disk space for that transaction. **Settings → Profile → Windows update package** opens a local signed update in builds configured with the publisher's certificate thumbprint. It checks the Windows Authenticode result, publisher thumbprint, product, scope, and version. Confirming an update uses the editor's ordinary close and draft-backup flow before setup opens. The release feed belongs to Phase 8. [Windows Installer major upgrades](https://learn.microsoft.com/en-us/windows/win32/msi/major-upgrades) · [InstallValidate](https://learn.microsoft.com/en-us/windows/win32/msi/installvalidate-action)

Use Windows **Settings → Apps → Installed apps** to uninstall. Opening the MSI for the installed version also offers repair and removal. Keep that MSI as the repair source in case Windows requests it. Setup uses the recorded installation folder for maintenance and upgrades. MSI owns program files, shortcuts, and optional registrations. Profiles, projects, draft backups, and Windows Credential Manager entries are outside its ownership. [Windows Installer source resiliency](https://learn.microsoft.com/en-us/windows/win32/msi/source-resiliency)

## Build and test

Build on Windows x64 from the repository after `npm ci`. A .NET runtime compatible with WiX 6 is needed on the build machine. The tool bootstrap verifies the pinned WiX archives with SHA-256. [WiX 6.0.2](https://github.com/wixtoolset/wix/releases/tag/v6.0.2)

```powershell
./scripts/get-windows-installer-toolchain.ps1
npm run build:windows-installer
```

The build places both packages in `dist/windows-installer/<version>`. Each package has a CycloneDX SBOM and a file inventory with SHA-256 hashes. To verify the lifecycle, use a clean Windows test account or VM and set `VOKRI_TEST_INSTALLER_SCOPE` to `account` or `machine`. The machine test requires an elevated shell. Use a fresh stage name each time.

```powershell
npm run stage:windows-integration -- g11-test
$env:VOKRI_TEST_INSTALLER_STAGE = 'g11-test'
$env:VOKRI_TEST_INSTALLER_SCOPE = 'account'
npm run test:windows-installer
```

The CI matrix runs both scopes and saves Windows Installer logs and lifecycle results. It exercises broken package rejection, fresh install and editor launch, repair, feature migration, deliberate upgrade failure and rollback, downgrade rejection, uninstall, draft recovery, project and profile preservation, and refusal of an unsigned update. MSI database validation skips ICE57 for the two `ALLUSERS=1` shortcut components in the all-users package and ICE91 for the fixed-profile file target in the current-account package. [Windows Installer ICE57](https://learn.microsoft.com/en-us/windows/win32/msi/ice57) · [Windows Installer ICE91](https://learn.microsoft.com/en-us/windows/win32/msi/ice91)

## Release status

The Windows 11 current-account wizard installed VOKRI Code into the current account's Programs folder and launched it. The default selection created the Start menu shortcut. [Setup welcome screen](evidence/g11/current-account-welcome.png)

Both installation scopes passed on clean Windows Server 2025 runners on November 21, 2026. The fixtures verified project and draft recovery and preserved a synthetic credential in Windows Credential Manager through upgrade, rollback, and removal. Windows 11 Home x64 built and validated both 0.1.1 preview packages. The Windows reliability suite passed 177 core tests and 112 desktop tests, with the optional native profile handoff skipped. [Installer lifecycle run](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/44896446890) · [Windows reliability run](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/44873558691)

This gate uses the Electron workbench approved for Phase 6. Public distribution requires a publisher certificate, signed application binaries and MSI packages, and successful verification of the signed update flow on clean Windows systems. Configure `VOKRI_UPDATE_SIGNER_THUMBPRINT` with the approved certificate thumbprint when building those packages. Apply signatures and timestamps with the release signing process and regenerate artifact hashes from the final signed bytes. Preview packages lack a configured signer. [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)

The low-space test installed VOKRI Code on a disposable virtual disk, then left 96 MiB free. Windows rejected the upgrade before replacing the earlier version. The test verified that the installed executable, version, and registry record were intact, then uninstalled from the original folder. [Low-space test artifacts](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/44896446890/artifacts/14703782836)

G11 passed for the Windows preview on November 21, 2026. Windows 10 client coverage is deferred to release validation. [Phase 6 gate record](PHASE6_STATUS.json)
