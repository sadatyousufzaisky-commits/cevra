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

## Dependency and boundary review

`npm audit` and `npm audit --omit=dev` reported zero findings on 2026-11-14. Review of upstream advisories checked the pinned Electron 45.2.3 and Wasmtime 36.0.20 release ranges. The Windows build verifies the Zig and Wasmtime archive hashes and the extracted compiler and runtime binary hashes. The worker accepts core Wasm through its scoped broker and the hosted suite tests the Windows confinement boundary. [Electron advisories](https://github.com/electron/electron/security/advisories) · [Wasmtime advisories](https://github.com/bytecodealliance/wasmtime/security/advisories) · [Build pins](../../scripts/build-extension-host.cjs)

The manual boundary review covered the Intelligence preload and sender checks, exact-request approval, provider destination and logging guards, revocation, cost admission and ledger contents, and test and draft authority. Each external send requires its own review. Workbench trust, sending text, applying drafts, and running tests grant distinct authority. [Threat model](g0-architecture.md) · [G8 hardening](g8-privacy-costs-and-hardening.md)

## Preview scope and opt-in smoke tests

CEVRA Intelligence is an opt-in Windows x64 preview in the Electron workbench. GPT-5.6 Terra uses a user-owned OpenAI API project key and provider billing. Anthropic and Gemini have credential slots only. OpenAI documents a separate OAuth flow for eligible open-source clients using ChatGPT plans. CEVRA has no subscription integration in this preview. Existing profiles need no migration for G9. [OpenAI project keys](https://developers.openai.com/api/docs/guides/api-keys) · [OpenAI plan authorization](https://developers.openai.com/siwc/token-sharing-open-source)

For an optional live check, start `npx electron . --enable-intelligence` after a build. Use a disposable workspace and a short synthetic prompt. Add your own project key in **Provider connections**, select GPT-5.6 Terra, inspect the endpoint, messages and estimate, and approve one send. Confirm the stream completes, check provider usage if reported, and disconnect the key. The send can incur an API charge. CI uses fixtures and requires no credentials. For a local smoke test, follow the Ollama guide with a local-only service and an installed model. [Local connection guide](g7-model-routing-and-offline.md)
