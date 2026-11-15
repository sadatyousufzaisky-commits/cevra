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
- The native report list serves row labels on demand and exposes at most 64 rows at once. A live accessibility-tree scan stalled when the Windows provider enumerated the original 100,000-row list. The bounded list passed the same inspection. The native tests read the final row through Windows Accessibility and verify that arrow keys cross page boundaries. In a separate desktop smoke check, F7 and End opened row 100,000 and the accessibility tree showed its title and editor text.
- RichEdit retains the Unicode edit surface and receives IME input from Windows. The shortcut dispatcher leaves active IME composition with the control.
- The window handles DPI messages and rebuilds logical bounds and fonts. Animation runs on the UI thread and stops when disposed, when the window closes, or when a frame callback fails.
- Native tests cover owned-window closing, 180 resize and paint iterations, GDI resource stability after warm-up, and service request deadlines and disposal. Frame timings measure resize and application paint work in the test process. They do not measure desktop compositor presentation.

## Platform evidence

The local test machine runs Windows 11 x64 build 26300. The CI matrix uses Windows Server 2022 and 2025 x64. Windows Server results supplement local Windows client testing. Windows 10 client testing, moving a window across mixed-DPI monitors, and a live IME composition check need hardware or a Windows client image with those configurations. The automated tests cover synthetic DPI transitions, Unicode and native accessibility roles and names.

| Windows x64 configuration | Native tests | Resize and paint p95 | Row-label requests |
| --- | ---: | ---: | ---: |
| Windows 11 Home build 26300 | 6 passed | 8.484 ms | 7,020 |
| Windows Server 2022 build 20348 | 6 passed | 8.219 ms | 6,763 |
| Windows Server 2025 build 26100 | 6 passed | 9.962 ms | 6,763 |

Results are for `9ccb09b`. Each run exercised 180 resize and paint iterations with a 100,000-document source. The local run exercised animation and timer-fault cleanup. The hosted runners exercised the single static frame specified by their reduced-motion configuration. [Server 2022 SDK tests](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43667758389/job/132670843539) · [Server 2025 SDK tests](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43667758389/job/132670843794)

The same revision passed all 287 existing product tests, including core, desktop, extension-host, and Intelligence benchmark coverage. The separate Windows credential-account check also passed. [Product regression job](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43667758389/job/132670843876)

The project owner closed G2 on 15 November 2026 with Windows 10 client testing, live IME composition, and a mixed-DPI monitor transition recorded as acceptance exceptions.
