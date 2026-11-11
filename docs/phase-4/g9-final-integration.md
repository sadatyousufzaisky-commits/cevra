# G9 · Final Integration & Benchmark

## Windows acceptance

Run `npm test` and `npm run test:extension-host` with Node.js 24 on Windows x64. The first command retains the core and Electron regression suites. It also repeats the complete Continuum invoice repair, verification, and commit workflow with an empty extension registry, with Starter Tools enabled, and with that same enabled package suppressed by safe start. [Continuum tests](../../qa/continuum.test.cjs)

The extension-host suite builds the pinned Wasmtime worker and the SDK sample. The G9 scenario installs declarative and executable ZIPs through the real Extension Manager in a disposable profile. The native dialogs use fixture responses. The Electron IPC, archive verification, broker, Windows confinement, and editor run through their production code paths. [Windows lifecycle test](../../qa/extension-integration.test.cjs)

| Check | Acceptance evidence |
| --- | --- |
| Install and review | Reject an archive with an unsupported extra entry. Inspect each valid digest, install disabled, and enable explicitly. Denied consent starts zero hosts. |
| Five active hosts | Activate five executable packages and observe five worker processes and their five launchers. Refuse the sixth while all five slots are occupied. Run the scoped broker and independent commands. |
| Fault isolation | Trap one registered command and one activation in confined guests. Remove the failed host's proposals and registrations. Verify healthy hosts still run and failed processes exit. |
| Update and revocation | Surface the newly requested file scope. Preserve the old digest and running host after an injected registry write failure. On a successful update, keep the rollback digest and require a fresh grant for the new digest. Revoke a second host without stopping the others. |
| Recovery and cleanup | Terminate the Electron process tree, verify the acknowledged draft and unchanged source files, and require fresh executable activation. Switch workspaces and check process cleanup, empty registrations, and successful uninstall. |

### Security and fault replay

- The package and registry suites cover malformed and oversized archives, checked paths, reviewed digests, and process termination at each install, update, and remove checkpoint. [Package tests](../../qa/extensions.test.cjs) · [Registry tests](../../qa/extension-registry.test.cjs)
- The broker suite covers denied scope, cross-extension authority, pending revocation, workspace changes, replay, stale revisions, and audit privacy. The G9 desktop scenario verifies that a denied file read appears as an operation outcome without the fixture source or private path in the persisted audit. [Broker tests](../../qa/extension-broker.test.cjs)
- The confinement suite verifies the Windows job and LPAC boundaries and reaps faulted hosts after bounded hangs, invalid frames, and output floods. Hosted Windows tests exercise a synthetic clipboard sentinel. The executable-runtime suite checks stale edit rejection and persisted quarantine after repeated failures. [Confinement tests](../../qa/extension-host.test.cjs) · [Runtime tests](../../qa/extension-runtime.test.cjs)

The active-host limit is five, including startup and teardown. Each host still runs in its own Windows job with the existing one-process limit and 256 MiB worker limit. Executable activation is verified for Windows x64 builds 26100 and 26300. [Isolation contract](g3-extension-host-isolation.md) · [Broker contract](g5-capability-broker.md)

## Reproduce the benchmark

From the current CEVRA source checkout, prepare the pinned Phase 3 build in a detached worktree and run the benchmark.

```powershell
$baseline = Join-Path ([IO.Path]::GetTempPath()) ('cevra-phase3-' + [Guid]::NewGuid().ToString('N'))
git worktree add --detach $baseline f2048ffda5a02e21acfe8d6d39632070c5557961
Push-Location -LiteralPath $baseline
npm ci
npm run build
Pop-Location
npm ci
$env:CEVRA_G9_BASELINE = $baseline
npm run benchmark:extensions
```

The runner writes `dist/phase4-g9-benchmark.json` with the commits, machine and toolchain, sample order, raw samples, and summaries. It uses the same Electron executable, dependency lockfile, generated 50-file workspace, and Windows machine for both builds. Each launch gets a fresh profile and process. Filesystem caches stay warm. One warm-up per scenario is excluded. The 20 Phase 3 and Phase 4 pairs alternate order. There are 20 inert-package samples and five active-host samples. `CEVRA_G9_SAMPLES` and `CEVRA_G9_ACTIVE_SAMPLES` can shorten a smoke run. [Benchmark runner](../../qa/extension-benchmark.test.cjs)

- **Zero extensions** measures launch through workspace readiness, keystroke to the second animation frame after the editor DOM updates, test command to a passing result, and forced process termination through recovered draft selection. The runner verifies the recovered contents and original disk bytes.
- **50 inert packages** measures registry metadata discovery outside Electron launch, then records a separate startup and verified contribution snapshot for 50 enabled data-only packages. The SSD discovery target is p95 at or below 200 ms.
- **Five active hosts** measures explicit permission review through each ready host, editor paint, and a command round trip. It sums Windows-reported working sets for the five workers and the five launchers separately. Working sets can include shared pages. The lifecycle test verifies crash isolation separately and records activation timings in CI.

p50 is the median. p95 is the nearest-rank observation. For the five active-host samples, p95 of a per-run metric is the largest of the five measurements. Activation percentiles use all 25 activations.

## Recorded results

The 2026-11-11 run measured `261ae916932bc102461000d190113ea5baa44ccb` against Phase 3 `f2048ffda5a02e21acfe8d6d39632070c5557961` on Windows 11 Home x64 build 26300, an Intel Core i5-1135G7, 7,835 MiB of usable RAM, and an SSD. Both builds used Electron 45.2.3 with bundled Node.js 24.22.2. The runner used Node.js 24.15.0. [Raw samples](g9-benchmark-windows-26300.json)

| Zero-extension metric | Phase 3 p50 | Phase 4 p50 | Phase 3 p95 | Phase 4 p95 |
| --- | ---: | ---: | ---: | ---: |
| Launch to workspace ready | 1,656.50 ms | 1,720.00 ms | 1,943.00 ms | 1,948.00 ms |
| Editor paint | 30.15 ms | 26.75 ms | 47.20 ms | 35.70 ms |
| Test run | 1,503.44 ms | 1,514.71 ms | 1,818.37 ms | 1,596.54 ms |
| Forced restart to draft recovery | 1,981.61 ms | 2,061.94 ms | 2,689.42 ms | 2,535.57 ms |

Median launch rose by 63.50 ms and median recovery by 80.33 ms. The launch p95 rose by 5 ms. The other three p95 measurements decreased. These measurements show no material regression in the matched fixture.

| Extension workload metric | p50 | p95 |
| --- | ---: | ---: |
| 50 inert packages · metadata discovery | 18.96 ms | 37.03 ms |
| 50 inert packages · launch to workspace ready | 1,905.00 ms | 2,239.00 ms |
| 50 inert packages · contribution snapshot | 49.15 ms | 62.29 ms |
| Five hosts · per-host activation | 894.34 ms | 998.12 ms |
| Five hosts · editor paint | 31.90 ms | 36.00 ms |
| Five hosts · command round trip | 138.95 ms | 164.97 ms |
| Five hosts · total worker working set | 56.02 MiB | 56.13 MiB |
| Five hosts · total launcher working set | 103.02 MiB | 103.11 MiB |

The 50-package discovery p95 met the 200 ms SSD target. The five active hosts used about 159 MiB of combined median worker and launcher working sets in the command fixture. Hosted Windows measured activations of 847, 339, 324, 333, and 325 ms during the mixed-extension lifecycle scenario. [Windows CI](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/42988060217)

## Gate decision

G9 passed on 2026-11-11. The exact implementation passed 118 core tests, 74 desktop tests, and 17 host and runtime tests on Windows Server 2025 x64 build 26100. Local Windows 11 x64 build 26300 passed 33 broker tests, all four Continuum tests, all 17 host and runtime tests, and all 70 benchmark checks. The reviewed package, consent, isolation, recovery, and performance checks left no critical blocker open. Phase 4 is complete. [Phase 4 ledger](PHASE4_STATUS.json) · [Windows CI](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/42988060217)
