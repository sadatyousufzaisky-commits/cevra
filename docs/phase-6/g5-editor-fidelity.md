# G5 professional editor experience

G5 builds on the Electron and CodeMirror editor. Its first increment covers byte fidelity in the existing UTF-8 editor, formatter, and draft recovery paths.

| Workflow | Behavior |
| --- | --- |
| Edit and save | Preserve the UTF-8 BOM and the original LF, CRLF, and CR separators that survive the edit. New separators follow the file's preferred style. |
| Change line endings | Select the line-ending indicator in the status bar, or search for **Convert line endings** in the Command Center. Choose LF, CRLF, or CR. Undo or redo the conversion like any other edit. |
| Format | Preserve surviving separators by default. An explicit `.cevra-format.json` line-ending setting converts the document within the same undo step. |
| Recover a draft | Restore the saved draft bytes after a crash. If the original changed on disk, **Save recovery copy** writes a separate file. |
| Reject unsupported input | The editor reports invalid UTF-8 and the existing 2 MiB limit. Saving rejects malformed Unicode that would otherwise be replaced by an encoding conversion. |

The editor uses normalized positions for selections, diagnostics, and language-service requests. It retains the original separators in the document state and uses them when writing a draft or saving to disk. The existing draft format and disk revision checks still apply. If an edit puts a standalone CR and LF immediately next to each other, the second separator becomes CRLF so reopening retains both lines.

The status bar shows **Mixed EOL** when the buffer retains exceptions to its preferred style. Project-wide and Intelligence edits still require mixed line endings to be converted and saved first.

## Verification

`npm run test:core` exercises a seeded mixed-ending corpus with Unicode text, undo and redo, grouped deletion, and unsupported save input. `npm run test:desktop` exercises byte-for-byte saves and recovery through real Windows Electron windows, including BOM, right-to-left text, emoji, a forced app crash, a formatter conversion, and an externally changed original. The checks cover undo of both direct and formatter conversions.

G5 remains in progress. The remaining acceptance work includes Phase 2 workflow parity, typing and scrolling benchmarks with large files and multiple tabs, and live Windows IME coverage.
