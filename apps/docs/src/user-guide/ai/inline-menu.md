# Inline AI Menu

Transform selected text in the editor without leaving it.

<!-- screenshot: inline AI menu open over a text selection -->

## Opening the Menu

Select text in any note or journal entry. The formatting toolbar shows an **AI** affordance — click it (or press the AI shortcut) to open the prompt menu.
If the global **Settings -> AI -> Enable** switch is off, memrynote hides the inline AI menu and slash
menu AI commands entirely.

## Built-in Actions

| Action                     | Effect                                             |
| -------------------------- | -------------------------------------------------- |
| **Fix grammar**            | Correct typos and grammar without changing meaning |
| **Adjust tone — formal**   | Rewrite in a more professional register            |
| **Adjust tone — casual**   | Rewrite in a more relaxed register                 |
| **Adjust tone — friendly** | Rewrite warmly                                     |
| **Expand**                 | Add detail; aim for more concrete examples         |
| **Condense**               | Tighten; remove redundancy without losing meaning  |
| **Summarize**              | Reduce to bullet points or a tight paragraph       |
| **Rephrase**               | Suggest alternative wording with the same meaning  |

## Custom Prompt

Below the built-ins, a free-form input accepts any instruction. Examples:

- "Convert to a numbered list"
- "Translate to Spanish"
- "Make this more vivid with sensory details"
- "Reframe as a question"

The custom prompt sees your selected text as input and returns a rewrite.

## Result Handling

After a transformation:

- The result appears in a **diff view** (additions green, removals red)
- Buttons: **Accept**, **Discard**, **Try again**
- "Try again" re-runs with the same prompt for a different draft

Until you accept, your original text is unchanged.

## Provider

Inline AI uses whichever provider you configured in [Settings → AI Inline](/user-guide/settings#ai-inline):

- **Ollama** — runs models locally; free; private; requires you to have Ollama running
- **OpenAI** — uses GPT models via API; needs an API key
- **Anthropic** — uses Claude models via API; needs an API key

See [Provider Setup](/user-guide/ai/provider-setup) for configuring each.

## Privacy

Requests go to whichever provider you chose. With **Ollama**, your text never leaves your machine. With **OpenAI** or **Anthropic**, the request goes to their API — review their data policies before sending sensitive content.

memrynote never proxies these requests through the sync server. The connection is direct from your device to the provider.

## When the Menu Doesn't Appear

- AI is disabled globally in [Settings → AI](/user-guide/settings#ai)
- AI Inline is disabled in [Settings → AI Inline](/user-guide/settings#ai-inline)
- The provider isn't configured (Ollama not running, missing API key)
- The selection is empty

A status icon in the toolbar indicates whether the provider is reachable.

## See Also

- [Provider Setup](/user-guide/ai/provider-setup)
- [Embeddings & Semantic Search](/user-guide/ai/embeddings-search) — semantic search uses different on-device infrastructure
