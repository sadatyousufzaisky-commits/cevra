# G10 Windows Open with, defaults, and VC document icons

The Windows x64 Electron preview stages `VokriCode.exe`, its matching Windows Error Reporting helper, and the app runtime together. Run `npm run stage:windows-integration -- preview` from the repository. Run `pwsh -File dist/windows-integration/preview/windows-integration.ps1 Register` to register it for the signed-in Windows account. The same script provides **Status** and **Unregister**. Update by staging a second named build and running its **Register** action. Keep the registered directory available until you switch registrations or remove them. [Electron 45 packaging requirements](https://www.electronjs.org/blog/electron-45-0#broader-crash-reporting-on-windows)

## File associations

| Category | Extensions | ProgID |
| --- | --- | --- |
| Code | `.js .jsx .mjs .cjs .ts .tsx .mts .cts .py .c .h .cpp .cs .sh .ps1` | `Vokri.Code.Code.1` |
| Data | `.json .yaml .yml .xml` | `Vokri.Code.Data.1` |
| Web | `.html .css` | `Vokri.Code.Web.1` |
| Text | `.md .txt` | `Vokri.Code.Text.1` |

The [file-type contract](../../src/windows-file-types.json) feeds both registration and launch validation. Each category uses a folded document and the VC mark at 16, 24, 32, 48, 64, 128, and 256 pixels. The document icon comes from the active Windows file association. The editor continues to show its language-specific file icons. [Document icon atlas](evidence/g10/document-icon-atlas.png)

| Windows integration | Win32 preview | MSIX mapping |
| --- | --- | --- |
| Open with and Default apps | Per-user `RegisteredApplications`, VOKRI-owned Capabilities, application SupportedTypes, and named `OpenWithProgids` values | `uap:Extension` with category `windows.fileTypeAssociation`, one association per asset category, and its supported extensions |
| Document artwork | Per-ProgID `DefaultIcon` points to the corresponding ICO | `uap:Logo` points to the scaled PNG assets for that category |
| Application identity | Friendly name **VOKRI Code** and AppUserModelID `Vokri.Code` | Packaged application identity and its Windows AUMID |
| Folder menu | VOKRI-owned `Directory\shell\VokriCode.Open` verb | Packaged Explorer command subject to later packaging work |

Each registration version identifies a stable ProgID schema across application upgrades. The registration script writes its own ProgIDs, app entry, capabilities, folder verb, and named Open with values. Windows Default apps handles the user's default selection. **Unregister** removes VOKRI-owned entries and refreshes the Shell. [Microsoft file types](https://learn.microsoft.com/en-us/windows/win32/shell/fa-file-types) · [Windows default apps](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-default-apps-settings) · [MSIX file type associations](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/desktop-to-uwp-extensions)

## Explorer launch behavior

The registered command quotes the executable and target and passes the target after an argument separator. Explorer launches sent while VOKRI Code is running go to its existing instance. Same-workspace files open in tabs, including files selected in a short Explorer launch burst. Selections for separate workspaces remain available through **Open next Explorer selection**. Switching workspaces uses the existing draft and terminal prompts.

On Windows 11, **Open Folder with VOKRI Code** is in the classic folder menu reached through **Show more options**.

The preview accepts supported files and local folders, including Unicode names, spaces, relative arguments from another working directory, and local long paths. It checks file and folder identity before opening and rejects device paths, UNC paths, alternate streams, linked files, hidden workspace internals, and unsupported or unreadable documents. Explorer activation opens content for editing with the workspace's normal execution authorization.

## Verification

The desktop tests open and save every registered extension, test a warm instance and a two-folder selection, and check Unicode, long paths, junctions, hard links, rejected inputs, and draft preservation. The Registry fixture covers fresh registration, update, repeat operations, ownership collision, and removal with a separate seeded default. A staged live test uses the real Windows Shell to resolve all four icon classes and activate a file and folder, then compares real user default records before and after cleanup. [Activation tests](../../qa/explorer-open-desktop.test.cjs) · [Registry tests](../../qa/windows-integration.test.cjs) · [Live Shell test](../../qa/windows-preview.test.cjs)

On Windows 11 Home build 26300, a real Explorer TypeScript fixture listed VOKRI Code in **Open with** and showed the existing Media Player default. The Windows URI opened the app-specific **Default apps** page. After unregistering, VOKRI Code disappeared from the chooser. The user-choice records for all 23 extensions matched the baseline. [Open with](evidence/g10/windows-11-open-with.png) · [Default apps](evidence/g10/windows-11-default-apps.png) · [After unregistering](evidence/g10/windows-11-after-unregister.png)

Revision `04d761306951926c7240f099896c2a422159ee1f` passed 177 core tests, 112 Electron desktop tests, and the staged Windows Shell integration test on Windows 11 Home and Windows Server 2025. Hosted checks also passed credential account isolation, 19 extension-host tests, and 13 Intelligence benchmark checks. The optional native profile-handoff test was skipped. [Windows reliability run](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43798651807)

G10 closed on November 21, 2026, at the project owner's direction. The owner waived Windows 10 desktop validation because a Windows 10 environment was unavailable. The Windows 11 manual sequence of choosing VOKRI Code as the default, inspecting the resulting document icon in Explorer, and restoring the previous default remains unverified. The automated Shell test resolved all four registered icon classes on Windows 11 and Windows Server 2025. [Phase 6 gate record](PHASE6_STATUS.json)
