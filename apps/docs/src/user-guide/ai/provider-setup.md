# Provider Setup

Configure the LLM provider used by the inline AI menu in the editor. Open from [Settings → AI Inline](/user-guide/settings#ai-inline).

<!-- screenshot: AI inline provider configuration in settings -->

## Supported Providers

| Provider      | Runs                    | Needs                        |
| ------------- | ----------------------- | ---------------------------- |
| **Ollama**    | Locally on your machine | Ollama installed and running |
| **OpenAI**    | OpenAI cloud            | API key                      |
| **Anthropic** | Anthropic cloud         | API key                      |

Each provider has its own model presets in the dropdown.

## Ollama (Local)

Best when you want privacy, no metering, and don't mind running an extra background process.

### Setup

1. Install [Ollama](https://ollama.com/) on your system.
2. Pull a model: `ollama pull llama3.2` (or any chat model you prefer).
3. In memrynote, set **Provider: Ollama**.
4. **Base URL**: defaults to `http://localhost:11434/v1` — adjust if Ollama runs on a different port or remote machine.
5. **Model**: pick from the dropdown (presets) or type a model name you've pulled locally.
6. Click **Test Connection**.

### Notes

- memrynote talks to Ollama's native `/api/chat` endpoint and automatically sets `num_ctx: 8192` per request. You do not need to set `OLLAMA_CONTEXT_LENGTH` or `OLLAMA_NUM_PARALLEL` — the context window is managed for you.
- No API key required for default local Ollama.
- Token costs: zero, but RAM usage scales with model size.

## OpenAI

### Setup

1. Get an API key from [platform.openai.com](https://platform.openai.com/).
2. **Provider: OpenAI**
3. Paste the API key into the input. Toggle visibility with the eye icon.
4. **Model**: pick from presets (e.g. `gpt-4o-mini`, `gpt-4o`).
5. Click **Test Connection**.

### Notes

- Keys are stored locally in the vault (encrypted at rest).
- Keys are never sent to the memrynote sync server.
- Each AI call hits OpenAI directly from your device.

## Anthropic

### Setup

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/).
2. **Provider: Anthropic**
3. Paste the API key.
4. **Model**: pick a Claude preset (e.g. `claude-sonnet-4-6`).
5. Click **Test Connection**.

### Notes

Same key-storage and privacy properties as OpenAI.

## Test Connection

The button verifies:

- The base URL is reachable
- The API key authenticates (for OpenAI / Anthropic)
- The selected model exists and is accessible

A status indicator (green / yellow / red) shows the most recent test result.

## Switching Providers

You can change provider at any time. Memory of past prompts is local — switching doesn't carry conversation state.

memrynote keeps one local inline-AI bridge running for the active provider settings. Re-opening the editor or another window reuses that bridge when settings are unchanged; changing provider, model, base URL, or API key restarts it with the new configuration.

## Where Keys Live

API keys are stored **locally**, in the vault, encrypted with the vault key. They:

- Never leave the device unencrypted
- Never appear in sync items
- Are accessible to memrynote's main process only (renderer reads via IPC)

Rotating a key in the provider's dashboard requires updating it here too.

## Troubleshooting

| Symptom                                    | Likely cause                                                         |
| ------------------------------------------ | -------------------------------------------------------------------- |
| "Cannot connect" with Ollama               | Ollama not running; check `http://localhost:11434/v1/models`         |
| "Unauthorized" with OpenAI / Anthropic     | Wrong key, expired, or rate-limited                                  |
| "Model not found"                          | Model name typo or not pulled (Ollama) / not enabled in your account |
| Test passes but inline menu doesn't appear | AI Inline toggle off in settings                                     |

## See Also

- [Inline AI Menu](/user-guide/ai/inline-menu)
- [Voice Transcription](/user-guide/ai/voice-transcription)
- [Embeddings & Semantic Search](/user-guide/ai/embeddings-search)
