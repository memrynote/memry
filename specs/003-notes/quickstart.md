# Quickstart: Notes System Development

**Feature**: 003-notes
**Date**: 2025-12-23
**Updated**: 2025-12-23 - Aligned with actual codebase

## Prerequisites

1. Node.js 20+ and pnpm installed
2. Repository cloned and dependencies installed
3. Familiarity with Electron, React, and TypeScript

## Getting Started

```bash
# Clone and install
git clone <repo-url>
cd memry
pnpm install

# Start development server
pnpm dev

# Open a vault (required for notes)
# Use the UI to select a folder as your vault
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         RENDERER PROCESS                         │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────────┐   │
│  │  NotePage   │───►│ useNotes()   │───►│ notes-service.ts  │   │
│  │  Component  │    │    Hook      │    │    (IPC wrapper)  │   │
│  └─────────────┘    └──────────────┘    └─────────┬─────────┘   │
│                                                    │             │
└────────────────────────────────────────────────────┼─────────────┘
                                                     │ IPC
┌────────────────────────────────────────────────────┼─────────────┐
│                          MAIN PROCESS              │             │
│  ┌─────────────────────┐    ┌────────────────────┐ │             │
│  │ notes-handlers.ts   │◄───┤ preload/index.ts   │◄┘             │
│  │  (IPC handlers)     │    │   (bridge API)     │               │
│  └──────────┬──────────┘    └────────────────────┘               │
│             │                                                     │
│  ┌──────────▼──────────┐    ┌────────────────────┐               │
│  │   vault/notes.ts    │───►│   SQLite (cache)   │               │
│  │   (file operations) │    │   FTS5 (search)    │               │
│  └──────────┬──────────┘    └────────────────────┘               │
│             │                                                     │
│  ┌──────────▼──────────┐                                         │
│  │   File System       │                                         │
│  │   vault/notes/*.md  │                                         │
│  └─────────────────────┘                                         │
└───────────────────────────────────────────────────────────────────┘
```

## Key Files

### Main Process

| File | Purpose |
|------|---------|
| `src/main/vault/notes.ts` | Note CRUD operations (file-based) |
| `src/main/vault/frontmatter.ts` | YAML frontmatter parsing |
| `src/main/vault/file-ops.ts` | Atomic file writes |
| `src/main/vault/watcher.ts` | File change detection |
| `src/main/ipc/notes-handlers.ts` | IPC handler registration |
| `src/main/database/fts.ts` | FTS5 full-text search |
| `src/shared/db/queries/notes.ts` | Database query functions |

### Renderer Process

| File | Purpose |
|------|---------|
| `src/renderer/src/pages/note.tsx` | Note page component |
| `src/renderer/src/hooks/use-notes.ts` | Notes state management |
| `src/renderer/src/services/notes-service.ts` | IPC wrapper |
| `src/renderer/src/components/note/content-area/ContentArea.tsx` | BlockNote editor |
| `src/renderer/src/components/note/note-title/NoteTitle.tsx` | Title + emoji |
| `src/renderer/src/components/note/tags-row/TagsRow.tsx` | Tag management |
| `src/renderer/src/components/note/info-section/InfoSection.tsx` | Properties panel |
| `src/renderer/src/components/note/backlinks/BacklinksSection.tsx` | Backlinks display |

### Shared

| File | Purpose |
|------|---------|
| `src/shared/contracts/notes-api.ts` | Zod schemas & types |
| `src/shared/db/schema/notes-cache.ts` | Drizzle table definitions |
| `src/shared/ipc-channels.ts` | IPC channel constants |

## Existing UI Components

The notes system already has extensive UI components built:

```
src/renderer/src/components/note/
├── ai-agent/              # AI Assistant panel (demo data)
├── backlinks/             # Backlinks section (demo data)
├── content-area/          # BlockNote-based rich text editor ✅
├── info-section/          # Properties panel with 8 editors ✅
├── linked-tasks/          # Tasks linked to note ✅
├── note-title/            # Title with emoji picker ✅
├── related-notes/         # Suggested related notes (demo data)
├── tags-row/              # Tag management ✅
├── note-layout.tsx        # Main layout wrapper ✅
├── outline-edge.tsx       # Document outline ✅
└── right-sidebar.tsx      # Right sidebar container ✅
```

## Common Tasks

### 1. Create a Note Programmatically

```typescript
// In renderer process
import { notesService } from '@/services/notes-service'

const note = await notesService.create({
  title: 'My New Note',
  content: '# Hello World',
  tags: ['example', 'tutorial'],
  folder: 'getting-started'
})
console.log('Created note:', note.id)
```

### 2. Use the Notes Hook

```tsx
import { useNotes } from '@/hooks/use-notes'

function NotesView() {
  const {
    notes,
    isLoading,
    createNote,
    updateNote,
    deleteNote
  } = useNotes({
    folder: 'projects',
    tags: ['active'],
    sortBy: 'modified'
  })

  const handleCreate = async () => {
    const note = await createNote({ title: 'New Note' })
    // Note automatically appears in `notes` array
  }

  return (
    <ul>
      {notes.map(note => (
        <li key={note.id}>{note.title}</li>
      ))}
    </ul>
  )
}
```

### 3. Use the BlockNote Editor

```tsx
import { ContentArea } from '@/components/note'

function NoteEditor({ noteId }) {
  const [headings, setHeadings] = useState([])

  const handleMarkdownChange = useCallback((markdown: string) => {
    // Save to backend
    notesService.update({ id: noteId, content: markdown })
  }, [noteId])

  return (
    <ContentArea
      initialContent={note.content}
      contentType="markdown"
      onMarkdownChange={handleMarkdownChange}
      onHeadingsChange={setHeadings}
      placeholder="Start writing..."
      editable={true}
    />
  )
}
```

### 4. Add a New IPC Handler

```typescript
// 1. Define schema in src/shared/contracts/notes-api.ts
export const MyNewInputSchema = z.object({
  noteId: z.string(),
  action: z.string()
})

// 2. Add channel in src/shared/ipc-channels.ts
export const NotesChannels = {
  invoke: {
    // ... existing
    MY_NEW_HANDLER: 'notes:my-new-action',
  }
}

// 3. Add handler in src/main/ipc/notes-handlers.ts
ipcMain.handle(NotesChannels.invoke.MY_NEW_HANDLER,
  createValidatedHandler(MyNewInputSchema, async (input) => {
    // Implement logic
    return { success: true, data: result }
  })
)

// 4. Expose in src/preload/index.ts
const api = {
  notes: {
    // ... existing
    myNewAction: (input) => ipcRenderer.invoke('notes:my-new-action', input)
  }
}

// 5. Add types in src/preload/index.d.ts
declare global {
  interface Window {
    api: {
      notes: {
        myNewAction: (input: MyNewInput) => Promise<MyNewResponse>
      }
    }
  }
}

// 6. Add to service in src/renderer/src/services/notes-service.ts
export const notesService = {
  myNewAction: (input) => window.api.notes.myNewAction(input)
}
```

### 5. Modify the Database Schema

```typescript
// 1. Update schema in src/shared/db/schema/notes-cache.ts
export const noteCache = sqliteTable('note_cache', {
  // ... existing columns
  myNewColumn: text('my_new_column'),
})

// 2. Generate migration
pnpm db:generate

// 3. Apply migration (in development)
pnpm db:push

// 4. Update queries in src/shared/db/queries/notes.ts
export function updateNoteCacheWithNewField(db, id, value) {
  return db
    .update(noteCache)
    .set({ myNewColumn: value })
    .where(eq(noteCache.id, id))
    .run()
}
```

### 6. Subscribe to Note Events

```tsx
import { useEffect } from 'react'

function NoteEventListener() {
  useEffect(() => {
    // Subscribe to events
    const unsubCreated = window.api.onNoteCreated((note) => {
      console.log('Note created:', note.title)
    })

    const unsubUpdated = window.api.onNoteUpdated((note) => {
      console.log('Note updated:', note.title)
    })

    const unsubExternal = window.api.onNoteExternalChange((note) => {
      console.log('Note changed externally:', note.title)
    })

    return () => {
      unsubCreated()
      unsubUpdated()
      unsubExternal()
    }
  }, [])

  return null
}
```

### 7. Create Custom BlockNote Extension

```typescript
// For wiki-links (inline content)
import { createInlineContentSpec } from '@blocknote/core'

const WikiLink = createInlineContentSpec({
  type: 'wikiLink',
  propSchema: {
    target: { default: '' },
    alias: { default: '' }
  },
  content: 'styled'
})

// For file attachments (block)
import { createBlockSpec } from '@blocknote/core'

const FileBlock = createBlockSpec({
  type: 'file',
  propSchema: {
    url: { default: '' },
    name: { default: '' },
    size: { default: 0 }
  },
  content: 'none'
})
```

## Development Workflow

### Running Commands

```bash
# Development
pnpm dev              # Start with hot reload

# Type checking
pnpm typecheck        # Check all TypeScript
pnpm typecheck:node   # Main process only
pnpm typecheck:web    # Renderer only

# Database
pnpm db:generate      # Generate migrations
pnpm db:push          # Apply schema changes
pnpm db:studio        # Open Drizzle Studio GUI

# Building
pnpm build:mac        # Build for macOS
```

### Testing Notes Manually

1. Start the dev server: `pnpm dev`
2. Select a vault folder in the app
3. Create notes via the UI or terminal:
   ```bash
   # Create a test note directly
   echo '---
   id: "test12345678"
   title: "Test Note"
   created: "2025-12-23T10:00:00.000Z"
   modified: "2025-12-23T10:00:00.000Z"
   tags: ["test"]
   ---

   # Test Note

   This is a test note with [[Wiki Link]].
   ' > ~/my-vault/notes/Test\ Note.md
   ```
4. The app should detect the new file and update the UI

### Debugging

```typescript
// Enable verbose logging in main process
console.log('[notes]', 'Creating note:', input)

// Check database state
pnpm db:studio  // Opens web UI for SQLite

// Check file system
ls -la ~/my-vault/notes/
cat ~/my-vault/notes/My\ Note.md
```

## Code Patterns

### Error Handling

```typescript
// Main process - use NoteError
import { NoteError } from '@/lib/errors'

if (!note) {
  throw new NoteError('Note not found', 'NOT_FOUND', { id })
}

// Renderer - handle errors gracefully
try {
  await notesService.update(input)
} catch (error) {
  if (error.code === 'NOT_FOUND') {
    toast.error('Note was deleted')
  } else {
    toast.error('Failed to save note')
  }
}
```

### Atomic File Operations

```typescript
// Always use atomicWrite for note content
import { atomicWrite } from '@/vault/file-ops'

// This writes to temp file then renames (crash-safe)
await atomicWrite(notePath, content)
```

### Debounced Auto-Save

```typescript
import { useDebouncedCallback } from 'use-debounce'

const debouncedSave = useDebouncedCallback(
  async (content: string) => {
    await notesService.update({ id: noteId, content })
    setSaveStatus('saved')
  },
  1000 // 1 second delay
)

// On editor change
const handleMarkdownChange = useCallback((markdown: string) => {
  setSaveStatus('saving')
  debouncedSave(markdown)
}, [debouncedSave])
```

## What's Already Built vs What's Needed

### Backend (90% Complete)
- ✅ Note CRUD (create, read, update, delete, rename, move)
- ✅ Tags management
- ✅ Wiki link tracking & backlinks
- ✅ Folder operations
- ✅ Full-text search
- ✅ File watching
- ⚠️ Properties tables (not created yet)
- ⚠️ Properties sync layer (not implemented)
- ⚠️ Attachment upload handler (not implemented)

### Frontend (70% Complete)
- ✅ BlockNote editor with markdown support
- ✅ Title + emoji picker
- ✅ Tags input with autocomplete UI
- ✅ Properties panel with 8 type editors
- ✅ Backlinks UI (needs backend wiring)
- ✅ Outline navigation
- ⚠️ Wiki link autocomplete (not implemented)
- ⚠️ SaveStatus component (not created)
- ⚠️ Backend wiring for properties
- ⚠️ Replace demo data in backlinks/related notes

## Next Steps

After setting up the development environment:

1. **Explore existing code**: Read through `use-notes.ts` and `notes.ts`
2. **Run the app**: Create and edit some notes to understand the flow
3. **Check the spec**: Review `specs/003-notes/spec.md` for requirements
4. **Start with Foundation**: Complete T003-T023 (properties tables + sync layer)
5. **Wire existing UI**: Connect UI callbacks to backend services

## Resources

- [BlockNote Documentation](https://www.blocknotejs.org/docs)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
- [Electron IPC Guide](https://www.electronjs.org/docs/latest/tutorial/ipc)
- [Zod Documentation](https://zod.dev)
