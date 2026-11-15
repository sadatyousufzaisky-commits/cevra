# G2 VOKRI native SDK

The integration branch combines Phase 6 G1 at `4340ed9` and the native SDK and experimental workbench from `663d431`. The integration resolved the script conflict by preserving the current product build and QA scripts alongside the native targets. The sample and DLL build from the same SDK sources as the experimental native preview.

## Build and verification

| Target | Command |
| --- | --- |
| SDK DLL | `node scripts/build-vokri.cjs --sdk-only` |
| SDK and standalone sample | `node scripts/build-vokri.cjs --sample` |
| Native SDK, standalone sample and native preview tests | `npm run test:vokri` |

The sample uses a Windows manifest with PerMonitorV2 DPI awareness and version 6 common controls. The runtime test copies the sample and DLL to an otherwise empty folder and opens the sample from it. It navigates 100,000 virtual documents and checks source, appearance and font changes. Build prerequisites are Windows x64, its .NET Framework compiler, and Node.js 24 for the scripts. The sample process has no Node.js service, Chromium renderer, or WebView. [Sample manifest](../../vokri/samples/workbench/app.manifest) · [SDK guide](../../vokri/README.md)

## Native behavior

- Native button windows preserve keyboard and Windows Accessibility behavior while VOKRI renders Iris Ink and Midnight Atelier states. Windows contrast settings supply the palette when active.
- The native report list serves row labels on demand. The test reads the final row through Windows Accessibility and moves selection with an Up key message.
- RichEdit retains the Unicode edit surface and receives IME input from Windows. The shortcut dispatcher leaves active IME composition with the control.
- The window handles DPI messages and rebuilds logical bounds and fonts. Animation runs on the UI thread and stops when disposed, when the window closes, or when a frame callback fails.
- Native tests cover owned-window closing, 180 resize and paint iterations, GDI resource stability after warm-up, and service request deadlines and disposal. Frame timings measure resize and application paint work in the test process. They do not measure desktop compositor presentation.

## Platform evidence

The local test machine runs Windows 11 x64 build 26300. The CI matrix uses Windows Server 2022 and 2025 x64. Windows Server results supplement local Windows client testing. Windows 10 client testing, moving a window across mixed-DPI monitors, and a live IME composition check need hardware or a Windows client image with those configurations. The automated tests cover synthetic DPI transitions, Unicode and native accessibility roles and names.
