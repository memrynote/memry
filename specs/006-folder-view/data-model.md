# Data Model: Folder View (Bases) System

**Feature**: Database-like table view for folders (similar to Obsidian Bases)
**Storage**: `.folder.md` files (YAML frontmatter) with optional `index.db` cache

---

## Overview

The Folder View system provides a spreadsheet-like interface for viewing and managing notes within folders. Configuration is stored in `.folder.md` files alongside notes, making it portable and sync-friendly.

---

## Storage Architecture

```
vault/
├── notes/
│   ├── projects/
│   │   ├── .folder.md          ← View config for "projects" folder
│   │   ├── project-a.md
│   │   ├── project-b.md
│   │   └── 2024/
│   │       ├── .folder.md      ← View config for "projects/2024" folder
│   │       └── q1-review.md
│   └── .folder.md              ← View config for root notes folder (optional)
└── .memry/
    └── index.db
        └── folder_view_cache   ← Performance cache (rebuildable from .folder.md)
```

### Why `.folder.md`?

1. **Portable** - Syncs with vault (Dropbox, Git, iCloud)
2. **Vault-native** - Follows Obsidian/markdown philosophy
3. **User-editable** - Power users can edit YAML directly
4. **Survives reindex** - File-based, not cache-dependent
5. **Already exists** - Infrastructure for `.folder.md` is in place

---

## `.folder.md` Schema

### Full Example

```yaml
# notes/projects/.folder.md
---
# Existing fields (template configuration)
template: project-template
inherit: true

# ============================================================================
# NEW: Folder View Configuration
# ============================================================================

# Global formulas (computed columns available to all views)
formulas:
  days_until_due: 'dateDiff(due_date, today(), "days")'
  is_overdue: 'due_date < today() && status != "done"'
  price_formatted: 'if(price, "$" + price.toFixed(2), "N/A")'

# Property display customization (applies to all views)
properties:
  status:
    displayName: 'Status'
    color: true
  priority:
    displayName: 'Priority'
  due_date:
    displayName: 'Due Date'
  formula.days_until_due:
    displayName: 'Days Left'
  formula.is_overdue:
    displayName: 'Overdue?'

# Column summaries (aggregations)
summaries:
  price:
    type: sum
    label: 'Total'
  priority:
    type: average
    label: 'Avg Priority'
  status:
    type: countBy
    label: 'By Status'

# Multiple named views
views:
  - name: 'All Projects'
    type: table
    default: true

    columns:
      - id: title
        width: 250
      - id: folder
        width: 120
      - id: status
        width: 100
      - id: priority
        width: 80
      - id: due_date
        width: 120
      - id: formula.days_until_due
        width: 100
      - id: tags
        width: 150
      - id: modified
        width: 130

    order:
      - property: modified
        direction: desc

    limit: 100

  - name: 'Active Only'
    type: table

    columns:
      - id: title
        width: 300
      - id: priority
        width: 80
      - id: due_date
        width: 120
      - id: formula.days_until_due
        width: 100

    filters:
      and:
        - status != "done"
        - status != "archived"
        - or:
            - priority >= 3
            - formula.is_overdue == true

    order:
      - property: priority
        direction: desc
      - property: due_date
        direction: asc

  - name: 'By Status'
    type: table

    groupBy:
      property: status
      direction: asc
      collapsed: false

    columns:
      - id: title
        width: 300
      - id: priority
        width: 80
      - id: modified
        width: 130

    order:
      - property: priority
        direction: desc

  - name: 'Overdue Items'
    type: table

    filters:
      and:
        - formula.is_overdue == true

    order:
      - property: due_date
        direction: asc

    showSummaries: true
---
```

---

## Schema Definitions

### Root Level

```typescript
interface FolderConfig {
  // Existing fields
  template?: string
  inherit?: boolean

  // NEW: View configuration
  formulas?: Record<string, string>
  properties?: Record<string, PropertyDisplay>
  summaries?: Record<string, SummaryConfig>
  views?: ViewConfig[]
}
```

### Formulas

Computed columns using expression syntax.

```typescript
// Key is formula name (referenced as "formula.{name}")
// Value is expression string
type Formulas = Record<string, string>
```

**Supported Expression Functions:**

- `today()` - Current date
- `now()` - Current datetime
- `dateDiff(date1, date2, unit)` - Difference between dates
- `if(condition, trueVal, falseVal)` - Conditional
- `coalesce(val1, val2, ...)` - First non-null value
- `concat(str1, str2, ...)` - String concatenation
- `round(num, decimals)` - Round number
- `toFixed(num, decimals)` - Format number
- `lower(str)`, `upper(str)` - Case conversion
- `contains(str, search)` - String contains
- `startsWith(str, prefix)` - String starts with
- `length(str|array)` - Length of string or array

**Available Variables:**

- All note properties by name (e.g., `status`, `priority`)
- `file.name` - Filename without extension
- `file.path` - Full path
- `file.folder` - Parent folder
- `file.created` - Creation date
- `file.modified` - Modified date
- `file.size` - File size in bytes
- `file.ext` - File extension
- `note.wordCount` - Word count
- `note.tags` - Array of tags

### Property Display

Customize how properties appear in views.

```typescript
interface PropertyDisplay {
  /** Custom display name for column header */
  displayName?: string

  /** Show color for select/status properties */
  color?: boolean

  /** Date format for date properties */
  dateFormat?: string // e.g., "MMM d, yyyy"

  /** Number format */
  numberFormat?: string // e.g., "0.00" or "$0,0.00"

  /** Hide this property from column selector */
  hidden?: boolean
}
```

### Summaries

Column aggregation configurations.

```typescript
interface SummaryConfig {
  /** Aggregation type */
  type: 'sum' | 'average' | 'min' | 'max' | 'count' | 'countBy' | 'countUnique' | 'custom'

  /** Display label */
  label?: string

  /** Custom expression (for type: 'custom') */
  expression?: string // e.g., 'values.filter(v => v > 0).length'
}
```

### View Configuration

A single view definition.

```typescript
interface ViewConfig {
  /** View name (displayed in view switcher) */
  name: string

  /** View type */
  type: 'table' | 'grid' | 'list' | 'kanban'

  /** Is this the default view? */
  default?: boolean

  /** Column definitions */
  columns?: ColumnConfig[]

  /** Filter expression */
  filters?: FilterExpression

  /** Sort order (multi-column) */
  order?: OrderConfig[]

  /** Grouping configuration */
  groupBy?: GroupByConfig

  /** Row limit */
  limit?: number

  /** Show summary row */
  showSummaries?: boolean
}
```

### Column Configuration

```typescript
interface ColumnConfig {
  /** Property ID or "formula.{name}" */
  id: string

  /** Column width in pixels */
  width?: number

  /** Override display name (takes precedence over properties.{id}.displayName) */
  displayName?: string

  /** Show summary for this column */
  showSummary?: boolean

  /** Custom summary type (overrides global summaries) */
  summary?: SummaryConfig
}
```

### Filter Expression

Supports complex nested AND/OR/NOT logic.

```typescript
type FilterExpression =
  | string // Simple expression: 'status == "done"'
  | { and: FilterExpression[] } // All must match
  | { or: FilterExpression[] } // Any must match
  | { not: FilterExpression } // Negate

// Expression syntax examples:
// 'status == "done"'
// 'priority >= 3'
// 'tags contains "work"'
// 'due_date < today()'
// 'formula.is_overdue == true'
// 'file.folder == "projects/2024"'
```

**Filter Operators:**

- `==`, `!=` - Equality
- `>`, `>=`, `<`, `<=` - Comparison
- `contains`, `notContains` - Array/string contains
- `startsWith`, `endsWith` - String matching
- `isEmpty`, `isNotEmpty` - Null/empty check
- `matches` - Regex match

### Order Configuration

Multi-column sorting.

```typescript
interface OrderConfig {
  /** Property or formula to sort by */
  property: string

  /** Sort direction */
  direction: 'asc' | 'desc'
}
```

### Group By Configuration

```typescript
interface GroupByConfig {
  /** Property to group by */
  property: string

  /** Group sort direction */
  direction?: 'asc' | 'desc'

  /** Start with groups collapsed */
  collapsed?: boolean

  /** Show group summaries */
  showSummary?: boolean
}
```

---

## Cache Table (index.db)

For performance, parsed configs are cached in `index.db`.

```sql
CREATE TABLE folder_view_cache (
  path TEXT PRIMARY KEY,
  config_hash TEXT NOT NULL,      -- Hash of .folder.md content for invalidation
  parsed_config TEXT NOT NULL,    -- Parsed JSON config
  cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_folder_view_cache_hash ON folder_view_cache(config_hash);
```

### Cache Strategy

1. **On folder view open**: Check cache by path
2. **If cached**: Compare `config_hash` with current `.folder.md` hash
3. **If valid**: Use cached `parsed_config`
4. **If invalid/missing**: Parse `.folder.md`, update cache
5. **On config save**: Update `.folder.md` and cache simultaneously

---

## Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FOLDER VIEW SYSTEM                                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────┐         ┌─────────────────────┐
│    .folder.md       │         │     note_cache      │
│  (YAML frontmatter) │         ├─────────────────────┤
├─────────────────────┤         │ id (PK)             │
│ template            │◄───────▶│ path                │
│ inherit             │  query  │ title               │
│ formulas            │   by    │ emoji               │
│ properties          │  folder │ created_at          │
│ summaries           │         │ modified_at         │
│ views[]             │         │ word_count          │
│   ├─ name           │         └─────────────────────┘
│   ├─ type           │                   │
│   ├─ columns[]      │                   │ 1:N
│   ├─ filters        │                   ▼
│   ├─ order[]        │        ┌─────────────────────┐
│   ├─ groupBy        │        │   note_properties   │
│   └─ summaries      │        ├─────────────────────┤
└─────────────────────┘        │ note_id (FK)        │
          │                    │ name                │
          │ cached in          │ value (JSON)        │
          ▼                    │ type                │
┌─────────────────────┐        └─────────────────────┘
│ folder_view_cache   │                   │
│     (index.db)      │                   │ N:1
├─────────────────────┤                   ▼
│ path (PK)           │        ┌─────────────────────┐
│ config_hash         │        │ property_definitions│
│ parsed_config       │        ├─────────────────────┤
│ cached_at           │        │ name (PK)           │
└─────────────────────┘        │ type                │
                               │ options (JSON)      │
                               │ default_value       │
                               │ color               │
                               └─────────────────────┘
```

---

## Query Patterns

### List Notes with Properties (Recursive)

Get all notes in a folder and its subfolders with their property values.

```sql
SELECT
  nc.id,
  nc.path,
  nc.title,
  nc.emoji,
  nc.created_at,
  nc.modified_at,
  nc.word_count,
  -- Extract relative folder path
  CASE
    WHEN nc.path LIKE 'notes/' || :folderPath || '/%/%'
    THEN SUBSTR(nc.path, LENGTH('notes/' || :folderPath || '/') + 1,
         INSTR(SUBSTR(nc.path, LENGTH('notes/' || :folderPath || '/') + 1), '/') - 1)
    ELSE '/'
  END as relative_folder,
  -- Aggregate tags
  GROUP_CONCAT(DISTINCT nt.tag) as tags,
  -- Get properties as JSON
  (
    SELECT json_group_object(np.name, np.value)
    FROM note_properties np
    WHERE np.note_id = nc.id
  ) as properties
FROM note_cache nc
LEFT JOIN note_tags nt ON nc.id = nt.note_id
WHERE nc.path LIKE 'notes/' || :folderPath || '/%'
  AND nc.date IS NULL  -- Exclude journal entries
GROUP BY nc.id
ORDER BY nc.modified_at DESC
LIMIT :limit OFFSET :offset
```

### Get Available Properties

Get all property names used in notes within a folder (for column selector).

```sql
SELECT
  np.name,
  pd.type,
  COUNT(DISTINCT np.note_id) as usage_count
FROM note_properties np
JOIN note_cache nc ON np.note_id = nc.id
LEFT JOIN property_definitions pd ON np.name = pd.name
WHERE nc.path LIKE 'notes/' || :folderPath || '/%'
  AND nc.date IS NULL
GROUP BY np.name
ORDER BY usage_count DESC
```

---

## File Operations

### Read Folder Config

```typescript
async function readFolderViewConfig(folderPath: string): Promise<FolderConfig | null> {
  const configPath = path.join(notesDir, folderPath, '.folder.md')

  if (!existsSync(configPath)) {
    return null
  }

  const content = await fs.readFile(configPath, 'utf-8')
  const { data } = matter(content)

  return parseFolderConfig(data)
}
```

### Write Folder Config

```typescript
async function writeFolderViewConfig(folderPath: string, config: FolderConfig): Promise<void> {
  const configPath = path.join(notesDir, folderPath, '.folder.md')

  // Read existing content to preserve body
  let existingBody = ''
  if (existsSync(configPath)) {
    const existing = await fs.readFile(configPath, 'utf-8')
    const { content } = matter(existing)
    existingBody = content
  }

  // Serialize with gray-matter
  const output = matter.stringify(existingBody, config)
  await fs.writeFile(configPath, output, 'utf-8')

  // Update cache
  await updateFolderViewCache(folderPath, config)
}
```

---

## Cascade Behaviors

### On Folder Rename

```typescript
async function onFolderRenamed(oldPath: string, newPath: string): Promise<void> {
  // .folder.md moves with the folder automatically (it's inside)
  // Just invalidate/update cache
  await db.delete(folderViewCache).where(eq(folderViewCache.path, oldPath))
}
```

### On Folder Delete

```typescript
async function onFolderDeleted(folderPath: string): Promise<void> {
  // .folder.md deleted with folder automatically
  // Clean up cache
  await db
    .delete(folderViewCache)
    .where(or(eq(folderViewCache.path, folderPath), like(folderViewCache.path, `${folderPath}/%`)))
}
```

---

## Default Configuration

When a folder has no `.folder.md` or no `views` section:

```typescript
const DEFAULT_VIEW: ViewConfig = {
  name: 'Default',
  type: 'table',
  default: true,
  columns: [
    { id: 'title', width: 250 },
    { id: 'folder', width: 120 },
    { id: 'tags', width: 150 },
    { id: 'modified', width: 130 }
  ],
  order: [{ property: 'modified', direction: 'desc' }]
}
```

---

## Built-in Columns

These columns are always available regardless of note properties.

| Column ID   | Display Name | Type        | Source                          |
| ----------- | ------------ | ----------- | ------------------------------- |
| `title`     | Title        | text        | `note_cache.title`              |
| `folder`    | Folder       | text        | Computed from `note_cache.path` |
| `tags`      | Tags         | multiselect | `note_tags` table               |
| `created`   | Created      | date        | `note_cache.created_at`         |
| `modified`  | Modified     | date        | `note_cache.modified_at`        |
| `wordCount` | Words        | number      | `note_cache.word_count`         |

---

## Property Type Rendering

How each property type should be rendered in the table.

| Type          | Render                                   | Sort           | Filter Operators                      |
| ------------- | ---------------------------------------- | -------------- | ------------------------------------- |
| `text`        | Plain text, ellipsis overflow            | Alphabetic     | equals, contains, startsWith, isEmpty |
| `number`      | Right-aligned, formatted                 | Numeric        | equals, gt, gte, lt, lte, isEmpty     |
| `checkbox`    | Checkmark icon (green ✓ / gray ✗)        | Boolean        | isChecked, isUnchecked                |
| `date`        | Relative date (Today, Yesterday, Dec 25) | Chronological  | equals, gt, lt, isEmpty               |
| `select`      | Colored badge                            | Alphabetic     | equals, notEquals, isEmpty            |
| `multiselect` | Multiple colored badges                  | By first value | contains, isEmpty                     |
| `url`         | Clickable link with external icon        | Alphabetic     | contains, isEmpty                     |
| `rating`      | Star icons (★★★☆☆)                       | Numeric        | equals, gte, lte                      |

---

## Query Execution

### Filter Evaluation

```typescript
function evaluateFilter(note: Note, filter: FilterExpression, context: EvalContext): boolean {
  if (typeof filter === 'string') {
    return evaluateExpression(filter, note, context)
  }

  if ('and' in filter) {
    return filter.and.every((f) => evaluateFilter(note, f, context))
  }

  if ('or' in filter) {
    return filter.or.some((f) => evaluateFilter(note, f, context))
  }

  if ('not' in filter) {
    return !evaluateFilter(note, filter.not, context)
  }

  return true
}
```

### Formula Evaluation

```typescript
function evaluateFormula(expression: string, note: Note, context: EvalContext): unknown {
  // Parse expression into AST
  const ast = parseExpression(expression)

  // Evaluate with note properties as variables
  return evaluate(ast, {
    ...note.properties,
    file: {
      name: note.title,
      path: note.path,
      folder: note.folder,
      created: note.created,
      modified: note.modified
    },
    note: {
      wordCount: note.wordCount,
      tags: note.tags
    },
    // Built-in functions
    today: () => new Date(),
    now: () => new Date(),
    dateDiff: (d1, d2, unit) => /* ... */,
    // ... other functions
  })
}
```

---

## Implementation Phases

### Phase 1 (MVP): Basic Table View

- Single default view per folder
- Basic columns (title, folder, tags, modified)
- Simple single-column sorting
- Store in `.folder.md`
- No filters, no formulas

### Phase 2: Column Customization

- Add/remove columns
- Resize columns
- Custom display names
- Multi-column sorting

### Phase 3: Filtering

- Simple property filters
- AND/OR/NOT nesting
- Filter persistence

### Phase 4: Multiple Views

- Named views
- View switcher UI
- Default view selection

### Phase 5: Formulas & Summaries

- Computed columns
- Expression parser
- Column summaries
- Summary row

### Phase 6: Advanced Features

- Group by
- Kanban view
- Grid/gallery view
- Export views

---

## Notes

1. **Expression Safety**: Formula expressions should be sandboxed - no access to filesystem, network, or dangerous operations.

2. **Performance**: For folders with 1000+ notes:
   - Evaluate formulas lazily (only visible rows)
   - Cache formula results
   - Use virtual scrolling

3. **Sync Conflicts**: If `.folder.md` is modified externally while app is open, detect and prompt user to reload.

4. **Backward Compatibility**: Old `.folder.md` files without `views` section should still work (template/inherit fields).
