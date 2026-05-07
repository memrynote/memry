# Provider Setup

Configure the LLM provider used by the inline AI menu.

<!-- screenshot: AI inline provider configuration in settings -->

## Supported Providers

- Ollama (local)
- OpenAI
- Anthropic

## Ollama

Run Ollama locally and point Memry at the base URL (default `http://localhost:11434`). Pick a model from the dropdown.

## OpenAI

Enter your API key. Pick a model preset; advanced users can override the model name.

## Anthropic

Enter your API key. Pick a Claude model preset.

## Test Connection

The "Test connection" button verifies the URL and key.

## Where Keys Are Stored

API keys are stored locally in the vault and are never sent to the Memry sync server.
