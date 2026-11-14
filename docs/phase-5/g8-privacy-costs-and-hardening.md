# G8 · Privacy, costs, and hardening

## Review and limit estimated spend

Open **Intelligence → OpenAI usage and daily estimate limit** to see the current UTC day's total. Enter a USD amount, including zero to block OpenAI requests, or leave the field blank to disable the daily limit. The setting is per CEVRA profile and persists through restart. Ollama and the offline mock remain available when the cloud limit blocks a request.

The OpenAI send review shows the exact messages and a reservation estimate in USD. CEVRA uses UTF-8 input bytes plus message framing headroom, the full output cap, and a dated GPT-5.6 Terra rate card. The model's published rates are $2 per million uncached input tokens and $12 per million output tokens. CEVRA uses the higher $2.50 per million input allowance to cover the listed cache-write premium. Estimates use standard text pricing. The rate card was checked on 2026-11-14 and expires on 2027-02-12. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-5.6-terra)

CEVRA checks the limit before opening a review and atomically reserves the estimate immediately before transport. With a limit enabled, unknown prices or unpriced requests earlier that day block new OpenAI requests. With the limit disabled, the send review shows an explicit price-unavailable message. The transport makes no preliminary remote token-count request. CEVRA settles a reservation from validated provider usage. Missing usage after a failure, Stop, or interrupted app run leaves the estimate reserved for that day. The estimated total can rise above the limit if reported usage exceeds the reservation, and the higher total governs the next request.

OpenAI bills usage independently. Tokenization, pricing changes, cached rates, account terms, taxes, or work performed after a cancellation can change the invoice. CEVRA does not query an account balance. HTTP 429 rate limits pause OpenAI sends for five seconds within the running app. Quota exhaustion is shown separately. A retry always needs a fresh review. [OpenAI errors](https://developers.openai.com/api/docs/guides/error-codes)

## Keep content and authority scoped

The local OpenAI usage ledger retains the latest 40 admitted requests and the current UTC day's aggregate. Each record holds an opaque request ID, model ID, timestamps, outcome, reservation, rate date, and validated usage when available. Prompts, responses, paths, source, provider error bodies, and credentials are excluded. Conversation content remains in memory under the existing panel and workspace lifecycle. [G0 architecture](g0-architecture.md)

The broker checks outbound messages for common credential patterns. The cloud adapter rejects a literal copy of the active vault key in outbound messages or model output, including a copy split across stream chunks. Provider errors map to fixed messages. The adapter blocks HTTP debug logging and request diagnostic subscriptions that could expose authorization headers. This screening covers recognized patterns and literal matches. Review outbound text for other sensitive material before approval. OpenAI requests set `store: false`, and the provider's abuse-monitoring policies may still apply. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

Workspace text remains reference material. The coding workflow sends approved attachments and baseline counts while keeping test stdout and stderr out of model requests. Model output has no shell, credential, or network authority. Extension guests use their existing capability broker, with no Intelligence API or credential access.
