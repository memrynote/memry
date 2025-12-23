# Research: Notes System

**Feature**: 003-notes
**Date**: 2025-12-23
**Status**: Complete
**Updated**: 2025-12-23 - Aligned with actual codebase (BlockNote, not Tiptap)

## Executive Summary

This research consolidates technology decisions for the Memry notes system. The existing codebase already implements ~90% of the backend infrastructure. Key decisions focus on leveraging existing patterns and filling UI gaps.

---

## 1. Rich Text Editor

### Decision: BlockNote (Already Implemented)

**Rationale**: BlockNote is already integrated in `src/renderer/src/components/note/content-area/ContentArea.tsx`. It provides a Notion-like block editing experience with excellent UX.

**Current Implementation**:
- `@blocknote/core` v0.44.2
- `@blocknote/react` v0.44.2
- `@blocknote/shadcn` v0.44.2

**Alternatives Considered**:
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **BlockNote** | Notion-like blocks, excellent UX, simpler API | Less mature than Tiptap | **SELECTED** (Already integrated) |
| Tiptap | Very extensible, ProseMirror-based | More boilerplate, migration needed | Rejected |
| Lexical (Meta) | Fast, modern | Less mature ecosystem, migration cost | Rejected |
| Slate.js | Highly customizable | More boilerplate, migration cost | Rejected |

**Existing Features**:
- Block-based editing (paragraphs, headings, lists, code blocks)
- Markdown serialization via `editor.blocksToMarkdownLossy()`
- Markdown parsing via `editor.tryParseMarkdownToBlocks()`
- Heading extraction for outline navigation
- Selection formatting toolbar
- Slash commands for block insertion
- Link click handling

**Extensions Needed**:
- Custom WikiLink inline content (using `createInlineContentSpec`)
- Custom FileBlock for attachments (using `createBlockSpec`)

---

## 2. Content Storage Format

### Decision: Markdown with YAML Frontmatter

**Rationale**: Constitution principle VI mandates file system as source of truth. Markdown is universal, editable in any text editor, and already implemented.

**Storage Pattern**:
```markdown
---
id: "a1b2c3d4e5f6"
title: "Note Title"
created: "2025-12-23T10:00:00.000Z"
modified: "2025-12-23T10:30:00.000Z"
tags:
  - work
  - research
emoji: "📝"
properties:
  status: "draft"
  priority: 3
  due: "2025-12-25"
---

# Note content here

This is [[wiki-linked]] content with #inline-tags.
```

**Implementation Notes**:
- BlockNote → Markdown: Use `editor.blocksToMarkdownLossy()`
- Markdown → BlockNote: Use `editor.tryParseMarkdownToBlocks()`
- Frontmatter parsed with `gray-matter`

---

## 3. Database Caching

### Decision: SQLite with Drizzle ORM (Already Implemented)

**Rationale**: Already implemented in `src/shared/db/schema/notes-cache.ts`. The cache is explicitly rebuildable per constitution principle VI.

**Existing Schema**:
```typescript
// noteCache - metadata cache
{ id, path, title, contentHash, wordCount, createdAt, modifiedAt, indexedAt }

// noteTags - many-to-many
{ noteId, tag }

// noteLinks - wiki link tracking
{ sourceId, targetId, targetTitle }
```

**Enhancements Needed**:
- Add `emoji` column to noteCache
- Add `noteProperties` table for custom properties
- Add `propertyDefinitions` table for schema

---

## 4. Full-Text Search

### Decision: SQLite FTS5 (Already Implemented)

**Rationale**: Already implemented in `src/main/database/fts.ts`. FTS5 provides excellent performance for local search.

**Existing Implementation**:
```sql
CREATE VIRTUAL TABLE fts_notes USING fts5(
  id UNINDEXED,
  title,
  content,
  tags,
  tokenize='porter unicode61'
);
```

**Current Behavior**:
- Automatic triggers sync title on INSERT/DELETE
- Manual `updateFtsContent()` required for content/tags
- Porter stemmer for English language support

**No Changes Needed**: Current implementation meets requirements.

---

## 5. File Watching

### Decision: chokidar (Already Implemented)

**Rationale**: Already implemented in `src/main/vault/watcher.ts`. Provides reliable cross-platform file watching.

**Existing Features**:
- Watches `notes/` and `journal/` directories
- 100ms debounce per file
- Emits events with `source: 'external'` flag
- Rename detection via UUID matching (500ms window)

**No Changes Needed**: Current implementation meets requirements.

---

## 6. Wiki Link Resolution

### Decision: Two-Phase Resolution (Already Implemented)

**Rationale**: Already implemented in `src/shared/db/queries/notes.ts`.

**Resolution Strategy**:
1. Exact title match
2. Case-insensitive fallback
3. Store `targetTitle` always, resolve `targetId` when possible

**Backlink Computation**:
- `getIncomingLinks(db, noteId)` returns all notes linking TO this note
- Context snippets extracted during indexing

**Enhancement Needed**: Context snippet extraction is stubbed (returns empty string).

---

## 7. Auto-Save Strategy

### Decision: Debounced Save (500ms currently, spec requires 1s)

**Rationale**: Spec FR-003 requires "save automatically 1 second after user stops typing."

**Current Implementation** (in `note.tsx`):
```typescript
const debouncedSave = useCallback(
  debounce(async (markdown: string) => {
    await updateNote({ id: noteId, content: markdown })
  }, 500) // TODO: Increase to 1000ms per spec
)
```

**Enhancement Needed**:
- Increase debounce to 1000ms
- Add SaveStatus component (Saving.../Saved/Error)
- Add save queue for rapid edits

---

## 8. Custom Properties

### Decision: Frontmatter + Typed Schema

**Rationale**: Spec FR-027-030 require multiple property types with appropriate controls.

**Property Types**:
| Type | Storage | UI Control |
|------|---------|------------|
| text | string | Text input |
| number | number | Number input |
| checkbox | boolean | Checkbox |
| date | ISO string | Date picker |
| select | string | Dropdown |
| multiselect | string[] | Multi-select |
| url | string | URL input with open button |
| rating | number (1-5) | Star rating |

**Existing UI Components** (in `info-section/editors/`):
- ✅ TextEditor
- ✅ LongTextEditor
- ✅ NumberEditor
- ✅ DateEditor
- ✅ CheckboxEditor
- ✅ SelectEditor
- ✅ RatingEditor
- ✅ UrlEditor

**Backend Needed**:
- `noteProperties` table (cache)
- `propertyDefinitions` table (schema)
- Properties sync layer (frontmatter ↔ DB)

---

## 9. Attachments

### Decision: Vault Folder + Markdown References

**Rationale**: Spec FR-031-034 require drag-drop upload with inline display.

**Storage Pattern**:
- Files stored in `vault/attachments/{nanoid}-{filename}`
- Referenced in markdown as `![alt](../attachments/{filename})`
- Unique prefix prevents collisions

**Upload Flow**:
1. User drops file on editor
2. Copy file to attachments folder with unique name
3. Insert markdown image/link syntax
4. Render inline for images (BlockNote handles this)

---

## 10. Performance Optimizations

### Decision: Progressive Loading + Virtualization

**Rationale**: Spec SC-001-010 set specific performance targets.

**Strategies**:
| Target | Strategy |
|--------|----------|
| 100ms note open | Lazy load backlinks; cache parsed frontmatter |
| 50ms search | FTS5 with proper indexes; limit results |
| 50+ backlinks | Progressive loading with virtualization |
| 10K index rebuild | Batch inserts (100 notes/chunk); progress events |

---

## 11. Accessibility

### Decision: WCAG 2.1 AA Compliance

**Rationale**: Constitution mandates full keyboard navigation and screen reader support.

**Implementation Checklist**:
- [ ] All interactive elements have focus states
- [ ] Keyboard shortcuts documented and consistent
- [ ] ARIA labels on custom components
- [ ] Respect `prefers-reduced-motion`
- [ ] High contrast mode support
- [ ] Screen reader announcements for state changes

---

## 12. Existing UI Components Inventory

These components already exist and are UI-complete:

| Component | Location | Status |
|-----------|----------|--------|
| NoteLayout | `components/note/note-layout.tsx` | ✅ Complete |
| RightSidebar | `components/note/right-sidebar.tsx` | ✅ Complete |
| OutlineEdge | `components/note/outline-edge.tsx` | ✅ Complete |
| ContentArea | `components/note/content-area/` | ✅ Complete |
| NoteTitle + Emoji | `components/note/note-title/` | ✅ Complete |
| TagsRow | `components/note/tags-row/` | ✅ Complete |
| InfoSection | `components/note/info-section/` | ✅ Complete (8 editors) |
| BacklinksSection | `components/note/backlinks/` | ⚠️ Demo data |
| RelatedNotesTab | `components/note/related-notes/` | ⚠️ Demo data |
| LinkedTasksSection | `components/note/linked-tasks/` | ✅ Wired |
| AIAgentTab | `components/note/ai-agent/` | ⚠️ Demo data |

---

## 13. Future Considerations (Deferred)

These items are noted but explicitly out of scope for 003-notes:

| Feature | Phase | Notes |
|---------|-------|-------|
| Encryption | 004-encryption | libsodium-wrappers, keytar, bip39 |
| Sync | 005-sync | Hono.js on Cloudflare Workers |
| AI Features | 006-ai | OpenAI embeddings + Ollama local |
| Real-time collaboration | v2 | CRDT-based |
| Templates | Future P3 | Basic implementation possible now |
| Version history | Future P3 | Git-based or snapshot approach |

---

## Resolved Questions

| Question | Resolution |
|----------|------------|
| Store HTML or Markdown? | Markdown (constitution requires editable files) |
| Rich text → MD fidelity? | Accept minor formatting loss for portability |
| Tiptap vs BlockNote? | **BlockNote** (already integrated, Notion-like UX) |
| Property schema storage? | Separate table, not in frontmatter |
| Attachment deduplication? | Not needed (unique prefix handles) |

---

## Dependencies (Already Installed)

```json
{
  "@blocknote/core": "^0.44.2",
  "@blocknote/react": "^0.44.2",
  "@blocknote/shadcn": "^0.44.2",
  "@emoji-mart/react": "^1.1.1",
  "@emoji-mart/data": "^1.2.1",
  "gray-matter": "^4.0.3",
  "use-debounce": "^10.0.0"
}
```

**Note**: Tiptap packages may still be installed for journal editor but are NOT used for notes. BlockNote is the notes editor.
