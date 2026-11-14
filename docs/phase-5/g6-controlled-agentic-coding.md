# Phase 5 G6 — Controlled Agentic Coding

On Windows x64, run `npm run build` and launch `npx electron . --enable-intelligence`. Open a workspace with Node.js tests, attach the source you want Intelligence to consider, and choose the OpenAI model. Enter the coding goal and choose **Plan coding task**.

1. Review the plan and its attachment scope. Choose **Run baseline tests**, then approve the execution dialog. Tests use the files on disk. Save or discard existing workspace drafts first.
2. If tests fail on a verified workspace revision, choose **Review proposal request**. The outbound review includes the goal, the selected sources, and observed test counts. CEVRA checks the baseline evidence again before sending. Test output and failure text stay local.
3. Open **Review Intelligence edit** in the workbench. **Apply as Drafts** creates the approved drafts with per-file Undo. Save them using CEVRA’s normal Save command.
4. Choose **Verify saved changes** and approve the second run. CEVRA checks that the approved bytes are on disk and reports the runner’s observed outcome. A passing result requires a nonempty suite and current revision evidence.

The task has up to three steps, a 15-minute lifetime, and a three-minute deadline per test step including approval. The broker exposes the existing project-test operation and a single scoped patch proposal. Tests run with the current Windows account’s permissions. The model supplies replacement text for approved targets. It has no shell, arbitrary network, Git, or test-command selection capability.

**Stop coding task** cancels pending approval, provider work, and the supervised test process tree. Closing the panel, switching workspaces, losing a renderer, or revoking the OpenAI connection also ends the task. Committed drafts retain normal Undo and crash recovery. The task and its permissions stay in memory and are cleared on restart. This workflow is available in the Electron preview.

## Verification

`npm test` covers bounded steps, stale evidence, late results after cancellation, and the Windows workflow. The desktop fixtures use the real Node.js runner and a synthetic provider stream. They verify separate approvals, test-output privacy, exact saved bytes, a failed baseline followed by a passing rerun, and termination of a detached child after Stop.

On 2026-11-14, hosted Windows Server 2025 x64 build 26100 passed 152 core, 82 desktop, and 17 extension-host tests. The Windows credential account isolation check also passed. [Windows verification](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43551408808)
