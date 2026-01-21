# Testing

## Commands

```bash
pnpm test                 # Run all tests once
pnpm vitest <path>        # Single test file
pnpm vitest <path> -t "should create"  # Single test by name
pnpm test:watch           # Watch mode
pnpm test:main            # Main process tests only
pnpm test:renderer        # Renderer process tests only
pnpm test:e2e             # Playwright E2E tests
```

## Structure

Tests are **co-located** with source files:

```
src/main/vault/notes.ts
src/main/vault/notes.test.ts  # Co-located test
```

## Test Utilities

### Main Process (in-memory database)

```typescript
import { createTestDataDb } from '@tests/utils/test-db'
const db = createTestDataDb()
```

### Renderer (wrapped rendering with providers)

```typescript
import { renderWithProviders, configureMockApi } from '@tests/utils/render'
configureMockApi({ 'notes.list': mockNotes })
renderWithProviders(<NotesList />)
```

## Mocking Patterns

```typescript
// Mock Electron APIs
vi.mock('electron')

// Mock window.api for renderer tests
window.api = { notes: { list: vi.fn().mockResolvedValue([]) } }

// Spy on internal services
vi.spyOn(notesService, 'create').mockResolvedValue({ success: true })
```
