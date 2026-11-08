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

## Verify CEVRA

Run `npm test` from the repository. The suite launches CEVRA with temporary projects and exercises saving, execution, error navigation, and failed-test retries through the desktop UI. It covers nested files and paths with spaces, parentheses, brackets, Unicode, and URL-special characters.
