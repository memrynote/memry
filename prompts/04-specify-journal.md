# Journal System Specification

Daily journaling with calendar navigation, context sidebar, and AI connections.

```
/speckit.specify

Build the journal system for daily entries that connects to the existing JournalPage component:

## USER STORIES

### P1 - Critical
1. As a user, I want one journal entry per day stored as a markdown file
2. As a user, I want to navigate between days using a calendar
3. As a user, I want to see which days have entries via a visual heatmap
4. As a user, I want today's entry to open by default when I visit the journal
5. As a user, I want my journal entries auto-saved as I type

### P2 - Important
6. As a user, I want a focus mode that hides distractions for deep writing
7. As a user, I want to see today's tasks and calendar events alongside my journal
8. As a user, I want to see AI-suggested connections to past entries and notes
9. As a user, I want month and year views to see my journaling history at a glance
10. As a user, I want word count and character count displayed

### P3 - Nice to Have
11. As a user, I want journal templates for different entry types (morning pages, reflection, gratitude)
12. As a user, I want to see streak information (consecutive days journaled)
13. As a user, I want to search across all journal entries

## DATA MODEL

### Journal Entry (File-based)
```
vault/journal/2024-01-15.md
```

```yaml
---
id: "journal-2024-01-15"
date: "2024-01-15"
created: "2024-01-15T08:30:00Z"
modified: "2024-01-15T14:22:00Z"
wordCount: 523
characterCount: 2891
tags:
  - reflection
  - work
---

# Monday, January 15, 2024

Today's focus: Planning Q1 goals...

## Morning Reflection
...

## Evening Review
...
```

### Journal Index (Database)
```typescript
interface JournalIndex {
  id: string              // "journal-YYYY-MM-DD"
  date: string            // "YYYY-MM-DD" for easy sorting
  path: string
  createdAt: Date
  modifiedAt: Date
  wordCount: number
  characterCount: number
  mood: string | null
  tags: string[]

  // For heatmap
  activityLevel: 0 | 1 | 2 | 3 | 4  // Computed from characterCount
}
```

### Heatmap Levels
```typescript
// Character count to activity level mapping
function getActivityLevel(charCount: number): 0 | 1 | 2 | 3 | 4 {
  if (charCount === 0) return 0
  if (charCount <= 100) return 1   // Quick note
  if (charCount <= 500) return 2   // Short entry
  if (charCount <= 1000) return 3  // Medium entry
  return 4                         // Long entry
}
```

## FUNCTIONAL REQUIREMENTS

### Entry Management
- Open journal: navigate to today's date
- Navigate to date: load or create entry for that date
- Create entry: generate file on first keystroke
- Auto-save: 1 second debounce like notes
- Delete entry: move file to trash, update index

### Calendar Widget
- Show current month by default
- Previous/next month navigation
- Click day to navigate to that entry
- Today button jumps to current date
- Visual heatmap showing activity levels:
  - Level 0: No entry (gray/empty)
  - Level 1: Brief entry (light color)
  - Level 2-3: Medium entries
  - Level 4: Substantial entry (dark color)
- Future dates shown but muted

### Month View
- List all entries in selected month
- Show entry preview (first 100 chars)
- Show word count and tags
- Click entry to navigate to day view

### Year View
- Grid of 12 month cards
- Each card shows:
  - Month name
  - Number of entries
  - Total word count
  - Dominant mood (if tracked)
- Click month to go to month view

### Day Context Sidebar
- Today's calendar events (integrate with system calendar later, mock for now)
- Today's tasks (from task system)
- Overdue task count with warning
- Quick task toggle (complete from journal)

### AI Connections Panel
- Semantic similarity search against:
  - Past journal entries
  - Notes in vault
- Triggered on content change (debounced 2 seconds)
- Show top 3-5 connections with:
  - Source type (journal/note)
  - Date or title
  - Snippet showing matched content
  - Relevance score (for debugging, hide in production)
- Click connection to open in new tab

### Focus Mode
- Hide left sidebar
- Hide right context sidebar
- Center editor with narrower max-width
- Subtle paper-like background
- Toggle via button or Cmd+\
- Persist preference in localStorage

### Word/Character Count
- Update in real-time as user types
- Show in subtle location (bottom or header)
- Don't distract from writing

## NON-FUNCTIONAL REQUIREMENTS

### Performance
- Switch between days in <100ms
- Heatmap render for 365 days in <50ms
- AI connections update in <2 seconds
- Focus mode toggle instant (no delay)

### UX
- Writing should feel "buttery smooth"
- No jarring layout shifts
- Respect reduced motion preferences
- Works well at different window sizes

## ACCEPTANCE CRITERIA

### Navigation
- [ ] Opening journal shows today's entry (or empty editor)
- [ ] Calendar shows current month with today highlighted
- [ ] Clicking past date loads that entry
- [ ] Future dates open empty editor
- [ ] Month/year views accessible from breadcrumb

### Heatmap
- [ ] Days with entries show colored activity level
- [ ] Empty days show neutral/gray
- [ ] Hovering shows date and word count
- [ ] Activity level updates after save

### Day Context
- [ ] Shows today's calendar events (mock data ok)
- [ ] Shows today's tasks with completion toggles
- [ ] Overdue tasks highlighted in red
- [ ] Completing task updates task system

### AI Connections
- [ ] Shows "Finding connections..." while loading
- [ ] Displays 3-5 relevant past entries/notes
- [ ] Connection snippets highlight matched text
- [ ] Clicking connection opens in new tab
- [ ] No connections shows empty state gracefully

### Focus Mode
- [ ] Cmd+\ toggles focus mode
- [ ] Sidebars smoothly animate out
- [ ] Editor width narrows for comfortable reading
- [ ] ESC exits focus mode
- [ ] Preference persists across sessions

### Writing Experience
- [ ] Auto-save works (no lost content)
- [ ] Word count updates as typing
- [ ] Formatting (headings, lists) works
- [ ] Can embed images
- [ ] Can link to notes with [[wiki links]]

### Edge Cases
- [ ] Very old dates (2020) work correctly
- [ ] Leap years handled (Feb 29)
- [ ] Journal entry with 10,000 words performs well
- [ ] Rapid day switching doesn't cause race conditions
- [ ] External edit to journal file detected
```
