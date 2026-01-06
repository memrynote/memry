# Search & Discovery Specification

Comprehensive search across all content with filters and AI-powered discovery.

```
/speckit.specify

Build the search system that enables finding content across notes, tasks, journal, and inbox:

## USER STORIES

### P1 - Critical
1. As a user, I want to search across all my content from a single search bar
2. As a user, I want to see results as I type (instant search)
3. As a user, I want to filter results by type (notes, tasks, journal, inbox)
4. As a user, I want to click a result and go directly to that item
5. As a user, I want search to find partial matches and typos (fuzzy search)

### P2 - Important
6. As a user, I want to search within specific date ranges
7. As a user, I want to search by tags
8. As a user, I want recent searches saved for quick access
9. As a user, I want to see highlighted matches in search results
10. As a user, I want keyboard navigation of search results

### P3 - Nice to Have
11. As a user, I want semantic search (find conceptually similar content)
12. As a user, I want saved searches that update automatically
13. As a user, I want advanced query syntax (AND, OR, NOT, quotes)
14. As a user, I want to search within specific folders/projects

## DATA MODEL

### SearchResult
```typescript
interface SearchResult {
  id: string
  type: "note" | "task" | "journal" | "inbox"
  title: string
  snippet: string           // Text around match with highlights
  matchScore: number        // Relevance score (0-1)
  matchPositions: number[]  // Character positions of matches

  // Type-specific data
  path?: string             // For notes/journal
  projectName?: string      // For tasks
  dueDate?: Date           // For tasks
  date?: string            // For journal (YYYY-MM-DD)
  itemType?: string        // For inbox (link/note/voice/image)

  // Metadata
  createdAt: Date
  modifiedAt: Date
  tags?: string[]
}
```

### SearchQuery
```typescript
interface SearchQuery {
  text: string

  // Filters
  types?: ("note" | "task" | "journal" | "inbox")[]
  tags?: string[]
  dateRange?: {
    start: Date
    end: Date
  }
  projectIds?: string[]     // For tasks
  folders?: string[]        // For notes

  // Options
  limit?: number            // Default 50
  offset?: number           // For pagination
  sortBy?: "relevance" | "date" | "title"
  sortDirection?: "asc" | "desc"
}
```

### RecentSearch
```typescript
interface RecentSearch {
  query: string
  timestamp: Date
  resultCount: number
}
```

## FUNCTIONAL REQUIREMENTS

### Global Search (Cmd+K)
- Keyboard shortcut: Cmd+K (or Cmd+P)
- Opens command palette-style modal
- Auto-focus on search input
- Show recent searches when empty
- Results appear as user types (debounced 150ms)
- Results grouped by type with section headers
- Maximum 10 results per section initially
- "View all" link per section for more results

### Full-Text Search
- Use SQLite FTS5 for fast text search
- Index: note content, note titles, task titles, task descriptions, journal content, inbox titles
- Support prefix matching ("meet*" finds "meeting")
- Support phrase search ("project alpha" in quotes)
- Rank by relevance using BM25 algorithm

### Fuzzy Search
- Use fuzzy matching for typo tolerance
- "meetng" should find "meeting"
- Fuzzy threshold configurable (default: 70% similarity)
- Combine fuzzy with FTS for best results

### Search Results UI
```
┌─────────────────────────────────────────────────────────────┐
│  🔍  meeting notes                               [⌘ K to close]  │
├─────────────────────────────────────────────────────────────┤
│  Notes (12)                                                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ 📝 Team Meeting Notes                                    ││
│  │    "...discussed Q4 goals in the **meeting** today..."  ││
│  │    Modified: 2 hours ago                                 ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │ 📝 Meeting Template                                      ││
│  │    "...standard agenda for weekly **meetings**..."      ││
│  └─────────────────────────────────────────────────────────┘│
│  [View all 12 notes →]                                       │
│                                                              │
│  Tasks (5)                                                   │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ ☐ Schedule quarterly meeting                             ││
│  │    Project Alpha • Due: Tomorrow                         ││
│  └─────────────────────────────────────────────────────────┘│
│  [View all 5 tasks →]                                        │
│                                                              │
│  Journal (3)                                                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ 📔 January 15, 2024                                      ││
│  │    "...productive **meeting** with the team today..."   ││
│  └─────────────────────────────────────────────────────────┘│
│  [View all 3 entries →]                                      │
└─────────────────────────────────────────────────────────────┘
```

### Filter Panel
- Toggle filters sidebar (Cmd+Shift+F)
- Type checkboxes: Notes, Tasks, Journal, Inbox
- Tag multi-select with autocomplete
- Date range picker with presets (Today, This Week, This Month, Custom)
- Project filter (for tasks)
- Folder filter (for notes)
- Clear all filters button

### Result Highlighting
- Match text highlighted in snippet
- Use <mark> tag or custom component
- Show context around match (50 chars before/after)
- Multiple matches shown with "..." separator

### Keyboard Navigation
- Arrow Up/Down: navigate results
- Enter: open selected result
- Tab: move between sections
- Escape: close search
- Cmd+1-4: filter by type (1=Notes, 2=Tasks, 3=Journal, 4=Inbox)

### Recent Searches
- Store last 20 unique searches
- Show when search input empty
- Click to re-run search
- Clear history option

## NON-FUNCTIONAL REQUIREMENTS

### Performance
- First results appear within 100ms
- Full search completes within 200ms
- Works smoothly with 10,000+ items
- Index updates don't block UI

### UX
- Search modal opens instantly
- No flicker during result updates
- Smooth keyboard navigation
- Loading state for slow searches

## ACCEPTANCE CRITERIA

### Basic Search
- [ ] Cmd+K opens search modal
- [ ] Typing shows results immediately
- [ ] Results grouped by type
- [ ] Clicking result opens item
- [ ] Escape closes modal

### Text Matching
- [ ] "meeting" finds "Team Meeting Notes"
- [ ] "meet" finds "meeting" (prefix)
- [ ] "meetng" finds "meeting" (fuzzy)
- [ ] "project alpha" finds exact phrase
- [ ] Case-insensitive matching

### Filtering
- [ ] Type filter shows only selected types
- [ ] Tag filter narrows results
- [ ] Date range filter works correctly
- [ ] Multiple filters combine with AND
- [ ] Clear filters shows all results

### Results Display
- [ ] Matches highlighted in snippets
- [ ] Relevant context shown
- [ ] Result count per section shown
- [ ] "View all" expands section
- [ ] Empty state when no matches

### Keyboard Navigation
- [ ] Arrow keys move selection
- [ ] Enter opens selected
- [ ] Tab moves between sections
- [ ] Selection wraps at boundaries
- [ ] Focus indicator visible

### Recent Searches
- [ ] Recent searches shown when empty
- [ ] Clicking recent search executes it
- [ ] History persists across sessions
- [ ] Can clear search history

### Edge Cases
- [ ] Very long query handled gracefully
- [ ] Special characters don't break search
- [ ] Empty results shows helpful message
- [ ] Search works offline
- [ ] Index corruption recoverable
```
