# Design: Note Properties System

**Feature**: 003-notes / Properties (US6)
**Date**: 2025-12-23
**Status**: Approved

## Problem Statement

T005 and T006 in tasks.md specify creating `noteProperties` and `propertyDefinitions` tables. This document clarifies the architecture for storing and syncing custom properties, particularly when users edit files externally.

## Design Decision: Hybrid Storage

**Follow the existing tag pattern**:

| Component | Source of Truth | Purpose |
|-----------|----------------|---------|
| Property VALUES | Frontmatter (YAML) | Portable, human-readable, external-edit friendly |
| Property CACHE | `noteProperties` table | Fast queries, filtering, sorting |
| Property SCHEMA | `propertyDefinitions` table | Vault-wide type definitions |

---

## 1. Frontmatter Storage (Source of Truth)

Properties live in the YAML frontmatter under a `properties` key:

```yaml
---
id: "a1b2c3d4e5f6"
title: "Project Planning"
created: "2025-12-23T10:00:00.000Z"
modified: "2025-12-23T10:30:00.000Z"
tags:
  - work
  - planning
properties:
  status: "in-progress"           # text (select)
  priority: 3                     # number
  completed: false                # checkbox
  due: "2025-12-25"              # date (ISO string)
  category: "engineering"         # select
  stakeholders:                   # multiselect
    - "Alice"
    - "Bob"
  docs: "https://docs.example.com" # url
  rating: 4                       # rating (1-5)
---

# Project Planning

Content here...
```

### Why Frontmatter?

1. **Constitution Compliance**: Principle VI mandates file system as source of truth
2. **Portability**: Works with any markdown editor (VS Code, Obsidian, Typora)
3. **Version Control**: Git diffs show property changes clearly
4. **Zero Lock-in**: Notes remain useful without the app
5. **Crash Recovery**: Properties survive database corruption

---

## 2. Database Schema (Cache + Definitions)

### noteProperties Table (Rebuildable Cache)

```typescript
export const noteProperties = sqliteTable('note_properties', {
  noteId: text('note_id')
    .notNull()
    .references(() => noteCache.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  value: text('value'),           // JSON-encoded for arrays
  type: text('type').notNull(),   // PropertyType enum
}, (table) => [
  primaryKey({ columns: [table.noteId, table.name] }),
  index('idx_note_properties_name').on(table.name),
  index('idx_note_properties_value').on(table.value)
])
```

**Key Points**:
- **Rebuildable**: Can be regenerated from frontmatter at any time
- **Cascades**: Deleted when note is deleted
- **Indexed**: Fast filtering by property name and value

### propertyDefinitions Table (Schema - NOT rebuildable)

```typescript
export const propertyDefinitions = sqliteTable('property_definitions', {
  name: text('name').primaryKey(),
  type: text('type').notNull(),          // PropertyType
  options: text('options'),               // JSON array for select/multiselect
  defaultValue: text('default_value'),
  color: text('color'),                   // Optional color for select options
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})
```

**Key Points**:
- **NOT rebuildable**: This is the source of truth for property schema
- **Vault-wide**: Same property name = same type across all notes
- **Options storage**: Select/multiselect options stored here, not in frontmatter

---

## 3. Type System

### Supported Property Types

```typescript
type PropertyType =
  | 'text'        // Free text
  | 'number'      // Numeric value
  | 'checkbox'    // Boolean true/false
  | 'date'        // ISO 8601 date string
  | 'select'      // Single value from options
  | 'multiselect' // Multiple values from options
  | 'url'         // URL string
  | 'rating'      // Number 1-5
```

### Type Mapping (Frontmatter → DB)

| YAML Type | Example | DB value Column | DB type Column |
|-----------|---------|-----------------|----------------|
| string | `"draft"` | `"draft"` | `text` or `select` |
| number | `3` | `"3"` | `number` |
| boolean | `true` | `"true"` | `checkbox` |
| array | `["a", "b"]` | `'["a","b"]'` | `multiselect` |
| ISO date | `"2025-12-25"` | `"2025-12-25"` | `date` |
| URL | `"https://..."` | `"https://..."` | `url` |

---

## 4. External Edit Handling

### Scenario: User Edits Frontmatter in VS Code

```
User edits file → chokidar detects → handleFileChange() → sync to DB
```

### Sync Flow (Extended from existing tag pattern)

```typescript
// In watcher.ts handleFileChange()

// Existing flow
const parsed = parseNote(content, relativePath)
const tags = extractTags(parsed.frontmatter)
setNoteTags(db, cached.id, tags)

// NEW: Properties sync
const properties = extractProperties(parsed.frontmatter)
setNoteProperties(db, cached.id, properties)

// Emit event includes properties
emitNoteEvent(NotesChannels.events.UPDATED, {
  id: cached.id,
  changes: {
    title,
    content: parsed.content,
    tags,
    properties,  // NEW
    modified: new Date(parsed.frontmatter.modified)
  },
  source: 'external'
})
```

### Type Inference for External Edits

When a user adds a new property externally without a definition:

```typescript
function inferPropertyType(name: string, value: unknown): PropertyType {
  // 1. Check existing definition
  const definition = getPropertyDefinition(db, name)
  if (definition) return definition.type

  // 2. Infer from value
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') {
    if (value >= 1 && value <= 5 && name.toLowerCase().includes('rating')) {
      return 'rating'
    }
    return 'number'
  }
  if (Array.isArray(value)) return 'multiselect'
  if (typeof value === 'string') {
    if (isISODate(value)) return 'date'
    if (isURL(value)) return 'url'
    return 'text'
  }
  return 'text'
}
```

### Auto-Definition Creation

When a new property is detected, auto-create a definition:

```typescript
function ensurePropertyDefinition(
  db: Database,
  name: string,
  inferredType: PropertyType
): void {
  const existing = getPropertyDefinition(db, name)
  if (!existing) {
    insertPropertyDefinition(db, {
      name,
      type: inferredType,
      options: null,
      defaultValue: null
    })
  }
}
```

---

## 5. Query Functions

### Set Note Properties (Sync from Frontmatter)

```typescript
export function setNoteProperties(
  db: Database,
  noteId: string,
  properties: Record<string, unknown>
): void {
  // Clear existing properties for this note
  db.delete(noteProperties)
    .where(eq(noteProperties.noteId, noteId))
    .run()

  // Insert new properties
  for (const [name, value] of Object.entries(properties)) {
    const type = inferPropertyType(name, value)
    ensurePropertyDefinition(db, name, type)

    db.insert(noteProperties)
      .values({
        noteId,
        name,
        value: JSON.stringify(value),
        type
      })
      .run()
  }
}
```

### Get Note Properties

```typescript
export function getNoteProperties(
  db: Database,
  noteId: string
): PropertyValue[] {
  const rows = db.select()
    .from(noteProperties)
    .where(eq(noteProperties.noteId, noteId))
    .all()

  return rows.map(row => ({
    name: row.name,
    value: JSON.parse(row.value),
    type: row.type as PropertyType
  }))
}
```

### Filter Notes by Property

```typescript
export function filterNotesByProperty(
  db: Database,
  propertyName: string,
  propertyValue: string
): NoteCache[] {
  return db.select()
    .from(noteCache)
    .innerJoin(
      noteProperties,
      eq(noteCache.id, noteProperties.noteId)
    )
    .where(
      and(
        eq(noteProperties.name, propertyName),
        eq(noteProperties.value, JSON.stringify(propertyValue))
      )
    )
    .all()
}
```

---

## 6. UI Integration

### Properties Panel Component

```tsx
function NoteProperties({ noteId }: { noteId: string }) {
  const { properties, updateProperty, addProperty } = useNoteProperties(noteId)
  const { definitions } = usePropertyDefinitions()

  return (
    <div className="space-y-2">
      {properties.map(prop => (
        <PropertyRow
          key={prop.name}
          property={prop}
          definition={definitions[prop.name]}
          onChange={(value) => updateProperty(prop.name, value)}
        />
      ))}
      <AddPropertyButton onClick={addProperty} />
    </div>
  )
}
```

### Property Input by Type

```tsx
function PropertyInput({ type, value, onChange, options }) {
  switch (type) {
    case 'text':
      return <Input value={value} onChange={onChange} />
    case 'number':
      return <Input type="number" value={value} onChange={onChange} />
    case 'checkbox':
      return <Checkbox checked={value} onCheckedChange={onChange} />
    case 'date':
      return <DatePicker value={value} onChange={onChange} />
    case 'select':
      return <Select value={value} options={options} onChange={onChange} />
    case 'multiselect':
      return <MultiSelect value={value} options={options} onChange={onChange} />
    case 'url':
      return <UrlInput value={value} onChange={onChange} />
    case 'rating':
      return <StarRating value={value} onChange={onChange} />
  }
}
```

---

## 7. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER ACTIONS                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  [App UI]                              [External Editor]                 │
│     │                                        │                           │
│     │ updateProperty()                       │ save file                 │
│     ▼                                        ▼                           │
│  notesService.update()              chokidar detects change              │
│     │                                        │                           │
│     ▼                                        ▼                           │
│  IPC: notes:update                   handleFileChange()                  │
└─────────────────────────────────────────────────────────────────────────┘
                    │                              │
                    ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         MAIN PROCESS                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    updateNote() / sync flow                       │   │
│  │                                                                   │   │
│  │  1. Merge frontmatter.properties with updates                    │   │
│  │  2. serializeNote() → write to file (atomic)                     │   │
│  │  3. setNoteProperties() → sync to DB cache                       │   │
│  │  4. emitNoteEvent() → notify renderer                            │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         STORAGE                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────┐    ┌─────────────────────────────────┐    │
│  │   MARKDOWN FILE         │    │   SQLite index.db               │    │
│  │   (Source of Truth)     │    │   (Cache + Definitions)         │    │
│  │                         │    │                                  │    │
│  │   ---                   │    │   noteProperties (cache)         │    │
│  │   properties:           │    │   ├─ noteId                      │    │
│  │     status: "draft"     │◄──►│   ├─ name: "status"              │    │
│  │     priority: 3         │    │   ├─ value: "draft"              │    │
│  │   ---                   │    │   └─ type: "select"              │    │
│  │                         │    │                                  │    │
│  │   Content here...       │    │   propertyDefinitions (schema)   │    │
│  │                         │    │   ├─ name: "status"              │    │
│  └─────────────────────────┘    │   ├─ type: "select"              │    │
│                                  │   └─ options: ["draft",...]      │    │
│                                  └─────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Edge Cases

### Case 1: Property Type Mismatch

**Scenario**: User has `status: "draft"` but then externally changes to `status: 123`

**Solution**: Accept the new value, keep the existing type definition. Log warning if type doesn't match. Don't corrupt user data.

```typescript
// In extractProperties()
const definition = getPropertyDefinition(db, name)
if (definition && !isValidForType(value, definition.type)) {
  console.warn(`[Properties] Type mismatch for ${name}: expected ${definition.type}`)
  // Store anyway - user's file is authoritative
}
```

### Case 2: Property Deleted Externally

**Scenario**: User removes a property from frontmatter

**Solution**: Property disappears from cache on next sync. Definition remains (might be used by other notes).

### Case 3: Conflicting External Edits

**Scenario**: User edits in VS Code while app has unsaved changes

**Solution**: File watcher detects change, emits `source: 'external'` event. UI shows conflict indicator. User can choose to reload or keep their version.

### Case 4: Index Rebuild

**Scenario**: User deletes index.db or runs rebuild command

**Solution**: Re-index all files, extract properties from frontmatter, rebuild `noteProperties` table. `propertyDefinitions` is also in index.db, so types will be re-inferred.

---

## 9. Updated Tasks

The original tasks T005 and T006 should be updated:

```markdown
## Phase 2: Foundational (Blocking Prerequisites)

### Database Schema & Migrations

- [ ] T004 Add `emoji` column to noteCache table in src/shared/db/schema/notes-cache.ts
- [ ] T005 Create noteProperties table (cache) in src/shared/db/schema/notes-cache.ts
- [ ] T006 Create propertyDefinitions table (schema) in src/shared/db/schema/notes-cache.ts
- [ ] T007 Generate and apply database migrations with `pnpm db:generate && pnpm db:push`

### Properties Query Layer (NEW - after T007)

- [ ] T007a Add extractProperties() function in src/main/vault/frontmatter.ts
- [ ] T007b Add setNoteProperties() query function in src/shared/db/queries/notes.ts
- [ ] T007c Add getNoteProperties() query function in src/shared/db/queries/notes.ts
- [ ] T007d Add inferPropertyType() utility in src/main/vault/frontmatter.ts
- [ ] T007e Add ensurePropertyDefinition() in src/shared/db/queries/notes.ts
- [ ] T007f Extend handleFileChange() to sync properties in src/main/vault/watcher.ts
- [ ] T007g Extend updateNote() to save properties to frontmatter in src/main/vault/notes.ts
```

---

## 10. Summary

| Question | Answer |
|----------|--------|
| Store properties where? | **Frontmatter** (source of truth) |
| Need DB? | **Yes** - for fast queries (cache) and schema (definitions) |
| External edit handling? | **Extend watcher.ts** - sync properties like tags |
| Type inference? | **Yes** - auto-infer types for externally-added properties |
| Breaking changes? | **None** - properties key is optional in frontmatter |

This design follows the existing architecture patterns (tags, links) and ensures data integrity while supporting external editing workflows.
