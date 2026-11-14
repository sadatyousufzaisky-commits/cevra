# G7 · Model routing, profiles, and offline use

## Configure model defaults

Launch the Windows Electron workbench with `npx electron . --enable-intelligence` after `npm run build`. Open **Intelligence**, expand **Models and local connection**, and save defaults for **Chat**, **Explain code**, **Patch proposal**, or **Coding task**. **Use the model picker** leaves a task without a saved default. Choose a task and use the **Model** picker to override its default for the current interaction.

Defaults are stored as provider and model IDs in the local CEVRA profile. An unavailable saved model leaves that task waiting for a connection or a new selection. The deterministic mock supports chat and explanations. Proposals and coding tasks use a connected model, and a coding plan displays the provider and model it will use before the baseline starts.

## Connect Ollama

Start your own Ollama service with `OLLAMA_NO_CLOUD=1` or `disable_ollama_cloud` set to `true` in Ollama's server configuration, then install a local text generation model using Ollama. Restart the service after changing its configuration. In CEVRA, enter the service's loopback port, usually `11434`, and choose **Discover local models**. The connection lasts while the Intelligence panel is open. [Ollama local-only configuration](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features)

CEVRA connects directly to `127.0.0.1`, checks the connected peer, blocks redirects, and checks that the service reports cloud features disabled. Discovery sends metadata requests. Before inference, CEVRA checks the selected model's installed digest and text generation capability and revalidates any attached workspace context. Ollama is the user-managed inference service. [Ollama model catalog](https://docs.ollama.com/api/tags) · [Ollama server routes](https://github.com/ollama/ollama/blob/main/server/routes.go)

## Review every destination

The send review shows the provider endpoint, model, and outbound messages. **Choose another model** after a provider failure returns focus to the model picker. Sending through the new provider opens a new review. Chat history is scoped to its provider and model. Explain, patch, and coding requests start with their own messages and any approved attachments. Start a new coding plan to change its model.

Editor features remain available with Intelligence disabled or a model disconnected. A local Ollama model runs inference through the loopback service. OpenAI requests require a configured key and can incur API charges.
