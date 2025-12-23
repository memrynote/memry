# Research: Notes System

**Feature**: 003-notes
**Date**: 2025-12-23
**Status**: Complete

## Executive Summary

This research consolidates technology decisions for the Memry notes system. The existing codebase already implements ~90% of the backend infrastructure. Key decisions focus on leveraging existing patterns and filling UI gaps.

---

## 1. Rich Text Editor

### Decision: Tiptap (Already Implemented)

**Rationale**: Tiptap is already integrated in `src/renderer/src/components/note/content-area/ContentArea.tsx` with wiki-link and tag extensions. Reusing this proven implementation reduces risk.

**Alternatives Considered**:
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Tiptap | Already integrated, extensible, ProseMirror-based | Learning curve for custom nodes | Rejected |
| BlockNote | Notion-like blocks, simpler API | Would require migration, less customizable |  **SELECTED**  |
| Lexical (Meta) | Fast, modern | Less mature ecosystem, migration cost | Rejected |
| Slate.js | Highly customizable | More boilerplate, migration cost | Rejected |

**Implementation Notes**:
- Existing extensions: StarterKit, Link, Placeholder, WikiLink, Tag
- Needed extensions: Table, Image, CodeBlock (syntax highlighting)
- Content stored as Markdown (via Tiptap markdown extension or custom serializer)

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

**Alternatives Considered**:
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Markdown + YAML | Universal, existing | Requires HTML→MD conversion | **SELECTED** |
| HTML files | Native Tiptap output | Not human-editable, lock-in | Rejected |
| JSON (Tiptap doc) | Full fidelity | Not human-readable, lock-in | Rejected |
| Dual format (MD + HTML) | Best of both | Sync complexity, 2x storage | Rejected |

**Conversion Strategy**:
- Tiptap → Markdown: Use `@tiptap/extension-markdown` or custom serializer
- Markdown → Tiptap: Parse on load, reconstruct ProseMirror document
- Preserve formatting fidelity for: headings, lists, bold, italic, code, links

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

**No Changes Needed**: Current implementation meets requirements.

---

## 7. Auto-Save Strategy

### Decision: Debounced Save (1 second)

**Rationale**: Spec FR-003 requires "save automatically 1 second after user stops typing."

**Implementation Pattern**:
```typescript
const debouncedSave = useDebouncedCallback(
  async (content: string) => {
    await notesService.update({ id: noteId, content })
  },
  1000 // 1 second delay
)

// On editor change
editor.on('update', ({ editor }) => {
  debouncedSave(editor.storage.markdown.getMarkdown())
})
```

**Error Handling**:
- Show "Saving..." indicator during save
- Show "Saved" on success (auto-hide after 2s)
- Show error toast on failure with retry button
- Queue saves if previous save in progress

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

**Schema Storage**:
```typescript
// propertyDefinitions table (index.db)
{
  name: string,          // "status", "priority"
  type: PropertyType,
  options?: string[],    // For select/multiselect
  defaultValue?: string
}
```

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
4. Render inline for images

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

## 12. Future Considerations (Deferred)

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
| Tiptap vs BlockNote? | Tiptap (already integrated, more flexible) |
| Property schema storage? | Separate table, not in frontmatter |
| Attachment deduplication? | Not needed (unique prefix handles) |

---

## Dependencies to Install

```bash
# Already installed (verify versions)
pnpm add @tiptap/react @tiptap/starter-kit @tiptap/extension-link

# May need to add
pnpm add @tiptap/extension-code-block-lowlight lowlight
pnpm add @tiptap/extension-table @tiptap/extension-table-row @tiptap/extension-table-cell @tiptap/extension-table-header
pnpm add use-debounce
pnpm add @emoji-mart/react @emoji-mart/data
```
