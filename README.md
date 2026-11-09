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
- **F5** saves the active file and runs it from the project root. The first milestone supports `.js`, `.mjs`, and `.cjs` through Electron's bundled Node runtime. Other files on disk are read as saved.
- **Stop** ends a running program. Its output remains visible in the run panel.
- **Source location** takes you to the first project location CEVRA finds in a failed run's error output.

The workbench uses Electron for the desktop shell and CodeMirror for the editor. CEVRA owns the project explorer, file state, and run workflow. Programs execute with your user account's permissions when you choose to run them.

## Run project tests

**Run tests** (Ctrl+Alt+T) saves open edits and uses Node's built-in test runner to discover JavaScript test files in the project. Click a failure to jump to its assertion or error location. The output pane keeps error details alongside the failure list.

After a failure, **Rerun failures** saves edits and retries tests that have yet to pass in the current run sequence. The summary reports previous passes separately. **Run tests** starts a fresh sequence for the entire suite.

The built-in example includes a failing test for fractional weights. In `total.cjs`, replace `Math.floor(weight)` with `weight` and choose **Rerun failures** to check the fix.

## Search and navigate

- **Ctrl+F** finds and replaces text in the current file. Use the case, whole-word, and regular-expression options to narrow a search. Replacements can be undone in the editor.
- **Ctrl+Shift+F** searches the project for literal text with an optional **Match case** setting. Open drafts take precedence over their disk copies. Click a result to select the exact match, or choose **Cancel** to stop a search.
- **Alt+Left** and **Alt+Right** return to the previous or next position after a jump from search, a runtime error, or a test failure.

Project search shows up to 400 matches and skips binary, unreadable, or oversized files. It excludes version-control directories and common dependency caches. If a file changes on disk after the search, CEVRA checks its revision before opening the result.

## Check syntax while editing

Open **Problems** with **Ctrl+Shift+M**. CEVRA checks open JavaScript and TypeScript buffers, including JSX and TSX, and marks syntax errors inline and in the gutter. Click a problem to select its source range. The panel clears outdated findings while it checks the latest edits. **Retry checks** is available if an analysis fails.

Syntax checking runs locally on editor text. Runtime failures remain in **Run output**. The Problems view in this milestone reports syntax findings.

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

## Verify CEVRA

Run `npm test` on Windows before expanding the workbench. The core suite exercises JavaScript process output and exit codes, stale edits, atomic saves, workspace boundaries, and draft ordering. The desktop suite launches Electron against temporary projects and checks execution, syntax and runtime navigation across files, failed-test retries, file safety through the editor bridge, and recovery after forced process termination. Run the suites independently with `npm run test:core` and `npm run test:desktop`.

GitHub Actions runs the same checks on Windows for every push and pull request.

## Recover unsaved edits

CEVRA stores unsaved edits in a local draft journal. **Draft backed up** in the status bar means the current edit has been written to the journal. CEVRA reopens those drafts after a renderer crash, after restarting the app, or after choosing **Quit and keep drafts**. Closing a tab and confirming discard removes its draft.

If an original file has changed or disappeared, **Save recovery copy** writes a separate file in the project root. The journal protects edits through the last completed backup. Reopen a disconnected workspace when it becomes accessible to recover its drafts.
