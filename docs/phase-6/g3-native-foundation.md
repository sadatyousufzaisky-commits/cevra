# G3 Electron-free product foundation

The first G3 build stages a native VOKRI Code launcher and its workspace service in a standalone app folder. `VokriCode.exe` locates the bundled Node.js executable and service relative to its own folder. The launcher starts the service over private pipes in a Windows Job Object. The staged build includes the project test reporter and process supervisor.

## Build and run

Use Windows x64, the Windows .NET Framework compiler, and the official Node.js v24.15.0 x64 executable. The build verifies the executable and downloads and verifies its release license. It stages a file inventory with SHA-256 digests and publishes to a new directory after all files are ready. [Node.js release checksums](https://nodejs.org/dist/v24.15.0/SHASUMS256.txt) · [Node.js license](https://raw.githubusercontent.com/nodejs/node/v24.15.0/LICENSE)

```powershell
npm run build:vokri-product
& .\dist\vokri-product\VokriCode.exe
```

Supply a new output folder with `npm run build:vokri-product -- <folder>` for a second build. The launcher accepts a project folder and an optional `--user-data-dir=<absolute folder>`. Its default is `%LOCALAPPDATA%\VOKRI Code\Native`, separate from the existing product profile while migration is in progress. Keep the contents of the app folder together when moving it.

`npm run test:vokri-product` builds into a temporary directory and launches from an unrelated working directory with a system-only PATH. It verifies the file inventory, native process modules, the bundled Node.js child, nested source execution and navigation, project tests, service loss, and recovery of a backed-up draft after reopening.

## Electron replacement inventory

| Surface | Current dependency | G3 state |
| --- | --- | --- |
| App and workbench startup | `src/main.cjs`, `BrowserWindow`, browser assets | Standalone launcher and native workspace slice run through VOKRI |
| Workspace, drafts and execution | Renderer preload methods and main-process IPC | Private pipe routes cover file browsing, editing, save, JavaScript and TypeScript runs, test runs and error navigation in the native slice |
| Settings, profile migration and window state | Electron app-data resolution, native theme and renderer settings | Isolated native profile in use. Profile continuity and settings parity remain open |
| Editor and Continuum | CodeMirror, xterm, renderer panels and IPC | RichEdit and native execution output available. Language services, the terminal, debugger, Python, Git and Continuum workflows await native parity |
| Extension and Intelligence surfaces | Electron preload and window lifecycle | Existing brokers and services are migration inputs. Native surfaces and consent parity remain open |
| Product build, desktop QA and packaging | Repository Electron main entry, Electron and Playwright dependencies, renderer builds | Staged native app and independent clean-checkout QA available. Repository-wide replacement, release package scans and the production cutover remain open |

Keep the production Electron entry point available until its required workflows have native equivalents. The staged executable contains no browser fallback. G3 remains in progress.
