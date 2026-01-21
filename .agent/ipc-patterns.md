# IPC Patterns

Use `ipcMain.handle` + `ipcRenderer.invoke` with Zod validation for all IPC communication.

## Adding a New IPC Handler

### 1. Define Contract

`src/shared/contracts/<domain>-api.ts`:

```typescript
import { z } from 'zod'

export const NoteCreateSchema = z.object({
  title: z.string().min(1),
  content: z.string().optional()
})

export type NoteCreateInput = z.infer<typeof NoteCreateSchema>
```

### 2. Register Handler

`src/main/ipc/<domain>-handlers.ts`:

```typescript
import { ipcMain } from 'electron'
import { createValidatedHandler } from './validate'
import { NoteCreateSchema } from '@shared/contracts/notes-api'

export function registerNotesHandlers() {
  ipcMain.handle(
    'notes:create',
    createValidatedHandler(NoteCreateSchema, async (input) => {
      return notesService.create(input)
    })
  )
}
```

### 3. Register in Index

`src/main/ipc/index.ts`:

```typescript
import { registerNotesHandlers } from './notes-handlers'
registerNotesHandlers()
```

### 4. Expose in Preload

`src/preload/index.ts`:

```typescript
const api = {
  notes: {
    create: (input: NoteCreateInput) => ipcRenderer.invoke('notes:create', input)
  }
}
```

### 5. Add Types

`src/preload/index.d.ts`:

```typescript
interface Api {
  notes: {
    create: (input: NoteCreateInput) => Promise<Note>
  }
}
```

### 6. Create Service

`src/renderer/src/services/notes-service.ts`:

```typescript
export const notesService = {
  create: (input: NoteCreateInput) => window.api.notes.create(input)
}
```

### 7. Create Hook

`src/renderer/src/hooks/use-notes.ts`:

```typescript
export function useCreateNote() {
  return useMutation({
    mutationFn: notesService.create
  })
}
```

## Error Handling

Main process errors use custom error classes:

```typescript
import { NoteError, NoteErrorCode } from '../lib/errors'
throw new NoteError('Note not found', NoteErrorCode.NOT_FOUND, noteId)
```

Renderer services return `{ success, error }` pattern.
