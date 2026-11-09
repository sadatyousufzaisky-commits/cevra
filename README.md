# PROJECT CEVRA

CEVRA is a public project building a desktop environment for the whole software development workflow. The first milestone connects editing, execution, and error navigation in one workbench. Its first benchmark against VS Code will be the time and actions it takes to get from an edit to a failed run and back to the relevant source line.

## Run the workbench

On Windows with Node.js 24 and npm installed, run these commands in the repository:

```powershell
npm ci
npm start
```

Choose **Open example** to try the built-in JavaScript project, or choose **Open folder** to browse an existing project. The example includes a commented-out error you can enable to try source navigation.

- **Ctrl+S** saves the active file. The editor accepts UTF-8 text files up to 2 MiB.
- **Ctrl+Shift+S** saves all open drafts. CEVRA reports where the save stopped if a file fails its revision check.
- **F5** saves the active file and runs it from the project root. The first milestone supports `.js`, `.mjs`, and `.cjs` through Electron's bundled Node runtime. Other files on disk are read as saved.
- **Stop** ends a running program. Its output remains visible in the run panel.
- **Source location** takes you to the first project location CEVRA finds in a failed run's error output.

The workbench uses Electron for the desktop shell and CodeMirror for the editor. CEVRA owns the project explorer, file state, and run workflow. Before the first file or test run in an untrusted workspace, choose **Run Once**, **Trust Workspace**, or **Cancel**. CEVRA asks before saving or running code. Programs execute with your user account's permissions. Workspace trust is stored locally and can be revoked in **Settings**.

## Run project tests

**Run tests** (Ctrl+Alt+T) saves open edits and uses Node's built-in test runner to discover JavaScript test files in the project. Click a failure to jump to its assertion or error location. The output pane keeps error details alongside the failure list.

After a failure, **Rerun failures** saves edits and retries tests that have yet to pass in the current run sequence. The summary reports previous passes separately. **Run tests** starts a fresh sequence for the entire suite.

The built-in example includes a failing test for fractional weights. In `total.cjs`, replace `Math.floor(weight)` with `weight` and choose **Rerun failures** to check the fix.

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

Run `npm test` on Windows before expanding the workbench. The core suite exercises JavaScript process output and exit codes, stale edits, atomic saves, workspace boundaries, and draft ordering. The desktop suite launches Electron against temporary projects and checks execution, syntax and runtime navigation across files, failed-test retries, file safety through the editor bridge, and recovery after forced process termination. Run the suites independently with `npm run test:core` and `npm run test:desktop`.

GitHub Actions runs the same checks on Windows for every push and pull request.

## Benchmark the desktop workflows

Run `npm run benchmark` for five samples or `npm run benchmark -- --samples=20` for a longer run. The harness launches Electron with a fresh local profile for each sample and a generated 163-file workspace. It reports median and p95 times for opening the workspace and a file, editing, syntax feedback, project search, a failed run, and jumping from its output. It verifies the exact search, diagnostic, and runtime destinations. The folder picker and trust prompt are answered by the harness, and timings include app and automation overhead for each measured operation.

For a matched VS Code comparison, generate the same workspace with `node qa/benchmark.cjs --fixture=PATH_TO_NEW_FOLDER`. On the same machine, use clean profiles, record editor versions and runtime versions, and run the same number of samples in each editor. Use `edit.ts` for opening, typing, and the syntax error `const benchmark = ;`. Search for `CEVRA_BENCHMARK_NEEDLE` and verify line 51, column 14. Run `main.cjs` and verify the jump to `fault # %.cjs` at line 3, column 9. Time the same start and end points and record the number of actions separately.

## Recover unsaved edits

CEVRA stores unsaved edits in a local draft journal. **Draft backed up** in the status bar means the current edit has been written to the journal. CEVRA reopens those drafts after a renderer crash, after restarting the app, or after choosing **Quit and keep drafts**. Closing a tab and confirming discard removes its draft.

If an original file has changed or disappeared, **Save recovery copy** writes a separate file in the project root. The journal protects edits through the last completed backup. Reopen a disconnected workspace when it becomes accessible to recover its drafts.
