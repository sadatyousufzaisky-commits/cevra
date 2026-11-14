# G9 · Windows integration and benchmarking

## Integrated acceptance

Run `npm test` and `npm run test:extension-host` on Windows x64 with Node.js 24. The desktop suite uses real Electron windows, Windows Credential Manager, the supervised Node.js test runner, and temporary workspaces and profiles. Cloud response fixtures intercept the request at the HTTPS transport. Ollama fixtures use real loopback HTTP. The CI workflow also verifies Credential Manager separation between Windows accounts. [Windows workflow](../../.github/workflows/windows-reliability.yml)

| Scenario | Evidence |
| --- | --- |
| End-to-end coding repair | Add a synthetic OpenAI key through the native password dialog. Attach saved source, review the coding plan, approve the baseline, and check that test output stays private. Review the exact outbound request, inspect the proposal, apply drafts, save explicitly, and approve a passing verification run. Disconnect and verify key deletion. Force an app restart and save a recovered draft with Intelligence off and extensions in safe start. |
| Provider and workspace faults | Verify zero sends after canceled approval, stop and timeout of an in-flight stream, revocation, renderer loss, workspace switch, stale inputs, and protection of `.env` and out-of-workspace files. |
| Local routing | Stream a bounded 10 KiB response through the Ollama adapter. Verify that disabling its local-only configuration stops inference and that an explicit new review is required to switch to OpenAI. |
| Privacy and spend | Test a zero estimate limit, durable reservations without confirmed usage, separate rate-limit and quota states, secret-safe error and stream handling, and a metadata-only ledger. |
| Editor and extensions | Re-run saving, execution, diagnostics and error navigation, crash recovery, workspace safety, and the confined extension lifecycle. Exercise active extensions alongside Intelligence. |

The coding repair fixture is synthetic. It verifies editor and provider boundaries with deterministic output. It does not score model quality. [Desktop fixtures](../../qa/intelligence-stream-desktop.test.cjs) · [Confined extension tests](../../qa/extension-runtime.test.cjs)

## Repeat the performance comparison

Build the pinned Phase 4 revision and the current checkout with the same lockfile. The benchmark uses the current checkout's Electron binary for all three modes.

```powershell
$baseline = Join-Path ([IO.Path]::GetTempPath()) ('cevra-phase4-' + [Guid]::NewGuid().ToString('N'))
git worktree add --detach $baseline 4960ef251237583f9ee7a21e067f949dd2f6d4b0
Push-Location -LiteralPath $baseline
npm ci
npm run build
Pop-Location
$env:CEVRA_PHASE5_BASELINE = $baseline
npm run benchmark:intelligence
```

Each mode uses the same generated 49-file project and a fresh Electron process and profile. The three modes are Phase 4, Phase 5 with Intelligence off, and Phase 5 with Intelligence enabled. Run order rotates to reduce order effects. One warm-up per mode is excluded. Filesystem caches remain warm. `CEVRA_PHASE5_SAMPLES` selects 1–30 measured samples per mode and defaults to 20. The runner writes the measurements and revision metadata to `dist/phase5-g9-benchmark.json`. [Benchmark runner](../../qa/intelligence-benchmark.test.cjs)

Startup measures launch through workspace readiness. Editor paint measures keydown through the second animation frame after the editor DOM updates. Working set and cumulative CPU time are the sum reported by Electron for its processes at the post-edit checkpoint. Working sets may include shared memory. The opt-in panel records opening time and first mock text on the next animation frame, with raw and 120 ms delay-adjusted values. The delay-adjusted number includes scheduling overhead. p50 is the median and p95 uses nearest rank.

## Measured results

Two local runs on 2026-11-14 each measured 20 samples per mode. The machine ran Windows 11 x64 build 26300 on an Intel Core i5-1135G7 with 7,835 MiB of usable RAM. Both revisions used Electron 45.2.3 with bundled Node.js 24.22.2. The runner used Node.js 24.15.0. [Raw measurements for both runs](g9-benchmark-windows-26300.json)

| Metric | Phase 4 p50 / p95 | Phase 5 off p50 / p95 | Phase 5 enabled p50 / p95 |
| --- | ---: | ---: | ---: |
| Startup | 712 / 782 ms | 703 / 783 ms | 722 / 812 ms |
| Editor paint | 21.35 / 30.30 ms | 25.35 / 39.70 ms | 21.65 / 33.90 ms |
| Working set before opening panel | 417.04 / 423.47 MiB | 413.66 / 420.86 MiB | 426.35 / 429.49 MiB |
| Cumulative CPU before opening panel | 1.88 / 1.96 s | 1.86 / 1.92 s | 1.87 / 2.00 s |

The table shows the first run. In the second, Phase 4 and Phase 5 off had nearly identical median startup at 710 and 713 ms. Phase 5 off had a higher startup p95 of 974 ms versus 777 ms for Phase 4. Its editor-paint p95 moved in the opposite direction at 30.20 ms versus 33.40 ms. The two runs show similar median startup and variable tail latency on this machine.

With Intelligence enabled, the mock first-text p95 was 144.30 and 145.60 ms across the two runs, or 24.30 and 25.60 ms after subtracting the scripted delay. Both runs met the proposed 200 ms delay-adjusted target. The combined median Electron working set with the panel open was about 569 MiB in both runs. These results apply to the measured fixture and machine.

Windows Server 2025 x64 build 26100 independently reproduced the benchmark with three measured samples per mode. Median startup was 533 ms for Phase 4, 535 ms with Intelligence off, and 545 ms with it enabled. The delay-adjusted mock first-text p95 was 16.90 ms. With three samples, p95 is the largest observation in each mode. [Windows benchmark log](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43573565167/job/132382868611)

## Dependency and boundary review

`npm audit` and `npm audit --omit=dev` reported zero findings on 2026-11-14. Review of upstream advisories checked the pinned Electron 45.2.3 and Wasmtime 36.0.20 release ranges. The Windows build verifies the Zig and Wasmtime archive hashes and the extracted compiler and runtime binary hashes. The worker accepts core Wasm through its scoped broker and the hosted suite tests the Windows confinement boundary. [Electron advisories](https://github.com/electron/electron/security/advisories) · [Wasmtime advisories](https://github.com/bytecodealliance/wasmtime/security/advisories) · [Build pins](../../scripts/build-extension-host.cjs)

The manual boundary review covered the Intelligence preload and sender checks, exact-request approval, provider destination and logging guards, revocation, cost admission and ledger contents, and test and draft authority. Each external send requires its own review. Workbench trust, sending text, applying drafts, and running tests grant distinct authority. [Threat model](g0-architecture.md) · [G8 hardening](g8-privacy-costs-and-hardening.md)

## Preview scope and opt-in smoke tests

CEVRA Intelligence is an opt-in Windows x64 preview in the Electron workbench. GPT-5.6 Terra uses a user-owned OpenAI API project key and provider billing. Anthropic and Gemini have credential slots only. OpenAI documents a separate OAuth flow for eligible open-source clients using ChatGPT plans. CEVRA has no subscription integration in this preview. Existing profiles need no migration for G9. [OpenAI project keys](https://developers.openai.com/api/docs/guides/api-keys) · [OpenAI plan authorization](https://developers.openai.com/siwc/token-sharing-open-source)

For an optional live check, start `npx electron . --enable-intelligence` after a build. Use a disposable workspace and a short synthetic prompt. Add your own project key in **Provider connections**, select GPT-5.6 Terra, inspect the endpoint, messages and estimate, and approve one send. Confirm the stream completes, check provider usage if reported, and disconnect the key. The send can incur an API charge. CI uses fixtures and requires no credentials. For a local smoke test, follow the Ollama guide with a local-only service and an installed model. [Local connection guide](g7-model-routing-and-offline.md)

## Gate decision

G9 passed on 2026-11-14 for the opt-in Windows preview. The verified implementation passed 163 core, 84 desktop, and 18 extension-host tests in hosted Windows, plus credential account separation and 13 benchmark checks. Two local benchmark runs passed 64 checks each. Provider verification used fixtures. Live OpenAI access and inference with an installed Ollama model remain opt-in checks. Phase 5 implementation is complete within the preview scope recorded in the ledger. [Phase 5 ledger](PHASE5_STATUS.json) · [Windows CI](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43573565167)
