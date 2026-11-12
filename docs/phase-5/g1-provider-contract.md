# Phase 5 G1 — Provider abstraction and capability registry

## Run the offline preview

```powershell
npm ci
npm run build
npx electron . --enable-intelligence-mock
```

Open **Intelligence** in the workbench status bar. Choose **Deterministic mock**, enter a prompt, and press **Send**. The panel streams a fixed response and shows simulated token totals. **Stop** cancels the current request. **Retry** starts a fresh request for the last submitted prompt. Closing the panel or switching workspaces clears its session. Normal startup leaves Intelligence off.

The preview has a dedicated sandboxed window and preload. Main checks its top-level sender for every provider operation. The workbench can open the preview. The preview receives its model catalog and prompt-only stream through narrow IPC methods. Its renderer pulls one event at a time, and the controller permits one active request and one pending pull. The mock receives only the entered prompt, uses no network, and keeps prompts and responses in memory for the window lifetime. [Main-process window](../../src/intelligence/mock-window.cjs) · [Mock adapter](../../src/intelligence/providers/mock.cjs)

## Provider ABI 0.1

The first-party registry accepts trusted adapters with a capability catalog and an asynchronous `stream(request, signal)` function. Catalogs advertise provider identity, label, provenance, and model limits. Model IDs belong to their provider. The caller explicitly selects both IDs. The registry snapshots catalog and request records before use and rejects duplicate IDs, unsupported versions, and model limits outside the contract. [Registry](../../src/intelligence/provider-registry.cjs) · [TypeScript declarations](../../src/intelligence/provider-registry.d.cts)

| Contract item | Validation |
| --- | --- |
| Request | Exact fields `abiVersion`, `requestId`, `providerId`, `modelId`, `messages`, and `maxOutputTokens`. A request ID has 1–64 ASCII letters, digits, or hyphens. Messages have `role` and `content`, with a nonblank final user message. |
| Catalog | Up to 32 unique models per provider. Each has `id`, `label`, `maxInputBytes`, `maxOutputTokens`, `streaming: true`, and `toolProposals: false`. ABI 0.1 supports text streams. |
| Input limits | Up to 16 messages and 64 KiB of UTF-8 message content. Model limits can be lower. The mock allows 8 KiB of input and up to 128 requested output tokens. |
| Text and usage | Zero or more `text.delta` events, then optional `usage` with integer input and output token totals. Output usage must be within the requested token limit. A missing usage event leaves usage unknown. |
| Terminal event | `complete` with `finishReason` of `stop` or `length`, or a typed `error` with an allowlisted code and retry flag. The first terminal event ends the stream. Every event carries the active request ID. |
| Stream limits | At most 256 events including the terminal event, 4 KiB of UTF-8 per delta, 64 KiB total output, and a deadline of up to 15 seconds. Invalid, misordered, excessive, and unterminated streams fail with a fixed error. |

Validation occurs before adapter invocation. The registry serializes pulls, closes the upstream iterator on termination, and propagates abort. It settles a stalled pull when cancellation or its deadline fires, even if an adapter fails to cooperate. Production transports will also need to release their underlying sockets on abort. Adapter exceptions and invalid frames surface fixed codes and messages. Retries use a new request ID and an explicit user action. [Runtime validation](../../src/intelligence/provider-contract.cjs)

This slice accepts prompt-only input in the preview. The ABI covers text, usage, terminal failures, and cancellation. Context disclosure and action proposals belong to later gates. G2 is the credential vault and connection lifecycle gate. G3 adds the production conversation and streaming workflow. [Phase 5 ledger](PHASE5_STATUS.json)

## Verification

`node --test qa/intelligence-provider.test.cjs` checks deterministic text and usage, provider-neutral routing, immutable catalog snapshots, TypeScript declarations, invalid requests and events, retry, deadlines, and cancellation. It asserts the mock opens no HTTP or TCP connection. `node --test qa/intelligence-mock-desktop.test.cjs` after a build checks default-off behavior, the real Electron preview, stop and retry, workspace isolation, and absence of browser network requests. Both run through `npm test` on Windows. The existing extension-host suite remains in Windows CI.

On 2026-11-12, implementation `8b43b3035b53286e50537af8b218188c4fc4f06b` passed 129 core, 76 desktop, and 17 extension-host tests on local Windows 11 x64 build 26300 and hosted Windows Server 2025 x64 build 26100. [Windows verification](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43145513825)
