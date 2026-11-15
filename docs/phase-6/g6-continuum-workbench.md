# G6 Continuum tools in one workbench

VOKRI Code keeps run activity in the bottom-panel header while you use the terminal, Flightpath, Tasks, Recipes, Failure Lens, or Change Lens. Select the run's status to reopen its output or the debugger. While shells are active, the adjacent shell count returns focus to the current terminal. The panel can still collapse or float.

The activity label identifies the operation and shows starting, running, paused, succeeded, failed, and canceled states. Test passes with changed or unverified inputs display their evidence status. A suite with only skipped or previously cached passes counts as unverified for that attempt, and Flightpath records that it produced no passing tests. Change Lens uses the independently verified full test result when checking staged bytes.

A successful save waits for the matching draft backup to clear before announcing completion. This lets verification start immediately after the save confirmation. If the write succeeds and the backup update fails, the editor reports both outcomes.

## Phase 3 workflow review

| Phase 3 workflow | Electron workbench and verification |
| --- | --- |
| Visual terminal | Windows ConPTY sessions support PowerShell and Command Prompt, independent state, Unicode, selection and clipboard, resizing, and 2,000 lines of scrollback per shell. The toolbar shows the workspace trust state before opening a shell. Desktop tests exercise Ctrl+C, explicit close, consent, revocation, workspace switch, and process cleanup after the Electron main process is killed. |
| Runtime Fabric | JavaScript and bundled TypeScript run from the workspace. Python uses a reviewed executable or a selected virtual environment. Tests exercise TypeScript source mapping, unavailable runtime selection, and supervised Python cancellation. |
| Runtime error navigation | JavaScript, TypeScript, and Python check candidate source files against a bounded snapshot from before execution. A verified link opens the recorded line and column from the same source revision. For a changed or unobserved file, the output shows the reported location and says that the revision is unavailable. If a verified source changes after execution, invoking the link warns and leaves the editor in place. |
| Test Workstreams | Run a named workstream, follow test failures, retry failures, and check whether inputs still match the recorded revision. Passing evidence becomes historical after edits or changed disk inputs. Skipped-only runs do not supply a passing revision. |
| Failure Lens | Debug JavaScript at a breakpoint, inspect variables, step, restart, stop, and reopen a verified frame. Tests cover detached children and saved source references. The active debugger state appears beside the tool tabs when a different tool is selected. |
| Task Weave and Recipes | Preview the dependency order or named steps before approving execution. Existing checks cover stale manifests, guard clauses between steps, a stopped process tree, and withheld subsequent actions after a failure. |
| Flightpath | Opt in to bounded local metadata for completed task and test outcomes. After reopening, past passes are historical. A forced app crash preserves saved metadata and backed-up drafts. |
| Change Lens | Review staged and working diffs with line markers and preserved keyboard focus, then explicitly approve staging and commit review. The checked tree is revision-bound, and a recorded pass verifies only matching staged bytes. Existing tests check that intervening changes invalidate review and that unsaved drafts stay outside a commit. |

## Repeat the Windows checks

Run `npm test` on Windows with Git and npm on PATH. The [Continuum replay](../../qa/continuum.test.cjs) reproduces an invoice failure, visits the recorded line, inspects a live breakpoint, fixes the source, marks the old evidence historical, verifies a task graph and passing tests, and commits the exact reviewed bytes. It repeats the workflow with no extensions, enabled contributions, and extension safe start. The fault replay covers a missing runtime, detached-process cancellation, and draft recovery.

The [workbench regression suite](../../qa/workbench.test.cjs) adds stale error navigation, skipped-suite evidence, and terminal revocation and crash checks. The [core suite](../../qa/core.test.cjs) checks revision matching, bounded output, and process cancellation.

A compact Windows smoke check at 160% Electron zoom kept execution activity inside the window, stacked Failure Lens details in one column, and used the keyboard to return to the exact failure line.

The Windows 11 x64 run passed 170 core tests and 101 Electron desktop tests on implementation revision `8959506a83dd842b1a9cfb0afdadcd65d1630460`. The optional native profile-handoff test was skipped. The recorded journeys include timing samples, the two fixture source revisions, and the resulting fixture commits for all three extension modes. [Windows Continuum traces](evidence/g6/windows-continuum.json)

## Gate decision

G6 passed on Electron on 2026-11-15. The Windows Server 2025 reliability workflow passed the same core and desktop suites, Windows credential account separation, 18 extension-host tests, and 13 Intelligence benchmark checks. [Phase 6 status](PHASE6_STATUS.json) · [Windows reliability run](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43737234147)
