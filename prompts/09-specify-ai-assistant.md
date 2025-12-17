# AI Assistant Specification

AI-powered assistant for writing help, content discovery, and productivity.

```
/speckit.specify

Build the AI assistant that helps users with writing, organization, and content discovery:

## USER STORIES

### P1 - Critical
1. As a user, I want to ask questions about my notes and get answers based on my content
2. As a user, I want AI to find related notes when I'm writing
3. As a user, I want to summarize long notes with one click
4. As a user, I want writing suggestions and improvements

### P2 - Important
5. As a user, I want to generate tasks from meeting notes
6. As a user, I want to expand bullet points into full paragraphs
7. As a user, I want to fix grammar and spelling in my writing
8. As a user, I want to translate content to other languages
9. As a user, I want AI suggestions that respect my privacy (local option)

### P3 - Nice to Have
10. As a user, I want to chat with an AI about my PKM system
11. As a user, I want AI to suggest tags for new content
12. As a user, I want weekly digest summaries generated automatically
13. As a user, I want to train AI on my writing style

## ARCHITECTURE

### Provider Abstraction
```typescript
interface AIProvider {
  name: string
  generateCompletion(prompt: string, options: CompletionOptions): Promise<string>
  generateEmbedding(text: string): Promise<number[]>
  isAvailable(): boolean
}

// OpenAI Provider
class OpenAIProvider implements AIProvider {
  // Uses gpt-4-turbo for completions
  // Uses text-embedding-3-small for embeddings
}

// Local Provider (Ollama)
class LocalProvider implements AIProvider {
  // Uses local models via Ollama
  // Embeddings via all-MiniLM or similar
}

// Anthropic Provider (optional)
class AnthropicProvider implements AIProvider {
  // Claude for completions
}
```

### Embedding Storage
```typescript
interface EmbeddingIndex {
  id: string              // Content ID (note, journal, task)
  type: "note" | "journal" | "task"
  embedding: number[]     // Vector (384-1536 dimensions)
  text: string            // Original text for display
  metadata: {
    title: string
    path?: string
    date?: string
  }
  updatedAt: Date
}
```

## FUNCTIONAL REQUIREMENTS

### AI Panel
- Slide-out panel on right side (like existing AI agent panel)
- Toggle with Cmd+I or button
- Chat interface for questions
- Context-aware: knows current note/task
- Quick action buttons above chat

### Semantic Search (RAG)
```
User asks: "What did I write about project planning?"

1. Generate embedding for query
2. Find similar embeddings in index (cosine similarity)
3. Retrieve top 5-10 matching chunks
4. Build prompt with context:
   "Based on these notes from the user's vault:
    [context chunks]

    Answer this question: What did I write about project planning?"
5. Stream response to UI
```

### Writing Assistance
Commands available in editor (select text, right-click or Cmd+J):

```typescript
type WritingCommand =
  | "improve"        // Rewrite for clarity
  | "fix-grammar"    // Fix spelling and grammar
  | "expand"         // Expand bullet points to paragraphs
  | "summarize"      // Condense selected text
  | "simplify"       // Make more readable
  | "formalize"      // Make more professional
  | "casual"         // Make more conversational
  | "translate"      // Translate to another language
  | "continue"       // Continue writing from cursor
```

### Content Generation
- Extract tasks from notes (find action items)
- Generate tags from content
- Create meeting summary from notes
- Generate outline from topic
- Brainstorm ideas on topic

### Embedding Updates
```
On note save:
1. Check if content changed significantly (hash comparison)
2. If changed, queue for re-embedding
3. Background worker processes queue:
   a. Chunk content into ~500 token segments
   b. Generate embedding for each chunk
   c. Store in embedding index
4. Update index timestamp
```

### Privacy Mode
- Local provider option (Ollama)
- All processing on device
- No data sent to external APIs
- Works offline
- Trade-off: Lower quality, slower

### Chat Interface
```
┌─────────────────────────────────────────────────────────────┐
│  AI Assistant                                        [×]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Quick Actions                                        │   │
│  │ [Summarize] [Find Related] [Extract Tasks] [Improve] │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Chat                                                       │
│  ─────                                                      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🧑 What did I write about productivity last month?   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🤖 Based on your journal entries from December:      │   │
│  │                                                       │   │
│  │ On December 5, you reflected on implementing time    │   │
│  │ blocking and noted it helped you focus better...     │   │
│  │                                                       │   │
│  │ On December 12, you mentioned the Pomodoro technique │   │
│  │ wasn't working well for deep work sessions...        │   │
│  │                                                       │   │
│  │ Sources:                                              │   │
│  │ • December 5, 2024                                   │   │
│  │ • December 12, 2024                                  │   │
│  │ • Productivity Methods (note)                        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Ask about your notes...                    [Send →]  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Context Window
- Include current note content in context
- Include recent conversation history
- Include relevant search results
- Total context: ~4000 tokens (adjust based on model)

## NON-FUNCTIONAL REQUIREMENTS

### Performance
- Chat response starts streaming within 1 second
- Embedding generation: ~100 notes/minute
- Semantic search: <500ms for 10,000 embeddings
- Background embedding doesn't block UI

### Privacy
- API keys stored in OS keychain
- Option for fully local processing
- No content sent to analytics
- Embeddings stored locally, not synced by default

### Cost Management
- Show estimated API cost for operations
- Rate limiting to prevent runaway costs
- Batch operations when possible
- Cache common queries

## ACCEPTANCE CRITERIA

### AI Panel
- [ ] Cmd+I toggles AI panel
- [ ] Panel slides in from right
- [ ] Close button works
- [ ] Panel state persists

### Chat
- [ ] Can type and send messages
- [ ] Responses stream in real-time
- [ ] Context from current note included
- [ ] Conversation history maintained
- [ ] Can clear conversation

### Semantic Search
- [ ] "What did I write about X" finds relevant notes
- [ ] Sources shown with results
- [ ] Clicking source opens note
- [ ] Works across notes and journal

### Writing Commands
- [ ] Select text, Cmd+J opens command menu
- [ ] "Improve" rewrites selected text
- [ ] "Fix grammar" corrects errors
- [ ] "Expand" elaborates on bullet points
- [ ] "Summarize" condenses long text
- [ ] Result shown in diff view, can accept/reject

### Content Generation
- [ ] "Extract tasks" from meeting notes works
- [ ] Generated tasks can be created with one click
- [ ] "Suggest tags" provides relevant tags
- [ ] Tags can be added with one click

### Privacy Mode
- [ ] Can switch to local provider in settings
- [ ] Local processing works offline
- [ ] No network requests when local mode enabled
- [ ] Clear indication of which mode active

### Embedding Index
- [ ] New notes get indexed automatically
- [ ] Updated notes get re-indexed
- [ ] Index status visible (X notes indexed)
- [ ] Can rebuild index manually

### Edge Cases
- [ ] Large documents chunked properly
- [ ] API errors show clear message
- [ ] Rate limiting handled gracefully
- [ ] Empty vault shows helpful guidance
- [ ] No API key shows setup instructions
```
