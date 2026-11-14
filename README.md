# PROJECT CEVRA

CEVRA is a public project building a desktop environment for the whole software development workflow. It connects editing, execution, and error navigation in one workbench. The desktop benchmark measures these workflows in CEVRA and can run the same fixture in VS Code.

## Run the workbench

On Windows 10 or 11 with Node.js 24, npm, and the Windows .NET Framework 4.x compiler, run these commands in the repository:

```powershell
npm ci
npm start
```

Choose **Open example** to try the built-in JavaScript project, or choose **Open folder** to browse an existing project. The example includes a commented-out error you can enable to try source navigation.

- **Ctrl+S** saves the active file. The editor accepts UTF-8 text files up to 2 MiB.
- **Ctrl+Shift+S** saves all open drafts. CEVRA reports where the save stopped if a file fails its revision check.
- **F5** saves the active file and runs it from the project root. CEVRA supports JavaScript, TypeScript, and Python entry files. Other files on disk are read as saved.
- **Stop** cancels a run during preparation or execution. Its recent output remains visible in the run panel, with a notice when earlier output was truncated.
- **Source location** takes you to the first project location CEVRA finds in a failed run's error output.

The workbench uses Electron for the desktop shell and CodeMirror for the editor. CEVRA owns the project explorer, file state, and run workflow. Before the first file or test run in an untrusted workspace, choose **Run Once**, **Trust Workspace**, or **Cancel**. CEVRA asks before saving or running code. Programs execute with your user account's permissions. Workspace trust is stored locally and can be revoked in **Settings**.

On Windows, CEVRA starts programs and tests inside a Job Object and waits for the process tree to stop before releasing its execution session. This covers detached children after a script exits and cleanup after the app's main process dies. Finish or cancel the active run before switching workspaces. [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

## Try CEVRA Intelligence

On Windows x64, build CEVRA and launch the opt-in Intelligence preview.

```powershell
npm run build
npx electron . --enable-intelligence
```

Open **Intelligence** in the status bar. The deterministic mock runs offline. To try OpenAI, add your own API project key in **Provider connections**, select **GPT-5.6 Terra**, and review the exact conversation before sending. OpenAI API charges may apply. [Conversation and streaming guide](docs/phase-5/g3-conversation-streaming.md)

Select code in the editor and choose **Attach selection to Intelligence** to include that range, including unsaved edits. You can also attach saved files and explicitly include `.cevra/ai-instructions.md`. Open **Response preferences** to set language, length, code style, and testing preferences. [Context and personalization guide](docs/phase-5/g4-context-and-personalization.md)

Choose **Propose edits** to request a change to attached code. Use **Review Intelligence edit** to inspect the diff. **Apply as Drafts** creates undoable edits. Use the editor’s normal **Save** command to update the original files. [Patch review guide](docs/phase-5/g5-editor-actions-and-patch-review.md)

Choose **Plan coding task** to review a test-and-fix plan. Intelligence uses the supervised Node.js runner to establish a baseline, offers one reviewed patch if tests fail, and can verify the exact saved changes. Each test run requires separate approval. [Coding task guide](docs/phase-5/g6-controlled-agentic-coding.md)

## Run TypeScript and Python

**TypeScript** `.ts`, `.mts`, and `.cts` entry files run through the bundled Node.js runtime. The direct profile uses Node's TypeScript transform and source maps. Use **Problems** for type checking and **Tasks** for project-specific builds, including TSX and projects that need `tsconfig.json` compilation settings. TypeScript imports in direct runs use explicit file extensions. [Node.js TypeScript support](https://nodejs.org/docs/latest-v24.x/api/typescript.html)

**Python** `.py` entry files use the interpreter you choose in **Run output**. CEVRA lists Python executables from workspace `.venv` and `venv` directories and from PATH. **Choose Python executable** lets you select a different Python 3 installation. The selection applies to the open workspace. Use **Refresh interpreters** and choose again after replacing or rebuilding the selected environment. [Python virtual environments](https://docs.python.org/3/library/venv.html)

TypeScript errors and Python tracebacks link to the recorded source when CEVRA can confirm its revision. An edited source requires a new run before you can use the link. **Stop run** uses the same process-tree cleanup for all three languages.

## Debug JavaScript with Failure Lens

Click the breakpoint gutter beside a JavaScript line or press **F9** at the cursor. Open **Failure Lens** and choose **Debug file**, or press **F6** from the editor. CEVRA asks for workspace execution permission, saves open drafts, then pauses the bundled Node.js runtime at entry. Choose **Continue** or press **F5** to run to the next breakpoint. Breakpoints can be enabled, disabled, or removed between sessions. They stay in memory for the open workspace.

Use **Pause**, **Step into**, **Step over**, and **Step out** to inspect code. Select a stack frame to inspect its local variables and navigate to its recorded source when CEVRA can verify the revision. **Restart debugger** starts the original entry file again. **Stop debugging** ends the supervised process tree. [Node.js debugger](https://nodejs.org/docs/latest-v24.x/api/debugger.html)

Failure Lens pauses on uncaught JavaScript exceptions and keeps their stack and recent output after exit. Variable previews are available during a pause. It also shows recorded output and source locations from regular runs. Debug sessions in this release launch `.js`, `.mjs`, and `.cjs` files.

## Use the integrated terminal

Choose **Terminal** in the bottom panel or press **Ctrl+Backtick**. Select **PowerShell** or **Command Prompt**, then choose **New terminal**. Each shell starts in the workspace folder and has its own environment and output. You can keep up to four sessions open and switch between them while commands run. The shell resizes with the panel. Use **Copy** and **Paste** or **Ctrl+Shift+C** and **Ctrl+Shift+V**.

Opening a shell uses the same workspace trust prompt as running code. **Close terminal** ends its process tree. CEVRA asks before closing active terminals on a workspace switch and also closes them if the renderer crashes. Scrollback holds up to 2,000 lines in memory per session. The built-in PowerShell profile starts without loading user profiles and disables PSReadLine history saves for the session. The terminal requires the Windows pseudoconsole API available from Windows 10 version 1809. Command Prompt starts in local folders. Use PowerShell for UNC paths. [Windows pseudoconsole sessions](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)

## Run project tests

**Run tests** (Ctrl+Alt+T) saves open edits and uses Node's built-in test runner to discover JavaScript test files in the project. Click a failure to jump to its assertion or error location. The output pane keeps error details alongside the failure list.

After a failure, **Rerun failures** saves edits and retries tests that have yet to pass in the current run sequence. The summary reports previous passes separately. **Run tests** starts a fresh sequence for the entire suite.

The built-in example includes a failing test for fractional weights. In `total.cjs`, replace `Math.floor(weight)` with `weight` and choose **Rerun failures** to check the fix.

### Track a test workstream

Expand **Run output** and enter a **Workstream** goal, then choose **Run tests**. The result records the goal, a unique attempt ID, the observed workspace revision, and the outcome. A failure opens its recorded line only if the source revision still matches. Editing a buffer marks the result **Historical** immediately. **Check inputs** and returning focus to CEVRA recheck the workspace on disk.

A recipe test uses the current Workstream goal when the step leaves its own `goal` unset. **End Workstream** clears the active goal while preserving the recorded result and any retained Run Capsules.

The latest result stays available in **Test results** for the open workspace. CEVRA compares snapshots of supported workspace files before and after the run. The scan includes source, configuration, and binary files and is bounded to 256 files and 16 MiB, with a 2 MiB per-file limit. It excludes dependency and cache directories and version-control data. Unreadable inputs, unsafe links, and scan limits make the workspace revision unavailable. The observation covers those snapshots. The runner still executes against the live workspace, where code can also read external inputs. A retry records the new attempt and keeps previously passed tests separate in the totals.

### Keep a local Flightpath

Open **Flightpath** in the bottom panel and select **Enable local history** for the workspace. Each completed test attempt or task step adds a **Run Capsule** with its outcome, revision fingerprint when available, duration, exit code, and timestamp. Task capsules also record the task ID. The journal keeps the latest 64 results for that workspace on this device. It stores structured metadata. Goals, source, command arguments, environment variables, and raw output stay out of the journal.

Earlier attempts with complete revision observations and entries reopened after a restart appear as **Historical**. Incomplete observations show **Revision unavailable**. A successful retry is labeled separately from a full test run. **Clear history** removes saved attempts and leaves retention on. **Turn off and clear** removes them and stops future recording. Both actions exclude in-progress attempts from saved history.

## Run builds and tasks

Open **Tasks**, choose a script from the root `package.json`, review the command, and select **Run task**. CEVRA discovers scripts by reading the manifest and starts the chosen script only after workspace execution is authorized. Use **Refresh tasks** after changing the manifest. The runner uses the installed npm CLI with implicit pre- and post-scripts disabled. It runs from the workspace root and saves open drafts before starting. If saving changes the previewed manifest or graph, refresh and review the new plan before running it.

Add an optional `.cevra-tasks.json` at the workspace root to define dependency graphs. Each `profile` names a script in `package.json`. For example, choose `verify` to run `compile` before the `test` script.

```json
{
  "schemaVersion": 1,
  "outputs": ["dist"],
  "tasks": [
    { "id": "compile", "profile": "build", "after": [] },
    { "id": "verify", "profile": "test", "after": ["compile"] }
  ]
}
```

Task Weave validates all dependencies before launch, runs each prerequisite once, and checks the manifest and graph again before each step. A failed dependency blocks its dependents by default. Set `"continueOnFailure": true` on a dependent to let it run after a failed prerequisite. **Stop run** ends the active process tree and blocks later steps. **Task output** shows each step’s status and recent output. Recognized JavaScript and TypeScript diagnostics can link to the recorded source revision.

Declare generated folders in `outputs` to exclude them from task revision checks. CEVRA still checks the manifest, graph, and other observed workspace inputs. With Flightpath enabled, each step records its outcome, including failures, cancellations, and blocked steps.

## Save and run workspace recipes

Open **Recipes** in the bottom panel and choose **Create recipe file** to add a starter `.cevra-recipes.json` to the workspace root. Edit and save the file, choose **Refresh recipes**, then select a recipe to see the ordered steps, resolved task commands, and runtime. Share the file with your project when the workflow applies to other contributors.

```json
{
  "schemaVersion": 2,
  "recipes": [
    {
      "id": "verify",
      "name": "Build and verify",
      "steps": [
        { "kind": "task", "target": "npm:build" },
        { "kind": "test", "goal": "Verify the project" }
      ]
    }
  ]
}
```

- **Task** accepts `npm:<script>` for a package script or `dag:<id>` for a Task Weave graph.
- **Test** runs the full JavaScript test suite and requires at least one passing test.
- **Run** accepts a workspace-relative `file` for JavaScript, TypeScript, or Python. Python requires a `profile` of `.venv`, `venv`, or `path`, resolved to a discovered interpreter.
- **Debug** opens Failure Lens for a workspace-relative JavaScript `file` and must be the only step in its recipe.

Each recipe supports one to eight steps. Opening a workspace or reviewing a plan never starts execution. **Run recipe** asks for native confirmation even in a trusted workspace. After confirmation, CEVRA saves open files and rechecks the recipe, referenced task configuration, and Python interpreter identity. A changed plan requires a fresh review. Steps use the latest saved source, run in order, and stop the pipeline on failure or cancellation. **Recipe output** shows each step's result.

Workspace trust is local to this device and bound to the selected directory. Revoke it from **Recipes** or **Settings**. Earlier trust records require fresh consent. Version 1 recipes can be reviewed and run as single steps. **Upgrade recipe file** converts them to version 2 after checking that the file still matches the reviewed revision. Keep credentials out of the recipe file.

## Review and commit with Change Lens

Open the repository root as a workspace, then select **Change Lens**. With Git on PATH, CEVRA shows the current branch, recent local commits, and separate lists of staged and working changes. Select a file to preview its diff. **Stage file** checks the reviewed disk contents before updating the index. **Unstage file** changes the index and keeps the working copy. Save a file's open draft before staging it.

Run the full test suite to compare its observed workspace inputs with the staged paths and blob bytes. Change Lens labels different snapshots **Historical**. The comparison is byte-for-byte, so Git line-ending conversion and files present only in the working directory can affect it. Review the staged diff and enter a message before choosing **Commit staged changes**. The confirmation names the branch and warns about unsaved drafts. CEVRA commits the reviewed tree and keeps working changes and drafts outside it.

**Create branch** creates a local branch at the current commit. **Switch branch** requires a clean working tree and saved drafts, then reopens the checkout. Change Lens writes unsigned local commits using Git's configured author identity. Linked worktrees can be reviewed in read-only mode. Git hooks and external filters are kept out of Change Lens actions. [Git status](https://git-scm.com/docs/git-status) and [Git commit objects](https://git-scm.com/docs/git-commit-tree)

## Search and navigate

- **Ctrl+F** finds and replaces text in the current file. Use the case, whole-word, and regular-expression options to narrow a search. Replacements can be undone in the editor.
- **Ctrl+Shift+F** searches the project for literal text with an optional **Match case** setting. Open drafts take precedence over their disk copies. Click a result to select the exact match, or choose **Cancel** to stop a search.
- **Alt+Left** and **Alt+Right** return to the previous or next position after a jump from search, a runtime error, or a test failure.

Project search shows up to 400 matches and skips binary, unreadable, or oversized files. It excludes version-control directories and common dependency caches. If a file changes on disk after the search, CEVRA checks its revision before opening the result.

## Preview edits across files

In project search, enter a replacement and choose **Preview Replace**. The preview groups before-and-after edits by file, identifies unsaved buffers, and reports skipped entries. Narrow capped searches before previewing. An empty replacement deletes the matched text.

Press **F2** on a JavaScript or TypeScript identifier, or choose **Rename Symbol** in **References**. Enter a new identifier and choose **Preview Rename**. CEVRA uses language analysis to find static references and rechecks the scope before applying. Rename requires a single readable workspace project. It refuses ambiguous edits, incomplete analysis, or a proposed name already used in the analyzed source. Runtime-computed names and external consumers are outside the analysis scope.

**Apply as Drafts** checks all original revisions and records the batch as one recoverable operation. Changes open in tabs with per-file undo. Use **Ctrl+S** to save individually or **Ctrl+Shift+S** to save all. A changed or missing original blocks applying the batch. CEVRA preserves the BOM and line-ending style and asks you to normalize mixed line endings before a batch edit.

## Check syntax and types while editing

Open **Problems** with **Ctrl+Shift+M**. CEVRA checks open JavaScript and TypeScript buffers, including JSX and TSX, and marks syntax errors inline and in the gutter. Click a problem to select its source range. The panel clears outdated findings while it checks the latest edits. **Retry checks** is available if an analysis fails.

**Type checking** shows a separate set of issues for the active TypeScript file, including errors that reflect unsaved imports. Enable JavaScript type checking with a leading `// @ts-check` comment or `"checkJs": true` in the nearest project configuration. Click a type problem to jump to its range. Runtime failures appear in **Run output**.

## Format a document

Press **Shift+Alt+F** or select **Format document** to format the active JavaScript or TypeScript buffer, including JSX and TSX. CEVRA applies its own indentation, spacing, and block layout rules and checks that the edited source parses to the same structure. Formatting is one undo step. Save when you want to write the result to disk.

Put a `.cevra-format.json` file in the workspace or a subfolder to set formatting rules. CEVRA uses the nearest configuration within the workspace. Omitted keys use these defaults.

```json
{
  "indentStyle": "spaces",
  "indentWidth": 2,
  "bracketSpacing": true,
  "finalNewline": true,
  "lineEnding": "preserve"
}
```

Use `"tabs"` for tab indentation. Set `lineEnding` to `"lf"`, `"crlf"`, or `"cr"` to change the document's line endings as part of formatting. The formatter preserves existing punctuation, comments, and literal contents, including the contents of JSX and templates.

## Inspect a symbol

Hover over a JavaScript or TypeScript name, or place the cursor on it and press **Ctrl+Alt+I**. CEVRA shows the symbol's type or signature and any available documentation. It follows workspace imports on demand and gives unsaved buffers priority over disk copies.

The bridge uses selected compiler options from the nearest `tsconfig.json` or `jsconfig.json`, including workspace-local import aliases. This first slice follows the active file's import graph within the workspace and uses bundled TypeScript library declarations. It skips dependency directories, configuration inheritance, project references, and language-service plugins.

## Complete JavaScript and TypeScript

Type after `object.` or press **Ctrl+Space** to request suggestions at the cursor. CEVRA shows the kind of each suggestion and uses unsaved workspace imports when resolving members and named exports. It also suggests values for supported typed contexts, such as a string literal argument with a fixed set of allowed values.

Use **Up** and **Down** to select an option, **Enter** to accept it, or **Escape** to dismiss the list. Accepting a symbol completion edits the active buffer in one undo step. Suggestions use the same local import graph as symbol inspection.

## See function parameters as you type

Type `(` after a JavaScript or TypeScript function name, or move the cursor inside an existing call. Signature help highlights the current parameter and shows its documentation when available. It follows nested calls, selects the overload that matches the current arguments, and uses unsaved changes in imported workspace files.

Press **Ctrl+Shift+Space** to request signature help at the cursor or **Escape** to dismiss it.

## Go to a definition

Place the cursor on a JavaScript or TypeScript symbol and press **F12**, or select **Go to Definition** in the status bar. CEVRA follows workspace imports and re-exports to the declaration and uses open drafts when finding the target. If a symbol has several declarations, choose a destination from the list.

Use **Alt+Left** to return to the original selection and **Alt+Right** to revisit the definition. CEVRA checks the target revision before opening it.

## Find references to a symbol

Press **Shift+F12** on a JavaScript or TypeScript symbol, or choose **Find References** in the **References** panel. Results include declarations and uses in closed source files and open drafts. Select a result to jump to the exact range, or choose **Cancel** while the search runs. Source edits invalidate the results, and CEVRA checks each destination before opening it.

Discovery starts in the nearest `tsconfig.json` or `jsconfig.json` folder, or at the workspace root when there is no config. It skips separately configured subtrees, dependency caches, and links, and follows supported imports through the language bridge. The panel reports when the 256-file discovery or 400-result limit is reached.

## Go to a symbol

Press **Ctrl+T** or use **Go to Symbol** in the title bar. Search for a JavaScript or TypeScript declaration by name, then use the arrow keys and **Enter** to jump to it. Each result shows its kind, containing declaration when available, and file. The search includes closed files and open drafts across the workspace, and checks the target before opening it. It searches up to 256 source files and displays the first 80 matches.

## Make room to edit

Press **Ctrl+B** to show or hide the Explorer and **Ctrl+J** to toggle the bottom panel. The bottom panel starts collapsed and opens when you run code or open a tool such as Problems. Drag its top edge or focus the resize handle and use **Up** or **Down** to adjust its height.

The editor shows the current file path and indentation guides. **Tab** and **Shift+Tab** indent and outdent JavaScript and TypeScript lines. Press **Escape** and then **Tab** to move focus out of the editor.

## Customize the editor

Use **Theme** in the status bar to choose **CEVRA Dark**, **CEVRA Light**, or **System**. System follows the operating system's app color mode. The theme applies to the workbench, editor, and window controls. CEVRA remembers it across projects and restarts. New profiles start with CEVRA Dark.

Use **Settings** or **Ctrl+,** for font size and family, indentation, wrapping, line numbers, cursor width, format on save, and the Rename Symbol shortcut. Changes apply to open tabs. **Global** sets the defaults, and **This workspace** overrides just the fields you change. **Clear Workspace Overrides** restores inheritance. Format on save uses the project's formatter configuration.

## Verify CEVRA

Run `npm test` on Windows before expanding the workbench. Put Git and Python 3 with `venv` support on PATH. The core suite exercises process output and exit codes, stale edits, atomic saves, workspace boundaries, and draft ordering. The desktop suite launches Electron against temporary projects and checks JavaScript, TypeScript, and Python execution, syntax and runtime navigation across files, failed-test retries, file safety through the editor bridge, and recovery after forced process termination. Run the suites independently with `npm run test:core` and `npm run test:desktop`.

GitHub Actions runs the same checks on Windows for every push and pull request.

### Manage local extensions

Open **Extensions** in the status bar and choose a local ZIP package. Review the version, contents, and permissions, then install and enable it. The manager also supports quarantine, restore, uninstall, and safe-mode restart. [Extension Manager](docs/phase-4/g6-extension-manager.md)

Run `npm run inspect:extension -- "C:\path\to\package.zip"` to validate a package and view its manifest, inventory, and SHA-256 digest from the command line. [Phase 4 package format](docs/phase-4/g1-package-inspection.md)

Use `npm run pack:extension -- "C:\path\to\source" "C:\path\to\package.zip"` to create a reproducible ZIP from `extension.json` and, for executable packages, `extension.wasm`. The manager can pin a version and shows permission changes before installing an update. [Local distribution and updates](docs/phase-4/g7-local-distribution.md)

Build an extension from the snippet, palette, and Wasm command templates. The SDK includes TypeScript contracts, a C guest header, and `npm run validate:extension -- <extension.json>` for manifest preflight. [Extension author guide](docs/phase-4/g8-author-sdk.md)

Phase 4's Windows acceptance suite covers the full extension lifecycle with five active executable hosts. Its benchmark measures the extension-free editor against the Phase 3 build and records scaling with 50 declarative packages and five active hosts. [Phase 4 integration and benchmark](docs/phase-4/g9-final-integration.md)

### Phase 3 end-to-end benchmark

Run `npm run benchmark:continuum` on Windows with Git and npm on PATH. The benchmark launches the real Electron workbench in a fresh profile and creates a temporary Git repository with a failing invoice calculation. It runs a recipe with workspace consent, opens the exact failure location, inspects the incorrect total at a live breakpoint, and repairs the calculation in the editor. It verifies that the original result becomes **Historical**, then runs a dependency graph and a fresh test suite. The final assertions check that Change Lens matches the staged bytes to the passing test revision, that the reviewed fix is the only committed change, and that the displayed commit hash matches Git.

Each passing sample prints a `CONTINUUM` record with the Windows build, runtime, action timings, both workspace revisions, and the disposable fixture's commit hash. The action timings include workbench and automation overhead. The harness answers the folder picker and native confirmations deterministically. The same suite replays a missing interpreter, cancellation of a detached process tree, and recovery of an unsaved draft after a forced crash. It runs with the Windows desktop regression suite.

Three consecutive samples on Windows 11 build 26300, Electron 45.2.3, and bundled Node.js 24.22.2 passed both the workflow and fault replay. The recorded workflow actions totaled **8.91 s**, **8.94 s**, and **9.90 s**. Fixture setup and cleanup are outside these timings.

| Workflow checkpoint | Median |
| --- | ---: |
| Launch and open fixture | 686 ms |
| Enable Flightpath and name Workstream | 215 ms |
| Review and run the failing recipe | 530 ms |
| Navigate to the recorded failure | 150 ms |
| Set the breakpoint and inspect the live value | 611 ms |
| Edit, save, and check historical evidence | 238 ms |
| Review the working diff and stage | 1,678 ms |
| Run the verification graph and full tests | 1,561 ms |
| Review staged proof and commit | 3,177 ms |
| End the Workstream | 88 ms |

The hosted regression job runs on Windows Server 2025. A separate Windows 10 desktop run is still unverified.

## Benchmark the desktop workflows

Run `npm run benchmark` for five samples or `npm run benchmark -- --samples=20` for a longer run. The harness launches Electron with a fresh local profile for each sample and a generated 163-file workspace. It reports median and p95 times for opening the workspace and a file, editing, syntax feedback, project search, a failed run, and jumping from its output. It verifies the exact search, diagnostic, and runtime destinations. The folder picker and trust prompt are answered by the harness, and timings include app and automation overhead for each measured operation.

On Windows, add a path to `Code.exe` to run a matched comparison in the same command.

```powershell
npm run benchmark -- --samples=5 "--vscode=C:\path\to\Code.exe"
```

The comparison alternates editor order across samples and uses the same fixture and fresh profiles. Workspace opening measures process launch to the file tree. VS Code takes the folder as a launch argument, and the harness supplies it through CEVRA's folder picker. VS Code runs the failing script through its built-in launcher with the Node executable running the harness. CEVRA uses its bundled runtime. Both apps report a runtime version, and jump timings start when the harness activates each app's output link.

To generate a fixture for manual runs, use `node qa/benchmark.cjs --fixture=PATH_TO_NEW_FOLDER`. Use `edit.ts` to type and correct `const benchmark = ;`. Search for `CEVRA_BENCHMARK_NEEDLE` at line 51, column 14. Run `main.cjs` and jump to `fault # %.cjs` at line 3, column 9.

### Reference run on November 9, 2026

Five interleaved samples per editor on Windows build 26300 and an Intel Core i5-1135G7. Both editors reached all 15 expected navigation targets. CEVRA used Electron 45.2.3 with Node 24.22.2, and VS Code 1.145.2 used Node 24.15.0 for the failing script.

| Workflow | CEVRA median | VS Code median |
| --- | ---: | ---: |
| Launch to workspace tree | 832.9 ms | 3,326.5 ms |
| Open a file | 74.9 ms | 1,173.5 ms |
| Edit to rendered text | 25.0 ms | 92.5 ms |
| Show a syntax error | 225.8 ms | 863.6 ms |
| Project search | 336.7 ms | 869.5 ms |
| Run until failure | 145.5 ms | 1,465.1 ms |
| Jump from failure to source | 41.9 ms | 124.2 ms |

## Recover unsaved edits

CEVRA stores unsaved edits in a local draft journal. **Draft backed up** in the status bar means the current edit has been written to the journal. CEVRA reopens those drafts after a renderer crash, after restarting the app, or after choosing **Quit and keep drafts**. Closing a tab and confirming discard removes its draft.

If an original file has changed or disappeared, **Save recovery copy** writes a separate file in the project root. The journal protects edits through the last completed backup. Reopen a disconnected workspace when it becomes accessible to recover its drafts.
