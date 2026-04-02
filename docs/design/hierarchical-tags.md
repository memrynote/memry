# Hierarchical Tags Design Brief

> Status: BRAINSTORM — awaiting user confirmation before implementation

## Summary

Extend the flat `#tag` system to support hierarchical `#parent/child` tags with implicit inheritance, tree sidebar UI, and cascading operations.

**Example**: `#movies/oscar`, `#movies/grammy` — clicking `movies` shows all movie notes; clicking `oscar` filters to just Oscar notes.

---

## Design Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Inheritance model | **Implicit** — `#movies/oscar` automatically belongs to `#movies` |
| 2 | Depth limit | **Unlimited** — UI collapses beyond 2-3 levels |
| 3 | Sidebar display | **Tree view** — collapsible parent → children |
| 4 | Parent-only tags | **Yes** — `#movies` can exist standalone AND have children |
| 5 | Autocomplete | **Yes** — typing `#movies/` suggests existing children |
| 6 | Color inheritance | **Independent** — each tag gets its own color |
| 7 | Rename cascade | **Yes** — renaming `#movies` → `#films` cascades to all children |

---

## Storage Strategy: Flat Path Strings

Store full paths as-is. No schema migration needed.

```
tagDefinitions.name = "movies/oscar"    -- PK, full path
noteTags.tag        = "movies/oscar"    -- FK-like, full path
frontmatter:  tags: [movies/oscar, movies/grammy]
```

**Why flat paths, not a parent-child table:**
- Zero schema changes — `name` and `tag` are already text columns
- Tree built client-side by splitting on `/`
- Prefix queries: `WHERE tag = 'movies' OR tag LIKE 'movies/%'`
- Frontmatter stays a simple array
- Rename cascade: `UPDATE ... SET tag = REPLACE(tag, 'movies/', 'films/')`

---

## Changes by Layer

### 1. Parsing (regex expansion)

**Current regex**: `/#([a-zA-Z0-9_-]+)/g`
**New regex**: `/#([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)/g`

Files to update:
- `renderer/src/lib/tag-utils.ts` — `extractTagsFromText()`
- `renderer/src/components/note/content-area/hash-tag.tsx` — inline tag splitting
- `renderer/src/components/journal/extensions/tag/tag.ts` — TipTap extension allow pattern

Validation rules:
- No leading/trailing slash: `#/movies` ✗, `#movies/` ✗
- No double slash: `#movies//oscar` ✗
- No empty segments: validated by regex (each segment requires 1+ char)
- Normalize to lowercase (existing behavior)

### 2. Database Queries

**`tag-queries.ts` — new/modified queries:**

```sql
-- Get notes for a tag AND all its descendants (implicit inheritance)
SELECT * FROM note_tags
WHERE tag = ? OR tag LIKE ? || '/%'

-- Get all tags, client builds tree
SELECT tag, COUNT(*) as count FROM note_tags
GROUP BY tag ORDER BY tag ASC

-- Rename cascade
UPDATE note_tags SET tag = REPLACE(tag, ?, ?) WHERE tag = ? OR tag LIKE ? || '/%'
UPDATE tag_definitions SET name = REPLACE(name, ?, ?) WHERE name = ? OR name LIKE ? || '/%'

-- Delete cascade (optional: delete parent = delete all children?)
-- Decision needed: probably YES for tag definitions, individual for note_tags
```

**Aggregate counts for parents:**
Parent `movies` count = notes tagged `movies` + notes tagged `movies/*` (deduplicated by noteId).

### 3. UI — Sidebar Tree View

Transform flat tag list into tree structure client-side:

```typescript
// Input:  [{ name: "movies", count: 2 }, { name: "movies/oscar", count: 5 }, ...]
// Output: tree nodes with children, aggregated counts

interface TagTreeNode {
  name: string           // "oscar"
  fullPath: string       // "movies/oscar"
  color: string | null
  ownCount: number       // notes tagged exactly "movies/oscar"
  totalCount: number     // ownCount + all descendants' counts (deduplicated)
  children: TagTreeNode[]
}
```

**UI behavior:**
- Collapsed by default — show top-level tags with `totalCount`
- Click chevron → expand to show children
- Click tag name → filter notes (implicit: includes all descendants)
- Indent children with visual connector lines
- Each tag shows its own color pill

### 4. Autocomplete Enhancement

**Trigger**: user types `#movies/`

**Behavior:**
1. Detect the `/` — extract prefix (`movies`)
2. Query existing children of prefix
3. Show dropdown: existing children + "Create new" option
4. Tab-complete or select existing child
5. Allow further nesting: `#movies/oscar/` triggers next level

**Implementation:**
- `TagAutocomplete` component gets hierarchy-aware search
- `useAllTags` hook adds `getChildTags(prefix)` method
- Suggestion sections: "Sub-tags of movies" → [oscar, grammy, cannes, + Create new]

### 5. Inline Rendering

`HashTag` component updates:
- Display: show full path `#movies/oscar` or abbreviated `#movies/oscar`
- Color: use the tag's own color (independent per decision)
- Click: filter by exact tag (with implicit inheritance for parent clicks from sidebar)
- Breadcrumb-style rendering option: `movies › oscar` (optional enhancement)

### 6. Rename/Merge Cascade

**Rename `#movies` → `#films`:**
1. Update `tagDefinitions`: rename `movies` → `films`
2. Update all children in `tagDefinitions`: `movies/oscar` → `films/oscar`, etc.
3. Update `noteTags`: same prefix replacement
4. Update note frontmatter: rewrite `tags:` array in all affected notes
5. Emit `onTagsChanged` event to refresh UI

**Merge `#movies/oscar` → `#movies/grammy`:**
- Works like current merge — just with path strings
- No special hierarchy logic needed

### 7. Tag Detail Page

When clicking a parent tag (e.g., `#movies`):
- Show all notes tagged `#movies` OR `#movies/*`
- Group by sub-tag with section headers: "oscar (5)", "grammy (3)", "uncategorized (2)"
- "Uncategorized" = notes tagged `#movies` directly (no sub-tag)

---

## Edge Cases

| Case | Behavior |
|------|----------|
| `#movies/oscar` exists but `#movies` has no tagDefinition | Auto-create `movies` as virtual parent (no color, inferred from children) |
| Delete `#movies` parent | Options: (a) delete all children too, (b) orphan children, (c) ask user. **Recommend: ask user** |
| Note has both `#movies` and `#movies/oscar` | Valid — `#movies` = uncategorized movie, `#movies/oscar` = specific. Both stored. |
| Sync conflict on hierarchical tags | Same as current — field-level merge handles `tags` array. No special hierarchy logic for sync. |
| Very deep nesting `#a/b/c/d/e/f` | Works in storage/queries. UI truncates display with `...` beyond 3 levels in sidebar. |

---

## Implementation Phases

### Phase 1 — Core (parsing + storage + queries)
- Update tag regex in 3 files
- Add prefix-query helpers to `tag-queries.ts`
- Update rename/delete to cascade
- Update tag validation in `tag-utils.ts`
- Tests for all new parsing + query behavior

### Phase 2 — Sidebar Tree UI
- Build `TagTreeNode` builder utility
- Replace flat `SidebarTagList` with collapsible tree
- Aggregate parent counts (deduplicated)
- Persist expand/collapse state

### Phase 3 — Autocomplete
- Hierarchy-aware `TagAutocomplete`
- `/` triggers child suggestion mode
- Create-new-subtag flow

### Phase 4 — Detail View + Polish
- Tag detail page grouped by sub-tag
- Inline breadcrumb rendering (optional)
- Virtual parent auto-creation
- Delete-parent confirmation dialog

---

## Open Questions

1. **Virtual parents**: If `#movies/oscar` exists but `#movies` was never explicitly created — should it appear in sidebar as a grouping node? **Lean: yes, as a virtual/gray node.**
2. **Tag detail grouping**: When viewing `#movies`, should sub-tagged notes show their sub-tag as a badge? **Lean: yes.**
3. **Max autocomplete depth**: Show all levels or just immediate children? **Lean: immediate children only, user drills deeper.**
