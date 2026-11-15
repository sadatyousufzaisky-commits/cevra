# G3 Electron-free product foundation

The first G3 build stages a native VOKRI Code launcher and its workspace service in a standalone app folder. `VokriCode.exe` locates the bundled Node.js executable and service relative to its own folder. The launcher starts the service over private pipes in a Windows Job Object. The staged build includes the project test reporter and process supervisor.

## Build and run

Use Windows x64, the Windows .NET Framework compiler, and the official Node.js v24.15.0 x64 executable. The build verifies the executable and downloads and verifies its release license. It stages a file inventory with SHA-256 digests and publishes to a new directory after all files are ready. [Node.js release checksums](https://nodejs.org/dist/v24.15.0/SHASUMS256.txt) · [Node.js license](https://raw.githubusercontent.com/nodejs/node/v24.15.0/LICENSE)

```powershell
npm run build:vokri-product
& .\dist\vokri-product\VokriCode.exe
```

Supply a new output folder with `npm run build:vokri-product -- <folder>` for a second build. The launcher accepts a project folder and an optional `--user-data-dir=<absolute folder>`. Keep the contents of the app folder together when moving it.

## Shared Windows profile

The standalone native launcher and Electron workbench use the same Windows profile selection rules. An explicit profile path takes priority. Without an override, the launcher uses `%APPDATA%\CEVRA` when it is the only existing profile and `%APPDATA%\VOKRI Code` otherwise. When both exist, both folders are kept intact. To reopen a profile created by the earlier standalone native build, pass `--user-data-dir` with the absolute path to `%LOCALAPPDATA%\VOKRI Code\Native`.

Windows grants a single workbench access to a profile at a time. Close the open workbench before switching builds. The operating system releases the lock after a crash, and the next workbench can recover edits whose backup completed. When returning to a build that predates the shared lock, close the current workbench before launching it.

The native workbench reads saved theme, editor font size, font family, and wrap settings, including workspace overrides. It uses the VOKRI system palette for the System option and Consolas for the default font. The native workbench reads preferences without rewriting them. It continues to prompt for consent before running project code. Trust records, extension registrations, and Intelligence connections remain in the original profile for the Electron workbench.

## Verification

`npm run test:vokri-product` builds into a temporary directory and launches from an unrelated working directory with a system-only PATH. It verifies the file inventory, native process modules, the bundled Node.js child, nested source execution and navigation, project tests, service loss, and recovery of a backed-up draft after reopening.

The staged product test also verifies branded, legacy, and explicit profile selection and applies the saved workspace wrap setting in a real Windows editor. The Windows identity suite verifies that Electron and the native workbench guard a shared profile in both directions, including through a junction alias. It reopens a legacy profile in the native workbench, creates a draft, terminates the native process, and recovers the unsaved content in Electron. It compares the original source and preferences byte for byte after the handoff.

On `1bd3beb`, the staged integration test passed on Windows 11 and a clean Windows Server 2025 checkout. The hosted job ran without `node_modules` or Electron on PATH. The six SDK tests passed locally and on Windows Server 2022 and 2025. Three focused existing-product execution tests passed locally. The previous Server 2025 SDK run exposed a folder-dialog readiness race in the probe. The probe now waits for the titled dialog and an enabled action before sending the command. [Clean native product job](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43669421785/job/132675915280)

## Electron replacement inventory

| Surface | Current dependency | G3 state |
| --- | --- | --- |
| App and workbench startup | `src/main.cjs`, `BrowserWindow`, browser assets | Standalone launcher and native workspace slice run through VOKRI |
| Workspace, drafts and execution | Renderer preload methods and main-process IPC | Private pipe routes cover file browsing, editing, save, JavaScript and TypeScript runs, test runs and error navigation in the native slice |
| Settings, profile continuity and window state | Electron app-data resolution, native theme and renderer settings | Shared Windows profile and draft recovery work across both workbenches. Native settings controls, remaining editor preferences, and window state await parity |
| Editor and Continuum | CodeMirror, xterm, renderer panels and IPC | RichEdit and native execution output available. Language services, the terminal, debugger, Python, Git and Continuum workflows await native parity |
| Extension and Intelligence surfaces | Electron preload and window lifecycle | Existing brokers and services are migration inputs. Native surfaces and consent parity remain open |
| Product build, desktop QA and packaging | Repository Electron main entry, Electron and Playwright dependencies, renderer builds | Staged native app and independent clean-checkout QA available. Repository-wide replacement, release package scans and the production cutover remain open |

Keep the production Electron entry point available until its required workflows have native equivalents. The staged executable contains no browser fallback. G3 remains in progress.
