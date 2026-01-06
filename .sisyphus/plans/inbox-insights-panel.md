# ULTRAWORK PLAN: Inbox Insights Panel

> **Status**: READY FOR REVIEW
> **Created**: 2026-01-06
> **Aesthetic Direction**: Editorial Minimalism with Warm Data Visualization

---

## 🎯 Problem Statement

The Inbox page has rich backend data for:

- **Archived items** - soft-deleted via `archivedAt` timestamp
- **Stats** - daily captures, processed counts, average time to process
- **Filing history** - where items were filed, with patterns

But there's **no UI surface** to display this information. Users can't:

- View their archived inbox items
- See capture/processing statistics
- Review their filing history and patterns

---

## 📐 Design Direction

### Aesthetic: "Contemplative Data"

Following the existing "Contemplative Editorial Design" of the Inbox page:

- **Typography**: Serif for stats labels, display font for numbers
- **Color Palette**: Warm earth tones (amber accents), muted backgrounds
- **Motion**: Subtle entrance animations, staggered reveals
- **Layout**: Generous whitespace, asymmetric grids for stats

### UI Pattern: Tabbed Panel Inside Inbox Page

Rather than a separate page or modal, add a **segmented control** in the inbox header that switches between:

```
┌─────────────────────────────────────────────────────────────┐
│  [Inbox]  [Archived]  [Insights]                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Content area changes based on active segment              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

This follows the **Journal page pattern** which uses segments for different views within the same page.

---

## 🏗️ Architecture

### Component Structure

```
src/renderer/src/pages/inbox.tsx (MODIFY)
├── Add view state: 'inbox' | 'archived' | 'insights'
├── Add segment control in header
└── Conditionally render content

src/renderer/src/components/inbox/
├── inbox-archived-view.tsx (NEW)
│   ├── Search/filter archived items
│   ├── Grouped by month (like tasks archived-view)
│   ├── Restore action (unarchive)
│   └── Permanent delete action
│
├── inbox-insights-view.tsx (NEW)
│   ├── inbox-stats-cards.tsx (NEW)
│   │   ├── Captured Today
│   │   ├── Processed Today
│   │   ├── Avg Time to Process
│   │   └── Stale Count
│   │
│   ├── inbox-capture-heatmap.tsx (NEW)
│   │   └── GitHub-style 24x7 contribution grid
│   │
│   ├── inbox-type-distribution.tsx (NEW)
│   │   └── Horizontal bar chart by type
│   │
│   └── inbox-filing-history.tsx (NEW)
│       └── Recent individual filings with dates
│
└── inbox-segment-control.tsx (NEW)
    └── Shared segment/tab control
```

### Data Flow

```
useInboxStats() ──────────► inbox-stats-cards.tsx
                            - totalItems, staleCount, snoozedCount
                            - processedToday, capturedToday
                            - avgTimeToProcess

useInboxPatterns() ───────► inbox-type-distribution.tsx
                            - typeDistribution[]
                            - topDomains[]

NEW: useInboxArchived() ──► inbox-archived-view.tsx
     (needs IPC handler)    - List archived items
                            - Unarchive action
```

---

## 📋 Implementation Tasks

### Phase 1: Backend Support

- [ ] **1.1** Add `inbox:list-archived` IPC handler
  - Query `inbox_items WHERE archived_at IS NOT NULL`
  - Support pagination and search
- [ ] **1.2** Add `inbox:unarchive` IPC handler
  - Clear `archivedAt` timestamp, restore to active inbox
- [ ] **1.3** Add `inbox:delete-permanent` IPC handler
  - Hard delete item from database
  - Also delete associated attachments from disk
- [ ] **1.4** Add `inbox:get-filing-history` IPC handler
  - Query `filing_history` table with limit
  - Return recent filings with item details

### Phase 2: Segment Control & View Switching

- [ ] **2.1** Create `inbox-segment-control.tsx`
  - Three segments: Inbox, Archived, Insights
  - Follow existing ToggleGroup pattern from inbox density toggle
- [ ] **2.2** Modify `inbox.tsx` to add view state
  - `const [activeView, setActiveView] = useState<'inbox' | 'archived' | 'insights'>('inbox')`
  - Conditionally render content based on view
- [ ] **2.3** Integrate segment control into header
  - Position between title and density toggle

### Phase 3: Archived View

- [ ] **3.1** Create `inbox-archived-view.tsx`
  - Follow pattern from `tasks/completed/archived-view.tsx`
  - Search input with debounce
  - Group by month
  - Empty state for no archived items
- [ ] **3.2** Create `inbox-archived-item-row.tsx`
  - Display item type icon, title, archived date
  - Restore button (unarchive)
  - Permanent delete button
- [ ] **3.3** Add `useInboxArchived()` hook
  - Query archived items
  - Subscribe to archive/unarchive events

### Phase 4: Insights View

- [ ] **4.1** Create `inbox-insights-view.tsx`
  - Container with editorial layout
  - Section header styling
  - Scrollable content area
- [ ] **4.2** Create `inbox-stats-cards.tsx`
  - 4-column grid of stat cards
  - Use `useInboxStats()` hook (already exists!)
  - Stat cards: Captured Today, Processed Today, Avg Time, Stale Count
- [ ] **4.3** Create `inbox-capture-heatmap.tsx`
  - Use `useInboxPatterns()` hook → `timeHeatmap: number[][]` (24x7 grid)
  - GitHub-contributions style visualization
  - Days of week (Mon-Sun) × Hours (0-23)
  - Color intensity based on capture frequency
  - Tooltip on hover showing count
- [ ] **4.4** Create `inbox-type-distribution.tsx`
  - Use `useInboxPatterns()` hook (already exists!)
  - Horizontal bar visualization
  - Type icons with percentage and trend indicator
- [ ] **4.5** Create `inbox-filing-history.tsx`
  - Recent 10 individual filing actions
  - Show: item title, type icon, destination folder, date
  - Click destination to navigate to folder
  - Needs new API: `inbox:get-filing-history`

### Phase 5: Polish & Animation

- [ ] **5.1** Add entrance animations
  - Stagger stat cards appearance
  - Smooth view transitions
- [ ] **5.2** Add loading states
  - Skeleton cards for stats
  - Skeleton rows for archived list
- [ ] **5.3** Responsive design
  - Stack stat cards on mobile
  - Collapse bar chart on small screens

---

## 🎨 Visual Design Specifications

### Segment Control

```
Background: bg-muted/30
Active: bg-background shadow-sm
Text: text-sm font-medium
Icons: 16px (Inbox, Archive, BarChart3)
```

### Stats Cards (Insights View)

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│    │     12      │  │      8      │  │    24min    │        │
│    │ Captured    │  │ Processed   │  │ Avg Process │        │
│    │   Today     │  │   Today     │  │    Time     │        │
│    └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                              │
│    Capture Activity                                          │
│    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        │
│         0  3  6  9  12 15 18 21                              │
│    Mon  ░░▒▒░░░░░░▓▓▓▓▒▒░░░░░░░░                            │
│    Tue  ░░▒▒░░░░░░████▓▓░░░░░░░░                            │
│    Wed  ░░░░░░░░░░▓▓▓▓▒▒░░░░░░░░                            │
│    Thu  ░░▒▒▒▒░░░░████████░░░░░░                            │
│    Fri  ░░░░░░░░░░▓▓▓▓▓▓░░░░░░░░                            │
│    Sat  ░░░░░░░░░░▒▒░░░░░░░░░░░░                            │
│    Sun  ░░░░░░░░░░░░░░░░░░░░░░░░                            │
│                                                              │
│    Type Distribution                                         │
│    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        │
│    🔗 Links      ████████████████░░░░░░░░░  62%  ↑          │
│    📝 Notes      ██████░░░░░░░░░░░░░░░░░░░  24%  →          │
│    🎤 Voice      ████░░░░░░░░░░░░░░░░░░░░░  14%  ↓          │
│                                                              │
│    Recent Filings                                            │
│    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        │
│    🔗 React article         → Work/Research      2h ago     │
│    📝 Meeting notes         → Projects/Alpha     Yesterday  │
│    🎤 Voice memo            → Personal/Ideas     Jan 4      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

┌──────────────────────────────────────────────────────────────┐
│ │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
│ │ 12 │ │ 8 │ │ 24min │ │
│ │ Captured │ │ Processed │ │ Avg Process │ │
│ │ Today │ │ Today │ │ Time │ │
│ └─────────────┘ └─────────────┘ └─────────────┘ │
│ │
│ Type Distribution │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ 🔗 Links ████████████████░░░░░░░░░ 62% │
│ 📝 Notes ██████░░░░░░░░░░░░░░░░░░░ 24% │
│ 🎤 Voice ████░░░░░░░░░░░░░░░░░░░░░ 14% │
│ │
└──────────────────────────────────────────────────────────────┘

```

### Archived View

```

┌──────────────────────────────────────────────────────────────┐
│ 🔍 Search archived items... │
├──────────────────────────────────────────────────────────────┤
│ │
│ JANUARY 2026 12 │
│ ───────────────────────────────────────────────────────── │
│ 🔗 Article about React Server Components Jan 5 ↩️ 🗑️ │
│ 📝 Meeting notes from standup Jan 3 ↩️ 🗑️ │
│ 🎤 Voice memo - project ideas Jan 2 ↩️ 🗑️ │
│ │
│ DECEMBER 2025 8 │
│ ───────────────────────────────────────────────────────── │
│ ... │
│ │
└──────────────────────────────────────────────────────────────┘

````

---

## 🔌 API Requirements

### Existing APIs (Ready to Use)

- `inboxService.getStats()` → `useInboxStats()`
- `inboxService.getPatterns()` → `useInboxPatterns()`
- `inboxService.archive(id)` → `useArchiveInboxItem()`

### New APIs Needed

1. **List Archived Items**

   ```typescript
   // inbox-api.ts
   [InboxChannels.invoke.LIST_ARCHIVED]: (options?: {
     search?: string
     limit?: number
     offset?: number
   }) => Promise<{
     items: InboxItemListItem[]
     total: number
     hasMore: boolean
   }>
````

2. **Unarchive Item**

   ```typescript
   [InboxChannels.invoke.UNARCHIVE]: (id: string) => Promise<{
     success: boolean
     error?: string
   }>
   ```

3. **Permanent Delete** ✅ REQUIRED

   ```typescript
   [InboxChannels.invoke.DELETE_PERMANENT]: (id: string) => Promise<{
     success: boolean
     error?: string
   }>
   ```

4. **Get Filing History** (for recent individual filings)
   ```typescript
   [InboxChannels.invoke.GET_FILING_HISTORY]: (options?: {
     limit?: number
   }) => Promise<{
     entries: Array<{
       id: string
       itemType: string
       itemTitle: string
       filedTo: string
       filedAction: 'folder' | 'note' | 'linked'
       filedAt: string
       tags: string[]
     }>
   }>
   ```

---

## ⚠️ Risk Assessment

| Risk                         | Likelihood | Impact | Mitigation                           |
| ---------------------------- | ---------- | ------ | ------------------------------------ |
| Stats API returns empty data | Low        | Medium | Add default/zero states              |
| View switching feels janky   | Medium     | Low    | Use CSS transitions, preserve scroll |
| Archived list too long       | Medium     | Medium | Pagination + virtualization          |
| Density toggle conflicts     | Low        | Low    | Test both density modes              |

---

## 📊 Success Metrics

1. **Discoverability**: Users find and use the Insights tab
2. **Utility**: Archived items can be restored
3. **Performance**: View switches feel instant (<100ms)
4. **Consistency**: Matches existing editorial design language

---

## ✅ User Decisions (Confirmed)

1. **Permanent Delete**: ✅ YES - Users can permanently delete archived items
2. **Filing History**: ✅ Show recent individual filings with item details and dates
3. **Heatmap**: ✅ YES - Include capture time heatmap (GitHub-contributions style)
4. **Badge/Indicator**: Keep segments clean (no badge)

---

## 📁 File Changes Summary

| File                                                            | Action | Description                                            |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------ |
| `src/renderer/src/pages/inbox.tsx`                              | MODIFY | Add view state and segment control                     |
| `src/renderer/src/components/inbox/inbox-segment-control.tsx`   | CREATE | Segment toggle component                               |
| `src/renderer/src/components/inbox/inbox-archived-view.tsx`     | CREATE | Archived items list view                               |
| `src/renderer/src/components/inbox/inbox-archived-item-row.tsx` | CREATE | Archived item row component                            |
| `src/renderer/src/components/inbox/inbox-insights-view.tsx`     | CREATE | Insights container                                     |
| `src/renderer/src/components/inbox/inbox-stats-cards.tsx`       | CREATE | Stats display cards                                    |
| `src/renderer/src/components/inbox/inbox-capture-heatmap.tsx`   | CREATE | GitHub-style activity heatmap (24x7 grid)              |
| `src/renderer/src/components/inbox/inbox-type-distribution.tsx` | CREATE | Type breakdown visualization with trends               |
| `src/renderer/src/components/inbox/inbox-filing-history.tsx`    | CREATE | Recent individual filings list                         |
| `src/renderer/src/hooks/use-inbox.ts`                           | MODIFY | Add useInboxArchived, useInboxFilingHistory hooks      |
| `src/main/ipc/inbox-handlers.ts`                                | MODIFY | Add list-archived, unarchive, delete, history handlers |
| `src/shared/contracts/inbox-api.ts`                             | MODIFY | Add new API schemas                                    |
| `src/shared/ipc-channels.ts`                                    | MODIFY | Add new channel constants                              |
| `src/preload/index.ts`                                          | MODIFY | Expose new IPC methods                                 |

---

**Total Estimated Effort**: 4-5 hours (increased due to heatmap + filing history)

**Recommended Implementation Order**:

1. Phase 1 (Backend) - Add all IPC handlers first
2. Phase 2 (Segment Control) - UI structure
3. Phase 4 (Insights) - Stats, heatmap, type distribution, filing history
4. Phase 3 (Archived) - Uses new backend handlers
5. Phase 5 (Polish) - Animations, loading states, responsive

---

## 🎨 Heatmap Design Details

### Data Structure

```typescript
// From useInboxPatterns().timeHeatmap
// 24 rows (hours 0-23) × 7 columns (days Mon-Sun)
timeHeatmap: number[][] // e.g., timeHeatmap[14][2] = captures at 2pm on Wednesday
```

### Visual Specification

```
Cell Size: 12×12px
Gap: 2px
Colors (warm palette matching editorial design):
  - 0 items:    bg-muted/20 (nearly invisible)
  - 1-2 items:  amber-200/40
  - 3-5 items:  amber-300/60
  - 6-10 items: amber-400/80
  - 10+ items:  amber-500 (full intensity)

Layout:
  - Hour labels on top (0, 3, 6, 9, 12, 15, 18, 21)
  - Day labels on left (Mon, Tue, Wed, Thu, Fri, Sat, Sun)
  - Tooltip on hover: "X captures on [Day] at [Hour]"
```

### Interaction

- Hover shows tooltip with exact count
- Click could filter inbox by that time (future enhancement)
