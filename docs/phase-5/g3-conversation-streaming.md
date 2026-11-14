# Phase 5 G3 — Conversation & Streaming

## Try the Windows preview

```powershell
npm ci
npm run build
npx electron . --enable-intelligence
```

Open **Intelligence** in the workbench status bar. Choose **Deterministic mock** to use the offline provider. To use OpenAI, open **Provider connections**, add an OpenAI API project key through the Windows prompt, and choose **GPT-5.6 Terra**. **Check key** checks the local Windows vault. A completed live response verifies that the key can use the selected model during that session. [OpenAI API key guidance](https://developers.openai.com/api/docs/guides/api-keys) · [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)

**Send** opens a keyboard-accessible review showing the endpoint, model, output-token cap, and exact prompt and conversation turns included. **Cancel** has initial focus. **Stop** ends the active stream and keeps partial text visible. **Retry** shows a fresh review for a new request. **New conversation**, model changes, workspace switches, and closing or restarting the panel clear the session. Completed turns stay in memory. The panel sends user-entered text and completed assistant turns. Project files and editor state are outside this workflow.

OpenAI bills API requests against the user's API project. A stopped or failed request can still incur charges for work already processed. The adapter sends `store: false` and omits hosted tools. OpenAI's abuse-monitoring policies may still apply to request and response content. Usage is shown when OpenAI returns valid token counts. [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) · [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

## Provider and credential boundary

The only live destination is `POST https://api.openai.com/v1/responses`. The trusted main process opens a direct, certificate-validated HTTPS connection with no redirects or automatic retries. It sends a user-owned project key in the authorization header. The native vault helper reads only the current, uninterrupted OpenAI credential generation and returns it over an inherited pipe. Main clears the borrowed key buffer after creating the request. The request library holds the authorization header in memory for transport. Renderer IPC exposes status and normalized stream events. [OpenAI authentication](https://developers.openai.com/api/reference/overview#authentication) · [Windows credential read](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)

Each approved request captures an immutable message snapshot tied to the active panel and stream. Switching workspaces, revoking workspace trust, closing the panel, or losing its renderer invalidates the active request. Starting replacement or confirming disconnect aborts an active request for that provider before the vault operation. Responses are rendered as text. Provider status, HTTP errors, and rate limits are mapped to fixed user-facing messages. [OpenAI streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events) · [OpenAI API errors](https://developers.openai.com/api/docs/guides/error-codes)

| Limit | Value |
| --- | --- |
| Prompt | 8 KiB UTF-8 |
| Conversation sent to OpenAI | 16 messages and 64 KiB of UTF-8 content |
| OpenAI output requested | 1,024 tokens |
| Normalized stream | 4,096 events, 4 KiB per delta, 64 KiB of accumulated text |
| OpenAI wire stream | 4 MiB total, 256 KiB per SSE frame |
| Request deadline | 45 seconds |

Normal startup keeps Intelligence disabled. `--enable-intelligence-mock` still exposes the offline-only preview. Anthropic and Gemini remain available for local key management. OpenAI is the live provider in this gate, using project API keys. The Vokri workbench is on its own development branch.

## Verify

`npm test` runs the provider tests and the Windows desktop scenarios. Tests cover Unicode and fragmented SSE, malformed and oversized streams, typed errors, redirects, cancellation, and deadlines. The Windows desktop scenario uses the production vault helper with a synthetic key and replaces the HTTPS request at the test boundary. It checks the exact review payload, keyboard approval, prompt-only scope, usage, manual retry, renderer crash, workspace switching, and disconnect. An authenticated request against an actual OpenAI account remains a manual smoke test with a user-owned key.

On 2026-11-14, the implementation passed 141 core, 78 desktop, and 17 extension-host tests on hosted Windows. The separate Windows account isolation check also passed. Direct TLS reached the configured OpenAI endpoint and returned HTTP 401 to an unauthenticated probe. [Windows verification](https://github.com/sadatyousufzaisky-commits/cevra/actions/runs/43545313364)
