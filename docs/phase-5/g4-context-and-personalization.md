# Phase 5 G4 — Context Broker & Personalization

Build CEVRA and run `npx electron . --enable-intelligence` on Windows x64. Open a project, select code in the editor, and choose **Attach selection to Intelligence**. The attachment uses the selected range from the current editor buffer, including unsaved text. In Intelligence, choose **Attach saved file** to add a file from disk, or **Attach project instructions** to add `.cevra/ai-instructions.md` explicitly. Use **Remove** to omit any attachment.

Select **GPT-5.6 Terra** and send a prompt. The review shows the destination and every message as sent, including the context and response preferences. Approve the request to stream the response. Attachments are used for one completed response. CEVRA excludes both the attachment text and its resulting turn from subsequent conversation requests. A failed or stopped request keeps its attachments available for explicit retry.

Use **Sources used in this response** to return to the recorded file and range. Editing or closing an attached buffer marks the source historical. The panel rechecks on focus and offers **Check source revisions** for external file changes. CEVRA revalidates the reference when opening it. Historical links remain visible and disabled. Source links identify the inputs supplied to the model.

## Scope and limits

- The broker reads files after an explicit attachment action. The workspace resolver checks containment and rejects symlinks, junctions, and hard links. A text allowlist and exclusions cover hidden paths, credential-related names and formats, generated directories, and common embedded private-key and token patterns. Review remains necessary for credentials outside those patterns.
- A request admits up to six attachments and 24 KiB of source text. Individual limits are 8 KiB per selection, 12 KiB per saved file, and 4 KiB for project instructions. Provider message and byte limits also apply to the full request.
- Before preview, after approval, and before the HTTPS call, the broker checks file identity and revision. An editor selection also requires the original document ID, version, and buffer digest. Changes require a fresh attachment and review.
- Project instructions travel as user-supplied reference material. The provider has no file-reading, network, or command tools through this panel. The review and model output render as text.
- **Response preferences** stores only validated choices for language, response length, coding style, and testing in the local CEVRA profile. They apply across workspaces and appear in the review whenever included. Attachments, prompts, and source links stay in memory.

The G4 preview supports selected ranges and explicitly picked files. Workspace-wide retrieval and indexing are outside this implementation. This workflow is available in the Electron workbench.

## Verification

`npm test` covers the broker and the Windows desktop workflow. The broker suite verifies unsafe paths, embedded credential patterns, attachment limits, stale file identity, stale drafts, and preferences across restart. The desktop suite uses a synthetic provider response and a real Windows credential entry. It verifies that the reviewed text exactly matches the request, rejects an external edit made during approval, tests revision-checked navigation to unsaved source, and confirms the next request excludes the previous attachment and answer.
