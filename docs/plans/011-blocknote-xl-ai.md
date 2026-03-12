# 011 — BlockNote xl-ai Integration

> Inline AI editing for notes via `@blocknote/xl-ai` (GPL-3.0, free for open-source)

## Product Goal

Add AI-powered inline editing to the note editor — users can select text and transform it, generate new content via slash commands, and review AI suggestions with accept/reject flow. This is **inline AI** (inside the editor), complementing the existing side-panel AI agent.

## UX Flow

1. **Selection → AI Menu**: Select text → formatting toolbar shows AI button → opens AI menu
2. **Slash Command**: Type `/ai` or trigger from slash menu → opens AI menu at cursor
3. **AI Menu**: Predefined commands (summarize, expand, simplify, translate, fix grammar) + free-text prompt input
4. **Streaming**: AI writes changes in real-time with diff highlighting
5. **Review**: User sees accept/reject buttons → accept applies changes, reject reverts

## Architecture

### Why IPC Transport (not ClientSideTransport)

```
Renderer (BlockNote + xl-ai)
    │
    │  IPC: ai:chat:stream
    ▼
Main Process
    │  Vercel AI SDK streamText()
    │  API keys from secure settings
    ▼
LLM Provider (OpenAI / Anthropic / Ollama)
```

- **Security**: API keys stay in main process (electron-store), never exposed to renderer
- **Consistency**: Follows memry's existing IPC pattern for all external calls
- **Flexibility**: Main process can swap providers, add RAG context, rate-limit — renderer doesn't care
- **Ollama support**: Main process can call local Ollama server without CORS issues

### Alternatives Considered

| Approach | Pros | Cons |
|----------|------|------|
| `ClientSideTransport` | Simpler setup | API keys in renderer, breaks memry's IPC pattern |
| Local HTTP server in main | Works with `DefaultChatTransport` | Extra complexity (port management, CORS) |
| **Custom IPC Transport** ✅ | Secure, consistent, flexible | Need to implement transport class |

---

## Implementation Plan

### Phase 1: Foundation (Package + Transport)

#### T1.1 — Install `@blocknote/xl-ai`

```bash
cd apps/desktop && pnpm add @blocknote/xl-ai
```

Verify version compatibility with existing `@blocknote/core@0.45.x`.

#### T1.2 — AI Provider Settings (Main Process)

**File**: `src/main/services/ai-llm-service.ts` (new)

- Read AI provider config from settings: `provider` (openai | anthropic | ollama), `apiKey`, `model`, `baseUrl`
- Create Vercel AI SDK `LanguageModel` instance based on config
- Dependencies: `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic` (add to package.json)

```typescript
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'

export function createLanguageModel(config: AIProviderConfig): LanguageModel {
  switch (config.provider) {
    case 'openai':
      return createOpenAI({ apiKey: config.apiKey })(config.model)
    case 'anthropic':
      return createAnthropic({ apiKey: config.apiKey })(config.model)
    case 'ollama':
      return createOpenAI({ baseURL: config.baseUrl, apiKey: 'ollama' })(config.model)
  }
}
```

#### T1.3 — IPC Handler for AI Chat Stream

**File**: `src/main/ipc/ai-chat-handler.ts` (new)

- Register IPC handler: `ai:chat:stream`
- Receive `{ messages, toolDefinitions }` from renderer
- Use `streamText()` from Vercel AI SDK with BlockNote's server utilities
- Stream response back via IPC using Electron's `MessagePort` or chunked `ipcMain.handle` responses

```typescript
import { streamText, convertToModelMessages } from 'ai'
import {
  aiDocumentFormats,
  injectDocumentStateMessages,
  toolDefinitionsToToolSet,
} from '@blocknote/xl-ai/server'

ipcMain.handle('ai:chat:stream', async (event, { messages, toolDefinitions }) => {
  const model = getConfiguredModel() // from ai-llm-service

  const result = streamText({
    model,
    system: aiDocumentFormats.html.systemPrompt,
    messages: await convertToModelMessages(
      injectDocumentStateMessages(messages),
    ),
    tools: toolDefinitionsToToolSet(toolDefinitions),
    toolChoice: 'required',
  })

  // Return stream as Data Stream Protocol response
  return result.toDataStreamResponse()
})
```

> **Open question**: Electron IPC doesn't natively support streaming responses like HTTP SSE. Options:
> - A) Use `MessagePort` (Electron's `MessageChannelMain`) for bidirectional streaming
> - B) Use `webContents.send()` to push chunks + `ipcRenderer.on()` to receive
> - C) Run a tiny local HTTP server in main process on a random port, use `DefaultChatTransport` pointing to it
>
> **Recommendation**: Option C is simplest — BlockNote's transport expects HTTP SSE. A local server on `127.0.0.1:0` (random port) avoids reinventing streaming over IPC.

#### T1.4 — Custom Transport (Renderer)

**File**: `src/renderer/src/lib/ai-ipc-transport.ts` (new)

If using local HTTP server approach (Option C from T1.3):

```typescript
import { DefaultChatTransport } from '@blocknote/xl-ai'

export function createAITransport(port: number) {
  return new DefaultChatTransport({
    api: `http://127.0.0.1:${port}/api/ai/chat`,
  })
}
```

If using raw IPC approach, implement the `Transport` interface from xl-ai.

### Phase 2: Editor Integration

#### T2.1 — Add AIExtension to BlockNote Schema

**File**: `src/renderer/src/components/note/content-area/ContentArea.tsx`

- Import `AIExtension` from `@blocknote/xl-ai`
- Import `@blocknote/xl-ai/style.css`
- Add AI locale strings to `dictionary`
- Add `AIExtension` to `extensions` array in `useCreateBlockNote`
- Wire transport from T1.4

```typescript
import { AIExtension } from '@blocknote/xl-ai'
import { en as aiEn } from '@blocknote/xl-ai/locales'
import '@blocknote/xl-ai/style.css'

const editor = useCreateBlockNote({
  schema,
  dictionary: { ...en, ai: aiEn },
  extensions: [
    AIExtension({
      transport: createAITransport(aiPort),
    }),
  ],
  // ... existing options
})
```

#### T2.2 — Add AI Menu Component

**File**: `src/renderer/src/components/note/content-area/ContentArea.tsx` (or extract to separate file)

- Add `AIMenuController` inside `<BlockNoteView>`
- Configure default AI menu items
- Add custom memry-specific commands (see Phase 3)

```tsx
import { AIMenuController } from '@blocknote/xl-ai'

<BlockNoteView editor={editor} theme={theme}>
  {/* existing suggestion controllers */}
  <SuggestionMenuController triggerCharacter="[[" ... />
  <SuggestionMenuController triggerCharacter="#" ... />

  {/* AI menu */}
  <AIMenuController />
</BlockNoteView>
```

#### T2.3 — AI Port Discovery (Renderer → Main)

- Main process starts local AI HTTP server, assigns random port
- Expose port to renderer via `preload` or IPC query: `ai:get-port`
- Renderer calls on mount, creates transport with port

### Phase 3: Custom AI Commands

#### T3.1 — Memry-Specific Commands

**File**: `src/renderer/src/components/note/ai-commands.ts` (new)

| Command | Prompt | Selection? | Description |
|---------|--------|-----------|-------------|
| Summarize | "Summarize the selected text concisely" | Yes | Condense selected text |
| Expand | "Expand on this text with more detail" | Yes | Add depth to selection |
| Fix Grammar | "Fix grammar and spelling errors" | Yes | Proofread |
| Simplify | "Simplify this text for clarity" | Yes | Make easier to read |
| Translate | "Translate to {language}" | Yes | Multi-language |
| Continue Writing | "Continue writing from where the text ends" | No | Generate next paragraph |
| Action Items | "Extract action items as a checklist" | Yes | Turn prose → tasks |

#### T3.2 — Custom AI Menu with Memry Commands

**File**: `src/renderer/src/components/note/content-area/ai-menu.tsx` (new)

- Build `CustomAIMenu` component combining default + custom items
- Context-aware: show different commands based on selection state
- Pass to `AIMenuController` as custom menu component

### Phase 4: Settings UI

#### T4.1 — AI Provider Configuration UI

**File**: `src/renderer/src/pages/settings/ai-section.tsx` (extend existing)

Add to existing AI settings page:
- **Provider selector**: OpenAI / Anthropic / Ollama / Custom
- **API Key input**: Masked, stored in main process via IPC
- **Model selector**: Dropdown per provider (e.g., gpt-4.1, claude-sonnet-4-6, llama3)
- **Base URL**: For Ollama/custom endpoints
- **Test Connection**: Verify API key + model work

#### T4.2 — Inline AI Toggle

- Add toggle: "Enable inline AI editing" (separate from existing AI agent toggle)
- When disabled, `AIExtension` not loaded → no AI menu in editor

### Phase 5: Polish & Edge Cases

#### T5.1 — CSS Integration

**File**: `src/renderer/src/assets/base.css`

- Style AI menu to match memry's design system (shadcn tokens)
- Dark mode support for AI diff highlighting
- Ensure AI menu doesn't clash with wiki-link/hashtag suggestion menus

#### T5.2 — Error Handling

- Network errors → show inline error in AI menu with retry button
- Invalid API key → clear message in AI menu + link to settings
- Ollama not running → detect + show helpful message
- Rate limiting → queue or backoff

#### T5.3 — Keyboard Shortcuts

- `Cmd+J` (or configurable) → open AI menu at cursor/selection
- `Escape` → close AI menu / reject changes
- `Enter` → accept changes (when reviewing)

#### T5.4 — Inbox Editor

- Optionally add AI extension to `InboxContentEditor` too
- Simpler config (no custom commands, just basics)

---

## Dependencies to Add

```json
{
  "@blocknote/xl-ai": "^0.45.x",
  "ai": "^4.x",
  "@ai-sdk/openai": "^1.x",
  "@ai-sdk/anthropic": "^1.x"
}
```

## Open Questions

1. **Streaming over IPC vs local HTTP server**: Local HTTP server (Option C) is recommended — simplest integration with BlockNote's expected transport. Need to validate no Electron security policy blocks `127.0.0.1` fetch from renderer.
2. **Version compatibility**: Verify `@blocknote/xl-ai` version matches existing `@blocknote/core@0.45.x` — they should be in lockstep.
3. **RAG integration**: Future phase — inject note context (linked notes, tags) into AI system prompt for smarter suggestions. Could use existing embedding index.
4. **Journal editor**: Journals use Tiptap, not BlockNote. xl-ai won't work there. Consider migrating journals to BlockNote in a separate plan, or build separate Tiptap AI extension.
5. **Ollama model management**: Should memry manage Ollama model downloads, or assume user has models ready?
6. **Token costs**: Show estimated token usage in UI? Or leave that to the provider dashboard?

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| xl-ai version mismatch with core | High | Pin to same minor version, test immediately |
| Electron CSP blocks local HTTP | Medium | Configure CSP in main process, or use IPC transport |
| AI menu conflicts with wiki-link menu | Low | Different trigger mechanisms (selection vs `[[`) |
| Large note context exceeds token limit | Medium | Truncate document state, only send nearby blocks |

## Phasing & Priority

| Phase | Effort | Priority | Depends On |
|-------|--------|----------|------------|
| Phase 1: Foundation | 2-3 days | P0 | — |
| Phase 2: Editor Integration | 1-2 days | P0 | Phase 1 |
| Phase 3: Custom Commands | 1 day | P1 | Phase 2 |
| Phase 4: Settings UI | 1 day | P1 | Phase 1 |
| Phase 5: Polish | 2 days | P2 | Phase 2-4 |

**Total estimate: ~7-9 days**
