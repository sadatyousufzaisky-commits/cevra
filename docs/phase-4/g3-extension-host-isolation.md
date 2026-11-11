# Phase 4 G3 — Extension host isolation

Run `npm run test:extension-host` on Windows x64 with Node.js 24 and the .NET Framework compiler used by CEVRA's existing process host. The build verifies pinned Zig 0.15.2 and Wasmtime 36.0.20 downloads by SHA-256 and builds the launcher, worker, and native test probe under `dist`. This record covers the one-shot G3 isolation tests. The confined host also supports executable extensions through the G5 broker. [G5 capability broker](g5-capability-broker.md) · [Wasmtime C API](https://docs.wasmtime.dev/c-api/) · [Wasmtime release](https://github.com/bytecodealliance/wasmtime/releases/tag/v36.0.20) · [Zig release](https://ziglang.org/download/0.15.2/release-notes.html)

## Process boundary

The launcher creates a temporary Less Privileged AppContainer with zero optional capabilities. It starts the worker suspended with child process creation restricted, a fixed environment, and an explicit standard-handle list. It grants the per-instance SID read and execute rights to the staged worker and its runtime. Before resuming, it verifies job membership, the AppContainer token and capability count, and denies a read of a file granted to ordinary AppContainers while permitting a read of the worker binary. Setup failures abort the launch. [Microsoft AppContainer launch](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) · [Process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)

The Windows job enforces one process, a 256 MiB process memory limit, kill on close, and UI restrictions covering clipboard data and other processes' UI handles. The prebuilt Wasmtime runtime requires Windows DLL initialization, so this prototype uses the verified job UI policy for clipboard and handle restrictions. The launcher monitors the owner and closes the job before removing the staged files and temporary profile. Forced termination of the launcher itself closes its job. A forced launcher kill can leave temporary files or the profile behind. [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) · [Job UI restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_ui_restrictions)

## Guest and protocol limits

The worker accepts one core Wasm module and calls its `run() -> i32` export. The runtime rejects imports, disables Wasm threads and components, and caps fuel, linear memory, and tables. The supervisor uses a versioned greeting and heartbeat, with one pending request at a time. It limits requests to 256 KiB, response frames to 1 KiB, and diagnostics to 8 KiB. A timeout, protocol error, or diagnostic flood stops the job. A module result is accepted after the worker exits cleanly. [Wasmtime resource limits](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html)

## Acceptance evidence

- An ordinary native control can reach the disposable filesystem, environment, loopback and non-loopback listener, subprocess, and process-handle fixtures. The same probe under the launcher is denied each operation.
- The native probe verifies the active job UI policy on Windows. The hosted job also seeds and checks a synthetic clipboard value on its disposable runner.
- The guest tests cover a successful module and heartbeat, unsupported imports, an invalid module, excessive memory, and fuel exhaustion.
- The supervisor tests cover a hang before and after replying, malformed frames, diagnostic floods, a worker crash, explicit cancellation, and forced owner exit. The desktop test verifies that a real backed-up editor draft survives a host crash and CEVRA restart.

The verified platform scope is recorded in the phase ledger. Executable support on additional Windows versions or architectures requires the same evidence on those targets.
